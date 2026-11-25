import { packageStorageKey } from "./store.ts";
import { PackageValidationError } from "./saved-package.ts";
export { PackageValidationError };
import {
  invalidPackage,
  isV2,
  PackageStorageError,
  type CachedPackage,
  type LocalHit,
} from "./search.ts";
import type { PackageEntry } from "../model/types.ts";
import {
  entryContentUnits,
  isPatternQuery,
  PatternError,
  searchMetrics,
  SearchBudgetError,
  SearchQueryTooLongError,
  SearchRequestBudget,
  SEARCH_QUERY_LENGTH_LIMIT,
  isSearchBudgetState,
  type SearchBudgetState,
} from "../../../../packages/search/src/index.ts";
import {
  PATTERN_TIMEOUT_MESSAGE,
  PATTERN_WORKER_TIMEOUT_MS,
} from "../../../../packages/search/src/pattern.ts";
/** Saved-package validation and lexical work run in one static module worker. */
import type {
  SegmentationStatus,
  SearchMetrics,
} from "../../../../packages/search/src/index.ts";
export interface PackageSearchResult {
  hits: LocalHit[][];
  totals: number[];
  segmentation: SegmentationStatus;
  metrics: SearchMetrics;
  prepared: boolean;
  allLojban: boolean;
}
export interface PackageSearchOptions {
  offset?: number;
  limit?: number;
  /**
   * Rank all query lists together before selecting the nearby page. Each
   * query is a word as the reader typed it; the worker lowercases it.
   */
  nearby?: boolean;
  /** Return independent Lojban and definition pages for one query. */
  grouped?: boolean;
  includeRetired?: boolean;
  view?: string | null;
  group?: import("../../../../packages/search/src/index.ts").SearchGroup;
  /** Meaning retrieval and claim previews always use literal text. */
  patterns?: boolean;
  /** Match retained rafsi spellings instead of headwords. */
  rafsiOnly?: boolean;
  /**
   * Per-request literal-search work budget in work units. Defaults to
   * SEARCH_LOCAL_WORK_LIMIT, which completes an ordinary query on a package
   * five times the base data with wide headroom.
   */
  workLimit?: number;
  /** Per-request literal-search and preparation deadline in milliseconds. */
  deadlineMs?: number;
  signal?: AbortSignal;
}
/** References belong to the exact immutable package captured by the request. */
export interface PackageHitReferences {
  word_id: string;
  match: LocalHit["match"];
  entries: number[];
  definitions: number[];
  preview: number;
  rafsi?: string[];
}
class MissingPackageError extends Error {}
/**
 * Maps a worker reply to its rejection. A worker that reports `package-too-large`
 * ran out of room while the package was validated, prepared, or indexed, so
 * the request fails with the documented does-not-fit message. A worker that
 * reports `resource-limit` hit the request budget or deadline: the rejection
 * keeps the resource-failure type instead of the invalid-package message so
 * the page does not drop its local package.
 */
export function workerReplyError(
  code: unknown,
  message: unknown,
  phase?: unknown,
): Error {
  const text = typeof message === "string" ? message : String(message);
  // An invalid package always shows the documented message, never the text
  // of the exception that the worker caught while it checked the package.
  if (code === "invalid-package") return new PackageValidationError();
  if (code === "package-missing") return new MissingPackageError(text);
  if (code === "package-too-large") return new PackageStorageError(text);
  if (code === "resource-limit")
    return new SearchBudgetError(
      phase === "prepare" ? "prepare" : "search",
      text,
    );
  if (code === "pattern_timeout" || code === "pattern_invalid")
    return new PatternError(code, text);
  if (code === "query-too-long") return new SearchQueryTooLongError(text);
  return new Error(text);
}
/**
 * Whether an error is an allocation failure in either engine's wording:
 * V8 reports "Array buffer allocation failed" and both engines report out
 * of memory as RangeErrors. A name alone does not identify the cause: an
 * out-of-bounds access is also a RangeError. An "invalid array length" alone
 * proves nothing about memory: `new Array(-1)` reports it without allocating
 * anything, and a length past the engine maximum reports it on any device,
 * so freeing storage cannot repair either. Engine string-capacity failures
 * ("Invalid string length", the Firefox repeat-count overflow message) are
 * likewise ambiguous between an engine maximum and exhausted memory, so they
 * keep the generic message too.
 */
const ALLOCATION_FAILURE_MESSAGE =
  /array buffer allocation failed|out of memory/i;
