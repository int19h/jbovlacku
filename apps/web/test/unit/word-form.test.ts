import { before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { initializeCore } from "../../../../packages/core/src/index.ts";
import { newDraft, draftToBody } from "../../src/model/draft.ts";
import { newLujvoState } from "../../src/model/builders.ts";
import { typedLujvoState } from "../../src/model/typed-headword.ts";
import {
  detectWord,
  setExperimental,
  wordFormFeedback,
  wordFormProfile,
  supportsJoins,
} from "../../src/model/word-form.ts";
import type { LexicalKind } from "../../src/model/types.ts";
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

test("new detection and builder state use morphology version 4", () => {
  assert.equal(newLujvoState().profile, "extended-v4");
  assert.equal(detectWord("ckusni").morphology.version, "4");
  assert.equal(
    typedLujvoState("ckusni", detectWord("ckusni").readings[0], null).profile,
    "extended-v4",
  );
  assert.ok(supportsJoins("extended-v4"));
  assert.ok(supportsJoins("extended"));
  assert.equal(supportsJoins("extended-v2"), false);
});
test("every selected lexical shape gets immediate mismatch feedback", () => {
  for (const [kind, spelling] of [
    ["gismu", "bangu"],
    ["lujvo", "ckusni"],
    ["fuhivla", "leksiko"],
    ["cmavo", "lo"],
    ["cmevla", ".lojban."],
    ["compound", "taia"],
  ] as [LexicalKind, string][]) {
    const draft = newDraft({ kind, spelling, text: "A test definition." });
    assert.equal(wordFormFeedback(draft).blocking, false, kind);
    draft.spelling = "zzzz";
    assert.equal(wordFormFeedback(draft).blocking, true, kind);
    assert.match(
      wordFormFeedback(draft).text,
      /The spelling does not match the selected/,
    );
    assert.ok(
      draftToBody(draft).problems.some(
        (problem) => problem.field === "kind" && problem.blocking,
      ),
    );
  }
});
test("experimental labels and Other keep mismatched forms available", () => {
  const draft = newDraft({
    kind: "gismu",
    spelling: "leksiko",
    text: "A test definition.",
  });
  assert.equal(wordFormFeedback(draft).blocking, true);
  setExperimental(draft, true);
  assert.deepEqual(draft.labels, ["experimental"]);
  assert.equal(wordFormFeedback(draft).blocking, false);
  assert.match(
    wordFormFeedback(draft).text,
    /The experimental label permits this classification/,
  );
  assert.equal(
    draftToBody(draft).problems.some(
      (problem) => problem.field === "kind" && problem.blocking,
    ),
    false,
  );
  setExperimental(draft, false);
  assert.equal(wordFormFeedback(draft).blocking, true);
  draft.kind = "other";
  assert.equal(wordFormFeedback(draft).blocking, false);
  assert.match(wordFormFeedback(draft).text, /Detected form: fu'ivla/);
});
test("cmavo clusters split by morphology and preserve hesitation words", () => {
  for (const [spelling, parts] of [
    ["taia", ["tai", "a"]],
    ["i'ecu'i", ["i'e", "cu'i"]],
    ["y bu", ["y", "bu"]],
  ] as const) {
    const analysis = detectWord(spelling);
    assert.equal(analysis.kind, "compound");
    assert.deepEqual(
      analysis.words?.map((word) => word.text),
      parts,
    );
    const draft = newDraft({ kind: "compound", spelling });
    assert.equal(wordFormFeedback(draft).blocking, false);
    draft.kind = "cmavo";
    assert.equal(wordFormFeedback(draft).blocking, true);
  }
  for (const spelling of ["y", "yyy", "ie'o"])
    assert.equal(detectWord(spelling).kind, "cmavo");
});
test("accepted CgV forms show the exact BPFK warning without blocking", () => {
  for (const [spelling, kind] of [
    ["cian", "cmevla"],
    ["sliagri", "fuhivla"],
  ] as const) {
    const feedback = wordFormFeedback(newDraft({ spelling, kind }));
    assert.equal(feedback.blocking, false);
    assert.match(
      feedback.text,
      /This form is not valid under the current BPFK morphology\./,
    );
  }
});

test("the Peggy headword check does not remove a second pair of framing periods", () => {
  assert.equal(detectWord("..sairzba..").kind, "unknown");
  assert.equal(detectWord(".sairzba.").kind, "lujvo");
});
test("historical compound evidence and typed restoration keep their profile", () => {
  const draft = newDraft({
    kind: "lujvo",
    spelling: "ckusni",
    evidenceForm: "ckusni",
  });
  draft.compound = {
    components: [],
    morphology: {
      id: "https://github.com/int19h/jbovlacku/blob/main/docs/morphology.md#extended-lujvo",
      version: "3",
    },
    scoring: { id: "test", version: "1" },
    score: 0,
    notes: [],
  };
  assert.equal(wordFormProfile(draft), "extended");
  assert.equal(wordFormFeedback(draft).blocking, false);
  draft.spelling = "ckusnu";
  assert.equal(wordFormProfile(draft), "extended-v4");
  draft.lujvo = {
    ...newLujvoState(),
    restoredEvidenceHistory: [{ spelling: "ckusnu", profile: "extended-v2" }],
  };
  assert.equal(wordFormProfile(draft), "extended-v2");
  assert.equal(detectWord("ckusni", "extended").morphology.version, "3");
});

test("unavailable historical profiles stay visible without replacing evidence", () => {
  const draft = newDraft({
    kind: "lujvo",
    spelling: "ckusni",
    evidenceForm: "ckusni",
  });
  draft.compound = {
    components: [],
    morphology: { id: "https://example.invalid/morphology", version: "9" },
    scoring: { id: "test", version: "1" },
    score: 0,
    notes: [],
  };
  assert.match(
    wordFormFeedback(draft).text,
    /Word-form check unavailable. Unsupported morphology/,
  );
  assert.equal(draft.compound.morphology.version, "9");
});
