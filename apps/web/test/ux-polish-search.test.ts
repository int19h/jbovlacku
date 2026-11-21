import { test, expect } from "@playwright/test";

test("local rows keep signed preview text literal and hide the unavailable status", async ({
  page,
}) => {
  // Signed text is shown literally. TeX, wiki quotes, Lojban apostrophes,
  // dollar amounts, and underscores all stay exactly as stored.
  const literal =
    "$z_1$, more than ``{ko}'' and ''ba'e'' with $5 to $10 at file_2.txt needle";
  await page.goto("/");
  await page.evaluate(async (plain_text) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    await new LocalStore().put("packages", "en", {
      snapshot: "sha256:" + "d".repeat(64),
      entries: [
        {
          event: "jve1:" + "1".repeat(64),
          word: { language: "jbo", spelling: "broda" },
          language: "en",
          glosses: [{ language: "en", text: "needle", sense: null }],
          plain_text,
          classification: { kind: "gismu", selmaho: [] },
          body: null,
        },
      ],
    });
  }, literal);
  await page.goto("/search?q=needle&lang=en");
  const results = page.getByRole("region", { name: "Search results" });
  await expect(results.locator("article")).toHaveCount(1);
  await expect(results.locator("article p.text")).toHaveText(literal);
  await expect(results.getByText("status: unavailable")).toHaveCount(0);
  // The score stays an accessible unavailable value, never a fake zero.
  await expect(
    results.getByRole("img", { name: "Score unavailable" }),
  ).toHaveCount(1);
});

test("a slow remote search shows its groups and Searching status", async ({
  page,
}) => {
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/v1/search?**", async (route) => {
    await held;
    await route.continue();
  });
  await page.goto("/search?q=cukta&lang=en");
  const results = page.getByRole("region", { name: "Search results" });
  await expect(results.getByText("Searching…").first()).toBeVisible();
  await expect(
    results.getByRole("heading", { name: "Lojban words" }),
  ).toBeVisible();
  release();
  await expect(results.locator("article").first()).toBeVisible();
});

test("a slow Settings load shows Loading instead of only the heading", async ({
  page,
}) => {
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/v1/manifest", async (route) => {
    await held;
    await route.continue();
  });
  await page.goto("/preferences");
  await expect(page.getByText("Loading…", { exact: true })).toBeVisible();
  release();
  await expect(
    page.getByLabel("Definition language", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Loading…", { exact: true })).toHaveCount(0);
});

test("a 503 for both groups offers one Retry search button", async ({
  page,
}) => {
  await page.route("**/api/v1/search?**", (route) =>
    route.fulfill({
      status: 503,
      headers: { "Retry-After": "1" },
      json: {
        code: "search_busy",
        message: "Pattern search is busy. Try again shortly.",
        event: null,
        field: null,
      },
    }),
  );
  await page.goto("/search?q=klama&lang=en");
  const main = page.locator("main");
  await expect(
    main.getByRole("button", { name: "Retry search", exact: true }),
  ).toHaveCount(1);
  await expect(main.locator(".read-error")).toHaveCount(2);
  // Both groups fail, so Definitions comes first in reading order even
  // though the Lojban group fails first. The reader meets the button with
  // the first error.
  const results = page.getByRole("region", { name: "Search results" });
  const firstFailed = results.locator("section:has(.read-error)").first();
  await expect(firstFailed.locator("h2")).toHaveText(/^Definitions/);
  await expect(
    firstFailed.getByRole("button", { name: "Retry search", exact: true }),
  ).toHaveCount(1);
});

test("a failed Settings storage read ends the Loading note", async ({
  page,
}) => {
  // Make every getAllKeys request on the packages store fail, as an
  // IndexedDB read error would.
  await page.addInitScript(() => {
    const original = IDBObjectStore.prototype.getAllKeys;
    IDBObjectStore.prototype.getAllKeys = function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore["getAllKeys"]>
    ) {
      if (this.name !== "packages") return original.apply(this, args);
      const request = {
        error: new Error("Storage read failed in this test."),
        onsuccess: null as null | (() => void),
        onerror: null as null | (() => void),
      };
      setTimeout(() => request.onerror?.(), 0);
      return request as unknown as IDBRequest<IDBValidKey[]>;
    };
  });
  await page.goto("/preferences");
  await expect(
    page.getByText("Storage read failed in this test.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Loading…", { exact: true })).toHaveCount(0);
});

