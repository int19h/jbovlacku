import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  fixture,
  expectKindSpelling,
  createIdentity,
  acceptFirstSignature,
} from "./helpers.ts";
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});
const operations = [
  "type",
  "lujvo",
  "gismu-sources",
  "cmavo-class",
  "definition",
  "places-glosses",
];
const profile = (
  id = "default",
  provider = "Mock provider",
  disclosure = "Send the draft fields and selected definitions.",
) => ({
  id,
  label: "Local test assistant",
  provider,
  model: "mock-model",
  operations: id === "components" ? ["lujvo"] : operations,
  disclosure,
});
const log = {
  operation: "type",
  model: "mock-model",
  reasoning_effort: "medium",
  provider: "Mock provider",
  prompt_version: "test-v1",
  prompt_files: ["type.task.txt"],
  started_at: "2026-10-22T12:00:00Z",
  duration_ms: 25,
  answers: 2,
  corrections: 1,
  input_tokens: 30,
  output_tokens: 20,
  cost_usd: 0.002,
  unknown_cost_attempts: 0,
  exchanges: [
    {
      task: "type",
      system_prompt: 'System <img src=x onerror="window.injected=true">',
      request: { meaning: "Original meaning" },
      attempts: [
        {
          attempt: 1,
          reasoning_summary: null,
          text: "<script>window.injected=true</script>",
          tool_calls: [
            { function: { name: "submit_answer", arguments: "{}" } },
          ],
          check: { accepted: false, problems: ["Missing word_type"] },
          usage: { input_tokens: 10, output_tokens: 5 },
          cost_usd: 0.001,
          request: {
            messages: [{ role: "user", content: "Original meaning" }],
          },
          response: { choices: [] },
        },
        {
          attempt: 2,
          reasoning_summary: "A shared summary.",
          text: "The assistant wrote this report.",
          tool_calls: [
            {
              function: {
                name: "submit_answer",
                arguments: '{"word_type":"cmavo"}',
              },
            },
          ],
          check: { accepted: true, problems: [] },
          usage: { input_tokens: 20, output_tokens: 15 },
          cost_usd: 0.001,
          request: { messages: [] },
          response: { choices: [] },
        },
      ],
    },
  ],
};
const compound = {
  components: [
    {
      word: { language: "jbo", spelling: "cukta" },
      definition: null,
      rafsi: "cku",
    },
    {
      word: { language: "jbo", spelling: "sinxa" },
      definition: null,
      rafsi: "sni",
    },
  ],
  morphology: { id: "cll", version: "1" },
  scoring: { id: "cll", version: "1" },
  score: null,
  notes: [],
};
const places = {
  role: "predicate",
  arity: { mode: "fixed", count: 1 },
  places: [
    {
      index: 1,
      description: [["A quantity."]],
      glosses: [{ language: "en", text: "quantity", sense: null }],
      type_hints: [
        {
          alternatives: [
            { tags: ["number"], abstractor: null, relation_arity: null },
          ],
          note: [["number: The definition names a quantity."]],
        },
      ],
      defaults: [],
      constraints: [],
      derivation: [
        {
          word: { language: "jbo", spelling: "klama" },
          definition: null,
          place: 2,
          explanation: [["direct: This place names the destination."]],
        },
      ],
    },
  ],
  tail: null,
  constraints: [],
};
function proposals(body: any): any[] {
  switch (body.operation) {
    case "type":
      return [{ path: "/word_type", value: "cmavo" }];
    case "cmavo-class":
      return [{ path: "/classification/selmaho", value: ["UI"] }];
    case "lujvo":
      return [
        { path: "/compound", value: compound },
        ...(body.profile === "components"
          ? []
          : [{ path: "/spelling", value: "ckusni" }]),
      ];
    case "definition":
      return [{ path: "/text", value: [["An improved definition."]] }];
    case "places-glosses":
      return [
        { path: "/frame", value: places },
        {
          path: "/glosses",
          value: [{ language: "en", text: "quantity", sense: "amount" }],
        },
      ];
    case "gismu-sources": {
      const row = body.current.formation.sources[0];
      return [
        {
          path: "/formation/sources",
          value: [
            {
              ...(row.language === "en"
                ? {
                    word: "book",
                    word_ipa: "bʊk",
                    stem: "book",
                    ipa: "bʊk",
                    input: { format: "lojbanized", text: "buk" },
                  }
                : {}),
              notes:
                row.language === "en"
                  ? [
                      ["Sense: written work"],
                      [
                        "Note: The whole word is the stem.\nA second note line is kept.",
                      ],
                    ]
                  : [["Note: No single source word is known."]],
            },
          ],
        },
      ];
    }
  }
  return [];
}
interface MockOptions {
  nullType?: boolean;
  existing?: {
    word: string;
    event: string;
    conversion: string | null;
    revised_definition: string | null;
  };
  explanation?: string;
  wordType?: string;
  lujvoProposals?: any[];
  deepLog?: boolean;
  delay?: boolean;
  failure?: string;
  invalid?: boolean;
  provider?: string;
  disclosure?: string;
  disabled?: boolean;
  emptyHints?: boolean;
  unknownMapping?: "none" | "unclear";
  mappingKind?: "direct" | "merged" | "distributed" | "functional";
  log?: Record<string, unknown>;
  sourceEdits?: Record<string, unknown>[];
}
async function mockAssistant(page: Page, options: MockOptions = {}) {
  const calls: any[] = [];
  let deleted = 0,
    polls = 0;
  let result: any;
  let released = !options.delay;
  let capabilityReads = 0;
  await page.route("**/api/v1/capabilities", async (route) => {
    capabilityReads++;
    const actual = await route.fetch();
    const caps = await actual.json();
    await route.fulfill({
      json: {
        ...caps,
        features: { ...caps.features, assistance: !options.disabled },
        assistance_profiles: options.disabled
          ? []
          : [
              profile("default", options.provider, options.disclosure),
              profile("components", options.provider, options.disclosure),
            ],
      },
    });
  });
  await page.route("**/api/v1/session", (route) =>
    route.fulfill({ json: { csrf: "disposable-csrf" } }),
  );
  await page.route("**/api/v1/assist", async (route) => {
    const body = route.request().postDataJSON();
    calls.push(body);
    expect(route.request().headers()["x-csrf-token"]).toBe("disposable-csrf");
    result = {
      operation: body.operation,
      draft_revision: body.draft_revision,
      proposals: options.invalid
        ? [{ path: "/identity", value: "bad" }]
        : structuredClone(
            body.operation === "lujvo" && options.lujvoProposals
              ? options.lujvoProposals
              : proposals(body),
          ),
      explanation:
        'A literal explanation <img src=x onerror="window.injected=true">.',
      provenance: {
        provider: "Mock provider",
        model: "mock-model",
        revision: null,
        recipe: "test-v1",
        seed: null,
      },
      usage: { input_tokens: 30, output_tokens: 20 },
      log: options.log ?? log,
    };
    if (body.operation === "type" && options.wordType)
      result.proposals = [{ path: "/word_type", value: options.wordType }];
    if (body.operation === "type") {
      if (options.nullType) result.proposals = [];
      if (options.existing) result.existing = options.existing;
      if (options.explanation) result.explanation = options.explanation;
    }
    if (body.operation === "gismu-sources" && options.sourceEdits)
      result.proposals = [
        {
          path: "/formation/sources",
          value: [
            structuredClone(
              options.sourceEdits[
                Math.min(calls.length - 1, options.sourceEdits.length - 1)
              ],
            ),
          ],
        },
      ];
    if (options.mappingKind && body.operation === "places-glosses") {
      result.proposals.find(
        (p: any) => p.path === "/frame",
      ).value.places[0].derivation[0].explanation = [
        [`${options.mappingKind}: This place names the destination.`],
      ];
    }
    if (options.emptyHints && body.operation === "places-glosses") {
      const frame = result.proposals.find(
        (p: any) => p.path === "/frame",
      ).value;
      frame.places[0].type_hints = [];
      frame.places[0].derivation = [];
      if (options.unknownMapping) {
        const reason = `${options.unknownMapping}: The definition does not identify a component place.`;
        result.log = {
          ...log,
          exchanges: [
            {
              task: "mappings",
              system_prompt:
                "Suggest a supplied component place or an unresolved mapping.",
              request: { keys: ["x1"] },
              attempts: [
                {
                  ...log.exchanges[0].attempts[1],
                  attempt: 1,
                  tool_calls: [
                    {
                      function: {
                        name: "submit_answer",
                        arguments: JSON.stringify({
                          x1: [{ component: options.unknownMapping, reason }],
                        }),
                      },
                    },
                  ],
                },
              ],
            },
          ],
        };
      }
    }
    await route.fulfill({
      status: 202,
      json: {
        job: "local-job",
        expires_at: "2026-10-22T13:00:00Z",
        poll_after_ms: 100,
      },
    });
  });
  await page.route("**/api/v1/jobs/local-job", (route) => {
    if (route.request().method() === "DELETE") {
      deleted++;
      return route.fulfill({
        json: { state: "canceled", result: null, error: null },
      });
    }
    polls++;
    if (!released || polls === 1)
      return route.fulfill({
        json: {
          state: "running",
          result: null,
          error: null,
          progress: { attempt: 2, max_attempts: 3, task: "type" },
        },
      });
    const terminal = {
      state: options.failure ? "failed" : "completed",
      result: options.failure ? null : result,
      error: options.failure
        ? { message: options.failure, log: options.log ?? log }
        : null,
    };
    if (options.deepLog) {
      const nested = `${"[".repeat(10000)}"deep metadata leaf"${"]".repeat(10000)}`;
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(terminal).replaceAll(
          '"DEEP_METADATA_ARRAY"',
          nested,
        ),
      });
    }
    return route.fulfill({ json: terminal });
  });
  return {
    calls,
    release: () => {
      released = true;
    },
    hold: () => {
      released = false;
    },
    deletions: () => deleted,
    capabilityReads: () => capabilityReads,
  };
}
async function draft(
  page: Page,
  patch: Record<string, unknown> = {},
  route = "/new/type",
) {
  await page.goto("/search");
  await page.evaluate(async (patch) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { newDraft } = await import(String("/src/model/draft.ts"));
    const store = new LocalStore();
    await store.put(
      "drafts",
      "current",
      newDraft({
        meaning: "Original meaning",
        text: "Original prose.",
        kind: "gismu",
        spelling: "brodu",
        ...patch,
      }),
    );
  }, patch);
  await page.goto(route);
}
async function stored(page: Page): Promise<any> {
  return page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return new LocalStore().get("drafts", "current");
  });
}
async function allow(page: Page) {
  const dialog = page.getByRole("dialog", {
    name: "Before using AI assistance",
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Allow these tasks" }).click();
}

test("consent precedes sending, suggestions need acceptance, and private logs export inert content", async ({
  page,
}) => {
  const mock = await mockAssistant(page);
  await draft(page);
  const action = page.getByRole("button", {
    name: "Recommend a type",
    exact: true,
  });
  await action.click();
  expect(mock.calls).toHaveLength(0);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Mock provider");
  await expect(dialog).toContainText("original meaning");
  await expect(dialog).toContainText("places-glosses");
  await expect(page.locator(".ai-working")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Not now" }).click();
  await expect(action).toBeFocused();
  expect(mock.calls).toHaveLength(0);
  await action.click();
  await allow(page);
  const panel = page.getByRole("region", {
    name: "Recommend a type suggestion",
  });
  await expect(panel).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Use this", exact: true }),
  ).toBeFocused();
  await expect(page.locator(".ai-action [role=status]")).toHaveText(
    "Suggestion ready.",
  );
  expect((await stored(page)).kind).toBe("gismu");
  expect(mock.calls[0].current).toHaveProperty("frame");
  expect(mock.calls[0].meaning).toBe("Original meaning");
  const open = panel.getByRole("button", { name: "How the assistant decided" });
  await open.click();
  const logDialog = page.getByRole("dialog", {
    name: "How the assistant decided",
  });
  await expect(logDialog).toContainText(
    "No reasoning summary was shared for this answer.",
  );
  await expect(logDialog).toContainText("Missing word_type");
  await expect(logDialog).toContainText("The assistant wrote this report.");
  expect(await page.evaluate(() => Boolean((window as any).injected))).toBe(
    false,
  );
  expect(await logDialog.locator("img,script").count()).toBe(0);
  await expect(
    logDialog.getByRole("link", { name: "type.task.txt" }),
  ).toHaveAttribute("href", /prompts\/type.task.txt/);
  const mdDownload = page.waitForEvent("download");
  await logDialog.getByRole("button", { name: "Export as Markdown" }).click();
  const md = await mdDownload;
  expect(await readFile((await md.path())!, "utf8")).toContain(
    "Missing word_type",
  );
  const rawDownload = page.waitForEvent("download");
  await logDialog.getByRole("button", { name: "Export raw JSON" }).click();
  const raw = await rawDownload;
  expect(JSON.parse(await readFile((await raw.path())!, "utf8"))).toEqual(log);
  await logDialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(open).toBeFocused();
  await panel.getByRole("button", { name: "Use this", exact: true }).click();
  await expect(page.getByRole("radio", { name: /^cmavo/ })).toBeChecked();
  await page.reload();
  await page.getByRole("button", { name: "Undo Recommend a type" }).click();
  await expect(page.getByRole("radio", { name: /^gismu/ })).toBeChecked();
  expect(JSON.parse((await stored(page)).ai.records[0].log_json)).toEqual(log);
});

test("new providers and expanded disclosures require consent and disabling the server preserves the preference", async ({
  page,
}) => {
  const options: MockOptions = {};
  const mock = await mockAssistant(page, options);
  await draft(page);
  await page
    .getByRole("button", { name: "Recommend a type", exact: true })
    .click();
  await allow(page);
  await expect(
    page.getByRole("button", { name: "Dismiss", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Recommend a type", exact: true }),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole("button", { name: "Recommend a type", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Dismiss", exact: true }),
  ).toBeVisible();
  expect(mock.calls).toHaveLength(2);
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  options.provider = "Another provider";
  await expect(
    page.getByRole("button", { name: "Recommend a type", exact: true }),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole("button", { name: "Recommend a type", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("Another provider");
  await allow(page);
  await expect(
    page.getByRole("button", { name: "Dismiss", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  options.disclosure = "Expanded scope also sends selected source definitions.";
  await expect(
    page.getByRole("button", { name: "Recommend a type", exact: true }),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole("button", { name: "Recommend a type", exact: true })
    .click();
  await allow(page);
  await expect(
    page.getByRole("button", { name: "Dismiss", exact: true }),
  ).toBeVisible();
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
  await page.goto("/new/type");
  await expect(
    page.getByRole("button", { name: "Recommend a type" }),
  ).toHaveCount(0);
  options.disabled = true;
  await page.goto("/preferences");
  await expect(
    page.getByText("Not available on this server.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: "Use AI assistance" }),
  ).toHaveCount(0);
  options.disabled = false;
  await page.reload();
  await expect(
    page.getByRole("checkbox", { name: "Use AI assistance" }),
  ).not.toBeChecked();
});

test("a delayed answer reports retries, compares stale fields, and requires renewed review after each edit", async ({
  page,
}) => {
  const mock = await mockAssistant(page, { delay: true });
  await draft(page, { kind: "lujvo", spelling: "ckusni" }, "/new/lujvo");
  await page
    .getByRole("button", {
      name: "Draft definition for this form",
      exact: true,
    })
    .click();
  await allow(page);
  await expect(
    page.getByRole("status").filter({ hasText: "2 of 3" }),
  ).toBeVisible();
  await page
    .getByLabel("Current definition", { exact: true })
    .fill("Newer human prose.");
  mock.release();
  const panel = page.getByRole("region", {
    name: "Draft definition for this form suggestion",
  });
  await expect(panel).toContainText("The draft changed");
  await expect(
    panel.getByRole("button", { name: "Use this", exact: true }),
  ).toBeDisabled();
  const reviewed = panel.getByRole("checkbox", {
    name: "I reviewed the newer fields and want to replace them",
  });
  await reviewed.check();
  await page
    .getByLabel("Current definition", { exact: true })
    .fill("A second human edit.");
  await panel.getByRole("button", { name: "Use this", exact: true }).click();
  await expect(reviewed).not.toBeChecked();
  await expect(
    page.getByLabel("Current definition", { exact: true }),
  ).toHaveValue("A second human edit.");
  await reviewed.check();
  await panel.getByRole("button", { name: "Use this", exact: true }).click();
  await expect(
    page.getByLabel("Current definition", { exact: true }),
  ).toHaveValue("An improved definition.");
  await page
    .getByLabel("Current definition", { exact: true })
    .fill("A later author replacement.");
  await page
    .getByRole("button", { name: "Undo Draft definition for this form" })
    .click();
  await expect(
    page.getByLabel("Current definition", { exact: true }),
  ).toHaveValue("A later author replacement.");
});

test("cancel, navigation, and the off setting cancel jobs without applying delayed answers", async ({
  page,
}) => {
  const mock = await mockAssistant(page, { delay: true });
  await draft(page);
  await page
    .getByRole("button", { name: "Recommend a type", exact: true })
    .click();
  await allow(page);
  await expect(
    page.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.poll(mock.deletions).toBe(1);
  await expect(
    page.getByRole("button", { name: "Recommend a type", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Recommend a type", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect.poll(mock.deletions).toBe(2);
  await page.getByRole("checkbox", { name: "Use AI assistance" }).uncheck();
  mock.release();
  await page.goto("/new/type");
  await expect(page.locator(".ai-action:visible")).toHaveCount(0);
  expect((await stored(page)).kind).toBe("gismu");
});

test("failures and rejected proposal paths leave the manual editor available and retain the log", async ({
  page,
}) => {
  const options: MockOptions = {
    failure:
      "No usable answer after 3 tries. Try again or fill the rows in by hand.",
  };
  await mockAssistant(page, options);
  await draft(page);
  await page
    .getByRole("button", { name: "Recommend a type", exact: true })
    .click();
  await allow(page);
  await expect(page.locator(".ai-action .notice")).toHaveText(options.failure!);
  await expect(
    page.getByRole("button", { name: "Try again", exact: true }),
  ).toBeFocused();
  await expect(page.locator(".ai-action [role=status]")).toHaveText(
    options.failure!,
  );
  await expect(page.getByRole("radio", { name: /^cmavo/ })).toBeEnabled();
  await page.getByRole("button", { name: "How the assistant decided" }).click();
  await expect(page.getByRole("dialog")).toContainText("Missing word_type");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  options.provider = "Changed provider";
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Before using AI assistance" }),
  ).toBeVisible();
  await expect(page.locator(".ai-working")).toHaveCount(0);
  await page.getByRole("button", { name: "Not now", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Try again", exact: true }),
  ).toBeFocused();
  options.provider = undefined;
  options.failure = undefined;
  options.invalid = true;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.locator(".ai-action .notice")).toContainText(
    "outside this action",
  );
  await expect(
    page.getByRole("button", { name: "Use this", exact: true }),
  ).toHaveCount(0);
  expect((await stored(page)).kind).toBe("gismu");
});

test("cmavo class suggestions apply only after review and undo restores the prior class", async ({
  page,
}) => {
  await mockAssistant(page);
  await draft(
    page,
    { kind: "cmavo", spelling: "ui", selmaho: ["COI"] },
    "/new/form",
  );
  await page
    .getByRole("button", { name: "Suggest a selma'o", exact: true })
    .click();
  await allow(page);
  await expect(page.getByLabel("selma'o", { exact: true })).toHaveValue("COI");
  await page.getByRole("button", { name: "Use this", exact: true }).click();
  await expect(page.getByLabel("selma'o", { exact: true })).toHaveValue("UI");
  await page.reload();
  await page.getByRole("button", { name: "Undo Suggest a selma'o" }).click();
  await expect(page.getByLabel("selma'o", { exact: true })).toHaveValue("COI");
});

test("both lujvo actions pass proposals through deterministic construction and preserve prose", async ({
  page,
}) => {
  const mock = await mockAssistant(page);
  await draft(page, { kind: "lujvo", spelling: "" }, "/new/lujvo");
  await page
    .getByRole("button", { name: "Suggest components", exact: true })
    .click();
  await allow(page);
  await page.getByRole("button", { name: "Use this", exact: true }).click();
  await expect(page.getByRole("region", { name: "Result" })).toContainText(
    "ckusni",
  );
  expect((await stored(page)).text).toEqual([["Original prose."]]);
  expect(mock.calls[0].profile).toBe("components");
  await page
    .getByRole("button", { name: "Suggest a lujvo", exact: true })
    .click();
  const panel = page.getByRole("region", {
    name: "Suggest a lujvo suggestion",
  });
  await expect(
    panel.getByRole("button", { name: "Use this", exact: true }),
  ).toBeEnabled();
  await panel.getByRole("button", { name: "Use this", exact: true }).click();
  expect((await stored(page)).spelling).toBe("ckusni");
  await expect(page.getByRole("region", { name: "Result" })).toContainText(
    "ckusni",
  );
});

test("places, glosses, type reasons, and component mappings are reviewed together", async ({
  page,
}) => {
  await mockAssistant(page);
  await draft(
    page,
    {
      kind: "lujvo",
      spelling: "ckusni",
      text: "A quantity.",
      frameMode: "none",
    },
    "/new/places",
  );
  await page
    .getByRole("button", { name: "Suggest places and glosses", exact: true })
    .click();
  await allow(page);
  const panel = page.getByRole("region", {
    name: "Suggest places and glosses suggestion",
  });
  await expect(panel).toContainText("The definition names a quantity.");
  await expect(panel).toContainText(
    "direct: This place names the destination.",
  );
  await panel.getByRole("button", { name: "Use this", exact: true }).click();
  const d = await stored(page);
  expect(d.frameMode).toBe("fixed");
  expect(d.glosses[0].text).toBe("quantity");
  expect(d.places[0].hint.alternatives[0].tags).toEqual(["number"]);
  expect(d.places[0].derivations[0]).toMatchObject({ word: "klama", place: 2 });
  expect(d.numberingApproved).toBe(false);
  await page.reload();
  await page
    .getByRole("button", { name: "Undo Suggest places and glosses" })
    .click();
  expect((await stored(page)).places).toEqual([]);
});

test("source requests cover each language and retain empty rows, pronunciation, and notes", async ({
  page,
}) => {
  const mock = await mockAssistant(page);
  await draft(
    page,
    {
      kind: "gismu",
      gismu: {
        preset: null,
        rows: [
          {
            language: "en",
            name: "English",
            word: "",
            input: "",
            aiNoteGroup: [],
            weight: { numerator: "1", denominator: "1" },
          },
          {
            language: "ja",
            name: "Japanese",
            word: "",
            input: "",
            aiNoteGroup: [],
            weight: { numerator: "1", denominator: "1" },
          },
        ],
        candidates: "source-letters",
        selected: null,
        manual: "",
        acknowledged: [],
        reason: "",
        window: 12,
      },
    },
    "/new/gismu",
  );
  await page
    .getByRole("button", { name: "Suggest source words", exact: true })
    .click();
  await allow(page);
  const english = page.getByRole("region", {
    name: "Suggest source for English suggestion",
  });
  const japanese = page.getByRole("region", {
    name: "Suggest source for Japanese suggestion",
  });
  await expect(english).toContainText("bʊk");
  await expect(japanese).toContainText("No single source word");
  expect(mock.calls).toHaveLength(2);
  expect(mock.calls.map((c) => c.current.formation.sources.length)).toEqual([
    1, 1,
  ]);
  expect(
    mock.calls.map((c) => c.current.formation.sources[0].language),
  ).toEqual(["en", "ja"]);
  await english.getByRole("button", { name: "Use this", exact: true }).click();
  await expect(
    page.getByLabel("Native word for English", { exact: true }),
  ).toHaveValue("book");
  await expect(
    page.getByLabel("Said for English", { exact: true }),
  ).toHaveValue("bʊk");
  await expect(
    page.getByLabel("Stem for English", { exact: true }),
  ).toHaveValue("book");
  await expect(
    page.getByLabel("Stem said for English", { exact: true }),
  ).toHaveValue("bʊk");
  await expect(page.getByLabel("Scoring letters for English")).toHaveValue(
    "buk",
  );
  const missing = page.getByRole("region", {
    name: "Suggest source for Japanese suggestion",
  });
  await missing
    .getByRole("checkbox", {
      name: "I reviewed the newer fields and want to replace them",
    })
    .check();
  await missing.getByRole("button", { name: "Use this", exact: true }).click();
  await expect(
    page.getByLabel("Native word for Japanese", { exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByLabel("Source notes for Japanese", { exact: true }),
  ).toHaveValue("Note: No single source word is known.");
  expect((await stored(page)).gismu.rows).toHaveLength(2);
  await page.reload();
  await page
    .getByRole("button", { name: "Undo Suggest source for Japanese" })
    .click();
  expect((await stored(page)).gismu.rows[0].word).toBe("book");
  expect((await stored(page)).gismu.rows[0].note).toBe(
    "The whole word is the stem.\nA second note line is kept.",
  );
  const exported = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export draft", exact: true }).click();
  const file = await exported;
  const savedExport = JSON.parse(await readFile((await file.path())!, "utf8"));
  expect(savedExport.gismu.rows[0].note).toBe(
    "The whole word is the stem.\nA second note line is kept.",
  );
});

test("browser requests reach the Node service and a mocked provider with a correction", async ({
  page,
}) => {
  await draft(page, { meaning: "Real browser wiring" });
  await page
    .getByRole("button", { name: "Recommend a type", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("Local browser fixture");
  await allow(page);
  const panel = page.getByRole("region", {
    name: "Recommend a type suggestion",
  });
  await expect(panel).toContainText("A grammar word fits this meaning.");
  await panel
    .getByRole("button", { name: "How the assistant decided" })
    .click();
  await expect(page.getByRole("dialog")).toContainText("Corrections: 1");
  await expect(page.getByRole("dialog")).toContainText(
    "Shared local mock reasoning.",
  );
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await panel.getByRole("button", { name: "Use this", exact: true }).click();
  await expect(page.getByRole("radio", { name: /^cmavo/ })).toBeChecked();
  const saved = await stored(page);
  expect(
    JSON.parse(saved.ai.records[0].log_json).exchanges[0].attempts,
  ).toHaveLength(2);
  expect(JSON.stringify(saved)).not.toContain("browser-fixture-only");
});

test("consent cannot start duplicate runs and cancel then restart keeps the new job isolated", async ({
  page,
}) => {
  const mock = await mockAssistant(page, { delay: true });
  await draft(page);
  const action = page.getByRole("button", {
    name: "Recommend a type",
    exact: true,
  });
  await action.dblclick();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await allow(page);
  await expect(
    page.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await action.click();
  await expect.poll(() => mock.calls.length).toBe(2);
  mock.release();
  await expect(
    page.getByRole("region", { name: "Recommend a type suggestion" }),
  ).toBeVisible();
  expect((await stored(page)).ai.records).toHaveLength(1);
});

test("AI type changes use the ordinary removal confirmation and persistent undo keeps classification evidence", async ({
  page,
}) => {
  await mockAssistant(page);
  await draft(page, {
    kind: "gismu",
    selmaho: ["EXPERIMENTAL"],
    formation: {
      method: "non-algorithmic",
      algorithm: null,
      sources: [],
      weights_profile: null,
      generated: null,
      selected_score: null,
      selected_rank: null,
      selection_reason: [["Human evidence"]],
      candidates: [],
      conflicts: [],
    },
    evidenceForm: "brodu",
  });
  await page
    .getByRole("button", { name: "Recommend a type", exact: true })
    .click();
  await allow(page);
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Use this", exact: true }).click();
  expect((await stored(page)).kind).toBe("gismu");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Use this", exact: true }).click();
  expect((await stored(page)).formation).toBeNull();
  expect((await stored(page)).selmaho).toEqual([]);
  await page.reload();
  await page.getByRole("button", { name: "Undo Recommend a type" }).click();
  const restored = await stored(page);
  expect(restored.kind).toBe("gismu");
  expect(restored.selmaho).toEqual(["EXPERIMENTAL"]);
  expect(restored.formation.selection_reason).toEqual([["Human evidence"]]);
});

test("place panels add a missing component mapping with persistent undo and show accepted alternatives", async ({
  page,
}) => {
  await mockAssistant(page);
  await draft(
    page,
    {
      kind: "lujvo",
      spelling: "ckusni",
      frameMode: "fixed",
      places: [
        {
          index: 1,
          description: [["A quantity."]],
          glosses: [],
          kind: "unspecified",
          hint: null,
          derivations: [],
          defaults: [],
          constraints: [],
        },
      ],
    },
    "/new/places",
  );
  await page
    .getByRole("button", { name: "Suggest places and glosses", exact: true })
    .click();
  await allow(page);
  let panel = page.getByRole("region", {
    name: "Suggest places and glosses suggestion",
  });
  await expect(panel).toContainText("klama 2 · direct");
  await panel
    .getByRole("button", { name: "Add klama 2 to place 1", exact: true })
    .click();
  await expect
    .poll(async () => (await stored(page)).places[0].derivations.length)
    .toBe(1);
  await page.reload();
  await expect(
    page.getByLabel("Source word of derivation 1 for place 1", { exact: true }),
  ).toHaveValue("klama");
  panel = page.getByRole("region", {
    name: "Suggest places and glosses suggestion",
  });
  await panel
    .getByRole("button", {
      name: "Undo mapping klama 2 to place 1",
      exact: true,
    })
    .click();
  await expect
    .poll(async () => (await stored(page)).places[0].derivations.length)
    .toBe(0);
  await expect(
    page.getByLabel("Source word of derivation 1 for place 1", { exact: true }),
  ).toHaveCount(0);
  await panel.getByRole("button", { name: "Use this", exact: true }).click();
  await expect(
    page.getByLabel("Kind of thing for place 1", { exact: true }),
  ).toHaveValue("custom");
  await expect(
    page
      .getByLabel("Kind of thing for place 1", { exact: true })
      .locator("option:checked"),
  ).toHaveText("number");
  await expect(
    page.getByText("klama 2 · direct", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".ai-hint-line")).toContainText(
    "The definition names a quantity.",
  );
  await page
    .getByLabel("Explanation of derivation 1 for place 1", { exact: true })
    .fill("merged: This place covers both sources.");
  await expect(
    page.getByText("klama 2 · merged", { exact: true }),
  ).toBeVisible();
});

for (const unknown of ["none", "unclear"] as const) {
  test(`empty hints show unspecified and retain the ${unknown} mapping reason privately`, async ({
    page,
  }) => {
    await mockAssistant(page, { emptyHints: true, unknownMapping: unknown });
    await draft(page, { kind: "lujvo", spelling: "ckusni" }, "/new/places");
    await page
      .getByRole("button", { name: "Suggest places and glosses", exact: true })
      .click();
    await allow(page);
    const panel = page.getByRole("region", {
      name: "Suggest places and glosses suggestion",
    });
    await expect(
      panel.getByRole("cell", { name: "unspecified", exact: true }),
    ).toBeVisible();
    await panel.getByRole("button", { name: "Use this", exact: true }).click();
    await expect(
      page.getByLabel("Kind of thing for place 1", { exact: true }),
    ).toHaveValue("unspecified");
    const saved = await stored(page);
    expect(saved.places[0].derivations).toEqual([]);
    expect(saved.places[0].hint).toBeNull();
    await page
      .locator('[data-ai-action="places-glosses"]')
      .getByRole("button", { name: "How the assistant decided", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toContainText(
      `${unknown}: The definition does not identify a component place.`,
    );
  });
}

for (const [action, lock] of [
  ["Suggest components", null],
  ["Suggest a lujvo", null],
  ["Suggest a lujvo", "cku"],
] as const) {
  test(`actual service ${action} honors one selected component${lock ? " with a rafsi lock" : ""} and keeps the author prose`, async ({
    page,
  }) => {
    const definition = fixture().definitions.cukta1;
    await draft(
      page,
      {
        kind: "lujvo",
        spelling: "",
        text: "Human draft prose.",
        lujvo: {
          profile: "cll",
          components: [
            {
              id: "selected-book",
              spelling: "cukta",
              kind: "gismu",
              definition,
              gloss: "book",
              claims: [],
              locked: lock,
            },
          ],
          selected: null,
          acknowledged: [],
        },
      },
      "/new/lujvo",
    );
    const sent = page.waitForRequest(
      (request) =>
        request.url().endsWith("/api/v1/assist") && request.method() === "POST",
    );
    await page.getByRole("button", { name: action, exact: true }).click();
    await allow(page);
    const current = (await sent).postDataJSON().current;
    expect(current.compound.components).toEqual([
      {
        word: { language: "jbo", spelling: "cukta" },
        definition,
        rafsi: lock ?? "",
      },
    ]);
    expect(current.compound.morphology.id).toMatch(/^https:\/\//);
    expect(current.compound.scoring.id).toMatch(/^https:\/\//);
    const panel = page.getByRole("region", { name: `${action} suggestion` });
    await expect(panel).toContainText(
      "Keep the selected book component and add a sign component.",
    );
    await panel.getByRole("button", { name: "Use this", exact: true }).click();
    await expect(page.getByRole("region", { name: "Result" })).toContainText(
      "Recovered parts",
    );
    const saved = await stored(page);
    expect(
      saved.lujvo.components.map((component: any) => component.spelling),
    ).toEqual(["cukta", "sinxa"]);
    expect(saved.lujvo.components[0].definition).toBe(definition);
    if (lock) expect(saved.lujvo.components[0].locked).toBe(lock);
    expect(saved.text).toEqual([["Human draft prose."]]);
    expect(
      JSON.parse(saved.ai.records[0].log_json).exchanges[0].request,
    ).toContain(definition);
  });
}

test("actual service resolves component labels to the chosen exact definitions through acceptance and reload", async ({
  page,
}) => {
  const definitions = fixture().definitions;
  const chosen = [definitions.cukta2, definitions.dunda2];
  await draft(
    page,
    {
      kind: "lujvo",
      spelling: "",
      text: "Human prose about donating a volume.",
      lujvo: {
        profile: "cll",
        components: ["cukta", "dunda"].map((spelling, index) => ({
          id: `chosen-${spelling}`,
          spelling,
          kind: "gismu",
          definition: chosen[index],
          gloss: "",
          claims: [],
          locked: null,
        })),
        selected: null,
        acknowledged: [],
      },
    },
    "/new/lujvo",
  );
  const sent = page.waitForRequest(
    (request) =>
      request.url().endsWith("/api/v1/assist") && request.method() === "POST",
  );
  await page
    .getByRole("button", { name: "Suggest components", exact: true })
    .click();
  await allow(page);
  const browserRequest = (await sent).postDataJSON();
  expect(browserRequest.context).toEqual(chosen);
  expect(
    browserRequest.current.compound.components.map(
      (component: any) => component.definition,
    ),
  ).toEqual(chosen);
  const panel = page.getByRole("region", {
    name: "Suggest components suggestion",
  });
  await expect(
    panel.getByRole("button", { name: "Use this", exact: true }),
  ).toBeEnabled();
  const pending = await stored(page);
  const record = pending.ai.records[0];
  const exchange = JSON.parse(record.log_json).exchanges[0];
  const modelRequest = JSON.parse(exchange.request);
  expect(
    modelRequest.definitions.map((definition: any) => ({
      label: definition.label,
      event: definition.event,
    })),
  ).toEqual([
    { label: "d1", event: chosen[0] },
    { label: "d2", event: chosen[1] },
  ]);
  expect(
    modelRequest.current.compound.components.map(
      (component: any) => component.definition,
    ),
  ).toEqual(["d1", "d2"]);
  expect(exchange.attempts).toHaveLength(1);
  const modelAnswer = JSON.parse(
    exchange.attempts[0].tool_calls[0].function.arguments,
  );
  expect(modelAnswer.components).toEqual([
    { spelling: "cukta", definition: "d1" },
    { spelling: "dunda", definition: "d2" },
  ]);
  expect(JSON.stringify(modelAnswer)).not.toContain(chosen[0]);
  expect(JSON.stringify(modelAnswer)).not.toContain(chosen[1]);
  expect(exchange.attempts[0].check).toEqual({ accepted: true, problems: [] });
  expect(
    record.result.proposals
      .find((proposal: any) => proposal.path === "/compound")
      .value.components.map((component: any) => component.definition),
  ).toEqual(chosen);
  await panel.getByRole("button", { name: "Use this", exact: true }).click();
  const accepted = await stored(page);
  expect(
    accepted.lujvo.components.map((component: any) => component.definition),
  ).toEqual(chosen);
  expect(accepted.text).toEqual([["Human prose about donating a volume."]]);
  await page.reload();
  const reloaded = await stored(page);
  expect(
    reloaded.lujvo.components.map((component: any) => component.definition),
  ).toEqual(chosen);
  expect(reloaded.ai.records[0].log_json).toEqual(record.log_json);
  expect(reloaded.text).toEqual(accepted.text);
});

test("actual service accepts an English source from the default language preset without changing its tag", async ({
  page,
}) => {
  await draft(page, { kind: "gismu" }, "/new/gismu");
  const sent = page.waitForRequest(
    (request) =>
      request.url().endsWith("/api/v1/assist") && request.method() === "POST",
  );
  await page
    .getByRole("button", { name: "Suggest source for English", exact: true })
    .click();
  await allow(page);
  const request = (await sent).postDataJSON();
  expect(request.current.formation.sources).toHaveLength(1);
  expect(request.current.formation.sources[0].language).toBe("eng");
  expect(request.current.formation.sources[0].weight).toEqual({
    numerator: 4,
    denominator: 25,
  });
  const panel = page.getByRole("region", {
    name: "Suggest source for English suggestion",
  });
  await expect(panel).toContainText("eng: book");
  await panel.getByRole("button", { name: "Use this", exact: true }).click();
  await expect(
    page.getByLabel("Native word for English", { exact: true }),
  ).toHaveValue("book");
  await expect(
    page.getByLabel("Said for English", { exact: true }),
  ).toHaveValue("bʊk");
  await expect(
    page.getByLabel("Stem for English", { exact: true }),
  ).toHaveValue("book");
  await expect(
    page.getByLabel("Stem said for English", { exact: true }),
  ).toHaveValue("bʊk");
  await expect(
    page.getByLabel("Scoring letters for English", { exact: true }),
  ).toHaveValue("buk");
  const saved = await stored(page);
  expect(saved.gismu.rows.find((row: any) => row.language === "eng").word).toBe(
    "book",
  );
  expect(saved.ai.records[0].result.proposals[0].value[0]).not.toHaveProperty(
    "language",
  );
  expect(saved.ai.records[0].result.proposals[0].value[0]).not.toHaveProperty(
    "weight",
  );
  expect(JSON.parse(saved.ai.records[0].log_json).exchanges[0].task).toBe(
    "sources",
  );
  expect(saved.ai.records[0].result.proposals[0].value[0]).toMatchObject({
    word_ipa: "bʊk",
    stem: "book",
    ipa: "bʊk",
  });
  const originalProfile = await page
    .getByLabel("Weights", { exact: true })
    .inputValue();
  await page.getByLabel("Weights", { exact: true }).selectOption("custom");
  await page
    .getByLabel("Weights", { exact: true })
    .selectOption(originalProfile);
  await expect(
    page.getByLabel("Said for English", { exact: true }),
  ).toHaveValue("bʊk");
  await expect(
    page.getByLabel("Stem for English", { exact: true }),
  ).toHaveValue("book");
  await expect(
    page.getByLabel("Stem said for English", { exact: true }),
  ).toHaveValue("bʊk");
  await page
    .getByLabel("Said for English", { exact: true })
    .fill("edited pronunciation");
  await page.getByLabel("Stem for English", { exact: true }).fill("");
  await expect
    .poll(
      async () =>
        (await stored(page)).gismu.rows.find(
          (row: any) => row.language === "eng",
        ).word_ipa,
    )
    .toBe("edited pronunciation");
  await page.reload();
  await expect(
    page.getByLabel("Said for English", { exact: true }),
  ).toHaveValue("edited pronunciation");
  await expect(
    page.getByLabel("Stem for English", { exact: true }),
  ).toHaveValue("");
  await page.getByRole("link", { name: "Enter without generation" }).click();
  await page.getByRole("button", { name: "Use brodu", exact: true }).click();
  await expect(page).toHaveURL(/\/new\/places$/);
  const bodyEvidence = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { draftToBody, draftFromBody } = await import(
      String("/src/model/draft.ts")
    );
    const draft = await new LocalStore().get("drafts", "current");
    const built = draftToBody(draft);
    const revision = draftToBody(
      draftFromBody(built.body, "jve1:" + "1".repeat(64), "native"),
    );
    return {
      body: built.body,
      problems: built.problems,
      revision: revision.body,
    };
  });
  expect(bodyEvidence.problems).toEqual([]);
  const source = bodyEvidence.body.etymology.formation.sources.find(
    (row: any) => row.language === "eng",
  );
  expect(source).toMatchObject({
    word: "book",
    word_ipa: "edited pronunciation",
  });
  expect(source).not.toHaveProperty("stem");
  expect(source).not.toHaveProperty("ipa");
  expect(bodyEvidence.revision.etymology.formation).toEqual(
    bodyEvidence.body.etymology.formation,
  );
  const exported = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export draft", exact: true }).click();
  const savedExport = JSON.parse(
    await readFile((await (await exported).path())!, "utf8"),
  );
  expect(savedExport.formation).toEqual(bodyEvidence.body.etymology.formation);
});

async function sourceDraft(page: Page, row: Record<string, unknown>) {
  await draft(
    page,
    {
      kind: "gismu",
      gismu: {
        preset: null,
        rows: [
          {
            id: "source-review-row",
            language: "en",
            name: "English",
            word: "old",
            input: "buk",
            weight: { numerator: "1", denominator: "1" },
            aiNoteGroup: [],
            ...row,
          },
        ],
        candidates: "source-letters",
        selected: "makru",
        manual: "makru",
        acknowledged: [],
        reason: "",
        window: 12,
      },
    },
    "/new/gismu",
  );
}

async function sourceSuggestion(page: Page, first = true) {
  await page
    .getByRole("button", { name: "Suggest source for English", exact: true })
    .click();
  if (first) await allow(page);
  const panel = page.getByRole("region", {
    name: "Suggest source for English suggestion",
  });
  await expect(panel).toBeVisible();
  return panel;
}

test("source preview preserves omitted values and replaces only the tracked AI notes", async ({
  page,
}) => {
  await mockAssistant(page, {
    sourceEdits: [
      { notes: [["Sense: new meaning"], ["Note: new AI note"]] },
      { notes: [] },
    ],
  });
  const ai = ["Note: earlier AI note"];
  await sourceDraft(page, {
    word: "book",
    word_ipa: "bʊk",
    stem: "book",
    ipa: "bʊk",
    notes: [["Authored first"], ai, ["Authored last"]],
    aiNoteGroup: [{ index: 1, paragraph: ai }],
  });
  const panel = await sourceSuggestion(page);
  await expect(panel).toContainText("bʊk (retained)");
  await expect(panel).toContainText("Earlier AI notes replaced");
  await expect(panel).toContainText("Authored first");
  await panel.getByRole("button", { name: "Use this", exact: true }).click();
  await expect(
    page.getByLabel("Source notes for English", { exact: true }),
  ).toHaveValue(
    "Authored first\n\nSense: new meaning\n\nNote: new AI note\n\nAuthored last",
  );
  await page
    .getByLabel("Source notes for English", { exact: true })
    .fill(
      "Authored first\n\nSense: edited by author\n\nNote: new AI note\n\nAuthored last",
    );
  await page
    .getByRole("button", { name: "Suggest again", exact: true })
    .click();
  const next = await sourceSuggestion(page, false);
  await next.getByRole("button", { name: "Use this", exact: true }).click();
  await expect(
    page.getByLabel("Source notes for English", { exact: true }),
  ).toHaveValue("Authored first\n\nSense: edited by author\n\nAuthored last");
  const row = (await stored(page)).gismu.rows[0];
  expect(row).toMatchObject({
    word: "book",
    word_ipa: "bʊk",
    stem: "book",
    ipa: "bʊk",
    input: "buk",
    aiNoteGroup: [],
  });
  expect(row.sourceReview ?? []).toEqual([]);
});

test("a changed source row requires a new request even after stale comparison", async ({
  page,
}) => {
  const mock = await mockAssistant(page, {
    delay: true,
    sourceEdits: [{ word: "book", notes: [] }],
  });
  await sourceDraft(page, { word: "old" });
  await page
    .getByRole("button", { name: "Suggest source for English", exact: true })
    .click();
  await allow(page);
  await expect.poll(() => mock.calls.length).toBe(1);
  await page
    .getByLabel("Native word for English", { exact: true })
    .fill("author edit");
  await expect(
    page.getByLabel("Native word for English", { exact: true }),
  ).toHaveValue("author edit");
  await expect
    .poll(async () => (await stored(page)).gismu.rows[0].word)
    .toBe("author edit");
  mock.release();
  const panel = page.getByRole("region", {
    name: "Suggest source for English suggestion",
  });
  await expect(panel).toContainText(
    "This source row changed. Request a new suggestion.",
  );
  await panel
    .getByRole("checkbox", {
      name: "I reviewed the newer fields and want to replace them",
      exact: true,
    })
    .check();
  await expect(
    panel.getByRole("button", { name: "Use this", exact: true }),
  ).toHaveCount(0);
  await panel
    .getByRole("button", {
      name: "Request a new source suggestion",
      exact: true,
    })
    .click();
  await expect.poll(() => mock.calls.length).toBe(2);
  expect(mock.calls[1].current.formation.sources[0].word).toBe("author edit");
  expect((await stored(page)).gismu.rows[0].word).toBe("author edit");
});

test("a reordered unchanged source applies to its stable private row after comparison", async ({
  page,
}) => {
  await mockAssistant(page, { sourceEdits: [{ word: "book", notes: [] }] });
  await sourceDraft(page, { word: "old" });
  const panel = await sourceSuggestion(page);
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const value = (await store.get("drafts", "current")) as any;
    value.gismu.rows.unshift({
      id: "other-source",
      language: "en",
      name: "English alternative",
      word: "unchanged",
      input: "buk",
      aiNoteGroup: [],
      weight: { numerator: "1", denominator: "1" },
    });
    await store.put("drafts", "current", value);
  });
  await page.reload();
  await expect(
    panel.getByRole("button", { name: "Use this", exact: true }),
  ).toBeDisabled();
  await panel
    .getByRole("checkbox", {
      name: "I reviewed the newer fields and want to replace them",
      exact: true,
    })
    .check();
  await panel.getByRole("button", { name: "Use this", exact: true }).click();
  await expect(
    page.getByLabel("Native word for English", { exact: true }),
  ).toHaveValue("book");
  const rows = (await stored(page)).gismu.rows;
  expect(rows.map((row: any) => [row.id, row.word])).toEqual([
    ["other-source", "unchanged"],
    ["source-review-row", "book"],
  ]);
});

test("legacy source notes require an explicit earlier AI group choice", async ({
  page,
}) => {
  await mockAssistant(page, {
    sourceEdits: [{ notes: [["Note: replacement"]] }],
  });
  await sourceDraft(page, {
    notes: [["Sense: authored prefix"], ["Note: old AI"]],
  });
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const value = (await store.get("drafts", "current")) as any;
    delete value.gismu.rows[0].aiNoteGroup;
    await store.put("drafts", "current", value);
  });
  await page.reload();
  const panel = await sourceSuggestion(page);
  await expect(
    panel.getByRole("button", { name: "Use this", exact: true }),
  ).toBeDisabled();
  await panel
    .getByRole("checkbox", {
      name: "Earlier AI paragraph 2: Note: old AI",
      exact: true,
    })
    .check();
  await panel
    .getByRole("button", {
      name: "Use the selected earlier AI notes",
      exact: true,
    })
    .click();
  await expect(
    panel.getByRole("checkbox", {
      name: "I reviewed the newer fields and want to replace them",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(panel).not.toContainText(
    "The draft changed while this suggestion was made.",
  );
  await panel.getByRole("button", { name: "Use this", exact: true }).click();
  await expect(
    page.getByLabel("Source notes for English", { exact: true }),
  ).toHaveValue("Sense: authored prefix\n\nNote: replacement");
});

test("a changed suggested word reviews retained identical values and original IPA input through reload and undo", async ({
  page,
}) => {
  await mockAssistant(page, {
    sourceEdits: [
      {
        word: "new",
        word_ipa: "oʊld",
        stem: "old",
        ipa: "oʊld",
        notes: [["Note: new source"]],
      },
    ],
  });
  await sourceDraft(page, {
    word_ipa: "oʊld",
    stem: "old",
    ipa: "oʊld",
    input: "",
    inputOriginal: { format: "ipa", text: "oʊld" },
    notes: [["Authored one"], ["Authored two"]],
  });
  await page
    .getByRole("link", { name: "Enter without generation", exact: true })
    .click();
  await page.getByRole("button", { name: "Use brodu", exact: true }).click();
  await expect(page).toHaveURL(/\/new\/places$/);
  await expect
    .poll(async () => (await stored(page)).formation)
    .toMatchObject({
      method: "non-algorithmic",
      sources: [
        {
          language: "en",
          word: "old",
          input: { format: "ipa", text: "oʊld" },
        },
      ],
    });
  await page.goto("/new/gismu");
  const panel = await sourceSuggestion(page);
  await expect(panel).toContainText("oʊld (proposed)");
  await expect(panel).toContainText("ipa");
  await panel.getByRole("button", { name: "Use this", exact: true }).click();
  const review = page.getByRole("region", {
    name: "Retained source evidence for English",
  });
  await expect(review).toContainText('earlier word "old"');
  for (const label of [
    "Said",
    "Stem",
    "Stem said",
    "Letters",
    "Notes paragraph 1",
    "Notes paragraph 2",
  ])
    await expect(
      review.getByRole("button", {
        name: `Keep ${label} for English`,
        exact: true,
      }),
    ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Use makru", exact: true }),
  ).toBeDisabled();
  const before = (await stored(page)).gismu.rows[0];
  expect(before.sourceReview).toHaveLength(6);
  await page.reload();
  await expect(
    review.getByRole("button", {
      name: "Keep Letters for English",
      exact: true,
    }),
  ).toBeVisible();
  const problems = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { draftToBody } = await import(String("/src/model/draft.ts"));
    return draftToBody((await new LocalStore().get("drafts", "current")) as any)
      .problems;
  });
  expect(problems).toContainEqual(
    expect.objectContaining({
      field: "formation",
      blocking: true,
      message:
        "The source evidence needs review. Keep or clear each retained value for its new word.",
    }),
  );
  await page.goto("/new/publish");
  await expect(page.locator("main")).toContainText(
    "The source evidence needs review. Keep or clear each retained value for its new word.",
  );
  for (const publish of await page
    .getByRole("button", { name: "Publish", exact: true })
    .all())
    await expect(publish).toBeDisabled();
  await page.goto("/new/gismu");
  await review
    .getByRole("button", {
      name: "Clear Notes paragraph 1 for English",
      exact: true,
    })
    .click();
  await expect(
    page.getByLabel("Source notes for English", { exact: true }),
  ).toHaveValue("Authored two\n\nNote: new source");
  while (await review.getByRole("button", { name: /^Keep / }).count())
    await review
      .getByRole("button", { name: /^Keep / })
      .first()
      .click();
  await expect(review).toHaveCount(0);
  await page
    .getByRole("button", {
      name: "Undo Suggest source for English",
      exact: true,
    })
    .click();
  await expect(
    page.getByLabel("Native word for English", { exact: true }),
  ).toHaveValue("old");
  // A review choice is an author edit. Undo preserves that edit and restores unchanged values.
  const undone = (await stored(page)).gismu.rows[0];
  expect(undone.sourceReview ?? []).toEqual([]);
  expect(undone.word_ipa).toBe("oʊld");
});

test("operator-disabled assistance hides saved AI decorations and preserves accepted fields and the preference", async ({
  page,
}) => {
  const options: MockOptions = {};
  const mock = await mockAssistant(page, options);
  const accepted = (key: string, operation: string, values: any[]) => ({
    id: `saved-${key}`,
    key,
    label: key,
    operation,
    fingerprint: "saved",
    requested: {
      word_type: "gismu",
      classification: { kind: "gismu", selmaho: [] },
      spelling: "brodu",
      text: [["Original prose."]],
      frame: null,
      glosses: [],
      formation: null,
      compound: null,
    },
    result: {
      operation,
      draft_revision: "saved",
      proposals: values,
      explanation: "Saved AI suggestion.",
      provenance: {
        provider: "Mock provider",
        model: "mock-model",
        revision: null,
        recipe: "test-v1",
        seed: null,
      },
      usage: null,
      log,
    },
    log,
    error: null,
    state: "accepted",
    patches: [],
  });
  await draft(page, {
    kind: "gismu",
    frameMode: "fixed",
    places: [
      {
        index: 1,
        description: [["A quantity."]],
        glosses: [],
        kind: "custom",
        hint: places.places[0].type_hints[0],
        derivations: [],
        defaults: [],
        constraints: [],
      },
    ],
    gismu: {
      preset: null,
      rows: [
        {
          language: "eng",
          name: "English",
          word: "book",
          input: "buk",
          weight: { numerator: "1", denominator: "1" },
          word_ipa: "bʊk",
          stem: "book",
          ipa: "bʊk",
          sense: "written work",
          note: "Accepted source note.",
        },
      ],
      candidates: "source-letters",
      selected: null,
      manual: "",
      acknowledged: [],
      reason: "",
      window: 12,
    },
    ai: {
      records: [
        accepted("type", "type", [{ path: "/word_type", value: "cmavo" }]),
        accepted("places-glosses", "places-glosses", [
          { path: "/frame", value: places },
        ]),
        accepted("source-0-eng", "gismu-sources", [
          { path: "/formation/sources", value: [] },
        ]),
      ],
    },
  });
  await expect(page.locator(".ai-action")).toBeVisible();
  for (const [path, decoration] of [
    ["/new/type", ".ai-pick"],
    ["/new/places", ".ai-hint-line"],
    ["/new/gismu", ".ai-source-actions"],
  ]) {
    options.disabled = false;
    const before = mock.capabilityReads();
    await page.goto(path);
    await expect(page.locator(decoration)).toBeVisible();
    expect(mock.capabilityReads() - before).toBe(1);
    if (path === "/new/gismu")
      await expect(
        page.getByLabel("Source notes for English", { exact: true }),
      ).toHaveValue("Sense: written work\n\nNote: Accepted source note.");
    options.disabled = true;
    const disabledCapabilities = page.waitForResponse((response) =>
      response.url().endsWith("/api/v1/capabilities"),
    );
    await page.reload();
    await disabledCapabilities;
    await expect(page.locator("main h1")).toBeVisible();
    await expect(page.locator(decoration)).not.toBeVisible();
    await expect(
      page.locator(
        ".ai-tag:visible,.ai-action:visible,.ai-hint-line:visible,.ai-source-note:visible,.ai-source-sense:visible,.ai-source-actions:visible",
      ),
    ).toHaveCount(0);
    if (path === "/new/gismu") {
      await expect(
        page.getByLabel("Native word for English", { exact: true }),
      ).toHaveValue("book");
      await expect(
        page.getByLabel("Source notes for English", { exact: true }),
      ).toBeVisible();
    }
    if (path === "/new/places")
      await expect(
        page.getByRole("textbox", { name: "Definition text", exact: true }),
      ).toHaveValue("Original prose.");
  }
  expect(mock.calls).toHaveLength(0);
  await page.goto("/preferences");
  await expect(
    page.getByText("Not available on this server.", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(async () => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      return (await new LocalStore().preferences()).useAiAssistance;
    }),
  ).toBe(true);
  options.disabled = false;
  await page.reload();
  await expect(
    page.getByRole("checkbox", { name: "Use AI assistance", exact: true }),
  ).toBeChecked();
  await page.goto("/new/gismu");
  await expect(
    page.getByLabel("Source notes for English", { exact: true }),
  ).toHaveValue("Sense: written work\n\nNote: Accepted source note.");
});

for (const mode of ["Cancel", "navigation"] as const) {
  test(`a delayed create response cancels its exact old job after ${mode} and keeps the restarted request`, async ({
    page,
  }) => {
    await mockAssistant(page);
    const requests: any[] = [];
    const deleted: string[] = [];
    const polled: string[] = [];
    let releaseOld!: () => void;
    const oldResponse = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const expires = "2026-10-22T13:00:00Z";
    await page.route("**/api/v1/assist", async (route) => {
      const body = route.request().postDataJSON();
      requests.push(body);
      const job =
        requests.length === 1 ? "old-delayed-job" : "new-restarted-job";
      if (job === "old-delayed-job") await oldResponse;
      await route.fulfill({
        status: 202,
        json: { job, expires_at: expires, poll_after_ms: 100 },
      });
    });
    await page.route("**/api/v1/jobs/*", async (route) => {
      const job = route.request().url().split("/").at(-1)!;
      if (route.request().method() === "DELETE") {
        deleted.push(job);
        await route.fulfill({
          json: {
            state: "canceled",
            result: null,
            error: null,
            expires_at: expires,
          },
        });
        return;
      }
      polled.push(job);
      const body = requests[1];
      await route.fulfill({
        json: {
          state: "completed",
          error: null,
          expires_at: expires,
          result: {
            operation: body.operation,
            draft_revision: body.draft_revision,
            proposals: [{ path: "/word_type", value: "cmavo" }],
            explanation: "The restarted request stays intact.",
            provenance: {
              provider: "Mock provider",
              model: "new-request-model",
              revision: null,
              recipe: "test-v1",
              seed: null,
            },
            usage: null,
            log,
          },
        },
      });
    });
    try {
      await draft(page);
      await page
        .getByRole("button", { name: "Recommend a type", exact: true })
        .click();
      await allow(page);
      await expect.poll(() => requests.length).toBe(1);
      expect(deleted).toEqual([]);
      if (mode === "Cancel")
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
      else {
        await page.getByRole("link", { name: "Settings", exact: true }).click();
        await page
          .getByRole("link", { name: "Add a word", exact: true })
          .click();
        await page.getByRole("link", { name: "Type", exact: true }).click();
      }
      await page
        .getByRole("button", { name: "Recommend a type", exact: true })
        .click();
      const panel = page.getByRole("region", {
        name: "Recommend a type suggestion",
      });
      await expect(panel).toContainText("The restarted request stays intact.");
      expect(requests).toHaveLength(2);
      expect(requests[0].draft_revision).not.toBe(requests[1].draft_revision);
      releaseOld();
      await expect
        .poll(() => deleted.filter((id) => id === "old-delayed-job").length)
        .toBe(1);
      expect(polled).not.toContain("old-delayed-job");
      await expect(panel).toContainText("new-request-model");
      const saved = await stored(page);
      expect(saved.ai.records).toHaveLength(1);
      expect(saved.ai.records[0].result.draft_revision).toBe(
        requests[1].draft_revision,
      );
      expect(deleted.filter((id) => id === "new-restarted-job")).toHaveLength(
        1,
      );
    } finally {
      releaseOld();
    }
  });
}

for (const kind of ["direct", "merged", "distributed", "functional"] as const) {
  test(`From shows the exact ${kind} prefix in proposals and accepted places`, async ({
    page,
  }) => {
    await mockAssistant(page, { mappingKind: kind });
    await draft(
      page,
      { kind: "lujvo", spelling: "ckusni", frameMode: "none" },
      "/new/places",
    );
    await page
      .getByRole("button", { name: "Suggest places and glosses", exact: true })
      .click();
    await allow(page);
    const panel = page.getByRole("region", {
      name: "Suggest places and glosses suggestion",
    });
    await expect(panel).toContainText(`klama 2 · ${kind}`);
    await panel.getByRole("button", { name: "Use this", exact: true }).click();
    await expect(page.locator("p.meta.span-3")).toContainText(
      `klama 2 · ${kind}`,
    );
    await page.reload();
    await expect(page.locator("p.meta.span-3")).toContainText(
      `klama 2 · ${kind}`,
    );
  });
}

for (const figures of [
  { name: "null", input_tokens: null, output_tokens: null, cost_usd: null },
  { name: "input only", input_tokens: 12, output_tokens: null, cost_usd: null },
  { name: "output only", input_tokens: null, output_tokens: 8, cost_usd: null },
  {
    name: "cost only",
    input_tokens: null,
    output_tokens: null,
    cost_usd: 0.05,
  },
  { name: "zero", input_tokens: 0, output_tokens: 0, cost_usd: 0 },
]) {
  test(`inference logs omit missing figures and preserve ${figures.name} provider usage`, async ({
    page,
  }) => {
    const providerLog: any = structuredClone(log);
    Object.assign(providerLog, figures);
    for (const attempt of providerLog.exchanges[0].attempts) {
      attempt.usage =
        figures.name === "null"
          ? null
          : {
              prompt_tokens: figures.input_tokens,
              completion_tokens: figures.output_tokens,
            };
      attempt.cost_usd = figures.cost_usd;
      if (figures.name === "input only") {
        delete providerLog.output_tokens;
        delete providerLog.cost_usd;
        delete attempt.usage.completion_tokens;
        delete attempt.cost_usd;
      }
      attempt.response = { provider_fact: "unchanged", usage: attempt.usage };
    }
    const expected = [
      figures.input_tokens == null
        ? ""
        : `Input tokens: ${figures.input_tokens}.`,
      figures.output_tokens == null
        ? ""
        : `Output tokens: ${figures.output_tokens}.`,
      figures.cost_usd == null ? "" : `Cost: ${figures.cost_usd} USD.`,
    ]
      .filter(Boolean)
      .join(" ");
    await mockAssistant(page, { log: providerLog });
    await draft(page);
    await page
      .getByRole("button", { name: "Recommend a type", exact: true })
      .click();
    await allow(page);
    const panel = page.getByRole("region", {
      name: "Recommend a type suggestion",
    });
    await panel
      .getByRole("button", { name: "How the assistant decided" })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "How the assistant decided",
    });
    if (expected)
      await expect(dialog.getByText(expected, { exact: true })).toHaveCount(3);
    for (const [field, label] of [
      ["input_tokens", "Input tokens:"],
      ["output_tokens", "Output tokens:"],
      ["cost_usd", "Cost:"],
    ] as const)
      if (figures[field] == null) await expect(dialog).not.toContainText(label);
    await expect(dialog).not.toContainText("unknown");
    const mdDownload = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Export as Markdown" }).click();
    const markdown = await readFile((await (await mdDownload).path())!, "utf8");
    if (expected) expect(markdown.split(expected)).toHaveLength(4);
    for (const [field, label] of [
      ["input_tokens", "Input tokens:"],
      ["output_tokens", "Output tokens:"],
      ["cost_usd", "Cost:"],
    ] as const)
      if (figures[field] == null) expect(markdown).not.toContain(label);
    const rawDownload = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Export raw JSON" }).click();
    expect(
      JSON.parse(await readFile((await (await rawDownload).path())!, "utf8")),
    ).toEqual(providerLog);
  });
}

test("old browser source aliases migrate without inventing null or missing evidence", async ({
  page,
}) => {
  const mock = await mockAssistant(page);
  await draft(
    page,
    {
      kind: "gismu",
      gismu: {
        preset: null,
        rows: [
          {
            language: "en",
            name: "English",
            word: "book",
            input: "",
            weight: null,
            wordIpa: "old pronunciation",
            stemIpa: "old stem pronunciation",
            word_ipa: null,
            notes: [["Stem: a note cannot invent the missing stem"]],
          },
        ],
        candidates: "source-letters",
        selected: null,
        manual: "",
        acknowledged: [],
        reason: "",
        window: 12,
      },
    },
    "/new/gismu",
  );
  await expect(
    page.getByLabel("Said for English", { exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByLabel("Stem for English", { exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByLabel("Stem said for English", { exact: true }),
  ).toHaveValue("old stem pronunciation");
  await page
    .getByLabel("Said for English", { exact: true })
    .fill("new pronunciation");
  await page.getByLabel("Stem said for English", { exact: true }).fill("");
  await expect
    .poll(async () => (await stored(page)).gismu.rows[0].word_ipa)
    .toBe("new pronunciation");
  await page.reload();
  await expect(
    page.getByLabel("Said for English", { exact: true }),
  ).toHaveValue("new pronunciation");
  await expect(
    page.getByLabel("Stem said for English", { exact: true }),
  ).toHaveValue("");
  await page
    .getByRole("button", { name: "Suggest source for English", exact: true })
    .click();
  await allow(page);
  await expect(
    page.getByRole("region", { name: "Suggest source for English suggestion" }),
  ).toBeVisible();
  expect(mock.calls[0].current.formation.sources[0]).toMatchObject({
    word_ipa: "new pronunciation",
  });
  expect(mock.calls[0].current.formation.sources[0]).not.toHaveProperty("stem");
  expect(mock.calls[0].current.formation.sources[0]).not.toHaveProperty("ipa");
  const saved = (await stored(page)).gismu.rows[0];
  expect(saved).not.toHaveProperty("wordIpa");
  expect(saved).not.toHaveProperty("stemIpa");
});

test("accepted source evidence survives a generated form independently of edited scoring letters", async ({
  page,
}) => {
  await mockAssistant(page);
  await draft(
    page,
    {
      kind: "gismu",
      gismu: {
        preset: null,
        rows: [
          {
            language: "en",
            name: "English",
            word: "",
            input: "",
            aiNoteGroup: [],
            weight: { numerator: "1", denominator: "1" },
          },
        ],
        candidates: "source-letters",
        selected: null,
        manual: "",
        acknowledged: [],
        reason: "",
        window: 12,
      },
    },
    "/new/gismu",
  );
  await page
    .getByRole("button", { name: "Suggest source for English", exact: true })
    .click();
  await allow(page);
  const panel = page.getByRole("region", {
    name: "Suggest source for English suggestion",
  });
  await panel.getByRole("button", { name: "Use this", exact: true }).click();
  await expect(
    page.getByLabel("Native word for English", { exact: true }),
  ).toHaveValue("book");
  await page.getByLabel("Scoring letters for English").fill("makru");
  await page.getByLabel("Type a form yourself").fill("makru");
  const use = page.getByRole("button", { name: "Use makru", exact: true });
  await expect(use).toBeEnabled();
  await use.click();
  await expect(page).toHaveURL(/\/new\/places$/);
  const saved = await stored(page);
  expect(saved.formation.method).toBe("algorithmic");
  expect(saved.formation.sources[0]).toMatchObject({
    word: "book",
    word_ipa: "bʊk",
    input: { format: "lojbanized", text: "makru" },
  });
  expect(saved.formation.sources[0]).not.toHaveProperty("stem");
  expect(saved.formation.sources[0]).not.toHaveProperty("ipa");
  await page.reload();
  expect((await stored(page)).formation).toEqual(saved.formation);
});

test("an off setting in another tab cancels an active job and removes by-meaning mode", async ({
  page,
  context,
}) => {
  const mock = await mockAssistant(page, { delay: true });
  await draft(page);
  await page
    .getByRole("button", { name: "Recommend a type", exact: true })
    .click();
  await allow(page);
  const cancel = page.getByRole("button", { name: "Cancel", exact: true });
  await expect(cancel).toBeFocused();
  await expect(page.locator(".ai-working")).toContainText("2 of 3");
  await expect(cancel).toBeFocused();
  const settings = await context.newPage();
  await settings.goto("/preferences");
  await settings.getByRole("checkbox", { name: "Use AI assistance" }).uncheck();
  await expect.poll(mock.deletions).toBe(1);
  await expect(page.locator(".ai-action:visible")).toHaveCount(0);
  mock.release();
  expect((await stored(page)).ai?.records ?? []).toHaveLength(0);
  await page.goto("/new/meaning");
  await expect(
    page.getByRole("link", { name: "by meaning: not configured" }),
  ).toHaveCount(0);
  await settings.close();
});

test("a dismissed later run keeps the newest accepted Undo reachable", async ({
  page,
}) => {
  await mockAssistant(page);
  await draft(page);
  await page
    .getByRole("button", { name: "Recommend a type", exact: true })
    .click();
  await allow(page);
  await page.getByRole("button", { name: "Use this", exact: true }).click();
  await page
    .getByRole("button", { name: "Suggest again", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Recommend a type", exact: true })
    .click();
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  await page.reload();
  await page
    .getByRole("button", { name: "Undo Recommend a type", exact: true })
    .click();
  await expect(page.getByRole("radio", { name: /^gismu/ })).toBeChecked();
});

test("partial mappings require stale review and recheck later edits", async ({
  page,
}) => {
  const mock = await mockAssistant(page, { delay: true });
  await draft(
    page,
    {
      kind: "lujvo",
      spelling: "ckusni",
      frameMode: "fixed",
      places: [
        {
          index: 1,
          description: [["Original place."]],
          glosses: [],
          kind: "unspecified",
          hint: null,
          derivations: [],
          defaults: [],
          constraints: [],
        },
      ],
    },
    "/new/places",
  );
  await page
    .getByRole("button", { name: "Suggest places and glosses", exact: true })
    .click();
  await allow(page);
  await expect.poll(() => mock.calls.length).toBe(1);
  await page
    .getByLabel("Description for place 1", { exact: true })
    .fill("A newer place.");
  mock.release();
  const panel = page.getByRole("region", {
    name: "Suggest places and glosses suggestion",
  });
  const add = panel.getByRole("button", {
    name: "Add klama 2 to place 1",
    exact: true,
  });
  await expect(add).toBeDisabled();
  await panel
    .getByRole("checkbox", {
      name: "I reviewed the newer fields and want to replace them",
    })
    .check();
  await expect(add).toBeEnabled();
  await page
    .getByLabel("Description for place 1", { exact: true })
    .fill("One more author edit.");
  await add.click();
  await expect(add).toBeDisabled();
  expect((await stored(page)).places[0].derivations).toHaveLength(0);
  await panel
    .getByRole("checkbox", {
      name: "I reviewed the newer fields and want to replace them",
    })
    .check();
  await add.click();
  await expect(
    page.getByLabel("Source word of derivation 1 for place 1", { exact: true }),
  ).toHaveValue("klama");
});

test("failed log Markdown matches the dialog and preserves string requests and code fences", async ({
  page,
}) => {
  const failedLog = structuredClone(log) as any;
  failedLog.exchanges[0].request = "First request line.\nSecond request line.";
  failedLog.exchanges[0].system_prompt = "System prompt\n```\nA literal fence.";
  failedLog.exchanges[0].attempts[0].text = "```\nAssistant text.";
  const error =
    "No usable answer after 3 tries. Try again or fill the rows in by hand.";
  await mockAssistant(page, { failure: error, log: failedLog });
  await draft(page);
  await page
    .getByRole("button", { name: "Recommend a type", exact: true })
    .click();
  await allow(page);
  await page
    .getByRole("button", { name: "How the assistant decided", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "How the assistant decided",
  });
  await expect(dialog).toContainText(error);
  await expect(dialog).toContainText(
    "First request line.\nSecond request line.",
  );
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Export as Markdown" }).click();
  const markdown = await readFile((await (await download).path())!, "utf8");
  expect(markdown).toContain(error);
  expect(markdown).toContain("First request line.\nSecond request line.");
  expect(markdown).toContain(
    "````text\nSystem prompt\n```\nA literal fence.\n````",
  );
  expect(markdown).toContain("[type.task.txt]");
  expect(markdown).toContain("never published");
});

test("a completed suggestion keeps focus in a manual field that the author is editing", async ({
  page,
}) => {
  const mock = await mockAssistant(page, { delay: true });
  await draft(page);
  await page
    .getByRole("button", { name: "Recommend a type", exact: true })
    .click();
  await allow(page);
  await expect.poll(() => mock.calls.length).toBe(1);
  const manual = page.getByRole("radio", { name: /^gismu/ });
  await manual.focus();
  mock.release();
  await expect(
    page.getByRole("button", { name: "Use this", exact: true }),
  ).toBeVisible();
  await expect(manual).toBeFocused();
});

test("an accepted partial mapping keeps Undo and one log after the panel is dismissed", async ({
  page,
}) => {
  await mockAssistant(page);
  await draft(
    page,
    {
      kind: "lujvo",
      spelling: "ckusni",
      frameMode: "fixed",
      places: [
        {
          index: 1,
          description: [["A place."]],
          glosses: [],
          kind: "unspecified",
          hint: null,
          derivations: [],
          defaults: [],
          constraints: [],
        },
      ],
    },
    "/new/places",
  );
  await page
    .getByRole("button", { name: "Suggest places and glosses", exact: true })
    .click();
  await allow(page);
  await page
    .getByRole("button", { name: "Add klama 2 to place 1", exact: true })
    .click();
  await expect(
    page.getByLabel("Source word of derivation 1 for place 1", { exact: true }),
  ).toHaveValue("klama");
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  await page.reload();
  const data = await stored(page);
  const mapping = data.ai.records.find((r: any) => r.key.includes(":mapping:"));
  expect(mapping.result).toBeNull();
  expect(mapping.log).toBeNull();
  expect(mapping.log_json).toBeUndefined();
  expect(mapping.log_id).toBe(
    data.ai.records.find((r: any) => r.key === "places-glosses").id,
  );
  await page
    .getByRole("button", {
      name: "Undo mapping klama 2 to place 1",
      exact: true,
    })
    .click();
  await expect(
    page.getByLabel("Source word of derivation 1 for place 1", { exact: true }),
  ).toHaveCount(0);
});

test("completed deep logs survive acceptance, reload, and both log exports", async ({
  page,
}) => {
  const deepLog = structuredClone(log) as any;
  deepLog.exchanges[0].attempts[0].response.unknown = "DEEP_METADATA_ARRAY";
  deepLog.exchanges[0].attempts[0].tool_calls[0].unknown =
    "DEEP_METADATA_ARRAY";
  await mockAssistant(page, { log: deepLog, deepLog: true });
  await draft(page);
  await page
    .getByRole("button", { name: "Recommend a type", exact: true })
    .click();
  await allow(page);
  const panel = page.getByRole("region", {
    name: "Recommend a type suggestion",
  });
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Use this", exact: true }).click();
  await expect(page.getByRole("radio", { name: /^cmavo/ })).toBeChecked();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Undo Recommend a type", exact: true }),
  ).toBeVisible();
  const persisted = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const saved = (await new LocalStore().get("drafts", "current")) as any;
    return saved.ai.records.map((record: any) => ({
      log: record.log,
      jsonType: typeof record.log_json,
      nestedLog: record.result?.log,
      nestedJson: record.result?.log_json,
    }));
  });
  expect(persisted).toEqual([
    {
      log: null,
      jsonType: "string",
      nestedLog: undefined,
      nestedJson: undefined,
    },
  ]);
  await page
    .getByRole("button", { name: "How the assistant decided", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "How the assistant decided",
  });
  await expect(dialog).toContainText("deep metadata leaf");
  const markdownDownload = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Export as Markdown" }).click();
  const markdown = await readFile(
    (await (await markdownDownload).path())!,
    "utf8",
  );
  expect(markdown).toContain("deep metadata leaf");
  expect(markdown.length).toBeLessThan(100000);
  const rawDownload = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Export raw JSON" }).click();
  const raw = await readFile((await (await rawDownload).path())!, "utf8");
  expect(raw.length).toBeLessThan(100000);
  const exported = JSON.parse(raw);
  expect(exported).not.toHaveProperty("log_json");
  const depth = (value: unknown) => {
    let count = 0;
    while (Array.isArray(value)) {
      count++;
      value = value[0];
    }
    expect(value).toBe("deep metadata leaf");
    return count;
  };
  expect(depth(exported.exchanges[0].attempts[0].response.unknown)).toBe(10000);
  expect(depth(exported.exchanges[0].attempts[0].tool_calls[0].unknown)).toBe(
    10000,
  );
});

test("an unversioned draft converts legacy deep logs before its first storage clone", async ({
  page,
}) => {
  await page.goto("/search");
  const outcome = await page.evaluate(async () => {
    const { newDraft } = await import(String("/src/model/draft.ts"));
    const { loadDraft } = await import(String("/src/pages/wizard/common.ts"));
    const legacy: any = newDraft();
    delete legacy.revision;
    legacy.ai = {
      records: [
        {
          id: "old-log",
          key: "definition",
          label: "Definition",
          operation: "definition",
          fingerprint: "old",
          requested: {},
          result: null,
          log: JSON.parse(
            `{"unknown":${"[".repeat(10000)}"old leaf"${"]".repeat(10000)}}`,
          ),
          error: null,
          state: "done",
        },
      ],
    };
    let storedType: string | null = null;
    const app: any = {
      session: { storageAvailable: true },
      store: {
        savedDrafts: async () => [],
        get: async () => legacy,
        saveDraft: async (_key: string, value: any) => {
          const saved = structuredClone(value);
          storedType = typeof saved.ai.records[0].log_json;
        },
      },
    };
    const loaded = await loadDraft(app);
    return {
      loaded: loaded !== null,
      storedType,
      rawLog: loaded?.ai?.records[0].log,
    };
  });
  expect(outcome).toEqual({ loaded: true, storedType: "string", rawLog: null });
});

for (const failure of [undefined, "The mock service failed."]) {
  test(`restored ${failure ? "failed" : "ready"} suggestions do not announce a new result`, async ({
    page,
  }) => {
    await mockAssistant(page, { failure });
    await draft(page);
    await page
      .getByRole("button", { name: "Recommend a type", exact: true })
      .click();
    await allow(page);
    await expect(page.locator(".ai-action [role=status]")).not.toHaveText("");
    await expect(page.locator(".ai-working")).toHaveCount(0);
    await page.reload();
    await expect(
      page.getByRole("button", {
        name: failure ? "Try again" : "Use this",
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator(".ai-action [role=status]")).toHaveText("");
  });
}

test("Cancel announces cancellation instead of a restored failure", async ({
  page,
}) => {
  const mock = await mockAssistant(page, { failure: "An earlier failure." });
  await draft(page);
  await page
    .getByRole("button", { name: "Recommend a type", exact: true })
    .click();
  await allow(page);
  await expect(
    page.getByRole("button", { name: "Try again", exact: true }),
  ).toBeVisible();
  mock.hold();
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".ai-action [role=status]")).toHaveText(
    "Canceled.",
  );
});

test("Cancel returns focus to Suggest again beside accepted Undo", async ({
  page,
}) => {
  const mock = await mockAssistant(page);
  await draft(page);
  await page
    .getByRole("button", { name: "Recommend a type", exact: true })
    .click();
  await allow(page);
  await page.getByRole("button", { name: "Use this", exact: true }).click();
  await page
    .getByRole("button", { name: "Suggest again", exact: true })
    .click();
  mock.hold();
  await page
    .getByRole("button", { name: "Recommend a type", exact: true })
    .click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  const suggest = page.getByRole("button", {
    name: "Suggest again",
    exact: true,
  });
  await expect(suggest).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Undo Recommend a type", exact: true }),
  ).not.toBeFocused();
  await expect(page.getByRole("radio", { name: /^cmavo/ })).toBeChecked();
});

test("Cancel returns focus to the action beside accepted mapping Undo", async ({
  page,
}) => {
  const mock = await mockAssistant(page);
  await draft(
    page,
    {
      kind: "lujvo",
      spelling: "ckusni",
      frameMode: "fixed",
      places: [
        {
          index: 1,
          description: [["Original place."]],
          glosses: [],
          kind: "unspecified",
          hint: null,
          derivations: [],
          defaults: [],
          constraints: [],
        },
      ],
    },
    "/new/places",
  );
  const action = page.getByRole("button", {
    name: "Suggest places and glosses",
    exact: true,
  });
  await action.click();
  await allow(page);
  await page
    .getByRole("button", { name: "Add klama 2 to place 1", exact: true })
    .click();
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  mock.hold();
  await action.click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(action).toBeFocused();
  await expect(
    page.getByRole("button", {
      name: "Undo mapping klama 2 to place 1",
      exact: true,
    }),
  ).not.toBeFocused();
  expect((await stored(page)).places[0].derivations).toHaveLength(1);
});

for (const stale of [false, true]) {
  test(`places completion focuses ${stale ? "the stale review checkbox" : "Use this"}`, async ({
    page,
  }) => {
    const mock = await mockAssistant(page, { delay: true });
    await draft(
      page,
      {
        kind: "lujvo",
        spelling: "ckusni",
        frameMode: "fixed",
        places: [
          {
            index: 1,
            description: [["Original place."]],
            glosses: [],
            kind: "unspecified",
            hint: null,
            derivations: [],
            defaults: [],
            constraints: [],
          },
        ],
      },
      "/new/places",
    );
    await page
      .getByRole("button", { name: "Suggest places and glosses", exact: true })
      .click();
    await allow(page);
    const cancel = page.getByRole("button", { name: "Cancel", exact: true });
    await expect(cancel).toBeFocused();
    if (stale) {
      await page
        .getByLabel("Description for place 1", { exact: true })
        .fill("Newer prose.");
      await cancel.focus();
    }
    mock.release();
    const panel = page.getByRole("region", {
      name: "Suggest places and glosses suggestion",
    });
    await expect(panel).toBeVisible();
    await expect(
      stale
        ? panel.getByRole("checkbox", {
            name: "I reviewed the newer fields and want to replace them",
          })
        : panel.getByRole("button", { name: "Use this", exact: true }),
    ).toBeFocused();
  });
}

test("the inference log collapses the full system prompt and exports it unchanged", async ({
  page,
}) => {
  await mockAssistant(page);
  await draft(page);
  await page
    .getByRole("button", { name: "Recommend a type", exact: true })
    .click();
  await allow(page);
  await page
    .getByRole("button", { name: "How the assistant decided", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "How the assistant decided",
  });
  const prompt = dialog.locator("details").filter({
    has: page.locator("summary", { hasText: "System prompt: type" }),
  });
  await expect(prompt).toHaveCount(1);
  await expect(prompt).not.toHaveAttribute("open");
  await expect(prompt.locator("pre")).toHaveText(
    log.exchanges[0].system_prompt,
  );
  await expect(prompt.locator("pre")).toBeHidden();
  await prompt.locator("summary").click();
  await expect(prompt.locator("pre")).toBeVisible();
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Export as Markdown" }).click();
  const markdown = await readFile((await (await download).path())!, "utf8");
  expect(markdown).toContain(
    `### System prompt: type\n\n\`\`\`text\n${log.exchanges[0].system_prompt}\n\`\`\``,
  );
});

test("network failures add manual guidance once", async ({ page }) => {
  await mockAssistant(page);
  await page.route("**/api/v1/assist", (route) => route.abort("failed"));
  await draft(page);
  await page
    .getByRole("button", { name: "Recommend a type", exact: true })
    .click();
  await allow(page);
  await expect(page.locator(".ai-action .notice")).toHaveText(
    "Failed to fetch. Try again or fill the fields in by hand.",
  );
  await expect(
    page.getByRole("button", { name: "Try again", exact: true }),
  ).toBeFocused();
  expect((await stored(page)).kind).toBe("gismu");
});

for (const refusal of [
  {
    code: "billing_limit",
    message:
      "Try again after the retry time, or reduce the request. Retry in 35 seconds.",
  },
  {
    code: "billing_request_too_large",
    message: "This request exceeds the spending limit. Reduce the request.",
  },
  {
    code: "billing_pending",
    message:
      "Active inference work holds this allowance while its final costs are unknown. Wait for that work to finish, then request the suggestion again.",
  },
]) {
  test(`coded ${refusal.code} keeps the server guidance without another retry instruction`, async ({
    page,
  }) => {
    await mockAssistant(page);
    await page.route("**/api/v1/assist", (route) =>
      route.fulfill({
        status: 429,
        json: refusal,
      }),
    );
    await draft(page);
    await page
      .getByRole("button", { name: "Recommend a type", exact: true })
      .click();
    await allow(page);
    const expected = `${refusal.message} You can fill the fields in by hand.`;
    await expect(page.locator(".ai-action .notice")).toHaveText(expected);
    await expect
      .poll(async () => (await stored(page)).ai.records.at(-1).error)
      .toBe(expected);
    await page.reload();
    await expect(page.locator(".ai-action .notice")).toHaveText(expected);
  });
}

test("coded source failures give manual row guidance once", async ({
  page,
}) => {
  await mockAssistant(page);
  await page.route("**/api/v1/assist", (route) =>
    route.fulfill({
      status: 503,
      json: {
        code: "capacity",
        message: "The assistant is at capacity. Retry in 5 seconds.",
      },
    }),
  );
  await draft(page, { kind: "gismu" }, "/new/gismu");
  await page
    .getByRole("button", { name: "Suggest source for English", exact: true })
    .click();
  await allow(page);
  await expect(
    page.locator('.ai-action[data-ai-action^="source-"] .notice'),
  ).toHaveText(
    "The assistant is at capacity. Retry in 5 seconds. You can fill the rows in by hand.",
  );
});

test("an expired result displays discarded status and keeps manual editing available", async ({
  page,
}) => {
  await mockAssistant(page);
  await page.route("**/api/v1/jobs/local-job", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          status: 410,
          json: {
            code: "result_discarded",
            message:
              "This private result and its log were discarded. Request a new suggestion to continue.",
          },
        })
      : route.fallback(),
  );
  await draft(page);
  await page
    .getByRole("button", { name: "Recommend a type", exact: true })
    .click();
  await allow(page);
  const expected =
    "This private result and its log were discarded. Request a new suggestion to continue. You can fill the fields in by hand.";
  await expect(page.locator(".ai-action .notice")).toHaveText(expected);
  await expect(page.locator(".ai-action [role=status]")).toHaveText(expected);
  await expect(page.getByRole("radio", { name: /^gismu/ })).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Try again", exact: true }),
  ).toBeEnabled();
});

async function scoredGismu(page: Page) {
  await draft(
    page,
    {
      kind: "gismu",
      gismu: {
        preset: null,
        rows: [
          {
            language: "en",
            name: "English",
            word: "book",
            input: "buk",
            weight: { numerator: "1", denominator: "1" },
          },
        ],
        candidates: "source-letters",
        selected: "makru",
        manual: "makru",
        acknowledged: [],
        reason: "",
        window: 12,
      },
    },
    "/new/gismu",
  );
  await expect(
    page.getByRole("button", { name: "Use makru", exact: true }),
  ).toBeEnabled();
  await page.clock.install();
  await page.clock.pauseAt(new Date());
}

for (const input of ["letters", "language", "weight"]) {
  test(`changing ${input} disables the old generated form during the calculation wait`, async ({
    page,
  }) => {
    await scoredGismu(page);
    const disabled = await page.evaluate((input) => {
      const selector =
        input === "letters"
          ? '[aria-label="Scoring letters for English"]'
          : input === "language"
            ? '[aria-label="Language tag of row 1"]'
            : '[aria-label="Weight numerator of row 1"]';
      const field = document.querySelector<HTMLInputElement>(selector)!;
      field.value =
        input === "letters" ? "makru" : input === "language" ? "fr" : "2";
      field.dispatchEvent(
        new Event(input === "letters" ? "input" : "change", { bubbles: true }),
      );
      return document.querySelector<HTMLButtonElement>(
        ".action-bar .btn-primary",
      )?.disabled;
    }, input);
    expect(disabled).toBe(true);
    await page.clock.runFor(251);
    await expect(
      page.getByRole("button", { name: "Use makru", exact: true }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Use makru", exact: true }).click();
    await expect(page).toHaveURL(/\/new\/places$/);
    const saved = await stored(page);
    expect(saved.formation.sources[0]).toMatchObject(
      input === "letters"
        ? { input: { format: "lojbanized", text: "makru" } }
        : input === "language"
          ? { language: "fr" }
          : { weight: { numerator: 2, denominator: 1 } },
    );
  });
}

test("scoring edits preserve the selected form while recalculation disables its action", async ({
  page,
}) => {
  await scoredGismu(page);
  const selected = page.getByRole("region", { name: "Selected form" });
  const before = await selected.textContent();
  await page
    .getByRole("textbox", { name: "Scoring letters for English" })
    .fill("makru");
  await expect(selected).toHaveText(before!);
  await expect(selected).not.toContainText("No form chosen yet");
  await expect(
    page.getByRole("button", { name: "Use makru", exact: true }),
  ).toBeDisabled();
  await expect(page.locator("main")).toContainText("Calculating…");
  await page.clock.runFor(251);
  await expect(
    page.getByRole("button", { name: "Use makru", exact: true }),
  ).toBeEnabled();
});

test("the primary handler refuses a stale generated result even if its button is enabled", async ({
  page,
}) => {
  await scoredGismu(page);
  await page.evaluate(() => {
    const field = document.querySelector<HTMLInputElement>(
      '[aria-label="Scoring letters for English"]',
    )!;
    field.value = "makru";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    const use = document.querySelector<HTMLButtonElement>(
      ".action-bar .btn-primary",
    )!;
    use.disabled = false;
    use.click();
  });
  await expect(page).toHaveURL(/\/new\/gismu$/);
  // Navigation would flush immediately. An ordinary pending edit flushes at 300 ms.
  await page.clock.runFor(1);
  expect((await stored(page)).formation).toBeNull();
});

test("closing the generator clears its pending calculation", async ({
  page,
}) => {
  await scoredGismu(page);
  await page.evaluate(async () => {
    const selected = document.querySelector('[aria-label="Selected form"]')!;
    const fixture = { changes: 0, writes: 0, selected };
    Object.assign(window, { closedGenerator: fixture });
    const field = document.querySelector<HTMLInputElement>(
      '[aria-label="Scoring letters for English"]',
    )!;
    field.value = "makru";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    const { navigate } = await import(String("/src/app/router.ts"));
    navigate("/search");
  });
  await expect(page).toHaveURL(/\/search$/);
  await page.evaluate(async () => {
    const fixture = (window as any).closedGenerator;
    new MutationObserver(() => fixture.changes++).observe(fixture.selected, {
      childList: true,
    });
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const original = LocalStore.prototype.saveDraft;
    LocalStore.prototype.saveDraft = function (...args: any[]) {
      fixture.writes++;
      return original.apply(this, args);
    };
  });
  await page.clock.runFor(300);
  expect(
    await page.evaluate(() => (window as any).closedGenerator.changes),
  ).toBe(0);
  expect(
    await page.evaluate(() => (window as any).closedGenerator.writes),
  ).toBe(0);
});

test("Cancel during a completed suggestion save keeps its ready status", async ({
  page,
}) => {
  const mock = await mockAssistant(page, { delay: true });
  await draft(page);
  await page.evaluate(async () => {
    const { DraftSaver } = await import(String("/src/pages/wizard/common.ts"));
    const original = DraftSaver.prototype.flush;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = { saving: false, release };
    Object.assign(window, { suggestionSave: fixture });
    DraftSaver.prototype.flush = async function () {
      const saved = await original.call(this);
      if (this.draft.ai?.records.at(-1)?.state === "done") {
        fixture.saving = true;
        await gate;
      }
      return saved;
    };
  });
  await page
    .getByRole("button", { name: "Recommend a type", exact: true })
    .click();
  await allow(page);
  mock.release();
  await expect
    .poll(() => page.evaluate(() => (window as any).suggestionSave.saving))
    .toBe(true);
  await expect(page.locator(".ai-action [role=status]")).toHaveText(
    "Suggestion ready.",
  );
  // The old Cancel control remains reachable while the final save is pending.
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".ai-action [role=status]")).toHaveText(
    "Suggestion ready.",
  );
  await page.evaluate(() => (window as any).suggestionSave.release());
  const panel = page.getByRole("region", {
    name: "Recommend a type suggestion",
  });
  await expect(panel).toBeVisible();
  expect((await stored(page)).ai.records.at(-1).state).toBe("done");
  expect(mock.deletions()).toBe(1);
});

test("Cancel during a failed suggestion save preserves the failure announcement", async ({
  page,
}) => {
  const mock = await mockAssistant(page, {
    failure: "Fixture inference failure.",
  });
  await draft(page);
  await page.evaluate(async () => {
    const { DraftSaver } = await import(String("/src/pages/wizard/common.ts"));
    const original = DraftSaver.prototype.flush;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = { saving: false, release };
    Object.assign(window, { failedSuggestionSave: fixture });
    DraftSaver.prototype.flush = async function () {
      const saved = await original.call(this);
      if (this.draft.ai?.records.at(-1)?.state === "failed") {
        fixture.saving = true;
        await gate;
      }
      return saved;
    };
  });
  await page
    .getByRole("button", { name: "Recommend a type", exact: true })
    .click();
  await allow(page);
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).failedSuggestionSave.saving),
    )
    .toBe(true);
  const status = page.locator(".ai-action [role=status]");
  const failure = await status.textContent();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(status).toHaveText(failure!);
  expect(mock.deletions()).toBe(0);
  await page.evaluate(() => (window as any).failedSuggestionSave.release());
  await expect(page.locator(".ai-action .notice")).toHaveText(failure!);
  await expect.poll(() => mock.deletions()).toBe(1);
});

test("Dismiss clears the completed suggestion announcement", async ({
  page,
}) => {
  await mockAssistant(page);
  await draft(page);
  await page
    .getByRole("button", { name: "Recommend a type", exact: true })
    .click();
  await allow(page);
  const panel = page.getByRole("region", {
    name: "Recommend a type suggestion",
  });
  await expect(panel).toBeVisible();
  await expect(page.locator(".ai-action [role=status]")).toHaveText(
    "Suggestion ready.",
  );
  await panel.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.locator(".ai-action [role=status]")).toHaveText("");
});

for (const action of ["Suggest a lujvo", "Suggest components"] as const)
  test(`R7 ${action} Undo restores exact rows and joins after reload and a later author edit`, async ({
    page,
  }) => {
    const components = [
      {
        word: { language: "jbo", spelling: "sanmi" },
        definition: null,
        rafsi: "sai",
      },
      {
        word: { language: "jbo", spelling: "zbasu" },
        definition: null,
        rafsi: "zba",
      },
    ];
    await mockAssistant(page, {
      lujvoProposals: [
        { path: "/compound", value: { ...compound, components } },
        ...(action === "Suggest a lujvo"
          ? [{ path: "/spelling", value: "saizba" }]
          : []),
      ],
    });
    await draft(
      page,
      {
        kind: "lujvo",
        spelling: "sairzba",
        typedSpelling: null,
        glosses: [{ language: "en", text: "synthetic", sense: "" }],
        lujvo: {
          profile: "extended",
          typed: "sairzba",
          selected: "sairzba",
          joins: ["r"],
          acknowledged: [],
          components: components.map((component, index) => ({
            id: `legacy-${index}`,
            spelling: component.word.spelling,
            kind: "gismu",
            definition: null,
            claims: [{ rafsi: component.rafsi, pair: "synthetic-pair" }],
            locked: component.rafsi,
            gloss: "",
          })),
        },
      },
      "/new/lujvo",
    );
    await expect(
      page.getByLabel("Form sairzba", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(async () => (await stored(page)).lujvo?.restoredSpelling)
      .toBe("sairzba");
    const original = await stored(page);
    await page.getByRole("button", { name: action, exact: true }).click();
    await allow(page);
    await page.getByRole("button", { name: "Use this", exact: true }).click();
    await expect(page.getByLabel("Form saizba", { exact: true })).toBeVisible();
    await page.reload();
    await page
      .getByRole("list", { name: "Steps" })
      .getByRole("link", { name: /^Meaning\b/ })
      .click();
    await page
      .getByLabel("Meaning", { exact: true })
      .fill("A later author meaning.");
    await page
      .getByRole("list", { name: "Steps" })
      .getByRole("link", { name: /^Form\b/ })
      .click();
    await page
      .getByRole("button", { name: `Undo ${action}`, exact: true })
      .click();
    await expect(
      page.getByLabel("Form sairzba", { exact: true }),
    ).toBeVisible();
    const undone = await stored(page);
    expect(undone.spelling).toBe("sairzba");
    expect(undone.lujvo).toEqual(original.lujvo);
    expect(undone.meaning).toBe("A later author meaning.");
    expect(undone.text).toEqual(original.text);
    expect(undone.glosses).toEqual(original.glosses);
    await page.reload();
    await expect(
      page.getByLabel("Form sairzba", { exact: true }),
    ).toBeVisible();
  });

for (const reverse of [false, true])
  test(`R8 AI lujvo replacement ignores discarded evidence in either proposal order: ${reverse}`, async ({
    page,
  }) => {
    const components = [
      {
        word: { language: "jbo", spelling: "sanmi" },
        definition: null,
        rafsi: "sai",
      },
      {
        word: { language: "jbo", spelling: "zbasu" },
        definition: null,
        rafsi: "zba",
      },
    ];
    const proposals = [
      { path: "/spelling", value: "saizba" },
      { path: "/compound", value: { ...compound, components } },
    ];
    if (reverse) proposals.reverse();
    await mockAssistant(page, { lujvoProposals: proposals });
    await draft(
      page,
      {
        kind: "lujvo",
        spelling: "sairzba",
        typedSpelling: null,
        compound: {
          ...compound,
          components,
          morphology: {
            id: "https://github.com/int19h/jbovlacku/blob/main/docs/morphology.md#extended-lujvo",
            version: "3",
          },
        },
        evidenceForm: "sairzba",
        lujvo: {
          profile: "extended",
          ordinarySpelling: "sairzba",
          selected: "sairzba",
          acknowledged: [],
          components: components.map((row, index) => ({
            id: `source-${index}`,
            spelling: row.word.spelling,
            kind: "gismu",
            definition: null,
            claims: [{ rafsi: row.rafsi, pair: "synthetic-pair" }],
            locked: row.rafsi,
            gloss: "",
          })),
        },
      },
      "/new/lujvo",
    );
    await page
      .getByRole("button", { name: "Suggest a lujvo", exact: true })
      .click();
    await allow(page);
    await page.getByRole("button", { name: "Use this", exact: true }).click();
    await expect.poll(async () => (await stored(page)).spelling).toBe("saizba");
    expect((await stored(page)).compound).toBeNull();
    expect((await stored(page)).review).toEqual([]);
  });

test("R8 component-only AI preserves the typed headword and later Use asks before replacing it", async ({
  page,
}) => {
  await mockAssistant(page);
  await draft(
    page,
    {
      kind: "lujvo",
      spelling: "sanzbax",
      typedSpelling: "sanzbax",
    },
    "/new/lujvo",
  );
  await page
    .getByRole("button", { name: "Suggest components", exact: true })
    .click();
  await allow(page);
  await page.getByRole("button", { name: "Use this", exact: true }).click();
  await expect(page.getByLabel("Form ckusni", { exact: true })).toBeVisible();
  await page.reload();
  expect((await stored(page)).typedSpelling).toBe("sanzbax");
  let replacement = "";
  page.once("dialog", (dialog) => {
    replacement = dialog.message();
    void dialog.dismiss();
  });
  await page.getByRole("button", { name: "Use ckusni", exact: true }).click();
  expect(replacement).toBe(
    'Replace the typed spelling "sanzbax" with "ckusni"?',
  );
  expect((await stored(page)).spelling).toBe("sanzbax");
});

test("type suggestions display fu'ivla and apply fuhivla", async ({ page }) => {
  await mockAssistant(page, { wordType: "fuhivla" });
  await draft(page);
  await page
    .getByRole("button", { name: "Recommend a type", exact: true })
    .click();
  await allow(page);
  const panel = page.getByRole("region", {
    name: "Recommend a type suggestion",
  });
  await expect(panel).toContainText("fu'ivla");
  await expectKindSpelling(page);
  await panel.getByRole("button", { name: "Use this", exact: true }).click();
  await expect(page.getByRole("radio", { name: /^fu'ivla/ })).toBeChecked();
  await expect.poll(async () => (await stored(page)).kind).toBe("fuhivla");
});

test("null type keeps the current card and formation, asks a question and permits retry", async ({
  page,
}) => {
  const options: MockOptions = {
    nullType: true,
    explanation: "Does this word name a person or a thing?",
  };
  const mock = await mockAssistant(page, options);
  await draft(page, {
    formation: {
      method: "unknown",
      sources: [],
      algorithm: null,
      weights_profile: null,
      generated: null,
      selected_score: null,
      selected_rank: null,
      selection_reason: [],
      candidates: [],
      conflicts: [],
    },
    formNotes: "Keep my evidence.",
  });
  const before = await stored(page);
  await page
    .getByRole("button", { name: "Recommend a type", exact: true })
    .click();
  await allow(page);
  const panel = page.getByRole("region", {
    name: "Recommend a type suggestion",
  });
  await expect(panel).toContainText(options.explanation!);
  await expect(
    panel.getByRole("button", { name: "Use this", exact: true }),
  ).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "Try again", exact: true }),
  ).toBeVisible();
  expect((await stored(page)).kind).toBe(before.kind);
  expect((await stored(page)).formation).toEqual(before.formation);
  await page.reload();
  await expect(panel).toContainText(options.explanation!);
  options.nullType = false;
  options.explanation =
    "A described thing.\n\nAlso possible: fu'ivla. Use a known name.";
  await panel.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(panel).toContainText(
    "Also possible: fu'ivla. Use a known name.",
  );
  await expect(
    page.getByRole("dialog", { name: "Before using AI assistance" }),
  ).toHaveCount(0);
  expect(mock.calls).toHaveLength(2);
  expect(mock.calls[0]).not.toHaveProperty("related");
});

test("type existing word adds a definition while the original draft stays saved", async ({
  page,
}) => {
  const options: MockOptions = {
    existing: {
      word: "cukta",
      event: fixture().definitions.cukta1,
      conversion: null,
      revised_definition: null,
    },
  };
  await mockAssistant(page, options);
  await draft(page, {
    formNotes: "Original evidence.",
    notes: "Keep authored notes.",
    glosses: [{ language: "en", text: "draft gloss", sense: "meaning" }],
    sources: [
      {
        label: "Draft source",
        url: "https://example.test/source",
        event: null,
        locator: null,
      },
    ],
    labels: ["draft-label"],
    frameMode: "fixed",
    places: [
      {
        index: 1,
        description: "Keep this place.",
        glosses: [],
        kind: "unspecified",
        hint: null,
        defaults: [],
        constraints: [],
        derivations: [],
      },
    ],
  });
  const before = await stored(page);
  await page
    .getByRole("button", { name: "Recommend a type", exact: true })
    .click();
  await allow(page);
  const panel = page.getByRole("region", {
    name: "Recommend a type suggestion",
  });
  await expect(
    panel.getByRole("link", { name: "cukta", exact: true }),
  ).toHaveAttribute("href", /word\/cukta/);
  await panel
    .getByRole("button", { name: "Add a definition", exact: true })
    .click();
  await expect(page).toHaveURL(/\/new\/type$/);
  await expect.poll(async () => (await stored(page)).spelling).toBe("cukta");
  expect((await stored(page)).parents).toEqual([]);
  const added = await stored(page);
  for (const field of [
    "meaning",
    "text",
    "kind",
    "language",
    "notes",
    "formNotes",
    "glosses",
    "sources",
    "places",
    "frameMode",
    "labels",
  ])
    expect(added[field]).toEqual(before[field]);
  expect(added.review).toContain("spelling");
  const savedRows = () =>
    page.evaluate(async () => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      return (await new LocalStore().keys("drafts")).filter((key: string) =>
        key.startsWith("saved:"),
      );
    });
  expect(await savedRows()).toHaveLength(1);
  await page
    .getByRole("button", { name: "Continue to places", exact: true })
    .click();
  await expect(page).toHaveURL(/\/new\/places$/);
  await expect(
    page.getByRole("link", { name: "Return to the saved draft" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Skip to the full editor" }).click();
  await page.reload();
  await page.getByRole("link", { name: "Return to the saved draft" }).click();
  await expect(page).toHaveURL(/\/new\/meaning/);
  expect((await stored(page)).spelling).toBe(before.spelling);
  expect((await stored(page)).formNotes).toBe("Original evidence.");
  expect(await savedRows()).toHaveLength(1);
  for (const path of [
    "/new/type",
    "/new/form",
    "/new/places",
    "/new/editor",
    "/new/publish",
    "/new/meaning",
  ]) {
    await page.goto(path);
    await expect(
      page.getByRole("link", { name: "Return to the saved draft" }),
    ).toBeVisible();
  }
  await page.getByRole("link", { name: "Return to the saved draft" }).click();
  await expect(page).toHaveURL(/\/new\/meaning/);
  await expect.poll(async () => (await stored(page)).spelling).toBe("cukta");
  expect(await savedRows()).toHaveLength(1);
  await page.reload();
  await page.getByRole("link", { name: "Return to the saved draft" }).click();
  await expect
    .poll(async () => (await stored(page)).spelling)
    .toBe(before.spelling);
  expect(await savedRows()).toHaveLength(1);
});

for (const conversion of [null, "te"]) {
  test(`type existing revision keeps the exact parent and supports acceptance and undo (${conversion ?? "no conversion"})`, async ({
    page,
  }) => {
    const proposed = "① is an improved synthetic book definition.";
    const options: MockOptions = {
      existing: {
        word: "cukta",
        event: fixture().definitions.cukta1,
        conversion,
        revised_definition: proposed,
      },
    };
    await mockAssistant(page, options);
    await draft(page);
    const before = await stored(page);
    await page
      .getByRole("button", { name: "Recommend a type", exact: true })
      .click();
    await allow(page);
    const panel = page.getByRole("region", {
      name: "Recommend a type suggestion",
    });
    await expect(panel).toContainText(proposed);
    if (conversion)
      await expect(
        panel.getByRole("button", { name: "Use te cukta", exact: true }),
      ).toBeVisible();
    await panel
      .getByRole("button", { name: "Revise this one", exact: true })
      .click();
    await expect(page).toHaveURL(/\/new\/editor$/);
    const revision = await stored(page);
    expect(revision.parents).toEqual([fixture().definitions.cukta1]);
    const revisionPanel = page.getByRole("region", {
      name: "Rewrite definition suggestion",
    });
    await expect(revisionPanel).toContainText(
      "improved synthetic book definition",
    );
    await revisionPanel
      .getByRole("button", { name: "Use this", exact: true })
      .click();
    expect((await stored(page)).text).toEqual([
      [1, " is an improved synthetic book definition."],
    ]);
    await page.reload();
    await page
      .getByRole("button", { name: "Undo Rewrite definition", exact: true })
      .click();
    expect((await stored(page)).text).toEqual(revision.text);
    expect((await stored(page)).parents).toEqual(revision.parents);
    await page.getByRole("link", { name: "Return to the saved draft" }).click();
    await expect(page).toHaveURL(/\/new\/meaning/);
    expect((await stored(page)).text).toEqual(before.text);
    expect((await stored(page)).spelling).toBe(before.spelling);
  });
}

test("type place conversion opens the existing word and creates no draft", async ({
  page,
}) => {
  const options: MockOptions = {
    existing: {
      word: "cukta",
      event: fixture().definitions.cukta1,
      conversion: "te",
      revised_definition: null,
    },
  };
  await mockAssistant(page, options);
  await draft(page);
  await page
    .getByRole("button", { name: "Recommend a type", exact: true })
    .click();
  await allow(page);
  const before = await stored(page);
  const panel = page.getByRole("region", {
    name: "Recommend a type suggestion",
  });
  await expect(
    panel.getByRole("button", { name: "Add a definition", exact: true }),
  ).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "Revise this one", exact: true }),
  ).toHaveCount(0);
  await panel
    .getByRole("button", { name: "Use te cukta", exact: true })
    .click();
  await expect(page).toHaveURL(/\/word\/cukta\?lang=en&conversion=te/);
  await expect(page.getByText("te cukta", { exact: true })).toBeVisible();
  const after = await stored(page);
  for (const field of [
    "createdAt",
    "spelling",
    "kind",
    "text",
    "formation",
    "compound",
    "parents",
  ])
    expect(after[field]).toEqual(before[field]);
});

test("type disclosure mentions public definitions without expanding remembered consent", async ({
  page,
}) => {
  const mock = await mockAssistant(page);
  await draft(page);
  await page
    .getByRole("button", { name: "Recommend a type", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Before using AI assistance",
  });
  await expect(dialog).toContainText(
    "Type suggestions can also send public dictionary definitions that the server finds for your meaning.",
  );
  await allow(page);
  await expect(
    page.getByRole("region", { name: "Recommend a type suggestion" }),
  ).toBeVisible();
  const consent = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return (await new LocalStore().get("prefs", "preferences"))
      ?.aiConsents?.[0];
  });
  expect(consent.dataScope).not.toContain("related public definitions");
  expect(JSON.parse(consent.scope).disclosure).toBe(
    "Send the draft fields and selected definitions.",
  );
  await page.reload();
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  await page
    .getByRole("button", { name: "Recommend a type", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Recommend a type suggestion" }),
  ).toBeVisible();
  expect(mock.calls).toHaveLength(2);
});

test("type imported revision shows the same license and origin notice as ordinary Revise", async ({
  page,
}) => {
  const event = fixture().definitions.imported;
  await page.goto(`/new/editor?revise=${encodeURIComponent(event)}`);
  const notice = page
    .locator("main p.notice")
    .filter({ hasText: "This draft copies every field" });
  await expect(notice).toBeVisible();
  const ordinary = await notice.textContent();
  const word = (await stored(page)).spelling;
  expect(ordinary).toContain("CC0 1.0");
  expect(ordinary).toContain("the imported legacy record");
  expect(ordinary).toContain("the origin, from imported to native");
  await mockAssistant(page, {
    existing: {
      word,
      event,
      conversion: null,
      revised_definition: "An improved imported definition.",
    },
  });
  await draft(page);
  await page
    .getByRole("button", { name: "Recommend a type", exact: true })
    .click();
  await allow(page);
  await page
    .getByRole("button", { name: "Revise this one", exact: true })
    .click();
  await expect(page).toHaveURL(/\/new\/editor$/);
  await expect(notice).toHaveText(ordinary!);
  const revised = await stored(page);
  expect(revised.parents).toEqual([event]);
  const body = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { draftToBody } = await import(String("/src/model/draft.ts"));
    return draftToBody(await new LocalStore().get("drafts", "current")).body;
  });
  expect(body.license.expression).toBe("CC0-1.0");
  expect(body.legacy).toBeNull();
});

for (const action of ["add", "revise", "conversion"] as const) {
  test(`accepted type keeps its existing word ${action} action through reload`, async ({
    page,
  }) => {
    const existing = {
      word: "cukta",
      event: fixture().definitions.cukta1,
      conversion: action === "conversion" ? "te" : null,
      revised_definition:
        action === "revise" ? "An improved synthetic definition." : null,
    };
    await mockAssistant(page, { wordType: "gismu", existing });
    await draft(page);
    await page
      .getByRole("button", { name: "Recommend a type", exact: true })
      .click();
    await allow(page);
    await page
      .getByRole("region", { name: "Recommend a type suggestion" })
      .getByRole("button", { name: "Use this", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Undo Recommend a type", exact: true }),
    ).toBeVisible();
    await page.reload();
    const block = page.getByRole("region", {
      name: "Existing word",
      exact: true,
    });
    await expect(
      block.getByRole("link", { name: "cukta", exact: true }),
    ).toBeVisible();
    const label =
      action === "add"
        ? "Add a definition"
        : action === "revise"
          ? "Revise this one"
          : "Use te cukta";
    await block.getByRole("button", { name: label, exact: true }).click();
    if (action === "conversion")
      await expect(page).toHaveURL(/\/word\/cukta\?lang=en&conversion=te/);
    else if (action === "revise") {
      await expect(page).toHaveURL(/\/new\/editor$/);
      expect((await stored(page)).parents).toEqual([existing.event]);
    } else {
      await expect
        .poll(async () => (await stored(page)).spelling)
        .toBe("cukta");
      await expect(page).toHaveURL(/\/new\/type$/);
    }
  });
}

test("saved draft switches refuse stale writers and roll back failed replacements without orphan rows", async ({
  page,
}) => {
  await draft(page);
  await page.goto("/search");
  const result = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { newDraft } = await import(String("/src/model/draft.ts"));
    const store = new LocalStore();
    const original = await store.get("drafts", "current");
    let conflict = "",
      failure = "",
      missing = "",
      invalid = "";
    try {
      await store.switchDraft(
        "stale-revision",
        newDraft({ spelling: "cukta" }),
      );
    } catch (error) {
      conflict = (error as { kind: string }).kind;
    }
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: any, key?: IDBValidKey) {
      if (this.name === "drafts" && key === "current")
        throw new Error("Injected replacement failure.");
      return put.call(this, value, key!);
    };
    try {
      await store.switchDraft(
        original.revision,
        newDraft({ spelling: "cukta" }),
      );
    } catch (error) {
      failure = (error as Error).message;
    } finally {
      IDBObjectStore.prototype.put = put;
    }
    try {
      await store.switchDraft(original.revision, {
        resume: `saved:${crypto.randomUUID()}`,
      });
    } catch (error) {
      missing = (error as Error).message;
    }
    try {
      await store.switchDraft(original.revision, { resume: "current" });
    } catch (error) {
      invalid = (error as Error).message;
    }
    return {
      invalid,
      original,
      after: await store.get("drafts", "current"),
      keys: await store.keys("drafts"),
      conflict,
      failure,
      missing,
    };
  });
  expect(result.conflict).toBe("changed");
  expect(result.failure).toBe("Injected replacement failure.");
  expect(result.missing).toBe("The saved draft is unavailable.");
  expect(result.invalid).toBe("The saved draft is unavailable.");
  expect(result.after).toEqual(result.original);
  expect(result.keys.filter((key: string) => key.startsWith("saved:"))).toEqual(
    [],
  );
});

async function earlierSavedDraft(page: Page, revise = false) {
  await mockAssistant(page, {
    existing: {
      word: "cukta",
      event: fixture().definitions.cukta1,
      conversion: null,
      revised_definition: revise
        ? "A revised synthetic book definition."
        : null,
    },
  });
  await draft(page, { notes: "Earlier private notes." });
  const original = await stored(page);
  await page
    .getByRole("button", { name: "Recommend a type", exact: true })
    .click();
  await allow(page);
  await page
    .getByRole("button", {
      name: revise ? "Revise this one" : "Add a definition",
      exact: true,
    })
    .click();
  await expect.poll(async () => (await stored(page)).spelling).toBe("cukta");
  return original;
}

for (const path of ["replacement", "discard", "ordinary revise"] as const) {
  test(`saved drafts remain reachable after current ${path}`, async ({
    page,
  }) => {
    const original = await earlierSavedDraft(page);
    if (path === "replacement") {
      await page.goto("/new/meaning?word=brode");
      await page
        .getByRole("button", { name: 'Start "brode" instead', exact: true })
        .click();
      await expect
        .poll(async () => (await stored(page)).spelling)
        .toBe("brode");
    } else if (path === "discard") {
      await page.goto("/new/meaning");
      page.once("dialog", (dialog) => dialog.accept());
      await page
        .getByRole("button", { name: "Discard draft", exact: true })
        .click();
      await expect(page).toHaveURL(/\/$/);
      expect(await stored(page)).toBeUndefined();
      await page.goto("/new/meaning");
      await expect(
        page.getByRole("heading", { name: "Saved drafts", exact: true }),
      ).toBeVisible();
      expect(await stored(page)).toBeUndefined();
    } else {
      await page
        .getByRole("region", { name: "Existing word", exact: true })
        .getByRole("link", { name: "cukta", exact: true })
        .click();
      page.once("dialog", (dialog) => dialog.accept());
      await page
        .locator(
          `a[href="/new/editor?revise=${encodeURIComponent(fixture().definitions.cukta2)}"]`,
        )
        .filter({ hasText: /^Revise$/ })
        .click();
      await expect
        .poll(async () => (await stored(page)).parents[0])
        .toBe(fixture().definitions.cukta2);
    }
    await page.reload();
    await page
      .getByRole("link", { name: "Return to the saved draft", exact: true })
      .click();
    await expect
      .poll(async () => (await stored(page))?.spelling)
      .toBe(original.spelling);
    expect((await stored(page)).notes).toEqual(original.notes);
    const state = await page.evaluate(async () => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const store = new LocalStore();
      return {
        index: await store.savedDrafts(),
        rows: (await store.keys("drafts")).filter((key: string) =>
          key.startsWith("saved:"),
        ),
      };
    });
    expect(state.rows).toHaveLength(path === "discard" ? 0 : 1);
    expect(state.index.map((entry: any) => entry.key)).toEqual(state.rows);
  });
}

test("publishing an AI-created revision keeps earlier draft recovery without a current row", async ({
  page,
}) => {
  const original = await earlierSavedDraft(page, true);
  await page
    .getByRole("region", { name: "Rewrite definition suggestion" })
    .getByRole("button", { name: "Use this", exact: true })
    .click();
  await createIdentity(page);
  await page.getByRole("link", { name: "Add a word", exact: true }).click();
  await page
    .getByRole("link", { name: "Skip to the full editor", exact: true })
    .click();
  const approve = page.getByRole("button", {
    name: "Approve the numbering",
    exact: true,
  });
  if (await approve.isVisible()) await approve.click();
  await page.getByRole("button", { name: "Review", exact: true }).click();
  const publish = page
    .locator("aside")
    .getByRole("button", { name: "Publish", exact: true });
  await expect(publish).toBeEnabled();
  // Save the signed revision locally without changing the shared dictionary fixture.
  await page.route("**/api/v1/events", (route) => route.abort("failed"));
  await publish.click();
  await acceptFirstSignature(page);
  await expect(
    page.getByRole("region", { name: "Saved publication", exact: true }),
  ).toContainText("Saved. Not delivered yet.");
  const publication = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const records = await new LocalStore().list("outbox");
    return records
      .map((item: any) => JSON.parse(item.transport).envelope.header.action)
      .find((action: any) => action.kind === "definition.publish");
  });
  expect(publication.parents).toEqual([fixture().definitions.cukta1]);
  expect(await stored(page)).toBeUndefined();
  await page.getByRole("link", { name: "Add a word", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Saved drafts", exact: true }),
  ).toBeVisible();
  expect(await stored(page)).toBeUndefined();
  await page
    .getByRole("link", { name: "Return to the saved draft", exact: true })
    .click();
  await expect
    .poll(async () => (await stored(page))?.spelling)
    .toBe(original.spelling);
  expect((await stored(page)).notes).toEqual(original.notes);
  const state = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    return {
      index: await store.savedDrafts(),
      rows: (await store.keys("drafts")).filter((key: string) =>
        key.startsWith("saved:"),
      ),
    };
  });
  expect(state.rows).toEqual([]);
  expect(state.index).toEqual([]);
});

test("orphan saved rows migrate without current and Export drafts excludes only index metadata", async ({
  page,
}) => {
  await page.goto("/search");
  const key = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { newDraft } = await import(String("/src/model/draft.ts"));
    const store = new LocalStore();
    const key = `saved:${crypto.randomUUID()}`;
    await store.put(
      "drafts",
      key,
      newDraft({
        spelling: "broda",
        meaning: "An orphan meaning.",
        notes: "An orphan note.",
      }),
    );
    return key;
  });
  await page.goto("/new/meaning");
  await expect(
    page.getByRole("heading", { name: "Saved drafts", exact: true }),
  ).toBeVisible();
  expect(await stored(page)).toBeUndefined();
  const index = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return new LocalStore().get("drafts", "saved-index");
  });
  expect(index.entries).toEqual([{ key, label: "broda" }]);
  const atomic = await page.evaluate(async (key) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const { newDraft } = await import(String("/src/model/draft.ts"));
    const store = new LocalStore();
    let failure = "",
      conflict = "";
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: any, key?: IDBValidKey) {
      if (this.name === "drafts" && key === "current")
        throw new Error("Injected absent resume failure.");
      return put.call(this, value, key!);
    };
    try {
      await store.switchDraft(null, { resume: key });
    } catch (error) {
      failure = (error as Error).message;
    } finally {
      IDBObjectStore.prototype.put = put;
    }
    const other = newDraft({ spelling: "brode" });
    await store.saveDraft("current", other, "absent");
    try {
      await store.switchDraft(null, { resume: key });
    } catch (error) {
      conflict = (error as { kind: string }).kind;
    }
    await store.deleteDraft("current", { revision: other.revision });
    return {
      failure,
      conflict,
      current: await store.get("drafts", "current"),
      index: await store.savedDrafts(),
      saved: await store.get("drafts", key),
    };
  }, key);
  expect(atomic.failure).toBe("Injected absent resume failure.");
  expect(atomic.conflict).toBe("changed");
  expect(atomic.current).toBeUndefined();
  expect(atomic.index).toEqual([{ key, label: "broda" }]);
  expect(atomic.saved.spelling).toBe("broda");
  await page
    .getByRole("link", { name: "Return to the saved draft", exact: true })
    .click();
  await expect.poll(async () => (await stored(page))?.spelling).toBe("broda");
  expect((await stored(page)).notes).toEqual([["An orphan note."]]);
  await page.goto("/search");
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    await store.put("drafts", "current", {
      word: "legacy-word",
      text: "A raw legacy draft.",
    });
  });
  await page.goto("/preferences");
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export drafts", exact: true })
    .click();
  const rows = JSON.parse(
    await readFile((await (await downloaded).path())!, "utf8"),
  );
  expect(rows).toContainEqual({
    word: "legacy-word",
    text: "A raw legacy draft.",
  });
  expect(rows.some((row: any) => row.kind === "saved-drafts")).toBe(false);
});
