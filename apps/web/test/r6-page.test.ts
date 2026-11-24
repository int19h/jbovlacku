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
  rafsi: [`raf${index % 63}`],
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
  entries[1000].rafsi = ["raf1000"];
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
  await expect
    .poll(async () => (await readAddedRows(page)).length, {
      timeout: 30000,
    })
    .toBe(1);
  const state = ((await readAddedRows(page))[0] ?? null) as {
    definitions: number;
    claims: number;
    last: string;
    rafsi: string[];
  };
  expect(state.definitions).toBe(1001);
  expect(state.claims).toBe(64);
  expect(state.last).toBe(
    "jve1:" + (1001).toString(16).padStart(64, "0"),
  );
  expect(state.rafsi).toContain("raf1000");
  expect(state.rafsi).toHaveLength(64);
});

async function readAddedRows(page: Page) {
  return page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const draft = (await new LocalStore().get("drafts", "current")) as {
      lujvo?: {
        components?: {
          spelling?: string;
          definitions?: { event: string }[];
          claims?: { rafsi: string }[];
        }[];
      };
    };
    return (draft?.lujvo?.components ?? []).map((row) => ({
      spelling: row.spelling ?? null,
      definitions: row.definitions?.length ?? 0,
      claims: row.claims?.length ?? 0,
      last: row.definitions?.[row.definitions.length - 1]?.event ?? null,
      rafsi: (row.claims ?? []).map((claim) => claim.rafsi),
    }));
  });
}

test("adjacent Adds keep their click order", async ({ page }) => {
  await page.goto("/");
  const broda = Array.from({ length: 1001 }, (_, index) => wordEntry(index));
  const brode = {
    ...wordEntry(0, "brode"),
    event: "jve1:" + (1002).toString(16).padStart(64, "0"),
    plain_text: "Definition 0 is a brode book.",
    rafsi: ["brode"],
  };
  await seedPackages(page, {
    en: { snapshot, version: 2, entries: [...broda, brode] },
  });
  await blockPackageDownloads(page);
  await startLujvoDraft(page);
  await page.getByLabel("Add a part").fill("brod");
  await page.getByRole("button", { name: "Add brode", exact: true }).waitFor();
  // Both Adds dispatch in one task: a synchronous Add keeps click order,
  // while a yielding one lets the second Add overtake the first.
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button[aria-label^="Add "]')];
    const broda = buttons.find(
      (button) => button.getAttribute("aria-label") === "Add broda",
    );
    const brode = buttons.find(
      (button) => button.getAttribute("aria-label") === "Add brode",
    );
    if (!(broda instanceof HTMLButtonElement && brode instanceof HTMLButtonElement))
      throw new Error("missing Add buttons");
    broda.click();
    brode.click();
  });
  let rows: { spelling: string | null; definitions: number }[] = [];
  await expect
    .poll(async () => {
      rows = await readAddedRows(page);
      return rows.length;
    })
    .toBe(2);
  expect(rows.map((row) => row.spelling)).toEqual(["broda", "brode"]);
  expect(rows.map((row) => row.definitions)).toEqual([1001, 1]);
});

test("navigating away right after Add keeps the component", async ({
  page,
}) => {
  await page.goto("/");
  const entries = Array.from({ length: 10001 }, (_, index) =>
    wordEntry(index),
  );
  await seedPackages(page, { en: { snapshot, version: 2, entries } });
  await blockPackageDownloads(page);
  await startLujvoDraft(page);
  await page.getByLabel("Add a part").fill("broda");
  await page.getByRole("button", { name: "Add broda", exact: true }).waitFor();
  // The Add and the in-app navigation dispatch in one task: a synchronous
  // Add is already pushed when the router guard flushes, while a yielding
  // one is detached first and never saved.
  await page.evaluate(() => {
    const add = document.querySelector('button[aria-label="Add broda"]');
    const home = document.querySelector('header a[href="/new/meaning"]');
    if (!(add instanceof HTMLButtonElement && home instanceof HTMLAnchorElement))
      throw new Error("missing Add button or header link");
    add.click();
    home.click();
  });
  await expect(page).toHaveURL(/\/new\/meaning$/);
  await expect
    .poll(async () => (await readAddedRows(page)).length, { timeout: 15000 })
    .toBe(1);
  const rows = await readAddedRows(page);
  expect(rows[0]?.spelling).toBe("broda");
  expect(rows[0]?.definitions).toBe(10001);
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
  const list = page.locator(
    'div[aria-label="Typed word"] ul.small li a',
  );
  await expect(list).toHaveCount(100);
  const showAll = page.getByRole("button", {
    name: "Show all 1001 definitions",
  });
  await expect(showAll).toBeVisible();
  // Keyboard activation moves focus to the first new row.
  await showAll.focus();
  await page.keyboard.press("Enter");
  await expect(list).toHaveCount(1001, { timeout: 60000 });
  await expect(
    page.getByRole("link", { name: "Definition 1000 is a book." }),
  ).toBeVisible();
  const focused = await page.evaluate(() => ({
    tag: document.activeElement?.tagName ?? null,
    text: document.activeElement?.textContent ?? null,
  }));
  // Each rendered batch focuses its first new row, including the final one.
  expect(focused.tag).toBe("LI");
  expect(focused.text).toBe("Definition 1000 is a book.");
  const box = await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    if (!active) return null;
    const rect = active.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, height: window.innerHeight };
  });
  // The final focus target scrolls into view instead of staying far below
  // the viewport.
  expect(box).not.toBeNull();
  expect(box!.top).toBeGreaterThanOrEqual(0);
  // A one-pixel tolerance absorbs sub-pixel rounding at the viewport edge.
  expect(box!.bottom).toBeLessThanOrEqual(box!.height + 1);
});

