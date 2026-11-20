import { before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { initializeCore, wordId } from "../../../../packages/core/src/index.ts";

let saved: typeof import("../../src/data/saved-package.ts");
let search: typeof import("../../src/data/search.ts");
let builders: typeof import("../../src/model/builders.ts");

before(async () => {
  await initializeCore(
    await readFile(
      new URL(
        "../../../../packages/core/generated/jvc_runtime_bg.wasm",
        import.meta.url,
      ),
    ),
  );
  Object.assign(globalThis, {
    location: new URL("http://local.invalid"),
    history: { state: null },
  });
  saved = await import("../../src/data/saved-package.ts");
  search = await import("../../src/data/search.ts");
  builders = await import("../../src/model/builders.ts");
});

const INVALID =
  "The search package is invalid. Search this server or download another package.";
const v1Row = (over: Record<string, unknown> = {}) => ({
  event: "jve1:" + "1".repeat(64),
  word: { language: "jbo", spelling: "cukta" },
  language: "en",
  glosses: [{ language: "en", text: "book", sense: null }],
  plain_text: "book",
  classification: { kind: "gismu", selmaho: [] },
  body: null,
  ...over,
});
const v2Row = (over: Record<string, unknown> = {}) => ({
  ...v1Row(),
  issuer: "ed25519:" + "a".repeat(64),
  notes: false,
  rafsi: ["cuk"],
  rafsi_complete: true,
  attribution: null,
  ...over,
});
const pkg = (entries: unknown[], over: Record<string, unknown> = {}) => ({
  snapshot: "sha256:" + "a".repeat(64),
  version: 2,
  entries,
  ...over,
});
/** What a page that reads every row checks: the package, then each row. */
const readAll = (value: unknown) => {
  const pkg = saved.savedPackage(value);
  for (const entry of pkg?.entries ?? []) saved.savedRow(entry, pkg!.version);
  return pkg;
};
const rejects = (value: unknown) =>
  assert.throws(
    () => readAll(value),
    (error: unknown) =>
      error instanceof saved.PackageValidationError &&
      error.message === INVALID,
  );
const workerAccepts = (value: unknown) => {
  try {
    search.validateCachedPackage(value, "en");
    return true;
  } catch {
    return false;
  }
};

test("nothing saved reads as no package", () => {
  assert.equal(saved.savedPackage(undefined), null);
});

test("the reported malformed saved values are unusable", () => {
  rejects(null);
  rejects(pkg([null]));
  rejects("package");
  rejects([]);
  rejects({ entries: [] });
  rejects(pkg([v2Row({ rafsi: undefined })].map(strip)));
  rejects(
    pkg([v2Row({ word: { language: "jbo", spelling: "cukta", extra: 1 } })]),
  );
  rejects(pkg([v1Row({ classification: null })]));
  rejects(pkg([v1Row({ glosses: [null] })]));
  rejects(pkg([v2Row({ rafsi: [1] })]));
  rejects(pkg([v2Row({ rafsi_complete: "no" })]));
  rejects(pkg([], { version: 3 }));
});

/** Drops fields whose value is undefined, as a stored row has none. */
function strip(row: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(row).filter(([, value]) => value !== undefined),
  );
}

test("every package that the search worker accepts is usable", () => {
  const view = "jve1:" + "9".repeat(64);
  const accepted = [
    pkg([], { version: undefined }),
    { snapshot: "sha256:" + "a".repeat(64), entries: [v1Row()] },
    pkg([v1Row()], { version: 1 }),
    pkg([v2Row()]),
    pkg([v2Row({ rafsi_complete: undefined })].map(strip)),
    pkg([v2Row()], { downgrade: null }),
    pkg([v2Row({ search_status: "active" })], { search_view: view }),
    pkg([v2Row({ search_status: { view, status: "retired" } })]),
  ];
  for (const value of accepted) {
    assert.ok(workerAccepts(value), JSON.stringify(value));
    assert.equal(readAll(value), value);
  }
});

