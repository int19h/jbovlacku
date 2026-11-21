import { test, expect, type Page } from "@playwright/test";
import {
  acceptFirstSignature,
  corePath,
  createIdentity,
  fixture,
  openWord,
  PASSPHRASE,
} from "./helpers.ts";

/** A synthetic definition record signed with a disposable seed. */
const definitionRecord = `(seed, index, word, language, patch) => {
  return core.createEvent(
    new Uint8Array(32).fill(seed),
    [],
    (index + 11).toString(16).padStart(2, "0").repeat(16),
    { kind: "definition.publish", word: core.wordId(word), language, parents: [], origin: patch.legacy ? "import" : "native" },
    {
      word, language, text: patch.text ?? [["Definition " + index]], frame: patch.frame ?? null, operands: [], glosses: patch.glosses ?? [], notes: [],
      etymology: { text: [], formation: null, compound: null }, examples: patch.examples ?? [],
      classification: { kind: patch.kind ?? "other", selmaho: [] }, labels: [], sources: patch.sources ?? [],
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

const zero = { numerator: "0", denominator: "1" };
const zeroScore = (target: string) => ({
  target,
  support: [zero, zero],
  opposition: [zero, zero],
  net: [zero, zero],
  direct_reviewers: 0,
  status: "active",
});

test("personal view shows definitions while the calculation runs, then scores them", async ({
  page,
}) => {
  const f = fixture();
  await page.goto("/word/cukta");
  await expect(page.locator("article.definition").first()).toBeVisible();
  await page.getByRole("link", { name: /^Trust:/ }).click();
  await page
    .getByRole("radio", { name: "Mine: site view + my choices" })
    .check();
  await expect(
    page.getByRole("link", { name: "Trust: personal view" }),
  ).toBeVisible();
  // Hold the record download open. The definitions must still appear.
  await page.route("**/api/v1/manifest*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 6000));
    await route.continue();
  });
  await page.goto("/word/cukta");
  const panel = page.getByRole("region", { name: "Personal view" });
  await expect(page.locator("article.definition").first()).toBeVisible({
    timeout: 4000,
  });
  await expect(panel).toContainText(/Downloading|Calculating/);
  await expect(
    page
      .locator("article.definition")
      .first()
      .getByRole("img", { name: /in your personal view$/ }),
  ).toBeVisible({ timeout: 30000 });
  void f;
});

test("endorse without a key returns to the word after the key is created", async ({
  page,
}) => {
  await page.goto("/word/cukta");
  const first = page.locator("article.definition").first();
  await first.getByRole("button", { name: "Endorse" }).click();
  await expect(page).toHaveURL(/\/identity$/);
  await expect(page.getByText(/will continue after you create/)).toBeVisible();
  await page.getByLabel("New passphrase", { exact: true }).fill(PASSPHRASE);
  await page.getByLabel("Repeat passphrase").fill(PASSPHRASE);
  await page.getByRole("button", { name: "Create a key" }).click();
  await acceptFirstSignature(page);
  await expect(page).toHaveURL(/\/word\/cukta/, { timeout: 15000 });
  await expect(page.getByRole("status")).toContainText(
    "Your endorsement is published.",
  );
  await expect(
    page
      .locator("article.definition")
      .first()
      .getByRole("button", { name: "Endorse" }),
  ).toHaveAttribute("aria-pressed", "true", { timeout: 15000 });
});

test("phone language tabs stay on one row and a lujvo without compound evidence says so", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const languages = [
    "en",
    "fr",
    "de",
    "es",
    "it",
    "pt",
    "ru",
    "ja",
    "zh",
    "eo",
    "la",
    "jbo",
  ];
  await page.goto("/");
  const built = await page.evaluate(
    async ({ corePath: path, make: source, languages: langs }) => {
      const core = await import(path);
      await core.initializeCore();
      const build = new Function("core", "return " + source)(core);
      const word = { language: "jbo", spelling: "jbobautest" };
      return langs.map((language: string, index: number) =>
        build(91, index, word, language, { kind: "lujvo" }),
      );
    },
    { corePath, make: definitionRecord, languages },
  );
  const ids = built.map((r: any) => r.envelope.id);
  await serveWord(page, built, {
    word: { language: "jbo", spelling: "jbobautest" },
    definitions: ids,
    rafsi: [],
    assignments: [],
    layers: [ids],
    statuses: ids.map((event: string) => ({ event, state: "active" })),
    unavailable_scores: [],
    scores: ids.map(zeroScore),
  });
  await page.goto("/word/jbobautest?lang=en");
  await expect(
    page.getByText("Composition is not recorded for this lujvo."),
  ).toBeVisible();
  const tops = await page
    .locator(".tabs .tab")
    .evaluateAll((nodes) =>
      nodes.map((n) => Math.round((n as HTMLElement).offsetTop)),
    );
  expect(tops.length).toBeGreaterThan(8);
  expect(new Set(tops).size).toBe(1);
  const firstTop = await page
    .locator("article.definition")
    .first()
    .evaluate((n) => n.getBoundingClientRect().top + window.scrollY);
  expect(firstTop).toBeLessThan(500);
});

test("the Place table header stays on one line", async ({ page }) => {
  await page.goto("/word/cukta");
  const article = page.locator("article.definition").first();
  await article.getByText("Places in detail", { exact: true }).click();
  const header = article.locator(".places-table th").first();
  await expect(header).toHaveText("Place");
  const height = await header.evaluate((n) => n.getBoundingClientRect().height);
  expect(height).toBeLessThan(40);
});

test("source locators show exactly as signed in the Source disclosure", async ({
  page,
}) => {
  await page.goto("/");
  const built = await page.evaluate(
    async ({ corePath: path, make: source }) => {
      const core = await import(path);
      await core.initializeCore();
      const build = new Function("core", "return " + source)(core);
      const word = { language: "jbo", spelling: "brodatest" };
      return [
        build(92, 0, word, "en", {
          sources: [
            {
              label: "Public domain notice",
              url: null,
              event: null,
              locator: "footer.publicDomainNotice",
            },
          ],
          legacy: {
            source: "https://example.invalid",
            snapshot: "sha256:" + "d".repeat(64),
            extraction: "fixture-v1",
            record: { kind: "definition", id: 583 },
            locator: "definitions/definitionid=583/cached_username",
            original: {
              author: "Fixture author",
              value: { $source_number: "123456789012345678901.25" },
            },
            attribution: {
              author: "Fixture author",
              editor: "Fixture editor",
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
  const id = built[0].envelope.id;
  await serveWord(page, built, {
    word: { language: "jbo", spelling: "brodatest" },
    definitions: [id],
    rafsi: [],
    assignments: [],
    layers: [[id]],
    statuses: [{ event: id, state: "active" }],
    unavailable_scores: [],
    scores: [zeroScore(id)],
  });
  await page.goto(`/definition/${encodeURIComponent(id)}`);
  const source = page.locator("details.disclosure", {
    has: page.locator("summary", { hasText: /^Source$/ }),
  });
  await source.locator("summary").click();
  // Signed text stays literal: no case, separator or key rewriting.
  await expect(
    source.getByText("Position definitions/definitionid=583/cached_username.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    source.getByText(/ · footer\.publicDomainNotice$/),
  ).toBeVisible();
  await expect(source).not.toContainText("footer · public");
  await expect(source).not.toContainText("cached username");
});

test("a tied layer gives a reason that holds for every kind of layer", async ({
  page,
}) => {
  await page.goto("/");
  const built = await page.evaluate(
    async ({ corePath: path, make: source }) => {
      const core = await import(path);
      await core.initializeCore();
      const build = new Function("core", "return " + source)(core);
      const word = { language: "jbo", spelling: "brodatest" };
      return [0, 1].map((index) => build(93, index, word, "en", {}));
    },
    { corePath, make: definitionRecord },
  );
  const ids = built.map((r: any) => r.envelope.id);
  await serveWord(page, built, {
    word: { language: "jbo", spelling: "brodatest" },
    definitions: ids,
    rafsi: [],
    assignments: [],
    layers: [ids],
    statuses: ids.map((event: string) => ({ event, state: "active" })),
    unavailable_scores: [],
    scores: ids.map(zeroScore),
  });
  await page.goto("/word/brodatest");
  await expect(
    page.getByText(
      "2 alternatives with unresolved order. The pairwise comparisons do not put the definitions in this group in one order. Every score in this group is zero. Presentation order follows event IDs.",
    ),
  ).toBeVisible();
  // The layer may come from a comparison cycle, which this client cannot
  // see, so no claim that nothing is ahead.
  await expect(page.getByText(/clearly ahead|certified ahead/)).toHaveCount(0);
});

test("compare links name the comparison in the page title", async ({
  page,
}) => {
  const f = fixture();
  await page.goto(
    `/definition/${encodeURIComponent(f.definitions.cuktaRev)}?compare=${encodeURIComponent(f.definitions.cukta1)}`,
  );
  await expect(page).toHaveTitle("Compare: cukta · jbovlacku");
  await expect(
    page.getByText(/The comparison with the parent revision is below/),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Compare with the parent revision" }),
  ).toBeVisible();
});

test("the deprecated layer says that its definitions are not ranked against each other", async ({
  page,
}) => {
  await page.goto("/");
  const built = await page.evaluate(
    async ({ corePath: path, make: source }) => {
      const core = await import(path);
      await core.initializeCore();
      const build = new Function("core", "return " + source)(core);
      const word = { language: "jbo", spelling: "brodatest" };
      return [0, 1, 2].map((index) => build(94, index, word, "en", {}));
    },
    { corePath, make: definitionRecord },
  );
  const ids = built.map((r: any) => r.envelope.id);
  const one = { numerator: "1", denominator: "1" };
  await serveWord(page, built, {
    word: { language: "jbo", spelling: "brodatest" },
    definitions: ids,
    rafsi: [],
    assignments: [],
    // The ranking puts deprecated definitions last without comparing them.
    // One of them has a clearly higher score than the other.
    layers: [[ids[0]], [ids[1], ids[2]]],
    statuses: ids.map((event: string, index: number) => ({
      event,
      state: index === 0 ? "active" : "deprecated",
    })),
    unavailable_scores: [],
    scores: [
      zeroScore(ids[0]),
      {
        ...zeroScore(ids[1]),
        support: [one, one],
        net: [one, one],
        direct_reviewers: 1,
      },
      zeroScore(ids[2]),
    ],
  });
  await page.goto("/word/brodatest");
  await expect(page.locator("article.definition")).toHaveCount(3);
  await expect(
    page.getByText(
      "2 alternatives with unresolved order. Deprecated definitions are not ranked against each other. Presentation order follows event IDs.",
    ),
  ).toBeVisible();
});

test("a compare link names the comparison only when it shows one with the parent", async ({
  page,
}) => {
  const f = fixture();
  const lead = page.locator("main > p.meta").first();
  // A revision that is not the parent of this one.
  await page.goto(
    `/definition/${encodeURIComponent(f.definitions.cuktaRev)}?compare=${encodeURIComponent(f.definitions.cukta2)}`,
  );
  await expect(
    page.getByRole("heading", { name: "Compare with the parent revision" }),
  ).toBeVisible();
  await expect(lead).toHaveText(
    "One immutable revision. Its exact event ID identifies this publication.",
  );
  // A comparison that does not load.
  const missing = `jve1:${"0".repeat(64)}`;
  await page.goto(
    `/definition/${encodeURIComponent(f.definitions.cuktaRev)}?compare=${encodeURIComponent(missing)}`,
  );
  await expect(page.getByText(/^Comparison unavailable:/)).toBeVisible();
  await expect(lead).toHaveText(
    "One immutable revision. Its exact event ID identifies this publication.",
  );
});

test("a rafsi claim without a key ends on the word page that the claim opens", async ({
  page,
}) => {
  await page.goto("/claim/cukta");
  await page.getByLabel("Rafsi spelling").fill("cuk");
  await page.getByRole("button", { name: "Check claims and preview" }).click();
  await page
    .getByRole("button", { name: "Sign and publish the claim" })
    .click();
  await expect(page).toHaveURL(/\/identity$/);
  await page.getByLabel("New passphrase", { exact: true }).fill(PASSPHRASE);
  await page.getByLabel("Repeat passphrase").fill(PASSPHRASE);
  await page.getByRole("button", { name: "Create a key" }).click();
  await acceptFirstSignature(page);
  await expect(page.getByRole("status")).toContainText(
    "Published the claim cuk for cukta",
    { timeout: 15000 },
  );
  await expect(page).toHaveURL(/\/word\/cukta\?fresh=1$/);
  await expect(page.locator("main h1").first()).toHaveText("cukta");
  // Nothing sends the reader back to the empty claim form afterwards.
  await page.waitForTimeout(1500);
  await expect(page).toHaveURL(/\/word\/cukta\?fresh=1$/);
  await expect(page.getByLabel("Rafsi spelling")).toHaveCount(0);
});

test("a page path with a doubled slash never becomes another origin after the key is created", async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  const leaving: string[] = [];
  page.on("request", (request) => {
    if (
      request.isNavigationRequest() &&
      new URL(request.url()).origin !== origin
    )
      leaving.push(request.url());
  });
  // "//word/cukta" renders the word page, but as a URL it names the host "word".
  await page.goto(`${origin}//word/cukta`);
  await page
    .locator("article.definition")
    .first()
    .getByRole("button", { name: "Endorse" })
    .click();
  await expect(page).toHaveURL(/\/identity$/);
  await page.getByLabel("New passphrase", { exact: true }).fill(PASSPHRASE);
  await page.getByLabel("Repeat passphrase").fill(PASSPHRASE);
  await page.getByRole("button", { name: "Create a key" }).click();
  await acceptFirstSignature(page);
  await expect(page.getByRole("status")).toContainText(
    "Your endorsement is published.",
    { timeout: 15000 },
  );
  await page.waitForTimeout(1500);
  // The unsafe return path is dropped: the reader stays on this site.
  expect(leaving).toEqual([]);
  expect(page.url()).toBe(`${origin}/identity`);
});

