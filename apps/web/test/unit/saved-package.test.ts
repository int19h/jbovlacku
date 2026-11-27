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
/** What a page that reads every row checks: the package, then each row in order. */
const readAll = (value: unknown) => {
  const pkg = saved.savedPackage(value);
  if (pkg) {
    saved.requireDenseList(pkg.entries);
    const readRow = saved.savedRowReader(pkg, "en");
    for (const entry of pkg.entries) readRow(entry);
  }
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

test("the rule and the worker agree on every field of a package and its rows", () => {
  // Each case changes one field of a valid package. The shared row reader and
  // the worker use the same shape and order rules, so the only case left to
  // the caller's spelling or word-ID check is an invalid spelling string.
  const workerOnly = new Set(["word.spelling"]);
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
    0,
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

test("a rafsi with a lone surrogate fails in both readers", () => {
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

test("dense lists reject missing indices and extra keys in both readers", () => {
  const gloss = v1Row().glosses[0];
  for (const value of [
    pkg(Object.assign([v2Row()], { entries: 0 })),
    pkg(Object.assign([v2Row()], { "01": 0 })),
    pkg(new Array(0xffffffff)),
    pkg([v2Row({ glosses: [, gloss] })]),
    pkg([v2Row({ rafsi: ["cuk", , "cku"] })]),
    pkg([
      v2Row({ rafsi: Object.assign(new Array(2), { 0: "cuk", foo: true }) }),
    ]),
    pkg([v2Row({ glosses: Object.assign([gloss], { map: false }) })]),
    pkg([v2Row({ rafsi: Object.assign(["cuk"], { includes: 1 }) })]),
    pkg([v2Row({ rafsi: ["cuk", undefined] })]),
    pkg([
      v2Row({
        classification: {
          kind: "gismu",
          selmaho: Object.assign([], { join: 2 }),
        },
      }),
    ]),
    pkg([
      v2Row({
        attribution: { source: "test", author: null, account: null, dates: [] },
      }),
    ]),
  ]) {
    rejects(value);
    assert.equal(workerAccepts(value), false);
  }
});

test("both readers enforce the UTF-8 rafsi boundary", () => {
  const boundary = "é".repeat(64);
  const accepted = pkg([v2Row({ rafsi: [boundary] })]);
  assert.equal(readAll(accepted), accepted);
  assert.equal(workerAccepts(accepted), true);
  const oversized = pkg([v2Row({ rafsi: [boundary + "a"] })]);
  rejects(oversized);
  assert.equal(workerAccepts(oversized), false);
});

test("the worker and wizard inventory count the union by canonical word ID", () => {
  const claims = (start: number, count: number) =>
    Array.from({ length: count }, (_, i) => `r${start + i}`);
  const row = (index: number, spelling: string, rafsi: string[]) =>
    v2Row({
      event: "jve1:" + String(index).repeat(64),
      word: { language: "jbo", spelling },
      rafsi,
    });
  const inventory = (value: ReturnType<typeof pkg>) =>
    builders.inventoryFromPackage({ pkg: value as never, language: "en" });
  const overlap = pkg([
    row(1, "djan", claims(0, 64)),
    row(2, "dján", claims(0, 40)),
  ]);
  assert.equal(workerAccepts(overlap), true);
  assert.equal(inventory(overlap).claims.length, 64);
  for (const value of [
    pkg([row(1, "djan", claims(0, 40)), row(2, "djan", claims(40, 40))]),
    pkg([
      row(1, "djan", claims(0, 64)),
      row(2, "cukta", ["cuk"]),
      row(3, "dján", ["r64"]),
    ]),
  ]) {
    assert.equal(workerAccepts(value), false);
    assert.throws(() => inventory(value), saved.PackageValidationError);
    const index = search.createPackageWordIndex();
    const id = wordId({ language: "jbo", spelling: "djan" });
    assert.equal(index(value as never, "en", id).length, 0);
    assert.equal(index.invalidEntryCount(value as never, "en"), 1);
  }
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

  // Own extra key on rafsi array rejects as an invalid package before comparison.
  const extraKey = structuredClone(base) as {
    entries: { rafsi: string[] }[];
  };
  Object.assign(extraKey.entries[0].rafsi, { includes: 1 });
  assert.throws(
    () => samePackageStructure(extraKey, base, budget()),
    saved.PackageValidationError,
  );

  // Hole plus extra key keeping the same own-key count rejects as invalid.
  const holePlusExtra = structuredClone(base) as {
    entries: { rafsi: unknown[] }[];
  };
  delete holePlusExtra.entries[0].rafsi[0];
  Object.assign(holePlusExtra.entries[0].rafsi, { includes: 1 });
  assert.throws(
    () => samePackageStructure(holePlusExtra, base, budget()),
    saved.PackageValidationError,
  );

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

test("wizard inventory skips a package with invalid attribution source and selects the valid fallback", async () => {
  const english = pkg([
    v2Row({
      event: "jve1:" + "1".repeat(64),
      word: { language: "jbo", spelling: "cukta" },
      glosses: [{ language: "en", text: "bad English source", sense: null }],
      rafsi: ["cku"],
      attribution: { source: [], author: null, account: null, dates: {} },
    }),
    v2Row({
      event: "jve1:" + "2".repeat(64),
      word: { language: "jbo", spelling: "zbasu" },
      rafsi: ["zba"],
    }),
    v2Row({
      event: "jve1:" + "3".repeat(64),
      word: { language: "jbo", spelling: "broda" },
      rafsi: [],
    }),
  ]);
  const french = pkg([
    v2Row({
      event: "jve1:" + "4".repeat(64),
      word: { language: "jbo", spelling: "cukta" },
      language: "fr",
      glosses: [{ language: "fr", text: "valid French source", sense: null }],
      rafsi: ["cku"],
    }),
    v2Row({
      event: "jve1:" + "5".repeat(64),
      word: { language: "jbo", spelling: "zbasu" },
      language: "fr",
      glosses: [{ language: "fr", text: "valid French source", sense: null }],
      rafsi: ["zba"],
    }),
  ]);
  assert.equal(workerAccepts(english), false);
  const read = await builders.savedPackages(
    listStore([
      ["en", english],
      ["fr", french],
    ]),
  );
  const result = builders.savedInventory(read);
  assert.equal(result.invalid, true);
  assert.equal(result.selected?.language, "fr");
  assert.equal(result.inventory.claims.length, 2);
});

test("sparse lists always fail as invalid package before budget charges, and valid dense lists charge content work", async () => {
  const { SearchBudgetError, SearchRequestBudget, searchMetrics } =
    await import("../../../../packages/search/src/index.ts");
  const { searchPackage } = await import("../../src/data/package-search.ts");
  const makeRow = (ordinal: number) =>
    v2Row({
      event: "jve1:" + (ordinal + 1).toString(16).padStart(64, "0"),
      glosses: [],
      plain_text: "",
      rafsi: [],
    });
  const sparseWithProbes = (len: number, make: (i: number) => unknown) => {
    const list: unknown[] = [];
    list.length = len;
    for (const index of [0, len >>> 1, len - 1]) list[index] = make(index);
    return structuredClone(list);
  };

  let posted = 0;
  const previousWorker = (globalThis as Record<string, unknown>).Worker;
  (globalThis as Record<string, unknown>).Worker = class {
    postMessage() {
      posted++;
      throw new Error("Unexpected worker message");
    }
    terminate() {}
  };
  try {
    // Sparse lists whose boundary and midpoint indices are populated must reject
    // as PackageValidationError across client, worker validation, and direct
    // inventory, even when claimed length exceeds the budget.
    const sparseCases: [unknown[], number | undefined][] = [
      [sparseWithProbes(300_000_000, makeRow), undefined],
      [
        [
          {
            ...makeRow(0),
            classification: {
              kind: "gismu",
              selmaho: sparseWithProbes(300_000_000, () => "BAI"),
            },
          },
        ],
        undefined,
      ],
      [sparseWithProbes(5, makeRow), 2],
    ];
    for (const [entries, workLimit] of sparseCases) {
      const value = pkg(entries);
      const budget = new SearchRequestBudget(searchMetrics(), {
        ...(workLimit !== undefined ? { workLimit } : {}),
        deadlineMs: Infinity,
      });
      assert.throws(
        () => search.validateCachedPackage(value, "en", budget),
        saved.PackageValidationError,
      );
      await assert.rejects(
        () =>
          searchPackage(
            value as never,
            "en",
            ["cukta"],
            workLimit !== undefined ? { workLimit } : {},
          ),
        saved.PackageValidationError,
      );
      assert.throws(
        () =>
          builders.inventoryFromPackage({ language: "en", pkg: value as never }),
        saved.PackageValidationError,
      );
    }

    // Valid dense lists pass the shape check and then hit the content budget.
    const denseEntries = Array.from({ length: 100_000 }, (_, i) => makeRow(i));
    const denseSelmahoRow = {
      ...makeRow(0),
      classification: { kind: "gismu", selmaho: Array(100_000).fill("BAI") },
    };
    for (const entries of [denseEntries, [denseSelmahoRow]]) {
      const budget = new SearchRequestBudget(searchMetrics(), {
        workLimit: 1,
        deadlineMs: Infinity,
      });
      assert.throws(
        () => search.validateCachedPackage(pkg(entries), "en", budget),
        SearchBudgetError,
      );
      await assert.rejects(
        () =>
          searchPackage(pkg(entries) as never, "en", ["cukta"], {
            workLimit: 1,
          }),
        SearchBudgetError,
      );
    }

    // Invalid gloss slot and oversized rafsi fail validation before content measurement.
    let reads = 0;
    const wrongGloss = Object.assign([], { sense: null, language: "en" });
    Object.defineProperty(wrongGloss, "text", {
      get() {
        reads++;
        return "b".repeat(10_000);
      },
      enumerable: true,
    });
    const wrongGlossPkg = pkg([{ ...makeRow(0), glosses: [wrongGloss] }]);
    assert.throws(
      () =>
        search.validateCachedPackage(
          wrongGlossPkg,
          "en",
          new SearchRequestBudget(searchMetrics(), {
            workLimit: 20,
            deadlineMs: Infinity,
          }),
        ),
      saved.PackageValidationError,
    );
    assert.equal(reads, 0);
    await assert.rejects(
      () =>
        searchPackage(wrongGlossPkg as never, "en", ["cukta"], {
          workLimit: 20,
        }),
      saved.PackageValidationError,
    );
    assert.equal(reads, 0);

    for (const [rafsi, workLimit] of [
      ["é".repeat(64) + "a", 6],
      ["a".repeat(1280), 10],
    ] as const) {
      const badRafsiPkg = pkg([{ ...makeRow(0), rafsi: [rafsi] }]);
      assert.throws(
        () =>
          search.validateCachedPackage(
            badRafsiPkg,
            "en",
            new SearchRequestBudget(searchMetrics(), {
              workLimit,
              deadlineMs: Infinity,
            }),
          ),
        saved.PackageValidationError,
      );
      await assert.rejects(
        () =>
          searchPackage(badRafsiPkg as never, "en", ["cukta"], { workLimit }),
        saved.PackageValidationError,
      );
    }
    assert.equal(posted, 0);
  } finally {
    if (previousWorker === undefined)
      delete (globalThis as Record<string, unknown>).Worker;
    else (globalThis as Record<string, unknown>).Worker = previousWorker;
  }
});

test("typed reconstruction keeps claims from an over-long alias that shares a word ID with a fitting spelling", async () => {
  const { sourceOptions } = await import("../../src/model/typed-headword.ts");
  const shortSpelling = "bab" + "a".repeat(67);
  const longSpelling = "bab" + "á".repeat(67);
  assert.equal(
    wordId({ language: "jbo", spelling: shortSpelling }),
    wordId({ language: "jbo", spelling: longSpelling }),
  );
  const shortRow = v2Row({
    event: "jve1:" + "1".repeat(64),
    word: { language: "jbo", spelling: shortSpelling },
    rafsi: ["bab"],
  });
  const longRow = v2Row({
    event: "jve1:" + "2".repeat(64),
    word: { language: "jbo", spelling: longSpelling },
    rafsi: ["bax"],
  });
  for (const entries of [
    [shortRow, longRow],
    [
      { ...longRow, event: "jve1:" + "1".repeat(64) },
      { ...shortRow, event: "jve1:" + "2".repeat(64) },
    ],
  ]) {
    const value = pkg(entries) as never;
    for (const rafsi of ["bab", "bax"]) {
      const options = sourceOptions(
        { text: rafsi, kind: "core", join_before: null },
        value,
      );
      assert.equal(options.length, 1);
      assert.equal(options[0].spelling, shortSpelling);
      assert.deepEqual(
        options[0].claims.map((claim) => claim.rafsi).sort(),
        ["bab", "bax"],
      );
      assert.equal(options[0].definitions?.length, 2);
    }
  }
  // Without any fitting alias spelling, the over-long component is dropped.
  const longOnly = pkg([longRow]) as never;
  assert.deepEqual(
    sourceOptions({ text: "bax", kind: "core", join_before: null }, longOnly),
    [],
  );
});

test("batched wordIdSpellings matches wordId across valid and invalid inputs", async () => {
  const { wordIdSpellings } = await import(
    "../../../../packages/core/src/index.ts"
  );
  const samples = [
    "cukta",
    "djan",
    "dján",
    "ba'a",
    "Ba’a",
    "a\"b\\c",
    "水",
    "𠮷",
  ];
  assert.deepEqual(
    wordIdSpellings(samples),
    samples.map((spelling) => wordId({ language: "jbo", spelling })),
  );
  assert.deepEqual(wordIdSpellings([]), []);
  for (const invalid of ["", " cukta", "x\0y", "\ud800", "e\u0301"])
    assert.throws(() => wordIdSpellings(["cukta", invalid]));
});

test("later-row nested list holes and over-cap lists reject before budget across validation and structural reuse", async () => {
  const { samePackageStructure } = await import(
    "../../src/data/package-search.ts"
  );
  const { SearchRequestBudget, searchMetrics } = await import(
    "../../../../packages/search/src/index.ts"
  );
  const { inventoryFromPackage } = await import("../../src/model/builders.ts");
  const budget = (workLimit: number) =>
    new SearchRequestBudget(searchMetrics(), {
      workLimit,
      deadlineMs: Infinity,
    });

  // Case A: valid row 1 exceeds workLimit 20; row 2 has a hole in selmaho.
  const base = pkg([
    v2Row({
      event: "jve1:" + "1".repeat(64),
      plain_text: "x".repeat(4000),
    }),
    v2Row({
      event: "jve1:" + "2".repeat(64),
      classification: { kind: "gismu", selmaho: ["BAI", "BAI"] },
    }),
  ]) as never;
  const holeySelmaho: unknown[] = ["BAI", "BAI"];
  delete holeySelmaho[0];
  const caseA = pkg([
    v2Row({
      event: "jve1:" + "1".repeat(64),
      plain_text: "x".repeat(4000),
    }),
    v2Row({
      event: "jve1:" + "2".repeat(64),
      classification: { kind: "gismu", selmaho: holeySelmaho as string[] },
    }),
  ]);
  assert.throws(
    () => search.validateCachedPackage(caseA, "en", budget(20)),
    saved.PackageValidationError,
  );
  assert.throws(
    () => inventoryFromPackage({ language: "en", pkg: caseA as never }),
    saved.PackageValidationError,
  );
  assert.throws(
    () => samePackageStructure(caseA, base, budget(20)),
    saved.PackageValidationError,
  );

  // Over-cap nested lists with a hole at the end reject immediately without a key scan.
  const overCapGlosses = Array.from({ length: 100_000 }, () => ({
    language: "en",
    text: "book",
    sense: null,
  }));
  delete overCapGlosses[99_999];
  const overCapRafsi = Array.from({ length: 100_000 }, () => "cku");
  delete overCapRafsi[99_999];
  const watched = new WeakSet<object>([overCapGlosses, overCapRafsi]);
  let scannedOverCap = 0;
  const originalOwnKeys = Reflect.ownKeys;
  Reflect.ownKeys = ((target: object) => {
    if (watched.has(target)) scannedOverCap++;
    return originalOwnKeys(target);
  }) as typeof Reflect.ownKeys;
  try {
    const overGlossPkg = pkg([
      v2Row({
        event: "jve1:" + "1".repeat(64),
        plain_text: "x".repeat(4000),
      }),
      v2Row({
        event: "jve1:" + "2".repeat(64),
        glosses: overCapGlosses as never,
      }),
    ]);
    const overRafsiPkg = pkg([
      v2Row({
        event: "jve1:" + "1".repeat(64),
        plain_text: "x".repeat(4000),
      }),
      v2Row({
        event: "jve1:" + "2".repeat(64),
        rafsi: overCapRafsi as never,
      }),
    ]);
    for (const candidate of [overGlossPkg, overRafsiPkg]) {
      assert.throws(
        () => search.validateCachedPackage(candidate, "en", budget(20)),
        saved.PackageValidationError,
      );
      assert.throws(
        () => samePackageStructure(candidate, base, budget(20)),
        saved.PackageValidationError,
      );
      assert.throws(
        () => inventoryFromPackage({ language: "en", pkg: candidate as never }),
        saved.PackageValidationError,
      );
    }
    assert.equal(scannedOverCap, 0);
  } finally {
    Reflect.ownKeys = originalOwnKeys;
  }
});

test("savedRafsiClaims and savedSpellingChecks do not hide invalid rows behind a small budget", async () => {
  const { SearchRequestBudget, searchMetrics } = await import(
    "../../../../packages/search/src/index.ts"
  );
  const { wordSpellingStatus } = await import(
    "../../../../packages/core/src/index.ts"
  );
  const budget = (workLimit: number) =>
    new SearchRequestBudget(searchMetrics(), {
      workLimit,
      deadlineMs: Infinity,
    });
  const claims = (start: number, count: number) =>
    Array.from({ length: count }, (_, i) => `r${start + i}`);
  const rowAt = (n: number, extra: Record<string, unknown>) =>
    v2Row({
      event: "jve1:" + (n + 1).toString(16).padStart(64, "0"),
      word: { language: "jbo", spelling: "cukta" },
      glosses: [],
      plain_text: "",
      rafsi: [],
      ...extra,
    });

  // Finding B: 5,002 rows all spelled cukta, union overflows on row 2.
  const repeatedUnion = pkg([
    rowAt(0, { rafsi: claims(0, 40) }),
    rowAt(1, { rafsi: claims(40, 40) }),
    ...Array.from({ length: 5000 }, (_, i) => rowAt(i + 2, { rafsi: ["cku"] })),
  ]);
  assert.throws(
    () => search.validateCachedPackage(repeatedUnion, "en", budget(20_000)),
    saved.PackageValidationError,
  );

  // Same class: overflowing union on rows 1-2 followed by 5,000 empty-rafsi rows.
  const unionThenEmpty = pkg([
    rowAt(0, { rafsi: claims(0, 40) }),
    rowAt(1, { rafsi: claims(40, 40) }),
    ...Array.from({ length: 5000 }, (_, i) => rowAt(i + 2, { rafsi: [] })),
  ]);
  assert.throws(
    () => search.validateCachedPackage(unionThenEmpty, "en", budget(20_000)),
    saved.PackageValidationError,
  );

  // Same class: buffered invalid fallback spelling on row 1 before huge row 2.
  assert.equal(wordSpellingStatus("e\u0301"), "check");
  const deferredFallbackSpelling = pkg([
    rowAt(0, { word: { language: "jbo", spelling: "e\u0301" }, rafsi: [] }),
    rowAt(1, { plain_text: "x".repeat(4000), rafsi: [] }),
  ]);
  assert.throws(
    () => search.validateCachedPackage(deferredFallbackSpelling, "en", budget(20)),
    saved.PackageValidationError,
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

test("samePackageStructure rejects extra array keys, compares own array values, rejects non-plain attribution.dates, and accepts null-prototype plain objects", async () => {
  const { samePackageStructure } = await import(
    "../../src/data/package-search.ts"
  );
  const { SearchRequestBudget, searchMetrics } = await import(
    "../../../../packages/search/src/index.ts"
  );
  const budget = () => new SearchRequestBudget(searchMetrics());

  // List-shape rules reject extra own properties on stored package lists.
  const nonEmptyOne = pkg([
    v2Row({ rafsi: Object.assign(["cuk"], { tag: "one" }) }),
  ]) as never;
  const nonEmptyTwo = pkg([
    v2Row({ rafsi: Object.assign(["cuk"], { tag: "two" }) }),
  ]);
  assert.throws(
    () => samePackageStructure(nonEmptyTwo, nonEmptyOne, budget()),
    saved.PackageValidationError,
  );
  const emptyWithKey = pkg([
    v2Row({ rafsi: Object.assign([], { tag: "one" }) }),
  ]) as never;
  assert.throws(
    () =>
      samePackageStructure(structuredClone(emptyWithKey), emptyWithKey, budget()),
    saved.PackageValidationError,
  );

  // Structural equality itself compares non-index own array property values
  // and accepts identical clones of empty arrays carrying own properties.
  const nonEmptyAuxOne = {
    ...pkg([v2Row()]),
    downgrade: Object.assign(["a"], { tag: "one" }),
  } as never;
  const nonEmptyAuxTwo = {
    ...pkg([v2Row()]),
    downgrade: Object.assign(["a"], { tag: "two" }),
  };
  assert.equal(
    samePackageStructure(nonEmptyAuxTwo, nonEmptyAuxOne, budget()),
    false,
  );
  const emptyAux = {
    ...pkg([v2Row()]),
    downgrade: Object.assign([], { tag: "one" }),
  } as never;
  assert.equal(
    samePackageStructure(structuredClone(emptyAux), emptyAux, budget()),
    true,
  );

  const base = pkg([
    v2Row({
      attribution: {
        source: "jbovlaste",
        author: "alice",
        account: null,
        dates: {},
      },
    }),
  ]) as never;

  const nullProtoDates = Object.create(null);
  const plainNull = pkg([
    v2Row({
      attribution: {
        source: "jbovlaste",
        author: "alice",
        account: null,
        dates: nullProtoDates,
      },
    }),
  ]);
  assert.equal(samePackageStructure(plainNull, base, budget()), false);
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
    assert.equal(samePackageStructure(corrupted, base, budget()), false);
  }
});

test("requireSavedRowLists meters uncapped classification.selmaho reads under a small budget", async () => {
  const { SearchBudgetError, SearchRequestBudget, searchMetrics } =
    await import("../../../../packages/search/src/index.ts");
  const rawSelmaho = Array(200_000).fill("BAI");
  let reads = 0;
  const proxied = new Proxy(rawSelmaho, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && /^\d+$/.test(prop)) reads++;
      return Reflect.get(target, prop, receiver);
    },
  });
  const big = pkg([
    v2Row({
      classification: { kind: "gismu", selmaho: proxied as string[] },
    }),
  ]);
  assert.throws(
    () =>
      search.validateCachedPackage(
        big,
        "en",
        new SearchRequestBudget(searchMetrics(), {
          workLimit: 1,
          deadlineMs: Infinity,
        }),
      ),
    SearchBudgetError,
  );
  assert.equal(reads, 64);
});

test("selectLujvoSource and signedComponent enforce builder component limits", async () => {
  const typedHeadword = await import("../../src/model/typed-headword.ts");
  const draftMod = await import("../../src/model/draft.ts");

  // Manual source over 128 bytes is rejected without mutating the component row.
  const draft = draftMod.newDraft({
    language: "en",
    spelling: "ckugerku",
    typedSpelling: "ckugerku",
    kind: "lujvo",
  });
  const state = typedHeadword.prepareLujvoBuilder(draft, null);
  const before = structuredClone(state.components[0]);
  assert.equal(
    typedHeadword.selectLujvoSource(state, 0, "cukta".repeat(26)),
    false,
  );
  assert.deepEqual(state.components[0], before);
  assert.equal(saved.fitsSavedComponent(state.components[0]), true);

  // A retained signed compound source over 128 bytes becomes an unresolved source.
  const longSpelling = "cukta".repeat(26);
  const signedDraft = draftMod.newDraft({
    language: "en",
    spelling: "ckugerku",
    typedSpelling: "ckugerku",
    kind: "lujvo",
  });
  signedDraft.compound = {
    morphology: {
      id: "https://github.com/int19h/jbovlacku/blob/main/docs/morphology.md#extended-lujvo",
      version: "4",
    },
    scoring: {
      id: "https://github.com/int19h/jbovlacku/blob/main/docs/morphology.md#extended-lujvo-scoring",
      version: "1",
    },
    score: null,
    notes: [],
    components: [
      {
        word: { language: "jbo", spelling: longSpelling },
        rafsi: "cku",
        definition: null,
      },
      {
        word: { language: "jbo", spelling: "gerku" },
        rafsi: "gerku",
        definition: null,
      },
    ],
  };
  signedDraft.evidenceForm = "ckugerku";
  const hydrated = typedHeadword.prepareLujvoBuilder(signedDraft, null);
  assert.equal(hydrated.components[0].spelling, "");
  assert.equal(hydrated.components[0].locked, "cku");
  assert.ok(hydrated.components[0].unresolvedSource);
  assert.equal(saved.fitsSavedComponent(hydrated.components[0]), true);
  assert.equal(hydrated.components[1].spelling, "gerku");
});

test("samePackageStructure rejects non-plain objects with the same prototype (Date and Map)", async () => {
  const { samePackageStructure } = await import(
    "../../src/data/package-search.ts"
  );
  const { SearchRequestBudget, searchMetrics } = await import(
    "../../../../packages/search/src/index.ts"
  );
  const budget = () => new SearchRequestBudget(searchMetrics());

  const dateA = pkg([
    v2Row({
      attribution: {
        source: "jbovlaste",
        author: "alice",
        account: null,
        dates: new Date(0),
      },
    }),
  ]) as never;
  const dateB = pkg([
    v2Row({
      attribution: {
        source: "jbovlaste",
        author: "alice",
        account: null,
        dates: new Date(86_400_000),
      },
    }),
  ]);
  assert.equal(samePackageStructure(dateB, dateA, budget()), false);
  assert.equal(
    samePackageStructure(structuredClone(dateA), dateA, budget()),
    false,
  );

  const mapA = pkg([
    v2Row({
      attribution: {
        source: "jbovlaste",
        author: "alice",
        account: null,
        dates: new Map([["created", "2020-01-01"]]),
      },
    }),
  ]) as never;
  const mapB = pkg([
    v2Row({
      attribution: {
        source: "jbovlaste",
        author: "alice",
        account: null,
        dates: new Map([["created", "2099-12-31"]]),
      },
    }),
  ]);
  assert.equal(samePackageStructure(mapB, mapA, budget()), false);
  assert.equal(
    samePackageStructure(structuredClone(mapA), mapA, budget()),
    false,
  );
});

test("samePackageStructure rejects cyclic own array properties and cyclic objects without stack overflow", async () => {
  const { samePackageStructure } = await import(
    "../../src/data/package-search.ts"
  );
  const { SearchRequestBudget, searchMetrics } = await import(
    "../../../../packages/search/src/index.ts"
  );
  const budget = () => new SearchRequestBudget(searchMetrics());

  // On stored package lists, the dense-list check rejects the extra own key up front.
  const cyclicRafsi = ["cuk"];
  Object.assign(cyclicRafsi, { self: cyclicRafsi });
  const cyclicRafsiPkg = pkg([v2Row({ rafsi: cyclicRafsi })]) as never;
  assert.throws(
    () =>
      samePackageStructure(
        structuredClone(cyclicRafsiPkg),
        structuredClone(cyclicRafsiPkg),
        budget(),
      ),
    saved.PackageValidationError,
  );

  // Structural equality itself returns false on cyclic own array properties without stack overflow.
  const cyclicAux = ["a"];
  Object.assign(cyclicAux, { self: cyclicAux });
  const cyclicAuxPkg = {
    ...pkg([v2Row()]),
    downgrade: cyclicAux,
  } as never;
  assert.equal(
    samePackageStructure(
      structuredClone(cyclicAuxPkg),
      structuredClone(cyclicAuxPkg),
      budget(),
    ),
    false,
  );

  const cyclicDates: Record<string, unknown> = {};
  cyclicDates.self = cyclicDates;
  const cyclicObjPkg = pkg([
    v2Row({
      attribution: {
        source: "jbovlaste",
        author: "alice",
        account: null,
        dates: cyclicDates,
      },
    }),
  ]) as never;
  assert.equal(
    samePackageStructure(
      structuredClone(cyclicObjPkg),
      structuredClone(cyclicObjPkg),
      budget(),
    ),
    false,
  );
});

test("validateEntry and validateCachedPackage reject an empty array carrying version 2 row fields and search_status", () => {
  const view = "jve1:" + "9".repeat(64);
  const perRowArray = Object.assign([], v2Row(), {
    search_status: { view, status: "active" },
  });
  assert.throws(
    () => search.validateEntry(perRowArray, "en", 2),
    { message: saved.INVALID_PACKAGE_MESSAGE },
  );
  assert.throws(
    () => search.validateCachedPackage(pkg([perRowArray]), "en"),
    { message: saved.INVALID_PACKAGE_MESSAGE },
  );

  const compactArray = Object.assign([], v2Row(), {
    search_status: "active",
  });
  assert.throws(
    () => search.validateEntry(compactArray, "en", 2, view),
    { message: saved.INVALID_PACKAGE_MESSAGE },
  );
  assert.throws(
    () =>
      search.validateCachedPackage(
        {
          version: 2,
          snapshot: "sha256:" + "a".repeat(64),
          search_view: view,
          entries: [compactArray],
        },
        "en",
      ),
    { message: saved.INVALID_PACKAGE_MESSAGE },
  );
});

test("searchPackage does not scan unrelated queued transfers during lookup or cleanup", async () => {
  const pkgSearchUrl = new URL(
    "../../src/data/package-search.ts",
    import.meta.url,
  );
  pkgSearchUrl.search = "?queued-transfers-test";
  const { searchPackage } = (await import(pkgSearchUrl.href)) as typeof import(
    "../../src/data/package-search.ts"
  );
  const prevWorker = globalThis.Worker;
  const prevLocation = (globalThis as { location?: unknown }).location;
  const queue: Array<{ request: number; key: number }> = [];
  let workerInstance:
    | { onmessage?: (event: { data: unknown }) => void; terminate(): void }
    | undefined;
  Object.assign(globalThis, {
    location: new URL("http://127.0.0.1:9970/"),
    Worker: class {
      onmessage?: (event: { data: unknown }) => void;
      constructor() {
        workerInstance = this;
      }
      postMessage(message: { request: number; key: number }) {
        queue.push(message);
      }
      terminate() {}
    },
  });
  const nativeIter = Map.prototype[Symbol.iterator];
  const nativeKeys = Map.prototype.keys;
  const isSnapshotMap = (map: Map<unknown, unknown>) => {
    const first = map.values().next().value as Record<string, unknown> | undefined;
    return !!first && typeof first === "object" && "pkg" in first && "language" in first;
  };
  let finalRequestCandidates = 0;
  let allAckPruned = 0;
  let firstAckPruned = -1;
  try {
    const requests: Promise<unknown>[] = [];
    const run = (index: number) =>
      searchPackage(
        { snapshot: "sha256:" + "a".repeat(64), entries: [] },
        `en-x-q${index}`,
        [],
        { workLimit: 0 },
      );
    for (let i = 0; i < 32; i++) requests.push(run(i));
    Map.prototype[Symbol.iterator] = function* (this: Map<unknown, unknown>) {
      const count = isSnapshotMap(this);
      for (const entry of nativeIter.call(this)) {
        if (count) finalRequestCandidates++;
        yield entry;
      }
    } as unknown as typeof nativeIter;
    try {
      requests.push(run(32));
    } finally {
      Map.prototype[Symbol.iterator] = nativeIter;
    }
    Map.prototype.keys = function* (this: Map<unknown, unknown>) {
      const count = isSnapshotMap(this);
      for (const key of nativeKeys.call(this)) {
        if (count) allAckPruned++;
        yield key;
      }
    } as unknown as typeof nativeKeys;
    try {
      const retained: number[] = [];
      for (const [i, msg] of queue.entries()) {
        retained.push(msg.key);
        if (retained.length > 2) retained.shift();
        workerInstance!.onmessage?.({
          data: {
            request: msg.request,
            retained: [...retained],
            cacheRevision: i + 1,
            result: { metrics: {}, prepared: true, hits: [], totals: [] },
          },
        });
        if (i === 0) firstAckPruned = allAckPruned;
      }
    } finally {
      Map.prototype.keys = nativeKeys;
    }
    await Promise.all(requests);
    assert.equal(finalRequestCandidates, 0);
    assert.equal(firstAckPruned, 0);
    assert.equal(allAckPruned, 0);
  } finally {
    Map.prototype[Symbol.iterator] = nativeIter;
    Map.prototype.keys = nativeKeys;
    if (prevWorker === undefined) delete (globalThis as { Worker?: unknown }).Worker;
    else globalThis.Worker = prevWorker;
    if (prevLocation === undefined)
      delete (globalThis as { location?: unknown }).location;
    else Object.assign(globalThis, { location: prevLocation });
  }
});

test("samePackageStructure accepts shared records and shared arrays at default budget and charges per reference", async () => {
  const { samePackageStructure } = await import(
    "../../src/data/package-search.ts"
  );
  const { SearchBudgetError, SearchRequestBudget, searchMetrics } = await import(
    "../../../../packages/search/src/index.ts"
  );
  const n = 128;
  for (const kind of ["dates", "selmaho"] as const) {
    const sharedDates = Object.fromEntries(
      Array.from({ length: n }, (_, i) => [
        "k" + i.toString(16).padStart(8, "0"),
        "1",
      ]),
    );
    const sharedSelmaho = Array.from({ length: n }, () => "UI");
    const base = pkg(
      Array.from({ length: n }, (_, i) =>
        v2Row({
          event: "jve1:" + (i + 1).toString(16).padStart(64, "0"),
          glosses: [],
          rafsi: [],
          classification: {
            kind: "gismu",
            selmaho: kind === "selmaho" ? sharedSelmaho : [],
          },
          attribution: {
            source: "fixture",
            author: null,
            account: null,
            dates: kind === "dates" ? sharedDates : {},
          },
        }),
      ),
    ) as never;
    const copy = structuredClone(base);
    assert.equal(
      samePackageStructure(copy, base, new SearchRequestBudget(searchMetrics())),
      true,
    );
    assert.throws(
      () =>
        samePackageStructure(
          copy,
          base,
          new SearchRequestBudget(searchMetrics(), {
            workLimit: 10_000,
            deadlineMs: Infinity,
          }),
        ),
      (err: unknown) =>
        err instanceof SearchBudgetError && err.phase === "prepare",
    );
  }
});

test("createPackageWordIndex checks a shared selmaho list once across rows without mixing field caches", () => {
  const n = 128;
  const rawSelmaho = Array.from({ length: n }, () => "UI");
  let reads = 0;
  const proxied = new Proxy(rawSelmaho, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && /^\d+$/.test(prop)) reads++;
      return Reflect.get(target, prop, receiver);
    },
  });
  const sharedPkg = pkg(
    Array.from({ length: n }, (_, i) =>
      v2Row({
        event: "jve1:" + (i + 1).toString(16).padStart(64, "0"),
        glosses: [],
        rafsi: [],
        classification: { kind: "gismu", selmaho: proxied as string[] },
      }),
    ),
  );
  const index = search.createPackageWordIndex();
  assert.equal(index.invalidEntryCount(sharedPkg as never, "en"), 0);
  assert.equal(reads, n);

  // Sharing one array across selmaho (allows lone surrogates) and rafsi
  // (rejects lone surrogates) must still reject the package.
  const crossField = ["\ud800", "a", "b", "c"];
  const mixed = pkg([
    v2Row({
      event: "jve1:" + "1".repeat(64),
      classification: { kind: "gismu", selmaho: crossField },
      rafsi: [],
    }),
    v2Row({
      event: "jve1:" + "2".repeat(64),
      classification: { kind: "gismu", selmaho: [] },
      rafsi: crossField,
    }),
  ]);
  assert.equal(
    search.createPackageWordIndex().invalidEntryCount(mixed as never, "en"),
    1,
  );
});

test("requirePackageListShapes and savedRowReader check shared selmaho arrays and attribution dates once across rows", () => {
  const n = 128;
  const sharedSelmaho = Array.from({ length: n }, () => "UI");
  const rawDates = Object.fromEntries(
    Array.from({ length: n }, (_, i) => [
      "k" + i.toString(16).padStart(8, "0"),
      "1",
    ]),
  );
  let dateReads = 0;
  const proxiedDates = new Proxy(rawDates, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && prop.startsWith("k")) dateReads++;
      return Reflect.get(target, prop, receiver);
    },
  });
  let selmahoReads = 0;
  const proxiedSelmaho = new Proxy(sharedSelmaho, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && /^\d+$/.test(prop)) selmahoReads++;
      return Reflect.get(target, prop, receiver);
    },
  });
  const sharedPkg = pkg(
    Array.from({ length: n }, (_, i) =>
      v2Row({
        event: "jve1:" + (i + 1).toString(16).padStart(64, "0"),
        glosses: [],
        rafsi: [],
        classification: { kind: "gismu", selmaho: proxiedSelmaho as string[] },
        attribution: {
          source: "fixture",
          author: null,
          account: null,
          dates: proxiedDates as Record<string, string>,
        },
      }),
    ),
  );

  let ownKeysCalls = 0;
  const nativeOwnKeys = Reflect.ownKeys;
  Reflect.ownKeys = function (target: object) {
    if (target === proxiedSelmaho) ownKeysCalls++;
    return nativeOwnKeys(target);
  };
  try {
    saved.requirePackageListShapes(sharedPkg);
  } finally {
    Reflect.ownKeys = nativeOwnKeys;
  }
  assert.equal(ownKeysCalls, 1);

  const readRow = saved.savedRowReader(sharedPkg as never, "en", undefined, true);
  for (const row of sharedPkg.entries) readRow(row);
  assert.equal(selmahoReads, n);
  assert.equal(dateReads, n);
});

