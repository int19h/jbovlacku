import { test, expect, type Page } from "@playwright/test";
import { corePath, fixture } from "./helpers.ts";

test.afterEach(async ({ page }) => {
  // Remove handlers before page closure without waiting for held requests.
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

const group = (page: Page, name: string) =>
  page.getByRole("region", { name, exact: true });
async function localPackage(page: Page) {
  await page.goto("/");
  await expect(
    page.getByText("Type a word or a meaning to search.", { exact: true }),
  ).toBeVisible();
  await page.evaluate(
    async ({ view, issuer }) => {
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
        issuer,
        notes: false,
        rafsi: [],
        rafsi_complete: true,
        attribution: null,
        search_status: { view, status: "active" },
      }));
      await new LocalStore().put("packages", "en", {
        snapshot: "sha256:" + "a".repeat(64),
        version: 2,
        entries,
      });
    },
    { view: fixture().view, issuer: fixture().identities.author },
  );
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
  await expect(page.locator("main [aria-live=polite]")).toHaveCount(1);
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
    failDefinitions: false,
    failIndices: [] as number[],
    records,
    pending: 3,
    profileReplies: 0,
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
  await page.route("**/api/v1/embedding-profiles**", async (route) => {
    await route.fulfill({
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
    });
    state.profileReplies++;
  });
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
          pending: state.pending,
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
    if (
      record &&
      (state.failDefinitions ||
        state.failIndices.includes(records.indexOf(record)))
    )
      return route.fulfill({
        status: 503,
        json: {
          code: "busy",
          message: "Synthetic definition busy.",
          event: null,
          field: null,
        },
      });
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
  await expect(page.locator("main [aria-live=polite]")).toHaveCount(1);
  await expect(page.locator("main .count-line")).not.toContainText(
    "needs your permission",
  );
  expect(state.calls).toHaveLength(0);
  await meaning.getByRole("button", { name: "Not now", exact: true }).click();
  await expect(meaning).toContainText("Meaning search is off for this page.");
  await expect(
    meaning.getByRole("button", { name: "Enable meaning search" }),
  ).toBeFocused();
  expect(state.calls).toHaveLength(0);
  await meaning.getByRole("button", { name: "Enable meaning search" }).click();
  await expect(
    meaning.getByRole("button", { name: "Allow meaning search" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(meaning.locator("article")).toHaveCount(1);
  await expect(meaning.locator("article .hw").first()).toBeFocused();
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
  await page.goto("/search?q=book&lang=en");
  const meaning = group(page, "Similar in meaning");
  await meaning.getByRole("button", { name: "Allow meaning search" }).click();
  await expect(meaning.locator("article")).toHaveCount(1);
  const counts = page.locator("main .count-line .count");
  await expect(counts).toContainText("1 meaning result.");
  await page.evaluate(async () => {
    const { Session } = await import(String("/src/app/session.ts"));
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const writer = new Session(new LocalStore());
    await writer.load();
    await writer.setPreferences({ useAiAssistance: false });
  });
  await expect(meaning).toHaveCount(0);
  await expect(counts).not.toContainText("meaning result");
  expect(state.calls).toHaveLength(1);
});

test("meaning results have separate pagination and recover after a 503 without changing the language", async ({
  page,
}) => {
  const state = await meaningService(page, 25);
  state.fail = true;
  await page.goto("/search?q=book&lang=en");
  const meaning = group(page, "Similar in meaning");
  await meaning.getByRole("button", { name: "Allow meaning search" }).click();
  await expect(meaning.locator(".count")).toContainText(
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
  await expect(meaning.locator(".count")).toHaveText(
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

test("measure a warm query with all three full groups outside the search worker", async ({
  page,
}) => {
  test.skip(
    process.env.JVC_GROUPED_MEASURE !== "enabled",
    "Run the explicit grouped search measurement.",
  );
  const state = await meaningService(page, 20);
  for (const record of state.records) {
    const response = await page.request.post("/api/v1/events", {
      data: { envelope: record.envelope, body: record.body },
    });
    expect(response.status()).toBe(201);
  }
  const wordResponses = new Set<string>();
  page.on("response", (response) => {
    if (
      new URL(response.url()).pathname.startsWith("/api/v1/words/") &&
      response.status() === 200
    )
      wordResponses.add(
        decodeURIComponent(new URL(response.url()).pathname).split("/").at(-1)!,
      );
  });
  await expect
    .poll(async () =>
      (
        await page.request.get(
          "/api/v1/words/" + encodeURIComponent(state.records.at(-1)!.word),
        )
      ).status(),
    )
    .toBe(200);
  await localPackage(page);
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const pkg = await store.get("packages", "en");
    for (let index = 0; index < 10_000; index++)
      pkg.entries.push({
        ...pkg.entries[0],
        event: "jve1:" + (1000 + index).toString(16).padStart(64, "0"),
        word: { language: "jbo", spelling: "broda" + index },
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
  const settle = async () => {
    for (const name of ["Lojban words", "Definitions", "Similar in meaning"])
      await expect(group(page, name).locator("article")).toHaveCount(20);
    await expect(meaning.locator("article .judgment")).toHaveCount(20);
    await expect(meaning.locator("article .identity-link")).toHaveCount(20);
    await expect(
      meaning
        .locator("article .text")
        .filter({ hasText: "A synthetic related definition." }),
    ).toHaveCount(20);
  };
  await settle();
  expect(state.records.every((record) => wordResponses.has(record.word))).toBe(
    true,
  );
  for (const mode of ["site", "personal"] as const) {
    await page.evaluate(async (mode) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      await new LocalStore().setPreferences({ viewMode: mode });
    }, mode);
    await page.reload();
    await settle();
    await page.evaluate(async () => {
      const { PersonalCalculator } = await import(
        String("/src/data/personal.ts")
      );
      const original = PersonalCalculator.prototype.rankWord;
      (window as any).rankMeasurement = { called: 0, completed: 0, failed: 0 };
      PersonalCalculator.prototype.rankWord = async function (...args: any[]) {
        const counts = (window as any).rankMeasurement;
        counts.called++;
        try {
          const value = await original.apply(this, args as any);
          counts.completed++;
          return value;
        } catch (error) {
          counts.failed++;
          throw error;
        }
      };
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
    const cpu = async () =>
      (await cdp.send("Performance.getMetrics")).metrics.find(
        (metric) => metric.name === "TaskDuration",
      )!.value;
    for (let index = 0; index < 3; index++) {
      const previousCalls = state.calls.length;
      await page.evaluate(() => {
        (window as any).rankMeasurement = {
          called: 0,
          completed: 0,
          failed: 0,
        };
      });
      const before = await cpu();
      await page.evaluate(async () => {
        const { navigate } = await import(String("/src/app/router.ts"));
        navigate("/search?q=se&lang=en", { replace: true, state: {} });
      });
      await expect.poll(() => state.calls.length).toBe(previousCalls + 1);
      await settle();
      const ranks = await page.evaluate(() => (window as any).rankMeasurement);
      expect(ranks).toEqual(
        mode === "personal"
          ? { called: 20, completed: 20, failed: 0 }
          : { called: 0, completed: 0, failed: 0 },
      );
      const mainThreadCpuMs = 1000 * ((await cpu()) - before);
      const stats = await page.evaluate(async () =>
        (
          await import(String("/src/data/package-search.ts"))
        ).packageSearchStats(),
      );
      console.log(
        JSON.stringify({
          measurement: "grouped-query",
          mode,
          query: "se",
          entries: 10_047,
          run: index + 1,
          main_thread_cpu_ms: mainThreadCpuMs,
          rows: [20, 20, 20],
          completed_remote_word_ids: wordResponses.size,
          ranks,
          stats,
        }),
      );
      expect(stats?.prepared).toBe(false);
      expect(stats?.metrics.headwordsParsed).toBe(0);
    }
    await cdp.detach();
  }
});

for (const local of [false, true])
  test(`r2: ${local ? "local" : "remote"} Back restores meaning results and their context without inference`, async ({
    page,
  }) => {
    const state = await meaningService(page, 25);
    if (local) await localPackage(page);
    await page.goto("/search?q=se&lang=en");
    const meaning = group(page, "Similar in meaning");
    await meaning.getByRole("button", { name: "Allow meaning search" }).click();
    await expect(meaning.locator("article")).toHaveCount(20);
    await meaning
      .getByRole("button", { name: "show all", exact: true })
      .click();
    await expect(meaning.locator("article")).toHaveCount(25);
    const original = await page.evaluate(() => history.state.dictionaryMeaning);
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Settings", exact: true }),
    ).toBeVisible();
    await page.route("**/api/v1/manifest", async (route) => {
      const response = await route.fetch();
      const manifest = await response.json();
      manifest.snapshot = "sha256:" + "f".repeat(64);
      await route.fulfill({ json: manifest });
    });
    state.fail = true;
    await page.goBack();
    await expect(meaning.locator("article")).toHaveCount(25);
    expect(state.calls).toHaveLength(1);
    expect(
      await page.evaluate(() => history.state.dictionaryMeaning.snapshot),
    ).toBe(original.snapshot);
    expect(
      await page.evaluate(() => history.state.dictionaryMeaning.view),
    ).toBe(original.view);
  });

test("r2: meaning pagination keeps keyboard focus", async ({ page }) => {
  await meaningService(page, 25);
  await page.goto("/search?q=book&lang=en");
  const meaning = group(page, "Similar in meaning");
  await meaning.getByRole("button", { name: "Allow meaning search" }).click();
  await expect(meaning.locator("article")).toHaveCount(20);
  await meaning.getByRole("button", { name: "Show more", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(meaning.locator("article")).toHaveCount(25);
  await expect(meaning.locator("article .hw").nth(20)).toBeFocused();
});

test("r2: definition read retry keeps good rows and does not repeat inference", async ({
  page,
}) => {
  const state = await meaningService(page, 2);
  state.failIndices = [1];
  await page.goto("/search?q=book&lang=en");
  const meaning = group(page, "Similar in meaning");
  await meaning.getByRole("button", { name: "Allow meaning search" }).click();
  await expect(meaning).toContainText("Synthetic definition busy.");
  const retries = meaning.getByRole("button", {
    name: "Retry reading",
    exact: true,
  });
  await expect(retries).toHaveCount(1);
  await expect(meaning.locator("article")).toHaveCount(1);
  state.failIndices = [];
  await retries.first().focus();
  await page.keyboard.press("Enter");
  await expect(meaning.locator("article")).toHaveCount(2);
  await expect(meaning.locator("article .hw").nth(1)).toBeFocused();
  expect(state.calls).toHaveLength(1);
});

test("r2: meaning consent names dictionary fields and local privacy follows consent with an off control", async ({
  page,
}) => {
  const state = await meaningService(page);
  await localPackage(page);
  await page.goto("/search?q=se&lang=en");
  const meaning = group(page, "Similar in meaning");
  const notice = meaning.getByRole("group", { name: "Meaning search consent" });
  await expect(notice).toBeVisible();
  for (const field of [
    "search query",
    "definition language",
    "snapshot",
    "view",
    "profile",
    "limit of 100",
  ])
    await expect(notice).toContainText(field);
  await meaning.getByRole("button", { name: "Allow meaning search" }).click();
  await expect(meaning.locator("article")).toHaveCount(1);
  await expect(page.locator("main")).toContainText(
    "Meaning search sends each query",
  );
  const off = page.getByRole("button", {
    name: "Turn off meaning search",
    exact: true,
  });
  await expect(off).toBeVisible();
  await off.click();
  await expect(meaning.locator("article")).toHaveCount(0);
  await page.goto("/search?q=book&lang=en");
  await expect(meaning).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Turn on meaning search", exact: true }),
  ).toBeVisible();
  expect(state.calls).toHaveLength(1);
  await page.goto("/search");
  await expect(page.locator("main")).toContainText(
    "Queries stay in this browser.",
  );
});

test("r2: local empty page and Settings disclose remembered meaning uploads", async ({
  page,
}) => {
  const state = await meaningService(page);
  await localPackage(page);
  await page.goto("/search?q=se&lang=en");
  await page.getByRole("button", { name: "Allow meaning search" }).click();
  await expect(
    group(page, "Similar in meaning").locator("article"),
  ).toHaveCount(1);
  await page.goto("/search");
  await expect(page.locator("main")).not.toContainText(
    "Queries stay in this browser.",
  );
  await expect(page.locator("main")).toContainText(
    "Meaning search sends each query",
  );
  await page.goto("/preferences");
  await expect(page.locator("main")).not.toContainText(
    "queries stay in this browser",
  );
  await expect(page.locator("main")).toContainText("Meaning search sends");
  expect(state.calls).toHaveLength(1);
});

test("r2: first lexical failure does not hide the other group", async ({
  page,
}) => {
  await page.route("**/api/v1/search?**", (route) => {
    const key = new URL(route.request().url()).searchParams.get("group");
    return route.fulfill({
      status: 503,
      json: {
        code: "busy",
        message:
          key === "lojban"
            ? "Synthetic word failure."
            : "Synthetic definition failure.",
        event: null,
        field: null,
      },
    });
  });
  await page.goto("/search?q=book&lang=en");
  await expect(group(page, "Lojban words")).toContainText(
    "Synthetic word failure.",
  );
  await expect(group(page, "Definitions")).toContainText(
    "Synthetic definition failure.",
  );
});

test("r2: second lexical group shows loading and only one count announcement per action", async ({
  page,
}) => {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/search?**", async (route) => {
    if (
      new URL(route.request().url()).searchParams.get("group") === "definitions"
    )
      await barrier;
    await route.continue();
  });
  await page.goto("/search?q=book&lang=en");
  await expect(group(page, "Definitions")).toContainText("Searching");
  await expect(group(page, "Definitions")).not.toContainText("unavailable");
  release();
  await expect(
    page.getByRole("region", { name: "Search results", exact: true }),
  ).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("main [aria-live=polite]")).toHaveCount(1);
  await localPackage(page);
  await page.goto("/search?q=se&lang=en");
  const words = group(page, "Lojban words");
  await expect(words.locator("article")).toHaveCount(20);
  await page.evaluate(() => {
    const messages: string[] = [];
    (window as any).countMessages = messages;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const target =
          record.target instanceof Element
            ? record.target
            : record.target.parentElement;
        if (target?.closest("main [aria-live=polite]"))
          messages.push(target.textContent ?? "");
      }
    });
    observer.observe(document.querySelector("main")!, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
  await words.getByRole("button", { name: "Show more", exact: true }).click();
  await expect(words.locator("article")).toHaveCount(40);
  await expect
    .poll(() => page.evaluate(() => (window as any).countMessages.length))
    .toBe(1);
});

for (const empty of [false, true])
  test(`r2: lexical expansion restores focus after ${empty ? "an empty page" : "a failure"}`, async ({
    page,
  }) => {
    const f = fixture();
    await page.route("**/api/v1/search?**", (route) => {
      const url = new URL(route.request().url());
      const later = url.searchParams.has("after");
      if (url.searchParams.get("group") === "lojban")
        return route.fulfill({
          json: {
            snapshot: "sha256:" + "a".repeat(64),
            view: f.view,
            hits: [],
            next: null,
          },
        });
      if (later && !empty)
        return route.fulfill({
          status: 503,
          json: {
            code: "busy",
            message: "Synthetic expansion busy.",
            event: null,
            field: null,
          },
        });
      return route.fulfill({
        json: {
          snapshot: "sha256:" + "a".repeat(64),
          view: f.view,
          hits: later
            ? []
            : [
                {
                  word: { language: "jbo", spelling: "cukta" },
                  word_id: f.words.cukta,
                  definitions: [f.definitions.cukta1],
                  match: "token",
                },
              ],
          next: later ? null : "r2-next",
        },
      });
    });
    await page.goto("/search?q=book&lang=en");
    const definitions = group(page, "Definitions");
    const more = definitions.getByRole("button", {
      name: "Show more",
      exact: true,
    });
    await more.focus();
    await page.keyboard.press("Enter");
    if (empty) await expect(more).toHaveCount(0);
    else await expect(definitions).toContainText("Synthetic expansion busy.");
    expect(
      await page.evaluate(() => document.activeElement === document.body),
    ).toBe(false);
    await expect(definitions.locator(":focus")).toHaveCount(1);
  });

test("r2: pending singular and a different local meaning snapshot stay visible", async ({
  page,
}) => {
  const state = await meaningService(page);
  state.pending = 1;
  await localPackage(page);
  await page.goto("/search?q=se&lang=en");
  const meaning = group(page, "Similar in meaning");
  await meaning.getByRole("button", { name: "Allow meaning search" }).click();
  await expect(meaning.locator("article")).toHaveCount(1);
  await expect(meaning).toContainText("1 is pending indexing.");
  await expect(
    meaning.locator("p.meta").filter({ hasText: "Meaning snapshot:" }),
  ).toBeVisible();
  await expect(meaning).toContainText(state.calls[0].snapshot);
  expect(state.calls[0].snapshot).not.toBe("sha256:" + "a".repeat(64));
});

test("r2: a failed word group keeps successful Definitions readable", async ({
  page,
}) => {
  await page.route("**/api/v1/search?**", (route) => {
    if (new URL(route.request().url()).searchParams.get("group") !== "lojban")
      return route.continue();
    return route.fulfill({
      status: 503,
      json: {
        code: "busy",
        message: "Synthetic word failure.",
        event: null,
        field: null,
      },
    });
  });
  await page.goto("/search?q=book&lang=en");
  await expect(group(page, "Lojban words")).toContainText(
    "Synthetic word failure.",
  );
  await expect(
    group(page, "Definitions").locator("article").first(),
  ).toBeVisible();
  await expect(group(page, "Definitions")).not.toContainText("unavailable");
});

for (const local of [true, false])
  test(`r3: ${local ? "local" : "remote"} complete spelling aliases and retired words control group order`, async ({
    page,
  }) => {
    await page.goto("/search");
    const f = fixture();
    const source = await page.evaluate(
      async ({ corePath, view, issuer }) => {
        const core = await import(corePath);
        await core.initializeCore();
        return [
          "lo",
          "ve",
          "ti",
          "me",
          "mi",
          "klama",
          "iseri'abo",
          "i",
          "coi",
          "do",
          "la",
          "alis",
          "ki'e",
        ].map((spelling, index) => ({
          event: "jve1:" + (index + 1).toString(16).padStart(64, "0"),
          word: { language: "jbo", spelling },
          word_id: core.wordId({ language: "jbo", spelling }),
          language: "en",
          glosses: [],
          plain_text: "Synthetic definition.",
          classification: { kind: "cmavo", selmaho: [] },
          body: null,
          issuer,
          notes: false,
          rafsi: [],
          rafsi_complete: true,
          attribution: null,
          search_status: { view, status: "active" },
        }));
      },
      { corePath, view: f.view, issuer: f.identities.author },
    );
    const packageRows = source.map(({ word_id, ...entry }) => entry);
    const evaluation = {
      publications: Object.fromEntries(
        source.map((row) => [
          row.event,
          { word: row.word_id, eligible: "eligible", status: "active" },
        ]),
      ),
      receipts: Object.fromEntries(
        source.map((row) => [row.event, { interpretation: "effective" }]),
      ),
    };
    if (local)
      await page.evaluate(async (entries) => {
        const { LocalStore } = await import(String("/src/data/store.ts"));
        await new LocalStore().put("packages", "en", {
          snapshot: "sha256:" + "a".repeat(64),
          version: 2,
          entries,
        });
      }, packageRows);
    else {
      const { lexicalSearch } =
        await import("../../../packages/service/src/lexical-search.ts");
      await page.route("**/api/v1/search?**", (route) => {
        const params = new URL(route.request().url()).searchParams;
        const hits = lexicalSearch(
          packageRows as any,
          params.get("q")!,
          "en",
          evaluation as any,
          params.get("retired") === "1",
          undefined,
          {},
          { group: params.get("group") as any },
        );
        return route.fulfill({
          json: {
            snapshot: "sha256:" + "a".repeat(64),
            view: f.view,
            hits,
            next: null,
            all_lojban: hits.allLojban,
          },
        });
      });
    }
    for (const [query, known] of [
      ["love", false],
      ["time", false],
      ["klama", true],
      ["mi klama", true],
      ["mi klama.", true],
      [".i mi klama", true],
      ["coi, do", true],
      ["la .alis.", true],
      ["kihe", true],
      ["klama!", false],
      ["coi, unknown", false],
      ["... ,", false],
    ] as const) {
      await page.goto(
        "/search?" + new URLSearchParams({ q: query, lang: "en" }),
      );
      await expect(page.locator("main h2")).toHaveText(
        known
          ? ["Lojban words", "Definitions"]
          : ["Definitions", "Lojban words"],
      );
    }
    packageRows[5].search_status.status = "retired";
    evaluation.publications[source[5].event].status = "deprecated";
    if (local)
      await page.evaluate(async (entries) => {
        const { LocalStore } = await import(String("/src/data/store.ts"));
        await new LocalStore().put("packages", "en", {
          snapshot: "sha256:" + "a".repeat(64),
          version: 2,
          entries,
        });
      }, packageRows);
    for (const retired of [false, true]) {
      await page.goto(
        "/search?q=klama&lang=en" + (retired ? "&retired=1" : ""),
      );
      await expect(page.locator("main h2")).toHaveText(
        retired
          ? ["Lojban words", "Definitions"]
          : ["Definitions", "Lojban words"],
      );
    }
  });

test("r2: failed meaning expansion focuses its definition retry and an empty result focuses its status", async ({
  page,
}) => {
  const state = await meaningService(page, 21);
  await page.goto("/search?q=book&lang=en");
  const meaning = group(page, "Similar in meaning");
  await meaning.getByRole("button", { name: "Allow meaning search" }).click();
  await expect(meaning.locator("article")).toHaveCount(20);
  state.failIndices = [20];
  await meaning.getByRole("button", { name: "Show more", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(
    meaning.getByRole("button", { name: "Retry reading", exact: true }),
  ).toBeFocused();
  expect(state.calls).toHaveLength(1);
  await page.route("**/api/v1/search/semantic", (route) => {
    const body = route.request().postDataJSON();
    return route.fulfill({
      json: {
        ...body,
        query_hash: "sha256:" + "e".repeat(64),
        hits: [],
        coverage: { indexed: 0, eligible: 0, pending: 0, failed: 0 },
      },
    });
  });
  state.provider = "Empty fixture provider";
  await page.goto("/search?q=empty&lang=en");
  await meaning.getByRole("button", { name: "Allow meaning search" }).click();
  await expect(meaning).toContainText("No similar meanings in this index.");
  await expect(meaning.locator(".count")).toBeFocused();
});

test("r2: an old package keeps its hits and visibly explains missing ordering evidence", async ({
  page,
}) => {
  await localPackage(page);
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const pkg = await store.get("packages", "en");
    for (const entry of pkg.entries) delete entry.search_status;
    await store.put("packages", "en", pkg);
  });
  await page.goto("/search?q=se&lang=en");
  await expect(page.locator("main h2")).toHaveText([
    "Definitions",
    "Lojban words",
  ]);
  await expect(group(page, "Lojban words").locator("article")).toHaveCount(20);
  await expect(
    page.getByText("Known-word ordering is unavailable for this package.", {
      exact: false,
    }),
  ).toBeVisible();
});

test("r2: Back retains the meaning context when incomplete lexical history reads a newer snapshot", async ({
  page,
}) => {
  const state = await meaningService(page, 25);
  await page.goto("/search?q=book&lang=en");
  const meaning = group(page, "Similar in meaning");
  await meaning.getByRole("button", { name: "Allow meaning search" }).click();
  await expect(meaning.locator("article")).toHaveCount(20);
  await meaning.getByRole("button", { name: "show all", exact: true }).click();
  await expect(meaning.locator("article")).toHaveCount(25);
  const original = state.calls[0];
  await page.evaluate(() =>
    history.replaceState(
      {
        ...history.state,
        dictionarySearch: {
          ...history.state.dictionarySearch,
          complete: false,
        },
      },
      "",
    ),
  );
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.route("**/api/v1/search?**", (route) =>
    route.fulfill({
      json: {
        snapshot: "sha256:" + "f".repeat(64),
        view: fixture().view,
        hits: [],
        next: null,
        all_lojban: false,
      },
    }),
  );
  state.fail = true;
  await page.goBack();
  await expect(meaning.locator("article")).toHaveCount(25);
  await expect(meaning).toContainText(original.snapshot);
  expect(state.calls).toHaveLength(1);
  expect(
    await page.evaluate(() => history.state.dictionarySearch.snapshot),
  ).toBe("sha256:" + "f".repeat(64));
});

test("r2: failed consent revocation remains visible and keeps the off control usable", async ({
  page,
}) => {
  await meaningService(page);
  await localPackage(page);
  await page.goto("/search?q=se&lang=en");
  await page.getByRole("button", { name: "Allow meaning search" }).click();
  await expect(
    group(page, "Similar in meaning").locator("article"),
  ).toHaveCount(1);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const original = LocalStore.prototype.setPreferences;
    LocalStore.prototype.setPreferences = async function (patch: any) {
      if (patch.useMeaningSearch === false)
        throw new Error("Synthetic revocation storage failure.");
      return original.call(this, patch);
    };
  });
  await page
    .getByRole("button", { name: "Turn off meaning search", exact: true })
    .click();
  await expect(page.locator("main")).toContainText(
    "The saved meaning search choice is unchanged.",
  );
  await expect(page.locator("main")).toContainText(
    "Synthetic revocation storage failure.",
  );
  await expect(
    page.getByRole("button", { name: "Turn off meaning search", exact: true }),
  ).toBeEnabled();
  await expect(
    group(page, "Similar in meaning").locator("article"),
  ).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("r2: Back after a reload keeps the saved meaning results without another inference request", async ({
  page,
}) => {
  const state = await meaningService(page, 25);
  await page.goto("/search?q=book&lang=en");
  const meaning = group(page, "Similar in meaning");
  await meaning.getByRole("button", { name: "Allow meaning search" }).click();
  await expect(meaning.locator("article")).toHaveCount(20);
  await page.reload();
  await expect(meaning.locator("article")).toHaveCount(20);
  expect(state.calls).toHaveLength(2);
  expect(
    await page.evaluate(
      () =>
        (
          performance.getEntriesByType(
            "navigation",
          )[0] as PerformanceNavigationTiming
        ).type,
    ),
  ).toBe("reload");
  await meaning.getByRole("button", { name: "show all", exact: true }).click();
  await expect(meaning.locator("article")).toHaveCount(25);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  state.fail = true;
  await page.goBack();
  await expect(meaning.locator("article")).toHaveCount(25);
  expect(state.calls).toHaveLength(2);
});

test("r2: cross-document Back restores meaning results without inference", async ({
  page,
}) => {
  const state = await meaningService(page, 25);
  await page.goto("/search?q=book&lang=en");
  const meaning = group(page, "Similar in meaning");
  await meaning.getByRole("button", { name: "Allow meaning search" }).click();
  await expect(meaning.locator("article")).toHaveCount(20);
  await meaning.getByRole("button", { name: "show all", exact: true }).click();
  await expect(meaning.locator("article")).toHaveCount(25);
  await page.goto("/preferences");
  state.fail = true;
  await page.goBack();
  await expect(meaning.locator("article")).toHaveCount(25);
  expect(state.calls).toHaveLength(1);
});

for (const held of ["semantic", "definition"] as const)
  test(`r3: held ${held} work leaves lexical counts, actions, and announcements ready`, async ({
    page,
  }) => {
    const state = await meaningService(page, 21);
    await localPackage(page);
    await page.goto("/search?q=se&lang=en");
    const meaning = group(page, "Similar in meaning");
    await meaning.getByRole("button", { name: "Allow meaning search" }).click();
    await expect(meaning.locator("article")).toHaveCount(20);
    await page.addInitScript(() => {
      (window as any).r3Counts = [];
      new MutationObserver((records) => {
        const count = document.querySelector("main .count-line .count");
        if (
          count &&
          records.some(
            (record) =>
              record.target === count || count.contains(record.target),
          )
        )
          (window as any).r3Counts.push(count.textContent);
      }).observe(document, {
        subtree: true,
        childList: true,
        characterData: true,
      });
    });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    const target =
      held === "semantic" ? "**/api/v1/search/semantic" : "**/api/v1/events/**";
    await page.route(target, async (route) => {
      if (
        held === "definition" &&
        !decodeURIComponent(route.request().url()).includes(
          state.records[0].envelope.id,
        )
      )
        return route.fallback();
      started = true;
      await waiting;
      return route.fallback();
    });
    try {
      await page.reload();
      await expect.poll(() => started).toBe(true);
      const counts = page.locator("main .count-line .count");
      await expect(counts).toContainText("46 Lojban results, 20 shown.");
      await expect(counts).not.toContainText("meaning");
      await expect(counts).toHaveClass(/\bsr\b/);
      await expect(
        page.getByRole("link", { name: "Add it", exact: true }),
      ).toBeVisible();
      await group(page, "Lojban words")
        .getByRole("button", { name: "Show more", exact: true })
        .focus();
      await page.keyboard.press("Enter");
      await expect(group(page, "Lojban words").locator("article")).toHaveCount(
        40,
      );
      await expect(
        group(page, "Lojban words").locator("article .hw").nth(20),
      ).toBeFocused();
      await expect(counts).toHaveText(
        "46 Lojban results, 40 shown. 47 definition results, 20 shown.",
      );
      release();
      await expect(meaning.locator("article")).toHaveCount(20);
      await expect(counts).toHaveText(
        "46 Lojban results, 40 shown. 47 definition results, 20 shown. 20 meaning results.",
      );
      await expect(
        group(page, "Lojban words").locator("article .hw").nth(20),
      ).toBeFocused();
      expect(await page.evaluate(() => (window as any).r3Counts)).toEqual([
        "46 Lojban results, 20 shown. 47 definition results, 20 shown.",
        "46 Lojban results, 40 shown. 47 definition results, 20 shown.",
        "46 Lojban results, 40 shown. 47 definition results, 20 shown. 20 meaning results.",
      ]);
    } finally {
      release();
    }
  });

test("r3: a held remote meaning request cannot delay retired results or Add it", async ({
  page,
}) => {
  await meaningService(page);
  await page.goto("/search?q=book&lang=en");
  await group(page, "Similar in meaning")
    .getByRole("button", { name: "Allow meaning search" })
    .click();
  await expect(
    group(page, "Similar in meaning").locator("article"),
  ).toHaveCount(1);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let completed!: () => void;
  const settled = new Promise<void>((resolve) => {
    completed = resolve;
  });
  let started = false;
  await page.route("**/api/v1/search/semantic", async (route) => {
    started = true;
    await waiting;
    try {
      return await route.fallback();
    } finally {
      completed();
    }
  });
  try {
    await page.reload();
    await expect.poll(() => started).toBe(true);
    await expect(page.getByLabel("Include retired results")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Add it", exact: true }),
    ).toBeVisible();
    const counts = page.locator("main .count-line .count");
    await expect(counts).toHaveText(
      /^\d+(?: or more)? definition results?\. \d+(?: or more)? Lojban results?\.$/,
    );
    await expect(counts).toHaveClass(/\bsr\b/);
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Settings" }),
    ).toBeVisible();
    await expect(page.locator("main")).toContainText(
      "Semantic search: available.",
    );
    release();
    await settled;
    await expect(page.locator("main #meaning-heading")).toHaveCount(0);
  } finally {
    release();
    if (started) await settled;
  }
});

test("r3: a chosen view mismatch explains the server evidence without download advice or query upload", async ({
  page,
}) => {
  await localPackage(page);
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    await new LocalStore().setPreferences({
      view: "jve1:" + "f".repeat(64),
      useAiAssistance: false,
    });
  });
  const uploads: string[] = [];
  await page.route("**/api/v1/search**", (route) => {
    uploads.push(route.request().url());
    return route.abort();
  });
  await page.goto("/search?q=se&lang=en");
  await expect(page.locator("main h2")).toHaveText([
    "Definitions",
    "Lojban words",
  ]);
  const notice = page
    .locator("main > .notice")
    .filter({ hasText: "Known-word ordering" });
  await expect(notice).toContainText("server view");
  await expect(notice).toContainText("chosen view");
  await expect(notice).toContainText("Definitions comes first");
  await expect(notice).not.toContainText(/download/i);
  expect(uploads).toEqual([]);
});

test("r3: turning meaning search off persists separately from consent and other AI choices", async ({
  page,
}) => {
  const state = await meaningService(page);
  await page.goto("/search?q=book&lang=en");
  await group(page, "Similar in meaning")
    .getByRole("button", { name: "Allow meaning search" })
    .click();
  await expect(
    group(page, "Similar in meaning").locator("article"),
  ).toHaveCount(1);
  const preferences = () =>
    page.evaluate(async () => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      return new LocalStore().preferences();
    });
  const before = await preferences();
  await page
    .getByRole("button", { name: "Turn off meaning search", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Turn on meaning search", exact: true }),
  ).toBeVisible();
  for (const query of ["book", "travel"]) {
    await page.goto("/search?" + new URLSearchParams({ q: query, lang: "en" }));
    await expect(
      page.getByRole("button", { name: "Turn on meaning search", exact: true }),
    ).toBeVisible();
    await expect(group(page, "Similar in meaning")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Allow meaning search" }),
    ).toHaveCount(0);
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Turn on meaning search", exact: true }),
    ).toBeVisible();
    await expect(group(page, "Similar in meaning")).toHaveCount(0);
  }
  expect(state.calls).toHaveLength(1);
  const after = await preferences();
  expect(after.useAiAssistance).toBe(before.useAiAssistance);
  expect(after.aiConsents).toEqual(before.aiConsents);
  expect((after as any).useMeaningSearch).toBe(false);
  await page
    .getByRole("button", { name: "Turn on meaning search", exact: true })
    .click();
  await expect(
    group(page, "Similar in meaning").locator("article"),
  ).toHaveCount(1);
  expect(state.calls).toHaveLength(2);
  expect(((await preferences()) as any).useMeaningSearch).toBe(true);
});

test("r3: count announcements follow displayed order without a second visible status line", async ({
  page,
}) => {
  await localPackage(page);
  await expect(page.locator("main .count-line .count")).toHaveText(
    "Type a word or a meaning to search.",
  );
  await expect(page.locator("main .count-line .count")).not.toHaveClass(
    /\bsr\b/,
  );
  for (const [query, message] of [
    ["book", "47 definition results, 20 shown. 0 Lojban results."],
    ["se", "46 Lojban results, 20 shown. 47 definition results, 20 shown."],
  ]) {
    await page.goto("/search?" + new URLSearchParams({ q: query, lang: "en" }));
    const counts = page.locator("main .count-line .count");
    await expect(counts).toHaveText(message);
    await expect(counts).toHaveClass(/\bsr\b/);
    expect(
      await counts.evaluate(
        (node) =>
          getComputedStyle(node).clipPath !== "none" ||
          getComputedStyle(node).clip !== "auto",
      ),
    ).toBe(true);
    const statuses = await page
      .locator("main section[aria-labelledby] > .count")
      .allTextContents();
    for (const status of statuses) expect(message).not.toContain(status);
  }
});

test("r3: meaning settles independently while a lexical expansion is held", async ({
  page,
}) => {
  await meaningService(page, 21);
  await localPackage(page);
  await page.goto("/search?q=se&lang=en");
  const meaning = group(page, "Similar in meaning");
  await meaning.getByRole("button", { name: "Allow meaning search" }).click();
  await expect(meaning.locator("article")).toHaveCount(20);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  await page.route("**/api/v1/search/semantic", async (route) => {
    started = true;
    await waiting;
    return route.fallback();
  });
  try {
    await page.reload();
    await expect.poll(() => started).toBe(true);
    const counts = page.locator("main .count-line .count");
    await expect(counts).toHaveText(
      "46 Lojban results, 20 shown. 47 definition results, 20 shown.",
    );
    await page.evaluate(() => {
      const original = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (message: any) {
        if (message.options?.offset > 0) {
          (window as any).heldLexical = true;
          (window as any).continueLexical = () => original.call(this, message);
        } else original.call(this, message);
      };
    });
    const words = group(page, "Lojban words");
    await words.getByRole("button", { name: "Show more", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => (window as any).heldLexical))
      .toBe(true);
    release();
    await expect(meaning.locator("article")).toHaveCount(20);
    await expect(counts).toHaveText(
      "46 Lojban results, 20 shown. 47 definition results, 20 shown. 20 meaning results.",
    );
    await expect(words.locator("article")).toHaveCount(20);
    await page.evaluate(() => (window as any).continueLexical());
    await expect(words.locator("article")).toHaveCount(40);
    await expect(counts).toHaveText(
      "46 Lojban results, 40 shown. 47 definition results, 20 shown.",
    );
    await expect(words.locator("article .hw").nth(20)).toBeFocused();
  } finally {
    release();
  }
});

test("r4: the consent box saves the off choice before any meaning request", async ({
  page,
}) => {
  const state = await meaningService(page);
  await page.goto("/search?q=book&lang=en");
  const consent = page.getByRole("group", {
    name: "Meaning search consent",
    exact: true,
  });
  await expect(consent).toBeVisible();
  const preferences = () =>
    page.evaluate(async () => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      return new LocalStore().preferences();
    });
  const before = await preferences();
  await expect(
    consent.getByRole("button", {
      name: "Turn off meaning search",
      exact: true,
    }),
  ).toBeVisible();
  await consent
    .getByRole("button", { name: "Turn off meaning search", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Turn on meaning search", exact: true }),
  ).toBeVisible();
  for (const query of ["book", "travel"]) {
    await page.goto("/search?" + new URLSearchParams({ q: query, lang: "en" }));
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Turn on meaning search", exact: true }),
    ).toBeVisible();
    await expect(group(page, "Similar in meaning")).toHaveCount(0);
    await expect(consent).toHaveCount(0);
  }
  const after = await preferences();
  expect(after.useMeaningSearch).toBe(false);
  expect(after.aiConsents).toEqual(before.aiConsents);
  expect(after.useAiAssistance).toBe(before.useAiAssistance);
  expect(state.calls).toHaveLength(0);
  await page
    .getByRole("button", { name: "Turn on meaning search", exact: true })
    .click();
  await expect(consent).toBeVisible();
  expect(state.calls).toHaveLength(0);
  await consent
    .getByRole("button", { name: "Allow meaning search", exact: true })
    .click();
  await expect(
    group(page, "Similar in meaning").locator("article"),
  ).toHaveCount(1);
  expect(state.calls).toHaveLength(1);
});

