import { test } from "node:test";
import assert from "node:assert/strict";
import { lexicalSearch } from "../src/lexical-search.ts";
import { rankNearby } from "../src/nearby.ts";
import type { SearchEntry } from "../src/packages.ts";
import type { Evaluation } from "../../core/src/index.ts";

test("accent aliases share one hit whose display follows the selected definition", () => {
  const entries: SearchEntry[] = ["djan", "dján"].map((spelling, index) => ({
    event: index ? "a" : "b",
    word: { language: "jbo", spelling },
    language: "en",
    glosses: [],
    plain_text: "A synthetic name.",
    classification: { kind: "cmevla" },
    body: "body",
  }));
  const evaluation = {
    publications: Object.fromEntries(
      entries.map((entry) => [
        entry.event,
        { word: "name", eligible: "eligible", status: "active" },
      ]),
    ),
    receipts: Object.fromEntries(
      entries.map((entry) => [entry.event, { interpretation: "effective" }]),
    ),
  } as unknown as Evaluation;
  for (const query of ["djan", "dján", "dja\u0301n", "DJÁN"]) {
    const hits = lexicalSearch(entries, query, "en", evaluation);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].preview.event, "a");
    assert.equal((hits[0].word as { spelling: string }).spelling, "dján");
    assert.equal(hits[0].definitions.length, 2);
  }
  assert.deepEqual(lexicalSearch(entries, "\u0301", "en", evaluation), []);
});

test("related lexical queries scan every entry once even above ten HTTP pages", () => {
  const entries: SearchEntry[] = Array.from({ length: 1205 }, (_, index) => ({
    event: `event-${index}`,
    word: { language: "jbo", spelling: `word${index}` },
    language: "en",
    glosses: [],
    plain_text: "thin bowl wide vessel green small",
    classification: { kind: "gismu" },
    body: "body",
  }));
  const evaluation = {
    publications: Object.fromEntries(
      entries.map((entry, index) => [
        entry.event,
        {
          word: String(index).padStart(4, "0"),
          eligible: "eligible",
          status: "active",
        },
      ]),
    ),
    receipts: Object.fromEntries(
      entries.map((entry) => [entry.event, { interpretation: "effective" }]),
    ),
  } as unknown as Evaluation;
  let visits = 0,
    scans = 0;
  const source = {
    *[Symbol.iterator]() {
      scans++;
      for (const entry of entries) {
        visits++;
        yield entry;
      }
    },
  };
  const queries = ["thin", "bowl", "wide", "vessel", "green", "small"];
  const hits = queries.map((query) =>
    lexicalSearch(source, query, "en", evaluation),
  );
  assert.equal(scans, queries.length);
  assert.equal(visits, entries.length * queries.length);
  assert.ok(hits.every((list) => list.length === 1205));
  assert.deepEqual(
    rankNearby(hits)
      .slice(0, 30)
      .map((hit) => hit.word_id),
    Array.from({ length: 30 }, (_, index) => String(index).padStart(4, "0")),
  );
});

test("shared lexical search retains public match tiers, previews, and retired filters", () => {
  const make = (
    event: string,
    spelling: string,
    gloss: string,
    text: string,
  ): SearchEntry => ({
    event,
    word: { language: "jbo", spelling },
    language: "en",
    glosses: [{ text: gloss }],
    plain_text: text,
    classification: { kind: "cmavo" },
    body: "body",
  });
  const entries = [
    make("token", "last", "none", "a bowl"),
    make("prefix", "bowlful", "none", "text"),
    make("gloss-prefix", "after", "bowlful", "text"),
    make("gloss", "next", "bowl", "text"),
    make("head", "bowl", "none", "text"),
    make("retired", "bowl old", "none", "text"),
    make("wrong-language", "bowl", "none", "text"),
    make("newer-hash", "bowl", "none", "later"),
  ];
  entries[6].language = "fr";
  const evaluation = {
    publications: Object.fromEntries(
      entries.map((entry) => [
        entry.event,
        {
          word: entry.event === "newer-hash" ? "head" : entry.event,
          eligible: "eligible",
          status: entry.event === "retired" ? "deprecated" : "active",
        },
      ]),
    ),
    receipts: Object.fromEntries(
      entries.map((entry) => [entry.event, { interpretation: "effective" }]),
    ),
  } as unknown as Evaluation;
  const hits = lexicalSearch(entries, "bowl", "en", evaluation);
  assert.deepEqual(
    hits.map((hit) => hit.match),
    ["headword", "gloss", "headword-prefix", "gloss-prefix", "token"],
  );
  assert.equal(hits[0].preview.event, "head");
  assert.deepEqual(hits[0].definitions, ["head", "newer-hash"]);
  assert.equal(
    lexicalSearch(entries, "bowl", "en", evaluation, true).length,
    6,
  );
});

