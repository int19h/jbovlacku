import { test, expect } from "@playwright/test";
import { corePath, fixture } from "./helpers.ts";

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
    const source = page.locator("details").filter({
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
      // A large rational score must fit on one line beside the attribution too.
      await row.locator(".score").evaluate((node) => {
        node.textContent = "1234567/32";
      });
      expect((await row.locator(".score").boundingBox())!.height).toBeLessThan(
        44,
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: test.info().outputPath(`cards-score-stress-${mode}-${width}.png`),
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
  const tags = ["en", "jbo", "tlh", "tpi", "art-guaspi", "test"];
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
  const before = (await (await page.request.get("/api/v1/manifest")).json())
    .packages;
  const synthetic = await page.evaluate(
    async ({ corePath, tags }) => {
      const core = await import(corePath);
      await core.initializeCore();
      const word = { language: "jbo", spelling: "rerlanguas" };
      const records = tags.map((language, index) =>
        core.createEvent(
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
        ),
      );
      return { word, id: core.wordId(word), records };
    },
    { corePath, tags },
  );
  const base = await (
    await page.request.get(
      `/api/v1/words/${encodeURIComponent(fixture().words.cukta)}`,
    )
  ).json();
  const ids = synthetic.records.map((record: any) => record.envelope.id);
  await page.route(
    `**/api/v1/words/${encodeURIComponent(synthetic.id)}*`,
    (route) =>
      route.fulfill({
        json: {
          ...base,
          word: synthetic.word,
          definitions: ids,
          rafsi: [],
          assignments: [],
          scores: [],
          layers: [],
          calculation: null,
          unavailable_scores: ids,
          statuses: ids.map((event: string) => ({ event, state: "active" })),
        },
      }),
  );
  await page.route("**/api/v1/events/**", (route) => {
    const record = synthetic.records.find((record: any) =>
      decodeURIComponent(route.request().url()).includes(record.envelope.id),
    );
    return record ? route.fulfill({ json: record.envelope }) : route.fallback();
  });
  await page.route("**/api/v1/bodies/**", (route) => {
    const record = synthetic.records.find((record: any) =>
      decodeURIComponent(route.request().url()).includes(
        record.envelope.header.content.hash,
      ),
    );
    return record ? route.fulfill({ json: record.body }) : route.fallback();
  });
  await page.goto(`/word/${encodeURIComponent(synthetic.id)}?lang=en`);
  const tabs = page.getByRole("navigation", { name: "Definition language" });
  for (const name of ["English", "Lojban", "Klingon", "Tok Pisin", "Guaspi"])
    await expect(
      tabs.getByRole("link", { name: new RegExp(`^${name} `) }),
    ).toBeVisible();
  await expect(tabs.getByRole("link", { name: /^test / })).toHaveCount(0);
  await page.goto(`/word/${encodeURIComponent(synthetic.id)}?lang=test`);
  await expect(tabs.getByRole("link", { name: /^test / })).toHaveAttribute(
    "aria-current",
    "true",
  );
  expect(
    (await (await page.request.get("/api/v1/manifest")).json()).packages,
  ).toEqual(before);
});

test("personal word status stays visible without snapshot identifiers", async ({
  page,
}) => {
  await page.goto("/trust");
  await page
    .getByRole("radio", { name: "Mine: site view + my choices" })
    .check();
  await page.goto("/word/cukta?lang=en");
  const panel = page.getByRole("region", {
    name: "Personal view",
    exact: true,
  });
  await expect(panel).toContainText(
    /Personal view calculated in this browser from \d+ verified records/,
    { timeout: 60000 },
  );
  await expect(panel).not.toContainText(/snapshot [0-9a-f]{12}/);
  await expect(
    panel.getByRole("button", { name: "Recompute from records", exact: true }),
  ).toBeVisible();
  const source = page.locator("details.word-source");
  await expect(source.getByText(/^Snapshot /)).toBeHidden();
  await source.locator(":scope > summary").click();
  await expect(source.getByText(/^Snapshot /)).toBeVisible();
});

test("a zero reviewer count has a neutral score disclosure label", async ({
  page,
}) => {
  await page.goto("/about");
  await page.evaluate(async () => {
    const { scoreDetails } = await import(
      String("/src/components/judgment.ts")
    );
    const zero = { numerator: "0", denominator: "1" };
    document.querySelector("main")!.append(
      scoreDetails(
        {} as any,
        { id: "test", word: null, describe: () => "test" },
        {
          unavailable: false,
          score: {
            support: [zero, zero],
            opposition: [zero, zero],
            net: [zero, zero],
            direct_reviewers: 0,
          },
        } as any,
      ),
    );
  });
  await expect(page.locator("details.judgment-details summary")).toHaveText(
    "Score details",
  );
  await expect(
    page.locator("details.judgment-details summary"),
  ).not.toContainText("0 reviewers");
});

test("the active hidden language stays selected in search and Settings", async ({
  page,
}) => {
  const requested: string[] = [];
  await page.route("**/api/v1/search?**", (route) => {
    requested.push(
      new URL(route.request().url()).searchParams.get("language") ?? "",
    );
    return route.fallback();
  });
  await page.goto("/search?q=book&lang=test");
  const language = page.getByRole("combobox", {
    name: "Definition language",
    exact: true,
  });
  await expect(language).toHaveValue("test");
  await expect(language.locator("option:checked")).toHaveText("test");
  await expect.poll(() => requested.length).toBeGreaterThanOrEqual(2);
  expect(requested.every((tag) => tag === "test")).toBe(true);
  await page.goto("/about");
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    await new LocalStore().setPreferences({ definitionLanguage: "test" });
  });
  await page.reload();
  await page.goto("/preferences");
  await expect(
    page.getByLabel("Definition language", { exact: true }),
  ).toHaveValue("test");
  await page.goto("/search");
  await expect(language).toHaveValue("test");
});
