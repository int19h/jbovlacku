import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { initializeCore } from "../../../../packages/core/src/index.ts";
import { searchMetrics, SearchRequestBudget } from "../../../../packages/search/src/index.ts";
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
const { workerReplyError, workerCrashError } = await import(
  "../../src/data/package-search.ts"
);

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

test("a worker crash during preparation reports does-not-fit", () => {
  assert.match(workerCrashError(true, true).message, /does not fit/);
  // A worker that never produced a reply may have failed to start instead.
  assert.match(
    workerCrashError(true, false).message,
    /could not start.*retry/,
  );
  assert.match(
    workerCrashError(false, true).message,
    /could not start.*retry/,
  );
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
