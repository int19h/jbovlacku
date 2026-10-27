import { expect, test } from "@playwright/test";
import { corePath, createIdentity } from "./helpers.ts";

test("editing a revision preserves multiline code and exact link labels", async ({
  page,
}) => {
  await page.goto("/");
  const original = await page.evaluate(async (path) => {
    const core = await import(path);
    await core.initializeCore();
    const model = await import(String("/src/model/draft.ts"));
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const text = [
      [
        { code: "first\n\n①" },
        " ",
        { url: "https://example.org/", label: " label\n\n① " },
      ],
    ];
    const body = model.draftToBody(
      model.newDraft({
        spelling: "broda",
        kind: "gismu",
        text,
        structured: true,
        frameMode: "fixed",
        places: [model.newPlace(1)],
        numberingApproved: true,
      }),
    ).body;
    const draft = model.draftFromBody(body, "jve1:" + "a".repeat(64), "native");
    await new LocalStore().put("drafts", "current", draft);
    return text;
  }, corePath);
  await page.goto("/new/places");
  const editor = page.getByRole("textbox", {
    name: "Definition text",
    exact: true,
  });
  await editor.fill((await editor.inputValue()) + " appended");
  await expect(
    page.getByText("Saved in this browser", { exact: true }),
  ).toBeVisible();
  const saved = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return (await new LocalStore().get("drafts", "current")).text;
  });
  expect(saved).toEqual([[...original[0], " appended"]]);
});

test("comparison exposes nested changes and distinct rich text nodes", async ({
  page,
}) => {
  await page.goto("/");
  const results = await page.evaluate(async (path) => {
    const core = await import(path);
    await core.initializeCore();
    const model = await import(String("/src/model/draft.ts"));
    const { comparison } = await import(String("/src/pages/definition.ts"));
    const body = model.draftToBody(
      model.newDraft({
        spelling: "broda",
        kind: "gismu",
        text: [[{ code: "①" }]],
        structured: true,
        frameMode: "fixed",
        places: [model.newPlace(1)],
        numberingApproved: true,
      }),
    ).body;
    body.sources = [
      {
        label: "source",
        url: "https://example.org/original",
        event: null,
        locator: null,
      },
    ];
    body.frame.places[0].defaults = [
      {
        kind: "suggested",
        value: { format: "lojban", text: "zo'e" },
        condition: [["only by day"]],
        explanation: [],
      },
    ];
    const changes: [string, (b: any) => void, string][] = [
      [
        "frame constraint",
        (b) => (b.frame.constraints = [[["must be alive"]]]),
        "must be alive",
      ],
      [
        "source URL",
        (b) => (b.sources[0].url = "https://example.org/other"),
        "https://example.org/other",
      ],
      ["code to reference", (b) => (b.text = [[1]]), "code"],
      [
        "default condition",
        (b) => (b.frame.places[0].defaults[0].condition = [["only at night"]]),
        "only at night",
      ],
      [
        "type hint",
        (b) =>
          (b.frame.places[0].type_hints = [
            { alternatives: [{ tags: ["number"] }], note: [] },
          ]),
        "number",
      ],
      [
        "operand",
        (b) =>
          (b.operands = [
            {
              id: "bridi",
              category: "bridi",
              description: [["operand detail"]],
              cardinality: { minimum: 1, maximum: null },
            },
          ]),
        "operand detail",
      ],
      [
        "formation",
        (b) =>
          (b.etymology.formation = {
            method: "unknown",
            selection_reason: [["formation detail"]],
          }),
        "formation detail",
      ],
      [
        "tail details",
        (b) => {
          b.frame.arity = { mode: "variadic", minimum: 1 };
          b.frame.tail = {
            from: 2,
            description: [["tail detail"]],
            type_hints: [],
          };
        },
        "tail detail",
      ],
      [
        "compound",
        (b) =>
          (b.etymology.compound = {
            components: [
              { word: { language: "jbo", spelling: "cukta" }, rafsi: "cku" },
              { word: { language: "jbo", spelling: "sorcu" }, rafsi: "sro" },
            ],
            morphology: { id: "https://example.org/morphology", version: "1" },
            scoring: { id: "https://example.org/scoring", version: "1" },
            notes: [["compound detail"]],
          }),
        "compound detail",
      ],
      [
        "source locator",
        (b) => (b.sources[0].locator = "new locator"),
        "new locator",
      ],
      [
        "source event",
        (b) => (b.sources[0].event = "jve1:" + "b".repeat(64)),
        "jve1:" + "b".repeat(64),
      ],
      [
        "gloss sense",
        (b) =>
          (b.glosses = [
            { language: "en", text: "sample", sense: "new sense" },
          ]),
        "new sense",
      ],
      [
        "example notes",
        (b) =>
          (b.examples = [
            {
              language: "jbo",
              text: "broda",
              notes: [["example detail"]],
              translation: [],
            },
          ]),
        "example detail",
      ],
      [
        "license URL",
        (b) => (b.license.url = "https://example.org/rights"),
        "https://example.org/rights",
      ],
    ];
    const original = JSON.stringify(body);
    const envelope = { id: "jve1:" + "a".repeat(64) };
    const omitted = core.omitDefinitionDefaults(body);
    const equal = comparison(
      { body, envelope },
      { body: omitted, envelope },
    ).textContent;
    const values = changes.map(([name, change, expected]) => {
      const after = structuredClone(body);
      change(after);
      const beforeProblems = model.coreProblems(
        body,
        core.wordId(body.word),
        [],
        "native",
      );
      const afterProblems = model.coreProblems(
        after,
        core.wordId(after.word),
        [],
        "native",
      );
      const envelope = { id: "jve1:" + "a".repeat(64) };
      const result = comparison(
        { body, envelope },
        { body: core.interpretDefinition(after), envelope },
      );
      return {
        name,
        expected,
        text: result.textContent,
        beforeProblems,
        afterProblems,
      };
    });
    return { values, equal, unchanged: JSON.stringify(body) === original };
  }, corePath);
  expect(results.unchanged).toBe(true);
  expect(results.equal).toContain("identical content fields");
  for (const result of results.values) {
    expect.soft(result.beforeProblems, result.name).toEqual([]);
    expect.soft(result.afterProblems, result.name).toEqual([]);
    expect
      .soft(result.text, result.name)
      .not.toContain("identical content fields");
    expect.soft(result.text, result.name).toContain(result.expected);
  }
});

