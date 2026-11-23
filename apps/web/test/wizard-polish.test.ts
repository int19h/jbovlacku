import { test, expect, type Page } from "@playwright/test";
import { corePath, createIdentity, PASSPHRASE } from "./helpers.ts";

test.use({ actionTimeout: 10000 });
test.setTimeout(30000);

async function downloadPackage(page: Page) {
  await page.goto("/preferences");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect(page.locator("#app > [role=status]")).toHaveText(
    "The English search package is saved in this browser.",
  );
}

async function seedPublishDraft(page: Page) {
  await page.goto("/");
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { newDraft } = await import(String("/src/model/draft.ts"));
    const store = new LocalStore();
    await store.put(
      "drafts",
      "current",
      newDraft({
        spelling: "cukta",
        kind: "gismu",
        meaning: "A disposable meaning.",
        text: "A disposable meaning.",
        structured: false,
        step: 5,
      }),
    );
  });
}

test("a gismu stem offered as a chip is not also reported as not offered", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    await core.initializeCore();
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { newDraft } = await import(String("/src/model/draft.ts"));
    const builders = await import(String("/src/model/builders.ts"));
    const component = (id: string, spelling: string, rafsi: string) => ({
      id,
      spelling,
      kind: "gismu",
      definition: null,
      gloss: "",
      claims: [
        {
          rafsi,
          pair: core.rafsiPairId(
            core.wordId({ language: "jbo", spelling }),
            rafsi,
          ),
        },
      ],
      locked: null,
    });
    const draft = newDraft({
      spelling: "",
      kind: "lujvo",
      meaning: "A disposable meaning.",
      text: "A disposable meaning.",
      structured: false,
      step: 3,
      lujvo: {
        ...builders.newLujvoState(),
        components: [
          component("a", "sance", "sanc"),
          component("b", "cmalu", "cmal"),
        ],
      },
    });
    await new LocalStore().put("drafts", "current", draft);
  }, corePath);
  await page.goto("/new/lujvo");
  await expect(
    page.getByRole("heading", { name: "Build the lujvo" }),
  ).toBeVisible();
  await expect(page.locator("main")).not.toContainText(
    "is not a short rafsi shape and is not offered",
  );
  await expect(
    page.getByRole("group", { name: "Rafsi for sance" }),
  ).toContainText("sanc");
});

test("lujvo Remove stays top-right with chips full-width below, in keyboard order after chips", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    await core.initializeCore();
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { newDraft } = await import(String("/src/model/draft.ts"));
    const builders = await import(String("/src/model/builders.ts"));
    const component = (
      id: string,
      spelling: string,
      kind: string,
      rafsi: string | null,
    ) => ({
      id,
      spelling,
      kind,
      definition: null,
      gloss: "",
      claims: rafsi
        ? [
            {
              rafsi,
              pair: core.rafsiPairId(
                core.wordId({ language: "jbo", spelling }),
                rafsi,
              ),
            },
          ]
        : [],
      locked: null,
    });
    const draft = newDraft({
      spelling: "",
      kind: "lujvo",
      meaning: "A disposable meaning.",
      text: "A disposable meaning.",
      structured: false,
      step: 3,
      lujvo: {
        ...builders.newLujvoState(),
        components: [
          component("a", "leksiko", "fuhivla", "leksiko"),
          component("b", "broda", "gismu", null),
        ],
      },
    });
    await new LocalStore().put("drafts", "current", draft);
  }, corePath);
  await page.goto("/new/lujvo");
  await expect(
    page.getByRole("heading", { name: "Build the lujvo" }),
  ).toBeVisible();
  await expect(page.locator("main")).not.toContainText(
    'Claimed rafsi "leksiko" is not a short rafsi shape and is not offered.',
  );
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 800 });
    for (const spelling of ["leksiko", "broda"]) {
      const remove = page.getByRole("button", {
        name: `Remove ${spelling}`,
      });
      const chips = page.getByRole("group", {
        name: `Rafsi for ${spelling}`,
      });
      const row = remove.locator("xpath=ancestor::li[1]");
      const [removeBox, chipsBox, rowBox] = await Promise.all([
        remove.boundingBox(),
        chips.boundingBox(),
        row.boundingBox(),
      ]);
      expect(removeBox).not.toBeNull();
      expect(chipsBox).not.toBeNull();
      expect(rowBox).not.toBeNull();
      // Remove at the top right of the card, chips below it and wide.
      expect(removeBox!.y).toBeLessThan(chipsBox!.y);
      expect(
        Math.abs(removeBox!.x + removeBox!.width - (rowBox!.x + rowBox!.width)),
      ).toBeLessThan(40);
      expect(chipsBox!.width).toBeGreaterThan(rowBox!.width * 0.6);
      // Keyboard order: chips come before Remove in the row.
      const order = await row.evaluate((rowElement, name) => {
        const fieldset = rowElement.querySelector("fieldset");
        const button = rowElement.querySelector(
          `button[aria-label="Remove ${name}"]`,
        );
        return fieldset && button
          ? fieldset.compareDocumentPosition(button) &
              Node.DOCUMENT_POSITION_FOLLOWING
          : 0;
      }, spelling);
      expect(order).toBeTruthy();
    }
  }
});

