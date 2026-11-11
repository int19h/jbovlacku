/**
 * Evaluation worker. It loads the shared core, builds one evaluation session
 * from authenticated records and the local overlay, and ranks words on request.
 * Every reply names the session it answers for, so a reply from an older
 * session is never read as the current one.
 * Cancellation terminates the worker, because WebAssembly work is synchronous.
 */
import {
  createEvaluationSession,
  evaluateSession,
  initializeCore,
  type EvaluationRequest,
  type EvaluationSessionOptions,
} from "../../../../packages/core/src/browser.ts";

export interface LoadSource {
  database: string;
  snapshot: string;
  events_digest: string;
  count: number;
}
export type WorkerRequest =
  | {
      type: "load";
      id: number;
      session: string;
      source: LoadSource;
      options: EvaluationSessionOptions;
    }
  | {
      type: "overlay";
      id: number;
      base: string;
      session: string;
      overlay: unknown;
    }
  | {
      type: "advance";
      id: number;
      base: string;
      session: string;
      input: EvaluationRequest;
    }
  | {
      type: "rank";
      id: number;
      session: string;
      word: string;
      /** At most this many reviewer details per score. Omitted means none. */
      reviewers?: number;
    };
export type WorkerResponse =
  | {
      type: "loaded";
      id: number;
      session: string;
      available: boolean;
      reasons: string[];
      selected_view: string;
      events: number;
      actors?: Record<string, string>;
    }
  | { type: "ranked"; id: number; session: string; result: unknown }
  | {
      type: "error";
      id: number;
      message: string;
      session_valid: boolean;
      fatal: boolean;
    };

type LoadedResponse = Extract<WorkerResponse, { type: "loaded" }>;
type RankedResponse = Extract<WorkerResponse, { type: "ranked" }>;
type Session = ReturnType<typeof evaluateSession>;
type Builder = ReturnType<typeof createEvaluationSession>;
type SourceLoader = (source: LoadSource, builder: Builder) => Promise<number>;

interface StoredInventory {
  events: string[];
  bodies: string[];
  events_digest: string;
}
interface StoredRecord {
  id: string;
  envelope: string;
  body: string | null;
  bodyHash: string | null;
}
function request<T>(read: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    read.onsuccess = () => resolve(read.result);
    read.onerror = () => reject(read.error);
  });
}
function missingRecord(id: string): Error {
  return new Error(`Record ${id} is not cached. Download the records again.`);
}
const BATCH_SIZE = 256;
function readBatch(recordStore: IDBObjectStore, after?: string) {
  return new Promise<{ id: string; record: StoredRecord }[]>(
    (resolve, reject) => {
      const range =
        after === undefined ? undefined : IDBKeyRange.lowerBound(after, true);
      const reading = recordStore.openCursor(range);
      const batch: { id: string; record: StoredRecord }[] = [];
      reading.onsuccess = () => {
        const cursor = reading.result;
        if (!cursor) {
          resolve(batch);
          return;
        }
        batch.push({
          id: String(cursor.key),
          record: cursor.value as StoredRecord,
        });
        if (batch.length === BATCH_SIZE) resolve(batch);
        else cursor.continue();
      };
      reading.onerror = () => reject(reading.error);
    },
  );
}
async function readStoredRecords(source: LoadSource, builder: Builder) {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const opening = indexedDB.open(source.database);
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error);
    opening.onblocked = () =>
      reject(new Error("Local storage is blocked by another open tab."));
  });
  try {
    const transaction = database.transaction(
      ["inventory", "records"],
      "readonly",
    );
    const inventoryStore = transaction.objectStore("inventory");
    const recordStore = transaction.objectStore("records");
    const stored = await request(
      inventoryStore.get(source.snapshot) as IDBRequest<
        StoredInventory | undefined
      >,
    );
    if (!stored) throw missingRecord(source.snapshot);
    if (stored.events_digest !== source.events_digest)
      throw new Error(
        "The cached inventory digest does not match the requested snapshot.",
      );
    if (!Array.isArray(stored.events) || !Array.isArray(stored.bodies))
      throw new Error("The cached inventory is malformed.");
    if (stored.events.length !== source.count)
      throw new Error(
        "The cached inventory count does not match the requested snapshot.",
      );
    if (
      stored.events.some(
        (id, index) =>
          typeof id !== "string" ||
          (index > 0 && id <= stored.events[index - 1]),
      )
    )
      throw new Error("The inventory is not in order.");
    const bodies = new Set(stored.bodies);
    let index = 0;
    let after: string | undefined;
    for (;;) {
      const batch = await readBatch(recordStore, after);
      if (batch.length === 0) break;
      for (const { id, record } of batch) {
        if (record.id !== id) throw missingRecord(id);
        const expected = stored.events[index];
        if (id !== expected) {
          if (expected === undefined || id < expected) {
            after = id;
            continue;
          }
          throw missingRecord(expected);
        }
        if (record.bodyHash && bodies.has(record.bodyHash) && !record.body)
          throw new Error(
            `The body of ${id} is retained by the snapshot but not cached. Download the records again.`,
          );
        const envelope = JSON.parse(record.envelope) as { id?: unknown };
        if (envelope.id !== id) throw missingRecord(id);
        builder.addRecordText(
          record.envelope,
          record.body && record.bodyHash && bodies.has(record.bodyHash)
            ? record.body
            : undefined,
        );
        index++;
        after = id;
      }
      if (index === stored.events.length || batch.length < BATCH_SIZE) break;
    }
    if (index !== stored.events.length)
      throw missingRecord(stored.events[index]);
    return index;
  } finally {
    database.close();
  }
}

