import { before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { initializeCore } from "../../../../packages/core/src/index.ts";

let search: typeof import("../../src/data/search.ts");
let builders: typeof import("../../src/model/builders.ts");
let typed: typeof import("../../src/model/typed-headword.ts");

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
  typed = await import("../../src/model/typed-headword.ts");
});

const INVALID =
  "The search package is invalid. Search this server or download another package.";
const malformed = {
  version: 2,
  snapshot: "sha256:" + "a".repeat(64),
  entries: [null],
} as never;
const valid = {
  version: 2,
  snapshot: "sha256:" + "a".repeat(64),
  entries: [
    {
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
    },
  ],
} as never;

test("the shared guard rejects a null row and a stored null", () => {
  for (const value of [malformed, null, { entries: [] }, "package"]) {
    assert.throws(
      () => search.checkSavedPackage(value, "en"),
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

test("inventory and source options reject malformed rows", () => {
  assert.throws(() => builders.inventoryFromPackage(malformed), /invalid/);
  assert.throws(
    () =>
      typed.sourceOptions(
        { text: "cuk", kind: "rafsi", join_before: null },
        malformed,
      ),
    /invalid/,
  );
});

test("cachedPackage rejects malformed saved packages", async () => {
  const store = {
    keys: async () => ["en"],
    get: async () => malformed,
    list: async () => [malformed],
  };
  await assert.rejects(() => builders.cachedPackage(store as never), /invalid/);
  const empty = {
    keys: async () => [],
    get: async () => undefined,
    list: async () => [],
  };
  assert.equal(await builders.cachedPackage(empty as never), null);
});