test("requirePackageListShapes and savedRowReader allocate no cache Sets on ordinary unshared rows", () => {
  const unshared = pkg(
    Array.from({ length: 64 }, (_, i) =>
      v2Row({
        event: "jve1:" + (i + 1).toString(16).padStart(64, "0"),
        glosses: [{ language: "en", text: "book", sense: null }],
        rafsi: ["cuk"],
        classification: { kind: "gismu", selmaho: ["UI"] },
        attribution: {
          source: "fixture",
          author: null,
          account: null,
          dates: { created: "2020-01-01" },
        },
      }),
    ),
  );
  const NativeSet = globalThis.Set;
  let setConstructs = 0;
  globalThis.Set = class CountingSet<T> extends NativeSet<T> {
    constructor(values?: readonly T[] | Iterable<T> | null) {
      super(values as any);
      setConstructs++;
    }
  } as unknown as SetConstructor;
  try {
    saved.requirePackageListShapes(unshared);
    const readRow = saved.savedRowReader(unshared as never, "en", undefined, true);
    for (const row of unshared.entries) readRow(row);
    const cache = saved.savedRowListCache();
    for (const row of unshared.entries)
      saved.requireSavedRowLists(row, undefined, true, cache);
    assert.deepEqual(cache, {});
  } finally {
    globalThis.Set = NativeSet;
  }
  assert.equal(setConstructs, 0);
});

