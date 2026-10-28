import {
  BuilderError,
  segmentText,
  stripAcuteAccents,
} from "../../morphology/src/index.ts";

export const SEARCH_QUERY_BYTE_LIMIT = 16_384;
export const SEARCH_QUERY_WORD_LIMIT = 512;
export const SEARCH_SEGMENT_WORK_LIMIT = 300_000;
export const SEARCH_HEADWORD_WORK_LIMIT = 300_000;
export type SegmentationStatus = "complete" | "limited";
export const matchKinds = [
  "headword",
  "sequence-exact",
  "gloss",
  "sequence-contiguous",
  "sequence-subsequence",
  "headword-prefix",
  "gloss-prefix",
  "token",
  "component",
] as const;
export type MatchKind = (typeof matchKinds)[number];
export function withSegmentation<T>(
  rows: T[],
  segmentation: SegmentationStatus,
): T[] & { segmentation: SegmentationStatus } {
  return Object.defineProperty(rows, "segmentation", {
    value: segmentation,
  }) as T[] & { segmentation: SegmentationStatus };
}
export const matchRank = (kind: MatchKind) => matchKinds.indexOf(kind);

export interface LexicalEntry {
  word: { spelling: string };
  glosses: { text: string }[];
  plain_text: string;
}
export interface SearchMetrics {
  entries: number;
  queryWords: number;
  queryParserWork: number;
  headwordsParsed: number;
  headwordParserWork: number;
  componentComparisons: number;
}
export const searchMetrics = (): SearchMetrics => ({
  entries: 0,
  queryWords: 0,
  queryParserWork: 0,
  headwordsParsed: 0,
  headwordParserWork: 0,
  componentComparisons: 0,
});
export function normalizeQuery(value: string): string {
  return value
    .normalize("NFC")
    .toLocaleLowerCase("en")
    .replaceAll("’", "'")
    .trim();
}
const headwordKey = (value: string) => stripAcuteAccents(normalizeQuery(value));

