import type { ObjectStore } from "./storage.ts";

export const RECORD_READ_WINDOW = 16;
type Outcome<T> = { ok: true; result: T } | { ok: false; error: unknown };

/** Overlap a small window of operations and consume results in input order. */
export async function* orderedPrefetch<T, R>(
  values: Iterable<T>,
  load: (value: T) => Promise<R>,
  windowSize = RECORD_READ_WINDOW,
): AsyncGenerator<{ value: T; result: R }> {
  if (
    !Number.isInteger(windowSize) ||
    windowSize < 1 ||
    windowSize > RECORD_READ_WINDOW
  )
    throw new RangeError("Prefetch window must be an integer from 1 to 16.");
  const iterator = values[Symbol.iterator]();
  const pending: { value: T; outcome: Promise<Outcome<R>> }[] = [];
  function fill() {
    while (pending.length < windowSize) {
      const item = iterator.next();
      if (item.done) break;
      let read: Promise<R>;
      try {
        read = load(item.value);
      } catch (error) {
        read = Promise.reject(error);
      }
      const outcome = read.then(
        (result): Outcome<R> => ({ ok: true, result }),
        (error): Outcome<R> => ({ ok: false, error }),
      );
      pending.push({ value: item.value, outcome });
    }
  }
  try {
    fill();
    while (pending.length) {
      const item = pending.shift()!;
      const outcome = await item.outcome;
      if (!outcome.ok) throw outcome.error;
      yield { value: item.value, result: outcome.result };
      fill();
    }
  } finally {
    // ObjectStore has no cancellation API. Settle only this bounded window.
    await Promise.all(pending.map((item) => item.outcome));
    pending.length = 0;
    iterator.return?.();
  }
}

/** Preserve envelope-error priority while both object reads run together. */
export async function readRecordBytes(
  objects: ObjectStore,
  envelopeHash: string | null,
  bodyHash: string | null,
) {
  const read = (hash: string | null) => {
    try {
      return hash ? objects.get(hash) : Promise.resolve(null);
    } catch (error) {
      return Promise.reject(error);
    }
  };
  const [envelope, body] = await Promise.allSettled([
    read(envelopeHash),
    read(bodyHash),
  ]);
  if (envelope.status === "rejected") throw envelope.reason;
  return { envelope: envelope.value, body };
}