for (const unavailable of [
  "AI off",
  "semantic capability off",
  "no query profile",
] as const)
  test(`r4: the saved off choice has no on control with ${unavailable}`, async ({
    page,
  }) => {
    const state = await meaningService(page);
    state.enabled = unavailable !== "semantic capability off";
    state.available = unavailable !== "no query profile";
    await page.evaluate(async (unavailable) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      await new LocalStore().setPreferences({
        useMeaningSearch: false,
        useAiAssistance: unavailable !== "AI off",
      });
    }, unavailable);
    const metadata: string[] = [];
    const uploads: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/v1/embedding-profiles")
        metadata.push(url.search);
      if (url.pathname === "/api/v1/search/semantic")
        uploads.push(url.pathname);
    });
    await page.goto("/search?q=book&lang=en");
    await expect(
      page.getByRole("region", { name: "Search results", exact: true }),
    ).toHaveAttribute("aria-busy", "false");
    await expect(
      page.getByRole("button", { name: "Turn on meaning search", exact: true }),
    ).toHaveCount(0);
    await expect(group(page, "Similar in meaning")).toHaveCount(0);
    if (unavailable === "no query profile")
      await expect.poll(() => state.profileReplies).toBe(1);
    else expect(metadata).toEqual([]);
    // Let metadata responses and the next paint settle before testing absence.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(
      page.getByRole("button", { name: "Turn on meaning search", exact: true }),
    ).toHaveCount(0);
    state.enabled = true;
    state.available = true;
    await page.evaluate(async () => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      await new LocalStore().setPreferences({ useAiAssistance: true });
    });
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Turn on meaning search", exact: true }),
    ).toBeVisible();
    expect(metadata.length).toBeGreaterThan(0);
    for (const query of metadata) {
      expect(new URLSearchParams(query).has("q")).toBe(false);
      expect(new URLSearchParams(query).has("query")).toBe(false);
    }
    expect(uploads).toEqual([]);
    expect(state.calls).toHaveLength(0);
    expect(
      await page.evaluate(async () => {
        const { LocalStore } = await import(String("/src/data/store.ts"));
        return (await new LocalStore().preferences()).useMeaningSearch;
      }),
    ).toBe(false);
  });

