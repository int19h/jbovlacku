import { typeRichText } from "./rich-helpers.ts";
import { test, expect, type Page } from "@playwright/test";
import {
  createIdentity,
  expectKindSpelling,
  acceptFirstSignature,
  corePath,
  PASSPHRASE,
} from "./helpers.ts";

async function packageDownload(page: Page) {
  await page.goto("/preferences");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect(page.locator("#app > [role=status]")).toHaveText(
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
  await expect(page).toHaveURL(/\/new\/places$/);
  await expect.poll(async () => (await draft(page)).kind).toBe("gismu");
  await typeRichText(
    page.getByLabel("Definition text", { exact: true }),
    (await draft(page)).meaning,
  );
  await page
    .getByRole("list", { name: "Steps" })
    .getByRole("link", { name: /^Publish\b/ })
    .click();
  await expect(page).toHaveURL(/\/new\/publish$/);
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
  ".eiksyspe",
])
  test(`typed lujvo ${spelling} keeps exact morphology without invented compound attribution`, async ({
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
    ).toBeDisabled();
    for (const source of await page
      .getByRole("textbox", { name: /^Other source word for part/ })
      .all())
      await expect(source).toHaveValue("");
    await page.reload();
    await expect(
      result.getByLabel(`Form ${spelling}`, { exact: true }),
    ).toBeVisible();
    await typeRichText(
      page.getByLabel("Current definition", { exact: true }),
      "A synthetic test definition.",
    );
    await page
      .getByRole("button", {
        name: "Continue without compound metadata",
        exact: true,
      })
      .click();
    await expect(page).toHaveURL(/\/new\/places/);
    const saved = await draft(page);
    expect(saved.spelling).toBe(spelling);
    expect(saved.lujvo.selected).toBe(spelling);
    expect(saved.compound).toBeNull();
    const publication = await page.evaluate(async (corePath) => {
      const core = await import(corePath);
      await core.initializeCore();
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const { draftToBody } = await import(String("/src/model/draft.ts"));
      const saved = await new LocalStore().get("drafts", "current");
      return draftToBody(saved);
    }, corePath);
    expect(publication.body?.word.spelling).toBe(spelling);
    expect(
      publication.problems.filter((problem: any) => problem.blocking),
    ).toEqual([]);
  });

