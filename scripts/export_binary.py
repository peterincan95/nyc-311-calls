"""Export the prepped calls to the compact files the web app loads.

Reads   data/NYC311Calls_prepped.csv, data/lookups/*.csv,
        scripts/problem_groups.py
Writes  public/data/calls.bin, public/data/tags.bin, public/data/meta.json

calls.bin holds 8 bytes per call, little-endian:
  uint16 x      longitude scaled from bounds.lonMin..lonMax to 0..65535
  uint16 y      latitude scaled from bounds.latMin..latMax to 0..65535
  uint32 t      seconds since tStart

tags.bin holds one little-endian uint32 per call, in the same order:
  bits 0-9    detail number within the call's problem, 0 if none was recorded
  bits 10-18  neighborhood id, 0 if none
  bits 19-21  borough id

Calls are sorted by problem, then time, so any problem and time filter selects
contiguous rows. meta.json gives each problem's start row and count, and lists
the problems in each dropdown category. Calls with no coordinates can't be
plotted: they are left out and counted in `missingCalls` by problem and tag.
"""
import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

from problem_groups import PROBLEM_GROUPS

ROOT = Path(__file__).resolve().parent.parent
PREPPED = ROOT / "data" / "NYC311Calls_prepped.csv"
LOOKUPS = ROOT / "data" / "lookups"
OUT = ROOT / "public" / "data"

NEW_YORK = ZoneInfo("America/New_York")
FIRST_MONTH = (2025, 7)
MONTHS = 12

NEIGHBORHOOD_SHIFT = 10
BOROUGH_SHIFT = 19
UNRECORDED_DETAILS = {"", "N/A"}
UNRECORDED_NAME = "Not specified"


def new_york_midnight(year: int, month: int, day: int = 1) -> int:
    return int(datetime(year, month, day, tzinfo=NEW_YORK).timestamp())


def month_starts() -> list[tuple[int, int]]:
    year, month = FIRST_MONTH
    months = []
    for _ in range(MONTHS + 1):
        months.append((year, month))
        year, month = (year + 1, 1) if month == 12 else (year, month + 1)
    return months


def day_starts(t_start: int, t_end: int) -> list[int]:
    days = pd.date_range(
        datetime.fromtimestamp(t_start, NEW_YORK),
        datetime.fromtimestamp(t_end, NEW_YORK),
        freq="D",
    )
    return [int(day.timestamp()) - t_start for day in days]


def scale(values: pd.Series, low: float, high: float) -> np.ndarray:
    return np.rint((values - low) / (high - low) * 65535).astype("<u2")


def read_lookup(name: str) -> pd.DataFrame:
    return pd.read_csv(LOOKUPS / f"{name}.csv", keep_default_na=False)


def number_details(calls: pd.DataFrame, details: pd.DataFrame) -> pd.DataFrame:
    """Number each problem's recorded details alphabetically, from 1."""
    pairs = calls[["Problem_ID", "Problem_Detail_ID"]].drop_duplicates()
    pairs = pairs.merge(details, left_on="Problem_Detail_ID", right_on="id")
    pairs = pairs[~pairs["name"].isin(UNRECORDED_DETAILS)].copy()
    pairs["sort_name"] = pairs["name"].str.casefold()
    pairs = pairs.sort_values(["Problem_ID", "sort_name"])
    pairs["Detail_Number"] = pairs.groupby("Problem_ID").cumcount() + 1
    return pairs[["Problem_ID", "Problem_Detail_ID", "Detail_Number", "name"]]


def subject_details(problem: int, numbered: pd.DataFrame, unrecorded: set[int]) -> list[dict]:
    """A problem's details. One lone detail adds nothing to filtering by the problem."""
    rows = numbered[numbered["Problem_ID"] == problem]
    details = [
        {"id": int(row.Detail_Number), "name": row.name}
        for row in rows.itertuples()
    ]
    if details and problem in unrecorded:
        details.append({"id": 0, "name": UNRECORDED_NAME})
    return details if len(details) > 1 else []


def group_subjects(problems: pd.DataFrame) -> list[dict]:
    ids = dict(zip(problems["name"], problems["id"]))
    grouped = [name for names in PROBLEM_GROUPS.values() for name in names]
    if sorted(grouped) != sorted(ids):
        raise ValueError("Every problem must belong to exactly one category")
    return [
        {"name": group, "subjects": [int(ids[name]) for name in names]}
        for group, names in PROBLEM_GROUPS.items()
    ]


