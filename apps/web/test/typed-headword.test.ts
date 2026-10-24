import { test, expect, type Page } from "@playwright/test";
import { createIdentity, acceptFirstSignature, PASSPHRASE } from "./helpers.ts";

async function packageDownload(page: Page) {
  await page.goto("/preferences");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText(
    "The English search package is saved in this browser.",
  );
}
async function typed(page: Page, spelling: string) {
  await page.goto("/new/meaning");
  await page
    .getByRole("textbox", { name: "Meaning", exact: true })
    .fill("A synthetic test definition.");
  await page
    .getByRole("textbox", { name: "Lojban word", exact: true })
    .fill(spelling);
  await expect(
    page.getByRole("region", { name: "Typed word", exact: true }),
  ).toContainText("Detected form:");
  await page.getByRole("button", { name: "New word", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "What kind of word?" }),
  ).toBeVisible();
}
async function draft(page: Page): Promise<any> {
  return page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return new LocalStore().get("drafts", "current");
  });
}

for (const spelling of ["bangu", "leksiko"])
  test(`typed ${spelling} goes straight to Places`, async ({ page }) => {
    await typed(page, spelling);
    await expect(
      page.getByRole("radio", {
        name: spelling === "bangu" ? /^gismu/ : /^fu'ivla/,
      }),
    ).toBeChecked();
    await page.getByRole("button", { name: "Continue to places" }).click();
    await expect(page).toHaveURL(/\/new\/places/);
    expect((await draft(page)).spelling).toBe(spelling);
  });

test("typed gismu shows linked closeness warnings beside confirmation and again at Publish", async ({
  page,
}) => {
  await packageDownload(page);
  await typed(page, "cukte");
  const closeness = page.getByRole("region", { name: "Gismu closeness" });
  await expect(closeness).toContainText("Last vowel differs from");
  await expect(
    closeness.getByRole("link", { name: "cukta", exact: true }),
  ).toBeVisible();
  await expect(
    closeness.getByRole("link", { name: "Add source-language evidence" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Continue to places" }).click();
  await page.goto("/new/publish");
  await expect(
    page
      .getByRole("region", { name: "Known conflicts" })
      .getByRole("link", { name: "cukta", exact: true }),
  ).toBeVisible();
});

test("typed gismu with no known close root reports package coverage", async ({
  page,
}) => {
  await packageDownload(page);
  await typed(page, "bangu");
  await expect(
    page.getByRole("region", { name: "Gismu closeness" }),
  ).toContainText("No known gismu is too close in this package.");
});

for (const spelling of [
  "ckusni",
  "cuktysinxa",
  "sairzba",
  "spageti'ybroda",
  "spageti'ykla",
  "kerlybai'ybroda",
  "kerlybla'ykla",
  "bangu'y'ismu",
  "sakrsakysakli",
  "SAI,rZBA",
])
  test(`typed lujvo ${spelling} keeps exact rafsi and joins through reload and the publication body`, async ({
    page,
  }) => {
    await typed(page, spelling);
    await page.getByRole("button", { name: "Link the lujvo parts" }).click();
    const result = page.getByRole("region", { name: "Result", exact: true });
    await expect(
      result.getByLabel(`Form ${spelling}`, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: `Use ${spelling}`, exact: true }),
    ).toBeEnabled();
    await page.reload();
    await expect(
      result.getByLabel(`Form ${spelling}`, { exact: true }),
    ).toBeVisible();
    await page
      .getByLabel("Current definition", { exact: true })
      .fill("A synthetic test definition.");
    await page
      .getByRole("button", { name: `Use ${spelling}`, exact: true })
      .click();
    await expect(page).toHaveURL(/\/new\/places/);
    const saved = await draft(page);
    expect(saved.spelling).toBe(spelling);
    expect(saved.lujvo.selected).toBe(spelling);
    expect(saved.compound.morphology.version).toBe("3");
    const publication = await page.evaluate(async () => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const { draftToBody } = await import(String("/src/model/draft.ts"));
      const saved = await new LocalStore().get("drafts", "current");
      return draftToBody(saved);
    });
    expect(publication.body?.word.spelling).toBe(spelling);
    expect(
      publication.problems.filter((problem: any) => problem.blocking),
    ).toEqual([]);
  });

for (const [spelling, kind] of [
  ["lo", "cmavo"],
  [".lojban.", "cmevla"],
  ["zzzz", "other"],
])
  test(`typed ${spelling} uses the manual Form path`, async ({ page }) => {
    await typed(page, spelling);
    await expect(
      page.getByRole("radio", {
        name: kind === "other" ? /^Other/ : new RegExp(`^${kind}`),
      }),
    ).toBeChecked();
    if (kind === "other")
      await expect(page.locator("main")).toContainText(
        "The form is not one word",
      );
    await page.locator("button.btn-primary").click();
    await expect(page).toHaveURL(/\/new\/form/);
    await expect(page.getByLabel("Spelling", { exact: true })).toHaveValue(
      spelling,
    );
    if (kind === "cmavo")
      await expect(page.getByLabel(/selma/).first()).toBeVisible();
    await page
      .getByRole("button", { name: `Use ${spelling}`, exact: true })
      .click();
    await expect(page).toHaveURL(/\/new\/places/);
  });

test("existing typed word offers its definitions and the ordinary add-definition path", async ({
  page,
}) => {
  await packageDownload(page);
  await page.goto("/new/meaning");
  await page
    .getByLabel("Meaning", { exact: true })
    .fill("Another synthetic sense.");
  await page.getByLabel("Lojban word", { exact: true }).fill("cukta");
  const panel = page.getByRole("region", { name: "Typed word", exact: true });
  await expect(panel).toContainText("Already exists:");
  await expect(
    panel.getByRole("link", { name: "cukta", exact: true }),
  ).toBeVisible();
  expect(await panel.getByRole("listitem").count()).toBeGreaterThan(1);
  await panel
    .getByRole("button", { name: "Add a definition", exact: true })
    .click();
  await expect(page).toHaveURL(/\/new\/type/);
  expect((await draft(page)).spelling).toBe("cukta");
});

test("missing package and offline lookup stay honest without passive draft uploads", async ({
  page,
  context,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/v1/words/")) requests.push(request.url());
  });
  await page.goto("/new/meaning");
  await page.getByLabel("Lojban word", { exact: true }).fill("cukta");
  const panel = page.getByRole("region", { name: "Typed word", exact: true });
  await expect(panel).toContainText("The word could not be checked.");
  expect(requests).toEqual([]);
  page.on("dialog", (dialog) => void dialog.accept());
  await context.setOffline(true);
  await panel
    .getByRole("button", { name: "Check this word on the server" })
    .click();
  await expect(panel).toContainText(
    "The word could not be checked on this server:",
  );
  await context.setOffline(false);
});

