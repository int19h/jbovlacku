import { parentPort, workerData } from "node:worker_threads";
import { initializeCore } from "../../../packages/core/src/index.ts";
import {
  EvaluationSession,
  EvaluationSessionBuilder,
} from "../../../packages/core/generated/jvc_runtime.js";
import { encodeEvaluationRequest } from "../../../packages/core/src/evaluation-request.ts";

/** The optional hook belongs to fixture workers. Production supplies none. */
export async function serveEvaluationWorker(beforeFinish?: () => void) {
  const port = parentPort!;
  let builder: EvaluationSessionBuilder | undefined;
  let session: EvaluationSession | undefined;
  let faulted = false;
  const encoder = new TextEncoder();
  const sendState = (id: number, allowDelta = false) => {
    const delta = allowDelta ? session!.state_delta() : "null";
    const kind = delta === "null" ? "state" : "delta";
    const bytes = encoder.encode(kind === "state" ? session!.state() : delta);
    port.postMessage({ id, value: { kind, bytes } }, [bytes.buffer]);
  };
  try {
    await initializeCore(workerData.wasm);
    port.postMessage({ id: 0 });
  } catch (error) {
    port.postMessage({ id: 0, error: String(error) });
    return;
  }
  port.on("message", ({ id, operation, value }) => {
    if (faulted) return;
    try {
      let result: unknown;
      switch (operation) {
        case "create":
          builder = new EvaluationSessionBuilder(
            encodeEvaluationRequest(value),
          );
          break;
        case "restore":
          session = value.records
            ? EvaluationSession.restore_host_result_checkpoint(
                value.bytes,
                value.binding,
                encoder.encode("[" + value.records.join(",") + "]"),
              )
            : EvaluationSession.restore_host_checkpoint(
                value.bytes,
                value.binding,
              );
          sendState(id);
          return;
        case "fork":
          {
            const base = EvaluationSession.restore_host_checkpoint(
              value.bytes,
              value.binding,
            );
            try {
              builder = base.fork(encodeEvaluationRequest(value.options));
              result = base.state_identity();
            } catch (error) {
              if (!(error instanceof WebAssembly.RuntimeError)) base.free();
              throw error;
            }
            base.free();
          }
          break;
        case "addHostVerified":
          result = JSON.parse(
            builder!.add_host_verified_record(encoder.encode(value)),
          );
          break;
        case "add":
          result = JSON.parse(builder!.add_record(value.envelope, value.body));
          break;
        case "remove":
          builder!.remove_record(value);
          break;
        case "finish":
          beforeFinish?.();
          session = builder!.finish();
          builder = undefined;
          sendState(id, true);
          return;
        case "state":
          sendState(id);
          return;
        case "rank":
          result = JSON.parse(
            value.reviewers === undefined
              ? session!.rank(value.word)
              : session!.rank_with_reviewers(value.word, value.reviewers),
          );
          break;
        case "resultCheckpoint":
        case "checkpoint": {
          const bytes =
            operation === "resultCheckpoint"
              ? session!.result_checkpoint(value)
              : session!.checkpoint(value);
          port.postMessage({ id, value: bytes }, [bytes.buffer as ArrayBuffer]);
          return;
        }
        default:
          throw new Error("Unknown evaluation operation.");
      }
      port.postMessage({ id, value: result });
    } catch (error) {
      const terminal = error instanceof WebAssembly.RuntimeError;
      faulted = terminal;
      port.postMessage({ id, error: String(error), terminal });
      // A trap can leave Rust borrows and allocations unfinished. Never reuse it.
      if (terminal) port.close();
    }
  });
}
if (workerData?.entry === "default") await serveEvaluationWorker();
