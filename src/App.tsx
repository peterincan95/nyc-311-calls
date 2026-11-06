import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BoxOutline, gridToShare, shareToGrid, useBoxDraw, type Box } from "./box";
import { loadCalls, monthName, type CallData, type Month } from "./data";
import { ColumnMenu } from "./ColumnMenu";
import {
  buildComplaintMenu,
  buildPlaceMenu,
  combineTags,
  countMissing,
  type Filter,
  type Place,
} from "./filters";
import { CallRenderer, mapFill, SCATTER_FILL_X, type Rect } from "./renderer";
import {
  countCallsByDay,
  countComplaints,
  countPlaces,
  selectCalls,
  WHOLE_CITY,
  type Area,
} from "./selection";
import { Timeline, type DayRange } from "./Timeline";

const LONGITUDE_TICKS = [-74.2, -74.1, -74, -73.9, -73.8];
const ANNOUNCE_DELAY_MS = 600;

const dateFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  month: "short",
  day: "numeric",
  year: "numeric",
});

export function App() {
  const [data, setData] = useState<CallData | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadCalls(setProgress).then(setData, (reason: Error) => setError(reason.message));
  }, []);

  if (error) return <p className="status">{error}</p>;
  if (!data) {
    return (
      <p className="status" role="status">
        Loading 311 calls… {Math.round(progress * 100)}%
      </p>
    );
  }
  return <Explorer data={data} />;
}

function monthLabel({ year, month }: Month, index: number) {
  const name = monthName(month);
  return index === 0 || month === 1 ? `${name} ${year}` : name;
}

/** Puts off an expensive count until something asks for it, then keeps the answer. */
function lazyCounts<T>(count: () => (value: T) => number) {
  let counts: ((value: T) => number) | null = null;
  return (value: T) => (counts ??= count())(value);
}

function relativeRect(element: HTMLElement, parent: DOMRect): Rect {
  const { left, top, width, height } = element.getBoundingClientRect();
  return { left: left - parent.left, top: top - parent.top, width, height };
}