export class EvaluationWorker {
  private session: Session | null = null;
  private sessionKey: string | null = null;

  constructor(
    private readonly loadSource: SourceLoader = readStoredRecords,
    private readonly createSession = createEvaluationSession,
  ) {}

  /** Test and measurement access to the current browser-safe session. */
  get currentSession() {
    return this.session;
  }

  private release() {
    this.session?.free();
    this.session = null;
    this.sessionKey = null;
  }

  private loaded(
    id: number,
    key: string,
    includeActors = true,
  ): LoadedResponse {
    if (!this.session) throw new Error("The evaluation session is not loaded.");
    return {
      type: "loaded",
      id,
      session: key,
      ...this.session.summary(),
      ...(includeActors ? { actors: this.session.actors() } : {}),
    };
  }

  async load(
    message: Extract<WorkerRequest, { type: "load" }>,
  ): Promise<LoadedResponse> {
    this.release();
    const builder = this.createSession(message.options);
    try {
      await this.loadSource(message.source, builder);
      this.session = builder.finish();
      this.sessionKey = message.session;
      return this.loaded(message.id, message.session);
    } finally {
      builder.free();
    }
  }

  overlay(
    message: Extract<WorkerRequest, { type: "overlay" }>,
  ): LoadedResponse {
    if (!this.session || this.sessionKey !== message.base)
      throw new Error("The base evaluation session is not loaded.");
    const next = this.session.withOverlay(message.overlay ?? undefined);
    this.release();
    this.session = next;
    this.sessionKey = message.session;
    return this.loaded(message.id, message.session, false);
  }

  advance(
    message: Extract<WorkerRequest, { type: "advance" }>,
  ): LoadedResponse {
    if (!this.session || this.sessionKey !== message.base)
      throw new Error("The base evaluation session is not loaded.");
    const { events, bodies, ...options } = message.input;
    const builder = this.session.fork(options);
    this.release();
    try {
      for (const envelope of events) {
        const { id } = JSON.parse(envelope) as { id: string };
        builder.addRecordText(envelope, bodies[id]);
      }
      this.session = builder.finish();
      this.sessionKey = message.session;
      return this.loaded(message.id, message.session);
    } finally {
      builder.free();
    }
  }

  rank(message: Extract<WorkerRequest, { type: "rank" }>): RankedResponse {
    if (!this.session || this.sessionKey !== message.session)
      throw new Error("The requested evaluation session is not loaded.");
    return {
      type: "ranked",
      id: message.id,
      session: message.session,
      result: this.session.rankWord(message.word, message.reviewers),
    };
  }
}

let initializationFailed = false;
export function workerErrorResponse(
  id: number,
  error: unknown,
): Extract<WorkerResponse, { type: "error" }> {
  return {
    type: "error",
    id,
    message: error instanceof Error ? error.message : String(error),
    session_valid: evaluation.currentSession !== null,
    fatal: initializationFailed || error instanceof WebAssembly.RuntimeError,
  };
}

export const evaluation = new EvaluationWorker();
const ready = initializeCore().catch((error) => {
  initializationFailed = true;
  throw error;
});
self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  const reply = (response: WorkerResponse) => self.postMessage(response);
  try {
    await ready;
    if (message.type === "load") {
      reply(await evaluation.load(message));
    } else if (message.type === "overlay") {
      reply(evaluation.overlay(message));
    } else if (message.type === "advance") {
      reply(evaluation.advance(message));
    } else if (message.type === "rank") {
      reply(evaluation.rank(message));
    }
  } catch (error) {
    reply(workerErrorResponse(message.id, error));
  }
};
