import { parentPort, workerData } from "node:worker_threads";
import { initializeCore } from "../../../packages/core/src/index.ts";
import { createPatternScan } from "../../../packages/search/src/pattern-scan.ts";
import { PatternError } from "../../../packages/search/src/pattern.ts";
await initializeCore(workerData.wasm);
try {
  const scan = createPatternScan(workerData.entries, workerData.query);
  try {
    while (!scan.step()) {
      /* The parent enforces the hard deadline. */
    }
    parentPort!.postMessage({ rows: scan.rows });
  } finally {
    scan.free();
  }
} catch (error) {
  parentPort!.postMessage({
    error: error instanceof Error ? error.message : String(error),
    code: error instanceof PatternError ? error.code : undefined,
  });
}
