import {
  compilePattern,
  PatternError,
  PATTERN_TIMEOUT_MESSAGE,
} from "./pattern.ts";
export interface PatternCandidate {
  spelling: string;
  rafsi: string[];
}
export interface PatternMatch {
  index: number;
  match: "headword-pattern" | "rafsi-pattern";
}
export type PatternScanner = (
  entries: PatternCandidate[],
  query: string,
  signal?: AbortSignal,
) => Promise<PatternMatch[]>;
export const PATTERN_CHUNK_WORK = 1_000_000;
export const PATTERN_CHUNK_ROWS = 8192;
export const patternTimeout = () =>
  new PatternError("pattern_timeout", PATTERN_TIMEOUT_MESSAGE);
export const patternBusy = () =>
  new PatternError("search_busy", "Pattern search is busy. Try again shortly.");
export const PATTERN_NON_IO_TIMEOUT_MS = 5000;
/** One matcher and budget survive all chunks. No caller receives partial rows. */
export function createPatternScan(entries: PatternCandidate[], query: string) {
  const pattern = compilePattern(query);
  const rows: PatternMatch[] = [];
  let index = 0,
    part = -1,
    headword = false,
    rafsi = false;
  return {
    rows,
    stats: pattern.stats,
    free: pattern.free,
    step(workLimit = PATTERN_CHUNK_WORK, rowLimit = PATTERN_CHUNK_ROWS) {
      const startWork = pattern.stats().spent,
        startRow = index;
      while (index < entries.length) {
        const entry = entries[index];
        if (part < 0) {
          headword = pattern.test(entry.spelling);
          rafsi = false;
          part = 0;
        } else if (part < entry.rafsi.length)
          rafsi = pattern.test(entry.rafsi[part++]) || rafsi;
        else {
          if (headword || rafsi)
            rows.push({
              index,
              match: headword ? "headword-pattern" : "rafsi-pattern",
            });
          index++;
          part = -1;
        }
        if (
          pattern.stats().spent - startWork >= workLimit ||
          index - startRow >= rowLimit
        )
          break;
      }
      return index === entries.length;
    },
  };
}
export interface PatternChunkOptions {
  /** This must perform host I/O when its clock freezes during CPU work. */
  yield: () => Promise<unknown>;
  now?: () => number;
  signal?: AbortSignal;
}
/** Abort releases the matcher even when the host cannot cancel its I/O. */
function yieldOrAbort(yieldWork: () => Promise<unknown>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
    let pending: Promise<unknown>;
    try {
      pending = yieldWork();
    } catch (error) {
      signal?.removeEventListener("abort", abort);
      reject(error);
      return;
    }
    pending.then(
      () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      },
      (error) => {
        signal?.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
export async function scanPatternsChunked(
  entries: PatternCandidate[],
  query: string,
  options: PatternChunkOptions,
): Promise<PatternMatch[]> {
  const now = options.now ?? Date.now;
  let checkpoint = now(),
    observed = 0;
  const check = () => {
    options.signal?.throwIfAborted();
    const current = now();
    observed += Math.max(0, current - checkpoint);
    checkpoint = current;
    if (observed >= PATTERN_NON_IO_TIMEOUT_MS) throw patternTimeout();
  };
  check();
  const scan = createPatternScan(entries, query);
  try {
    while (true) {
      check();
      const done = scan.step();
      // Advance hosted clocks through genuine I/O, including the final chunk.
      check();
      await yieldOrAbort(options.yield, options.signal);
      // Hosted clocks include CPU in the I/O interval. This subtraction is
      // only a loose guard, not a CPU clock. Compiled work is the primary bound.
      checkpoint = now();
      check();
      if (done) return scan.rows;
    }
  } finally {
    scan.free();
  }
}
