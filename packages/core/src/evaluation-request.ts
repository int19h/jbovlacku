import type { EvaluationRequest } from "./index.ts";

const encoder = new TextEncoder();

/** Request values are plain JSON. Signed envelopes and bodies remain strings. */
function* chunks(
  value: unknown,
  ancestors = new Set<object>(),
): Generator<string> {
  if (value === undefined) {
    yield "null";
    return;
  }
  if (
    value === null ||
    ["string", "number", "boolean"].includes(typeof value)
  ) {
    yield JSON.stringify(value);
    return;
  }
  if (typeof value !== "object")
    throw new TypeError("Evaluation requests must contain plain JSON values.");
  if (ancestors.has(value))
    throw new TypeError("Evaluation requests cannot contain cyclic values.");
  const array = Array.isArray(value);
  if (
    !array &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    throw new TypeError("Evaluation requests must contain plain JSON values.");
  const toJSON = Object.getOwnPropertyDescriptor(value, "toJSON");
  if (toJSON && (!("value" in toJSON) || typeof toJSON.value === "function"))
    throw new TypeError(
      "Evaluation requests cannot contain custom toJSON methods.",
    );
  ancestors.add(value);
  try {
    yield array ? "[" : "{";
    let separator = "";
    if (array) {
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (descriptor && !("value" in descriptor))
          throw new TypeError(
            "Evaluation requests cannot contain property accessors.",
          );
        yield separator;
        yield* chunks(descriptor?.value, ancestors);
        separator = ",";
      }
    } else {
      for (const key of Object.keys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (!("value" in descriptor))
          throw new TypeError(
            "Evaluation requests cannot contain property accessors.",
          );
        if (descriptor.value === undefined) continue;
        yield separator;
        yield JSON.stringify(key);
        yield ":";
        yield* chunks(descriptor.value, ancestors);
        separator = ",";
      }
    }
    yield array ? "]" : "}";
  } finally {
    ancestors.delete(value);
  }
}

/** Two passes avoid both an aggregate JSON string and a retained chunk list. */
export function encodeEvaluationRequest(input: EvaluationRequest): Uint8Array {
  let size = 0;
  for (const chunk of chunks(input)) size += encoder.encode(chunk).byteLength;
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks(input)) {
    const encoded = encoder.encodeInto(chunk, bytes.subarray(offset));
    if (encoded.read !== chunk.length)
      throw new TypeError("The evaluation request changed during encoding.");
    offset += encoded.written;
  }
  if (offset !== size)
    throw new TypeError("The evaluation request changed during encoding.");
  return bytes;
}
