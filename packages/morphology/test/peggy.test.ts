import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { analyzeWord, buildLujvo, morphologyProfile } from "../src/index.ts";
import type { LujvoRequest, WordAnalysis } from "../src/types.ts";
import { BuilderError } from "../src/errors.ts";
import { recognizeWords } from "../src/recognize.ts";

const warning = "This form is not valid under the current BPFK morphology.";
const morphologyId =
  "https://github.com/int19h/jbovlacku/blob/main/docs/morphology.md#extended-lujvo";

test("Peggy exhaustion discards a parse even after an earlier word succeeds", () => {
  const input = "broda ckusni";
  const complete = recognizeWords(input);
  assert.deepEqual(
    complete.words.map((word) => word.text),
    ["broda", "ckusni"],
  );
  assert.deepEqual(recognizeWords(input, complete.spent), complete);
  assert.throws(
    () => recognizeWords(input, complete.spent - 1),
    (error: unknown) =>
      error instanceof BuilderError &&
      error.failure.kind === "resource-limit" &&
      error.failure.measure === "recognition work" &&
      error.failure.value === complete.spent &&
      error.failure.limit === complete.spent - 1,
  );
});

test("Peggy counts original input bytes before it removes presentation characters", () => {
  const oversized = "broda" + ",".repeat(124);
  const analysis = analyzeWord("extended-v4", oversized);
  assert.equal(analysis.kind, "unknown");
  assert.equal(analysis.normalized, null);
  assert.deepEqual(analysis.words, []);
  assert.match(
    analysis.diagnostics[0],
    /word bytes is 129, above the limit of 128/,
  );
});

test("one-word headwords allow framing periods but do not discard other pause material", () => {
  for (const spelling of ["sairzba!", "sairzba?", "..sairzba..", "sairzba ."]) {
    const analysis = analyzeWord("extended-v4", spelling);
    assert.equal(analysis.kind, "unknown", spelling);
    assert.deepEqual(analysis.readings, [], spelling);
  }
  roundtrip(".SAI,rZBA.");
});

test("a pure y run does not take the start of an apostrophe-linked cmavo", () => {
  for (const spelling of ["y'y", "y'e", "y'y'y"]) {
    const analysis = analyzeWord("extended-v4", spelling);
    assert.equal(analysis.kind, "cmavo", spelling);
    assert.deepEqual(
      analysis.words?.map((word) => word.text),
      [spelling],
    );
  }
});
interface FixtureWord {
  text: string;
  kind: string;
  cgv_warning: boolean;
}
interface FixtureCase {
  id: string;
  source_file: string;
  source_text: string;
  source_dialect: string;
  source_expect: string;
  source_words: string[];
  input: string;
  transform?: string;
  brief_override?: string;
  expected: { kind: string; words: FixtureWord[] };
}
interface Evidence {
  reference: string;
  revision: string;
  sources: Record<string, string>;
  cases: FixtureCase[];
  excluded_source_cases: {
    source_file: string;
    case_id: string;
    input: string;
    reason: string;
  }[];
  retained_typed_lujvo: {
    source_file: string;
    source_sha256: string;
    reference: string;
    revision: string;
    cases: { word: string; kind: string }[];
  };
}
const evidence: Evidence = JSON.parse(
  readFileSync(
    new URL("../evidence/gencmu-words.json", import.meta.url),
    "utf8",
  ),
);
const words = (analysis: WordAnalysis) =>
  analysis.words?.map((word) => ({ text: word.text, kind: word.kind }));

function roundtrip(spelling: string): void {
  const analysis = analyzeWord("extended-v4", spelling);
  assert.equal(
    analysis.kind,
    "lujvo",
    `${spelling}: ${JSON.stringify(analysis)}`,
  );
  assert.equal(analysis.readings.length, 1, spelling);
  const reading = analysis.readings[0];
  const request: LujvoRequest = {
    profile: "extended-v4",
    joins: reading.slice(1).map((part) => part.join_before ?? ""),
    spelling,
    components: reading.map((part, index) => ({
      id: String(index),
      spelling: part.text,
      kind: "other",
      locked: part.text,
    })),
  };
  const result = buildLujvo(request);
  assert.equal(
    result.candidates.length,
    1,
    `${spelling}: ${JSON.stringify(result)}`,
  );
  const candidate = result.candidates[0];
  assert.equal(candidate.spelling, spelling);
  assert.equal(candidate.tokens.join(""), spelling);
  assert.deepEqual(candidate.recovered, reading, spelling);
  assert.deepEqual(
    candidate.parts.map((part) => part.form),
    reading.map((part) => part.text),
  );
  assert.deepEqual(result.morphology, { id: morphologyId, version: "4" });
}

