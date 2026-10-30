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

/** The caller runs this bounded scan inside its own execution deadline. */
export function scanPatterns(
  entries: PatternCandidate[],
  query: string,
): PatternMatch[] {
  const pattern = compilePattern(query);
  try {
    const rows: PatternMatch[] = [];
    for (const [index, entry] of entries.entries()) {
      const headword = pattern.test(entry.spelling);
      let rafsi = false;
      for (const spelling of entry.rafsi)
        rafsi = pattern.test(spelling) || rafsi;
      if (headword || rafsi)
        rows.push({
          index,
          match: headword ? "headword-pattern" : "rafsi-pattern",
        });
    }
    return rows;
  } finally {
    pattern.free();
  }
}
