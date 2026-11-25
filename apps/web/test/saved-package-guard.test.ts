import { test, expect, type Page } from "@playwright/test";
import { corePath, fixture } from "./helpers.ts";

const INVALID =
  "The search package is invalid. Search this server or download another package.";
// Raw runtime errors look different in each engine, so the check bans the
// shapes every engine produces: error class names, property-access and
// iteration wording, and the core's schema JSON.
const RAW_ERROR =
  /TypeError|ReferenceError|\{"code":|is not iterable|not iterable|Cannot read|Cannot use|can't access|is undefined|is null/;

const savedPackages: [string, unknown][] = [
  [
    "a package with a null row",
    { version: 2, snapshot: "sha256:" + "a".repeat(64), entries: [null] },
  ],
  ["a stored null", null],
];

/**
 * Saves one package value for `en` and, when asked, one wizard draft in this
 * browser. Further packages are saved under their language keys.
 */
async function seed(
  page: Page,
  saved: unknown,
  draft?: Record<string, unknown>,
  others: Record<string, unknown> = {},
) {
  await page.goto("/");
  await page.evaluate(
    async ({ saved, draft, others }) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const store = new LocalStore();
      await store.setPreferences({ searchMode: "local" });
      await store.put("packages", "en", saved);
      for (const [language, value] of Object.entries(others))
        await store.put("packages", language, value);
      if (draft) {
        const { newDraft } = await import(String("/src/model/draft.ts"));
        await store.put("drafts", "current", newDraft(draft as never));
      }
    },
    { saved, draft, others },
  );
}

async function expectInvalidOnly(page: Page) {
  await expect(page.getByText(INVALID).first()).toBeVisible();
  const body = await page.locator("body").innerText();
  expect(body).not.toMatch(RAW_ERROR);
}

/** The rafsi pages try this server first, so a failed download reaches the saved package. */
async function blockDownloads(page: Page) {
  await page.route("**/api/v1/manifest", (route) => route.abort());
}

for (const [label, saved] of savedPackages) {
  test(`the rafsi page reports ${label} instead of crashing`, async ({
    page,
  }) => {
    await seed(page, saved);
    await blockDownloads(page);
    await page.goto("/rafsi/cuk");
    await expectInvalidOnly(page);
    await expect(page.getByRole("heading", { name: "cuk" })).toBeVisible();
  });

  test(`the rafsi pair page reports ${label} instead of crashing`, async ({
    page,
  }) => {
    await seed(page, saved);
    await blockDownloads(page);
    await page.goto(`/rafsi-pair/${fixture().pair}`);
    await expectInvalidOnly(page);
  });

  test(`the claim page reports ${label} instead of crashing`, async ({
    page,
  }) => {
    await seed(page, saved);
    await blockDownloads(page);
    await page.goto("/claim/cukta");
    await page.getByLabel("Rafsi spelling").fill("cuk");
    await page
      .getByRole("button", { name: "Check claims and preview" })
      .click();
    await expectInvalidOnly(page);
  });

  test(`the lujvo builder reports ${label} and keeps its part field`, async ({
    page,
  }) => {
    await seed(page, saved, {
      meaning: "book",
      kind: "lujvo",
      step: 3,
    });
    await page.goto("/new/lujvo");
    await expectInvalidOnly(page);
    await expect(page.getByLabel("Add a part")).toBeVisible();
    await page.getByLabel("Add a part").fill("cukta");
    await expect(
      page.getByRole("button", { name: "Add cukta as entered" }),
    ).toBeVisible();
  });

  test(`the gismu page reports ${label} instead of crashing`, async ({
    page,
  }) => {
    await seed(page, saved, {
      meaning: "book",
      kind: "gismu",
      step: 3,
    });
    await page.goto("/new/gismu");
    await expectInvalidOnly(page);
    await expect(
      page.getByRole("heading", { name: "Make a gismu" }),
    ).toBeVisible();
  });

  test(`the word type page reports ${label} instead of crashing`, async ({
    page,
  }) => {
    await seed(page, saved, {
      meaning: "book",
      kind: "gismu",
      spelling: "cukte",
      step: 2,
    });
    await page.goto("/new/type");
    await expectInvalidOnly(page);
    await expect(
      page.getByRole("heading", { name: "What kind of word?" }),
    ).toBeVisible();
  });

  test(`the publish page reports ${label} instead of crashing`, async ({
    page,
  }) => {
    await seed(page, saved, {
      meaning: "book",
      kind: "gismu",
      spelling: "broda",
      text: "___ is a book.",
      step: 5,
    });
    await page.goto("/new/publish");
    await expectInvalidOnly(page);
    await expect(
      page.getByRole("region", { name: "Known conflicts" }),
    ).toContainText(INVALID);
  });

  test(`the meaning page reports ${label} instead of crashing`, async ({
    page,
  }) => {
    await seed(page, saved, { meaning: "book", spelling: "cukta", step: 1 });
    await page.goto("/new/meaning");
    await expectInvalidOnly(page);
    await expect(page.getByRole("textbox", { name: "Meaning" })).toBeVisible();
    // The typed-word check reads saved rows itself, so it shows the same
    // message instead of reporting that the word is absent.
    await expect(
      page.getByRole("region", { name: "Typed word" }),
    ).toContainText(INVALID);
  });

  test(`settings reports ${label} and keeps its remove control`, async ({
    page,
  }) => {
    await seed(page, saved);
    await page.goto("/preferences");
    await expectInvalidOnly(page);
    await expect(
      page.getByRole("button", { name: "Remove", exact: true }),
    ).toBeVisible();
  });
}

