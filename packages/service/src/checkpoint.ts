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

export function checkpointBindingKey(binding: CheckpointBinding): string {
  return JSON.stringify([
    binding.schema,
    binding.snapshot,
    binding.logical_inventory,
    binding.position,
    binding.view,
    binding.core_version,
    binding.limits
      ? [
          binding.limits.events,
          binding.limits.traversal,
          binding.limits.claim_depth,
        ]
      : null,
  ]);
}

/** Read only the separate host pin. File contents never establish this binding. */
export function parseCheckpointBinding(text: string): CheckpointBinding | null {
  try {
    if (text.length > 4096) return null;
    const values: unknown = JSON.parse(text);
    if (!Array.isArray(values) || values.length !== 7) return null;
    const [
      schema,
      snapshot,
      logical_inventory,
      position,
      view,
      core_version,
      rawLimits,
    ] = values;
    const hash = (value: unknown, prefix: string) =>
      typeof value === "string" &&
      new RegExp(`^${prefix}[a-f0-9]{64}$`).test(value);
    if (
      schema !== 1 ||
      !hash(snapshot, "sha256:") ||
      !hash(logical_inventory, "sha256:") ||
      !hash(view, "jve1:") ||
      !Number.isSafeInteger(position) ||
      position < 0 ||
      typeof core_version !== "string" ||
      core_version.length === 0 ||
      core_version.length > 1024 ||
      (rawLimits !== null &&
        (!Array.isArray(rawLimits) ||
          rawLimits.length !== 3 ||
          rawLimits.some((value) => !Number.isSafeInteger(value) || value < 0)))
    )
      return null;
    const binding: CheckpointBinding = {
      schema,
      snapshot,
      logical_inventory,
      position,
      view,
      core_version,
      limits:
        rawLimits === null
          ? null
          : {
              events: rawLimits[0],
              traversal: rawLimits[1],
              claim_depth: rawLimits[2],
            },
    };
    return checkpointBindingKey(binding) === text ? binding : null;
  } catch {
    return null;
  }
}

export interface CheckpointStore {
  /** Discover the latest committed host pin before asking for its exact payload. */
  latestBinding?(): Promise<CheckpointBinding | null>;
  load(binding: CheckpointBinding): Promise<ServiceCheckpoint | null>;
  save(binding: CheckpointBinding, payload: ServiceCheckpoint): Promise<void>;
}