export function isAllocationFailure(error: unknown): boolean {
  return (
    error instanceof RangeError &&
    ALLOCATION_FAILURE_MESSAGE.test(error.message)
  );
}
/**
 * Evidence for classifying a worker crash. A worker that runs out of room
 * reports an allocation failure through its error event. Chromium delivers an
 * `ErrorEvent` with e.g. "Uncaught RangeError: Array buffer allocation
 * failed"; Firefox delivers an `ErrorEvent` with the bare "RangeError: ..."
 * form and a null error object. A script that never loads reports a syntax
 * error instead. The message decides whether a RangeError is an allocation
 * failure: a name alone does not, since an out-of-bounds access is also a
 * RangeError.
 */
export interface WorkerCrashEvidence {
  /** Parsed error name, e.g. "RangeError", "Error", or "SyntaxError". */
  errorName?: string;
  /** The error message, kept so allocation failures stay distinguishable. */
  message?: string;
}
/**
 * Classifies a worker crash by its own cause. Only an allocation failure
 * reports does-not-fit. Every other crash — an ordinary error, a load
 * failure, a non-allocation RangeError, or a crash with no error
 * information — keeps the generic startup message, no matter what the
 * worker reported before.
 */
export function workerCrashReason(evidence: WorkerCrashEvidence): Error {
  if (/^QuotaExceededError$/i.test(evidence.errorName ?? ""))
    return new PackageStorageError();
  // A RangeError is an allocation failure only when its message is one in
  // either engine: an out-of-bounds access is also a RangeError.
  if (
    /^RangeError$/i.test(evidence.errorName ?? "") &&
    ALLOCATION_FAILURE_MESSAGE.test(evidence.message ?? "")
  )
    return new PackageStorageError();
  return new Error("Local search could not start. Reload the page to retry.");
}
/**
 * Reads the error name from a worker error event: the error object when the
 * browser supplies one, else the `NAME:` message prefix. Chromium prefixes
 * the message with `Uncaught` while Firefox reports the bare `NAME:` form
 * with a null error object.
 */
export function workerErrorName(event: unknown): string | undefined {
  if (event instanceof Error) return event.name;
  const anyEvent = event as {
    error?: unknown;
    message?: unknown;
  } | null;
  if (anyEvent?.error instanceof Error) return anyEvent.error.name;
  const message = typeof anyEvent?.message === "string" ? anyEvent.message : "";
  return /^(?:Uncaught )?([A-Za-z]*Error):/.exec(message)?.[1];
}
/**
 * Reads the error message from a worker error event for the crash
 * classifier: the error object's message when the browser supplies one,
 * else the event's own message. Allocation failures in either engine carry
 * their wording here.
 */
export function workerErrorMessage(event: unknown): string | undefined {
  if (event instanceof Error) return event.message;
  const anyEvent = event as {
    error?: unknown;
    message?: unknown;
  } | null;
  if (anyEvent?.error instanceof Error) return anyEvent.error.message;
  return typeof anyEvent?.message === "string" ? anyEvent.message : undefined;
}
interface Client {
  worker: Worker;
  canceledPatterns: Set<number>;
  retained: Set<number>;
  cacheRevision: number;
  preparing: Map<number, number>;
  /**
   * In-flight transfer counts by package key. A key with no count has no
   * pending transfer, so reuse is decided by lookup instead of copying
   * every pending key.
   */
  preparingKeys: Map<number, number>;
  /**
   * Validated or preparing package snapshots paired with their worker key.
   * Pruned to keys that the worker still retains or is preparing.
   */
  snapshots: Map<
    number,
    { pkg: CachedPackage; language: string; storageHint?: string }
  >;
  /** Fresh clones already verified equal to a retained snapshot. */
  aliases: WeakMap<CachedPackage, { key: number; language: string }>;
  pending: Map<
    number,
    {
      resolve: (
        value: Omit<PackageSearchResult, "hits"> & {
          hits: PackageHitReferences[][];
        },
      ) => void;
      reject: (error: Error) => void;
      started: () => void;
    }
  >;
}
let latest: Pick<PackageSearchResult, "metrics" | "prepared"> | undefined;
export const packageSearchStats = () =>
  latest ? { metrics: latest.metrics, prepared: latest.prepared } : null;
let client: Client | undefined;
let requestId = 0,
  packageId = 0;

