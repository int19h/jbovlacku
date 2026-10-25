import { before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { initializeCore } from "../../../../packages/core/src/index.ts";
import { currentDraft, sourceCurrent } from "../../src/model/assistance.ts";
import { manualFormation, newGismuState } from "../../src/model/builders.ts";
import {
  draftToBody,
  newDraft,
  newPlace,
  normalizeDraft,
} from "../../src/model/draft.ts";

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
const values = [
  1.5,
  Number.MAX_SAFE_INTEGER + 1,
  NaN,
  Infinity,
  -Infinity,
  "invalid",
];
function example() {
  return newDraft({
    spelling: "broda",
    kind: "gismu",
    text: "A test relation.",
    frameMode: "context",
    places: [
      {
        ...newPlace(1),
        kind: "custom",
        hint: {
          alternatives: [
            {
              tags: ["relation"],
              abstractor: null,
              relation_arity: { mode: "fixed", count: 1 },
            },
          ],
          note: [],
        },
      },
    ],
  });
}
for (const value of values) {
  test(`invalid stored relation count ${String(value)} stays editable and blocks publication`, () => {
    const stored = example();
    (stored.places[0].hint!.alternatives[0].relation_arity as any).count =
      value;
    // Older drafts can omit these outer fields even when another fragment is invalid.
    delete (stored as Partial<typeof stored>).formation;
    delete (stored as Partial<typeof stored>).compound;
    delete (stored as Partial<typeof stored>).sources;
    const original = structuredClone(stored);
    const loaded = normalizeDraft(stored);
    assert.deepEqual(
      (loaded.places[0].hint!.alternatives[0].relation_arity as any).count,
      value,
    );
    assert.equal(loaded.formation, null);
    assert.equal(loaded.compound, null);
    assert.deepEqual(loaded.sources, []);
    const problems = draftToBody(loaded).problems.filter(
      (problem) => problem.blocking,
    );
    assert.ok(problems.length > 0);
    if (value === 1.5) assert.equal(problems.length, 1);
    const current = currentDraft(loaded);
    assert.deepEqual(
      (
        current.frame!.places[0].type_hints[0].alternatives[0]
          .relation_arity as any
      ).count,
      value,
    );
    assert.deepEqual(stored, original);
  });
  test(`invalid stored variadic minimum ${String(value)} stays editable and blocks publication`, () => {
    const stored = example();
    stored.frameMode = "variadic";
    stored.variadicMinimum = value as number;
    stored.tail = { description: [], kind: "unspecified", hint: null };
    const loaded = normalizeDraft(structuredClone(stored));
    assert.deepEqual(loaded.variadicMinimum, value);
    assert.ok(draftToBody(loaded).problems.some((problem) => problem.blocking));
    assert.deepEqual((currentDraft(loaded).frame!.arity as any).minimum, value);
  });
}
test("an invalid stored Unicode source label stays in the draft and blocks publication", () => {
  const stored = example();
  stored.sources = [
    { label: "unpaired \ud800", url: null, event: null, locator: null },
  ];
  const original = structuredClone(stored);
  const loaded = normalizeDraft(stored);
  assert.deepEqual(loaded.sources, stored.sources);
  assert.ok(draftToBody(loaded).problems.some((problem) => problem.blocking));
  assert.doesNotThrow(() => currentDraft(loaded));
  assert.deepEqual(stored, original);
});
test("invalid selected source text survives both current projections without changing the draft", () => {
  const rows = [
    {
      id: "source",
      language: "en",
      name: "English",
      word: "unpaired \ud800",
      input: "buk",
      weight: { numerator: "1", denominator: "1" },
      notes: [],
    },
  ];
  const draft = newDraft({
    spelling: "broda",
    kind: "gismu",
    text: "A test root.",
    gismu: { ...newGismuState(), rows },
    formation: manualFormation(rows, ""),
    evidenceForm: "broda",
  });
  const loaded = normalizeDraft(structuredClone(draft));
  const original = structuredClone(loaded);
  const current = currentDraft(loaded);
  const selected = sourceCurrent(loaded, "source");
  assert.equal(selected.formation!.sources[0].word, "unpaired \ud800");
  assert.deepEqual(selected.formation!.sources, current.formation!.sources);
  assert.ok(draftToBody(loaded).problems.some((problem) => problem.blocking));
  assert.deepEqual(loaded, original);
});
test("invalid stored formation numbers stay editable without changing their value", () => {
  for (const value of values) {
    const stored = example();
    stored.formation = {
      method: "non-algorithmic",
      algorithm: null,
      sources: [],
      weights_profile: null,
      generated: null,
      selected_score: null,
      selected_rank: value as number,
      selection_reason: [],
      candidates: [],
      conflicts: [],
    };
    const original = structuredClone(stored);
    const loaded = normalizeDraft(stored);
    assert.deepEqual(loaded.formation!.selected_rank, value);
    assert.deepEqual(currentDraft(loaded).formation!.selected_rank, value);
    assert.ok(draftToBody(loaded).problems.some((problem) => problem.blocking));
    assert.deepEqual(stored, original);
  }
});
