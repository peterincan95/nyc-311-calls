import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import type { Month } from "./data";

/** Indexes into the day list. The range covers `from` up to, but not including, `to`. */
export type DayRange = [from: number, to: number];

type DragKind = "from" | "to" | "band";

interface Drag {
  kind: DragKind;
  startDay: number;
  startRange: DayRange;
}

interface TimelineProps {
  days: number[];
  months: Month[];
  span: number;
  range: DayRange;
  isFiltered: boolean;
  formatDay: (t: number) => string;
  onChange: (range: DayRange) => void;
}

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

export function Timeline({ days, months, span, range, isFiltered, formatDay, onChange }: TimelineProps) {
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const lastDay = days.length - 1;
  const [from, to] = range;
  const percent = (t: number) => `${(t / span) * 100}%`;

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
      <div className="track" ref={track}>
        <div
          className={isFiltered ? "band band-filtered" : "band"}
          style={{ left: percent(days[from]!), right: `${100 - (days[to]! / span) * 100}%` }}
          onPointerDown={startDrag("band")}
          onPointerMove={onDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        />
        {months.slice(1, -1).map(({ t }) => (
          <div className="tick" key={t} style={{ left: percent(t) }} />
        ))}
        {handle("from", from, "Start date", from)}
        {handle("to", to, "End date", to - 1)}
      </div>
    </div>
  );
}