const segmentedEntry = (spelling: string, event = spelling): SearchEntry => ({
  event,
  word: { language: "jbo", spelling },
  language: "en",
  glosses: [],
  plain_text: "A synthetic definition.",
  classification: { kind: "cmavo", selmaho: [] },
  body: "body",
});
const segmentedEvaluation = (entries: SearchEntry[]) =>
  ({
    publications: Object.fromEntries(
      entries.map((entry) => [
        entry.event,
        { word: entry.word.spelling, eligible: "eligible", status: "active" },
      ]),
    ),
    receipts: Object.fromEntries(
      entries.map((entry) => [entry.event, { interpretation: "effective" }]),
    ),
  }) as unknown as Evaluation;

test("segmented results rank exact sequences before prefixes and containing subsequences", () => {
  const entries = ["iseri'abo", "iboku", "i bo", "ibo", "i", "bo"].map(
    (spelling) => segmentedEntry(spelling),
  );
  const hits = lexicalSearch(
    entries,
    "i bo",
    "en",
    segmentedEvaluation(entries),
  );
  assert.deepEqual(
    hits.map(({ word_id, match }) => [word_id, match]),
    [
      ["i bo", "headword"],
      ["ibo", "sequence-exact"],
      ["iboku", "sequence-subsequence"],
      ["iseri'abo", "sequence-subsequence"],
    ],
  );
  for (const query of [
    "i seri'a bo",
    "ise ri'abo",
    "iseri'abo",
    "I SE RÍ’ABO",
    "mi klama i seri'a bo",
  ])
    assert.ok(
      lexicalSearch(entries, query, "en", segmentedEvaluation(entries)).some(
        (hit) => hit.word_id === "iseri'abo",
      ),
    );
});

test("fallback preserves query order, groups repeated words, and applies every eligibility guard", () => {
  const entries = ["bo", "i", "je", "klama", "tai", "a"].map((spelling) =>
    segmentedEntry(spelling),
  );
  const evaluation = segmentedEvaluation(entries);
  assert.deepEqual(
    lexicalSearch(entries, "ijebo", "en", evaluation).map((hit) => hit.word_id),
    ["i", "je", "bo"],
  );
  assert.deepEqual(
    lexicalSearch(entries, "i klama i bo", "en", evaluation).map(
      (hit) => hit.word_id,
    ),
    ["i", "klama", "bo"],
  );
  assert.deepEqual(
    lexicalSearch(entries, "taia", "en", evaluation).map((hit) => hit.word_id),
    ["tai", "a"],
  );
  evaluation.publications.je.status = "deprecated";
  evaluation.publications.klama.eligible = "unknown";
  evaluation.receipts.bo.interpretation = "unavailable";
  entries[1].language = "fr";
  assert.deepEqual(lexicalSearch(entries, "ijebo klama", "en", evaluation), []);
  assert.deepEqual(
    lexicalSearch(entries, "ijebo klama", "en", evaluation, true).map(
      (hit) => hit.word_id,
    ),
    ["je"],
  );
});

test("grouped remote matching keeps language and status filters before known-word detection", () => {
  const entries: SearchEntry[] = ["se", "bo", "sebo", "cukta"].map(
    (spelling) => ({
      event: spelling,
      word: { language: "jbo", spelling },
      language: "en",
      glosses: [{ text: "se bo" }],
      plain_text: "A book uses se.",
      classification: { kind: "cmavo" },
      body: "body",
    }),
  );
  const evaluation = {
    publications: Object.fromEntries(
      entries.map((entry) => [
        entry.event,
        { word: entry.event, eligible: "eligible", status: "active" },
      ]),
    ),
    receipts: Object.fromEntries(
      entries.map((entry) => [entry.event, { interpretation: "effective" }]),
    ),
  } as unknown as Evaluation;
  const search = (query: string, group: "lojban" | "definitions") =>
    lexicalSearch(
      entries,
      query,
      "en",
      evaluation,
      false,
      undefined,
      { cukta: ["cku"] },
      { group },
    );
  assert.deepEqual(
    search("se bo", "lojban").map((hit) => hit.match),
    ["sequence-exact"],
  );
  assert.ok(
    search("se bo", "definitions").every((hit) => hit.match === "gloss"),
  );
  assert.equal(search("se bo", "lojban").allLojban, true);
  assert.equal(search("book", "lojban").allLojban, false);
  assert.equal(search("cku", "lojban")[0].word_id, "cukta");
  entries[1].language = "fr";
  assert.equal(search("se bo", "lojban").allLojban, false);
  entries[1].language = "en";
  evaluation.publications.bo.status = "deprecated";
  assert.equal(search("se bo", "lojban").allLojban, false);
});