test("an unchanged revision keeps uppercase word links and derivations publishable", async ({
  page,
}) => {
  await createIdentity(page);
  const result = await page.evaluate(async (path) => {
    const core = await import(path);
    await core.initializeCore();
    const model = await import(String("/src/model/draft.ts"));
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const body = model.draftToBody(
      model.newDraft({
        spelling: "broda",
        kind: "gismu",
        text: "Test definition.",
        structured: true,
        frameMode: "fixed",
        places: [model.newPlace(1)],
        numberingApproved: true,
      }),
    ).body;
    body.text = [
      [{ word: { language: "jbo", spelling: "CUKTA" }, label: "CUKTA" }],
    ];
    body.frame.places[0].derivation = [
      {
        word: { language: "jbo", spelling: "CUKTA" },
        definition: null,
        place: 1,
        explanation: [],
      },
    ];
    const problems = model.coreProblems(
      body,
      core.wordId(body.word),
      [],
      "native",
    );
    await new LocalStore().put(
      "drafts",
      "current",
      model.draftFromBody(body, "jve1:" + "a".repeat(64), "native"),
    );
    return problems;
  }, corePath);
  expect(result).toEqual([]);
  await page.goto("/new/publish");
  await expect(
    page.getByRole("heading", { name: /^Publish as/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Publish", exact: true }).first(),
  ).toBeEnabled();
});

test("a package download keeps its requested language after the selector changes", async ({
  page,
}) => {
  await page.goto("/");
  const packages = await page.evaluate(async (path) => {
    const core = await import(path);
    await core.initializeCore();
    const snapshot = "sha256:" + "b".repeat(64);
    const entry = {
      event: "jve1:" + "c".repeat(64),
      word: { language: "jbo", spelling: "broda" },
      language: "en",
      glosses: [],
      plain_text: "English definition",
      classification: { kind: "gismu", selmaho: [] },
      body: null,
    };
    const part = core.canonicalize(core.utf8(JSON.stringify([entry])));
    const hash = core.contentHash(core.utf8(part));
    const pkg = core.canonicalize(
      core.utf8(
        JSON.stringify({
          version: 1,
          language: "en",
          snapshot,
          parts: [{ hash, bytes: core.utf8(part).length, count: 1 }],
        }),
      ),
    );
    return {
      part,
      pkg,
      manifest: {
        snapshot,
        packages: ["en", "ru"].map((language) => ({
          language,
          hash: core.contentHash(core.utf8(pkg)),
          bytes: core.utf8(pkg).length,
        })),
      },
    };
  }, corePath);
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/v1/manifest", (route) =>
    route.fulfill({ json: packages.manifest }),
  );
  await page.route("**/api/v1/packages/en?*", async (route) => {
    await delayed;
    await route.fulfill({ body: packages.pkg });
  });
  await page.route("**/api/v1/package-parts/*", (route) =>
    route.fulfill({ body: packages.part }),
  );
  await page.goto("/preferences");
  const request = page.waitForRequest("**/api/v1/packages/en?*");
  await page
    .getByLabel("Download a package", { exact: true })
    .selectOption("en");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await request;
  try {
    await page
      .getByLabel("Download a package", { exact: true })
      .selectOption("ru");
  } finally {
    release();
  }
  await expect(
    page.getByRole("button", { name: "Download", exact: true }),
  ).toBeEnabled();
  const result = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { validateCachedPackage } = await import(
      String("/src/data/search.ts")
    );
    const store = new LocalStore();
    const keys = await store.keys("packages");
    return Promise.all(
      keys.map(async (key: string) => {
        const value = await store.get("packages", key);
        let valid = true;
        try {
          validateCachedPackage(value, key);
        } catch {
          valid = false;
        }
        return {
          key,
          valid,
          languages: value.entries.map((entry: any) => entry.language),
        };
      }),
    );
  });
  expect(result).toEqual([{ key: "en", valid: true, languages: ["en"] }]);
  await expect(page.getByRole("status")).toContainText(
    "English search package is saved",
  );
});