test("r4: Back delivers lexical counts and restored meaning counts in the frame sequence", async ({
  page,
}) => {
  const state = await meaningService(page, 2);
  // Empty lexical groups keep the entire Back restoration in one task.
  await page.route("**/api/v1/search?**", (route) =>
    route.fulfill({
      json: {
        snapshot: "sha256:" + "a".repeat(64),
        view: fixture().view,
        hits: [],
        next: null,
        all_lojban: false,
      },
    }),
  );
  await page.goto("/search?q=book&lang=en");
  await group(page, "Similar in meaning")
    .getByRole("button", { name: "Allow meaning search" })
    .click();
  await expect(
    group(page, "Similar in meaning").locator("article"),
  ).toHaveCount(2);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Settings" }),
  ).toBeVisible();
  await page.evaluate(() => {
    const samples: string[] = [];
    (window as any).r4Frames = samples;
    const sample = () => {
      const message = document.querySelector(
        "main .count-line .count",
      )?.textContent;
      if (message && message !== samples.at(-1)) samples.push(message);
      (window as any).r4Frame = requestAnimationFrame(sample);
    };
    (window as any).r4Frame = requestAnimationFrame(sample);
  });
  await page.goBack();
  await expect(
    group(page, "Similar in meaning").locator("article"),
  ).toHaveCount(2);
  // Sample at rendering opportunities so same-task writes settle before delivery.
  await expect
    .poll(() => page.evaluate(() => (window as any).r4Frames))
    .toEqual(["0 definition results. 0 Lojban results. 2 meaning results."]);
  await page.evaluate(() => cancelAnimationFrame((window as any).r4Frame));
  expect(state.calls).toHaveLength(1);
});

