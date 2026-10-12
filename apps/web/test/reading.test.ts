import { test, expect } from "@playwright/test";
import { fixture, fingerprintText } from "./helpers.ts";

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
  await page
    .getByRole("button", { name: "Source" })
    .or(page.getByText("Source", { exact: true }))
    .first()
    .click();
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
    first.getByText(/The score adds the weight of each reviewer in your/),
  ).toBeVisible();
  await expect(first.getByRole("link", { name: "trust view" })).toHaveAttribute(
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
    page.getByText("Web UI test view. Published by this server."),
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
