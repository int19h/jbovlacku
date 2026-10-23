import { test, expect, type Locator, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { BROWSER_HEADERS } from "../../server/src/security.ts";
import { fixture } from "./helpers.ts";

test.beforeAll(async () => {
  test.setTimeout(120000);
  // Test the built app under the Node adapter's actual browser policy.
  // Vite injects styles during development and does not use that policy.
  await promisify(execFile)("npm", ["run", "build:web"], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    timeout: 90000,
  });
});

type PolicyWindow = Window & { layoutPolicyViolations: string[] };

async function watchPolicy(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as PolicyWindow).layoutPolicyViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      (window as unknown as PolicyWindow).layoutPolicyViolations.push(
        `${event.effectiveDirective}: ${event.blockedURI}`,
      );
    });
  });
}

async function openBuiltPage(page: Page, path: string) {
  const response = await page.goto(`${fixture().origin}${path}`);
  expect(response?.headers()["content-security-policy"]).toBe(
    BROWSER_HEADERS["content-security-policy"],
  );
  expect(response?.headers()["content-security-policy"]).not.toContain(
    "'unsafe-inline'",
  );
  expect(response?.headers()["content-security-policy"]).not.toContain(
    "'unsafe-eval'",
  );
  await page.locator("main h1").first().waitFor();
  await page.evaluate(() => document.fonts.ready);
}

async function expectCleanLayout(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
  expect(
    await page.evaluate(
      () => (window as unknown as PolicyWindow).layoutPolicyViolations,
    ),
  ).toEqual([]);
}

async function expectSeparateCardText(cards: Locator, count: number) {
  await expect(cards).toHaveCount(count);
  for (const card of await cards.all()) {
    const title = card.locator(":scope > span > span").nth(0);
    const description = card.locator(":scope > span > span").nth(1);
    await expect(title).toHaveCSS("display", "block");
    await expect(description).toHaveCSS("display", "block");
    const titleBox = (await title.boundingBox())!;
    const descriptionBox = (await description.boundingBox())!;
    expect(descriptionBox.y).toBeGreaterThanOrEqual(
      titleBox.y + titleBox.height - 0.5,
    );
  }
}

for (const viewport of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "phone", width: 360, height: 800 },
]) {
  test.describe(viewport.name, () => {
    test.use({ viewport });

    test("wizard placeholders and type cards keep their layout under the browser policy", async ({
      page,
    }) => {
      await watchPolicy(page);
      await openBuiltPage(page, "/new/meaning");
      const placeholder = page.locator(".blank");
      await expect(placeholder).toHaveText("___");
      await expect(placeholder).toHaveCSS("border-bottom-width", "0px");
      await expect(placeholder).toHaveCSS("text-decoration-line", "none");
      await expect(page.locator("main > .two-col")).toHaveCSS(
        "column-gap",
        "40px",
      );
      const language = (await page
        .getByLabel("Language", { exact: true })
        .boundingBox())!;
      const customLanguage = (await page
        .getByLabel("Other language tag")
        .boundingBox())!;
      if (viewport.width === 1280) {
        expect(Math.abs(language.y - customLanguage.y)).toBeLessThan(1);
      } else {
        expect(customLanguage.y).toBeGreaterThanOrEqual(
          language.y + language.height,
        );
      }
      await page
        .getByLabel("Meaning", { exact: true })
        .fill("___ gives ___ to ___.");
      await expectCleanLayout(page);
      await page.getByRole("button", { name: "New word", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "What kind of word?" }),
      ).toBeVisible();
      await expectSeparateCardText(page.locator(".type-grid .opt"), 6);
      await expect(page.locator("fieldset")).toHaveCSS(
        "border-top-width",
        "0px",
      );
      await expect(page.locator('[data-kind="lujvo"]')).toContainText(
        /lujvo\s+Compound of existing words\./,
        { useInnerText: true },
      );
      await page.locator('[data-kind="lujvo"] input').check();
      await page
        .getByRole("button", { name: "Build the lujvo", exact: true })
        .click();
      await expect(
        page.getByRole("radiogroup", { name: "Morphology profile" }),
      ).toBeVisible();
      await expect(page.locator("main > .two-col > .side-col")).toHaveCSS(
        "display",
        "flex",
      );
      await expect(page.locator("main > .two-col > .side-col")).toHaveCSS(
        "row-gap",
        "14px",
      );
      await expectCleanLayout(page);
    });

    test("trust cards and reading controls keep their layout under the browser policy", async ({
      page,
    }) => {
      await watchPolicy(page);
      const f = fixture();
      await openBuiltPage(
        page,
        `/identity/${encodeURIComponent(f.identities.author)}`,
      );
      await page
        .getByRole("button", { name: "Trust their judgments", exact: true })
        .click();
      await expectSeparateCardText(page.locator(".opt"), 2);
      const visibility = page.getByRole("group", {
        name: "Visibility",
        exact: true,
      });
      await expect(visibility).toHaveCSS("display", "grid");
      await expect(visibility).toHaveCSS("gap", "8px");
      await expect(visibility).toHaveCSS("border-top-width", "0px");
      await page
        .getByRole("button", {
          name: "limit by language, word, or rafsi",
          exact: true,
        })
        .click();
      const kind = (await page
        .getByLabel("Kind", { exact: true })
        .boundingBox())!;
      const language = (await page
        .getByLabel("Definition language", { exact: true })
        .boundingBox())!;
      if (viewport.width === 1280) {
        expect(Math.abs(kind.y - language.y)).toBeLessThan(1);
      } else {
        expect(language.y).toBeGreaterThanOrEqual(kind.y + kind.height);
      }
      await expectCleanLayout(page);

      await openBuiltPage(page, "/trust");
      const view = page.getByRole("radiogroup", { name: "Active view" });
      await expect(view).toBeVisible();
      await expectCleanLayout(page);
      await openBuiltPage(page, `/word/${f.words.cukta}`);
      await expect(page.locator("article.definition").first()).toBeVisible();
      await expectCleanLayout(page);
      await openBuiltPage(page, "/preferences");
      await expect(
        page.getByLabel("Search mode", { exact: true }),
      ).toBeVisible();
      await expectCleanLayout(page);
    });
  });
}
