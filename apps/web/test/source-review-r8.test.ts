import { test, expect, type Page } from "@playwright/test";
import { acceptFirstSignature, createIdentity } from "./helpers.ts";

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

const row = () => ({
  id: "retained-english",
  language: "eng",
  name: "English",
  word: "book",
  word_ipa: "bʊk",
  stem: "book",
  ipa: "bʊk",
  input: "buk",
  inputOriginal: { format: "lojbanized", text: "buk" },
  weight: { numerator: "1", denominator: "1" },
  notes: [["Authored note"]],
  aiNoteGroup: [],
});
const builder = (rows: unknown[], preset: string | null = null) => ({
  preset,
  rows,
  candidates: "source-letters",
  selected: null,
  manual: "",
  acknowledged: [],
  reason: "",
  window: 12,
});
const formation = (sources: unknown[]) => ({
  method: "non-algorithmic",
  algorithm: null,
  sources,
  weights_profile: null,
  generated: null,
  selected_score: null,
  selected_rank: null,
  selection_reason: [],
  candidates: [],
  conflicts: [],
});
async function stored(page: Page): Promise<any> {
  return page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return new LocalStore().get("drafts", "current");
  });
}
async function seed(
  page: Page,
  patch: Record<string, unknown>,
  revise = false,
) {
  await page.goto("/search");
  await page.evaluate(
    async ({ patch, revise }) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const { newDraft, draftToBody, draftFromBody } = await import(
        String("/src/model/draft.ts")
      );
      const store = new LocalStore();
      await store.setPreferences({ useAiAssistance: true });
      const initial = newDraft({
        meaning: "A book",
        text: "A book.",
        kind: "gismu",
        spelling: "brodu",
        ...patch,
      });
      let draft = initial;
      if (revise) {
        const body = draftToBody(initial).body;
        body.etymology.formation.sources[0].word_ipa = null;
        draft = draftFromBody(body, "jve1:" + "a".repeat(64), "native");
      }
      await store.put("drafts", "current", draft);
    },
    { patch, revise },
  );
  await page.goto("/new/gismu");
}
async function mock(
  page: Page,
  source: Record<string, unknown> = { word: "tome", notes: [] },
) {
  await page.route("**/api/v1/capabilities", async (route) => {
    const actual = await (await route.fetch()).json();
    await route.fulfill({
      json: {
        ...actual,
        features: { ...actual.features, assistance: true },
        assistance_profiles: [
          {
            id: "default",
            label: "Mock",
            provider: "Mock",
            model: "mock",
            operations: ["gismu-sources", "type"],
            disclosure: "Send draft fields.",
          },
        ],
      },
    });
  });
  await page.route("**/api/v1/session", (route) =>
    route.fulfill({ json: { csrf: "local" } }),
  );
  let result: unknown;
  await page.route("**/api/v1/assist", async (route) => {
    const request = route.request().postDataJSON();
    result = {
      operation: request.operation,
      draft_revision: request.draft_revision,
      proposals:
        request.operation === "type"
          ? [{ path: "/word_type", value: "other" }]
          : [{ path: "/formation/sources", value: [source] }],
      explanation: "Mock suggestion.",
      provenance: {
        provider: "Mock",
        model: "mock",
        revision: null,
        recipe: "test",
        seed: null,
      },
      usage: null,
      log: {
        operation: request.operation,
        provider: "Mock",
        model: "mock",
        exchanges: [],
      },
    };
    await route.fulfill({
      status: 202,
      json: {
        job: "review-r8",
        expires_at: new Date(Date.now() + 60000).toISOString(),
        poll_after_ms: 100,
      },
    });
  });
  await page.route("**/api/v1/jobs/review-r8", (route) =>
    route.fulfill({
      json: {
        state: route.request().method() === "DELETE" ? "canceled" : "completed",
        result: route.request().method() === "DELETE" ? null : result,
        error: null,
      },
    }),
  );
}
async function suggest(page: Page, name = "Suggest source for English") {
  await page.getByRole("button", { name, exact: true }).click();
  const consent = page.getByRole("dialog", {
    name: "Before using AI assistance",
  });
  await consent.getByRole("button", { name: "Allow these tasks" }).click();
  await expect(
    page.getByRole("button", { name: "Use this", exact: true }),
  ).toBeVisible();
}