test("word fixtures retain source revisions, file digests, case IDs, and explicit exclusions", () => {
  assert.equal(evidence.reference, "https://github.com/int19h/gencmu");
  assert.equal(evidence.revision, "0b3da7d2ec2f727a6730d77c775f88214a7ffc89");
  assert.ok(Object.keys(evidence.sources).length >= 10);
  for (const digest of Object.values(evidence.sources))
    assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(
    new Set(evidence.cases.map((item) => `${item.source_file}:${item.id}`))
      .size,
    evidence.cases.length,
  );
  for (const item of evidence.cases) {
    assert.ok(evidence.sources[item.source_file], item.id);
    assert.equal(item.source_dialect, "experimental", item.id);
    assert.ok(item.source_text.length > 0, item.id);
    if (item.input !== item.source_text) assert.ok(item.transform, item.id);
  }
  assert.match(evidence.retained_typed_lujvo.source_sha256, /^[0-9a-f]{64}$/);
  assert.ok(
    evidence.excluded_source_cases.some((item) => item.input === "atkwila"),
  );
  assert.ok(
    evidence.excluded_source_cases.every((item) => item.reason.length > 0),
  );
});

for (const item of evidence.cases) {
  test(`gencmu word case ${item.id}: ${item.input}`, () => {
    const analysis = analyzeWord("extended-v4", item.input);
    assert.equal(analysis.kind, item.expected.kind, JSON.stringify(analysis));
    assert.deepEqual(
      words(analysis),
      item.expected.words.map(({ text, kind }) => ({ text, kind })),
      JSON.stringify(analysis),
    );
    assert.deepEqual(analysis.morphology, { id: morphologyId, version: "4" });
    for (let index = 0; index < item.expected.words.length; index++) {
      const actual = analysis.words![index],
        expected = item.expected.words[index];
      assert.deepEqual(
        actual.diagnostics,
        expected.cgv_warning ? [warning] : [],
        `${item.input}: word ${index}`,
      );
      assert.equal(
        analysis.normalized!.slice(actual.start, actual.end),
        actual.text,
        `${item.input}: word span ${index}`,
      );
    }
    assert.equal(
      analysis.diagnostics.includes(warning),
      item.expected.words.some((word) => word.cgv_warning),
    );
  });
}

for (const item of evidence.retained_typed_lujvo.cases) {
  test(`retained typed word classification: ${item.word}`, () => {
    assert.equal(
      analyzeWord("extended-v4", item.word).kind,
      item.kind,
      item.word,
    );
  });
  if (item.kind === "lujvo")
    test(`v4 exact builder roundtrip: ${item.word}`, () =>
      roundtrip(item.word));
}

test("magic words are ordinary cmavo in the word grammar", () => {
  for (const spelling of [
    "zoi",
    "la'o",
    "sa",
    "su",
    "zei",
    "zo",
    "si",
    "bu",
    "fa'o",
    "lu",
    "li'u",
    "lo'u",
    "le'u",
    "zo'oi",
    "la'oi",
    "me'oi",
    "ra'oi",
    "lo'ai",
    "le'ai",
    "go'oi",
    "mu'oi",
    "do'oi",
    "ze'ei",
  ]) {
    const analysis = analyzeWord("extended-v4", spelling);
    assert.equal(
      analysis.kind,
      "cmavo",
      `${spelling}: ${JSON.stringify(analysis)}`,
    );
    assert.deepEqual(words(analysis), [{ text: spelling, kind: "cmavo" }]);
    assert.deepEqual(analysis.diagnostics, []);
  }
});

test("word morphology preserves words around magic-looking cmavo", () => {
  for (const marker of ["zo", "zoi", "la'o", "sa", "su", "si", "fa'o"]) {
    const analysis = analyzeWord("extended-v4", `${marker} broda`);
    assert.deepEqual(words(analysis), [
      { text: marker, kind: "cmavo" },
      { text: "broda", kind: "gismu" },
    ]);
  }
  const joined = analyzeWord("extended-v4", "broda zei brode");
  assert.deepEqual(words(joined), [
    { text: "broda", kind: "gismu" },
    { text: "zei", kind: "cmavo" },
    { text: "brode", kind: "gismu" },
  ]);
  assert.equal(joined.kind, "unknown");
  assert.deepEqual(joined.readings, []);
});

test("hesitation-shaped forms are ordinary cmavo and can form compound cmavo", () => {
  for (const spelling of ["y", "yy", "yyy", "ie'o", "ie'oi"]) {
    const analysis = analyzeWord("extended-v4", spelling);
    assert.equal(
      analysis.kind,
      "cmavo",
      `${spelling}: ${JSON.stringify(analysis)}`,
    );
    assert.deepEqual(words(analysis), [{ text: spelling, kind: "cmavo" }]);
  }
  for (const spelling of ["y bu", "yyy bu", "ie'o bu"]) {
    const analysis = analyzeWord("extended-v4", spelling);
    assert.equal(analysis.kind, "compound", spelling);
    assert.deepEqual(
      words(analysis),
      spelling.split(" ").map((text) => ({ text, kind: "cmavo" })),
    );
    assert.deepEqual(analysis.readings, []);
  }
});

