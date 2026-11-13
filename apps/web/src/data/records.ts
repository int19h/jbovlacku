/**
 * Snapshot records for local calculation. Pages come from the records
 * transport. Every envelope and body is authenticated through the shared core
 * and cached by event ID, with the body availability kept separately. The
 * downloaded set is compared with the snapshot inventory and its digests
 * before a calculation is called complete.
 */
import {
  canonicalize,
  contentHash,
  createContentDigest,
  createRecordProjector,
  prepareSelectionCanonical,
  projectRecord,
  utf8,
} from "../../../../packages/core/src/browser.ts";
import {
  api,
  getManifest,
  objectBytes,
  type RequestOptions,
  getPreferredView,
} from "./api.ts";
import { findSortedId, hasSortedId, type LocalStore } from "./store.ts";
import { eventId, hashId, type Envelope } from "../model/types.ts";

export interface StoredRecord {
  id: string;
  /** Canonical envelope JSON. */
  envelope: string;
  /** Canonical body JSON, or null when no valid body is cached. */
  body: string | null;
  /**
   * "present" with a body that the current schema interprets, "invalid" with
   * authenticated body bytes that it cannot interpret, "missing" when the
   * header requires a body that is not cached, "none" when it requires none.
   */
  bodyStatus: "present" | "missing" | "none" | "invalid";
  /** The required body hash from the header, or null. */
  bodyHash: string | null;
}
export interface SnapshotInventory {
  snapshot: string;
  logical_inventory: string;
  events_digest: string;
  view: string;
  events: string[];
  /** Body hashes the snapshot reports as retained. */
  bodies: string[];
  /** Required body hashes that the snapshot does not retain. */
  unretained_bodies?: string[];
  selections: string[];
}
export interface RecordsProgress {
  phase: "inventory" | "records" | "bodies" | "selections" | "done";
  loaded: number;
  total: number;
  bytes: number;
}
export class RecordsError extends Error {
  constructor(
    message: string,
    public kind:
      | "missing"
      | "invalid"
      | "limit"
      | "network"
      | "unavailable"
      | "storage"
      | "memory",
  ) {
    super(message);
  }
}
const INVENTORY_PAGE_LIMIT = 1000;
const PAGE_LIMIT = 200;
const READ_BATCH = 256;
const MAX_BODY_BYTES = 262144;
const STATE_MISSING = 0;
const STATE_READY = 1;
const STATE_MISSING_RETAINED_BODY = 2;
const byteLength = (text: string) => utf8(text).length;
const hashJson = (value: unknown) =>
  contentHash(utf8(canonicalize(utf8(JSON.stringify(value)))));

function updateCanonicalIdArray(
  digest: ReturnType<typeof createContentDigest>,
  ids: readonly string[],
  pageSize = INVENTORY_PAGE_LIMIT,
): void {
  digest.update(utf8("["));
  for (let start = 0; start < ids.length; start += pageSize) {
    const page = ids.slice(start, start + pageSize);
    const prefix = start === 0 ? '"' : ',"';
    digest.update(utf8(prefix + page.join('","') + '"'));
  }
  digest.update(utf8("]"));
}

export function hashInventoryIds(
  ids: readonly string[],
  pageSize = INVENTORY_PAGE_LIMIT,
): string {
  const digest = createContentDigest();
  updateCanonicalIdArray(digest, ids, pageSize);
  return digest.finish();
}

export function hashLogicalInventory(
  inventory: {
    events: readonly string[];
    bodies: readonly string[];
    import_selections: readonly string[];
  },
  pageSize = INVENTORY_PAGE_LIMIT,
): string {
  const digest = createContentDigest();
  digest.update(utf8('{"bodies":'));
  updateCanonicalIdArray(digest, inventory.bodies, pageSize);
  digest.update(utf8(',"events":'));
  updateCanonicalIdArray(digest, inventory.events, pageSize);
  digest.update(utf8(',"import_selections":'));
  updateCanonicalIdArray(digest, inventory.import_selections, pageSize);
  digest.update(utf8("}"));
  return digest.finish();
}