for (const earlierAi of [false, true])
  test(`preset changes use the live row for preview and ${earlierAi ? "selected" : "empty"} earlier AI ownership`, async ({
    page,
  }) => {
    await mock(page);
    const legacy: Record<string, unknown> = row();
    delete legacy.aiNoteGroup;
    await seed(page, { gismu: builder([legacy], "cll-1995") });
    await page.getByLabel("Weights", { exact: true }).selectOption("cll-1987");
    await page
      .getByLabel("Native word for English", { exact: true })
      .fill("volume");
    await page
      .getByLabel("Source notes for English", { exact: true })
      .fill("Current author note");
    await suggest(page);
    const panel = page.getByRole("region", {
      name: "Suggest source for English suggestion",
    });
    await expect(
      panel
        .locator(".ai-source-preview tr")
        .filter({
          has: page.getByRole("rowheader", { name: "Word", exact: true }),
        })
        .locator("td")
        .first(),
    ).toHaveText("volume");
    await expect(
      panel.getByRole("checkbox", {
        name: "Earlier AI paragraph 1: Current author note",
      }),
    ).toBeVisible();
    if (earlierAi) {
      await panel
        .getByRole("checkbox", {
          name: "Earlier AI paragraph 1: Current author note",
        })
        .check();
      await panel
        .getByRole("button", {
          name: "Use the selected earlier AI notes",
          exact: true,
        })
        .click();
    } else {
      await panel
        .getByRole("button", { name: "No earlier AI notes", exact: true })
        .click();
    }
    await expect(panel).not.toContainText(
      "The draft changed while this suggestion was made.",
    );
    await expect(
      panel.getByRole("checkbox", {
        name: "I reviewed the newer fields and want to replace them",
      }),
    ).toHaveCount(0);
    await expect(
      panel.getByRole("button", { name: "Use this", exact: true }),
    ).toBeEnabled();
    await panel.getByRole("button", { name: "Use this", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await stored(page)).gismu.rows.find(
            (r: any) => r.id === "retained-english",
          ).word,
      )
      .toBe("tome");
    const accepted = (await stored(page)).gismu.rows.find(
      (r: any) => r.id === "retained-english",
    );
    expect(accepted.aiNoteGroup).toEqual([]);
    expect(accepted.notes).toEqual(earlierAi ? [] : [["Current author note"]]);
  });

