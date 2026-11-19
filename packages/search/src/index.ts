import {
  BuilderError,
  segmentText,
  stripAcuteAccents,
} from "../../morphology/src/index.ts";
import { compilePattern, isPatternQuery, patternKey } from "./pattern.ts";
export {
  PatternError,
  isPatternQuery,
  naturalLanguageNote,
  comparePatternSpelling,
} from "./pattern.ts";

export const SEARCH_QUERY_BYTE_LIMIT = 16_384;
export const SEARCH_QUERY_WORD_LIMIT = 512;
/**
 * A local search query accepts at most this many UTF-16 code units. Longer
 * input is refused before anything reads it: every per-query step (splitting,
 * detectors, transfer, parsing, scanning, sorting) scales with the query,
 * and the per-request budget cannot see the raw query before it is charged.
 * Real dictionary queries are words and short phrases; the longest fixed
 * check query is 25 units, so this leaves wide headroom.
 */
export const SEARCH_QUERY_LENGTH_LIMIT = 4096;
/** A query longer than SEARCH_QUERY_LENGTH_LIMIT. The page reports it as a message. */
export class SearchQueryTooLongError extends Error {
  constructor(
    message = "The search query is too long. Queries accept at most 4096 characters.",
  ) {
    super(message);
    this.name = "SearchQueryTooLongError";
  }
}
export const SEARCH_SEGMENT_WORK_LIMIT = 300_000;
export const SEARCH_HEADWORD_WORK_LIMIT = 300_000;
/**
 * A literal local scan or package preparation may use this much work before
 * it reports a budget failure instead of running unbounded. Work is counted
 * in units: a validated, prepared, transferred, or scanned entry costs
 * `1 + items + ceil(chars / 64)`, where items counts its glosses, rafsi
 * spellings, selmaho names, and attribution dates, and chars counts the
 * characters of its spelling, plain text, event ID, issuer, gloss texts
 * and senses, rafsi spellings, selmaho names, and attribution strings.
 * All other work costs one unit each: a component comparison, a map
 * insertion, a sort comparison, a morphology parser step, or a mapped reply
 * reference. A comparison block reserves its upper bound before it runs,
 * and each comparison that runs is also counted. The default completes an
 * ordinary query on a package five times the base data with wide headroom.
 * A caller can lower or raise it per request.
 */
export const SEARCH_LOCAL_WORK_LIMIT = 200_000_000;
/**
 * Wall-clock bound for one literal local scan or package preparation, in
 * milliseconds. Pattern queries keep their own shorter worker deadline.
 * Preparation runs once per package and dominates the cost: on the measured
 * host it takes about 70 seconds for a package five times the base data, so
 * the default keeps wide headroom above that instead of racing it. The work
 * budget above remains the tight deterministic guard; this deadline only
 * stops runs whose cost the work count cannot see (a much slower device or
 * pathological platform behavior).
 */
export const SEARCH_LOCAL_DEADLINE_MS = 300_000;
/**
 * Work units for variable-size content: one unit per item plus one unit per
 * 64 UTF-16 code units, so charges grow with the bytes and items actually
 * handled instead of counting every entry the same.
 */
export function contentUnits(items: number, chars: number): number {
  return items + Math.ceil(chars / 64);
}
/**
 * Defensive content size of one package entry-shaped value, on top of the
 * one unit every entry costs: gloss, rafsi, selmaho, and attribution-date
 * counts plus the characters of the word spelling, plain text, gloss texts
 * and senses, rafsi spellings, event ID, issuer, attribution source, author,
 * account origin, and attribution date names and values. Non-array or
 * non-string fields contribute nothing, so malformed input still fails
 * validation with its invalid-package error instead of a shape error here.
 * Gloss and rafsi counts stop at validation's own per-entry bounds, so an
 * oversized malformed list cannot turn into a budget refusal instead of
 * invalid input. Validation places no bound on the attribution dates map,
 * so every date counts: any date count is valid input there. Callers add
 * their own base unit. With a budget, the unbounded walks stop as soon as
 * the measured cost itself exceeds the remaining allowance, so measuring a
 * huge map cannot walk unbounded on an exhausted budget; a cost that fits is
 * measured to the end, so exact charges are unchanged.
 */