test("the typed-word check pages a 100000-definition word in batches", async ({
  page,
}) => {
  // Rendering all batches can take several minutes on a shared runner.
  test.setTimeout(360000);
  await page.goto("/");
  await page.evaluate(
    async ({ snapshot, issuer }) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const entries = [];
      for (let index = 0; index < 100000; index += 1)
        entries.push({
          event: "jve1:" + (index + 1).toString(16).padStart(64, "0"),
          word: { language: "jbo", spelling: "broda" },
          language: "en",
          glosses: [{ language: "en", text: "book", sense: null }],
          plain_text: `Definition ${index} is a book.`,
          classification: { kind: "gismu", selmaho: [] },
          body: null,
          issuer,
          notes: false,
          rafsi: [`raf${index % 63}`],
          rafsi_complete: true,
          attribution: null,
        });
      await new LocalStore().put("packages", "en", {
        snapshot,
        version: 2,
        entries,
      });
    },
    { snapshot, issuer },
  );
  await blockPackageDownloads(page);
  await page.goto("/new/meaning?word=broda");
  await expect(page.getByText("Already exists:")).toBeVisible();
  const list = page.locator('div[aria-label="Typed word"] ul.small li a');
  // Only the rendered rows are built, no matter how many entries the word
  // carries.
  await expect(list).toHaveCount(100);
  const showAll = page.getByRole("button", {
    name: "Show all 100000 definitions",
  });
  await expect(showAll).toBeVisible();
  await showAll.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () =>
      document.querySelectorAll('div[aria-label="Typed word"] ul.small li a')
        .length === 100000,
    null,
    { timeout: 300000 },
  );
  await expect(list).toHaveCount(100000);
  await expect(
    page.getByRole("link", { name: "Definition 99999 is a book." }),
  ).toBeVisible();
  const focused = await page.evaluate(() => ({
    tag: document.activeElement?.tagName ?? null,
    text: document.activeElement?.textContent ?? null,
  }));
  // Each rendered batch focuses its first new row, including the final one.
  expect(focused.tag).toBe("LI");
  expect(focused.text).toBe("Definition 99950 is a book.");
  const box = await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    if (!active) return null;
    const rect = active.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, height: window.innerHeight };
  });
  expect(box).not.toBeNull();
  expect(box!.top).toBeGreaterThanOrEqual(0);
  // A one-pixel tolerance absorbs sub-pixel rounding at the viewport edge.
  expect(box!.bottom).toBeLessThanOrEqual(box!.height + 1);
});

test("a later language's rafsi row replaces the earlier one", async ({
  page,
}) => {
  await page.goto("/");
  // The same word and rafsi in English and French: the French row wins, as
  // on main, without counting as a new row against the cap.
  const broda = (language: string) => ({
    ...wordEntry(0),
    language,
    rafsi: ["bau"],
  });
  await seedPackages(page, {
    en: { snapshot, version: 2, entries: [broda("en")] },
    fr: { snapshot, version: 2, entries: [broda("fr")] },
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
      "bau",
      new AbortController().signal,
    );
    return found.map(
      (row: { spelling: string; language: string; rafsi: string }) => ({
        spelling: row.spelling,
        language: row.language,
        rafsi: row.rafsi,
      }),
    );
  });
  expect(words).toEqual([{ spelling: "broda", language: "fr", rafsi: "bau" }]);
});

test("exactly 1000 rafsi rows show no limited notice", async ({ page }) => {
  await page.goto("/");
  // The English package has 1,000 pairs within the per-word limit.
  // The French package adds no matching pair.
  const enEntries = Array.from({ length: 16 }, (_, index) => {
    const start = index * 64;
    const count = index < 15 ? 64 : 40;
    const spelling =
      "b" + "aeio"[Math.floor(index / 4)] + "bdgj"[index % 4] + "ar";
    return {
      ...wordEntry(index, spelling),
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
