import assert from "node:assert/strict";
import test from "node:test";
import {
  prepareIndex,
  selectMatches,
  selectRafsiMatches,
  searchMetrics,
  SearchBudgetError,
  SEARCH_LOCAL_WORK_LIMIT,
  SEARCH_LOCAL_DEADLINE_MS,
  type LexicalEntry,
} from "../src/index.ts";

const entry = (spelling: string, text = "A disposable definition."): LexicalEntry => ({
  word: { spelling },
  glosses: [{ text: "book" }],
  plain_text: text,
});

// A slow scan stands in for a very large retained package: the accept hook
// busy-waits on every entry so the deadline has something to catch.
const spinMs = (ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end);
};

test("a tiny work budget refuses a scan that ordinary defaults accept", () => {
  const entries = Array.from({ length: 200 }, (_, index) => entry(`broda${index}`));
  const rows = selectMatches(entries, "broda").rows;
  assert.ok(rows.length > 0);
  assert.throws(
    () => selectMatches(entries, "broda", undefined, undefined, { workLimit: 10 }),
    (error: unknown) =>
      error instanceof SearchBudgetError &&
      error.phase === "search" &&
      /work or time limit/.test(error.message),
  );
});

test("the default work budget accepts a large ordinary package scan", () => {
  assert.ok(SEARCH_LOCAL_WORK_LIMIT >= 1_000_000);
  const entries = Array.from({ length: 20_000 }, (_, index) =>
    entry(`broda${index}`),
  );
  const { rows } = selectMatches(entries, "broda19999");
  assert.ok(rows.length > 0);
  const metrics = searchMetrics();
  selectMatches(entries, "broda19999", metrics);
  const work =
    metrics.entries +
    metrics.componentComparisons +
    metrics.queryParserWork +
    metrics.headwordParserWork;
  assert.ok(work < SEARCH_LOCAL_WORK_LIMIT);
});

test("a short deadline refuses a slow scan that the default deadline accepts", () => {
  assert.ok(SEARCH_LOCAL_DEADLINE_MS >= 1_000);
  const entries = Array.from({ length: 60 }, (_, index) => entry(`broda${index}`));
  const accept = () => {
    spinMs(5);
    return true;
  };
  assert.throws(
    () =>
      selectMatches(entries, "broda", undefined, accept, { deadlineMs: 50 }),
    (error: unknown) =>
      error instanceof SearchBudgetError &&
      /work or time limit/.test(error.message),
  );
  const { rows } = selectMatches(entries, "broda", undefined, accept);
  assert.ok(rows.length > 0);
});

test("a tiny preparation budget refuses indexing that ordinary defaults accept", () => {
  // Long vowel runs parse as compounds, so indexing spends parser work.
  const spelling = (prefix: string, index: number) =>
    `${prefix}${"i".repeat(40)}${"a".repeat(index % 7)}`;
  const entries = Array.from({ length: 50 }, (_, index) =>
    entry(spelling("se", index), `Definition number ${index} about books.`),
  );
  const metrics = searchMetrics();
  prepareIndex(entries, metrics);
  assert.ok(metrics.headwordsParsed > 0);
  assert.ok(metrics.headwordParserWork > 1);
  const fresh = Array.from({ length: 50 }, (_, index) =>
    entry(spelling("te", index), `Definition number ${index} about books.`),
  );
  assert.throws(
    () => prepareIndex(fresh, searchMetrics(), { workLimit: 1 }),
    (error: unknown) =>
      error instanceof SearchBudgetError &&
      error.phase === "prepare" &&
      /preparation/.test(error.message),
  );
});

test("a tiny budget also refuses rafsi scans that ordinary defaults accept", () => {
  const entries = Array.from({ length: 100 }, (_, index) => ({
    ...entry(`broda${index}`),
    rafsi: ["cku"],
  }));
  const accepted = selectRafsiMatches(entries, "cku");
  assert.equal(accepted.rows.length, 100);
  assert.throws(
    () => selectRafsiMatches(entries, "cku", undefined, { workLimit: 10 }),
    (error: unknown) => error instanceof SearchBudgetError,
  );
});