/** One valid version 2 row for cukta, which claims the rafsi cuk. */
const validRow = {
  event: "jve1:" + "1".repeat(64),
  word: { language: "jbo", spelling: "cukta" },
  language: "en",
  glosses: [{ language: "en", text: "book", sense: null }],
  plain_text: "book",
  classification: { kind: "gismu", selmaho: [] },
  body: null,
  issuer: "ed25519:" + "a".repeat(64),
  notes: false,
  rafsi: ["cuk"],
  rafsi_complete: true,
  attribution: null,
};
const validPackage = {
  version: 2,
  snapshot: "sha256:" + "a".repeat(64),
  entries: [validRow],
};
/** Ranks before the one-row valid package: same version, more rows. */
const malformedPackage = {
  version: 2,
  snapshot: "sha256:" + "b".repeat(64),
  entries: [null, null],
};

const rowShapes: [string, Record<string, unknown>][] = [
  [
    "a version 2 row with no rafsi",
    {
      version: 2,
      snapshot: "sha256:" + "a".repeat(64),
      entries: [
        {
          event: "jve1:" + "1".repeat(64),
          word: { language: "jbo", spelling: "cukta" },
          language: "en",
          glosses: [{ language: "en", text: "book", sense: null }],
          plain_text: "book",
          classification: { kind: "gismu", selmaho: [] },
          body: null,
          issuer: "ed25519:" + "a".repeat(64),
          notes: false,
          attribution: null,
        },
      ],
    },
  ],
  [
    "a word object with an extra field",
    {
      version: 2,
      snapshot: "sha256:" + "a".repeat(64),
      entries: [
        {
          event: "jve1:" + "1".repeat(64),
          word: { language: "jbo", spelling: "cukta", extra: 1 },
          language: "en",
          glosses: [{ language: "en", text: "book", sense: null }],
          plain_text: "book",
          classification: { kind: "gismu", selmaho: [] },
          body: null,
          issuer: "ed25519:" + "a".repeat(64),
          notes: false,
          rafsi: ["cuk"],
          rafsi_complete: true,
          attribution: null,
        },
      ],
    },
  ],
];

rowShapes.push([
  "a word that the core does not accept",
  {
    version: 2,
    snapshot: "sha256:" + "a".repeat(64),
    entries: [{ ...validRow, word: { language: "jbo", spelling: " cukta" } }],
  },
]);

// The search worker accepts this row, but the core cannot read the rafsi
// when a page derives its pair ID.
const loneSurrogatePackage = {
  version: 2,
  snapshot: "sha256:" + "a".repeat(64),
  entries: [{ ...validRow, rafsi: ["\ud800"] }],
};
rowShapes.push(["a rafsi with a lone surrogate", loneSurrogatePackage]);

for (const [label, saved] of rowShapes) {
  test(`the rafsi pair page reports ${label} instead of crashing`, async ({
    page,
  }) => {
    await seed(page, saved);
    await blockDownloads(page);
    await page.goto(`/rafsi-pair/${fixture().pair}`);
    await expectInvalidOnly(page);
  });

  test(`the lujvo builder reports ${label} and keeps its part field`, async ({
    page,
  }) => {
    await seed(page, saved, { meaning: "book", kind: "lujvo", step: 3 });
    await page.goto("/new/lujvo");
    await expectInvalidOnly(page);
    await expect(page.getByLabel("Add a part")).toBeVisible();
  });
}

