import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { loadCalls, monthName, type CallData, type Month } from "./data";
import { CallRenderer, SCATTER_FILL_X, type Rect } from "./renderer";
import { countCallsByDay, selectCalls } from "./selection";
import { SubjectMenu } from "./SubjectMenu";
import { Timeline, type DayRange } from "./Timeline";

const DEFAULT_SUBJECT = "HEAT/HOT WATER";
const ALL_CALLS = "All calls";
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

  const [subjectId, setSubjectId] = useState<number | null>(
    () => meta.subjects.find(({ name }) => name === DEFAULT_SUBJECT)?.id ?? null,
  );
  const [range, setRange] = useState<DayRange>(fullRange);
  const [announcement, setAnnouncement] = useState("");
  const [error, setError] = useState<string | null>(null);

  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const mapPlot = useRef<HTMLDivElement>(null);
  const scatterPlot = useRef<HTMLDivElement>(null);
  const startHandle = useRef<HTMLDivElement>(null);
  const renderer = useRef<CallRenderer | null>(null);

  const subject = meta.subjects.find(({ id }) => id === subjectId) ?? null;
  const tFrom = meta.days[range[0]]!;
  const tTo = meta.days[range[1]]!;
  const isFiltered = range[0] > 0 || range[1] < meta.days.length - 1;

  const selection = useMemo(
    () => selectCalls(data, subject, tFrom, tTo),
    [data, subject, tFrom, tTo],
  );
  const dailyCounts = useMemo(() => countCallsByDay(data, subject), [data, subject]);

  const formatDay = (t: number) => dateFormat.format((meta.tStart + t) * 1000);
  const callCount = selection.insideCount.toLocaleString("en-US");
  const dates = `${formatDay(tFrom)} to ${formatDay(meta.days[range[1] - 1]!)}`;
  const description = `${subject?.name ?? ALL_CALLS}: ${callCount} calls, ${dates}`;

  useLayoutEffect(() => {
    let current: CallRenderer;
    try {
      current = new CallRenderer(canvas.current!, data.buffer, meta);
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
  }, [data, meta]);

  useLayoutEffect(() => {
    renderer.current?.setSelection(selection);
  }, [selection]);

  // Screen readers hear the result once the range settles, not every day of a drag.
  useEffect(() => {
    const timer = setTimeout(() => setAnnouncement(description), ANNOUNCE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [description]);

  if (error) return <p className="status">{error}</p>;

  const missing = subject ? subject.missing : meta.missing;
  const peakCount = Math.max(...dailyCounts);
  const peakDay = formatDay(meta.days[dailyCounts.indexOf(peakCount)]!);
  const peakText = peakCount > 0 ? ` The busiest day was ${peakDay}.` : "";

  let emptyMessage = null;
  if (selection.totalCount === 0) {
    emptyMessage = "None of these calls have a location, so there's nothing to plot.";
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
        <h1>311 Calls</h1>
        <SubjectMenu
          allCallsLabel={ALL_CALLS}
          subjects={meta.subjects}
          selectedId={subjectId}
          onSelect={setSubjectId}
        />
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
          <button
            type="button"
            className="reset"
            style={{ visibility: isFiltered ? "visible" : "hidden" }}
            onClick={resetRange}
          >
            Reset dates
          </button>
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
        startHandle={startHandle}
      />
    </main>
  );
}
