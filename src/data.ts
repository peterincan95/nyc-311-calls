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
}

export interface BoundaryLabel {
  name: string;
  x: number;
  y: number;
  /** Width of a square the same area as this place, as a share of the city. */
  size: number;
  residential: boolean;
}

/** Outlines on the same grid as the calls. Each ring is a flat [x, y, x, y, ...] list. */
export interface Boundaries {
  boroughs: number[][];
  neighborhoods: number[][];
  /** Largest first. */
  labels: BoundaryLabel[];
}

export interface CallData {
  meta: Meta;
  boundaries: Boundaries;
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
  const [boundaries] = await Promise.all([
    fetchOk("boundaries.json").then((response) => response.json() as Promise<Boundaries>),
    readInto("calls.bin", calls, onBytes),
    readInto("tags.bin", tags, onBytes),
  ]);

  return {
    meta,
    boundaries,
    buffer: calls.buffer,
    words: new Uint32Array(calls.buffer),
    tags: new Uint32Array(tags.buffer),
  };
}

/** Street centerlines on the calls' grid, from scripts/build_streets.py. */
export interface Streets {
  /** Index of each line's first vertex, with one more entry for the end. Lines run in tier order. */
  lineStarts: Uint32Array;
  /** x, y pairs on the grid. */
  vertices: Uint16Array;
  /** Lines in tiers 1 (highways), 2 (major roads) and 3 (local streets). */
  tierLineCounts: number[];
  /** Label spots, most important first, as x, y, name index and tier. */
  anchors: Uint16Array;
  /** Half of each label spot's chord along its street, as x and y on the grid. */
  reach: Int16Array;
  anchorCount: number;
  names: string[];
}

interface StreetsHeader {
  lineCount: number;
  vertexCount: number;
  anchorCount: number;
  tierLineCounts: number[];
  names: string[];
}

/** Loaded after the calls, since the map works without it. */
export async function loadStreets(): Promise<Streets> {
  const [header, buffer] = await Promise.all([
    fetchOk("streets.json").then((response) => response.json() as Promise<StreetsHeader>),
    fetchOk("streets.bin").then((response) => response.arrayBuffer()),
  ]);
  const { lineCount, vertexCount, anchorCount, tierLineCounts, names } = header;
  // Each section starts on a 4-byte boundary.
  let offset = 0;
  const take = <T>(make: (start: number) => T, bytes: number) => {
    const view = make(offset);
    offset += Math.ceil(bytes / 4) * 4;
    return view;
  };
  const lineStarts = take((start) => new Uint32Array(buffer, start, lineCount + 1), (lineCount + 1) * 4);
  const vertices = take((start) => new Uint16Array(buffer, start, vertexCount * 2), vertexCount * 4);
  const anchors = take((start) => new Uint16Array(buffer, start, anchorCount * 4), anchorCount * 8);
  const reach = take((start) => new Int16Array(buffer, start, anchorCount * 2), anchorCount * 4);
  if (offset !== buffer.byteLength) throw new Error("streets.bin doesn't match streets.json");
  return { lineStarts, vertices, tierLineCounts, anchors, reach, anchorCount, names };
}