for (const [label, saved] of savedPackages) {
  test(`the meaning page still searches the server for ${label}`, async ({
    page,
  }) => {
    // A malformed or missing local package must not block server search:
    // after the reader allows it, the server results appear, as on main
    // for a stored null.
    await seed(page, saved, { meaning: "book", step: 1 });
    page.on("dialog", (dialog) => void dialog.accept());
    await page.goto("/new/meaning");
    await page.getByRole("button", { name: "allow server search" }).click();
    await expect(page.locator("ol.similar")).toContainText("cukta");
    const body = await page.locator("body").innerText();
    expect(body).not.toMatch(RAW_ERROR);
  });
}

/** Blocks the search worker, the same failure the part-lookup test uses. */
async function blockWorker(page: Page) {
  await page.route("**/package-search-worker.ts*", (route) => route.abort());
}

for (const [name, route, draft, control] of [
  [
    "gismu",
    "/new/gismu",
    { meaning: "book", kind: "gismu", step: 3 },
    "Make a gismu",
  ],
  [
    "lujvo",
    "/new/lujvo",
    { meaning: "book", kind: "lujvo", step: 3 },
    "Add a part",
  ],
  [
    "word type",
    "/new/type",
    { meaning: "book", kind: "gismu", spelling: "cukte", step: 2 },
    "What kind of word?",
  ],
  [
    "publish",
    "/new/publish",
    {
      meaning: "book",
      kind: "gismu",
      spelling: "broda",
      text: "___ is a book.",
      step: 5,
    },
    "Known conflicts",
  ],
] as const) {
  test(`the ${name} page reports a malformed package when the worker cannot start`, async ({
    page,
  }) => {
    await seed(
      page,
      { version: 2, snapshot: "sha256:" + "a".repeat(64), entries: [null] },
      draft,
    );
    await blockWorker(page);
    await page.goto(route);
    await expectInvalidOnly(page);
    if (name === "publish")
      await expect(
        page.getByRole("region", { name: "Known conflicts" }),
      ).toBeVisible();
    else await expect(page.getByText(control).first()).toBeVisible();
  });
}

test("settings shows a valid package count when the worker cannot start", async ({
  page,
}) => {
  await seed(page, {
    version: 2,
    snapshot: "sha256:" + "a".repeat(64),
    entries: [
      {
        event: "jve1:" + "1".repeat(64),
        word: { language: "jbo", spelling: "cukta" },
        language: "en",
        glosses: [{ language: "en", text: "book", sense: null }],
        plain_text: "book",
        classification: { kind: "gismu", selmaho: [] },
        body: null,
        issuer: "ed25519:" + "a".repeat(64),
        notes: false,
        rafsi: ["cuk"],
        rafsi_complete: true,
        attribution: null,
      },
    ],
  });
  await blockWorker(page);
  await page.goto("/preferences");
  await expect(page.getByText(/1 definition/)).toBeVisible();
  await expect(page.getByText("Local search could not start.")).toHaveCount(0);
});

test("the rafsi pair page reports a malformed package when the worker cannot start", async ({
  page,
}) => {
  await seed(page, {
    version: 2,
    snapshot: "sha256:" + "a".repeat(64),
    entries: [null],
  });
  await blockDownloads(page);
  await blockWorker(page);
  await page.goto(`/rafsi-pair/${fixture().pair}`);
  await expectInvalidOnly(page);
});

test("search reports a stored null and falls back to the server", async ({
  page,
}) => {
  // Other malformed saved values already reach the search worker and keep
  // its fallback. A stored null was read as no package, with no message.
  await seed(page, null);
  await page.goto("/search?q=book&lang=en");
  await expect(page.getByRole("status")).toContainText(
    "The search package is invalid",
  );
  await expect(
    page.getByRole("link", { name: "cukta", exact: true }),
  ).toBeVisible();
});