/** Turns on the personal view through the Trust page. */
async function personalMode(page: Page) {
  await page.goto("/word/cukta");
  await expect(page.locator("article.definition").first()).toBeVisible();
  await page.getByRole("link", { name: /^Trust:/ }).click();
  await page
    .getByRole("radio", { name: "Mine: site view + my choices" })
    .check();
  await expect(
    page.getByRole("link", { name: "Trust: personal view" }),
  ).toBeVisible();
}

test("scores that arrive later keep focus, scroll position and the status line", async ({
  page,
  browserName,
}) => {
  await page.setViewportSize({ width: 390, height: 600 });
  if (browserName === "chromium")
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"]);
  await personalMode(page);
  await page.route("**/api/v1/manifest*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 6000));
    await route.continue();
  });
  await page.goto("/word/cukta");
  const articles = page.locator("article.definition");
  await expect(articles.first()).toBeVisible({ timeout: 4000 });
  await expect(
    page.getByText(
      /^Personal scores are unavailable: The local calculation is not ready yet\./,
    ),
  ).toBeVisible();
  // The page must never go blank while the scores arrive.
  await page.evaluate(() => {
    const w = window as unknown as { blanks: number };
    w.blanks = 0;
    const main = document.querySelector("main")!;
    new MutationObserver(() => {
      if (main.childElementCount === 0) w.blanks++;
    }).observe(main, { childList: true });
  });
  // A real announcement from the reader's own action.
  await page.getByRole("button", { name: "Copy cukta" }).click();
  const status = page.getByRole("status");
  await expect(status).not.toHaveText("");
  const announced = await status.textContent();
  const last = articles.last();
  await last.scrollIntoViewIfNeeded();
  const endorse = last.getByRole("button", { name: "Endorse" });
  await endorse.focus();
  const before = await page.evaluate(() => {
    const active = document.activeElement as HTMLElement;
    return {
      scrollY: window.scrollY,
      top: active.getBoundingClientRect().top,
      // The definition block that holds focus, named by its heading.
      key: active.closest("article")?.getAttribute("aria-labelledby") ?? null,
      label: active.getAttribute("aria-label"),
    };
  });
  expect(before.scrollY).toBeGreaterThan(300);
  expect(before.key).not.toBeNull();
  await expect(
    articles.first().getByRole("img", { name: /in your personal view$/ }),
  ).toBeVisible({ timeout: 40000 });
  await expect(page.getByText(/^Personal scores are unavailable/)).toHaveCount(
    0,
  );
  const after = await page.evaluate(() => {
    const active = document.activeElement as HTMLElement;
    return {
      url: location.pathname + location.search,
      scrollY: window.scrollY,
      top: active.getBoundingClientRect().top,
      // The definition block that holds focus, named by its heading.
      key: active.closest("article")?.getAttribute("aria-labelledby") ?? null,
      label: active.getAttribute("aria-label"),
      blanks: (window as unknown as { blanks: number }).blanks,
    };
  });
  console.log(
    `scored update: before ${JSON.stringify(before)} after ${JSON.stringify(after)}`,
  );
  expect(after.url).toBe("/word/cukta");
  expect(after.blanks).toBe(0);
  expect(after.key).toBe(before.key);
  expect(after.label).toBe("Endorse");
  // The reader's control stays where it was on screen.
  expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(2);
  expect(after.scrollY).toBeGreaterThan(300);
  await expect(status).toHaveText(announced!);
});