test("samePackageStructure accepts equal-content squares 8, 16, and 32 at default budget, refuses tight limits, and caps deep DAGs", async () => {
  const { samePackageStructure } = await import(
    "../../src/data/package-search.ts"
  );
  const { SearchBudgetError, SearchRequestBudget, searchMetrics } = await import(
    "../../../../packages/search/src/index.ts"
  );

  for (const kind of ["dates", "selmaho"] as const) {
    for (const k of [8, 16, 32]) {
      const make = (byColumn: boolean) => {
        const shared = Array.from({ length: k }, () =>
          kind === "dates"
            ? Object.fromEntries(
                Array.from({ length: 4 * k }, (_, j) => [
                  "k" + j.toString(16).padStart(8, "0"),
                  "1",
                ]),
              )
            : Array.from({ length: 4 * k }, () => "UI"),
        );
        return pkg(
          Array.from({ length: k * k }, (_, i) => {
            const value = shared[byColumn ? i % k : Math.floor(i / k)];
            return v2Row({
              event: "jve1:" + (i + 1).toString(16).padStart(64, "0"),
              glosses: [],
              rafsi: [],
              classification: {
                kind: "gismu",
                selmaho: kind === "selmaho" ? (value as string[]) : [],
              },
              attribution: {
                source: "fixture",
                author: null,
                account: null,
                dates:
                  kind === "dates"
                    ? (value as Record<string, string>)
                    : {},
              },
            });
          }),
        );
      };
      const byRow = make(false) as never;
      const byColumn = make(true);
      const defaultBudget = new SearchRequestBudget(searchMetrics());
      assert.equal(
        samePackageStructure(byColumn, byRow, defaultBudget),
        true,
      );
      const spent = defaultBudget.snapshot().spent;
      assert.throws(
        () =>
          samePackageStructure(
            byColumn,
            byRow,
            new SearchRequestBudget(searchMetrics(), {
              workLimit: spent - 1,
              deadlineMs: Infinity,
            }),
          ),
        (err: unknown) =>
          err instanceof SearchBudgetError && err.phase === "prepare",
      );
      if (k === 32) {
        assert.throws(
          () =>
            samePackageStructure(
              byColumn,
              byRow,
              new SearchRequestBudget(searchMetrics(), {
                workLimit: 75 * k * k,
                deadlineMs: Infinity,
              }),
            ),
          (err: unknown) =>
            err instanceof SearchBudgetError && err.phase === "prepare",
        );
      }
    }
  }

  // Deep DAG of small 2-key objects stops within the per-row cap
  // without exponential blowup.
  let leafA: Record<string, unknown> = { a: "x", b: "y" };
  let leafB: Record<string, unknown> = { a: "x", b: "y" };
  for (let d = 0; d < 20; d++) {
    leafA = { a: leafA, b: leafA };
    leafB = { a: leafB, b: leafB };
  }
  const dagBudget = new SearchRequestBudget(searchMetrics(), {
    workLimit: 5_000,
    deadlineMs: Infinity,
  });
  assert.equal(
    samePackageStructure(
      pkg([
        v2Row({
          attribution: {
            source: "fixture",
            author: null,
            account: null,
            dates: leafA as any,
          },
        }),
      ]),
      pkg([
        v2Row({
          attribution: {
            source: "fixture",
            author: null,
            account: null,
            dates: leafB as any,
          },
        }),
      ]) as never,
      dagBudget,
    ),
    false,
  );
  assert.ok(dagBudget.snapshot().spent <= 250);
  // Equal content shared across different depths counts as equal within the cap.
  const bigA = Object.fromEntries(
    Array.from({ length: 32 }, (_, i) => [`k${i}`, "1"]),
  );
  const bigB1 = Object.fromEntries(
    Array.from({ length: 32 }, (_, i) => [`k${i}`, "1"]),
  );
  const bigB2 = Object.fromEntries(
    Array.from({ length: 32 }, (_, i) => [`k${i}`, "1"]),
  );
  assert.equal(
    samePackageStructure(
      pkg([
        v2Row({
          event: "jve1:" + "1".repeat(64),
          attribution: {
            source: "fixture",
            author: null,
            account: null,
            dates: bigA,
          },
        }),
        v2Row({
          event: "jve1:" + "2".repeat(64),
          attribution: {
            source: "fixture",
            author: null,
            account: null,
            dates: { nested: bigA } as any,
          },
        }),
      ]),
      pkg([
        v2Row({
          event: "jve1:" + "1".repeat(64),
          attribution: {
            source: "fixture",
            author: null,
            account: null,
            dates: bigB1,
          },
        }),
        v2Row({
          event: "jve1:" + "2".repeat(64),
          attribution: {
            source: "fixture",
            author: null,
            account: null,
            dates: { nested: bigB2 } as any,
          },
        }),
      ]) as never,
      new SearchRequestBudget(searchMetrics(), {
        workLimit: 5_000,
        deadlineMs: Infinity,
      }),
    ),
    true,
  );
});

