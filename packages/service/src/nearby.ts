import type { SearchRequestBudget } from "../../search/src/index.ts";
/** The search text of one nearby word: its typed spelling, lowercased. */
export function nearbyTermText(spelling: string): string {
  return spelling.toLocaleLowerCase("en");
}

/**
 * The typed spellings of the words that meaning search uses: at most six
 * distinct words. Place marks are not words. Words are distinct and long
 * enough by their search text, and each keeps the spelling of its first
 * occurrence, so `nearbyQuery` is this list mapped through `nearbyTermText`.
 */
export function nearbyTerms(meaning: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const word of meaning
    .replace(
      /(?<![\p{L}\p{N}])\$?x_?\{?\d+\}?\$?(?![\p{L}\p{N}])|\{place\s+\d+\}|[①-⑳㉑-㉟㊱-㊿]/giu,
      " ",
    )
    .split(/\s+/u)) {
    const spelling = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    const text = nearbyTermText(spelling);
    if (Array.from(text).length <= 2 || seen.has(text)) continue;
    seen.add(text);
    terms.push(spelling);
    if (terms.length === 6) break;
  }
  return terms;
}

/** Meaning search uses at most six distinct words. Place marks are not words. */
export function nearbyQuery(meaning: string): string[] {
  return nearbyTerms(meaning).map(nearbyTermText);
}

/** Count matching query words, then use summed search positions and word ID. */
export function rankNearby<T extends { word_id: string }>(
  searches: T[][],
  budget?: SearchRequestBudget,
): T[] {
  const scored = new Map<string, { hit: T; score: number; rank: number }>();
  for (const hits of searches) {
    const seen = new Set<string>();
    hits.forEach((hit, rank) => {
      // One input hit costs one unit, charged before the hit is scored.
      budget?.reserve(1, "search");
      if (seen.has(hit.word_id)) return;
      seen.add(hit.word_id);
      const row = scored.get(hit.word_id) ?? { hit, score: 0, rank: 0 };
      row.score++;
      row.rank += rank;
      scored.set(hit.word_id, row);
    });
  }
  const ordered = [...scored.values()].sort((a, b) => {
    // One comparison costs one unit, charged before the comparison runs.
    budget?.reserve(1, "search");
    return (
      b.score - a.score ||
      a.rank - b.rank ||
      (a.hit.word_id < b.hit.word_id
        ? -1
        : a.hit.word_id > b.hit.word_id
          ? 1
          : 0)
    );
  });
  return ordered.map((row) => {
    // The final mapping copies every distinct hit, so it charges one unit
    // per row before the copy runs.
    budget?.reserve(1, "search");
    return row.hit;
  });
}
