import { test, expect, type Page } from "@playwright/test";
import type { LexicalKind } from "../src/model/types.ts";
import { corePath } from "./helpers.ts";

const reviewText = "The spelling changed. Review the word type that you chose.";
async function saved(page: Page): Promise<any> {
  return page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return new LocalStore().get("drafts", "current");
  });
}
async function meaningWord(page: Page, spelling: string) {
  await page
    .getByRole("list", { name: "Steps" })
    .getByRole("link", { name: /^Meaning\b/ })
    .click();
  await page.getByLabel("Lojban word", { exact: true }).fill(spelling);
  await page.getByRole("button", { name: "New word", exact: true }).click();
  await expect(page).toHaveURL(/\/new\/type$/);
}
async function seed(
  page: Page,
  options: {
    kind?: LexicalKind | null;
    word?: string;
    auto?: LexicalKind;
    evidence?: boolean;
    detectionFor?: string;
  } = {},
) {
  await page.goto("/new/meaning");
  await page.evaluate(async (options) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { newDraft } = await import(String("/src/model/draft.ts"));
    const { newGismuState, manualFormation } = await import(
      String("/src/model/builders.ts")
    );
    const rows = [
      {
        id: "test-en",
        language: "en",
        name: "English",
        word: "book",
        input: "cukta",
        weight: { numerator: "1", denominator: "1" },
        aiNoteGroup: [],
      },
    ];
    const value = newDraft({
      kind: options.kind ?? null,
      spelling: options.word ?? "bangu",
      typedSpelling: options.word ?? "bangu",
      detectionFor: options.detectionFor,
      autoDetectedKind: options.auto,
      text: "A synthetic definition.",
      meaning: "A synthetic meaning.",
      step: 2,
    });
    value.gismu = {
      ...newGismuState(),
      rows,
      manual: "bangu",
      selected: "bangu",
    };
    if (options.evidence) {
      value.formation = manualFormation(rows, "Synthetic evidence.");
      value.evidenceForm = "bangu";
    }
    await new LocalStore().put("drafts", "current", value);
  }, options);
}

for (const route of ["/new/gismu?evidence=1", "/new/lujvo", "/new/form"])
  test(`direct own-kind entry confirms its automatic type at ${route}`, async ({
    page,
  }) => {
    const kind = route.includes("gismu")
      ? "gismu"
      : route.includes("lujvo")
        ? "lujvo"
        : "cmavo";
    const word =
      kind === "gismu" ? "bangu" : kind === "lujvo" ? "ckusni" : "lo";
    await seed(page, { kind, word, auto: kind, detectionFor: word });
    await page.goto(route);
    await expect
      .poll(async () => (await saved(page)).autoDetectedKind)
      .toBeUndefined();
    await meaningWord(page, "leksiko");
    await expect(page.getByText(reviewText, { exact: true })).toBeVisible();
    expect((await saved(page)).kind).toBe(kind);
  });

for (const target of ["Form", "Places", "Publish", "full editor"])
  test(`forward ${target} navigation confirms the detected type`, async ({
    page,
  }) => {
    await seed(page, { word: "ckusni" });
    await page.goto("/new/type");
    await expect
      .poll(async () => (await saved(page)).autoDetectedKind)
      .toBe("lujvo");
    if (target === "full editor")
      await page
        .getByRole("link", { name: "Skip to the full editor", exact: true })
        .click();
    else
      await page
        .getByRole("list", { name: "Steps" })
        .getByRole("link", { name: new RegExp(`^${target}\\b`) })
        .click();
    await expect(page).not.toHaveURL(/\/new\/type$/);
    await expect
      .poll(async () => (await saved(page)).autoDetectedKind)
      .toBeUndefined();
    await page.reload();
    expect((await saved(page)).autoDetectedKind).toBeUndefined();
    await meaningWord(page, "klama");
    await expect(page.getByRole("radio", { name: /^lujvo/ })).toBeChecked();
    await expect(page.getByText(reviewText, { exact: true })).toBeVisible();
  });

test("the evidence link confirms a gismu before evidence is saved", async ({
  page,
}) => {
  await seed(page, { word: "bangu" });
  await page.goto("/new/type");
  await page
    .getByRole("link", { name: "Add source-language evidence", exact: true })
    .click();
  await expect
    .poll(async () => (await saved(page)).autoDetectedKind)
    .toBeUndefined();
  await page.getByRole("button", { name: "Use bangu", exact: true }).click();
  await expect(page).toHaveURL(/\/new\/places$/);
  expect((await saved(page)).formation).not.toBeNull();
  await meaningWord(page, "leksiko");
  await expect(page.getByRole("radio", { name: /^gismu/ })).toBeChecked();
  await expect(page.getByText(reviewText, { exact: true })).toBeVisible();
  expect((await saved(page)).formation).not.toBeNull();
});

