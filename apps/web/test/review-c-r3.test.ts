import { expect, test } from "@playwright/test";
import { corePath, createIdentity } from "./helpers.ts";

async function mountComparison(page: any, scenario: string) {
  await page.goto("/");
  return page.evaluate(
    async ({ path, scenario }: { path: string; scenario: string }) => {
      const core = await import(path);
      await core.initializeCore();
      const model = await import(String("/src/model/draft.ts"));
      const { comparison } = await import(String("/src/pages/definition.ts"));
      const before = model.draftToBody(
        model.newDraft({
          spelling: "broda",
          kind: "gismu",
          text: "Before",
          structured: true,
          frameMode: "fixed",
          places: [model.newPlace(1)],
          numberingApproved: true,
        }),
      ).body;
      const after = structuredClone(before);
      if (scenario === "order") {
        after.text = [["After"]];
        after.frame.places[0].description = [["Place detail"]];
        after.glosses = [{ language: "en", text: "sample", sense: null }];
        after.notes = [["Notes"]];
        after.examples = [
          { language: "jbo", text: "broda", translation: [], notes: [] },
        ];
        after.etymology.text = [["Etymology"]];
        after.sources = [
          { label: "Source", url: null, event: null, locator: null },
        ];
        after.classification.kind = "other";
        after.labels = ["experimental"];
        after.license.attribution = "Contributor";
        after.legacy = { original: "Legacy" };
      } else if (scenario === "controls") {
        const controls = "\u0001\u007f\u0085\u202e\u2066\u200e\u200f\u061c";
        after.glosses = [
          { language: "en", text: controls + "retaw", sense: null },
        ];
        after.text = [
          [
            controls,
            { code: controls },
            { word: { language: "jbo", spelling: "cukta" }, label: controls },
            { url: "https://example.org/", label: controls },
          ],
        ];
        after.sources = [
          { label: controls, url: null, event: null, locator: controls },
        ];
        after.examples = [
          { language: "jbo", text: controls, translation: [], notes: [] },
        ];
        after.labels = [controls];
      } else if (scenario === "nested") {
        before.etymology.formation = {
          method: "unknown",
          candidates: Array.from({ length: 40 }, (_, i) => ({
            form: `candidate${i}`,
            score: { numerator: "1", denominator: "1" },
            rank: i + 1,
          })),
        };
        after.etymology = structuredClone(before.etymology);
        after.etymology.formation.candidates[20].score.numerator = "2";
        before.frame.places[0].glosses = ["first", "last"].map((text) => ({
          language: "en",
          text,
          sense: null,
        }));
        after.frame.places[0].glosses = ["first", "middle", "last"].map(
          (text) => ({ language: "en", text, sense: null }),
        );
      } else if (scenario === "bounded") {
        before.glosses = Array.from({ length: 3000 }, (_, i) => ({
          language: "en",
          text: `before${i}`,
          sense: null,
        }));
        after.glosses = Array.from({ length: 3000 }, (_, i) => ({
          language: "en",
          text: `after${i}`,
          sense: null,
        }));
      }
      const original = JSON.stringify([before, after]);
      const envelope = { id: "jve1:" + "a".repeat(64) };
      document
        .querySelector("main")!
        .replaceChildren(
          comparison({ body: before, envelope }, { body: after, envelope }),
        );
      return { unchanged: original === JSON.stringify([before, after]) };
    },
    { path: corePath, scenario },
  );
}

