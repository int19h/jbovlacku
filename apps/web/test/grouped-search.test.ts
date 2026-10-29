import { test, expect, type Page } from "@playwright/test";
import { corePath, fixture } from "./helpers.ts";

const group = (page: Page, name: string) =>
  page.getByRole("region", { name, exact: true });
async function localPackage(page: Page) {
  await page.goto("/");
  await expect(
    page.getByText("Type a word or a meaning to search.", { exact: true }),
  ).toBeVisible();
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const entries = [
      "se",
      "bo",
      ...Array.from(
        { length: 45 },
        (_, index) => "se".repeat(index + 2) + "bo",
      ),
    ].map((spelling, index) => ({
      event: "jve1:" + (index + 1).toString(16).padStart(64, "0"),
      word: { language: "jbo", spelling },
      language: "en",
      glosses: [{ language: "en", text: "se", sense: null }],
      plain_text: "A book uses se in its synthetic definition.",
      classification: { kind: "cmavo", selmaho: [] },
      body: null,
    }));
    await new LocalStore().put("packages", "en", {
      snapshot: "sha256:" + "a".repeat(64),
      entries,
    });
  });
}

test("one local box orders known Lojban and English queries and keeps group pages, Back, and keyboard structure", async ({
  page,
}) => {
  await localPackage(page);
  const requests: string[] = [];
  await page.route("**/api/v1/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/capabilities" && !url.search)
      return route.continue();
    requests.push(route.request().url());
    return route.abort();
  });
  await page.goto("/search?q=se&lang=en");
  await expect(page.locator("main h2")).toHaveText([
    "Lojban words",
    "Definitions",
  ]);
  const words = group(page, "Lojban words");
  const definitions = group(page, "Definitions");
  await expect(words.locator("article")).toHaveCount(20);
  await expect(definitions.locator("article")).toHaveCount(20);
  await expect(words.locator(".count")).toHaveText("20 Lojban results shown.");
  await expect(definitions.locator(".count")).toHaveAttribute(
    "aria-live",
    "polite",
  );
  await words.getByRole("button", { name: "Show more", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(words.locator("article")).toHaveCount(40);
  await expect(words.locator("article .hw").nth(20)).toBeFocused();
  await expect(definitions.locator("article")).toHaveCount(20);
  await words.getByRole("button", { name: "show all", exact: true }).click();
  await expect(words.locator("article")).toHaveCount(46);
  await definitions
    .getByRole("button", { name: "show all", exact: true })
    .click();
  await expect(definitions.locator("article")).toHaveCount(47);
  await page.getByRole("link", { name: "Add a word", exact: true }).click();
  await page.goBack();
  await expect(words.locator("article")).toHaveCount(46);
  await expect(definitions.locator("article")).toHaveCount(47);
  await page.goto("/search?q=book&lang=en");
  await expect(page.locator("main h2")).toHaveText([
    "Definitions",
    "Lojban words",
  ]);
  await expect(definitions.locator("article")).toHaveCount(20);
  await page.goto("/search?q=sei&lang=en");
  await expect(page.locator("main h2")).toHaveText([
    "Definitions",
    "Lojban words",
  ]);
  await page.goto("/search?q=se%20bo&lang=en");
  await expect(page.locator("main h2")).toHaveText([
    "Lojban words",
    "Definitions",
  ]);
  await page.goto("/search?q=se*&lang=en");
  await expect(page.getByRole("heading", { level: 2 })).toHaveText([
    "Lojban words",
  ]);
  expect(requests).toEqual([]);
});

test("remote groups use the server's known-word decision and keep independent results", async ({
  page,
}) => {
  for (const [query, order] of [
    ["cukta", ["Lojban words", "Definitions"]],
    ["cukta lo", ["Lojban words", "Definitions"]],
    ["book", ["Definitions", "Lojban words"]],
  ] as const) {
    await page.goto("/search?" + new URLSearchParams({ q: query, lang: "en" }));
    await expect(
      page.getByRole("region", { name: "Search results", exact: true }),
    ).toHaveAttribute("aria-busy", "false");
    await expect(page.getByRole("heading", { level: 2 })).toHaveText(order);
    await expect(
      group(page, query === "book" ? "Definitions" : "Lojban words")
        .locator("article")
        .first(),
    ).toBeVisible();
  }
});

