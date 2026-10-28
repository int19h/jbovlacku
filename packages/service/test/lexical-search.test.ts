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
