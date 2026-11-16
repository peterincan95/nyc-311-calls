"""Build public/data/streets.bin and streets.json from the NYC street centerline.

Download the Centerline (CSCL) GeoJSON from NYC Open Data into data/GeoJSON/, then:

    pip install shapely
    python scripts/build_streets.py [path/to/Centerline.geojson]

Coordinates use the same grid as the calls (see export_binary.py), so run that
first: this reads the grid's bounds from public/data/meta.json.

Streets are sorted into three tiers, drawn from the furthest zoom to the closest:
  1. Highways: expressways and parkways, their main bridges and tunnels, and ramps
  2. Major roads: truck routes, roads on the city's display-level list, and
     streets at least MAJOR_WIDTH_FEET wide
  3. Local streets: every other street, plus boardwalks and minor bridges and tunnels
Paths, alleys, driveways, step streets, ferry routes and the like are left out.

streets.bin holds, in order and each 4-byte aligned:
  line starts   uint32 x (lines + 1)   index of each line's first vertex
  vertices      uint16 x 2 per vertex  x, y on the grid
  anchors       uint16 x 4 per anchor  x, y, name index, tier
  anchor reach  int16 x 2 per anchor   half the label's chord, x and y on the grid
Lines run in tier order. streets.json gives the counts and the street names.
"""

import json
import math
import re
import struct
import sys
from collections import defaultdict
from pathlib import Path

from shapely.geometry import LineString, MultiLineString
from shapely.ops import clip_by_rect, linemerge

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "data" / "GeoJSON"
META = ROOT / "public" / "data" / "meta.json"
OUTPUT_BIN = ROOT / "public" / "data" / "streets.bin"
OUTPUT_JSON = ROOT / "public" / "data" / "streets.json"

GRID_MAX = 65535
# About 3 m, far below what the map shows at its closest zoom.
SIMPLIFY_DEGREES = 0.00003
MAJOR_WIDTH_FEET = 60

# Roadway types (rw_type) in the centerline.
STREET, HIGHWAY, BRIDGE, TUNNEL, BOARDWALK, RAMP = "1", "2", "3", "4", "5", "9"
CONSTRUCTED = "2"

# A label is placed on each stretch of about this many meters, by tier. Curvy
# stretches are halved until they're nearly straight, down to MIN_LABEL_METERS.
LABEL_METERS = {1: 1600, 2: 800, 3: 400}
MIN_LABEL_METERS = 60
# Path length over chord length that still counts as straight.
STRAIGHTNESS = 1.08

# Names too generic to label.
GENERIC_NAMES = {"UNNAMED ST", "CONNECTOR", "ALLEY", "DRIVEWAY", "PEDESTRIAN PATH"}
UNLABELED_WORDS = re.compile(r"\b(EXIT|ENTRANCE|ET|EN|RAMP|TURNAROUND|EXPWY|U TURN)\b")

ABBREVIATIONS = {
    "AVE": "Ave", "ST": "St", "BLVD": "Blvd", "PKWY": "Pkwy", "EXPY": "Expy", "RD": "Rd",
    "DR": "Dr", "PL": "Pl", "LN": "Ln", "CT": "Ct", "TER": "Ter", "HWY": "Hwy",
    "TPKE": "Tpke", "CONC": "Concourse", "BRG": "Bridge", "TUNL": "Tunnel", "BCH": "Beach",
    "SQ": "Sq", "PLZ": "Plaza", "PROM": "Promenade", "BDWK": "Boardwalk", "CIR": "Cir",
    "HTS": "Heights", "XING": "Crossing", "TRL": "Trail", "WAY": "Way", "LOOP": "Loop",
    "OVAL": "Oval", "WALK": "Walk", "ROW": "Row", "SLIP": "Slip", "PARKWAY": "Pkwy",
}
# Words after a number that make it an ordinal, as in "3 AVE" to "3rd Ave".
ORDINAL_TYPES = {"AVE", "ST", "RD", "DR", "PL", "TER", "LN", "CT", "WAY", "WALK"}
UPPERCASE_WORDS = {"FDR", "JFK", "RFK", "US", "NY", "II", "III", "IV", "N", "S", "E", "W",
                   "NE", "NW", "SE", "SW"}


