import { parentPort, workerData } from "node:worker_threads";
import { initializeCore } from "../../../packages/core/src/index.ts";
import { createPatternScan } from "../../../packages/search/src/pattern-scan.ts";
import { PatternError } from "../../../packages/search/src/pattern.ts";
await initializeCore(workerData.wasm);
parentPort!.on("message", ({ id, entries, query }) => {
  try {
    const scan = createPatternScan(entries, query);
    try {
      while (!scan.step()) {
        /* The parent enforces the hard deadline. */
      }
      parentPort!.postMessage({ id, rows: scan.rows });
    } finally {
      scan.free();
    }
  } catch (error) {
    parentPort!.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
      code: error instanceof PatternError ? error.code : undefined,
    });
  }
});
parentPort!.postMessage({ ready: true });
