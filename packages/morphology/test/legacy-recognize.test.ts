import assert from "node:assert/strict";
import test from "node:test";
import { BuilderError } from "../src/errors.ts";
import {
  MAX_WORD_BYTES,
  parse,
  parseProfile,
  parseProfileMetered,
  type Kind,
} from "../src/legacy-recognize.ts";

// These results and work counts come from the Rust recognizer at 62340e6.
// Raw recognition precedes the lujvo module's profile-specific filtering.
type Case = [
  word: string,
  kind: Kind,
  tokens: string[],
  cllWork: number,
  extendedWork: number,
];
const referenceCases: Case[] = [
  ["aktyiismu", "lujvo", ["akt", "y", "iismu"], 985, 722],
  ["fuly'ismu", "lujvo", ["ful", "y'", "ismu"], 653, 477],
  ["fulta'yismu", "unknown", [], 0, 0],
  ["tcenelyiismu", "lujvo", ["tce", "nel", "y", "iismu"], 1288, 890],
  ["gimyiismu", "lujvo", ["gim", "y", "iismu"], 671, 507],
  ["jenjigu'ydi'e", "lujvo", ["jenjigu", "'y", "di'e"], 1591, 876],
  ["gimspageti", "fuhivla", [], 823, 803],
  ["baurismu", "unknown", [], 138, 88],
  ["leksiko'yismu", "unknown", [], 0, 0],
  ["fulty'ismu", "lujvo", ["fult", "y'", "ismu"], 825, 556],
  ["sairzba", "lujvo", ["sai", "r", "zba"], 155, 140],
  ["sakrsakysakli", "lujvo", ["sakrsak", "y", "sakli"], 1138, 723],
  ["sabkysakli", "unknown", [], 0, 0],
  ["rsakli", "unknown", [], 145, 128],
  ["ntadi", "unknown", [], 126, 112],
  ["ismu", "fuhivla", [], 353, 303],
  ["zbasai", "lujvo", ["zba", "sai"], 98, 96],
  ["tosymabru", "lujvo", ["tos", "y", "mabru"], 294, 180],
  ["tosmabru", "unknown", [], 107, 106],
  ["ckusni", "lujvo", ["cku", "sni"], 98, 96],
  ["cuktysni", "lujvo", ["cukt", "y", "sni"], 175, 156],
  ["ro'inre'o", "lujvo", ["ro'i", "n", "re'o"], 429, 393],
  ["saizba", "lujvo", ["sai", "zba"], 178, 126],
  ["sakrsakrsakrsakrsakrsakrsakrsakrsakli", "fuhivla", [], 2690, 2615],
];

for (const experimental of [false, true]) {
  test(`legacy reference parses preserve tokens and work, experimental=${experimental}`, () => {
    for (const [word, kind, tokens, cllWork, extendedWork] of referenceCases) {
      assert.deepEqual(
        parseProfileMetered(word, experimental),
        {
          reading: { kind, tokens },
          spent: experimental ? extendedWork : cllWork,
        },
        word,
      );
    }
  });
}

test("the default parser uses the retained nonexperimental path", () => {
  for (const [word] of referenceCases)
    assert.deepEqual(parse(word), parseProfile(word, false), word);
});

test("basic word classes and standalone cmavo preserve Rust results", () => {
  const cases: [string, Kind][] = [
    ["sakli", "gismu"],
    ["ka'a", "cmavo"],
    ["djan", "cmevla"],
    ["iismu", "fuhivla"],
    ["leksiko", "fuhivla"],
    ["aaaa", "unknown"],
    ["djan.", "unknown"],
    ["", "unknown"],
    ["y", "cmavo"],
    ["yyy", "cmavo"],
    ["ýý", "cmavo"],
    ["ie'o", "cmavo"],
    ["taia", "unknown"],
    ["i'ecu'i", "unknown"],
  ];
  for (const [word, kind] of cases)
    for (const experimental of [false, true]) {
      assert.deepEqual(
        parseProfile(word, experimental),
        { kind, tokens: [] },
        `${experimental} ${word}`,
      );
    }
  for (let digit = 0; digit <= 9; digit += 1)
    assert.deepEqual(parse(String(digit)), { kind: "cmavo", tokens: [] });
});

