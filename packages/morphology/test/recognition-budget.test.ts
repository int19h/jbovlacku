import assert from "node:assert/strict";
import test from "node:test";
import { analyzeWord, buildLujvo, BuilderError } from "../src/index.ts";
import { PEG_WORK_LIMIT, recognizeWords } from "../src/recognize.ts";
import type { LujvoRequest } from "../src/types.ts";

// Highest counts from a bounded search of repeated forms and byte mutations.
// These examples are not proven maxima over every valid 128-byte input.
const boundaryLujvo = "ron".repeat(42) + "ro";
const boundaryCompound = "ruryro".repeat(21) + "ru";
const lujvoCases = [
  { spelling: "kem".repeat(41) + "bra", bytes: 126, entries: 51_508 },
  { spelling: "kem".repeat(41) + "broda", bytes: 128, entries: 52_368 },
  { spelling: boundaryLujvo, bytes: 128, entries: 53_800 },
];

function exhausted(value: number, limit: number) {
  return (error: unknown): boolean =>
    error instanceof BuilderError &&
    error.failure.kind === "resource-limit" &&
    error.failure.measure === "recognition work" &&
    error.failure.value === value &&
    error.failure.limit === limit;
}

for (const { spelling, bytes, entries } of lujvoCases) {
  test(`v4 analyzes and rebuilds the ${bytes}-byte lujvo that needs ${entries} rule entries`, () => {
    assert.equal(Buffer.byteLength(spelling), bytes);
    assert.throws(
      () => recognizeWords(spelling, 50_000),
      exhausted(50_001, 50_000),
    );
    const parsed = recognizeWords(spelling);
    assert.equal(parsed.spent, entries);
    assert.equal(parsed.words.length, 1);
    assert.equal(parsed.words[0].kind, "lujvo");

    const analysis = analyzeWord("extended-v4", spelling);
    assert.equal(analysis.kind, "lujvo");
    assert.deepEqual(analysis.diagnostics, []);
    assert.equal(analysis.readings.length, 1);
    const reading = analysis.readings[0];
    assert.equal(reading.length, 42);
    const request: LujvoRequest = {
      profile: "extended-v4",
      spelling,
      joins: reading.slice(1).map((part) => part.join_before ?? ""),
      components: reading.map((part, index) => ({
        id: String(index),
        spelling: part.text,
        kind: "other",
        locked: part.text,
      })),
    };
    const built = buildLujvo(request);
    assert.equal(built.complete, true);
    assert.equal(built.considered, 1);
    assert.equal(built.candidates.length, 1);
    assert.equal(built.candidates[0].spelling, spelling);
    assert.equal(built.candidates[0].tokens.join(""), spelling);
    assert.deepEqual(built.candidates[0].recovered, reading);
  });
}

test("v4 analyzes the 128-byte compound cmavo with the highest count found", () => {
  assert.equal(Buffer.byteLength(boundaryCompound), 128);
  const parsed = recognizeWords(boundaryCompound);
  assert.equal(parsed.spent, 43_252);
  const analysis = analyzeWord("extended-v4", boundaryCompound);
  assert.equal(analysis.kind, "compound");
  assert.deepEqual(analysis.diagnostics, []);
  assert.deepEqual(analysis.readings, []);
  assert.deepEqual(
    analysis.words?.map(({ text, kind, start, end }) => ({
      text,
      kind,
      start,
      end,
    })),
    [...Array.from({ length: 21 }, () => ["ru", "ry", "ro"]).flat(), "ru"].map(
      (text, index) => ({
        text,
        kind: "cmavo",
        start: index * 2,
        end: index * 2 + 2,
      }),
    ),
  );
});

test("v4 keeps a finite ceiling and honors exact rule entry boundaries", () => {
  assert.equal(PEG_WORK_LIMIT, 75_000);
  assert.equal(PEG_WORK_LIMIT - recognizeWords(boundaryLujvo).spent, 21_200);
  for (const spelling of [boundaryLujvo, boundaryCompound]) {
    const complete = recognizeWords(spelling);
    assert.deepEqual(recognizeWords(spelling, complete.spent), complete);
    assert.throws(
      () => recognizeWords(spelling, complete.spent - 1),
      exhausted(complete.spent, complete.spent - 1),
    );
    const oversized = analyzeWord("extended-v4", spelling + "a");
    assert.equal(oversized.kind, "unknown");
    assert.deepEqual(oversized.words, []);
    assert.deepEqual(oversized.readings, []);
    assert.deepEqual(oversized.diagnostics, [
      "word bytes is 129, above the limit of 128.",
    ]);
  }
});

test("historical profiles keep their 50,000-entry recognition ceiling", () => {
  for (const profile of ["cll", "extended-v2", "extended"] as const) {
    const analysis = analyzeWord(profile, "tca".repeat(40));
    assert.equal(analysis.kind, "unknown");
    assert.deepEqual(analysis.readings, []);
    assert.deepEqual(analysis.diagnostics, [
      "recognition work is 50001, above the limit of 50000.",
    ]);
  }
});
