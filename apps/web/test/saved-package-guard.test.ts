import { test, expect, type Page } from "@playwright/test";
import { fixture } from "./helpers.ts";

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

/** Saves one package value and, when asked, one wizard draft in this browser. */
async function seed(
  page: Page,
  saved: unknown,
  draft?: Record<string, unknown>,
) {
  await page.goto("/");
  await page.evaluate(
    async ({ saved, draft }) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const store = new LocalStore();
      await store.setPreferences({ searchMode: "local" });
      await store.put("packages", "en", saved);
      if (draft) {
        const { newDraft } = await import(String("/src/model/draft.ts"));
        await store.put("drafts", "current", newDraft(draft as never));
      }
    },
    { saved, draft },
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
    await page
      .getByRole("button", { name: "search this server" })
      .click();
    await expect(page.locator("ol.similar")).toContainText("cukta");
    const body = await page.locator("body").innerText();
    expect(body).not.toMatch(RAW_ERROR);
  });
}

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
