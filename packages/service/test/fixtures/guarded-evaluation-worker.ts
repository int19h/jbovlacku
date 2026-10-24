import { workerData } from "node:worker_threads";
import { EvaluationSession } from "../../../core/generated/jvc_runtime.js";
import { serveEvaluationWorker } from "../../../../apps/server/src/evaluation-worker.ts";

if (workerData.rejectParsedState) {
  const parse = JSON.parse;
  JSON.parse = (text, reviver) => {
    const value = parse(text, reviver);
    if (value?.selected_view && value.receipts && value.publications)
      throw new Error("The worker parsed the full evaluated state.");
    return value;
  };
}
if (workerData.trapRank) {
  const trap = new WebAssembly.Instance(
    new WebAssembly.Module(
      new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 7, 8, 1, 4,
        116, 114, 97, 112, 0, 0, 10, 5, 1, 3, 0, 0, 11,
      ]),
    ),
  ).exports.trap as () => never;
  EvaluationSession.prototype.rank = trap;
}
await serveEvaluationWorker();