async function linkSources(page: Page, words: string[]) {
  for (const [index, word] of words.entries()) {
    const field = page.getByLabel(`Other source word for part ${index + 1}`, {
      exact: true,
    });
    await field.fill(word);
    await field.press("Tab");
  }
}

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
    await linkSources(
      page,
      spelling === "bangu'y'ismu" ? ["bangu", "ismu"] : ["sanmi", "zbasu"],
    );
    await typeRichText(
      page.getByLabel("Current definition", { exact: true }),
      "A synthetic publication definition.",
    );
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
    expect(published.body.etymology.compound.morphology.version).toBe("4");
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
  await linkSources(page, ["cukta", "sinxa"]);
  await typeRichText(
    page.getByLabel("Current definition", { exact: true }),
    "A synthetic retained definition.",
  );
  await page.getByRole("button", { name: "Use ckusni", exact: true }).click();
  await expect(page).toHaveURL(/\/new\/places$/);
  await expect
    .poll(async () => (await draft(page)).evidenceForm)
    .toBe("ckusni");
  await page
    .getByRole("link", { name: "Skip to the full editor", exact: true })
    .click();
  await expect(page).toHaveURL(/\/new\/editor$/);
  await page.getByLabel("Headword", { exact: true }).fill("bangu");
  await expect(
    page.getByText("Saved in this browser", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("list", { name: "Steps" })
    .getByRole("link", { name: /^Type\b/ })
    .click();
  await expect(page).toHaveURL(/\/new\/type$/);
  await expect(page.locator("main")).toContainText("Detected form: gismu.");
  const saved = await draft(page);
  expect(saved.evidenceForm).toBe("ckusni");
  expect(saved.compound).not.toBeNull();
  expect(saved.review).toContain("spelling");
  expect(saved.kind).toBe("lujvo");
  await expect(page.getByRole("radio", { name: /^lujvo/ })).toBeChecked();
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

for (const spelling of ["bangu", "Bangu", "ban,gu", ".Bangu."])
  test(`source-language evidence preserves the typed gismu ${spelling}`, async ({
    page,
  }) => {
    await seedBuilder(page, "gismu");
    await page.evaluate(async (spelling) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const store = new LocalStore();
      const value: any = await store.get("drafts", "current");
      value.spelling = spelling;
      value.typedSpelling = spelling;
      await store.put("drafts", "current", value);
    }, spelling);
    await page.goto("/new/gismu?evidence=1");
    const primary = page.getByRole("button", {
      name: "Use bangu",
      exact: true,
    });
    await expect(primary).toBeEnabled();
    await page
      .getByLabel("Type a form yourself", { exact: true })
      .fill(spelling);
    await expect(primary).toBeEnabled();
    await primary.click();
    await expect(page).toHaveURL(/\/new\/places/);
    const saved = await draft(page);
    expect(saved.spelling).toBe(spelling);
    expect(saved.evidenceForm).toBe(spelling);
    expect(saved.formation.generated).toBe("bangu");
  });

for (const [version, spelling, sources, locks, incompatible] of [
  ["2", "ckusni'ybroda", ["ckusni", "broda"], ["ckusni", "broda"], false],
  ["2", "ckusni'ybroda", ["ckusni", "broda"], ["ckusni", "broda"], true],
  ["3", "sairzba", ["sanmi", "zbasu"], ["sai", "zba"], false],
  ["3", "bangu'y'ismu", ["bangu", "ismu"], ["bangu", "ismu"], false],
] as const)
  test(`an unknown-origin saved version ${version} compound keeps editable exact parts and spelling ${spelling}${incompatible ? " with incompatible typed state" : ""}`, async ({
    page,
  }) => {
    await typed(page, spelling);
    await page.evaluate(
      async ({ version, sources, locks, incompatible }) => {
        const { LocalStore } = await import(String("/src/data/store.ts"));
        const store = new LocalStore();
        const value: any = await store.get("drafts", "current");
        const base =
          "https://github.com/int19h/jbovlacku/blob/main/docs/morphology.md#";
        value.kind = "lujvo";
        value.evidenceForm = value.spelling;
        value.lujvo = null;
        if (incompatible) {
          const { newLujvoState } = await import(
            String("/src/model/builders.ts")
          );
          value.lujvo = {
            ...newLujvoState(),
            typed: value.spelling,
            joins: ["", "'y"],
            components: ["cku", "sni", "broda"].map((part, index) => ({
              id: `old-${index}`,
              spelling: part,
              kind: "other",
              definition: null,
              gloss: "",
              claims: [],
              locked: part,
            })),
          };
        }
        value.compound = {
          components: sources.map((spelling, index) => ({
            word: { language: "jbo", spelling },
            definition: null,
            rafsi: locks[index],
          })),
          morphology: { id: base + "extended-lujvo", version },
          scoring: { id: base + "extended-lujvo-scoring", version: "1" },
          score: null,
          notes: [],
        };
        await store.put("drafts", "current", value);
      },
      { version, sources, locks, incompatible },
    );
    await page.goto("/new/lujvo");
    if (version === "2")
      await expect(
        page.getByText("Saved morphology: extended version 2.", {
          exact: true,
        }),
      ).toBeVisible();
    await expect
      .poll(async () => (await draft(page)).lujvo?.profile)
      .toBe(version === "2" ? "extended-v2" : "extended");
    await expect(
      page
        .getByRole("region", { name: "Result", exact: true })
        .getByLabel(`Form ${spelling}`, { exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("Add a part", { exact: true })).toBeVisible();
    await expect
      .poll(async () => (await draft(page)).lujvo?.typedOrigin)
      .toBeUndefined();
    for (const source of sources)
      await expect(
        page.getByRole("group", { name: `Rafsi for ${source}`, exact: true }),
      ).toBeVisible();
    await expect(
      page.getByText("Saved in this browser", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Add a part", { exact: true })).toBeVisible();
    await expect(
      page
        .getByRole("region", { name: "Result", exact: true })
        .getByLabel(`Form ${spelling}`, { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: `Use ${spelling}`, exact: true })
      .click();
    await expect(page).toHaveURL(/\/new\/places$/);
    expect((await draft(page)).compound.morphology.version).toBe(version);
    expect(
      (await draft(page)).compound.components.map((part: any) => part.rafsi),
    ).toEqual(locks);
  });

test("clearing a typed lujvo restores the ordinary component builder", async ({
  page,
}) => {
  await typed(page, "ckusni");
  await page.getByRole("button", { name: "Link the lujvo parts" }).click();
  await page
    .getByRole("list", { name: "Steps" })
    .getByRole("link", { name: /^Meaning\b/ })
    .click();
  await page.getByLabel("Lojban word", { exact: true }).fill("");
  await page.getByRole("button", { name: "New word", exact: true }).click();
  await page
    .getByRole("button", { name: "Build the lujvo", exact: true })
    .click();
  await expect(page.getByLabel("Add a part", { exact: true })).toBeVisible();
  expect((await draft(page)).lujvo.typed).toBeUndefined();
  const remove = page.getByRole("button", { name: /^Remove(?: |$)/ });
  while (await remove.count()) await remove.first().click();
  for (const word of ["bangu", "sinxa"]) {
    await page.getByLabel("Add a part", { exact: true }).fill(word);
    await page
      .getByRole("button", { name: `Add ${word} as entered`, exact: true })
      .click();
  }
  const primary = page.locator("button.btn-primary");
  await expect(primary).toBeEnabled();
  const spelling = (await primary.innerText()).replace(/^Use /, "");
  await primary.click();
  await expect(page).toHaveURL(/\/new\/places$/);
  expect((await draft(page)).spelling).toBe(spelling);
  expect(
    (await draft(page)).compound.components.map(
      (part: any) => part.word.spelling,
    ),
  ).toEqual(["bangu", "sinxa"]);
});

test("a different normalized gismu candidate still asks in evidence mode", async ({
  page,
}) => {
  await seedBuilder(page, "gismu");
  await page.goto("/new/gismu?evidence=1");
  await page.getByRole("button", { name: "Choose cukta", exact: true }).click();
  const primary = page.getByRole("button", { name: "Use cukta", exact: true });
  await expect(primary).toBeEnabled();
  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain(
      'Replace the typed spelling "bangu" with "cukta"?',
    );
    void dialog.dismiss();
  });
  await primary.click();
  expect((await draft(page)).spelling).toBe("bangu");
  page.once("dialog", (dialog) => void dialog.accept());
  await primary.click();
  await expect(page).toHaveURL(/\/new\/places$/);
  expect((await draft(page)).spelling).toBe("cukta");
});

test("an authored compound-cmavo type survives a spelling correction without formation evidence", async ({
  page,
}) => {
  await typed(page, "lo'e");
  await page.getByRole("radio", { name: /^Other/ }).check();
  await page
    .getByLabel(
      "Which other kind? Every lexical kind that the format permits is listed.",
    )
    .selectOption("compound");
  await page.locator("button.btn-primary").click();
  await page.getByLabel("Spelling", { exact: true }).fill("lo'a");
  await page
    .getByRole("list", { name: "Steps" })
    .getByRole("link", { name: /^Type\b/ })
    .click();
  await expect(page.getByRole("radio", { name: /^Other/ })).toBeChecked();
  await expect(
    page.getByLabel(
      "Which other kind? Every lexical kind that the format permits is listed.",
    ),
  ).toHaveValue("compound");
  await expect(page.locator("main")).toContainText("Detected form: cmavo.");
  await expect(page.locator("main")).toContainText(
    "Review the word type that you chose.",
  );
  const value = await draft(page);
  expect(value.kind).toBe("compound");
  expect(value.formation).toBeNull();
  expect(value.compound).toBeNull();
});

test("ordinary generation asks before replacing equivalent typed bytes", async ({
  page,
}) => {
  await seedBuilder(page, "gismu");
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const value: any = await store.get("drafts", "current");
    value.spelling = "Bangu";
    value.typedSpelling = "Bangu";
    value.gismu.manual = "bangu";
    value.gismu.selected = "bangu";
    await store.put("drafts", "current", value);
  });
  await page.goto("/new/gismu");
  const primary = page.getByRole("button", { name: "Use bangu", exact: true });
  await expect(primary).toBeEnabled();
  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain(
      'Replace the typed spelling "Bangu" with "bangu"?',
    );
    void dialog.dismiss();
  });
  await primary.click();
  expect((await draft(page)).spelling).toBe("Bangu");
});

