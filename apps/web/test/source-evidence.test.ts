import { test, expect, type Page } from "@playwright/test";
import { acceptFirstSignature, createIdentity } from "./helpers.ts";
test.setTimeout(20000);
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

const source = (language = "en", name = "English") => ({
  language,
  name,
  word: "",
  input: "",
  aiNoteGroup: [],
  weight: { numerator: "1", denominator: "1" },
});
async function seed(
  page: Page,
  patch: Record<string, unknown> = {},
  enabled = true,
) {
  await page.goto("/search");
  await page.evaluate(
    async ({ patch, enabled }) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const { newDraft } = await import(String("/src/model/draft.ts"));
      const store = new LocalStore();
      await store.setPreferences({ useAiAssistance: enabled });
      await store.put(
        "drafts",
        "current",
        newDraft({
          meaning: "A book",
          text: "A book.",
          kind: "gismu",
          spelling: "brodu",
          ...patch,
        }),
      );
    },
    { patch, enabled },
  );
  await page.goto("/new/gismu");
}
const state = (rows: unknown[]) => ({
  preset: null,
  rows,
  candidates: "source-letters",
  selected: null,
  manual: "",
  acknowledged: [],
  reason: "",
  window: 12,
});
async function stored(page: Page): Promise<any> {
  return page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return new LocalStore().get("drafts", "current");
  });
}
async function mock(
  page: Page,
  options: {
    disabled?: boolean;
    delay?: boolean;
    delayCapabilities?: boolean;
  } = {},
) {
  const calls: any[] = [];
  let deletes = 0;
  let capabilityReads = 0;
  const jobs = new Map<string, any>();
  let releaseCapabilities = () => {};
  const capabilitiesReady = options.delayCapabilities
    ? new Promise<void>((resolve) => {
        releaseCapabilities = resolve;
      })
    : Promise.resolve();
  await page.route("**/api/v1/capabilities", async (route) => {
    const actual = await (await route.fetch()).json();
    await capabilitiesReady;
    await route.fulfill({
      json: {
        ...actual,
        features: { ...actual.features, assistance: !options.disabled },
        assistance_profiles: options.disabled
          ? []
          : [
              {
                id: "default",
                label: "Mock",
                provider: "Mock",
                model: "mock",
                operations: ["gismu-sources"],
                disclosure: "Send source fields.",
              },
            ],
      },
    });
    capabilityReads++;
  });
  await page.route("**/api/v1/session", (route) =>
    route.fulfill({ json: { csrf: "local" } }),
  );
  await page.route("**/api/v1/assist", async (route) => {
    const body = route.request().postDataJSON();
    calls.push(body);
    const id = String(calls.length);
    jobs.set(id, {
      operation: body.operation,
      draft_revision: body.draft_revision,
      proposals: [
        {
          path: "/formation/sources",
          value: [
            {
              word: `book${id}`,
              word_ipa: "ˈbʊk",
              stem: "book",
              ipa: "bʊk",
              input: { format: "lojbanized", text: "buk" },
              notes: [
                [`Sense: work ${id}`],
                [`Note: first line ${id}\nsecond line\n\nlast line`],
              ],
            },
          ],
        },
      ],
      explanation: "Mock source.",
      provenance: {
        provider: "Mock",
        model: "mock",
        revision: null,
        recipe: "test",
        seed: null,
      },
      usage: null,
      log: {
        operation: "gismu-sources",
        provider: "Mock",
        model: "mock",
        exchanges: [],
      },
    });
    await route.fulfill({
      status: 202,
      json: {
        job: id,
        expires_at: new Date(Date.now() + 60000).toISOString(),
        poll_after_ms: 100,
      },
    });
  });
  await page.route(/\/api\/v1\/jobs\/\d+$/, (route) => {
    if (route.request().method() === "DELETE") {
      deletes++;
      return route.fulfill({
        json: { state: "canceled", result: null, error: null },
      });
    }
    const id = route.request().url().split("/").at(-1)!;
    return route.fulfill({
      json: options.delay
        ? { state: "running", result: null, error: null }
        : { state: "completed", result: jobs.get(id), error: null },
    });
  });
  return {
    calls,
    deletes: () => deletes,
    capabilityReads: () => capabilityReads,
    releaseCapabilities,
  };
}
async function allow(page: Page) {
  await page
    .getByRole("dialog", { name: "Before using AI assistance" })
    .getByRole("button", { name: "Allow these tasks" })
    .click();
}

