import { test, expect, type Page } from "@playwright/test";
import {
  acceptFirstSignature,
  corePath,
  fixture,
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
  await expect(
    page.locator("article.definition").first(),
  ).toBeVisible();
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
    "en", "fr", "de", "es", "it", "pt", "ru", "ja", "zh", "eo", "la", "jbo",
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
  const tops = await page.locator(".tabs .tab").evaluateAll((nodes) =>
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

test("source locators read as words in the Source disclosure", async ({
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
  await expect(
    source.getByText(/Position definitions · definition 583 · cached username/),
  ).toBeVisible();
  await expect(source.getByText(/footer · public domain notice/)).toBeVisible();
});

test("a tied layer says why its order is unresolved", async ({ page }) => {
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
      "2 alternatives with unresolved order. No score in this group is clearly ahead of the others, and every score in this group is zero. Presentation order follows event IDs.",
    ),
  ).toBeVisible();
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
