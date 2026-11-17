import { expect, test, type Page } from "@playwright/test";

/**
 * Page-level fixtures for the r6 caps: a two-entry word that must render
 * byte-identically to main, a 1,001-entry word that exercises the display
 * caps and the whole-set actions, and an exact-1,000 rafsi pair set. The
 * file drives only pages and long-stable modules, so the same file also
 * runs on main for the comparison.
 */
const issuer = "ed25519:" + "a".repeat(64);
const snapshot = "sha256:" + "b".repeat(64);

const wordEntry = (index: number, spelling = "broda") => ({
  event: "jve1:" + (index + 1).toString(16).padStart(64, "0"),
  word: { language: "jbo", spelling },
  language: "en",
  glosses: [{ language: "en", text: "book", sense: null }],
  plain_text: `Definition ${index} is a book.`,
  classification: { kind: "gismu", selmaho: [] },
  body: null,
  issuer,
  notes: false,
  rafsi: [`raf${index}`],
  rafsi_complete: true,
  attribution: null,
});

const seedPackages = (page: Page, pkgs: Record<string, unknown>) =>
  page.evaluate(async (entries) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    for (const [language, pkg] of Object.entries(entries))
      await store.put("packages", language, pkg);
  }, pkgs);

const blockPackageDownloads = (page: Page) =>
  Promise.all([
    page.route("**/api/v1/manifest*", (route) => route.abort()),
    page.route("**/api/v1/packages*", (route) => route.abort()),
    page.route("**/api/v1/package-parts*", (route) => route.abort()),
  ]);

async function startLujvoDraft(page: Page) {
  page.on("dialog", (dialog) => void dialog.accept());
  await page.goto("/new/meaning");
  await page.getByRole("textbox", { name: "Meaning" }).fill("___ is a book.");
  await page.getByRole("button", { name: "New word" }).click();
  await page.getByRole("heading", { name: "What kind of word?" }).waitFor();
  await page.getByRole("radio", { name: /lujvo/ }).check();
  await page.getByRole("button", { name: "Build the lujvo" }).click();
  await page.getByRole("heading", { name: "Build the lujvo" }).waitFor();
}

test("ordinary part lookup shows every rafsi with no cap notice", async ({
  page,
}) => {
  await page.goto("/");
  const pkg = { snapshot, version: 2, entries: [wordEntry(0), wordEntry(1)] };
  await seedPackages(page, { en: pkg });
  await blockPackageDownloads(page);
  await startLujvoDraft(page);
  await page.getByLabel("Add a part").fill("broda");
  const item = page.getByRole("list", { name: "Matching words" });
  await expect(item).toContainText("rafsi raf0, raf1");
  await expect(item).not.toContainText("also:");
});

test("ordinary typed-word check lists every definition", async ({ page }) => {
  await page.goto("/");
  const pkg = { snapshot, version: 2, entries: [wordEntry(0), wordEntry(1)] };
  await seedPackages(page, { en: pkg });
  await blockPackageDownloads(page);
  await page.goto("/new/meaning?word=broda");
  await expect(page.getByText("Already exists:")).toBeVisible();
  await expect(page.getByRole("link", { name: "Definition 0 is a book." }))
    .toBeVisible();
  await expect(page.getByRole("link", { name: "Definition 1 is a book." }))
    .toBeVisible();
  await expect(
    page.getByRole("button", { name: /Show all \d+ definitions/ }),
  ).toHaveCount(0);
});