async function inventoryIds(
  kind: "events" | "bodies" | "import_selections",
  snapshot: string,
  options: RequestOptions,
): Promise<string[]> {
  const ids: string[] = [];
  let after: string | null = null;
  for (;;) {
    options.signal?.throwIfAborted();
    const query = new URLSearchParams({
      kind,
      snapshot,
      limit: String(INVENTORY_PAGE_LIMIT),
    });
    if (after) query.set("after", after);
    const value = (await api(`/inventory?${query}`, options)) as {
      snapshot?: string;
      kind?: string;
      ids?: unknown;
      next?: unknown;
    };
    if (
      value.snapshot !== snapshot ||
      value.kind !== kind ||
      !Array.isArray(value.ids) ||
      !(value.next === null || typeof value.next === "string")
    )
      throw new RecordsError(
        "The server returned an invalid inventory page.",
        "invalid",
      );
    if (value.ids.length > INVENTORY_PAGE_LIMIT)
      throw new RecordsError(
        "The server returned an inventory page outside the per-page bound.",
        "invalid",
      );
    for (const id of value.ids) {
      if (kind === "events" ? !eventId(id) : !hashId(id))
        throw new RecordsError(
          "The inventory names an invalid identifier.",
          "invalid",
        );
      if (ids.length && id <= ids[ids.length - 1])
        throw new RecordsError("The inventory is not in order.", "invalid");
      ids.push(id);
    }
    after = value.next as string | null;
    if (after === null) break;
    if (!value.ids.length || after !== ids[ids.length - 1])
      throw new RecordsError(
        "The inventory cursor did not advance.",
        "invalid",
      );
  }
  return ids;
}
type Project = typeof projectRecord;
type SyncOptions = RequestOptions & {
  fresh?: boolean;
  onProgress?: (progress: RecordsProgress) => void;
};

async function readRecords(store: LocalStore, ids: string[]) {
  if (typeof store.readRecords === "function") return store.readRecords(ids);
  return Promise.all(ids.map((id) => store.get<StoredRecord>("records", id)));
}
async function writeRecords(
  store: LocalStore,
  records: { record: StoredRecord; row: Uint8Array }[],
  latest: SnapshotInventory | null,
) {
  if (typeof store.putProjectedRecords === "function") {
    await store.putProjectedRecords(records, latest);
    return;
  }
  for (const projected of records)
    await store.putProjectedRecord(projected.record, projected.row, latest);
}
function physicalFailure(error: unknown): never {
  if (error instanceof RecordsError) throw error;
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? String(error.name)
      : "";
  const message = error instanceof Error ? error.message : String(error);
  if (name === "QuotaExceededError" || /storage quota/i.test(message))
    throw new RecordsError(
      "The browser storage quota is full. Free storage for this site, then recompute from records.",
      "storage",
    );
  if (
    /out of memory|array buffer allocation failed|invalid array buffer length/i.test(
      message,
    )
  )
    throw new RecordsError(
      "The browser ran out of memory while syncing records. Close other tabs or use a device with more memory, then recompute from records.",
      "memory",
    );
  throw error;
}

