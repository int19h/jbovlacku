import { before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { initializeCore } from "../../../../packages/core/src/index.ts";
import { draftToBody, newDraft } from "../../src/model/draft.ts";
import {
  newGismuState,
  sourceRowsFromFormation,
} from "../../src/model/builders.ts";
import type { Formation } from "../../src/model/types.ts";

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

function example() {
  const formation: Formation = {
    method: "algorithmic",
    algorithm: null,
    sources: [
      {
        language: "en",
        word: "book",
        input: { format: "lojbanized", text: "buk" },
        weight: { numerator: 1, denominator: 1 },
        notes: [["Original"]],
      },
    ],
    weights_profile: null,
    generated: "brodu",
    selected_score: { numerator: "1", denominator: "2" },
    selected_rank: 3,
    selection_reason: [["Chosen reason"]],
    candidates: [],
    conflicts: [],
  };
  return newDraft({
    kind: "gismu",
    spelling: "brodu",
    text: "A book.",
    formation,
    evidenceForm: "brodu",
    gismu: {
      ...newGismuState(),
      rows: sourceRowsFromFormation(formation.sources),
    },
  });
}

test("publication uses descriptive source edits even when navigation skips the form action", () => {
  const draft = example();
  const row = draft.gismu!.rows[0];
  row.word = "";
  row.notes = [];
  row.word_ipa = "bʊk";
  row.stem = "boo";
  row.ipa = "bʊ";
  const { body, problems } = draftToBody(draft);
  assert.equal(
    problems.some((p) => p.blocking),
    false,
  );
  assert.deepEqual(body?.etymology.formation?.sources[0], {
    language: "en",
    word: "",
    input: { format: "lojbanized", text: "buk" },
    weight: { numerator: 1, denominator: 1 },
    notes: [],
    word_ipa: "bʊk",
    stem: "boo",
    ipa: "bʊ",
  });
  assert.deepEqual(body?.etymology.formation?.selected_score, {
    numerator: "1",
    denominator: "2",
  });
});

for (const changed of ["language", "input", "weight"] as const) {
  test(`publication blocks a changed source ${changed} until the score is refreshed`, () => {
    const draft = example();
    const row = draft.gismu!.rows[0];
    if (changed === "language") row.language = "fr";
    if (changed === "input") {
      row.input = "buku";
      delete row.inputOriginal;
    }
    if (changed === "weight") row.weight = { numerator: "2", denominator: "1" };
    const { problems } = draftToBody(draft);
    assert.equal(
      problems.some(
        (p) =>
          p.blocking &&
          p.field === "formation" &&
          p.message.includes("source scoring inputs changed"),
      ),
      true,
    );
  });
}

test("a blank alternative does not change the saved scoring inputs", () => {
  const draft = example();
  draft.gismu!.rows.push({
    language: "en",
    name: "English",
    input: "",
    word: "",
    weight: { numerator: "1", denominator: "1" },
  });
  const { body, problems } = draftToBody(draft);
  assert.equal(
    problems.some((p) => p.blocking),
    false,
  );
  assert.equal(body?.etymology.formation?.sources.length, 1);
  assert.deepEqual(body?.etymology.formation?.selection_reason, [
    ["Chosen reason"],
  ]);
});

test("accepting and undoing source text updates the publication copy immediately", async () => {
  const { applySource, restorePatches, undoPatches } =
    await import("../../src/model/assistance.ts");
  const draft = example();
  const before = structuredClone(draft.gismu);
  const changedSource = {
    ...draft.formation!.sources[0],
    word: "books",
    notes: [["Accepted note"]],
  };
  applySource(draft, draft.gismu!.rows[0].id!, {
    proposals: [{ path: "/formation/sources", value: [changedSource] }],
  } as never);
  assert.equal(draft.formation!.sources[0].word, "books");
  assert.deepEqual(draft.formation!.sources[0].notes, [["Accepted note"]]);
  const after = structuredClone(draft.gismu);
  const record = {
    key: `source-${draft.gismu!.rows[0].id!}`,
    before: { gismu: before },
    after: { gismu: after },
    patches: undoPatches({ gismu: before }, { gismu: after }),
  };
  restorePatches(draft, record as never);
  assert.equal(draft.formation!.sources[0].word, "book");
  assert.deepEqual(draft.formation!.sources[0].notes, [["Original"]]);
  assert.deepEqual(draft.formation!.selected_score, {
    numerator: "1",
    denominator: "2",
  });
});