test("the word type page keeps a valid package beside a malformed one that ranks first", async ({
  page,
}) => {
  await seed(
    page,
    validPackage,
    { meaning: "book", kind: "gismu", spelling: "cukte", step: 2 },
    { fr: malformedPackage },
  );
  await page.goto("/new/type");
  const closeness = page.getByRole("region", { name: "Gismu closeness" });
  await expect(closeness).toContainText(INVALID);
  await expect(closeness).toContainText("Last vowel differs from cukta");
  await expect(
    closeness.getByRole("link", { name: "Add source-language evidence" }),
  ).toBeVisible();
  expect(await page.locator("body").innerText()).not.toMatch(RAW_ERROR);
});

test("the publish page keeps a valid package beside a malformed one that ranks first", async ({
  page,
}) => {
  await seed(
    page,
    validPackage,
    {
      meaning: "book",
      kind: "gismu",
      spelling: "broda",
      text: "___ is a book.",
      step: 5,
      rafsiClaims: [{ rafsi: "cuk", rationale: "" }],
    },
    { fr: malformedPackage },
  );
  await page.goto("/new/publish");
  const conflicts = page.getByRole("region", { name: "Known conflicts" });
  await expect(conflicts).toContainText(INVALID);
  await expect(conflicts).toContainText("cuk is also claimed by cukta");
  expect(await page.locator("body").innerText()).not.toMatch(RAW_ERROR);
});

test("the rafsi pair page finds a pair in a valid package beside a malformed one", async ({
  page,
}) => {
  await seed(page, malformedPackage, undefined, { fr: frPackage });
  await blockDownloads(page);
  const pair = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    await core.initializeCore();
    return core.rafsiPairId(
      core.wordId({ language: "jbo", spelling: "cukta" }),
      "cuk",
    );
  }, corePath);
  await page.goto(`/rafsi-pair/${pair}`);
  await expect(page.getByRole("heading", { name: "cuk" })).toBeVisible();
  // The word link names the language of the package that held the pair.
  await expect(
    page.locator('main a[href="/word/cukta?lang=fr"]').first(),
  ).toBeVisible();
  expect(await page.locator("body").innerText()).not.toMatch(RAW_ERROR);
});

test("settings marks only the malformed package of two", async ({ page }) => {
  await seed(page, validPackage, undefined, { fr: malformedPackage });
  await page.goto("/preferences");
  await expect(page.getByText(INVALID)).toHaveCount(1);
  await expect(
    page.getByText(/1 definition · snapshot aaaaaaaaaaaa/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Remove", exact: true }),
  ).toHaveCount(2);
});

for (const [name, route, draft] of [
  ["gismu", "/new/gismu", { meaning: "book", kind: "gismu", step: 3 }],
  [
    "word type",
    "/new/type",
    { meaning: "book", kind: "gismu", spelling: "cukte", step: 2 },
  ],
  [
    "publish",
    "/new/publish",
    {
      meaning: "book",
      kind: "gismu",
      spelling: "broda",
      text: "___ is a book.",
      step: 5,
    },
  ],
  ["settings", "/preferences", undefined],
] as const) {
  test(`the ${name} page reports a rafsi with a lone surrogate`, async ({
    page,
  }) => {
    await seed(page, loneSurrogatePackage, draft);
    await page.goto(route);
    await expectInvalidOnly(page);
    if (name === "publish")
      await expect(
        page.getByRole("region", { name: "Known conflicts" }),
      ).toContainText("no usable local package");
  });
}

test("the rafsi page reports a lone-surrogate rafsi after an incomplete row", async ({
  page,
}) => {
  // The completeness scan must check every row, not stop at the first
  // incomplete one: the worker accepts the later row, and the page derives
  // a pair ID from each rafsi that the pattern matches.
  await seed(page, {
    version: 2,
    snapshot: "sha256:" + "a".repeat(64),
    entries: [
      { ...validRow, rafsi_complete: false },
      {
        ...validRow,
        event: "jve1:" + "2".repeat(64),
        word: { language: "jbo", spelling: "cukte" },
        rafsi: ["\ud800"],
      },
    ],
  });
  await blockDownloads(page);
  await page.goto("/rafsi/*");
  await expectInvalidOnly(page);
});

test("the meaning page reports a lone-surrogate event in the typed-word check", async ({
  page,
}) => {
  // The typed-word check links each definition by its event, and a link
  // cannot hold an unpaired surrogate.
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await seed(
    page,
    {
      version: 2,
      snapshot: "sha256:" + "a".repeat(64),
      entries: [{ ...validRow, event: "\ud800" }],
    },
    { meaning: "book", spelling: "cukta", step: 1 },
  );
  await page.goto("/new/meaning");
  const typed = page.getByRole("region", { name: "Typed word" });
  await expect(typed).toContainText(INVALID);
  await expect(
    typed.getByRole("button", { name: "Check this word on the server" }),
  ).toBeVisible();
  expect(await page.locator("body").innerText()).not.toMatch(RAW_ERROR);
  expect(errors).toEqual([]);
});

// Stage 3 review inputs: one fault per case, beside valid packages where the
// review used them. Each case checks that the page reports the package. The
// lujvo builder saves its builder state on load, so its cases also wait for
// that save and check that no bad value reaches the saved draft.
const rowWith = (over: Record<string, unknown>) => ({ ...validRow, ...over });
const zbasuRow = rowWith({
  event: "jve1:" + "2".repeat(64),
  word: { language: "jbo", spelling: "zbasu" },
  glosses: [{ language: "en", text: "make", sense: null }],
  plain_text: "make",
  rafsi: ["zba"],
});
const frPackage = {
  version: 2,
  snapshot: "sha256:" + "f".repeat(64),
  entries: [
    rowWith({
      language: "fr",
      glosses: [{ language: "fr", text: "livre", sense: null }],
      plain_text: "livre",
    }),
  ],
};
const lujvoDraft = {
  meaning: "book maker",
  kind: "lujvo",
  spelling: "ckuzba",
  typedSpelling: "ckuzba",
  text: "It makes books.",
  step: 3,
};
/** Waits until the lujvo builder's load-time save has written its components. */
async function expectSavedBuilderDraft(page: Page) {
  await expect(page.getByText("Saved in this browser")).toBeVisible();
  await expect.poll(() => savedDraftText(page)).toContain('"components":[{');
}
async function savedDraftText(page: Page) {
  return page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return JSON.stringify(
      (await new LocalStore().get("drafts", "current")) ?? null,
    );
  });
}