function Explorer({ data }: { data: CallData }) {
  const { meta } = data;
  const span = meta.tEnd - meta.tStart;
  const fullRange: DayRange = [0, meta.days.length - 1];

  const complaintMenu = useMemo(() => buildComplaintMenu(meta), [meta]);
  const placeMenu = useMemo(() => buildPlaceMenu(meta), [meta]);
  const [filter, setFilter] = useState<Filter>(complaintMenu[0]!.value!);
  const [place, setPlace] = useState<Place>(placeMenu[0]!.value!);
  const [range, setRange] = useState<DayRange>(fullRange);
  const [area, setArea] = useState<Area>(WHOLE_CITY);
  // A box on the scatterplot also sets the dates, so clearing it should too.
  const [boxSetDates, setBoxSetDates] = useState(false);
  const [fill, setFill] = useState<[number, number]>([1, 1]);
  const [announcement, setAnnouncement] = useState("");
  const [error, setError] = useState<string | null>(null);

  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const mapPlot = useRef<HTMLDivElement>(null);
  const scatterPlot = useRef<HTMLDivElement>(null);
  const startHandle = useRef<HTMLDivElement>(null);
  const renderer = useRef<CallRenderer | null>(null);

  const tFrom = meta.days[range[0]]!;
  const tTo = meta.days[range[1]]!;
  const isFiltered = range[0] > 0 || range[1] < meta.days.length - 1;

  const hasArea = area !== WHOLE_CITY;
  const hasBox = hasArea || boxSetDates;

  const tags = useMemo(() => combineTags(filter, place), [filter, place]);
  const dailyCounts = useMemo(
    () => countCallsByDay(data, filter.subjects, tags, area),
    [data, filter, tags, area],
  );
  const selection = useMemo(
    () => selectCalls(data, filter.subjects, tags, area, dailyCounts, range[0], range[1]),
    [data, filter, tags, area, dailyCounts, range],
  );

  const complaintCounts = useMemo(
    () => lazyCounts(() => countComplaints(data, place, area, tFrom, tTo)),
    [data, place, area, tFrom, tTo],
  );
  const placeCounts = useMemo(
    () => lazyCounts(() => countPlaces(data, filter, area, tFrom, tTo)),
    [data, filter, area, tFrom, tTo],
  );

  const formatDay = (t: number) => dateFormat.format((meta.tStart + t) * 1000);
  const callCount = selection.insideCount.toLocaleString("en-US");
  const dates = `${formatDay(tFrom)} to ${formatDay(meta.days[range[1] - 1]!)}`;
  const boxNote = hasBox ? " inside the drawn box" : "";
  const description = `${filter.name} in ${place.name}${boxNote}: ${callCount} calls, ${dates}`;

  useLayoutEffect(() => {
    let current: CallRenderer;
    try {
      current = new CallRenderer(canvas.current!, data);
    } catch (reason) {
      setError((reason as Error).message);
      return;
    }
    renderer.current = current;
    if (import.meta.env.DEV) Object.assign(window, { callRenderer: current });

    const updateLayout = () => {
      const bounds = stage.current!.getBoundingClientRect();
      const map = relativeRect(mapPlot.current!, bounds);
      current.setLayout(
        bounds.width,
        bounds.height,
        map,
        relativeRect(scatterPlot.current!, bounds),
      );
      setFill(mapFill(meta.bounds, map.width, map.height));
    };
    const observer = new ResizeObserver(updateLayout);
    observer.observe(stage.current!);
    updateLayout();

    return () => {
      observer.disconnect();
      current.destroy();
      renderer.current = null;
    };
  }, [data, meta]);

  useLayoutEffect(() => {
    renderer.current?.setSelection(selection);
  }, [selection]);

  // Screen readers hear the result once the range settles, not every day of a drag.
  useEffect(() => {
    const timer = setTimeout(() => setAnnouncement(description), ANNOUNCE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [description]);

  const drawOnMap = ({ left, right, top, bottom }: Box) => {
    setArea({
      west: shareToGrid(left, fill[0]),
      east: shareToGrid(right, fill[0]),
      south: shareToGrid(1 - bottom, fill[1]),
      north: shareToGrid(1 - top, fill[1]),
    });
  };

  const drawOnScatter = ({ left, right, top, bottom }: Box) => {
    setArea({
      ...area,
      west: shareToGrid(left, SCATTER_FILL_X),
      east: shareToGrid(right, SCATTER_FILL_X),
    });
    const lastDay = meta.days.length - 1;
    const from = meta.days.findLastIndex((t) => t <= top * span);
    const to = meta.days.findIndex((t) => t >= bottom * span);
    setRange([Math.min(from, lastDay - 1), Math.max(to, from + 1)]);
    setBoxSetDates(true);
  };

  const clearBox = () => {
    setArea(WHOLE_CITY);
    if (boxSetDates) setRange(fullRange);
    setBoxSetDates(false);
    startHandle.current?.focus();
  };

  const mapDraw = useBoxDraw(drawOnMap);
  const scatterDraw = useBoxDraw(drawOnScatter);

  if (error) return <p className="status">{error}</p>;

  // Calls with no coordinates can't be inside a box.
  const missing = hasArea ? 0 : countMissing(meta, filter.subjects, tags);
  const peakCount = Math.max(...dailyCounts);
  const peakDay = formatDay(meta.days[dailyCounts.indexOf(peakCount)]!);
  const peakText = peakCount > 0 ? ` The busiest day was ${peakDay}.` : "";

  let emptyMessage = null;
  if (selection.totalCount === 0 && hasArea) {
    emptyMessage = "No calls like these in this box. Try a bigger box.";
  } else if (selection.totalCount === 0 && missing > 0) {
    emptyMessage = "None of these calls have a location, so there's nothing to plot.";
  } else if (selection.totalCount === 0) {
    emptyMessage = `No calls like these in ${place.name}. Try a wider area.`;
  } else if (selection.insideCount === 0) {
    emptyMessage = "No calls in these dates. Try a wider range.";
  }

  const longitudePosition = (longitude: number) => {
    const { lonMin, lonMax } = meta.bounds;
    const share = (longitude - lonMin) / (lonMax - lonMin);
    return `${50 + (share - 0.5) * SCATTER_FILL_X * 100}%`;
  };

  const resetRange = () => {
    setRange(fullRange);
    startHandle.current?.focus();
  };

  const mapBox: Box = {
    left: gridToShare(area.west, fill[0]),
    right: gridToShare(area.east, fill[0]),
    top: 1 - gridToShare(area.north, fill[1]),
    bottom: 1 - gridToShare(area.south, fill[1]),
  };
  const scatterBox: Box = {
    left: gridToShare(area.west, SCATTER_FILL_X),
    right: gridToShare(area.east, SCATTER_FILL_X),
    top: tFrom / span,
    bottom: tTo / span,
  };

  return (
    <main className="app">
      <header className="header">
        <div className="sentence">
          <h1>311 Calls</h1>
          <ColumnMenu
            id="complaint"
            label="regarding"
            items={complaintMenu}
            columnNames={["Categories", "Complaints", "Details"]}
            searchLabel="Search categories, complaints and details"
            selected={filter}
            selectedName={filter.name}
            onSelect={setFilter}
            countOf={complaintCounts}
          />
          <ColumnMenu
            id="place"
            label="in"
            items={placeMenu}
            columnNames={["Geography types", "Places"]}
            searchLabel="Search boroughs and neighborhoods"
            selected={place}
            selectedName={place.name}
            onSelect={setPlace}
            countOf={placeCounts}
          />
        </div>
        <div className="summary">
          <p>
            <strong>{callCount}</strong> calls{hasBox && " in the box"}
            {missing > 0 && (
              <span className="summary-note">
                {" "}
                · {missing.toLocaleString("en-US")} more this year have no location
              </span>
            )}
          </p>
        </div>
      </header>

      <p className="visually-hidden" role="status">
        {announcement}
      </p>

      <div className="stage" ref={stage}>
        <canvas className="points" ref={canvas} aria-hidden="true" />

        <section className="panel" aria-label="Map of calls">
          <div
            className="plot"
            ref={mapPlot}
            role="img"
            aria-label={`Map of New York City. ${description}.`}
            {...mapDraw.handlers}
          >
            {hasArea && <BoxOutline box={mapBox} />}
            {mapDraw.draft && <BoxOutline box={mapDraw.draft} draft />}
          </div>
          {emptyMessage && <p className="empty">{emptyMessage}</p>}
          <div className="box-bar">
            {hasBox ? (
              <button className="pill" type="button" onClick={clearBox}>
                Clear box
              </button>
            ) : (
              <p>Drag on the map or chart to select an area</p>
            )}
          </div>
        </section>

        <section className="panel scatter" aria-label="Calls by longitude and date">
          <div
            className="plot"
            ref={scatterPlot}
            role="img"
            aria-label={`Scatterplot of longitude against date for the full year, highlighting ${dates}.${peakText}`}
            {...scatterDraw.handlers}
          >
            {meta.months.slice(0, -1).map((month, index) => (
              <span
                className="month"
                key={month.t}
                style={{ top: `${(month.t / span) * 100}%` }}
              >
                {monthLabel(month, index)}
              </span>
            ))}
            {isFiltered &&
              [tFrom, tTo].map((t, index) => (
                <div className="edge" key={index} style={{ top: `${(t / span) * 100}%` }} />
              ))}
            {hasBox && <BoxOutline box={scatterBox} />}
            {scatterDraw.draft && <BoxOutline box={scatterDraw.draft} draft />}
            <div className="x-axis">
              {LONGITUDE_TICKS.map((longitude) => (
                <span key={longitude} style={{ left: longitudePosition(longitude) }}>
                  {Math.abs(longitude).toFixed(1)}°W
                </span>
              ))}
              <p className="x-axis-title">Longitude, west to east</p>
            </div>
          </div>
        </section>
      </div>

      <Timeline
        days={meta.days}
        months={meta.months}
        dailyCounts={dailyCounts}
        span={span}
        range={range}
        isFiltered={isFiltered}
        formatDay={formatDay}
        onChange={setRange}
        onReset={resetRange}
        startHandle={startHandle}
      />
    </main>
  );
}
