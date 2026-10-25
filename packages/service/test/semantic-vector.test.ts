import assert from "node:assert/strict";
import { test } from "node:test";
import {
  distance,
  normalizeVector,
  vectorBytes,
  vectorFromBytes,
} from "../src/semantic/vector.ts";

test("vector codecs use little-endian float32 and honor byte offsets", () => {
  const vector = Float32Array.of(1, -0);
  const bytes = vectorBytes(vector);
  assert.deepEqual([...bytes], [0, 0, 128, 63, 0, 0, 0, 128]);
  const padded = new Uint8Array(12);
  padded.set(bytes, 3);
  assert.deepEqual(vectorFromBytes(padded.subarray(3, 11), 2), vector);
  assert.deepEqual(vectorBytes(vectorFromBytes(bytes, 2)), bytes);
});

test("provider normalization handles large and tiny finite values before float32 retention", () => {
  for (const scale of [1, 1e300, 1e-300]) {
    const vector = normalizeVector([3 * scale, 4 * scale], 2);
    assert.deepEqual(vector, Float32Array.of(0.6, 0.8));
    assert.deepEqual(vectorFromBytes(vectorBytes(vector), 2), vector);
  }
  assert.deepEqual(
    normalizeVector([Number.MAX_VALUE, Number.MAX_VALUE], 2),
    Float32Array.of(Math.SQRT1_2, Math.SQRT1_2),
  );
});

test("strict artifact decoding rejects invalid lengths, dimensions, values, and norms", () => {
  const raw = (values: number[]) => {
    const bytes = new Uint8Array(values.length * 4);
    const view = new DataView(bytes.buffer);
    values.forEach((value, i) => view.setFloat32(i * 4, value, true));
    return bytes;
  };
  for (const values of [
    [0, 0],
    [NaN, 1],
    [Infinity, 0],
    [-Infinity, 0],
    [2, 0],
    [0.9998, 0],
  ]) {
    const bytes = raw(values);
    const copy = bytes.slice();
    assert.throws(() => vectorFromBytes(bytes, 2));
    assert.deepEqual(bytes, copy);
    assert.throws(() => vectorBytes(Float32Array.from(values)));
  }
  for (const dimension of [0, -1, 1.5, NaN, Infinity, 65537])
    assert.throws(
      () => vectorFromBytes(new Uint8Array(), dimension),
      /dimension/,
    );
  for (const bytes of [new Uint8Array(7), new Uint8Array(9)])
    assert.throws(() => vectorFromBytes(bytes, 2), /length/);
  assert.throws(() => vectorBytes(Float32Array.of(1), 2), /length/);
  assert.deepEqual(
    vectorFromBytes(raw([0.99995, 0]), 2),
    Float32Array.of(0.99995, 0),
  );
  for (const values of [[], [0, 0], [NaN, 0], [Infinity, 1], [1]])
    assert.throws(() => normalizeVector(values, 2));
});

test("cosine distance compares matching unit vectors without accepting invalid vectors", () => {
  const a = Float32Array.of(1, 0);
  const b = Float32Array.of(0, 1);
  const opposite = Float32Array.of(-1, 0);
  assert.equal(distance(a, a), 0);
  assert.equal(distance(a, b), 1);
  assert.equal(distance(a, opposite), 2);
  assert.throws(() => distance(a, Float32Array.of(1)), /length/);
  assert.throws(() => distance(a, Float32Array.of(0, 0)), /norm/);
  assert.throws(() => distance(a, Float32Array.of(NaN, 0)), /nonfinite/);
});
