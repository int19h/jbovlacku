import { before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { initializeCore } from "../../../../packages/core/src/index.ts";
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
    samePresence(currentDraft(loaded).formation!.sources[0]);
    samePresence(
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
    samePresence(currentDraft(revised).formation!.sources[0]);
    revised.spelling = "";
    revised.kind = null;
    samePresence(currentDraft(revised).formation!.sources[0]);
  });
}
