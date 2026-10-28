import assert from "node:assert/strict";
import test from "node:test";
import {
  selectMatches,
  matchKind,
  searchMetrics,
  prepareQuery,
  SEARCH_QUERY_WORD_LIMIT,
  SEARCH_SEGMENT_WORK_LIMIT,
  type LexicalEntry,
} from "../src/index.ts";
const entry = (spelling: string): LexicalEntry => ({
  word: { spelling },
  glosses: [],
  plain_text: "Synthetic definition.",
});
const result = (entries: LexicalEntry[], query: string) =>
  selectMatches(entries, query).rows.map(({ entry, match }) => [
    entry.word.spelling,
    match,
  ]);

test("compound headwords use the same components across joined and spaced queries", () => {
  for (const query of ["i seri'a bo", "ise ri'abo", "iseri'abo", "I SE RÍ’ABO"])
    assert.ok(
      ["headword", "sequence-exact"].includes(
        matchKind(entry("iseri'abo"), query)!,
      ),
    );
  assert.equal(
    matchKind(entry("iseri'abo"), "mi klama i seri'a bo do"),
    "sequence-contiguous",
  );
  assert.equal(
    matchKind(entry("iseri'abo"), "se ri'a"),
    "sequence-subsequence",
  );
  assert.equal(matchKind(entry("iseri'abo"), "i bo"), "sequence-subsequence");
  assert.equal(matchKind(entry("iseri'abo"), "bo i"), null);
  assert.equal(matchKind(entry("iseri'abo"), "i i bo"), null);
});

test("taia splits into tai and a, rather than ta and ia", () => {
  assert.deepEqual(prepareQuery("taia").components?.words, ["tai", "a"]);
  assert.deepEqual(
    result([entry("tai"), entry("a"), entry("ta"), entry("ia")], "taia"),
    [
      ["tai", "component"],
      ["a", "component"],
    ],
  );
  assert.equal(matchKind(entry("taia"), "tai a"), "sequence-exact");
  assert.equal(matchKind(entry("taia"), "ta ia"), null);
});

test("fallback uses every recognized query word and keeps ordinary full-query matches", () => {
  const entries = ["i", "je", "bo", "klama", "dján"].map(entry);
  assert.deepEqual(result(entries, "ijebo"), [
    ["i", "component"],
    ["je", "component"],
    ["bo", "component"],
  ]);
  assert.deepEqual(result(entries, "i klama dján bo"), [
    ["i", "component"],
    ["bo", "component"],
    ["klama", "component"],
    ["dján", "component"],
  ]);
  assert.deepEqual(result([...entries, entry("ijebo")], "ijebo"), [
    ["ijebo", "headword"],
  ]);
  assert.deepEqual(result([entry("klamaku")], "klama ku"), []);
  const gloss = { ...entry("broda"), glosses: [{ text: "i klama" }] };
  assert.deepEqual(result([gloss, ...entries], "i klama"), [
    ["broda", "gloss"],
    ["i", "component"],
    ["klama", "component"],
  ]);
});

test("foreign runs prevent joined matches across the barrier", () => {
  const entries = [entry("ibo"), entry("i"), entry("bo")];
  assert.deepEqual(result(entries, "i mibaoz bo"), [
    ["i", "component"],
    ["bo", "component"],
  ]);
  assert.equal(matchKind(entry("ibo"), "i bo mibaoz"), "sequence-contiguous");
});

test("ordinary lexical classes ignore case and use explicit apostrophe aliases", () => {
  assert.equal(matchKind(entry("dján"), "DJAN"), "headword");
  assert.equal(
    matchKind({ ...entry("broda"), glosses: [{ text: "Can't" }] }, "CAN’T"),
    "gloss",
  );
  assert.equal(matchKind(entry("cukta"), "cuk"), "headword-prefix");
  assert.equal(
    matchKind({ ...entry("broda"), glosses: [{ text: "bookcase" }] }, "book"),
    "gloss-prefix",
  );
  assert.equal(
    matchKind({ ...entry("broda"), plain_text: "A book." }, "book"),
    "token",
  );
});

test("one hundred words use linear component comparisons with no subset enumeration", () => {
  const entries = Array.from({ length: 200 }, () =>
    entry("mi".repeat(30) + "bo"),
  );
  const query = [...Array(99).fill("mi"), "bo"].join(" ");
  let scans = 0;
  const source = {
    *[Symbol.iterator]() {
      scans++;
      yield* entries;
    },
  };
  const metrics = searchMetrics();
  const selected = selectMatches(source, query, metrics);
  assert.equal(scans, 1);
  assert.equal(selected.segmentation, "complete");
  assert.equal(metrics.queryWords, 100);
  assert.ok(selected.rows.every((row) => row.match === "sequence-contiguous"));
  assert.equal(selected.rows.length, entries.length);
  assert.ok(metrics.componentComparisons <= 4 * entries.length * (100 + 31));
  assert.ok(metrics.queryParserWork <= SEARCH_SEGMENT_WORK_LIMIT);
  const warm = searchMetrics();
  selectMatches(entries, query, warm);
  assert.equal(warm.headwordsParsed, 0);
});

test("resource limits keep ordinary search and never use a partial component query", () => {
  for (const query of [
    "i".repeat(129),
    Array(SEARCH_QUERY_WORD_LIMIT + 1)
      .fill("i")
      .join(" "),
    "x".repeat(16_385),
  ]) {
    const row = { ...entry("broda"), glosses: [{ text: query }] };
    const selected = selectMatches([entry("i"), row], query);
    assert.equal(selected.segmentation, "limited");
    assert.deepEqual(
      selected.rows.map((row) => row.match),
      ["gloss"],
    );
  }
  const oversized = entry("ba".repeat(128) + "bo");
  assert.equal(matchKind(oversized, oversized.word.spelling), "headword");
  assert.equal(matchKind(oversized, "i bo"), null);
});

test("the component index covers legal headwords through 256 bytes", () => {
  for (const count of [65, 80, 128]) {
    const headword = entry("ba".repeat(count));
    assert.equal(matchKind(headword, "ba ba"), "sequence-subsequence");
    assert.equal(selectMatches([headword], "ba ba").segmentation, "complete");
  }
});

test("one hundred query words match a genuine subsequence and reject repeated prefixes in linear work", () => {
  const query = [...Array(99).fill("mi"), "bo"].join(" ");
  const headword = entry("mi".repeat(50) + "ta" + "mi".repeat(49) + "bo");
  const mismatch = entry("mi".repeat(100) + "ta");
  const metrics = searchMetrics();
  const selected = selectMatches([headword, mismatch], query, metrics);
  assert.deepEqual(
    selected.rows.map((row) => row.match),
    ["sequence-subsequence"],
  );
  assert.equal(selected.segmentation, "complete");
  assert.equal(metrics.queryWords, 100);
  assert.ok(metrics.componentComparisons <= 4 * 2 * (100 + 101));
});