test("r4: local singular and zero counts and remote open totals keep their wording", async ({
  page,
}) => {
  await localPackage(page);
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const pkg = await store.get("packages", "en");
    pkg.entries = pkg.entries.slice(0, 1);
    await store.put("packages", "en", pkg);
    await store.setPreferences({ useAiAssistance: false });
  });
  await page.goto("/search?q=se&lang=en");
  const counts = page.locator("main .count-line .count");
  await expect(counts).toHaveText("1 Lojban result. 1 definition result.");
  await page.goto("/search?q=absent&lang=en");
  await expect(counts).toHaveText("0 definition results. 0 Lojban results.");
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    await new LocalStore().setPreferences({ searchMode: "remote" });
  });
  let more = false;
  await page.route("**/api/v1/search?**", (route) => {
    const definitions =
      new URL(route.request().url()).searchParams.get("group") ===
      "definitions";
    return route.fulfill({
      json: {
        snapshot: "sha256:" + "a".repeat(64),
        view: fixture().view,
        all_lojban: false,
        hits: definitions
          ? [
              {
                word: { language: "jbo", spelling: "cukta" },
                word_id: fixture().words.cukta,
                definitions: [fixture().definitions.cukta1],
                match: "gloss",
              },
            ]
          : [],
        next: definitions && more ? "synthetic-next-page" : null,
      },
    });
  });
  await page.goto("/search?q=book&lang=en");
  await expect(counts).toHaveText("1 definition result. 0 Lojban results.");
  more = true;
  await page.goto("/search?q=books&lang=en");
  await expect(counts).toHaveText(
    "1 or more definition results. 0 Lojban results.",
  );
});