test("after a failed calculation, a later word page shows the retry and then its scores", async ({
  page,
}) => {
  await page.goto("/word/cukta");
  await expect(page.locator("article.definition").first()).toBeVisible();
  await page.route("**/api/v1/manifest*", (route) => route.abort());
  await page.getByRole("link", { name: /^Trust:/ }).click();
  await page
    .getByRole("radio", { name: "Mine: site view + my choices" })
    .check();
  await expect(
    page.getByRole("link", { name: "Trust: personal view" }),
  ).toBeVisible();
  await page.goBack();
  const note = page.getByText(/^Personal scores are unavailable:/);
  await expect(note).toContainText("No connection to the server.", {
    timeout: 30000,
  });
  // The connection comes back slowly. A later word page starts a retry.
  await page.unroute("**/api/v1/manifest*");
  await page.route("**/api/v1/manifest*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 4000));
    await route.continue();
  });
  await page.locator(".tabs .tab").last().click();
  await expect(page).toHaveURL(/lang=all/);
  const panel = page.getByRole("region", { name: "Personal view" });
  await expect(panel).toContainText(/Downloading|Calculating/);
  // While the retry runs, the old failure is not the page state.
  await expect(note).toContainText("The local calculation is not ready yet.");
  await expect(note).not.toContainText("No connection");
  // The retry's scores replace the note when it settles.
  await expect(
    page
      .locator("article.definition")
      .first()
      .getByRole("img", { name: /in your personal view$/ }),
  ).toBeVisible({ timeout: 40000 });
  await expect(note).toHaveCount(0);
});

