import { expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const corePath = `/@fs${resolve("packages/core/src/browser.ts")}`;
export interface Fixture {
  origin: string;
  /** The server's selected view: the two-root view under the bounds profile. */
  view: string;
  /** Every signed view of the fixture. The shun scenario has one view per profile. */
  views: Record<"bounds" | "shun" | "shunGraphBounds", string>;
  identities: Record<
    | "rootA"
    | "rootB"
    | "curator"
    | "delegate"
    | "author"
    | "importer"
    | "rootC"
    | "rootD"
    | "curator2"
    | "delegate2"
    | "outcast"
    | "loner"
    | "scoped",
    string
  >;
  words: Record<"cukta" | "vlacku" | "lo" | "ckusro" | "dunda", string>;
  definitions: Record<
    | "cukta1"
    | "cukta2"
    | "cukta3"
    | "cuktaRev"
    | "vlacku"
    | "lo"
    | "imported"
    | "dunda1"
    | "dunda2",
    string
  >;
  pair: string;
  claim: string;
}
export function fixture(): Fixture {
  return JSON.parse(readFileSync(process.env.JVC_FIXTURE_FILE!, "utf8"));
}
export const PASSPHRASE = "test passphrase with spaces";
/** Creates a disposable key through the page and leaves it unlocked. */
export async function createIdentity(page: Page, passphrase = PASSPHRASE) {
  await page.goto("/identity");
  await page.getByLabel("New passphrase", { exact: true }).fill(passphrase);
  await page.getByLabel("Repeat passphrase").fill(passphrase);
  await page.getByRole("button", { name: "Create a key" }).click();
  await expect(page.getByText("Unlocked", { exact: true })).toBeVisible();
  return page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return new LocalStore().get("keys", "selected");
  });
}
/** Accepts the one-time first-signature explanation when it appears. */
export async function acceptFirstSignature(page: Page) {
  const dialog = page.getByRole("dialog", {
    name: "Before your first public signature",
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Continue" }).click();
}
/** Navigates inside the app, keeping the in-memory key, by using the header search. */
export async function openWord(page: Page, spelling: string) {
  await page.getByLabel("Search words and meanings").fill(spelling);
  await page.getByLabel("Search words and meanings").press("Enter");
  await page
    .getByRole("region", { name: "Search results" })
    .getByRole("link", { name: spelling, exact: true })
    .first()
    .click();
  await expect(page).toHaveTitle(`${spelling} · jbovlacku`);
}
export function fingerprintText(identity: string): string {
  const [prefix, hex] = identity.split(":");
  return `${prefix} ${hex.match(/.{1,4}/g)!.join(" ")}`;
}

/** Ordinary page text uses the human spelling of lexical kinds. */
export async function expectKindSpelling(page: Page) {
  // The full editor opens its raw JSON inspector by default.
  const inspector = page.getByText("JSON inspector", { exact: true });
  if (
    (await inspector.isVisible()) &&
    (await inspector.evaluate((node) => node.closest("details")?.open))
  )
    await inspector.click();
  await expect(page.locator("main")).toContainText("fu'ivla");
  expect(await page.locator("body").innerText()).not.toMatch(
    /\b(?:fuhivla|fuivla)\b/,
  );
}
