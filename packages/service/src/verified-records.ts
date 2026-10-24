import {
  extractHostVerifiedRecord,
  checkHostVerifiedRecord,
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
export type VerifiedRecordBinding = Pick<
  StoredVerifiedRecord,
  "id" | "envelope_hash" | "body_hash" | "version"
>;
const statistics = new WeakMap<
  Coordinator,
  {
    missing: number;
    decode_failed: number;
    backfilled: number;
  }
>();
export function verifiedRecordStatistics(coordinator: Coordinator) {
  let value = statistics.get(coordinator);
  if (!value)
    statistics.set(
      coordinator,
      (value = {
        missing: 0,
        decode_failed: 0,
        backfilled: 0,
      }),
    );
  return value;
}
const localStores = new WeakMap<
  Coordinator,
  Map<string, StoredVerifiedRecord>
>();
export function verifiedRecordKey(record: VerifiedRecordBinding): string {
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
  const counts = verifiedRecordStatistics(coordinator);
  if (stored) {
    try {
      if (checkHostVerifiedRecord(stored.compact) !== id)
        throw new Error("Stored compact event ID differs from its binding.");
      return stored;
    } catch (error) {
      counts.decode_failed++;
      console.warn(
        JSON.stringify({
          event: "verified_record_decode_failed",
          id,
          envelope_hash: event.envelope_hash,
          body_hash: event.body_hash,
          version: binding.version,
        }),
      );
    }
  } else counts.missing++;
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
  counts.backfilled++;
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
  const before = { ...verifiedRecordStatistics(coordinator) };
  for await (const _ of streamVerifiedRecords(
    coordinator,
    objects,
    state.events,
    Object.keys(state.events),
  )) {
    /* Drain bounded batches. */
  }
  const after = verifiedRecordStatistics(coordinator);
  return after.backfilled - before.backfilled;
}
