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
  assert.equal(samePackageStructure(nullProtoDates, baseDates, budget()), false);
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

test("samePackageStructure returns false on cyclic own array properties without stack overflow", async () => {
  const { samePackageStructure } = await import(
    "../../src/data/package-search.ts"
  );
  const { SearchRequestBudget, searchMetrics } = await import(
    "../../../../packages/search/src/index.ts"
  );
  const budget = () => new SearchRequestBudget(searchMetrics());

  const cyclicRafsi = ["cuk"];
  Object.assign(cyclicRafsi, { self: cyclicRafsi });
  const cyclicPkg = pkg([v2Row({ rafsi: cyclicRafsi })]) as never;
  assert.equal(
    samePackageStructure(
      structuredClone(cyclicPkg),
      structuredClone(cyclicPkg),
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
  const { searchPackage } = await import("../../src/data/package-search.ts");
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
  for (let d = 0; d < 24; d++) {
    leafA = { a: leafA, b: leafA };
    leafB = { a: leafB, b: leafB };
  }
  const dagBudget = new SearchRequestBudget(searchMetrics(), {
    workLimit: 5_000,
    deadlineMs: Infinity,
  });
  assert.equal(
    samePackageStructure(
      { snapshot: "s", entries: [leafA] },
      { snapshot: "s", entries: [leafB] } as never,
      dagBudget,
    ),
    false,
  );
  assert.ok(dagBudget.snapshot().spent <= 200);
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
      { snapshot: "s", entries: [bigA, { nested: bigA }] },
      { snapshot: "s", entries: [bigB1, { nested: bigB2 }] } as never,
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

  // A direct non-package root without entries stops at the fixed 64-step cap.
  const directBudget = new SearchRequestBudget(searchMetrics(), {
    workLimit: 82_688,
    deadlineMs: Infinity,
  });
  assert.equal(
    samePackageStructure(structuredClone(root), root as never, directBudget),
    false,
  );
  assert.ok(
    directBudget.snapshot().spent <= 64,
    `expected 64-step cap stop <= 64 units, spent ${directBudget.snapshot().spent}`,
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