test("compound cmavo follow morphology and the brief longest-nucleus override", () => {
  for (const [spelling, expected] of [
    ["taia", ["tai", "a"]],
    ["i'ecu'i", ["i'e", "cu'i"]],
    ["mido", ["mi", "do"]],
    ["i'ecu'icai", ["i'e", "cu'i", "cai"]],
  ] as const) {
    const analysis = analyzeWord("extended-v4", spelling);
    assert.equal(
      analysis.kind,
      "compound",
      `${spelling}: ${JSON.stringify(analysis)}`,
    );
    assert.deepEqual(
      words(analysis),
      expected.map((text) => ({ text, kind: "cmavo" })),
    );
    assert.deepEqual(analysis.diagnostics, []);
  }
});

test("CgV warnings are exact, unique, and limited to the word that contains the form", () => {
  for (const spelling of [
    "mariam",
    "lidias",
    "niys",
    "kuys",
    "atkuila",
    "zgiaca'a",
    "lanruage",
    "puamamakla",
  ]) {
    const analysis = analyzeWord("extended-v4", spelling);
    assert.ok(
      ["cmevla", "fuhivla"].includes(analysis.kind),
      `${spelling}: ${JSON.stringify(analysis)}`,
    );
    assert.deepEqual(analysis.diagnostics, [warning], spelling);
    assert.deepEqual(analysis.words![0].diagnostics, [warning], spelling);
  }
  for (const spelling of [
    "broda atkuila",
    "broda .mariam.",
    "mi broda atkuila",
  ]) {
    const analysis = analyzeWord("extended-v4", spelling);
    assert.ok(analysis.words!.length >= 2, JSON.stringify(analysis));
    assert.deepEqual(analysis.words!.at(-1)!.diagnostics, [warning]);
    assert.ok(
      analysis
        .words!.slice(0, -1)
        .every((word) => word.diagnostics.length === 0),
      spelling,
    );
    assert.deepEqual(
      analysis.diagnostics.filter((message) => message === warning),
      [warning],
    );
  }
  for (const spelling of ["broda", "mi", "kamzi", "bamzda", "djeimz"])
    assert.ok(
      !analyzeWord("extended-v4", spelling).diagnostics.includes(warning),
      spelling,
    );
});

test("v4 keeps all extended joins and exact typed presentation", () => {
  for (const spelling of [
    "bangu'y'ismu",
    "klama'ybroda",
    "spageti'ybroda",
    "spageti'ykla",
    "spageiybroda",
    "kerlybai'ybroda",
    "kerlybla'ykla",
    "kerlyfa'u'yiismu",
    "sairzba",
    "ro'inre'o",
    ".SAI,rZBA.",
  ])
    roundtrip(spelling);
});

test("legacy profiles retain their exact signed versions and readings", () => {
  assert.equal(
    morphologyProfile({ id: morphologyId, version: "4" }),
    "extended-v4",
  );
  assert.equal(
    morphologyProfile({ id: morphologyId, version: "3" }),
    "extended",
  );
  assert.equal(
    morphologyProfile({ id: morphologyId, version: "2" }),
    "extended-v2",
  );
  assert.throws(
    () => morphologyProfile({ id: morphologyId, version: "5" }),
    /Unsupported morphology/,
  );
  const legacy = analyzeWord("extended", "ckusni");
  assert.deepEqual(legacy, {
    original: "ckusni",
    normalized: "ckusni",
    kind: "lujvo",
    readings: [
      [
        { text: "cku", kind: "rafsi", join_before: null },
        { text: "sni", kind: "rafsi", join_before: null },
      ],
    ],
    diagnostics: [],
    morphology: { id: morphologyId, version: "3" },
  });
  assert.equal(analyzeWord("extended", "taia").kind, "unknown");
  assert.equal(analyzeWord("extended", "mariam").kind, "cmevla");
  assert.deepEqual(analyzeWord("extended", "mariam").diagnostics, []);
  assert.equal(analyzeWord("extended-v2", "kamzi").kind, "unknown");
  const request: LujvoRequest = {
    profile: "extended",
    joins: ["r"],
    spelling: "SAI,rZBA",
    components: [
      { id: "a", spelling: "sai", kind: "other", locked: "sai" },
      { id: "b", spelling: "zba", kind: "other", locked: "zba" },
    ],
  };
  const legacyBuild = buildLujvo(request);
  assert.equal(legacyBuild.morphology.version, "3");
  assert.deepEqual(legacyBuild.candidates[0].tokens, ["SAI,", "r", "ZBA"]);
  assert.equal(legacyBuild.candidates[0].score, 6947);
});