async function editMeaningWord(page: Page, spelling: string) {
  await page
    .getByRole("list", { name: "Steps" })
    .getByRole("link", { name: /^Meaning\b/ })
    .click();
  await page.getByLabel("Lojban word", { exact: true }).fill(spelling);
  await page.getByRole("button", { name: "New word", exact: true }).click();
  await expect(page).toHaveURL(/\/new\/type$/);
}

test("an unconfirmed detected type follows a corrected spelling", async ({
  page,
}) => {
  await typed(page, "klama");
  await expect(page.getByRole("radio", { name: /^gismu/ })).toBeChecked();
  await editMeaningWord(page, "ckusni");
  await expect(page.getByRole("radio", { name: /^lujvo/ })).toBeChecked();
  await expect(
    page.getByRole("button", { name: "Link the lujvo parts", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "The spelling changed. Review the word type that you chose.",
      { exact: true },
    ),
  ).toBeHidden();
  await expect
    .poll(async () => (await draft(page)).autoDetectedKind)
    .toBe("lujvo");
  expect((await draft(page)).review).not.toContain("word type");
});

for (const completion of ["selection", "confirmation", "matching spelling"])
  test(`an accepted type stays selected and its review clears after ${completion}`, async ({
    page,
  }) => {
    await typed(page, "klama");
    await page
      .getByRole("button", { name: "Continue to places", exact: true })
      .click();
    await expect(page).toHaveURL(/\/new\/places$/);
    expect((await draft(page)).autoDetectedKind).toBeUndefined();
    await editMeaningWord(page, "ckusni");
    await expect(page.getByRole("radio", { name: /^gismu/ })).toBeChecked();
    const note = page.getByText(
      "The spelling changed. Review the word type that you chose.",
      { exact: true },
    );
    await expect(note).toBeVisible();
    if (completion === "selection")
      await page.getByRole("radio", { name: /^lujvo/ }).check();
    else if (completion === "confirmation") {
      await page
        .getByRole("button", { name: "Continue to places", exact: true })
        .click();
      await expect(page).toHaveURL(/\/new\/places$/);
      await page
        .getByRole("list", { name: "Steps" })
        .getByRole("link", { name: /^Type\b/ })
        .click();
    } else await editMeaningWord(page, "bangu");
    await expect(note).toBeHidden();
    await expect
      .poll(async () => {
        const saved = await draft(page);
        return {
          kind: saved.kind,
          detectionFor: saved.detectionFor,
          review: saved.review.includes("word type"),
        };
      })
      .toEqual({
        kind: completion === "selection" ? "lujvo" : "gismu",
        detectionFor: completion === "matching spelling" ? "bangu" : "ckusni",
        review: false,
      });
    await page.reload();
    await expect(note).toBeHidden();
  });

for (const staleMarker of ["none", "stale", "invalid typed rows"])
  test(`an ordinary generated lujvo stays editable after replacing a typed word${staleMarker === "none" ? "" : ` with ${staleMarker}`}`, async ({
    page,
  }) => {
    await typed(page, "klama");
    await page.getByRole("radio", { name: /^lujvo/ }).check();
    await page
      .getByRole("button", { name: "Link the lujvo parts", exact: true })
      .click();
    for (const word of ["bangu", "sinxa"]) {
      await page.getByLabel("Add a part", { exact: true }).fill(word);
      await page
        .getByRole("button", { name: `Add ${word} as entered`, exact: true })
        .click();
    }
    const use = page.locator("button.btn-primary");
    await expect(use).toBeEnabled();
    const spelling = (await use.innerText()).replace(/^Use /, "");
    page.once("dialog", (dialog) => {
      expect(dialog.message()).toContain('Replace the typed spelling "klama"');
      void dialog.accept();
    });
    await use.click();
    await expect(page).toHaveURL(/\/new\/places$/);
    expect((await draft(page)).spelling).toBe(spelling);
    expect((await draft(page)).typedSpelling).toBeNull();
    if (staleMarker !== "none") {
      await page.evaluate(async (mode) => {
        const { LocalStore } = await import(String("/src/data/store.ts"));
        const store = new LocalStore();
        const value: any = await store.get("drafts", "current");
        value.typedSpelling = mode === "stale" ? "klama" : value.spelling;
        if (mode === "invalid typed rows") value.lujvo.typed = value.spelling;
        await store.put("drafts", "current", value);
      }, staleMarker);
      await page.reload();
    }
    await page
      .getByRole("list", { name: "Steps" })
      .getByRole("link", { name: /^Form\b/ })
      .click();
    await expect(page.getByLabel("Add a part", { exact: true })).toBeVisible();
    for (const word of ["bangu", "sinxa"])
      await expect(
        page
          .getByRole("group", { name: `Rafsi for ${word}`, exact: true })
          .getByRole("radio", { name: "automatic", exact: true }),
      ).toBeChecked();
    await expect
      .poll(async () => (await draft(page)).lujvo.typed)
      .toBeUndefined();
    await page.getByLabel("Add a part", { exact: true }).fill("klama");
    await page
      .getByRole("button", { name: "Add klama as entered", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Remove klama", exact: true }),
    ).toBeVisible();
    if (await page.locator("button.btn-primary").isDisabled())
      await page
        .getByRole("region", { name: "Other forms", exact: true })
        .getByRole("button")
        .first()
        .click();
    await expect(page.locator("button.btn-primary")).toBeEnabled();
  });

test("returning to unknown morphology clears a completed Other type review", async ({
  page,
}) => {
  await typed(page, "zzzz");
  await page.locator("button.btn-primary").click();
  await expect(page).toHaveURL(/\/new\/form$/);
  await editMeaningWord(page, "klama");
  const note = page.getByText(
    "The spelling changed. Review the word type that you chose.",
    { exact: true },
  );
  await expect(note).toBeVisible();
  await editMeaningWord(page, "zzzz");
  await expect(page.getByRole("radio", { name: /^Other/ })).toBeChecked();
  await expect(note).toBeHidden();
  await expect
    .poll(async () => (await draft(page)).review.includes("word type"))
    .toBe(false);
});

test("R8 repeated gismu evidence visits retain typed identity and later replacement confirmation", async ({
  page,
}) => {
  await seedBuilder(page, "gismu");
  for (let visit = 0; visit < 2; visit++) {
    await page.goto("/new/gismu?evidence=1");
    await expect(
      page.getByRole("button", { name: "Use bangu", exact: true }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Use bangu", exact: true }).click();
    await expect(page).toHaveURL(/\/new\/places$/);
    expect((await draft(page)).typedSpelling).toBe("bangu");
    await page.reload();
  }
  await page.goto("/new/gismu");
  await page.getByRole("button", { name: "Choose cukta", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Use cukta", exact: true }),
  ).toBeEnabled();
  let replacement = "";
  page.once("dialog", (dialog) => {
    replacement = dialog.message();
    void dialog.dismiss();
  });
  await page.getByRole("button", { name: "Use cukta", exact: true }).click();
  expect(replacement).toBe('Replace the typed spelling "bangu" with "cukta"?');
  expect((await draft(page)).spelling).toBe("bangu");
});

test("R8 gismu replacement reviews retained annotations and manual Form Use rebinds changed source evidence", async ({
  page,
}) => {
  await seedBuilder(page, "gismu");
  await page.goto("/new/gismu?evidence=1");
  await page.getByRole("button", { name: "Use bangu", exact: true }).click();
  await expect(page).toHaveURL(/\/new\/places$/);
  await page.goto("/new/gismu");
  await page.getByLabel("Type a form yourself", { exact: true }).fill("cukte");
  await expect(
    page.getByRole("button", { name: "Use cukte", exact: true }),
  ).toBeEnabled();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Use cukte", exact: true }).click();
  await expect(page).toHaveURL(/\/new\/places$/);
  expect((await draft(page)).review).toEqual([]);
  expect((await draft(page)).evidenceForm).toBe("cukte");
  await page.goto("/new/gismu");
  await page
    .getByLabel("Native word for English", { exact: true })
    .fill("volume");
  await expect
    .poll(async () => (await draft(page)).formation.sources[0].word)
    .toBe("volume");
  expect((await draft(page)).evidenceForm).toBe("cukte");
  await page
    .getByLabel("Scoring letters for English", { exact: true })
    .fill("volum");
  await expect(
    page.getByText(/^The source scoring inputs changed\./),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Enter without generation", exact: true })
    .click();
  await page.getByLabel("Spelling", { exact: true }).fill("cukta");
  await expect(
    page.getByText(/^The source scoring inputs changed\./),
  ).toBeVisible();
  await page.getByRole("button", { name: "Use cukta", exact: true }).click();
  await expect(page).toHaveURL(/\/new\/places$/);
  const manual = await draft(page);
  expect(manual.formation.method).toBe("non-algorithmic");
  expect(manual.formation.selected_score).toBeNull();
  expect(manual.formation.sources[0].input.text).toBe("volum");
  expect(manual.evidenceForm).toBe("cukta");
  expect(manual.review).toEqual(["spelling"]);
  await page.reload();
  expect((await draft(page)).evidenceForm).toBe("cukta");
});

test("fu'ivla publication signs fuhivla and keeps the visible spelling", async ({
  page,
}) => {
  await createIdentity(page);
  await typed(page, "leksiko");
  await expect(page.getByRole("radio", { name: /^fu'ivla/ })).toBeChecked();
  await page.getByRole("button", { name: "Continue to places" }).click();
  await expect.poll(async () => (await draft(page)).kind).toBe("fuhivla");
  await expectKindSpelling(page);
  await typeRichText(
    page.getByLabel("Definition text", { exact: true }),
    "A synthetic borrowing definition.",
  );
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expectKindSpelling(page);
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
  await expectKindSpelling(page);
  const published = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const rows: any[] = await new LocalStore().list("outbox");
    return rows
      .map((row) => JSON.parse(row.transport))
      .find((row) => row.envelope.header.action.kind === "definition.publish");
  });
  expect(published.body.classification.kind).toBe("fuhivla");
  expect(published.body.word.spelling).toBe("leksiko");
});