export function entryContentUnits(
  value: unknown,
  budget?: SearchRequestBudget,
  phase: SearchBudgetError["phase"] = "prepare",
): number {
  // Mirrors the per-entry bounds enforced by entry validation.
  const MAX_GLOSSES = 8192;
  const MAX_RAFSI = 64;
  if (!value || typeof value !== "object") return 0;
  const record = value as Record<string, unknown>;
  const word = record.word;
  let items = 0;
  let chars = 0;
  const text = (input: unknown) => {
    if (typeof input === "string") chars += input.length;
  };
  text(
    typeof word === "object" && word !== null
      ? (word as Record<string, unknown>).spelling
      : undefined,
  );
  text(record.plain_text);
  text(record.event);
  text(record.issuer);
  // Enforcement inside the unbounded walks below: stop as soon as the cost
  // measured so far exceeds what remains, so a huge map respects the
  // allowance instead of walking to the end on an exhausted budget.
  let walked = 0;
  const bound = () => {
    if (budget && ++walked % 64 === 0)
      budget.ensure(items + Math.ceil(chars / 64), phase);
  };
  const glosses = Array.isArray(record.glosses) ? record.glosses : [];
  const glossCount = Math.min(glosses.length, MAX_GLOSSES);
  items += glossCount;
  for (let index = 0; index < glossCount; index++) {
    const gloss = glosses[index] as Record<string, unknown> | null;
    text(gloss?.text);
    text(gloss?.sense);
  }
  const attribution = record.attribution;
  if (attribution && typeof attribution === "object") {
    const info = attribution as Record<string, unknown>;
    text(info.source);
    text(info.author);
    const account = info.account;
    if (account && typeof account === "object")
      text((account as Record<string, unknown>).origin);
    const dates = info.dates;
    if (dates && typeof dates === "object") {
      // for..in avoids materializing the whole pairs array before the bound
      // below can refuse; with an own-property guard it enumerates the same
      // names in the same order as Object.entries.
      const table = dates as Record<string, unknown>;
      for (const day in table) {
        if (!Object.prototype.hasOwnProperty.call(table, day)) continue;
        items++;
        text(day);
        text(table[day]);
        bound();
      }
    }
  }
  const rafsi = Array.isArray(record.rafsi) ? record.rafsi : [];
  const rafsiCount = Math.min(rafsi.length, MAX_RAFSI);
  items += rafsiCount;
  for (let index = 0; index < rafsiCount; index++) text(rafsi[index]);
  const classification = record.classification;
  const selmaho =
    typeof classification === "object" && classification !== null
      ? (classification as Record<string, unknown>).selmaho
      : undefined;
  if (Array.isArray(selmaho)) {
    items += selmaho.length;
    for (const name of selmaho) {
      text(name);
      bound();
    }
  }
  return contentUnits(items, chars);
}
/** A scan or preparation stopped by its work budget or deadline. */
export class SearchBudgetError extends Error {
  constructor(
    public phase: "prepare" | "search",
    message: string,
  ) {
    super(message);
  }
}
export const SEARCH_BUDGET_MESSAGE =
  "Local search reached its work or time limit. Use a shorter or more specific query.";
export const SEARCH_PREPARE_BUDGET_MESSAGE =
  "Search package preparation reached its work or time limit. The package index is too costly to build on this device. Search this server instead.";
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
  "headword-pattern",
  "rafsi-pattern",
] as const;
export type MatchKind = (typeof matchKinds)[number];
export function withSegmentation<T>(
  rows: T[],
  segmentation: SegmentationStatus,
  allLojban = false,
): T[] & { segmentation: SegmentationStatus; allLojban: boolean } {
  return Object.defineProperties(rows, {
    segmentation: { value: segmentation },
    allLojban: { value: allLojban },
  }) as T[] & { segmentation: SegmentationStatus; allLojban: boolean };
}
export type SearchGroup = "lojban" | "definitions";
export const matchGroup = (match: MatchKind): SearchGroup =>
  ["gloss", "gloss-prefix", "token"].includes(match) ? "definitions" : "lojban";
export const matchRank = (kind: MatchKind) => matchKinds.indexOf(kind);

