import {
  BOROUGH_MASK,
  BOROUGH_SHIFT,
  DETAIL_MASK,
  NEIGHBORHOOD_MASK,
  NEIGHBORHOOD_SHIFT,
  type CallData,
  type Meta,
  type Subject,
} from "./data";
import type { Filter, Place, TagFilter } from "./filters";

/** A run of consecutive calls in the data buffer. */
export interface Slice {
  first: number;
  count: number;
}

/** The largest value of a call's x or y. */
export const GRID_MAX = 65535;

export const SECONDS_PER_DAY = 86400;
export const SECONDS_PER_HOUR = 3600;
export const HOURS_PER_DAY = 24;
export const DAYS_PER_WEEK = 7;
/** Each hour of the week, Monday midnight first, so the weekend comes last. */
export const WEEK_CELLS = DAYS_PER_WEEK * HOURS_PER_DAY;
// New York's clocks change at 2am.
const CLOCK_CHANGE_SECONDS = 2 * SECONDS_PER_HOUR;

/** A rectangle of the city in call coordinates and a part of the day, edges included. */
export interface Area {
  west: number;
  east: number;
  south: number;
  north: number;
  /** Seconds after midnight. */
  timeFrom: number;
  timeTo: number;
  /** The hours of the week picked on the week grid, 1 for each one in, or null for all. */
  cells: Uint8Array | null;
}

export const WHOLE_CITY: Area = {
  west: 0,
  east: GRID_MAX,
  south: 0,
  north: GRID_MAX,
  timeFrom: 0,
  timeTo: SECONDS_PER_DAY,
  cells: null,
};

export const isWholeCity = (area: Area) =>
  area.west === 0 &&
  area.east === GRID_MAX &&
  area.south === 0 &&
  area.north === GRID_MAX &&
  area.timeFrom === 0 &&
  area.timeTo === SECONDS_PER_DAY &&
  area.cells === null;

/** When winter time starts and ends: the two days that aren't 24 hours long. */
export function winterTime({ days }: Meta): [start: number, end: number] {
  const changes = days
    .slice(0, -1)
    .filter((t, day) => days[day + 1]! - t !== SECONDS_PER_DAY)
    .map((t) => t + CLOCK_CHANGE_SECONDS);
  return [changes[0]!, changes[1]!];
}

/** The day of the week `tStart` falls on, from 0 for Monday. */
export const startWeekday = ({ tStart }: Meta) =>
  // January 1, 1970 was a Thursday, and New York's midnights fall early in the UTC day.
  (Math.floor(tStart / SECONDS_PER_DAY) + 3) % DAYS_PER_WEEK;

/** What's needed to turn a call's time into New York's clock time. */
interface Clock {
  winter: [number, number];
  weekday: number;
}

const clockOf = (meta: Meta): Clock => ({ winter: winterTime(meta), weekday: startWeekday(meta) });

/** Seconds since `tStart` on New York's clock. `tStart` is a midnight in summer time. */
function localTime(t: number, [winterStart, winterEnd]: [number, number]) {
  return t >= winterStart && t < winterEnd ? t - SECONDS_PER_HOUR : t;
}

/** The hour of the week a call falls in, as an index into `Area.cells`. */
function weekCell(local: number, weekday: number) {
  const day = (Math.floor(local / SECONDS_PER_DAY) + weekday) % DAYS_PER_WEEK;
  return day * HOURS_PER_DAY + Math.floor((local % SECONDS_PER_DAY) / SECONDS_PER_HOUR);
}

function isInArea(
  { west, east, south, north, timeFrom, timeTo, cells }: Area,
  position: number,
  t: number,
  { winter, weekday }: Clock,
) {
  const x = position & 0xffff;
  const y = position >>> 16;
  if (x < west || x > east || y < south || y > north) return false;
  const local = localTime(t, winter);
  const second = local % SECONDS_PER_DAY;
  if (second < timeFrom || second > timeTo) return false;
  return cells === null || cells[weekCell(local, weekday)] === 1;
}

