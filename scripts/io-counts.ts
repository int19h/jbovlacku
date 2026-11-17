/** Counters for the service I/O measurement script. */
export interface IoCounts {
  logical_get: number;
  logical_put: number;
  object_get: number;
  /** Temporary-file write attempts only. */
  object_put: number;
  /** Directory syncs. Never counted as writes. */
  object_sync: number;
}

export const emptyIoCounts = (): IoCounts => ({
  logical_get: 0,
  logical_put: 0,
  object_get: 0,
  object_put: 0,
  object_sync: 0,
});

/**
 * Count one object-store operation by its exact kind. A new operation
 * kind changes no counter until it is counted here on purpose, so it
 * cannot silently inflate `object_put`.
 */
export function countObjectOperation(counts: IoCounts, operation: string) {
  if (operation === "read") counts.object_get++;
  else if (operation === "write") counts.object_put++;
  else if (operation === "sync") counts.object_sync++;
}

/** Every counted object operation: reads, writes, and directory syncs. */
export const totalObjectOperations = (counts: IoCounts) =>
  counts.object_get + counts.object_put + counts.object_sync;