function sameStructuredValue(
  incoming: unknown,
  trusted: unknown,
  budget: SearchRequestBudget,
): boolean {
  if (typeof incoming === "string" && typeof trusted === "string") {
    if (incoming.length !== trusted.length) return false;
    if (incoming.length > 64)
      budget.reserve(Math.ceil(incoming.length / 64), "prepare");
    return incoming === trusted;
  }
  if (Object.is(incoming, trusted)) return true;
  if (
    !incoming ||
    !trusted ||
    typeof incoming !== "object" ||
    typeof trusted !== "object"
  )
    return false;
  const isArray = Array.isArray(trusted);
  if (Array.isArray(incoming) !== isArray) return false;
  if (isArray) {
    const left = incoming as unknown[];
    const right = trusted as unknown[];
    if (left.length !== right.length) return false;
    const keysA = Reflect.ownKeys(left);
    const keysB = Reflect.ownKeys(right);
    if (keysA.length !== keysB.length) return false;
    if (keysB.length > 0) budget.reserve(keysB.length, "prepare");
    const leftRecord = left as unknown as Record<PropertyKey, unknown>;
    const rightRecord = right as unknown as Record<PropertyKey, unknown>;
    for (let i = 0; i < keysB.length; i++) {
      const key = keysB[i];
      if (key === "length") continue;
      if (keysA[i] !== key && !Object.hasOwn(left, key)) return false;
      if (!sameStructuredValue(leftRecord[key], rightRecord[key], budget))
        return false;
    }
    return true;
  }
  const protoA = Object.getPrototypeOf(incoming);
  const protoB = Object.getPrototypeOf(trusted);
  const plainA = protoA === Object.prototype || protoA === null;
  const plainB = protoB === Object.prototype || protoB === null;
  if (plainA !== plainB) return false;
  if (!plainA && protoA !== protoB) return false;
  const keysA = Reflect.ownKeys(incoming);
  const keysB = Reflect.ownKeys(trusted);
  if (keysA.length !== keysB.length) return false;
  if (keysB.length > 0) budget.reserve(keysB.length, "prepare");
  const left = incoming as Record<PropertyKey, unknown>;
  const right = trusted as Record<PropertyKey, unknown>;
  for (let i = 0; i < keysB.length; i++) {
    const key = keysB[i];
    if (keysA[i] !== key && !Object.hasOwn(incoming, key)) return false;
    if (!sameStructuredValue(left[key], right[key], budget)) return false;
  }
  return true;
}

/**
 * Exact structural equality between a freshly read package clone and a
 * trusted validated snapshot, charged to the request budget. Checks row
 * order, actual own array keys, holes, and all worker fields.
 */
export function samePackageStructure(
  incoming: unknown,
  trusted: CachedPackage,
  budget: SearchRequestBudget,
): boolean {
  if (incoming === trusted) return true;
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming))
    return false;
  return sameStructuredValue(incoming, trusted, budget);
}

function pruneSnapshots(current: Client): void {
  for (const key of current.snapshots.keys())
    if (!current.retained.has(key) && !current.preparingKeys.has(key))
      current.snapshots.delete(key);
}

function stopWorker(current: Client, error: Error) {
  current.worker.terminate();
  current.retained.clear();
  current.preparing.clear();
  current.preparingKeys.clear();
  current.snapshots.clear();
  for (const waiting of current.pending.values()) waiting.reject(error);
  current.pending.clear();
  if (client === current) {
    client = undefined;
  }
}
/**
 * Drops one request's transfer announcement, keeping the per-key count for
 * any other request still transferring the same package. A request that
 * never announced (it reused a warm package) changes nothing.
 */
