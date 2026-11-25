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
  for (const entry of pkg?.entries ?? [])
    saved.savedRow(entry, pkg!.version, "en");
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
    // Only the search page reads attribution, after the worker's verdict.
    "row.attribution",
    // The core checks the spelling where a page derives the word ID.
    "word.spelling",
    // A row's ordering status: only the worker reads it. A package with a
    // bad status still reaches the lujvo builder, whose part lookup then
    // reports that the local lookup is unavailable, as on main.
    "row.search_status",
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
  const view = "jve1:" + "9".repeat(64);
  for (const status of ["unknown", 1, null, ""])
    cases.push([
      "row.search_status",
      pkg([v2Row({ search_status: status })], { search_view: view }),
    ]);
  for (const status of [{ view, status: "unknown" }, { view }, "active"])
    cases.push(["row.search_status", pkg([v2Row({ search_status: status })])]);
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
    () =>
      builders.inventoryFromPackage({ language: "en", pkg: value as never }),
    saved.PackageValidationError,
  );
});

const listStore = (values: [string, unknown][]) => ({
  listPackages: async () => values,
});

test("an unusable package does not hide a usable one on the wizard pages", async () => {
  const good = pkg([v2Row()]);
  const malformed = pkg([null, null]);
  // A stored null fails at once. The malformed package ranks first (same
  // version, more rows) and fails when its inventory reads the rows.
  const read = await builders.savedPackages(
    listStore([
      ["de", null],
      ["fr", malformed],
      ["en", good],
    ]),
  );
  assert.deepEqual(read, {
    packages: [
      { language: "fr", pkg: malformed },
      { language: "en", pkg: good },
    ],
    invalid: true,
  });
  const inventory = builders.savedInventory(read);
  assert.equal(inventory.selected?.pkg, good);
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
  const read = await builders.savedPackages(
    listStore([
      ["en", bad],
      ["en", good],
    ]),
  );
  assert.deepEqual(
    read.packages.map(({ pkg }) => pkg),
    [bad, good],
  );
  assert.equal(read.invalid, false);
  const inventory = builders.savedInventory(read);
  assert.equal(inventory.selected?.pkg, good);
  assert.equal(inventory.invalid, true);
});

test("the best usable package is chosen as on main", async () => {
  const v1 = pkg([v1Row(), v1Row()], { version: 1 });
  const small = pkg([v2Row()]);
  const large = pkg([v2Row(), v2Row()]);
  const read = await builders.savedPackages(
    listStore([
      ["en", v1],
      ["en", small],
      ["en", large],
    ]),
  );
  assert.deepEqual(
    read.packages.map(({ pkg }) => pkg),
    [large, small, v1],
  );
  assert.equal(read.invalid, false);
  assert.deepEqual(
    await builders.savedPackages({
      listPackages: async () => {
        throw new Error("storage failed");
      },
    }),
    { packages: [], invalid: false },
  );
  assert.deepEqual(builders.savedInventory({ packages: [], invalid: false }), {
    selected: null,
    inventory: builders.inventoryFromPackage(null),
    invalid: false,
  });
});

test("the word index counts rows that fail the row check", async () => {
  const index = search.createPackageWordIndex();
  const value = pkg([v2Row(), null, v2Row({ glosses: null })]) as never;
  assert.equal(
    index(value, "en", wordId({ language: "jbo", spelling: "cukta" })).length,
    1,
  );
  assert.equal(index.invalidEntryCount(value, "en"), 2);
});

test("the word index checks the language even if it saw the package object before", () => {
  const index = search.createPackageWordIndex();
  const value = pkg([v2Row()]) as never;
  const id = wordId({ language: "jbo", spelling: "cukta" });
  assert.equal(index(value, "en", id).length, 1);
  assert.equal(index(value, "fr", id).length, 0);
  assert.equal(index.invalidEntryCount(value, "fr"), 1);
});

test("wizard inventory skips a package whose rows disagree with its key", async () => {
  const wrongLanguage = pkg([
    v2Row(),
    v2Row({ event: "jve1:" + "2".repeat(64) }),
  ]);
  const good = pkg([v2Row()]);
  const read = await builders.savedPackages(
    listStore([
      ["fr", wrongLanguage],
      ["en", good],
    ]),
  );
  const inventory = builders.savedInventory(read);
  assert.equal(inventory.invalid, true);
  assert.deepEqual(inventory.selected, { language: "en", pkg: good });
});

