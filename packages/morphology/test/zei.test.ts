import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { analyzeWord, buildLujvo, segmentText } from "../src/index.ts";
import type { LujvoRequest } from "../src/types.ts";

const join = " zei ";
const scoring = {
  id: "https://github.com/int19h/jbovlacku/blob/main/docs/morphology.md#zei-lujvo-linking",
  version: "1",
};
const fixture = JSON.parse(
  readFileSync(
    new URL("../evidence/zei-lujvo-imports.json", import.meta.url),
    "utf8",
  ),
) as {
  index_sha256: string;
  cases: {
    spelling: string;
    event: string;
    body: string;
    kind: string;
    supported: boolean;
  }[];
};
function request(parts: string[], spelling?: string): LujvoRequest {
  return {
    profile: "extended-v4",
    components: parts.map((part, index) => ({
      id: String(index),
      spelling: part,
      kind: "other",
      locked: part,
    })),
    joins: parts.slice(1).map(() => join),
    ...(spelling === undefined ? {} : { spelling }),
  };
}

test("zei analysis reports whole-word components while segmentation stays ordinary", () => {
  const analysis = analyzeWord("extended-v4", "broda zei brode zei brodi");
  assert.equal(analysis.kind, "lujvo");
  assert.deepEqual(analysis.readings, [
    [
      { text: "broda", kind: "core", join_before: null },
      { text: "brode", kind: "core", join_before: join },
      { text: "brodi", kind: "core", join_before: join },
    ],
  ]);
  assert.deepEqual(
    analysis.words?.map(({ text }) => text),
    ["broda", "zei", "brode", "zei", "brodi"],
  );
  assert.deepEqual(
    segmentText("broda zei brode").words.map(({ text, kind }) => ({
      text,
      kind,
    })),
    [
      { text: "broda", kind: "gismu" },
      { text: "zei", kind: "cmavo" },
      { text: "brode", kind: "gismu" },
    ],
  );
});

test("finite BU operands and attached zei retain the actual component spelling", () => {
  for (const [spelling, parts] of [
    ["ibu zei sance", ["ibu", "sance"]],
    ["denpa bu zei sance", ["denpa bu", "sance"]],
    ["denpa bu bu zei sance", ["denpa bu bu", "sance"]],
    ["ka'ozeino zei namcu", ["ka'o", "no", "namcu"]],
    ["y zei broda", ["y", "broda"]],
  ] as const) {
    const analysis = analyzeWord("extended-v4", spelling);
    assert.equal(analysis.kind, "lujvo", spelling);
    assert.deepEqual(
      analysis.readings[0].map(({ text }) => text),
      parts,
      spelling,
    );
    const built = buildLujvo(request([...parts], spelling));
    assert.deepEqual(
      built.candidates[0].parts.map(({ form }) => form),
      parts,
      spelling,
    );
  }
});

test("the complete imported zei corpus has 167 supported chains and one explicit negative", () => {
  assert.match(fixture.index_sha256, /^[a-f0-9]{64}$/);
  assert.equal(fixture.cases.length, 168);
  let supported = 0;
  for (const item of fixture.cases) {
    assert.match(item.event, /^jve1:[a-f0-9]{64}$/);
    assert.match(item.body, /^sha256:[a-f0-9]{64}$/);
    const analysis = analyzeWord("extended-v4", item.spelling);
    assert.equal(analysis.kind === "lujvo", item.supported, item.spelling);
    if (!item.supported) {
      assert.equal(item.spelling, "zo si si zei fa'o");
      continue;
    }
    supported++;
    const result = buildLujvo(
      request(
        analysis.readings[0].map(({ text }) => text),
        item.spelling,
      ),
    );
    assert.equal(result.candidates[0].spelling, item.spelling);
    assert.equal(result.candidates[0].tokens.join(""), item.spelling);
    assert.deepEqual(result.candidates[0].recovered, analysis.readings[0]);
    assert.deepEqual(result.scoring, scoring);
  }
  assert.equal(supported, 167);
});

test("whole-word linking uses no rafsi claims or conflicts", () => {
  const input = request(["batke", "uidje"]);
  input.components[0].claims = [{ rafsi: "bat", pair: "synthetic" }];
  input.inventory = {
    claims: [
      { rafsi: "bat", pair: "other", word: "other", spelling: "different" },
    ],
  };
  const built = buildLujvo(input);
  assert.equal(built.considered, 1);
  assert.deepEqual(built.scoring, scoring);
  const candidate = built.candidates[0];
  assert.equal(candidate.score, 0); // An internal placeholder, not a construction rank.
  assert.deepEqual(candidate.conflicts, []);
  assert.deepEqual(candidate.unlisted, []);
  assert.ok(
    candidate.parts.every(
      (part) => part.origin === "core" && part.pair === null,
    ),
  );
  assert.deepEqual(
    built.rows.map((row) => row.choices.map((choice) => choice.form)),
    [["batke"], ["uidje"]],
  );
  assert.equal(
    buildLujvo({ ...input, limits: { results: 0 } }).candidates.length,
    0,
  );
  assert.throws(
    () => buildLujvo({ ...input, limits: { choice_product: 0 } }),
    /choice combinations/,
  );
});

test("typed spelling and recovered joins survive JSON persistence", () => {
  for (const spelling of [
    "BRO,da  ZEI\tBROde",
    ".DJAN. ZEI .ALIS.",
    "denpa bu zei sance",
    "ka'ozeino zei namcu",
  ]) {
    const analysis = analyzeWord("extended-v4", spelling);
    const input = request(
      analysis.readings[0].map(({ text }) => text),
      spelling,
    );
    const first = buildLujvo(input);
    assert.equal(first.candidates[0].tokens.join(""), spelling);
    assert.deepEqual(buildLujvo(JSON.parse(JSON.stringify(input))), first);
    assert.ok(
      first.candidates[0].recovered
        .slice(1)
        .every((part) => part.join_before === join),
    );
  }
});

test("malformed chains and arbitrary multiword operands cannot become lujvo", () => {
  for (const spelling of [
    "zei broda",
    "broda zei",
    "broda zei zei brode",
    "zei zei broda",
    "mi do zei broda",
    "broda zei mido",
    "broda zei baoz",
    "broda!zei brode",
    "zo si si zei fa'o",
  ]) {
    assert.notEqual(
      analyzeWord("extended-v4", spelling).kind,
      "lujvo",
      spelling,
    );
  }
  assert.throws(
    () => buildLujvo(request(["mi do", "broda"])),
    /one word or a word followed by bu/,
  );
  assert.throws(
    () =>
      buildLujvo({
        ...request(["broda", "brode", "brodi"]),
        joins: [join, "y"],
      }),
    /zei at every boundary/,
  );
  const mismatched = request(["broda", "brode"]);
  mismatched.components[0].locked = "brod";
  assert.throws(
    () => buildLujvo(mismatched),
    /match its whole component spelling/,
  );
  assert.throws(
    () => buildLujvo(request(["broda", "brode"], "broda zei brodi")),
    /does not match/,
  );
  assert.throws(() => buildLujvo(request(Array(64).fill("a"))), /word bytes/);
});

test("historical profiles keep their original zei results and join validation", () => {
  for (const profile of ["cll", "extended-v2", "extended"] as const) {
    assert.equal(
      analyzeWord(profile, "broda zei brode").kind,
      "unknown",
      profile,
    );
    assert.throws(
      () => buildLujvo({ ...request(["broda", "brode"]), profile }),
      profile === "extended"
        ? /Choose one permitted join/
        : /Explicit joins need the extended profile/,
    );
  }
});
