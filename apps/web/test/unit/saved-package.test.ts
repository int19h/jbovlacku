import { before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { initializeCore } from "../../../../packages/core/src/index.ts";

let search: typeof import("../../src/data/search.ts");
let builders: typeof import("../../src/model/builders.ts");

before(async () => {
  await initializeCore(
    await readFile(
      new URL(
        "../../../../packages/core/generated/jvc_runtime_bg.wasm",
        import.meta.url,
      ),
    ),
  );
  Object.assign(globalThis, {
    location: new URL("http://local.invalid"),
    history: { state: null },
  });
  search = await import("../../src/data/search.ts");
  builders = await import("../../src/model/builders.ts");
});

const INVALID =
  "The search package is invalid. Search this server or download another package.";
const row = (over: Record<string, unknown> = {}, drop: string[] = []) => {
  const base: Record<string, unknown> = {
    event: "jve1:" + "1".repeat(64),
    word: { language: "jbo", spelling: "cukta" },
    language: "en",
    glosses: [{ language: "en", text: "book", sense: null }],
    plain_text: "book",
    classification: { kind: "gismu", selmaho: [] },
    body: null,
    issuer: "ed25519:" + "a".repeat(64),
    notes: false,
    rafsi: ["cuk"],
    rafsi_complete: true,
    attribution: null,
    ...over,
  };
  for (const name of drop) delete base[name];
  return base;
};
const pkg = (entries: unknown[]) =>
  ({
    version: 2,
    snapshot: "sha256:" + "a".repeat(64),
    entries,
  }) as never;
const malformed = pkg([null]);
const valid = pkg([row()]);

test("the shared guard rejects a null row and a stored null", () => {
  for (const value of [malformed, null, { entries: [] }, "package"]) {
    assert.throws(
      () => search.checkSavedPackage(value, "en"),
      (error: unknown) => error instanceof Error && error.message === INVALID,
    );
  }
});

test("the shared guard runs the worker validation on every row field", () => {
  // A version 2 row with an issuer but no rafsi, and a word object with an
  // extra field, are both shapes the worker rejects.
  for (const bad of [
    pkg([row({}, ["rafsi", "rafsi_complete"])]),
    pkg([row({ word: { language: "jbo", spelling: "cukta", extra: 1 } })]),
    pkg([row({ glosses: [{ language: "en", text: "book" }] })]),
    pkg([row(), row()]),
  ]) {
    assert.throws(
      () => search.checkSavedPackage(bad, "en"),
      (error: unknown) => error instanceof Error && error.message === INVALID,
    );
  }
});

test("the shared guard accepts a valid package unchanged", () => {
  assert.equal(search.checkSavedPackage(valid, "en"), valid);
  const inventory = builders.inventoryFromPackage(valid);
  assert.equal(inventory.snapshot, "sha256:" + "a".repeat(64));
  assert.deepEqual(
    inventory.claims.map((claim) => claim.rafsi),
    ["cuk"],
  );
});

test("a checked package object is not checked again", () => {
  const mutable = pkg([row()]);
  assert.equal(search.checkSavedPackage(mutable, "en"), mutable);
  // The store returns the same object until the package changes, so a
  // later edit of that object does not pay for a second check. A changed
  // package arrives as a different object and is checked then.
  (mutable as { entries: unknown[] }).entries = [null];
  assert.equal(search.checkSavedPackage(mutable, "en"), mutable);
});

test("the package pick skips a malformed package and keeps a valid one", async () => {
  const store = {
    keys: async () => ["fr", "en"],
    list: async () => [malformed, valid],
  };
  const pick = await builders.cachedPackagePick(store as never);
  assert.equal(pick.pkg, valid);
  assert.equal(pick.invalid, INVALID);
  assert.equal(await builders.cachedPackage(store as never), valid);
  const onlyBad = {
    keys: async () => ["en"],
    list: async () => [malformed],
  };
  const badPick = await builders.cachedPackagePick(onlyBad as never);
  assert.equal(badPick.pkg, null);
  assert.equal(badPick.invalid, INVALID);
  const empty = { keys: async () => [], list: async () => [] };
  assert.deepEqual(await builders.cachedPackagePick(empty as never), {
    pkg: null,
    invalid: null,
  });
});
