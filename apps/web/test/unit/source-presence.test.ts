import { before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  createEvent,
  initializeCore,
  wordId,
} from "../../../../packages/core/src/index.ts";
import { currentDraft, sourceCurrent } from "../../src/model/assistance.ts";
import {
  formationSource,
  manualFormation,
  newGismuState,
  sourceRowsFromFormation,
} from "../../src/model/builders.ts";
import {
  draftFromBody,
  draftToBody,
  newDraft,
  normalizeDraft,
} from "../../src/model/draft.ts";
import type { DefinitionBody, FormationSource } from "../../src/model/types.ts";

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

for (const present of [true, false]) {
  test(`source pronunciation ${present ? "explicit null" : "absence"} survives selection, publication, Revise, and requests`, () => {
    const source: FormationSource = {
      language: "en",
      word: "book",
      input: { format: "lojbanized", text: "Buk" },
      weight: { numerator: 1, denominator: 1 },
      notes: [["Historical note"]],
      ...(present ? { word_ipa: null } : {}),
    };
    const samePresence = (actual: FormationSource) => {
      assert.equal(Object.hasOwn(actual, "word_ipa"), present);
      if (present) assert.equal(actual.word_ipa, null);
      assert.deepEqual(actual, source);
    };
    const sameCurrent = (actual: FormationSource) => {
      assert.deepEqual(actual, { ...source, word_ipa: null });
    };
    const rows = sourceRowsFromFormation([source]);
    samePresence(formationSource(rows[0]));
    const formation = manualFormation(rows, "An unchanged source.")!;
    samePresence(formation.sources[0]);
    const draft = newDraft({
      kind: "gismu",
      spelling: "brodu",
      text: "A book.",
      formation,
      evidenceForm: "brodu",
      gismu: { ...newGismuState(), rows },
    });
    const loaded = normalizeDraft(JSON.parse(JSON.stringify(draft)));
    const published = draftToBody(loaded);
    assert.deepEqual(published.problems, []);
    samePresence(published.body!.etymology.formation!.sources[0]);
    const signed = createEvent(
      new Uint8Array(32).fill(74),
      [],
      "1".repeat(32),
      {
        kind: "definition.publish",
        word: wordId(published.body!.word),
        language: "en",
        parents: [],
        origin: "native",
      },
      published.body,
    );
    assert.equal(
      Object.hasOwn(
        (signed.body as DefinitionBody).etymology.formation!.sources[0],
        "word_ipa",
      ),
      false,
    );
    samePresence(published.body!.etymology.formation!.sources[0]);
    sameCurrent(currentDraft(loaded).formation!.sources[0]);
    sameCurrent(
      sourceCurrent(loaded, loaded.gismu!.rows[0].id!).formation!.sources[0],
    );
    const revised = normalizeDraft(
      JSON.parse(
        JSON.stringify(
          draftFromBody(published.body!, "jve1:" + "1".repeat(64), "native"),
        ),
      ),
    );
    assert.equal(revised.gismu, null);
    samePresence(draftToBody(revised).body!.etymology.formation!.sources[0]);
    sameCurrent(currentDraft(revised).formation!.sources[0]);
    revised.spelling = "";
    revised.kind = null;
    sameCurrent(currentDraft(revised).formation!.sources[0]);
  });
}

test("source requests interpret absent pronunciation without changing raw rows or exposing private fields", () => {
  for (const present of [false, true]) {
    const source: FormationSource = {
      language: "en",
      word: "book",
      input: null,
      weight: null,
      notes: [],
      ...(present ? { word_ipa: null } : {}),
    };
    const rows = sourceRowsFromFormation([source]);
    rows[0].stem = "private stem";
    rows[0].ipa = "private pronunciation";
    rows[0].aiNoteGroup = [];
    rows[0].sourceReview = [];
    const draft = newDraft({
      kind: "gismu",
      spelling: "brodu",
      text: "A book.",
      formation: manualFormation(rows, ""),
      evidenceForm: "brodu",
      gismu: { ...newGismuState(), rows },
    });
    const before = structuredClone(draft);
    const current = sourceCurrent(draft, rows[0].id!);
    assert.deepEqual(current.formation!.sources[0], {
      ...source,
      word_ipa: null,
    });
    for (const key of [
      "id",
      "stem",
      "ipa",
      "name",
      "inputOriginal",
      "aiNoteGroup",
      "sourceReview",
      "wordIpaNullOriginal",
    ])
      assert.equal(Object.hasOwn(current.formation!.sources[0], key), false);
    assert.deepEqual(draft, before);
    assert.deepEqual(formationSource(draft.gismu!.rows[0]), source);
    assert.equal(
      Object.hasOwn(formationSource(draft.gismu!.rows[0]), "word_ipa"),
      present,
    );
  }
});
