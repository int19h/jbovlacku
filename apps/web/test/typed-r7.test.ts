import { test, expect, type Page } from "@playwright/test";
import type { MorphologyProfile } from "../../../packages/core/src/index.ts";
import { corePath } from "./helpers.ts";

async function saved(page: Page): Promise<any> {
  return page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return new LocalStore().get("drafts", "current");
  });
}
async function seed(
  page: Page,
  spelling: string,
  profile: MorphologyProfile,
  mode: "typed" | "legacy" | "revision",
) {
  await page.goto("/new/meaning");
  await expect(
    page.getByRole("heading", {
      name: "What does the word mean?",
      exact: true,
    }),
  ).toBeVisible();
  await page.evaluate(
    async ({ spelling, profile, mode, corePath }) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const { newDraft, draftFromBody, draftToBody } = await import(
        String("/src/model/draft.ts")
      );
      const {
        typedLujvoState,
        detectWord,
        buildLujvoState,
        selectLujvoCandidate,
      } = await import(String("/src/model/typed-headword.ts"));
      const { analyzeWord, rafsiPairId, wordId } = await import(corePath);
      const reading =
        profile === "extended"
          ? detectWord(spelling).readings[0]
          : analyzeWord(profile, spelling).readings[0];
      const state = typedLujvoState(spelling, reading, null, profile);
      const sources: Record<string, string> = {
        sai: "sanmi",
        zba: "zbasu",
        bau: "bangu",
        cla: "clani",
        ckusni: "ckusni",
        broda: "broda",
        bangu: "bangu",
        ismu: "ismu",
      };
      for (const row of state.components) {
        row.spelling = sources[row.locked!];
        row.kind = detectWord(row.spelling).kind;
        row.claims = [
          {
            rafsi: row.locked!,
            pair: rafsiPairId(
              wordId({ language: "jbo", spelling: row.spelling }),
              row.locked!,
            ),
          },
        ];
        delete row.unresolvedSource;
      }
      let draft = newDraft({
        spelling,
        typedSpelling: spelling,
        kind: "lujvo",
        text: "A synthetic definition.",
        glosses: [{ language: "en", text: "synthetic", sense: "" }],
        frameMode: "none",
        lujvo: state,
      });
      if (mode === "legacy") {
        delete state.typedOrigin;
        draft.typedSpelling = null;
      } else {
        const result = buildLujvoState(state);
        selectLujvoCandidate(draft, result, result.candidates[0], true);
        if (mode === "revision") {
          const { body, problems } = draftToBody(draft);
          if (!body) throw new Error(JSON.stringify(problems));
          draft = draftFromBody(body, "jve1:" + "b".repeat(64), "native");
        }
      }
      await new LocalStore().put("drafts", "current", draft);
    },
    { spelling, profile, mode, corePath },
  );
  await page.goto("/new/lujvo");
  await expect(
    page.getByLabel(`Form ${spelling}`, { exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => (await saved(page)).lujvo?.components.length)
    .toBe(2);
  if (mode !== "typed")
    await expect
      .poll(async () => (await saved(page)).lujvo?.restoredSpelling)
      .toBe(spelling);
}

for (const [spelling, profile] of [
  ["sairzba", "extended"],
  ["bangu'y'ismu", "extended"],
  ["CKUSNI'yBRODA", "extended-v2"],
] as const)
  for (const metadata of [true, false])
    test(`R7 fresh analysis recovers ${profile} after a CLL choice, ${spelling}, metadata ${metadata}`, async ({
      page,
    }) => {
      await seed(page, spelling, profile, "typed");
      const original = await saved(page);
      await page
        .getByRole("link", { name: "Type the spelling yourself", exact: true })
        .click();
      await page.getByLabel("Spelling", { exact: true }).fill(spelling + "x");
      await page
        .getByRole("list", { name: "Steps" })
        .getByRole("link", { name: /^Form\b/ })
        .click();
      await expect(
        page.getByLabel("Add a part", { exact: true }),
      ).toBeVisible();
      if (!metadata) {
        await page.evaluate(async () => {
          const { LocalStore } = await import(String("/src/data/store.ts"));
          const { clearWordEvidence } = await import(
            String("/src/model/typed-headword.ts")
          );
          const store = new LocalStore();
          const draft: any = await store.get("drafts", "current");
          clearWordEvidence(draft);
          await store.put("drafts", "current", draft);
        });
        await page.reload();
      }
      await page.getByRole("radio", { name: "CLL rules", exact: true }).check();
      await page
        .getByRole("link", { name: "Type the spelling yourself", exact: true })
        .click();
      await page.getByLabel("Spelling", { exact: true }).fill(spelling);
      await page
        .getByRole("list", { name: "Steps" })
        .getByRole("link", { name: /^Form\b/ })
        .click();
      await expect(
        page.getByLabel(`Form ${spelling}`, { exact: true }),
      ).toBeVisible();
      await expect(page.locator("button.btn-primary")).toBeEnabled();
      await expect
        .poll(async () => (await saved(page)).lujvo.profile)
        .toBe(profile);
      const after = await saved(page);
      expect(after.lujvo.typedOrigin).toBe(true);
      expect(after.lujvo.profileChosen).toBeUndefined();
      expect(after.lujvo.components).toEqual(original.lujvo.components);
      expect(after.compound).toEqual(metadata ? original.compound : null);
      expect(after.review).toContain("spelling");
      await page.reload();
      await expect(
        page.getByLabel(`Form ${spelling}`, { exact: true }),
      ).toBeVisible();
    });

for (const [spelling, profile, automatic] of [
  ["BAU,CLA", "cll", "baucla"],
  ["CKUSNI'yBRODA", "extended-v2", "ckusni'ybroda"],
  ["SAI,rZBA", "extended", "saizba"],
] as const)
  for (const mode of ["legacy", "revision"] as const)
    test(`R7 rafsi release persists after relock, reopen and reload: ${profile}, ${mode}`, async ({
      page,
    }) => {
      await seed(page, spelling, profile, mode);
      const before = await saved(page);
      const row = before.lujvo.components[0];
      const radios = page.getByRole("group", {
        name: `Rafsi for ${row.spelling}`,
        exact: true,
      });
      await radios
        .getByRole("radio", { name: "automatic", exact: true })
        .check();
      await radios.locator(`input[value="${row.locked}"]`).check();
      await expect(
        page.getByLabel(`Form ${automatic}`, { exact: true }),
      ).toBeVisible();
      await expect
        .poll(async () => (await saved(page)).lujvo.restoredReleased)
        .toBe(true);
      for (let visit = 0; visit < 2; visit++) {
        await page
          .getByRole("link", {
            name: "Type the spelling yourself",
            exact: true,
          })
          .click();
        await page
          .getByRole("list", { name: "Steps" })
          .getByRole("link", { name: /^Form\b/ })
          .click();
        await expect(
          page.getByLabel(`Form ${automatic}`, { exact: true }),
        ).toBeVisible();
        await page.reload();
        await expect(
          page.getByLabel(`Form ${automatic}`, { exact: true }),
        ).toBeVisible();
      }
      expect((await saved(page)).lujvo.restoredSpelling).toBeUndefined();
      expect((await saved(page)).compound).toEqual(before.compound);
    });

test("R7 an unsupported saved historical reading keeps profile controls available", async ({
  page,
}) => {
  await seed(page, "sairzba", "extended", "typed");
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const draft: any = await store.get("drafts", "current");
    draft.compound.morphology = {
      id: "https://github.com/int19h/jbovlacku/blob/main/docs/morphology.md#cll-lujvo",
      version: "2",
    };
    await store.put("drafts", "current", draft);
  });
  await page.reload();
  await expect(
    page.getByRole("radio", { name: "CLL rules", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("radio", {
      name: "Extended: whole-word parts",
      exact: true,
    }),
  ).toBeEnabled();
  await expect(page.getByLabel("Form saizba", { exact: true })).toBeVisible();
  await expect
    .poll(async () => (await saved(page)).lujvo.typedOrigin)
    .toBeUndefined();
  await page
    .getByRole("radio", { name: "Extended: whole-word parts", exact: true })
    .check();
  await expect(page.locator("button.btn-primary")).toBeEnabled();
  for (let visit = 0; visit < 2; visit++) {
    await page
      .getByRole("list", { name: "Steps" })
      .getByRole("link", { name: /^Places\b/ })
      .click();
    await page
      .getByRole("list", { name: "Steps" })
      .getByRole("link", { name: /^Form\b/ })
      .click();
    await page.reload();
    await expect(
      page.getByRole("radio", {
        name: "Extended: whole-word parts",
        exact: true,
      }),
    ).toBeChecked();
    await expect
      .poll(async () => (await saved(page)).lujvo.profileChosen)
      .toBe(true);
  }
});

async function enterSpelling(page: Page, spelling: string) {
  await page
    .getByRole("link", { name: "Type the spelling yourself", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Enter the lujvo", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Spelling", { exact: true }).fill(spelling);
  await page
    .getByRole("list", { name: "Steps" })
    .getByRole("link", { name: /^Form\b/ })
    .click();
}

for (const mode of ["legacy", "revision"] as const)
  test(`R8 profile evidence survives other typed words after ${mode} evidence removal`, async ({
    page,
  }) => {
    await seed(page, "BAU,CLA", "cll", mode);
    // The historical constructor needs linked sources, as in the unit inventory.
    await page.evaluate(async () => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      await new LocalStore().put("packages", "en", {
        snapshot: "sha256:" + "a".repeat(64),
        version: 2,
        entries: [
          ["bangu", "bau"],
          ["clani", "cla"],
        ].map(([spelling, rafsi], index) => ({
          event: "jve1:" + String(index).repeat(64),
          word: { language: "jbo", spelling },
          language: "en",
          glosses: [],
          plain_text: "A synthetic source.",
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
    if (mode === "revision") {
      await page
        .getByRole("link", { name: "Type the spelling yourself", exact: true })
        .click();
      page.once("dialog", (dialog) => void dialog.accept());
      await page
        .getByRole("button", { name: "Remove formation evidence", exact: true })
        .click();
      await page
        .getByRole("list", { name: "Steps" })
        .getByRole("link", { name: /^Form\b/ })
        .click();
    }
    for (const spelling of ["ckusnu", "ckusni", "BAU,CLA"]) {
      await enterSpelling(page, spelling);
      await expect(
        page.getByLabel(`Form ${spelling}`, { exact: true }),
      ).toBeVisible();
      await expect
        .poll(async () => (await saved(page)).lujvo.typed)
        .toBe(spelling);
      await page.reload();
      await expect(
        page.getByLabel(`Form ${spelling}`, { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("Saved in this browser", { exact: true }),
      ).toBeVisible();
    }
    expect((await saved(page)).lujvo.profile).toBe("cll");
    expect((await saved(page)).lujvo.typedOrigin).toBe(true);
    expect((await saved(page)).lujvo.restoredEvidenceHistory).toContainEqual({
      spelling: "BAU,CLA",
      profile: "cll",
    });
  });

for (const spelling of ["bangu'y'ismu", "sairzba"])
  for (const typo of [false, true])
    test(`R8 empty published rows restore exact signed joins: ${spelling}, typo ${typo}`, async ({
      page,
    }) => {
      await seed(page, spelling, "extended", "revision");
      const original = await saved(page);
      const remove = page.getByRole("button", { name: /^Remove / });
      while (await remove.count()) await remove.first().click();
      await expect
        .poll(async () => (await saved(page)).lujvo.components.length)
        .toBe(0);
      if (typo) {
        await enterSpelling(page, spelling + "x");
        await expect
          .poll(async () => (await saved(page)).lujvo.components.length)
          .toBe(0);
        await enterSpelling(page, spelling);
      } else {
        await page
          .getByRole("list", { name: "Steps" })
          .getByRole("link", { name: /^Places\b/ })
          .click();
        await page
          .getByRole("list", { name: "Steps" })
          .getByRole("link", { name: /^Form\b/ })
          .click();
      }
      await expect(
        page.getByLabel(`Form ${spelling}`, { exact: true }),
      ).toBeVisible();
      await expect
        .poll(async () => (await saved(page)).lujvo.restoredReleased)
        .toBeUndefined();
      await page.reload();
      await expect(
        page.getByLabel(`Form ${spelling}`, { exact: true }),
      ).toBeVisible();
      await expect(page.locator("button.btn-primary")).toBeEnabled();
      await expect
        .poll(async () => (await saved(page)).lujvo.restoredReleased)
        .toBeUndefined();
      const restored = await saved(page);
      expect(restored.lujvo.restoredReleased).toBeUndefined();
      expect(
        restored.lujvo.components.map((row: any) => [row.spelling, row.locked]),
      ).toEqual(
        original.lujvo.components.map((row: any) => [row.spelling, row.locked]),
      );
      expect(restored.lujvo.joins).toEqual(original.lujvo.joins);
      expect(restored.compound).toEqual(original.compound);
    });
