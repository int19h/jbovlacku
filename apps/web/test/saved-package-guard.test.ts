import { test, expect, type Page } from "@playwright/test";
import { fixture } from "./helpers.ts";

const INVALID =
  "The search package is invalid. Search this server or download another package.";
const RAW_ERRORS = [
  "Cannot use 'in' operator",
  "Cannot read properties of null",
  "Cannot read properties of undefined",
];

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
  for (const raw of RAW_ERRORS) expect(body).not.toContain(raw);
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