test("samePackageStructure treats equal content with different sharing as equal and caps four-depth graphs", async () => {
  const { samePackageStructure } = await import(
    "../../src/data/package-search.ts"
  );
  const { SearchRequestBudget, searchMetrics } = await import(
    "../../../../packages/search/src/index.ts"
  );
  const fields = (n: number) =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, "x"]));
  const makeRow = (i: number) =>
    v2Row({
      event: "jve1:" + (i + 1).toString(16).padStart(64, "0"),
      glosses: [],
      rafsi: [],
      classification: { kind: "gismu", selmaho: [] },
      attribution: { source: "fixture", author: null, account: null, dates: {} },
    });

  // Equal content with different sharing across all field shapes must be equal.
  for (const [field, n] of [
    ["word", 0],
    ["selmaho", 23],
    ["dates", 24],
    ["text", 127],
    ["cross", 23],
  ] as const) {
    const build = (shared: boolean) => {
      const a = makeRow(0);
      const b = makeRow(1);
      const make = () =>
        field === "word"
          ? { language: "jbo" as const, spelling: "cukta" }
          : field === "dates"
            ? fields(n)
            : field === "text"
              ? { day: "x".repeat(64 * n) }
              : Array.from({ length: n }, () => "cuk");
      const v = make();
      const w = shared ? v : make();
      if (field === "word") {
        a.word = v as any;
        b.word = w as any;
      } else if (field === "dates" || field === "text") {
        (a as any).attribution.dates = v;
        (b as any).attribution.dates = w;
      } else if (field === "cross") {
        a.classification.selmaho = v as any;
        a.rafsi = w as any;
      } else {
        a.classification.selmaho = v as any;
        b.classification.selmaho = w as any;
      }
      return pkg([a, b]);
    };
    const joined = build(true);
    const split = build(false);
    assert.equal(
      samePackageStructure(
        split,
        joined as never,
        new SearchRequestBudget(searchMetrics()),
      ),
      true,
      `split vs joined failed for ${field}:${n}`,
    );
    assert.equal(
      samePackageStructure(
        joined,
        split as never,
        new SearchRequestBudget(searchMetrics()),
      ),
      true,
      `joined vs split failed for ${field}:${n}`,
    );
  }

  // Four-depth amplification graph wrapped in a package row exercises the
  // per-row step cap and declines reuse instead of spending 123,918 units.
  const leaf = fields(14);
  const small = Object.fromEntries(
    Array.from({ length: 8 }, (_, i) => [`s${i}`, leaf]),
  );
  const wide = Array.from({ length: 256 }, () => small);
  const root: Record<string, unknown> = {};
  for (let d = 0; d < 4; d++) {
    let obj: unknown = wide;
    for (let j = 0; j < d; j++) obj = { v: obj };
    root[`d${d}`] = obj;
  }
  const foldedPkg = pkg([
    v2Row({
      attribution: {
        source: "fixture",
        author: null,
        account: null,
        dates: root as any,
      },
    }),
  ]);
  const rowBudget = new SearchRequestBudget(searchMetrics(), {
    workLimit: 82_688,
    deadlineMs: Infinity,
  });
  assert.equal(
    samePackageStructure(structuredClone(foldedPkg), foldedPkg as never, rowBudget),
    false,
  );
  assert.ok(
    rowBudget.snapshot().spent <= 20,
    `expected per-row cap stop <= 20 units, spent ${rowBudget.snapshot().spent}`,
  );

  // A direct non-package root without entries is rejected up front by
  // requirePackageListShapes before spending any budget.
  const directBudget = new SearchRequestBudget(searchMetrics(), {
    workLimit: 82_688,
    deadlineMs: Infinity,
  });
  assert.throws(
    () =>
      samePackageStructure(structuredClone(root), root as never, directBudget),
    saved.PackageValidationError,
  );
  assert.equal(directBudget.snapshot().spent, 0);
});

