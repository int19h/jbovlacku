/**
 * Snapshot records for local calculation. Pages come from the records
 * transport. Every envelope and body is authenticated through the shared core
 * and cached by event ID. The set is compared with the snapshot inventory
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
import { api, getManifest, objectBytes, type RequestOptions } from "./api.ts";
import type { LocalStore } from "./store.ts";
import { eventId, hashId, type Envelope } from "../model/types.ts";

export interface StoredRecord {
  id: string;
  /** Canonical envelope JSON. */
  envelope: string;
  /** Canonical body JSON, or null when the server has no body. */
  body: string | null;
}
export interface SnapshotInventory {
  snapshot: string;
  logical_inventory: string;
  view: string;
  events: string[];
  selections: string[];
}
export interface RecordsProgress {
  phase: "inventory" | "records" | "selections" | "done";
  loaded: number;
  total: number;
  bytes: number;
}
export class RecordsError extends Error {
  constructor(
    message: string,
    public kind: "missing" | "invalid" | "limit" | "network",
  ) {
    super(message);
  }
}
const PAGE_LIMIT = 200;
/** Local bounds on one calculation. They are explicit and shown to the user. */
export const RECORD_LIMITS = { events: 50000, bytes: 256 * 1024 * 1024 };

async function inventoryIds(
  kind: "events" | "import_selections",
  snapshot: string,
  options: RequestOptions,
): Promise<string[]> {
  const ids: string[] = [];
  let after: string | null = null;
  for (let page = 0; page < 1000; page++) {
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
/**
 * Downloads and verifies the current snapshot's records into the local store.
 * Returns the inventory. Records already cached by ID are not fetched again.
 */
export async function syncRecords(
  store: LocalStore,
  options: RequestOptions & {
    onProgress?: (progress: RecordsProgress) => void;
  } = {},
): Promise<SnapshotInventory> {
  const progress = options.onProgress ?? (() => {});
  const manifest = await getManifest(options);
  const snapshot = manifest.snapshot;
  progress({ phase: "inventory", loaded: 0, total: 0, bytes: 0 });
  const events = await inventoryIds("events", snapshot, options);
  const selections = await inventoryIds("import_selections", snapshot, options);
  const cachedIds = new Set(await store.keys("records"));
  const missing = events.filter((id) => !cachedIds.has(id));
  let bytes = 0;
  let loaded = events.length - missing.length;
  progress({ phase: "records", loaded, total: events.length, bytes });
  // Page through the records transport. Only pages that contain missing records are fetched.
  let after: string | null = null;
  const missingSet = new Set(missing);
  while (missingSet.size) {
    // Start the page just before the first missing ID in inventory order.
    const first = [...missingSet].sort()[0];
    const index = events.indexOf(first);
    after = index > 0 ? events[index - 1] : null;
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
    for (const item of page.items as {
      id?: unknown;
      envelope?: unknown;
      body?: unknown;
      body_status?: unknown;
    }[]) {
      if (!eventId(item.id) || !item.envelope)
        throw new RecordsError("A records item is malformed.", "invalid");
      const envelopeBytes = utf8(JSON.stringify(item.envelope));
      verifyEnvelope(envelopeBytes);
      const envelope = canonicalize(envelopeBytes);
      const parsed = JSON.parse(envelope) as Envelope;
      if (parsed.id !== item.id)
        throw new RecordsError(
          "A records item does not match its event ID.",
          "invalid",
        );
      let body: string | null = null;
      if (item.body !== null && item.body !== undefined) {
        body = canonicalize(utf8(JSON.stringify(item.body)));
        const hash = contentHash(utf8(body));
        if (
          !parsed.header.content ||
          parsed.header.content.hash !== hash ||
          parsed.header.content.bytes !== utf8(body).length
        )
          throw new RecordsError(
            `The body of ${item.id} does not match its signed hash.`,
            "invalid",
          );
        const inspected = inspectBody(utf8(envelope), utf8(body));
        if (inspected.availability === "invalid") body = null;
      }
      bytes += envelope.length + (body?.length ?? 0);
      if (bytes > RECORD_LIMITS.bytes)
        throw new RecordsError(
          "The snapshot exceeds the local calculation byte limit.",
          "limit",
        );
      if (missingSet.has(item.id)) {
        await store.put("records", item.id, {
          id: item.id,
          envelope,
          body,
        } satisfies StoredRecord);
        missingSet.delete(item.id);
        loaded++;
      }
      if (!events.includes(item.id))
        throw new RecordsError(
          "The server returned a record outside the inventory.",
          "invalid",
        );
    }
    progress({ phase: "records", loaded, total: events.length, bytes });
    if (page.next === null) {
      if (missingSet.size)
        throw new RecordsError(
          `${missingSet.size} inventory records are missing from the records transport.`,
          "missing",
        );
      break;
    }
  }
  // Import selections, cached by hash.
  const cachedSelections = new Set(await store.keys("selections"));
  for (const [index, hash] of selections.entries()) {
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
  // Completeness: every inventory event must now be cached. The view comes from a word probe.
  const probe = (await api(
    `/words/jvw1:${"0".repeat(64)}?snapshot=${encodeURIComponent(snapshot)}`,
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
/** Reads the cached records of an inventory. Throws when any record is missing. */
export async function loadRecords(
  store: LocalStore,
  inventory: SnapshotInventory,
): Promise<{
  events: string[];
  bodies: Record<string, string>;
  selections: Record<string, string[]>;
}> {
  const events: string[] = [];
  const bodies: Record<string, string> = {};
  for (const id of inventory.events) {
    const record = await store.get<StoredRecord>("records", id);
    if (!record)
      throw new RecordsError(
        `Record ${id} is not cached. Download the records again.`,
        "missing",
      );
    events.push(record.envelope);
    if (record.body) bodies[id] = record.body;
  }
  const selections: Record<string, string[]> = {};
  for (const hash of inventory.selections) {
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
export async function latestInventory(
  store: LocalStore,
): Promise<SnapshotInventory | null> {
  return (await store.get<SnapshotInventory>("inventory", "latest")) ?? null;
}
