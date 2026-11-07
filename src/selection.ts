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
const SECONDS_PER_HOUR = 3600;
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
}

export const WHOLE_CITY: Area = {
  west: 0,
  east: GRID_MAX,
  south: 0,
  north: GRID_MAX,
  timeFrom: 0,
  timeTo: SECONDS_PER_DAY,
};

/** When winter time starts and ends: the two days that aren't 24 hours long. */
export function winterTime({ days }: Meta): [start: number, end: number] {
  const changes = days
    .slice(0, -1)
    .filter((t, day) => days[day + 1]! - t !== SECONDS_PER_DAY)
    .map((t) => t + CLOCK_CHANGE_SECONDS);
  return [changes[0]!, changes[1]!];
}

/** Seconds after midnight in New York. `tStart` is a midnight in summer time. */
function secondOfDay(t: number, [winterStart, winterEnd]: [number, number]) {
  const isWinter = t >= winterStart && t < winterEnd;
  return (t - (isWinter ? SECONDS_PER_HOUR : 0)) % SECONDS_PER_DAY;
}

function isInArea(
  { west, east, south, north, timeFrom, timeTo }: Area,
  position: number,
  t: number,
  winter: [number, number],
) {
  const x = position & 0xffff;
  const y = position >>> 16;
  if (x < west || x > east || y < south || y > north) return false;
  const second = secondOfDay(t, winter);
  return second >= timeFrom && second <= timeTo;
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
 * The number of matching calls on each day, from one pass over the filter's calls.
 * Each subject's calls are in time order, so the day only ever moves forward.
 */
export function countCallsByDay(
  { meta, words, tags }: CallData,
  subjects: Subject[],
  { mask, match }: TagFilter,
  area: Area,
): Uint32Array {
  const { days } = meta;
  const winter = winterTime(meta);
  const counts = new Uint32Array(days.length - 1);

  for (const { start, count } of subjects) {
    let day = 0;
    let nextDay = days[1]!;
    for (let call = start; call < start + count; call += 1) {
      const t = words[call * 2 + 1]!;
      while (t >= nextDay) {
        day += 1;
        nextDay = days[day + 1]!;
      }
      if ((tags[call]! & mask) !== match) continue;
      if (isInArea(area, words[call * 2]!, t, winter)) counts[day]! += 1;
    }
  }
  return counts;
}

/** Runs over the subjects' calls in the time range that match the tags and area. */
function forEachCall(
  { meta, words, tags }: CallData,
  subjects: Subject[],
  { mask, match }: TagFilter,
  area: Area,
  tFrom: number,
  tTo: number,
  visit: (tag: number) => void,
) {
  const winter = winterTime(meta);
  for (const subject of subjects) {
    const end = subject.start + subject.count;
    const first = firstAtOrAfter(words, subject.start, end, tFrom);
    const last = firstAtOrAfter(words, first, end, tTo);
    for (let call = first; call < last; call += 1) {
      const tag = tags[call]!;
      if ((tag & mask) !== match) continue;
      if (isInArea(area, words[call * 2]!, words[call * 2 + 1]!, winter)) visit(tag);
    }
  }
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
