import { before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { initializeCore } from "../../../../packages/core/src/index.ts";
import {
  newDraft,
  draftFromBody,
  draftToBody,
  normalizeDraft,
} from "../../src/model/draft.ts";
import { detectWord, wordFormFeedback } from "../../src/model/word-form.ts";
import {
  buildLujvoState,
  changeTypedWord,
  prepareLujvoBuilder,
  selectLujvoCandidate,
  sourceOptions,
} from "../../src/model/typed-headword.ts";
import {
  currentCompoundConflicts,
  inventoryFromPackage,
  isZeiLujvoState,
} from "../../src/model/builders.ts";
import type { CachedPackage } from "../../src/data/search.ts";

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

// These headwords occur in the imported Lensisku dictionary. The tests use synthetic definitions.
const imported = [
  "batke zei uidje",
  "ci zei tuple",
  "cy zei bai'ei zei bangu",
  "ibu zei sance",
  "denpa bu zei sance",
  "ka'ozeino zei namcu",
];
const componentWords = (spelling: string) =>
  spelling === "ka'ozeino zei namcu"
    ? ["ka'o", "no", "namcu"]
    : spelling.split(" zei ");
const imports = JSON.parse(
  readFileSync(
    new URL(
      "../../../../packages/morphology/evidence/zei-lujvo-imports.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const definition = "jve1:" + "a".repeat(64);
const cached = {
  snapshot: "sha256:" + "a".repeat(64),
  version: 2,
  entries: ["cukta", "dunda", "bangu"].map((spelling, index) => ({
    event: index === 0 ? definition : "jve1:" + String(index).repeat(64),
    word: { language: "jbo", spelling },
    language: "en",
    glosses: [],
    plain_text: `Synthetic ${spelling} definition.`,
    classification: { kind: "gismu", selmaho: [] },
    body: null,
    issuer: "ed25519:" + "a".repeat(64),
    notes: false,
    rafsi: ["cukta"],
    rafsi_complete: true,
    attribution: null,
  })),
} as CachedPackage;

test("imported zei headwords and longer chains pass the lujvo word-type check", () => {
  for (const spelling of imported) {
    assert.ok(
      imports.cases.some(
        (entry: { spelling: string }) => entry.spelling === spelling,
      ),
    );
    const draft = newDraft({
      kind: "lujvo",
      spelling,
      typedSpelling: spelling,
      text: "Synthetic definition.",
    });
    assert.equal(wordFormFeedback(draft).blocking, false, spelling);
    assert.equal(detectWord(spelling).kind, "lujvo");
    const state = prepareLujvoBuilder(draft, null);
    assert.ok(isZeiLujvoState(state));
    assert.deepEqual(
      state.components.map((part) => part.spelling),
      componentWords(spelling),
    );
    assert.ok(state.components.every((part) => part.claims.length === 0));
    const result = buildLujvoState(state);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].tokens.join(""), spelling);
    selectLujvoCandidate(draft, result, result.candidates[0], true);
    assert.equal(draft.compound!.score, null);
    assert.deepEqual(
      draft.compound!.components.map((part) => part.rafsi),
      componentWords(spelling),
    );
    assert.equal(
      draftToBody(draft).problems.some((problem) => problem.blocking),
      false,
    );
  }
});

test("malformed zei chains remain blocked as lujvo definitions", () => {
  for (const spelling of [
    "zei cukta",
    "cukta zei",
    "cukta zei zei dunda",
    "cukta dunda zei bangu",
    "cukta zei zz",
  ]) {
    assert.equal(
      wordFormFeedback(newDraft({ kind: "lujvo", spelling })).blocking,
      true,
      spelling,
    );
  }
});

test("zei feedback blocks final BU tails and keeps nonfinal BU operands", () => {
  for (const spelling of [
    "sance zei denpa bu",
    "broda zei brode bu",
    "abu zei abu",
    "broda zei brode bu bu",
  ]) {
    const feedback = wordFormFeedback(newDraft({ kind: "lujvo", spelling }));
    assert.equal(feedback.blocking, true, spelling);
    assert.match(feedback.message, /does not match the selected lujvo type/);
    assert.notEqual(detectWord(spelling).kind, "lujvo", spelling);
  }
  for (const spelling of [
    "denpa bu zei sance",
    "broda zei denpa bu zei sance",
    "abu zei broda",
    "y'y zei bu",
  ]) {
    const draft = newDraft({ kind: "lujvo", spelling, typedSpelling: spelling });
    assert.equal(wordFormFeedback(draft).blocking, false, spelling);
    assert.equal(detectWord(spelling).kind, "lujvo", spelling);
    const state = prepareLujvoBuilder(draft, null);
    assert.ok(isZeiLujvoState(state), spelling);
    assert.equal(buildLujvoState(state).candidates[0].spelling, spelling);
  }
});

test("zei component lookup ignores competing rafsi assignments", () => {
  const part = detectWord("cukta zei dunda").readings[0][0];
  const options = sourceOptions(part, cached, true);
  assert.deepEqual(
    options.map((option) => option.spelling),
    ["cukta"],
  );
  assert.deepEqual(options[0].claims, []);
});

test("zei definition links survive draft reload and signed-body restoration without rafsi claims", () => {
  const spelling = "CUKTA  ZEI dunda";
  let draft = newDraft({
    kind: "lujvo",
    spelling,
    typedSpelling: spelling,
    text: "Synthetic definition.",
  });
  let state = prepareLujvoBuilder(draft, cached);
  state.components[0].definition = definition;
  draft = normalizeDraft(structuredClone(draft));
  state = prepareLujvoBuilder(draft, cached);
  const result = buildLujvoState(state);
  assert.equal(result.candidates[0].spelling, spelling);
  selectLujvoCandidate(draft, result, result.candidates[0], true);
  assert.equal(draft.compound!.components[0].definition, definition);
  assert.deepEqual(
    currentCompoundConflicts(draft.compound!, inventoryFromPackage(cached)),
    [],
  );
  const publication = draftToBody(draft);
  assert.deepEqual(
    publication.problems.filter((problem) => problem.blocking),
    [],
  );
  const revised = draftFromBody(
    publication.body!,
    "jve1:" + "c".repeat(64),
    "native",
  );
  const restored = prepareLujvoBuilder(revised, cached);
  assert.equal(restored.typedOrigin, true);
  assert.equal(restored.components[0].definition, definition);
  assert.ok(restored.components.every((part) => part.claims.length === 0));
  assert.equal(buildLujvoState(restored).candidates[0].spelling, spelling);
});

test("editing a zei headword does not transfer an exact definition to a different component", () => {
  const draft = newDraft({
    kind: "lujvo",
    spelling: "cukta zei dunda",
    typedSpelling: "cukta zei dunda",
  });
  prepareLujvoBuilder(draft, cached).components[0].definition = definition;
  changeTypedWord(draft, "bangu zei dunda");
  const state = prepareLujvoBuilder(draft, cached);
  assert.equal(state.components[0].spelling, "bangu");
  assert.equal(state.components[0].definition, null);
  assert.equal(
    buildLujvoState(state).candidates[0].spelling,
    "bangu zei dunda",
  );
});
