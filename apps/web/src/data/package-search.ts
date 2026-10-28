import { packageStorageKey } from "./store.ts";
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
}
/** References belong to the exact immutable package captured by the request. */
export interface PackageHitReferences {
  word_id: string;
  match: LocalHit["match"];
  entries: number[];
  definitions: number[];
  preview: number;
}
export class PackageValidationError extends Error {}
class MissingPackageError extends Error {}
interface Client {
  worker: Worker;
  pending: Map<
    number,
    {
      resolve: (
        value: Omit<PackageSearchResult, "hits"> & {
          hits: PackageHitReferences[][];
        },
      ) => void;
      reject: (error: Error) => void;
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
const retained: (string | number)[] = [];
function searchWorker(): Client {
  if (client) return client;
  const worker = new Worker(
    new URL("./package-search-worker.ts", import.meta.url),
    { type: "module" },
  );
  const current: Client = { worker, pending: new Map() };
  worker.onmessage = ({ data }) => {
    const waiting = current.pending.get(data.request);
    if (!waiting) return;
    current.pending.delete(data.request);
    if (data.error) {
      const index = retained.indexOf(data.key);
      if (index >= 0) retained.splice(index, 1);
      waiting.reject(
        data.code === "invalid-package"
          ? new PackageValidationError(data.error)
          : data.code === "package-missing"
            ? new MissingPackageError(data.error)
            : new Error(data.error),
      );
    } else {
      latest = { metrics: data.result.metrics, prepared: data.result.prepared };
      waiting.resolve(data.result);
    }
  };
  worker.onerror = () => {
    for (const waiting of current.pending.values())
      waiting.reject(
        new Error("Local search could not start. Reload the page to retry."),
      );
    current.pending.clear();
    worker.terminate();
    retained.length = 0;
    if (client === current) client = undefined;
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
  const current = searchWorker();
  let identity: string | number | undefined =
    packageStorageKey(pkg) ?? packageIds.get(pkg);
  if (identity === undefined) {
    identity = ++packageId;
    packageIds.set(pkg, identity);
  }
  const key = JSON.stringify([language, identity]);
  const send = (force = false) => {
    const prepare = force || !retained.includes(key);
    const index = retained.indexOf(key);
    if (index >= 0) retained.splice(index, 1);
    retained.push(key);
    if (retained.length > 2) retained.shift();
    const request = ++requestId;
    return new Promise<
      Omit<PackageSearchResult, "hits"> & { hits: PackageHitReferences[][] }
    >((resolve, reject) => {
      current.pending.set(request, { resolve, reject });
      try {
        current.worker.postMessage({
          request,
          key,
          language,
          queries,
          options,
          ...(prepare ? { pkg } : {}),
        });
      } catch (error) {
        current.pending.delete(request);
        const index = retained.indexOf(key);
        if (index >= 0) retained.splice(index, 1);
        reject(error);
      }
    });
  };
  let result;
  try {
    result = await send();
  } catch (error) {
    if (!(error instanceof MissingPackageError)) throw error;
    // A rejected or evicted queued request can invalidate the optimistic LRU.
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
            plain_text: Array.from(selected.plain_text).slice(0, 240).join(""),
            status: "unavailable",
          },
        };
      }),
    ),
  };
}
