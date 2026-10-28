import { expectRichText } from "./rich-helpers.ts";
import { test, expect, type Page } from "@playwright/test";

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

const reviewProblem =
  "The source evidence needs review. Keep or clear each retained value for its new word.";
const lettersProblem =
  "Keep or clear the retained Letters before the generator runs.";
const source = () => ({
  id: "review-r9-english",
  language: "eng",
  name: "English",
  word: "book",
  word_ipa: "bʊk",
  stem: "book",
  ipa: "bʊk",
  input: "buk",
  inputOriginal: { format: "lojbanized", text: "buk" },
  weight: { numerator: "1", denominator: "1" },
  notes: [["Author note"]],
  aiNoteGroup: [],
});

async function stored(page: Page): Promise<any> {
  return page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return new LocalStore().get("drafts", "current");
  });
}

async function seed(page: Page, row: Record<string, unknown> = source()) {
  await page.goto("/search");
  await page.evaluate(async (row) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { newDraft } = await import(String("/src/model/draft.ts"));
    const store = new LocalStore();
    await store.setPreferences({ useAiAssistance: true });
    await store.put(
      "drafts",
      "current",
      newDraft({
        meaning: "A book",
        text: "A book.",
        kind: "gismu",
        spelling: "brodu",
        gismu: {
          preset: null,
          rows: [row],
          candidates: "source-letters",
          selected: null,
          manual: "",
          acknowledged: [],
          reason: "",
          window: 12,
        },
      }),
    );
  }, row);
  await page.goto("/new/gismu");
}

async function mock(page: Page, sources: Record<string, unknown>[]) {
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
  let sourceIndex = 0;
  await page.route("**/api/v1/assist", async (route) => {
    const request = route.request().postDataJSON();
    result = {
      operation: request.operation,
      draft_revision: request.draft_revision,
      proposals:
        request.operation === "type"
          ? [{ path: "/word_type", value: "other" }]
          : [{ path: "/formation/sources", value: [sources[sourceIndex++]] }],
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
        job: "review-r9",
        expires_at: new Date(Date.now() + 60000).toISOString(),
        poll_after_ms: 100,
      },
    });
  });
  await page.route("**/api/v1/jobs/review-r9", (route) =>
    route.fulfill({
      json: {
        state: route.request().method() === "DELETE" ? "canceled" : "completed",
        result: route.request().method() === "DELETE" ? null : result,
        error: null,
      },
    }),
  );
}

async function accept(
  page: Page,
  first = true,
  name = "Suggest source for English",
) {
  await page.getByRole("button", { name, exact: true }).click();
  if (first)
    await page
      .getByRole("dialog", { name: "Before using AI assistance" })
      .getByRole("button", { name: "Allow these tasks", exact: true })
      .click();
  const panel = page.getByRole("region", { name: `${name} suggestion` });
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Use this", exact: true }).click();
}

async function chooseForm(page: Page) {
  await page.goto("/new/form?manual=1");
  const expected = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { manualFormation } = await import(String("/src/model/builders.ts"));
    const draft = await new LocalStore().get("drafts", "current");
    return manualFormation(draft.gismu.rows, draft.gismu.reason);
  });
  await page.getByRole("button", { name: "Use brodu", exact: true }).click();
  await expect(page).toHaveURL(/\/new\/places$/);
  await expect
    .poll(async () => (await stored(page)).formation)
    .toEqual(expected);
  return expected;
}

async function reviewProblems(page: Page) {
  return page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { draftToBody } = await import(String("/src/model/draft.ts"));
    const draft = await new LocalStore().get("drafts", "current");
    return draftToBody(draft).problems.filter((problem: { message: string }) =>
      problem.message.includes("The source evidence needs review."),
    );
  });
}

