import type { SearchRequestBudget } from "../../search/src/index.ts";
/** Meaning search uses at most six distinct words. Place marks are not words. */
export function nearbyQuery(meaning: string): string[] {
  return [
    ...new Set(
      meaning
        .replace(
          /(?<![\p{L}\p{N}])\$?x_?\{?\d+\}?\$?(?![\p{L}\p{N}])|\{place\s+\d+\}|[①-⑳㉑-㉟㊱-㊿]/giu,
          " ",
        )
        .split(/\s+/u)
        .map((word) =>
          word
            .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
            .toLocaleLowerCase("en"),
        )
        .filter((word) => Array.from(word).length > 2),
    ),
  ].slice(0, 6);
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
  return [...scored.values()]
    .sort((a, b) => {
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
    })
    .map((row) => row.hit);
}
