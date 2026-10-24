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
  inspectBody,
  prepareSelection,
  utf8,
  verifyEnvelope,
} from "../../../../packages/core/src/index.ts";
import {
  api,
  getManifest,
  objectBytes,
  type RequestOptions,
  getPreferredView,
} from "./api.ts";
import type { LocalStore } from "./store.ts";
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
  view: string;
  events: string[];
  /** Body hashes the snapshot reports as retained. */
  bodies: string[];
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
    public kind: "missing" | "invalid" | "limit" | "network" | "unavailable",
  ) {
    super(message);
  }
}
const PAGE_LIMIT = 200;
/** Local bounds on one calculation. They are explicit and shown to the user. */
export const RECORD_LIMITS = { events: 50000, bytes: 256 * 1024 * 1024 };
const byteLength = (text: string) => utf8(text).length;
const hashJson = (value: unknown) =>
  contentHash(utf8(canonicalize(utf8(JSON.stringify(value)))));

async function inventoryIds(
  kind: "events" | "bodies" | "import_selections",
  snapshot: string,
  options: RequestOptions,
): Promise<string[]> {
  const ids: string[] = [];
  let after: string | null = null;
  for (let page = 0; page < 1000; page++) {
    options.signal?.throwIfAborted();
    const query = new URLSearchParams({ kind, snapshot, limit: "1000" });
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
    if (ids.length > RECORD_LIMITS.events)
      throw new RecordsError(
        `The snapshot has more than ${RECORD_LIMITS.events} events, above the local calculation limit.`,
        "limit",
      );
    after = value.next as string | null;
    if (after === null) break;
    if (after !== ids[ids.length - 1])
      throw new RecordsError(
        "The inventory cursor did not advance.",
        "invalid",
      );
  }
  return ids;
}
/** Builds a stored record from a verified envelope and an optional body. */
function storedRecord(
  id: string,
  envelopeValue: unknown,
  bodyValue: unknown,
): StoredRecord {
  const envelopeBytes = utf8(JSON.stringify(envelopeValue));
  verifyEnvelope(envelopeBytes);
  const envelope = canonicalize(envelopeBytes);
  const parsed = JSON.parse(envelope) as Envelope;
  if (parsed.id !== id)
    throw new RecordsError(
      "A records item does not match its event ID.",
      "invalid",
    );
  const bodyHash = parsed.header.content?.hash ?? null;
  if (bodyValue === null || bodyValue === undefined)
    return {
      id,
      envelope,
      body: null,
      bodyStatus: bodyHash ? "missing" : "none",
      bodyHash,
    };
  const body = canonicalize(utf8(JSON.stringify(bodyValue)));
  if (
    !parsed.header.content ||
    parsed.header.content.hash !== contentHash(utf8(body)) ||
    parsed.header.content.bytes !== byteLength(body)
  )
    throw new RecordsError(
      `The body of ${id} does not match its signed hash.`,
      "invalid",
    );
  // Authenticated bytes stay even when the current schema cannot interpret
  // them. The shared evaluator applies the format's invalid-content rules, so
  // one unsupported record stays inert instead of disabling the calculation.
  const inspected = inspectBody(utf8(envelope), utf8(body));
  return {
    id,
    envelope,
    body,
    bodyStatus: inspected.availability === "invalid" ? "invalid" : "present",
    bodyHash,
  };
}
/** Upgrades a record cached before body availability was tracked. */
function normalize(record: StoredRecord): StoredRecord {
  if (record.bodyStatus) return record;
  const parsed = JSON.parse(record.envelope) as Envelope;
  const bodyHash = parsed.header.content?.hash ?? null;
  return {
    ...record,
    bodyHash,
    bodyStatus: record.body ? "present" : bodyHash ? "missing" : "none",
  };
}
/**
 * Downloads and verifies the current snapshot's records into the local store.
 * Returns the inventory. Records cached by ID are not fetched again, but a
 * body that the new snapshot reports as retained is fetched when the cached
 * record lacks it. The whole operation honors the caller's signal and the
 * byte bound, which counts cached data in UTF-8 bytes.
 */