def ordinal(number):
    if 10 <= number % 100 <= 20:
        suffix = "th"
    else:
        suffix = {1: "st", 2: "nd", 3: "rd"}.get(number % 10, "th")
    return f"{number}{suffix}"


def display_name(name):
    """'E 158 ST' to 'E 158th St', 'GRAND CONC' to 'Grand Concourse'."""
    words = name.split()
    out = []
    for index, word in enumerate(words):
        following = words[index + 1] if index + 1 < len(words) else None
        if word.isdigit() and following in ORDINAL_TYPES:
            out.append(ordinal(int(word)))
        elif word in ABBREVIATIONS and index > 0:
            out.append(ABBREVIATIONS[word])
        elif word == "ST" and index == 0:
            out.append("St")
        elif word == "BCH" and index == 0:
            out.append("Beach")
        elif word in UPPERCASE_WORDS:
            out.append(word)
        else:
            out.append("-".join(part[:1] + part[1:].lower() for part in word.split("-")))
    return " ".join(out)


def tier_of(properties):
    """The tier a segment belongs to, or None to leave it out."""
    rw = properties["rw_type"]
    name = properties["stname_label"] or ""
    if properties["status"] != CONSTRUCTED:
        return None
    if rw in (HIGHWAY, RAMP):
        return 1
    if rw in (BRIDGE, TUNNEL):
        is_main = properties["carto_display_level"] or "BRG" in name or "TUNL" in name
        return 1 if is_main else 3
    if rw == STREET:
        width = float(properties["streetwidth"] or 0)
        if properties["carto_display_level"] or properties["truck_route_type"] or width >= MAJOR_WIDTH_FEET:
            return 2
        return 3
    if rw == BOARDWALK:
        return 3
    return None


def is_labeled(properties):
    name = properties["stname_label"] or ""
    return (
        properties["rw_type"] != RAMP
        and name not in GENERIC_NAMES
        and not UNLABELED_WORDS.search(name)
    )


def read_features(path):
    """The centerline export has one feature per line, so it's read without loading it all."""
    with open(path, encoding="utf-8") as source:
        for line in source:
            line = line.strip().rstrip(",")
            if line.startswith('{"type":"Feature"'):
                yield json.loads(line)


