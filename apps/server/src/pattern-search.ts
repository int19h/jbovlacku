import { Worker } from "node:worker_threads";
import type {
  PatternCandidate,
  PatternMatch,
  PatternScanner,
} from "../../../packages/search/src/pattern-scan.ts";
import { patternTimeout } from "../../../packages/search/src/pattern-scan.ts";
import {
  PatternError,
  PATTERN_WORKER_TIMEOUT_MS,
} from "../../../packages/search/src/pattern.ts";
interface WorkerInput {
  wasm: Uint8Array;
  entries: PatternCandidate[];
  query: string;
}
interface ScannerOptions {
  workerFactory?: (data: WorkerInput) => Worker;
}
interface Task {
  entries: PatternCandidate[];
  query: string;
  signal?: AbortSignal;
  resolve: (rows: PatternMatch[]) => void;
  reject: (error: Error) => void;
  cancel: () => void;
}
/** Two workers and eight waiting requests bound concurrent pattern work. */
export class NodePatternScanner {
  private waiting: Task[] = [];
  private running = new Map<
    Task,
    { worker: Worker; finish: (error?: Error, rows?: PatternMatch[]) => void }
  >();
  private retiring = new Set<Promise<unknown>>();
  private closed = false;
  constructor(
    private wasm: Uint8Array,
    private options: ScannerOptions = {},
  ) {}
  get liveWorkers() {
    return this.running.size;
  }
  get queuedRequests() {
    return this.waiting.length;
  }
  readonly scan: PatternScanner = (entries, query, signal) => {
    signal?.throwIfAborted();
    if (this.closed || this.waiting.length >= 8)
      return Promise.reject(patternTimeout());
    return new Promise((resolve, reject) => {
      const task: Task = {
        entries,
        query,
        signal,
        resolve,
        reject,
        cancel: () => {},
      };
      task.cancel = () => {
        const index = this.waiting.indexOf(task);
        if (index >= 0) {
          this.waiting.splice(index, 1);
          signal?.removeEventListener("abort", task.cancel);
          reject(new DOMException("Search was canceled.", "AbortError"));
        }
      };
      signal?.addEventListener("abort", task.cancel, { once: true });
      this.waiting.push(task);
      this.pump();
    });
  };
  private pump() {
    while (!this.closed && this.running.size < 2 && this.waiting.length)
      this.start(this.waiting.shift()!);
  }
  private start(task: Task) {
    task.signal?.removeEventListener("abort", task.cancel);
    const source = import.meta.url.endsWith(".ts");
    let worker: Worker;
    try {
      worker =
        this.options.workerFactory?.({
          wasm: this.wasm,
          entries: task.entries,
          query: task.query,
        }) ??
        new Worker(
          new URL(
            source
              ? "./pattern-search-worker.ts"
              : "./pattern-search-worker.js",
            import.meta.url,
          ),
          {
            workerData: {
              wasm: this.wasm,
              entries: task.entries,
              query: task.query,
            },
            execArgv: source ? ["--experimental-transform-types"] : [],
            resourceLimits: {
              maxOldGenerationSizeMb: 128,
              maxYoungGenerationSizeMb: 32,
            },
          },
        );
    } catch (error) {
      task.reject(error as Error);
      return;
    }
    let settled = false;
    const finish = (error?: Error, rows?: PatternMatch[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      task.signal?.removeEventListener("abort", abort);
      const stopped = worker.terminate().finally(() => {
        this.retiring.delete(stopped);
        this.running.delete(task);
        this.pump();
      });
      this.retiring.add(stopped);
      if (error) task.reject(error);
      else task.resolve(rows!);
    };
    this.running.set(task, { worker, finish });
    const abort = () =>
      finish(new DOMException("Search was canceled.", "AbortError"));
    // This parent timer covers worker startup, compilation, and the entire scan.
    const timer = setTimeout(
      () => finish(patternTimeout()),
      PATTERN_WORKER_TIMEOUT_MS,
    );
    task.signal?.addEventListener("abort", abort, { once: true });
    if (task.signal?.aborted) abort();
    worker.once("message", (data) =>
      finish(
        data.error
          ? data.code === "pattern_invalid" || data.code === "pattern_timeout"
            ? new PatternError(data.code, data.error)
            : new Error(data.error)
          : undefined,
        data.rows,
      ),
    );
    worker.once("error", (error) => finish(error));
    worker.once("exit", () => finish(new Error("The pattern worker stopped.")));
  }
  async close() {
    this.closed = true;
    for (const task of this.waiting.splice(0)) {
      task.signal?.removeEventListener("abort", task.cancel);
      task.reject(patternTimeout());
    }
    for (const { finish } of this.running.values()) finish(patternTimeout());
    await Promise.all(this.retiring);
    this.running.clear();
  }
}