export interface LexicalEntry {
  word: { spelling: string };
  glosses: { text: string }[];
  plain_text: string;
  rafsi?: string[];
  search_status?:
    | "active"
    | "retired"
    | "ineligible"
    | { view: string; status: "active" | "retired" | "ineligible" };
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
// These are whole spelling aliases. They never use morphology segmentation.
const knownSpelling = (value: string) =>
  value.replace(/[.,]/gu, "").replaceAll("h", "'");

interface Components {
  words: string[];
  cmavo: boolean;
  tokens: (string | null)[];
  prefix: number[];
}
interface PreparedEntry {
  spelling: string;
  knownSpelling: string;
  canonical: string;
  glosses: string[];
  text: string;
  components: Components | null;
  limited: boolean;
}
// Entries belong to immutable packages. A replaced package releases its cache.
const entryIndex = new WeakMap<LexicalEntry, PreparedEntry>();
const equal = (
  a: string | null,
  b: string | null,
  metrics?: SearchMetrics,
  budget?: SearchRequestBudget,
) => {
  // Each counted comparison checks the remaining allowance before it runs,
  // so a comparison never starts with zero units left for its own charge.
  if (metrics) {
    budget?.ensure(1, "search");
    metrics.componentComparisons++;
  }
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
  budget?: SearchRequestBudget,
): boolean {
  if (text.length < pattern.length) return false;
  let matched = 0,
    found = false;
  for (let index = 0; index < text.length; index++) {
    const word = text[index];
    while (matched && !equal(word, pattern[matched], metrics, budget))
      matched = prefix[matched - 1];
    if (equal(word, pattern[matched], metrics, budget)) matched++;
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
function indexedComponents(
  spelling: string,
  metrics?: SearchMetrics,
  allowance = SEARCH_HEADWORD_WORK_LIMIT,
) {
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
  // The parser runs on at most the remaining shared allowance, never on its
  // own independent cap alone. The parser counts a refusing step in its own
  // totals, so only the allowance is added to the shared budget.
  const cap = Math.min(SEARCH_HEADWORD_WORK_LIMIT, allowance);
  try {
    const result = components(spelling, cap, 256);
    if (metrics)
      metrics.headwordParserWork += Math.min(result.parsed.spent, cap);
    if (!result.parsed.foreign.length && result.value.cmavo)
      sequence = result.value;
  } catch (error) {
    if (!(error instanceof BuilderError)) throw error;
    limited = error.failure.kind === "resource-limit";
    if (metrics)
      metrics.headwordParserWork += Math.min(error.failure.value ?? 0, cap);
  }
  const result = { components: sequence, limited };
  // A limit reached under a tight allowance must not poison later requests:
  // only successes and full-allowance results are cached.
  if (!limited || allowance >= SEARCH_HEADWORD_WORK_LIMIT) {
    spellingIndex.set(spelling, result);
    if (spellingIndex.size > SPELLING_CACHE_LIMIT)
      spellingIndex.delete(spellingIndex.keys().next().value!);
  }
  return result;
}
function prepareEntry(
  entry: LexicalEntry,
  metrics?: SearchMetrics,
  allowance = SEARCH_HEADWORD_WORK_LIMIT,
): PreparedEntry {
  const cached = entryIndex.get(entry);
  if (cached) return cached;
  const spelling = headwordKey(entry.word.spelling);
  const indexed = {
    spelling,
    knownSpelling: knownSpelling(spelling),
    canonical: canonicalWord(spelling),
    glosses: entry.glosses.map((gloss) => normalizeQuery(gloss.text)),
    text: normalizeQuery(entry.plain_text),
    ...indexedComponents(spelling, metrics, allowance),
  };
  // As above, a limit reached under a tight allowance is never cached.
  if (!indexed.limited || allowance >= SEARCH_HEADWORD_WORK_LIMIT)
    entryIndex.set(entry, indexed);
  return indexed;
}
export interface SearchIndex<T extends LexicalEntry> {
  rows: { entry: T; indexed: PreparedEntry }[];
}
/**
 * Per-request overrides for the literal-search work budget and deadline.
 * `requestBudget` shares one budget across a whole request: validation,
 * preparation, maps, query parsing, scanning, grouping, and sorting. When it
 * is absent, each call starts its own budget from `workLimit`/`deadlineMs`.
 * A shared budget measures the metrics object it was created with; every
 * stage of the request must pass that same object.
 */
export interface SearchBudgetOptions {
  workLimit?: number;
  deadlineMs?: number;
  requestBudget?: SearchRequestBudget;
}
/** The transferable state of one request budget across a worker boundary. */
export interface SearchBudgetState {
  workLimit: number;
  deadlineMs: number;
  start: number;
  spent: number;
}
/** True for a well-formed budget state carried by a worker message. */
export function isSearchBudgetState(
  value: unknown,
): value is SearchBudgetState {
  const state = value as SearchBudgetState;
  const bound = (n: number) =>
    typeof n === "number" && (Number.isFinite(n) || n === Infinity);
  return (
    !!value &&
    typeof value === "object" &&
    bound(state.workLimit) &&
    bound(state.deadlineMs) &&
    Number.isFinite(state.start) &&
    Number.isFinite(state.spent) &&
    state.spent >= 0
  );
}
/**
 * One work budget and one deadline for a whole request. Each stage reserves
 * its units before doing the work, so an exhausted budget stops the next
 * unit instead of letting a batch run past it. The deadline starts when the
 * budget is created and is checked on every reservation.
 */
export class SearchRequestBudget {
  readonly workLimit: number;
  readonly deadlineMs: number;
  private start = Date.now();
  private reserved = 0;
  private entries: number;
  private comparisons: number;
  private parserWork: number;
  constructor(
    private metrics: SearchMetrics,
    options?: SearchBudgetOptions,
  ) {
    this.workLimit = options?.workLimit ?? SEARCH_LOCAL_WORK_LIMIT;
    this.deadlineMs = options?.deadlineMs ?? SEARCH_LOCAL_DEADLINE_MS;
    this.entries = metrics.entries;
    this.comparisons = metrics.componentComparisons;
    this.parserWork = metrics.queryParserWork + metrics.headwordParserWork;
  }
  /** Use a shared budget when one is supplied, else start one for this call. */
  static for(
    metrics: SearchMetrics,
    options?: SearchBudgetOptions,
  ): SearchRequestBudget {
    return options?.requestBudget ?? new SearchRequestBudget(metrics, options);
  }
  /**
   * Continue the same budget on the other side of a worker boundary. The
   * reply carries the spent total and the original start, so the deadline
   * still spans the whole request.
   */
  static resume(
    state: SearchBudgetState,
    metrics: SearchMetrics = searchMetrics(),
  ): SearchRequestBudget {
    const budget = new SearchRequestBudget(metrics, {
      workLimit: state.workLimit,
      deadlineMs: state.deadlineMs,
    });
    budget.start = state.start;
    budget.reserved = state.spent;
    budget.entries = metrics.entries;
    budget.comparisons = metrics.componentComparisons;
    budget.parserWork = metrics.queryParserWork + metrics.headwordParserWork;
    return budget;
  }
  /**
   * Work units left before the limit. Parsers take at most this as their
   * allowance, so an exhausted shared budget stops them before they start
   * instead of letting them run on their own independent caps.
   */
  remaining(): number {
    return Math.max(0, this.workLimit - this.total());
  }
  /** Transferable spent total plus the original start for the reply. */
  snapshot(): SearchBudgetState {
    return {
      workLimit: this.workLimit,
      deadlineMs: this.deadlineMs,
      start: this.start,
      spent: this.total(),
    };
  }
  private total(): number {
    return (
      this.reserved +
      (this.metrics.entries - this.entries) +
      (this.metrics.componentComparisons - this.comparisons) +
      (this.metrics.queryParserWork +
        this.metrics.headwordParserWork -
        this.parserWork)
    );
  }
  private failure(phase: SearchBudgetError["phase"]): SearchBudgetError {
    return new SearchBudgetError(
      phase,
      phase === "prepare"
        ? SEARCH_PREPARE_BUDGET_MESSAGE
        : SEARCH_BUDGET_MESSAGE,
    );
  }
  /** Enforce the budget and the deadline before the next work runs. */
  check(phase: SearchBudgetError["phase"]): void {
    if (this.total() > this.workLimit) throw this.failure(phase);
    if (Date.now() - this.start > this.deadlineMs) throw this.failure(phase);
  }
  /**
   * Throw unless `units` more work fits in the budget, without charging
   * anything. Use it before a metrics counter increment that the budget
   * totals, so the increment itself cannot push the total past the limit.
   * Unlike `check`, this performs no deadline read, so it stays cheap
   * inside per-comparison loops; the surrounding per-row reservation still
   * enforces the deadline.
   */
  ensure(units: number, phase: SearchBudgetError["phase"]): void {
    if (this.total() + units > this.workLimit) throw this.failure(phase);
  }
  /**
   * Charge `units` of work, then enforce before that work runs. The refusal
   * is tested before anything is added, so the budget total never passes
   * its limit on a refusal: only performed work is ever charged.
   */
  reserve(units: number, phase: SearchBudgetError["phase"]): void {
    this.ensure(units, phase);
    this.reserved += units;
    this.check(phase);
  }
}
const preparedIndexes = new WeakMap<object, SearchIndex<LexicalEntry>>();
/** The caller retains an immutable array for its package or materialized generation. */
export function prepareIndex<T extends LexicalEntry>(
  entries: readonly T[],
  metrics?: SearchMetrics,
  budget?: SearchBudgetOptions,
): SearchIndex<T> {
  const previous = preparedIndexes.get(entries);
  if (previous) return previous as SearchIndex<T>;
  const measured = metrics ?? searchMetrics();
  const limit = SearchRequestBudget.for(measured, budget);
  // A limit reached under a tight allowance must not poison later requests:
  // the whole-array result is cached only when no row was limited by one,
  // like the per-spelling and per-entry caches below.
  let cacheable = true;
  const rows = entries.map((entry) => {
    // Building one row costs one unit on top of its content work and its
    // parser work, charged before the row is built so an exhausted budget
    // builds nothing. The unit is ensured before measuring, so an
    // exhausted budget also walks nothing.
    limit.ensure(1, "prepare");
    limit.reserve(1 + entryContentUnits(entry, limit, "prepare"), "prepare");
    const allowance = limit.remaining();
    const indexed = prepareEntry(entry, measured, allowance);
    if (indexed.limited && allowance < SEARCH_HEADWORD_WORK_LIMIT)
      cacheable = false;
    return { entry, indexed };
  });
  limit.check("prepare");
  const index = { rows };
  if (cacheable) preparedIndexes.set(entries, index);
  return index;
}
export interface SearchOptions extends SearchBudgetOptions {
  patterns?: boolean;
  /**
   * Check SEARCH_QUERY_LENGTH_LIMIT against the given string, which must be
   * the raw input spelling. Local entry points decide the cap once on the
   * raw query; normalized, lowercased, or trimmed text is never rechecked.
   * The server never sets this, so remote search keeps its own byte policy.
   */
  enforceQueryLengthCap?: boolean;
  group?: SearchGroup;
  includeRetired?: boolean;
  view?: string | null;
  /** The view that binds compact status fields in a local package. */
  packageView?: string;
  knownWord?: (entry: LexicalEntry) => boolean;
  rafsiFor?: (entry: LexicalEntry) => readonly string[];
}
export interface PreparedQuery {
  text: string;
  headword: string;
  components: Components | null;
  positions: Map<string, number>;
  segmentation: SegmentationStatus;
  pattern?: string;
}
export function prepareQuery(
  query: string,
  metrics?: SearchMetrics,
  options: SearchOptions = {},
): PreparedQuery {
  // The local product cap applies only when the caller asks for it, on the
  // raw input spelling: the server keeps its own byte policy, and callers
  // that already decided it on the raw query pass the prepared result on.
  if (options.enforceQueryLengthCap && query.length > SEARCH_QUERY_LENGTH_LIMIT)
    throw new SearchQueryTooLongError();
  // Query parsing belongs to the request budget, so a grouped query that
  // parses before the scan still counts its parser work.
  const measured = metrics ?? searchMetrics();
  const limit = SearchRequestBudget.for(measured, options);
  limit.check("search");
  // The query size is charged before anything that scales with it runs:
  // normalization, the byte check, parsing, and the per-group word splits
  // below all read the whole query. One unit per 64 UTF-16 code units,
  // like entry content.
  limit.reserve(contentUnits(0, query.length), "search");
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
  if (options.patterns !== false && isPatternQuery(query)) {
    result.pattern = query;
    return result;
  }
  if (new TextEncoder().encode(query).length > SEARCH_QUERY_BYTE_LIMIT) {
    result.segmentation = "limited";
    return result;
  }
  // The query parser runs on at most the remaining shared allowance, so an
  // exhausted budget stops it instead of running its own cap alone. Only
  // the allowance is added to the shared budget; a refusing step is the
  // parser's own accounting.
  const allowance = Math.min(SEARCH_SEGMENT_WORK_LIMIT, limit.remaining());
  try {
    measured.queryParses++;
    const segmented = components(headword, allowance);
    measured.queryParserWork += Math.min(segmented.parsed.spent, allowance);
    measured.queryWords += segmented.value.words.length;
    // The parse work above belongs to the request budget; enforce it before
    // the scan runs on the parsed query.
    limit.check("search");
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
    // Every failure carries the work already performed plus the failing
    // run's own size: recognition-work failures, later runs that fail their
    // phoneme bound (their length, not parser work), byte-bound failures
    // (their byte count, charged before any parsing), and invalid runs
    // (what parsing them cost). Only the allowance is added to the shared
    // budget; work past it is the parser's own accounting.
    measured.queryParserWork += Math.min(error.failure.value ?? 0, allowance);
    limit.check("search");
  }
  return result;
}
function sequenceMatch(
  entry: PreparedEntry,
  query: PreparedQuery,
  coverage: Int32Array,
  metrics?: SearchMetrics,
  limit?: SearchRequestBudget,
): MatchKind | null {
  const head = entry.components,
    q = query.components;
  if (!head?.cmavo || head.words.length < 2 || !q?.words.length) return null;
  // Component comparisons are request work too: reserve each block's bound
  // before it runs, so an exhausted budget refuses instead of letting the
  // comparisons run past the allowance. The exact path compares at most one
  // word per headword, and the subsequence path at most one word per
  // headword. The scan below compares at most three times the token count
  // across the whole scan: the per-token test, its repeat after a
  // prefix-follow mismatch exits the follow loop, and the follow steps,
  // which total no more than the tests that succeed. Any single token may
  // exceed three (a mismatch, its follow, and the repeated final test can
  // coincide); the sum cannot. Each comparison that runs also checks the
  // remaining
  // allowance first (see `equal`), so a bound that fits exactly still runs
  // nothing past it.
  if (q.cmavo && head.words.length === q.words.length) {
    limit?.reserve(head.words.length, "search");
    if (
      head.words.every((word, index) =>
        equal(word, q.words[index], metrics, limit),
      )
    ) {
      coverage[0]++;
      coverage[q.tokens.length]--;
      return "sequence-exact";
    }
  }
  if (q.tokens.length >= head.words.length) {
    limit?.reserve(3 * q.tokens.length + 1, "search");
    if (
      coverOccurrences(
        q.tokens,
        head.words,
        head.prefix,
        coverage,
        metrics,
        limit,
      )
    )
      return "sequence-contiguous";
  }
  if (q.cmavo && q.words.length <= head.words.length) {
    limit?.reserve(head.words.length, "search");
    let matched = 0;
    for (const word of head.words) {
      if (equal(word, q.words[matched], metrics, limit)) matched++;
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
  rafsi?: string[];
}
/** Match each exact retained spelling under one query budget. */
export function selectRafsiMatches<T extends LexicalEntry>(
  entries: Iterable<T>,
  query: string,
  metrics?: SearchMetrics,
  options: SearchOptions = {},
) {
  // Rafsi searches skip prepareQuery, so a local caller enforces the cap
  // here on the raw input spelling; the server never asks for it. The
  // query charge is reserved before the detector and the matcher below,
  // so a refusal happens with no matcher alive to free.
  if (options.enforceQueryLengthCap && query.length > SEARCH_QUERY_LENGTH_LIMIT)
    throw new SearchQueryTooLongError();
  const measured = metrics ?? searchMetrics();
  const limit = SearchRequestBudget.for(measured, options);
  limit.reserve(contentUnits(0, query.length), "search");
  const pattern =
    options.patterns !== false && isPatternQuery(query)
      ? compilePattern(query)
      : null;
  const rows: LexicalMatch<T>[] = [];
  // The literal comparison key depends only on the query.
  const queryKey = pattern ? null : patternKey(query);
  try {
    for (const entry of entries) {
      // One scanned entry costs one unit, ensured before the entry is
      // measured or counted, plus its content in proportion to the bytes
      // the scan handles, so neither step walks input or pushes the total
      // past the limit on an exhausted budget.
      limit.ensure(1, "search");
      const content = entryContentUnits(entry, limit, "search");
      limit.ensure(1 + content, "search");
      measured.entries++;
      limit.reserve(content, "search");
      const rafsi = (entry.rafsi ?? []).filter((spelling) =>
        pattern ? pattern.test(spelling) : patternKey(spelling) === queryKey,
      );
      if (rafsi.length)
        rows.push({ entry, match: "rafsi-pattern", position: 0, rafsi });
    }
    limit.check("search");
    return { rows, segmentation: "complete" as const };
  } finally {
    pattern?.free();
  }
}
/** One scan. Sequence searches use linear passes and never enumerate subsets. */
export function selectMatches<T extends LexicalEntry>(
  entries: Iterable<T> | SearchIndex<T>,
  query: string | PreparedQuery,
  metrics?: SearchMetrics,
  accept: (entry: T) => boolean = () => true,
  options: SearchOptions = {},
): {
  rows: LexicalMatch<T>[];
  segmentation: SegmentationStatus;
  allLojban: boolean;
} {
  const measured = metrics ?? searchMetrics();
  const limit = SearchRequestBudget.for(measured, options);
  // A grouped query parses before the scan on the same metrics; the shared
  // budget keeps that parser work inside this request.
  limit.check("search");
  const prepared =
    typeof query === "string"
      ? prepareQuery(query, measured, { ...options, requestBudget: limit })
      : query;
  const rows: LexicalMatch<T>[] = [];
  if (prepared.pattern !== undefined) {
    const pattern = compilePattern(prepared.pattern);
    try {
      const source =
        "rows" in entries ? entries.rows.map(({ entry }) => entry) : entries;
      for (const entry of source) {
        // One scanned entry costs one unit, ensured before the entry is
        // measured or counted, plus its content in proportion to the bytes
        // the scan handles, so neither step walks input or pushes the total
        // past the limit on an exhausted budget.
        limit.ensure(1, "search");
        const content = entryContentUnits(entry, limit, "search");
        limit.ensure(1 + content, "search");
        measured.entries++;
        limit.reserve(content, "search");
        if (!accept(entry)) continue;
        const headword = pattern.test(entry.word.spelling);
        // Scan every retained rafsi, even after a match, under the same budget.
        let rafsi = false;
        for (const spelling of options.rafsiFor?.(entry) ?? entry.rafsi ?? [])
          rafsi = pattern.test(spelling) || rafsi;
        if (headword || rafsi)
          rows.push({
            entry,
            match: headword ? "headword-pattern" : "rafsi-pattern",
            position: 0,
          });
      }
      limit.check("search");
      return {
        rows: options.group === "definitions" ? [] : rows,
        segmentation: "complete",
        allLojban: false,
      };
    } finally {
      pattern.free();
    }
  }
  const fallback: { entry: T; key: string }[] = [];
  const coverage = new Int32Array(
    (prepared.components?.tokens.length ?? 0) + 1,
  );
  let segmentation = prepared.segmentation;
  const known = new Set<string>();
  const queryWords = prepared.headword.split(/\s+/u).map(knownSpelling);
  const querySpellings = new Set(queryWords);
  const wholeSpelling = knownSpelling(prepared.headword);
  let wholeKnown = false;
  if (!prepared.text) return { rows, segmentation, allLojban: false };
  const single =
    prepared.components?.words.length === 1 &&
    !prepared.components.tokens.includes(null)
      ? prepared.components.words[0]
      : null;
  const source =
    "rows" in entries
      ? entries.rows
      : Array.isArray(entries)
        ? prepareIndex(entries, measured, {
            ...options,
            requestBudget: limit,
          }).rows
        : (function* () {
            for (const entry of entries as Iterable<T>) {
              // Lazy rows charge their content up front like prepareIndex,
              // and parse with only the remaining allowance. The unit is
              // ensured before measuring, so an exhausted budget builds
              // nothing and walks nothing.
              limit.ensure(1, "prepare");
              limit.reserve(
                1 + entryContentUnits(entry, limit, "prepare"),
                "prepare",
              );
              yield {
                entry,
                indexed: prepareEntry(entry, measured, limit.remaining()),
              };
            }
          })();
  // Query-only transformations run once here, not once per entry.
  const prefix = prepared.headword.replace(/[.,]/gu, "");
  const headwordH = prepared.headword.replaceAll("h", "'");
  for (const { entry, indexed: index } of source) {
    // One scanned entry costs one unit, ensured before the entry is
    // measured or counted, plus its content in proportion to the bytes
    // the scan handles, so neither step walks input or pushes the total
    // past the limit on an exhausted budget.
    limit.ensure(1, "search");
    const content = entryContentUnits(entry, limit, "search");
    limit.ensure(1 + content, "search");
    measured.entries++;
    limit.reserve(content, "search");
    if (!accept(entry)) continue;
    if (!options.knownWord || options.knownWord(entry)) {
      if (index.knownSpelling && querySpellings.has(index.knownSpelling))
        known.add(index.knownSpelling);
      if (wholeSpelling && index.knownSpelling === wholeSpelling)
        wholeKnown = true;
    }
    if (index.limited) segmentation = "limited";
    const sequence = sequenceMatch(index, prepared, coverage, measured, limit);
    const candidates: MatchKind[] = [];
    if (
      (prepared.headword && index.spelling === prepared.headword) ||
      (single && index.canonical === single)
    )
      candidates.push("headword");
    if (index.glosses.includes(prepared.text)) candidates.push("gloss");
    if (sequence) candidates.push(sequence);
    // A complete component relation keeps its subsequence class even at the start.
    if (
      sequence !== "sequence-subsequence" &&
      ((prepared.headword && index.spelling.startsWith(prepared.headword)) ||
        (prefix && index.spelling.replace(/[.,]/gu, "").startsWith(prefix)))
    )
      candidates.push("headword-prefix");
    if (index.glosses.some((gloss) => gloss.startsWith(prepared.text)))
      candidates.push("gloss-prefix");
    if (index.text.includes(prepared.text)) candidates.push("token");
    if (
      options.group === "lojban" &&
      (options.rafsiFor?.(entry) ?? entry.rafsi ?? []).some(
        (rafsi: string) =>
          headwordKey(rafsi).replaceAll("h", "'") === headwordH,
      )
    )
      candidates.push("rafsi-pattern");
    if (options.group) {
      for (let index = candidates.length - 1; index >= 0; index--)
        if (matchGroup(candidates[index]) !== options.group)
          candidates.splice(index, 1);
    }
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
  // The definitions group never adds component fallback rows, so it needs
  // no hit set; other groups deduplicate fallback rows against it.
  const matchedEntries =
    options.group === "definitions"
      ? new Set<T>()
      : new Set(rows.map((row) => row.entry));
  for (const { entry, key } of fallback) {
    const position = positions.get(key);
    if (
      options.group !== "definitions" &&
      position !== undefined &&
      !matchedEntries.has(entry)
    )
      rows.push({ entry, match: "component", position });
  }
  limit.check("search");
  return {
    rows,
    segmentation,
    allLojban:
      wholeKnown ||
      !!(
        queryWords.length <= SEARCH_QUERY_WORD_LIMIT &&
        queryWords.every((word) => known.has(word))
      ),
  };
}
/** A single-entry lookup, with the same normalization and sequence classes. */
export function matchKind(
  entry: LexicalEntry,
  query: string,
): MatchKind | null {
  return selectMatches([entry], query).rows[0]?.match ?? null;
}