test("pagination labels use the same case", async ({ page }) => {
  const snapshot = "sha256:" + "a".repeat(64);
  const view = "jve1:" + "b".repeat(64);
  const hit = (index: number) => {
    const event = "jve1:" + index.toString(16).padStart(64, "0");
    return {
      word: { language: "jbo", spelling: `fixture-${index}` },
      word_id: "jvw1:" + index.toString(16).padStart(64, "0"),
      definitions: [event],
      match: "token",
      preview: {
        event,
        word_kind: "gismu",
        plain_text: `Preview ${index}`,
        status: "active",
      },
    };
  };
  await page.route("**/api/v1/search?**", (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("group") === "lojban")
      return route.fulfill({ json: { snapshot, view, hits: [], next: null } });
    const after = url.searchParams.get("after");
    return route.fulfill({
      json: {
        snapshot,
        view,
        hits: Array.from({ length: after ? 3 : 20 }, (_, index) =>
          hit(index + (after ? 21 : 1)),
        ),
        next: after ? null : "next-page",
      },
    });
  });
  await page.route("**/api/v1/words/**", (route) =>
    route.fulfill({
      status: 503,
      json: {
        code: "resource_unavailable",
        message: "unavailable",
        event: null,
        field: null,
      },
    }),
  );
  await page.route("**/api/v1/events/**", (route) =>
    route.fulfill({
      status: 404,
      json: { code: "missing", message: "missing", event: null, field: null },
    }),
  );
  await page.goto("/search?q=fixture&lang=en");
  const results = page.getByRole("region", { name: "Search results" });
  await expect(results.locator("article")).toHaveCount(20);
  await expect(
    page.getByRole("button", { name: "Show more", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Show all", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "show all", exact: true }),
  ).toHaveCount(0);
});

test("language options use readable names, not raw tags", async ({ page }) => {
  const tags = [
    "en",
    "jbo",
    "tlh",
    "tpi",
    "tok",
    "en-simple",
    "fr-facile",
    "art-loglan",
    "art-picture",
    "art-guaspi",
    "test",
  ];
  await page.route("**/api/v1/manifest", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.packages = tags.map((language) => ({ ...json.packages[0], language }));
    await route.fulfill({ response, json });
  });
  await page.goto("/search?lang=en");
  const languages = page.getByRole("combobox", {
    name: "Definition language",
    exact: true,
  });
  await expect(languages.locator("option")).toHaveText([
    "Guaspi",
    "Loglan",
    "Picture language",
    "English",
    "Simple English",
    "Easy French",
    "Lojban",
    "Klingon",
    "Toki Pona",
    "Tok Pisin",
  ]);
  await page.goto("/preferences");
  await expect(
    page.getByLabel("Definition language", { exact: true }).locator("option"),
  ).toHaveText([
    "Guaspi",
    "Loglan",
    "Picture language",
    "English",
    "Simple English",
    "Easy French",
    "Lojban",
    "Klingon",
    "Toki Pona",
    "Tok Pisin",
  ]);
});

test("the rafsi page labels its pagination Show all", async ({ page }) => {
  const entries = Array.from({ length: 25 }, (_, index) => ({
    event: "jve1:" + (index + 1).toString(16).padStart(64, "0"),
    word: { language: "jbo", spelling: "broda" },
    language: "en",
    glosses: [{ language: "en", text: "book", sense: null }],
    plain_text: `Definition ${index} is a book.`,
    classification: { kind: "gismu", selmaho: [] },
    body: null,
    issuer: "ed25519:" + "a".repeat(64),
    notes: false,
    rafsi: [`raf${index}`],
    rafsi_complete: true,
    attribution: null,
  }));
  await page.goto("/");
  await page.evaluate(async (entries) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    await new LocalStore().put("packages", "en", {
      snapshot: "sha256:" + "b".repeat(64),
      version: 2,
      entries,
    });
  }, entries);
  await Promise.all([
    page.route("**/api/v1/manifest*", (route) => route.abort()),
    page.route("**/api/v1/packages*", (route) => route.abort()),
    page.route("**/api/v1/package-parts*", (route) => route.abort()),
  ]);
  await page.goto(`/rafsi/${encodeURIComponent("raf*")}`);
  await expect(
    page.getByRole("button", { name: "Show all", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "show all", exact: true }),
  ).toHaveCount(0);
});
