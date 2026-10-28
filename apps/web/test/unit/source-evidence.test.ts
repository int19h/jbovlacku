import { before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { initializeCore } from "../../../../packages/core/src/index.ts";
import * as builders from "../../src/model/builders.ts";
import { newDraft, normalizeDraft } from "../../src/model/draft.ts";
import type { GismuRowState } from "../../src/model/builders.ts";
import type { FormationSource } from "../../src/model/types.ts";

before(async () =>
  initializeCore(
    await readFile(
      new URL(
        "../../../../packages/core/generated/jvc_runtime_bg.wasm",
        import.meta.url,
      ),
    ),
  ),
);

const row = (): GismuRowState => ({
  language: "en",
  name: "English",
  word: "book",
  input: "",
  weight: { numerator: "1", denominator: "1" },
});

test("source rows preserve original IPA, null, and exact lojbanized input", () => {
  for (const original of [
    { format: "ipa", text: " ˈbʊk " },
    { format: "lojbanized", text: " Buk " },
    null,
  ] as const) {
    const source = builders.formationSource({
      ...row(),
      input: original?.format === "lojbanized" ? original.text : "",
      inputOriginal: original,
    } as GismuRowState);
    assert.deepEqual(source.input, original);
    assert.equal(Object.hasOwn(source, "ipa"), false);
    assert.equal(Object.hasOwn(source, "stem"), false);
  }
});

test("formation sources open as distinct scoring rows without invented pronunciation", () => {
  assert.equal(typeof builders.sourceRowsFromFormation, "function");
  const sources: FormationSource[] = [
    {
      language: "en",
      word: "book",
      input: { format: "ipa", text: "ˈbʊk" },
      weight: null,
      notes: [["Author evidence."]],
    },
    {
      language: "zh",
      word: "书",
      input: { format: "lojbanized", text: "Cu" },
      weight: { numerator: 2, denominator: 3 },
      notes: [],
    },
    {
      language: "fr",
      word: "livre",
      input: null,
      weight: null,
      notes: [],
      word_ipa: null,
    },
  ];
  const rows = builders.sourceRowsFromFormation(sources);
  assert.deepEqual(
    rows.map((r) => r.input),
    ["", "Cu", ""],
  );
  assert.equal(new Set(rows.map((r) => r.id)).size, 3);
  assert.deepEqual(rows.map(builders.formationSource), sources);
});

test("legacy source keys and undo snapshots migrate to stable row IDs once", () => {
  const before = {
    ...builders.newGismuState(),
    rows: [row(), { ...row(), language: "zh" }],
  };
  const after = structuredClone(before);
  after.rows[1].word = "书";
  const stored = newDraft({
    gismu: after,
    ai: {
      records: [
        {
          id: "record",
          key: "source-1-zh",
          state: "accepted",
          operation: "gismu-sources",
          before: { gismu: before },
          after: { gismu: after },
        } as never,
      ],
    },
  });
  const draft = normalizeDraft(stored);
  const id = draft.gismu!.rows[1].id;
  assert.equal(typeof id, "string");
  assert.equal(draft.ai!.records[0].key, `source-${id}`);
  assert.equal(draft.ai!.records[0].before!.gismu!.rows[1].id, id);
  assert.equal(draft.ai!.records[0].after!.gismu!.rows[1].id, id);
  const loaded = normalizeDraft(JSON.parse(JSON.stringify(draft)));
  assert.equal(loaded.gismu!.rows[1].id, id);
  assert.equal(loaded.ai!.records[0].key, `source-${id}`);
});

test("manual evidence retains an IPA input when the source word is unknown", () => {
  const input = { format: "ipa" as const, text: "ˈbʊk" };
  const formation = builders.manualFormation(
    [{ ...row(), word: "", inputOriginal: input }],
    "",
  );
  assert.deepEqual(formation?.sources[0].input, input);
});

test("legacy source undo migrates after an earlier language row was already removed", () => {
  const before = {
    ...builders.newGismuState(),
    rows: [row(), { ...row(), language: "zh", word: "old" }],
  };
  const after = structuredClone(before);
  after.rows[1].word = "书";
  const stored = newDraft({
    gismu: { ...after, rows: [after.rows[1]] },
    ai: {
      records: [
        {
          id: "old-record",
          key: "source-1-zh",
          state: "accepted",
          operation: "gismu-sources",
          before: { gismu: before },
          after: { gismu: after },
        } as never,
      ],
    },
  });
  const normalized = normalizeDraft(stored);
  const id = normalized.gismu!.rows[0].id;
  assert.equal(normalized.ai!.records[0].key, `source-${id}`);
  assert.equal(normalized.ai!.records[0].before!.gismu!.rows[1].id, id);
  assert.equal(normalized.ai!.records[0].after!.gismu!.rows[1].id, id);
});

test("source comparison ignores key order and optional nulls but keeps exact evidence text", () => {
  assert.equal(typeof builders.sameFormationSources, "function");
  const historical: FormationSource = {
    word: "book",
    word_ipa: null,
    input: { text: " Buk ", format: "lojbanized" },
    language: "en",
    notes: [["A note\nline two"]],
    weight: null,
  };
  const reopened = builders.formationSource(
    builders.sourceRowsFromFormation([historical])[0],
  );
  assert.equal(builders.sameFormationSources([historical], [reopened]), true);
  assert.equal(
    builders.sameFormationSources(
      [historical],
      [{ ...reopened, input: { format: "lojbanized", text: "Buk" } }],
    ),
    false,
  );
  assert.equal(
    builders.sameFormationSources(
      [historical],
      [{ ...reopened, notes: [["A note line two"]] }],
    ),
    false,
  );
});

test("source comparison treats blank optional pronunciation as unknown and keeps meaningful bytes exact", () => {
  const unknown: FormationSource = {
    language: "en",
    word: "book",
    input: null,
    weight: null,
    notes: [],
    word_ipa: " \n",
  };
  const omitted: FormationSource = {
    language: "en",
    word: "book",
    input: null,
    weight: null,
    notes: [],
  };
  assert.equal(builders.sameFormationSources([unknown], [omitted]), true);
  assert.equal(
    builders.sameFormationSources(
      [{ ...omitted, word_ipa: " bʊk " }],
      [{ ...omitted, word_ipa: "bʊk" }],
    ),
    false,
  );
});
