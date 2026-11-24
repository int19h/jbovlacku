import { expect, test, type Page } from "@playwright/test";
import { corePath } from "./helpers.ts";

const englishRow = {
  event: "jve1:" + "1".repeat(64),
  word: { language: "jbo", spelling: "cukta" },
  language: "en",
  glosses: [{ language: "en", text: "book", sense: null }],
  plain_text: "book",
  classification: { kind: "gismu", selmaho: [] },
  body: null,
  issuer: "ed25519:" + "a".repeat(64),
  notes: false,
  rafsi: ["cuk"],
  rafsi_complete: true,
  attribution: null,
};

const frenchRow = {
  ...englishRow,
  language: "fr",
  glosses: [{ language: "fr", text: "livre", sense: null }],
  plain_text: "Un livre ② {place 3}.",
};

async function savePackages(
  page: Page,
  entriesByLanguage: Record<string, unknown[]>,
) {
  await page.goto("/");
  await page.evaluate(async (packages) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    await store.setPreferences({ definitionLanguage: "en" });
    for (const [language, entries] of Object.entries(packages))
      await store.put("packages", language, {
        version: 2,
        snapshot: "sha256:" + "a".repeat(64),
        entries,
      });
  }, entriesByLanguage);
}

test("a rafsi pair skips a matching package with a bad later row", async ({
  page,
}) => {
  await savePackages(page, { en: [englishRow, null], fr: [frenchRow] });
  const pair = await page.evaluate(async (path) => {
    const core = await import(path);
    await core.initializeCore();
    return core.rafsiPairId(
      core.wordId({ language: "jbo", spelling: "cukta" }),
      "cuk",
    );
  }, corePath);
  await page.route("**/api/v1/manifest", (route) => route.abort());
  await page.goto(`/rafsi-pair/${pair}`);
  const word = page.locator('main a[href^="/word/cukta?"]').first();
  await expect(word).toHaveAttribute("href", "/word/cukta?lang=fr");
});

test("Meaning rejects a French row saved in the English package", async ({
  page,
}) => {
  await savePackages(page, { en: [frenchRow], fr: [frenchRow] });
  await page.goto("/new/meaning?lang=en");
  await page.getByLabel("Lojban word").fill("cukta");
  const typed = page.getByRole("region", { name: "Typed word" });
  await expect(typed).toContainText("The search package is invalid.");
  await expect(typed).not.toContainText("Already exists");
  await expect(typed).not.toContainText(frenchRow.plain_text);
  await expect(
    typed.getByRole("button", { name: "Check this word on the server" }),
  ).toBeVisible();
  await page.getByLabel("Language", { exact: true }).selectOption("fr");
  await expect(typed).toContainText("Local package for fr");
  await expect(
    typed.getByRole("link", { name: frenchRow.plain_text, exact: true }),
  ).toBeVisible();
});