for (const removalPage of ["Form", "Places"])
  test(`removing evidence on ${removalPage} preserves review until a rebuilt formation needs it again`, async ({
    page,
  }) => {
    await mock(page, [{ word: "tome", notes: [] }]);
    await seed(page);
    await chooseForm(page);
    await page.goto("/new/gismu");
    await accept(page);
    await expect
      .poll(async () => (await stored(page)).gismu.rows[0].word)
      .toBe("tome");
    const marks = (await stored(page)).gismu.rows[0].sourceReview;
    expect(marks).toHaveLength(5);
    expect(await reviewProblems(page)).toContainEqual(
      expect.objectContaining({
        field: "formation",
        blocking: true,
        message: reviewProblem,
      }),
    );

    await page.goto(
      removalPage === "Form" ? "/new/form?manual=1" : "/new/places",
    );
    if (removalPage === "Places")
      await page.getByText("Etymology", { exact: true }).click();
    page.once("dialog", (dialog) => dialog.accept());
    await page
      .getByRole("button", { name: "Remove formation evidence", exact: true })
      .click();
    await expect.poll(async () => (await stored(page)).formation).toBeNull();
    expect((await stored(page)).gismu.rows[0].sourceReview).toEqual(marks);
    expect(await reviewProblems(page)).toEqual([]);
    await page.goto("/new/publish");
    await expect(page.locator("main")).not.toContainText(reviewProblem);

    await page.goto("/new/gismu");
    await expect(
      page.getByText(lettersProblem, { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Keep Letters for English",
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Keep Letters for English", exact: true })
      .click();
    await expect
      .poll(async () =>
        (await stored(page)).gismu.rows[0].sourceReview.map(
          (mark: any) => mark.field,
        ),
      )
      .not.toContain("input");
    await expect(
      page.getByRole("button", { name: "Keep Said for English", exact: true }),
    ).toBeVisible();
    await chooseForm(page);
    expect(await reviewProblems(page)).toContainEqual(
      expect.objectContaining({
        field: "formation",
        blocking: true,
        message: reviewProblem,
      }),
    );
    await page.goto("/new/publish");
    await expect(page.locator("main")).toContainText(reviewProblem);
    for (const publish of await page
      .getByRole("button", { name: "Publish", exact: true })
      .all())
      await expect(publish).toBeDisabled();
  });

test("a type change clears review and Undo restores the chosen evidence and its marks", async ({
  page,
}) => {
  await mock(page, [{ word: "tome", notes: [] }]);
  await seed(page);
  await chooseForm(page);
  await page.goto("/new/gismu");
  await accept(page);
  await expect
    .poll(async () => (await stored(page)).gismu.rows[0].sourceReview?.length)
    .toBe(5);
  const before = await stored(page);
  await page.goto("/new/type");
  page.once("dialog", (dialog) => dialog.accept());
  await accept(page, false, "Recommend a type");
  await expect.poll(async () => (await stored(page)).kind).toBe("other");
  expect((await stored(page)).formation).toBeNull();
  expect((await stored(page)).gismu.rows[0].sourceReview ?? []).toEqual([]);
  expect((await stored(page)).gismu.rows[0].input).toBe("buk");
  await page
    .getByRole("button", { name: "Undo Recommend a type", exact: true })
    .click();
  await expect
    .poll(async () => (await stored(page)).formation)
    .toEqual(before.formation);
  expect((await stored(page)).gismu.rows[0].sourceReview).toEqual(
    before.gismu.rows[0].sourceReview,
  );
  await page.goto("/new/gismu");
  await expect(
    page.getByRole("button", { name: "Keep Letters for English", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(lettersProblem, { exact: true }).first(),
  ).toBeVisible();
});

test("Undo restores replaced Letters with their mark and preserves Keep on Said", async ({
  page,
}) => {
  await mock(page, [
    { word: "tome", notes: [] },
    { word: "tome", input: { format: "lojbanized", text: "tom" }, notes: [] },
  ]);
  await seed(page);
  await accept(page);
  await expect(
    page.getByRole("button", { name: "Keep Letters for English", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Suggest again", exact: true })
    .click();
  await accept(page, false);
  await expect(
    page.getByLabel("Scoring letters for English", { exact: true }),
  ).toHaveValue("tom");
  await expect(
    page.getByRole("button", { name: "Keep Letters for English", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Keep Said for English", exact: true })
    .click();
  await expect
    .poll(async () =>
      (await stored(page)).gismu.rows[0].sourceReview.map(
        (mark: any) => mark.field,
      ),
    )
    .not.toContain("word_ipa");
  await page
    .getByRole("button", {
      name: "Undo Suggest source for English",
      exact: true,
    })
    .click();
  const letters = page.getByLabel("Scoring letters for English", {
    exact: true,
  });
  await expect(letters).toHaveValue("buk");
  await expect(letters).toHaveAttribute("readonly", "");
  await expect(
    page.getByRole("button", { name: "Keep Letters for English", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Keep Said for English", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel("Said for English", { exact: true }),
  ).toBeEditable();
  await expect(
    page.getByText(lettersProblem, { exact: true }).first(),
  ).toBeVisible();
  const undone = (await stored(page)).gismu.rows[0];
  expect(undone.word).toBe("tome");
  expect(undone.word_ipa).toBe("bʊk");
  expect(undone.inputOriginal).toEqual({ format: "lojbanized", text: "buk" });
  expect(undone.sourceReview).toContainEqual(
    expect.objectContaining({
      field: "input",
      word: "book",
      value: { format: "lojbanized", text: "buk" },
    }),
  );
  await page.reload();
  await expect(letters).toHaveAttribute("readonly", "");
  await expect(
    page.getByRole("button", { name: "Keep Said for English", exact: true }),
  ).toHaveCount(0);
});

test("Undo restores the AI note layout and Keep cannot replace Tail through a stale mark", async ({
  page,
}) => {
  await mock(page, [{ word: "tome", notes: [["Sense: AI1"], ["Note: AI2"]] }]);
  const notes = [["Note: AI0"], ["Author note"], ["Tail"]];
  await seed(page, {
    ...source(),
    notes,
    aiNoteGroup: [{ index: 0, paragraph: ["Note: AI0"] }],
  });
  await accept(page);
  const field = page.getByLabel("Source notes for English", { exact: true });
  await expectRichText(field, "Sense: AI1\n\nNote: AI2\n\nAuthor note\n\nTail");
  await expect(
    page.getByRole("button", {
      name: "Keep Notes paragraph 3 for English",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Keep Notes paragraph 4 for English",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Keep Stem for English", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Undo Suggest source for English",
      exact: true,
    })
    .click();
  await expectRichText(field, "Note: AI0\n\nAuthor note\n\nTail");
  await expect
    .poll(async () => (await stored(page)).gismu.rows[0].notes)
    .toEqual(notes);
  expect(
    ((await stored(page)).gismu.rows[0].sourceReview ?? []).filter(
      (mark: any) => mark.field === "notes" || mark.field === "stem",
    ),
  ).toEqual([]);
  await expect(
    page.getByRole("button", { name: /^Keep Notes paragraph/ }),
  ).toHaveCount(0);

  // Old saved drafts can still contain a mark from the longer note layout.
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const draft = await store.get("drafts", "current");
    draft.gismu.rows[0].sourceReview = [
      { field: "notes", index: 2, word: "book", value: ["Author note"] },
    ];
    await store.put("drafts", "current", draft);
  });
  await page.reload();
  await page
    .getByRole("button", {
      name: "Keep Notes paragraph 3 for English",
      exact: true,
    })
    .click();
  await expectRichText(field, "Note: AI0\n\nAuthor note\n\nTail");
  await expect
    .poll(async () => (await stored(page)).gismu.rows[0].notes)
    .toEqual(notes);
  await expect(
    page.getByRole("button", { name: /^Keep Notes paragraph/ }),
  ).toHaveCount(0);
});
