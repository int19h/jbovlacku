import { test } from "node:test";
import assert from "node:assert/strict";
import {
  newDraft,
  normalizeDraft,
  draftToBody,
} from "../../src/model/draft.ts";
import {
  applySource,
  sourceCurrent,
  currentDraft,
  sourceProposal,
  undoPatches,
  restorePatches,
  captureSourceTarget,
  sourceTargetMatches,
} from "../../src/model/assistance.ts";
import {
  newGismuState,
  manualFormation,
  sourceRowsFromFormation,
  formationSource,
  setSourceAiNoteGroup,
  editSourceNotes,
  sourceReviewMarks,
  resolveSourceReview,
} from "../../src/model/builders.ts";
import type { GismuRowState } from "../../src/model/builders.ts";

function example() {
  return newDraft({
    kind: "gismu",
    spelling: "broda",
    text: "A book.",
    gismu: {
      ...newGismuState(),
      rows: [
        {
          id: "row",
          language: "en",
          name: "English",
          word: "book",
          word_ipa: "bʊk",
          stem: "book",
          ipa: "bʊk",
          input: "buk",
          weight: { numerator: "1", denominator: "2" },
          notes: [["Author note"]],
          aiNoteGroup: [],
        },
        {
          id: "other",
          language: "en",
          name: "English",
          word: "volume",
          input: "volum",
          weight: null,
          aiNoteGroup: [],
        },
      ],
    },
  });
}
function suggestion(source: unknown): any {
  return { proposals: [{ path: "/formation/sources", value: [source] }] };
}

test("partial source edits preserve omitted fields, language, weight and other rows", () => {
  const draft = example();
  const before = structuredClone(draft.gismu!.rows);
  applySource(
    draft,
    "row",
    suggestion({ notes: [["Note: No single source word."]] }),
  );
  const row = draft.gismu!.rows[0];
  for (const field of [
    "word",
    "word_ipa",
    "stem",
    "ipa",
    "input",
    "weight",
    "language",
  ] as const)
    assert.deepEqual(row[field], before[0][field]);
  assert.deepEqual(row.notes, [
    ["Author note"],
    ["Note: No single source word."],
  ]);
  assert.deepEqual(draft.gismu!.rows[1], before[1]);
  assert.deepEqual(sourceReviewMarks(row), []);
  assert.equal(
    Object.hasOwn(sourceCurrent(draft, "row").formation!.sources[0], "stem"),
    false,
  );
  assert.equal(Object.hasOwn(formationSource(row), "ipa"), false);
});

test("source proposal parser refuses signed row fields, null edits and foreign fields", () => {
  assert.deepEqual(
    sourceProposal(suggestion({ stem: "book", ipa: "bʊk", notes: [] })),
    { stem: "book", ipa: "bʊk", notes: [] },
  );
  for (const source of [
    { language: "en", notes: [] },
    { weight: null, notes: [] },
    { provenance: {}, notes: [] },
    { word: null, notes: [] },
    { word_ipa: null, notes: [] },
    { stem: null, notes: [] },
    { input: null, notes: [] },
    { input: { format: "ipa", text: "x" }, notes: [] },
    { word: "book" },
    { notes: [["Sense: "]] },
    { notes: [["Authored echo"]] },
  ])
    assert.throws(
      () => sourceProposal(suggestion(source)),
      /source suggestion/i,
    );
});

test("AI note replacement preserves authored order, demotes edits and supports empty replacement", () => {
  const draft = example();
  const row = draft.gismu!.rows[0];
  row.notes = [
    ["Before"],
    ["Note: old AI"],
    ["Middle"],
    ["Sense: old AI"],
    ["After"],
  ];
  setSourceAiNoteGroup(row, [1, 3]);
  applySource(
    draft,
    "row",
    suggestion({ notes: [["Sense: new"], ["Note: new"]] }),
  );
  assert.deepEqual(row.notes, [
    ["Before"],
    ["Sense: new"],
    ["Note: new"],
    ["Middle"],
    ["After"],
  ]);
  editSourceNotes(row, [
    ["Before"],
    ["Sense: author edited"],
    ["Note: new"],
    ["Middle"],
    ["After"],
  ]);
  applySource(draft, "row", suggestion({ notes: [] }));
  assert.deepEqual(row.notes, [
    ["Before"],
    ["Sense: author edited"],
    ["Middle"],
    ["After"],
  ]);
  assert.deepEqual(row.aiNoteGroup, []);
});

test("legacy note ownership needs an explicit choice and signed notes start as authored", () => {
  const draft = example();
  const row = draft.gismu!.rows[0];
  delete row.aiNoteGroup;
  row.notes = [["Sense: authored prefix"]];
  assert.throws(
    () => applySource(draft, "row", suggestion({ notes: [] })),
    /earlier AI notes/i,
  );
  setSourceAiNoteGroup(row, []);
  applySource(draft, "row", suggestion({ notes: [["Note: new"]] }));
  assert.deepEqual(row.notes, [["Sense: authored prefix"], ["Note: new"]]);
  const reopened = sourceRowsFromFormation([formationSource(row)])[0];
  assert.deepEqual(reopened.aiNoteGroup, []);
  assert.equal(Object.hasOwn(reopened, "sourceReview"), false);
});