test("the experimental flag preserves the mz and slihykru differences", () => {
  for (const word of ["kamzu", "mamza", "kamzi"]) {
    assert.deepEqual(parseProfileMetered(word, false), {
      reading: { kind: "unknown", tokens: [] },
      spent: 0,
    });
    assert.deepEqual(parseProfileMetered(word, true), {
      reading: { kind: "gismu", tokens: [] },
      spent: 0,
    });
  }
  assert.deepEqual(parseProfileMetered("cimza'a", true), {
    reading: { kind: "lujvo", tokens: ["cim", "za'a"] },
    spent: 227,
  });
  assert.deepEqual(parseProfileMetered("lemzasli", true), {
    reading: { kind: "lujvo", tokens: ["lem", "zasli"] },
    spent: 407,
  });
  assert.equal(parseProfile("cimza'a", false).kind, "unknown");
  assert.equal(parseProfile("lemzasli", false).kind, "unknown");
  assert.deepEqual(parseProfileMetered("sli'ykru", false), {
    reading: { kind: "lujvo", tokens: ["sli", "'y", "kru"] },
    spent: 319,
  });
  assert.deepEqual(parseProfileMetered("sli'ykru", true), {
    reading: { kind: "unknown", tokens: [] },
    spent: 3,
  });
});

test("apostrophe y apostrophe stays one join in raw legacy recognition", () => {
  const cases: [string, number, number][] = [
    ["bangu", 744, 675],
    ["fulta", 744, 675],
    ["leksiko", 1468, 976],
    ["spageti", 1254, 852],
  ];
  for (const [core, cllWork, extendedWork] of cases)
    for (const experimental of [false, true]) {
      assert.deepEqual(parseProfileMetered(`${core}'y'ismu`, experimental), {
        reading: { kind: "lujvo", tokens: [core, "'y'", "ismu"] },
        spent: experimental ? extendedWork : cllWork,
      });
    }
});

test("Unicode code points, stress, and comma behavior match raw Rust recognition", () => {
  for (const experimental of [false, true]) {
    assert.deepEqual(parseProfileMetered("sákli", experimental), {
      reading: { kind: "gismu", tokens: [] },
      spent: 0,
    });
    assert.deepEqual(parseProfileMetered("ckúsni", experimental), {
      reading: { kind: "lujvo", tokens: ["ckú", "sni"] },
      spent: experimental ? 96 : 98,
    });
    for (const word of ["zo,is", "zoi,s", "cĭan", "kiam", "📘klam", "𝑎klam"])
      assert.deepEqual(
        parseProfileMetered(word, experimental),
        { reading: { kind: "cmevla", tokens: [] }, spent: 0 },
        word,
      );
    for (const word of ["i,aii", "íaií"])
      assert.deepEqual(
        parseProfileMetered(word, experimental),
        { reading: { kind: "unknown", tokens: [] }, spent: 0 },
        word,
      );
  }
});

function assertResource(
  call: () => unknown,
  measure: string,
  value: number,
  limit: number,
): void {
  assert.throws(call, (error: unknown) => {
    assert.ok(error instanceof BuilderError);
    assert.deepEqual(error.failure, {
      kind: "resource-limit",
      measure,
      value,
      limit,
    });
    assert.equal(
      error.message,
      `${measure} is ${value}, above the limit of ${limit}.`,
    );
    return true;
  });
}

test("word limits count UTF-8 bytes rather than code points or UTF-16 units", () => {
  assert.equal(MAX_WORD_BYTES, 128);
  assert.equal(parse("y".repeat(128)).kind, "cmavo");
  assert.equal(parse("á".repeat(64)).kind, "unknown");
  assert.equal(parse("📘".repeat(31) + "klam").kind, "cmevla");
  assertResource(() => parse("y".repeat(129)), "word bytes", 129, 128);
  assertResource(() => parse("á".repeat(65)), "word bytes", 130, 128);
  assertResource(() => parse("📘".repeat(32) + "klam"), "word bytes", 132, 128);
});

test("exhaustion invalidates even a successful branch, as in the Rust test", () => {
  for (const experimental of [false, true]) {
    for (const word of ["ckusni", "gimspageti"]) {
      assertResource(
        () => parseProfileMetered(word, experimental, 1),
        "recognition work",
        2,
        1,
      );
      assertResource(
        () => parseProfileMetered(word, experimental, 0),
        "recognition work",
        1,
        0,
      );
    }
  }
});

test("exact work limits accept the last charge and reject an exhausted branch", () => {
  for (const experimental of [false, true]) {
    for (const word of [
      "ckusni",
      "gimspageti",
      "leksiko'y'ismu",
      "rsakli",
      "",
    ]) {
      const result = parseProfileMetered(word, experimental);
      assert.deepEqual(
        parseProfileMetered(word, experimental, result.spent),
        result,
        word,
      );
      assertResource(
        () => parseProfileMetered(word, experimental, result.spent - 1),
        "recognition work",
        result.spent,
        result.spent - 1,
      );
    }
    assert.deepEqual(parseProfileMetered("sakli", experimental, 0), {
      reading: { kind: "gismu", tokens: [] },
      spent: 0,
    });
    assertResource(
      () => parseProfileMetered("tca".repeat(40), experimental),
      "recognition work",
      50001,
      50000,
    );
  }
});
