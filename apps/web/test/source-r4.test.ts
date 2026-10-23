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
    const current = body.current.formation.sources[0];
    jobs.set(id, {
      operation: body.operation,
      draft_revision: body.draft_revision,
      proposals: [
        {
          path: "/formation/sources",
          value: [
            {
              ...current,
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

test("accepted source notes stay editable with AI off and every field reaches review", async ({
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
  await expect(page.locator("main")).toContainText("Stem: book");
  await expect(page.locator("main")).toContainText("Stem said: bʊk");
  const saved = await stored(page);
  expect(saved.formation.sources[0].notes).toEqual([
    ["Reviewed author note\nsecond line"],
  ]);
  expect(saved.formation.sources[0].word).toBe("author word");
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
      ipa: "stem-only",
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
  expect(roundtrip.sources[0].ipa).toBe("stem-only");
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
  await expect(page.locator('td[colspan="8"]:visible')).toHaveCount(0);
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
  await expect(bulk).toBeDisabled();
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

test("manual selection rebuilds changed source evidence and removes stale scores", async ({
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
      selected_rank: "1",
      selection_reason: [],
      candidates: [],
      conflicts: [],
    },
  });
  await page.getByLabel("Native word for English", { exact: true }).fill("new");
  await page
    .getByRole("link", { name: "Enter without generation", exact: true })
    .click();
  await page.getByRole("button", { name: "Use brodu", exact: true }).click();
  await expect(page).toHaveURL(/\/new\/places$/);
  const draft = await stored(page);
  expect(draft.formation.sources[0].word).toBe("new");
  expect(draft.formation.method).toBe("non-algorithmic");
  expect(draft.formation.selected_score).toBeNull();
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
  await expect(page.locator('td[colspan="8"]:visible')).toHaveCount(0);
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
        ipa: null,
        language: "en",
        notes: [["Historical note"]],
        stem: null,
        weight: { denominator: 1, numerator: 1 },
        word: "book",
        word_ipa: null,
      },
    ],
    weights_profile: null,
    generated: "brodu",
    selected_score: { numerator: 1, denominator: 2 },
    selected_rank: "1",
    selection_reason: [["Original selection"]],
    candidates: [],
    conflicts: [],
  };
  await seed(page, { formation, evidenceForm: "brodu" }, false);
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