/** Serves the synthetic 12-language lujvo used by the tab tests. */
async function manyLanguages(page: Page) {
  const languages = [
    "en",
    "fr",
    "de",
    "es",
    "it",
    "pt",
    "ru",
    "ja",
    "zh",
    "eo",
    "la",
    "jbo",
  ];
  await page.goto("/");
  const built = await page.evaluate(
    async ({ corePath: path, make: source, languages: langs }) => {
      const core = await import(path);
      await core.initializeCore();
      const build = new Function("core", "return " + source)(core);
      const word = { language: "jbo", spelling: "jbobautest" };
      return langs.map((language: string, index: number) =>
        build(91, index, word, language, { kind: "lujvo" }),
      );
    },
    { corePath, make: definitionRecord, languages },
  );
  const ids = built.map((r: any) => r.envelope.id);
  await serveWord(page, built, {
    word: { language: "jbo", spelling: "jbobautest" },
    definitions: ids,
    rafsi: [],
    assignments: [],
    layers: [ids],
    statuses: ids.map((event: string) => ({ event, state: "active" })),
    unavailable_scores: [],
    scores: ids.map(zeroScore),
  });
}

test("desktop language tabs all stay visible", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await manyLanguages(page);
  await page.goto("/word/jbobautest?lang=en");
  await expect(page.locator(".tabs .tab")).toHaveCount(13);
  const geometry = await page.locator(".tabs").evaluate((strip) => {
    const box = strip.getBoundingClientRect();
    return {
      overflowX: getComputedStyle(strip).overflowX,
      scrollWidth: strip.scrollWidth,
      clientWidth: strip.clientWidth,
      hidden: [...strip.children].filter((tab) => {
        const r = tab.getBoundingClientRect();
        return r.left < box.left || r.right > box.right;
      }).length,
    };
  });
  expect(geometry.overflowX).toBe("visible");
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
  expect(geometry.hidden).toBe(0);
});

