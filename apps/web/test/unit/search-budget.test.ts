import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { initializeCore } from "../../../../packages/core/src/index.ts";
import {
  searchMetrics,
  SearchBudgetError,
  SearchRequestBudget,
} from "../../../../packages/search/src/index.ts";
import type { PackageEntry } from "../../src/model/types.ts";

Object.assign(globalThis, {
  location: new URL("http://local.invalid"),
  history: { state: null },
});

await initializeCore(
  await readFile(
    new URL(
      "../../../../packages/core/generated/jvc_runtime_bg.wasm",
      import.meta.url,
    ),
  ),
);
const searchModule: typeof import("../../src/data/search.ts") = await import(
  "../../src/data/search.ts"
);
const { localSearch, validateCachedPackage } = searchModule;
const {
  workerReplyError,
  workerCrashReason,
  workerErrorMessage,
  workerErrorName,
  resolvePackageHits,
} = await import("../../src/data/package-search.ts");

const packageEntry = (index: number): PackageEntry => ({
  event: "jve1:" + (index + 1).toString(16).padStart(64, "0"),
  word: { language: "jbo", spelling: `broda${index}` },
  language: "en",
  glosses: [{ language: "en", text: "book", sense: null }],
  plain_text: `Book definition ${index}.`,
  classification: { kind: "gismu", selmaho: [] },
  body: null,
});

test("worker reply codes map to their documented errors", () => {
  const invalid = workerReplyError("invalid-package", "bad shape");
  assert.equal(invalid.constructor.name, "PackageValidationError");
  assert.equal(invalid.message, "bad shape");
  const missing = workerReplyError("package-missing", "gone");
  assert.ok(!(missing instanceof Error) || missing.message === "gone");
  assert.equal(missing.constructor.name, "MissingPackageError");
  // The worker sends the documented message; the client keeps that text
  // and reports it as a storage failure.
  const tooLarge = workerReplyError(
    "package-too-large",
    "The search package does not fit in this browser's storage or memory.",
  );
  assert.equal(tooLarge.constructor.name, "PackageStorageError");
  assert.match(tooLarge.message, /does not fit/);
  const pattern = workerReplyError("pattern_timeout", "slow");
  assert.equal(pattern.constructor.name, "PatternError");
  const other = workerReplyError("unknown-code", "plain");
  assert.equal(other.constructor.name, "Error");
  assert.equal(other.message, "plain");
});

test("a worker crash is classified by cause, not history", () => {
  const generic = /could not start.*retry/;
  // An ordinary code bug keeps the startup message, before or after any
  // earlier reply: a prior memory failure must not launder it.
  assert.match(workerCrashReason({ errorName: "Error" }).message, generic);
  assert.match(
    workerCrashReason({ errorName: undefined }).message,
    generic,
  );
  // An allocation failure reports does-not-fit on its own evidence, in
  // either engine's wording. A bare RangeError no longer suffices: only the
  // message proves the cause.
  assert.match(
    workerCrashReason({ errorName: "RangeError" }).message,
    generic,
  );
  assert.match(
    workerCrashReason({
      errorName: "RangeError",
      message: "Array buffer allocation failed",
    }).message,
    /does not fit/,
  );
  assert.match(
    workerCrashReason({
      errorName: "RangeError",
      message: "invalid array length",
    }).message,
    /does not fit/,
  );
  assert.match(
    workerCrashReason({ errorName: "RangeError", message: "out of memory" })
      .message,
    /does not fit/,
  );
  // A bounds error is also a RangeError but keeps the startup message, in
  // both engines' wording.
  assert.match(
    workerCrashReason({
      errorName: "RangeError",
      message: "Offset is outside of the bounds of the DataView",
    }).message,
    generic,
  );
  assert.match(
    workerCrashReason({
      errorName: "RangeError",
      message: "offset is outside the bounds of the DataView",
    }).message,
    generic,
  );
  assert.match(
    workerCrashReason({ errorName: "QuotaExceededError" }).message,
    /does not fit/,
  );
  // A load failure keeps the startup message.
  assert.match(
    workerCrashReason({ errorName: "SyntaxError" }).message,
    generic,
  );
  // A stale memory report cannot classify a later crash: the old positional
  // call that mapped two truthy flags to does-not-fit now reports the
  // startup message.
  const staleEvidence = {
    hadPendingPreparation: true,
    memoryPressure: true,
    errorName: "Error",
  } as unknown as Parameters<typeof workerCrashReason>[0];
  assert.match(workerCrashReason(staleEvidence).message, generic);
});