for (const aiIndex of [0, 1]) {
  test(`unchanged duplicate notes retain explicit AI ownership at index ${aiIndex}`, () => {
    const draft = example();
    const row = draft.gismu!.rows[0];
    row.notes = [["Note: same"], ["Note: same"]];
    setSourceAiNoteGroup(row, [aiIndex]);
    applySource(draft, "row", suggestion({ notes: [["Note: replacement"]] }));
    assert.deepEqual(
      row.notes,
      aiIndex === 0
        ? [["Note: replacement"], ["Note: same"]]
        : [["Note: same"], ["Note: replacement"]],
    );
  });
  test(`ambiguous duplicate note edits preserve authored text when AI index is ${aiIndex}`, () => {
    const draft = example();
    const row = draft.gismu!.rows[0];
    row.notes = [["Note: same"], ["Note: same"]];
    setSourceAiNoteGroup(row, [aiIndex]);
    editSourceNotes(row, [["Note: same"]]);
    assert.deepEqual(row.aiNoteGroup, []);
    applySource(draft, "row", suggestion({ notes: [] }));
    assert.deepEqual(row.notes, [["Note: same"]]);
  });
}

test("changed words mark retained identical evidence and notes, and block signing until each choice", () => {
  const draft = example();
  draft.formation = manualFormation(draft.gismu!.rows, "");
  const row = draft.gismu!.rows[0];
  row.input = "";
  row.inputOriginal = { format: "ipa", text: "bʊk" };
  applySource(
    draft,
    "row",
    suggestion({ word: "volume", word_ipa: "bʊk", notes: [["Note: New AI"]] }),
  );
  assert.deepEqual(
    sourceReviewMarks(row).map((mark) => mark.field),
    ["word_ipa", "stem", "ipa", "input", "notes"],
  );
  assert.equal(
    sourceReviewMarks(row).every((mark) => mark.word === "book"),
    true,
  );
  assert.equal(
    draftToBody(draft).problems.some(
      (problem) => problem.blocking && /source.*review/i.test(problem.message),
    ),
    true,
  );
  const restored = normalizeDraft(JSON.parse(JSON.stringify(draft)));
  assert.deepEqual(
    sourceReviewMarks(restored.gismu!.rows[0]),
    sourceReviewMarks(row),
  );
  resolveSourceReview(row, 0, "keep");
  resolveSourceReview(row, 0, "clear");
  assert.equal(row.stem, null);
  assert.equal(row.word_ipa, "bʊk");
  while (sourceReviewMarks(row).length) resolveSourceReview(row, 0, "clear");
  assert.deepEqual(row.notes, [["Note: New AI"]]);
  assert.equal(row.input, "");
  assert.equal(row.inputOriginal, null);
  assert.equal(
    draftToBody(draft).problems.some((problem) =>
      /source.*review/i.test(problem.message),
    ),
    false,
  );
});

test("source target follows unchanged private IDs after reorder and refuses changed or removed rows", () => {
  const draft = example();
  const target = captureSourceTarget(draft, "row");
  draft.gismu!.rows.reverse();
  assert.equal(sourceTargetMatches(draft, target), true);
  applySource(draft, "row", suggestion({ notes: [] }), target);
  for (const field of [
    "language",
    "word",
    "word_ipa",
    "stem",
    "ipa",
    "input",
  ] as const) {
    const changed = example();
    const target = captureSourceTarget(changed, "row");
    (changed.gismu!.rows[0] as any)[field] = "changed";
    assert.equal(sourceTargetMatches(changed, target), false);
    assert.throws(
      () => applySource(changed, "row", suggestion({ notes: [] }), target),
      /new suggestion/,
    );
  }
  draft.gismu!.rows = draft.gismu!.rows.filter((row) => row.id !== "row");
  assert.equal(sourceTargetMatches(draft, target), false);
});

test("all assistance currents project signed source fields even before word and type are filled", () => {
  for (const incomplete of [true, false]) {
    const draft = example();
    if (incomplete) {
      draft.spelling = "";
      draft.kind = null;
    }
    draft.formation = {
      method: "unknown",
      algorithm: null,
      weights_profile: null,
      generated: null,
      selected_score: null,
      selected_rank: null,
      selection_reason: [],
      candidates: [],
      conflicts: [],
      sources: [
        {
          language: "en",
          word: "book",
          input: null,
          weight: null,
          notes: [],
          stem: "book",
          ipa: "bʊk",
          aiNoteGroup: [],
          sourceReview: [],
        } as any,
      ],
    };
    const source = currentDraft(draft).formation!.sources[0];
    for (const field of ["stem", "ipa", "aiNoteGroup", "sourceReview"])
      assert.equal(Object.hasOwn(source, field), false);
  }
});

test("fresh changed fields avoid review and a later word restarts approval of retained values", () => {
  const draft = example();
  const row = draft.gismu!.rows[0];
  row.notes = [];
  applySource(
    draft,
    "row",
    suggestion({
      word: "volume",
      word_ipa: "vɒljum",
      stem: "volum",
      ipa: "vɒljum",
      input: { format: "lojbanized", text: "volum" },
      notes: [],
    }),
  );
  assert.deepEqual(sourceReviewMarks(row), []);
  applySource(draft, "row", suggestion({ word: "tome", notes: [] }));
  assert.equal(sourceReviewMarks(row).length, 4);
  while (sourceReviewMarks(row).length) resolveSourceReview(row, 0, "keep");
  applySource(draft, "row", suggestion({ word: "book", notes: [] }));
  assert.equal(sourceReviewMarks(row).length, 4);
  assert.equal(sourceReviewMarks(row)[0].word, "tome");
});

test("undo restores source review marks and AI note group with accepted values", () => {
  const draft = example();
  const before = structuredClone(draft.gismu);
  applySource(
    draft,
    "row",
    suggestion({ word: "volume", notes: [["Note: new"]] }),
  );
  const after = structuredClone(draft.gismu);
  restorePatches(draft, {
    key: "source-row",
    before: { gismu: before },
    after: { gismu: after },
    patches: undoPatches({ gismu: before }, { gismu: after }),
  } as never);
  assert.deepEqual(draft.gismu, before);
});
