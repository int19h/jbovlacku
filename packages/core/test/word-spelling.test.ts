import assert from "node:assert/strict";
import { before, test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  initializeCore,
  validWordIdSpellings,
  wordId,
  wordSpellingStatus,
} from "../src/index.ts";

before(async () => {
  await initializeCore(
    await readFile(
      new URL("../generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  );
});

function fastOrCore(spelling: string): {
  valid: boolean;
  path: "valid" | "invalid" | "check";
} {
  const path = wordSpellingStatus(spelling);
  if (path === "valid") return { valid: true, path };
  if (path === "invalid") return { valid: false, path };
  return { valid: validWordIdSpellings([spelling]), path };
}

function coreAccepts(spelling: string): boolean {
  try {
    wordId({ language: "jbo", spelling });
    return true;
  } catch {
    return false;
  }
}

test("wordSpellingStatus plus core fallback agrees with wordId across BMP and counterexamples", () => {
  const counterexamples = [
    "",
    " ",
    " cukta",
    "cukta ",
    "a".repeat(256),
    "a".repeat(257),
    "á",
    "bá",
    "ba",
    "ba'a",
    "Ba’a",
    "é",
    "e\u0301",
    "q\u0301",
    "á\u0301",
    "\u1100\u1161",
    "\u00a0a",
    "a\u00a0b",
    "水".repeat(85) + "a",
    "水".repeat(86),
    "𠮷".repeat(64),
    "𠮷".repeat(65),
    "\ud800",
    "x\0",
    "Ⓐ",
    "bá\u2000",
    "\u1e83",
  ];
  for (const spelling of counterexamples) {
    assert.equal(
      fastOrCore(spelling).valid,
      coreAccepts(spelling),
      JSON.stringify(spelling),
    );
  }
  // Specific fast-path and fallback routing checks.
  assert.equal(wordSpellingStatus("cukta"), "valid");
  assert.equal(wordSpellingStatus("ba'a"), "valid");
  assert.equal(wordSpellingStatus("Ba’a"), "valid");
  assert.equal(wordSpellingStatus("水".repeat(85) + "a"), "valid");
  assert.equal(wordSpellingStatus("水".repeat(86)), "invalid");
  assert.equal(wordSpellingStatus("\u1100\u1161"), "check");
  assert.equal(wordSpellingStatus("e\u0301"), "check");
  assert.equal(wordSpellingStatus("q\u0301"), "check");
  assert.equal(wordSpellingStatus("á\u0301"), "check");
  assert.equal(wordSpellingStatus("\u00a0a"), "check");
  assert.equal(wordSpellingStatus("𠮷"), "check");
  assert.equal(wordSpellingStatus("\ud800"), "check");
  assert.equal(wordSpellingStatus("x\0"), "check");

  // Exhaustive single UTF-16 code units alone and between ASCII letters.
  for (let code = 0; code < 65536; code++) {
    const unit = String.fromCharCode(code);
    for (const sample of [unit, `a${unit}b`]) {
      assert.equal(
        fastOrCore(sample).valid,
        coreAccepts(sample),
        `U+${code.toString(16).padStart(4, "0")} (${JSON.stringify(sample)})`,
      );
    }
  }

  // Deterministic BMP pairs including accent combinations.
  let seed = 1234567;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let i = 0; i < 4000; i++) {
    const a = String.fromCharCode(next() >>> 16);
    const b = String.fromCharCode(next() >>> 16);
    for (const sample of [a + b, `a${a}\u0301${b}`]) {
      assert.equal(
        fastOrCore(sample).valid,
        coreAccepts(sample),
        JSON.stringify(sample),
      );
    }
  }
});