test("the rafsi and claim pages keep a valid package beside a stored null", async ({
  page,
}) => {
  await seed(
    page,
    { ...validPackage, entries: [rowWith({ rafsi: ["cuk", "cku"] })] },
    undefined,
    { fr: null },
  );
  await blockDownloads(page);
  await page.goto("/rafsi/cuk");
  await expect(page.getByText(INVALID).first()).toBeVisible();
  await expect(
    page.getByRole("region", { name: "cuk for cukta" }),
  ).toBeVisible();
  await page.goto("/claim/broda");
  await page.getByLabel("Rafsi spelling").fill("cuk");
  await page.getByRole("button", { name: "Check claims and preview" }).click();
  await expect(page.getByText(INVALID).first()).toBeVisible();
  await expect(page.locator("main")).toContainText(
    "Conflict: cuk is already claimed for cukta",
  );
  await expect(page.getByRole("heading", { name: "Preview" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sign and publish the claim" }),
  ).toBeVisible();
  expect(await page.locator("body").innerText()).not.toMatch(RAW_ERROR);
});

for (const snapshot of ["bad-snapshot", "sha256:\ud800"])
  test(`the gismu page reports a package whose snapshot is ${JSON.stringify(snapshot)}`, async ({
    page,
  }) => {
    await seed(
      page,
      { ...validPackage, snapshot },
      { meaning: "book", kind: "gismu", spelling: "cukte", step: 3 },
    );
    await page.goto("/new/gismu");
    await expectInvalidOnly(page);
  });

test("the publish page uses a valid package beside one with an empty snapshot", async ({
  page,
}) => {
  await seed(
    page,
    { ...validPackage, snapshot: "", entries: [validRow, zbasuRow] },
    {
      meaning: "book",
      kind: "gismu",
      spelling: "cukte",
      text: "It is a book.",
      step: 5,
    },
    { fr: frPackage },
  );
  await page.goto("/new/publish");
  const conflicts = page.getByRole("region", { name: "Known conflicts" });
  await expect(conflicts).toContainText(INVALID);
  await expect(conflicts).toContainText("ffffffffffff");
  await expect(conflicts).not.toContainText("Root conflicts were not checked");
});

test("the lujvo builder reports a row whose event is not an event ID", async ({
  page,
}) => {
  await seed(
    page,
    {
      ...validPackage,
      // With cku listed, cukta is a source for the typed part, so the
      // builder offers and saves its definitions.
      entries: [
        rowWith({ event: "bad-event", rafsi: ["cuk", "cku"] }),
        zbasuRow,
      ],
    },
    lujvoDraft,
  );
  await page.goto("/new/lujvo");
  await expectInvalidOnly(page);
  await expectSavedBuilderDraft(page);
  expect(await savedDraftText(page)).not.toContain("bad-event");
  await expect(page.locator('option[value="bad-event"]')).toHaveCount(0);
});

test("the lujvo builder reports a row with more than 64 rafsi and uses the valid package", async ({
  page,
}) => {
  await seed(
    page,
    {
      ...validPackage,
      entries: [
        rowWith({
          rafsi: ["cku", ...Array.from({ length: 64 }, (_, i) => `r${i}`)],
        }),
        zbasuRow,
      ],
    },
    lujvoDraft,
    { fr: frPackage },
  );
  await page.goto("/new/lujvo");
  await expectInvalidOnly(page);
  await expectSavedBuilderDraft(page);
  expect(await savedDraftText(page)).not.toContain('"r63"');
  // Only the valid fr package has this snapshot.
  await expect(page.getByRole("region", { name: "Result" })).toContainText(
    "ffffffffffff",
  );
  await expect(page.locator("main")).not.toContainText(
    "component claims is 65",
  );
});

const v1Row = {
  event: "jve1:" + "1".repeat(64),
  word: { language: "jbo", spelling: "cukta" },
  language: "fr",
  glosses: [{ language: "fr", text: "livre", sense: null }],
  plain_text: "livre",
  classification: { kind: "gismu", selmaho: [] },
  body: null,
};
const v2WithV1Rows = {
  version: 2,
  snapshot: "sha256:" + "b".repeat(64),
  entries: [v1Row, { ...v1Row, event: "jve1:" + "2".repeat(64) }],
};

test("the publish page reports a version 2 package of version 1 rows and keeps the valid one", async ({
  page,
}) => {
  await seed(
    page,
    validPackage,
    {
      meaning: "book",
      kind: "gismu",
      spelling: "broda",
      text: "It is a book.",
      step: 5,
      rafsiClaims: [{ rafsi: "cuk", rationale: "" }],
    },
    { fr: v2WithV1Rows },
  );
  await page.goto("/new/publish");
  const conflicts = page.getByRole("region", { name: "Known conflicts" });
  await expect(conflicts).toContainText(INVALID);
  await expect(conflicts).toContainText("cuk is also claimed by cukta");
});

test("settings reports a version 2 package of version 1 rows", async ({
  page,
}) => {
  await seed(page, validPackage, undefined, { fr: v2WithV1Rows });
  await page.goto("/preferences");
  await expect(page.getByText(INVALID)).toHaveCount(1);
  await expect(
    page.getByText(/1 definition · snapshot aaaaaaaaaaaa/),
  ).toBeVisible();
});

for (const [label, row] of [
  ["with rafsi but no issuer", { ...v1Row, language: "en", rafsi: ["cuk"] }],
  [
    "with a rejected word and no issuer",
    { ...v1Row, language: "en", word: { language: "jbo", spelling: " cukta" } },
  ],
] as const)
  test(`the rafsi pair page reports a version 2 row ${label}`, async ({
    page,
  }) => {
    await seed(page, { ...validPackage, entries: [row] });
    await blockDownloads(page);
    const pair = await page.evaluate(async (corePath) => {
      const core = await import(corePath);
      await core.initializeCore();
      return core.rafsiPairId(
        core.wordId({ language: "jbo", spelling: "cukta" }),
        "cuk",
      );
    }, corePath);
    await page.goto(`/rafsi-pair/${pair}`);
    await expectInvalidOnly(page);
  });

/**
 * Saves one package built in the page, so that shapes that do not survive
 * the test's argument passing (empty array slots, own properties on
 * arrays) go through a real IndexedDB write and read.
 */
async function seedBuilt(
  page: Page,
  shape: "selmaho-hole" | "gloss-hole" | "rafsi-hole" | "gloss-some",
  draft?: Record<string, unknown>,
) {
  await page.goto("/");
  await page.evaluate(
    async ({ shape, row, draft }) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const entry = structuredClone(row) as Record<string, any>;
      if (shape === "selmaho-hole") entry.classification.selmaho = new Array(1);
      if (shape === "gloss-hole") entry.glosses.length = 2;
      if (shape === "rafsi-hole") entry.rafsi.length = 2;
      if (shape === "gloss-some") Object.assign(entry.glosses, { some: false });
      const store = new LocalStore();
      await store.setPreferences({ searchMode: "local" });
      await store.put("packages", "en", {
        version: 2,
        snapshot: "sha256:" + "a".repeat(64),
        entries: [entry],
      });
      if (draft) {
        const { newDraft } = await import(String("/src/model/draft.ts"));
        await store.put("drafts", "current", newDraft(draft as never));
      }
    },
    { shape, row: validRow, draft },
  );
}

for (const shape of ["selmaho-hole", "gloss-hole", "rafsi-hole"] as const)
  test(`a package with an empty array slot (${shape}) stays usable, as the worker reads it`, async ({
    page,
  }) => {
    await seedBuilt(page, shape, {
      meaning: "book",
      kind: "gismu",
      spelling: "cukte",
      step: 2,
    });
    await page.goto("/new/type");
    const closeness = page.getByRole("region", { name: "Gismu closeness" });
    await expect(closeness).toContainText("Last vowel differs from cukta");
    await expect(closeness).not.toContainText(INVALID);
    await page.goto("/preferences");
    await expect(
      page.getByText(/1 definition · snapshot aaaaaaaaaaaa/),
    ).toBeVisible();
    // Settings checks the rows in a later task; give it time to run.
    await page.waitForTimeout(500);
    await expect(page.getByText(INVALID)).toHaveCount(0);
  });

test("search and meaning show the documented message for a gloss list with an own some property", async ({
  page,
}) => {
  await seedBuilt(page, "gloss-some", { meaning: "book", step: 1 });
  await page.goto("/search?q=book&lang=en");
  await expect(page.locator("div.status[role=status]")).toContainText(INVALID);
  expect(await page.locator("body").innerText()).not.toMatch(/not a function/);
  await page.goto("/new/meaning");
  await expect(page.locator("div.status[role=status]")).toContainText(INVALID);
  expect(await page.locator("body").innerText()).not.toMatch(/not a function/);
});

test("an obsolete nearby lookup does not clear the current language's package", async ({
  page,
}) => {
  // Holds the worker's invalid-package reply for the English lookup until
  // the page has read the French package, then releases it.
  await page.addInitScript(() => {
    const w = window as unknown as {
      held?: () => void;
      frenchRead?: boolean;
    };
    const Native = window.Worker;
    window.Worker = class extends Native {
      set onmessage(handler: ((event: MessageEvent) => void) | null) {
        super.onmessage = (event: MessageEvent) => {
          if (event.data?.code === "invalid-package" && !w.held)
            w.held = () => handler?.call(this, event);
          else handler?.call(this, event);
        };
      }
    } as typeof Worker;
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (key: IDBValidKey) {
      const request = get.call(this, key);
      if (this.name === "packages" && key === "fr")
        request.addEventListener("success", () =>
          setTimeout(() => (w.frenchRead = true), 0),
        );
      return request;
    };
  });
  const empty = {
    version: 2,
    snapshot: "sha256:" + "a".repeat(64),
    entries: [],
  };
  await seed(
    page,
    { ...empty, entries: [null] },
    { meaning: "book", language: "en", step: 1 },
    { fr: empty },
  );
  await page.goto("/new/meaning");
  await page.waitForFunction(
    () => typeof (window as unknown as { held?: unknown }).held === "function",
  );
  await page.getByLabel("Meaning", { exact: true }).fill("");
  await page.getByLabel("Language", { exact: true }).selectOption("fr");
  await page.waitForFunction(
    () => (window as unknown as { frenchRead?: boolean }).frenchRead === true,
  );
  const panel = page.getByRole("region", { name: "Close in meaning" });
  await expect(panel).not.toContainText("from the downloaded package");
  await page.evaluate(() => (window as unknown as { held: () => void }).held());
  await page.getByRole("textbox", { name: "Meaning", exact: true }).fill("livre");
  await expect(panel).toContainText("from the downloaded package");
  await expect(panel).not.toContainText("saved package is invalid");
});

/**
 * Saves an English package whose cukta row has the rafsi `cku` and an empty
 * array slot, beside a valid zbasu row, and a valid French package with
 * both words. The slot is made in the page, so it goes through IndexedDB.
 */
async function seedRafsiHole(page: Page, draft?: Record<string, unknown>) {
  await page.goto("/");
  await page.evaluate(
    async ({ cukta, zbasu, draft }) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const store = new LocalStore();
      await store.setPreferences({ searchMode: "local" });
      const holed = structuredClone(cukta) as Record<string, any>;
      holed.rafsi = ["cku"];
      holed.rafsi.length = 2;
      await store.put("packages", "en", {
        version: 2,
        snapshot: "sha256:" + "a".repeat(64),
        entries: [holed, zbasu],
      });
      const french = (row: Record<string, any>, text: string) => ({
        ...row,
        language: "fr",
        glosses: [{ language: "fr", text, sense: null }],
        plain_text: text,
      });
      await store.put("packages", "fr", {
        version: 2,
        snapshot: "sha256:" + "f".repeat(64),
        entries: [
          french({ ...cukta, rafsi: ["cku"] }, "livre"),
          french(zbasu, "faire"),
        ],
      });
      if (draft) {
        const { newDraft } = await import(String("/src/model/draft.ts"));
        await store.put("drafts", "current", newDraft(draft as never));
      }
    },
    { cukta: validRow, zbasu: zbasuRow, draft },
  );
}

