import { expect, test } from "@playwright/test";
import { corePath, createIdentity } from "./helpers.ts";

test("editing a revision keeps code and labels with normalized blank lines", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async (path) => {
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
  expect(saved).toEqual([
    [
      { code: "first\n①" },
      " ",
      { url: "https://example.org/", label: " label\n① " },
      " appended",
    ],
  ]);
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
      ["code to reference", (b) => (b.text = [[1]]), "Code:"],
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
      const visible = result.cloneNode(true) as HTMLElement;
      visible
        .querySelectorAll("details")
        .forEach((node: Element) => node.remove());
      return {
        name,
        expected,
        text: visible.textContent,
        fields: [...result.querySelectorAll(".comparison-field > h3")].map(
          (node) => node.textContent,
        ),
        prose: result.querySelectorAll(".comparison-prose").length,
        code: result.querySelector("code")?.textContent,
        place: result.querySelector('[aria-label="place 1"]') !== null,
        exposedJson: result.querySelectorAll("pre:not(details pre)").length,
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
    expect.soft(result.exposedJson, result.name).toBe(0);
    expect.soft(result.fields.length, result.name).toBe(1);
    expect.soft(result.fields[0], result.name).not.toContain(" / ");
    if (result.name === "code to reference") {
      expect(result.code).toBe("①");
      expect(result.place).toBe(true);
      expect(result.fields).toEqual(["Definition"]);
    }
    if (result.name === "default condition") {
      expect(result.fields).toEqual(["Place 1"]);
      expect(result.text).toContain("When");
      expect(result.prose).toBeGreaterThan(0);
    }
    if (result.name === "source URL") {
      expect(result.fields).toEqual(["Sources"]);
      expect(result.text).toContain("source");
      expect(result.text).toContain("https://example.org/original");
    }
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
  await expect(page.locator("#app > [role=status]")).toContainText(
    "English search package is saved",
  );
});

test("comparison aligns middle list changes and numbered places", async ({
  page,
}) => {
  await page.goto("/");
  const results = await page.evaluate(async (path) => {
    const core = await import(path);
    await core.initializeCore();
    const model = await import(String("/src/model/draft.ts"));
    const { comparison } = await import(String("/src/pages/definition.ts"));
    const body = model.draftToBody(
      model.newDraft({ spelling: "broda", kind: "gismu", text: "Test" }),
    ).body;
    const envelope = { id: "jve1:" + "a".repeat(64) };
    const values = [];
    for (const field of ["glosses", "sources", "examples"]) {
      const item = (name: string) =>
        field === "glosses"
          ? { language: "en", text: name, sense: null }
          : field === "sources"
            ? {
                label: name,
                url: `https://example.org/${name}`,
                locator: `page ${name}`,
                event: null,
              }
            : { language: "jbo", text: name, translation: [], notes: [] };
      const before = { ...body, [field]: [item("first"), item("last")] };
      const after = {
        ...body,
        [field]: [item("first"), item("middle"), item("last")],
      };
      for (const [left, right] of [
        [before, after],
        [after, before],
      ]) {
        const result = comparison(
          { body: left, envelope },
          { body: right, envelope },
        );
        result
          .querySelectorAll("details")
          .forEach((node: Element) => node.remove());
        values.push({
          field,
          text: result.textContent,
          rows: result.querySelectorAll(".comparison-field").length,
          pairs: result.querySelectorAll(".comparison-pair").length,
        });
      }
    }
    const first = { index: 1, description: [["first"]] };
    const middle = { index: 2, description: [["middle"]] };
    const last = { index: 3, description: [["last"]] };
    const frame = {
      role: "predicate",
      arity: { mode: "context" },
      places: [first, last],
    };
    const result = comparison(
      { body: { ...body, frame }, envelope },
      {
        body: { ...body, frame: { ...frame, places: [first, middle, last] } },
        envelope,
      },
    );
    result
      .querySelectorAll("details")
      .forEach((node: Element) => node.remove());
    values.push({
      field: "Place 2",
      text: result.textContent,
      rows: result.querySelectorAll(".comparison-field").length,
      pairs: result.querySelectorAll(".comparison-pair").length,
    });
    return values;
  }, corePath);
  for (const result of results) {
    expect(result.rows, result.field).toBe(1);
    expect(result.pairs, result.field).toBe(1);
    expect(result.text, result.field).toContain("middle");
    expect(result.text, result.field).toContain("Not present");
    expect(result.text, result.field).not.toContain("first");
    expect(result.text, result.field).not.toContain("last");
    expect(result.text, result.field).not.toContain("identical content fields");
    if (result.field === "sources") {
      expect(result.text).toContain("https://example.org/middle");
      expect(result.text).toContain("page middle");
    }
  }
});

test("reviewed import comparison summarizes legacy evidence behind a disclosure", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async (path) => {
    const core = await import(path);
    await core.initializeCore();
    const model = await import(String("/src/model/draft.ts"));
    const { comparison } = await import(String("/src/pages/definition.ts"));
    const body = model.draftToBody(
      model.newDraft({
        spelling: "broda",
        kind: "gismu",
        text: "Imported definition",
      }),
    ).body;
    body.legacy = {
      source: "https://example.org",
      snapshot: "sha256:" + "d".repeat(64),
      extraction: "fixture-v1",
      record: { kind: "definition", id: 1 },
      locator: "definitions/1",
      original: { definition: "Archived source text" },
      attribution: {
        author: "Source author",
        editor: null,
        dates: {},
        author_account: null,
      },
      conversion: {
        method: "literal",
        tool: "fixture",
        version: "1",
        model: null,
        review: "unreviewed",
        mappings: [],
        warnings: [],
      },
      limitations: [],
    };
    const original = JSON.stringify(body);
    const id = "jve1:" + "a".repeat(64);
    const draft = model.draftFromBody(body, id, "import");
    const child = model.draftToBody(draft).body;
    const problems = model.coreProblems(
      body,
      core.wordId(body.word),
      [],
      "import",
    );
    const childProblems = model.coreProblems(
      child,
      core.wordId(child.word),
      [id],
      "native",
    );
    const comparisonNode = comparison(
      { body, envelope: { id } },
      { body: child, envelope: { id } },
    );
    document.querySelector("main")!.replaceChildren(comparisonNode);
    return {
      problems,
      childProblems,
      legacy: child.legacy,
      unchanged: JSON.stringify(body) === original,
    };
  }, corePath);
  expect(result.problems).toEqual([]);
  expect(result.childProblems).toEqual([]);
  expect(result.legacy).toBeNull();
  expect(result.unchanged).toBe(true);
  const field = page.locator('[data-field="Import evidence"]');
  await expect(field).toContainText(
    "Import evidence is present in the parent and absent in this revision.",
  );
  await expect(
    field.getByText("Archived source text", { exact: false }),
  ).not.toBeVisible();
  await expect(field.locator("details")).not.toHaveAttribute("open");
  await field.getByText("Show exact values", { exact: true }).click();
  await expect(field.locator("pre").first()).toBeVisible();
  await expect(field.locator("pre").first()).toContainText(
    "Archived source text",
  );
  await expect(page.locator("main")).not.toContainText(
    "identical content fields",
  );
});

