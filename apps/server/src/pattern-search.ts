import { Worker } from "node:worker_threads";
import type {
  PatternCandidate,
  PatternMatch,
  PatternScanner,
} from "../../../packages/search/src/pattern-scan.ts";
import {
  patternBusy,
  patternTimeout,
} from "../../../packages/search/src/pattern-scan.ts";
import {
  PatternError,
  PATTERN_WORKER_TIMEOUT_MS,
} from "../../../packages/search/src/pattern.ts";
interface ScannerOptions {
  workerFactory?: (data: { wasm: Uint8Array }) => Worker;
  startupTimeoutMs?: number;
  taskTimeoutMs?: number;
}
interface Task {
  id: number;
  entries: PatternCandidate[];
  query: string;
  signal?: AbortSignal;
  resolve: (rows: PatternMatch[]) => void;
  reject: (error: Error) => void;
  cancel: () => void;
  slot?: Slot;
}
interface Slot {
  worker: Worker;
  ready: boolean;
  task?: Task;
  startupTimer?: ReturnType<typeof setTimeout>;
  taskTimer?: ReturnType<typeof setTimeout>;
}
/** Two initialized workers and eight waiting requests bound pattern work. */
export class NodePatternScanner {
  private waiting: Task[] = [];
  private workers = new Set<Slot>();
  private retiring = new Set<Promise<unknown>>();
  private closed = false;
  private nextId = 0;
  constructor(
    private wasm: Uint8Array,
    private options: ScannerOptions = {},
  ) {}
  get liveWorkers() {
    return this.workers.size;
  }
  get queuedRequests() {
    return this.waiting.length;
  }
  readonly scan: PatternScanner = (entries, query, signal) => {
    signal?.throwIfAborted();
    if (this.closed) return Promise.reject(patternTimeout());
    if (this.waiting.length >= 8) return Promise.reject(patternBusy());
    return new Promise((resolve, reject) => {
      const task: Task = {
        id: ++this.nextId,
        entries,
        query,
        signal,
        resolve,
        reject,
        cancel: () => {},
      };
      task.cancel = () => {
        const error = new DOMException("Search was canceled.", "AbortError");
        if (task.slot) this.finish(task.slot, error, undefined, true);
        else {
          const index = this.waiting.indexOf(task);
          if (index < 0) return;
          this.waiting.splice(index, 1);
          this.settle(task, error);
        }
      };
      signal?.addEventListener("abort", task.cancel, { once: true });
      this.waiting.push(task);
      this.pump();
    });
  };
  private settle(task: Task, error?: Error, rows?: PatternMatch[]) {
    task.signal?.removeEventListener("abort", task.cancel);
    task.slot = undefined;
    if (error) task.reject(error);
    else task.resolve(rows!);
  }
  private pump() {
    while (!this.closed && this.waiting.length) {
      const idle = [...this.workers].find((slot) => slot.ready && !slot.task);
      if (idle) {
        this.assign(idle, this.waiting.shift()!);
      } else if (this.workers.size + this.retiring.size < 2) {
        this.spawn(this.waiting.shift()!);
      } else break;
    }
  }
  private assign(slot: Slot, task: Task) {
    slot.task = task;
    task.slot = slot;
    if (task.signal?.aborted) {
      this.finish(
        slot,
        new DOMException("Search was canceled.", "AbortError"),
        undefined,
        true,
      );
      return;
    }
    slot.worker.ref();
    if (!slot.ready) return;
    // Startup has its own bound. This deadline covers compilation and matching.
    slot.taskTimer = setTimeout(
      () => this.finish(slot, patternTimeout(), undefined, true),
      this.options.taskTimeoutMs ?? PATTERN_WORKER_TIMEOUT_MS,
    );
    try {
      slot.worker.postMessage({
        id: task.id,
        entries: task.entries,
        query: task.query,
      });
    } catch (error) {
      this.finish(slot, error as Error, undefined, true);
    }
  }
  private spawn(task: Task) {
    const source = import.meta.url.endsWith(".ts");
    let worker: Worker;
    try {
      worker =
        this.options.workerFactory?.({ wasm: this.wasm }) ??
        new Worker(
          new URL(
            source
              ? "./pattern-search-worker.ts"
              : "./pattern-search-worker.js",
            import.meta.url,
          ),
          {
            workerData: { wasm: this.wasm },
            execArgv: source ? ["--experimental-transform-types"] : [],
            resourceLimits: {
              maxOldGenerationSizeMb: 128,
              maxYoungGenerationSizeMb: 32,
            },
          },
        );
    } catch (error) {
      this.settle(task, error as Error);
      return;
    }
    const slot: Slot = { worker, ready: false };
    this.workers.add(slot);
    slot.startupTimer = setTimeout(
      () =>
        this.finish(
          slot,
          new Error("The pattern worker did not become ready."),
          undefined,
          true,
        ),
      this.options.startupTimeoutMs ?? 5000,
    );
    worker.on("message", (data) => {
      if (!this.workers.has(slot)) return;
      if (!slot.ready) {
        if (data.ready !== true) return;
        clearTimeout(slot.startupTimer);
        slot.ready = true;
        this.assign(slot, slot.task!);
      } else if (slot.task && data.id === slot.task.id) {
        this.finish(
          slot,
          data.error
            ? data.code === "pattern_invalid" || data.code === "pattern_timeout"
              ? new PatternError(data.code, data.error)
              : new Error(data.error)
            : undefined,
          data.rows,
        );
      }
    });
    worker.on("error", (error) => this.finish(slot, error, undefined, true));
    worker.on("exit", () =>
      this.finish(
        slot,
        new Error("The pattern worker stopped."),
        undefined,
        true,
      ),
    );
    this.assign(slot, task);
  }
  private finish(
    slot: Slot,
    error?: Error,
    rows?: PatternMatch[],
    retire = false,
  ) {
    if (!this.workers.has(slot)) return;
    clearTimeout(slot.taskTimer);
    const task = slot.task;
    slot.task = undefined;
    if (retire) {
      this.workers.delete(slot);
      clearTimeout(slot.startupTimer);
      // Retiring workers count toward the physical worker bound until exit.
      const stopped = slot.worker
        .terminate()
        .catch(() => {})
        .finally(() => {
          this.retiring.delete(stopped);
          this.pump();
        });
      this.retiring.add(stopped);
    } else slot.worker.unref();
    if (task) this.settle(task, error, rows);
    this.pump();
  }
  async close() {
    this.closed = true;
    for (const task of this.waiting.splice(0))
      this.settle(task, patternTimeout());
    for (const slot of this.workers)
      this.finish(slot, patternTimeout(), undefined, true);
    await Promise.all(this.retiring);
  }
}
