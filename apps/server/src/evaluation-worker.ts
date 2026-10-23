import { parentPort, workerData } from "node:worker_threads";
import {
  initializeCore,
  createEvaluationSession,
  restoreHostEvaluationSession,
  type EvaluationBuilder,
  type EvaluationSessionHandle,
} from "../../../packages/core/src/index.ts";

/** The optional hook belongs to fixture workers. Production supplies none. */
export async function serveEvaluationWorker(beforeFinish?: () => void) {
  const port = parentPort!;
  let builder: EvaluationBuilder | undefined;
  let session: EvaluationSessionHandle | undefined;
  try {
    await initializeCore(workerData.wasm);
    port.postMessage({ id: 0 });
  } catch (error) {
    port.postMessage({ id: 0, error: String(error) });
    return;
  }
  port.on("message", ({ id, operation, value }) => {
    try {
      let result: unknown;
      switch (operation) {
        case "create":
          builder = createEvaluationSession(value);
          break;
        case "restore":
          session = restoreHostEvaluationSession(value.bytes, value.binding);
          result = session.state;
          break;
        case "fork":
          {
            const base = restoreHostEvaluationSession(
              value.bytes,
              value.binding,
            );
            try {
              builder = base.fork(value.options);
            } finally {
              base.free();
            }
          }
          break;
        case "add":
          result = builder!.addRecord(value.envelope, value.body);
          break;
        case "remove":
          builder!.removeRecord(value);
          break;
        case "finish":
          beforeFinish?.();
          session = builder!.finish();
          builder = undefined;
          result = session.state;
          break;
        case "rank":
          result = session!.rankWord(value.word, value.reviewers);
          break;
        case "checkpoint": {
          const bytes = session!.checkpoint(value);
          port.postMessage({ id, value: bytes }, [bytes.buffer as ArrayBuffer]);
          return;
        }
        default:
          throw new Error("Unknown evaluation operation.");
      }
      port.postMessage({ id, value: result });
    } catch (error) {
      port.postMessage({ id, error: String(error) });
    }
  });
}
if (workerData?.entry === "default") await serveEvaluationWorker();
