import { test, expect } from "@playwright/test";
import { corePath } from "./helpers.ts";

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

for (const failure of ["offline", "server error"] as const)
  test(`failed ${failure} searches use neutral source wording`, async ({
    page,
  }) => {
    await page.route("**/api/v1/search?**", (route) =>
      failure === "offline"
        ? route.abort("internetdisconnected")
        : route.fulfill({
            status: 503,
            json: { message: "Synthetic search failure." },
          }),
    );
    await page.goto("/search?q=book&lang=en");
    await expect(
      page.getByRole("region", { name: "Search results", exact: true }),
    ).toHaveAttribute("aria-busy", "false");
    const source = page
      .locator("details")
      .filter({
        has: page.getByText("Search source and snapshot", { exact: true }),
      });
    await source.locator("summary").click();
    await expect(source).toContainText(
      `Search server: ${new URL(page.url()).host}.`,
    );
    await expect(source).not.toContainText("Searched on");
    await expect(
      page.getByText(
        `Search sends this query to ${new URL(page.url()).host}.`,
        { exact: true },
      ),
    ).toBeVisible();
  });

for (const width of [360, 1024])
  for (const mode of ["local", "remote"] as const)
    test(`${mode} search cards keep votes beside attribution at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto("/preferences");
      if (mode === "local") {
        await page
          .getByRole("button", { name: "Download", exact: true })
          .click();
        await expect(page.locator("#app > [role=status]")).toContainText(
          "The English search package is saved in this browser.",
        );
      }
      await page.evaluate(async (mode) => {
        const { LocalStore } = await import(String("/src/data/store.ts"));
        await new LocalStore().setPreferences({ searchMode: mode });
      }, mode);
      await page.goto("/search?q=book&lang=en");
      const row = page
        .locator("article.hit")
        .filter({ has: page.getByRole("link", { name: "cukta", exact: true }) })
        .first();
      await expect(row.locator(".attribution-line")).not.toBeEmpty();
      await expect(
        row.getByRole("button", { name: "Endorse", exact: true }),
      ).toBeVisible();
      await expect(
        row.getByRole("button", { name: "Oppose", exact: true }),
      ).toBeVisible();
      await expect(page.locator("article.hit .judgment-details")).toHaveCount(
        0,
      );
      const geometry = await row.evaluate((node) => {
        const line = node.querySelector(".line3")!.getBoundingClientRect();
        const author = node
          .querySelector(".hit-attribution")!
          .getBoundingClientRect();
        const votes = node
          .querySelector(".hit-judgment")!
          .getBoundingClientRect();
        return {
          right: Math.abs(line.right - votes.right),
          top: Math.abs(author.top - votes.top),
          fits: document.documentElement.scrollWidth <= innerWidth,
        };
      });
      expect(geometry.right).toBeLessThan(2);
      expect(geometry.top).toBeLessThan(2);
      expect(geometry.fits).toBe(true);
      await page.screenshot({
        path: test.info().outputPath(`cards-${mode}-${width}.png`),
        fullPage: true,
      });
    });

test("word diagnostics open by keyboard below definitions", async ({
  page,
}) => {
  await page.goto("/word/cukta?lang=en");
  const source = page.locator("details.word-source");
  const snapshot = source.getByText(/^Snapshot /);
  await expect(page.locator("article.definition").first()).toBeVisible();
  await expect(snapshot).toBeHidden();
  await expect(
    source.getByText("Check the scores locally", { exact: true }),
  ).toBeHidden();
  expect(
    await source.evaluate((node) =>
      Boolean(
        node.compareDocumentPosition(
          document.querySelector("article.definition")!,
        ) & Node.DOCUMENT_POSITION_PRECEDING,
      ),
    ),
  ).toBe(true);
  await source.locator(":scope > summary").focus();
  await page.keyboard.press("Enter");
  await expect(snapshot).toBeVisible();
  await source.getByText("Check the scores locally", { exact: true }).click();
  await expect(
    source.getByRole("button", { name: "Recompute from records", exact: true }),
  ).toBeVisible();
});

test("reading language lists show names and hide the test tag", async ({
  page,
}) => {
  const tags = ["en", "jbo", "tlh", "tpi", "art-x-guaspi", "test"];
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
    "English",
    "Lojban",
    "Klingon",
    "Tok Pisin",
  ]);
  await page.goto("/preferences");
  await expect(
    page.getByLabel("Definition language", { exact: true }).locator("option"),
  ).toHaveText(["Guaspi", "English", "Lojban", "Klingon", "Tok Pisin"]);
  await page.goto("/about");
  await page.evaluate(
    async ({ corePath, tags }) => {
      const core = await import(corePath);
      await core.initializeCore();
      const { postEvent, getManifest } = await import(
        String("/src/data/api.ts")
      );
      const word = { language: "jbo", spelling: "broda" };
      for (const [index, language] of tags.entries()) {
        const event = core.createEvent(
          crypto.getRandomValues(new Uint8Array(32)),
          [],
          (index + 1).toString(16).padStart(32, "0"),
          {
            kind: "definition.publish",
            word: core.wordId(word),
            language,
            parents: [],
            origin: "native",
          },
          {
            word,
            language,
            text: [["A synthetic language-list definition."]],
            classification: { kind: "other" },
            license: { expression: "CC0-1.0" },
          },
        );
        await postEvent(JSON.stringify(event));
      }
      await getManifest({ fresh: true });
    },
    { corePath, tags },
  );
  await page.goto("/word/broda?lang=en");
  const tabs = page.getByRole("navigation", { name: "Definition language" });
  for (const name of ["English", "Lojban", "Klingon", "Tok Pisin", "Guaspi"])
    await expect(
      tabs.getByRole("link", { name: new RegExp(`^${name} `) }),
    ).toBeVisible();
  await expect(tabs.getByRole("link", { name: /^test / })).toHaveCount(0);
});