test("r4: a failed consent-box off save keeps consent and retry usable", async ({
  page,
}) => {
  const state = await meaningService(page);
  await page.goto("/search?q=book&lang=en");
  const consent = page.getByRole("group", {
    name: "Meaning search consent",
    exact: true,
  });
  const off = consent.getByRole("button", {
    name: "Turn off meaning search",
    exact: true,
  });
  await expect(off).toBeVisible();
  const before = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const original = LocalStore.prototype.setPreferences;
    (window as any).r4SetPreferences = original;
    LocalStore.prototype.setPreferences = async function (patch: any) {
      if (patch.useMeaningSearch === false)
        throw new Error("Synthetic consent-box storage failure.");
      return original.call(this, patch);
    };
    return new LocalStore().preferences();
  });
  await off.click();
  await expect(group(page, "Similar in meaning")).toContainText(
    "The saved meaning search choice is unchanged. Synthetic consent-box storage failure.",
  );
  await expect(off).toBeEnabled();
  await expect(
    consent.getByRole("button", { name: "Allow meaning search", exact: true }),
  ).toBeEnabled();
  const after = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const preferences = await new LocalStore().preferences();
    LocalStore.prototype.setPreferences = (window as any).r4SetPreferences;
    return preferences;
  });
  expect(after.useMeaningSearch).toBe(before.useMeaningSearch);
  expect(after.aiConsents).toEqual(before.aiConsents);
  expect(after.useAiAssistance).toBe(before.useAiAssistance);
  expect(state.calls).toHaveLength(0);
  await off.click();
  await expect(
    page.getByRole("button", { name: "Turn on meaning search", exact: true }),
  ).toBeVisible();
  expect(state.calls).toHaveLength(0);
});

