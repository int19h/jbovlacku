import { test, expect } from "@playwright/test";

test("local rows read TeX and wiki previews as plain text and hide the unavailable status", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    await new LocalStore().put("packages", "en", {
      snapshot: "sha256:" + "d".repeat(64),
      entries: [
        {
          event: "jve1:" + "1".repeat(64),
          word: { language: "jbo", spelling: "broda" },
          language: "en",
          glosses: [{ language: "en", text: "needle", sense: null }],
          plain_text: "$z_1$, more than $z_2$ with ''kla'' and $x_{3}$ needle",
          classification: { kind: "gismu", selmaho: [] },
          body: null,
        },
      ],
    });
  });
  await page.goto("/search?q=needle&lang=en");
  const results = page.getByRole("region", { name: "Search results" });
  await expect(results.locator("article")).toHaveCount(1);
  await expect(
    results.getByText("z₁, more than z₂ with kla and x₃ needle", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(results.getByText("status: unavailable")).toHaveCount(0);
  await expect(results.getByText("$z_1$")).toHaveCount(0);
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
    "Picture",
    "English",
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
    "Picture",
    "English",
    "Lojban",
    "Klingon",
    "Toki Pona",
    "Tok Pisin",
  ]);
});
