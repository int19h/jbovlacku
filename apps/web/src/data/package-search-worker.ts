import { initializeCore } from "../../../../packages/core/src/browser.ts";
import {
  prepareIndex,
  searchMetrics,
  PatternError,
  isPatternQuery,
} from "../../../../packages/search/src/index.ts";
import {
  localSearch,
  validateCachedPackage,
  type CachedPackage,
} from "./search.ts";
import { rankNearby } from "../../../../packages/service/src/nearby.ts";
import type {
  PackageSearchOptions,
  PackageHitReferences,
} from "./package-search.ts";
const packages = new Map<
  string | number,
  {
    pkg: CachedPackage;
    entries: Map<CachedPackage["entries"][number], number>;
    events: Map<string, number>;
  }
>();
let cacheRevision = 0;
const reply = (data: Record<string, unknown>) =>
  self.postMessage({
    ...data,
    retained: [...packages.keys()],
    cacheRevision: ++cacheRevision,
  });
const ready = initializeCore();
let queue = Promise.resolve();
const canceled = new Set<number>();
const queued = new Set<number>();
// Keep messages ordered while the initial Wasm module loads.
self.onmessage = ({ data }) => {
  if (data.cancel !== undefined) {
    if (queued.has(data.cancel)) canceled.add(data.cancel);
    return;
  }
  queued.add(data.request);
  queue = queue.then(async () => {
    try {
      await ready;
      // Let queued cancellation messages arrive before preparation or matching.
      await new Promise((resolve) => setTimeout(resolve, 0));
      queued.delete(data.request);
      if (canceled.delete(data.request)) {
        reply({ request: data.request, canceled: true });
        return;
      }
      const metrics = searchMetrics();
      if (data.pkg) {
        try {
          validateCachedPackage(data.pkg, data.language);
        } catch (error) {
          reply({
            request: data.request,
            key: data.key,
            code: "invalid-package",
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        prepareIndex(data.pkg.entries, metrics);
        const pkg: CachedPackage = data.pkg;
        packages.set(data.key, {
          pkg,
          entries: new Map(pkg.entries.map((entry, index) => [entry, index])),
          events: new Map(
            pkg.entries.map((entry, index) => [entry.event, index]),
          ),
        });
      }
      const stored = packages.get(data.key);
      if (!stored) {
        reply({
          request: data.request,
          key: data.key,
          code: "package-missing",
          error:
            "The local search package is unavailable. Start a new search to retry.",
        });
        return;
      }
      packages.delete(data.key);
      packages.set(data.key, stored);
      if (packages.size > 2) packages.delete(packages.keys().next().value!);
      const options: PackageSearchOptions = data.options ?? {};
      if (
        options.patterns !== false &&
        !options.nearby &&
        data.queries.some(isPatternQuery)
      )
        reply({ request: data.request, started: true });
      const hits: ReturnType<typeof localSearch>[] = data.queries.map(
        (query: string) =>
          localSearch(stored.pkg.entries, query, metrics, options.rafsiOnly, {
            patterns: options.patterns !== false && !options.nearby,
          }),
      );
      const segmentation = hits.some(
        (rows: ReturnType<typeof localSearch>) =>
          rows.segmentation === "limited",
      )
        ? "limited"
        : "complete";
      const offset = Number.isSafeInteger(options.offset)
        ? Math.min(1000, Math.max(0, options.offset!))
        : 0;
      const limit = Math.min(
        1000 - offset,
        Number.isSafeInteger(options.limit) ? Math.max(0, options.limit!) : 20,
      );
      const ranked = options.nearby ? [rankNearby(hits)] : hits;
      const pages: PackageHitReferences[][] = ranked.map((rows) =>
        rows.slice(offset, offset + limit).map((hit) => ({
          word_id: hit.word_id,
          match: hit.match,
          entries: hit.entries.map((entry) => stored.entries.get(entry)!),
          definitions: hit.definitions.map(
            (event) => stored.events.get(event)!,
          ),
          preview: stored.events.get(hit.preview!.event)!,
          ...(hit.matchingRafsi ? { rafsi: hit.matchingRafsi } : {}),
        })),
      );
      reply({
        request: data.request,
        result: {
          hits: pages,
          totals: ranked.map((rows) => rows.length),
          segmentation,
          metrics,
          prepared: !!data.pkg,
        },
      });
    } catch (error) {
      queued.delete(data.request);
      canceled.delete(data.request);
      reply({
        request: data.request,
        key: data.key,
        ...(error instanceof PatternError ? { code: error.code } : {}),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
};