test("r5: Not now cancels a pending Allow without removing stored consent", async ({
  page,
}) => {
  const state = await meaningService(page);
  await page.goto("/search?q=book&lang=en");
  const meaning = group(page, "Similar in meaning");
  const allow = meaning.getByRole("button", { name: "Allow meaning search" });
  await expect(allow).toBeVisible();
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const original = LocalStore.prototype.setPreferences;
    const barrier = new Promise<void>((resolve) => {
      (window as any).r5ReleaseConsent = resolve;
    });
    LocalStore.prototype.setPreferences = async function (patch: any) {
      if (patch.aiConsents) await barrier;
      return original.call(this, patch);
    };
    const fetch = window.fetch;
    (window as any).r5SemanticDispatches = 0;
    window.fetch = function (...args) {
      if (String(args[0]).includes("/search/semantic"))
        (window as any).r5SemanticDispatches++;
      return fetch.apply(this, args);
    };
  });
  await allow.click();
  await expect(allow).toBeDisabled();
  await meaning.getByRole("button", { name: "Not now", exact: true }).click();
  await expect(meaning).toContainText("Meaning search is off for this page.");
  expect(state.calls).toHaveLength(0);
  await page.evaluate(() => (window as any).r5ReleaseConsent());
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { LocalStore } = await import(String("/src/data/store.ts"));
        return (await new LocalStore().preferences()).aiConsents.length;
      }),
    )
    .toBe(1);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(await page.evaluate(() => (window as any).r5SemanticDispatches)).toBe(
    0,
  );
  expect(state.calls).toHaveLength(0);
  await expect(meaning).toContainText("Meaning search is off for this page.");
  await page.reload();
  await expect(meaning.locator("article")).toHaveCount(1);
  expect(state.calls).toHaveLength(1);
});

