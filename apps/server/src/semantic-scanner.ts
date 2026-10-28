import { Worker } from "node:worker_threads";
import { SemanticError } from "../../../packages/service/src/semantic/types.ts";
import type {
  ScanRequest,
  SemanticHit,
  VectorScanner,
} from "../../../packages/service/src/semantic/scan.ts";

interface Slot {
  worker: Worker;
  busy: boolean;
  network?: string;
  fail?: (error: Error) => void;
}
/** Two reusable read-only workers bound memory and leave the HTTP thread free. */
export class NodeVectorScanner implements VectorScanner {
  private workers: Slot[] = [];
  private sequence = 0;
  private closed = false;
  constructor(private path: string) {}
  async scan(
    request: ScanRequest,
    signal?: AbortSignal,
  ): Promise<SemanticHit[]> {
    signal?.throwIfAborted();
    if (this.closed)
      throw new SemanticError(
        503,
        "semantic_closed",
        "The vector scanner is closed.",
      );
    const network = request.network ?? "";
    if (this.workers.some((slot) => slot.busy && slot.network === network))
      throw new SemanticError(
        503,
        "semantic_busy",
        "This client already has an active vector scan. Try again later.",
      );
    let slot = this.workers.find((worker) => !worker.busy);
    if (!slot && this.workers.length < 2) {
      const source = import.meta.url.endsWith(".ts");
      const entry = new URL(
        source ? "./semantic-worker.ts" : "./semantic-worker.js",
        import.meta.url,
      );
      const worker = new Worker(entry, {
        workerData: { path: this.path },
        execArgv: source ? ["--experimental-transform-types"] : [],
      });
      slot = { worker, busy: false };
      const created = slot;
      const failed = () => {
        created.fail?.(
          new SemanticError(
            503,
            "semantic_scan",
            "The vector scan worker stopped.",
          ),
        );
        this.workers = this.workers.filter((entry) => entry !== created);
      };
      worker.on("error", failed);
      worker.on("exit", failed);
      this.workers.push(slot);
    }
    if (!slot)
      throw new SemanticError(
        503,
        "semantic_busy",
        "Both vector scan workers are busy. Try again later.",
      );
    slot.busy = true;
    slot.network = network;
    const selected = slot;
    const id = ++this.sequence;
    const cancel = new SharedArrayBuffer(4);
    return new Promise<SemanticHit[]>((resolve, reject) => {
      const abort = () => {
        Atomics.store(new Int32Array(cancel), 0, 1);
        // Keep the search lease and client slot until the worker stops reading.
      };
      const cleanup = () => {
        signal?.removeEventListener("abort", abort);
        selected.worker.removeListener("message", receive);
        selected.busy = false;
        selected.network = undefined;
        selected.fail = undefined;
      };
      const receive = (message: {
        id: number;
        hits: SemanticHit[];
        error?: { status: number; code: string; message: string };
      }) => {
        if (message.id !== id) return;
        cleanup();
        if (signal?.aborted) reject(signal.reason);
        else if (message.error)
          reject(
            new SemanticError(
              message.error.status,
              message.error.code,
              message.error.message,
            ),
          );
        else resolve(message.hits);
      };
      selected.fail = (error) => {
        cleanup();
        reject(error);
      };
      selected.worker.on("message", receive);
      signal?.addEventListener("abort", abort, { once: true });
      selected.worker.postMessage({ id, request, cancel });
      if (signal?.aborted) abort();
    });
  }
  async close() {
    this.closed = true;
    await Promise.all(this.workers.map((slot) => slot.worker.terminate()));
    this.workers = [];
  }
}
