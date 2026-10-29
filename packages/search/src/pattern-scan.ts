import {
  compilePattern,
  PatternError,
  PATTERN_TIMEOUT_MESSAGE,
  PATTERN_WORKER_TIMEOUT_MS,
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
export async function scanPatternsChunked(
  entries: PatternCandidate[],
  query: string,
  options: PatternChunkOptions,
): Promise<PatternMatch[]> {
  const now = options.now ?? Date.now;
  const started = now();
  const check = () => {
    options.signal?.throwIfAborted();
    if (now() - started >= PATTERN_WORKER_TIMEOUT_MS) throw patternTimeout();
  };
  check();
  const scan = createPatternScan(entries, query);
  try {
    while (true) {
      check();
      const done = scan.step();
      // Advance hosted clocks through genuine I/O, including the final chunk.
      await options.yield();
      check();
      if (done) return scan.rows;
    }
  } finally {
    scan.free();
  }
}
