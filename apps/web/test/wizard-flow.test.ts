import { test, expect, type Page } from "@playwright/test";
import { acceptFirstSignature, corePath, createIdentity } from "./helpers.ts";

test.use({ actionTimeout: 10000 });
test.setTimeout(30000);

async function open(page: Page, path: string) {
  await page.evaluate(async (path) => {
    const { navigate } = await import(String("/src/app/router.ts"));
    navigate(path);
  }, path);
}

async function stored(page: Page) {
  return page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return new LocalStore().get("drafts", "current");
  });
}

/** Synthetic package entries and disposable drafts stay in this browser. */
async function seed(page: Page, options: {
  kind?: string;
  spelling?: string;
  compound?: boolean;
  selected?: string;
  formation?: boolean;
  cut?: boolean;
  competitors?: string[];
  step?: number;
  claims?: boolean;
} = {}) {
  await page.evaluate(async ({ options, corePath }) => {
    const core = await import(corePath);
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { newDraft } = await import(String("/src/model/draft.ts"));
    const builders = await import(String("/src/model/builders.ts"));
    const store = new LocalStore();
    const rows = [{ language: "en", name: "English", word: "book", input: "cukta", weight: { numerator: "1", denominator: "1" } }];
    const components = [
      { id: "a", spelling: "cukta", kind: "gismu", definition: null, gloss: "book", claims: [{ rafsi: "cku", pair: core.rafsiPairId(core.wordId({ language: "jbo", spelling: "cukta" }), "cku") }], locked: null },
      { id: "b", spelling: "valsi", kind: "gismu", definition: null, gloss: "word", claims: [{ rafsi: "vla", pair: core.rafsiPairId(core.wordId({ language: "jbo", spelling: "valsi" }), "vla") }], locked: null },
    ];
    const result = core.buildLujvo({ profile: "cll", components });
    const candidate = result.candidates[0];
    const spelling = options.spelling ?? (options.compound ? candidate.spelling : "cukta");
    const draft = newDraft({
      spelling, kind: options.kind ?? (options.compound ? "lujvo" : "gismu"),
      meaning: "A disposable meaning.", text: "A disposable meaning.", structured: false,
      step: options.step ?? 5,
      compound: options.compound ? builders.compoundMetadata(result, candidate, components, "") : null,
      formation: options.formation ? builders.manualFormation(rows, "Historical evidence.") : null,
      evidenceForm: options.compound || options.formation ? spelling : null,
      lujvo: { ...builders.newLujvoState(), components, selected: options.selected ?? null },
      gismu: { ...builders.newGismuState(), rows, manual: "cukte", selected: "cukte" },
      rafsiClaims: options.claims ? [{ rafsi: "cku", rationale: "Disposable claim." }] : [],
    });
    if (!options.formation && !options.selected) draft.gismu = null;
    await store.put("drafts", "current", draft);
    const spellings = ["cukta", "valsi", ...(options.competitors ?? [])];
    await store.put("packages", "en", {
      version: 2, snapshot: "sha256:" + "a".repeat(64),
      entries: spellings.map((spelling, i) => ({
        event: "jve1:" + String(i + 1).repeat(64), word: { language: "jbo", spelling },
        language: "en", glosses: [], plain_text: "Synthetic entry.",
        classification: { kind: "gismu", selmaho: [] }, body: null,
        issuer: "ed25519:" + "1".repeat(64), notes: false, attribution: null,
        rafsi: spelling === "valsi" ? ["vla"] : ["cku"],
        rafsi_complete: !(options.cut && spelling === "cukta"),
      })),
    });
  }, { options, corePath });
}

test("F4 manual entry and Etymology can remove evidence after confirmation", async ({ page }) => {
  await createIdentity(page);
  await seed(page, { compound: true });
  await open(page, "/new/form?manual=1");
  await expect(page.locator("main")).toContainText("This draft keeps construction evidence");
  const remove = page.getByRole("button", { name: "Remove formation evidence", exact: true });
  page.once("dialog", (dialog) => void dialog.dismiss());
  await remove.click();
  expect((await stored(page)).compound).not.toBeNull();
  page.once("dialog", (dialog) => void dialog.accept());
  await remove.click();
  await expect.poll(async () => (await stored(page)).compound).toBeNull();
  await seed(page, { formation: true });
  await open(page, "/new/editor");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Remove formation evidence", exact: true }).click();
  await expect.poll(async () => (await stored(page)).formation).toBeNull();
});