test("requireSavedRowLists skips Object.getOwnPropertySymbols on cached attribution dates", () => {
  const n = 128;
  const rawDates = Object.fromEntries(
    Array.from({ length: n }, (_, i) => [
      "k" + i.toString(16).padStart(8, "0"),
      "1",
    ]),
  );
  let ownKeysCalls = 0;
  const proxiedDates = new Proxy(rawDates, {
    ownKeys(target) {
      ownKeysCalls++;
      return Reflect.ownKeys(target);
    },
  });
  const sharedPkg = pkg(
    Array.from({ length: n }, (_, i) =>
      v2Row({
        event: "jve1:" + (i + 1).toString(16).padStart(64, "0"),
        glosses: [],
        rafsi: [],
        classification: { kind: "gismu", selmaho: [] },
        attribution: {
          source: "fixture",
          author: null,
          account: null,
          dates: proxiedDates as Record<string, string>,
        },
      }),
    ),
  );
  const readRow = saved.savedRowReader(sharedPkg as never, "en", undefined, true);
  for (const row of sharedPkg.entries) readRow(row);
  // Row 0 runs getOwnPropertySymbols and for..in (2 ownKeys calls); rows 1..127
  // hit checked.dates and skip both checks.
  assert.ok(
    ownKeysCalls <= 2,
    `expected <= 2 ownKeys calls on cached dates, got ${ownKeysCalls}`,
  );
});

