import { initializeCore } from "../../../../packages/core/src/browser.ts";
import {
  prepareIndex,
  searchMetrics,
} from "../../../../packages/search/src/index.ts";
import {
  localSearch,
  validateCachedPackage,
  type CachedPackage,
} from "./search.ts";
const packages = new Map<string | number, CachedPackage>();
const ready = initializeCore();
let queue = Promise.resolve();
// Keep messages ordered while the initial Wasm module loads.
self.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    try {
      await ready;
      const metrics = searchMetrics();
      if (data.pkg) {
        try {
          validateCachedPackage(data.pkg, data.language);
        } catch (error) {
          self.postMessage({
            request: data.request,
            key: data.key,
            code: "invalid-package",
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        packages.set(data.key, data.pkg);
        prepareIndex(data.pkg.entries, metrics);
      }
      const pkg = packages.get(data.key);
      if (!pkg)
        throw new Error(
          "The local search package expired. Start a new search to retry.",
        );
      packages.delete(data.key);
      packages.set(data.key, pkg);
      if (packages.size > 2) packages.delete(packages.keys().next().value!);
      const hits = data.queries.map((query: string) =>
        localSearch(pkg.entries, query, metrics),
      );
      const segmentation = hits.some(
        (rows: ReturnType<typeof localSearch>) =>
          rows.segmentation === "limited",
      )
        ? "limited"
        : "complete";
      self.postMessage({
        request: data.request,
        result: { hits, segmentation, metrics, prepared: !!data.pkg },
      });
    } catch (error) {
      self.postMessage({
        request: data.request,
        key: data.key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
};