test("F4 opening the other builder asks before removing evidence", async ({ page }) => {
  await createIdentity(page);
  await seed(page, { compound: true });
  const dialogs: string[] = [];
  page.on("dialog", async (dialog) => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await open(page, "/new/gismu");
  await expect.poll(() => dialogs.length).toBe(1);
  expect((await stored(page)).kind).toBe("lujvo");
  expect((await stored(page)).compound).not.toBeNull();
  await expect(page).toHaveURL(/\/new\/type$/);
});

test("Grok 3 gismu acknowledgments belong to the selected spelling", async ({ page }) => {
  await createIdentity(page);
  await seed(page, { selected: "cukte", formation: true });
  await open(page, "/new/gismu");
  const roots = page.getByRole("group", { name: "Root conflicts" });
  await roots.getByRole("checkbox").check();
  await page.getByLabel("Type a form yourself").fill("cukti");
  await page.getByRole("button", { name: "Choose cukti", exact: true }).click();
  await expect(roots.getByRole("checkbox")).not.toBeChecked();
  await expect(page.locator(".action-bar .btn-primary")).toBeDisabled();
});

test("Grok 3 lujvo acknowledgments belong to the selected spelling", async ({ page }) => {
  await createIdentity(page);
  await seed(page, { compound: true, competitors: ["spofu"] });
  await open(page, "/new/lujvo");
  const claims = page.getByRole("group", { name: "Competing rafsi claims" });
  await claims.getByRole("checkbox").check();
  const next = page.getByRole("region", { name: "Other forms", exact: true }).getByRole("row").filter({ hasText: "cku" }).filter({ has: page.getByRole("button", { name: /^Use / }) }).first();
  await next.getByRole("button").click();
  await expect(claims.getByRole("checkbox")).not.toBeChecked();
});

test("Grok 4 an invalid restored lujvo stays visible until a current form is chosen", async ({ page }) => {
  await createIdentity(page);
  await seed(page, { compound: true, selected: "old-invalid-choice" });
  await open(page, "/new/lujvo");
  await expect(page.locator("main")).toContainText("old-invalid-choice is no longer a candidate");
  await expect(page.locator(".action-bar .btn-primary")).toBeDisabled();
  expect((await stored(page)).lujvo.selected).toBe("old-invalid-choice");
  await page.getByRole("region", { name: "Other forms", exact: true }).getByRole("button").first().click();
  await expect(page.locator(".action-bar .btn-primary")).toBeEnabled();
});

test("F6 F7 manual gismu conflicts persist and enter the signed body", async ({ page }) => {
  await createIdentity(page);
  await seed(page);
  await open(page, "/new/publish");
  const publish = page.locator("aside").getByRole("button", { name: "Publish", exact: true });
  await expect(page.getByRole("region", { name: "Known conflicts" })).toContainText("identical conflict with cukta");
  await expect(publish).toBeDisabled();
  await page.getByLabel(/although the refreshed package shows a new root conflict with cukta/).check();
  await expect(publish).toBeEnabled();
  await open(page, "/new/places");
  await open(page, "/new/publish");
  await expect(page.getByLabel(/although the refreshed package shows a new root conflict with cukta/)).toBeChecked();
  await publish.click();
  await acceptFirstSignature(page);
  await expect(page).toHaveURL(/\/word\/cukta/);
  const formation = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const items = await new LocalStore().list("outbox");
    return JSON.parse(items.find((item: any) => item.order === 0).transport).body.etymology.formation;
  });
  expect(formation.algorithm).toBeNull();
  expect(formation.selected_score ?? null).toBeNull();
  expect(formation.conflicts).toHaveLength(1);
  expect(formation.conflicts[0]).toMatchObject({ rule: "identical", snapshot: "sha256:" + "a".repeat(64) });
});