function forgetPreparing(current: Client, request: number): void {
  const key = current.preparing.get(request);
  if (key === undefined) return;
  current.preparing.delete(request);
  const left = (current.preparingKeys.get(key) ?? 1) - 1;
  if (left <= 0) current.preparingKeys.delete(key);
  else current.preparingKeys.set(key, left);
  pruneSnapshots(current);
}
function searchWorker(): Client {
  if (client) return client;
  const worker = new Worker(
    new URL("./package-search-worker.ts", import.meta.url),
    { type: "module" },
  );
  const current: Client = {
    worker,
    pending: new Map(),
    canceledPatterns: new Set(),
    retained: new Set(),
    cacheRevision: -1,
    preparing: new Map(),
    preparingKeys: new Map(),
    snapshots: new Map(),
    aliases: new WeakMap(),
  };
  worker.onmessage = ({ data }) => {
    // Cache acknowledgments also matter after that request's consumer aborts.
    const stale =
      Number.isSafeInteger(data.cacheRevision) &&
      data.cacheRevision < current.cacheRevision;
    if (
      Array.isArray(data.retained) &&
      Number.isSafeInteger(data.cacheRevision) &&
      !stale
    ) {
      current.retained.clear();
      for (const key of data.retained)
        if (typeof key === "number") current.retained.add(key);
      current.cacheRevision = data.cacheRevision;
      pruneSnapshots(current);
    }
    if (!data.started) forgetPreparing(current, data.request);
    const waiting = current.pending.get(data.request);
    if (!waiting) {
      if (data.started && !stale && current.canceledPatterns.has(data.request))
        stopWorker(
          current,
          new DOMException("Search was canceled.", "AbortError"),
        );
      if (!data.started || stale) current.canceledPatterns.delete(data.request);
      return;
    }
    if (data.started) {
      if (!stale) waiting.started();
      return;
    }
    current.pending.delete(data.request);
    if (data.error) {
      waiting.reject(workerReplyError(data.code, data.error, data.phase));
    } else {
      latest = { metrics: data.result.metrics, prepared: data.result.prepared };
      waiting.resolve(data.result);
    }
  };
  worker.onerror = (event) => {
    stopWorker(
      current,
      workerCrashReason({
        errorName: workerErrorName(event),
        message: workerErrorMessage(event),
      }),
    );
  };
  client = current;
  return current;
}
/** A package object comes from a fresh storage read or an acquired snapshot. */
export async function searchPackage(
  pkg: CachedPackage,
  language: string,
  queries: string[],
  options: PackageSearchOptions = {},
): Promise<PackageSearchResult> {
  options.signal?.throwIfAborted();
  if (
    !pkg ||
    typeof pkg !== "object" ||
    Array.isArray(pkg) ||
    !Array.isArray((pkg as { entries?: unknown }).entries)
  )
    throw new PackageValidationError(invalidPackage().message);
  // The strings are captured once, so the length check and every send,
  // including a retry, read the same accepted strings.
  const accepted = Array.from(queries);
  // The local length limit applies before any detector, transfer or group
  // choice reads a query. A longer query never leaves the client.
  const tooLong = accepted.some(
    (text) => text.length > SEARCH_QUERY_LENGTH_LIMIT,
  );
  // An over-long query is refused only once the package is known to be
  // usable: the worker validates and prepares the package with no query, so
  // an unusable package still reports its own error and the page keeps its
  // fallback.
  const texts = tooLong ? [] : accepted;
  const { signal, ...workerOptions } = options;
  // One client budget spans equality checks, transfer, and the worker request
  // below: the worker continues it from the posted state and the reply
  // continues it back.
  const clientBudget = SearchRequestBudget.for(searchMetrics(), {
    workLimit: options.workLimit,
    deadlineMs: options.deadlineMs,
  });
  const storageHint = packageStorageKey(pkg);
  let matchedKey: number | undefined;
  let resolvedPkg: CachedPackage = pkg;
  if (client) {
    // Same acquired snapshot used again in the same language.
    for (const [candidateKey, entry] of client.snapshots) {
      if (
        entry.pkg === pkg &&
        entry.language === language &&
        (client.retained.has(candidateKey) ||
          client.preparingKeys.has(candidateKey))
      ) {
        matchedKey = candidateKey;
        break;
      }
    }
    // Fresh clone already verified structurally equal to a retained snapshot.
    if (matchedKey === undefined) {
      const alias = client.aliases.get(pkg);
      if (
        alias &&
        alias.language === language &&
        (client.retained.has(alias.key) || client.preparingKeys.has(alias.key))
      ) {
        const trusted = client.snapshots.get(alias.key);
        if (trusted) {
          matchedKey = alias.key;
          resolvedPkg = trusted.pkg;
        }
      }
    }
    // Fresh clone with the same durable storage revision: reuse only after
    // exact structural equality against the validated snapshot.
    if (matchedKey === undefined && storageHint !== undefined) {
      for (const [candidateKey, entry] of client.snapshots) {
        if (
          entry.language === language &&
          entry.storageHint === storageHint &&
          client.retained.has(candidateKey) &&
          samePackageStructure(pkg, entry.pkg, clientBudget)
        ) {
          matchedKey = candidateKey;
          resolvedPkg = entry.pkg;
          client.aliases.set(pkg, { key: candidateKey, language });
          break;
        }
      }
    }
  }
  const key = matchedKey ?? ++packageId;
  const send = (force = false) => {
    signal?.throwIfAborted();
    const current = searchWorker();
    const prepare =
      force ||
      !(current.retained.has(key) || current.preparingKeys.has(key));
    const request = ++requestId;
    // Announce a transfer without evicting any confirmed warm package.
    if (prepare) {
      current.snapshots.set(key, {
        pkg: resolvedPkg,
        language,
        storageHint,
      });
      current.preparing.set(request, key);
      current.preparingKeys.set(
        key,
        (current.preparingKeys.get(key) ?? 0) + 1,
      );
    }
    return new Promise<
      Omit<PackageSearchResult, "hits"> & {
        hits: PackageHitReferences[][];
        budget?: SearchBudgetState;
      }
    >((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let started = false;
      const pattern =
        options.patterns !== false &&
        !options.nearby &&
        texts.some(isPatternQuery);
      const clean = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      const abort = () => {
        const error = new DOMException("Search was canceled.", "AbortError");
        if (pattern && started) {
          stopWorker(current, error);
          return;
        }
        current.pending.delete(request);
        clean();
        if (pattern) current.canceledPatterns.add(request);
        current.worker.postMessage({ cancel: request });
        reject(error);
      };
      current.pending.set(request, {
        resolve(value) {
          clean();
          resolve(value);
        },
        reject(error) {
          clean();
          reject(error);
        },
        started() {
          started = true;
          clearTimeout(timer);
          if (pattern)
            timer = setTimeout(
              () =>
                stopWorker(
                  current,
                  new PatternError("pattern_timeout", PATTERN_TIMEOUT_MESSAGE),
                ),
              PATTERN_WORKER_TIMEOUT_MS,
            );
        },
      });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        // Transferring the package clones every entry onto the worker, so
        // the transfer charges one unit per entry plus its content before
        // the package is posted. Each entry is charged before the next one
        // is measured, so an exhausted budget stops before walking the
        // remaining package; the per-entry measurement itself checks the
        // allowance inside large date maps.
        if (prepare) {
          for (const entry of resolvedPkg.entries) {
            clientBudget.ensure(1, "prepare");
            clientBudget.reserve(
              1 + entryContentUnits(entry, clientBudget, "prepare"),
              "prepare",
            );
          }
        }
        current.worker.postMessage({
          request,
          key,
          language,
          queries: texts,
          options: workerOptions,
          ...(prepare ? { pkg: resolvedPkg } : {}),
          budget: clientBudget.snapshot(),
        });
      } catch (error) {
        clean();
        current.pending.delete(request);
        forgetPreparing(current, request);
        // An allocation failure while the package is posted reports that the
        // package does not fit. Other clone or programming errors keep their
        // own rejection.
        reject(
          isAllocationFailure(error) ? new PackageStorageError() : error,
        );
      }
    });
  };
  let result;
  try {
    result = await send();
  } catch (error) {
    if (!(error instanceof MissingPackageError)) throw error;
    // An evicted or canceled queued preparation can require one captured retry.
    result = await send(true);
  }
  if (tooLong) throw new SearchQueryTooLongError();
  const continued = isSearchBudgetState(result.budget)
    ? SearchRequestBudget.resume(result.budget)
    : SearchRequestBudget.for(searchMetrics(), {
        workLimit: options.workLimit,
        deadlineMs: options.deadlineMs,
      });
  // The resumed budget permits completion before any result is returned,
  // including an empty one: the deadline spans the worker reply delivery.
  continued.check("search");
  return {
    ...result,
    hits: resolvePackageHits(resolvedPkg, result.hits, continued),
  };
}
/**
 * Rebuilds full hits from the worker's entry references into the captured
 * package. One unit per mapped hit, entry, definition, and preview, charged
 * before the mapping runs, on the budget the worker reply continues.
 */
