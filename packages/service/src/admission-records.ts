import {
  hostRecordVersion,
  semanticProjectionVersion,
} from "../../core/src/index.ts";
import { orderedPrefetch, readRecordBytes } from "./record-reads.ts";
import {
  projectVerifiedRecord,
  verifiedRecordKey,
  type StoredVerifiedRecord,
} from "./verified-records.ts";
import {
  projectSemanticRecord,
  semanticRecordKey,
  type StoredSemanticRecord,
} from "./semantic/storage.ts";
import type { ObjectStore, StoredEvent } from "./storage.ts";

/** Admission owns both arrays. Evaluation receives only verifiedRecords. */
export interface AdmissionRecords {
  verifiedRecords: StoredVerifiedRecord[];
  semanticRecords: StoredSemanticRecord[];
}
export async function prepareAdmissionRecords(
  objects: ObjectStore,
  events: Record<string, Pick<StoredEvent, "envelope_hash" | "body_hash">>,
  ids: Iterable<string>,
  verified = new Map<string, StoredVerifiedRecord>(),
  semantic = new Map<string, StoredSemanticRecord>(),
): Promise<AdmissionRecords> {
  const result: AdmissionRecords = { verifiedRecords: [], semanticRecords: [] };
  for await (const { result: pair } of orderedPrefetch(ids, async (id) => {
    const event = events[id];
    const binding = {
      id,
      envelope_hash: event.envelope_hash,
      body_hash: event.body_hash,
    };
    const retained = verified.get(
      verifiedRecordKey({ ...binding, version: hostRecordVersion() }),
    );
    const evidence = semantic.get(
      semanticRecordKey({ ...binding, version: semanticProjectionVersion() }),
    );
    if (retained && evidence) return [retained, evidence] as const;
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
    const body = loaded.body.value ?? undefined;
    return [
      retained ?? projectVerifiedRecord(id, event, loaded.envelope, body),
      evidence ?? projectSemanticRecord(id, event, loaded.envelope, body),
    ] as const;
  })) {
    result.verifiedRecords.push(pair[0]);
    result.semanticRecords.push(pair[1]);
  }
  return result;
}
