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
  assert.equal(samePackageStructure(plainNull, base, budget()), true);

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