test("F1 comparison sections follow reader order", async ({ page }) => {
  await mountComparison(page, "order");
  await expect(page.locator(".comparison-field > h3")).toHaveText([
    "Definition",
    "Place 1",
    "Glosses",
    "Notes",
    "Examples",
    "Etymology",
    "Sources",
    "Type",
    "Labels",
    "Rights",
    "Import evidence",
  ]);
});
test("F2 every readable comparison string escapes invisible controls", async ({
  page,
}) => {
  expect((await mountComparison(page, "controls")).unchanged).toBe(true);
  for (const field of [
    "Glosses",
    "Definition",
    "Sources",
    "Examples",
    "Labels",
  ]) {
    const content = page.locator(`[data-field="${field}"] .comparison-pair`);
    for (const code of [
      "0001",
      "007f",
      "0085",
      "202e",
      "2066",
      "200e",
      "200f",
      "061c",
    ])
      await expect(content).toContainText(`\\u${code}`);
    expect(await content.textContent()).not.toMatch(
      /[\u0001\u007f\u0085\u202e\u2066\u200e\u200f\u061c]/u,
    );
  }
  for (const selector of ["code", "a"]) {
    for (const value of await page
      .locator('[data-field="Definition"] .comparison-pair')
      .locator(selector)
      .allTextContents())
      expect(value).toContain("\\u202e");
  }
});
test("F3 nested list edits show only the changed item", async ({ page }) => {
  await mountComparison(page, "nested");
  const etymology = page.locator('[data-field="Etymology"] .comparison-pair');
  await expect(etymology).toHaveCount(1);
  await expect(etymology).toContainText("candidate20");
  await expect(etymology).not.toContainText("candidate19");
  await expect(etymology).not.toContainText("candidate21");
  const place = page.locator('[data-field="Place 1"] .comparison-pair');
  await expect(place).toHaveCount(1);
  await expect(place).toContainText("middle");
  await expect(place).not.toContainText("first");
  await expect(place).not.toContainText("last");
});
test("F3 a 3000-item comparison limits its initial rendered changes", async ({
  page,
}) => {
  await mountComparison(page, "bounded");
  await expect(page.locator(".comparison-pair")).toHaveCount(50);
  await expect(page.locator("main")).toContainText("2950 more changes");
  await page
    .getByRole("button", { name: "2950 more changes. Show the next 50" })
    .click();
  await expect(page.locator(".comparison-pair")).toHaveCount(100);
  await expect(page.locator("main")).toContainText("2900 more changes");
});
for (const mode of ["trust", "ignore"] as const)
  test(`F8 failed private ${mode} removal announces the error and keeps the choice`, async ({
    page,
  }) => {
    await page.goto("/");
    const result = await page.evaluate(
      async ({ path, mode }) => {
        const core = await import(path);
        await core.initializeCore();
        const { LocalStore, emptyOverlay, defaultPreferences } = await import(
          String("/src/data/store.ts")
        );
        const { trustPage } = await import(String("/src/pages/trust.ts"));
        const dbname = `failed-remove-${crypto.randomUUID()}`;
        const store = new LocalStore(dbname);
        const identity = "ed25519:" + "a".repeat(64);
        const subject = "ed25519:" + "b".repeat(64);
        const scope = { kind: "*", word: "*", language: "*" };
        const overlay = emptyOverlay();
        if (mode === "trust")
          overlay.trust.push({
            issuer: identity,
            subject,
            scope,
            value: "heed",
            weight: null,
          });
        else overlay.blocked.push({ identity: subject, scope });
        await store.setOverlay(overlay);
        store.updateOverlay = async () => {
          throw new Error("The local storage transaction failed.");
        };
        const announced: string[] = [];
        const unhandled: string[] = [];
        const rejection = (event: PromiseRejectionEvent) => {
          event.preventDefault();
          unhandled.push(String(event.reason));
        };
        window.addEventListener("unhandledrejection", rejection);
        const main = document.createElement("main");
        document.body.append(main);
        let live = true;
        try {
          await trustPage(
            {},
            {
              main,
              signal: new AbortController().signal,
              live: () => live,
              title: () => {},
            },
            {
              store,
              session: { identity, preferences: defaultPreferences },
              own: { registers: async () => null },
              personal: { loadedContinuity: null, subscribe: () => () => {} },
              announce: (value: string) => announced.push(value),
            },
          );
          [...main.querySelectorAll("button")]
            .find((button) => button.textContent === "Remove")!
            .click();
          await new Promise((resolve) => setTimeout(resolve, 100));
          return {
            announced,
            unhandled,
            saved: await store.overlay(),
            expected: overlay,
          };
        } finally {
          live = false;
          main.remove();
          window.removeEventListener("unhandledrejection", rejection);
          (await store.database).close();
          indexedDB.deleteDatabase(dbname);
        }
      },
      { path: corePath, mode },
    );
    expect(result.announced).toEqual(["The local storage transaction failed."]);
    expect(result.unhandled).toEqual([]);
    expect(result.saved).toEqual(result.expected);
  });

test("F6 an edit preserves saved string line breaks and whitespace", async ({
  page,
}) => {
  await page.goto("/");
  const original = await page.evaluate(async (path) => {
    const core = await import(path);
    await core.initializeCore();
    const { newDraft } = await import(String("/src/model/draft.ts"));
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const text = [
      ["first\n\nsecond"],
      [{ code: "x" }, " trailing "],
      ["\nleading"],
      [" "],
      ["last"],
    ];
    await new LocalStore().put(
      "drafts",
      "current",
      newDraft({
        spelling: "broda",
        kind: "gismu",
        text,
        structured: true,
        numberingApproved: true,
      }),
    );
    return text;
  }, corePath);
  await page.goto("/new/places");
  const editor = page.getByRole("textbox", {
    name: "Definition text",
    exact: true,
  });
  await editor.fill((await editor.inputValue()) + " added");
  await expect(
    page.getByText("Saved in this browser", { exact: true }),
  ).toBeVisible();
  const saved = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return (await new LocalStore().get("drafts", "current")).text;
  });
  original[4] = ["last added"];
  expect(saved).toEqual(original);
});

test("F5 reference spelling advice stays visible while Publish stays enabled", async ({
  page,
}) => {
  await createIdentity(page);
  await page.evaluate(async (path) => {
    const core = await import(path);
    await core.initializeCore();
    const { newDraft, newPlace } = await import(String("/src/model/draft.ts"));
    const { LocalStore } = await import(String("/src/data/store.ts"));
    await new LocalStore().put(
      "drafts",
      "current",
      newDraft({
        spelling: "broda",
        kind: "gismu",
        structured: true,
        frameMode: "fixed",
        places: [newPlace(1)],
        numberingApproved: true,
        text: [
          [{ word: { language: "jbo", spelling: "cukta?" }, label: "Target" }],
        ],
      }),
    );
  }, corePath);
  await page.goto("/new/publish");
  await expect(
    page.getByText(
      /This reference spelling does not match a recognized Lojban word form/,
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Publish", exact: true }).first(),
  ).toBeEnabled();
});
