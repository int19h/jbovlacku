import assert from "node:assert/strict";
import { test } from "node:test";
import {
  orderedPrefetch,
  readRecordBytes,
  RECORD_READ_WINDOW,
} from "../src/record-reads.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test("record prefetch bounds active reads and yields the original order", async () => {
  const values = Array.from({ length: 40 }, (_, index) => index);
  const gates = values.map(() => deferred<number>());
  for (let index = RECORD_READ_WINDOW; index < gates.length; index++)
    gates[index].resolve(index);
  const started: number[] = [];
  let active = 0;
  let peak = 0;
  const records = orderedPrefetch(values, async (value) => {
    started.push(value);
    peak = Math.max(peak, ++active);
    try {
      return await gates[value].promise;
    } finally {
      active--;
    }
  });
  const first = records.next();
  assert.equal(started.length, RECORD_READ_WINDOW);
  let firstReady = false;
  void first.then(() => {
    firstReady = true;
  });
  for (let index = RECORD_READ_WINDOW - 1; index > 0; index--)
    gates[index].resolve(index);
  await Promise.resolve();
  assert.equal(firstReady, false);
  gates[0].resolve(0);
  const output = [(await first).value];
  for await (const record of records) output.push(record);
  assert.deepEqual(
    output,
    values.map((value) => ({ value, result: value })),
  );
  assert.equal(peak, RECORD_READ_WINDOW);
  assert.equal(active, 0);
});

test("record prefetch reports the first input error and settles pending reads", async () => {
  const firstError = new Error("First record error.");
  const laterError = new Error("Later record error.");
  const first = deferred<number>();
  const failed = deferred<number>();
  const cleanup = deferred<number>();
  let started = 0;
  let active = 0;
  const records = orderedPrefetch(
    Array.from({ length: 40 }, (_, index) => index),
    async (value) => {
      started++;
      active++;
      try {
        if (value === 0) return await first.promise;
        if (value === 1) return await failed.promise;
        if (value === 2) throw laterError;
        if (value === 3) return await cleanup.promise;
        return value;
      } finally {
        active--;
      }
    },
  );
  const initial = records.next();
  first.resolve(0);
  assert.deepEqual((await initial).value, { value: 0, result: 0 });
  const failure = records.next();
  const rejection = assert.rejects(failure, (error) => error === firstError);
  failed.reject(firstError);
  let finished = false;
  void rejection.then(() => {
    finished = true;
  });
  await Promise.resolve();
  assert.equal(finished, false);
  cleanup.resolve(3);
  await rejection;
  assert.equal(active, 0);
  assert.equal(started, RECORD_READ_WINDOW + 1);
});

test("stopping record consumption settles its window without starting more reads", async () => {
  const gates = Array.from({ length: RECORD_READ_WINDOW }, () =>
    deferred<number>(),
  );
  let started = 0;
  let active = 0;
  const records = orderedPrefetch(
    Array.from({ length: 40 }, (_, index) => index),
    async (value) => {
      started++;
      active++;
      try {
        return await gates[value].promise;
      } finally {
        active--;
      }
    },
  );
  const first = records.next();
  gates[0].resolve(0);
  await first;
  const stopped = records.return(undefined);
  for (let index = 1; index < gates.length; index++)
    gates[index].resolve(index);
  await stopped;
  assert.equal(active, 0);
  assert.equal(started, RECORD_READ_WINDOW);
});

test("record bytes read concurrently and retain envelope-error priority", async () => {
  const envelope = deferred<Uint8Array | null>();
  const body = deferred<Uint8Array | null>();
  const calls: string[] = [];
  const objects = {
    get(hash: string) {
      calls.push(hash);
      return hash === "envelope" ? envelope.promise : body.promise;
    },
    async put() {},
  };
  const read = readRecordBytes(objects, "envelope", "body");
  assert.deepEqual(calls, ["envelope", "body"]);
  const envelopeError = new Error("Envelope read failed.");
  const rejection = assert.rejects(read, (error) => error === envelopeError);
  body.reject(new Error("Body read failed first."));
  envelope.reject(envelopeError);
  await rejection;
  assert.deepEqual(await readRecordBytes(objects, null, null), {
    envelope: null,
    body: { status: "fulfilled", value: null },
  });
});