async function meaningService(page: Page, count = 1) {
  await page.goto("/");
  const records = await page.evaluate(
    async ({ corePath, count }) => {
      const core = await import(corePath);
      await core.initializeCore();
      const seed = new Uint8Array(32).fill(59);
      return Array.from({ length: count }, (_, index) => {
        const word = { language: "jbo", spelling: "meaning" + index };
        const record = core.createEvent(
          seed,
          [],
          (index + 1).toString(16).padStart(32, "0"),
          {
            kind: "definition.publish",
            word: core.wordId(word),
            language: "en",
            parents: [],
            origin: "native",
          },
          {
            word,
            language: "en",
            text: [["A synthetic related definition."]],
            classification: { kind: "other" },
            license: { expression: "CC0-1.0" },
          },
        );
        return { ...record, word: core.wordId(word) };
      });
    },
    { corePath, count },
  );
  const state = {
    enabled: true,
    available: true,
    provider: "Synthetic Embedding Provider",
    profile: "sha256:" + "d".repeat(64),
    calls: [] as any[],
    fail: false,
  };
  await page.route("**/api/v1/capabilities", async (route) => {
    const response = await route.fetch();
    const caps = await response.json();
    caps.features.semantic_search = state.enabled;
    caps.features.assistance = false;
    caps.assistance_profiles = [];
    caps.embedding_profiles = [state.profile];
    await route.fulfill({ json: caps });
  });
  await page.route("**/api/v1/embedding-profiles**", (route) =>
    route.fulfill({
      json: {
        profiles: [
          {
            id: state.profile,
            label: state.provider,
            query_available: state.available,
            indexed: count,
            eligible: count + 3,
            pending: 3,
            limitations: [],
          },
        ],
      },
    }),
  );
  await page.route("**/api/v1/search/semantic", (route) => {
    const body = route.request().postDataJSON();
    state.calls.push({
      url: route.request().url(),
      method: route.request().method(),
      ...body,
    });
    if (state.fail)
      return route.fulfill({
        status: 503,
        json: {
          code: "semantic_unavailable",
          message: "Synthetic meaning failure.",
          event: null,
          field: null,
        },
      });
    return route.fulfill({
      json: {
        ...body,
        query_hash: "sha256:" + "e".repeat(64),
        hits: records.map((record, index) => ({
          event: record.envelope.id,
          word: record.word,
          distance: index / 100,
          position: index + 1,
        })),
        coverage: {
          indexed: count,
          eligible: count + 4,
          pending: 3,
          failed: 1,
        },
      },
    });
  });
  await page.route("**/api/v1/events/**", (route) => {
    const record = records.find((record) =>
      decodeURIComponent(new URL(route.request().url()).pathname).endsWith(
        record.envelope.id,
      ),
    );
    return record ? route.fulfill({ json: record.envelope }) : route.continue();
  });
  await page.route("**/api/v1/bodies/**", (route) => {
    const record = records.find((record) =>
      decodeURIComponent(new URL(route.request().url()).pathname).endsWith(
        record.envelope.header.content!.hash,
      ),
    );
    return record ? route.fulfill({ json: record.body }) : route.continue();
  });
  return state;
}

test("inline meaning consent can be declined, accepted, remembered, and renewed for a new provider or scope", async ({
  page,
}) => {
  const state = await meaningService(page);
  await page.goto("/search?q=book&lang=en");
  const meaning = group(page, "Similar in meaning");
  await expect(meaning).toContainText("Provider: Synthetic Embedding Provider");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.calls).toHaveLength(0);
  await meaning.getByRole("button", { name: "Not now", exact: true }).click();
  await expect(meaning).toContainText("Meaning search is off for this page.");
  expect(state.calls).toHaveLength(0);
  await meaning.getByRole("button", { name: "Enable meaning search" }).click();
  await meaning.getByRole("button", { name: "Allow meaning search" }).click();
  await expect(meaning.locator("article")).toHaveCount(1);
  await expect(
    meaning.getByRole("link", { name: "Matched definition", exact: true }),
  ).toHaveAttribute("href", /^\/definition\/jve1%3A/);
  await expect(meaning).toContainText(
    "3 are pending indexing. 1 failed indexing.",
  );
  expect(state.calls).toHaveLength(1);
  expect(state.calls[0]).toMatchObject({
    query: "book",
    language: "en",
    method: "POST",
    profile: state.profile,
    view: fixture().view,
  });
  expect(new URL(state.calls[0].url).search).toBe("");
  await page.goto("/search?q=travel&lang=en");
  await expect(meaning.locator("article")).toHaveCount(1);
  expect(state.calls).toHaveLength(2);
  state.provider = "A different provider";
  await page.reload();
  await expect(
    meaning.getByRole("button", { name: "Allow meaning search" }),
  ).toBeVisible();
  expect(state.calls).toHaveLength(2);
  await meaning.getByRole("button", { name: "Allow meaning search" }).click();
  await expect(meaning.locator("article")).toHaveCount(1);
  state.profile = "sha256:" + "c".repeat(64);
  await page.reload();
  await expect(
    meaning.getByRole("button", { name: "Allow meaning search" }),
  ).toBeVisible();
  expect(state.calls).toHaveLength(3);
});

