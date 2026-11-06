import type { CallData, Subject } from "./data";
import type { TagFilter } from "./filters";

/** A run of consecutive calls in the data buffer. */
export interface Slice {
  first: number;
  count: number;
}

export interface Selection extends TagFilter {
  /** Calls inside the time range, before the tag filter. */
  inside: Slice[];
  /** The filter's calls outside the time range, before the tag filter. */
  outside: Slice[];
  /** Calls matching every filter, inside the time range. */
  insideCount: number;
  /** Calls matching every filter across the whole year. */
  totalCount: number;
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
): Uint32Array {
  const { days } = meta;
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
      if ((tags[call]! & mask) === match) counts[day]! += 1;
    }
  }
  return counts;
}

/**
 * Calls are sorted by subject, then time, so each subject contributes one run
 * before the range, one inside it and one after it. The renderer applies the
 * tag filter to those runs. `from` and `to` are indexes into the day list.
 */
export function selectCalls(
  { meta, words }: CallData,
  subjects: Subject[],
  tags: TagFilter,
  dailyCounts: Uint32Array,
  from: number,
  to: number,
): Selection {
  const selection: Selection = { ...tags, inside: [], outside: [], insideCount: 0, totalCount: 0 };
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