test("phone language tabs show the selected tab, with unclipped focus ring and underline", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await manyLanguages(page);
  await page.goto("/word/jbobautest?lang=all");
  const strip = page.locator(".tabs");
  await expect(strip.locator(".tab")).toHaveCount(13);
  const current = strip.locator('.tab[aria-current="true"]');
  await expect(current).toHaveText(/^All/);
  // Wait for the strip to scroll the selected tab into view.
  await expect
    .poll(() =>
      strip.evaluate((node) => {
        const box = node.getBoundingClientRect();
        const tab = node
          .querySelector('[aria-current="true"]')!
          .getBoundingClientRect();
        return tab.left >= box.left - 0.5 && tab.right <= box.right + 0.5;
      }),
    )
    .toBe(true);
  const geometry = await strip.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const tab = node
      .querySelector('[aria-current="true"]')!
      .getBoundingClientRect();
    const tops = [...node.children].map((t) =>
      Math.round(t.getBoundingClientRect().top),
    );
    return {
      windowScrollY: window.scrollY,
      rows: new Set(tops).size,
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
      // The active underline is the tab's bottom border.
      underlineInside:
        tab.bottom <= box.top + node.clientTop + node.clientHeight + 0.5,
    };
  });
  expect(geometry.windowScrollY).toBe(0);
  expect(geometry.rows).toBe(1);
  expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.clientHeight);
  expect(geometry.underlineInside).toBe(true);
  // Keyboard focus on a tab: the whole ring stays inside the strip.
  await strip.locator(".tab").nth(11).focus();
  await page.keyboard.press("Tab");
  await expect(current).toBeFocused();
  const ring = await strip.evaluate((node) => {
    const active = document.activeElement as HTMLElement;
    const style = getComputedStyle(active);
    const spread =
      parseFloat(style.outlineOffset) + parseFloat(style.outlineWidth);
    const r = active.getBoundingClientRect();
    const box = node.getBoundingClientRect();
    const inner = {
      top: box.top + node.clientTop,
      left: box.left + node.clientLeft,
      bottom: box.top + node.clientTop + node.clientHeight,
      right: box.left + node.clientLeft + node.clientWidth,
    };
    return {
      focusVisible: active.matches(":focus-visible"),
      spread,
      inside:
        r.top - spread >= inner.top - 0.5 &&
        r.bottom + spread <= inner.bottom + 0.5 &&
        r.left - spread >= inner.left - 0.5 &&
        r.right + spread <= inner.right + 0.5,
    };
  });
  expect(ring.focusVisible).toBe(true);
  expect(ring.inside).toBe(true);
});