/** Authenticates one record and builds its stored record and projection together. */
function storedRecord(
  id: string,
  envelopeValue: unknown,
  bodyValue: unknown,
  project: Project = projectRecord,
): { record: StoredRecord; row: Uint8Array } {
  const body =
    bodyValue === null || bodyValue === undefined
      ? null
      : canonicalize(utf8(JSON.stringify(bodyValue)));
  const projected = project(
    utf8(JSON.stringify(envelopeValue)),
    body === null ? undefined : utf8(body),
  );
  const parsed = JSON.parse(projected.envelope) as Envelope;
  if (parsed.id !== id)
    throw new RecordsError(
      "A records item does not match its event ID.",
      "invalid",
    );
  const bodyHash = parsed.header.content?.hash ?? null;
  if (
    body !== null &&
    (!parsed.header.content ||
      parsed.header.content.hash !== contentHash(utf8(body)) ||
      parsed.header.content.bytes !== byteLength(body))
  )
    throw new RecordsError(
      `The body of ${id} does not match its signed hash.`,
      "invalid",
    );
  // Authenticated bytes stay even when the current schema cannot interpret
  // them. The shared evaluator applies the format's invalid-content rules, so
  // one unsupported record stays inert instead of disabling the calculation.
  return {
    record: {
      id,
      envelope: projected.envelope,
      body,
      bodyStatus: projected.bodyStatus,
      bodyHash,
    },
    row: projected.row,
  };
}
/**
 * Downloads and verifies the current snapshot's records into the local store.
 * Cached records are read in bounded batches and are not downloaded again.
 * New records and projection rows are committed one transport page at a time.
 */
