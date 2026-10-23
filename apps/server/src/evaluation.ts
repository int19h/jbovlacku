import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import type {
  Evaluation,
  EvaluationPackageRecord,
  EvaluationSessionOptions,
} from "../../../packages/core/src/index.ts";
import type {
  EvaluationRuntime,
  EvaluationBuilder,
  EvaluationSession,
} from "../../../packages/service/src/evaluation.ts";

export interface EvaluationWorkerData {
  entry: string;
  wasm: Uint8Array;
}
interface Options {
  workerFactory?: (data: EvaluationWorkerData) => Worker;
}
interface SerializedState {
  kind: "state" | "delta";
  bytes: Uint8Array;
}
interface SessionBasis {
  identity: string;
  state: Evaluation;
}
interface StateDelta {
  version: number;
  base_session: string;
  receipts: Evaluation["receipts"];
  registers: Record<string, unknown>;
  judgments: Record<string, Record<string, unknown>>;
  lifecycle: {
    key_actor: Record<string, string>;
    groups: Record<string, string[]>;
  };
}
function freezeState<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeState(child);
  }
  return value;
}
/** Version 1 patches change only judgments, their receipts, and actor entries. */
function applyStateDelta(parent: Evaluation, delta: StateDelta): Evaluation {
  const oldJudgments = parent.judgments as StateDelta["judgments"];
  const judgments = { ...oldJudgments };
  for (const [target, actors] of Object.entries(delta.judgments))
    judgments[target] = { ...oldJudgments[target], ...actors };
  const lifecycle = parent.lifecycle as StateDelta["lifecycle"];
  return {
    ...parent,
    receipts: { ...parent.receipts, ...delta.receipts },
    registers: { ...(parent.registers as object), ...delta.registers },
    judgments,
    lifecycle: {
      ...lifecycle,
      key_actor: { ...lifecycle.key_actor, ...delta.lifecycle.key_actor },
      groups: { ...lifecycle.groups, ...delta.lifecycle.groups },
    },
  };
}

class Connection {
  private sequence = 0;
  private pending = new Map<
    number,
    { resolve(value: any): void; reject(error: Error): void }
  >();
  private failure?: Error;
  private released = false;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  readonly ready = new Promise<void>((resolve, reject) => {
    this.readyResolve = resolve;
    this.readyReject = reject;
  });
  constructor(
    readonly worker: Worker,
    private release: (connection: Connection) => void,
  ) {
    worker.on("message", (message) => {
      if (message.id === 0) {
        if (message.error) this.fail(new Error(message.error));
        else this.readyResolve();
        return;
      }
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.terminal) {
        this.fail(new Error(message.error));
        this.free();
      }
      if (message.error) pending?.reject(new Error(message.error));
      else pending?.resolve(message.value);
    });
    worker.on("error", (error) => {
      this.fail(error);
      this.free();
    });
    worker.on("exit", () => {
      this.fail(new Error("The evaluation worker stopped."));
      this.free();
    });
  }
  private fail(error: Error) {
    this.failure ??= error;
    this.readyReject(this.failure);
    for (const entry of this.pending.values()) entry.reject(this.failure);
    this.pending.clear();
  }
  async request<T = any>(
    operation: string,
    value?: unknown,
    transfer: ArrayBuffer[] = [],
  ): Promise<T> {
    await this.ready;
    if (this.failure) throw this.failure;
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage({ id, operation, value }, transfer);
      } catch (error) {
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }
  free() {
    if (this.released) return;
    this.released = true;
    this.fail(new Error("The evaluation session is closed."));
    this.release(this);
  }
  isAvailable() {
    return !this.failure;
  }
}