interface Components {
  words: string[];
  cmavo: boolean;
  tokens: (string | null)[];
  prefix: number[];
}
interface PreparedEntry {
  spelling: string;
  glosses: string[];
  text: string;
  components: Components | null;
  limited: boolean;
}
// Entries belong to immutable packages. A replaced package releases its cache.
const entryIndex = new WeakMap<LexicalEntry, PreparedEntry>();
const equal = (a: string | null, b: string | null, metrics?: SearchMetrics) => {
  if (metrics) metrics.componentComparisons++;
  return a === b;
};
function prefixTable(pattern: string[], metrics?: SearchMetrics): number[] {
  const table = new Array<number>(pattern.length).fill(0);
  for (let index = 1, matched = 0; index < pattern.length; index++) {
    while (matched && !equal(pattern[index], pattern[matched], metrics))
      matched = table[matched - 1];
    if (equal(pattern[index], pattern[matched], metrics)) matched++;
    table[index] = matched;
  }
  return table;
}
function contains(
  text: readonly (string | null)[],
  pattern: string[],
  prefix: number[],
  metrics?: SearchMetrics,
): boolean {
  if (text.length < pattern.length) return false;
  let matched = 0;
  for (const word of text) {
    while (matched && !equal(word, pattern[matched], metrics))
      matched = prefix[matched - 1];
    if (equal(word, pattern[matched], metrics)) matched++;
    if (matched === pattern.length) return true;
  }
  return false;
}
function components(value: string, workLimit: number, runLimit = 128) {
  const parsed = segmentText(value, {
    byteLimit: SEARCH_QUERY_BYTE_LIMIT,
    workLimit,
    runLimit,
  });
  const words = parsed.words.map((word) => headwordKey(word.text));
  const tokens: (string | null)[] = [];
  let foreign = 0;
  for (let index = 0; index < parsed.words.length; index++) {
    while (parsed.foreign[foreign]?.start < parsed.words[index].start) {
      tokens.push(null);
      foreign++;
    }
    tokens.push(words[index]);
  }
  if (foreign < parsed.foreign.length) tokens.push(null);
  return {
    parsed,
    value: {
      words,
      tokens,
      cmavo:
        parsed.foreign.length === 0 &&
        parsed.words.every((word) => word.kind === "cmavo"),
      prefix: prefixTable(words),
    } satisfies Components,
  };
}
function prepareEntry(
  entry: LexicalEntry,
  metrics?: SearchMetrics,
): PreparedEntry {
  const cached = entryIndex.get(entry);
  if (cached) return cached;
  const spelling = headwordKey(entry.word.spelling);
  let sequence: Components | null = null;
  let limited = false;
  if (new TextEncoder().encode(spelling).length <= 256) {
    if (metrics) metrics.headwordsParsed++;
    try {
      const result = components(spelling, SEARCH_HEADWORD_WORK_LIMIT, 256);
      if (metrics) metrics.headwordParserWork += result.parsed.spent;
      if (!result.parsed.foreign.length) sequence = result.value;
    } catch (error) {
      if (!(error instanceof BuilderError)) throw error;
      limited = error.failure.kind === "resource-limit";
      if (metrics) metrics.headwordParserWork += error.failure.value ?? 0;
    }
  }
  const indexed = {
    spelling,
    glosses: entry.glosses.map((gloss) => normalizeQuery(gloss.text)),
    text: normalizeQuery(entry.plain_text),
    components: sequence,
    limited,
  };
  entryIndex.set(entry, indexed);
  return indexed;
}
export interface PreparedQuery {
  text: string;
  headword: string;
  components: Components | null;
  positions: Map<string, number>;
  segmentation: SegmentationStatus;
}
export function prepareQuery(
  query: string,
  metrics?: SearchMetrics,
): PreparedQuery {
  const text = normalizeQuery(query);
  const headword = headwordKey(text);
  const result: PreparedQuery = {
    text,
    headword,
    components: null,
    positions: new Map(),
    segmentation: "complete",
  };
  if (!text) return result;
  if (new TextEncoder().encode(query).length > SEARCH_QUERY_BYTE_LIMIT) {
    result.segmentation = "limited";
    return result;
  }
  try {
    const segmented = components(headword, SEARCH_SEGMENT_WORK_LIMIT);
    if (metrics) {
      metrics.queryParserWork = segmented.parsed.spent;
      metrics.queryWords = segmented.value.words.length;
    }
    if (segmented.value.words.length > SEARCH_QUERY_WORD_LIMIT) {
      result.segmentation = "limited";
      return result;
    }
    result.components = segmented.value;
    segmented.value.words.forEach((word, index) => {
      if (!result.positions.has(word)) result.positions.set(word, index);
    });
  } catch (error) {
    if (!(error instanceof BuilderError)) throw error;
    result.segmentation = "limited";
    if (metrics) metrics.queryParserWork = error.failure.value ?? 0;
  }
  return result;
}
function sequenceMatch(
  entry: PreparedEntry,
  query: PreparedQuery,
  metrics?: SearchMetrics,
): MatchKind | null {
  const head = entry.components;
  const q = query.components;
  if (!head?.cmavo || head.words.length < 2 || !q?.words.length) return null;
  if (
    q.cmavo &&
    head.words.length === q.words.length &&
    head.words.every((word, index) => equal(word, q.words[index], metrics))
  )
    return "sequence-exact";
  if (
    contains(q.tokens, head.words, head.prefix, metrics) ||
    (q.cmavo && contains(head.words, q.words, q.prefix, metrics))
  )
    return "sequence-contiguous";
  if (q.cmavo && q.words.length <= head.words.length) {
    let matched = 0;
    for (const word of head.words) {
      if (equal(word, q.words[matched], metrics)) matched++;
      if (matched === q.words.length) return "sequence-subsequence";
    }
  }
  return null;
}
export interface LexicalMatch<T> {
  entry: T;
  match: MatchKind;
  /** The first query position, used only for component fallback. */
  position: number;
}
/** One scan. Sequence searches use linear passes and never enumerate subsets. */
export function selectMatches<T extends LexicalEntry>(
  entries: Iterable<T>,
  query: string | PreparedQuery,
  metrics?: SearchMetrics,
): { rows: LexicalMatch<T>[]; segmentation: SegmentationStatus } {
  const prepared =
    typeof query === "string" ? prepareQuery(query, metrics) : query;
  const rows: LexicalMatch<T>[] = [];
  const fallback: LexicalMatch<T>[] = [];
  let joined = false;
  let segmentation = prepared.segmentation;
  if (!prepared.text) return { rows, segmentation: prepared.segmentation };
  for (const entry of entries) {
    if (metrics) metrics.entries++;
    const index = prepareEntry(entry, metrics);
    if (index.limited) segmentation = "limited";
    const sequence = sequenceMatch(index, prepared, metrics);
    if (sequence) joined = true;
    const match: MatchKind | null =
      index.spelling === prepared.headword && prepared.headword
        ? "headword"
        : sequence === "sequence-exact"
          ? sequence
          : index.glosses.includes(prepared.text)
            ? "gloss"
            : (sequence ??
              (prepared.headword && index.spelling.startsWith(prepared.headword)
                ? "headword-prefix"
                : index.glosses.some((gloss) => gloss.startsWith(prepared.text))
                  ? "gloss-prefix"
                  : index.text.includes(prepared.text)
                    ? "token"
                    : null));
    if (match) rows.push({ entry, match, position: 0 });
    if ((prepared.components?.words.length ?? 0) > 1) {
      const key =
        index.components?.words.length === 1
          ? index.components.words[0]
          : index.spelling;
      const position = prepared.positions.get(key);
      if (position !== undefined)
        fallback.push({ entry, match: "component", position });
    }
  }
  // Ordinary full-query matches remain visible. Component cards follow them.
  if (!joined) {
    const matchedEntries = new Set(rows.map((row) => row.entry));
    for (const row of fallback)
      if (!matchedEntries.has(row.entry)) rows.push(row);
  }
  return { rows, segmentation };
}
/** A single-entry lookup, with the same normalization and sequence classes. */
export function matchKind(
  entry: LexicalEntry,
  query: string,
): MatchKind | null {
  return selectMatches([entry], query).rows[0]?.match ?? null;
}