export async function syncRecords(
  store: LocalStore,
  options: SyncOptions = {},
): Promise<SnapshotInventory> {
  let projector: ReturnType<typeof createRecordProjector> | undefined;
  try {
    projector = createRecordProjector();
    return await syncProjectedRecords(store, options, projector.project);
  } catch (error) {
    return physicalFailure(error);
  } finally {
    projector?.free();
  }
}
async function syncProjectedRecords(
  store: LocalStore,
  options: SyncOptions,
  project: Project,
): Promise<SnapshotInventory> {
  const progress = options.onProgress ?? (() => {});
  const check = () => options.signal?.throwIfAborted();
  progress({ phase: "inventory", loaded: 0, total: 0, bytes: 0 });
  const manifest = await getManifest(options);
  const snapshot = manifest.snapshot;
  const latest =
    (await store.get<SnapshotInventory>("inventory", "latest")) ?? null;
  const declared = manifest.manifest as {
    events?: { count?: number; hash?: string };
    bodies?: { count?: number; hash?: string };
    import_selections?: { count?: number; hash?: string };
  };
  const events = await inventoryIds("events", snapshot, options);
  const bodies = await inventoryIds("bodies", snapshot, options);
  const selections = await inventoryIds("import_selections", snapshot, options);
  if (
    hashInventoryIds(bodies) !== declared.bodies?.hash ||
    bodies.length !== declared.bodies?.count ||
    hashInventoryIds(selections) !== declared.import_selections?.hash ||
    events.length !== declared.events?.count ||
    hashLogicalInventory({
      events,
      bodies,
      import_selections: selections,
    }) !== manifest.logical_inventory ||
    hashJson(declared) !== snapshot
  )
    throw new RecordsError(
      "The inventory does not match the manifest digests. The snapshot is inconsistent.",
      "invalid",
    );
  const state = new Uint8Array(events.length);
  let missingCount = events.length;
  const missingBodies: { index: number; id: string; bodyHash: string }[] = [];
  const unretainedBodies = new Set<string>();
  const eventsDigest = createContentDigest();
  let digestCursor = 0;
  const advanceDigest = async (
    writes: readonly { record: StoredRecord; index: number }[],
  ) => {
    let writePos = 0;
    while (
      digestCursor < events.length &&
      state[digestCursor] !== STATE_MISSING
    ) {
      while (writePos < writes.length && writes[writePos].index < digestCursor)
        writePos++;
      if (writePos < writes.length && writes[writePos].index === digestCursor) {
        eventsDigest.update(utf8(writes[writePos].record.envelope + "\n"));
        digestCursor++;
        writePos++;
        continue;
      }
      const limit =
        writePos < writes.length ? writes[writePos].index : events.length;
      let end = digestCursor + 1;
      while (
        end < limit &&
        end - digestCursor < READ_BATCH &&
        state[end] !== STATE_MISSING
      )
        end++;
      check();
      const cached = await readRecords(store, events.slice(digestCursor, end));
      for (let offset = 0; offset < end - digestCursor; offset++) {
        const record = cached[offset];
        const id = events[digestCursor + offset];
        if (!record || record.id !== id)
          throw new RecordsError(
            `Record ${id} is not cached. Download the records again.`,
            "missing",
          );
        eventsDigest.update(utf8(record.envelope + "\n"));
      }
      cached.length = 0;
      digestCursor = end;
    }
  };
  let bytes = 0;
  for (let start = 0; start < events.length; start += READ_BATCH) {
    check();
    const records = await readRecords(
      store,
      events.slice(start, start + READ_BATCH),
    );
    for (const [offset, record] of records.entries()) {
      const index = start + offset;
      if (!record || record.id !== events[index]) continue;
      const retainedBody =
        record.bodyHash !== null && hasSortedId(bodies, record.bodyHash);
      if (record.bodyHash !== null && !retainedBody)
        unretainedBodies.add(record.bodyHash);
      if (record.bodyStatus === "missing" && retainedBody) {
        state[index] = STATE_MISSING_RETAINED_BODY;
        missingBodies.push({
          index,
          id: record.id,
          bodyHash: record.bodyHash!,
        });
      } else {
        state[index] = STATE_READY;
      }
      missingCount--;
      if (index === digestCursor) {
        eventsDigest.update(utf8(record.envelope + "\n"));
        digestCursor++;
      }
      bytes += byteLength(record.envelope) + byteLength(record.body ?? "");
    }
    records.length = 0;
  }
  let cursor = 0;
  let loaded = events.length - missingCount;
  progress({ phase: "records", loaded, total: events.length, bytes });
  while (missingCount > 0) {
    check();
    while (cursor < events.length && state[cursor] !== STATE_MISSING) cursor++;
    const index = cursor;
    const after = index > 0 ? events[index - 1] : null;
    const query = new URLSearchParams({ snapshot, limit: String(PAGE_LIMIT) });
    if (after) query.set("after", after);
    const page = (await api(`/records?${query}`, {
      ...options,
      timeoutMs: 120000,
    })) as { snapshot?: string; items?: unknown; next?: unknown };
    if (page.snapshot !== snapshot || !Array.isArray(page.items))
      throw new RecordsError(
        "The server returned an invalid records page.",
        "invalid",
      );
    if (!page.items.length || page.items.length > PAGE_LIMIT)
      throw new RecordsError(
        "The server returned a records page outside the per-page bound.",
        "invalid",
      );
    let previous = after ?? "";
    const writes: {
      record: StoredRecord;
      row: Uint8Array;
      index: number;
      retainedBody: boolean;
    }[] = [];
    for (const item of page.items as {
      id?: unknown;
      envelope?: unknown;
      body?: unknown;
    }[]) {
      check();
      if (!eventId(item.id) || !item.envelope)
        throw new RecordsError("A records item is malformed.", "invalid");
      if (item.id <= previous)
        throw new RecordsError(
          "The records page did not advance past the requested position.",
          "invalid",
        );
      previous = item.id;
      const itemIndex = findSortedId(events, item.id);
      if (itemIndex < 0)
        throw new RecordsError(
          "The server returned a record outside the inventory.",
          "invalid",
        );
      if (state[itemIndex] !== STATE_MISSING) continue;
      const bodyStatus = (item as { body_status?: unknown }).body_status;
      if (
        item.body == null &&
        typeof bodyStatus === "string" &&
        !["present", "missing", "none"].includes(bodyStatus)
      )
        throw new RecordsError(
          `The server could not read the retained body of ${item.id} (status "${bodyStatus}"). The inventory is not at fault. Try the download again later.`,
          "unavailable",
        );
      const projected = storedRecord(
        item.id,
        item.envelope,
        item.body,
        project,
      );
      const record = projected.record;
      const retainedBody =
        record.bodyHash !== null && hasSortedId(bodies, record.bodyHash);
      if (record.bodyHash && !retainedBody && record.body)
        throw new RecordsError(
          "The server supplied a body that its inventory does not list.",
          "invalid",
        );
      bytes += byteLength(record.envelope) + byteLength(record.body ?? "");
      writes.push({ ...projected, index: itemIndex, retainedBody });
    }
    if (page.next === null && missingCount > writes.length)
      throw new RecordsError(
        `${missingCount - writes.length} inventory records are missing from the records transport.`,
        "missing",
      );
    if (!writes.length)
      throw new RecordsError(
        "The records page supplied no missing record. The traversal did not advance.",
        "invalid",
      );
    await writeRecords(store, writes, latest);
    for (const { record, index: itemIndex, retainedBody } of writes) {
      if (record.bodyHash !== null && !retainedBody)
        unretainedBodies.add(record.bodyHash);
      state[itemIndex] =
        record.bodyStatus === "missing" && retainedBody
          ? STATE_MISSING_RETAINED_BODY
          : STATE_READY;
      missingCount--;
      loaded++;
    }
    await advanceDigest(writes);
    writes.length = 0;
    progress({ phase: "records", loaded, total: events.length, bytes });
    if (page.next === null) break;
    if (typeof page.next !== "string" || page.next !== previous)
      throw new RecordsError(
        "The records cursor does not name the last returned record.",
        "invalid",
      );
  }
  for (const [index, target] of missingBodies.entries()) {
    check();
    progress({
      phase: "bodies",
      loaded: index,
      total: missingBodies.length,
      bytes,
    });
    const [record] = await readRecords(store, [target.id]);
    if (!record)
      throw new RecordsError(
        `Record ${target.id} is not cached. Download the records again.`,
        "missing",
      );
    const raw = await objectBytes(
      `/bodies/${encodeURIComponent(target.bodyHash)}?snapshot=${encodeURIComponent(snapshot)}`,
      MAX_BODY_BYTES,
      options,
    );
    const updated = storedRecord(
      target.id,
      JSON.parse(record.envelope),
      JSON.parse(new TextDecoder().decode(raw)),
      project,
    );
    bytes += byteLength(updated.record.body ?? "");
    await writeRecords(store, [updated], latest);
    state[target.index] =
      updated.record.bodyStatus === "missing"
        ? STATE_MISSING_RETAINED_BODY
        : STATE_READY;
  }
  const missingRetainedIndex = state.indexOf(STATE_MISSING_RETAINED_BODY);
  if (missingRetainedIndex >= 0)
    throw new RecordsError(
      `The body of ${events[missingRetainedIndex]} is listed as retained in the inventory but the records transport reports it as not retained.`,
      "missing",
    );
  const missingRecordIndex = state.indexOf(STATE_MISSING);
  if (missingRecordIndex >= 0 || digestCursor !== events.length)
    throw new RecordsError(
      `Record ${events[missingRecordIndex >= 0 ? missingRecordIndex : digestCursor]} is not cached. Download the records again.`,
      "missing",
    );
  if (eventsDigest.finish() !== declared.events?.hash)
    throw new RecordsError(
      "The downloaded envelopes do not match the manifest's events digest.",
      "invalid",
    );
  // Import selections, cached by hash.
  const cachedSelections = new Set(await store.keys("selections"));
  for (const [index, hash] of selections.entries()) {
    check();
    progress({
      phase: "selections",
      loaded: index,
      total: selections.length,
      bytes,
    });
    if (cachedSelections.has(hash)) continue;
    const raw = await objectBytes(
      `/import-selections/${encodeURIComponent(hash)}?snapshot=${encodeURIComponent(snapshot)}`,
      16 * 1024 * 1024,
      options,
    );
    const prepared = prepareSelectionCanonical(raw);
    if (prepared.hash !== hash)
      throw new RecordsError(
        "An import selection did not match its hash.",
        "invalid",
      );
    await store.put("selections", hash, prepared.canonical);
  }
  let view: unknown = getPreferredView() ?? manifest.view;
  if (view === undefined)
    view = (
      (await api(
        `/words/jvw1:${"0".repeat(64)}?snapshot=${encodeURIComponent(snapshot)}`,
        options,
      )) as { view?: unknown }
    ).view;
  if (!eventId(view) || view === "jve1:" + "0".repeat(64))
    throw new RecordsError(
      "The server did not report its selected view.",
      "invalid",
    );
  const inventory: SnapshotInventory = {
    snapshot,
    logical_inventory: manifest.logical_inventory,
    events_digest: declared.events.hash!,
    view,
    events,
    bodies,
    unretained_bodies: [...unretainedBodies].sort(),
    selections,
  };
  if (typeof store.commitInventory === "function")
    await store.commitInventory(inventory);
  else {
    await store.put("inventory", snapshot, inventory);
    await store.put("inventory", "latest", inventory);
  }
  progress({
    phase: "done",
    loaded: events.length,
    total: events.length,
    bytes,
  });
  return inventory;
}
/** Reads the cached records of an inventory. Throws when any record or retained body is missing. */
export async function loadRecords(
  store: LocalStore,
  inventory: SnapshotInventory,
  options: { signal?: AbortSignal } = {},
): Promise<{
  events: string[];
  bodies: Record<string, string>;
  selections: Record<string, string[]>;
}> {
  const events: string[] = [];
  const bodies: Record<string, string> = {};
  if (!Array.isArray(inventory.bodies))
    throw new RecordsError(
      "The cached inventory predates body tracking. Download the records again.",
      "missing",
    );
  // Only bodies that this snapshot retains take part. Other cached bodies stay cached for other snapshots.
  const bodySet = new Set(inventory.bodies);
  for (const id of inventory.events) {
    // A cancelled calculation stops here too, before every cached read.
    options.signal?.throwIfAborted();
    const stored = await store.get<StoredRecord>("records", id);
    if (!stored)
      throw new RecordsError(
        `Record ${id} is not cached. Download the records again.`,
        "missing",
      );
    events.push(stored.envelope);
    if (stored.body && stored.bodyHash && bodySet.has(stored.bodyHash))
      bodies[id] = stored.body;
    else if (stored.bodyHash && bodySet.has(stored.bodyHash))
      throw new RecordsError(
        `The body of ${id} is retained by the snapshot but not cached. Download the records again.`,
        "missing",
      );
  }
  const selections = await loadSelections(store, inventory, options);
  return { events, bodies, selections };
}
/** Reads only import selections, leaving record authentication in the worker. */
export async function loadSelections(
  store: LocalStore,
  inventory: SnapshotInventory,
  options: { signal?: AbortSignal } = {},
): Promise<Record<string, string[]>> {
  const selections: Record<string, string[]> = {};
  for (const hash of inventory.selections) {
    options.signal?.throwIfAborted();
    const canonical = await store.get<string>("selections", hash);
    if (!canonical)
      throw new RecordsError(
        `Import selection ${hash} is not cached.`,
        "missing",
      );
    selections[hash] = JSON.parse(canonical) as string[];
  }
  return selections;
}
/**
 * The stored inventory of the last sync. Its records do not depend on the
 * view, so a view the reader chose by ID rebinds it; a stored inventory from
 * another chosen view never answers for the chosen one.
 */
export async function latestInventory(
  store: LocalStore,
): Promise<SnapshotInventory | null> {
  const stored = await store.get<SnapshotInventory>("inventory", "latest");
  if (!stored || typeof stored.events_digest !== "string") return null;
  const chosen = getPreferredView();
  return chosen && chosen !== stored.view
    ? { ...stored, view: chosen }
    : stored;
}
/** Drops the stored inventory, so the next sync reads the server's selected view again. */
export async function forgetInventory(store: LocalStore): Promise<void> {
  await store.delete("inventory", "latest");
  await store.delete("meta", "projection:latest");
}
