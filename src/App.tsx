import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { loadCalls, type CallData, type Month } from "./data";
import { CallRenderer, type Rect } from "./renderer";
import { countCallsByDay, selectCalls } from "./selection";
import { SubjectMenu } from "./SubjectMenu";
import { Timeline, type DayRange } from "./Timeline";

const DEFAULT_SUBJECT = "HEAT/HOT WATER";
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "July", "Aug", "Sept", "Oct", "Nov", "Dec"];

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
  const name = MONTH_NAMES[month - 1];
  return index === 0 || month === 1 ? `${name} ${year}` : name;
}

function relativeRect(element: HTMLElement, parent: DOMRect): Rect {
  const { left, top, width, height } = element.getBoundingClientRect();
  return { left: left - parent.left, top: top - parent.top, width, height };
}

function Explorer({ data }: { data: CallData }) {
  const { meta } = data;
  const span = meta.tEnd - meta.tStart;

  const [subjectId, setSubjectId] = useState<number | null>(
    () => meta.subjects.find(({ name }) => name === DEFAULT_SUBJECT)?.id ?? null,
  );
  const [range, setRange] = useState<DayRange>([0, meta.days.length - 1]);
  const [error, setError] = useState<string | null>(null);

  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const mapPlot = useRef<HTMLDivElement>(null);
  const scatterPlot = useRef<HTMLDivElement>(null);
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

  if (error) return <p className="status">{error}</p>;

  const missing = subject ? subject.missing : meta.missing;
  const lastDay = meta.tStart + meta.days[range[1] - 1]!;

  return (
    <main className="app">
      <div className="stage" ref={stage}>
        <canvas className="points" ref={canvas} aria-hidden="true" />

        <section className="panel" aria-label="Map of calls">
          <div className="plot" ref={mapPlot} />
          <header className="heading">
            <h1>311 Calls</h1>
            <SubjectMenu subjects={meta.subjects} selectedId={subjectId} onSelect={setSubjectId} />
            <p className="summary" role="status">
              {selection.insideCount.toLocaleString("en-US")} calls,{" "}
              {dateFormat.format((meta.tStart + tFrom) * 1000)} to {dateFormat.format(lastDay * 1000)}
              {missing > 0 && (
                <>
                  <br />
                  {missing.toLocaleString("en-US")} more this year have no location
                </>
              )}
            </p>
          </header>
        </section>

        <section className="panel scatter" aria-label="Calls by longitude and date">
          <div className="plot" ref={scatterPlot}>
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
        formatDay={(t) => dateFormat.format((meta.tStart + t) * 1000)}
        onChange={setRange}
      />
    </main>
  );
}