test("the rule and the worker agree on every field a page reads", () => {
  // Each case changes one field of a valid package. Whenever the shared
  // rule calls the result unusable, the worker must agree, so a package
  // that the search page can use is never unusable on another page. And
  // whenever the worker rejects a case that the rule accepts, the changed
  // field must be one of the listed differences: fields that no page reads
  // before the worker's verdict, or checks that pages make when they read.
  const workerOnly = new Set([
    // The row language must equal the package language. The wizard pages
    // list packages without their keys, so the rule cannot compare them.
    "row.language",
    // Only the search page reads attribution, after the worker's verdict.
    "row.attribution",
    // The core checks the spelling where a page derives the word ID.
    "word.spelling",
    // Exact field sets and the row order: no page reads them.
    "package.extra",
    "row.extra",
    "row.order",
  ]);
  const odd = [
    undefined,
    null,
    0,
    1,
    "",
    "x",
    "fr",
    true,
    [],
    {},
    [null],
    [1],
    ["x"],
  ];
  const cases: [string, unknown][] = [];
  for (const base of [pkg([v1Row()], { version: 1 }), pkg([v2Row()])]) {
    for (const field of Object.keys(base))
      for (const value of odd)
        cases.push([`package.${field}`, strip({ ...base, [field]: value })]);
    cases.push(["package.extra", { ...base, extra: 1 }]);
    const row = base.entries[0] as Record<string, unknown>;
    for (const field of [
      ...Object.keys(row),
      "issuer",
      "notes",
      "rafsi",
      "rafsi_complete",
      "attribution",
    ])
      for (const value of odd)
        cases.push([
          `row.${field}`,
          { ...base, entries: [strip({ ...row, [field]: value })] },
        ]);
    cases.push(["row.extra", { ...base, entries: [{ ...row, extra: 1 }] }]);
    cases.push([
      "row.order",
      {
        ...base,
        entries: [{ ...row, event: "jve1:" + "2".repeat(64) }, row],
      },
    ]);
    for (const field of ["language", "spelling", "extra"])
      for (const value of odd)
        cases.push([
          `word.${field}`,
          {
            ...base,
            entries: [
              {
                ...row,
                word: strip({ ...(row.word as object), [field]: value }),
              },
            ],
          },
        ]);
    for (const field of ["kind", "selmaho", "extra"])
      for (const value of odd)
        cases.push([
          `classification.${field}`,
          {
            ...base,
            entries: [
              {
                ...row,
                classification: strip({
                  ...(row.classification as object),
                  [field]: value,
                }),
              },
            ],
          },
        ]);
    for (const field of ["language", "text", "sense", "extra"])
      for (const value of odd)
        cases.push([
          `gloss.${field}`,
          {
            ...base,
            entries: [
              {
                ...row,
                glosses: [
                  strip({
                    ...(row.glosses as object[])[0],
                    [field]: value,
                  }),
                ],
              },
            ],
          },
        ]);
    for (const value of odd)
      cases.push([
        "row.glosses",
        { ...base, entries: [{ ...row, glosses: [value] }] },
      ]);
  }
  const over = pkg([
    v2Row({ rafsi: Array.from({ length: 65 }, (_, i) => `r${i}`) }),
  ]);
  cases.push(["row.rafsi", over]);
  let rejected = 0;
  const differences = new Set<string>();
  for (const [label, value] of cases) {
    let usable = true;
    try {
      readAll(value);
    } catch {
      usable = false;
    }
    const accepted = workerAccepts(value);
    if (!usable) {
      rejected++;
      assert.equal(accepted, false, `${label} ${JSON.stringify(value)}`);
    } else if (!accepted) {
      assert.ok(workerOnly.has(label), `${label} ${JSON.stringify(value)}`);
      differences.add(label);
    }
  }
  assert.ok(rejected > 300, `only ${rejected} cases were rejected`);
  assert.deepEqual([...differences].sort(), [...workerOnly].sort());
});

