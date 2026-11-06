"""Prepare the raw NYC 311 export for the web app.

Reads   data/NYC311Calls.csv (never modified)
Writes  data/NYC311Calls_prepped.csv
        data/lookups/<field>.csv, each with columns: id,name

String fields become integer IDs:
  * IDs start at 1 and follow case-insensitive alphabetical order of the names.
  * Values that differ only in spacing or case share one ID. The lookup name is
    the most common spelling, with whitespace tidied.
  * Blank values stay blank in the output and have no lookup entry.

Created_Date and Closed_Date become Unix timestamps (whole seconds, UTC):
  * The source times are New York wall-clock times, so display them in
    America/New_York rather than the viewer's local zone.
  * Times in the repeated fall-back hour are read as the first occurrence (EDT).
  * Times in the skipped spring-forward hour are moved to 03:00 EDT.
  * Blank close dates stay blank.

Rows that exactly repeat an earlier row in every column are removed, keeping the
first copy. Resolution_Description is dropped. Every other column passes through
unchanged.
"""
from pathlib import Path

import numpy as np
import pandas as pd

DATA = Path(__file__).resolve().parent.parent / "data"
SOURCE = DATA / "NYC311Calls.csv"
OUTPUT = DATA / "NYC311Calls_prepped.csv"
LOOKUPS = DATA / "lookups"

# source column -> (output ID column, lookup file stem)
FIELDS = {
    "Agency_Name": ("Agency_ID", "agency"),
    "Problem__formerly_Complaint_Type_": ("Problem_ID", "problem"),
    "Problem_Detail__formerly_Descriptor_": ("Problem_Detail_ID", "problem_detail"),
    "Location_Type": ("Location_Type_ID", "location_type"),
    "Street_Name": ("Street_Name_ID", "street_name"),
    "Borough": ("Borough_ID", "borough"),
    "ntaname": ("Neighborhood_ID", "neighborhood"),
}
DATES = {"Created_Date": "Created_Timestamp", "Closed_Date": "Closed_Timestamp"}
KEY = "Unique_Key"
DROPPED_COLUMNS = ["Resolution_Description"]

DATE_FORMAT = "%m/%d/%Y %I:%M:%S %p"
TIMEZONE = "America/New_York"
EPOCH = pd.Timestamp("1970-01-01", tz="UTC")
CHUNK_ROWS = 250_000


def read_source(**kwargs):
    # keep_default_na=False stops literal values such as "NA" becoming nulls.
    return pd.read_csv(
        SOURCE, dtype=str, keep_default_na=False, encoding="utf-8-sig", **kwargs
    )


def tidy(values: pd.Series) -> pd.Series:
    return values.str.replace(r"\s+", " ", regex=True).str.strip()


def build_lookup(counts: pd.Series) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Turn raw value counts into (raw value -> id table, id/name lookup table)."""
    table = counts.rename("n").rename_axis("raw").reset_index()
    table["tidy"] = tidy(table["raw"])
    table = table[table["tidy"] != ""].copy()
    table["key"] = table["tidy"].str.upper()

    spellings = table.groupby(["key", "tidy"], as_index=False)["n"].sum()
    names = (
        spellings.sort_values(["n", "tidy"], ascending=[False, True])
        .drop_duplicates("key")
        .sort_values("key")
        .reset_index(drop=True)
    )
    names["id"] = names.index + 1
    return table.merge(names[["key", "id"]], on="key"), names[["id", "tidy"]].rename(
        columns={"tidy": "name"}
    )


def to_timestamps(values: pd.Series) -> pd.Series:
    naive = pd.to_datetime(values.replace("", None), format=DATE_FORMAT)
    local = naive.dt.tz_localize(
        TIMEZONE,
        ambiguous=np.ones(len(naive), dtype=bool),
        nonexistent="shift_forward",
    )
    return ((local - EPOCH) // pd.Timedelta(seconds=1)).astype("Int64")


def drop_repeated_rows(chunk: pd.DataFrame, repeated_keys: set, seen_rows: set) -> pd.DataFrame:
    """Remove rows that exactly match an earlier row, including in earlier chunks."""
    keep = pd.Series(True, index=chunk.index)
    for index, row in chunk[chunk[KEY].isin(repeated_keys)].iterrows():
        values = tuple(row)
        keep[index] = values not in seen_rows
        seen_rows.add(values)
    return chunk[keep]


def main():
    # Pass 1: count the values in each field so the IDs cover the whole file, and
    # note repeated keys, since copies of a row can land in different chunks.
    counts = {field: None for field in FIELDS}
    seen_keys, repeated_keys = set(), set()
    for chunk in read_source(usecols=[KEY, *FIELDS], chunksize=CHUNK_ROWS):
        keys = chunk[KEY]
        repeated_keys.update(keys[keys.duplicated() | keys.isin(seen_keys)])
        seen_keys.update(keys)
        for field in FIELDS:
            current = chunk[field].value_counts()
            counts[field] = (
                current if counts[field] is None else counts[field].add(current, fill_value=0)
            )

    LOOKUPS.mkdir(exist_ok=True)
    id_maps = {}
    for field, (_, stem) in FIELDS.items():
        raw_to_id, lookup = build_lookup(counts[field])
        id_maps[field] = raw_to_id.set_index("raw")["id"]
        lookup.to_csv(LOOKUPS / f"{stem}.csv", index=False, encoding="utf-8", lineterminator="\n")
        print(f"{stem}: {len(lookup):,} values ({len(raw_to_id):,} raw spellings)")

    # Pass 2: rewrite the data in chunks, keeping the original column order.
    rows = 0
    seen_rows = set()
    # Write beside the output and swap at the end, so a failed run keeps the last good file.
    partial = OUTPUT.with_suffix(".csv.tmp")
    with open(partial, "w", encoding="utf-8", newline="") as out:
        for chunk in read_source(chunksize=CHUNK_ROWS):
            chunk = drop_repeated_rows(chunk, repeated_keys, seen_rows)
            chunk = chunk.drop(columns=DROPPED_COLUMNS)
            renames = {}
            for field, (id_column, _) in FIELDS.items():
                chunk[field] = chunk[field].map(id_maps[field]).astype("Int64")
                renames[field] = id_column
            for field, timestamp_column in DATES.items():
                chunk[field] = to_timestamps(chunk[field])
                renames[field] = timestamp_column
            chunk = chunk.rename(columns=renames)
            chunk.to_csv(out, index=False, header=rows == 0, lineterminator="\n")
            rows += len(chunk)
            print(f"wrote {rows:,} rows", flush=True)
    partial.replace(OUTPUT)


if __name__ == "__main__":
    main()
