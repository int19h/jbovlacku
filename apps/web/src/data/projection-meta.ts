import { createProjectionDigest } from "../../../../packages/core/src/browser.ts";

export const PROJECTION_PRODUCER_KEY = "projection:producer";
export const PROJECTION_LATEST_KEY = "projection:latest";
export const projectionSnapshotKey = (snapshot: string) =>
  `projection:${snapshot}`;

export type ProjectionBytes = Uint8Array | ArrayBuffer;
export interface ProjectionAdvanceFrom {
  snapshot: string;
  logical_inventory: string;
  events_digest: string;
  count: number;
  selections: string[];
  added: string[];
  new_bodies: string[];
}
export const projectionRowBytes = (value: ProjectionBytes): Uint8Array =>
  value instanceof Uint8Array ? value : new Uint8Array(value);

/**
 * XOR of per-row SHA-256(record ID, little-endian u64 row length, row bytes).
 * This detects accidental damage only. It is not a defense against a party
 * who can write to this origin's storage. That party is trusted.
 */
export function updateProjectionHash(
  current: string,
  id: string,
  oldRow: ProjectionBytes | undefined,
  newRow: ProjectionBytes | undefined,
): string {
  const delta = createProjectionDigest();
  if (oldRow) delta.update(id, projectionRowBytes(oldRow));
  if (newRow) delta.update(id, projectionRowBytes(newRow));
  return xorProjectionHashes(current, delta.finish());
}

export function xorProjectionHashes(left: string, right: string): string {
  const parse = (hash: string) => {
    if (!/^sha256:[0-9a-f]{64}$/.test(hash))
      throw new Error("Invalid projection digest.");
    return hash.slice(7);
  };
  const a = parse(left);
  const b = parse(right);
  let result = "";
  for (let index = 0; index < 64; index += 2) {
    const value =
      Number.parseInt(a.slice(index, index + 2), 16) ^
      Number.parseInt(b.slice(index, index + 2), 16);
    result += value.toString(16).padStart(2, "0");
  }
  return `sha256:${result}`;
}
