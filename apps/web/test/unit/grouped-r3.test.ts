import { before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  initializeCore,
  wordId,
  type Evaluation,
} from "../../../../packages/core/src/index.ts";
import { lexicalSearch } from "../../../../packages/service/src/lexical-search.ts";
import type { PackageEntry } from "../../src/model/types.ts";
let local: typeof import("../../src/data/search.ts");
const view = "jve1:" + "a".repeat(64);
const snapshot = "sha256:" + "b".repeat(64);
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
  local = await import("../../src/data/search.ts");
});
const entries = (): PackageEntry[] =>
  [
    "mi",
    "klama",
    "i",
    "coi",
    "do",
    "la",
    "alis",
    "ki'e",
    "lo",
    "ve",
    "ti",
    "me",
  ].map((spelling, index) => ({
    event: "jve1:" + (index + 1).toString(16).padStart(64, "0"),
    word: { language: "jbo", spelling },
    language: "en",
    glosses: [],
    plain_text: "Synthetic definition.",
    classification: { kind: "other", selmaho: [] },
    body: null,
    search_status: { view, status: "active" },
  }));
for (const query of [
  "mi klama.",
  ".i mi klama",
  "coi, do",
  "la .alis.",
  "kihe",
])
  test(`r3: browser and server know complete spelling aliases: ${query}`, () => {
    const rows = entries();
    const evaluation = {
      publications: Object.fromEntries(
        rows.map((row) => [
          row.event,
          { word: wordId(row.word), eligible: "eligible", status: "active" },
        ]),
      ),
      receipts: Object.fromEntries(
        rows.map((row) => [row.event, { interpretation: "effective" }]),
      ),
    } as unknown as Evaluation;
    for (const group of ["lojban", "definitions"] as const) {
      assert.equal(
        local.localSearch(rows, query, undefined, false, { group, view })
          .allLojban,
        true,
      );
      assert.equal(
        lexicalSearch(
          rows as any,
          query,
          "en",
          evaluation,
          false,
          undefined,
          {},
          { group },
        ).allLojban,
        true,
      );
    }
  });
for (const query of [
  "love",
  "time",
  "klama!",
  "klama?",
  "mi; klama",
  ".",
  ",",
  "... ,",
  "coi, unknown",
  "(klama)",
  "klama ☃",
])
  test(`r3: unknown and other punctuation never establish a known token: ${query}`, () => {
    const rows = entries();
    const evaluation = {
      publications: Object.fromEntries(
        rows.map((row) => [
          row.event,
          { word: wordId(row.word), eligible: "eligible", status: "active" },
        ]),
      ),
      receipts: Object.fromEntries(
        rows.map((row) => [row.event, { interpretation: "effective" }]),
      ),
    } as unknown as Evaluation;
    for (const group of ["lojban", "definitions"] as const) {
      assert.equal(
        local.localSearch(rows, query, undefined, false, { group, view })
          .allLojban,
        false,
      );
      assert.equal(
        lexicalSearch(
          rows as any,
          query,
          "en",
          evaluation,
          false,
          undefined,
          {},
          { group },
        ).allLojban,
        false,
      );
    }
  });
test("r3: package view binds compact statuses, while old v2 and v1 stay readable", () => {
  const row = {
    ...entries()[0],
    issuer: "ed25519:" + "c".repeat(64),
    notes: false,
    rafsi: [],
    rafsi_complete: true,
    attribution: null,
  };
  const compact = { ...row, search_status: "active" };
  const pkg = { snapshot, version: 2, search_view: view, entries: [compact] };
  assert.doesNotThrow(() => local.validateCachedPackage(pkg, "en"));
  assert.equal(
    local.localSearch(pkg.entries as any, "mi", undefined, false, {
      packageView: view,
    } as any).allLojban,
    true,
  );
  assert.equal(
    local.localSearch(pkg.entries as any, "mi", undefined, false, {
      packageView: view,
      view: "jve1:" + "f".repeat(64),
    } as any).allLojban,
    false,
  );
  assert.doesNotThrow(() =>
    local.validateCachedPackage({ snapshot, version: 2, entries: [row] }, "en"),
  );
  const {
    issuer,
    notes,
    rafsi,
    rafsi_complete,
    attribution,
    search_status,
    ...v1
  } = row;
  assert.doesNotThrow(() =>
    local.validateCachedPackage({ snapshot, entries: [v1] }, "en"),
  );
  assert.equal(local.localSearch([v1], "mi").allLojban, false);
  for (const invalid of [
    { ...pkg, search_view: "bad" },
    { ...pkg, extra: true },
    { ...pkg, version: 1 },
    { ...pkg, entries: [row] },
    { ...pkg, entries: [{ ...compact, search_status: "unknown" }] },
    { ...pkg, entries: [{ ...compact, search_status: { status: "active" } }] },
    { snapshot, version: 2, entries: [compact] },
    { ...pkg, entries: [{ ...compact, extra: true }] },
  ])
    assert.throws(() => local.validateCachedPackage(invalid, "en"));
});
