"""Build public/data/boundaries.json from the GeoJSON in data/GeoJSON/.

Coordinates use the same grid as the calls (see export_binary.py), so boundaries
and points always line up. Run export_binary.py first: this reads the grid's
bounds from public/data/meta.json.

    pip install shapely
    python scripts/build_boundaries.py
"""

import json
import math
from pathlib import Path

from shapely.geometry import shape
from shapely.geometry.polygon import orient
from shapely.ops import polylabel

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "data" / "GeoJSON"
META = ROOT / "public" / "data" / "meta.json"
OUTPUT = ROOT / "public" / "data" / "boundaries.json"

GRID_MAX = 65535
# About 3 m, far below what the map shows at its closest zoom.
SIMPLIFY_DEGREES = 0.00003
RESIDENTIAL = "0"


def polygons(geometry):
    return list(geometry.geoms) if geometry.geom_type == "MultiPolygon" else [geometry]


def main():
    bounds = json.loads(META.read_text(encoding="utf-8"))["bounds"]
    lon_min, lon_max = bounds["lonMin"], bounds["lonMax"]
    lat_min, lat_max = bounds["latMin"], bounds["latMax"]
    # Ground distance per degree of longitude, relative to latitude.
    shrink = math.cos(math.radians((lat_min + lat_max) / 2))

    def grid_x(lon):
        return (lon - lon_min) / (lon_max - lon_min) * GRID_MAX

    def grid_y(lat):
        return (lat - lat_min) / (lat_max - lat_min) * GRID_MAX

    def rings(geometry):
        """Each ring as a flat [x, y, x, y, ...] list on the grid."""
        out = []
        for polygon in polygons(geometry.simplify(SIMPLIFY_DEGREES)):
            for ring in [polygon.exterior, *polygon.interiors]:
                flat = []
                for lon, lat in ring.coords:
                    flat += [round(grid_x(lon)), round(grid_y(lat))]
                out.append(flat)
        return out

    def read(name):
        text = (SOURCE / name).read_text(encoding="utf-8")
        return json.loads(text)["features"]

    borough_rings = []
    for feature in read("boroughs.json"):
        borough_rings += rings(shape(feature["geometry"]))

    neighborhood_rings = []
    labels = []
    for feature in read("neighborhoods.json"):
        geometry = shape(feature["geometry"])
        neighborhood_rings += rings(geometry)

        # The label sits at the point furthest from the edges of the largest part.
        largest = max(polygons(geometry), key=lambda polygon: polygon.area)
        center = polylabel(orient(largest), tolerance=0.0001)
        width_share = (lon_max - lon_min) * shrink
        height_share = lat_max - lat_min
        area = geometry.area * shrink / (width_share * height_share)
        labels.append(
            {
                "name": feature["properties"]["ntaname"],
                "x": round(grid_x(center.x)),
                "y": round(grid_y(center.y)),
                # Width of a square the same area, as a share of the city.
                "size": round(math.sqrt(area), 4),
                "residential": feature["properties"]["ntatype"] == RESIDENTIAL,
            }
        )

    # Larger areas claim their label space first.
    labels.sort(key=lambda label: -label["size"])
    OUTPUT.write_text(
        json.dumps(
            {"boroughs": borough_rings, "neighborhoods": neighborhood_rings, "labels": labels},
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    count = sum(len(ring) // 2 for ring in borough_rings + neighborhood_rings)
    print(f"{OUTPUT.name}: {count} points, {OUTPUT.stat().st_size / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
