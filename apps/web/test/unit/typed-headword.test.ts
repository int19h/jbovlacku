import { before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  initializeCore,
  buildLujvo,
  type WordAnalysis,
} from "../../../../packages/core/src/index.ts";
import {
  changeTypedWord,
  detectWord,
  readingOptions,
  sourceOptions,
  typedLujvoState,
  typedWord,
} from "../../src/model/typed-headword.ts";
import { newDraft, normalizeDraft } from "../../src/model/draft.ts";
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
  ]) {
    const analysis = detectWord(spelling);
    const state = typedLujvoState(spelling, analysis.readings[0], null);
    const result = buildLujvo({
      profile: state.profile,
      components: state.components,
      joins: state.joins,
    });
    assert.equal(result.candidates.length, 1, spelling);
    assert.equal(result.candidates[0].spelling, spelling);
    assert.equal(result.candidates[0].tokens.join(""), spelling);
  }
});

test("a second analysis reading keeps its exact parts and joins through reload", () => {
  const first = [
    { text: "bau", kind: "rafsi" as const, join_before: null },
    { text: "kla", kind: "rafsi" as const, join_before: "r" },
  ];
  const second = [
    { text: "bangu", kind: "core" as const, join_before: null },
    { text: "klama", kind: "rafsi" as const, join_before: "'y" },
  ];
  const analysis = {
    ...detectWord("baukla"),
    readings: [first, second],
  } satisfies WordAnalysis;
  const options = readingOptions(analysis);
  const state = typedLujvoState("bangu'yklama", options[1].parts, null, 1);
  const restored = normalizeDraft(newDraft({ lujvo: state })).lujvo!;
  assert.equal(restored.readingIndex, 1);
  assert.deepEqual(restored.typedReading, second);
  assert.deepEqual(restored.joins, ["'y"]);
  assert.deepEqual(
    restored.components.map((component) => component.locked),
    ["bangu", "klama"],
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