test("a 1001-entry word keeps every definition and claim through Add", async ({
  page,
}) => {
  await page.goto("/");
  const entries = Array.from({ length: 1001 }, (_, index) => wordEntry(index));
  await seedPackages(page, { en: { snapshot, version: 2, entries } });
  await blockPackageDownloads(page);
  await startLujvoDraft(page);
  await page.getByLabel("Add a part").fill("broda");
  const item = page.getByRole("list", { name: "Matching words" });
  // The display names the one definition it does not render.
  await expect(item).toContainText("also: 1 other matching definition");
  await expect(item).not.toContainText("raf1000");
  await page.getByRole("button", { name: "Add broda", exact: true }).click();
  // The action carries the whole set, as on main.
  const readAddedRow = () =>
    page.evaluate(async () => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const draft = (await new LocalStore().get("drafts", "current")) as {
        lujvo?: {
          components?: {
            definitions?: { event: string }[];
            claims?: { rafsi: string }[];
          }[];
        };
      };
      const row = draft?.lujvo?.components?.[0];
      return row
        ? {
            definitions: row.definitions?.length ?? 0,
            claims: row.claims?.length ?? 0,
            last: row.definitions?.[row.definitions.length - 1]?.event ?? null,
            rafsi: (row.claims ?? []).map((claim) => claim.rafsi),
          }
        : null;
    });
  await expect
    .poll(async () => (await readAddedRow())?.definitions ?? 0, {
      timeout: 30000,
    })
    .toBe(1001);
  const state = (await readAddedRow()) as {
    definitions: number;
    claims: number;
    last: string;
    rafsi: string[];
  };
  expect(state.definitions).toBe(1001);
  expect(state.claims).toBe(1001);
  expect(state.last).toBe(
    "jve1:" + (1001).toString(16).padStart(64, "0"),
  );
  expect(state.rafsi).toContain("raf1000");
  expect(state.rafsi).toHaveLength(1001);
});

test("the typed-word check caps a 1001-definition word with show-all", async ({
  page,
}) => {
  await page.goto("/");
  const entries = Array.from({ length: 1001 }, (_, index) => wordEntry(index));
  await seedPackages(page, { en: { snapshot, version: 2, entries } });
  await blockPackageDownloads(page);
  await page.goto("/new/meaning?word=broda");
  await expect(page.getByText("Already exists:")).toBeVisible();
  const rows = page.getByRole("link", { name: /is a book\./ });
  await expect(rows).toHaveCount(100);
  const showAll = page.getByRole("button", {
    name: "Show all 1001 definitions",
  });
  await expect(showAll).toBeVisible();
  await showAll.click();
  await expect(rows).toHaveCount(1001);
  await expect(
    page.getByRole("link", { name: "Definition 1000 is a book." }),
  ).toBeVisible();
});

test("exactly 1000 rafsi rows show no limited notice", async ({ page }) => {
  await page.goto("/");
  // One word with exactly 1,000 distinct retained rafsi, plus a quiet
  // French package that contributes no novel spelling.
  const enEntries = Array.from({ length: 16 }, (_, index) => {
    const start = index * 64;
    const count = index < 15 ? 64 : 40;
    return {
      ...wordEntry(index),
      event: "jve1:" + (index + 1).toString(16).padStart(64, "0"),
      rafsi: Array.from({ length: count }, (_, j) => `raf${start + j}`),
    };
  });
  const frEntry = {
    ...wordEntry(0, "brode"),
    language: "fr",
    event: "jve1:" + "f".repeat(64),
    rafsi: ["zzz"],
  };
  await seedPackages(page, {
    en: { snapshot, version: 2, entries: enEntries },
    fr: { snapshot, version: 2, entries: [frEntry] },
  });
  await blockPackageDownloads(page);
  const words = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { wordsWithRafsi } = await import(String("/src/pages/rafsi.ts"));
    const store = new LocalStore();
    const app = {
      session: {
        preferences: { definitionLanguage: "en" },
        storageAvailable: true,
      },
      store,
    };
    const found = await wordsWithRafsi(
      app as never,
      "raf*",
      new AbortController().signal,
    );
    return {
      rows: found.length,
      limited: found.limited,
      first: found[0]?.rafsi ?? null,
      last: found[found.length - 1]?.rafsi ?? null,
    };
  });
  expect(words.rows).toBe(1000);
  expect(words.limited).toBe(false);
  expect(words.first).toBe("raf0");
  expect(words.last).toBe("raf999");
  await page.goto(`/rafsi/${encodeURIComponent("raf*")}`);
  await expect(
    page.getByText("Rafsi coverage is limited.", { exact: false }),
  ).toHaveCount(0);
});