test("accepted source notes stay editable with AI off and every signed field reaches review", async ({
  page,
}) => {
  test.setTimeout(45000);
  await mock(page);
  await seed(page, { gismu: state([source()]) });
  await page
    .getByRole("button", { name: "Suggest source for English", exact: true })
    .click();
  await allow(page);
  await page.getByRole("button", { name: "Use this", exact: true }).click();
  const notes = page.getByLabel("Source notes for English", { exact: true });
  await expect(notes).toHaveValue(
    "Sense: work 1\n\nNote: first line 1\nsecond line\n\nlast line",
  );
  await expect(notes).toHaveJSProperty("tagName", "TEXTAREA");
  await page
    .getByRole("button", { name: "Suggest again", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Suggest source for English", exact: true })
    .click();
  await page.getByRole("button", { name: "Use this", exact: true }).click();
  await expect(notes).toHaveValue(
    "Sense: work 2\n\nNote: first line 2\nsecond line\n\nlast line",
  );
  const review = page.getByRole("region", {
    name: "Retained source evidence for English",
  });
  await expect(review.getByRole("button", { name: /^Keep / })).toHaveCount(4);
  while (await review.getByRole("button", { name: /^Keep / }).count())
    await review
      .getByRole("button", { name: /^Keep / })
      .first()
      .click();
  await expect(review).toHaveCount(0);
  await expect
    .poll(
      async () => (await stored(page)).gismu.rows[0].sourceReview?.length ?? 0,
    )
    .toBe(0);
  await page.goto("/preferences");
  await page.getByRole("checkbox", { name: "Use AI assistance" }).uncheck();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { LocalStore } = await import(String("/src/data/store.ts"));
        return (await new LocalStore().preferences()).useAiAssistance;
      }),
    )
    .toBe(false);
  await page.goto("/new/gismu");
  await expect(notes).toBeVisible();
  await notes.fill("Author note line 1\nline 2");
  await page
    .getByLabel("Native word for English", { exact: true })
    .fill("author word");
  await expect(
    page.getByText("The source word changed. Review the source notes.", {
      exact: true,
    }),
  ).toBeVisible();
  await notes.fill("Reviewed author note\nsecond line");
  await page
    .getByRole("link", { name: "Enter without generation", exact: true })
    .click();
  await page.getByRole("button", { name: "Use brodu", exact: true }).click();
  await expect(page).toHaveURL(/\/new\/places$/);
  await page.goto("/new/publish");
  await page.getByText("Etymology", { exact: true }).click();
  await expect(page.locator("main")).toContainText("Reviewed author note");
  await expect(page.locator("main")).toContainText("ˈbʊk");
  await expect(page.locator("main")).not.toContainText("Stem: book");
  await expect(page.locator("main")).not.toContainText("Stem said: bʊk");
  const saved = await stored(page);
  expect(saved.formation.sources[0].notes).toEqual([
    ["Reviewed author note\nsecond line"],
  ]);
  expect(saved.formation.sources[0].word).toBe("author word");
  expect(saved.gismu.rows[0]).toMatchObject({ stem: "book", ipa: "bʊk" });
  expect(saved.formation.sources[0]).not.toHaveProperty("stem");
  expect(saved.formation.sources[0]).not.toHaveProperty("ipa");
  const published: any[] = [];
  await page.route("**/api/v1/events", async (route) => {
    const payload = route.request().postDataJSON();
    if (payload?.envelope?.header?.action?.kind === "definition.publish")
      published.push(payload);
    await route.continue();
  });
  await createIdentity(page);
  await page.evaluate(async () => {
    const { navigate } = await import(String("/src/app/router.ts"));
    navigate("/new/publish");
  });
  await page
    .locator("aside")
    .getByRole("button", { name: "Publish", exact: true })
    .click();
  await acceptFirstSignature(page);
  await expect(page).toHaveURL(/\/word\/brodu/);
  expect(published).toHaveLength(1);
  expect(published[0].body.etymology.formation.sources[0].notes).toEqual([
    ["Reviewed author note\nsecond line"],
  ]);
  expect(published[0].envelope.signature).toEqual(expect.any(String));
  expect(JSON.stringify(published[0].body)).not.toContain("Sense: work");
  expect(JSON.stringify(published[0].body)).not.toContain("first line");
  expect(published[0].body.ai).toBeUndefined();
  expect(published[0].body.etymology.formation.sources[0]).not.toHaveProperty(
    "stem",
  );
  expect(published[0].body.etymology.formation.sources[0]).not.toHaveProperty(
    "ipa",
  );
  // Reopen a disposable copy to test dropping notes after an earlier formation.
  await seed(page, saved, false);
  await page
    .getByRole("button", { name: "Drop source notes for English", exact: true })
    .click();
  await expect(notes).toHaveCount(0);
  await page
    .getByRole("link", { name: "Enter without generation", exact: true })
    .click();
  await page.getByRole("button", { name: "Use brodu", exact: true }).click();
  await expect(page).toHaveURL(/\/new\/places$/);
  expect((await stored(page)).formation.sources[0].notes).toEqual([]);
});