test("AI off, missing semantic capability, unavailable profiles, and patterns have no meaning group", async ({
  page,
}) => {
  const state = await meaningService(page);
  await page.goto("/preferences");
  await page.getByLabel("Use AI assistance").uncheck();
  await expect(page.locator("#assistance-save-status")).toHaveText(
    "Assistance setting saved in this browser.",
  );
  await page.goto("/search?q=book&lang=en");
  await expect(page.locator("main h2")).toHaveText([
    "Definitions",
    "Lojban words",
  ]);
  await expect(group(page, "Similar in meaning")).toHaveCount(0);
  await page.goto("/preferences");
  await page.getByLabel("Use AI assistance").check();
  await expect(page.locator("#assistance-save-status")).toHaveText(
    "Assistance setting saved in this browser.",
  );
  state.enabled = false;
  await page.goto("/search?q=book&lang=en");
  await expect(group(page, "Definitions")).toBeVisible();
  await expect(page.locator("#meaning-heading")).toHaveCount(0);
  state.enabled = true;
  state.available = false;
  await page.reload();
  await expect(group(page, "Definitions")).toBeVisible();
  await expect(page.locator("#meaning-heading")).toHaveCount(0);
  state.available = true;
  await page.goto("/search?q=cu*&lang=en");
  await expect(page.getByRole("heading", { level: 2 })).toHaveText([
    "Lojban words",
  ]);
  expect(state.calls).toHaveLength(0);
});

test("meaning results have separate pagination and recover after a 503 without changing the language", async ({
  page,
}) => {
  const state = await meaningService(page, 25);
  state.fail = true;
  await page.goto("/search?q=book&lang=en");
  const meaning = group(page, "Similar in meaning");
  await meaning.getByRole("button", { name: "Allow meaning search" }).click();
  await expect(meaning.getByRole("status")).toContainText(
    "Synthetic meaning failure.",
  );
  await expect(
    meaning.getByRole("button", { name: "Retry reading", exact: true }),
  ).toBeVisible();
  state.fail = false;
  await meaning
    .getByRole("button", { name: "Retry reading", exact: true })
    .click();
  await expect(meaning.locator("article")).toHaveCount(20);
  await meaning.getByRole("button", { name: "Show more", exact: true }).click();
  await expect(meaning.locator("article")).toHaveCount(25);
  await expect(meaning.getByRole("status")).toHaveText(
    "25 meaning results shown.",
  );
  await page.goto("/search?q=travel&lang=en");
  await expect(meaning.locator("article")).toHaveCount(20);
  await meaning.getByRole("button", { name: "show all", exact: true }).click();
  await expect(meaning.locator("article")).toHaveCount(25);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.goBack();
  await expect(meaning.locator("article")).toHaveCount(25);
  expect(state.calls.every((call) => call.language === "en")).toBe(true);
});

test("measure a warm query with all three groups outside the search worker", async ({
  page,
}) => {
  test.skip(
    process.env.JVC_GROUPED_MEASURE !== "enabled",
    "Run the explicit grouped search measurement.",
  );
  const state = await meaningService(page);
  await localPackage(page);
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const pkg = await store.get("packages", "en");
    for (let index = 0; index < 10_000; index++)
      pkg.entries.push({
        event: "jve1:" + (1000 + index).toString(16).padStart(64, "0"),
        word: { language: "jbo", spelling: "broda" + index },
        language: "en",
        glosses: [],
        plain_text: "Synthetic definition uses se as a query token.",
        classification: { kind: "other", selmaho: [] },
        body: null,
      });
    await store.put("packages", "en", pkg);
  });
  await page.goto("/search?q=se&lang=en");
  const meaning = group(page, "Similar in meaning");
  await meaning.getByRole("button", { name: "Allow meaning search" }).click();
  await expect(meaning.locator("article")).toHaveCount(1);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
  const cpu = async () =>
    (await cdp.send("Performance.getMetrics")).metrics.find(
      (metric) => metric.name === "TaskDuration",
    )!.value;
  for (let index = 0; index < 3; index++) {
    const before = await cpu();
    await page.evaluate(async () => {
      const { navigate } = await import(String("/src/app/router.ts"));
      navigate("/search?q=se&lang=en", { replace: true, state: {} });
    });
    await expect(meaning.locator("article")).toHaveCount(1);
    await expect(group(page, "Lojban words").locator("article")).toHaveCount(
      20,
    );
    await expect(group(page, "Definitions").locator("article")).toHaveCount(20);
    const mainThreadCpuMs = 1000 * ((await cpu()) - before);
    const stats = await page.evaluate(async () =>
      (
        await import(String("/src/data/package-search.ts"))
      ).packageSearchStats(),
    );
    console.log(
      JSON.stringify({
        measurement: "grouped-query",
        query: "se",
        entries: 10_047,
        run: index + 1,
        main_thread_cpu_ms: mainThreadCpuMs,
        rows: [20, 20, 1],
        stats,
      }),
    );
    expect(stats?.prepared).toBe(false);
    expect(stats?.metrics.headwordsParsed).toBe(0);
  }
  expect(state.calls).toHaveLength(4);
});
