import { test, expect, type Page } from "@playwright/test";
import { corePath, fixture, fingerprintText } from "./helpers.ts";

/**
 * Opens the Source disclosure of the definition on the page by its exact
 * summary, apart from any other "Source" text, and waits until it is open.
 */
async function openSourceDisclosure(page: Page) {
  const details = page.locator("main details.disclosure", {
    has: page.locator("summary", { hasText: /^Source$/ }),
  });
  await expect(details).toHaveCount(1);
  await details.locator("summary").click();
  await expect(details).toHaveAttribute("open", "");
}

test("search rows show headword, rafsi, type, highlighted text, attribution, and a net score", async ({
  page,
}) => {
  const f = fixture();
  await page.goto("/search?q=book&lang=en");
  await expect(page).toHaveTitle("Search: book · jbovlacku");
  await expect(page.getByLabel("Search words and meanings")).toHaveValue(
    "book",
  );
  const results = page.getByRole("region", { name: "Search results" });
  const row = results
    .locator("article")
    .filter({ has: page.getByRole("link", { name: "cukta", exact: true }) });
  await expect(
    row.getByRole("link", { name: "cukta", exact: true }),
  ).toHaveAttribute("lang", "jbo");
  await expect(row.locator("mark")).toHaveText("book");
  await expect(row.getByText("gismu", { exact: true })).toBeVisible();
  await expect(row.getByText("cku", { exact: true })).toBeVisible();
  await expect(row.getByRole("img", { name: "place 1" })).toBeVisible();
  await expect(row.getByRole("link", { name: "notes" })).toBeVisible();
  await expect(
    row.getByRole("link", { name: /also: 1 other matching definition/ }),
  ).toBeVisible();
  const score = row.getByRole("img", {
    name: /^Score 6: 6 for, 0 against, \d+ reviewers?/,
  });
  await expect(score).toBeVisible();
  await expect(score).toHaveText("6");
  const author = row.getByRole("link", {
    name:
      f.identities.curator.slice(8, 12) + "…" + f.identities.curator.slice(-4),
  });
  await expect(author).toHaveAttribute(
    "title",
    fingerprintText(f.identities.curator),
  );
  await expect(row.getByRole("button", { name: "Endorse" })).toBeVisible();
  await expect(row.getByRole("button", { name: "Oppose" })).toBeVisible();
  // Without a key, pressed state is unknown, so aria-pressed is absent.
  await expect(
    row.getByRole("button", { name: "Endorse" }),
  ).not.toHaveAttribute("aria-pressed", /.*/);
  await expect(page.getByRole("link", { name: "Add it" })).toHaveAttribute(
    "href",
    /\/new\/meaning\?meaning=book/,
  );
  await expect(
    page.getByRole("link", { name: "Trust: site view" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Settings" })).toBeVisible();
});

test("an imported definition keeps its source author, importer, rights, and source date separate", async ({
  page,
}) => {
  const f = fixture();
  await page.goto("/search?q=library&lang=en");
  const row = page
    .getByRole("region", { name: "Search results" })
    .locator("article")
    .first();
  await expect(
    row.getByRole("link", { name: "ckusro", exact: true }),
  ).toBeVisible();
  await page.goto(`/definition/${encodeURIComponent(f.definitions.imported)}`);
  await expect(page).toHaveTitle("Definition: ckusro · jbovlacku");
  await openSourceDisclosure(page);
  await expect(
    page.getByText("Source author: arj.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Rights: unknown · Lensisku source author unknown", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText(/Imported from https:\/\/lensisku.invalid, account 8/),
  ).toBeVisible();
  await expect(
    page
      .getByRole("link", {
        name:
          f.identities.importer.slice(8, 12) +
          "…" +
          f.identities.importer.slice(-4),
      })
      .first(),
  ).toBeVisible();
  await expect(page.locator("main")).not.toContainText("[object Object]");
});

test("the word page orders definitions by the two-root view and exposes the score breakdown", async ({
  page,
}) => {
  const f = fixture();
  await page.goto("/word/cukta");
  await expect(page).toHaveTitle("cukta · jbovlacku");
  await expect(page.locator("main h1")).toHaveAttribute("lang", "jbo");
  await expect(
    page.getByRole("link", { name: "cku", exact: true }),
  ).toHaveAttribute("href", "/rafsi/cku");
  const articles = page.locator("article.definition");
  await expect(articles).toHaveCount(4);
  const scores = await articles.locator(".judgment .score").allTextContents();
  expect(scores).toEqual(["6", "3", "0", "−3"]);
  const first = articles.first();
  const headline = first.getByRole("img", {
    name: /^Score 6: 6 for, 0 against, \d+ reviewers?$/,
  });
  await expect(headline).toBeVisible();
  await expect(headline).toHaveAttribute("title", /Exact value 6\./);
  await first.getByText(/^\d+ reviewers?$/).click();
  await expect(first.getByText("Support", { exact: true })).toBeVisible();
  await expect(
    first.locator("dd").filter({ hasText: /^6$/ }).first(),
  ).toBeVisible();
  await expect(first.getByText("Exact", { exact: true })).toBeVisible();
  await expect(
    first.getByText(
      /The score adds the weight of each reviewer in the site view/,
    ),
  ).toBeVisible();
  await expect(first.getByRole("link", { name: "Trust page" })).toHaveAttribute(
    "href",
    "/trust",
  );
  // Place strip and place links.
  const strip = first.locator(".place-strip");
  await expect(strip.getByLabel("place 1: book")).toBeVisible();
  await expect(
    first.getByRole("link", { name: "place 3", exact: true }),
  ).toHaveAttribute("href", /#place-[0-9a-f]+-3$/);
  // Revision notice from the delegate.
  await expect(first.locator(".revision-notice")).toContainText(
    "not the author.",
  );
  await first.getByRole("link", { name: "Compare" }).click();
  await expect(page).toHaveURL(
    new RegExp(
      `/definition/${f.definitions.cuktaRev.replace(":", "%3A")}\\?compare=`,
    ),
  );
  await expect(
    page.getByRole("region", { name: "Changed fields" }),
  ).toContainText("Places");
  await page.goBack();
  await expect(page).toHaveTitle("cukta · jbovlacku");
  // The zero-reviewer revision shows "no judgments yet" rather than a fabricated opposition.
  await expect(
    articles.nth(2).getByRole("img", { name: "Score 0, no judgments yet" }),
  ).toBeVisible();
  // The third definition is opposed by the delegate and endorsed by an untrusted author.
  await expect(
    articles.nth(3).getByRole("img", {
      name: /^Score minus 3: 0 for, 3 against, \d+ reviewers/,
    }),
  ).toBeVisible();
  // Rafsi pair card.
  await expect(
    page.getByRole("heading", { name: "Rafsi claims" }),
  ).toBeVisible();
  await expect(page.getByText("Eligible pair · 1 claim")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Add a definition" }),
  ).toHaveAttribute("href", /\/new\/meaning\?word=cukta/);
});

test("SPA routes update the title, focus the heading, and preserve search through history", async ({
  page,
}) => {
  await page.goto("/search?q=klama&lang=en");
  await expect(page).toHaveTitle("Search: klama · jbovlacku");
  await page.getByRole("link", { name: "Your key" }).click();
  await expect(page).toHaveTitle("Your key · jbovlacku");
  await expect(page.locator("main h1")).toBeFocused();
  await page.goBack();
  await expect(page).toHaveTitle("Search: klama · jbovlacku");
  await expect(page.getByLabel("Search words and meanings")).toHaveValue(
    "klama",
  );
  await page.goForward();
  await expect(page).toHaveTitle("Your key · jbovlacku");
  await page.getByLabel("Search words and meanings").fill("dictionary");
  await page.getByLabel("Search words and meanings").press("Enter");
  await expect(page).toHaveURL(/\/search\?q=dictionary&lang=en$/);
  await expect(
    page.getByRole("link", { name: "vlacku", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "vlacku", exact: true }).click();
  await expect(page).toHaveTitle("vlacku · jbovlacku");
  await expect(page.locator("main h1")).toBeFocused();
  await expect(page.locator("main > p.muted").first()).toContainText(
    "valsi + cukta",
  );
  await expect(page.getByRole("heading", { name: "See also" })).toBeVisible();
});

test("every page fits a 360 pixel screen in both themes with header search and footer links", async ({
  page,
}) => {
  const f = fixture();
  await page.setViewportSize({ width: 360, height: 780 });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const path of [
      "/search?q=book&lang=en",
      "/word/cukta",
      `/definition/${encodeURIComponent(f.definitions.cukta1)}`,
      "/identity",
      "/outbox",
      "/trust",
      "/preferences",
      "/about",
      `/identity/${encodeURIComponent(f.identities.curator)}`,
    ]) {
      await page.goto(path);
      await expect(page.locator("main h1").first()).toBeVisible();
      await expect(page.getByLabel("Search words and meanings")).toBeVisible();
      await expect(page.getByRole("link", { name: "Settings" })).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        path,
      ).toBe(true);
    }
  }
});

test("the trust page names both roots and the site view settings", async ({
  page,
}) => {
  const f = fixture();
  await page.goto("/trust");
  await expect(
    page.getByRole("radio", { name: "Site view only" }),
  ).toBeChecked();
  await expect(
    page.getByText("Web UI test view. Selected by this server."),
  ).toBeVisible();
  for (const root of [f.identities.rootA, f.identities.rootB])
    await expect(
      page.getByRole("link", {
        name: root.slice(8, 12) + "…" + root.slice(-4),
      }),
    ).toBeVisible();
  await page.getByText("Settings and history").click();
  await expect(page.getByText("Outward allowance (H)")).toBeVisible();
  await expect(
    page.getByText("3 · an outward multiplier, not a route depth limit"),
  ).toBeVisible();
  await expect(page.getByText("Passed on (alpha)")).toBeVisible();
  await expect(page.getByRole("link", { name: f.view })).toBeVisible();
  await page
    .getByRole("radio", { name: "Mine: site view + my choices" })
    .check();
  await expect(
    page.getByRole("link", { name: "Trust: personal view" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("radio", { name: "Mine: site view + my choices" }),
  ).toBeChecked();
});

test("a hash-correct signed body with an invalid schema stays unavailable", async ({
  page,
}) => {
  await page.goto("/");
  const id = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    await core.initializeCore();
    const fixtureSeed = crypto.getRandomValues(new Uint8Array(32));
    const body = {
      text: [["This malformed body must not become a readable definition."]],
    };
    const bytes = core.utf8(core.canonicalize(core.utf8(JSON.stringify(body))));
    const envelope = core.signHeader(fixtureSeed, {
      version: 1,
      issuer: core.identityFromSeed(fixtureSeed),
      previous: [],
      nonce: "f".repeat(32),
      action: {
        kind: "definition.publish",
        word: core.wordId({ language: "jbo", spelling: "brodi" }),
        language: "en",
        parents: [],
        origin: "native",
      },
      content: { hash: core.contentHash(bytes), bytes: bytes.length },
    });
    fixtureSeed.fill(0);
    const response = await fetch("/api/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ envelope, body }),
    });
    if (!response.ok)
      throw new Error("The malformed fixture was not retained.");
    return envelope.id;
  }, `/@fs${process.cwd()}/packages/core/src/index.ts`);
  await page.goto(`/definition/${encodeURIComponent(id)}`);
  await expect(
    page.getByText(
      "This signed body does not satisfy the format rules. Its content is unavailable.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      "This malformed body must not become a readable definition.",
      { exact: true },
    ),
  ).toHaveCount(0);
});

/** A synthetic definition record signed with a disposable seed. */
const definitionRecord = `(seed, index, word, language, patch) => {
  return core.createEvent(
    new Uint8Array(32).fill(seed),
    [],
    String(index).repeat(32),
    { kind: "definition.publish", word: core.wordId(word), language, parents: [], origin: patch.legacy ? "import" : "native" },
    {
      word, language, text: patch.text ?? [["Definition " + index]], frame: null, operands: [], glosses: patch.glosses ?? [], notes: [],
      etymology: { text: [], formation: null, compound: null }, examples: patch.examples ?? [],
      classification: { kind: "other", selmaho: [] }, labels: [], sources: [],
      license: { expression: "CC0-1.0", url: null, attribution: "Disposable fixture" }, legacy: patch.legacy ?? null,
    },
  );
}`;
/** Serves a synthetic word with routes, based on the server's real response shape. */
async function serveWord(
  page: Page,
  records: any[],
  patch: Record<string, unknown>,
) {
  await page.route("**/api/v1/words/**", async (route) => {
    const real = await (
      await route.fetch({
        url: new URL(
          `/api/v1/words/${encodeURIComponent(fixture().words.cukta)}`,
          page.url(),
        ).href,
      })
    ).json();
    await route.fulfill({ json: { ...real, ...patch } });
  });
  await page.route("**/api/v1/events/**", (route) => {
    const record = records.find((r) =>
      decodeURIComponent(route.request().url()).includes(r.envelope.id),
    );
    return record ? route.fulfill({ json: record.envelope }) : route.continue();
  });
  await page.route("**/api/v1/bodies/**", (route) => {
    const record = records.find((r) =>
      decodeURIComponent(route.request().url()).includes(
        r.envelope.header.content.hash,
      ),
    );
    return record ? route.fulfill({ json: record.body }) : route.continue();
  });
}

test("word pages show tied layers, deprecated and unavailable definitions, and no ranking without a calculation", async ({
  page,
}) => {
  await page.goto("/");
  const records = await page.evaluate(
    async ({ corePath, make }) => {
      const core = await import(corePath);
      await core.initializeCore();
      const build = new Function("core", "return " + make)(core);
      const word = { language: "jbo", spelling: "brodatest" };
      return Array.from({ length: 4 }, (_, index) =>
        build(81, index, word, "en", {}),
      ).sort((a: any, b: any) => (a.envelope.id < b.envelope.id ? -1 : 1));
    },
    { corePath, make: definitionRecord },
  );
  const ids = records.map((r: any) => r.envelope.id);
  const zero = { numerator: "0", denominator: "1" };
  const score = (target: string) => ({
    target,
    support: [zero, zero],
    opposition: [zero, zero],
    net: [zero, zero],
    direct_reviewers: 0,
    status: "active",
  });
  const patch = {
    word: { language: "jbo", spelling: "brodatest" },
    definitions: ids,
    rafsi: [],
    assignments: [],
    layers: [[ids[2], ids[1]], [ids[0]]],
    statuses: ids.map((event: string, index: number) => ({
      event,
      state:
        index === 0 ? "deprecated" : index === 3 ? "unavailable" : "active",
    })),
    unavailable_scores: [ids[3]],
    scores: ids.slice(0, 3).map(score),
  };
  await serveWord(page, records, patch);
  await page.goto("/word/brodatest");
  const articles = page.locator("article.definition");
  await expect(articles).toHaveCount(4);
  // The tied layer keeps the server's order and says that the order is unresolved.
  await expect(
    page.getByText(
      "2 alternatives with unresolved order. Presentation order follows event IDs.",
    ),
  ).toBeVisible();
  expect(
    await articles
      .locator(".byline a[href^='/definition/']")
      .evaluateAll((links) =>
        links.slice(0, 2).map((l) => l.getAttribute("href")),
      ),
  ).toEqual(
    [ids[2], ids[1]].map(
      (id: string) => `/definition/${encodeURIComponent(id)}`,
    ),
  );
  // The deprecated definition says so, and the unavailable one assumes no number.
  await expect(
    page.getByRole("img", {
      name: "Deprecated definition. Judgments are inactive.",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: "Score unavailable" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "No ranking position is available for this definition in the server layers.",
    ),
  ).toBeVisible();
  await expect(page.locator("main")).not.toContainText("NaN");
  // Without a calculation the page makes no ranking claim at all.
  await serveWord(page, records, { ...patch, calculation: null });
  await page.reload();
  await expect(
    page.getByText(/ranking unavailable for this word. No score is assumed./),
  ).toBeVisible();
  await expect(articles).toHaveCount(4);
  await expect(
    page.getByText(/alternatives with unresolved order/),
  ).toHaveCount(0);
  await expect(
    page.getByRole("img", { name: "Score unavailable" }),
  ).toHaveCount(3);
  await expect(page.getByRole("img", { name: /^Score \d/ })).toHaveCount(0);
});

test("hostile imported attribution and text stay literal, and the source details keep the editor, evidence kind, and raw numbers", async ({
  page,
}) => {
  await page.goto("/");
  const [record] = await page.evaluate(
    async ({ corePath, make }) => {
      const core = await import(corePath);
      await core.initializeCore();
      const build = new Function("core", "return " + make)(core);
      const word = { language: "jbo", spelling: "brodatest" };
      return [
        build(82, 0, word, "en", {
          text: [
            [
              "Imported <b>bold</b> text with <script>window.bad=true</script>.",
            ],
          ],
          legacy: {
            source: "https://example.invalid",
            snapshot: "sha256:" + "d".repeat(64),
            extraction: "fixture-v1",
            record: { kind: "definition", id: 1 },
            locator: "definitions/1",
            original: {
              author: "<b>Fixture author</b>",
              value: { $source_number: "123456789012345678901.25" },
            },
            attribution: {
              author: "<b>Fixture author</b>",
              editor: "<i>Fixture editor</i>",
              dates: { created: "2026-10-11" },
              author_account: {
                origin: "https://example.invalid",
                account: 7,
                username: "Fixture author",
                evidence: {
                  kind: "source-id",
                  source: {
                    label: "Fixture",
                    url: null,
                    event: null,
                    locator: null,
                  },
                },
              },
            },
            conversion: {
              method: "literal",
              tool: "fixture",
              version: "1",
              model: null,
              review: "unreviewed",
              mappings: [],
              warnings: [],
            },
            limitations: [],
          },
        }),
      ];
    },
    { corePath, make: definitionRecord },
  );
  const id = record.envelope.id;
  const zero = { numerator: "0", denominator: "1" };
  await serveWord(page, [record], {
    word: { language: "jbo", spelling: "brodatest" },
    definitions: [id],
    rafsi: [],
    assignments: [],
    layers: [[id]],
    statuses: [{ event: id, state: "active" }],
    unavailable_scores: [],
    scores: [
      {
        target: id,
        support: [zero, zero],
        opposition: [zero, zero],
        net: [zero, zero],
        direct_reviewers: 0,
        status: "active",
      },
    ],
  });
  await page.goto(`/definition/${encodeURIComponent(id)}`);
  await expect(
    page.getByText(
      "Imported <b>bold</b> text with <script>window.bad=true</script>.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText("<b>Fixture author</b>", { exact: true }).first(),
  ).toBeVisible();
  expect(await page.locator("main b, main i, main script").count()).toBe(0);
  expect(await page.evaluate(() => Boolean((window as any).bad))).toBe(false);
  await openSourceDisclosure(page);
  await expect(
    page.getByText("Source author: <b>Fixture author</b>.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Source editor: <i>Fixture editor</i>.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Account evidence: source-id.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/Imported from https:\/\/example.invalid, account 7/),
  ).toBeVisible();
  await expect(page.locator("main")).not.toContainText("[object Object]");
  await page
    .getByText("Original source author, account, and import evidence", {
      exact: true,
    })
    .click();
  await expect(page.locator("details[open] pre")).toContainText(
    '"$source_number": "123456789012345678901.25"',
  );
});

test("mixed-language definitions keep their language attributes, and navigation restores heading focus", async ({
  page,
}) => {
  await page.goto("/");
  const [record] = await page.evaluate(
    async ({ corePath, make }) => {
      const core = await import(corePath);
      await core.initializeCore();
      const build = new Function("core", "return " + make)(core);
      const word = { language: "jbo", spelling: "klamatest" };
      return [
        build(95, 8, word, "es", {
          text: [
            [
              "ir a algún lugar ",
              { word: { language: "jbo", spelling: "cadzu" }, label: "cadzu" },
            ],
          ],
          glosses: [{ language: "es", text: "ir", sense: null }],
          examples: [
            {
              language: "jbo",
              text: "mi klama",
              translation: [["voy"]],
              notes: [],
            },
          ],
        }),
      ];
    },
    { corePath, make: definitionRecord },
  );
  const id = record.envelope.id;
  const zero = { numerator: "0", denominator: "1" };
  await serveWord(page, [record], {
    word: { language: "jbo", spelling: "klamatest" },
    definitions: [id],
    rafsi: [],
    assignments: [],
    layers: [[id]],
    statuses: [{ event: id, state: "active" }],
    unavailable_scores: [],
    scores: [
      {
        target: id,
        support: [zero, zero],
        opposition: [zero, zero],
        net: [zero, zero],
        direct_reviewers: 0,
        status: "active",
      },
    ],
  });
  await page.route("**/api/v1/search?**", async (route) => {
    const real = await (await route.fetch()).json();
    await route.fulfill({
      json: {
        ...real,
        next: null,
        hits: [
          {
            word: record.body.word,
            word_id: record.envelope.header.action.word,
            definitions: [id],
            match: "headword",
            preview: {
              event: id,
              word_kind: "other",
              plain_text: "ir a algún lugar cadzu",
              status: "active",
            },
          },
        ],
      },
    });
  });
  await page.goto("/search?q=ir&lang=es");
  const results = page.getByRole("region", { name: "Search results" });
  await expect(
    results.getByRole("link", { name: "klamatest", exact: true }),
  ).toHaveAttribute("lang", "jbo");
  await expect(
    results.getByText("ir a algún lugar cadzu", { exact: true }),
  ).toHaveAttribute("lang", "es");
  await results.getByRole("link", { name: "klamatest", exact: true }).click();
  await expect(page).toHaveTitle("klamatest · jbovlacku");
  await expect(page.locator("main h1")).toBeFocused();
  await expect(page.locator("main h1")).toHaveAttribute("lang", "jbo");
  const article = page.locator("article.definition").first();
  await expect(
    article
      .locator("[lang='es']")
      .filter({ hasText: "ir a algún lugar" })
      .first(),
  ).toBeVisible();
  await expect(
    article.getByRole("link", { name: "cadzu", exact: true }),
  ).toHaveAttribute("lang", "jbo");
  await expect(article.getByText("ir", { exact: true })).toHaveAttribute(
    "lang",
    "es",
  );
  await article.getByText("1 example").click();
  await expect(article.getByText("mi klama", { exact: true })).toHaveAttribute(
    "lang",
    "jbo",
  );
  await expect(
    article
      .getByText("voy", { exact: true })
      .locator("xpath=ancestor-or-self::*[@lang][1]"),
  ).toHaveAttribute("lang", "es");
  await page.goBack();
  await expect(page).toHaveTitle("Search: ir · jbovlacku");
  await expect(page.locator("main h1")).toBeFocused();
  await page.goForward();
  await article
    .getByRole("link", { name: "record", exact: true })
    .or(article.getByRole("link", { name: "link", exact: true }))
    .first()
    .click();
  await expect(page).toHaveTitle("Definition: klamatest · jbovlacku");
  await expect(page.locator("main h1")).toBeFocused();
});

test("a full snapshot hash fits a narrow screen and the wizard works in both themes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 780 });
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.goto("/search?q=book&lang=en");
    await page.getByText("Search source and snapshot", { exact: true }).click();
    const snapshot = await page
      .getByText(/^Snapshot: sha256:[0-9a-f]{64}$/)
      .innerText();
    expect(snapshot).toMatch(/^Snapshot: sha256:[0-9a-f]{64}$/);
    await expect(page.getByText(/^View: jve1:[0-9a-f]{64}$/)).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    // The full hash sits inside the viewport, and no ancestor clips it.
    const box = await page
      .getByText(/^Snapshot: sha256:[0-9a-f]{64}$/)
      .evaluate((node) => {
        const rect = node.getBoundingClientRect();
        let clipped = false;
        for (let e: Element | null = node; e; e = e.parentElement) {
          const style = getComputedStyle(e);
          if (
            (style.overflowX === "hidden" || style.overflowX === "clip") &&
            e.scrollWidth > e.clientWidth
          )
            clipped = true;
        }
        return { left: rect.left, right: rect.right, clipped };
      });
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(360);
    expect(box.clipped).toBe(false);
    for (const path of [
      "/new/meaning",
      "/new/type",
      "/new/form",
      "/new/places",
      "/new/publish",
    ]) {
      await page.goto(path);
      await expect(page.locator("main h1").first()).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        `${path} ${colorScheme}`,
      ).toBe(true);
    }
  }
});

test("judgment controls stop listening after their page is gone", async ({
  page,
}) => {
  await page.goto("/");
  // Count live own-state subscriptions. Every control subscribes once.
  await page.evaluate(async () => {
    const { OwnState } = await import(String("/src/app/context.ts"));
    const original = OwnState.prototype.subscribe;
    (window as any).__ownListeners = 0;
    OwnState.prototype.subscribe = function (listener: () => void) {
      (window as any).__ownListeners++;
      const unsubscribe = original.call(this, listener);
      return () => {
        (window as any).__ownListeners--;
        return unsubscribe();
      };
    };
  });
  const listeners = () => page.evaluate(() => (window as any).__ownListeners);
  // The Trust page's own subscriptions are the baseline, measured after the
  // complete Trust content, including the site view section, is rendered.
  const trustComplete = async () => {
    await expect(
      page.getByRole("radio", { name: "Site view only" }),
    ).toBeVisible();
    await expect(page.locator("main")).toContainText("Calculation profile");
  };
  await page.getByRole("link", { name: /^Trust:/ }).click();
  await trustComplete();
  const baseline = await listeners();
  await page.getByLabel("Search words and meanings").fill("cukta");
  await page.getByLabel("Search words and meanings").press("Enter");
  await page
    .getByRole("region", { name: "Search results" })
    .getByRole("link", { name: "cukta", exact: true })
    .first()
    .click();
  await expect(page).toHaveTitle("cukta · jbovlacku");
  await expect(
    page
      .locator("article.definition")
      .first()
      .getByRole("button", { name: "Endorse" }),
  ).toBeVisible();
  expect(await listeners()).toBeGreaterThan(baseline);
  await page.getByLabel("Search words and meanings").fill("vlacku");
  await page.getByLabel("Search words and meanings").press("Enter");
  await page
    .getByRole("region", { name: "Search results" })
    .getByRole("link", { name: "vlacku", exact: true })
    .first()
    .click();
  await expect(page).toHaveTitle("vlacku · jbovlacku");
  await page.getByRole("link", { name: /^Trust:/ }).click();
  await trustComplete();
  // The explicit boundary: every subscription from the earlier pages is gone.
  await expect.poll(listeners).toBe(baseline);
  // A session change then reaches no control at all.
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const original = LocalStore.prototype.list;
    (window as any).__outboxReads = 0;
    LocalStore.prototype.list = function (name: string) {
      if (name === "outbox") (window as any).__outboxReads++;
      return original.call(this, name);
    };
  });
  await page
    .getByRole("radio", { name: "Mine: site view + my choices" })
    .check();
  await expect(
    page.getByRole("link", { name: "Trust: personal view" }),
  ).toBeVisible();
  // The preference is saved, so the session listeners have all run.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { LocalStore } = await import(String("/src/data/store.ts"));
        return (await new LocalStore().preferences()).viewMode;
      }),
    )
    .toBe("personal");
  expect(await page.evaluate(() => (window as any).__outboxReads)).toBe(0);
  expect(await listeners()).toBe(baseline);
});

