import { packageStorageKey } from "./store.ts";
/** Saved-package validation and lexical work run in one static module worker. */
import type { CachedPackage, LocalHit } from "./search.ts";
import type {
  SegmentationStatus,
  SearchMetrics,
} from "../../../../packages/search/src/index.ts";
export interface PackageSearchResult {
  hits: LocalHit[][];
  segmentation: SegmentationStatus;
  metrics: SearchMetrics;
  prepared: boolean;
}
export class PackageValidationError extends Error {}
interface Client {
  worker: Worker;
  pending: Map<
    number,
    {
      resolve: (value: PackageSearchResult) => void;
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
): Promise<PackageSearchResult> {
  const current = searchWorker();
  let identity: string | number | undefined =
    packageStorageKey(pkg) ?? packageIds.get(pkg);
  if (identity === undefined) {
    identity = ++packageId;
    packageIds.set(pkg, identity);
  }
  const key = JSON.stringify([language, identity]);
  const prepare = !retained.includes(key);
  if (!prepare) retained.splice(retained.indexOf(key), 1);
  retained.push(key);
  if (retained.length > 2) retained.shift();
  const request = ++requestId;
  return new Promise((resolve, reject) => {
    current.pending.set(request, { resolve, reject });
    try {
      current.worker.postMessage({
        request,
        key,
        language,
        queries,
        ...(prepare ? { pkg } : {}),
      });
    } catch (error) {
      current.pending.delete(request);
      retained.splice(retained.indexOf(key!), 1);
      reject(error);
    }
  });
}