test("samePackageStructure requires exact container prototypes and accepts unmodified shared-collection clones", async () => {
  const { samePackageStructure } = await import(
    "../../src/data/package-search.ts"
  );
  const { SearchRequestBudget, searchMetrics } = await import(
    "../../../../packages/search/src/index.ts"
  );
  const budget = () => new SearchRequestBudget(searchMetrics());

  // Mismatched null vs Object.prototype, altered array prototypes, and
  // self-identical non-plain roots must all compare as not equal.
  const base = pkg([v2Row({ rafsi: ["cuk"] })]) as never;
  const rootNull = Object.assign(Object.create(null), pkg([v2Row({ rafsi: ["cuk"] })]));
  const rowNull = pkg([Object.assign(Object.create(null), v2Row({ rafsi: ["cuk"] }))]);
  const wordNull = pkg([
    v2Row({
      rafsi: ["cuk"],
      word: Object.assign(Object.create(null), {
        language: "jbo",
        spelling: "cukta",
      }),
    }),
  ]);
  const nullProtoArr = pkg([
    v2Row({ rafsi: Object.setPrototypeOf(["cuk"], null) }),
  ]);
  class SubArray extends Array {}
  const subArr = pkg([v2Row({ rafsi: SubArray.from(["cuk"]) })]);
  const dateRoot = Object.assign(new Date(), pkg([v2Row({ rafsi: ["cuk"] })]));
  assert.equal(samePackageStructure(rootNull, base, budget()), false);
  assert.equal(samePackageStructure(rowNull, base, budget()), false);
  assert.equal(samePackageStructure(wordNull, base, budget()), false);
  assert.equal(samePackageStructure(nullProtoArr, base, budget()), false);
  assert.equal(samePackageStructure(subArr, base, budget()), false);
  assert.equal(samePackageStructure(dateRoot, dateRoot as never, budget()), false);

  // Two null-prototype records on both sides still match.
  const nullDatesA = pkg([
    v2Row({
      attribution: {
        source: "jbovlaste",
        author: "alice",
        account: null,
        dates: Object.assign(Object.create(null), { created: "2020" }),
      },
    }),
  ]);
  const nullDatesB = pkg([
    v2Row({
      attribution: {
        source: "jbovlaste",
        author: "alice",
        account: null,
        dates: Object.assign(Object.create(null), { created: "2020" }),
      },
    }),
  ]);
  assert.equal(samePackageStructure(nullDatesA, nullDatesB as never, budget()), true);

  // Unmodified fresh clones of usable packages with shared parts must
  // compare as equal regardless of sharing size.
  const makeRow = (i: number, overrides: Record<string, unknown> = {}) =>
    v2Row({
      event: "jve1:" + (i + 1).toString(16).padStart(64, "0"),
      glosses: [],
      rafsi: [],
      classification: { kind: "gismu", selmaho: [] },
      attribution: { source: "fixture", author: null, account: null, dates: {} },
      ...overrides,
    });
  const sharedGlosses20 = Array.from({ length: 20 }, (_, j) => ({
    language: "en",
    text: `book${j}`,
    sense: null,
  }));
  const sharedLongDate = { day: "x".repeat(6400) };
  const sharedSelmaho22 = Array.from({ length: 22 }, () => "A".repeat(65));
  const sharedRafsi22 = Array.from(
    { length: 22 },
    (_, j) => "a".repeat(63) + String(j).padStart(2, "0"),
  );
  const sharedDates23 = Object.fromEntries(
    Array.from({ length: 23 }, (_, j) => [`k${j}`, "1"]),
  );
  const view = "jve1:" + "9".repeat(64);
  const cases = [
    ["shared-glosses-20", pkg(Array.from({ length: 128 }, (_, i) => makeRow(i, { glosses: sharedGlosses20 })))],
    ["shared-long-date", pkg(Array.from({ length: 128 }, (_, i) => makeRow(i, { attribution: { source: "fixture", author: null, account: null, dates: sharedLongDate } })))],
    ["shared-selmaho-22", pkg(Array.from({ length: 128 }, (_, i) => makeRow(i, { classification: { kind: "cmavo", selmaho: sharedSelmaho22 } })))],
    ["shared-rafsi-22", pkg(Array.from({ length: 128 }, (_, i) => makeRow(i, { rafsi: sharedRafsi22 })))],
    ["shared-dates-23", pkg(Array.from({ length: 128 }, (_, i) => makeRow(i, { body: "sha256:" + "c".repeat(64), rafsi_complete: true, search_status: { view, status: "active" }, attribution: { source: "fixture", author: null, account: { origin: "x", account: 1 }, dates: sharedDates23 } })))],
  ] as const;
  for (const [label, sample] of cases) {
    assert.equal(
      samePackageStructure(structuredClone(sample), sample as never, budget()),
      true,
      `${label} fresh clone must compare as equal`,
    );
  }
});