test("existing IPA, null, and exact lojbanized inputs open without conversion or field guesses", async ({
  page,
}) => {
  await mock(page, { disabled: true });
  const sources = [
    {
      language: "en",
      word: "book",
      input: { format: "ipa", text: " ˈbʊk " },
      weight: null,
      notes: [],
    },
    { language: "fr", word: "livre", input: null, weight: null, notes: [] },
    {
      language: "zh",
      word: "书",
      input: { format: "lojbanized", text: " Cu " },
      weight: null,
      notes: [],
    },
  ];
  await seed(page, {
    formation: {
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
    },
    evidenceForm: "brodu",
  });
  await expect(
    page.getByLabel("Native word for en", { exact: true }),
  ).toHaveValue("book");
  await expect(
    page.getByLabel("Scoring letters for en", { exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByLabel("Original IPA input for en", { exact: true }),
  ).toHaveText(" ˈbʊk ");
  await expect(
    page.getByText(
      "IPA conversion is unavailable. The original input stays unchanged.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByLabel("Stem said for en", { exact: true }),
  ).toHaveValue("");
  await expect(page.getByLabel("Stem for en", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Said for en", { exact: true })).toHaveValue("");
  await page.getByLabel("Stem said for en", { exact: true }).fill("stem-only");
  await expect
    .poll(async () => (await stored(page))?.gismu?.rows[0]?.ipa)
    .toBe("stem-only");
  await page.reload();
  await expect(
    page.getByLabel("Stem said for en", { exact: true }),
  ).toHaveValue("stem-only");
  await expect(
    page.getByLabel("Scoring letters for fr", { exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByLabel("Scoring letters for zh", { exact: true }),
  ).toHaveValue(" Cu ");
  await page.getByLabel("Native word for en", { exact: true }).fill("books");
  await expect
    .poll(async () => (await stored(page))?.gismu?.rows[0]?.word)
    .toBe("books");
  const roundtrip = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { manualFormation } = await import(String("/src/model/builders.ts"));
    const draft = await new LocalStore().get("drafts", "current");
    return manualFormation(draft.gismu.rows, "");
  });
  expect(roundtrip.sources.map((s: any) => s.input)).toEqual(
    sources.map((s) => s.input),
  );
  expect(roundtrip.sources[0]).not.toHaveProperty("ipa");
  expect(roundtrip.sources[0]).not.toHaveProperty("stem");
  expect(roundtrip.sources[0]).not.toHaveProperty("word_ipa");
  expect((await stored(page)).gismu.rows[0].ipa).toBe("stem-only");
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Replace IPA input for en", exact: true })
    .click();
  const letters = page.getByLabel("Scoring letters for en", { exact: true });
  await expect(letters).toBeEnabled();
  await letters.fill("buk");
  await expect
    .poll(async () => (await stored(page)).gismu.rows[0].input)
    .toBe("buk");
  expect((await stored(page)).gismu.rows[0].inputOriginal).toBeUndefined();
  await expect(
    page.getByLabel("Stem said for en", { exact: true }),
  ).toHaveValue("stem-only");
  await page.reload();
  await expect(
    page.getByLabel("Stem said for en", { exact: true }),
  ).toHaveValue("stem-only");
  await expect(letters).toHaveValue("buk");
});

test("bulk source suggestions stop after declined consent and hide empty detail rows", async ({
  page,
}) => {
  const assistant = await mock(page);
  await seed(page, {
    gismu: state([source(), source("zh", "Chinese"), source("ja", "Japanese")]),
  });
  await page
    .getByRole("button", { name: "Suggest source words", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Before using AI assistance" })
    .getByRole("button", { name: "Not now", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Suggest source words", exact: true }),
  ).toBeEnabled();
  await page.waitForTimeout(200);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(assistant.calls).toHaveLength(0);
  await page.goto("/preferences");
  await page.getByRole("checkbox", { name: "Use AI assistance" }).uncheck();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { LocalStore } = await import(String("/src/data/store.ts"));
        return (await new LocalStore().preferences()).useAiAssistance;
      }),
    )
    .toBe(false);
  await page.goto("/new/gismu");
  await expect(
    page.getByLabel("Native word for English", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".source-row-details:visible")).toHaveCount(0);
});

test("bulk suggestions disable repeated starts and stop on cancellation", async ({
  page,
}) => {
  const assistant = await mock(page, { delay: true });
  await seed(page, { gismu: state([source(), source("zh", "Chinese")]) });
  const bulk = page.getByRole("button", {
    name: "Suggest source words",
    exact: true,
  });
  await bulk.click();
  await expect(bulk).toHaveAttribute("aria-disabled", "true");
  await allow(page);
  await expect.poll(() => assistant.calls.length).toBe(1);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(bulk).toBeEnabled();
  await expect.poll(assistant.deletes).toBe(1);
  expect(assistant.calls).toHaveLength(1);
});

test("bulk source action appears after adding a row to an empty custom profile", async ({
  page,
}) => {
  const assistant = await mock(page, { delayCapabilities: true });
  await seed(page, { gismu: state([source()]) });
  await expect(
    page.getByLabel("Native word for English", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Remove row 1", exact: true }).click();
  assistant.releaseCapabilities();
  await expect.poll(assistant.capabilityReads).toBeGreaterThan(0);
  await expect(
    page.getByRole("button", { name: "Suggest source words", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Add a language", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Suggest source words", exact: true }),
  ).toBeVisible();
});

test("source undo follows its row after an earlier row is removed", async ({
  page,
}) => {
  await mock(page);
  await seed(page, { gismu: state([source(), source("zh", "Chinese")]) });
  await page
    .getByRole("button", { name: "Suggest source for Chinese", exact: true })
    .click();
  await allow(page);
  await page.getByRole("button", { name: "Use this", exact: true }).click();
  await page.getByRole("button", { name: "Remove row 1", exact: true }).click();
  await expect.poll(async () => (await stored(page)).gismu.rows.length).toBe(1);
  await page.reload();
  await page
    .getByRole("button", {
      name: "Undo Suggest source for Chinese",
      exact: true,
    })
    .click();
  await expect(
    page.getByLabel("Native word for Chinese", { exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByLabel("Native word for English", { exact: true }),
  ).toHaveCount(0);
});

test("saved source notes remain ordinary author fields when assistance is unavailable", async ({
  page,
}) => {
  await mock(page, { disabled: true });
  await seed(
    page,
    {
      gismu: state([
        {
          ...source(),
          word: "book",
          notes: [["Sense: a work"], ["Note: line one\nline two"]],
        },
      ]),
    },
    false,
  );
  await expect(
    page.getByLabel("Source notes for English", { exact: true }),
  ).toHaveValue("Sense: a work\n\nNote: line one\nline two");
});

test("manual selection keeps scores after descriptive source edits", async ({
  page,
}) => {
  await mock(page, { disabled: true });
  const rows = [
    { ...source(), word: "old", input: "old", notes: [["Old note"]] },
  ];
  await seed(page, {
    gismu: state(rows),
    evidenceForm: "brodu",
    formation: {
      method: "algorithmic",
      algorithm: null,
      sources: [
        {
          language: "en",
          word: "old",
          input: { format: "lojbanized", text: "old" },
          weight: { numerator: 1, denominator: 1 },
          notes: [["Old note"]],
        },
      ],
      weights_profile: null,
      generated: "brodu",
      selected_score: { numerator: 1, denominator: 2 },
      selected_rank: 1,
      selection_reason: [],
      candidates: [],
      conflicts: [],
    },
  });
  await page.getByLabel("Native word for English", { exact: true }).fill("new");
  await page.getByLabel("Said for English", { exact: true }).fill("nuː");
  await page
    .getByLabel("Source notes for English", { exact: true })
    .fill("Reviewed note");
  await page
    .getByRole("link", { name: "Enter without generation", exact: true })
    .click();
  await page.getByRole("button", { name: "Use brodu", exact: true }).click();
  await expect(page).toHaveURL(/\/new\/places$/);
  const draft = await stored(page);
  expect(draft.formation.sources[0].word).toBe("new");
  expect(draft.formation.method).toBe("algorithmic");
  expect(draft.formation.selected_score).toEqual({
    numerator: 1,
    denominator: 2,
  });
  expect(draft.formation.sources[0].notes).toEqual([["Reviewed note"]]);
  expect(draft.formation.sources[0].word_ipa).toBe("nuː");
});

test("a custom language edit updates its source action and cancels an old-language job", async ({
  page,
}) => {
  const assistant = await mock(page, { delay: true });
  await seed(page, { gismu: state([source()]) });
  await page
    .getByRole("button", { name: "Suggest source for English", exact: true })
    .click();
  await allow(page);
  await expect.poll(() => assistant.calls.length).toBe(1);
  await page.getByLabel("Language tag of row 1", { exact: true }).fill("fr");
  await page.getByLabel("Language tag of row 1", { exact: true }).press("Tab");
  await expect(
    page.getByRole("button", { name: "Suggest source for fr", exact: true }),
  ).toBeVisible();
  await expect.poll(assistant.deletes).toBe(1);
  await expect
    .poll(async () => (await stored(page)).gismu.rows[0].language)
    .toBe("fr");
});

test("Suggest again replaces the accepted source notes before the author edits them", async ({
  page,
}) => {
  await mock(page);
  await seed(page, { gismu: state([source()]) });
  await page
    .getByRole("button", { name: "Suggest source for English", exact: true })
    .click();
  await allow(page);
  await page.getByRole("button", { name: "Use this", exact: true }).click();
  await page
    .getByRole("button", { name: "Suggest again", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Suggest source for English", exact: true })
    .click();
  await page.getByRole("button", { name: "Use this", exact: true }).click();
  await expect(
    page.getByLabel("Source notes for English", { exact: true }),
  ).toHaveValue(
    "Sense: work 2\n\nNote: first line 2\nsecond line\n\nlast line",
  );
  expect((await stored(page)).gismu.rows[0].notes).toEqual([
    ["Sense: work 2"],
    ["Note: first line 2\nsecond line\n\nlast line"],
  ]);
});

test("empty source detail rows collapse with assistance off", async ({
  page,
}) => {
  await mock(page, { disabled: true });
  await seed(
    page,
    { gismu: state([source(), source("zh", "Chinese")]) },
    false,
  );
  await expect(
    page.getByLabel("Native word for English", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".source-row-details:visible")).toHaveCount(0);
});

test("manual selection preserves unchanged canonical source evidence and historical scores", async ({
  page,
}) => {
  await mock(page, { disabled: true });
  const formation = {
    method: "algorithmic",
    algorithm: null,
    sources: [
      {
        input: { text: "Buk", format: "lojbanized" },
        language: "en",
        notes: [["Historical note"]],
        weight: { denominator: 1, numerator: 1 },
        word: "book",
        word_ipa: null,
      },
    ],
    weights_profile: null,
    generated: "brodu",
    selected_score: { numerator: 1, denominator: 2 },
    selected_rank: 1,
    selection_reason: [["Original selection"]],
    candidates: [],
    conflicts: [],
  };
  await seed(
    page,
    { formation, evidenceForm: "brodu", retainedWordIpaNullSources: [0] },
    false,
  );
  await expect(
    page.getByLabel("Native word for en", { exact: true }),
  ).toHaveValue("book");
  await page
    .getByRole("link", { name: "Enter without generation", exact: true })
    .click();
  await page.getByRole("button", { name: "Use brodu", exact: true }).click();
  await expect(page).toHaveURL(/\/new\/places$/);
  expect((await stored(page)).formation).toEqual(formation);
});

test("changing a source language keeps the next weight input attached and preserves typed zero", async ({
  page,
}) => {
  await mock(page, { disabled: true });
  await seed(page, { gismu: state([source()]) }, false);
  const language = page.getByLabel("Language tag of row 1", { exact: true });
  const weight = page.getByLabel("Weight numerator of row 1", { exact: true });
  const original = await weight.elementHandle();
  await language.fill("deu");
  await weight.fill("0");
  await expect(weight).toBeFocused();
  expect(await original!.evaluate((input) => input.isConnected)).toBe(true);
  await weight.press("Tab");
  await expect
    .poll(async () => (await stored(page)).gismu.rows[0].weight.numerator)
    .toBe("0");
  await expect(
    page.getByLabel("Scoring letters for deu", { exact: true }),
  ).toBeVisible();
});

const scoredFormation = () => ({
  method: "algorithmic",
  algorithm: null,
  sources: [
    {
      language: "en",
      word: "book",
      input: { format: "lojbanized", text: "buk" },
      weight: { numerator: 1, denominator: 1 },
      notes: [["Original note"]],
    },
  ],
  weights_profile: { name: "Historical", source: null },
  generated: "brodu",
  selected_score: { numerator: 1, denominator: 2 },
  selected_rank: 3,
  selection_reason: [["Author chose this form."]],
  candidates: [
    { form: "brodu", score: { numerator: 1, denominator: 2 }, rank: 3 },
  ],
  conflicts: [],
});

test("a blank alternative keeps the scored formation and its selection reason", async ({
  page,
}) => {
  await mock(page, { disabled: true });
  const formation = scoredFormation();
  await seed(page, { formation, evidenceForm: "brodu" }, false);
  await page
    .getByRole("button", {
      name: "Add an alternative word for en",
      exact: true,
    })
    .click();
  await page
    .getByRole("link", { name: "Enter without generation", exact: true })
    .click();
  await page.getByRole("button", { name: "Use brodu", exact: true }).click();
  await expect(page).toHaveURL(/\/new\/places$/);
  expect((await stored(page)).formation).toEqual(formation);
});

test("dropping notes after Use this form then publishing through the step bar signs current source text", async ({
  page,
}) => {
  test.setTimeout(45000);
  await mock(page);
  await seed(page, { gismu: state([source()]) });
  await page
    .getByRole("button", { name: "Suggest source for English", exact: true })
    .click();
  await allow(page);
  await page.getByRole("button", { name: "Use this", exact: true }).click();
  await expect(
    page.getByLabel("Source notes for English", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Scoring letters for English", { exact: true })
    .fill("buktu");
  await page
    .getByRole("region", { name: "Candidates", exact: true })
    .getByRole("button", { name: /^Choose / })
    .first()
    .click();
  await page.locator("button.btn-primary").filter({ hasText: /^Use / }).click();
  await expect(page).toHaveURL(/\/new\/places$/);
  expect(
    (await stored(page)).formation.sources[0].notes.length,
  ).toBeGreaterThan(0);
  await page.locator(".step-bar").getByRole("link", { name: /^Form/ }).click();
  await page
    .getByRole("button", { name: "Drop source notes for English", exact: true })
    .click();
  await page.getByLabel("Native word for English", { exact: true }).fill("");
  await page.getByLabel("Said for English", { exact: true }).fill("ˈbʊks");
  await page.getByLabel("Stem for English", { exact: true }).fill("new stem");
  await page.getByLabel("Stem said for English", { exact: true }).fill("bʊks");
  await page
    .locator(".step-bar")
    .getByRole("link", { name: /^Publish/ })
    .click();
  await expect(page).toHaveURL(/\/new\/publish$/);
  expect((await stored(page)).gismu.rows[0]).toMatchObject({
    stem: "new stem",
    ipa: "bʊks",
  });
  await createIdentity(page);
  await page.evaluate(async () => {
    const { navigate } = await import(String("/src/app/router.ts"));
    navigate("/new/publish");
  });
  const published: any[] = [];
  await page.route("**/api/v1/events", async (route) => {
    const payload = route.request().postDataJSON();
    if (payload?.envelope?.header?.action?.kind === "definition.publish")
      published.push(payload);
    await route.continue();
  });
  await page
    .locator("aside")
    .getByRole("button", { name: "Publish", exact: true })
    .click();
  await acceptFirstSignature(page);
  await expect(page).toHaveURL(/\/word\//);
  expect(published).toHaveLength(1);
  expect(published[0].body.etymology.formation.sources[0]).toMatchObject({
    word: "",
    notes: [],
    word_ipa: "ˈbʊks",
  });
  expect(published[0].body.etymology.formation.sources[0]).not.toHaveProperty(
    "stem",
  );
  expect(published[0].body.etymology.formation.sources[0]).not.toHaveProperty(
    "ipa",
  );
  expect(published[0].body.etymology.formation.method).toBe("algorithmic");
  expect(published[0].envelope.signature).toEqual(expect.any(String));
});

test("scoring edits block publication through the step bar until the author removes the old scores", async ({
  page,
}) => {
  await mock(page, { disabled: true });
  await seed(
    page,
    { formation: scoredFormation(), evidenceForm: "brodu" },
    false,
  );
  await page
    .getByLabel("Scoring letters for en", { exact: true })
    .fill("buksa");
  await page
    .locator(".step-bar")
    .getByRole("link", { name: /^Publish/ })
    .click();
  await expect(page.locator("main")).toContainText(
    "The source scoring inputs changed.",
  );
  await expect(
    page.locator("aside").getByRole("button", { name: "Publish", exact: true }),
  ).toBeDisabled();
  await page.locator(".step-bar").getByRole("link", { name: /^Form/ }).click();
  await page
    .getByRole("link", { name: "Enter without generation", exact: true })
    .click();
  await expect(page.locator("main")).toContainText(
    "Using this form without generation removes the old scores.",
  );
  await page.getByRole("button", { name: "Use brodu", exact: true }).click();
  await expect(page).toHaveURL(/\/new\/places$/);
  expect((await stored(page)).formation.selected_score).toBeNull();
});

test("bulk source suggestions keep focus after a completed loop and declined consent", async ({
  page,
}) => {
  await mock(page);
  await seed(page, { gismu: state([source(), source("zh", "Chinese")]) });
  const bulk = page.getByRole("button", {
    name: "Suggest source words",
    exact: true,
  });
  await bulk.focus();
  await bulk.press("Enter");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Not now", exact: true })
    .click();
  await expect(bulk).toBeFocused();
  await bulk.press("Enter");
  await allow(page);
  await expect(page.getByText("Mock source.", { exact: true })).toHaveCount(2);
  await expect(bulk).toBeFocused();
});

test("source note review preserves visible line breaks", async ({ page }) => {
  await mock(page, { disabled: true });
  const formation = scoredFormation();
  formation.sources[0].notes = [["line one\nline two"]];
  await seed(page, { formation, evidenceForm: "brodu" }, false);
  await page
    .locator(".step-bar")
    .getByRole("link", { name: /^Publish/ })
    .click();
  await page.getByText("Etymology", { exact: true }).click();
  const note = page.locator(".source-notes").first();
  await expect(note).toHaveCSS("white-space", "pre-wrap");
  await expect(note).toContainText("line one\nline two");
});

test("source notes edit plain text without token escapes", async ({ page }) => {
  await mock(page, { disabled: true });
  const formation = scoredFormation();
  const value = "pronounced [buk] `literal` \\ {place 2} ②";
  formation.sources[0].notes = [[value]];
  await seed(page, { formation, evidenceForm: "brodu" }, false);
  const notes = page.getByLabel("Source notes for en", { exact: true });
  await expect(notes).toHaveValue(value);
  await notes.fill(value + "\nsecond line");
  await page
    .locator(".step-bar")
    .getByRole("link", { name: /^Publish/ })
    .click();
  expect((await stored(page)).formation.sources[0].notes).toEqual([
    [value + "\nsecond line"],
  ]);
});
