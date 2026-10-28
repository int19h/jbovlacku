import { workerData } from "node:worker_threads";
import { serveEvaluationWorker } from "../../../../apps/server/src/evaluation-worker.ts";

const gate = new Int32Array(workerData.gate);
await serveEvaluationWorker(() => {
  if (Atomics.load(gate, 2)) {
    Atomics.store(gate, 0, 1);
    Atomics.wait(gate, 1, 0, 60000);
  }
});