async function holdMeaningWrites(page: Page) {
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const original = LocalStore.prototype.setPreferences;
    (window as any).r5Writes = [];
    LocalStore.prototype.setPreferences = async function (patch: any) {
      const kind = patch.aiConsents
        ? "allow"
        : patch.useMeaningSearch === false
          ? "off"
          : null;
      if (!kind) return original.call(this, patch);
      const write: any = { kind };
      write.done = new Promise<void>((resolve) => {
        write.finish = resolve;
      });
      const barrier = new Promise<boolean>((resolve) => {
        write.release = resolve;
      });
      (window as any).r5Writes.push(write);
      try {
        if (await barrier)
          throw new Error("Synthetic delayed preference failure.");
        return await original.call(this, patch);
      } finally {
        write.finish();
      }
    };
    const fetch = window.fetch;
    (window as any).r5SemanticDispatches = 0;
    window.fetch = function (...args) {
      if (String(args[0]).includes("/search/semantic"))
        (window as any).r5SemanticDispatches++;
      return fetch.apply(this, args);
    };
  });
}
async function releaseMeaningWrite(page: Page, index: number, fail = false) {
  await page.evaluate(
    async ({ index, fail }) => {
      const write = (window as any).r5Writes[index];
      write.release(fail);
      await write.done;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    },
    { index, fail },
  );
}
const meaningPreferences = (page: Page) =>
  page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return new LocalStore().preferences();
  });
const meaningWrites = (page: Page) =>
  page.evaluate(() => (window as any).r5Writes.map((write: any) => write.kind));
const meaningDispatches = (page: Page) =>
  page.evaluate(() => (window as any).r5SemanticDispatches);

test("r5: a failed pending Allow cannot replace Not now and a deliberate retry works", async ({
  page,
}) => {
  const state = await meaningService(page);
  await page.goto("/search?q=book&lang=en");
  const meaning = group(page, "Similar in meaning");
  await holdMeaningWrites(page);
  await meaning.getByRole("button", { name: "Allow meaning search" }).click();
  await expect.poll(() => meaningWrites(page)).toEqual(["allow"]);
  await meaning.getByRole("button", { name: "Not now", exact: true }).click();
  await releaseMeaningWrite(page, 0, true);
  await expect(meaning).toContainText("Meaning search is off for this page.");
  await expect(meaning).not.toContainText(
    "Synthetic delayed preference failure.",
  );
  expect(await meaningDispatches(page)).toBe(0);
  expect((await meaningPreferences(page)).aiConsents).toEqual([]);
  await meaning.getByRole("button", { name: "Enable meaning search" }).click();
  await meaning.getByRole("button", { name: "Allow meaning search" }).click();
  await expect.poll(() => meaningWrites(page)).toEqual(["allow", "allow"]);
  await releaseMeaningWrite(page, 1);
  await expect(meaning.locator("article")).toHaveCount(1);
  expect(state.calls).toHaveLength(1);
});

test("r5: reopening consent while Allow saves keeps one write and needs a new action", async ({
  page,
}) => {
  const state = await meaningService(page);
  await page.goto("/search?q=book&lang=en");
  const meaning = group(page, "Similar in meaning");
  await holdMeaningWrites(page);
  await meaning.getByRole("button", { name: "Allow meaning search" }).click();
  await expect.poll(() => meaningWrites(page)).toEqual(["allow"]);
  for (let index = 0; index < 2; index++) {
    await meaning.getByRole("button", { name: "Not now", exact: true }).click();
    await meaning
      .getByRole("button", { name: "Enable meaning search" })
      .click();
    const allow = meaning.getByRole("button", { name: "Allow meaning search" });
    await expect(allow).toBeDisabled();
    await allow.dispatchEvent("click");
    expect(await meaningWrites(page)).toEqual(["allow"]);
  }
  await releaseMeaningWrite(page, 0);
  expect(await meaningDispatches(page)).toBe(0);
  expect(state.calls).toHaveLength(0);
  const allow = meaning.getByRole("button", { name: "Allow meaning search" });
  await expect(allow).toBeEnabled();
  await allow.click();
  await expect(meaning.locator("article")).toHaveCount(1);
  expect(await meaningWrites(page)).toEqual(["allow"]);
  expect((await meaningPreferences(page)).aiConsents).toHaveLength(1);
  expect(state.calls).toHaveLength(1);
});

