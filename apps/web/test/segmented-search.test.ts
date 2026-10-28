import { test, expect } from "@playwright/test";
import { corePath } from "./helpers.ts";

test("local sequences share rank across spellings, fall back to query words, and page without uploading the query", async ({
  page,
}) => {
  await page.goto("/");
  const expected = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    await core.initializeCore();
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const spellings = [
      "i",
      "je",
      "bo",
      "klama",
      "tai",
      "a",
      "dján",
      "djan",
      "ibo",
      "iboku",
      "iseri'abo",
      "mibo",
      ...Array.from(
        { length: 35 },
        (_, index) => "i" + "se".repeat(index + 2) + "bo",
      ),
    ];
    const entries = spellings.map((spelling, index) => ({
      event: "jve1:" + (index + 1).toString(16).padStart(64, "0"),
      word: { language: "jbo", spelling },
      language: "en",
      glosses: [],
      plain_text: "A synthetic definition.",
      classification: { kind: "cmavo", selmaho: [] },
      body: null,
    }));
    await new LocalStore().put("packages", "en", {
      snapshot: "sha256:" + "d".repeat(64),
      entries,
    });
    return [
      "ibo",
      "iboku",
      ...entries
        .filter(
          (row) =>
            row.word.spelling === "iseri'abo" ||
            /^i(?:se){2,}bo$/.test(row.word.spelling),
        )
        .sort((a, b) =>
          core.wordId(a.word).localeCompare(core.wordId(b.word), "en"),
        )
        .map((row) => row.word.spelling),
    ];
  }, corePath);
  const forbidden: string[] = [];
  await page.route("**/api/v1/**", (route) => {
    const url = new URL(route.request().url());
    if (
      url.pathname === "/api/v1/capabilities" &&
      !url.search &&
      route.request().method() === "GET"
    )
      return route.continue();
    forbidden.push(route.request().url());
    return route.abort();
  });
  const results = page.getByRole("region", { name: "Search results" });
  for (const query of [
    "i seri'a bo",
    "ise ri'abo",
    "iseri'abo",
    "I SE RÍ’ABO",
    "mi klama i seri'a bo",
  ]) {
    await page.goto("/search?" + new URLSearchParams({ q: query, lang: "en" }));
    await expect(results.locator("article .hw")).toHaveText(["iseri'abo"]);
  }
  for (const [query, spellings] of [
    ["ijebo", ["i", "je", "bo"]],
    ["taia", ["tai", "a"]],
    ["i klama i", ["i", "klama"]],
    ["DJÁN", ["dján"]],
    [[...Array(99).fill("mi"), "bo"].join(" "), ["mibo"]],
  ] as [string, string[]][]) {
    await page.goto("/search?" + new URLSearchParams({ q: query, lang: "en" }));
    await expect(results.locator("article .hw")).toHaveText(spellings);
  }
  await page.goto("/search?q=i%20bo&lang=en");
  await expect(results.locator("article")).toHaveCount(20);
  expect(await results.locator("article .hw").allTextContents()).toEqual(
    expected.slice(0, 20),
  );
  await page.getByRole("button", { name: "show all" }).click();
  await expect(results.locator("article .hw")).toHaveText(expected);
  await expect(page.getByRole("button", { name: "show all" })).toHaveCount(0);
  await page.getByRole("link", { name: "Add a word" }).click();
  await page.goBack();
  await expect(results.locator("article .hw")).toHaveText(expected);
  await page.goto(
    "/search?" + new URLSearchParams({ q: "i".repeat(129), lang: "en" }),
  );
  await expect(page.locator("main > .notice")).toContainText(
    "Word segmentation reached a limit.",
  );
  expect(forbidden).toEqual([]);
});

test("remote sequence classes and a limited-segmentation notice survive pagination and Back", async ({
  page,
}) => {
  const snapshot = "sha256:" + "a".repeat(64);
  const view = "jve1:" + "b".repeat(64);
  const hits = [
    "sequence-exact",
    "sequence-contiguous",
    "sequence-subsequence",
    "component",
  ].map((match, index) => ({
    word: {
      language: "jbo",
      spelling: ["ibo", "iboku", "iseri'abo", "i"][index],
    },
    word_id: "jvw1:" + (index + 1).toString(16).padStart(64, "0"),
    definitions: ["jve1:" + (index + 1).toString(16).padStart(64, "0")],
    match,
  }));
  let requests = 0;
  await page.route("**/api/v1/search?**", (route) => {
    requests++;
    const later = new URL(route.request().url()).searchParams.has("after");
    return route.fulfill({
      json: {
        snapshot,
        view,
        hits: later ? hits.slice(2) : hits.slice(0, 2),
        next: later ? null : "sequence-page",
        segmentation: "limited",
      },
    });
  });
  await page.route("**/api/v1/words/**", (route) => route.abort());
  await page.route("**/api/v1/events/**", (route) => route.abort());
  await page.goto("/search?q=i%20bo&lang=en");
  const results = page.getByRole("region", { name: "Search results" });
  const notice = page.locator("main > .notice");
  await expect(results.locator("article .hw")).toHaveText(["ibo", "iboku"]);
  await expect(notice).toContainText("Word segmentation reached a limit.");
  await page.getByRole("button", { name: "show all" }).click();
  await expect(results.locator("article .hw")).toHaveText([
    "ibo",
    "iboku",
    "iseri'abo",
    "i",
  ]);
  await expect(notice).toBeVisible();
  await page.getByRole("link", { name: "Settings" }).click();
  await page.goBack();
  await expect(results.locator("article")).toHaveCount(4);
  await expect(notice).toBeVisible();
  expect(requests).toBe(2);
});
