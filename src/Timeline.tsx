import { useMemo, useRef, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { monthName, type Month } from "./data";
import { COLOR_STOPS } from "./renderer";

const chartColor = COLOR_STOPS[COLOR_STOPS.length - 2];

/** Indexes into the day list. The range covers `from` up to, but not including, `to`. */
export type DayRange = [from: number, to: number];

type DragKind = "from" | "to" | "band";

// The chart and day ticks share one SVG coordinate system, stretched to fit the track.
const VIEW_WIDTH = 1000;
const VIEW_HEIGHT = 100;
const CHART_HEIGHT = 90;
const DAY_TICK_HEIGHT = 9;

const DOUBLE_PRESS_MS = 350;

interface Drag {
  kind: DragKind;
  startDay: number;
  startRange: DayRange;
}

interface TimelineProps {
  days: number[];
  months: Month[];
  dailyCounts: Uint32Array;
  span: number;
  range: DayRange;
  isFiltered: boolean;
  formatDay: (t: number) => string;
  onChange: (range: DayRange) => void;
  onReset: () => void;
  startHandle: RefObject<HTMLDivElement | null>;
}

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

function dayTicksPath(days: number[], months: Month[], span: number) {
  const monthStarts = new Set(months.map(({ t }) => t));
  return days
    .filter((day) => !monthStarts.has(day))
    .map((day) => `M${(day / span) * VIEW_WIDTH} 0V${DAY_TICK_HEIGHT}`)
    .join("");
}

/** The days from `from` to the same date next month, or that month's end if it's shorter. */
function daysInMonthFrom(from: number, monthStarts: number[]) {
  const month = monthStarts.filter((start) => start <= from).length - 1;
  const next = monthStarts[month + 1]!;
  const nextLength = (monthStarts[month + 2] ?? Infinity) - next;
  return next + Math.min(from - monthStarts[month]!, nextLength) - from;
}

/** Plots each day's count at the middle of that day. */
function countChartPaths(days: number[], dailyCounts: Uint32Array, span: number) {
  const peak = Math.max(1, ...dailyCounts);
  const middleOfDay = (day: number) => ((days[day]! + days[day + 1]!) / 2 / span) * VIEW_WIDTH;
  const points = Array.from(dailyCounts, (count, day) => {
    return `${middleOfDay(day)} ${VIEW_HEIGHT - (count / peak) * CHART_HEIGHT}`;
  });
  const line = `M${points.join("L")}`;
  const lastX = middleOfDay(dailyCounts.length - 1);
  return { line, area: `${line}L${lastX} ${VIEW_HEIGHT}L${middleOfDay(0)} ${VIEW_HEIGHT}Z` };
}

export function Timeline({
  days,
  months,
  dailyCounts,
  span,
  range,
  isFiltered,
  formatDay,
  onChange,
  onReset,
  startHandle,
}: TimelineProps) {
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const lastPress = useRef(0);
  const lastDay = days.length - 1;
  const [from, to] = range;
  const percent = (t: number) => `${(t / span) * 100}%`;
  const bandMiddle = ((days[from]! + days[to]!) / 2 / span) * 100;

  const dayTicks = useMemo(() => dayTicksPath(days, months, span), [days, months, span]);
  const chart = useMemo(
    () => countChartPaths(days, dailyCounts, span),
    [days, dailyCounts, span],
  );

  const monthStarts = useMemo(() => months.map(({ t }) => days.indexOf(t)), [days, months]);
  const presets = [
    { label: "1 Month", length: daysInMonthFrom(from, monthStarts) },
    { label: "1 Week", length: 7 },
    { label: "1 Day", length: 1 },
  ];

  /** Keeps the start date, moving it back only if the range would run past the last day. */
  const applyPreset = (length: number) => {
    const end = Math.min(from + length, lastDay);
    onChange([Math.max(end - length, 0), end]);
  };

  const nearestDay = (clientX: number) => {
    const { left, width } = track.current!.getBoundingClientRect();
    const t = clamp((clientX - left) / width, 0, 1) * span;
    let nearest = 0;
    days.forEach((day, index) => {
      if (Math.abs(day - t) < Math.abs(days[nearest]! - t)) nearest = index;
    });
    return nearest;
  };

  const moved = (kind: DragKind, startRange: DayRange, change: number): DayRange => {
    const [startFrom, startTo] = startRange;
    if (kind === "from") return [clamp(startFrom + change, 0, startTo - 1), startTo];
    if (kind === "to") return [startFrom, clamp(startTo + change, startFrom + 1, lastDay)];
    const shift = clamp(change, -startFrom, lastDay - startTo);
    return [startFrom + shift, startTo + shift];
  };

  const startDrag = (kind: DragKind) => (event: PointerEvent<HTMLElement>) => {
    event.preventDefault();
    // Counted from presses, not dblclick, so it also works on touch screens.
    const isDoublePress = event.timeStamp - lastPress.current < DOUBLE_PRESS_MS;
    lastPress.current = event.timeStamp;
    if (isDoublePress && isFiltered) {
      lastPress.current = 0;
      onReset();
      return;
    }
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { kind, startDay: nearestDay(event.clientX), startRange: range };
  };

  const onDrag = (event: PointerEvent) => {
    if (!drag.current) return;
    const { kind, startDay, startRange } = drag.current;
    const next = moved(kind, startRange, nearestDay(event.clientX) - startDay);
    if (next[0] !== from || next[1] !== to) onChange(next);
  };

  const endDrag = () => {
    drag.current = null;
  };

  const onKeyDown = (kind: DragKind) => (event: KeyboardEvent) => {
    const step = event.shiftKey ? 7 : 1;
    const change = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step }[event.key];
    if (change === undefined) return;
    event.preventDefault();
    onChange(moved(kind, range, change));
  };

  const handle = (kind: "from" | "to", day: number, label: string, valueDay: number) => (
    <div
      className={`handle handle-${kind}`}
      ref={kind === "from" ? startHandle : undefined}
      style={{ left: percent(days[day]!) }}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={kind === "from" ? 0 : from + 1}
      aria-valuemax={kind === "from" ? to - 1 : lastDay}
      aria-valuenow={day}
      aria-valuetext={formatDay(days[valueDay]!)}
      onPointerDown={startDrag(kind)}
      onPointerMove={onDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown(kind)}
    />
  );

  return (
    <div className="timeline">
      <div className="range-pills" role="group" aria-label="Date range">
        {presets.map(({ label, length }) => (
          <button
            type="button"
            className="pill"
            key={label}
            aria-pressed={to - from === length}
            onClick={() => applyPreset(length)}
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          className="pill pill-icon"
          aria-label="Reset to the full year"
          title="Reset to the full year"
          disabled={!isFiltered}
          onClick={onReset}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3.5 6.5a5 5 0 1 1-.2 3.2" />
            <path d="M3 2.5v4h4" />
          </svg>
        </button>
      </div>
      <div className="range-row" aria-hidden="true">
        <span
          className="range-label"
          style={{ left: `clamp(112px, ${bandMiddle}%, calc(100% - 112px))` }}
        >
          {formatDay(days[from]!)} – {formatDay(days[to - 1]!)}
        </span>
      </div>
      <div className="track" ref={track}>
        <div
          className={isFiltered ? "band band-filtered" : "band"}
          style={{ left: percent(days[from]!), right: `${100 - (days[to]! / span) * 100}%` }}
          onPointerDown={startDrag("band")}
          onPointerMove={onDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        />
        <svg
          className="chart"
          viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path className="chart-area" d={chart.area} style={{ fill: chartColor }} />
          <path
            className="chart-line"
            d={chart.line}
            style={{ stroke: chartColor }}
          />
          <path className="day-ticks" d={dayTicks} />
        </svg>
        {months.slice(0, -1).map(({ t }) => (
          <div className="tick" key={t} style={{ left: percent(t) }} />
        ))}
        {handle("from", from, "Start date", from)}
        {handle("to", to, "End date", to - 1)}
      </div>
      <div className="month-row" aria-hidden="true">
        {months.slice(0, -1).map(({ t, month }, index) => (
          <span
            key={t}
            style={{ left: percent(t), width: percent(months[index + 1]!.t - t) }}
          >
            {monthName(month)}
          </span>
        ))}
      </div>
    </div>
  );
}