test("retained fields wait for Keep or Clear and Letters report review before missing input", async ({
  page,
}) => {
  await mock(page);
  await seed(page, { gismu: builder([row()]) });
  await suggest(page);
  await page.getByRole("button", { name: "Use this", exact: true }).click();
  const labels = ["Said", "Stem", "Stem said", "Scoring letters"];
  for (const label of labels) {
    const field = page.getByLabel(`${label} for English`, { exact: true });
    await expect(field).toHaveAttribute("readonly", "");
    const retained = await field.inputValue();
    await field.press("End");
    await field.pressSequentially("changed");
    await expect(field).toHaveValue(retained);
  }
  await expect(
    page
      .getByText(
        "Keep or clear the retained Letters before the generator runs.",
        { exact: true },
      )
      .first(),
  ).toBeVisible();
  await expect(
    page.getByText("Fill in every scoring input before the generator runs.", {
      exact: true,
    }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Keep Letters for English", exact: true })
    .click();
  await expect(
    page.getByLabel("Scoring letters for English", { exact: true }),
  ).toBeEditable();
  await expect
    .poll(async () => (await stored(page)).gismu.rows[0].inputOriginal)
    .toEqual({ format: "lojbanized", text: "buk" });
  await page
    .getByRole("button", { name: "Clear Stem for English", exact: true })
    .click();
  await page.getByLabel("Stem for English", { exact: true }).fill("fresh stem");
  await page
    .getByRole("button", { name: "Keep Said for English", exact: true })
    .click();
  await expect(
    page.getByLabel("Said for English", { exact: true }),
  ).toHaveValue("bʊk");
  await page
    .getByRole("button", { name: "Clear Stem said for English", exact: true })
    .click();
  await expect(
    page.getByLabel("Stem said for English", { exact: true }),
  ).toBeEditable();
  await expect
    .poll(async () => (await stored(page)).gismu.rows[0].ipa)
    .toBeNull();
  await expect
    .poll(async () => (await stored(page)).gismu.rows[0].stem)
    .toBe("fresh stem");
  await page.reload();
  await expect(
    page.getByLabel("Stem for English", { exact: true }),
  ).toHaveValue("fresh stem");
  await expect(
    page.getByLabel("Scoring letters for English", { exact: true }),
  ).toHaveValue("buk");
  await page
    .getByRole("button", {
      name: "Undo Suggest source for English",
      exact: true,
    })
    .click();
  await expect(
    page.getByLabel("Native word for English", { exact: true }),
  ).toHaveValue("book");
  await expect(
    page.getByLabel("Stem for English", { exact: true }),
  ).toHaveValue("fresh stem");
});

test("clearing retained Letters asks for new input and permits manual entry", async ({
  page,
}) => {
  await mock(page);
  await seed(page, { gismu: builder([row()]) });
  await suggest(page);
  await page.getByRole("button", { name: "Use this", exact: true }).click();
  await page
    .getByRole("button", { name: "Clear Letters for English", exact: true })
    .click();
  const letters = page.getByLabel("Scoring letters for English", {
    exact: true,
  });
  await expect(letters).toBeEditable();
  await expect(letters).toHaveValue("");
  await expect(
    page.getByText("Fill in every scoring input before the generator runs.", {
      exact: true,
    }),
  ).toBeVisible();
  await letters.fill("tom");
  await expect
    .poll(async () => (await stored(page)).gismu.rows[0].input)
    .toBe("tom");
});

test("retained IPA input requires review before its replacement action", async ({
  page,
}) => {
  await mock(page);
  const original = { format: "ipa", text: " ˈbʊk " };
  await seed(page, {
    formation: formation([
      {
        language: "eng",
        word: "book",
        input: original,
        weight: null,
        notes: [],
      },
    ]),
    evidenceForm: "brodu",
  });
  await suggest(page, "Suggest source for eng");
  await page.getByRole("button", { name: "Use this", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "Replace IPA input for eng",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    page.getByLabel("Original IPA input for eng", { exact: true }),
  ).toHaveText(" ˈbʊk ");
  await page
    .getByRole("button", { name: "Keep Letters for eng", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Replace IPA input for eng",
      exact: true,
    }),
  ).toBeEnabled();
  await expect
    .poll(async () => (await stored(page)).gismu.rows[0].inputOriginal)
    .toEqual(original);
});

test("a type change removes formation review marks, preserves builder inputs, and Undo restores them", async ({
  page,
}) => {
  await mock(page);
  const marked = {
    ...row(),
    sourceReview: [
      {
        field: "input",
        word: "old",
        value: { format: "lojbanized", text: "buk" },
      },
    ],
  };
  const signed = {
    language: "eng",
    word: "book",
    input: { format: "lojbanized", text: "buk" },
    weight: { numerator: 1, denominator: 1 },
    notes: [],
  };
  await seed(page, {
    gismu: builder([marked]),
    formation: formation([signed]),
    evidenceForm: "brodu",
  });
  await page.goto("/new/type");
  await suggest(page, "Recommend a type");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Use this", exact: true }).click();
  await expect.poll(async () => (await stored(page)).kind).toBe("other");
  expect((await stored(page)).formation).toBeNull();
  expect((await stored(page)).gismu.rows[0].sourceReview ?? []).toEqual([]);
  expect((await stored(page)).gismu.rows[0].input).toBe("buk");
  await page
    .getByRole("button", { name: "Undo Recommend a type", exact: true })
    .click();
  await expect
    .poll(async () => (await stored(page)).gismu.rows[0].sourceReview)
    .toEqual(marked.sourceReview);
  expect((await stored(page)).formation).not.toBeNull();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("radio", { name: /Other/ }).check();
  await expect.poll(async () => (await stored(page)).kind).toBe("other");
  await createIdentity(page);
  await page.evaluate(async () => {
    const { navigate } = await import(String("/src/app/router.ts"));
    navigate("/new/publish");
  });
  await expect(page.locator("main")).not.toContainText(
    "The source evidence needs review.",
  );
  const publish = page
    .locator("aside")
    .getByRole("button", { name: "Publish", exact: true });
  await expect(publish).toBeEnabled();
  await publish.click();
  await acceptFirstSignature(page);
  await expect(page).toHaveURL(/\/word\/brodu/);
});

test("new blank Said fields omit pronunciation while unchanged signed null survives", async ({
  page,
}) => {
  await mock(page);
  await seed(
    page,
    {
      formation: formation([
        {
          language: "eng",
          word: "book",
          word_ipa: null,
          input: { format: "lojbanized", text: "buk" },
          weight: null,
          notes: [],
        },
      ]),
      evidenceForm: "brodu",
    },
    true,
  );
  const serialize = () =>
    page.evaluate(async () => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const { manualFormation } = await import(
        String("/src/model/builders.ts")
      );
      const draft = await new LocalStore().get("drafts", "current");
      return manualFormation(draft.gismu.rows, "").sources;
    });
  await expect
    .poll(async () => (await stored(page))?.gismu?.rows?.length)
    .toBe(1);
  expect((await serialize())[0]).toHaveProperty("word_ipa", null);
  await page
    .getByRole("button", {
      name: "Add an alternative word for eng",
      exact: true,
    })
    .click();
  await page
    .getByLabel("Native word for eng", { exact: true })
    .nth(1)
    .fill("volume");
  await page
    .getByLabel("Scoring letters for eng", { exact: true })
    .nth(1)
    .fill("volum");
  const said = page.getByLabel("Said for eng", { exact: true }).nth(1);
  await said.fill("voːl");
  await said.fill("");
  await expect
    .poll(async () => (await stored(page))?.gismu?.rows?.[1]?.input)
    .toBe("volum");
  expect((await serialize())[0]).toHaveProperty("word_ipa", null);
  expect((await serialize())[1]).not.toHaveProperty("word_ipa");
});
