import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { CallRenderer, SCATTER_FILL_X, type Rect } from "./renderer";
import { countCallsByDay, selectCalls } from "./selection";
import { Timeline, type DayRange } from "./Timeline";

const DEFAULT_SUBJECT = "HEAT/HOT WATER";
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
  const [filter, setFilter] = useState<Filter>(() => {
    const complaints = complaintMenu.flatMap(({ children }) => children);
    const complaint = complaints.find(({ name }) => name === DEFAULT_SUBJECT) ?? complaintMenu[0]!;
    return complaint.value!;
  });
  const [place, setPlace] = useState<Place>(placeMenu[0]!.value!);
  const [range, setRange] = useState<DayRange>(fullRange);
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

  const tags = useMemo(() => combineTags(filter, place), [filter, place]);
  const dailyCounts = useMemo(
    () => countCallsByDay(data, filter.subjects, tags),
    [data, filter, tags],
  );
  const selection = useMemo(
    () => selectCalls(data, filter.subjects, tags, dailyCounts, range[0], range[1]),
    [data, filter, tags, dailyCounts, range],
  );

  const formatDay = (t: number) => dateFormat.format((meta.tStart + t) * 1000);
  const callCount = selection.insideCount.toLocaleString("en-US");
  const dates = `${formatDay(tFrom)} to ${formatDay(meta.days[range[1] - 1]!)}`;
  const description = `${filter.name} in ${place.name}: ${callCount} calls, ${dates}`;

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
      current.setLayout(
        bounds.width,
        bounds.height,
        relativeRect(mapPlot.current!, bounds),
        relativeRect(scatterPlot.current!, bounds),
      );
    };
    const observer = new ResizeObserver(updateLayout);
    observer.observe(stage.current!);
    updateLayout();

    return () => {
      observer.disconnect();
      current.destroy();
      renderer.current = null;
    };
  }, [data]);

  useLayoutEffect(() => {
    renderer.current?.setSelection(selection);
  }, [selection]);

  // Screen readers hear the result once the range settles, not every day of a drag.
  useEffect(() => {
    const timer = setTimeout(() => setAnnouncement(description), ANNOUNCE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [description]);

  if (error) return <p className="status">{error}</p>;

  const missing = countMissing(meta, filter.subjects, tags);
  const peakCount = Math.max(...dailyCounts);
  const peakDay = formatDay(meta.days[dailyCounts.indexOf(peakCount)]!);
  const peakText = peakCount > 0 ? ` The busiest day was ${peakDay}.` : "";

  let emptyMessage = null;
  if (selection.totalCount === 0 && missing > 0) {
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
          />
        </div>
        <div className="summary">
          <p>
            <strong>{callCount}</strong> calls
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
          />
          {emptyMessage && <p className="empty">{emptyMessage}</p>}
        </section>

        <section className="panel scatter" aria-label="Calls by longitude and date">
          <div
            className="plot"
            ref={scatterPlot}
            role="img"
            aria-label={`Scatterplot of longitude against date for the full year, highlighting ${dates}.${peakText}`}
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
