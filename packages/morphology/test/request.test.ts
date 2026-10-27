import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUILDER_INPUT_LIMIT,
  BuilderError,
  buildLujvo,
  generateGismu,
} from "../src/index.ts";

test("the public builder rejects malformed request fields", () => {
  for (const request of [
    null,
    {},
    { profile: "extended", components: null },
    { profile: "extended", components: [{ id: 1 }] },
    { profile: "extended", components: [], inventory: { claims: [null] } },
    { profile: "extended", components: [], joins: [2] },
    { profile: "extended", components: [], limits: { results: -1 } },
  ]) {
    assert.throws(
      () => buildLujvo(request as never),
      (error: unknown) =>
        error instanceof BuilderError &&
        error.failure.kind === "invalid" &&
        error.message.startsWith("The request is malformed:"),
    );
  }
  for (const request of [
    {},
    { sources: null },
    { sources: [{ word: "root" }] },
    { sources: [], window: 0.5 },
    { sources: [], candidates: "anything" },
  ]) {
    assert.throws(() => generateGismu(request as never), BuilderError);
  }
});

test("the serialized request ceiling includes ignored fields and exact UTF-8 bytes", () => {
  const base = { profile: "cll" as const, components: [], ignored: "" };
  const overhead = JSON.stringify(base).length;
  const request = {
    ...base,
    ignored: "x".repeat(BUILDER_INPUT_LIMIT - overhead),
  };
  // At the byte ceiling, the typed builder reaches its component rule.
  assert.throws(
    () => buildLujvo(request),
    (error: unknown) =>
      error instanceof BuilderError &&
      error.message === "A lujvo needs 2 through 64 components.",
  );
  request.ignored += "é";
  assert.throws(
    () => buildLujvo(request),
    (error: unknown) =>
      error instanceof BuilderError &&
      error.failure.measure === "request bytes" &&
      error.failure.value === BUILDER_INPUT_LIMIT + 2 &&
      error.failure.limit === BUILDER_INPUT_LIMIT,
  );
});
