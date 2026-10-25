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

for (const [original, replacement, back] of [
  ["ckusnu", "ckusni", false],
  ["ckusni", "sairzba", false],
  ["ckusnu", "ckusni", true],
] as const)
  for (const metadata of [false, true])
    test(`one-fill typed edit ${original} to ${replacement}${back ? " and back before reopening" : ""} starts fresh analysis, metadata ${metadata}`, async ({
      page,
    }) => {
      await seed(page, {
        kind: "lujvo",
        word: original,
        detectionFor: original,
      });
      await page.goto("/new/lujvo");
      await expect
        .poll(async () => (await saved(page)).lujvo?.typedOrigin)
        .toBe(true);
      if (metadata) {
        for (const [index, source] of [
          "cukta",
          original === "ckusnu" ? "casnu" : "sinxa",
        ].entries()) {
          const input = page.getByLabel(
            `Other source word for part ${index + 1}`,
            { exact: true },
          );
          await input.fill(source);
          await input.press("Tab");
        }
        await page
          .getByRole("button", { name: `Use ${original}`, exact: true })
          .click();
        await expect(page).toHaveURL(/\/new\/places$/);
      }
      const compound = (await saved(page)).compound;
      const linkedRows = (await saved(page)).lujvo.components;
      await page
        .getByRole("list", { name: "Steps" })
        .getByRole("link", { name: /^Meaning\b/ })
        .click();
      await page.getByLabel("Lojban word", { exact: true }).fill(replacement);
      if (back)
        await page.getByLabel("Lojban word", { exact: true }).fill(original);
      const spelling = back ? original : replacement;
      await expect
        .poll(async () => (await saved(page)).lujvo?.ordinarySpelling)
        .toBe("");
      await page.getByRole("button", { name: "New word", exact: true }).click();
      await page
        .getByRole("button", { name: "Link the lujvo parts", exact: true })
        .click();
      await expect(page.getByLabel("Add a part", { exact: true })).toBeHidden();
      await expect(
        page.getByRole("radio", {
          name: "CLL rules",
          exact: true,
          includeHidden: true,
        }),
      ).toBeDisabled();
      await expect(
        page
          .getByRole("region", { name: "Result", exact: true })
          .getByLabel(`Form ${spelling}`, { exact: true }),
      ).toBeVisible();
      await expect
        .poll(async () => {
          const state = (await saved(page)).lujvo;
          return {
            typed: state?.typed,
            origin: state?.typedOrigin,
            ordinary: state?.ordinarySpelling,
          };
        })
        .toEqual({ typed: spelling, origin: true, ordinary: undefined });
      expect((await saved(page)).compound).toEqual(compound);
      if (metadata && back) {
        await expect(
          page.getByLabel("Other source word for part 1", { exact: true }),
        ).toHaveValue("cukta");
        await expect(
          page.getByLabel("Other source word for part 2", { exact: true }),
        ).toHaveValue("casnu");
        await expect(
          page.getByRole("button", { name: `Use ${original}`, exact: true }),
        ).toBeEnabled();
        expect((await saved(page)).lujvo.components).toEqual(linkedRows);
      }
      await page.reload();
      await expect(page.getByLabel("Add a part", { exact: true })).toBeHidden();
      await expect(
        page
          .getByRole("region", { name: "Result", exact: true })
          .getByLabel(`Form ${spelling}`, { exact: true }),
      ).toBeVisible();
      if (metadata && back) {
        await expect(
          page.getByLabel("Other source word for part 1", { exact: true }),
        ).toHaveValue("cukta");
        await expect(
          page.getByLabel("Other source word for part 2", { exact: true }),
        ).toHaveValue("casnu");
        await expect(
          page.getByRole("button", { name: `Use ${original}`, exact: true }),
        ).toBeEnabled();
        expect((await saved(page)).lujvo.components).toEqual(linkedRows);
      }
    });