def main():
    source = Path(sys.argv[1]) if len(sys.argv) > 1 else max(SOURCE.glob("Centerline*.geojson"))
    bounds = json.loads(META.read_text(encoding="utf-8"))["bounds"]
    lon_min, lon_max = bounds["lonMin"], bounds["lonMax"]
    lat_min, lat_max = bounds["latMin"], bounds["latMax"]
    middle = math.radians((lat_min + lat_max) / 2)
    meters_x = 111_320 * math.cos(middle)
    meters_y = 110_540

    def grid(lon, lat):
        return (
            (lon - lon_min) / (lon_max - lon_min) * GRID_MAX,
            (lat - lat_min) / (lat_max - lat_min) * GRID_MAX,
        )

    def meters(a, b):
        return math.hypot((b[0] - a[0]) * meters_x, (b[1] - a[1]) * meters_y)

    # Segments grouped by what they'll be merged into: same tier, labeling and name.
    groups = defaultdict(list)
    for feature in read_features(source):
        properties = feature["properties"]
        tier = tier_of(properties)
        if tier is None or not feature["geometry"]:
            continue
        key = (tier, is_labeled(properties), properties["stname_label"] or "")
        for part in feature["geometry"]["coordinates"]:
            if len(part) >= 2:
                groups[key].append(LineString(part))

    names = []
    name_index = {}
    lines = []  # (tier, [(lon, lat), ...])
    anchors = []  # (tier, -length, x, y, dx, dy, name)

    def add_anchors(tier, name, coords):
        """Places labels along a line, on stretches straight enough for straight text."""
        lengths = [0.0]
        for a, b in zip(coords, coords[1:]):
            lengths.append(lengths[-1] + meters(a, b))
        total = lengths[-1]
        if total < MIN_LABEL_METERS:
            return

        def point_at(distance):
            for index in range(1, len(lengths)):
                if lengths[index] >= distance:
                    a, b = coords[index - 1], coords[index]
                    span = lengths[index] - lengths[index - 1]
                    t = 0 if span == 0 else (distance - lengths[index - 1]) / span
                    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
            return coords[-1]

        def place(start, end):
            a, b = point_at(start), point_at(end)
            chord = meters(a, b)
            length = end - start
            if length > 2 * MIN_LABEL_METERS and (chord == 0 or length / chord > STRAIGHTNESS):
                middle = (start + end) / 2
                place(start, middle)
                place(middle, end)
                return
            if chord < MIN_LABEL_METERS:
                return
            center = grid(*point_at((start + end) / 2))
            ga, gb = grid(*a), grid(*b)
            if name not in name_index:
                name_index[name] = len(names)
                names.append(name)
            anchors.append((
                tier, -chord, round(center[0]), round(center[1]),
                round((gb[0] - ga[0]) / 2), round((gb[1] - ga[1]) / 2), name_index[name],
            ))

        count = max(1, round(total / LABEL_METERS[tier]))
        step = total / count
        for index in range(count):
            place(index * step, (index + 1) * step)

    for (tier, labeled, raw_name), parts in groups.items():
        merged = linemerge(MultiLineString(parts))
        # The grid only covers the calls' bounds, so streets are cut at its edges.
        clipped = clip_by_rect(merged, lon_min, lat_min, lon_max, lat_max)
        if clipped.is_empty:
            continue
        pieces = clipped.geoms if hasattr(clipped, "geoms") else [clipped]
        for piece in pieces:
            if piece.geom_type != "LineString" or len(piece.coords) < 2:
                continue
            coords = list(piece.coords)
            simplified = list(piece.simplify(SIMPLIFY_DEGREES).coords)
            lines.append((tier, simplified))
            if labeled and raw_name:
                add_anchors(tier, display_name(raw_name), coords)

    lines.sort(key=lambda line: line[0])
    # More important streets, then longer labels, claim their space first.
    anchors.sort(key=lambda anchor: (anchor[0], anchor[1]))

    tier_line_counts = [sum(1 for tier, _ in lines if tier == t) for t in (1, 2, 3)]
    line_starts = [0]
    vertices = []
    for _, coords in lines:
        for lon, lat in coords:
            x, y = grid(lon, lat)
            vertices += [round(x), round(y)]
        line_starts.append(len(vertices) // 2)

    def padded(data):
        return data + b"\0" * (-len(data) % 4)

    with open(OUTPUT_BIN, "wb") as out:
        out.write(padded(struct.pack(f"<{len(line_starts)}I", *line_starts)))
        out.write(padded(struct.pack(f"<{len(vertices)}H", *vertices)))
        flat = []
        reach = []
        for tier, _, x, y, dx, dy, name in anchors:
            flat += [x, y, name, tier]
            reach += [dx, dy]
        out.write(padded(struct.pack(f"<{len(flat)}H", *flat)))
        out.write(padded(struct.pack(f"<{len(reach)}h", *reach)))

    OUTPUT_JSON.write_text(
        json.dumps(
            {
                "lineCount": len(lines),
                "vertexCount": len(vertices) // 2,
                "anchorCount": len(anchors),
                "tierLineCounts": tier_line_counts,
                "names": names,
            },
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    print(
        f"{len(lines)} lines ({tier_line_counts}), {len(vertices) // 2} vertices, "
        f"{len(anchors)} labels, {len(names)} names; "
        f"{OUTPUT_BIN.name} {OUTPUT_BIN.stat().st_size / 1e6:.2f} MB, "
        f"{OUTPUT_JSON.name} {OUTPUT_JSON.stat().st_size / 1e6:.2f} MB"
    )


if __name__ == "__main__":
    main()