export interface Selection extends TagFilter {
  area: Area;
  /** Calls inside the time range, before the tag and area filters. */
  inside: Slice[];
  /** The filter's calls outside the time range, before the tag and area filters. */
  outside: Slice[];
  /** Calls matching every filter, inside the time range. */
  insideCount: number;
  /** Calls matching every filter across the whole year. */
  totalCount: number;
  /** Like `totalCount`, ignoring the box. Sets brightness, so a box doesn't change it. */
  cityCount: number;
}

function firstAtOrAfter(words: Uint32Array, start: number, end: number, t: number): number {
  let low = start;
  let high = end;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (words[middle * 2 + 1]! < t) low = middle + 1;
    else high = middle;
  }
  return low;
}

function addSlice(slices: Slice[], first: number, count: number) {
  if (count === 0) return;
  const last = slices[slices.length - 1];
  if (last && last.first + last.count === first) last.count += count;
  else slices.push({ first, count });
}

/**
 * Each subject's matching calls on each day, in the subjects' order, from one pass
 * over their calls. Each subject's calls are in time order, so the day only moves forward.
 */
export function countSubjectsByDay(
  { meta, words, tags }: CallData,
  subjects: Subject[],
  { mask, match }: TagFilter,
  area: Area,
): Uint32Array[] {
  const { days } = meta;
  const clock = clockOf(meta);

  return subjects.map(({ start, count }) => {
    const counts = new Uint32Array(days.length - 1);
    let day = 0;
    let nextDay = days[1]!;
    for (let call = start; call < start + count; call += 1) {
      const t = words[call * 2 + 1]!;
      while (t >= nextDay) {
        day += 1;
        nextDay = days[day + 1]!;
      }
      if ((tags[call]! & mask) !== match) continue;
      if (isInArea(area, words[call * 2]!, t, clock)) counts[day]! += 1;
    }
    return counts;
  });
}

/** Adds up each day across the subjects' daily counts. */
export function sumByDay(subjectCounts: Uint32Array[], dayCount: number) {
  const totals = new Uint32Array(dayCount);
  for (const counts of subjectCounts) {
    counts.forEach((count, day) => (totals[day]! += count));
  }
  return totals;
}

/** The number of matching calls on each day, across all the subjects. */
export function countCallsByDay(
  data: CallData,
  subjects: Subject[],
  tags: TagFilter,
  area: Area,
): Uint32Array {
  return sumByDay(countSubjectsByDay(data, subjects, tags, area), data.meta.days.length - 1);
}

/** Calls from day `from` up to, but not including, day `to`. */
export const countInRange = (counts: Uint32Array, from: number, to: number) =>
  counts.subarray(from, to).reduce((sum, count) => sum + count, 0);

/** Runs over the subjects' calls in the time range that match the tags and area. */
function forEachCall(
  { meta, words, tags }: CallData,
  subjects: Subject[],
  { mask, match }: TagFilter,
  area: Area,
  tFrom: number,
  tTo: number,
  visit: (tag: number, t: number) => void,
) {
  const clock = clockOf(meta);
  for (const subject of subjects) {
    const end = subject.start + subject.count;
    const first = firstAtOrAfter(words, subject.start, end, tFrom);
    const last = firstAtOrAfter(words, first, end, tTo);
    for (let call = first; call < last; call += 1) {
      const tag = tags[call]!;
      if ((tag & mask) !== match) continue;
      const t = words[call * 2 + 1]!;
      if (isInArea(area, words[call * 2]!, t, clock)) visit(tag, t);
    }
  }
}

/**
 * Matching calls in each hour of the week, for the week grid. The grid shows what can be
 * picked, so it ignores the parts of `area` that pick times of day or week.
 */
