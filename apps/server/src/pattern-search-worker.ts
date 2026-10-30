import { parentPort, workerData } from "node:worker_threads";
import { initializeCore } from "../../../packages/core/src/index.ts";
import { scanPatterns } from "../../../packages/search/src/pattern-scan.ts";
import { PatternError } from "../../../packages/search/src/pattern.ts";
await initializeCore(workerData.wasm);
parentPort!.on("message", ({ id, entries, query }) => {
  try {
    parentPort!.postMessage({ id, rows: scanPatterns(entries, query) });
  } catch (error) {
    parentPort!.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
      code: error instanceof PatternError ? error.code : undefined,
    });
  }
});
parentPort!.postMessage({ ready: true });
