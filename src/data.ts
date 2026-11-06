export const BYTES_PER_CALL = 8;

// Each call's tag, as written by scripts/export_binary.py.
const BYTES_PER_TAG = 4;
export const DETAIL_MASK = 0x3ff;
export const NEIGHBORHOOD_SHIFT = 10;
export const NEIGHBORHOOD_MASK = 0x1ff << NEIGHBORHOOD_SHIFT;
export const BOROUGH_SHIFT = 19;
export const BOROUGH_MASK = 0x7 << BOROUGH_SHIFT;

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "July", "Aug", "Sept", "Oct", "Nov", "Dec"];

export const monthName = (month: number) => MONTH_NAMES[month - 1]!;

export interface NamedId {
  id: number;
  name: string;
}

export interface Subject {
  id: number;
  name: string;
  start: number;
  count: number;
  details: NamedId[];
}

export interface SubjectGroup {
  name: string;
  /** Subject ids. */
  subjects: number[];
}

export interface Month {
  t: number;
  year: number;
  month: number;
}

export interface Meta {
  count: number;
  bounds: { lonMin: number; lonMax: number; latMin: number; latMax: number };
  tStart: number;
  tEnd: number;
  months: Month[];
  days: number[];
  subjects: Subject[];
  groups: SubjectGroup[];
  boroughs: NamedId[];
  neighborhoods: NamedId[];
  /** Calls with no coordinates, as [subject id, tag, count]. */
  missingCalls: [number, number, number][];
}

export interface CallData {
  meta: Meta;
  buffer: ArrayBufferLike;
  /** Every call's record as uint32 pairs: [packed x and y, seconds since tStart]. */
  words: Uint32Array;
  /** Every call's tag. */
  tags: Uint32Array;
}

async function fetchOk(path: string): Promise<Response> {
  const response = await fetch(`${import.meta.env.BASE_URL}data/${path}`);
  if (!response.ok || !response.body) {
    throw new Error(`Could not load ${path} (${response.status})`);
  }
  return response;
}

async function readInto(path: string, bytes: Uint8Array, onBytes: (count: number) => void) {
  const reader = (await fetchOk(path)).body!.getReader();
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (received + value.length > bytes.length) {
      throw new Error(`${path} is larger than meta.json describes`);
    }
    bytes.set(value, received);
    received += value.length;
    onBytes(value.length);
  }
  if (received !== bytes.length) {
    throw new Error(`${path} is smaller than meta.json describes`);
  }
}

export async function loadCalls(onProgress: (fraction: number) => void): Promise<CallData> {
  const meta: Meta = await (await fetchOk("meta.json")).json();
  const calls = new Uint8Array(meta.count * BYTES_PER_CALL);
  const tags = new Uint8Array(meta.count * BYTES_PER_TAG);

  let received = 0;
  const onBytes = (count: number) => {
    received += count;
    onProgress(received / (calls.length + tags.length));
  };
  await Promise.all([readInto("calls.bin", calls, onBytes), readInto("tags.bin", tags, onBytes)]);

  return {
    meta,
    buffer: calls.buffer,
    words: new Uint32Array(calls.buffer),
    tags: new Uint32Array(tags.buffer),
  };
}