test("a literal circled character in a search preview stays literal text", async ({
  page,
}) => {
  await page.goto("/");
  const [record] = await page.evaluate(
    async ({ corePath, make }) => {
      const core = await import(corePath);
      await core.initializeCore();
      const build = new Function("core", "return " + make)(core);
      const word = { language: "jbo", spelling: "brodatest" };
      return [build(83, 0, word, "en", { text: [["see ① literally"]] })];
    },
    { corePath, make: definitionRecord },
  );
  const id = record.envelope.id;
  await serveWord(page, [record], {
    word: { language: "jbo", spelling: "brodatest" },
    definitions: [id],
    scores: [],
    statuses: [{ event: id, state: "active" }],
    layers: [[id]],
    unavailable_scores: [],
  });
  await page.route("**/api/v1/search?**", async (route) => {
    const real = await (await route.fetch()).json();
    await route.fulfill({
      json: {
        ...real,
        hits: [
          {
            word: { language: "jbo", spelling: "brodatest" },
            word_id: record.envelope.header.action.word,
            match: "headword",
            definitions: [id],
            preview: {
              event: id,
              word_kind: "other",
              plain_text: "see ① literally",
              status: "active",
            },
          },
        ],
        next: null,
      },
    });
  });
  await page.goto("/search?q=brodatest&lang=en");
  const row = page
    .getByRole("region", { name: "Search results" })
    .locator("article")
    .first();
  await expect(row).toContainText("see ① literally");
  await expect(row.getByRole("img", { name: "place 1" })).toHaveCount(0);
  // The attribution loads from the signed record. The preview stays literal after that too.
  await expect(row.locator(".attribution-line")).not.toBeEmpty();
  await expect(row).toContainText("see ① literally");
  await expect(row.getByRole("img", { name: "place 1" })).toHaveCount(0);
});

