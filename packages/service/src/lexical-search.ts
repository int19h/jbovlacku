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
  scanPatterns,
  type PatternScanner,
} from "../../search/src/pattern-scan.ts";
import type { SearchEntry, SearchPreviewMeta } from "./packages.ts";

import {
  PREVIEW_RAFSI_COUNT,
  PREVIEW_RAFSI_LENGTH,
  PREVIEW_SELMAHO_COUNT,
  PREVIEW_SELMAHO_LENGTH,
  boundedPreviewAttribution,
  boundedPreviewList,
} from "../../search/src/preview-row.ts";

/**
 * The bounded fields a hit preview carries for its row: rafsi spellings and
 * selma'o names for the word, the signing identity, a notes flag, and
 * imported source attribution. Every string is bounded by length and every
 * list by count (packages/search/src/preview-row.ts), so the response size
 * per hit stays small whatever the signed bodies hold. Row rendering needs
 * no further read for these fields.
 */
export interface SearchPreview {
  event: string;
  word_kind: string;
  plain_text: string;
  status: string;
  rafsi: string[];
  selmaho: string[];
  /** The signing identity, when the caller supplies preview metadata. */
  issuer?: string;
  /** Whether the definition has notes, when metadata is supplied. */
  notes?: boolean;
  /** Imported source attribution, when metadata is supplied. */
  attribution?: SearchPreviewMeta["attribution"];
}
/** Copies one preview-meta value within the preview bounds. */
function boundedMeta(meta: SearchPreviewMeta): SearchPreviewMeta {
  return {
    issuer: meta.issuer,
    notes: meta.notes,
    attribution: boundedPreviewAttribution(meta.attribution) ?? null,
  };
}

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
  previewMeta?: Record<string, SearchPreviewMeta>,
) {
  const hits = new Map<
    string,
    {
      word: unknown;
      word_id: string;
      match: MatchKind;
      position: number;
      definitions: string[];
      preview: SearchPreview;
    }
  >();
  const pattern = options.patterns !== false && isPatternQuery(query);
  const selected = selectedRows
    ? {
        rows: options.group === "definitions" ? [] : selectedRows,
        segmentation: "complete" as const,
        allLojban: false,
      }
    : selectMatches(
        entries,
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
        {
          ...options,
          // Server remote search keeps the existing request policy: the
          // browser product budget does not apply here, so it is off.
          workLimit: Infinity,
          deadlineMs: Infinity,
          rafsiFor: (entry) =>
            rafsi[
              evaluation.publications[(entry as SearchEntry).event]?.word
            ] ?? [],
        },
      );
  for (const { entry, match, position } of selected.rows) {
    const publication = evaluation.publications[entry.event];
    const wordId = publication.word;
    const classification = entry.classification as {
      kind?: unknown;
      selmaho?: unknown;
    } | null;
    const plainText = entry.plain_text.replace(/\s+/gu, " ").trim();
    const characters = Array.from(plainText);
    const meta = previewMeta?.[entry.event];
    const preview: SearchPreview = {
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
      rafsi:
        boundedPreviewList(
          rafsi[publication.word],
          PREVIEW_RAFSI_COUNT,
          PREVIEW_RAFSI_LENGTH,
        ) ?? [],
      selmaho:
        boundedPreviewList(
          classification?.selmaho,
          PREVIEW_SELMAHO_COUNT,
          PREVIEW_SELMAHO_LENGTH,
        ) ?? [],
      ...(meta ? boundedMeta(meta) : {}),
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

/** The Node server supplies its bounded pattern runtime. Other callers use a five-second fallback.
 * Ordinary retrieval stays literal when requested.
 */
export async function lexicalSearchAsync(
  entries: SearchEntry[],
  query: string,
  language: string,
  evaluation: Evaluation,
  includeRetired = false,
  rafsi: Record<string, string[]> = {},
  scanner: PatternScanner = async (entries, query, signal) =>
    scanPatterns(entries, query, {
      signal,
      deadline: performance.now() + 5000,
    }),
  signal?: AbortSignal,
  options: SearchOptions = {},
  previewMeta?: Record<string, SearchPreviewMeta>,
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
      undefined,
      previewMeta,
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
    previewMeta,
  );
}
