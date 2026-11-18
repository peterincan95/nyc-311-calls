import { useRef, type MouseEvent, type PointerEvent } from "react";
import { COLOR_STOPS } from "./renderer";
import {
  DAYS_PER_WEEK,
  HOURS_PER_DAY,
  SECONDS_PER_HOUR,
  WEEK_CELLS,
  type Area,
} from "./selection";
import { hourLabel, WEEKDAY_NAMES } from "./scatterAxes";

// A pointer that moves further than this between press and release was dragging, not clicking.
const MAX_CLICK_PIXELS = 4;

const STOPS = COLOR_STOPS.map((hex) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)));

/** A color from the points' gradient, from 0 for none to 1 for the busiest. */
function gradientColor(share: number) {
  const position = Math.min(1, Math.max(0, share)) * (STOPS.length - 1);
  const index = Math.min(Math.floor(position), STOPS.length - 2);
  const mix = position - index;
  const [r, g, b] = STOPS[index]!.map((low, channel) => low + (STOPS[index + 1]![channel]! - low) * mix);
  return `rgb(${r} ${g} ${b})`;
}

/** Whether an hour of the week is picked by both the week grid and any time-of-day box. */
export function isCellPicked({ cells, timeFrom, timeTo }: Area, cell: number) {
  const hourStart = (cell % HOURS_PER_DAY) * SECONDS_PER_HOUR;
  const inTime = hourStart + SECONDS_PER_HOUR > timeFrom && hourStart <= timeTo;
  return inTime && (cells === null || cells[cell] === 1);
}

interface WeekGridProps {
  counts: Uint32Array;
  area: Area;
  onPick: (cell: number, isAdding: boolean) => void;
}

/**
 * Requests in each hour of the week: days across, hours down, each cell colored by its
 * count. Clicking picks a cell, and shift-clicking adds or removes one.
 */
export function WeekGrid({ counts, area, onPick }: WeekGridProps) {
  const busiest = Math.max(1, ...counts);
  const hasPick = area.cells !== null || area.timeFrom > 0 || area.timeTo < HOURS_PER_DAY * SECONDS_PER_HOUR;

  const pressedAt = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    pressedAt.current = { x: event.clientX, y: event.clientY };
  };

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const pressed = pressedAt.current;
    if (
      pressed &&
      Math.max(Math.abs(event.clientX - pressed.x), Math.abs(event.clientY - pressed.y)) > MAX_CLICK_PIXELS
    ) {
      return;
    }
    const { left, top, width, height } = event.currentTarget.getBoundingClientRect();
    const day = Math.floor(((event.clientX - left) / width) * DAYS_PER_WEEK);
    const hour = Math.floor(((event.clientY - top) / height) * HOURS_PER_DAY);
    if (day < 0 || day >= DAYS_PER_WEEK || hour < 0 || hour >= HOURS_PER_DAY) return;
    onPick(day * HOURS_PER_DAY + hour, event.shiftKey);
  };

  const cells = [];
  // Laid out row by row, an hour at a time, so each row runs Monday to Sunday.
  for (let hour = 0; hour < HOURS_PER_DAY; hour += 1) {
    for (let day = 0; day < DAYS_PER_WEEK; day += 1) {
      const cell = day * HOURS_PER_DAY + hour;
      const count = counts[cell]!;
      const isPicked = !hasPick || isCellPicked(area, cell);
      cells.push(
        <div
          key={cell}
          className={isPicked ? "week-cell" : "week-cell unpicked"}
          style={{ background: gradientColor(count / busiest) }}
          title={`${WEEKDAY_NAMES[day]} ${hourLabel(hour)}: ${count.toLocaleString("en-US")}`}
        />,
      );
    }
  }
  return (
    <div className="week-grid" onPointerDown={onPointerDown} onClick={onClick}>
      {cells}
    </div>
  );
}

export const emptyCells = () => new Uint8Array(WEEK_CELLS);