test("remote duplicate consent belongs to one word and language and ignores an old response", async ({
  page,
}) => {
  page.on("dialog", (dialog) => void dialog.accept());
  await page.goto("/new/meaning");
  await page.getByLabel("Lojban word", { exact: true }).fill("cukta");
  const panel = page.getByRole("region", { name: "Typed word", exact: true });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let seen!: () => void;
  const started = new Promise<void>((resolve) => {
    seen = resolve;
  });
  await page.route("**/api/v1/words/**", async (route) => {
    const response = await route.fetch();
    seen();
    await gate;
    await route.fulfill({ response });
  });
  await panel
    .getByRole("button", { name: "Check this word on the server" })
    .click();
  await started;
  await page.getByLabel("Lojban word", { exact: true }).fill("bangu");
  release();
  await expect(
    panel.getByRole("button", { name: "Check this word on the server" }),
  ).toBeVisible();
  await expect(panel).not.toContainText("Already exists");
  await page.getByLabel("Other language tag", { exact: true }).fill("fr");
  await expect(
    panel.getByRole("button", { name: "Check this word on the server" }),
  ).toBeVisible();
});

test("ambiguous rafsi source choice and an unlisted source preserve typed joins on reload", async ({
  page,
}) => {
  await packageDownload(page);
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const cached: any = await store.get("packages", "en");
    const base = cached.entries.find(
      (entry: any) => entry.word.spelling === "cukta",
    );
    cached.entries.push({
      ...base,
      event: "jve1:" + "f".repeat(64),
      word: { language: "jbo", spelling: "cukte" },
      rafsi: ["cku"],
    });
    await store.put("packages", "en", cached);
  });
  await typed(page, "ckusni");
  await page.getByRole("button", { name: "Link the lujvo parts" }).click();
  await expect(
    page.getByRole("button", { name: "Use ckusni", exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel("Source word for part 1", { exact: true })
    .selectOption("cukte");
  for (const box of await page
    .getByRole("region", { name: "Result", exact: true })
    .getByRole("checkbox")
    .all())
    await box.check();
  await expect(
    page.getByText("Saved in this browser", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByLabel("Source word for part 1", { exact: true }),
  ).toHaveValue("cukte");
  await page
    .getByLabel("Other source word for part 1", { exact: true })
    .fill("bangu");
  await page
    .getByLabel("Other source word for part 1", { exact: true })
    .press("Tab");
  await expect(
    page
      .getByRole("region", { name: "Result", exact: true })
      .getByLabel("Form ckusni", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Saved in this browser", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByLabel("Other source word for part 1", { exact: true }),
  ).toHaveValue("bangu");
  expect((await draft(page)).lujvo.components[0]).toMatchObject({
    spelling: "bangu",
    definition: null,
    claims: [],
    locked: "cku",
  });
});

for (const spelling of ["sairzba", "bangu'y'ismu", "SAI,rZBA"])
  test(`publication signs the exact typed spelling ${spelling}`, async ({
    page,
  }) => {
    await createIdentity(page);
    await typed(page, spelling);
    await page.getByRole("button", { name: "Link the lujvo parts" }).click();
    await page
      .getByLabel("Current definition", { exact: true })
      .fill("A synthetic publication definition.");
    await page
      .getByRole("button", { name: `Use ${spelling}`, exact: true })
      .click();
    await page.getByRole("button", { name: "Review", exact: true }).click();
    await page
      .locator("aside")
      .getByRole("button", { name: "Publish", exact: true })
      .click();
    const unlock = page.getByRole("dialog", { name: "Unlock your key" });
    if (await unlock.isVisible()) {
      await unlock.getByLabel("Passphrase").fill(PASSPHRASE);
      await unlock.getByRole("button", { name: "Unlock", exact: true }).click();
    }
    await acceptFirstSignature(page);
    await expect(page).toHaveURL(/\/word\//);
    const published = await page.evaluate(async () => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const rows: any[] = await new LocalStore().list("outbox");
      return rows
        .map((row) => JSON.parse(row.transport))
        .find(
          (row) => row.envelope.header.action.kind === "definition.publish",
        );
    });
    expect(published.body.word.spelling).toBe(spelling);
    expect(published.body.etymology.compound.morphology.version).toBe("3");
  });

test("remote existence remains visible when a definition cannot be fetched", async ({
  page,
}) => {
  page.on("dialog", (dialog) => void dialog.accept());
  await page.goto("/new/meaning");
  await page.route("**/api/v1/events/**", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        code: "unavailable",
        message: "Synthetic unavailable record.",
        event: null,
        field: null,
      }),
    }),
  );
  await page.getByLabel("Lojban word", { exact: true }).fill("cukta");
  const panel = page.getByRole("region", { name: "Typed word", exact: true });
  await panel
    .getByRole("button", { name: "Check this word on the server" })
    .click();
  await expect(panel).toContainText("Already exists:");
  await expect(panel).toContainText("Definition unavailable.");
  await expect(
    panel.getByRole("button", { name: "Add a definition", exact: true }),
  ).toBeVisible();
});

