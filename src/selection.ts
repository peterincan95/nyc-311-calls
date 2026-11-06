import type { CallData, Subject } from "./data";

/** A run of consecutive calls in the data buffer. */
export interface Slice {
  first: number;
  count: number;
}

export interface Selection {
  /** Calls inside the time range. */
  inside: Slice[];
  /** The subject's calls outside the time range. */
  outside: Slice[];
  insideCount: number;
  /** Plotted calls for the subject across the whole year. */
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

/** The number of plotted calls on each day. `days` holds each day's start, plus the final end. */
export function countCallsByDay({ meta, words }: CallData, subject: Subject | null): Uint32Array {
  const { days, subjects } = meta;
  const counts = new Uint32Array(days.length - 1);

  for (const { start, count } of subject ? [subject] : subjects) {
    const end = start + count;
    let from = start;
    counts.forEach((_, day) => {
      const to = firstAtOrAfter(words, from, end, days[day + 1]!);
      counts[day]! += to - from;
      from = to;
    });
  }
  return counts;
}

/**
 * Calls are sorted by subject, then time, so each subject contributes one run
 * before the range, one inside it and one after it.
 */
export function selectCalls(
  { meta, words }: CallData,
  subject: Subject | null,
  tFrom: number,
  tTo: number,
): Selection {
  const selection: Selection = { inside: [], outside: [], insideCount: 0, totalCount: 0 };

  for (const { start, count } of subject ? [subject] : meta.subjects) {
    const end = start + count;
    const from = firstAtOrAfter(words, start, end, tFrom);
    const to = firstAtOrAfter(words, from, end, tTo);
    addSlice(selection.outside, start, from - start);
    addSlice(selection.inside, from, to - from);
    addSlice(selection.outside, to, end - to);
    selection.insideCount += to - from;
    selection.totalCount += count;
  }
  return selection;
}
