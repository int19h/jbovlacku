import type { EvaluationRequest } from "../../core/src/index.ts";
import type { MaterializedPackages, PackageRecord } from "./packages.ts";

export interface CheckpointBinding {
  schema: 1;
  snapshot: string;
  logical_inventory: string;
  position: number;
  view: string;
  core_version: string;
  limits: EvaluationRequest["limits"] | null;
}

/** The host checks its independent pin before returning any checkpoint payload. */
export interface ServiceCheckpoint {
  core: Uint8Array;
  package_records: PackageRecord[];
  packages: MaterializedPackages;
  envelopes: [string, string][];
}

export interface CheckpointStore {
  load(binding: CheckpointBinding): Promise<ServiceCheckpoint | null>;
  save(binding: CheckpointBinding, payload: ServiceCheckpoint): Promise<void>;
}