test("an oversized typed word exposes diagnostics and permits an experimental kind", async ({
  page,
}) => {
  await typed(page, "b".repeat(129));
  await expect(page.locator("main")).toContainText("above the limit of 128");
  await expect(page.getByRole("radio", { name: /^Other/ })).toBeChecked();
});

for (const kind of ["compound", "letteral"])
  test(`typed cmavo can use the ${kind} classification`, async ({ page }) => {
    await typed(page, "lo");
    await page.getByRole("radio", { name: /^Other/ }).check();
    await page
      .getByLabel(
        "Which other kind? Every lexical kind that the format permits is listed.",
      )
      .selectOption(kind);
    await page.locator("button.btn-primary").click();
    await expect(page.getByLabel("Spelling", { exact: true })).toHaveValue(
      "lo",
    );
    await expect(page.getByLabel(/selma/).first()).toBeVisible();
    await page.getByRole("button", { name: "Use lo", exact: true }).click();
    expect((await draft(page)).kind).toBe(kind);
  });

test("later spelling edits update detection and flag retained evidence without removing annotations", async ({
  page,
}) => {
  await typed(page, "ckusni");
  await page.getByRole("button", { name: "Link the lujvo parts" }).click();
  await page
    .getByLabel("Current definition", { exact: true })
    .fill("A synthetic retained definition.");
  await page.getByRole("button", { name: "Use ckusni", exact: true }).click();
  await page.goto("/new/editor");
  await page.getByLabel("Headword", { exact: true }).fill("bangu");
  await expect(
    page.getByText("Saved in this browser", { exact: true }),
  ).toBeVisible();
  await page.goto("/new/type");
  await expect(page.locator("main")).toContainText("Detected form: gismu.");
  const saved = await draft(page);
  expect(saved.evidenceForm).toBe("ckusni");
  expect(saved.compound).not.toBeNull();
  expect(saved.review).toContain("spelling");
  expect(saved.text).toEqual([["A synthetic retained definition."]]);
});