test("comparison explains equal-looking prose and fits a narrow screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/");
  await page.evaluate(async (path) => {
    const core = await import(path);
    await core.initializeCore();
    const model = await import(String("/src/model/draft.ts"));
    const { comparison } = await import(String("/src/pages/definition.ts"));
    const body = model.draftToBody(
      model.newDraft({ spelling: "broda", kind: "gismu", text: "Test" }),
    ).body;
    body.text = [["Same prose"]];
    body.sources = [
      {
        label: "Source",
        url: "https://example.org/" + "a".repeat(300),
        locator: null,
        event: null,
      },
    ];
    const child = structuredClone(body);
    child.text = [["Same ", "prose"]];
    child.sources[0].locator = "page 42";
    const envelope = { id: "jve1:" + "a".repeat(64) };
    document
      .querySelector("main")!
      .replaceChildren(
        comparison({ body, envelope }, { body: child, envelope }),
      );
  }, corePath);
  const field = page.locator('[data-field="Definition"]');
  await expect(field.locator(".comparison-prose")).toHaveText([
    "Same prose",
    "Same prose",
  ]);
  await expect(field).toContainText("The structured values differ.");
  await expect(page.locator("main")).not.toContainText(
    "identical content fields",
  );
  await expect(page.locator("pre:visible")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const pair = field.locator(".comparison-pair > div");
  const oldBox = await pair.nth(0).boundingBox();
  const newBox = await pair.nth(1).boundingBox();
  expect(newBox!.y).toBeGreaterThan(oldBox!.y + oldBox!.height);
  await field.getByText("Show exact values", { exact: true }).click();
  await expect(field.locator("pre").first()).toContainText('"Same prose"');
  await expect(field.locator("pre").last()).toContainText('"Same "');
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