test("an empty rafsi slot is no rafsi on the lujvo builder, and its draft holds only real claims", async ({
  page,
}) => {
  await seedRafsiHole(page, lujvoDraft);
  await page.goto("/new/lujvo");
  await expect(page.getByRole("button", { name: "Use ckuzba" })).toBeVisible();
  const main = page.locator("main");
  await expect(main).not.toContainText("The builder stopped");
  await expect(main).not.toContainText(INVALID);
  // The English package stays in use: the worker accepts it.
  await expect(page.getByRole("region", { name: "Result" })).toContainText(
    "aaaaaaaaaaaa",
  );
  await expectSavedBuilderDraft(page);
  const claims = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const draft = (await new LocalStore().get("drafts", "current")) as {
      lujvo: { components: { claims: { rafsi: unknown }[] }[] };
    };
    return draft.lujvo.components.flatMap((c) =>
      c.claims.map((claim) => typeof claim.rafsi),
    );
  });
  expect(claims.length).toBeGreaterThan(0);
  expect(claims.every((type) => type === "string")).toBe(true);
});

test("an empty rafsi slot is no rafsi on the gismu page", async ({ page }) => {
  await seedRafsiHole(page, {
    meaning: "book",
    kind: "gismu",
    spelling: "cukte",
    text: "It is a book.",
    step: 3,
    gismu: {
      preset: null,
      rows: [
        {
          id: "r1",
          language: "en",
          name: "English",
          weight: { numerator: "1", denominator: "1" },
          word: "book",
          input: "cukte",
          sense: "",
          note: "",
        },
      ],
      candidates: "source-letters",
      window: 12,
      manual: "cukte",
      selected: "cukte",
      acknowledged: [],
      reason: "",
    },
  });
  await page.goto("/new/gismu");
  await expect(
    page.getByRole("heading", { name: "Make a gismu" }),
  ).toBeVisible();
  await expect(page.locator("main")).toContainText("aaaaaaaaaaaa");
  const main = page.locator("main");
  await expect(main).not.toContainText("The generator stopped");
  await expect(main).not.toContainText(INVALID);
});

test("an empty rafsi slot is no rafsi in a pattern search", async ({
  page,
}) => {
  await seedRafsiHole(page);
  await page.goto("/search?q=zba*&lang=en");
  await expect(
    page
      .getByRole("region", { name: "Search results" })
      .getByRole("link", { name: "zbasu", exact: true }),
  ).toBeVisible();
  expect(await page.locator("body").innerText()).not.toMatch(RAW_ERROR);
});

test("an empty rafsi slot is no rafsi on the rafsi pair page", async ({
  page,
}) => {
  await seedRafsiHole(page);
  await blockDownloads(page);
  const [real, empty] = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    await core.initializeCore();
    const id = core.wordId({ language: "jbo", spelling: "cukta" });
    return [core.rafsiPairId(id, "cku"), core.rafsiPairId(id, undefined)];
  }, corePath);
  await page.goto(`/rafsi-pair/${real}`);
  await expect(page.getByRole("heading", { name: "cku" })).toBeVisible();
  await page.goto(`/rafsi-pair/${empty}`);
  await expect(
    page.getByRole("heading", { name: "Rafsi pair unavailable" }),
  ).toBeVisible();
  expect(await page.locator("main").innerText()).not.toContain("undefined");
});