for (const mismatch of ["typed identity", "rafsi", "join"])
  test(`legacy joins clear when saved ${mismatch} is incompatible`, async ({
    page,
  }) => {
    await seed(page, {
      kind: "lujvo",
      word: "sairzba",
      detectionFor: "sairzba",
    });
    await page.evaluate(
      async ({ mismatch, corePath }) => {
        const { LocalStore } = await import(String("/src/data/store.ts"));
        const { newLujvoState } = await import(
          String("/src/model/builders.ts")
        );
        const { rafsiPairId, wordId } = await import(corePath);
        const store = new LocalStore();
        const value: any = await store.get("drafts", "current");
        value.lujvo = {
          ...newLujvoState(),
          typed: mismatch === "typed identity" ? "saizba" : "sairzba",
          joins: [mismatch === "join" ? "'y'" : "r"],
          components: [
            ["sanmi", mismatch === "rafsi" ? "sanm" : "sai"],
            ["zbasu", "zba"],
          ].map(([spelling, rafsi], index) => ({
            id: `legacy-${index}`,
            spelling,
            kind: "gismu",
            definition: null,
            locked: rafsi,
            gloss: "",
            claims: [
              {
                rafsi,
                pair: rafsiPairId(wordId({ language: "jbo", spelling }), rafsi),
              },
            ],
          })),
        };
        // Keep the author in ordinary mode so the test observes the stale state cleanup.
        value.typedSpelling = null;
        await store.put("drafts", "current", value);
      },
      { mismatch, corePath },
    );
    await page.goto("/new/lujvo");
    await expect(page.getByLabel("Add a part", { exact: true })).toBeVisible();
    await expect
      .poll(async () => {
        const state = (await saved(page)).lujvo;
        return {
          typed: state?.typed,
          joins: state?.joins,
          parts: state?.restoredJoinParts,
          origin: state?.typedOrigin,
        };
      })
      .toEqual({
        typed: undefined,
        joins: undefined,
        parts: undefined,
        origin: undefined,
      });
    await page.reload();
    await expect(page.getByLabel("Add a part", { exact: true })).toBeVisible();
    expect((await saved(page)).lujvo.joins).toBeUndefined();
  });
async function meaningWord(page: Page, spelling: string) {
  await page
    .getByRole("list", { name: "Steps" })
    .getByRole("link", { name: /^Meaning\b/ })
    .click();
  await page.getByLabel("Lojban word", { exact: true }).fill(spelling);
  await page.getByRole("button", { name: "New word", exact: true }).click();
  await expect(page).toHaveURL(/\/new\/type$/);
}