export function resolvePackageHits(
  pkg: CachedPackage,
  pages: PackageHitReferences[][],
  budget: SearchRequestBudget,
): LocalHit[][] {
  return pages.map((rows) =>
    rows.map((hit) => {
      budget.reserve(1, "search");
      const selected = pkg.entries[hit.preview];
      const entries = hit.entries.map((index) => {
        budget.reserve(1, "search");
        return pkg.entries[index];
      });
      const definitions = hit.definitions.map((index) => {
        budget.reserve(1, "search");
        return pkg.entries[index].event;
      });
      budget.reserve(1, "search");
      return {
        word_id: hit.word_id,
        match: hit.match,
        word: selected.word,
        entries,
        definitions,
        preview: {
          event: selected.event,
          word_kind: selected.classification.kind,
          // A code point uses at most two UTF-16 units. Read only the preview.
          plain_text: Array.from(selected.plain_text.slice(0, 480))
            .slice(0, 240)
            .join(""),
          status: "unavailable",
        },
        ...(hit.rafsi ? { matchingRafsi: hit.rafsi } : {}),
      };
    }),
  );
}

/**
 * Per-hit content bound for page work after the response. The request cap
 * bounds hits, not the entries inside each hit: one word can carry entries
 * for the whole package. Pages stop their per-hit loops here, so their work
 * stays bounded by what they render. Real words keep far fewer entries, so
 * ordinary displays are unchanged.
 */
