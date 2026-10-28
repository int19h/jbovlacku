import { SemanticError } from "./types.ts";

export const UNIT_NORM_TOLERANCE = 0.0001;

function checkDimension(dimension: number): void {
  if (!Number.isInteger(dimension) || dimension < 1 || dimension > 65536)
    throw new SemanticError(
      400,
      "vector_dimension",
      "The vector dimension is invalid.",
    );
}

function checkUnitVector(vector: Float32Array, dimension: number): void {
  checkDimension(dimension);
  if (!(vector instanceof Float32Array) || vector.length !== dimension)
    throw new SemanticError(400, "vector", "The vector length is invalid.");
  let squared = 0;
  for (const value of vector) {
    if (!Number.isFinite(value))
      throw new SemanticError(
        400,
        "vector",
        "The vector contains a nonfinite value.",
      );
    squared += value * value;
  }
  if (Math.abs(Math.sqrt(squared) - 1) > UNIT_NORM_TOLERANCE)
    throw new SemanticError(
      400,
      "vector",
      "The vector does not have unit norm.",
    );
}

/** Normalize provider output before retention. Imported vector artifacts use strict decoding. */
export function normalizeVector(
  values: ArrayLike<number>,
  dimension: number,
): Float32Array {
  checkDimension(dimension);
  if (values.length !== dimension)
    throw new SemanticError(
      502,
      "embedding_vector",
      "The provider vector length is invalid.",
    );
  let scale = 0;
  for (let i = 0; i < dimension; i++) {
    if (typeof values[i] !== "number" || !Number.isFinite(values[i]))
      throw new SemanticError(
        502,
        "embedding_vector",
        "The provider vector contains an invalid value.",
      );
    scale = Math.max(scale, Math.abs(values[i]));
  }
  if (scale === 0)
    throw new SemanticError(
      502,
      "embedding_vector",
      "The provider returned a zero vector.",
    );
  let squared = 0;
  for (let i = 0; i < dimension; i++) squared += (values[i] / scale) ** 2;
  const norm = Math.sqrt(squared);
  const vector = Float32Array.from(values, (value) => value / scale / norm);
  checkUnitVector(vector, dimension);
  return vector;
}

/** Encode unit vectors as little-endian IEEE 754 binary32 values. */
export function vectorBytes(
  vector: Float32Array,
  dimension: number = vector.length,
): Uint8Array {
  checkUnitVector(vector, dimension);
  const bytes = new Uint8Array(dimension * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < dimension; i++) view.setFloat32(i * 4, vector[i], true);
  return bytes;
}

/** Retained artifacts must already have unit norm. Never repair their bytes. */
export function vectorFromBytes(
  bytes: Uint8Array,
  dimension: number,
): Float32Array {
  checkDimension(dimension);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== dimension * 4)
    throw new SemanticError(
      400,
      "vector",
      "The encoded vector length is invalid.",
    );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vector = new Float32Array(dimension);
  for (let i = 0; i < dimension; i++) vector[i] = view.getFloat32(i * 4, true);
  checkUnitVector(vector, dimension);
  return vector;
}

export function distance(a: Float32Array, b: Float32Array): number {
  checkUnitVector(a, a.length);
  checkUnitVector(b, a.length);
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return Math.max(0, Math.min(2, 1 - dot / Math.sqrt(aa * bb)));
}