// Round 3: the in-place update of personal scores, and the key-creation return.

/** Turns on the personal view and holds the record download until released. */
async function heldPersonal(page: Page) {
  await page.goto("/trust");
  await page
    .getByRole("radio", { name: "Mine: site view + my choices" })
    .check();
  await expect(
    page.getByRole("link", { name: "Trust: personal view" }),
  ).toBeVisible();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/v1/manifest*", async (route) => {
    await held;
    await route.continue();
  });
  return release;
}
const block = (page: Page, key: string) =>
  page.locator(`article.definition[data-key="${key}"]`);
const scored = (page: Page, key?: string) =>
  expect(
    (key
      ? block(page, key)
      : page.locator("article.definition").first()
    ).getByRole("img", { name: /in your personal view$/ }),
  ).toBeVisible({ timeout: 40000 });
const order = (page: Page) =>
  page
    .locator("article.definition")
    .evaluateAll((n) => n.map((a) => (a as HTMLElement).dataset.key));
/** A curator profile name that arrives after the identity link is drawn. */
async function namedCurator(page: Page) {
  const f = fixture();
  await page.route(
    `**/api/v1/identities/${encodeURIComponent(f.identities.curator)}*`,
    async (route) => {
      const real = await (await route.fetch()).json();
      await route.fulfill({
        json: {
          ...real,
          profile: {
            state: "known",
            claims: [
              {
                id: "jve1:" + "a".repeat(64),
                body: { name: "Curator Alice", bio: [], links: [] },
              },
            ],
          },
        },
      });
    },
  );
}

test("a reader at the top of a word page stays there when personal scores reorder it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const release = await heldPersonal(page);
  await page.goto("/word/cukta");
  await expect(page.locator("article.definition").first()).toBeVisible();
  const before = await order(page);
  release();
  await scored(page);
  await page.waitForTimeout(300);
  // The fixture's ranked order differs from the provisional event order.
  expect((await order(page))[0]).not.toBe(before[0]);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await expect(page.locator("main h1")).toBeInViewport();
});

test("a heading that the app focused stays focused and on screen when scores arrive", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const release = await heldPersonal(page);
  await openWord(page, "cukta");
  await expect(page.locator("article.definition").first()).toBeVisible();
  await expect(page.locator("main h1")).toBeFocused();
  release();
  await scored(page);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await expect(page.locator("main h1")).toBeFocused();
  await expect(page.locator("main h1")).toBeInViewport();
});

