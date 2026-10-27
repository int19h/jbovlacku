import assert from "node:assert/strict";
import test from "node:test";
import { analyzeWord, BuilderError, segmentText } from "../src/index.ts";
import { recognizeWords } from "../src/recognize.ts";

const warning = "This form is not valid under the current BPFK morphology.";

test("text segmentation recovers only complete runs and exposes foreign spans", () => {
  const input = "mi baoz do.uy la olje";
  const parsed = segmentText(input);
  assert.deepEqual(
    parsed.words.map(({ text }) => text),
    ["mi", "do", "uy", "la", "olje"],
  );
  assert.deepEqual(parsed.foreign, [{ text: "baoz", start: 3, end: 7 }]);
  assert.deepEqual(segmentText("mibaoz").words, []);
  assert.deepEqual(segmentText("mibaoz").foreign, [
    { text: "mibaoz", start: 0, end: 6 },
  ]);
  assert.deepEqual(recognizeWords(input).words, []);
  assert.equal(analyzeWord("extended-v4", "broda qqq").kind, "unknown");
});

test("text segmentation has separate aggregate limits from headwords", () => {
  const input = "mi klama ".repeat(100);
  const parsed = segmentText(input);
  assert.equal(parsed.words.length, 200);
  assert.throws(() => segmentText("mi".repeat(65)), /text run phonemes/);
  assert.deepEqual(parsed.foreign, []);
  assert.equal(analyzeWord("extended-v4", input).kind, "unknown");
  assert.throws(
    () => segmentText(input, { byteLimit: input.length - 1 }),
    /text bytes/,
  );
  assert.deepEqual(segmentText(input, { workLimit: parsed.spent }), parsed);
  assert.throws(
    () => segmentText(input, { workLimit: parsed.spent - 1 }),
    (error: unknown) =>
      error instanceof BuilderError &&
      error.failure.kind === "resource-limit" &&
      error.failure.measure === "text recognition work" &&
      error.failure.value === parsed.spent &&
      error.failure.limit === parsed.spent - 1,
  );
  assert.throws(
    () => segmentText(input, { workLimit: Infinity }),
    /nonnegative safe integers/,
  );
});

test("text punctuation and spelling transformations preserve original UTF-16 spans", () => {
  const input = "😀 ‘mi’ 2 atkwila";
  const parsed = segmentText(input);
  assert.deepEqual(
    parsed.words.map(({ text, start, end }) => ({ text, start, end })),
    [
      { text: "mi", start: 4, end: 6 },
      { text: "re", start: 8, end: 9 },
      { text: "atkuila", start: 10, end: 17 },
    ],
  );
  assert.deepEqual(parsed.words[2].diagnostics, [warning]);
  assert.deepEqual(parsed.foreign, []);
});

test("marked glides apply only to text mode and retain their phonological roles", () => {
  for (const [input, expected] of [
    ["qa", "ia"],
    ["wa", "ua"],
    ["maĭ", "mai"],
    ["coĭ", "coi"],
    ["kaŭ", "kau"],
  ]) {
    assert.deepEqual(
      segmentText(input).words.map(({ text }) => text),
      [expected],
      input,
    );
  }
  for (const input of ["mɩ", "mĭ", "kaw", "www", "aiɩa"]) {
    assert.deepEqual(segmentText(input).words, [], input);
    assert.equal(segmentText(input).foreign.length, 1, input);
  }
  for (const input of ["qa", "atkwila"]) {
    assert.deepEqual(recognizeWords(input).words, [], input);
    assert.equal(analyzeWord("extended-v4", input).kind, "unknown", input);
  }
});

test("text mode keeps stress while headword case handling stays unchanged", () => {
  assert.deepEqual(
    segmentText("BROdaku").words.map(({ text }) => text),
    ["brOda", "ku"],
  );
  assert.deepEqual(
    segmentText("BRODA").words.map(({ text }) => text),
    ["broda"],
  );
  assert.equal(analyzeWord("extended-v4", "BROdaku").kind, "fuhivla");
});

test("text mode keeps magic words ordinary and rejects false CgV warnings", () => {
  const parsed = segmentText("zo skiuarna zei broda si y bu");
  assert.deepEqual(
    parsed.words.map(({ text }) => text),
    ["zo", "skiuarna", "zei", "broda", "si", "y", "bu"],
  );
  assert.ok(parsed.words.every(({ diagnostics }) => diagnostics.length === 0));
  assert.deepEqual(parsed.foreign, []);
});
