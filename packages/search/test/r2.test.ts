import assert from "node:assert/strict";
import test from "node:test";
import { selectMatches, matchRank, searchMetrics } from "../src/index.ts";
const entry = (spelling: string, gloss = "") => ({
  word: { spelling },
  glosses: gloss ? [{ text: gloss }] : [],
  plain_text: "Synthetic definition.",
});
const search = (spellings: string[], query: string) =>
  selectMatches(
    spellings.map((word) => entry(word)),
    query,
  )
    .rows.sort(
      (a, b) =>
        matchRank(a.match) - matchRank(b.match) || a.position - b.position,
    )
    .map((row) => [row.entry.word.spelling, row.match]);

test("R2 canonical single words keep the headword class", () => {
  for (const [query, spelling] of [
    ["klama.", "klama"],
    ["(klama)", "klama"],
    [".i", "i"],
    ["1", "pa"],
    ["riha", "ri'a"],
  ])
    assert.deepEqual(
      search([spelling], query),
      [[spelling, "headword"]],
      query,
    );
});
test("R2 one recognized word beside a foreign run gets a card", () => {
  for (const query of ["klama mibaoz", "mibaoz klama"])
    assert.deepEqual(search(["klama"], query), [["klama", "component"]], query);
});
test("R2 matched query spans keep cards for uncovered words", () => {
  const words = [
    "i",
    "je",
    "bo",
    "ije",
    "klama",
    "le",
    "nu",
    "lenu",
    "mi",
    "iseri'abo",
  ];
  for (const [query, leftovers] of [
    ["ijebo", ["bo"]],
    ["ijebo klama", ["bo", "klama"]],
    ["le nu klama", ["klama"]],
    ["mi klama i seri'a bo", ["mi", "klama"]],
  ] as [string, string[]][])
    assert.deepEqual(
      search(words, query)
        .filter(([, kind]) => kind === "component")
        .map(([word]) => word),
      leftovers,
      query,
    );
});
test("R2 subsequences never hide query-word cards", () => {
  const hits = search(["i", "bo", "iseri'abo"], "i bo");
  assert.deepEqual(
    hits.filter(([, kind]) => kind === "component").map(([word]) => word),
    ["i", "bo"],
  );
});
test("R2 ordinary prefixes precede compounds containing the query", () => {
  assert.deepEqual(
    search(["iseri'abo", "selbri", "se'a", "se"], "se").map(([, kind]) => kind),
    ["headword", "headword-prefix", "headword-prefix", "sequence-subsequence"],
  );
});
test("R2 an exact whole-query gloss precedes a cmavo sequence", () => {
  const hits = selectMatches(
    [entry("sono"), entry("broda", "so no")],
    "so no",
  ).rows.sort((a, b) => matchRank(a.match) - matchRank(b.match));
  assert.deepEqual(
    hits.map((row) => row.match),
    ["gloss", "sequence-exact"],
  );
});
test("R2 overlong indexed headwords expose incomplete sequence coverage", () => {
  assert.equal(
    selectMatches([entry("ba".repeat(200))], "ba ba").segmentation,
    "limited",
  );
});
test("R2 morphology skips noncmavo headwords and survives fresh entry clones", () => {
  const entries = [
    ...Array.from({ length: 1000 }, () => entry("klama")),
    entry("ijebo"),
    entry("ijebo"),
  ];
  const cold = searchMetrics();
  selectMatches(entries, "klama", cold);
  assert.ok(cold.headwordsParsed <= 1, JSON.stringify(cold));
  const reloaded = searchMetrics();
  selectMatches(structuredClone(entries), "klama", reloaded);
  assert.equal(reloaded.headwordsParsed, 0);
});

test("R2 canonical aliases preserve literal prefix lookup", () => {
  assert.equal(search(["haskell"], "has")[0]?.[1], "headword-prefix");
  assert.equal(search([".djan."], ".")[0]?.[1], "headword-prefix");
});

test("R2 parser counters cover every query in a nearby batch", () => {
  const rows = [entry("klama")];
  const metrics = searchMetrics();
  selectMatches(rows, "klama", metrics);
  const first = metrics.queryParserWork;
  selectMatches(rows, "klama", metrics);
  assert.equal(metrics.queryParses, 2);
  assert.equal(metrics.queryWords, 2);
  assert.equal(metrics.queryParserWork, first * 2);
});

test("R2 prefix-shaped compounds keep the weaker component class", () => {
  assert.deepEqual(search(["sefa'e", "selbri", "se'a", "se"], "se"), [
    ["se", "headword"],
    ["selbri", "headword-prefix"],
    ["se'a", "headword-prefix"],
    ["sefa'e", "sequence-subsequence"],
  ]);
  assert.deepEqual(search(["sefa'e"], "sef"), [["sefa'e", "headword-prefix"]]);
});
