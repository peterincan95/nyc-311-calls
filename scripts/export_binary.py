"""Export the prepped calls to the compact files the web app loads.

Reads   data/NYC311Calls_prepped.csv, data/lookups/problem.csv
Writes  public/data/calls.bin, public/data/meta.json

calls.bin holds 8 bytes per call, little-endian:
  uint16 x      longitude scaled from bounds.lonMin..lonMax to 0..65535
  uint16 y      latitude scaled from bounds.latMin..latMax to 0..65535
  uint32 t      seconds since tStart

Calls are sorted by problem, then time, so any problem and time filter selects
contiguous rows. meta.json gives each problem's start row and count. Calls with
no coordinates can't be plotted: they are left out and counted as `missing`.
"""
import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
PREPPED = ROOT / "data" / "NYC311Calls_prepped.csv"
PROBLEMS = ROOT / "data" / "lookups" / "problem.csv"
OUT = ROOT / "public" / "data"

NEW_YORK = ZoneInfo("America/New_York")
FIRST_MONTH = (2025, 7)
MONTHS = 12


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


def main():
    calls = pd.read_csv(
        PREPPED,
        usecols=["Created_Timestamp", "Problem_ID", "Latitude", "Longitude"],
        dtype={"Created_Timestamp": "int64", "Problem_ID": "int32"},
    )
    problems = pd.read_csv(PROBLEMS, keep_default_na=False)

    months = month_starts()
    t_start = new_york_midnight(*months[0])
    t_end = new_york_midnight(*months[-1])
    if calls["Created_Timestamp"].min() < t_start or calls["Created_Timestamp"].max() >= t_end:
        raise ValueError("Calls fall outside the expected date range")

    located = calls["Latitude"].notna() & calls["Longitude"].notna()
    missing = calls.loc[~located, "Problem_ID"].value_counts()
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
                "missing": int(missing.get(problem.id, 0)),
            }
        )
        start += count

    meta = {
        "count": len(points),
        "missing": int((~located).sum()),
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
    }

    OUT.mkdir(parents=True, exist_ok=True)
    records.tofile(OUT / "calls.bin")
    (OUT / "meta.json").write_text(json.dumps(meta, separators=(",", ":")), encoding="utf-8")
    print(f"{len(points):,} calls, {(~located).sum():,} without coordinates")


if __name__ == "__main__":
    main()
