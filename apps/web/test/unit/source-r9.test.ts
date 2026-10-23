import { before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { initializeCore } from "../../../../packages/core/src/index.ts";
import {
  applySource,
  restorePatches,
  undoPatches,
  type AssistanceRecord,
  type Suggestion,
} from "../../src/model/assistance.ts";
import {
  formationSource,
  manualFormation,
  newGismuState,
  resolveSourceReview,
  setSourceAiNoteGroup,
  sourceReviewMarks,
  type GismuRowState,
  type SourceReview,
} from "../../src/model/builders.ts";
import { draftToBody, newDraft, type Draft } from "../../src/model/draft.ts";

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
      id: "row",
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
const suggestion = (source: unknown) =>
  ({
    proposals: [{ path: "/formation/sources", value: [source] }],
  }) as Suggestion;
function accept(draft: Draft, source: unknown): AssistanceRecord {
  const before = {
    gismu: structuredClone(draft.gismu),
    formation: structuredClone(draft.formation),
  };
  applySource(draft, "row", suggestion(source));
  const after = {
    gismu: structuredClone(draft.gismu),
    formation: structuredClone(draft.formation),
  };
  return {
    key: "source-row",
    before,
    after,
    patches: undoPatches(before, after),
  } as AssistanceRecord;
}
function choose(
  row: GismuRowState,
  field: SourceReview["field"],
  action: "keep" | "clear",
) {
  const index = sourceReviewMarks(row).findIndex(
    (mark) => mark.field === field,
  );
  assert.notEqual(index, -1);
  resolveSourceReview(row, index, action);
}
const needsReview = (draft: Draft) =>
  draftToBody(draft).problems.some(
    (problem) =>
      problem.blocking && /source evidence needs review/.test(problem.message),
  );

test("removing evidence preserves row reviews and type Undo restores them", async () => {
  const location = Object.getOwnPropertyDescriptor(globalThis, "location");
  const history = Object.getOwnPropertyDescriptor(globalThis, "history");
  const confirm = Object.getOwnPropertyDescriptor(globalThis, "confirm");
  const window = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperties(globalThis, {
    location: { configurable: true, value: { href: "http://localhost/" } },
    history: { configurable: true, value: { state: null } },
    confirm: { configurable: true, value: () => true },
    window: { configurable: true, value: { addEventListener() {} } },
  });
  try {
    const { removeFormationEvidence, confirmKindChange } =
      await import("../../src/pages/wizard/common.ts");
    const draft = example();
    const row = draft.gismu!.rows[0];
    accept(draft, { word: "tome", notes: [] });
    const marks = structuredClone(row.sourceReview);
    assert.equal(needsReview(draft), true);
    assert.equal(removeFormationEvidence(draft), true);
    assert.equal(needsReview(draft), false);
    assert.deepEqual(row.sourceReview, marks);
    assert.equal(
      row.sourceReview?.some((mark) => mark.field === "input"),
      true,
    );
    draft.formation = manualFormation(draft.gismu!.rows, "");
    assert.equal(needsReview(draft), true);
    const beforeType = {
      kind: draft.kind,
      formation: structuredClone(draft.formation),
      gismu: structuredClone(draft.gismu),
    };
    confirmKindChange(draft, "lujvo");
    assert.equal(row.sourceReview, undefined);
    const afterType = {
      kind: draft.kind,
      formation: structuredClone(draft.formation),
      gismu: structuredClone(draft.gismu),
    };
    restorePatches(draft, {
      key: "type",
      before: beforeType,
      after: afterType,
      patches: undoPatches(beforeType, afterType),
    } as AssistanceRecord);
    assert.deepEqual(row.sourceReview, marks);
    assert.equal(needsReview(draft), true);
  } finally {
    for (const [name, descriptor] of Object.entries({
      location,
      history,
      confirm,
      window,
    })) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

for (const action of ["keep", "clear"] as const) {
  test(`undo restores replaced Letters and its mark after a newer Said ${action}`, () => {
    const draft = example();
    accept(draft, { word: "tome", notes: [] });
    const row = draft.gismu!.rows[0];
    const inputMark = structuredClone(
      row.sourceReview!.find((mark) => mark.field === "input"),
    );
    const record = accept(draft, {
      word: "tome",
      input: { format: "lojbanized", text: "tom" },
      notes: [],
    });
    choose(row, "word_ipa", action);
    assert.ok(restorePatches(draft, record) > 0);
    assert.equal(row.input, "buk");
    assert.deepEqual(
      row.sourceReview!.find((mark) => mark.field === "input"),
      inputMark,
    );
    assert.equal(
      row.sourceReview!.some((mark) => mark.field === "word_ipa"),
      false,
    );
    assert.equal(row.word_ipa, action === "keep" ? "bʊk" : null);
    assert.equal(needsReview(draft), true);
  });
}

test("partial undo drops moved stale note marks and Keep cannot overwrite Tail", () => {
  const draft = example();
  const row = draft.gismu!.rows[0];
  row.notes = [["Note: AI0"], ["Author note"], ["Tail"]];
  setSourceAiNoteGroup(row, [0]);
  const record = accept(draft, {
    word: "tome",
    notes: [["Sense: AI1"], ["Note: AI2"]],
  });
  const stale = structuredClone(
    row.sourceReview!.find(
      (mark) => mark.field === "notes" && mark.index === 2,
    )!,
  );
  choose(row, "stem", "keep");
  assert.ok(restorePatches(draft, record) > 0);
  assert.deepEqual(row.notes, [["Note: AI0"], ["Author note"], ["Tail"]]);
  assert.equal(
    row.sourceReview!.some((mark) => mark.field === "notes"),
    false,
  );
  row.sourceReview!.push(stale);
  resolveSourceReview(row, row.sourceReview!.length - 1, "keep");
  assert.deepEqual(row.notes, [["Note: AI0"], ["Author note"], ["Tail"]]);
});

test("undo restores multiple replaced marks after row reorder and preserves unrelated edits", () => {
  const draft = example();
  accept(draft, { word: "tome", notes: [] });
  const row = draft.gismu!.rows[0];
  const beforeMarks = structuredClone(row.sourceReview!);
  const record = accept(draft, {
    stem: "tom",
    ipa: "toʊm",
    input: { format: "lojbanized", text: "tom" },
    notes: [],
  });
  choose(row, "word_ipa", "keep");
  row.name = "New display name";
  draft.text = [["A newer definition"]];
  const other = { ...structuredClone(row), id: "other", sourceReview: [] };
  draft.gismu!.rows.unshift(other);
  restorePatches(draft, record);
  assert.equal(draft.gismu!.rows[1], row);
  assert.equal(row.name, "New display name");
  assert.deepEqual(draft.text, [["A newer definition"]]);
  for (const field of ["stem", "ipa", "input"])
    assert.deepEqual(
      row.sourceReview!.find((mark) => mark.field === field),
      beforeMarks.find((mark) => mark.field === field),
    );
  assert.equal(other.input, "tom");
  assert.deepEqual(other.sourceReview, []);
});

test("undo leaves absent rows absent", () => {
  const draft = example();
  accept(draft, { word: "tome", notes: [] });
  const record = accept(draft, {
    input: { format: "lojbanized", text: "tom" },
    notes: [],
  });
  draft.gismu!.rows = [];
  assert.ok(restorePatches(draft, record) > 0);
  assert.deepEqual(draft.gismu!.rows, []);
});

test("undo does not restore a mark when newer input prevents value restoration", () => {
  const draft = example();
  accept(draft, { word: "tome", notes: [] });
  const row = draft.gismu!.rows[0];
  const record = accept(draft, {
    input: { format: "lojbanized", text: "tom" },
    notes: [],
  });
  choose(row, "stem", "keep");
  row.input = "new";
  row.inputOriginal = { format: "lojbanized", text: "new" };
  restorePatches(draft, record);
  assert.equal(row.input, "new");
  assert.deepEqual(formationSource(row).input, {
    format: "lojbanized",
    text: "new",
  });
  assert.equal(
    row.sourceReview!.some((mark) => mark.field === "input"),
    false,
  );
});

test("undo does not revive a mark after the author independently restores its old value", () => {
  const draft = example();
  accept(draft, { word: "tome", notes: [] });
  const row = draft.gismu!.rows[0];
  const record = accept(draft, {
    stem: "tom",
    input: { format: "lojbanized", text: "tom" },
    notes: [],
  });
  row.stem = "book";
  restorePatches(draft, record);
  assert.equal(
    row.sourceReview!.some((mark) => mark.field === "stem"),
    false,
  );
});

test("undo preserves an unchanged mark once and honors Keep on an unchanged mark", () => {
  const draft = example();
  accept(draft, { word: "tome", notes: [] });
  const row = draft.gismu!.rows[0];
  const record = accept(draft, { stem: "tom", word_ipa: "bʊk", notes: [] });
  choose(row, "ipa", "keep");
  restorePatches(draft, record);
  assert.equal(
    row.sourceReview!.filter((mark) => mark.field === "word_ipa").length,
    1,
  );
  assert.equal(
    row.sourceReview!.filter((mark) => mark.field === "stem").length,
    1,
  );
  assert.equal(
    row.sourceReview!.some((mark) => mark.field === "ipa"),
    false,
  );
});

for (const action of ["keep", "clear"] as const) {
  test(`undo preserves a newer Notes ${action} among duplicate paragraphs`, () => {
    const draft = example();
    const row = draft.gismu!.rows[0];
    row.notes = [["Note: AI0"], ["Same"], ["Same"], ["Tail"]];
    setSourceAiNoteGroup(row, [0]);
    accept(draft, { word: "tome", notes: [["Note: AI0"]] });
    const record = accept(draft, { notes: [["Sense: AI1"], ["Note: AI2"]] });
    const index = row.sourceReview!.findIndex(
      (mark) => mark.field === "notes" && mark.index === 2,
    );
    resolveSourceReview(row, index, action);
    restorePatches(draft, record);
    assert.deepEqual(
      row.notes,
      action === "keep"
        ? [["Note: AI0"], ["Same"], ["Same"], ["Tail"]]
        : [["Sense: AI1"], ["Note: AI2"], ["Same"], ["Tail"]],
    );
    assert.deepEqual(
      row
        .sourceReview!.filter((mark) => mark.field === "notes")
        .map((mark) => ({ index: mark.index, value: mark.value })),
      [
        { index: 2, value: ["Same"] },
        { index: 3, value: ["Tail"] },
      ],
    );
  });
}

test("undo does not duplicate an equal mark already on the row", () => {
  const draft = example();
  accept(draft, { word: "tome", notes: [] });
  const row = draft.gismu!.rows[0];
  const mark = structuredClone(
    row.sourceReview!.find((entry) => entry.field === "input")!,
  );
  const record = accept(draft, {
    input: { format: "lojbanized", text: "tom" },
    notes: [],
  });
  row.sourceReview!.push(mark);
  restorePatches(draft, record);
  assert.equal(
    row.sourceReview!.filter((entry) => entry.field === "input").length,
    1,
  );
});

for (const original of [
  undefined,
  null,
  { format: "lojbanized", text: " Buk " },
  { format: "ipa", text: "bʊk" },
] as const) {
  test(`undo restores Letters snapshots with inputOriginal ${JSON.stringify(original)}`, () => {
    const draft = example();
    const row = draft.gismu!.rows[0];
    row.input = "Buk";
    if (original !== undefined) row.inputOriginal = structuredClone(original);
    accept(draft, { word: "tome", notes: [] });
    const mark = structuredClone(
      row.sourceReview!.find((mark) => mark.field === "input"),
    );
    const record = accept(draft, {
      input: { format: "lojbanized", text: "tom" },
      notes: [],
    });
    choose(row, "word_ipa", "keep");
    restorePatches(draft, record);
    assert.equal(row.input, "Buk");
    assert.equal(Object.hasOwn(row, "inputOriginal"), original !== undefined);
    assert.deepEqual(row.inputOriginal, original);
    assert.deepEqual(
      row.sourceReview!.find((entry) => entry.field === "input"),
      mark,
    );
  });
}

test("undo does not mark restored signed input over a newer private preview", () => {
  const draft = example();
  accept(draft, { word: "tome", notes: [] });
  const row = draft.gismu!.rows[0];
  const record = accept(draft, {
    input: { format: "lojbanized", text: "tom" },
    notes: [],
  });
  choose(row, "word_ipa", "keep");
  row.input = "new";
  restorePatches(draft, record);
  assert.equal(row.input, "new");
  assert.equal(
    row.sourceReview!.some((mark) => mark.field === "input"),
    false,
  );
});

for (const field of ["word_ipa", "stem", "ipa", "input", "notes"] as const) {
  test(`Keep removes a stale ${field} mark without changing data`, () => {
    const draft = example();
    const row = draft.gismu!.rows[0];
    accept(draft, { word: "tome", notes: [] });
    if (field === "notes") row.notes = [["A newer paragraph"]];
    else if (field === "input") {
      row.input = "new";
      row.inputOriginal = { format: "lojbanized", text: "new" };
    } else row[field] = "new";
    const before = structuredClone(row);
    choose(row, field, "keep");
    before.sourceReview = before.sourceReview!.filter(
      (mark) => mark.field !== field,
    );
    assert.deepEqual(row, before);
  });
}

test("Keep on a missing note removes only the stale mark", () => {
  const row = example().gismu!.rows[0];
  row.sourceReview = [
    { field: "notes", index: 8, word: "book", value: ["Old note"] },
  ];
  const notes = structuredClone(row.notes);
  assert.doesNotThrow(() => resolveSourceReview(row, 0, "keep"));
  assert.deepEqual(row.notes, notes);
  assert.deepEqual(row.sourceReview, []);
});

test("Keep on stale Said preserves the signed-null flag", () => {
  const row = example().gismu!.rows[0];
  row.word_ipa = null;
  row.wordIpaNullOriginal = true;
  row.sourceReview = [{ field: "word_ipa", word: "book", value: "bʊk" }];
  resolveSourceReview(row, 0, "keep");
  assert.equal(row.word_ipa, null);
  assert.equal(row.wordIpaNullOriginal, true);
});

test("Keep preserves a newer private preview even when signed input still matches", () => {
  const draft = example();
  const row = draft.gismu!.rows[0];
  row.inputOriginal = { format: "lojbanized", text: "buk" };
  accept(draft, { word: "tome", notes: [] });
  row.input = "new";
  choose(row, "input", "keep");
  assert.equal(row.input, "new");
  assert.deepEqual(row.inputOriginal, { format: "lojbanized", text: "buk" });
});

for (const original of [
  undefined,
  null,
  { format: "lojbanized", text: " Buk " },
  { format: "ipa", text: "bʊk" },
] as const) {
  test(`matching Keep preserves exact Letters and original-input presence ${JSON.stringify(original)}`, () => {
    const draft = example();
    const row = draft.gismu!.rows[0];
    row.input = "Buk";
    if (original !== undefined) row.inputOriginal = structuredClone(original);
    accept(draft, { word: "tome", notes: [] });
    if (original === null) return;
    choose(row, "input", "keep");
    assert.equal(row.input, "Buk");
    assert.equal(Object.hasOwn(row, "inputOriginal"), original !== undefined);
    assert.deepEqual(row.inputOriginal, original);
  });
}
