import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analyzeWord,
  buildLujvo,
  segmentText,
  stripAcuteAccents,
} from "../src/index.ts";

test("acute name marks leave every headword profile's plain parse unchanged", () => {
  for (const profile of [
    "cll",
    "extended-v2",
    "extended",
    "extended-v4",
  ] as const)
    for (const [spelling, plain] of [
      ["dján", "djan"],
      ["ĺénan", "lenan"],
      ["ḿa'an", "ma'an"],
      ["m\u0301a'an", "ma'an"],
      ["DŹÁN", "DZAN"],
      ["b\u0301an", "ban"],
    ]) {
      const marked = analyzeWord(profile, spelling);
      assert.equal(marked.original, spelling);
      assert.equal(marked.kind, "cmevla");
      assert.deepEqual(
        { ...marked, original: plain },
        analyzeWord(profile, plain),
      );
    }
  assert.equal(stripAcuteAccents("ḿä'án"), "mä'an");
  assert.equal(analyzeWord("extended-v4", "djän").kind, "unknown");
});

test("acute marks on nonnames or separators return a clear error", () => {
  for (const profile of [
    "cll",
    "extended-v2",
    "extended",
    "extended-v4",
  ] as const)
    for (const spelling of [
      "blánu",
      "lé",
      "ckúsni",
      "ĺéna",
      "ḿa'a",
      "\u0301djan",
      "dja'\u0301an",
      "dja1\u0301n",
      "dja\u0301\u0301n",
    ]) {
      const analysis = analyzeWord(profile, spelling);
      assert.equal(analysis.kind, "unknown", spelling);
      assert.match(analysis.diagnostics.join(" "), /acute accent/i, spelling);
    }
  assert.match(
    analyzeWord("extended-v4", ".\u0301djan.").diagnostics.join(" "),
    /must follow/,
  );
});

test("zei construction keeps accented names visible and recovers plain components", () => {
  for (const spelling of [
    "dján zei blanu",
    "dján bu zei blanu",
    "ḿa'an zei blanu",
    "m\u0301a'an zei blanu",
    "DŹÁN zei blanu",
  ]) {
    const first = spelling.split(" zei ")[0];
    const analysis = analyzeWord("extended-v4", spelling);
    assert.equal(analysis.kind, "lujvo");
    const result = buildLujvo({
      profile: "extended-v4",
      components: [
        { id: "name", spelling: first, kind: "cmevla" },
        { id: "root", spelling: "blanu", kind: "gismu" },
      ],
      joins: [" zei "],
      spelling,
    });
    const candidate = result.candidates[0];
    assert.equal(candidate.spelling, spelling);
    assert.deepEqual(candidate.tokens, [first, " zei ", "blanu"]);
    assert.deepEqual(candidate.recovered, analysis.readings[0]);
    assert.equal(
      candidate.parts[0].form,
      stripAcuteAccents(first).toLowerCase(),
    );
    assert.equal(
      buildLujvo({
        profile: "extended-v4",
        components: [
          { id: "name", spelling: first, kind: "cmevla" },
          { id: "root", spelling: "blanu", kind: "gismu" },
        ],
        joins: [" zei "],
      }).candidates[0].spelling,
      spelling,
    );
  }
  assert.equal(analyzeWord("extended-v4", "djan zei blánu").kind, "unknown");
  assert.throws(
    () =>
      buildLujvo({
        profile: "extended-v4",
        components: [
          { id: "name", spelling: "djan", kind: "cmevla" },
          { id: "root", spelling: "blánu", kind: "gismu" },
        ],
        joins: [" zei "],
      }),
    /component|cmevla/,
  );
});

test("name rafsi construction uses plain source names without accepting accented rafsi", () => {
  const request = {
    profile: "extended-v4" as const,
    components: [
      {
        id: "name",
        spelling: "dján",
        kind: "cmevla",
        claims: [{ rafsi: "dja", pair: "pair" }],
      },
      { id: "root", spelling: "blanu", kind: "gismu" },
    ],
  };
  const result = buildLujvo(request);
  assert.ok(
    result.candidates.some((candidate) => candidate.spelling === "djablanu"),
  );
  assert.equal(result.rows[0].normalized, "djan");
  const refused = buildLujvo({
    ...request,
    components: [
      { ...request.components[0], locked: "djá" },
      request.components[1],
    ],
  });
  assert.equal(refused.candidates.length, 0);
  assert.equal(refused.rows[0].lock_valid, false);
});

test("text segmentation ignores acute name stress and keeps original source offsets", () => {
  const source = "mi .m\u0301a'an. .dján. BROdaku";
  const result = segmentText(source);
  assert.deepEqual(
    result.words.map((word) => word.text),
    segmentText(stripAcuteAccents(source)).words.map((word) => word.text),
  );
  assert.deepEqual(
    result.words
      .filter((word) => word.kind === "cmevla")
      .map((word) => source.slice(word.start, word.end)),
    ["m\u0301a'an", "dján"],
  );
  assert.throws(
    () => segmentText("mi blánu"),
    /Acute accents are allowed only on cmevla/,
  );
  assert.deepEqual(
    segmentText("mi .café漢.").foreign.map((run) => run.text),
    ["café漢"],
  );
});
