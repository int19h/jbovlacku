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
      spelling.toLowerCase().normalize("NFC"),
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

test("R2 Opus F1: implicit zei candidates normalize every spelling alias and keep only acute display marks", () => {
  const build = (name: string, spelling?: string) =>
    buildLujvo({
      profile: "extended-v4",
      components: [
        { id: "name", spelling: name, kind: "cmevla" },
        { id: "root", spelling: "blanu", kind: "gismu" },
      ],
      joins: [" zei "],
      ...(spelling ? { spelling } : {}),
    }).candidates[0];
  for (const [marked, plain] of [
    ["DŹÁN", "DZAN"],
    ["Dján", "Djan"],
    [".dján.", ".djan."],
    ["dja,ń", "dja,n"],
    ["djáhan", "djahan"],
  ]) {
    assert.equal(
      stripAcuteAccents(build(marked).spelling),
      build(plain).spelling,
      marked,
    );
    assert.equal(
      build(marked, `${marked} zei blanu`).spelling,
      `${marked} zei blanu`,
    );
  }
});

test("R2 Astra 1: a plain lock and fixed zei spelling cannot admit an invalid marked source", () => {
  for (const spelling of ["blánu", "\u0301blanu"]) {
    assert.throws(
      () =>
        buildLujvo({
          profile: "extended-v4",
          components: [
            { id: "source", spelling, locked: "blanu", kind: "gismu" },
            { id: "root", spelling: "klama", kind: "gismu" },
          ],
          joins: [" zei "],
          spelling: "blanu zei klama",
        }),
      /source|component/,
      spelling,
    );
  }
  const positive = buildLujvo({
    profile: "extended-v4",
    components: [
      { id: "name", spelling: "dján bu", locked: "djan bu", kind: "letteral" },
      { id: "root", spelling: "blanu", kind: "gismu" },
    ],
    joins: [" zei "],
    spelling: "djan bu zei blanu",
  });
  assert.equal(positive.candidates.length, 1);
});

test("R2 Opus F6: accented runs without a word parse remain literal foreign text", () => {
  for (const source of ["mi .cáfeee.", "mi .café漢."]) {
    const result = segmentText(source);
    assert.ok(result.foreign.length, source);
    for (const run of result.foreign)
      assert.equal(source.slice(run.start, run.end), run.text);
  }
  for (const source of ["mi blánu", "café", "klamá"])
    assert.throws(
      () => segmentText(source),
      /Acute accents are allowed only on cmevla/,
    );
});

test("R2 Opus F8: unknown plain headwords keep their original diagnostics without a false accent error", () => {
  for (const profile of ["cll", "extended-v4"] as const) {
    for (const spelling of [".dján.", "dján smit"]) {
      const marked = analyzeWord(profile, spelling);
      const plain = analyzeWord(profile, stripAcuteAccents(spelling));
      assert.equal(marked.kind, plain.kind, `${profile}: ${spelling}`);
      assert.deepEqual(
        marked.diagnostics,
        plain.diagnostics,
        `${profile}: ${spelling}`,
      );
    }
  }
});