test("already-exists block truncates the snapshot and publish has one Publish button", async ({
  page,
}) => {
  await downloadPackage(page);
  await page.goto("/new/meaning");
  await page.getByLabel("Lojban word", { exact: true }).fill("cukta");
  const panel = page.getByRole("region", { name: "Typed word" });
  await expect(panel).toContainText("Already exists");
  await expect(panel).toContainText(/snapshot [0-9a-f]{12}…/);
  await expect(panel).not.toContainText("sha256:");
  await seedPublishDraft(page);
  await page.goto("/new/publish");
  await expect(
    page.getByRole("button", { name: "Publish", exact: true }),
  ).toHaveCount(1);
  await expect(page.locator("main")).not.toContainText("0000…0000");
  await expect(page.locator("main")).not.toContainText("Definition by 0000");
});

test("first-signature dialog names the rafsi assignment endorsement", async ({
  page,
}) => {
  await createIdentity(page);
  const seedClaims = async (rafsi: string[]) => {
    await page.goto("/");
    await page.evaluate(async (claims) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const { newDraft } = await import(String("/src/model/draft.ts"));
      await new LocalStore().put(
        "drafts",
        "current",
        newDraft({
          spelling: "cukta",
          kind: "gismu",
          meaning: "A disposable meaning.",
          text: "A disposable meaning.",
          structured: false,
          step: 5,
          rafsiClaims: claims.map((claim) => ({
            rafsi: claim,
            rationale: "Disposable claim.",
          })),
        }),
      );
    }, rafsi);
    await page.goto("/new/publish");
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    const unlock = page.getByRole("dialog", { name: "Unlock your key" });
    if (await unlock.isVisible().catch(() => false)) {
      await unlock.getByLabel("Passphrase").fill(PASSPHRASE);
      await unlock.getByRole("button", { name: "Unlock" }).click();
    }
    return page.getByRole("dialog", {
      name: "Before your first public signature",
    });
  };
  const dialog = await seedClaims(["cku"]);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(
    "1 rafsi claim (cku), and an endorsement of that rafsi assignment",
  );
  await dialog.getByRole("button", { name: "Not now" }).click();
  const dialog2 = await seedClaims(["cku", "kuk"]);
  await expect(dialog2).toBeVisible();
  await expect(dialog2).toContainText(
    "2 rafsi claims (cku, kuk), and an endorsement of those rafsi assignments",
  );
  await dialog2.getByRole("button", { name: "Not now" }).click();
});

test("first-signature dialog mentions the definition being published", async ({
  page,
}) => {
  await createIdentity(page);
  await seedPublishDraft(page);
  await page.goto("/new/publish");
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  const unlock = page.getByRole("dialog", { name: "Unlock your key" });
  if (await unlock.isVisible().catch(() => false)) {
    await unlock.getByLabel("Passphrase").fill(PASSPHRASE);
    await unlock.getByRole("button", { name: "Unlock" }).click();
  }
  const dialog = page.getByRole("dialog", {
    name: "Before your first public signature",
  });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(
    "signs your definition of cukta and your endorsement of it",
  );
  await expect(dialog).not.toContainText("its endorsements");
  await expect(dialog).not.toContainText("undo does not erase them");
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/word\/cukta/);
});

test("wizard touch targets: the enclosing labels meet 44px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/new/meaning");
  await page
    .getByRole("textbox", { name: "Meaning" })
    .fill("___ is a small thing.");
  await page.getByRole("button", { name: "New word" }).click();
  await page.getByRole("heading", { name: "What kind of word?" }).waitFor();
  for (const label of await page.locator("label.opt").all()) {
    const box = await label.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
});
