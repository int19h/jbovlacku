import { initializeCore } from "../../../../packages/core/src/browser.ts";
import {
  prepareIndex,
  prepareQuery,
  searchMetrics,
  PatternError,
  isPatternQuery,
  SearchRequestBudget,
  isSearchBudgetState,
} from "../../../../packages/search/src/index.ts";
import {
  localSearch,
  validateCachedPackage,
  PackageStorageError,
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
      // One budget and one deadline cover the whole request: validation,
      // preparation, maps, query parsing, scanning, grouping, and sorting.
      // The client sends its budget state with the request, so the deadline
      // spans the transfer as well.
      const requestBudget = isSearchBudgetState(data.budget)
        ? SearchRequestBudget.resume(data.budget, metrics)
        : new SearchRequestBudget(metrics, {
            workLimit: data.options?.workLimit,
            deadlineMs: data.options?.deadlineMs,
          });
      const tooLarge = (request: number, key: string) =>
        reply({
          request,
          key,
          code: "package-too-large",
          error: new PackageStorageError().message,
        });
      if (data.pkg) {
        try {
          validateCachedPackage(data.pkg, data.language, requestBudget);
        } catch (error) {
          // A memory failure while a package is validated reports that the
          // package does not fit instead of the raw allocation error.
          if (error instanceof RangeError) {
            tooLarge(data.request, data.key);
            return;
          }
          reply({
            request: data.request,
            key: data.key,
            code: "invalid-package",
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        try {
          prepareIndex(data.pkg.entries, metrics, {
            requestBudget,
          });
        } catch (error) {
          // A memory failure while a package is prepared reports that the
          // package does not fit instead of the raw allocation error.
          if (error instanceof RangeError) {
            tooLarge(data.request, data.key);
            return;
          }
          throw error;
        }
        const pkg: CachedPackage = data.pkg;
        try {
          // One unit per map insertion, charged before the maps grow.
          const entries = new Map<CachedPackage["entries"][number], number>();
          const events = new Map<string, number>();
          for (const [index, entry] of pkg.entries.entries()) {
            requestBudget.reserve(1, "prepare");
            entries.set(entry, index);
            requestBudget.reserve(1, "prepare");
            events.set(entry.event, index);
          }
          packages.set(data.key, { pkg, entries, events });
        } catch (error) {
          if (error instanceof RangeError) {
            tooLarge(data.request, data.key);
            return;
          }
          throw error;
        }
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
      // Both groups share one bounded query parse on the request budget.
      const queries = options.grouped
        ? data.queries.map((query: string) =>
            prepareQuery(query, metrics, {
              patterns: options.patterns !== false && !options.nearby,
              requestBudget,
            }),
          )
        : data.queries;
      const hits: ReturnType<typeof localSearch>[] = (
        options.grouped ? ["lojban", "definitions"] : [options.group]
      ).flatMap((group) =>
        queries.map((query: Parameters<typeof localSearch>[1]) =>
          localSearch(stored.pkg.entries, query, metrics, options.rafsiOnly, {
            patterns: options.patterns !== false && !options.nearby,
            group: group as PackageSearchOptions["group"],
            view: options.view,
            packageView: stored.pkg.search_view,
            includeRetired: options.includeRetired,
            workLimit: options.workLimit,
            deadlineMs: options.deadlineMs,
            requestBudget,
          }),
        ),
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
      const ranked = options.nearby
        ? [rankNearby(hits, requestBudget)]
        : hits;
      // The structured clone below copies every mapped reference to the
      // client, so the mapping also counts the transfer units up front.
      let transferUnits = 0;
      const pages: PackageHitReferences[][] = ranked.map((rows) =>
        rows.slice(offset, offset + limit).map((hit) => {
          // One unit per reference mapped, charged before the mapping runs.
          requestBudget.reserve(1, "search");
          transferUnits += 1;
          const entries = hit.entries.map((entry) => {
            requestBudget.reserve(1, "search");
            transferUnits += 1;
            return stored.entries.get(entry)!;
          });
          const definitions = hit.definitions.map((event) => {
            requestBudget.reserve(1, "search");
            transferUnits += 1;
            return stored.events.get(event)!;
          });
          requestBudget.reserve(1, "search");
          transferUnits += 1;
          return {
            word_id: hit.word_id,
            match: hit.match,
            entries,
            definitions,
            preview: stored.events.get(hit.preview!.event)!,
            ...(hit.matchingRafsi ? { rafsi: hit.matchingRafsi } : {}),
          };
        }),
      );
      // Charge the reply transfer before it is posted.
      requestBudget.reserve(transferUnits, "search");
      reply({
        request: data.request,
        result: {
          hits: pages,
          totals: ranked.map((rows) => rows.length),
          segmentation,
          metrics,
          prepared: !!data.pkg,
          allLojban: hits[0]?.allLojban ?? false,
          budget: requestBudget.snapshot(),
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