test("worker error names cover both engines' event shapes", () => {
  assert.equal(workerErrorName(new RangeError("x")), "RangeError");
  // Chromium prefixes the name with "Uncaught".
  assert.equal(
    workerErrorName({ message: "Uncaught RangeError: Array buffer allocation failed" }),
    "RangeError",
  );
  // Firefox reports the bare name with a null error object.
  assert.equal(
    workerErrorName({ message: "RangeError: review allocation failure", error: null }),
    "RangeError",
  );
  assert.equal(
    workerErrorName({ message: "Uncaught Error: plain probe bug" }),
    "Error",
  );
  assert.equal(workerErrorName({ message: "nothing useful" }), undefined);
  assert.equal(workerErrorName(null), undefined);
});

test("entry content counts items and bytes, never malformed shapes", async () => {
  const { entryContentUnits } = await import(
    "../../../../packages/search/src/index.ts"
  );
  assert.equal(entryContentUnits(null), 0);
  assert.equal(entryContentUnits("broda"), 0);
  // One gloss and a short headword stay small.
  assert.equal(
    entryContentUnits({
      word: { spelling: "broda" },
      glosses: [{ text: "book" }],
      plain_text: "x",
    }),
    1 + Math.ceil((5 + 1 + 4) / 64),
  );
  // Thousands of glosses cost thousands of units.
  assert.ok(
    entryContentUnits({
      word: { spelling: "broda" },
      glosses: Array.from({ length: 8192 }, () => ({ text: "x".repeat(250) })),
      plain_text: "x",
    }) > 40000,
  );
  // An oversized malformed list cannot turn into a budget refusal: counts
  // stop at the validation bounds so validation still reports invalid input.
  assert.ok(
    entryContentUnits({ glosses: new Array(1000000).fill({ text: "x" }) }) <
      20000,
  );
});

test("a worker budget refusal keeps its resource type", () => {
  const prepared = workerReplyError(
    "resource-limit",
    "The package index is too costly to build on this device.",
    "prepare",
  );
  assert.ok(prepared instanceof SearchBudgetError);
  assert.equal(prepared.phase, "prepare");
  const searched = workerReplyError(
    "resource-limit",
    "Local search reached its work or time limit.",
    "search",
  );
  assert.ok(searched instanceof SearchBudgetError);
  assert.equal(searched.phase, "search");
});

test("only allocation wording marks a RangeError as out of room", async () => {
  const { isAllocationFailure } = await import(
    "../../src/data/package-search.ts"
  );
  assert.equal(
    isAllocationFailure(new RangeError("Array buffer allocation failed")),
    true,
  );
  assert.equal(
    isAllocationFailure(new RangeError("invalid array length")),
    true,
  );
  assert.equal(isAllocationFailure(new RangeError("out of memory")), true);
  assert.equal(
    isAllocationFailure(
      new RangeError("Offset is outside of the bounds of the DataView"),
    ),
    false,
  );
  assert.equal(isAllocationFailure(new RangeError()), false);
  assert.equal(isAllocationFailure(new Error("out of memory")), false);
  assert.equal(isAllocationFailure(null), false);
});

test("worker crash messages keep both engines' wording", () => {
  assert.equal(workerErrorMessage(new RangeError("Array buffer allocation failed")), "Array buffer allocation failed");
  assert.equal(
    workerErrorMessage({
      message: "Uncaught RangeError: Array buffer allocation failed",
      error: null,
    }),
    "Uncaught RangeError: Array buffer allocation failed",
  );
  assert.equal(
    workerErrorMessage({
      message: "RangeError: offset is outside the bounds of the DataView",
      error: null,
    }),
    "RangeError: offset is outside the bounds of the DataView",
  );
  assert.equal(workerErrorMessage(null), undefined);
});

