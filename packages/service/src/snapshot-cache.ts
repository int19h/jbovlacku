import type { Snapshot } from "./storage.ts";

// These private rows contain verified headers and derived inventory data.
// Protocol hashes and signed canonical bytes are computed before this serializer.
export function serializeSnapshotCacheValue(snapshot: unknown): string {
  function encode(value: unknown, depth = 0): string {
    if (value === null) return "null";
    if (typeof value === "string" || typeof value === "boolean")
      return JSON.stringify(value);
    if (typeof value === "number" && Number.isSafeInteger(value))
      return JSON.stringify(value);
    if (typeof value !== "object" || depth >= 34)
      throw new Error("Invalid derived snapshot cache value.");
    if (Array.isArray(value))
      return "[" + value.map((item) => encode(item, depth + 1)).join(",") + "]";
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(
          (key) =>
            JSON.stringify(key) +
            ":" +
            encode((value as Record<string, unknown>)[key], depth + 1),
        )
        .join(",") +
      "}"
    );
  }
  return encode(snapshot);
}

const serializedSnapshots = new WeakMap<Snapshot, string>();
export function serializeSnapshotCache(snapshot: Snapshot): string {
  const previous = serializedSnapshots.get(snapshot);
  if (previous) return previous;
  const value = serializeSnapshotCacheValue(snapshot);
  if (Object.isFrozen(snapshot) && Object.isFrozen(snapshot.events))
    serializedSnapshots.set(snapshot, value);
  return value;
}

export function freezeSnapshotCache(snapshot: Snapshot): void {
  function freeze(value: unknown): void {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  freeze(snapshot);
}
