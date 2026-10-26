import { test, expect, type Page } from "@playwright/test";
import { expectKindSpelling } from "./helpers.ts";

test.use({ actionTimeout: 10000 });

async function seed(
  page: Page,
  kind: "fuhivla" | "lujvo" = "fuhivla",
  evidence = false,
) {
  await page.goto("/new/meaning");
  await page.evaluate(
    async ({ kind, evidence }) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const { newDraft } = await import(String("/src/model/draft.ts"));
      const store = new LocalStore();
      await store.put(
        "drafts",
        "current",
        newDraft({
          kind,
          spelling: kind === "lujvo" ? "ckusro" : "leksiko",
          meaning: "A synthetic borrowing.",
          text: "A synthetic borrowing.",
          structured: false,
          step: 4,
          compound: evidence
            ? {
                components: [],
                morphology: {
                  id: "https://github.com/int19h/jbovlacku/blob/main/docs/morphology.md#cll-lujvo",
                  version: "2",
                },
                scoring: {
                  id: "https://github.com/int19h/jbovlacku/blob/main/docs/morphology.md#cll-lujvo-scoring",
                  version: "1",
                },
                score: null,
                notes: [],
              }
            : null,
        }),
      );
      await store.put("packages", "en", {
        snapshot: "sha256:" + "a".repeat(64),
        entries: [
          {
            event: "jve1:" + "a".repeat(64),
            word: { language: "jbo", spelling: "odbenu" },
            language: "en",
            glosses: [{ language: "en", text: "borrowing", sense: null }],
            plain_text: "A synthetic borrowing.",
            classification: { kind: "fuhivla", selmaho: [] },
            body: null,
          },
        ],
      });
    },
    { kind, evidence },
  );
}

test("fu'ivla labels stay human-readable across the draft pages and editor updates", async ({
  page,
}) => {
  await seed(page);
  for (const [path, label] of [
    ["/new/meaning", "Detected form: fu'ivla."],
    ["/new/type", "Detected form: fu'ivla."],
    ["/new/form?manual=1", "Detected form: fu'ivla."],
    ["/new/places", "fu'ivla · en"],
    ["/new/editor", "fu'ivla · en"],
  ]) {
    await page.goto(path);
    await expect(page.locator("main")).toContainText(label);
    await expectKindSpelling(page);
  }
  await page.getByLabel("Type", { exact: true }).selectOption("gismu");
  await expect(page.locator("main")).toContainText("gismu · en");
  await page.getByLabel("Type", { exact: true }).selectOption("fuhivla");
  await expect(page.locator("main")).toContainText("fu'ivla · en");
  await expectKindSpelling(page);
  await page.getByLabel("Definition language", { exact: true }).fill("fr");
  await expect(page.locator("main")).toContainText("fu'ivla · fr");
  await expectKindSpelling(page);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { LocalStore } = await import(String("/src/data/store.ts"));
        return (await new LocalStore().get("drafts", "current"))?.language;
      }),
    )
    .toBe("fr");
});

test("saved fu'ivla entries use the human label in nearby search, search, and the part picker", async ({
  page,
}) => {
  await seed(page, "lujvo");
  await page.goto("/new/meaning");
  const nearby = page.getByRole("region", { name: "Close in meaning" });
  await expect(nearby).toContainText("odbenu");
  await expect(nearby).toContainText("fu'ivla");
  await expectKindSpelling(page);
  await page.getByLabel("Search words and meanings").fill("odbenu");
  await page.getByLabel("Search words and meanings").press("Enter");
  await expect(
    page.getByRole("region", { name: "Search results" }),
  ).toContainText("fu'ivla");
  await expectKindSpelling(page);
  await page.goto("/new/lujvo");
  await page.getByLabel("Add a part").fill("odbenu");
  const matches = page.getByRole("list", { name: "Matching words" });
  await expect(matches).toContainText("fu'ivla");
  await expect(matches).not.toContainText("not in the local package");
  await expectKindSpelling(page);
  await matches
    .getByRole("button", { name: "Add odbenu", exact: true })
    .click();
  await expect(
    page.getByRole("list", { name: "Components", exact: true }),
  ).toContainText("fu'ivla");
  await expectKindSpelling(page);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { LocalStore } = await import(String("/src/data/store.ts"));
        const draft = await new LocalStore().get("drafts", "current");
        return draft?.lujvo?.components[0]?.kind;
      }),
    )
    .toBe("fuhivla");
});

test("the type-change dialog uses fu'ivla and keeps the signed kind", async ({
  page,
}) => {
  await seed(page, "lujvo", true);
  await page.goto("/new/editor");
  await expect(page.getByLabel("Type", { exact: true })).toHaveValue("lujvo");
  const dialogPromise = page.waitForEvent("dialog");
  const change = page
    .getByLabel("Type", { exact: true })
    .selectOption("fuhivla");
  const dialog = await dialogPromise;
  expect(dialog.message()).toContain(
    "Changing the type to fu'ivla no longer uses: compound evidence.",
  );
  expect(dialog.message()).not.toMatch(/\b(?:fuhivla|fuivla)\b/);
  await dialog.accept();
  await change;
  await expect(page.locator("main")).toContainText("fu'ivla · en");
  await expectKindSpelling(page);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { LocalStore } = await import(String("/src/data/store.ts"));
        const draft = await new LocalStore().get("drafts", "current");
        return { kind: draft?.kind, compound: draft?.compound };
      }),
    )
    .toEqual({ kind: "fuhivla", compound: null });
});

test("the older draft preview uses the shared kind label without rewriting storage", async ({
  page,
}) => {
  await page.goto("/new/meaning");
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    await new LocalStore().put("drafts", "current", {
      word: "leksiko",
      kind: "fuhivla",
      language: "en",
      text: "A synthetic borrowing.",
    });
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "An older draft is saved" }),
  ).toBeVisible();
  await expectKindSpelling(page);
  expect(
    await page.evaluate(async () => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      return (await new LocalStore().get("drafts", "current"))?.kind;
    }),
  ).toBe("fuhivla");
});
