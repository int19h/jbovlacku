import type { Evaluation } from "../../core/src/index.ts";
import {
  selectMatches,
  matchRank,
  withSegmentation,
  type MatchKind,
  type SearchMetrics,
} from "../../search/src/index.ts";
import type { SearchEntry } from "./packages.ts";

/** Scan each entry once and retain the public lexical match tiers and order. */
export function lexicalSearch(
  entries: Iterable<SearchEntry>,
  query: string,
  language: string,
  evaluation: Evaluation,
  includeRetired = false,
  metrics?: SearchMetrics,
) {
  const hits = new Map<
    string,
    {
      word: unknown;
      word_id: string;
      match: MatchKind;
      position: number;
      definitions: string[];
      preview: {
        event: string;
        word_kind: string;
        plain_text: string;
        status: string;
      };
    }
  >();
  const selected = selectMatches(entries, query, metrics, (entry) => {
    const publication = evaluation.publications[entry.event];
    return (
      entry.language === language &&
      !!publication &&
      evaluation.receipts[entry.event]?.interpretation === "effective" &&
      publication.eligible === "eligible" &&
      (publication.status === "active" || includeRetired)
    );
  });
  for (const { entry, match, position } of selected.rows) {
    const publication = evaluation.publications[entry.event];
    const wordId = publication.word;
    const classification = entry.classification as {
      kind?: unknown;
    } | null;
    const plainText = entry.plain_text.replace(/\s+/gu, " ").trim();
    const characters = Array.from(plainText);
    const preview = {
      event: entry.event,
      word_kind:
        typeof classification?.kind === "string"
          ? classification.kind
          : "unknown",
      plain_text:
        characters.length > 240
          ? characters.slice(0, 239).join("") + "…"
          : plainText,
      status: publication.status,
    };
    const old = hits.get(wordId);
    if (old) {
      old.definitions.push(entry.event);
      if (
        matchRank(match) < matchRank(old.match) ||
        (match === old.match && entry.event < old.preview.event)
      ) {
        old.match = match;
        old.position = position;
        old.preview = preview;
        old.word = entry.word;
      }
    } else
      hits.set(wordId, {
        word: entry.word,
        word_id: wordId,
        match,
        position,
        definitions: [entry.event],
        preview,
      });
  }
  const ordered = [...hits.values()].sort(
    (a, b) =>
      matchRank(a.match) - matchRank(b.match) ||
      a.position - b.position ||
      a.word_id.localeCompare(b.word_id),
  );

  return withSegmentation(
    ordered.map(({ position, ...hit }) => {
      void position;
      return hit;
    }),
    selected.segmentation,
  );
}
