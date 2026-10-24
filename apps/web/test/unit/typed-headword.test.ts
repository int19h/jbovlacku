import { before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  initializeCore,
  buildLujvo,
  morphologyProfile,
  analyzeWord as awaitlessAnalyze,
} from "../../../../packages/core/src/index.ts";
import {
  changeTypedWord,
  detectWord,
  typedLujvoRequest,
  linkedSources,
  sourceOptions,
  typedLujvoState,
  typedWord,
} from "../../src/model/typed-headword.ts";
import { newDraft, normalizeDraft } from "../../src/model/draft.ts";
import { compoundMetadata } from "../../src/model/builders.ts";
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

test("typed detection preserves identity spelling and exposes unknown diagnostics", () => {
  for (const [spelling, kind] of [
    ["bangu", "gismu"],
    ["leksiko", "fuivla"],
    ["ckusni", "lujvo"],
    ["lo", "cmavo"],
    [".lojban.", "cmevla"],
    [".djeimz.", "cmevla"],
    [".akme", "fuivla"],
    [".i", "cmavo"],
    ["zzzz", "unknown"],
  ])
    assert.equal(detectWord(spelling).kind, kind);
  assert.equal(typedWord("  BAU,CLA  "), "BAU,CLA");
  assert.ok(
    detectWord("b".repeat(129)).diagnostics.some((line) =>
      line.includes("128"),
    ),
  );
});

test("all typed lujvo hydrate exact locks and reproduce their spelling", () => {
  for (const spelling of [
    "ckusni",
    "cuktysinxa",
    "sairzba",
    "spageti'ybroda",
    "spageti'ykla",
    "kerlybai'ybroda",
    "kerlybla'ykla",
    "bangu'y'ismu",
    "sakrsakysakli",
    "klama'ybroda",
    "kerlyxambrga",
    ".eiksyselrirni",
    ".eiksyspe",
    ".SAI,rZBA.",
  ]) {
    const analysis = detectWord(spelling);
    const state = typedLujvoState(spelling, analysis.readings[0], null);
    assert.equal(state.typedOrigin, true);
    assert.equal(linkedSources(state), false);
    assert.ok(state.components.every((component) => component.spelling === ""));
    const result = buildLujvo(typedLujvoRequest(state));
    assert.equal(result.candidates.length, 1, spelling);
    assert.equal(result.candidates[0].spelling, spelling);
    assert.equal(result.candidates[0].tokens.join(""), spelling);
  }
});

test("stored morphology selects the actual version and rejects unknown evidence", () => {
  const id =
    "https://github.com/int19h/jbovlacku/blob/main/docs/morphology.md#extended-lujvo";
  const profile = morphologyProfile({ id, version: "2" });
  assert.equal(profile, "extended-v2");
  const analysis = awaitlessAnalyze(profile, "ckusni'ybroda");
  assert.deepEqual(
    analysis.readings[0].map((part) => part.text),
    ["ckusni", "broda"],
  );
  const state = {
    ...typedLujvoState("ckusni'ybroda", analysis.readings[0], null),
    profile,
  };
  state.components[0].spelling = "ckusni";
  state.components[0].kind = "lujvo";
  state.components[1].spelling = "broda";
  state.components[1].kind = "gismu";
  const rebuilt = buildLujvo(typedLujvoRequest(state));
  assert.equal(rebuilt.morphology.version, "2");
  assert.equal(rebuilt.candidates[0].spelling, "ckusni'ybroda");
  assert.throws(
    () => morphologyProfile({ id, version: "4" }),
    /Unsupported morphology/,
  );
});

test("source-word ambiguity stays unresolved until the author chooses", () => {
  const cached = {
    snapshot: "sha256:" + "a".repeat(64),
    version: 2,
    entries: ["cukta", "cukte"].map((spelling, index) => ({
      event: "jve1:" + String(index).repeat(64),
      word: { language: "jbo", spelling },
      language: "en",
      glosses: [],
      plain_text: spelling,
      classification: { kind: "gismu", selmaho: [] },
      body: null,
      issuer: "ed25519:" + "a".repeat(64),
      notes: false,
      rafsi: ["cku"],
      rafsi_complete: true,
      attribution: null,
    })),
  } as CachedPackage;
  const parts = detectWord("ckusni").readings[0];
  const options = sourceOptions(parts[0], cached);
  assert.deepEqual(
    options.map((option) => option.spelling),
    ["cukta", "cukte"],
  );
  const state = typedLujvoState("ckusni", parts, cached);
  assert.equal(state.components[0].unresolvedSource, "Choose a source word.");
  state.components[0] = options[1];
  state.components[0].definition = options[1].definitions![0].event;
  const restored = normalizeDraft(newDraft({ lujvo: state })).lujvo!;
  assert.equal(restored.components[0].spelling, "cukte");
  assert.equal(restored.components[0].locked, "cku");
  assert.equal(
    restored.components[0].definition,
    options[1].definitions![0].event,
  );
});

test("later spelling edits keep annotations and mark retained evidence for review", () => {
  const draft = newDraft({
    spelling: "ckusni",
    text: "A bookmark.",
    glosses: [{ language: "en", text: "bookmark", sense: "" }],
    formation: {
      method: "unknown",
      sources: [],
      algorithm: null,
      weights_profile: null,
      generated: null,
      selected_score: null,
      selected_rank: null,
      selection_reason: [],
      candidates: [],
      conflicts: [],
    },
    evidenceForm: "ckusni",
    publishAcknowledged: ["old"],
  });
  changeTypedWord(draft, "ckusro");
  assert.equal(draft.evidenceForm, "ckusni");
  assert.equal(draft.formation?.method, "unknown");
  assert.deepEqual(draft.text, [["A bookmark."]]);
  assert.equal(draft.glosses[0].text, "bookmark");
  assert.deepEqual(draft.review, ["spelling"]);
  assert.deepEqual(draft.publishAcknowledged, []);
});

test("changing or clearing a typed spelling restores editable component rows", () => {
  for (const spelling of ["", "baukla"]) {
    const state = typedLujvoState(
      "ckusni",
      detectWord("ckusni").readings[0],
      null,
    );
    const draft = newDraft({ spelling: "ckusni", lujvo: state });
    changeTypedWord(draft, spelling);
    assert.equal(draft.lujvo?.typedOrigin, undefined);
    assert.equal(draft.lujvo?.typed, undefined);
    assert.equal(draft.lujvo?.joins, undefined);
    assert.equal(draft.lujvo?.selected, null);
    assert.equal(draft.lujvo?.components.length, 2);
    assert.equal(draft.lujvo?.ordinarySpelling, "");
    changeTypedWord(draft, "ckusni");
    assert.equal(draft.lujvo?.ordinarySpelling, "");
  }
});

test("unknown sources cannot become signed compound attribution", () => {
  const state = typedLujvoState(
    "ckusni",
    detectWord("ckusni").readings[0],
    null,
  );
  const result = buildLujvo(typedLujvoRequest(state));
  assert.throws(
    () => compoundMetadata(result, result.candidates[0], state.components, ""),
    /Link every source/,
  );
  for (const [index, spelling] of ["cukta", "sinxa"].entries()) {
    state.components[index].spelling = spelling;
    delete state.components[index].unresolvedSource;
  }
  assert.deepEqual(
    compoundMetadata(
      result,
      result.candidates[0],
      state.components,
      "",
    ).components.map((part) => part.word.spelling),
    ["cukta", "sinxa"],
  );
});