async function historicalDraft(
  page: Page,
  mode: "legacy" | "revision" | "gap",
) {
  await seed(page, {
    kind: "lujvo",
    word: mode === "gap" ? "sairzba" : "BAU,CLA",
  });
  await page.evaluate(
    async ({ mode, corePath }) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const { newDraft, draftToBody, draftFromBody } = await import(
        String("/src/model/draft.ts")
      );
      const { typedLujvoState, buildLujvoState, selectLujvoCandidate } =
        await import(String("/src/model/typed-headword.ts"));
      const { analyzeWord, rafsiPairId, wordId } = await import(corePath);
      const spelling = mode === "gap" ? "sairzba" : "BAU,CLA";
      const profile = mode === "gap" ? "extended" : "cll";
      const state = typedLujvoState(
        spelling,
        analyzeWord(profile, spelling).readings[0],
        null,
        profile,
      );
      for (const [index, source] of (mode === "gap"
        ? ["sanmi", "zbasu"]
        : ["bangu", "clani"]
      ).entries()) {
        const row = state.components[index];
        row.spelling = source;
        row.kind = "gismu";
        row.claims = [
          {
            rafsi: row.locked,
            pair: rafsiPairId(
              wordId({ language: "jbo", spelling: source }),
              row.locked,
            ),
          },
        ];
        delete row.unresolvedSource;
      }
      let value = newDraft({
        spelling,
        typedSpelling: spelling,
        kind: "lujvo",
        text: "A synthetic definition.",
        frameMode: "none",
        lujvo: state,
      });
      if (mode === "revision") {
        const result = buildLujvoState(state);
        selectLujvoCandidate(value, result, result.candidates[0], true);
        const { body, problems } = draftToBody(value);
        if (!body) throw new Error(JSON.stringify(problems));
        value = draftFromBody(body, "jve1:" + "c".repeat(64), "native");
      } else if (mode === "legacy") {
        delete state.typedOrigin;
        value.typedSpelling = null;
      } else state.restoredEvidenceHistory = [{ spelling, profile: "cll" }];
      await new LocalStore().put("drafts", "current", value);
    },
    { mode, corePath },
  );
  await page.goto("/new/lujvo");
  await expect(
    page
      .getByRole("region", { name: "Result", exact: true })
      .getByLabel(`Form ${mode === "gap" ? "sairzba" : "BAU,CLA"}`, {
        exact: true,
      }),
  ).toBeVisible();
  if (mode === "revision") {
    await page
      .getByRole("link", { name: "Type the spelling yourself", exact: true })
      .click();
    page.once("dialog", (dialog) => void dialog.accept());
    await page
      .getByRole("button", { name: "Remove formation evidence", exact: true })
      .click();
    await expect.poll(async () => (await saved(page)).compound).toBeNull();
  }
  await meaningWord(page, "ckusnu");
  await page
    .getByRole("button", { name: "Link the lujvo parts", exact: true })
    .click();
  await expect
    .poll(async () =>
      (await saved(page)).lujvo?.components.map((row: any) => row.locked),
    )
    .toEqual(["cku", "snu"]);
  await meaningWord(page, mode === "gap" ? "sairzba" : "BAU,CLA");
  await page
    .getByRole("button", { name: "Link the lujvo parts", exact: true })
    .click();
  await expect
    .poll(async () =>
      (await saved(page)).lujvo?.components.map((row: any) => row.locked),
    )
    .toEqual(mode === "gap" ? ["sai", "zba"] : ["bau", "cla"]);
}

async function historicalPackage(page: Page) {
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    await new LocalStore().put("packages", "en", {
      snapshot: "sha256:" + "a".repeat(64),
      version: 2,
      entries: [
        ["bangu", "bau"],
        ["clani", "cla"],
        ["sanmi", "sai"],
        ["zbasu", "zba"],
      ].map(([spelling, rafsi], index) => ({
        event: "jve1:" + String(index).repeat(64),
        word: { language: "jbo", spelling },
        language: "en",
        glosses: [],
        plain_text: "Synthetic source.",
        classification: { kind: "gismu", selmaho: [] },
        body: null,
        issuer: "ed25519:" + "a".repeat(64),
        notes: false,
        rafsi: [rafsi],
        rafsi_complete: true,
        attribution: null,
      })),
    });
  });
}

