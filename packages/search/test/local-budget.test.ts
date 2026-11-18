import assert from "node:assert/strict";
import test from "node:test";
import {
  entryContentUnits,
  prepareIndex,
  prepareQuery,
  selectMatches,
  selectRafsiMatches,
  searchMetrics,
  SearchBudgetError,
  SearchRequestBudget,
  SEARCH_LOCAL_WORK_LIMIT,
  SEARCH_LOCAL_DEADLINE_MS,
  type LexicalEntry,
} from "../src/index.ts";

const entry = (spelling: string, text = "A disposable definition."): LexicalEntry => ({
  word: { spelling },
  glosses: [{ text: "book" }],
  plain_text: text,
});

const glossEntry = (glossCount: number): LexicalEntry => ({
  word: { spelling: "broda" },
  glosses: Array.from({ length: glossCount }, () => ({ text: "book" })),
  plain_text: "x",
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

test("preparation charges every row it builds, even with no parser work", () => {
  const entries = Array.from({ length: 20_000 }, (_, index) =>
    entry(`broda${index}`),
  );
  const metrics = searchMetrics();
  assert.throws(
    () =>
      prepareIndex(entries, metrics, {
        workLimit: 0,
        deadlineMs: Infinity,
      }),
    (error: unknown) =>
      error instanceof SearchBudgetError && error.phase === "prepare",
  );
  assert.ok(metrics.headwordsParsed < 20_000);
});

test("a scan charges each entry before reading it, not in batches", () => {
  const entries = Array.from({ length: 2_000 }, (_, index) =>
    entry(`broda${index}`),
  );
  // A prepared query and a built index isolate the scan: parsing and
  // preparation are already paid for.
  const prepared = prepareQuery("no-match", searchMetrics(), {
    workLimit: Infinity,
    deadlineMs: Infinity,
  });
  const built = prepareIndex(entries, searchMetrics(), {
    workLimit: Infinity,
    deadlineMs: Infinity,
  });
  let accepted = 0;
  assert.throws(
    () =>
      selectMatches(
        built,
        prepared,
        undefined,
        () => {
          accepted++;
          return true;
        },
        { workLimit: 10, deadlineMs: Infinity },
      ),
    (error: unknown) => error instanceof SearchBudgetError,
  );
  // Each scanned entry costs one unit plus its content in proportion to the
  // bytes the scan handles, so a 10-unit budget stops after the entries that
  // fit instead of after exactly ten entries.
  const perEntry =
    1 +
    entryContentUnits({
      word: { spelling: "broda0" },
      glosses: [{ text: "book" }],
      plain_text: "A disposable definition.",
    });
  assert.equal(accepted, Math.floor(10 / perEntry));
});

test("one shared budget covers preparation and its query together", () => {
  const spelling = (prefix: string, index: number) =>
    `${prefix}${"i".repeat(40)}${"a".repeat(index % 7)}`;
  const shared = Array.from({ length: 50 }, (_, index) =>
    entry(spelling("te", index), `Definition number ${index} about books.`),
  );
  const metrics = searchMetrics();
  const sharedBudget = new SearchRequestBudget(metrics, {
    workLimit: 50,
    deadlineMs: Infinity,
  });
  // Preparation of 50 rows costs 50 units plus parser work, so 50 is too
  // tight once the parser work is counted. A roomier shared budget completes
  // preparation and then refuses the query that exceeds what is left.
  assert.throws(
    () => prepareIndex(shared, metrics, { requestBudget: sharedBudget }),
    (error: unknown) => error instanceof SearchBudgetError,
  );
  const roomyMetrics = searchMetrics();
  const roomy = new SearchRequestBudget(roomyMetrics, {
    workLimit: 150_000,
    deadlineMs: Infinity,
  });
  prepareIndex(shared, roomyMetrics, { requestBudget: roomy });
  assert.throws(
    () =>
      selectMatches(shared, "i ".repeat(500), roomyMetrics, undefined, {
        requestBudget: roomy,
      }),
    (error: unknown) =>
      error instanceof SearchBudgetError && error.phase === "search",
  );
});

test("a grouped query parse counts against the shared request budget", () => {
  const metrics = searchMetrics();
  const shared = new SearchRequestBudget(metrics, {
    workLimit: 250_000,
    deadlineMs: Infinity,
  });
  const parsed = prepareQuery("i ".repeat(500), metrics, {
    requestBudget: shared,
  });
  assert.ok(parsed.components !== null);
  // The parse spent about two hundred thousand units on the shared budget, so
  // a large scan after it exceeds the quarter-million limit.
  const many = Array.from({ length: 100_000 }, (_, index) =>
    entry(`broda${index}`),
  );
  assert.throws(
    () =>
      selectMatches(many, parsed, metrics, undefined, {
        requestBudget: shared,
      }),
    (error: unknown) => error instanceof SearchBudgetError,
  );
});

test("preparation charges gloss count in proportion, not per entry", () => {
  // One hundred ordinary entries pass comfortably under a thousand units.
  const ordinary = Array.from({ length: 100 }, (_, index) =>
    glossEntry(1),
  );
  prepareIndex(ordinary, searchMetrics(), {
    workLimit: 1000,
    deadlineMs: Infinity,
  });
  // A hundred entries with the maximum gloss count cost hundreds of
  // thousands of units on the same budget.
  const heavy = Array.from({ length: 100 }, (_, index) => glossEntry(8192));
  assert.throws(
    () =>
      prepareIndex(heavy, searchMetrics(), {
        workLimit: 1000,
        deadlineMs: Infinity,
      }),
    (error: unknown) =>
      error instanceof SearchBudgetError && error.phase === "prepare",
  );
});

test("a long literal query is transformed once, not once per entry", () => {
  const query = "qqq.rrr";
  const entries = Array.from({ length: 200 }, (_, index) =>
    entry(`broda${index}`),
  );
  const calls: number[] = [];
  const original = String.prototype.replace;
  String.prototype.replace = function (
    this: string,
    ...args: [searchValue: string | RegExp, replaceValue: string]
  ): string {
    if (String(this) === query && String(args[0]) === "/[.,]/gu")
      calls.push(1);
    return Reflect.apply(original, this, args);
  } as typeof String.prototype.replace;
  try {
    selectMatches(entries, query, undefined, undefined, {
      patterns: false,
    });
  } finally {
    String.prototype.replace = original;
  }
  // One hoisted prefix replacement plus the single-word query shape: the
  // per-entry scan used to repeat the query replacement two hundred times.
  assert.ok(calls.length <= 5, `expected a few query replaces, saw ${calls.length}`);
});

test("an exhausted budget stops the parser before it starts", () => {
  // A 199-character spelling makes the morphology parser run tens of
  // thousands of steps under its own cap.
  const long = entry("x".repeat(199));
  const measured = searchMetrics();
  const shared = SearchRequestBudget.for(measured, {
    workLimit: 1,
    deadlineMs: Infinity,
  });
  assert.throws(
    () => prepareIndex([long], measured, { requestBudget: shared }),
    (error: unknown) => error instanceof SearchBudgetError,
  );
  // The parser never ran: only the per-entry content charge was spent.
  assert.ok(shared.snapshot().spent < 100);
  assert.equal(measured.headwordParserWork, 0);
});

test("the parser never spends past its remaining allowance", () => {
  // The review input: the spelling "a ".repeat(99) + "a" under a shared
  // budget of 100 units. Content reservation spends 6 and passes 94 to the
  // parser; the parser used to perform a 95th step and throw only at a
  // total of 101.
  const long = entry("a ".repeat(99) + "a", "x");
  const measured = searchMetrics();
  const shared = SearchRequestBudget.for(measured, {
    workLimit: 100,
    deadlineMs: Infinity,
  });
  prepareIndex([long], measured, { requestBudget: shared });
  assert.ok(
    shared.snapshot().spent <= 100,
    `spent ${shared.snapshot().spent} exceeds the shared budget`,
  );
  assert.ok(
    measured.headwordParserWork <= 94,
    `parser work ${measured.headwordParserWork} exceeds its allowance`,
  );
});

test("a nearly exhausted budget bounds the parser to what remains", () => {
  const long = entry("x".repeat(199));
  const measured = searchMetrics();
  const shared = SearchRequestBudget.for(measured, {
    workLimit: 100,
    deadlineMs: Infinity,
  });
  // The full allowance makes the parser run tens of thousands of steps and
  // refuse the request; the remaining allowance keeps the parse near zero
  // work so the request still completes.
  prepareIndex([long], measured, { requestBudget: shared });
  assert.ok(
    measured.headwordParserWork < 1000,
    `parser work ${measured.headwordParserWork}`,
  );
});

test("a later parser failure still bills the runs before it", () => {
  // The review input: ten short "a" runs parse before the last run fails
  // its 128-phoneme bound. The shared budget must see those performed
  // steps, not just the failing run.
  const query = "a ".repeat(10) + "a".repeat(129);
  const measured = searchMetrics();
  const shared = SearchRequestBudget.for(measured, {
    workLimit: 5000,
    deadlineMs: Infinity,
  });
  const first = prepareQuery(query, measured, { requestBudget: shared });
  assert.equal(first.segmentation, "limited");
  assert.ok(
    measured.queryParserWork >= 4050,
    `billed ${measured.queryParserWork}, performed 4050`,
  );
});

test("component comparisons stop at the shared allowance", () => {
  // The review input: a two-word headword against a 512-word query at a
  // 207,362-unit limit. Query parsing consumes 207,360 units and the row
  // one more, so the row content reserve would pass the limit and the
  // request refuses before the 1,023 comparisons the scan would otherwise
  // perform.
  const short = {
    word: { spelling: "a a" },
    glosses: [],
    plain_text: "book",
  } as LexicalEntry;
  const index = prepareIndex([short]);
  const query = "a ".repeat(511) + "a";
  const measured = searchMetrics();
  const budget = new SearchRequestBudget(measured, {
    workLimit: 207362,
    deadlineMs: Infinity,
  });
  assert.throws(
    () =>
      selectMatches(index, query, measured, () => true, {
        requestBudget: budget,
      }),
    (error: unknown) => error instanceof SearchBudgetError,
  );
  // No comparison ran past the allowance: the metrics show none, and the
  // measured work stays at or below the limit.
  assert.equal(measured.componentComparisons, 0);
  const spent =
    measured.entries +
    measured.componentComparisons +
    measured.queryParserWork +
    measured.headwordParserWork;
  assert.ok(spent <= 207362, `spent ${spent} exceeds the allowance`);
  // The refusal adds nothing: the budget's own total also stays at or
  // below the limit.
  assert.ok(
    budget.snapshot().spent <= 207362,
    `budget spent ${budget.snapshot().spent} exceeds the limit`,
  );
});

test("a tight preparation does not poison the whole-array cache", () => {
  // The review input: preparing under a 3-unit allowance limits the
  // "i o i" headword; a later default-allowance search must agree with a
  // fresh preparation instead of reusing that partial row.
  const rows = [
    {
      word: { spelling: "i o i" },
      glosses: [],
      plain_text: "unrelated",
    } as LexicalEntry,
  ];
  prepareIndex(rows, undefined, { workLimit: 3, deadlineMs: Infinity });
  const warm = selectMatches(rows, "o i").rows.map((row) => row.match);
  const fresh = selectMatches(structuredClone(rows), "o i").rows.map(
    (row) => row.match,
  );
  assert.deepEqual(warm, fresh);
  assert.deepEqual(warm, ["sequence-subsequence"]);
});
