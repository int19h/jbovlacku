import {
  extractHostVerifiedRecord,
  hostRecordVersion,
  type HostVerifiedRecord,
} from "../../core/src/index.ts";
import type { Coordinator, ObjectStore, StoredEvent } from "./storage.ts";
import { orderedPrefetch, readRecordBytes } from "./record-reads.ts";

/** This object stays inside the server's trusted private storage. */
export interface StoredVerifiedRecord {
  id: string;
  envelope_hash: string;
  body_hash: string | null;
  version: number;
  compact: string;
}
const localStores = new WeakMap<
  Coordinator,
  Map<string, StoredVerifiedRecord>
>();
export function verifiedRecordKey(
  record: Omit<StoredVerifiedRecord, "compact">,
): string {
  return JSON.stringify([
    record.id,
    record.envelope_hash,
    record.body_hash,
    record.version,
  ]);
}
function localStore(coordinator: Coordinator) {
  let store = localStores.get(coordinator);
  if (!store) localStores.set(coordinator, (store = new Map()));
  return store;
}
export function projectVerifiedRecord(
  id: string,
  event: Pick<StoredEvent, "envelope_hash" | "body_hash">,
  envelope: Uint8Array,
  body?: Uint8Array,
): StoredVerifiedRecord {
  return {
    id,
    envelope_hash: event.envelope_hash,
    body_hash: event.body_hash,
    version: hostRecordVersion(),
    compact: extractHostVerifiedRecord(envelope, body),
  };
}
/** Missing versions parse admitted original bytes once. They never repeat cryptography. */
export async function readVerifiedRecord(
  coordinator: Coordinator,
  objects: ObjectStore,
  id: string,
  event: Pick<StoredEvent, "envelope_hash" | "body_hash">,
  backfill?: StoredVerifiedRecord[],
): Promise<StoredVerifiedRecord> {
  const binding = {
    id,
    envelope_hash: event.envelope_hash,
    body_hash: event.body_hash,
    version: hostRecordVersion(),
  };
  const key = verifiedRecordKey(binding);
  const stored = coordinator.getVerifiedRecord
    ? await coordinator.getVerifiedRecord(binding)
    : localStore(coordinator).get(key);
  if (stored) return stored;
  const loaded = await readRecordBytes(
    objects,
    event.envelope_hash,
    event.body_hash,
  );
  if (!loaded.envelope)
    throw new Error("Admitted envelope bytes are unavailable.");
  if (loaded.body.status === "rejected") throw loaded.body.reason;
  if (event.body_hash !== null && !loaded.body.value)
    throw new Error("Admitted body bytes are unavailable.");
  const record = projectVerifiedRecord(
    id,
    event,
    loaded.envelope,
    loaded.body.value ?? undefined,
  );
  if (backfill) backfill.push(record);
  else await retainVerifiedRecords(coordinator, [record]);
  return record;
}
export async function retainVerifiedRecords(
  coordinator: Coordinator,
  records: StoredVerifiedRecord[],
) {
  if (coordinator.saveVerifiedRecords)
    await coordinator.saveVerifiedRecords(records);
  else
    for (const record of records)
      localStore(coordinator).set(verifiedRecordKey(record), record);
}
/** Build rows before the record transaction, including shared and late body mappings. */
export async function prepareVerifiedRecords(
  objects: ObjectStore,
  events: Record<string, Pick<StoredEvent, "envelope_hash" | "body_hash">>,
  ids: Iterable<string>,
  prepared: Map<string, StoredVerifiedRecord> = new Map(),
): Promise<StoredVerifiedRecord[]> {
  const result: StoredVerifiedRecord[] = [];
  for await (const { result: record } of orderedPrefetch(
    [...ids],
    async (id) => {
      const event = events[id];
      const binding = {
        id,
        envelope_hash: event.envelope_hash,
        body_hash: event.body_hash,
        version: hostRecordVersion(),
      };
      const cached = prepared.get(verifiedRecordKey(binding));
      if (cached) return cached;
      const loaded = await readRecordBytes(
        objects,
        event.envelope_hash,
        event.body_hash,
      );
      if (!loaded.envelope)
        throw new Error("Admitted envelope bytes are unavailable.");
      if (loaded.body.status === "rejected") throw loaded.body.reason;
      if (event.body_hash !== null && !loaded.body.value)
        throw new Error("Admitted body bytes are unavailable.");
      return projectVerifiedRecord(
        id,
        event,
        loaded.envelope,
        loaded.body.value ?? undefined,
      );
    },
  ))
    result.push(record);
  return result;
}
export function compactRecord(
  record: StoredVerifiedRecord,
): HostVerifiedRecord {
  return JSON.parse(record.compact) as HostVerifiedRecord;
}
/** Bound migration commits and record reads for a cold evaluation or offline backfill. */
export async function* streamVerifiedRecords(
  coordinator: Coordinator,
  objects: ObjectStore,
  events: Record<string, Pick<StoredEvent, "envelope_hash" | "body_hash">>,
  ids: Iterable<string>,
) {
  const pending: StoredVerifiedRecord[] = [];
  try {
    for await (const item of orderedPrefetch(ids, (id) =>
      readVerifiedRecord(coordinator, objects, id, events[id], pending),
    )) {
      while (pending.length >= 256)
        await retainVerifiedRecords(coordinator, pending.splice(0, 256));
      yield item;
    }
  } finally {
    while (pending.length)
      await retainVerifiedRecords(coordinator, pending.splice(0, 256));
  }
}
/** An offline migration uses the same parse-only path as automatic startup backfill. */
export async function backfillVerifiedRecords(
  coordinator: Coordinator,
  objects: ObjectStore,
): Promise<number> {
  const state = await coordinator.load();
  let count = 0;
  const ids: string[] = [];
  for (const [id, event] of Object.entries(state.events)) {
    const binding = {
      id,
      envelope_hash: event.envelope_hash,
      body_hash: event.body_hash,
      version: hostRecordVersion(),
    };
    if (
      !coordinator.getVerifiedRecord ||
      !(await coordinator.getVerifiedRecord(binding))
    )
      ids.push(id);
  }
  for await (const _ of streamVerifiedRecords(
    coordinator,
    objects,
    state.events,
    ids,
  ))
    count++;
  return count;
}
