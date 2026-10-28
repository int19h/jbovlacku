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
  "gloss",
  "sequence-exact",
  "sequence-contiguous",
  "headword-prefix",
  "gloss-prefix",
  "sequence-subsequence",
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
  queryParses: number;
  queryParserWork: number;
  headwordsParsed: number;
  headwordParserWork: number;
  componentComparisons: number;
}
export const searchMetrics = (): SearchMetrics => ({
  entries: 0,
  queryWords: 0,
  queryParses: 0,
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
  canonical: string;
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
function coverOccurrences(
  text: readonly (string | null)[],
  pattern: string[],
  prefix: number[],
  coverage: Int32Array,
  metrics?: SearchMetrics,
): boolean {
  if (text.length < pattern.length) return false;
  let matched = 0,
    found = false;
  for (let index = 0; index < text.length; index++) {
    const word = text[index];
    while (matched && !equal(word, pattern[matched], metrics))
      matched = prefix[matched - 1];
    if (equal(word, pattern[matched], metrics)) matched++;
    if (matched === pattern.length) {
      coverage[index - pattern.length + 1]++;
      coverage[index + 1]--;
      found = true;
      matched = prefix[matched - 1];
    }
  }
  return found;
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
      if (tokens.at(-1) !== null) tokens.push(null);
      foreign++;
    }
    tokens.push(words[index]);
  }
  if (foreign < parsed.foreign.length && tokens.at(-1) !== null)
    tokens.push(null);
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
export const SPELLING_CACHE_LIMIT = 4096;
const spellingIndex = new Map<
  string,
  { components: Components | null; limited: boolean }
>();
const canonicalWord = (value: string) =>
  value.replaceAll("h", "'").replace(/[.,]/gu, "").trim();
/** Cmavo have no consonant clusters and cannot end in a consonant. */
function canBeCompound(value: string): boolean {
  const plain = canonicalWord(value);
  if (/[^a-z'0-9\s]/u.test(plain)) return true;
  if (/[bcdfgjklmnprstvxz]{2}|[bcdfgjklmnprstvxz](?:\s|$)/u.test(plain))
    return false;
  return (plain.match(/[aeiouy0-9]/gu)?.length ?? 0) >= 2;
}
function indexedComponents(spelling: string, metrics?: SearchMetrics) {
  if (new TextEncoder().encode(spelling).length > 256)
    return { components: null, limited: true };
  if (!canBeCompound(spelling)) return { components: null, limited: false };
  const cached = spellingIndex.get(spelling);
  if (cached) {
    spellingIndex.delete(spelling);
    spellingIndex.set(spelling, cached);
    return cached;
  }
  let sequence: Components | null = null;
  let limited = false;
  if (metrics) metrics.headwordsParsed++;
  try {
    const result = components(spelling, SEARCH_HEADWORD_WORK_LIMIT, 256);
    if (metrics) metrics.headwordParserWork += result.parsed.spent;
    if (!result.parsed.foreign.length && result.value.cmavo)
      sequence = result.value;
  } catch (error) {
    if (!(error instanceof BuilderError)) throw error;
    limited = error.failure.kind === "resource-limit";
    if (metrics) metrics.headwordParserWork += error.failure.value ?? 0;
  }
  const result = { components: sequence, limited };
  spellingIndex.set(spelling, result);
  if (spellingIndex.size > SPELLING_CACHE_LIMIT)
    spellingIndex.delete(spellingIndex.keys().next().value!);
  return result;
}
function prepareEntry(
  entry: LexicalEntry,
  metrics?: SearchMetrics,
): PreparedEntry {
  const cached = entryIndex.get(entry);
  if (cached) return cached;
  const spelling = headwordKey(entry.word.spelling);
  const indexed = {
    spelling,
    canonical: canonicalWord(spelling),
    glosses: entry.glosses.map((gloss) => normalizeQuery(gloss.text)),
    text: normalizeQuery(entry.plain_text),
    ...indexedComponents(spelling, metrics),
  };
  entryIndex.set(entry, indexed);
  return indexed;
}
export interface SearchIndex<T extends LexicalEntry> {
  rows: { entry: T; indexed: PreparedEntry }[];
}
const preparedIndexes = new WeakMap<object, SearchIndex<LexicalEntry>>();
/** The caller retains an immutable array for its package or materialized generation. */
export function prepareIndex<T extends LexicalEntry>(
  entries: readonly T[],
  metrics?: SearchMetrics,
): SearchIndex<T> {
  const previous = preparedIndexes.get(entries);
  if (previous) return previous as SearchIndex<T>;
  const index = {
    rows: entries.map((entry) => ({
      entry,
      indexed: prepareEntry(entry, metrics),
    })),
  };
  preparedIndexes.set(entries, index);
  return index;
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
    if (metrics) metrics.queryParses++;
    const segmented = components(headword, SEARCH_SEGMENT_WORK_LIMIT);
    if (metrics) {
      metrics.queryParserWork += segmented.parsed.spent;
      metrics.queryWords += segmented.value.words.length;
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
    if (metrics && error.failure.measure === "text recognition work")
      metrics.queryParserWork += error.failure.value ?? 0;
  }
  return result;
}
function sequenceMatch(
  entry: PreparedEntry,
  query: PreparedQuery,
  coverage: Int32Array,
  metrics?: SearchMetrics,
): MatchKind | null {
  const head = entry.components,
    q = query.components;
  if (!head?.cmavo || head.words.length < 2 || !q?.words.length) return null;
  if (
    q.cmavo &&
    head.words.length === q.words.length &&
    head.words.every((word, index) => equal(word, q.words[index], metrics))
  ) {
    coverage[0]++;
    coverage[q.tokens.length]--;
    return "sequence-exact";
  }
  if (coverOccurrences(q.tokens, head.words, head.prefix, coverage, metrics))
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
  entries: Iterable<T> | SearchIndex<T>,
  query: string | PreparedQuery,
  metrics?: SearchMetrics,
  accept: (entry: T) => boolean = () => true,
): { rows: LexicalMatch<T>[]; segmentation: SegmentationStatus } {
  const prepared =
    typeof query === "string" ? prepareQuery(query, metrics) : query;
  const rows: LexicalMatch<T>[] = [];
  const fallback: { entry: T; key: string }[] = [];
  const coverage = new Int32Array(
    (prepared.components?.tokens.length ?? 0) + 1,
  );
  let segmentation = prepared.segmentation;
  if (!prepared.text) return { rows, segmentation };
  const single =
    prepared.components?.words.length === 1 &&
    !prepared.components.tokens.includes(null)
      ? prepared.components.words[0]
      : null;
  const source =
    "rows" in entries
      ? entries.rows
      : Array.isArray(entries)
        ? prepareIndex(entries, metrics).rows
        : (function* () {
            for (const entry of entries as Iterable<T>)
              yield { entry, indexed: prepareEntry(entry, metrics) };
          })();
  for (const { entry, indexed: index } of source) {
    if (metrics) metrics.entries++;
    if (!accept(entry)) continue;
    if (index.limited) segmentation = "limited";
    const sequence = sequenceMatch(index, prepared, coverage, metrics);
    const prefix = single ?? prepared.headword;
    const candidates: MatchKind[] = [];
    if (
      (prepared.headword && index.spelling === prepared.headword) ||
      (single && index.canonical === single)
    )
      candidates.push("headword");
    if (index.glosses.includes(prepared.text)) candidates.push("gloss");
    if (sequence) candidates.push(sequence);
    if (
      (prepared.headword && index.spelling.startsWith(prepared.headword)) ||
      (prefix && index.canonical.startsWith(prefix))
    )
      candidates.push("headword-prefix");
    if (index.glosses.some((gloss) => gloss.startsWith(prepared.text)))
      candidates.push("gloss-prefix");
    if (index.text.includes(prepared.text)) candidates.push("token");
    candidates.sort((a, b) => matchRank(a) - matchRank(b));
    if (candidates.length)
      rows.push({ entry, match: candidates[0], position: 0 });
    if (prepared.positions.has(index.canonical))
      fallback.push({ entry, key: index.canonical });
  }
  const positions = new Map<string, number>();
  let covered = 0,
    position = 0;
  for (const [index, token] of (prepared.components?.tokens ?? []).entries()) {
    covered += coverage[index];
    if (token === null) continue;
    if (!covered && !positions.has(token)) positions.set(token, position);
    position++;
  }
  const matchedEntries = new Set(rows.map((row) => row.entry));
  for (const { entry, key } of fallback) {
    const position = positions.get(key);
    if (position !== undefined && !matchedEntries.has(entry))
      rows.push({ entry, match: "component", position });
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
