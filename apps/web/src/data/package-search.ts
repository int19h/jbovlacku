import { packageStorageKey } from "./store.ts";
import {
  isPatternQuery,
  PatternError,
} from "../../../../packages/search/src/index.ts";
import {
  PATTERN_TIMEOUT_MESSAGE,
  PATTERN_WORKER_TIMEOUT_MS,
} from "../../../../packages/search/src/pattern.ts";
/** Saved-package validation and lexical work run in one static module worker. */
import type { CachedPackage, LocalHit } from "./search.ts";
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
}
export interface PackageSearchOptions {
  offset?: number;
  limit?: number;
  /** Rank all query lists together before selecting the nearby page. */
  nearby?: boolean;
  /** Meaning retrieval and claim previews always use literal text. */
  patterns?: boolean;
  /** Match retained rafsi spellings instead of headwords. */
  rafsiOnly?: boolean;
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
      waiting.reject(
        data.code === "invalid-package"
          ? new PackageValidationError(data.error)
          : data.code === "package-missing"
            ? new MissingPackageError(data.error)
            : data.code === "pattern_timeout" || data.code === "pattern_invalid"
              ? new PatternError(data.code, data.error)
              : new Error(data.error),
      );
    } else {
      latest = { metrics: data.result.metrics, prepared: data.result.prepared };
      waiting.resolve(data.result);
    }
  };
  worker.onerror = () => {
    stopWorker(
      current,
      new Error("Local search could not start. Reload the page to retry."),
    );
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
    throw new PackageValidationError(
      "The search package is invalid or exceeds the browser limit. Search this server or download another package.",
    );
  const { signal, ...workerOptions } = options;
  let identity: string | number | undefined =
    packageStorageKey(pkg) ?? packageIds.get(pkg);
  if (identity === undefined) {
    identity = ++packageId;
    packageIds.set(pkg, identity);
  }
  const key = JSON.stringify([language, identity]);
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
      Omit<PackageSearchResult, "hits"> & { hits: PackageHitReferences[][] }
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
        current.worker.postMessage({
          request,
          key,
          language,
          queries,
          options: workerOptions,
          ...(prepare ? { pkg } : {}),
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
  return {
    ...result,
    hits: result.hits.map((rows) =>
      rows.map((hit) => {
        const selected = pkg.entries[hit.preview];
        return {
          word_id: hit.word_id,
          match: hit.match,
          word: selected.word,
          entries: hit.entries.map((index) => pkg.entries[index]),
          definitions: hit.definitions.map((index) => pkg.entries[index].event),
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
    ),
  };
}