test("a word that the core rejects is unusable", () => {
  assert.equal(
    saved.savedWordId({ language: "jbo", spelling: "cukta" }),
    wordId({ language: "jbo", spelling: "cukta" }),
  );
  assert.throws(
    () => saved.savedWordId({ language: "jbo", spelling: " cukta" }),
    saved.PackageValidationError,
  );
  // The row check accepts this row, and the inventory finds the bad word.
  const value = pkg([v2Row({ word: { language: "jbo", spelling: " cukta" } })]);
  assert.equal(readAll(value), value);
  assert.equal(workerAccepts(value), false);
  assert.throws(
    () => builders.inventoryFromPackage(value as never),
    saved.PackageValidationError,
  );
});

/** The pages call `list` on the real store, so this store has only `list`. */
const listStore = (values: unknown[]) => ({
  list: async <T>() => values as T[],
});

test("an unusable package does not hide a usable one on the wizard pages", async () => {
  const good = pkg([v2Row()]);
  const malformed = pkg([null, null]);
  // A stored null fails at once. The malformed package ranks first (same
  // version, more rows) and fails when its inventory reads the rows.
  const read = await builders.savedPackages(listStore([null, malformed, good]));
  assert.deepEqual(read, { packages: [malformed, good], invalid: true });
  const inventory = builders.savedInventory(read);
  assert.equal(inventory.pkg, good);
  assert.equal(inventory.invalid, true);
  assert.deepEqual(
    inventory.inventory.claims.map((claim) => claim.spelling),
    ["cukta"],
  );
});

test("a package with a word that the core rejects gives way to the next one", async () => {
  const bad = pkg([
    v2Row({ word: { language: "jbo", spelling: " cukta" } }),
    v2Row({ event: "jve1:" + "2".repeat(64) }),
  ]);
  const good = pkg([v2Row()]);
  const read = await builders.savedPackages(listStore([bad, good]));
  assert.deepEqual(read.packages, [bad, good]);
  assert.equal(read.invalid, false);
  const inventory = builders.savedInventory(read);
  assert.equal(inventory.pkg, good);
  assert.equal(inventory.invalid, true);
});

test("the best usable package is chosen as on main", async () => {
  const v1 = pkg([v1Row(), v1Row()], { version: 1 });
  const small = pkg([v2Row()]);
  const large = pkg([v2Row(), v2Row()]);
  const read = await builders.savedPackages(listStore([v1, small, large]));
  assert.deepEqual(read, { packages: [large, small, v1], invalid: false });
  assert.deepEqual(
    await builders.savedPackages({
      list: async () => {
        throw new Error("storage failed");
      },
    }),
    { packages: [], invalid: false },
  );
  assert.deepEqual(builders.savedInventory({ packages: [], invalid: false }), {
    pkg: null,
    inventory: builders.inventoryFromPackage(null),
    invalid: false,
  });
});

test("the word index counts rows that fail the row check", async () => {
  const index = search.createPackageWordIndex();
  const value = pkg([v2Row(), null, v2Row({ glosses: null })]) as never;
  assert.equal(
    index(value, wordId({ language: "jbo", spelling: "cukta" })).length,
    1,
  );
  assert.equal(index.invalidEntryCount(value), 2);
});

test("a rafsi with a lone surrogate is unusable, though the worker accepts it", () => {
  const lone = pkg([v2Row({ rafsi: ["\ud800"] })]);
  rejects(lone);
  // The one known case where the rule is stricter than the worker: the
  // core cannot serialize this rafsi when a page derives its pair ID.
  assert.equal(workerAccepts(lone), true);
  // A surrogate pair is well-formed and stays usable.
  const paired = pkg([v2Row({ rafsi: ["😀"] })]);
  assert.equal(readAll(paired), paired);
});

test("an event or row language with a lone surrogate is unusable", () => {
  for (const over of [{ event: "\ud800" }, { language: "en\udc00" }]) {
    const value = pkg([v2Row(over)]);
    rejects(value);
    assert.equal(workerAccepts(value), false);
  }
});