test("cached-package validation charges the request budget", () => {
  const pkg = {
    snapshot: "sha256:" + "a".repeat(64),
    entries: [packageEntry(0), packageEntry(1), packageEntry(2)],
  };
  const metrics = searchMetrics();
  const shared = new SearchRequestBudget(metrics, {
    workLimit: 0,
    deadlineMs: Infinity,
  });
  assert.throws(
    () => validateCachedPackage(pkg, "en", shared),
    (error: unknown) =>
      error instanceof Error &&
      error.constructor.name === "SearchBudgetError" &&
      (error as unknown as { phase: string }).phase === "prepare",
  );
  // Without a budget the same package validates.
  assert.doesNotThrow(() => validateCachedPackage(pkg, "en"));
});

test("grouping and sorting share the request budget", () => {
  const entries = Array.from({ length: 100_000 }, (_, index) =>
    packageEntry(index),
  );
  // A prepared query isolates the scan: parsing is already paid for.
  const prepared = { text: "book", headword: "book", components: null as null, positions: new Map(), segmentation: "complete" as const };
  assert.throws(
    () =>
      localSearch(entries, prepared, searchMetrics(), false, {
        workLimit: 100_000,
        deadlineMs: Infinity,
      }),
    (error: unknown) =>
      error instanceof Error && error.constructor.name === "SearchBudgetError",
  );
});

test("the request deadline covers grouping and sorting", () => {
  const entries = Array.from({ length: 100_000 }, (_, index) =>
    packageEntry(index),
  );
  const prepared = { text: "book", headword: "book", components: null as null, positions: new Map(), segmentation: "complete" as const };
  // One millisecond is far below any full run over 100,000 rows, so the
  // deadline must stop the operation instead of returning after it.
  assert.throws(
    () =>
      localSearch(entries, prepared, searchMetrics(), false, {
        workLimit: Infinity,
        deadlineMs: 1,
      }),
    (error: unknown) =>
      error instanceof Error &&
      error.constructor.name === "SearchBudgetError" &&
      /work or time limit/.test(error.message),
  );
});

test("rafsi merging charges its linear cost with identical results", () => {
  const rows = 8000;
  const entries: PackageEntry[] = Array.from({ length: rows }, (_, index) => ({
    ...packageEntry(index),
    word: { language: "jbo", spelling: "broda" },
    rafsi: [`r${index}`],
  }));
  const hits = localSearch(entries, "*", searchMetrics(), true, {
    workLimit: Infinity,
    deadlineMs: Infinity,
  });
  assert.equal(hits.length, 1);
  const merged = [...(hits[0].matchingRafsi ?? [])].sort();
  assert.equal(merged.length, rows);
  assert.deepEqual(hits[0].matchingRafsi, merged);
  // Scan and grouping charge two units per row, so a budget of two rows'
  // worth refuses once the merge insertions and the final sort add more.
  assert.throws(
    () =>
      localSearch(entries, "*", searchMetrics(), true, {
        workLimit: rows * 2,
        deadlineMs: Infinity,
      }),
    (error: unknown) =>
      error instanceof Error && error.constructor.name === "SearchBudgetError",
  );
});

test("page-side reference rebuild charges the continued budget", () => {
  const entries = Array.from({ length: 10 }, (_, index) =>
    packageEntry(index),
  );
  const pkg = {
    snapshot: "sha256:" + "a".repeat(64),
    entries,
  };
  const pages = [
    [
      {
        word_id: "w1",
        match: "headword" as const,
        entries: entries.map((_, index) => index),
        definitions: entries.map((_, index) => index),
        preview: 0,
      },
    ],
  ];
  const complete = resolvePackageHits(
    pkg,
    pages,
    new SearchRequestBudget(searchMetrics(), {
      workLimit: Infinity,
      deadlineMs: Infinity,
    }),
  );
  assert.equal(complete[0][0].entries.length, 10);
  assert.equal(complete[0][0].definitions.length, 10);
  assert.throws(
    () =>
      resolvePackageHits(
        pkg,
        pages,
        new SearchRequestBudget(searchMetrics(), {
          workLimit: 10,
          deadlineMs: Infinity,
        }),
      ),
    (error: unknown) =>
      error instanceof Error && error.constructor.name === "SearchBudgetError",
  );
});