for (const mode of ["legacy", "revision"] as const)
  for (const retry of ["reopen", "reload", "typo"] as const)
    test(`R9 missing CLL sources retry after cache download and ${retry}, ${mode}`, async ({
      page,
    }) => {
      await historicalDraft(page, mode);
      const fallback = (await saved(page)).lujvo;
      expect(fallback.ordinarySpelling).toBe("");
      expect(fallback.typedOrigin).toBeUndefined();
      expect(fallback.components.map((row: any) => row.spelling)).toEqual([
        "",
        "",
      ]);
      await expect(
        page.getByRole("radio", { name: "CLL rules", exact: true }),
      ).toBeChecked();
      await historicalPackage(page);
      if (retry === "reload") await page.reload();
      else if (retry === "reopen") await page.goto("/new/lujvo");
      else {
        await page
          .getByRole("link", {
            name: "Type the spelling yourself",
            exact: true,
          })
          .click();
        await page.getByLabel("Spelling", { exact: true }).fill("BAU,CLAx");
        await page.getByLabel("Spelling", { exact: true }).fill("BAU,CLA");
        await page
          .getByRole("list", { name: "Steps" })
          .getByRole("link", { name: /^Form\b/ })
          .click();
      }
      await expect(
        page
          .getByRole("region", { name: "Result", exact: true })
          .getByLabel("Form BAU,CLA", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Use BAU,CLA", exact: true }),
      ).toBeEnabled();
      await expect
        .poll(async () => (await saved(page)).lujvo?.typedOrigin)
        .toBe(true);
      expect(
        (await saved(page)).lujvo.components.map((row: any) => row.spelling),
      ).toEqual(["bangu", "clani"]);
      expect((await saved(page)).spelling).toBe("BAU,CLA");
    });

test("R9 an authored profile survives repeated cache absence and reload", async ({
  page,
}) => {
  await historicalDraft(page, "legacy");
  await page
    .getByRole("radio", { name: "Extended: whole-word parts", exact: true })
    .check();
  await expect
    .poll(async () => (await saved(page)).lujvo?.profileChosen)
    .toBe(true);
  for (let visit = 0; visit < 2; visit++) {
    await page.reload();
    await expect(
      page.getByRole("radio", {
        name: "Extended: whole-word parts",
        exact: true,
      }),
    ).toBeChecked();
    await expect
      .poll(async () => (await saved(page)).lujvo?.profileChosen)
      .toBe(true);
    expect((await saved(page)).lujvo.ordinarySpelling).toBe("");
    expect(
      (await saved(page)).lujvo.components.map((row: any) => row.locked),
    ).toEqual(["bau", "cla"]);
  }
});

test("R9 a genuine CLL gap keeps sai and zba rows and an authored profile", async ({
  page,
}) => {
  await seed(page, { kind: "lujvo", word: "sairzba" });
  await historicalPackage(page);
  await historicalDraft(page, "gap");
  await expect(
    page.getByRole("group", { name: "Rafsi for sanmi", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("group", { name: "Rafsi for zbasu", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Result", exact: true })
      .getByLabel("Form saizba", { exact: true }),
  ).toBeVisible();
  expect((await saved(page)).spelling).toBe("sairzba");
  expect((await saved(page)).lujvo.ordinarySpelling).toBe("sairzba");
  await page
    .getByRole("radio", { name: "Extended: whole-word parts", exact: true })
    .check();
  await expect
    .poll(async () => (await saved(page)).lujvo?.profileChosen)
    .toBe(true);
  await page.reload();
  await expect(
    page.getByRole("radio", {
      name: "Extended: whole-word parts",
      exact: true,
    }),
  ).toBeChecked();
  expect((await saved(page)).lujvo.profileChosen).toBe(true);
  expect(
    (await saved(page)).lujvo.components.map((row: any) => row.locked),
  ).toEqual(["sai", "zba"]);
});

for (const [profile, spelling, sources] of [
  ["extended-v2", "CKUSNI'yBRODA", ["ckusni", "broda"]],
  ["extended-v2", "cku,sni'ybroda", ["ckusni", "broda"]],
  ["extended-v2", "ckusni’ybroda", ["ckusni", "broda"]],
  ["cll", "BAU,CLA", ["bangu", "clani"]],
] as const)
  for (const revision of [false, true])
    test(`saved ${profile} exact presentation survives a spelling round trip: ${spelling}, ${revision ? "published revision" : "typed metadata"}`, async ({
      page,
    }) => {
      await seed(page, { kind: "lujvo", word: spelling });
      await page.evaluate(
        async ({ profile, spelling, sources, revision, corePath }) => {
          const { LocalStore } = await import(String("/src/data/store.ts"));
          const { newDraft, draftToBody, draftFromBody } = await import(
            String("/src/model/draft.ts")
          );
          const { analyzeWord, rafsiPairId, wordId } = await import(corePath);
          const { typedLujvoState, buildLujvoState, selectLujvoCandidate } =
            await import(String("/src/model/typed-headword.ts"));
          const parts = analyzeWord(profile, spelling).readings[0];
          const state = typedLujvoState(spelling, parts, null, profile);
          for (const [index, source] of sources.entries()) {
            const row = state.components[index];
            row.spelling = source;
            row.kind = analyzeWord(profile, source).kind;
            row.definition = "jve1:" + "b".repeat(64);
            row.claims = [
              {
                rafsi: row.locked,
                pair: rafsiPairId(
                  wordId({ language: "jbo", spelling: source }),
                  row.locked,
                ),
              },
            ];
            delete row.unresolvedSource;
          }
          let value = newDraft({
            kind: "lujvo",
            spelling,
            typedSpelling: spelling,
            lujvo: state,
            frameMode: "none",
            text: "A synthetic definition.",
          });
          const result = buildLujvoState(state);
          selectLujvoCandidate(value, result, result.candidates[0], true);
          if (revision) {
            const { body, problems } = draftToBody(value);
            if (!body) throw new Error(JSON.stringify(problems));
            value = draftFromBody(body, "jve1:" + "c".repeat(64), "native");
          }
          await new LocalStore().put("drafts", "current", value);
        },
        { profile, spelling, sources, revision, corePath },
      );
      await page.goto("/new/lujvo");
      const form = page
        .getByRole("region", { name: "Result", exact: true })
        .getByLabel(`Form ${spelling}`, { exact: true });
      await expect(form).toBeVisible();
      await expect
        .poll(async () => (await saved(page)).lujvo?.components.length)
        .toBe(sources.length);
      const before = await saved(page);
      if (revision)
        await expect(
          page.getByLabel("Add a part", { exact: true }),
        ).toBeVisible();
      else {
        await expect(
          page.getByLabel("Add a part", { exact: true }),
        ).toBeHidden();
        await expect(
          page.getByRole("radio", {
            name: "CLL rules",
            exact: true,
            includeHidden: true,
          }),
        ).toBeDisabled();
      }
      await page
        .getByRole("link", { name: "Type the spelling yourself", exact: true })
        .click();
      await page.getByLabel("Spelling", { exact: true }).fill(spelling + "x");
      await page.getByLabel("Spelling", { exact: true }).fill(spelling);
      await page
        .getByRole("list", { name: "Steps" })
        .getByRole("link", { name: /^Form\b/ })
        .click();
      await expect(form).toBeVisible();
      await expect(page.locator("button.btn-primary")).toBeEnabled();
      const after = await saved(page);
      expect(after.lujvo.profile).toBe(profile);
      expect(after.lujvo.components).toEqual(before.lujvo.components);
      expect(after.compound).toEqual(before.compound);
      await page.reload();
      await expect(form).toBeVisible();
      if (revision) {
        await page
          .getByRole("button", { name: `Remove ${sources[0]}`, exact: true })
          .click();
        await expect
          .poll(async () => (await saved(page)).lujvo.restoredSpelling)
          .toBeUndefined();
        expect((await saved(page)).lujvo.restoredJoinParts).toBeUndefined();
      }
    });

test("Use this word replaces a typed lujvo with fresh analysis", async ({
  page,
}) => {
  await seed(page, { kind: "lujvo", word: "ckusni", detectionFor: "ckusni" });
  await page.goto("/new/lujvo");
  await expect
    .poll(async () => (await saved(page)).lujvo?.typedOrigin)
    .toBe(true);
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    await new LocalStore().put("packages", "en", {
      snapshot: "sha256:" + "a".repeat(64),
      version: 1,
      entries: ["ckusni", "sairzba"].map((spelling, index) => ({
        event: "jve1:" + String(index).repeat(64),
        word: { language: "jbo", spelling },
        language: "en",
        glosses: [],
        plain_text: index === 0 ? "Synthetic meaning." : "Synthetic.",
        classification: { kind: "lujvo", selmaho: [] },
        body: null,
        notes: false,
      })),
    });
  });
  await page
    .getByRole("list", { name: "Steps" })
    .getByRole("link", { name: /^Meaning\b/ })
    .click();
  await page
    .getByRole("button", { name: "Use this word", exact: true })
    .click();
  await expect(page.getByLabel("Lojban word", { exact: true })).toHaveValue(
    "sairzba",
  );
  await page.getByRole("button", { name: "New word", exact: true }).click();
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
    .poll(async () => (await saved(page)).lujvo?.typed)
    .toBe("sairzba");
});
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

for (const [
  spelling,
  sources,
  locks,
  join,
  legacyState,
  metadata,
  typedMarker,
] of [
  ["sairzba", ["sanmi", "zbasu"], ["sai", "zba"], "r", false, true, true],
  [
    "bangu'y'ismu",
    ["bangu", "ismu"],
    ["bangu", "ismu"],
    "'y'",
    false,
    true,
    true,
  ],
  [".SAI,rZBA.", ["sanmi", "zbasu"], ["sai", "zba"], "r", false, true, true],
  [".SAI,rZBA.", ["sanmi", "zbasu"], ["sai", "zba"], "r", true, false, false],
  ["bau,cla", ["bangu", "clani"], ["bau", "cla"], "", false, true, true],
  ["bau,cla", ["bangu", "clani"], ["bau", "cla"], "", true, false, false],
  ["sairzba", ["sanmi", "zbasu"], ["sai", "zba"], "r", true, true, true],
  [
    "bangu'y'ismu",
    ["bangu", "ismu"],
    ["bangu", "ismu"],
    "'y'",
    true,
    true,
    true,
  ],
  ["sairzba", ["sanmi", "zbasu"], ["sai", "zba"], "r", true, false, true],
  [
    "bangu'y'ismu",
    ["bangu", "ismu"],
    ["bangu", "ismu"],
    "'y'",
    true,
    false,
    true,
  ],
  ["sairzba", ["sanmi", "zbasu"], ["sai", "zba"], "r", true, false, false],
  [
    "bangu'y'ismu",
    ["bangu", "ismu"],
    ["bangu", "ismu"],
    "'y'",
    true,
    false,
    false,
  ],
] as const)
  test(`restored optional joins survive spelling round trips and evidence removal and release when ordinary rows change: ${spelling}, ${legacyState ? "legacy typed rows" : "no saved rows"}, metadata ${metadata}, typed marker ${typedMarker}`, async ({
    page,
  }) => {
    await seed(page, { kind: "lujvo", word: spelling, detectionFor: spelling });
    await page.evaluate(
      async ({
        spelling,
        sources,
        locks,
        join,
        legacyState,
        metadata,
        typedMarker,
        corePath,
      }) => {
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
        if (!metadata) {
          value.compound = null;
          value.evidenceForm = null;
        }
        if (!typedMarker) value.typedSpelling = null;
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
        if (metadata && !legacyState) {
          const { draftToBody, draftFromBody } = await import(
            String("/src/model/draft.ts")
          );
          value.frameMode = "none";
          const { body, problems } = draftToBody(value);
          if (!body) throw new Error(JSON.stringify(problems));
          const revised = draftFromBody(
            body,
            "jve1:" + "b".repeat(64),
            "native",
          );
          await store.put("drafts", "current", revised);
        } else await store.put("drafts", "current", value);
      },
      {
        spelling,
        sources,
        locks,
        join,
        legacyState,
        metadata,
        typedMarker,
        corePath,
      },
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
    const restoredRows = (await saved(page)).lujvo.components;
    const signedCompound = (await saved(page)).compound;
    await page
      .getByRole("link", { name: "Type the spelling yourself", exact: true })
      .click();
    const wordField = page.getByLabel("Spelling", { exact: true });
    await wordField.fill(spelling + "x");
    await wordField.fill(spelling);
    await page
      .getByRole("list", { name: "Steps" })
      .getByRole("link", { name: /^Form\b/ })
      .click();
    await expect(page.getByLabel("Add a part", { exact: true })).toBeVisible();
    await expect(
      page
        .getByRole("region", { name: "Result", exact: true })
        .getByLabel(`Form ${spelling}`, { exact: true }),
    ).toBeVisible();
    await expect(page.locator("button.btn-primary")).toBeEnabled();
    expect((await saved(page)).lujvo.joins).toEqual([join]);
    expect((await saved(page)).lujvo.components).toEqual(restoredRows);
    expect((await saved(page)).compound).toEqual(signedCompound);
    await page.reload();
    await expect(
      page
        .getByRole("region", { name: "Result", exact: true })
        .getByLabel(`Form ${spelling}`, { exact: true }),
    ).toBeVisible();
    if (metadata) {
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
    } else expect((await saved(page)).compound).toBeNull();
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