test("a fresh lifetime helper releases a node that joins and leaves before any later change", async ({
  page,
}) => {
  await page.goto("/about");
  const result = await page.evaluate(async () => {
    // A fresh module instance, with no observer started by an earlier control.
    const { onDisconnect } = await import(
      String(`/src/lib/lifetime.ts?fresh=${Date.now()}`)
    );
    const wait = () => new Promise((resolve) => setTimeout(resolve, 50));
    let cleaned = 0;
    const node = document.createElement("div");
    onDisconnect(node, () => cleaned++);
    document.body.append(node);
    node.remove();
    await wait();
    const afterOwnLifetime = cleaned;
    const probe = document.createElement("div");
    document.body.append(probe);
    probe.remove();
    await wait();
    // A node that never joined stays subscribed until its signal ends.
    let detachedCleaned = 0;
    const detached = document.createElement("div");
    const controller = new AbortController();
    onDisconnect(detached, () => detachedCleaned++, controller.signal);
    const again = document.createElement("div");
    document.body.append(again);
    again.remove();
    await wait();
    const detachedBeforeAbort = detachedCleaned;
    controller.abort();
    return {
      afterOwnLifetime,
      afterLaterChange: cleaned,
      detachedBeforeAbort,
      detachedAfterAbort: detachedCleaned,
    };
  });
  expect(result).toEqual({
    afterOwnLifetime: 1,
    afterLaterChange: 1,
    detachedBeforeAbort: 0,
    detachedAfterAbort: 1,
  });
});

