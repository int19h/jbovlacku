import { test, expect, type Page } from "@playwright/test";

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

async function seed(
  page: Page,
  method = "algorithmic",
  stale = false,
  kind = "gismu",
) {
  await page.goto("/search");
  await page.evaluate(
    async ({ method, stale, kind }) => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const { newDraft, newPlace } = await import(
        String("/src/model/draft.ts")
      );
      const { newGismuState, sourceRowsFromFormation } = await import(
        String("/src/model/builders.ts")
      );
      const formation: any = {
        method,
        algorithm: null,
        sources: [
          {
            language: "en",
            word: "book",
            input: { format: "lojbanized", text: "buk" },
            weight: { numerator: 1, denominator: 1 },
            notes: [],
          },
          {
            language: "hi",
            word: "",
            input: null,
            weight: { numerator: 1, denominator: 2 },
            notes: [],
          },
        ],
        weights_profile: null,
        generated: "brodu",
        selected_score: { numerator: "1", denominator: "2" },
        selected_rank: 1,
        selection_reason: [],
        candidates: [],
        conflicts: [],
      };
      const rows = sourceRowsFromFormation(formation.sources);
      if (stale) {
        rows[0].input = "buku";
        delete rows[0].inputOriginal;
      }
      const draft = newDraft({
        kind: kind as any,
        spelling: "brodu",
        meaning: "A book.",
        text: "A book.",
        frameMode: "fixed",
        places: [newPlace(1)],
        formation,
        evidenceForm: "brodu",
        gismu: { ...newGismuState(), rows },
      });
      await new LocalStore().put("drafts", "current", draft);
    },
    { method, stale, kind },
  );
}

async function mock(page: Page, operation: string) {
  let result: any;
  await page.route("**/api/v1/capabilities", async (route) => {
    const response = await route.fetch();
    const caps = await response.json();
    await route.fulfill({
      json: {
        ...caps,
        features: { ...caps.features, assistance: true },
        assistance_profiles: [
          {
            id: "default",
            label: "Local test assistant",
            provider: "Mock provider",
            model: "mock-model",
            operations: [operation],
            disclosure: "Send the draft fields.",
          },
        ],
      },
    });
  });
  await page.route("**/api/v1/session", (route) =>
    route.fulfill({ json: { csrf: "disposable-csrf" } }),
  );
  await page.route("**/api/v1/assist", async (route) => {
    const request = route.request().postDataJSON();
    const frame = structuredClone(request.current.frame);
    frame.places[0].description = [["A suggested place."]];
    frame.places[0].derivation.push({
      word: { language: "jbo", spelling: "klama" },
      definition: null,
      place: 2,
      explanation: [["direct: The source place."]],
    });
    result = {
      operation,
      draft_revision: request.draft_revision,
      proposals:
        operation === "definition"
          ? [{ path: "/text", value: [["An improved definition."]] }]
          : [{ path: "/frame", value: frame }],
      explanation: "A local suggestion.",
      provenance: {
        provider: "Mock provider",
        model: "mock-model",
        revision: null,
        recipe: "fixture",
        seed: null,
      },
      usage: null,
      log: {},
    };
    await route.fulfill({
      status: 202,
      json: {
        job: "model-job",
        expires_at: "2099-01-01T00:00:00Z",
        poll_after_ms: 1,
      },
    });
  });
  await page.route("**/api/v1/jobs/model-job", (route) =>
    route.fulfill({
      json: {
        state: "completed",
        result: route.request().method() === "DELETE" ? null : result,
        error: null,
        log: null,
      },
    }),
  );
}

for (const accept of ["definition", "places", "mapping"]) {
  test(`stale source scores keep ${accept} suggestions usable`, async ({
    page,
  }) => {
    const operation = accept === "definition" ? "definition" : "places-glosses";
    await mock(page, operation);
    await seed(
      page,
      "algorithmic",
      true,
      accept === "definition" ? "lujvo" : "gismu",
    );
    await page.goto(accept === "definition" ? "/new/lujvo" : "/new/places");
    const action =
      accept === "definition"
        ? "Draft definition for this form"
        : "Suggest places and glosses";
    await page.getByRole("button", { name: action, exact: true }).click();
    await page
      .getByRole("dialog", { name: "Before using AI assistance" })
      .getByRole("button", { name: "Allow these tasks" })
      .click();
    const panel = page.getByRole("region", { name: `${action} suggestion` });
    await panel
      .getByRole("button", {
        name: accept === "mapping" ? "Add klama 2 to place 1" : "Use this",
        exact: true,
      })
      .click();
    const saved = await page.evaluate(async () => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const { draftToBody } = await import(String("/src/model/draft.ts"));
      const draft: any = await new LocalStore().get("drafts", "current");
      return {
        text: draft.text,
        places: draft.places,
        stale: draftToBody(draft).problems.some(
          (p: any) => p.blocking && p.field === "formation",
        ),
      };
    });
    expect(saved.stale).toBe(true);
    if (accept === "definition")
      expect(saved.text).toEqual([["An improved definition."]]);
    else expect(saved.places[0].derivations[0].word).toBe("klama");
  });
}

for (const method of ["algorithmic", "non-algorithmic", "unknown"]) {
  test(`opening ${method} sources preserves a signed weight-only row`, async ({
    page,
  }) => {
    await seed(page, method);
    await page.goto("/new/gismu");
    await expect(
      page.getByLabel("Native word for hi", { exact: true }),
    ).toBeVisible();
    const checked = await page.evaluate(async () => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const { draftToBody } = await import(String("/src/model/draft.ts"));
      const draft: any = await new LocalStore().get("drafts", "current");
      const result = draftToBody(draft);
      return {
        sources: result.body?.etymology.formation?.sources,
        blocked: result.problems.some((p: any) => p.blocking),
      };
    });
    expect(checked.blocked).toBe(false);
    expect(checked.sources).toHaveLength(2);
    expect(checked.sources?.[1]).toEqual({
      language: "hi",
      word: "",
      input: null,
      weight: { numerator: 1, denominator: 2 },
      notes: [],
    });
  });
}

test("body reads preserve browser drafts with deep private logs", async ({
  page,
}) => {
  await seed(page);
  const outcome = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { draftToBody, normalizeDraft, referenceFields } = await import(
      String("/src/model/draft.ts")
    );
    const { currentDraft, draftFingerprint } = await import(
      String("/src/model/assistance.ts")
    );
    const draft: any = await new LocalStore().get("drafts", "current");
    draft.text = [[999]];
    draft.gismu.rows[0].notes = [["An edited note."]];
    draft.ai = {
      records: [
        {
          id: "deep",
          key: "definition",
          state: "done",
          log: JSON.parse(
            `{"unknown":${"[".repeat(10000)}0${"]".repeat(10000)}}`,
          ),
        },
      ],
    };
    const before = draftFingerprint(draft);
    currentDraft(draft);
    const problems = draftToBody(draft).problems.filter(
      (problem: any) => problem.richFieldKey,
    );
    const unchanged = draftFingerprint(draft) === before;
    const normalized = normalizeDraft(draft);
    const keys = new Set(
      referenceFields(draft, true).map((field: any) => field.key),
    );
    return {
      unchanged,
      stableKeys: problems.every((problem: any) =>
        keys.has(problem.richFieldKey),
      ),
      savedNotes: draft.formation.sources[0].notes,
      loadedNotes: normalized.formation!.sources[0].notes,
    };
  });
  expect(outcome).toEqual({
    unchanged: true,
    stableKeys: true,
    savedNotes: [],
    loadedNotes: [["An edited note."]],
  });
});