for (const control of ["consent", "privacy"] as const) {
  for (const first of ["allow", "off"] as const)
    test(`r5: ${control} off stops pending Allow when ${first} saves first`, async ({
      page,
    }) => {
      const state = await meaningService(page);
      await page.goto("/search?q=book&lang=en");
      const meaning = group(page, "Similar in meaning");
      if (control === "privacy") {
        await meaning
          .getByRole("button", { name: "Allow meaning search" })
          .click();
        await expect(meaning.locator("article")).toHaveCount(1);
        state.provider = "A different delayed provider";
        await page.reload();
      }
      const consent = meaning.getByRole("group", {
        name: "Meaning search consent",
      });
      await expect(consent).toBeVisible();
      const before = await meaningPreferences(page);
      const previousCalls = state.calls.length;
      await holdMeaningWrites(page);
      await consent
        .getByRole("button", { name: "Allow meaning search" })
        .click();
      await expect.poll(() => meaningWrites(page)).toEqual(["allow"]);
      const off =
        control === "consent"
          ? consent.getByRole("button", {
              name: "Turn off meaning search",
              exact: true,
            })
          : page
              .getByRole("button", {
                name: "Turn off meaning search",
                exact: true,
              })
              .first();
      await off.click();
      await expect.poll(() => meaningWrites(page)).toEqual(["allow", "off"]);
      await expect(
        consent.getByRole("button", { name: "Allow meaning search" }),
      ).toBeDisabled();
      await releaseMeaningWrite(page, first === "allow" ? 0 : 1);
      expect(await meaningDispatches(page)).toBe(0);
      expect(state.calls).toHaveLength(previousCalls);
      await releaseMeaningWrite(page, first === "allow" ? 1 : 0);
      await expect(meaning).toHaveCount(0);
      await expect(
        page.getByRole("button", {
          name: "Turn on meaning search",
          exact: true,
        }),
      ).toBeVisible();
      const after = await meaningPreferences(page);
      expect(after.useMeaningSearch).toBe(false);
      expect(after.useAiAssistance).toBe(before.useAiAssistance);
      expect(after.aiConsents).toHaveLength(before.aiConsents.length + 1);
      expect(after.aiConsents.slice(0, before.aiConsents.length)).toEqual(
        before.aiConsents,
      );
      expect(await meaningDispatches(page)).toBe(0);
      expect(state.calls).toHaveLength(previousCalls);
      await page.reload();
      await expect(meaning).toHaveCount(0);
      await expect(
        page.getByRole("button", {
          name: "Turn on meaning search",
          exact: true,
        }),
      ).toBeVisible();
      expect(state.calls).toHaveLength(previousCalls);
    });

  test(`r5: failed ${control} off does not resume pending Allow and keeps explicit retry usable`, async ({
    page,
  }) => {
    const state = await meaningService(page);
    await page.goto("/search?q=book&lang=en");
    const meaning = group(page, "Similar in meaning");
    if (control === "privacy") {
      await meaning
        .getByRole("button", { name: "Allow meaning search" })
        .click();
      await expect(meaning.locator("article")).toHaveCount(1);
      state.provider = "A different delayed provider";
      await page.reload();
    }
    const consent = meaning.getByRole("group", {
      name: "Meaning search consent",
    });
    await expect(consent).toBeVisible();
    const before = await meaningPreferences(page);
    const previousCalls = state.calls.length;
    await holdMeaningWrites(page);
    const allow = consent.getByRole("button", { name: "Allow meaning search" });
    await allow.click();
    await expect.poll(() => meaningWrites(page)).toEqual(["allow"]);
    const off =
      control === "consent"
        ? consent.getByRole("button", {
            name: "Turn off meaning search",
            exact: true,
          })
        : page
            .getByRole("button", {
              name: "Turn off meaning search",
              exact: true,
            })
            .first();
    await off.click();
    await expect.poll(() => meaningWrites(page)).toEqual(["allow", "off"]);
    await releaseMeaningWrite(page, 1, true);
    await expect(page.locator("main")).toContainText(
      "Synthetic delayed preference failure.",
    );
    await expect(off).toBeEnabled();
    await expect(allow).toBeDisabled();
    await releaseMeaningWrite(page, 0);
    await expect(allow).toBeEnabled();
    expect(await meaningDispatches(page)).toBe(0);
    expect(state.calls).toHaveLength(previousCalls);
    const after = await meaningPreferences(page);
    expect(after.useMeaningSearch).toBe(before.useMeaningSearch);
    expect(after.useAiAssistance).toBe(before.useAiAssistance);
    await allow.click();
    await expect(meaning.locator("article")).toHaveCount(1);
    expect(state.calls).toHaveLength(previousCalls + 1);
    expect(await meaningWrites(page)).toEqual(["allow", "off"]);
  });
}

test("r5: pending off blocks Allow and its failure cannot replace Not now", async ({
  page,
}) => {
  const state = await meaningService(page);
  await page.goto("/search?q=book&lang=en");
  const meaning = group(page, "Similar in meaning");
  await holdMeaningWrites(page);
  await meaning
    .getByRole("button", { name: "Turn off meaning search", exact: true })
    .click();
  await expect.poll(() => meaningWrites(page)).toEqual(["off"]);
  const allow = meaning.getByRole("button", { name: "Allow meaning search" });
  await expect(allow).toBeDisabled();
  await allow.dispatchEvent("click");
  expect(await meaningWrites(page)).toEqual(["off"]);
  await meaning.getByRole("button", { name: "Not now", exact: true }).click();
  await releaseMeaningWrite(page, 0, true);
  await expect(meaning).toContainText("Meaning search is off for this page.");
  await expect(meaning).not.toContainText(
    "Synthetic delayed preference failure.",
  );
  expect(await meaningDispatches(page)).toBe(0);
  expect(state.calls).toHaveLength(0);
  await meaning.getByRole("button", { name: "Enable meaning search" }).click();
  await expect(
    meaning.getByRole("button", { name: "Allow meaning search" }),
  ).toBeEnabled();
  await expect(
    meaning.getByRole("button", {
      name: "Turn off meaning search",
      exact: true,
    }),
  ).toBeEnabled();
});

test("r5: pending privacy off blocks an initial request after profile discovery", async ({
  page,
}) => {
  const state = await meaningService(page);
  await page.goto("/search?q=book&lang=en");
  const meaning = group(page, "Similar in meaning");
  await meaning.getByRole("button", { name: "Allow meaning search" }).click();
  await expect(meaning.locator("article")).toHaveCount(1);
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let waiting = false;
  await page.route("**/api/v1/embedding-profiles**", async (route) => {
    waiting = true;
    await barrier;
    await route.fallback();
  });
  try {
    await page.reload();
    await expect.poll(() => waiting).toBe(true);
    const off = page.getByRole("button", {
      name: "Turn off meaning search",
      exact: true,
    });
    await expect(off).toBeVisible();
    await holdMeaningWrites(page);
    await off.click();
    await expect.poll(() => meaningWrites(page)).toEqual(["off"]);
    release();
    const allow = meaning.getByRole("button", { name: "Allow meaning search" });
    await expect(allow).toBeDisabled();
    expect(await meaningDispatches(page)).toBe(0);
    expect(state.calls).toHaveLength(1);
    await releaseMeaningWrite(page, 0, true);
    await expect(page.locator("main")).toContainText(
      "Synthetic delayed preference failure.",
    );
    await expect(allow).toBeEnabled();
    expect(await meaningDispatches(page)).toBe(0);
    await allow.click();
    await expect(meaning.locator("article")).toHaveCount(1);
    expect(state.calls).toHaveLength(2);
  } finally {
    release();
  }
});
