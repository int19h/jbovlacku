import {
  scanPatternsChunked,
  type PatternScanner,
} from "../../../packages/search/src/pattern-scan.ts";
/** A real read advances the hosted clock. Promise-only yields do not. */
export const workerPatternScanner =
  (index: Pick<D1Database, "prepare">): PatternScanner =>
  (entries, query, signal) =>
    scanPatternsChunked(entries, query, {
      signal,
      yield: () => index.prepare("SELECT 1").first(),
    });