test("focus on a link inside an open disclosure survives the scores", async ({
  page,
}) => {
  const f = fixture();
  const release = await heldPersonal(page);
  await page.goto("/word/cukta");
  const cukta1 = block(page, f.definitions.cukta1);
  await expect(cukta1).toBeVisible();
  await cukta1.getByText("Notes", { exact: true }).click();
  const note = () =>
    block(page, f.definitions.cukta1).locator("details#notes a", {
      hasText: "ckusro",
    });
  await expect(note()).toBeVisible();
  await note().focus();
  release();
  await scored(page, f.definitions.cukta1);
  await page.waitForTimeout(300);
  await expect(note()).toBeFocused();
});

test("focus on an identity link that shows a profile name survives the scores", async ({
  page,
}) => {
  const f = fixture();
  await namedCurator(page);
  const release = await heldPersonal(page);
  await page.goto("/word/cukta");
  const author = () =>
    block(page, f.definitions.cukta1)
      .locator(".byline a.identity-link")
      .first();
  await expect(author()).toHaveText("Curator Alice");
  await author().focus();
  release();
  await scored(page, f.definitions.cukta1);
  await page.waitForTimeout(300);
  await expect(author()).toBeFocused();
});

test("a nested open disclosure stays open when the scores arrive", async ({
  page,
}) => {
  const release = await heldPersonal(page);
  await page.goto("/word/ckusro");
  const source = () =>
    page
      .locator("article.definition")
      .first()
      .locator("details.disclosure", {
        has: page.locator("summary", { hasText: /^Source$/ }),
      });
  const evidence = () =>
    source().locator("details.disclosure", {
      has: page.locator("summary", { hasText: /Original source author/ }),
    });
  await source().locator("summary").click();
  await evidence().locator("summary").click();
  await expect(evidence().locator("pre.json")).toBeVisible();
  release();
  await scored(page);
  await page.waitForTimeout(300);
  await expect(source()).toHaveAttribute("open", "");
  await expect(evidence()).toHaveAttribute("open", "");
  await expect(evidence().locator("pre.json")).toBeVisible();
});

test("open disclosures above a focused control do not push it down after the scores", async ({
  page,
}) => {
  const f = fixture();
  await page.setViewportSize({ width: 390, height: 600 });
  const release = await heldPersonal(page);
  await page.goto("/word/cukta");
  const c1 = block(page, f.definitions.cukta1);
  const c2 = block(page, f.definitions.cukta2);
  await expect(c1).toBeVisible();
  await c1.getByText("Places in detail", { exact: true }).click();
  await expect(c1.locator(".places-table")).toBeVisible();
  await c1.getByText("Signed record", { exact: true }).click();
  await expect(c1.locator("pre.json")).toBeVisible();
  await c2.scrollIntoViewIfNeeded();
  await c2.getByRole("button", { name: "Endorse" }).focus();
  const top = () =>
    page.evaluate(
      () => (document.activeElement as HTMLElement).getBoundingClientRect().top,
    );
  const before = await top();
  release();
  await scored(page, f.definitions.cukta1);
  await page.waitForTimeout(500);
  await expect(
    block(page, f.definitions.cukta2).getByRole("button", { name: "Endorse" }),
  ).toBeFocused();
  expect(Math.abs((await top()) - before)).toBeLessThanOrEqual(2);
  await expect(
    block(page, f.definitions.cukta1).locator("pre.json"),
  ).toBeVisible();
});

