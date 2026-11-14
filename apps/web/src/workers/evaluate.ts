/**
 * Evaluation worker. It loads the shared core, builds one evaluation session
 * from authenticated projection rows and the local overlay, and ranks words on
 * request. Every reply names the session it answers for, so a reply from an
 * older session is never read as the current one.
 * Cancellation terminates the worker, because WebAssembly work is synchronous.
 */
import {
  createEvaluationSession,
  createProjectionDigest,
  createRecordProjector,
  evaluateSession,
  initializeCore,
  projectionBuildIdentity,
  PROJECTION_ROW_VERSION,
  utf8,
  type EvaluationRequest,
  type EvaluationSessionOptions,
} from "../../../../packages/core/src/browser.ts";
import {
  PROJECTION_PRODUCER_KEY,
  projectionSnapshotKey,
} from "../data/projection-meta.ts";

export interface LoadSource {
  database: string;
  snapshot: string;
  events_digest: string;
  count: number;
}
export type AdvanceInput = Omit<EvaluationRequest, "import_selections"> & {
  import_selections?: Record<string, string[]>;
};
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
      input: AdvanceInput;
      source?: LoadSource;
      rows?: { id: string; row: Uint8Array; bodyRetained: boolean }[];
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
      storage_bytes?: number;
      projection_rebuilt?: boolean;
      projection_digest?: string;
    }
  | { type: "ranked"; id: number; session: string; result: unknown }
  | {
      type: "error";
      id: number;
      message: string;
      session_valid: boolean;
      fatal: boolean;
      memory?: boolean;
    };

type LoadedResponse = Extract<WorkerResponse, { type: "loaded" }>;
type RankedResponse = Extract<WorkerResponse, { type: "ranked" }>;
type Session = ReturnType<typeof evaluateSession>;
type Builder = ReturnType<typeof createEvaluationSession>;
interface SourceLoad {
  count: number;
  bytesRead: number;
  digest: string;
}
type SourceLoader = (
  source: LoadSource,
  builder: Builder,
  loadSelections?: boolean,
) => Promise<SourceLoad>;

