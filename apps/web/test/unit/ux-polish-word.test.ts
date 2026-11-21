import { test } from "node:test";
import assert from "node:assert/strict";
import { readableSourceLocator } from "../../src/lib/format.ts";

test("source locators read as words, not raw locator keys", () => {
  assert.equal(
    readableSourceLocator("definitions/definitionid=583/cached_username"),
    "definitions · definition 583 · cached username",
  );
  assert.equal(
    readableSourceLocator("footer.publicDomainNotice"),
    "footer · public domain notice",
  );
  assert.equal(readableSourceLocator("definitions/42"), "definitions · 42");
});
