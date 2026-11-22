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

async function startLujvo(page: Page) {
  await page.goto("/new/meaning");
  await page
    .getByRole("textbox", { name: "Meaning" })
    .fill("___ is a small thing.");
  await page.getByRole("button", { name: "New word" }).click();
  await page.getByRole("heading", { name: "What kind of word?" }).waitFor();
  await page.getByRole("radio", { name: /lujvo/ }).check();
  await page.getByRole("button", { name: "Build the lujvo" }).click();
  await page.getByRole("heading", { name: "Build the lujvo" }).waitFor();
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

test("remote nearby search sends the whole consented query through an in-app dialog", async ({
  page,
}) => {
  const searches: { body: unknown }[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/v1/search")
      searches.push({ body: request.postDataJSON() });
  });
  await page.goto("/new");
  await page
    .getByLabel("Meaning", { exact: true })
    .fill("book private committee");
  const settings = page.getByRole("link", { name: "Settings", exact: true });
  await expect(settings.first()).toBeVisible();
  await page
    .getByRole("button", { name: "search this server", exact: true })
    .click();
  const consent = page.getByRole("dialog", { name: "Search this server" });
  await expect(consent).toBeVisible();
  await expect(consent).toContainText('"book", "private", "committee"');
  await consent
    .getByRole("button", { name: "Search this server", exact: true })
    .click();
  await expect(
    page.locator("ol.similar").getByRole("link", { name: "cukta" }),
  ).toBeVisible();
  expect(searches.map((s) => (s.body as { q: string }).q).sort()).toEqual([
    "book",
    "committee",
    "private",
  ]);
  await expect(
    page.getByRole("button", { name: "searching this server" }),
  ).toHaveCount(0);
  await expect(page.getByText("searching this server")).toBeVisible();
});

test("remote consent focus: cancel keeps the invoker, accept lands on the Meaning input", async ({
  page,
}) => {
  await page.goto("/new/meaning");
  await page
    .getByLabel("Meaning", { exact: true })
    .fill("book private committee");
  const invoker = page.getByRole("button", {
    name: "search this server",
    exact: true,
  });
  await invoker.click();
  const consent = page.getByRole("dialog", { name: "Search this server" });
  await consent.getByRole("button", { name: "Not now" }).click();
  await expect(invoker).toBeFocused();
  await invoker.click();
  await page
    .getByRole("dialog", { name: "Search this server" })
    .getByRole("button", { name: "Search this server", exact: true })
    .click();
  await expect(
    page.locator("ol.similar").getByRole("link", { name: "cukta" }),
  ).toBeVisible();
  await expect(page.getByLabel("Meaning", { exact: true })).toBeFocused();
});

test("typed-word consent focus: cancel keeps the invoker, accept lands on the Lojban word input", async ({
  page,
}) => {
  await page.goto("/new/meaning");
  await page.getByLabel("Lojban word", { exact: true }).fill("cukta");
  const panel = page.getByRole("region", { name: "Typed word", exact: true });
  const invoker = panel.getByRole("button", {
    name: "Check this word on the server",
  });
  await invoker.click();
  const consent = page.getByRole("dialog", { name: "Search this server" });
  await consent.getByRole("button", { name: "Not now" }).click();
  await expect(invoker).toBeFocused();
  await invoker.click();
  await page
    .getByRole("dialog", { name: "Search this server" })
    .getByRole("button", { name: "Search this server", exact: true })
    .click();
  await expect(panel).toContainText("Already exists:");
  await expect(page.getByLabel("Lojban word", { exact: true })).toBeFocused();
});

test("remote consent focus: a removed Meaning field falls back without landing on the body", async ({
  page,
}) => {
  await page.goto("/new/meaning");
  const meaning = page.getByLabel("Meaning", { exact: true });
  await meaning.fill("book private committee");
  await page
    .getByRole("button", { name: "search this server", exact: true })
    .click();
  await meaning.evaluate((element) => element.remove());
  await page
    .getByRole("dialog", { name: "Search this server" })
    .getByRole("button", { name: "Search this server", exact: true })
    .click();
  await expect(page.locator("ol.similar")).toContainText("cukta");
  await expect(
    page.getByRole("heading", { name: "What does the word mean?" }),
  ).toBeFocused();
  const tag = await page.evaluate(() => document.activeElement?.tagName);
  expect(tag).not.toBe("BODY");
});

test("typed-word consent focus: a disabled word field falls back without landing on the body", async ({
  page,
}) => {
  await page.goto("/new/meaning");
  const word = page.getByLabel("Lojban word", { exact: true });
  await word.fill("cukta");
  const panel = page.getByRole("region", { name: "Typed word", exact: true });
  await panel
    .getByRole("button", { name: "Check this word on the server" })
    .click();
  await word.evaluate((element: HTMLInputElement) => {
    element.disabled = true;
  });
  await page
    .getByRole("dialog", { name: "Search this server" })
    .getByRole("button", { name: "Search this server", exact: true })
    .click();
  await expect(panel).toContainText("Already exists:");
  await expect(
    page.getByRole("heading", { name: "What does the word mean?" }),
  ).toBeFocused();
  const tag = await page.evaluate(() => document.activeElement?.tagName);
  expect(tag).not.toBe("BODY");
});

