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
    pkg([row({ rafsi: "cuk" })]),
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

test("the verified pick skips a malformed package and keeps a valid one", async () => {
  // The verdict in this test is the shared row check; pages use the
  // search worker for the same verdict.
  const verify = async (value: unknown, language: string) => {
    search.checkSavedPackage(value, language);
  };
  const byKey: Record<string, unknown> = { fr: malformed, en: valid };
  const store = {
    keys: async () => Object.keys(byKey),
    get: async (_name: string, key: string) => byKey[key],
    list: async () => Object.values(byKey),
  };
  const pick = await builders.verifiedCachedPackage(store as never, verify);
  assert.equal(pick.pkg, valid);
  assert.equal(pick.invalid, INVALID);
  const onlyBad = {
    keys: async () => ["en"],
    get: async () => malformed,
    list: async () => [malformed],
  };
  const badPick = await builders.verifiedCachedPackage(
    onlyBad as never,
    verify,
  );
  assert.equal(badPick.pkg, null);
  assert.equal(badPick.invalid, INVALID);
  const empty = { keys: async () => [], get: async () => undefined, list: async () => [] };
  assert.deepEqual(
    await builders.verifiedCachedPackage(empty as never, verify),
    { pkg: null, invalid: null },
  );
});

test("the store.get path returns the same package object every time", async () => {
  // A store whose get returns its cached object, as the real store does
  // while a package revision is unchanged: two reads of the candidate
  // list hand back the identical object, so a per-object check hits its
  // cache on the second read. A getAll-style list returns fresh objects
  // and would miss it.
  const stored = valid;
  const store = {
    keys: async () => ["en"],
    get: async () => stored,
    list: async () => [{ ...(stored as object) }],
  };
  const first = await builders.cachedPackages(store as never);
  const second = await builders.cachedPackages(store as never);
  assert.equal(first[0].pkg, stored);
  assert.equal(second[0].pkg, first[0].pkg);
});