test("a Source link in the URL does not pull the reader back when the scores arrive", async ({
  page,
}) => {
  const f = fixture();
  await page.setViewportSize({ width: 390, height: 600 });
  const release = await heldPersonal(page);
  await page.goto(`/word/cukta#source-${f.definitions.cukta1}`);
  await expect(page.locator("article.definition").first()).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeGreaterThan(0);
  // The reader goes back to the top while the calculation runs.
  await page.evaluate(() => window.scrollTo(0, 0));
  release();
  await scored(page);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test("Continue in the first-signature notice still publishes when the scores arrive behind it", async ({
  page,
}) => {
  const f = fixture();
  await createIdentity(page);
  await page.getByRole("link", { name: /^Trust:/ }).click();
  await page
    .getByRole("radio", { name: "Mine: site view + my choices" })
    .check();
  await expect(
    page.getByRole("link", { name: "Trust: personal view" }),
  ).toBeVisible();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/v1/manifest*", async (route) => {
    await held;
    await route.continue();
  });
  await openWord(page, "cukta");
  await expect(block(page, f.definitions.cukta1)).toBeVisible();
  await block(page, f.definitions.cukta1)
    .getByRole("button", { name: "Endorse" })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Before your first public signature",
  });
  await expect(dialog).toBeVisible();
  release();
  // Let the calculation finish while the notice is open.
  await expect(
    page.getByRole("region", { name: "Personal view" }),
  ).toContainText("calculated in this browser", { timeout: 40000 });
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Your endorsement is published.",
    { timeout: 15000 },
  );
  await scored(page, f.definitions.cukta1);
  await expect(
    block(page, f.definitions.cukta1).getByRole("button", { name: "Endorse" }),
  ).toHaveAttribute("aria-pressed", "true", { timeout: 15000 });
});

test("after a cancelled calculation, later word pages keep score details", async ({
  page,
}) => {
  await createIdentity(page);
  await openWord(page, "cukta");
  const endorsed = page.locator("article.definition").first();
  const key = await endorsed.getAttribute("data-key");
  await endorsed.getByRole("button", { name: "Endorse" }).click();
  await acceptFirstSignature(page);
  await expect(page.getByRole("status")).toContainText(
    "Your endorsement is published.",
  );
  const siteDetails = await page.locator("details.judgment-details").count();
  expect(siteDetails).toBeGreaterThan(0);
  // The calculation's download is held until the reader cancels it.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/v1/records?*", async (route) => {
    await held;
    await route.continue().catch(() => {});
  });
  await page.getByRole("link", { name: /^Trust:/ }).click();
  await page
    .getByRole("radio", { name: "Mine: site view + my choices" })
    .check();
  await openWord(page, "cukta");
  const panel = page.getByRole("region", { name: "Personal view" });
  await expect(panel).toContainText(/Downloading/);
  await panel.getByRole("button", { name: "Cancel" }).click();
  await expect(panel).toContainText("The local calculation was cancelled.");
  release();
  await page.locator(".tabs .tab").last().click();
  await expect(page).toHaveURL(/lang=all/);
  await expect(page.locator("article.definition").first()).toBeVisible();
  await expect(page.locator("details.judgment-details")).toHaveCount(
    siteDetails,
  );
  // The reader can still clear their judgment from the details.
  const details = block(page, key!).locator("details.judgment-details");
  await details.locator("summary").click();
  await expect(
    details.getByRole("button", { name: /Clear my judgment/ }),
  ).toBeVisible();
});

test("a return path never becomes another host after dot segments collapse", async ({
  page,
}) => {
  await page.goto("/");
  const results = await page.evaluate(async () => {
    const { returnPath } = await import(String("/src/app/router.ts"));
    return [
      "/foo/..//evil.example/path?x=1#y",
      "/a/b/../..//evil.example",
      "/./\\evil.example",
      "/word/cukta?lang=all#x",
    ].map((value) => returnPath(value));
  });
  expect(results).toEqual([null, null, null, "/word/cukta?lang=all#x"]);
});

test("declining the first-signature notice does not carry the key page's status to the word", async ({
  page,
}) => {
  await page.goto("/word/cukta");
  await page
    .locator("article.definition")
    .first()
    .getByRole("button", { name: "Endorse" })
    .click();
  await expect(page).toHaveURL(/\/identity$/);
  await page.getByLabel("New passphrase", { exact: true }).fill(PASSPHRASE);
  await page.getByLabel("Repeat passphrase").fill(PASSPHRASE);
  await page.getByRole("button", { name: "Create a key" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Before your first public signature",
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Not now" }).click();
  await expect(page).toHaveURL(/\/word\/cukta$/);
  await expect(page.locator("main h1")).toHaveText("cukta");
  await page.waitForTimeout(500);
  // The shell's status line, found by its element so that an empty line
  // still matches.
  const line = page.locator("#app > .status[role=status]");
  await expect(line).toHaveCount(1);
  // Read once: a retrying "not" assertion would also pass if some later
  // render cleared the line.
  expect(await line.textContent()).not.toContain("Test it below");
});
