import assert from "node:assert/strict";
import { test } from "node:test";
import { DetailBudget } from "../src/detail-budget.ts";
import {
  BuilderError,
  invalid,
  requireLimit,
  resource,
} from "../src/errors.ts";
import { builderPresets } from "../src/presets.ts";
import {
  isInitialPair,
  isPermissiblePair,
  normalizeWord,
  pairClass,
} from "../src/phonotactics.ts";
import {
  gismuShape,
  isShortRafsiForm,
  isShortRafsiShape,
  possibleShortRafsi,
  rafsiShape,
  rafsiShapeScore,
  universalGismuForms,
} from "../src/rafsi.ts";

test("classifies CLL consonant pairs", () => {
  for (const [a, b, expected] of [
    ["b", "l", "initial"],
    ["n", "l", "permissible"],
    ["m", "z", "forbidden"],
    ["b", "n", "permissible"],
    ["c", "x", "forbidden"],
    ["a", "b", null],
  ] as const)
    assert.equal(pairClass(a, b), expected);
  assert.ok(isInitialPair("s", "k"));
  for (const [a, b] of [
    ["n", "r"],
    ["b", "n"],
  ])
    assert.equal(isInitialPair(a, b), false);
  assert.ok(isPermissiblePair("n", "r"));
  assert.equal(isPermissiblePair("m", "z"), false);
});
test("normalizes words with Rust ASCII and whitespace rules", () => {
  for (const [input, expected] of [
    [" Sakli ", "sakli"],
    ["sa'i", "sa'i"],
    ["sa,kli", "sakli"],
    ["sákli", null],
    ["sahi", "sa'i"],
    ["wakli", null],
    ["", null],
    ["sa’i", "sa'i"],
    ["\u0085SAKLI\u0085", "sakli"],
    ["\ufeffsakli", null],
    ["ſakli", null],
  ] as const)
    assert.equal(normalizeWord(input), expected);
});
test("derives every short rafsi for both gismu shapes", () => {
  assert.deepEqual(possibleShortRafsi("sakli"), [
    "kli",
    "sa'i",
    "sai",
    "sak",
    "sal",
    "ska",
  ]);
  assert.deepEqual(possibleShortRafsi("bridi"), [
    "bi'i",
    "bid",
    "bri",
    "ri'i",
    "rid",
  ]);
  assert.deepEqual(possibleShortRafsi("blaci"), [
    "ba'i",
    "bac",
    "bai",
    "bla",
    "la'i",
    "lac",
    "lai",
  ]);
  assert.deepEqual(possibleShortRafsi("banli"), ["ba'i", "bai", "bal", "ban"]);
  assert.deepEqual(possibleShortRafsi("toldu"), ["to'u", "tod", "tol"]);
  assert.equal(gismuShape("toldu"), "cvccv");
});
test("rejects non-gismu shapes and validates complete short rafsi", () => {
  for (const word of [
    "",
    "sakl",
    "sakliu",
    "coi",
    "jetcybolxada",
    "sákli",
    "toldu ",
    "mzaku",
  ]) {
    assert.deepEqual(possibleShortRafsi(word), []);
    assert.equal(gismuShape(word), null);
  }
  for (const form of ["sal", "ska", "sa'i", "sai", "sei", "soi", "sau"])
    assert.ok(isShortRafsiForm(form), form);
  for (const form of [
    "sal!",
    "sa'i ",
    "sae",
    "sia",
    "sa",
    "salk",
    "",
    "nra",
    "bna",
    "sái",
  ])
    assert.equal(isShortRafsiForm(form), false, form);
  assert.deepEqual(
    ["banta", "bant", "blaci", "blac", "ban", "ba'i", "bla", "bai", "xyz"]
      .map(rafsiShape)
      .map(rafsiShapeScore),
    [1, 2, 3, 4, 5, 6, 7, 8, 0],
  );
  assert.ok(isShortRafsiShape("cv'v"));
  assert.equal(isShortRafsiShape("cvcc"), false);
});
test("universal gismu forms preserve the reserved brod stem", () => {
  assert.deepEqual(universalGismuForms("cukta"), ["cukt", "cukta"]);
  assert.deepEqual(universalGismuForms("broda"), [null, "broda"]);
  assert.equal(universalGismuForms("coi"), null);
});
test("presets preserve their order, weights, source hashes and independent values", () => {
  const presets = builderPresets();
  assert.deepEqual(
    presets.map((p) => p.id),
    ["cll-1995", "cll-1987", "ilmen6", "ilmen8", "ilmen12"],
  );
  assert.deepEqual(
    presets.map((p) => p.languages.reduce((n, l) => n + l.numerator, 0)),
    [1000, 1000, 1000, 1000, 999],
  );
  for (const preset of presets) {
    assert.equal(preset.denominator, 1000);
    assert.match(preset.source_digest, /^[0-9a-f]{64}$/);
  }
  presets[0].languages[0].numerator = 0;
  assert.equal(builderPresets()[0].languages[0].numerator, 347);
});
test("detail budgets bound scans, rows, and UTF-8 bytes cumulatively", () => {
  const work = new DetailBudget(2, 10, 10);
  work.scan(2);
  assert.throws(
    () => work.scan(1),
    (e: unknown) =>
      e instanceof BuilderError &&
      e.failure.measure === "conflict detail work" &&
      e.failure.value === 3,
  );
  const rows = new DetailBudget(10, 1, 10);
  rows.detail(["a"]);
  assert.throws(
    () => rows.detail(["b"]),
    /conflict detail rows is 2, above the limit of 1/,
  );
  const bytes = new DetailBudget(10, 10, 3);
  bytes.detail(["é"]);
  assert.throws(
    () => bytes.detail(["é"]),
    /conflict detail bytes is 4, above the limit of 3/,
  );
});
test("builder errors retain exact public failure diagnostics", () => {
  requireLimit("work", 1, 1);
  assert.throws(
    () => requireLimit("work", 2, 1),
    (e: unknown) =>
      e instanceof BuilderError &&
      JSON.stringify(e.failure) ===
        JSON.stringify({
          kind: "resource-limit",
          measure: "work",
          value: 2,
          limit: 1,
        }),
  );
  assert.throws(() => resource("build recognition work", 2, 1), {
    message:
      "build recognition work is 2, above the limit of 1. Lock a component form.",
  });
  assert.throws(() => invalid("Exact diagnostic."), {
    message: "Exact diagnostic.",
  });
});