export async function syncRecords(
  store: LocalStore,
  options: RequestOptions & {
    fresh?: boolean;
    onProgress?: (progress: RecordsProgress) => void;
  } = {},
): Promise<SnapshotInventory> {
  const progress = options.onProgress ?? (() => {});
  const check = () => options.signal?.throwIfAborted();
  progress({ phase: "inventory", loaded: 0, total: 0, bytes: 0 });
  const manifest = await getManifest(options);
  const snapshot = manifest.snapshot;
  const declared = manifest.manifest as {
    events?: { count?: number; hash?: string };
    bodies?: { count?: number; hash?: string };
    import_selections?: { count?: number; hash?: string };
  };
  const events = await inventoryIds("events", snapshot, options);
  const bodies = await inventoryIds("bodies", snapshot, options);
  const selections = await inventoryIds("import_selections", snapshot, options);
  const bodySet = new Set(bodies);
  // The inventory digests must match the manifest before any record counts.
  if (
    hashJson(bodies) !== declared.bodies?.hash ||
    bodies.length !== declared.bodies?.count ||
    hashJson(selections) !== declared.import_selections?.hash ||
    events.length !== declared.events?.count ||
    hashJson({ events, bodies, import_selections: selections }) !==
      manifest.logical_inventory ||
    hashJson(declared) !== snapshot
  )
    throw new RecordsError(
      "The inventory does not match the manifest digests. The snapshot is inconsistent.",
      "invalid",
    );
  // What is cached, with body availability, and what must be fetched.
  const cached = new Map<string, StoredRecord>();
  let bytes = 0;
  for (const id of events) {
    check();
    const record = await store.get<StoredRecord>("records", id);
    if (!record) continue;
    const normalized = normalize(record);
    cached.set(id, normalized);
    bytes +=
      byteLength(normalized.envelope) + byteLength(normalized.body ?? "");
  }
  const missing = new Set(events.filter((id) => !cached.has(id)));
  // Position lookups by map and set. The inventory is in order, so the first
  // missing record is found by moving a cursor forward, never by sorting.
  const eventIndex = new Map(events.map((id, index) => [id, index]));
  let cursor = 0;
  const missingBodies = events.filter((id) => {
    const record = cached.get(id);
    return (
      record &&
      record.bodyStatus === "missing" &&
      record.bodyHash !== null &&
      bodySet.has(record.bodyHash)
    );
  });
  const bound = () => {
    if (bytes > RECORD_LIMITS.bytes)
      throw new RecordsError(
        `The snapshot exceeds the local calculation limit of ${Math.round(RECORD_LIMITS.bytes / 1048576)} MiB of records.`,
        "limit",
      );
  };
  bound();
  let loaded = events.length - missing.size;
  progress({ phase: "records", loaded, total: events.length, bytes });
  // Page through the records transport. Each page must advance the inventory traversal.
  let pages = 0;
  while (missing.size) {
    check();
    if (++pages > events.length + 1)
      throw new RecordsError(
        "The records transport needed more pages than the inventory has records.",
        "invalid",
      );
    while (cursor < events.length && !missing.has(events[cursor])) cursor++;
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
    if (!page.items.length)
      throw new RecordsError(
        "The server returned an empty records page before the inventory ended.",
        "invalid",
      );
    let previous = after ?? "";
    let advanced = false;
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
      if (!eventIndex.has(item.id))
        throw new RecordsError(
          "The server returned a record outside the inventory.",
          "invalid",
        );
      if (!missing.has(item.id)) continue;
      // A retained body that the server could not read is a server-side
      // failure, not an inventory error. The status names the difference.
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
      const record = storedRecord(item.id, item.envelope, item.body);
      if (record.bodyHash && !bodySet.has(record.bodyHash) && record.body)
        throw new RecordsError(
          "The server supplied a body that its inventory does not list.",
          "invalid",
        );
      bytes += byteLength(record.envelope) + byteLength(record.body ?? "");
      bound();
      await store.put("records", item.id, record);
      cached.set(item.id, record);
      missing.delete(item.id);
      loaded++;
      advanced = true;
    }
    if (!advanced)
      throw new RecordsError(
        "The records page supplied no missing record. The traversal did not advance.",
        "invalid",
      );
    progress({ phase: "records", loaded, total: events.length, bytes });
    if (page.next === null) {
      if (missing.size)
        throw new RecordsError(
          `${missing.size} inventory records are missing from the records transport.`,
          "missing",
        );
      break;
    }
    if (typeof page.next !== "string" || page.next !== previous)
      throw new RecordsError(
        "The records cursor does not name the last returned record.",
        "invalid",
      );
  }
  // Bodies that were missing before and are retained now.
  for (const [index, id] of missingBodies.entries()) {
    check();
    progress({
      phase: "bodies",
      loaded: index,
      total: missingBodies.length,
      bytes,
    });
    const record = cached.get(id)!;
    const raw = await objectBytes(
      `/bodies/${encodeURIComponent(record.bodyHash!)}?snapshot=${encodeURIComponent(snapshot)}`,
      16 * 1024 * 1024,
      options,
    );
    const updated = storedRecord(
      id,
      JSON.parse(record.envelope),
      JSON.parse(new TextDecoder().decode(raw)),
    );
    bytes += byteLength(updated.body ?? "");
    bound();
    await store.put("records", id, updated);
    cached.set(id, updated);
  }
  // Every retained body of a cached record must now be cached.
  for (const id of events) {
    const record = cached.get(id)!;
    if (
      record.bodyStatus === "missing" &&
      record.bodyHash &&
      bodySet.has(record.bodyHash)
    )
      throw new RecordsError(
        `The body of ${id} is listed as retained in the inventory but the records transport reports it as not retained.`,
        "missing",
      );
  }
  // The events digest covers the canonical envelope lines in inventory order.
  const lines = events.map((id) => cached.get(id)!.envelope + "\n").join("");
  if (contentHash(utf8(lines)) !== declared.events?.hash)
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
    const prepared = prepareSelection(raw);
    if (prepared.hash !== hash)
      throw new RecordsError(
        "An import selection did not match its hash.",
        "invalid",
      );
    await store.put("selections", hash, prepared.canonical);
  }
  const chosen = getPreferredView();
  const probe = (await api(
    `/words/jvw1:${"0".repeat(64)}?snapshot=${encodeURIComponent(snapshot)}${chosen ? `&view=${encodeURIComponent(chosen)}` : ""}`,
    options,
  )) as { view?: unknown };
  if (!eventId(probe.view))
    throw new RecordsError(
      "The server did not report its selected view.",
      "invalid",
    );
  const inventory: SnapshotInventory = {
    snapshot,
    logical_inventory: manifest.logical_inventory,
    view: probe.view,
    events,
    bodies,
    selections,
  };
  await store.put("inventory", snapshot, inventory);
  await store.put("inventory", "latest", inventory);
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
    const record = normalize(stored);
    events.push(record.envelope);
    if (record.body && record.bodyHash && bodySet.has(record.bodyHash))
      bodies[id] = record.body;
    else if (record.bodyHash && bodySet.has(record.bodyHash))
      throw new RecordsError(
        `The body of ${id} is retained by the snapshot but not cached. Download the records again.`,
        "missing",
      );
  }
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
  return { events, bodies, selections };
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
  if (!stored) return null;
  const chosen = getPreferredView();
  return chosen && chosen !== stored.view
    ? { ...stored, view: chosen }
    : stored;
}
/** Drops the stored inventory, so the next sync reads the server's selected view again. */
export async function forgetInventory(store: LocalStore): Promise<void> {
  await store.delete("inventory", "latest");
}