test("samePackageStructure charges zero units for empty v1 and v2 packages and only row units for populated packages", async () => {
  const { samePackageStructure } = await import(
    "../../src/data/package-search.ts"
  );
  const { entryContentUnits, SearchRequestBudget, searchMetrics } =
    await import("../../../../packages/search/src/index.ts");
  const snapshot = "sha256:" + "a".repeat(64);
  const searchView = "jve1:" + "b".repeat(64);
  const emptyPackages = [
    ["v1-empty", { version: 1 as const, snapshot, entries: [] }],
    [
      "v2-empty-with-view",
      { version: 2 as const, snapshot, search_view: searchView, entries: [] },
    ],
    [
      "v1-empty-with-downgrade",
      {
        version: 1 as const,
        snapshot,
        downgrade: "x".repeat(200),
        entries: [],
      },
    ],
  ] as const;

  for (const [label, base] of emptyPackages) {
    const b = new SearchRequestBudget(searchMetrics(), {
      workLimit: 0,
      deadlineMs: Infinity,
    });
    assert.equal(
      samePackageStructure(structuredClone(base), base as never, b),
      true,
      `${label} must match at workLimit 0`,
    );
    assert.equal(b.snapshot().spent, 0, `${label} must spend 0 units`);
  }

  // One-row package charges only the row's own content units, not the header.
  const oneRow = pkg([v2Row()]);
  const expectedRowUnits = 1 + entryContentUnits(oneRow.entries[0]);
  const exactBudget = new SearchRequestBudget(searchMetrics(), {
    workLimit: expectedRowUnits,
    deadlineMs: Infinity,
  });
  assert.equal(
    samePackageStructure(structuredClone(oneRow), oneRow as never, exactBudget),
    true,
  );
  assert.equal(exactBudget.snapshot().spent, expectedRowUnits);
});

test("savedRafsiClaims invokes an optional callback with batched canonical word IDs", async () => {
  const { wordId } = await import("../../../../packages/core/src/index.ts");
  const seen: { spelling: string; id: string }[] = [];
  const claims = (saved.savedRafsiClaims as any)(
    (entry: { word: { spelling: string } }, id: string) => {
      seen.push({ spelling: entry.word.spelling, id });
    },
  );
  // Queue 520 distinct spellings plus a duplicate to span a batch flush and a cache hit.
  const rows = [
    ...Array.from({ length: 520 }, (_, i) =>
      v2Row({
        event: "jve1:" + (i + 1).toString(16).padStart(64, "0"),
        word: { language: "jbo", spelling: `djan${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}n` },
        classification: { kind: "cmevla", selmaho: [] },
        rafsi: ["dja"],
      }),
    ),
    v2Row({
      event: "jve1:" + (521).toString(16).padStart(64, "0"),
      word: { language: "jbo", spelling: "djanaan" },
      classification: { kind: "cmevla", selmaho: [] },
      rafsi: ["djb"],
    }),
  ];
  for (const row of rows) claims.add(row);
  claims.finish();
  assert.equal(seen.length, 521);
  assert.equal(seen[0].id, wordId({ language: "jbo", spelling: "djanaan" }));
  assert.equal(seen[520].id, seen[0].id);
});

