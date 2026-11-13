import assert from "node:assert/strict";
import { before, test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  contentHash,
  createContentDigest,
  initializeCore,
  utf8,
} from "../src/index.ts";

before(async () =>
  initializeCore(
    await readFile(
      new URL("../generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  ),
);

test("a streaming content digest matches one-shot hashing", () => {
  const parts = ["first\n", "", "second ☃\n", "third\n"];
  const digest = createContentDigest();
  for (const part of parts) digest.update(utf8(part));
  assert.equal(digest.finish(), contentHash(utf8(parts.join(""))));
});
