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
import type {
  SearchEntry,
  SearchPreviewMeta,
  SearchRafsiClaims,
} from "./packages.ts";
import {
  PREVIEW_RAFSI_COUNT,
  PREVIEW_RAFSI_LENGTH,
} from "../../search/src/preview-row.ts";

/**
 * The fields a hit preview carries for its row: rafsi spellings for the
 * word, and the selma'o names, signing identity, notes flag, and imported
 * source attribution of the previewed definition. Every string is bounded by
 * length and every list by count (packages/search/src/preview-row.ts), so
 * the response size per hit stays small whatever the signed bodies hold.
 * The row fields are present only when the caller supplies the metadata.
 */
export interface SearchPreview {
  event: string;
  word_kind: string;
  plain_text: string;
  status: string;
  /** Rafsi of the word's active assignments under the served view. */
  rafsi?: string[];
  selmaho?: string[];
  /** The signing identity. Present together with `notes` and `attribution`. */
  issuer?: string;
  notes?: boolean;
  attribution?: SearchPreviewMeta["attribution"];
}

/**
 * The rafsi a row shows for one word under one view, as the word route gives
 * them: claims the view does not select are left out, an assignment whose
 * claims are all inactive is left out, and each other assignment shows the
 * spelling of its first claim in ID order, if that claim body is retained.
 * The spellings are sorted, as on a row without preview fields and on a
 * local row, and the first ones within the count bound stay. It reads each
 * claim's publication once.
 */
function wordRafsi(
  claims: SearchRafsiClaims[string],
  evaluation: Evaluation,
): string[] {
  const assignments = new Map<
    string,
    { first: [string, string | null]; shown: boolean }
  >();
  for (const claim of claims) {
    const publication = evaluation.publications[claim[0]];
    if (!publication?.assignment || publication.eligible === "not_selected")
      continue;
    const assignment = assignments.get(publication.assignment);
    if (!assignment)
      assignments.set(publication.assignment, {
        first: claim,
        shown: publication.eligible !== "inactive",
      });
    else {
      if (claim[0] < assignment.first[0]) assignment.first = claim;
      if (publication.eligible !== "inactive") assignment.shown = true;
    }
  }
  const spellings = new Set<string>();
  for (const { first, shown } of assignments.values()) {
    const spelling = first[1];
    if (shown && spelling !== null && spelling.length <= PREVIEW_RAFSI_LENGTH)
      spellings.add(spelling);
  }
  return [...spellings].sort().slice(0, PREVIEW_RAFSI_COUNT);
}

const preparedRafsi = new WeakMap<
  Evaluation,
  { claims: SearchRafsiClaims; byWord: Map<string, string[]> }
>();
/**
 * The preview rafsi of every word under one evaluated snapshot and view,
 * at most `PREVIEW_RAFSI_COUNT` sorted spellings per word. The list is
 * prepared once per evaluation, in one pass over the retained claims, and
 * kept with that evaluation. A search request then reads one prepared list
 * per hit, so its work does not grow with the claims of a word. Each view
 * has its own evaluation and so its own lists.
 */
export function previewRafsiByWord(
  claims: SearchRafsiClaims,
  evaluation: Evaluation,
): ReadonlyMap<string, string[]> {
  const cached = preparedRafsi.get(evaluation);
  if (cached && cached.claims === claims) return cached.byWord;
  const byWord = new Map<string, string[]>();
  for (const word of Object.keys(claims)) {
    const spellings = wordRafsi(claims[word], evaluation);
    if (spellings.length) byWord.set(word, spellings);
  }
  preparedRafsi.set(evaluation, { claims, byWord });
  return byWord;
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
      // The metadata is bounded when the packages are built, so a hit only
      // copies references here.
      ...(meta
        ? {
            selmaho: meta.selmaho,
            issuer: meta.issuer,
            notes: meta.notes,
            attribution: meta.attribution,
          }
        : {}),
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