def main():
    calls = pd.read_csv(
        PREPPED,
        usecols=[
            "Created_Timestamp",
            "Problem_ID",
            "Problem_Detail_ID",
            "Borough_ID",
            "Neighborhood_ID",
            "Latitude",
            "Longitude",
        ],
        dtype={"Created_Timestamp": "int64", "Problem_ID": "int32"},
    )
    problems = read_lookup("problem")
    boroughs = read_lookup("borough")
    neighborhoods = read_lookup("neighborhood")
    for column in ["Problem_Detail_ID", "Borough_ID", "Neighborhood_ID"]:
        calls[column] = calls[column].fillna(0).astype("int32")

    numbered = number_details(calls, read_lookup("problem_detail"))
    calls = calls.merge(
        numbered.drop(columns="name"), how="left", on=["Problem_ID", "Problem_Detail_ID"]
    )
    calls["Detail_Number"] = calls["Detail_Number"].fillna(0).astype("int64")
    if calls["Detail_Number"].max() >= 1 << NEIGHBORHOOD_SHIFT:
        raise ValueError("A problem has too many details for the tag format")
    unrecorded = set(calls.loc[calls["Detail_Number"] == 0, "Problem_ID"])
    calls["Tags"] = (
        calls["Detail_Number"]
        | calls["Neighborhood_ID"].astype("int64") * (1 << NEIGHBORHOOD_SHIFT)
        | calls["Borough_ID"].astype("int64") * (1 << BOROUGH_SHIFT)
    )

    months = month_starts()
    t_start = new_york_midnight(*months[0])
    t_end = new_york_midnight(*months[-1])
    if calls["Created_Timestamp"].min() < t_start or calls["Created_Timestamp"].max() >= t_end:
        raise ValueError("Calls fall outside the expected date range")

    located = calls["Latitude"].notna() & calls["Longitude"].notna()
    missing = calls[~located].groupby(["Problem_ID", "Tags"]).size()
    points = calls[located].sort_values(
        ["Problem_ID", "Created_Timestamp"], kind="stable"
    )

    bounds = {
        "lonMin": float(points["Longitude"].min()),
        "lonMax": float(points["Longitude"].max()),
        "latMin": float(points["Latitude"].min()),
        "latMax": float(points["Latitude"].max()),
    }
    records = np.empty(
        len(points), dtype=[("x", "<u2"), ("y", "<u2"), ("t", "<u4")]
    )
    records["x"] = scale(points["Longitude"], bounds["lonMin"], bounds["lonMax"])
    records["y"] = scale(points["Latitude"], bounds["latMin"], bounds["latMax"])
    records["t"] = points["Created_Timestamp"] - t_start

    counts = points["Problem_ID"].value_counts()
    subjects, start = [], 0
    for problem in problems.itertuples():
        count = int(counts.get(problem.id, 0))
        subjects.append(
            {
                "id": int(problem.id),
                "name": problem.name,
                "start": start,
                "count": count,
                "details": subject_details(problem.id, numbered, unrecorded),
            }
        )
        start += count

    meta = {
        "count": len(points),
        "bounds": bounds,
        "tStart": t_start,
        "tEnd": t_end,
        "months": [
            {
                "t": new_york_midnight(year, month) - t_start,
                "year": year,
                "month": month,
            }
            for year, month in months
        ],
        "days": day_starts(t_start, t_end),
        "subjects": subjects,
        "groups": group_subjects(problems),
        "boroughs": [
            {"id": int(row.id), "name": row.name.title()} for row in boroughs.itertuples()
        ],
        "neighborhoods": [
            {"id": int(row.id), "name": row.name} for row in neighborhoods.itertuples()
        ],
        "missingCalls": [
            [int(problem), int(tags), int(count)] for (problem, tags), count in missing.items()
        ],
    }

    OUT.mkdir(parents=True, exist_ok=True)
    records.tofile(OUT / "calls.bin")
    points["Tags"].to_numpy(dtype="<u4").tofile(OUT / "tags.bin")
    (OUT / "meta.json").write_text(json.dumps(meta, separators=(",", ":")), encoding="utf-8")
    print(f"{len(points):,} calls, {(~located).sum():,} without coordinates")


if __name__ == "__main__":
    main()
