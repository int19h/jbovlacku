import assert from "node:assert/strict";
import { test } from "node:test";
import type { GismuRequest, GismuSourceRow } from "../../core/src/index.ts";
import {
  generateGismu,
  matchScore,
  tooSimilarConsonant,
} from "../src/gismu.ts";
import { DetailBudget } from "../src/detail-budget.ts";
import { BuilderError } from "../src/errors.ts";
const row = (
  language: string,
  input: string,
  numerator: number | string = 1,
  denominator: number | string = 1,
): GismuSourceRow => ({
  language,
  word: input,
  input,
  weight: { numerator, denominator },
});
const request = (sources = [row("eng", "makrum")]): GismuRequest => ({
  sources,
  window: 4,
});
const fraction = (numerator: string, denominator: string) => ({
  numerator,
  denominator,
});
const fails = (run: () => unknown, measure: string) =>
  assert.throws(
    run,
    (e: unknown) => e instanceof BuilderError && e.failure.measure === measure,
  );

test("CLL recognition uses its LCS and two-letter arrangement rules", () => {
  for (const [source, score] of [
    ["ekspekt", 3],
    ["uan", 2],
    ["na", 0],
    ["ap", 0],
    ["akp", 2],
  ] as const)
    assert.equal(matchScore("kanpe", source), score);
});
test("similar consonants are directional", () => {
  for (const [a, b] of [
    ["b", "p"],
    ["f", "p"],
    ["p", "f"],
    ["m", "n"],
  ])
    assert.ok(tooSimilarConsonant(a, b));
  assert.equal(tooSimilarConsonant("b", "f"), false);
  assert.equal(tooSimilarConsonant("m", "l"), false);
});
test("normalizes exact positive weights, preserves zero rows and tied ranks", () => {
  const result = generateGismu({
    ...request([
      row("eng", "makrum", 2),
      row("spa", "ongo"),
      row("deu", "pilts", 0),
    ]),
    window: 8,
    manual: "makru",
  });
  assert.deepEqual(result.languages[0].normalized, fraction("2", "3"));
  assert.deepEqual(result.languages[2].normalized, fraction("0", "1"));
  assert.equal(result.complete, true);
  assert.deepEqual(result.manual!.score, fraction("5", "9"));
  assert.deepEqual(
    result.manual!.contributions[2].weighted,
    fraction("0", "1"),
  );
  assert.equal(result.manual!.contributions.length, 3);
  assert.notEqual(result.manual!.rank, null);
  assert.equal(result.candidates[0].rank, 1);
  for (let i = 1; i < result.candidates.length; i++) {
    const a = result.candidates[i - 1],
      b = result.candidates[i];
    if (JSON.stringify(a.score) === JSON.stringify(b.score)) {
      assert.equal(a.rank, b.rank);
      assert.ok(a.form < b.form);
    } else assert.ok(b.rank! > a.rank!);
  }
});
test("language alternatives share one weight and contribute the maximum", () => {
  const req = {
    ...request([
      row("eng", "mukrom"),
      row("eng", "makrum"),
      row("spa", "ongo"),
    ]),
    manual: "makru",
  };
  const result = generateGismu(req);
  assert.equal(result.languages.length, 2);
  assert.equal(result.manual!.contributions[0].input, "makrum");
  assert.deepEqual(
    result.manual!.contributions[0].weighted,
    fraction("5", "12"),
  );
  assert.throws(
    () =>
      generateGismu({
        ...req,
        sources: [row("eng", "mukrom"), row("eng", "makrum", 2)],
      }),
    /The rows for eng have different weights. Alternatives of one language share one weight./,
  );
  assert.throws(
    () => generateGismu(request([row("eng", "mukrom", 0)])),
    /At least one language weight must be positive./,
  );
});
test("manual forms outside the recipe retain scores without ranks", () => {
  const result = generateGismu({ ...request(), manual: "zbasu" });
  assert.equal(result.manual!.rank, null);
  assert.equal(
    result.diagnostics[0],
    '"zbasu" is outside the generated inventory, so it has a score but no rank.',
  );
  assert.equal(generateGismu({ ...request(), manual: "   " }).manual, null);
  assert.equal(
    generateGismu({ ...request(), manual: "sákli" }).diagnostics[0],
    "The manual form uses characters outside Lojban letters.",
  );
  assert.equal(
    generateGismu({ ...request(), manual: "coi" }).diagnostics[0],
    '"coi" is not a gismu shape, so it has no generation score.',
  );
});
test("conflicts preserve every root rule and competing rafsi claim", () => {
  const req: GismuRequest = {
    ...request([row("eng", "come")]),
    candidates: "all-letters",
    window: 1,
    manual: "klama",
    inventory: {
      snapshot: "sha256:x",
      gismu: [
        { spelling: "klama", word: "w1" },
        { spelling: "plami", word: "w2" },
        { spelling: "klamu", word: "w3" },
      ],
      claims: [
        { rafsi: "kla", word: "w1", spelling: "klama", pair: "p1" },
        { rafsi: "kla", word: "w9", spelling: "klaku", pair: "p9" },
      ],
    },
  };
  const manual = generateGismu(req).manual!;
  assert.deepEqual(
    manual.conflicts.map((c) => [c.spelling, c.rule]),
    [
      ["klama", "identical"],
      ["klamu", "final-vowel"],
    ],
  );
  assert.equal(manual.rafsi_conflicts.length, 2);
  const glama = generateGismu({ ...req, manual: "glama" }).manual!;
  assert.ok(
    glama.conflicts.some(
      (c) => c.spelling === "klama" && c.rule === "similar-consonant",
    ),
  );
  assert.equal(
    glama.conflicts.some((c) => ["klamu", "plami"].includes(c.spelling)),
    false,
  );
  const plama = generateGismu({ ...req, manual: "plama" }).manual!;
  assert.ok(
    plama.conflicts.some(
      (c) => c.spelling === "plami" && c.rule === "final-vowel",
    ),
  );
  assert.equal(
    plama.conflicts.some((c) => c.spelling === "klama"),
    false,
  );
});
test("work limits refuse the full search even with an empty output window", () => {
  fails(
    () =>
      generateGismu({
        ...request([row("eng", "bacdefgijklmnopr")]),
        candidates: "all-letters",
        window: 0,
        limits: { work: 1000 },
      }),
    "candidates times input letters",
  );
});
test("resource bounds precede normalization and exact arithmetic", () => {
  fails(
    () =>
      generateGismu(
        request([{ ...row("eng", "a".repeat(257)), word: "test" }]),
      ),
    "scoring input bytes",
  );
  fails(
    () => generateGismu(request([row("eng", "test", "1".repeat(65))])),
    "weight digits",
  );
  fails(
    () => generateGismu(request([row("é".repeat(33), "test")])),
    "language bytes",
  );
  fails(
    () =>
      generateGismu(
        request([{ ...row("eng", "test"), word: "é".repeat(129) }]),
      ),
    "source word bytes",
  );
  fails(
    () =>
      generateGismu({
        ...request(),
        inventory: {
          gismu: Array.from({ length: 20_001 }, () => ({
            spelling: "sakli",
            word: "word",
          })),
        },
      }),
    "inventory rows",
  );
});
test("rejects invalid scoring input and missing source evidence exactly", () => {
  for (const [sources, message] of [
    [[], "The generator needs 1 through 64 source rows."],
    [[row(" ", "a")], "A source row has no language."],
    [
      [{ ...row("eng", "a"), weight: null }],
      "The weight of eng is missing or not a nonnegative rational.",
    ],
    [
      [{ ...row("eng", "a"), input: null }],
      "The source row for eng has no scoring input.",
    ],
    [[row("eng", "'.,")], "A scoring input is empty."],
    [[row("eng", "a".repeat(65))], "A scoring input has more than 64 letters."],
    [
      [row("eng", "é")],
      'A scoring input uses "é", which is not a Lojban letter.',
    ],
  ] as [GismuSourceRow[], string][])
    assert.throws(() => generateGismu(request(sources)), { message });
  assert.deepEqual(
    generateGismu(request([row(" eng ", " MA,K.R'UM ")])).languages[0].inputs,
    ["makrum"],
  );
});
test("conflict detail budgets include both ranked and manual output", () => {
  const req = request([row("eng", "banta")]);
  req.window = 1;
  const first = generateGismu(req).candidates[0];
  req.manual = first.form;
  req.inventory = {
    claims: [
      {
        rafsi: first.short_rafsi[0],
        word: "other-word",
        spelling: "other",
        pair: "other-pair",
      },
    ],
  };
  const complete = generateGismu(req);
  assert.equal(complete.candidates[0].rafsi_conflicts.length, 1);
  assert.equal(complete.manual!.rafsi_conflicts.length, 1);
  fails(
    () => generateGismu(req, new DetailBudget(100, 1, 1000)),
    "conflict detail rows",
  );
  req.manual = null;
  fails(
    () => generateGismu(req, new DetailBudget(100, 10, 1)),
    "conflict detail bytes",
  );
  fails(
    () => generateGismu(req, new DetailBudget(1, 10, 1000)),
    "conflict detail work",
  );
});
test("root conflict indexing and output obey scan and copy bounds", () => {
  const req = {
    ...request([row("eng", "sakli")]),
    window: 0,
    manual: "sakli",
    inventory: { gismu: [{ spelling: "sakli", word: "word" }] },
  };
  fails(
    () => generateGismu(req, new DetailBudget(1, 10, 1000)),
    "conflict detail work",
  );
  fails(
    () => generateGismu(req, new DetailBudget(100, 0, 1000)),
    "conflict detail rows",
  );
  fails(
    () => generateGismu(req, new DetailBudget(100, 10, 1)),
    "conflict detail bytes",
  );
});
test("exact fractions support 64-digit parts and equivalent unreduced weights", () => {
  const huge = "9".repeat(64);
  const req = {
    ...request([row("eng", "makrum", huge, huge), row("spa", "ongo", 2, 2)]),
    manual: "makru",
  };
  const result = generateGismu(req);
  assert.deepEqual(
    result.languages.map((l) => l.normalized),
    [fraction("1", "2"), fraction("1", "2")],
  );
  assert.deepEqual(result.manual!.score, fraction("5", "12"));
  assert.equal(
    generateGismu(
      request([row("eng", "makrum", 1, 2), row("eng", "makrum", 2, 4)]),
    ).languages.length,
    1,
  );
  for (const value of ["00", "01", "-1", "1.0", "1e2", "", -1, 1.5, 1e22]) {
    assert.throws(
      () => generateGismu(request([row("eng", "makrum", value)])),
      /missing or not a nonnegative rational/,
    );
  }
  assert.throws(
    () => generateGismu(request([row("eng", "makrum", 1, 0)])),
    /missing or not a nonnegative rational/,
  );
});
test("large distinct denominators refuse before candidate enumeration", () => {
  const sources = Array.from({ length: 64 }, (_, i) =>
    row(`l${i}`, "banta", 1, String(10n ** 63n + BigInt(2 * i + 1))),
  );
  fails(() => generateGismu(request(sources)), "weight arithmetic bits");
});
test("zero-weight alternatives retain their first input on weighted ties", () => {
  const result = generateGismu({
    ...request([
      row("eng", "makrum"),
      row("deu", "abc", 0),
      row("deu", "makrum", 0),
    ]),
    manual: "makru",
    window: 0,
  });
  assert.equal(result.manual!.contributions[1].input, "abc");
  assert.deepEqual(
    result.manual!.contributions[1].weighted,
    fraction("0", "1"),
  );
});