test("typedLujvoState and sourceOptions read each package row once across matched parts and preserve alias order", async () => {
  const { sourceOptions, typedLujvoState } = await import(
    "../../src/model/typed-headword.ts"
  );
  const makeRow = (
    spelling: string,
    index: number,
    rafsi: string[],
    kind: "gismu" | "cmevla",
    plain_text = "shared book",
  ) =>
    v2Row({
      event: "jve1:" + (index + 1).toString(16).padStart(64, "0"),
      word: { language: "jbo", spelling },
      classification: { kind, selmaho: [] },
      plain_text,
      rafsi,
    });
  const many = [
    makeRow("cukta", 0, ["cku"], "gismu"),
    makeRow("zbasu", 1, ["zba"], "gismu"),
    ...Array.from({ length: 998 }, (_, i) =>
      makeRow(
        "djan" +
          String.fromCharCode(
            97 + (i % 26),
            97 + (Math.floor(i / 26) % 26),
            97 + Math.floor(i / 676),
          ) +
          "n",
        i + 2,
        [],
        "cmevla",
      ),
    ),
  ];
  let reads = 0;
  const entries = new Proxy(many, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  const cached = pkg(entries as any) as any;
  const state = typedLujvoState(
    "ckuzba",
    [
      { text: "cku", kind: "rafsi", join_before: null },
      { text: "zba", kind: "rafsi", join_before: "" },
    ],
    cached,
  );
  assert.deepEqual(
    state.components.map((c) => c.spelling),
    ["cukta", "zbasu"],
  );
  assert.ok(
    reads <= 1_000,
    `expected at most 1,000 row reads across two matched parts, got ${reads}`,
  );
  // Repeat lookups on the same immutable package (e.g. renderRows) read no rows again.
  const again = sourceOptions(
    { text: "cku", kind: "rafsi", join_before: null },
    cached,
  );
  assert.equal(again.length, 1);
  assert.equal(again[0].spelling, "cukta");
  assert.equal(reads, 1_000);

  // Alias rows keep first-occurrence definition order and select a fitting display spelling.
  const shortSpelling = "ba".repeat(43) + "n";
  const longSpelling = "bá".repeat(43) + "n";
  for (const order of [
    [longSpelling, shortSpelling],
    [shortSpelling, longSpelling],
  ]) {
    const aliasPkg = pkg([
      makeRow(order[0], 0, ["bab"], "cmevla", "first def"),
      makeRow(order[1], 1, ["bab"], "cmevla", "second def"),
    ]) as any;
    const options = sourceOptions(
      { text: "bab", kind: "core", join_before: null },
      aliasPkg,
    );
    assert.equal(options.length, 1);
    assert.equal(options[0].spelling, shortSpelling);
    assert.deepEqual(
      options[0].definitions?.map((d) => d.summary),
      ["first def", "second def"],
    );
  }
});

test("structured-cloned packages keep exact dense-list, plain-date, and hex ID checks", () => {
  const gloss = v1Row().glosses[0];
  const valid = pkg([v2Row()]);
  saved.markStructuredPackage(valid);
  saved.requireSavedEntriesList(valid);
  const readValid = saved.savedRowReader(valid as any, "en");
  assert.equal(readValid(valid.entries[0]), valid.entries[0]);

  for (const bad of [
    pkg(Object.assign([v2Row()], { "01": 0 })),
    pkg(new Array(0xffffffff)),
    pkg([v2Row({ glosses: [, gloss] })]),
    pkg([v2Row({ rafsi: Object.assign(["cuk"], { includes: 1 }) })]),
    pkg([
      v2Row({ rafsi: Object.assign(new Array(2), { 0: "cuk", foo: true }) }),
    ]),
    pkg([
      v2Row({
        classification: { kind: "gismu", selmaho: Object.assign([], { join: 2 }) },
      }),
    ]),
    pkg([
      v2Row({
        attribution: {
          source: "test",
          author: null,
          account: null,
          dates: new Date() as any,
        },
      }),
    ]),
    pkg([
      v2Row({
        attribution: {
          source: "test",
          author: null,
          account: null,
          dates: new Map() as any,
        },
      }),
    ]),
    pkg([v2Row({ event: "jve1:" + "A".repeat(64) })]),
    pkg([v2Row({ body: "sha256:" + "é" + "0".repeat(63) })]),
    pkg([v2Row({ issuer: "ed25519:" + "0".repeat(63) + "g" })]),
  ]) {
    saved.markStructuredPackage(bad);
    assert.throws(() => {
      saved.requireSavedEntriesList(bad);
      const read = saved.savedRowReader(bad as any, "en");
      for (const row of bad.entries) read(row);
    }, saved.PackageValidationError);
  }
});

test("resolvePackageHits records the first fitting alias beyond HIT_CONTENT_LIMIT while mapping entries once", async () => {
  const { resolvePackageHits } = await import(
    "../../src/data/package-search.ts"
  );
  const { SearchRequestBudget, searchMetrics } = await import(
    "../../../../packages/search/src/index.ts"
  );
  const shortSpelling = "ba".repeat(43) + "n";
  const longSpelling = "bá".repeat(43) + "n";
  const entries = [
    ...Array.from({ length: 1005 }, (_, i) =>
      v2Row({
        event: "jve1:" + (i + 1).toString(16).padStart(64, "0"),
        word: { language: "jbo", spelling: longSpelling },
        classification: { kind: "cmevla", selmaho: [] },
        rafsi: ["bab"],
      }),
    ),
    v2Row({
      event: "jve1:" + (1006).toString(16).padStart(64, "0"),
      word: { language: "jbo", spelling: shortSpelling },
      classification: { kind: "cmevla", selmaho: [] },
      rafsi: ["bab"],
    }),
  ];
  const cached = pkg(entries) as any;
  const indices = entries.map((_, i) => i);
  const id = wordId({ language: "jbo", spelling: shortSpelling });
  const pages = resolvePackageHits(
    cached,
    [
      [
        {
          word_id: id,
          match: "headword",
          entries: indices,
          definitions: indices,
          preview: 0,
        },
      ],
    ],
    SearchRequestBudget.for(searchMetrics()),
  );
  assert.equal((pages[0][0] as any).fittingEntry?.word.spelling, shortSpelling);
});

test("sourceOptions keeps event order across interleaved competing claims without sorting all matching rows", async () => {
  const { sourceOptions } = await import("../../src/model/typed-headword.ts");
  const cv = ["ba", "be", "bi", "bo", "bu", "ca", "ce", "ci"];
  const names = Array.from(
    { length: 64 },
    (_, i) => cv[Math.floor(i / 8)] + cv[i % 8] + "n",
  );
  const entries: any[] = [];
  for (let d = 0; d < 64; d++) {
    for (let n = 0; n < 64; n++) {
      const idx = entries.length + 1;
      entries.push(
        v2Row({
          event: "jve1:" + idx.toString(16).padStart(64, "0"),
          word: { language: "jbo", spelling: names[n] },
          classification: { kind: "cmevla", selmaho: [] },
          rafsi: ["bab"],
        }),
      );
    }
  }
  const cached = pkg(entries) as any;
  for (let call = 0; call < 2; call++) {
    let rowComparisons = 0;
    let wordComparisons = 0;
    const originalSort = Array.prototype.sort;
    Array.prototype.sort = function (compareFn?: (a: any, b: any) => number) {
      return originalSort.call(
        this,
        compareFn &&
          ((a: any, b: any) => {
            if (this.length > 64) rowComparisons++;
            else wordComparisons++;
            return compareFn(a, b);
          }),
      );
    };
    let result: ReturnType<typeof sourceOptions>;
    try {
      result = sourceOptions(
        { text: "bab", kind: "rafsi", join_before: null },
        cached,
      );
    } finally {
      Array.prototype.sort = originalSort;
    }
    assert.equal(result.length, 64);
    assert.equal(
      rowComparisons,
      0,
      `call ${call}: expected 0 per-row sort comparisons, got ${rowComparisons}`,
    );
    assert.ok(wordComparisons > 0 && wordComparisons <= 64 * 7);
    assert.deepEqual(
      result.map((o) => o.spelling),
      [...names].sort((a, b) => a.localeCompare(b)),
    );
    for (const option of result) {
      assert.equal(option.definitions?.length, 64);
      for (let i = 1; i < option.definitions!.length; i++) {
        assert.ok(
          option.definitions![i - 1].event < option.definitions![i].event,
        );
      }
    }
  }
});