test("a rafsi with a lone surrogate is unusable in both readers", () => {
  const lone = pkg([v2Row({ rafsi: ["\ud800"] })]);
  rejects(lone);
  assert.equal(workerAccepts(lone), false);
  // A surrogate pair is well-formed and stays usable.
  const paired = pkg([v2Row({ rafsi: ["😀"] })]);
  assert.equal(readAll(paired), paired);
  assert.equal(workerAccepts(paired), true);
});

test("an event or row language with a lone surrogate is unusable", () => {
  for (const over of [{ event: "\ud800" }, { language: "en\udc00" }]) {
    const value = pkg([v2Row(over)]);
    rejects(value);
    assert.equal(workerAccepts(value), false);
  }
});

test("empty array slots are read as the worker reads them", () => {
  // IndexedDB keeps empty slots. The worker's `.some` skips them, so the
  // rule must skip them too.
  const selmaho = new Array(1);
  const glosses = [v1Row().glosses[0]];
  glosses.length = 2;
  const rafsi = ["cuk"];
  rafsi.length = 2;
  for (const row of [
    v2Row({ classification: { kind: "gismu", selmaho } }),
    v2Row({ glosses }),
    v2Row({ rafsi }),
  ]) {
    const value = pkg([row]);
    assert.ok(workerAccepts(value));
    assert.equal(readAll(value), value);
  }
});

test("an own some property on a stored array does not replace the rule's test", () => {
  // The worker calls the array's own `some` and rejects the package when it
  // is not a function. The rule uses `Array.prototype.some`, so it accepts
  // this one listed difference without throwing a raw error.
  const glosses = Object.assign([v1Row().glosses[0]], { some: false });
  const value = pkg([v2Row({ glosses })]);
  assert.equal(workerAccepts(value), false);
  assert.equal(readAll(value), value);
});

test("spelling checks and bounded batches agree with core wordId on composition and byte counterexamples", () => {
  const validCases = [
    "cukta",
    "ba'a",
    "Ba’a",
    "bá",
    "máik",
    "slaka bu",
    "a".repeat(256),
    "水".repeat(85) + "a",
    "𠮷".repeat(64),
    "a\u00a0b",
  ];
  const invalidCases = [
    "",
    " ",
    " cukta",
    "cukta ",
    "a".repeat(257),
    "水".repeat(86),
    "𠮷".repeat(65),
    "\u1100\u1161",
    "e\u0301",
    "á\u0301",
    "q\u0301",
    "\u00a0a",
    "x\0",
    "\ud800",
    "\u1e83",
  ];
  const batch = saved.savedSpellingChecks();
  for (const spelling of validCases) {
    assert.doesNotThrow(() =>
      saved.checkSavedWord({ language: "jbo", spelling }),
    );
    assert.doesNotThrow(() => wordId({ language: "jbo", spelling }));
    batch.add(spelling);
  }
  assert.doesNotThrow(() => batch.finish());
  for (const spelling of invalidCases) {
    assert.throws(() => wordId({ language: "jbo", spelling }));
    assert.throws(
      () => saved.checkSavedWord({ language: "jbo", spelling }),
      saved.PackageValidationError,
      JSON.stringify(spelling),
    );
    const badBatch = saved.savedSpellingChecks();
    assert.throws(() => {
      badBatch.add("𠮷");
      badBatch.add(spelling);
      badBatch.finish();
    }, saved.PackageValidationError);
  }
});

