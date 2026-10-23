import { before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { initializeCore } from "../../../../packages/core/src/index.ts";
import {
  applySource,
  captureSourceTarget,
  currentDraft,
  draftFingerprint,
  sourceCurrent,
  sourceTargetMatches,
  undoPatches,
  restorePatches,
} from "../../src/model/assistance.ts";
import {
  alternativeSourceRow,
  editSourceNotes,
  formationSource,
  manualFormation,
  newGismuState,
  resolveSourceReview,
  setSourceAiNoteGroup,
  sourceReviewMarks,
  sourceRowsFromFormation,
} from "../../src/model/builders.ts";
import {
  draftFromBody,
  draftToBody,
  newDraft,
  normalizeDraft,
} from "../../src/model/draft.ts";
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

function example() {
  const rows: GismuRowState[] = [
    {
      id: "source-row",
      language: "en",
      name: "English",
      word: "book",
      word_ipa: "bʊk",
      stem: "book",
      ipa: "bʊk",
      input: "buk",
      weight: { numerator: "1", denominator: "1" },
      notes: [["Author note"]],
      aiNoteGroup: [],
    },
  ];
  return newDraft({
    kind: "gismu",
    spelling: "brodu",
    text: "A book.",
    evidenceForm: "brodu",
    gismu: { ...newGismuState(), rows },
    formation: manualFormation(rows, ""),
  });
}
const suggestion = (source: unknown): any => ({
  proposals: [{ path: "/formation/sources", value: [source] }],
});
const changeWord = (draft: ReturnType<typeof example>) =>
  applySource(draft, "source-row", suggestion({ word: "tome", notes: [] }));

test("retained source marks block only the gismu formation that signs them", () => {
  const draft = example();
  changeWord(draft);
  const needsReview = () =>
    draftToBody(draft).problems.some(
      (problem) =>
        problem.blocking &&
        /source evidence needs review/.test(problem.message),
    );
  assert.equal(needsReview(), true);
  draft.formation = null;
  assert.equal(needsReview(), false);
  draft.kind = "lujvo";
  assert.equal(needsReview(), false);
  assert.equal(sourceReviewMarks(draft.gismu!.rows[0]).length, 5);
});

test("same-word acceptance removes only marks for the replaced values", () => {
  const draft = example();
  changeWord(draft);
  applySource(
    draft,
    "source-row",
    suggestion({
      word: "tome",
      word_ipa: "bʊk",
      stem: "tom",
      ipa: "toʊm",
      input: { format: "lojbanized", text: "tom" },
      notes: [["Note: A fresh source"]],
    }),
  );
  const row = draft.gismu!.rows[0];
  assert.deepEqual(
    sourceReviewMarks(row).map((mark) => mark.field),
    ["word_ipa", "notes"],
  );
  assert.equal(row.stem, "tom");
  assert.equal(row.ipa, "toʊm");
  assert.equal(row.input, "tom");
  while (sourceReviewMarks(row).length) resolveSourceReview(row, 0, "clear");
  assert.equal(row.stem, "tom");
  assert.equal(row.ipa, "toʊm");
  assert.equal(row.input, "tom");
  assert.deepEqual(row.notes, [["Note: A fresh source"]]);
});

test("same-word acceptance keeps marks when every retained field is repeated", () => {
  const draft = example();
  changeWord(draft);
  const before = structuredClone(sourceReviewMarks(draft.gismu!.rows[0]));
  applySource(
    draft,
    "source-row",
    suggestion({
      word: "tome",
      word_ipa: "bʊk",
      stem: "book",
      ipa: "bʊk",
      input: { format: "lojbanized", text: "buk" },
      notes: [],
    }),
  );
  assert.deepEqual(sourceReviewMarks(draft.gismu!.rows[0]), before);
});

test("repeated scoring input keeps its review when JSON object keys have another order", () => {
  const draft = example();
  const row = draft.gismu!.rows[0];
  row.inputOriginal = { text: "buk", format: "lojbanized" };
  const repeated = { format: "lojbanized", text: "buk" };
  applySource(
    draft,
    row.id!,
    suggestion({ word: "tome", input: repeated, notes: [] }),
  );
  assert.equal(
    sourceReviewMarks(row).some((mark) => mark.field === "input"),
    true,
  );
  applySource(
    draft,
    row.id!,
    suggestion({ word: "tome", input: repeated, notes: [] }),
  );
  assert.equal(
    sourceReviewMarks(row).some((mark) => mark.field === "input"),
    true,
  );
});

for (const field of ["word_ipa", "stem", "ipa", "input", "notes"] as const) {
  test(`Keep restores the exact retained ${field} after an editor bypass`, () => {
    const draft = example();
    const row = draft.gismu!.rows[0];
    row.input = "Buk";
    row.inputOriginal = { format: "lojbanized", text: " Buk " };
    changeWord(draft);
    const markIndex = sourceReviewMarks(row).findIndex(
      (mark) => mark.field === field,
    );
    const retained = structuredClone(sourceReviewMarks(row)[markIndex].value);
    if (field === "notes") row.notes![0] = ["A later authored note"];
    else if (field === "input") {
      row.input = "klama";
      delete row.inputOriginal;
    } else row[field] = "replacement";
    resolveSourceReview(row, markIndex, "keep");
    const actual =
      field === "notes"
        ? row.notes![0]
        : field === "input"
          ? formationSource(row).input
          : row[field];
    assert.deepEqual(actual, retained);
    if (field === "input") assert.equal(row.input, "Buk");
  });

  test(`Clear leaves a later ${field} replacement intact after an editor bypass`, () => {
    const draft = example();
    const row = draft.gismu!.rows[0];
    changeWord(draft);
    const markIndex = sourceReviewMarks(row).findIndex(
      (mark) => mark.field === field,
    );
    if (field === "notes") row.notes![0] = ["A later authored note"];
    else if (field === "input") {
      row.input = "klama";
      delete row.inputOriginal;
    } else row[field] = "replacement";
    resolveSourceReview(row, markIndex, "clear");
    const actual =
      field === "notes"
        ? row.notes![0]
        : field === "input"
          ? row.input
          : row[field];
    assert.deepEqual(
      actual,
      field === "notes"
        ? ["A later authored note"]
        : field === "input"
          ? "klama"
          : "replacement",
    );
    assert.equal(
      sourceReviewMarks(row).some((mark) => mark.field === field),
      false,
    );
  });
}

test("fingerprints ignore ownership and review metadata while retaining values and row order", () => {
  const draft = example();
  const row = draft.gismu!.rows[0];
  delete row.aiNoteGroup;
  const target = captureSourceTarget(draft, row.id!);
  const fingerprint = draftFingerprint(draft);
  setSourceAiNoteGroup(row, []);
  row.sourceReview = [{ field: "stem", word: "earlier", value: "book" }];
  (row as any).wordIpaNullOriginal = true;
  (draft as any).retainedWordIpaNullSources = [0];
  assert.equal(draftFingerprint(draft), fingerprint);
  assert.equal(sourceTargetMatches(draft, target), true);
  const metadataOnly = structuredClone(draft);
  for (const field of [
    "word",
    "word_ipa",
    "stem",
    "ipa",
    "input",
    "notes",
    "weight",
    "language",
  ] as const) {
    const changed = structuredClone(metadataOnly);
    (changed.gismu!.rows[0] as any)[field] =
      field === "notes"
        ? [["Changed"]]
        : field === "weight"
          ? { numerator: "2", denominator: "1" }
          : "changed";
    assert.notEqual(draftFingerprint(changed), fingerprint, field);
    assert.equal(sourceTargetMatches(changed, target), false, field);
  }
  const second = alternativeSourceRow(row);
  draft.gismu!.rows.push(second);
  const ordered = draftFingerprint(draft);
  draft.gismu!.rows.reverse();
  assert.notEqual(draftFingerprint(draft), ordered);
});

for (const aiIndex of [0, 1]) {
  test(`editing another note keeps unchanged duplicate AI ownership at index ${aiIndex}`, () => {
    const draft = example();
    const row = draft.gismu!.rows[0];
    row.notes = [["Note: same"], ["Note: same"], ["Other authored note"]];
    setSourceAiNoteGroup(row, [aiIndex]);
    editSourceNotes(row, [
      ["Note: same"],
      ["Note: same"],
      ["Other authored note edited"],
    ]);
    assert.deepEqual(
      row.aiNoteGroup?.map((entry) => entry.index),
      [aiIndex],
    );
    applySource(draft, row.id!, suggestion({ notes: [["Note: replacement"]] }));
    assert.deepEqual(
      row.notes,
      aiIndex === 0
        ? [
            ["Note: replacement"],
            ["Note: same"],
            ["Other authored note edited"],
          ]
        : [
            ["Note: same"],
            ["Note: replacement"],
            ["Other authored note edited"],
          ],
    );
  });

  test(`adding an identical copy demotes ambiguous AI ownership at index ${aiIndex}`, () => {
    const row = example().gismu!.rows[0];
    row.notes = [["Note: same"], ["Note: same"], ["Other"]];
    setSourceAiNoteGroup(row, [aiIndex]);
    editSourceNotes(row, [
      ["Note: same"],
      ["Note: same"],
      ["Note: same"],
      ["Other edited"],
    ]);
    assert.deepEqual(row.aiNoteGroup, []);
  });
}

test("new null Said values stay omitted in rows, formation bodies and requests", () => {
  const draft = example();
  const row = alternativeSourceRow(draft.gismu!.rows[0]);
  Object.assign(row, { word: "volume", input: "volum" });
  assert.equal(Object.hasOwn(formationSource(row), "word_ipa"), false);
  draft.gismu!.rows = [row];
  draft.formation = manualFormation([row], "");
  assert.equal(
    Object.hasOwn(
      draftToBody(draft).body!.etymology.formation!.sources[0],
      "word_ipa",
    ),
    false,
  );
  assert.equal(
    Object.hasOwn(currentDraft(draft).formation!.sources[0], "word_ipa"),
    false,
  );
  assert.equal(
    Object.hasOwn(
      sourceCurrent(draft, row.id!).formation!.sources[0],
      "word_ipa",
    ),
    false,
  );
  draft.gismu = null;
  draft.formation!.sources[0].word_ipa = null;
  const reopened = sourceRowsFromFormation(draft.formation!.sources, []);
  assert.equal(Object.hasOwn(formationSource(reopened[0]), "word_ipa"), false);
  assert.equal(
    Object.hasOwn(
      draftToBody(draft).body!.etymology.formation!.sources[0],
      "word_ipa",
    ),
    false,
  );
  assert.equal(
    Object.hasOwn(currentDraft(draft).formation!.sources[0], "word_ipa"),
    false,
  );
});

test("signed null Said survives reload, reordered sources, Revise and requests without private metadata", () => {
  const original: FormationSource = {
    language: "en",
    word: "book",
    word_ipa: null,
    input: null,
    weight: null,
    notes: [["History"]],
  };
  const draft = example();
  const fresh = alternativeSourceRow(draft.gismu!.rows[0]);
  Object.assign(fresh, { word: "volume", input: "volum" });
  draft.gismu!.rows = [fresh, ...sourceRowsFromFormation([original])];
  draft.gismu!.rows.unshift({ ...alternativeSourceRow(fresh), weight: null });
  draft.gismu!.rows.reverse();
  draft.formation = manualFormation(draft.gismu!.rows, "");
  const loaded = normalizeDraft(JSON.parse(JSON.stringify(draft)));
  const published = draftToBody(loaded).body!;
  const sameEvidence = (sources: FormationSource[]) => {
    assert.deepEqual(sources[0], original);
    assert.equal(Object.hasOwn(sources[1], "word_ipa"), false);
    assert.equal(sources.length, 2);
    for (const source of sources)
      assert.equal(Object.hasOwn(source, "wordIpaNullOriginal"), false);
  };
  sameEvidence(published.etymology.formation!.sources);
  sameEvidence(currentDraft(loaded).formation!.sources);
  const revised = normalizeDraft(
    JSON.parse(
      JSON.stringify(
        draftFromBody(published, "jve1:" + "1".repeat(64), "native"),
      ),
    ),
  );
  assert.equal(revised.gismu, null);
  sameEvidence(draftToBody(revised).body!.etymology.formation!.sources);
  sameEvidence(currentDraft(revised).formation!.sources);
  revised.kind = null;
  revised.spelling = "";
  sameEvidence(currentDraft(revised).formation!.sources);
});

test("new Said and Clear discard the private signed-null presence and undo restores it", () => {
  const draft = example();
  const original = formationSource(draft.gismu!.rows[0]);
  original.word_ipa = null;
  const row = sourceRowsFromFormation([original])[0];
  draft.gismu!.rows = [row];
  const before = structuredClone(draft.gismu);
  applySource(draft, row.id!, suggestion({ word_ipa: "bʊk", notes: [] }));
  assert.equal(Object.hasOwn(row, "wordIpaNullOriginal"), false);
  const after = structuredClone(draft.gismu);
  row.sourceReview = [{ field: "word_ipa", word: "book", value: "bʊk" }];
  resolveSourceReview(row, 0, "clear");
  assert.equal(Object.hasOwn(formationSource(row), "word_ipa"), false);
  draft.gismu = after;
  restorePatches(draft, {
    key: `source-${row.id}`,
    before: { gismu: before },
    after: { gismu: after },
    patches: undoPatches({ gismu: before }, { gismu: after }),
  } as never);
  assert.equal(formationSource(draft.gismu!.rows[0]).word_ipa, null);
  assert.equal(
    Object.hasOwn(formationSource(draft.gismu!.rows[0]), "word_ipa"),
    true,
  );
});