test("typed-word consent focus: a delayed check does not override a later focus choice", async ({
  page,
}) => {
  let release!: () => void;
  let markStarted!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  await page.route("**/api/v1/words/**", async (route) => {
    markStarted();
    await gate;
    await route.continue();
  });
  await page.goto("/new/meaning");
  await page.getByLabel("Lojban word", { exact: true }).fill("cukta");
  const panel = page.getByRole("region", { name: "Typed word", exact: true });
  await panel
    .getByRole("button", { name: "Check this word on the server" })
    .click();
  await page
    .getByRole("dialog", { name: "Search this server" })
    .getByRole("button", { name: "Search this server", exact: true })
    .click();
  await started;
  const meaning = page.getByLabel("Meaning", { exact: true });
  await meaning.click();
  await expect(meaning).toBeFocused();
  release();
  await expect(panel).toContainText("Already exists:");
  // The check finishes loading its definitions after the heading appears.
  // Wait for that completion, when the old code moved focus, before judging.
  await page.waitForTimeout(1000);
  await expect(meaning).toBeFocused();
});

test("lujvo builder: Enter adds a part as entered without a package", async ({
  page,
}) => {
  await startLujvo(page);
  await page.getByLabel("Add a part").fill("sance");
  await page.getByLabel("Add a part").press("Enter");
  await expect(page.getByRole("list", { name: "Components" })).toContainText(
    "sance",
  );
  await expect(page.getByText("No parts yet")).toHaveCount(0);
});

test("consent sends only the disclosed terms and lists each separate request", async ({
  page,
}) => {
  const sent: string[] = [];
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname === "/api/v1/search" &&
      request.method() === "POST"
    )
      sent.push((request.postDataJSON() as { q: string }).q);
  });
  await page.goto("/new/meaning");
  const meaning = page.getByLabel("Meaning", { exact: true });
  await meaning.fill("book private committee");
  await page
    .getByRole("button", { name: "search this server", exact: true })
    .click();
  const consent = page.getByRole("dialog", { name: "Search this server" });
  await expect(consent).toContainText('"book", "private", "committee"');
  await expect(consent).toContainText(
    "Each word is sent as a separate request",
  );
  await meaning.evaluate((element: HTMLTextAreaElement) => {
    element.value = "book secretword";
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await consent
    .getByRole("button", { name: "Search this server", exact: true })
    .click();
  await page.waitForTimeout(800);
  expect(sent).toEqual([]);
  await expect(
    page.getByRole("button", { name: "search this server", exact: true }),
  ).toBeVisible();
});

test("remote consent dialog closes when the route ends", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Add a word" }).click();
  await page.getByLabel("Meaning", { exact: true }).fill("book");
  await page
    .getByRole("button", { name: "search this server", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Search this server" }),
  ).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.getByRole("dialog", { name: "Search this server" }),
  ).toHaveCount(0);
});

test("typed-word consent moves focus at close, before the network finishes", async ({
  page,
}) => {
  let release!: () => void;
  let markStarted!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  await page.route("**/api/v1/words/**", async (route) => {
    markStarted();
    await gate;
    await route.continue();
  });
  await page.goto("/new/meaning");
  await page.getByLabel("Lojban word", { exact: true }).fill("cukta");
  const panel = page.getByRole("region", { name: "Typed word", exact: true });
  await panel
    .getByRole("button", { name: "Check this word on the server" })
    .click();
  await page
    .getByRole("dialog", { name: "Search this server" })
    .getByRole("button", { name: "Search this server", exact: true })
    .click();
  await started;
  const word = page.getByLabel("Lojban word", { exact: true });
  await expect(word).toBeFocused();
  const meaning = page.getByLabel("Meaning", { exact: true });
  await meaning.click();
  await page.getByText("Plain words are fine.").click();
  release();
  await expect(panel).toContainText("Already exists:");
  await page.waitForTimeout(500);
  await expect(word).not.toBeFocused();
});

test("lujvo Enter with a package adds only exact matches and keeps other matches open", async ({
  page,
}) => {
  await downloadPackage(page);
  await startLujvo(page);
  const part = page.getByLabel("Add a part");
  const components = page.getByRole("list", { name: "Components" });
  const matching = page.getByRole("list", { name: "Matching words" });
  for (const gloss of ["book", "cuk"]) {
    await part.fill(gloss);
    await part.press("Enter");
    await expect(matching).toContainText("cukta");
    await expect(components).toContainText("No parts yet");
  }
  await part.fill(".cukta.");
  await part.press("Enter");
  await expect(components).toContainText("cukta");
  await part.fill("sinxa");
  await part.press("Enter");
  await expect(components).toContainText("sinxa");
  await expect(
    page.getByRole("group", { name: "Rafsi for cukta" }),
  ).toContainText("cku");
});

test("lujvo builder: Enter adds the exact package match", async ({ page }) => {
  await downloadPackage(page);
  await startLujvo(page);
  await page.getByLabel("Add a part").fill("cukta");
  await page.getByLabel("Add a part").press("Enter");
  await expect(page.getByRole("list", { name: "Components" })).toContainText(
    "cukta",
  );
});

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