/** Each live session owns a runtime, so a rebuild cannot block completed reads. */
export class NodeEvaluationRuntime implements EvaluationRuntime {
  private live = new Set<Connection>();
  private retiring = new Set<Promise<unknown>>();
  private closed = false;
  constructor(
    private wasm: Uint8Array,
    private options: Options = {},
  ) {}
  get liveWorkers() {
    return this.live.size;
  }
  private release = (connection: Connection) => {
    if (!this.live.has(connection)) return;
    const stopped = connection.worker.terminate().finally(() => {
      this.live.delete(connection);
      this.retiring.delete(stopped);
    });
    this.retiring.add(stopped);
  };
  private async connect() {
    await Promise.all(this.retiring);
    if (this.closed) throw new Error("The evaluation runtime is closed.");
    if (this.live.size >= 2)
      throw new Error(
        "Two evaluation runtimes already occupy the available slots.",
      );
    const data: EvaluationWorkerData = { entry: "default", wasm: this.wasm };
    const source = import.meta.url.endsWith(".ts");
    const worker =
      this.options.workerFactory?.(data) ??
      new Worker(
        new URL(
          source ? "./evaluation-worker.ts" : "./evaluation-worker.js",
          import.meta.url,
        ),
        {
          workerData: data,
          execArgv: source ? ["--experimental-transform-types"] : [],
        },
      );
    const connection = new Connection(worker, this.release);
    this.live.add(connection);
    try {
      await connection.ready;
      return connection;
    } catch (error) {
      connection.free();
      throw error;
    }
  }
  async create(options: EvaluationSessionOptions): Promise<EvaluationBuilder> {
    const connection = await this.connect();
    try {
      await connection.request("create", options);
      return this.builder(connection);
    } catch (error) {
      connection.free();
      throw error;
    }
  }
  async restore(
    bytes: Uint8Array,
    binding: string,
  ): Promise<EvaluationSession> {
    const connection = await this.connect();
    try {
      const state = await connection.request<SerializedState>("restore", {
        bytes,
        binding,
      });
      return await this.readSession(connection, state);
    } catch (error) {
      connection.free();
      throw error;
    }
  }
  private builder(
    connection: Connection,
    parent?: SessionBasis,
  ): EvaluationBuilder {
    let closed = false;
    let transferred = false;
    const requireOpen = () => {
      if (closed) throw new Error("The evaluation builder is closed.");
    };
    return {
      addRecord(envelope, body) {
        requireOpen();
        // Object stores can retain or pool these buffers. Transfer only owned copies.
        const original = Uint8Array.from(envelope);
        const content = body === undefined ? undefined : Uint8Array.from(body);
        return connection.request<EvaluationPackageRecord | null>(
          "add",
          { envelope: original, body: content },
          [original.buffer, ...(content ? [content.buffer] : [])],
        );
      },
      removeRecord(id) {
        requireOpen();
        return connection.request<void>("remove", id);
      },
      finish: async () => {
        requireOpen();
        closed = true;
        try {
          const value = await connection.request<SerializedState>("finish");
          const session = await this.readSession(connection, value, parent);
          transferred = true;
          return session;
        } catch (error) {
          connection.free();
          throw error;
        } finally {
          parent = undefined;
        }
      },
      free() {
        closed = true;
        parent = undefined;
        if (!transferred) connection.free();
      },
    };
  }
  private async readSession(
    connection: Connection,
    value: SerializedState,
    parent?: SessionBasis,
  ): Promise<EvaluationSession> {
    const parsed = JSON.parse(new TextDecoder().decode(value.bytes));
    if (value.kind === "delta") {
      const delta = parsed as StateDelta;
      if (
        parent &&
        delta.version === 1 &&
        delta.base_session === parent.identity
      )
        return this.session(
          connection,
          freezeState(applyStateDelta(parent.state, delta)),
        );
      return this.readSession(
        connection,
        await connection.request<SerializedState>("state"),
      );
    }
    return this.session(connection, freezeState(parsed as Evaluation));
  }
  private session(
    connection: Connection,
    state: Evaluation,
  ): EvaluationSession {
    return {
      state,
      isAvailable: () => connection.isAvailable(),
      rankWord: (word, reviewers) =>
        connection.request("rank", { word, reviewers }),
      checkpoint: (binding) =>
        connection.request<Uint8Array>("checkpoint", binding),
      fork: async (options) => {
        const binding = "node-evaluation-transfer-v1:" + randomUUID();
        const bytes = await connection.request<Uint8Array>(
          "checkpoint",
          binding,
        );
        const next = await this.connect();
        try {
          const identity = await next.request<string>(
            "fork",
            { bytes, binding, options },
            [bytes.buffer as ArrayBuffer],
          );
          return this.builder(next, { identity, state });
        } catch (error) {
          next.free();
          throw error;
        }
      },
      free: () => connection.free(),
    };
  }
  async close() {
    this.closed = true;
    for (const connection of this.live) connection.free();
    await Promise.all(this.retiring);
  }
}