export function countWeekCells(
  data: CallData,
  subjects: Subject[],
  tags: TagFilter,
  area: Area,
  tFrom: number,
  tTo: number,
): Uint32Array {
  const { winter, weekday } = clockOf(data.meta);
  const counts = new Uint32Array(WEEK_CELLS);
  const place = { ...area, timeFrom: 0, timeTo: SECONDS_PER_DAY, cells: null };
  forEachCall(data, subjects, tags, place, tFrom, tTo, (_, t) => {
    counts[weekCell(localTime(t, winter), weekday)]! += 1;
  });
  return counts;
}

/** How many calls each complaint menu item would show, keeping the other filters. */
export function countComplaints(
  data: CallData,
  place: TagFilter,
  area: Area,
  tFrom: number,
  tTo: number,
): (filter: Filter) => number {
  const details = new Map<number, Uint32Array>();
  const totals = new Map<number, number>();
  for (const subject of data.meta.subjects) {
    const counts = new Uint32Array(DETAIL_MASK + 1);
    let total = 0;
    forEachCall(data, [subject], place, area, tFrom, tTo, (tag) => {
      total += 1;
      counts[tag & DETAIL_MASK]! += 1;
    });
    details.set(subject.id, counts);
    totals.set(subject.id, total);
  }

  return ({ subjects: chosen, mask, match }) =>
    chosen.reduce(
      (sum, { id }) => sum + (mask ? details.get(id)![match]! : totals.get(id)!),
      0,
    );
}

/** How many calls each place menu item would show, keeping the other filters. */
export function countPlaces(
  data: CallData,
  filter: Filter,
  area: Area,
  tFrom: number,
  tTo: number,
): (place: Place) => number {
  const boroughs = new Uint32Array((BOROUGH_MASK >>> BOROUGH_SHIFT) + 1);
  const neighborhoods = new Uint32Array((NEIGHBORHOOD_MASK >>> NEIGHBORHOOD_SHIFT) + 1);
  let total = 0;
  forEachCall(data, filter.subjects, filter, area, tFrom, tTo, (tag) => {
    total += 1;
    boroughs[(tag & BOROUGH_MASK) >>> BOROUGH_SHIFT]! += 1;
    neighborhoods[(tag & NEIGHBORHOOD_MASK) >>> NEIGHBORHOOD_SHIFT]! += 1;
  });

  return ({ mask, match }) => {
    if (mask === BOROUGH_MASK) return boroughs[match >>> BOROUGH_SHIFT]!;
    if (mask === NEIGHBORHOOD_MASK) return neighborhoods[match >>> NEIGHBORHOOD_SHIFT]!;
    return total;
  };
}

/**
 * Calls are sorted by subject, then time, so each subject contributes one run
 * before the range, one inside it and one after it. The renderer applies the
 * tag and area filters to those runs. `from` and `to` are indexes into the day list.
 */
export function selectCalls(
  { meta, words }: CallData,
  subjects: Subject[],
  tags: TagFilter,
  area: Area,
  dailyCounts: Uint32Array,
  cityDailyCounts: Uint32Array,
  from: number,
  to: number,
): Selection {
  const selection: Selection = {
    ...tags,
    area,
    inside: [],
    outside: [],
    insideCount: 0,
    totalCount: 0,
    cityCount: cityDailyCounts.reduce((sum, count) => sum + count, 0),
  };
  const tFrom = meta.days[from]!;
  const tTo = meta.days[to]!;

  for (const { start, count } of subjects) {
    const end = start + count;
    const first = firstAtOrAfter(words, start, end, tFrom);
    const last = firstAtOrAfter(words, first, end, tTo);
    addSlice(selection.outside, start, first - start);
    addSlice(selection.inside, first, last - first);
    addSlice(selection.outside, last, end - last);
  }
  dailyCounts.forEach((count, day) => {
    selection.totalCount += count;
    if (day >= from && day < to) selection.insideCount += count;
  });
  return selection;
}
