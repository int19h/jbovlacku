import type { Evaluation } from "../../core/src/index.ts";
import {
  selectMatches,
  matchRank,
  withSegmentation,
  isPatternQuery,
  comparePatternSpelling,
  type SearchOptions,
  type LexicalMatch,
  type MatchKind,
  type SearchMetrics,
} from "../../search/src/index.ts";
import {
  scanPatternsChunked,
  type PatternScanner,
} from "../../search/src/pattern-scan.ts";
import type { SearchEntry } from "./packages.ts";

/** Scan each entry once and retain the public lexical match tiers and order. */
export function lexicalSearch(
  entries: Iterable<SearchEntry>,
  query: string,
  language: string,
  evaluation: Evaluation,
  includeRetired = false,
  metrics?: SearchMetrics,
  rafsi: Record<string, string[]> = {},
  options: SearchOptions = {},
  selectedRows?: LexicalMatch<SearchEntry>[],
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
  const pattern = options.patterns !== false && isPatternQuery(query);
  const source =
    pattern || options.group === "lojban"
      ? (function* () {
          for (const entry of entries)
            yield {
              ...entry,
              rafsi: rafsi[evaluation.publications[entry.event]?.word] ?? [],
            };
        })()
      : entries;
  const selected = selectedRows
    ? {
        rows: options.group === "definitions" ? [] : selectedRows,
        segmentation: "complete" as const,
        allLojban: false,
      }
    : selectMatches(
        source,
        query,
        metrics,
        (entry) => {
          const publication = evaluation.publications[entry.event];
          return (
            entry.language === language &&
            !!publication &&
            evaluation.receipts[entry.event]?.interpretation === "effective" &&
            publication.eligible === "eligible" &&
            (publication.status === "active" || includeRetired)
          );
        },
        options,
      );
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
      (pattern
        ? comparePatternSpelling(
            (a.word as SearchEntry["word"]).spelling,
            (b.word as SearchEntry["word"]).spelling,
          )
        : 0) ||
      (a.word_id < b.word_id ? -1 : a.word_id > b.word_id ? 1 : 0),
  );

  return withSegmentation(
    ordered.map(({ position, ...hit }) => {
      void position;
      return hit;
    }),
    selected.segmentation,
    selected.allLojban,
  );
}

/** Hosts supply their own bounded pattern runtime. Ordinary retrieval stays literal when requested. */
export async function lexicalSearchAsync(
  entries: SearchEntry[],
  query: string,
  language: string,
  evaluation: Evaluation,
  includeRetired = false,
  rafsi: Record<string, string[]> = {},
  scanner: PatternScanner = (entries, query, signal) =>
    scanPatternsChunked(entries, query, {
      yield: () => new Promise((resolve) => setTimeout(resolve, 0)),
      signal,
    }),
  signal?: AbortSignal,
  options: SearchOptions = {},
) {
  if (options.patterns === false || !isPatternQuery(query))
    return lexicalSearch(
      entries,
      query,
      language,
      evaluation,
      includeRetired,
      undefined,
      rafsi,
      options,
    );
  const source = entries.filter((entry) => {
    const publication = evaluation.publications[entry.event];
    return (
      entry.language === language &&
      publication &&
      evaluation.receipts[entry.event]?.interpretation === "effective" &&
      publication.eligible === "eligible" &&
      (publication.status === "active" || includeRetired)
    );
  });
  const matches = await scanner(
    source.map((entry) => ({
      spelling: entry.word.spelling,
      rafsi: rafsi[evaluation.publications[entry.event].word] ?? [],
    })),
    query,
    signal,
  );
  return lexicalSearch(
    source,
    query,
    language,
    evaluation,
    includeRetired,
    undefined,
    rafsi,
    options,
    matches.map((row) => ({
      entry: source[row.index],
      match: row.match,
      position: 0,
    })),
  );
}
