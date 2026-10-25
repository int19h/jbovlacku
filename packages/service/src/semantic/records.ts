import {
  checkHostVerifiedRecord,
  hostRecordVersion,
  type HostVerifiedRecord,
} from "../../../core/src/index.ts";
import type { StoredVerifiedRecord } from "../verified-records.ts";
import { documentInput, inputHash } from "./profile.ts";
import { SemanticError, type EmbeddingProfile } from "./types.ts";

export interface SemanticDocument {
  event: string;
  envelope: string;
  body: string;
  extraction_version: number;
  input: Uint8Array;
  input_hash: string;
  definition: Record<string, unknown>;
}

/**
 * Read records from the private store under their exact envelope/body binding.
 * Envelope metadata comes from that trusted key. This function does not authenticate it.
 * The evaluator separately decides current eligibility.
 */
export function semanticDocument(
  profile: EmbeddingProfile,
  record: StoredVerifiedRecord,
): SemanticDocument | null {
  if (
    record.version !== hostRecordVersion() ||
    checkHostVerifiedRecord(record.compact) !== record.id
  )
    throw new SemanticError(
      503,
      "semantic_record",
      "The stored record binding is invalid.",
    );
  const compact = JSON.parse(record.compact) as HostVerifiedRecord;
  if (
    !compact.action_valid ||
    compact.body_status !== "present" ||
    !compact.semantic
  )
    return null;
  const projection = compact.semantic;
  if (
    compact.version !== record.version ||
    projection.id !== record.id ||
    projection.kind !== "definition.publish" ||
    projection.body_hash === null ||
    projection.body_hash !== record.body_hash ||
    !projection.body
  )
    throw new SemanticError(
      503,
      "semantic_record",
      "The semantic projection binding is invalid.",
    );
  const input = documentInput(profile, projection.body);
  return {
    event: record.id,
    envelope: record.envelope_hash,
    body: projection.body_hash,
    extraction_version: record.version,
    input,
    input_hash: inputHash(input),
    definition: projection.body,
  };
}
