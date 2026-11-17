import { packageStorageKey } from "./store.ts";
import {
  invalidPackage,
  PackageStorageError,
  type CachedPackage,
  type LocalHit,
} from "./search.ts";
import type { PackageEntry } from "../model/types.ts";
import {
  isPatternQuery,
  PatternError,
  searchMetrics,
  SearchRequestBudget,
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
  /** Rank all query lists together before selecting the nearby page. */
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
export class PackageValidationError extends Error {}
class MissingPackageError extends Error {}
/**
 * Maps a worker reply to its rejection. A worker that reports `package-too-large`
 * ran out of room while the package was validated, prepared, or indexed, so
 * the request fails with the documented does-not-fit message.
 */
export function workerReplyError(code: unknown, message: unknown): Error {
  const text = typeof message === "string" ? message : String(message);
  if (code === "invalid-package") return new PackageValidationError(text);
  if (code === "package-missing") return new MissingPackageError(text);
  if (code === "package-too-large") return new PackageStorageError(text);
  if (code === "pattern_timeout" || code === "pattern_invalid")
    return new PatternError(code, text);
  return new Error(text);
}
/**
 * Evidence for classifying a worker crash. A worker that runs out of room
 * reports an allocation failure through its error event. Chromium delivers an
 * `ErrorEvent` with e.g. "Uncaught RangeError: Array buffer allocation
 * failed"; Firefox delivers an `ErrorEvent` with the bare "RangeError: ..."
 * form and a null error object. A script that never loads reports a syntax
 * error instead.
 */
export interface WorkerCrashEvidence {
  /** Parsed error name, e.g. "RangeError", "Error", or "SyntaxError". */
  errorName?: string;
}
/**
 * Classifies a worker crash by its own cause. Only an allocation failure
 * reports does-not-fit. Every other crash — an ordinary error, a load
 * failure, or a crash with no error information — keeps the generic startup
 * message, no matter what the worker reported before.
 */
export function workerCrashReason(evidence: WorkerCrashEvidence): Error {
  if (/^(RangeError|QuotaExceededError)$/i.test(evidence.errorName ?? ""))
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
interface Client {
  worker: Worker;
  canceledPatterns: Set<number>;
  retained: Set<string | number>;
  cacheRevision: number;
  preparing: Map<number, string | number>;
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
const packageIds = new WeakMap<CachedPackage, number>();
function stopWorker(current: Client, error: Error) {
  current.worker.terminate();
  current.retained.clear();
  current.preparing.clear();
  for (const waiting of current.pending.values()) waiting.reject(error);
  current.pending.clear();
  if (client === current) {
    client = undefined;
  }
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
      for (const key of data.retained) current.retained.add(key);
      current.cacheRevision = data.cacheRevision;
    }
    if (!data.started) current.preparing.delete(data.request);
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
      waiting.reject(workerReplyError(data.code, data.error));
    } else {
      latest = { metrics: data.result.metrics, prepared: data.result.prepared };
      waiting.resolve(data.result);
    }
  };
  worker.onerror = (event) => {
    stopWorker(current, workerCrashReason({ errorName: workerErrorName(event) }));
  };
  client = current;
  return current;
}
/** A package object comes from the store's revision-aware, bounded cache. */
export async function searchPackage(
  pkg: CachedPackage,
  language: string,
  queries: string[],
  options: PackageSearchOptions = {},
): Promise<PackageSearchResult> {
  options.signal?.throwIfAborted();
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg))
    throw new PackageValidationError(invalidPackage().message);
  const { signal, ...workerOptions } = options;
  let identity: string | number | undefined =
    packageStorageKey(pkg) ?? packageIds.get(pkg);
  if (identity === undefined) {
    identity = ++packageId;
    packageIds.set(pkg, identity);
  }
  const key = JSON.stringify([language, identity]);
  // One client budget spans the transfer and the worker request below: the
  // worker continues it from the posted state and the reply continues it back.
  const clientBudget = SearchRequestBudget.for(searchMetrics(), {
    workLimit: options.workLimit,
    deadlineMs: options.deadlineMs,
  });
  const send = (force = false) => {
    signal?.throwIfAborted();
    const current = searchWorker();
    const prepare =
      force ||
      !(
        current.retained.has(key) ||
        [...current.preparing.values()].includes(key)
      );
    const request = ++requestId;
    // Announce a transfer without evicting any confirmed warm package.
    if (prepare) current.preparing.set(request, key);
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
        queries.some(isPatternQuery);
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
        // Transferring the package clones every entry onto the worker, so the
        // transfer charges one unit per entry before it is posted.
        if (prepare) clientBudget.reserve(pkg.entries.length, "prepare");
        current.worker.postMessage({
          request,
          key,
          language,
          queries,
          options: workerOptions,
          ...(prepare ? { pkg } : {}),
          budget: clientBudget.snapshot(),
        });
      } catch (error) {
        clean();
        current.pending.delete(request);
        current.preparing.delete(request);
        reject(error);
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
  const continued = isSearchBudgetState(result.budget)
    ? SearchRequestBudget.resume(result.budget)
    : SearchRequestBudget.for(searchMetrics(), {
        workLimit: options.workLimit,
        deadlineMs: options.deadlineMs,
      });
  return {
    ...result,
    hits: resolvePackageHits(pkg, result.hits, continued),
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
 * order, deduplicated across calls through `found`. Returns true when a
 * further spelling exists past the limit, so the caller stops the whole
 * accumulation instead of visiting every remaining spelling through a
 * continue. Hits stay bounded by the request limit and rows by the display
 * limit, so the page's work is bounded by what it renders.
 */
export function takeRafsiRows(
  hits: readonly Pick<LocalHit, "word_id" | "word" | "matchingRafsi">[],
  language: string,
  found: Map<string, { spelling: string; language: string; rafsi: string }>,
  limit: number,
): boolean {
  for (const hit of hits) {
    for (const spelling of hit.matchingRafsi ?? []) {
      const key = `${hit.word_id}|${spelling}`;
      if (found.has(key)) continue;
      if (found.size >= limit) return true;
      found.set(key, { spelling: hit.word.spelling, language, rafsi: spelling });
    }
  }
  return false;
}