interface StoredInventory {
  events: string[];
  bodies: string[];
  selections?: string[];
  events_digest: string;
}
interface StoredRecord {
  id: string;
  envelope: string;
  body: string | null;
  bodyHash: string | null;
}
interface ProjectionMeta {
  version: number;
  build: string;
  events_digest: string;
  rows_hash: string | null;
  count: number;
}
class ProjectionRebuildNeeded extends Error {}
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
function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(name);
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error);
    opening.onblocked = () =>
      reject(new Error("Local storage is blocked by another open tab."));
  });
}
async function assertProjectionProducer(database: IDBDatabase) {
  const producer = await request(
    database
      .transaction("meta", "readonly")
      .objectStore("meta")
      .get(PROJECTION_PRODUCER_KEY) as IDBRequest<string | undefined>,
  );
  if (producer !== projectionBuildIdentity())
    throw new Error("Projection rows come from another core build.");
}
async function readInventory(
  transaction: IDBTransaction,
  source: LoadSource,
): Promise<StoredInventory> {
  const stored = await request(
    transaction.objectStore("inventory").get(source.snapshot) as IDBRequest<
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
        typeof id !== "string" || (index > 0 && id <= stored.events[index - 1]),
    )
  )
    throw new Error("The inventory is not in order.");
  return stored;
}
async function readBatch<T>(
  store: IDBObjectStore,
  after: string | undefined,
): Promise<{ id: string; value: T }[]> {
  const range =
    after === undefined ? undefined : IDBKeyRange.lowerBound(after, true);
  const [keys, values] = await Promise.all([
    request(store.getAllKeys(range, BATCH_SIZE)),
    request(store.getAll(range, BATCH_SIZE) as IDBRequest<T[]>),
  ]);
  return keys.map((key, index) => ({ id: String(key), value: values[index] }));
}
function rowBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new ProjectionRebuildNeeded("A projection row is not binary data.");
}
async function readProjectionRows(
  database: IDBDatabase,
  source: LoadSource,
  builder: Builder,
  loadSelections = true,
): Promise<SourceLoad> {
  const hasSelectionsStore = database.objectStoreNames.contains("selections");
  const transaction = database.transaction(
    hasSelectionsStore
      ? ["inventory", "projections", "selections", "meta"]
      : ["inventory", "projections", "meta"],
    "readonly",
  );
  const stored = await readInventory(transaction, source);
  const metaStore = transaction.objectStore("meta");
  const [meta, producer] = await Promise.all([
    request(
      metaStore.get(projectionSnapshotKey(source.snapshot)) as IDBRequest<
        ProjectionMeta | undefined
      >,
    ),
    request(
      metaStore.get(PROJECTION_PRODUCER_KEY) as IDBRequest<string | undefined>,
    ),
  ]);
  if (producer !== projectionBuildIdentity())
    throw new ProjectionRebuildNeeded("Projection producer is stale.");
  if (
    !meta ||
    meta.version !== PROJECTION_ROW_VERSION ||
    meta.build !== projectionBuildIdentity() ||
    meta.events_digest !== source.events_digest ||
    meta.count !== source.count ||
    typeof meta.rows_hash !== "string"
  )
    throw new ProjectionRebuildNeeded("Projection metadata is stale.");
  if (loadSelections) {
    builder.clearImportSelections();
    for (const hash of stored.selections ?? []) {
      const canonical = hasSelectionsStore
        ? await request(
            transaction.objectStore("selections").get(hash) as IDBRequest<
              string | undefined
            >,
          )
        : undefined;
      if (typeof canonical !== "string" || !canonical)
        throw new Error(`Import selection ${hash} is not cached.`);
      builder.setImportSelection(hash, canonical);
    }
  }
  if (Array.isArray(stored.selections)) stored.selections.length = 0;
  builder.setRetainedBodies(stored.bodies);
  stored.bodies.length = 0;
  const projectionStore = transaction.objectStore("projections");
  const digest = createProjectionDigest();
  let digestFinished = false;
  try {
    let bytesRead = 0;
    let index = 0;
    let after: string | undefined;
    for (;;) {
      const batch = await readBatch<unknown>(projectionStore, after);
      if (batch.length === 0) break;
      for (const { id, value } of batch) {
        const bytes = rowBytes(value);
        bytesRead += bytes.byteLength;
        const expected = stored.events[index];
        if (id !== expected) {
          if (expected === undefined || id < expected) {
            after = id;
            continue;
          }
          throw new ProjectionRebuildNeeded("A projection row is missing.");
        }
        digest.update(id, bytes);
        try {
          builder.addProjectionRow(bytes, id);
        } catch (error) {
          throw new ProjectionRebuildNeeded(
            error instanceof Error ? error.message : String(error),
          );
        }
        index++;
        after = id;
      }
      if (index === stored.events.length || batch.length < BATCH_SIZE) break;
    }
    if (index !== stored.events.length)
      throw new ProjectionRebuildNeeded("A projection row is missing.");
    stored.events.length = 0;
    digestFinished = true;
    const actualHash = digest.finish();
    if (actualHash !== meta.rows_hash)
      throw new ProjectionRebuildNeeded(
        "The projection digest does not match.",
      );
    return { count: index, bytesRead, digest: actualHash };
  } finally {
    if (!digestFinished) digest.free();
  }
}
function readStoredRecords(
  source: LoadSource,
  builder: Builder,
  loadSelections = true,
) {
  return openDatabase(source.database).then(async (database) => {
    try {
      return await readProjectionRows(database, source, builder, loadSelections);
    } finally {
      database.close();
    }
  });
}
async function rebuildStoredProjection(source: LoadSource): Promise<number> {
  const database = await openDatabase(source.database);
  const projector = createRecordProjector();
  try {
    const transaction = database.transaction(
      ["inventory", "records", "projections", "meta"],
      "readwrite",
    );
    const completion = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => {};
    });
    void completion.catch(() => {});
    let bytesRead = 0;
    try {
      const stored = await readInventory(transaction, source);
      const recordStore = transaction.objectStore("records");
      const projectionStore = transaction.objectStore("projections");
      projectionStore.clear();
      const bodies = new Set(stored.bodies);
      const digest = createProjectionDigest();
      let digestFinished = false;
      try {
        let index = 0;
        let after: string | undefined;
        for (;;) {
          const batch = await readBatch<StoredRecord>(recordStore, after);
          if (batch.length === 0) break;
          for (const { id, value: record } of batch) {
            bytesRead += utf8(record?.envelope ?? "").byteLength;
            bytesRead += utf8(record?.body ?? "").byteLength;
            const expected = stored.events[index];
            if (id !== expected) {
              if (expected === undefined || id < expected) {
                after = id;
                continue;
              }
              throw missingRecord(expected);
            }
            if (!record || record.id !== id) throw missingRecord(id);
            if (record.bodyHash && bodies.has(record.bodyHash) && !record.body)
              throw new Error(
                `The body of ${id} is retained by the snapshot but not cached. Download the records again.`,
              );
            const body = record.body ?? undefined;
            const projected = projector.project(
              utf8(record.envelope),
              body === undefined ? undefined : utf8(body),
            );
            if ((JSON.parse(projected.envelope) as { id: string }).id !== id)
              throw missingRecord(id);
            digest.update(id, projected.row);
            projectionStore.put(projected.row, id);
            index++;
            after = id;
          }
          if (index === stored.events.length || batch.length < BATCH_SIZE)
            break;
        }
        if (index !== stored.events.length)
          throw missingRecord(stored.events[index]);
        digestFinished = true;
        const rowsHash = digest.finish();
        const meta = transaction.objectStore("meta");
        meta.put(projectionBuildIdentity(), PROJECTION_PRODUCER_KEY);
        meta.put(
          {
            version: PROJECTION_ROW_VERSION,
            build: projectionBuildIdentity(),
            events_digest: source.events_digest,
            rows_hash: rowsHash,
            count: index,
          },
          projectionSnapshotKey(source.snapshot),
        );
      } finally {
        if (!digestFinished) digest.free();
      }
    } catch (error) {
      transaction.abort();
      throw error;
    }
    await completion;
    return bytesRead;
  } finally {
    projector.free();
    database.close();
  }
}
async function checkProjectionProducer(source: LoadSource): Promise<void> {
  const database = await openDatabase(source.database);
  try {
    await assertProjectionProducer(database);
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
    private readonly producerCheck: (
      source: LoadSource,
    ) => Promise<void> = checkProjectionProducer,
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
    storage?: { bytesRead: number; rebuilt: boolean; digest: string },
  ): LoadedResponse {
    if (!this.session) throw new Error("The evaluation session is not loaded.");
    return {
      type: "loaded",
      id,
      session: key,
      ...this.session.summary(),
      ...(includeActors ? { actors: this.session.actors() } : {}),
      ...(storage
        ? {
            storage_bytes: storage.bytesRead,
            projection_rebuilt: storage.rebuilt,
            projection_digest: storage.digest,
          }
        : {}),
    };
  }

  async load(
    message: Extract<WorkerRequest, { type: "load" }>,
  ): Promise<LoadedResponse> {
    this.release();
    const loadSelections = message.options.import_selections === undefined;
    let builder = this.createSession(message.options);
    let rebuilt = false;
    let rebuildBytes = 0;
    try {
      let loaded: SourceLoad;
      try {
        loaded = await this.loadSource(message.source, builder, loadSelections);
      } catch (error) {
        if (!(error instanceof ProjectionRebuildNeeded)) throw error;
        builder.free();
        rebuilt = true;
        rebuildBytes = await rebuildStoredProjection(message.source);
        builder = this.createSession(message.options);
        loaded = await this.loadSource(message.source, builder, loadSelections);
      }
      this.session = builder.finish();
      this.sessionKey = message.session;
      return this.loaded(message.id, message.session, true, {
        bytesRead: rebuildBytes + loaded.bytesRead,
        rebuilt,
        digest: loaded.digest,
      });
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

  async advance(
    message: Extract<WorkerRequest, { type: "advance" }>,
  ): Promise<LoadedResponse> {
    if (!this.session || this.sessionKey !== message.base)
      throw new Error("The base evaluation session is not loaded.");
    if (message.rows?.length) {
      if (!message.source)
        throw new Error("Projection advance has no inventory source.");
      await this.producerCheck(message.source);
    }
    const { events, bodies, ...options } = message.input;
    const builder = this.session.fork(options);
    this.release();
    try {
      for (const { id, row, bodyRetained } of message.rows ?? [])
        builder.addProjectionRow(row, id, bodyRetained);
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
  const rawMessage = error instanceof Error ? error.message : String(error);
  const memoryError =
    error instanceof WebAssembly.RuntimeError ||
    (error instanceof RangeError &&
      /out of memory|allocation|buffer|invalid string length/i.test(
        rawMessage,
      )) ||
    /out of memory|array buffer allocation failed|invalid array buffer length|invalid string length|WebAssembly\.RuntimeError/i.test(
      rawMessage,
    );
  const message =
    error instanceof WebAssembly.RuntimeError &&
    !/WebAssembly\.RuntimeError|trap/i.test(rawMessage)
      ? rawMessage
        ? `WebAssembly.RuntimeError: ${rawMessage}`
        : "WebAssembly.RuntimeError"
      : rawMessage;
  return {
    type: "error",
    id,
    message,
    session_valid: evaluation.currentSession !== null,
    fatal: initializationFailed || memoryError,
    memory: memoryError,
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
      reply(await evaluation.advance(message));
    } else if (message.type === "rank") {
      reply(evaluation.rank(message));
    }
  } catch (error) {
    reply(workerErrorResponse(message.id, error));
  }
};