test("samePackageStructure detects holes, extra array keys, order changes, and stays within budget", async () => {
  const { samePackageStructure } = await import(
    "../../src/data/package-search.ts"
  );
  const { SearchBudgetError, SearchRequestBudget, searchMetrics } =
    await import("../../../../packages/search/src/index.ts");
  const base = pkg([
    v2Row({ event: "jve1:" + "1".repeat(64) }),
    v2Row({ event: "jve1:" + "2".repeat(64), plain_text: "volume" }),
  ]) as never;
  const equal = structuredClone(base);
  const budget = () => new SearchRequestBudget(searchMetrics());
  assert.equal(samePackageStructure(equal, base, budget()), true);

  // Changed row order.
  const swapped = pkg([
    v2Row({ event: "jve1:" + "2".repeat(64), plain_text: "volume" }),
    v2Row({ event: "jve1:" + "1".repeat(64) }),
  ]);
  assert.equal(samePackageStructure(swapped, base, budget()), false);

  // Changed meaning in last row.
  const edited = structuredClone(base) as { entries: { plain_text: string }[] };
  edited.entries[1].plain_text = "changed";
  assert.equal(samePackageStructure(edited, base, budget()), false);

  // Own extra key on rafsi array (including numeric includes).
  const extraKey = structuredClone(base) as {
    entries: { rafsi: string[] }[];
  };
  Object.assign(extraKey.entries[0].rafsi, { includes: 1 });
  assert.equal(samePackageStructure(extraKey, base, budget()), false);

  // Hole plus extra key keeping the same own-key count.
  const holePlusExtra = structuredClone(base) as {
    entries: { rafsi: unknown[] }[];
  };
  delete holePlusExtra.entries[0].rafsi[0];
  Object.assign(holePlusExtra.entries[0].rafsi, { includes: 1 });
  assert.equal(samePackageStructure(holePlusExtra, base, budget()), false);

  // Exhausted budget refuses before enumerating keys.
  assert.throws(
    () =>
      samePackageStructure(
        equal,
        base,
        new SearchRequestBudget(searchMetrics(), { workLimit: 1 }),
      ),
    SearchBudgetError,
  );
});

test("validateCachedPackage and createPackageWordIndex reject lone-surrogate rafsi and invalid empty-package language keys", () => {
  const loneSurrogate = pkg([v2Row({ rafsi: ["\ud800"] })]);
  assert.throws(
    () => search.validateCachedPackage(loneSurrogate, "en"),
    { message: saved.INVALID_PACKAGE_MESSAGE },
  );

  const empty = pkg([]);
  assert.throws(
    () => saved.savedPackage(empty, "EN"),
    saved.PackageValidationError,
  );
  assert.throws(
    () => search.validateCachedPackage(empty, "EN"),
    { message: saved.INVALID_PACKAGE_MESSAGE },
  );
  assert.equal(
    search.createPackageWordIndex().invalidEntryCount(empty as never, "EN"),
    1,
  );
});

test("samePackageStructure compares own array property values, empty-array own properties, and object prototypes", async () => {
  const { samePackageStructure } = await import(
    "../../src/data/package-search.ts"
  );
  const { SearchRequestBudget, searchMetrics } = await import(
    "../../../../packages/search/src/index.ts"
  );
  const budget = () => new SearchRequestBudget(searchMetrics());

  const nonEmptyOne = pkg([
    v2Row({ rafsi: Object.assign(["cuk"], { tag: "one" }) }),
  ]) as never;
  const nonEmptyTwo = pkg([
    v2Row({ rafsi: Object.assign(["cuk"], { tag: "two" }) }),
  ]);
  assert.equal(samePackageStructure(nonEmptyTwo, nonEmptyOne, budget()), false);

  const emptyWithKey = pkg([
    v2Row({ rafsi: Object.assign([], { tag: "one" }) }),
  ]) as never;
  assert.equal(
    samePackageStructure(structuredClone(emptyWithKey), emptyWithKey, budget()),
    true,
  );

  const baseDates = pkg([
    v2Row({
      attribution: {
        source: "jbovlaste",
        author: "alice",
        account: null,
        dates: {},
      },
    }),
  ]) as never;
  const nullProtoDates = pkg([
    v2Row({
      attribution: {
        source: "jbovlaste",
        author: "alice",
        account: null,
        dates: Object.create(null),
      },
    }),
  ]);
  assert.equal(samePackageStructure(nullProtoDates, baseDates, budget()), true);
  for (const badDates of [
    new Date(0),
    new Map([["created", 123]]),
    new Set(["x"]),
    new ArrayBuffer(8),
  ]) {
    const corrupted = pkg([
      v2Row({
        attribution: {
          source: "jbovlaste",
          author: "alice",
          account: null,
          dates: badDates,
        },
      }),
    ]);
    assert.equal(samePackageStructure(corrupted, baseDates, budget()), false);
  }
});
