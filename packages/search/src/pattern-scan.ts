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
export const patternTimeout = () =>
  new PatternError("pattern_timeout", PATTERN_TIMEOUT_MESSAGE);
export const patternBusy = () =>
  new PatternError("search_busy", "Pattern search is busy. Try again shortly.");

/** The caller runs this bounded scan inside its own execution deadline.
 * Optional limits stop the scan between bounded matcher calls.
 */
export function scanPatterns(
  entries: PatternCandidate[],
  query: string,
  limits: { signal?: AbortSignal; deadline?: number } = {},
): PatternMatch[] {
  const check = () => {
    limits.signal?.throwIfAborted();
    if (limits.deadline !== undefined && performance.now() >= limits.deadline)
      throw patternTimeout();
  };
  check();
  const pattern = compilePattern(query);
  try {
    check();
    const rows: PatternMatch[] = [];
    for (const [index, entry] of entries.entries()) {
      check();
      const headword = pattern.test(entry.spelling);
      let rafsi = false;
      for (const spelling of entry.rafsi) {
        check();
        rafsi = pattern.test(spelling) || rafsi;
      }
      if (headword || rafsi)
        rows.push({
          index,
          match: headword ? "headword-pattern" : "rafsi-pattern",
        });
    }
    check();
    return rows;
  } finally {
    pattern.free();
  }
}
