import {
  checkHostSemanticRecord,
  extractHostSemanticRecord,
  semanticProjectionVersion,
  type HostSemanticRecord,
} from "../../../core/src/index.ts";
import type { Coordinator, ObjectStore, StoredEvent } from "../storage.ts";
import { orderedPrefetch, readRecordBytes } from "../record-reads.ts";

/** A separate private row. Evaluation never reads this payload. */
export interface StoredSemanticRecord {
  id: string;
  envelope_hash: string;
  body_hash: string | null;
  version: number;
  projection: string;
}
export type SemanticRecordBinding = Omit<StoredSemanticRecord, "projection">;
export const semanticRecordKey = (record: SemanticRecordBinding) =>
  JSON.stringify([
    record.id,
    record.envelope_hash,
    record.body_hash,
    record.version,
  ]);
const localStores = new WeakMap<
  Coordinator,
  Map<string, StoredSemanticRecord>
>();
const counts = new WeakMap<
  Coordinator,
  { missing: number; decode_failed: number; backfilled: number }
>();
export function semanticRecordStatistics(coordinator: Coordinator) {
  let result = counts.get(coordinator);
  if (!result)
    counts.set(
      coordinator,
      (result = { missing: 0, decode_failed: 0, backfilled: 0 }),
    );
  return result;
}
function localStore(coordinator: Coordinator) {
  let store = localStores.get(coordinator);
  if (!store) localStores.set(coordinator, (store = new Map()));
  return store;
}
export function projectSemanticRecord(
  id: string,
  event: Pick<StoredEvent, "envelope_hash" | "body_hash">,
  envelope: Uint8Array,
  body?: Uint8Array,
): StoredSemanticRecord {
  return {
    id,
    envelope_hash: event.envelope_hash,
    body_hash: event.body_hash,
    version: semanticProjectionVersion(),
    projection: extractHostSemanticRecord(envelope, body),
  };
}
export function checkedSemanticRecord(
  record: StoredSemanticRecord,
): HostSemanticRecord {
  if (
    record.version !== semanticProjectionVersion() ||
    checkHostSemanticRecord(record.projection) !== record.id
  )
    throw new Error("The semantic record binding is invalid.");
  const value = JSON.parse(record.projection) as HostSemanticRecord;
  if (
    value.version !== record.version ||
    (value.body_status === "present" && value.body_hash !== record.body_hash)
  )
    throw new Error("The semantic body binding is invalid.");
  return value;
}
export async function retainSemanticRecords(
  coordinator: Coordinator,
  records: StoredSemanticRecord[],
) {
  if (coordinator.saveSemanticRecords)
    await coordinator.saveSemanticRecords(records);
  else
    for (const record of records)
      localStore(coordinator).set(semanticRecordKey(record), record);
}
/** Semantic backfill does not load, repair, or replace evaluation records. */
export async function readSemanticRecord(
  coordinator: Coordinator,
  objects: ObjectStore,
  id: string,
  event: Pick<StoredEvent, "envelope_hash" | "body_hash">,
  pending?: StoredSemanticRecord[],
): Promise<StoredSemanticRecord> {
  const binding = {
    id,
    envelope_hash: event.envelope_hash,
    body_hash: event.body_hash,
    version: semanticProjectionVersion(),
  };
  const key = semanticRecordKey(binding);
  const stored = coordinator.getSemanticRecord
    ? await coordinator.getSemanticRecord(binding)
    : localStore(coordinator).get(key);
  const statistics = semanticRecordStatistics(coordinator);
  if (stored) {
    try {
      if (semanticRecordKey(stored) !== key)
        throw new Error("The semantic row binding differs.");
      checkedSemanticRecord(stored);
      return stored;
    } catch {
      statistics.decode_failed++;
      console.warn(
        JSON.stringify({ event: "semantic_record_decode_failed", ...binding }),
      );
    }
  } else statistics.missing++;
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
  const record = projectSemanticRecord(
    id,
    event,
    loaded.envelope,
    loaded.body.value ?? undefined,
  );
  checkedSemanticRecord(record);
  statistics.backfilled++;
  if (pending) pending.push(record);
  else await retainSemanticRecords(coordinator, [record]);
  return record;
}
export async function backfillSemanticRecords(
  coordinator: Coordinator,
  objects: ObjectStore,
): Promise<number> {
  const state = await coordinator.load();
  const before = semanticRecordStatistics(coordinator).backfilled;
  const pending: StoredSemanticRecord[] = [];
  try {
    for await (const _ of orderedPrefetch(Object.keys(state.events), (id) =>
      readSemanticRecord(coordinator, objects, id, state.events[id], pending),
    )) {
      while (pending.length >= 256)
        await retainSemanticRecords(coordinator, pending.splice(0, 256));
    }
  } finally {
    while (pending.length)
      await retainSemanticRecords(coordinator, pending.splice(0, 256));
  }
  return semanticRecordStatistics(coordinator).backfilled - before;
}