test("F7 Grok 7 Publish reviews saved compound conflicts and rejects changed coverage", async ({ page }) => {
  await createIdentity(page);
  await seed(page, { compound: true, competitors: ["spofu"] });
  // Revise can carry compound evidence without any builder state.
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const draft = await store.get("drafts", "current");
    draft.lujvo = null;
    await store.put("drafts", "current", draft);
  });
  await open(page, "/new/publish");
  const claims = page.getByLabel(/I keep .*although.*component rafsi/);
  const publish = page.locator("aside").getByRole("button", { name: "Publish", exact: true });
  await expect(page.getByRole("region", { name: "Known conflicts" })).toContainText("cku is also claimed by spofu");
  await expect(publish).toBeDisabled();
  await claims.check();
  await open(page, "/new/places");
  await open(page, "/new/publish");
  await expect(claims).toBeChecked();
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const cached = await store.get("packages", "en");
    cached.entries.push({ ...cached.entries.at(-1), word: { language: "jbo", spelling: "spali" } });
    await store.put("packages", "en", cached);
  });
  await open(page, "/new/places");
  await open(page, "/new/publish");
  await expect(claims).not.toBeChecked();
  await expect(publish).toBeDisabled();
});

test("F7 published rafsi claim acknowledgments survive a return to Edit", async ({ page }) => {
  await createIdentity(page);
  await seed(page, { spelling: "broda", claims: true });
  await open(page, "/new/publish");
  const claim = page.getByLabel(/I keep the claim cku although other words/);
  await claim.check();
  await open(page, "/new/places");
  await open(page, "/new/publish");
  await expect(claim).toBeChecked();
});

test("F8 an accepted definition opens the word despite a refused endorsement", async ({ page }) => {
  await createIdentity(page);
  await seed(page, { spelling: "brode" });
  await page.route("**/api/v1/events", async (route) => {
    if (route.request().postDataJSON()?.envelope?.header?.action?.kind === "judgment.set")
      await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "synthetic_refusal" }) });
    else await route.continue();
  });
  await open(page, "/new/publish");
  await page.locator("aside").getByRole("button", { name: "Publish", exact: true }).click();
  await acceptFirstSignature(page);
  await expect(page).toHaveURL(/\/word\/brode/);
  await expect(page.getByRole("link", { name: /Not delivered/ }).first()).toBeVisible();
});

test("F10 Places Back and saved draft continuation return to the matching builder", async ({ page }) => {
  await createIdentity(page);
  await seed(page, { compound: true, step: 3 });
  await open(page, "/new/places");
  await expect(page.getByRole("link", { name: "Back", exact: true })).toHaveAttribute("href", "/new/lujvo");
  await open(page, "/new/meaning?word=broda");
  await expect(page.getByRole("link", { name: "Continue the saved draft", exact: true })).toHaveAttribute("href", "/new/lujvo");
});

test("F11 both builders label cut rafsi inventories as unknown coverage", async ({ page }) => {
  await createIdentity(page);
  await seed(page, { compound: true, cut: true });
  await open(page, "/new/lujvo");
  await expect(page.locator("main")).toContainText("coverage is incomplete for cukta");
  await seed(page, { selected: "cukte", formation: true, cut: true });
  await open(page, "/new/gismu");
  await expect(page.getByRole("region", { name: "Selected form" })).toContainText("coverage is incomplete for cukta");
});

test("Grok 8 11 12 help names saved evidence, package conflicts, and server retention limits", async ({ page }) => {
  await createIdentity(page);
  await seed(page, { spelling: "brodi" });
  await open(page, "/new/editor");
  await expect(page.locator("main")).toContainText('"Use" in a builder saves');
  await expect(page.locator("main")).toContainText("Publish compares claims with the downloaded package");
  await expect(page.locator("main")).not.toContainText("The builders add it in a later stage");
  await open(page, "/new/publish");
  await expect(page.locator("aside")).toContainText("This client cannot promise what each server stores");
  await expect(page.locator("aside")).not.toContainText("kept by every server");
});