async function seedBuilder(page: Page, kind: "gismu" | "lujvo") {
  await page.goto("/new/meaning");
  await page.evaluate(async (kind) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { newDraft } = await import(String("/src/model/draft.ts"));
    const { newGismuState, newLujvoState } = await import(
      String("/src/model/builders.ts")
    );
    const store = new LocalStore();
    const draft = newDraft({
      kind,
      spelling: kind === "gismu" ? "bangu" : "zzzz",
      typedSpelling: kind === "gismu" ? "bangu" : "zzzz",
      text: "A synthetic definition.",
      meaning: "A synthetic meaning.",
      step: 3,
    });
    if (kind === "gismu")
      draft.gismu = {
        ...newGismuState(),
        rows: [
          {
            id: "source-test",
            language: "en",
            name: "English",
            word: "book",
            input: "cukta",
            weight: { numerator: "1", denominator: "1" },
            aiNoteGroup: [],
          },
        ],
      };
    else
      draft.lujvo = {
        ...newLujvoState(),
        components: [
          {
            id: "a",
            spelling: "bangu",
            kind: "gismu",
            definition: null,
            gloss: "language",
            locked: "bau",
            claims: [{ rafsi: "bau", pair: "pair-a" }],
          },
          {
            id: "b",
            spelling: "sinxa",
            kind: "gismu",
            definition: null,
            gloss: "sign",
            locked: "sni",
            claims: [{ rafsi: "sni", pair: "pair-b" }],
          },
        ],
      };
    await store.put("drafts", "current", draft);
  }, kind);
}

for (const kind of ["gismu", "lujvo"] as const)
  test(`${kind} builder asks before replacing a typed spelling`, async ({
    page,
  }) => {
    await seedBuilder(page, kind);
    await page.goto(`/new/${kind}`);
    if (kind === "gismu")
      await page
        .getByRole("button", { name: "Choose cukta", exact: true })
        .click();
    const primary = page.locator("button.btn-primary");
    await expect(primary).toBeEnabled();
    const selected = (await primary.textContent())!.replace(/^Use /, "");
    const original = kind === "gismu" ? "bangu" : "zzzz";
    page.once("dialog", (dialog) => {
      expect(dialog.message()).toContain(
        `Replace the typed spelling "${original}"`,
      );
      void dialog.dismiss();
    });
    await primary.click();
    expect((await draft(page)).spelling).toBe(original);
    page.once("dialog", (dialog) => void dialog.accept());
    await primary.click();
    await expect(page).toHaveURL(/\/new\/places/);
    expect((await draft(page)).spelling).toBe(selected);
  });

test("source-language evidence preserves the typed gismu", async ({ page }) => {
  await seedBuilder(page, "gismu");
  await page.goto("/new/gismu?evidence=1");
  const primary = page.getByRole("button", { name: "Use bangu", exact: true });
  await expect(primary).toBeEnabled();
  await primary.click();
  await expect(page).toHaveURL(/\/new\/places/);
  const saved = await draft(page);
  expect(saved.spelling).toBe("bangu");
  expect(saved.formation.generated).toBe("bangu");
});