export const HIT_CONTENT_LIMIT = 1000;
/**
 * The entries of one hit that a page may read. Longer lists keep their
 * first HIT_CONTENT_LIMIT entries; the request already ordered the strongest
 * match first.
 */
export function cappedHitEntries(
  hit: Pick<LocalHit, "entries">,
): readonly PackageEntry[] {
  return hit.entries.length > HIT_CONTENT_LIMIT
    ? hit.entries.slice(0, HIT_CONTENT_LIMIT)
    : hit.entries;
}
/**
 * One definition summary per entry, in entry order. The lujvo Add action
 * builds from the whole hit, never from a silently truncated list.
 */
export function summarizeHitEntries(
  entries: readonly PackageEntry[],
): { event: string; summary: string }[] {
  return entries.map((entry) => ({
    event: entry.event,
    summary:
      // filter drops empty array slots, which the worker's checks skip.
      entry.glosses
        .filter(() => true)
        .map((gloss) => gloss.text)
        .join(", ") ||
      // The first 60 code points occupy at most 120 UTF-16 units, so reading
      // that prefix first is exact and keeps a long entry from stalling the
      // page.
      Array.from(entry.plain_text.slice(0, 120)).slice(0, 60).join(""),
  }));
}
/**
 * Every distinct retained rafsi across entries, in first-occurrence order.
 * The lujvo claims use the whole hit, so no spelling is silently dropped.
 */
export function distinctHitRafsi(entries: readonly PackageEntry[]): string[] {
  return [
    ...new Set(entries.flatMap((entry) => (isV2(entry) ? entry.rafsi : []))),
  ];
}
/**
 * A hit's own entry for a result row. Local grouping keeps the preview
 * entry first, so the page reads it in O(1) instead of scanning every entry
 * of the hit. Anything else reports no entry, the same as a missed scan.
 */
export function previewEntryForHit(
  hit: Pick<LocalHit, "entries">,
  eventId: string,
): PackageEntry | undefined {
  const first = hit.entries?.[0];
  return first?.event === eventId ? first : undefined;
}
/**
 * Rows the rafsi page collects from result hits, at most `limit` in visit
 * order, deduplicated across calls through `found`. A later language's row
 * replaces an existing word-and-rafsi key, as on main — even after the cap
 * fills, since replacing adds no row. A novel spelling past the limit is
 * skipped but the scan continues, so later duplicates still replace their
 * rows exactly as the uncapped accumulation does. Returns true when a novel
 * spelling was left out, so the page marks its list limited exactly then.
 */
export function takeRafsiRows(
  hits: readonly Pick<LocalHit, "word_id" | "word" | "matchingRafsi">[],
  language: string,
  found: Map<string, { spelling: string; language: string; rafsi: string }>,
  limit: number,
): boolean {
  let limited = false;
  for (const hit of hits) {
    for (const spelling of hit.matchingRafsi ?? []) {
      const key = `${hit.word_id}|${spelling}`;
      // A repeat key takes the later language's row without counting
      // toward the cap, exactly as the uncapped accumulation does.
      if (found.has(key)) {
        found.set(key, {
          spelling: hit.word.spelling,
          language,
          rafsi: spelling,
        });
        continue;
      }
      if (found.size >= limit) {
        limited = true;
        continue;
      }
      found.set(key, { spelling: hit.word.spelling, language, rafsi: spelling });
    }
  }
  return limited;
}
