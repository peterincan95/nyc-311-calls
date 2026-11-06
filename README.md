# NYC 311 Calls

Explore a year of New York City 311 calls, from July 2025 through June 2026. The left panel plots calls by location. The right panel plots them by longitude and date. Filter by category, problem or problem detail, by borough or neighborhood, and by date. Both dropdowns have a search box.

## Run the app

Requires Node 20 or later. The processed data is in the repo, so this is all you need:

```bash
npm install
npm run dev
```

## How it works

- **Data:** `public/data/calls.bin` stores 8 bytes per call. Calls are sorted by problem, then time, so problem and date filters select contiguous rows. `public/data/tags.bin` stores each call's detail, neighborhood and borough in 4 bytes, and the GPU uses them to hide calls that don't match. `public/data/meta.json` describes where each problem starts and which problems are in each category. Categories are defined in `scripts/problem_groups.py`.
- **Rendering:** a small WebGL2 renderer in `src/renderer.ts` adds every point into a density buffer, then turns density into light with a two-size glow. Both panels share one canvas and one copy of the data.
- **Missing locations:** calls with no coordinates can't be plotted, so they are left out of the binary file. The app reports how many there are for the current problem.
- **Dates:** times are New York local time, and days and months begin at New York midnight.

## Rebuild the data

The source CSVs are too large for GitHub, so they aren't in the repo. To rebuild the data, put the raw export at `data/NYC311Calls.csv`. The scripts need Python with pandas.

```bash
python scripts/prep_data.py
```

```bash
python scripts/export_binary.py
```

`prep_data.py` replaces text fields with integer IDs, writes the tables in `data/lookups/`, converts dates to Unix timestamps, removes exact duplicate rows and drops `Resolution_Description`. `export_binary.py` then writes the two files the app loads.
