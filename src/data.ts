export const BYTES_PER_CALL = 8;

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "July", "Aug", "Sept", "Oct", "Nov", "Dec"];

export const monthName = (month: number) => MONTH_NAMES[month - 1]!;

export interface Subject {
  id: number;
  name: string;
  start: number;
  count: number;
  missing: number;
}

export interface Month {
  t: number;
  year: number;
  month: number;
}

export interface Meta {
  count: number;
  missing: number;
  bounds: { lonMin: number; lonMax: number; latMin: number; latMax: number };
  tStart: number;
  tEnd: number;
  months: Month[];
  days: number[];
  subjects: Subject[];
}

export interface CallData {
  meta: Meta;
  buffer: ArrayBuffer;
  /** Every call's record as uint32 pairs: [packed x and y, seconds since tStart]. */
  words: Uint32Array;
}

async function fetchOk(path: string): Promise<Response> {
  const response = await fetch(`${import.meta.env.BASE_URL}data/${path}`);
  if (!response.ok || !response.body) {
    throw new Error(`Could not load ${path} (${response.status})`);
  }
  return response;
}

export async function loadCalls(onProgress: (fraction: number) => void): Promise<CallData> {
  const meta: Meta = await (await fetchOk("meta.json")).json();
  const bytes = new Uint8Array(meta.count * BYTES_PER_CALL);

  const reader = (await fetchOk("calls.bin")).body!.getReader();
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (received + value.length > bytes.length) {
      throw new Error("calls.bin is larger than meta.json describes");
    }
    bytes.set(value, received);
    received += value.length;
    onProgress(received / bytes.length);
  }
  if (received !== bytes.length) {
    throw new Error("calls.bin is smaller than meta.json describes");
  }

  return { meta, buffer: bytes.buffer, words: new Uint32Array(bytes.buffer) };
}