test("a focus choice made while a page loads is kept, Enter then submits the search, and further input in the focused field after a search starts is kept too", async ({
  page,
}) => {
  await page.goto("/");
  const field = page.getByLabel("Search words and meanings");
  // The Trust page waits for the view probe, which the test holds.
  let releaseProbe = () => {};
  const probeHeld = new Promise<void>((resolve) => (releaseProbe = resolve));
  const probe = "**/api/v1/words/jvw1%3A0000*";
  await page.route(probe, async (route) => {
    await probeHeld;
    await route.continue();
  });
  await page.getByRole("link", { name: /^Trust:/ }).click();
  await expect(
    page.getByRole("radio", { name: "Site view only" }),
  ).toBeVisible();
  // The reader moves to the search field while the page still loads.
  await field.click();
  await expect(field).toBeFocused();
  releaseProbe();
  await expect(page.locator("main")).toContainText("Calculation profile");
  await expect(field).toBeFocused();
  await expect(page.locator("main h1")).not.toBeFocused();
  await field.fill("cukta");
  await field.press("Enter");
  await expect(page).toHaveURL(/\/search\?q=cukta&lang=en$/);
  await expect(
    page
      .getByRole("region", { name: "Search results" })
      .getByRole("link", { name: "cukta", exact: true })
      .first(),
  ).toBeVisible();
  await page.unroute(probe);
  // A search starts and its request is held. The reader keeps typing in the
  // same field. The finished page leaves focus and the typed text alone.
  let releaseSearch = () => {};
  const searchHeld = new Promise<void>((resolve) => (releaseSearch = resolve));
  await page.route("**/api/v1/search?**", async (route) => {
    await searchHeld;
    await route.continue();
  });
  await field.fill("vla");
  await field.press("Enter");
  await expect(page).toHaveURL(/\/search\?q=vla&lang=en$/);
  await expect(field).toBeFocused();
  await page.keyboard.type("cku");
  await expect(field).toHaveValue("vlacku");
  releaseSearch();
  await expect(
    page
      .getByRole("region", { name: "Search results" })
      .locator("article")
      .first(),
  ).toBeVisible();
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("vlacku");
  await expect(page.locator("main h1")).not.toBeFocused();
  await page.unroute("**/api/v1/search?**");
  await field.press("Enter");
  await expect(page).toHaveURL(/\/search\?q=vlacku&lang=en$/);
  await expect(
    page
      .getByRole("region", { name: "Search results" })
      .getByRole("link", { name: "vlacku", exact: true })
      .first(),
  ).toBeVisible();
  // Without further interaction, navigation still focuses the heading.
  await page.getByRole("link", { name: /^Trust:/ }).click();
  await expect(page.locator("main h1")).toBeFocused();
});