test("the Form step confirms a typed lujvo before compound evidence is saved", async ({
  page,
}) => {
  await seed(page, { word: "ckusni" });
  await page.goto("/new/type");
  await page
    .getByRole("list", { name: "Steps" })
    .getByRole("link", { name: /^Form\b/ })
    .click();
  for (const [index, word] of ["cukta", "sinxa"].entries()) {
    const input = page.getByLabel(`Other source word for part ${index + 1}`, {
      exact: true,
    });
    await input.fill(word);
    await input.press("Tab");
  }
  await page.getByRole("button", { name: "Use ckusni", exact: true }).click();
  await expect(page).toHaveURL(/\/new\/places$/);
  const value = await saved(page);
  expect(value.autoDetectedKind).toBeUndefined();
  expect(value.lujvo.typedOrigin).toBe(true);
  expect(value.compound).not.toBeNull();
  await meaningWord(page, "klama");
  await expect(page.getByRole("radio", { name: /^lujvo/ })).toBeChecked();
  await expect(page.getByText(reviewText, { exact: true })).toBeVisible();
  expect((await saved(page)).compound).not.toBeNull();
});

for (const accept of [false, true])
  test(`legacy automatic type change ${accept ? "accepts" : "cancels"} evidence removal explicitly`, async ({
    page,
  }) => {
    await seed(page, {
      kind: "gismu",
      word: "leksiko",
      auto: "gismu",
      evidence: true,
      detectionFor: "bangu",
    });
    const dialogs: string[] = [];
    page.on("dialog", async (dialog) => {
      dialogs.push(dialog.message());
      await (accept ? dialog.accept() : dialog.dismiss());
    });
    await page.goto("/new/type");
    await expect.poll(() => dialogs.length).toBe(1);
    expect(dialogs[0]).toContain("gismu generation evidence");
    await expect
      .poll(async () => {
        const value = await saved(page);
        return {
          kind: value.kind,
          auto: value.autoDetectedKind,
          formation: !!value.formation,
          review: value.review.includes("word type"),
        };
      })
      .toEqual({
        kind: accept ? "fuivla" : "gismu",
        auto: accept ? "fuivla" : "gismu",
        formation: !accept,
        review: !accept,
      });
    await page.reload();
    expect(dialogs).toHaveLength(1);
    await expect(
      page.getByRole("radio", { name: accept ? /^fu'ivla/ : /^gismu/ }),
    ).toBeChecked();
    if (!accept)
      await expect(page.getByText(reviewText, { exact: true })).toBeVisible();
  });

test("a cancelled Other kind restores its displayed value and retained evidence", async ({
  page,
}) => {
  await seed(page, {
    kind: "other",
    word: "zzzz",
    auto: "other",
    evidence: true,
    detectionFor: "zzzz",
  });
  await page.goto("/new/type");
  const select = page.getByLabel(
    "Which other kind? Every lexical kind that the format permits is listed.",
  );
  page.once("dialog", (dialog) => void dialog.dismiss());
  await select.selectOption("letteral");
  await expect(select).toHaveValue("other");
  expect((await saved(page)).kind).toBe("other");
  expect((await saved(page)).formation).not.toBeNull();
  await page.reload();
  await expect(select).toHaveValue("other");
  page.once("dialog", (dialog) => void dialog.accept());
  await select.selectOption("letteral");
  await expect
    .poll(async () => ({
      kind: (await saved(page)).kind,
      evidence: !!(await saved(page)).formation,
    }))
    .toEqual({ kind: "letteral", evidence: false });
  await page.reload();
  await expect(select).toHaveValue("letteral");
});

for (const path of [
  "Form",
  "Meaning",
  "retype",
  "remove evidence",
  "remove and retype",
])
  test(`ordinary locked rafsi stay editable through ${path}`, async ({
    page,
  }) => {
    await seed(page, { word: "klama" });
    await page.goto("/new/type");
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
    await page
      .getByRole("group", { name: "Rafsi for bangu", exact: true })
      .getByRole("radio", { name: /^bang stem/ })
      .check();
    await page
      .getByRole("group", { name: "Rafsi for sinxa", exact: true })
      .getByRole("radio", { name: /^sinxa last/ })
      .check();
    const use = page.locator("button.btn-primary");
    await expect(use).toBeEnabled();
    const word = (await use.innerText()).replace(/^Use /, "");
    page.once("dialog", (dialog) => void dialog.accept());
    await use.click();
    await expect(page).toHaveURL(/\/new\/places$/);
    expect((await saved(page)).lujvo.typedOrigin).toBeUndefined();
    expect((await saved(page)).lujvo.ordinarySpelling).toBe(word);
    if (path.startsWith("remove")) {
      await page.goto("/new/form?manual=1");
      page.once("dialog", (dialog) => void dialog.accept());
      await page
        .getByRole("button", { name: "Remove formation evidence", exact: true })
        .click();
      await expect.poll(async () => (await saved(page)).compound).toBeNull();
    }
    if (path !== "Form") {
      await page
        .getByRole("list", { name: "Steps" })
        .getByRole("link", { name: /^Meaning\b/ })
        .click();
      if (path.includes("retype")) {
        await page.getByLabel("Lojban word", { exact: true }).fill("");
        await page.getByLabel("Lojban word", { exact: true }).fill(word);
      }
      await page.getByRole("button", { name: "New word", exact: true }).click();
      await page
        .getByRole("button", { name: "Link the lujvo parts", exact: true })
        .click();
    } else
      await page
        .getByRole("list", { name: "Steps" })
        .getByRole("link", { name: /^Form\b/ })
        .click();
    await expect(page.getByLabel("Add a part", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Remove bangu", exact: true }),
    ).toBeVisible();
    await expect
      .poll(async () => (await saved(page)).lujvo.typedOrigin)
      .toBeUndefined();
    await page.getByLabel("Add a part", { exact: true }).fill("klama");
    await page
      .getByRole("button", { name: "Add klama as entered", exact: true })
      .click();
    await page
      .getByRole("group", { name: "Rafsi for sinxa", exact: true })
      .getByRole("radio", { name: /^sinx stem/ })
      .check();
    if (await use.isDisabled())
      await page
        .getByRole("region", { name: "Other forms", exact: true })
        .getByRole("button")
        .first()
        .click();
    await expect(use).toBeEnabled();
  });

for (const legacyTyped of [false, true])
  test(`legacy unmarked rows without metadata stay ordinary after same-word retyping (${legacyTyped ? "typed field" : "ordinary rows"})`, async ({
    page,
  }) => {
    await seed(page, {
      kind: "lujvo",
      word: "bangysinxa",
      detectionFor: "bangysinxa",
    });
    await page.evaluate(async (legacyTyped) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const { newLujvoState } = await import(String("/src/model/builders.ts"));
      const store = new LocalStore();
      const value: any = await store.get("drafts", "current");
      value.lujvo = {
        ...newLujvoState(),
        ...(legacyTyped ? { typed: value.spelling } : {}),
        joins: ["y"],
        components: [
          {
            id: "a",
            spelling: "bangu",
            kind: "gismu",
            locked: "bang",
            definition: null,
            claims: [],
            gloss: "",
          },
          {
            id: "b",
            spelling: "sinxa",
            kind: "gismu",
            locked: "sinxa",
            definition: null,
            claims: [],
            gloss: "",
          },
        ],
      };
      await store.put("drafts", "current", value);
    }, legacyTyped);
    await page.goto("/new/lujvo");
    await expect(page.getByLabel("Add a part", { exact: true })).toBeVisible();
    await expect
      .poll(async () => (await saved(page)).lujvo.ordinarySpelling)
      .toBe("bangysinxa");
    expect((await saved(page)).lujvo.typedOrigin).toBeUndefined();
    expect((await saved(page)).lujvo.typed).toBeUndefined();
    await meaningWord(page, "bangysinxa");
    await page
      .getByRole("button", { name: "Link the lujvo parts", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Remove bangu", exact: true }),
    ).toBeVisible();
  });

test("a genuinely different typed spelling starts a new typed analysis after an ordinary build", async ({
  page,
}) => {
  await seed(page, { word: "klama" });
  await page.goto("/new/type");
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
  page.once("dialog", (dialog) => void dialog.accept());
  await page.locator("button.btn-primary").click();
  await expect(page).toHaveURL(/\/new\/places$/);
  await meaningWord(page, "sairzba");
  await page
    .getByRole("button", { name: "Link the lujvo parts", exact: true })
    .click();
  await expect(page.getByLabel("Add a part", { exact: true })).toBeHidden();
  await expect(
    page
      .getByRole("region", { name: "Result", exact: true })
      .getByLabel("Form sairzba", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => (await saved(page)).lujvo.typedOrigin)
    .toBe(true);
  expect((await saved(page)).lujvo.ordinarySpelling).toBeUndefined();
});

for (const [spelling, sources, locks, join, legacyState] of [
  ["sairzba", ["sanmi", "zbasu"], ["sai", "zba"], "r", false],
  ["sairzba", ["sanmi", "zbasu"], ["sai", "zba"], "r", true],
  ["bangu'y'ismu", ["bangu", "ismu"], ["bangu", "ismu"], "'y'", true],
] as const)
  test(`restored optional joins survive evidence removal and release when ordinary rows change: ${spelling}, ${legacyState ? "legacy typed rows" : "no saved rows"}`, async ({
    page,
  }) => {
    await seed(page, { kind: "lujvo", word: spelling, detectionFor: spelling });
    await page.evaluate(
      async ({ spelling, sources, locks, join, legacyState, corePath }) => {
        const { LocalStore } = await import(String("/src/data/store.ts"));
        const { newLujvoState } = await import(
          String("/src/model/builders.ts")
        );
        const { detectWord } = await import(
          String("/src/model/typed-headword.ts")
        );
        const { rafsiPairId, wordId } = await import(corePath);
        const store = new LocalStore();
        const value: any = await store.get("drafts", "current");
        const base =
          "https://github.com/int19h/jbovlacku/blob/main/docs/morphology.md#";
        value.compound = {
          components: sources.map((source, index) => ({
            word: { language: "jbo", spelling: source },
            rafsi: locks[index],
            definition: null,
          })),
          morphology: { id: base + "extended-lujvo", version: "3" },
          scoring: { id: base + "extended-lujvo-scoring", version: "1" },
          score: null,
          notes: [],
        };
        value.evidenceForm = spelling;
        if (legacyState)
          value.lujvo = {
            ...newLujvoState(),
            typed: spelling,
            selected: spelling,
            joins: [join],
            components: sources.map((source, index) => ({
              id: `legacy-${index}`,
              spelling: source,
              kind: detectWord(source).kind,
              definition: null,
              claims: [
                {
                  rafsi: locks[index],
                  pair: rafsiPairId(
                    wordId({ language: "jbo", spelling: source }),
                    locks[index],
                  ),
                },
              ],
              locked: locks[index],
              gloss: "",
            })),
          };
        await store.put("drafts", "current", value);
      },
      { spelling, sources, locks, join, legacyState, corePath },
    );
    await page.goto("/new/lujvo");
    await expect(
      page
        .getByRole("region", { name: "Result", exact: true })
        .getByLabel(`Form ${spelling}`, { exact: true }),
    ).toBeVisible();
    await expect
      .poll(async () => {
        const state = (await saved(page)).lujvo;
        return {
          joins: state?.joins,
          typed: state?.typed,
          origin: state?.typedOrigin,
          ordinary: state?.ordinarySpelling,
        };
      })
      .toEqual({
        joins: [join],
        typed: undefined,
        origin: undefined,
        ordinary: spelling,
      });
    await expect(page.getByLabel("Add a part", { exact: true })).toBeVisible();
    await page.reload();
    await expect(
      page
        .getByRole("region", { name: "Result", exact: true })
        .getByLabel(`Form ${spelling}`, { exact: true }),
    ).toBeVisible();
    expect((await saved(page)).lujvo.joins).toEqual([join]);
    expect((await saved(page)).lujvo.typedOrigin).toBeUndefined();
    await page
      .getByRole("link", { name: "Type the spelling yourself", exact: true })
      .click();
    page.once("dialog", (dialog) => void dialog.accept());
    await page
      .getByRole("button", { name: "Remove formation evidence", exact: true })
      .click();
    await expect.poll(async () => (await saved(page)).compound).toBeNull();
    expect((await saved(page)).lujvo.joins).toEqual([join]);
    await page
      .getByRole("list", { name: "Steps" })
      .getByRole("link", { name: /^Form\b/ })
      .click();
    await expect(page.getByLabel("Add a part", { exact: true })).toBeVisible();
    await page.getByLabel("Add a part", { exact: true }).fill("klama");
    await page
      .getByRole("button", { name: "Add klama as entered", exact: true })
      .click();
    await expect
      .poll(async () => (await saved(page)).lujvo?.joins)
      .toBeUndefined();
    expect((await saved(page)).lujvo.restoredJoinParts).toBeUndefined();
    if (sources[0] === "bangu")
      await page
        .getByRole("group", { name: "Rafsi for bangu", exact: true })
        .getByRole("radio", { name: /^bang stem/ })
        .check();
    await expect(page.locator("button.btn-primary")).toBeEnabled();
  });
