import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isSpellingRefusal,
  nullOnSpellingRefusal,
} from "../../src/lib/core-error.ts";

const SPELLING_REFUSAL = JSON.stringify({
  code: "spelling",
  message:
    "spelling must be nonempty NFC text without controls or edge whitespace",
});

test("the core spelling refusal becomes null", () => {
  assert.equal(isSpellingRefusal(SPELLING_REFUSAL), true);
  assert.equal(
    nullOnSpellingRefusal(() => {
      throw SPELLING_REFUSAL;
    }),
    null,
  );
  assert.equal(
    nullOnSpellingRefusal(() => "jvw1:abc"),
    "jvw1:abc",
  );
});

test("a non-spelling core error is rethrown, not turned into a bad link", () => {
  const other = JSON.stringify({ code: "size", message: "too large" });
  assert.equal(isSpellingRefusal(other), false);
  assert.throws(
    () =>
      nullOnSpellingRefusal(() => {
        throw other;
      }),
    (error: unknown) => error === other,
  );
});

test("errors and runtime failures are rethrown", () => {
  const failure = new Error("core crashed");
  assert.equal(isSpellingRefusal(failure), false);
  assert.throws(
    () =>
      nullOnSpellingRefusal(() => {
        throw failure;
      }),
    (error: unknown) => error === failure,
  );
  assert.equal(isSpellingRefusal("not json"), false);
  assert.equal(isSpellingRefusal(null), false);
  assert.throws(
    () =>
      nullOnSpellingRefusal(() => {
        throw "not json";
      }),
    (error: unknown) => error === "not json",
  );
});
