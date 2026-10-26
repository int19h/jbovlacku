import { before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import {
  initializeCore,
  signHeader,
  contentHash,
  wordId,
  canonicalize,
  identityFromSeed,
  utf8,
  builderPresets,
  createEvent,
} from "../../core/src/index.ts";
import { DictionaryService } from "../src/service.ts";
import { emptyState } from "../src/storage.ts";
import {
  parseAssistRequest,
  runAssistance,
  type AssistRequest,
  type AssistanceOptions,
  type ContextDefinition,
} from "../src/assistance.ts";
import {
  InferenceRunner,
  checkAnswer,
  foldHints,
  newLog,
  promptVersion,
  providerConfig,
  type ProviderConfig,
  type TaskCase,
  sourceLanguages,
  schemaFor,
} from "../src/inference.ts";
import { promptFiles } from "../src/prompt-bundle.ts";

before(async () =>
  initializeCore(
    await readFile(
      new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  ),
);
const disposableKey = "disposable-inference-canary-7340";
const makeConfig = (
  overrides: Partial<ProviderConfig> = {},
): ProviderConfig => ({
  ...providerConfig(
    { JVC_AI_ENABLED: "enabled", JVC_AI_BASE_URL: "http://127.0.0.1:9999" },
    async () => disposableKey,
  )!,
  ...overrides,
});
const draft = (
  operation: AssistRequest["operation"] = "type",
  patch: Partial<AssistRequest["current"]> = {},
): AssistRequest => ({
  operation,
  draft_revision: "revision-private-1",
  language: "en",
  meaning: "x1 teaches subject x2 to learner x3.",
  current: {
    word_type: null,
    classification: null,
    spelling: null,
    text: [["x1 teaches subject x2 to learner x3."]],
    frame: null,
    glosses: [],
    formation: null,
    compound: null,
    ...patch,
  },
  context: [],
  profile: "default",
});
const frame = {
  role: "predicate",
  arity: { mode: "fixed", count: 1 },
  places: [
    {
      index: 1,
      glosses: [],
      description: [["teacher"]],
      type_hints: [],
      defaults: [],
      constraints: [],
      derivation: [],
    },
  ],
  tail: null,
  constraints: [],
};
function completion(answer: unknown, extra: Record<string, any> = {}) {
  return {
    model: "mock-model",
    provider: "mock-route",
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: "Review this suggestion.",
          reasoning_details: [
            {
              type: "reasoning.summary",
              summary: "The supplied definition describes teaching.",
            },
            { type: "reasoning.encrypted", data: "encrypted-canary" },
          ],
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "submit_answer",
                arguments: JSON.stringify(answer),
              },
            },
          ],
          ...extra,
        },
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.001 },
  };
}
function queue(
  values: unknown[],
  inspect?: (body: any, turn: number) => void,
): typeof fetch {
  let turn = 0;
  return (async (_url: unknown, init: any) => {
    const body = JSON.parse(init.body);
    assert.deepEqual(body.usage, { include: true });
    if (body.tool_choice !== "auto")
      return Response.json(
        { error: { message: 'Only "auto" is supported for tool_choice.' } },
        { status: 400 },
      );
    inspect?.(body, turn);
    const next = values[turn++];
    assert.notEqual(next, undefined, "Unexpected extra provider request.");
    return Response.json(next);
  }) as typeof fetch;
}
async function runner(fetcher: typeof fetch, operation = "type") {
  const config = makeConfig({ fetch: fetcher });
  const log = newLog(operation, config, await promptVersion());
  return {
    config,
    log,
    runner: new InferenceRunner(config, log, AbortSignal.timeout(2000)),
  };
}
test("public prompt bundle matches every source file", async () => {
  for (const [name, text] of Object.entries(promptFiles))
    assert.equal(
      await readFile(
        new URL(`../../../prompts/${name}`, import.meta.url),
        "utf8",
      ),
      text,
    );
  const root = new URL("../../../prompts/", import.meta.url);
  const sources = (await readdir(root)).filter(
    (name) => name.endsWith(".txt") || name === "answer-shapes.json",
  );
  for (const name of await readdir(new URL("languages/", root)))
    if (name.endsWith(".txt")) sources.push(`languages/${name}`);
  assert.deepEqual(Object.keys(promptFiles).sort(), sources.sort());
});
test("provider is off by default and validates operator fields", () => {
  assert.equal(
    providerConfig({}, async () => disposableKey),
    undefined,
  );
  assert.throws(() =>
    providerConfig(
      {
        JVC_AI_ENABLED: "enabled",
        JVC_AI_BASE_URL: "https://user:secret@example.test",
      },
      async () => disposableKey,
    ),
  );
  assert.throws(() =>
    providerConfig(
      { JVC_AI_ENABLED: "enabled", JVC_AI_OPERATIONS: "sign" },
      async () => disposableKey,
    ),
  );
  assert.throws(() =>
    providerConfig(
      { JVC_AI_ENABLED: "enabled", JVC_AI_MAX_TOKENS: "999999" },
      async () => disposableKey,
    ),
  );
});
test("four studied tasks use exact explicit answer keys and semantic checks", () => {
  assert.deepEqual(
    checkAnswer(
      { task: "glosses", input: "", keys: ["word", "x1"] },
      {
        word: { gloss: "teach", sense: "instruct a learner" },
        x1: { gloss: "teacher", sense: "" },
      },
    ),
    [],
  );
  assert.ok(
    checkAnswer(
      { task: "glosses", input: "", keys: ["word"] },
      { word: { gloss: "teach", sense: "teach" } },
    ).length,
  );
  assert.ok(
    checkAnswer(
      { task: "glosses", input: "", keys: ["word"] },
      { word: { gloss: "teach", sense: "" }, x1: {} },
    ).length,
  );
  assert.ok(
    checkAnswer(
      { task: "hints", input: "", keys: ["x1"] },
      {
        x1: [
          { type: "unclear", reason: "unknown" },
          { type: "event", reason: "event" },
        ],
      },
    ).length,
  );
  assert.deepEqual(
    foldHints([
      { type: "state", reason: "state" },
      { type: "event", reason: "event" },
    ]),
    [{ type: "event", reason: "event" }],
  );
  assert.deepEqual(
    foldHints([
      { type: "agent", reason: "agent" },
      { type: "referent", reason: "anything" },
    ]),
    [{ type: "referent", reason: "anything" }],
  );
  const mappings: TaskCase = {
    task: "mappings",
    input: "",
    keys: ["x1"],
    components: ["ctuca[1]"],
  };
  assert.ok(
    checkAnswer(mappings, {
      x1: [
        { component: "none", reason: "none" },
        { component: "ctuca[1]", reason: "direct" },
      ],
    }).length,
  );
  assert.ok(
    checkAnswer(mappings, { x1: [{ component: "ctuca[2]", reason: "direct" }] })
      .length,
  );
  assert.ok(
    checkAnswer(mappings, {
      x1: [
        { component: "ctuca[1]", reason: "direct" },
        { component: "ctuca[1]", reason: "direct" },
      ],
    }).length,
  );
  const source = {
    word: "teacher",
    sense: "one who teaches",
    stem: "teach",
    word_ipa: "ˈtitʃər",
    ipa: "titʃ",
    sounds: "titc",
    note: "Removed agent noun ending -er.",
  };
  assert.deepEqual(
    checkAnswer({ task: "sources", input: "", language: "en" }, source),
    [],
  );
  assert.ok(
    checkAnswer({ task: "sources", input: "" }, { ...source, sounds: "teach" })
      .length,
  );
  assert.ok(
    checkAnswer({ task: "sources", input: "" }, { ...source, ipa: "ti.tʃ" })
      .length,
  );
  assert.ok(
    checkAnswer({ task: "sources", input: "" }, { ...source, word: null })
      .length,
  );
  assert.ok(
    checkAnswer(
      { task: "sources", input: "" },
      {
        word: null,
        sense: null,
        stem: null,
        word_ipa: null,
        ipa: null,
        sounds: null,
        note: "",
      },
    ).length,
  );
});
test("mapping reasons require the exact matching kind and an explanation", () => {
  const spec: TaskCase = {
    task: "mappings",
    input: "",
    keys: ["x1"],
    components: ["ctuca[1]"],
  };
  for (const component of ["ctuca[1]", "none", "unclear"]) {
    const kinds =
      component === "ctuca[1]"
        ? ["direct", "merged", "distributed", "functional"]
        : [component];
    for (const kind of kinds)
      assert.deepEqual(
        checkAnswer(spec, {
          x1: [
            {
              component,
              reason: `${kind}: The definition supports this role.`,
            },
          ],
        }),
        [],
      );
    for (const reason of [
      "",
      "direct",
      `${kinds[0]}:`,
      `${kinds[0]}: `,
      `${kinds[0]}:...`,
      `${kinds[0]}: ...`,
      `${kinds[0]}:  Explanation.`,
      "Direct: Explanation.",
      "other: Explanation.",
      component === "ctuca[1]" ? "none: Explanation." : "direct: Explanation.",
      component === "none" ? "unclear: Explanation." : "none: Explanation.",
    ])
      assert.ok(
        checkAnswer(spec, { x1: [{ component, reason }] }).length,
        `${component} rejected ${JSON.stringify(reason)}`,
      );
  }
});
test("a missing mapping prefix receives correction before acceptance", async () => {
  const requests: any[] = [];
  const { runner: inference, log } = await runner(
    queue(
      [
        completion({
          x1: [{ component: "ctuca[1]", reason: "The teacher acts." }],
        }),
        completion({
          x1: [{ component: "ctuca[1]", reason: "direct: The teacher acts." }],
        }),
      ],
      (body) => requests.push(body),
    ),
    "mappings",
  );
  await inference.run({
    task: "mappings",
    input: "A teacher.",
    keys: ["x1"],
    components: ["ctuca[1]"],
  });
  assert.equal(log.answers, 2);
  assert.match(
    log.exchanges[0].attempts[0].check.problems[0],
    /starts with "direct: "/,
  );
  assert.equal(requests[1].messages.at(-1).role, "tool");
  assert.ok(
    requests[1].messages
      .at(-1)
      .content.includes(log.exchanges[0].attempts[0].check.problems[0]),
  );
});
test("retry sends exact problems, keeps full exchange, and removes encrypted reasoning and keys", async () => {
  const requests: any[] = [];
  const { runner: inference, log } = await runner(
    queue(
      [
        completion({ word_type: "bogus", reason: "x" }),
        completion(
          { word_type: "lujvo", reason: "A compound fits." },
          { content: disposableKey },
        ),
      ],
      (body) => requests.push(body),
    ),
  );
  assert.equal(
    (await inference.run({ task: "type", input: "Draft evidence." })).word_type,
    "lujvo",
  );
  assert.equal(log.answers, 2);
  assert.equal(log.corrections, 1);
  assert.equal(log.cost_usd, 0.002);
  assert.deepEqual(requests[0].provider.only, ["meta"]);
  assert.equal(requests[0].provider.allow_fallbacks, false);
  assert.equal(requests[0].reasoning.effort, "medium");
  assert.equal(requests[0].tool_choice, "auto");
  assert.deepEqual(requests[0].usage, { include: true });
  assert.deepEqual(requests[1].usage, { include: true });
  assert.ok(
    requests[1].messages
      .at(-1)
      .content.includes(log.exchanges[0].attempts[0].check.problems[0]),
  );
  assert.ok(
    log.exchanges[0].attempts[0].reasoning_summary?.includes("teaching"),
  );
  assert.equal(JSON.stringify(log).includes("encrypted-canary"), false);
  assert.equal(JSON.stringify(log).includes(disposableKey), false);
  assert.equal(JSON.stringify(requests).includes("encrypted-canary"), false);
});
test("three failed answers stop without a fourth request", async () => {
  const { runner: inference, log } = await runner(
    queue(Array.from({ length: 3 }, () => completion({}))),
  );
  await assert.rejects(inference.run({ task: "type", input: "draft" }), {
    code: "invalid_answer",
  });
  assert.equal(log.answers, 3);
  assert.equal(log.corrections, 2);
});
test("the baseline provider accepts auto and rejects forced tool choices", async () => {
  const provider = queue([
    completion({ word_type: "lujvo", reason: "A compound fits." }),
  ]);
  const rejected = await provider("http://localhost/chat/completions", {
    method: "POST",
    body: JSON.stringify({ tool_choice: "required", usage: { include: true } }),
  });
  assert.equal(rejected.status, 400);
  const { runner: inference, log } = await runner(provider);
  const answer = await inference.run({
    task: "type",
    input: "Draft evidence.",
  });
  assert.equal(answer.word_type, "lujvo");
  assert.equal(log.answers, 1);
  assert.equal(log.exchanges[0].attempts[0].request.tool_choice, "auto");
});
test("malformed arguments get a valid assistant echo and correction", async () => {
  const bad = completion({});
  bad.choices[0].message.tool_calls[0].function.arguments = "{broken";
  const requests: any[] = [];
  const { runner: inference } = await runner(
    queue(
      [bad, completion({ word_type: "lujvo", reason: "compound" })],
      (body) => requests.push(body),
    ),
  );
  await inference.run({ task: "type", input: "draft" });
  assert.equal(requests[1].messages[2].tool_calls[0].function.arguments, "{}");
});
test("no tool calls and multiple tool calls count toward the same limit", async () => {
  const noCall = completion(
    {},
    { tool_calls: [], content: "Answer in prose." },
  );
  const twoCalls = completion({});
  twoCalls.choices[0].message.tool_calls.push(
    twoCalls.choices[0].message.tool_calls[0],
  );
  const { runner: inference, log } = await runner(
    queue([noCall, twoCalls, noCall]),
  );
  await assert.rejects(inference.run({ task: "type", input: "draft" }), {
    code: "invalid_answer",
  });
  assert.equal(log.answers, 3);
});
test("three missing or wrongly named submit calls fail without a tool result", async () => {
  for (const name of [null, "other_tool"]) {
    const missing = completion({}, name === null ? { tool_calls: [] } : {});
    if (name !== null)
      missing.choices[0].message.tool_calls[0].function.name = name;
    const requests: any[] = [];
    const { runner: inference, log } = await runner(
      queue([missing, missing, missing], (body) => requests.push(body)),
    );
    await assert.rejects(inference.run({ task: "type", input: "draft" }), {
      code: "invalid_answer",
    });
    assert.equal(requests.length, 3);
    assert.equal(log.answers, 3);
    assert.equal(log.corrections, 2);
    for (const body of requests)
      assert.equal(
        body.messages.some((message: any) => message.role === "tool"),
        false,
      );
    assert.equal(requests[1].messages[2].tool_calls, undefined);
    assert.equal(requests[1].messages.at(-1).role, "user");
  }
});
test("a missing or wrongly named submit call can recover without a tool result", async () => {
  for (const name of [null, "other_tool"]) {
    const missing = completion({}, name === null ? { tool_calls: [] } : {});
    if (name !== null)
      missing.choices[0].message.tool_calls[0].function.name = name;
    const requests: any[] = [];
    const { runner: inference, log } = await runner(
      queue(
        [
          missing,
          completion({ word_type: "lujvo", reason: "A compound fits." }),
        ],
        (body) => requests.push(body),
      ),
    );
    assert.equal(
      (await inference.run({ task: "type", input: "draft" })).word_type,
      "lujvo",
    );
    assert.equal(log.answers, 2);
    assert.equal(log.corrections, 1);
    assert.equal(
      requests[1].messages.some((message: any) => message.role === "tool"),
      false,
    );
    assert.equal(requests[1].messages[2].tool_calls, undefined);
    assert.match(
      requests[1].messages.at(-1).content,
      /Call submit_answer exactly once/,
    );
  }
});
test("HTTP, network, null JSON and non-JSON failures disclose unknown usage with a failed check", async () => {
  for (const fetcher of [
    (async () => {
      throw new Error(disposableKey);
    }) as typeof fetch,
    (async () =>
      new Response("not JSON " + disposableKey, {
        status: 502,
      })) as typeof fetch,
    (async () => Response.json(null)) as typeof fetch,
    (async () =>
      Response.json(
        { error: { message: disposableKey } },
        { status: 429 },
      )) as typeof fetch,
  ]) {
    const { runner: inference, log } = await runner(fetcher);
    await assert.rejects(inference.run({ task: "type", input: "draft" }), {
      code: "provider_error",
    });
    assert.equal(log.cost_usd, null);
    assert.equal(log.input_tokens, null);
    assert.equal(log.output_tokens, null);
    assert.equal(log.unknown_cost_attempts, 1);
    assert.ok(log.exchanges[0].attempts[0].check.problems.length);
    assert.equal(JSON.stringify(log).includes(disposableKey), false);
  }
});
test("stalled fetch and response streams respect cancellation", async () => {
  for (const fetcher of [
    (() => new Promise(() => {})) as typeof fetch,
    (async () =>
      new Response(
        new ReadableStream({ pull: () => new Promise(() => {}) }),
      )) as typeof fetch,
  ]) {
    const config = makeConfig({ fetch: fetcher });
    const log = newLog("type", config, await promptVersion());
    const timer = setTimeout(() => {}, 100);
    try {
      await assert.rejects(
        new InferenceRunner(config, log, AbortSignal.timeout(10)).run({
          task: "type",
          input: "draft",
        }),
        { name: "TimeoutError" },
      );
    } finally {
      clearTimeout(timer);
    }
    assert.equal(log.cost_usd, null);
    assert.ok(log.exchanges[0].attempts[0].check.problems.length);
  }
});
test("response size and billing bounds stop inference", async () => {
  const { runner: inference, log } = await runner(
    (async () => new Response("x".repeat(1048577))) as typeof fetch,
  );
  await assert.rejects(inference.run({ task: "type", input: "draft" }), {
    code: "provider_size",
  });
  assert.equal(log.cost_usd, null);
  const config = makeConfig({ maxCostUsd: 0.000001, fetch: queue([]) });
  await assert.rejects(
    runAssistance(
      draft(),
      config,
      [],
      AbortSignal.timeout(1000),
      newLog("type", config, await promptVersion()),
      () => {},
    ),
    { code: "billing_limit" },
  );
});
test("private log admission reserves the complete response before making an upstream call", async () => {
  let called = false;
  const config = makeConfig({
    maxLogBytes: 1000,
    fetch: (async () => {
      called = true;
      return Response.json(
        completion({ word_type: "lujvo", reason: "compound" }),
      );
    }) as typeof fetch,
  });
  await assert.rejects(
    new InferenceRunner(
      config,
      newLog("type", config, await promptVersion()),
      AbortSignal.timeout(1000),
    ).run({ task: "type", input: "draft" }),
    { code: "log_limit" },
  );
  assert.equal(called, false);
});
test("malformed usage and unsafe aggregate token totals remain unknown", async () => {
  const first = completion({});
  first.usage.prompt_tokens = Number.MAX_SAFE_INTEGER;
  const second = completion({ word_type: "lujvo", reason: "compound" });
  second.usage.prompt_tokens = Number.MAX_SAFE_INTEGER;
  const { runner: inference, log } = await runner(queue([first, second]));
  await inference.run({ task: "type", input: "draft" });
  assert.equal(log.input_tokens, null);
  assert.equal(log.output_tokens, 100);
  assert.equal(log.cost_usd, 0.002);
  const malformed: any = completion({ word_type: "lujvo", reason: "compound" });
  malformed.usage = {
    prompt_tokens: -1,
    completion_tokens: "50",
    cost: "unknown",
  };
  const other = await runner(queue([malformed]));
  await other.runner.run({ task: "type", input: "draft" });
  assert.equal(other.log.input_tokens, null);
  assert.equal(other.log.output_tokens, null);
  assert.equal(other.log.cost_usd, null);
});
test("requesting usage does not invent missing provider token counts or cost", async () => {
  for (const usage of [undefined, { prompt_tokens: 100 }, { cost: 0.001 }]) {
    const response: any = completion({
      word_type: "lujvo",
      reason: "A compound fits.",
    });
    response.usage = usage;
    const { runner: inference, log } = await runner(queue([response]));
    await inference.run({ task: "type", input: "draft" });
    assert.equal(log.input_tokens, usage?.prompt_tokens ?? null);
    assert.equal(log.output_tokens, null);
    assert.equal(log.cost_usd, usage?.cost ?? null);
    assert.equal(log.unknown_cost_attempts, usage?.cost === undefined ? 1 : 0);
  }
});
test("failures before a provider request retain unknown figures and reported zero stays visible", async () => {
  for (const overrides of [
    { key: async () => "" },
    {
      key: async () => {
        throw new Error("Local key unavailable.");
      },
    },
    { maxLogBytes: 1000 },
  ]) {
    const config = makeConfig({ ...overrides, fetch: queue([]) });
    const log = newLog("type", config, await promptVersion());
    await assert.rejects(
      new InferenceRunner(config, log, AbortSignal.timeout(1000)).run({
        task: "type",
        input: "draft",
      }),
    );
    assert.equal(log.answers, 0);
    assert.equal(log.input_tokens, null);
    assert.equal(log.output_tokens, null);
    assert.equal(log.cost_usd, null);
    assert.deepEqual(log.exchanges[0].attempts, []);
  }
  const zero = completion({ word_type: "lujvo", reason: "A compound fits." });
  zero.usage = { prompt_tokens: 0, completion_tokens: 0, cost: 0 };
  const { runner: inference, log } = await runner(queue([zero]));
  await inference.run({ task: "type", input: "draft" });
  assert.equal(log.input_tokens, 0);
  assert.equal(log.output_tokens, 0);
  assert.equal(log.cost_usd, 0);
});
test("unknown earlier usage stays unknown after a later known answer", async () => {
  const missing: any = completion({});
  delete missing.usage;
  const { runner: inference, log } = await runner(
    queue([
      missing,
      completion({ word_type: "lujvo", reason: "A compound fits." }),
    ]),
  );
  await inference.run({ task: "type", input: "draft" });
  assert.equal(log.answers, 2);
  assert.equal(log.input_tokens, null);
  assert.equal(log.output_tokens, null);
  assert.equal(log.cost_usd, null);
  assert.equal(log.unknown_cost_attempts, 1);
});
test("source prompt order, explicit tool keys and optional reports follow the recipe", async () => {
  let sent: any;
  const source = {
    word: "teacher",
    sense: "one who teaches",
    stem: "teach",
    word_ipa: "ˈtitʃər",
    ipa: "titʃ",
    sounds: "titc",
    note: "Removed -er.",
  };
  const config = makeConfig({
    decisionReports: true,
    fetch: queue([completion(source)], (body) => (sent = body)),
  });
  const log = newLog("gismu-sources", config, await promptVersion());
  await new InferenceRunner(config, log, AbortSignal.timeout(1000)).run({
    task: "sources",
    input: "teacher",
    language: "en",
  });
  assert.equal(
    sent.messages[0].content,
    [
      "common.system.txt",
      "sources.task.txt",
      "sound-guide.txt",
      "explain.txt",
      "languages/english.txt",
    ]
      .map((name) => promptFiles[name].trim())
      .join("\n\n"),
  );
  assert.equal(sent.tool_choice, "auto");
});
test("prompt order omits disabled reports and appends reports to other tasks", async () => {
  for (const decisionReports of [false, true]) {
    let sent: any;
    const config = makeConfig({
      decisionReports,
      fetch: queue(
        [completion({ word_type: "lujvo", reason: "A compound fits." })],
        (body) => (sent = body),
      ),
    });
    const log = newLog("type", config, await promptVersion());
    await new InferenceRunner(config, log, AbortSignal.timeout(1000)).run({
      task: "type",
      input: "draft",
    });
    assert.equal(
      sent.messages[0].content,
      [
        "common.system.txt",
        "type.task.txt",
        ...(decisionReports ? ["explain.txt"] : []),
      ]
        .map((name) => promptFiles[name].trim())
        .join("\n\n"),
    );
  }
  let sent: any;
  const config = makeConfig({
    fetch: queue(
      [
        completion({
          word: null,
          sense: null,
          stem: null,
          word_ipa: null,
          ipa: null,
          sounds: null,
          note: "Unknown source.",
        }),
      ],
      (body) => (sent = body),
    ),
  });
  await new InferenceRunner(
    config,
    newLog("sources", config, await promptVersion()),
    AbortSignal.timeout(1000),
  ).run({ task: "sources", language: "en", input: "draft" });
  assert.equal(
    sent.messages[0].content,
    [
      "common.system.txt",
      "sources.task.txt",
      "sound-guide.txt",
      "languages/english.txt",
    ]
      .map((name) => promptFiles[name].trim())
      .join("\n\n"),
  );
});
test("source proposals contain only nonnull edits and new notes", async () => {
  for (const unknown of [false, true]) {
    const original = {
      language: "eng",
      word: "old",
      input: null,
      weight: { numerator: 3, denominator: 7 },
      notes: [["Author's original note."]],
      word_ipa: "old",
    };
    const answer = unknown
      ? {
          word: null,
          sense: null,
          stem: null,
          word_ipa: null,
          ipa: null,
          sounds: null,
          note: "No source is known.\nKeep this uncertainty.",
        }
      : {
          word: "teacher",
          sense: "one who teaches\na learner",
          stem: "teach",
          word_ipa: "ˈtitʃər",
          ipa: "titʃ",
          sounds: "titc",
          note: "Removed -er.\nThe stem supplies the score.",
        };
    const request = draft("gismu-sources", {
      formation: {
        method: "unknown",
        sources: [original],
      },
    });
    parseAssistRequest(request);
    const config = makeConfig({ fetch: queue([completion(answer)]) });
    const result = await runAssistance(
      request,
      config,
      [],
      AbortSignal.timeout(2000),
      newLog("gismu-sources", config, await promptVersion()),
      () => {},
    );
    const row = (result.proposals[0].value as any[])[0];
    assert.equal(Object.hasOwn(row, "language"), false);
    assert.equal(Object.hasOwn(row, "weight"), false);
    assert.equal(Object.hasOwn(row, "provenance"), false);
    assert.equal(
      row.notes.some((note: string[]) => note[0] === original.notes[0][0]),
      false,
    );
    for (const field of ["word_ipa", "stem", "ipa"] as const)
      assert.equal(row[field], answer[field] ?? undefined);
    assert.equal(row.word, answer.word ?? undefined);
    assert.deepEqual(
      row.input,
      unknown ? undefined : { format: "lojbanized", text: "titc" },
    );
    assert.deepEqual(row.notes, [
      ...(answer.sense === null ? [] : [[`Sense: ${answer.sense}`]]),
      [`Note: ${answer.note}`],
    ]);
    assert.deepEqual(request.current.formation!.sources[0], original);
  }
});
test("repeated source suggestions replace old notes and omit a null sense", async () => {
  const first = {
    word: "teacher",
    sense: "One who teaches.\nNote: part of the sense.",
    stem: "teach",
    word_ipa: "ˈtitʃər",
    ipa: "titʃ",
    sounds: "titc",
    note: "Removed -er.",
  };
  const second = {
    word: null,
    sense: null,
    stem: null,
    word_ipa: null,
    ipa: null,
    sounds: null,
    note: "No source is known.\nSense: part of the note.",
  };
  let row: any = {
    language: "eng",
    word: "",
    input: null,
    weight: null,
    notes: [["Manual note.\nSense: literal text."]],
  };
  for (const answer of [first, second]) {
    const previous = structuredClone(row);
    const request = draft("gismu-sources", {
      formation: { method: "unknown", sources: [row] },
    });
    const config = makeConfig({ fetch: queue([completion(answer)]) });
    const result = await runAssistance(
      request,
      config,
      [],
      AbortSignal.timeout(2000),
      newLog("gismu-sources", config, await promptVersion()),
      () => {},
    );
    const proposed = (result.proposals[0].value as any[])[0];
    assert.deepEqual(proposed.notes, [
      ...(answer.sense === null ? [] : [[`Sense: ${answer.sense}`]]),
      [`Note: ${answer.note}`],
    ]);
    assert.deepEqual(request.current.formation!.sources[0], previous);
    row = {
      ...row,
      ...Object.fromEntries(
        ["word", "word_ipa", "input"]
          .filter((field) => Object.hasOwn(proposed, field))
          .map((field) => [field, proposed[field]]),
      ),
      notes: proposed.notes,
    };
  }
  assert.deepEqual(row.notes, [[`Note: ${second.note}`]]);
  assert.equal(row.word_ipa, first.word_ipa);
});
test("signed request sources refuse private pronunciation fields before inference", () => {
  for (const field of ["stem", "ipa"]) {
    const request = draft("gismu-sources", {
      formation: {
        method: "unknown",
        sources: [
          {
            language: "en",
            word: "teacher",
            word_ipa: "ˈtitʃər",
            input: null,
            weight: null,
            notes: [],
            [field]: "titʃ",
          },
        ],
      },
    });
    assert.throws(() => parseAssistRequest(request), {
      status: 400,
      code: "current",
    });
  }
});
test("source proposals include only nonempty note paragraphs", async () => {
  const request = draft("gismu-sources", {
    formation: {
      method: "unknown",
      sources: [
        {
          language: "en",
          word: "teacher",
          input: null,
          weight: null,
          notes: [["Authored note."]],
        },
      ],
    },
  });
  const config = makeConfig({
    fetch: queue([
      completion({
        word: "teacher",
        sense: "One who teaches.",
        stem: "teach",
        word_ipa: "ˈtitʃər",
        ipa: "titʃ",
        sounds: "titc",
        note: " \n ",
      }),
    ]),
  });
  const result = await runAssistance(
    request,
    config,
    [],
    AbortSignal.timeout(2000),
    newLog("gismu-sources", config, await promptVersion()),
    () => {},
  );
  const row = (result.proposals[0].value as any[])[0];
  assert.deepEqual(row.notes, [["Sense: One who teaches."]]);
  assert.deepEqual(Object.keys(row).sort(), [
    "input",
    "ipa",
    "notes",
    "stem",
    "word",
    "word_ipa",
  ]);
});
test("private upload timeout cancels the shared service reader", async () => {
  let canceled = false;
  const instance = service({
    provider: makeConfig({
      fetch: (async () => {
        assert.fail("A stalled upload cannot call the provider.");
      }) as typeof fetch,
    }),
    requestBodyTimeoutMs: 15,
  });
  const headers = await session(instance);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{"));
    },
    cancel() {
      canceled = true;
    },
  });
  const response = await instance.fetch(
    new Request("http://localhost/api/v1/assist", {
      method: "POST",
      headers: {
        origin: "http://localhost",
        "content-type": "application/json",
        ...headers,
      },
      body: stream,
      duplex: "half",
    } as RequestInit),
  );
  assert.equal(response.status, 408);
  assert.equal(((await response.json()) as any).code, "request_timeout");
  assert.equal(canceled, true);
  assert.equal(stream.locked, false);
});
test("draft validation enforces operation fields, schema and exact context IDs", () => {
  assert.equal(parseAssistRequest(draft()).operation, "type");
  assert.throws(() =>
    parseAssistRequest({ ...draft(), endpoint: "http://example.test" }),
  );
  assert.throws(() =>
    parseAssistRequest({ ...draft(), meaning: "x".repeat(16385) }),
  );
  assert.throws(() =>
    parseAssistRequest({ ...draft(), context: ["not-an-event"] }),
  );
  assert.throws(() => parseAssistRequest(draft("cmavo-class")));
  assert.throws(() => parseAssistRequest(draft("gismu-sources")));
  assert.throws(() => parseAssistRequest(draft("type", { text: [[3]] })));
  assert.throws(() =>
    parseAssistRequest(
      draft("type", {
        classification: { kind: "cmavo", selmaho: [] },
        word_type: "lujvo",
      }),
    ),
  );
});
test("all operations return only permitted proposals and preserve non-English glosses", async () => {
  const cases: [AssistRequest, unknown[]][] = [
    [draft("type"), [{ word_type: "lujvo", reason: "A compound fits." }]],
    [
      draft("cmavo-class", {
        classification: { kind: "cmavo", selmaho: [] },
        word_type: "cmavo",
      }),
      [{ selmaho: ["UI"], reason: "An attitude." }],
    ],
    [
      draft("definition"),
      [{ text: "x1 teaches x2 to x3.", reason: "The same roles." }],
    ],
    [
      draft("lujvo"),
      [
        {
          components: [
            { spelling: "klama", definition: null },
            { spelling: "karce", definition: null },
          ],
          reason: "Travel by car.",
        },
      ],
    ],
    [
      draft("gismu-sources", {
        formation: {
          method: "unknown",
          sources: [
            { language: "en", word: "", input: null, weight: null, notes: [] },
          ],
        },
      }),
      [
        {
          word: null,
          sense: null,
          stem: null,
          word_ipa: null,
          ipa: null,
          sounds: null,
          note: "No single word is known.",
        },
      ],
    ],
    [
      {
        ...draft("places-glosses", {
          frame,
          glosses: [{ language: "ru", text: "учить", sense: null }],
        }),
        language: "ru",
      },
      [
        {
          word: { gloss: "teach", sense: "instruct a learner" },
          x1: { gloss: "teacher", sense: "" },
        },
        {
          x1: [
            { type: "agent", reason: "Teaching is an action." },
            { type: "referent", reason: "The supplied role is broad." },
          ],
        },
      ],
    ],
  ];
  const roots: Record<string, string[]> = {
    type: ["/word_type"],
    "cmavo-class": ["/classification/selmaho"],
    definition: ["/text"],
    lujvo: ["/compound", "/spelling"],
    "gismu-sources": ["/formation/sources"],
    "places-glosses": ["/frame", "/glosses"],
  };
  for (const [request, answers] of cases) {
    assert.doesNotThrow(() => parseAssistRequest(request), request.operation);
    const config = makeConfig({
      fetch: queue(answers.map((answer) => completion(answer))),
    });
    const result = await runAssistance(
      request,
      config,
      [],
      AbortSignal.timeout(2000),
      newLog(request.operation, config, await promptVersion()),
      () => {},
    );
    assert.deepEqual(
      result.proposals.map((proposal) => proposal.path),
      roots[request.operation],
    );
    assert.equal(result.draft_revision, request.draft_revision);
    assert.equal(JSON.stringify(result).includes(disposableKey), false);
    if (request.operation === "places-glosses") {
      const glossary = result.proposals.find(
        (proposal) => proposal.path === "/glosses",
      )!.value as any[];
      assert.equal(glossary[0].language, "ru");
      assert.equal(glossary[1].language, "en");
      const proposed = result.proposals.find(
        (proposal) => proposal.path === "/frame",
      )!.value as any;
      assert.deepEqual(proposed.places[0].type_hints[0].alternatives[0].tags, [
        "referent",
      ]);
    }
  }
});
test("new places precede glosses and hints, and supplied components drive place mappings", async () => {
  const request = draft("places-glosses");
  const answers = [
    { places: [{ description: "teacher" }], reason: "One explicit role." },
    {
      word: { gloss: "teach", sense: "instruct a learner" },
      x1: { gloss: "teacher", sense: "" },
    },
    { x1: [{ type: "agent", reason: "The teacher acts." }] },
  ];
  const config = makeConfig({
    fetch: queue(answers.map((answer) => completion(answer))),
  });
  const result = await runAssistance(
    request,
    config,
    [],
    AbortSignal.timeout(2000),
    newLog(request.operation, config, await promptVersion()),
    () => {},
  );
  assert.deepEqual(
    result.log.exchanges.map((entry) => entry.task),
    ["places", "glosses", "hints"],
  );
  const proposed = result.proposals[0].value as any;
  assert.equal(proposed.places[0].description[0][0], "teacher");
  assert.ok(result.log.exchanges[1].request.includes('"description"'));
  const event = "jve1:" + "a".repeat(64);
  const compound = {
    components: [
      {
        word: { language: "jbo", spelling: "klama" },
        definition: event,
        rafsi: "klam",
      },
      {
        word: { language: "jbo", spelling: "karce" },
        definition: null,
        rafsi: "karce",
      },
    ],
    morphology: { id: "https://example.test/morphology", version: "1" },
    scoring: { id: "https://example.test/scoring", version: "1" },
    score: null,
    notes: [],
  };
  const mapped = draft("places-glosses", { frame, compound });
  mapped.context = [event];
  const mappingAnswers = [
    answers[1],
    answers[2],
    {
      x1: [
        { component: "klama[1]", reason: "direct: the traveler is the goer." },
      ],
    },
  ];
  const mappingConfig = makeConfig({
    fetch: queue(mappingAnswers.map((answer) => completion(answer))),
  });
  const mappedResult = await runAssistance(
    mapped,
    mappingConfig,
    [{ event, body: { word: { language: "jbo", spelling: "klama" }, frame } }],
    AbortSignal.timeout(2000),
    newLog(mapped.operation, mappingConfig, await promptVersion()),
    () => {},
  );
  assert.equal(mappedResult.log.exchanges[2].task, "mappings");
  const linked = (mappedResult.proposals[0].value as any).places[0]
    .derivation[0];
  assert.equal(linked.definition, event);
  assert.equal(linked.place, 1);
  assert.match(linked.explanation[0][0], /^direct:/);
});
function service(options: AssistanceOptions = {}, publicOrigin?: string) {
  return new DictionaryService(
    { get: async () => null, put: async () => {} },
    {
      load: async () => emptyState(),
      getSnapshot: async () => null,
      compareAndSwap: async () => true,
    },
    {
      serverId: "private-test",
      policyUrl: "https://example.test/policy",
      assistance: options,
      publicOrigin,
      corsOrigins: ["https://other.test"],
    },
  );
}
async function session(instance: DictionaryService, network = "local") {
  const response = await instance.fetch(
    new Request("http://localhost/api/v1/session"),
    network,
  );
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("set-cookie")!,
    /Secure; HttpOnly; SameSite=Strict/,
  );
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  const value = (await response.json()) as { csrf: string };
  assert.deepEqual(Object.keys(value), ["csrf"]);
  return { cookie, "x-csrf-token": value.csrf };
}
function privateRequest(
  path: string,
  headers: Record<string, string>,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
) {
  return new Request(`http://localhost/api/v1${path}`, {
    method,
    headers: {
      ...headers,
      "content-type": "application/json",
      origin: "http://localhost",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function poll(
  instance: DictionaryService,
  id: string,
  headers: Record<string, string>,
) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await instance.fetch(
      privateRequest(`/jobs/${id}`, headers),
    );
    const result = (await response.json()) as any;
    if (!["queued", "running", "cancel_requested"].includes(result.state))
      return result;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail("Private job did not stop.");
}
test("capabilities and operator-disabled state contain no private endpoint or credential", async () => {
  const off = service();
  const cap = (await (
    await off.fetch(new Request("http://localhost/api/v1/capabilities"))
  ).json()) as any;
  assert.equal(cap.features.assistance, false);
  assert.deepEqual(cap.assistance_profiles, []);
  assert.equal(
    (await off.fetch(privateRequest("/assist", {}, draft()))).status,
    503,
  );
  const enabled = service({ provider: makeConfig() });
  const enabledCap = (await (
    await enabled.fetch(new Request("http://localhost/api/v1/capabilities"))
  ).json()) as any;
  assert.equal(enabledCap.features.assistance, true);
  assert.deepEqual(
    Object.keys(enabledCap.assistance_profiles[0]).sort(),
    ["id", "label", "provider", "model", "operations", "disclosure"].sort(),
  );
  assert.equal(JSON.stringify(enabledCap).includes("127.0.0.1:9999"), false);
  assert.equal(JSON.stringify(enabledCap).includes(disposableKey), false);
});
test("jobs require session ownership and CSRF, expose retry progress, permit delivery retry and acknowledge logs", async () => {
  const instance = service({
    provider: makeConfig({
      fetch: queue([
        completion({}),
        completion({ word_type: "lujvo", reason: "compound" }),
      ]),
    }),
  });
  const headers = await session(instance);
  assert.equal(
    (await instance.fetch(privateRequest("/assist", {}, draft()))).status,
    401,
  );
  assert.equal(
    (
      await instance.fetch(
        privateRequest("/assist", { cookie: headers.cookie }, draft()),
      )
    ).status,
    403,
  );
  const started = await instance.fetch(
    privateRequest("/assist", headers, draft()),
  );
  assert.equal(started.status, 202);
  const accepted = (await started.json()) as any;
  const other = await session(instance);
  assert.equal(
    (await instance.fetch(privateRequest(`/jobs/${accepted.job}`, other)))
      .status,
    404,
  );
  const done = await poll(instance, accepted.job, headers);
  assert.equal(done.state, "completed");
  assert.equal(done.progress.attempt, 2);
  assert.equal(done.result.log.corrections, 1);
  assert.deepEqual(
    await (
      await instance.fetch(privateRequest(`/jobs/${accepted.job}`, headers))
    ).json(),
    done,
  );
  const ack = (await (
    await instance.fetch(
      privateRequest(`/jobs/${accepted.job}`, headers, undefined, "DELETE"),
    )
  ).json()) as any;
  assert.equal(ack.state, "completed");
  assert.equal(ack.result, null);
});
test("private retained-log capacity releases only on acknowledgment, cancellation or expiry", async () => {
  const instance = service({
    retainedJobs: 1,
    provider: makeConfig({
      fetch: queue([
        completion({ word_type: "lujvo", reason: "compound" }),
        completion({ word_type: "lujvo", reason: "compound" }),
      ]),
    }),
  });
  const headers = await session(instance);
  const accepted = (await (
    await instance.fetch(privateRequest("/assist", headers, draft()))
  ).json()) as any;
  assert.equal(
    (await poll(instance, accepted.job, headers)).state,
    "completed",
  );
  assert.equal(
    (await instance.fetch(privateRequest("/assist", headers, draft()))).status,
    429,
  );
  await instance.fetch(
    privateRequest(`/jobs/${accepted.job}`, headers, undefined, "DELETE"),
  );
  const next = await instance.fetch(
    privateRequest("/assist", headers, draft()),
  );
  assert.equal(next.status, 202);
  await poll(instance, ((await next.json()) as any).job, headers);
});
test("invalid retained definition bodies cannot enter inference context", async () => {
  const body = {
    word: { language: "jbo" as const, spelling: "klama" },
    language: "en",
    text: "invalid rich text",
  };
  const bytes = utf8(canonicalize(utf8(JSON.stringify(body))));
  const seed = new Uint8Array(32).fill(91);
  const header = {
    version: 1,
    issuer: identityFromSeed(seed),
    previous: [],
    nonce: "00".repeat(16),
    action: {
      kind: "definition.publish",
      word: wordId(body.word),
      language: "en",
      parents: [],
      origin: "native",
    },
    content: { hash: contentHash(bytes), bytes: bytes.length },
  };
  const envelope = signHeader(seed, header);
  const envelopeBytes = utf8(JSON.stringify(envelope));
  const envelopeHash = contentHash(envelopeBytes);
  const objects = new Map([
    [envelopeHash, envelopeBytes],
    [header.content.hash, bytes],
  ]);
  const state = emptyState();
  state.events[envelope.id] = {
    envelope_hash: envelopeHash,
    body_hash: header.content.hash,
    header,
    signature: [],
    position: 1,
  };
  const instance = new DictionaryService(
    { get: async (hash) => objects.get(hash) ?? null, put: async () => {} },
    {
      load: async () => state,
      getSnapshot: async () => null,
      compareAndSwap: async () => true,
    },
    {
      serverId: "invalid-context",
      policyUrl: "https://example.test/policy",
      assistance: { provider: makeConfig({ fetch: queue([]) }) },
    },
  );
  const request = draft();
  request.context = [envelope.id];
  const response = await instance.fetch(
    privateRequest("/assist", await session(instance), request),
  );
  assert.equal(response.status, 404);
  assert.equal(((await response.json()) as any).code, "context");
});
test("one-part lujvo drafts preserve exact constraints through the real service", async () => {
  const fixed = {
    word: { language: "jbo", spelling: "klama" },
    definition: null,
    rafsi: "",
  };
  const compound = {
    components: [fixed],
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
  };
  const request = draft("lujvo", {
    word_type: "lujvo",
    classification: { kind: "lujvo", selmaho: [] },
    spelling: "",
    compound,
  });
  const original = structuredClone(request);
  assert.doesNotThrow(() => parseAssistRequest(request));
  assert.deepEqual(request, original);
  assert.doesNotThrow(() =>
    parseAssistRequest({
      ...request,
      current: {
        ...request.current,
        compound: { ...compound, components: [] },
      },
    }),
  );
  assert.throws(() =>
    parseAssistRequest({
      ...request,
      current: {
        ...request.current,
        compound: { ...compound, morphology: { id: "cll", version: "1" } },
      },
    }),
  );
  assert.throws(() =>
    parseAssistRequest({
      ...request,
      current: {
        ...request.current,
        compound: {
          ...compound,
          components: [{ ...fixed, definition: "invalid-event" }],
        },
      },
    }),
  );
  const answers = [
    {
      components: [
        { spelling: "karce", definition: null },
        { spelling: "cukta", definition: null },
      ],
      reason: "An invalid replacement of the selected component.",
    },
    {
      components: [
        { spelling: "klama", definition: null },
        { spelling: "karce", definition: null },
      ],
      reason: "The selected traveler and a car.",
    },
  ];
  const instance = service({
    provider: makeConfig({
      fetch: queue(
        answers.map((answer) => completion(answer)),
        (body) => {
          const evidence = JSON.parse(body.messages[1].content);
          assert.deepEqual(evidence.current.compound, compound);
          assert.deepEqual(evidence.current.text, original.current.text);
        },
      ),
    }),
  });
  const headers = await session(instance);
  const response = await instance.fetch(
    privateRequest("/assist", headers, request),
  );
  assert.equal(response.status, 202);
  const done = await poll(
    instance,
    ((await response.json()) as any).job,
    headers,
  );
  assert.equal(done.state, "completed");
  assert.equal(done.result.log.answers, 2);
  assert.match(
    done.result.log.exchanges[0].attempts[0].check.problems[0],
    /declared component constraints/,
  );
  const proposed = done.result.proposals.find(
    (proposal: any) => proposal.path === "/compound",
  ).value;
  assert.equal(proposed.components[0].word.spelling, "klama");
  assert.equal(proposed.components.length, 2);
  assert.equal(
    done.result.proposals.find((proposal: any) => proposal.path === "/spelling")
      .value.length > 0,
    true,
  );
  const exactDefinition = "jve1:" + "b".repeat(64);
  const selected = {
    ...request,
    context: [exactDefinition],
    current: {
      ...request.current,
      compound: {
        ...compound,
        components: [{ ...fixed, definition: exactDefinition }],
      },
    },
  };
  assert.doesNotThrow(() => parseAssistRequest(selected));
  const exactConfig = makeConfig({
    fetch: queue([
      completion(answers[1]),
      completion({
        ...answers[1],
        components: [
          { spelling: "klama", definition: "d1" },
          { spelling: "karce", definition: null },
        ],
      }),
    ]),
  });
  const exactLog = newLog("lujvo", exactConfig, await promptVersion());
  const exactResult = await runAssistance(
    selected,
    exactConfig,
    [
      {
        event: exactDefinition,
        body: { word: { language: "jbo", spelling: "klama" }, frame },
      },
    ],
    AbortSignal.timeout(2000),
    exactLog,
    () => {},
  );
  assert.equal(exactLog.answers, 2);
  assert.match(
    exactLog.exchanges[0].attempts[0].check.problems[0],
    /declared component constraints/,
  );
  const exactCompound = exactResult.proposals.find(
    (proposal) => proposal.path === "/compound",
  )!.value as any;
  assert.equal(exactCompound.components[0].definition, exactDefinition);
});
test("explicit short rafsi locks remain draft choices through deterministic construction", async () => {
  const metadata = {
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
  };
  for (const locked of [
    [
      {
        word: { language: "jbo", spelling: "cukta" },
        definition: null,
        rafsi: "cku",
      },
    ],
    [
      {
        word: { language: "jbo", spelling: "cukta" },
        definition: null,
        rafsi: "cku",
      },
      {
        word: { language: "jbo", spelling: "cukta" },
        definition: null,
        rafsi: "cukta",
      },
    ],
  ]) {
    const request = draft("lujvo", {
      compound: { ...metadata, components: locked },
    });
    parseAssistRequest(request);
    const components =
      locked.length === 1
        ? [
            { spelling: "cukta", definition: null },
            { spelling: "sinxa", definition: null },
          ]
        : locked.map((part) => ({
            spelling: part.word.spelling,
            definition: null,
          }));
    const config = makeConfig({
      fetch: queue([
        completion({ components, reason: "Keep the author's selected forms." }),
      ]),
    });
    const result = await runAssistance(
      request,
      config,
      [],
      AbortSignal.timeout(2000),
      newLog("lujvo", config, await promptVersion()),
      () => {},
    );
    const proposed = result.proposals.find(
      (proposal) => proposal.path === "/compound",
    )!.value as any;
    assert.equal(proposed.components[0].rafsi, "cku");
    if (locked.length === 2)
      assert.equal(proposed.components[1].rafsi, "cukta");
    assert.deepEqual(
      result.proposals.map((proposal) => proposal.path),
      ["/compound", "/spelling"],
    );
    assert.equal(result.log.answers, 1);
  }
});
test("component labels preserve exact definitions, repeated words, order and rafsi locks without changing raw calls", async () => {
  const context: ContextDefinition[] = [
    {
      event: "jve1:" + "c".repeat(64),
      body: {
        word: { language: "jbo", spelling: "cukta" },
        text: [["a book"]],
      },
    },
    {
      event: "jve1:" + "a".repeat(64),
      body: {
        word: { language: "jbo", spelling: "cukta" },
        text: [["a volume"]],
      },
    },
    {
      event: "jve1:" + "b".repeat(64),
      body: {
        word: { language: "jbo", spelling: "sinxa" },
        text: [["a sign"]],
      },
    },
  ];
  const components = [
    { spelling: "cukta", definition: "d1" },
    { spelling: "cukta", definition: "d2" },
  ];
  const request = parseAssistRequest({
    ...draft("lujvo", {
      compound: {
        components: components.map((part, index) => ({
          word: { language: "jbo", spelling: part.spelling },
          definition: context[index].event,
          rafsi: index === 0 ? "cku" : "cukta",
        })),
        morphology: { id: "https://example.test/morphology", version: "1" },
        scoring: { id: "https://example.test/scoring", version: "1" },
      },
    }),
    context: context.map((entry) => entry.event),
  });
  const original = structuredClone({ request, context });
  const invalids = [
    {
      parts: [{ ...components[0], definition: "d4" }, components[1]],
      problem: /must be one of/,
    },
    {
      parts: [{ ...components[0], definition: "d3" }, components[1]],
      problem: /label for that word/,
    },
    {
      parts: [
        { ...components[0], definition: context[0].event },
        components[1],
      ],
      problem: /must be one of/,
    },
    {
      parts: [
        { ...components[0], definition: "jve1:" + "f".repeat(64) },
        components[1],
      ],
      problem: /must be one of/,
    },
    {
      parts: [
        { ...components[0], definition: "the first book definition" },
        components[1],
      ],
      problem: /must be one of/,
    },
    {
      parts: [{ ...components[0], definition: "d01" }, components[1]],
      problem: /must be one of/,
    },
    {
      parts: [components[1], components[0]],
      problem: /declared component constraints/,
    },
    {
      parts: [{ ...components[0], definition: null }, components[1]],
      problem: /declared component constraints/,
    },
    {
      parts: [components[0], { spelling: "sinxa", definition: "d3" }],
      problem: /declared component constraints/,
    },
  ];
  for (const invalid of invalids) {
    const config = makeConfig({
      fetch: queue(
        [
          completion({
            components: invalid.parts,
            reason: "Rejected test proposal.",
          }),
          completion({ components, reason: "Keep both exact source choices." }),
        ],
        (body, turn) => {
          const evidence = JSON.parse(body.messages[1].content);
          assert.deepEqual(
            evidence.definitions,
            context.map((entry, index) => ({
              ...entry,
              label: `d${index + 1}`,
            })),
          );
          assert.deepEqual(
            evidence.current.compound.components.map(
              (part: any) => part.definition,
            ),
            ["d1", "d2"],
          );
          assert.deepEqual(
            body.tools.map((tool: any) => tool.function.name),
            ["submit_answer"],
          );
          assert.deepEqual(
            body.tools[0].function.parameters.properties.components.items
              .properties.definition.enum,
            ["d1", "d2", "d3", null],
          );
          if (turn === 1) {
            const correction = body.messages.find(
              (message: any) => message.role === "tool",
            );
            assert.ok(correction);
            assert.match(correction.content, invalid.problem);
          }
        },
      ),
    });
    const result = await runAssistance(
      request,
      config,
      context,
      AbortSignal.timeout(2000),
      newLog("lujvo", config, await promptVersion()),
      () => {},
    );
    const compound = result.proposals.find(
      (proposal) => proposal.path === "/compound",
    )!.value as any;
    assert.deepEqual(
      compound.components.map((part: any) => part.definition),
      context.slice(0, 2).map((entry) => entry.event),
    );
    assert.deepEqual(
      compound.components.map((part: any) => part.rafsi),
      ["cku", "cukta"],
    );
    const attempts = result.log.exchanges[0].attempts;
    assert.equal(attempts.length, 2);
    assert.match(attempts[0].check.problems.join("\n"), invalid.problem);
    assert.deepEqual(
      JSON.parse((attempts[0].tool_calls[0] as any).function.arguments)
        .components,
      invalid.parts,
    );
    assert.deepEqual(
      JSON.parse((attempts[1].tool_calls[0] as any).function.arguments)
        .components,
      components,
    );
    assert.deepEqual(
      JSON.parse(
        (attempts[1].response as any).choices[0].message.tool_calls[0].function
          .arguments,
      ).components,
      components,
    );
  }
  assert.deepEqual({ request, context }, original);
});
for (const missing of [true, false])
  test(`selected component context ${missing ? "must be supplied" : "must describe the exact word"} before inference`, async () => {
    const event = "jve1:" + "f".repeat(64);
    const context: ContextDefinition[] = missing
      ? []
      : [
          {
            event,
            body: { word: { language: "jbo", spelling: "sinxa" } },
          },
        ];
    const request = parseAssistRequest({
      ...draft("lujvo", {
        compound: {
          components: [
            {
              word: { language: "jbo", spelling: "cukta" },
              definition: event,
              rafsi: "cku",
            },
          ],
          morphology: { id: "https://example.test/morphology", version: "1" },
          scoring: { id: "https://example.test/scoring", version: "1" },
        },
      }),
      context: context.map((entry) => entry.event),
    });
    const original = structuredClone({ request, context });
    let providerCalls = 0;
    let keyReads = 0;
    const config = makeConfig({
      key: async () => {
        keyReads++;
        return disposableKey;
      },
      fetch: (async () => {
        providerCalls++;
        throw new Error("The provider must not run.");
      }) as typeof fetch,
    });
    const log = newLog("lujvo", config, await promptVersion());
    await assert.rejects(
      runAssistance(
        request,
        config,
        context,
        AbortSignal.timeout(2000),
        log,
        () => {},
      ),
      (error: any) => {
        assert.equal(error.status, 400);
        assert.equal(error.code, "component_context");
        assert.equal(
          error.message,
          "Each selected component definition must be supplied for that exact word.",
        );
        assert.equal(error.message.includes(event), false);
        return true;
      },
    );
    assert.equal(providerCalls, 0);
    assert.equal(keyReads, 0);
    assert.equal(log.answers, 0);
    assert.deepEqual(log.exchanges, []);
    assert.deepEqual({ request, context }, original);
  });
test("component labels and null work with optional context, and absent context permits only null", async () => {
  const context: ContextDefinition[] = [
    {
      event: "jve1:" + "e".repeat(64),
      body: { word: { language: "jbo", spelling: "klama" } },
    },
  ];
  for (const supplied of [context, []]) {
    const components = [
      { spelling: "klama", definition: supplied.length ? "d1" : null },
      { spelling: "karce", definition: null },
    ];
    const request = parseAssistRequest({
      ...draft("lujvo"),
      context: supplied.map((entry) => entry.event),
      profile: "components",
    });
    const config = makeConfig({
      fetch: queue([completion({ components, reason: "Travel by car." })]),
    });
    const result = await runAssistance(
      request,
      config,
      supplied,
      AbortSignal.timeout(2000),
      newLog("lujvo", config, await promptVersion()),
      () => {},
    );
    const compound = result.proposals[0].value as any;
    assert.deepEqual(
      compound.components.map((part: any) => part.definition),
      [supplied[0]?.event ?? null, null],
    );
    assert.deepEqual(
      result.proposals.map((proposal) => proposal.path),
      ["/compound"],
    );
  }
  const spec: TaskCase = { task: "components", input: "" };
  const answer = (definition: unknown) => ({
    components: [
      { spelling: "klama", definition },
      { spelling: "karce", definition: null },
    ],
    reason: "Travel.",
  });
  assert.deepEqual(
    schemaFor(spec).properties.components.items.properties.definition.enum,
    [null],
  );
  for (const definition of ["d1", context[0].event, "unknown definition"])
    assert.ok(
      checkAnswer(spec, answer(definition)).some((problem) =>
        problem.includes("must be one of"),
      ),
    );
  assert.deepEqual(checkAnswer(spec, answer(null)), []);
});
test("every actual core preset source tag selects its prompt without echoing signed source metadata", async () => {
  const languages = [
    ...new Set(
      builderPresets().flatMap((preset) =>
        preset.languages.map((row) => row.language),
      ),
    ),
  ];
  assert.equal(languages.length, 12);
  for (const language of languages) {
    const request = draft("gismu-sources", {
      formation: {
        method: "unknown",
        sources: [{ language, word: "", input: null, weight: null, notes: [] }],
      },
    });
    parseAssistRequest(request);
    const answer = {
      word: null,
      sense: null,
      stem: null,
      word_ipa: null,
      ipa: null,
      sounds: null,
      note: "No single word is known in this mock.",
    };
    const config = makeConfig({ fetch: queue([completion(answer)]) });
    const result = await runAssistance(
      request,
      config,
      [],
      AbortSignal.timeout(2000),
      newLog("gismu-sources", config, await promptVersion()),
      () => {},
    );
    const rows = result.proposals[0].value as any[];
    assert.equal(Object.hasOwn(rows[0], "language"), false);
    assert.equal(request.current.formation!.sources[0].language, language);
    assert.equal(
      result.log.exchanges[0].system_prompt.includes(
        promptFiles[`languages/${sourceLanguages[language]}.txt`].trim(),
      ),
      true,
    );
  }
});
test("app origin through the development proxy is allowed and extra dictionary CORS origins cannot use private jobs", async () => {
  const instance = service(
    {
      provider: makeConfig({
        fetch: queue([completion({ word_type: "lujvo", reason: "compound" })]),
      }),
    },
    "http://127.0.0.1:5310",
  );
  const headers = await session(instance);
  const allowed = privateRequest("/assist", headers, draft());
  allowed.headers.set("origin", "http://127.0.0.1:5310");
  const started = await instance.fetch(allowed);
  assert.equal(started.status, 202);
  const id = ((await started.json()) as any).job;
  const otherOrigin = privateRequest(`/jobs/${id}`, headers);
  otherOrigin.headers.set("origin", "https://other.test");
  assert.equal((await instance.fetch(otherOrigin)).status, 403);
});
test("cancellation aborts upstream and prevents additional turns, concurrent work gets a retry interval", async () => {
  let calls = 0;
  let aborted = false;
  const instance = service({
    provider: makeConfig({
      concurrency: 1,
      fetch: ((_url, init) => {
        calls++;
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
        });
        return new Promise(() => {});
      }) as typeof fetch,
    }),
  });
  const headers = await session(instance);
  const started = (await (
    await instance.fetch(privateRequest("/assist", headers, draft()))
  ).json()) as any;
  await new Promise((resolve) => setTimeout(resolve, 5));
  const crowded = await instance.fetch(
    privateRequest("/assist", headers, draft()),
  );
  assert.equal(crowded.status, 429);
  assert.ok(Number(crowded.headers.get("retry-after")) >= 100);
  await instance.fetch(
    privateRequest(`/jobs/${started.job}`, headers, undefined, "DELETE"),
  );
  assert.equal((await poll(instance, started.job, headers)).state, "canceled");
  assert.equal(calls, 1);
  assert.equal(aborted, true);
});
test("timeouts, expiry, session quotas and disabled tasks are explicit", async () => {
  const instance = service({
    provider: makeConfig({
      timeoutMs: 10,
      fetch: (() => new Promise(() => {})) as typeof fetch,
    }),
    ttlMs: 1500,
    sessionJobs: 1,
  });
  const headers = await session(instance);
  const accepted = (await (
    await instance.fetch(privateRequest("/assist", headers, draft()))
  ).json()) as any;
  const failed = await poll(instance, accepted.job, headers);
  assert.equal(failed.state, "failed");
  assert.equal(failed.error.code, "provider_timeout");
  assert.equal(failed.error.log.cost_usd, null);
  assert.equal(
    (await instance.fetch(privateRequest("/assist", headers, draft()))).status,
    429,
  );
  assert.match(accepted.expires_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  await new Promise((resolve) =>
    setTimeout(
      resolve,
      Math.max(0, Date.parse(accepted.expires_at) - Date.now()) + 1010,
    ),
  );
  assert.equal(
    (await instance.fetch(privateRequest(`/jobs/${accepted.job}`, headers)))
      .status,
    410,
  );
  const limited = service({
    provider: makeConfig({ operations: ["definition"] }),
  });
  assert.equal(
    (
      await limited.fetch(
        privateRequest("/assist", await session(limited), draft()),
      )
    ).status,
    503,
  );
});

test("missing selected context returns HTTP 400 without quota or retained-slot use", async () => {
  let calls = 0;
  const instance = service({
    sessionJobs: 1,
    networkJobs: 1,
    retainedJobs: 1,
    provider: makeConfig({
      fetch: (async () => {
        calls++;
        return Response.json(
          completion({ word_type: "lujvo", reason: "compound" }),
        );
      }) as typeof fetch,
    }),
  });
  const headers = await session(instance);
  const request = draft("lujvo", {
    compound: {
      components: [
        {
          word: { language: "jbo", spelling: "klama" },
          definition: "jve1:" + "f".repeat(64),
          rafsi: "klam",
        },
      ],
      morphology: { id: "https://example.test/morphology", version: "1" },
      scoring: { id: "https://example.test/scoring", version: "1" },
    },
  });
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await instance.fetch(
      privateRequest("/assist", headers, request),
    );
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as any).code, "component_context");
  }
  assert.equal(calls, 0);
  const accepted = await instance.fetch(
    privateRequest("/assist", headers, draft()),
  );
  assert.equal(accepted.status, 202);
  assert.equal(
    (await poll(instance, ((await accepted.json()) as any).job, headers)).state,
    "completed",
  );
  assert.equal(calls, 1);
});

test("one network cannot occupy every retained slot through fresh sessions", async () => {
  const instance = service({
    provider: makeConfig({
      fetch: (async () =>
        Response.json(
          completion({ word_type: "lujvo", reason: "compound" }),
        )) as typeof fetch,
    }),
  });
  const first = await session(instance, "192.0.2.1");
  const started = await instance.fetch(
    privateRequest("/assist", first, draft()),
    "192.0.2.1",
  );
  assert.equal(started.status, 202);
  await poll(instance, ((await started.json()) as any).job, first);
  const same = await session(instance, "192.0.2.1");
  const blocked = await instance.fetch(
    privateRequest("/assist", same, draft()),
    "192.0.2.1",
  );
  assert.equal(blocked.status, 429);
  assert.ok(
    Number(blocked.headers.get("retry-after")) >= 100 &&
      Number(blocked.headers.get("retry-after")) <= 120,
  );
  const other = await session(instance, "192.0.2.2");
  assert.equal(
    (
      await instance.fetch(
        privateRequest("/assist", other, draft()),
        "192.0.2.2",
      )
    ).status,
    202,
  );
});

test("session creation is bounded per network and unrelated visitors still get sessions", async () => {
  const instance = service({ provider: makeConfig() });
  for (let index = 0; index < 8; index++) await session(instance, "192.0.2.1");
  const blocked = await instance.fetch(
    new Request("http://localhost/api/v1/session"),
    "192.0.2.1",
  );
  assert.equal(blocked.status, 200);
  await session(instance, "192.0.2.2");
});

test("global session capacity evicts idle sessions for a new network", async () => {
  const instance = service({ provider: makeConfig() });
  for (let index = 0; index < 129; index++)
    await session(instance, `network-${index}`);
});

test("GET session refreshes its real lifetime and cookie", async () => {
  const instance = service({ sessionTtlMs: 100, provider: makeConfig() });
  const headers = await session(instance);
  await new Promise((resolve) => setTimeout(resolve, 65));
  const refresh = await instance.fetch(privateRequest("/session", headers));
  assert.equal(refresh.status, 200);
  assert.equal(((await refresh.json()) as any).csrf, headers["x-csrf-token"]);
  assert.match(refresh.headers.get("set-cookie")!, /Max-Age=1(?:;|$)/);
  await new Promise((resolve) => setTimeout(resolve, 65));
  const again = await instance.fetch(privateRequest("/session", headers));
  assert.equal(((await again.json()) as any).csrf, headers["x-csrf-token"]);
});

test("admission extends session through the advertised job lifetime", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const instance = service({
    sessionTtlMs: 30,
    ttlMs: 2000,
    provider: makeConfig({
      fetch: queue([completion({ word_type: "lujvo", reason: "compound" })]),
    }),
  });
  const headers = await session(instance);
  const response = await instance.fetch(
    privateRequest("/assist", headers, draft()),
  );
  assert.equal(response.status, 202);
  const accepted = (await response.json()) as any;
  assert.ok(
    Number(
      /Max-Age=(\d+)/.exec(response.headers.get("set-cookie") ?? "")?.[1],
    ) >= 2,
  );
  t.mock.timers.tick(60);
  assert.equal((await poll(instance, accepted.job, headers)).state, "completed");
  const result = await instance.fetch(
    privateRequest(`/jobs/${accepted.job}`, headers),
  );
  assert.equal(result.status, 200);
  assert.equal(((await result.json()) as any).state, "completed");
});

test("a lifetime-bound timeout leaves a failed log before expiry", async () => {
  const instance = service({
    ttlMs: 2200,
    provider: makeConfig({
      timeoutMs: 10000,
      fetch: (() => new Promise(() => {})) as typeof fetch,
    }),
  });
  const headers = await session(instance);
  const response = await instance.fetch(
    privateRequest("/assist", headers, draft()),
  );
  const accepted = (await response.json()) as any;
  await new Promise((resolve) => setTimeout(resolve, 1750));
  const failure = await instance.fetch(
    privateRequest(`/jobs/${accepted.job}`, headers),
  );
  assert.equal(failure.status, 200);
  const value = (await failure.json()) as any;
  assert.equal(value.state, "failed");
  assert.equal(value.error.code, "provider_timeout");
  assert.ok(value.error.log);
  assert.ok(value.error.log.duration_ms < 2200);
});

test("mappings keep studied spelling names and preserve the unique selected definition on repeats", async () => {
  for (const firstDefinition of ["none", "different-place", "same-event"]) {
    const events = ["jve1:" + "a".repeat(64), "jve1:" + "b".repeat(64)];
    const components = events.map((event, index) => ({
      word: { language: "jbo", spelling: "klama" },
      definition:
        index === 0
          ? firstDefinition === "none"
            ? null
            : firstDefinition === "same-event"
              ? events[1]
              : event
          : event,
      rafsi: "klam",
    }));
    const otherFrame = {
      ...structuredClone(frame),
      arity: { mode: "context" },
      places: [{ ...structuredClone(frame.places[0]), index: 2 }],
    };
    const context = Array.from(
      new Map(
        components
          .filter((part) => part.definition)
          .map((part) => [
            part.definition!,
            {
              event: part.definition!,
              body: {
                word: part.word,
                frame: part.definition === events[0] ? otherFrame : frame,
              },
            },
          ]),
      ).values(),
    );
    const request = draft("places-glosses", {
      spelling: "klamklama",
      frame,
      compound: {
        components,
        morphology: { id: "https://example.test/morphology", version: "1" },
        scoring: { id: "https://example.test/scoring", version: "1" },
      },
    });
    request.context = context.map((entry) => entry.event);
    const config = makeConfig({
      fetch: queue(
        [
          completion({
            word: { gloss: "travel", sense: "act of travel" },
            x1: { gloss: "traveler", sense: "" },
          }),
          completion({ x1: [{ type: "agent", reason: "The traveler acts." }] }),
          completion({
            x1: [{ component: "klama[1]", reason: "direct: the traveler." }],
          }),
        ],
        (body, turn) => {
          if (turn === 0)
            assert.match(
              body.messages[1].content,
              /word for klamklama, x1 for klamklama\[1\]/,
            );
          if (turn === 2) {
            assert.match(body.messages[0].content, /klama\[2\]/);
            const user = body.messages[1].content;
            assert.match(user, /Permitted component places: klama\[(?:2,)?1\]/);
            assert.equal(/c\d+\[/.test(user), false);
            assert.match(user, /for example klama\[[12]\]/);
            assert.match(
              body.tools[0].function.parameters.properties.x1.items.properties
                .component.description,
              /such as klama\[2\]/,
            );
          }
        },
      ),
    });
    const result = await runAssistance(
      request,
      config,
      context,
      AbortSignal.timeout(2000),
      newLog(request.operation, config, await promptVersion()),
      () => {},
    );
    const derivation = (result.proposals[0].value as any).places[0].derivation;
    assert.equal(derivation[0].definition, events[1]);
    assert.equal(derivation[0].place, 1);
    assert.deepEqual(derivation[0].word, components[1].word);
    const mappingInput = JSON.parse(
      result.log.exchanges[2].request.split("\n\nIn submit_answer")[0],
    );
    assert.equal(
      mappingInput.component_places.some((entry: any) => "label" in entry),
      false,
    );
    assert.deepEqual(
      mappingInput.component_places.map((entry: any) => entry.definition),
      components.map((entry) => entry.definition),
    );
  }
});

test("ambiguous repeated spelling mappings request unclear without choosing a definition", async () => {
  const events = ["jve1:" + "a".repeat(64), "jve1:" + "b".repeat(64)];
  const components = events.map((definition) => ({
    word: { language: "jbo", spelling: "klama" },
    definition,
    rafsi: "klam",
  }));
  const request = draft("places-glosses", {
    spelling: "klamklama",
    frame,
    compound: {
      components,
      morphology: { id: "https://example.test/morphology", version: "1" },
      scoring: { id: "https://example.test/scoring", version: "1" },
    },
  });
  request.context = events;
  const config = makeConfig({
    fetch: queue(
      [
        completion({
          word: { gloss: "travel", sense: "act of travel" },
          x1: { gloss: "traveler", sense: "" },
        }),
        completion({ x1: [{ type: "agent", reason: "The traveler acts." }] }),
        completion({
          x1: [{ component: "klama[1]", reason: "direct: the traveler." }],
        }),
        completion({
          x1: [
            {
              component: "unclear",
              reason: "unclear: the selected definitions differ.",
            },
          ],
        }),
      ],
      (body, turn) => {
        if (turn === 3) {
          const feedback = body.messages.at(-1).content;
          assert.match(feedback, /klama\[1\].*distinct selected definitions/);
          assert.match(feedback, /unclear/);
          assert.equal(/c\d+\[/.test(feedback), false);
        }
      },
    ),
  });
  const result = await runAssistance(
    request,
    config,
    components.map((part) => ({
      event: part.definition,
      body: { word: part.word, frame },
    })),
    AbortSignal.timeout(2000),
    newLog(request.operation, config, await promptVersion()),
    () => {},
  );
  assert.deepEqual((result.proposals[0].value as any).places[0].derivation, []);
  assert.equal(result.log.corrections, 1);
});

test("refreshing a session does not reset quota, and its hourly window still resets", async (t) => {
  const initial = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: initial });
  const instance = service({
    sessionJobs: 1,
    provider: makeConfig({
      fetch: queue([
        completion({ word_type: "lujvo", reason: "compound" }),
        completion({ word_type: "lujvo", reason: "compound" }),
      ]),
    }),
  });
  const headers = await session(instance);
  const response = await instance.fetch(
    privateRequest("/assist", headers, draft()),
  );
  const id = ((await response.json()) as any).job;
  await poll(instance, id, headers);
  await instance.fetch(
    privateRequest(`/jobs/${id}`, headers, undefined, "DELETE"),
  );
  t.mock.timers.tick(3599900);
  await instance.fetch(privateRequest("/session", headers));
  const blocked = await instance.fetch(
    privateRequest("/assist", headers, draft()),
  );
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("retry-after"), "1");
  t.mock.timers.tick(200);
  const accepted = await instance.fetch(
    privateRequest("/assist", headers, draft()),
  );
  assert.equal(accepted.status, 202);
  assert.equal(
    (await poll(instance, ((await accepted.json()) as any).job, headers)).state,
    "completed",
  );
});

test("network job quota survives cookie churn with a decreasing retry interval", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const instance = service({
    networkJobs: 1,
    provider: makeConfig({
      fetch: queue([completion({ word_type: "lujvo", reason: "compound" })]),
    }),
  });
  const headers = await session(instance);
  const started = await instance.fetch(
    privateRequest("/assist", headers, draft()),
  );
  const id = ((await started.json()) as any).job;
  await poll(instance, id, headers);
  await instance.fetch(
    privateRequest(`/jobs/${id}`, headers, undefined, "DELETE"),
  );
  t.mock.timers.tick(300000);
  const fresh = await session(instance);
  const blocked = await instance.fetch(
    privateRequest("/assist", fresh, draft()),
  );
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("retry-after"), "3300");
});

test("unavailable network identity disables private requests but leaves manual reads available", async () => {
  const instance = service({ provider: makeConfig() });
  const response = await instance.fetch(
    new Request("http://localhost/api/v1/session"),
    "",
  );
  assert.equal(response.status, 503);
  assert.equal(((await response.json()) as any).code, "feature_disabled");
  assert.equal(
    (
      await instance.fetch(
        new Request("http://localhost/api/v1/capabilities"),
        "",
      )
    ).status,
    200,
  );
});

test("a failure before any provider turn releases its retained reservation", async () => {
  let keyReads = 0;
  const instance = service({
    retainedJobs: 1,
    provider: makeConfig({
      key: async () => {
        keyReads++;
        return "";
      },
      fetch: queue([]),
    }),
  });
  const headers = await session(instance);
  for (let attempt = 0; attempt < 2; attempt++) {
    const started = await instance.fetch(
      privateRequest("/assist", headers, draft()),
    );
    assert.equal(started.status, 202);
    const id = ((await started.json()) as any).job;
    const failed = await poll(instance, id, headers);
    assert.equal(failed.state, "failed");
    assert.equal(failed.error.code, "provider_credentials");
    assert.equal(failed.error.log.answers, 0);
  }
  assert.equal(keyReads, 2);
});

test("wrong-word selected context returns HTTP 400 before any provider turn", async () => {
  const body = {
    word: { language: "jbo" as const, spelling: "sinxa" },
    language: "en",
    text: [["x1 is a sign."]],
    frame: null,
    glosses: [],
    operands: [],
    notes: [],
    examples: [],
    labels: [],
    sources: [],
    legacy: null,
    etymology: { text: [], formation: null, compound: null },
    classification: { kind: "gismu", selmaho: [] },
    license: {
      expression: "CC0-1.0",
      url: "https://creativecommons.org/publicdomain/zero/1.0/",
      attribution: "",
    },
  };
  const publication = createEvent(
    new Uint8Array(32).fill(93),
    [],
    "00".repeat(16),
    {
      kind: "definition.publish",
      word: wordId(body.word),
      language: "en",
      parents: [],
      origin: "native",
    },
    body,
  );
  const bytes = utf8(canonicalize(utf8(JSON.stringify(body))));
  const envelopeBytes = utf8(JSON.stringify(publication.envelope));
  const envelopeHash = contentHash(envelopeBytes);
  const bodyHash = publication.envelope.header.content!.hash;
  const objects = new Map([
    [envelopeHash, envelopeBytes],
    [bodyHash, bytes],
  ]);
  const state = emptyState();
  state.events[publication.envelope.id] = {
    envelope_hash: envelopeHash,
    body_hash: bodyHash,
    header: publication.envelope.header,
    signature: [],
    position: 1,
  };
  let keyReads = 0;
  const instance = new DictionaryService(
    { get: async (hash) => objects.get(hash) ?? null, put: async () => {} },
    {
      load: async () => state,
      getSnapshot: async () => null,
      compareAndSwap: async () => true,
    },
    {
      serverId: "wrong-word",
      policyUrl: "https://example.test/policy",
      assistance: {
        sessionJobs: 1,
        retainedJobs: 1,
        provider: makeConfig({
          key: async () => {
            keyReads++;
            return disposableKey;
          },
          fetch: queue([
            completion({ word_type: "lujvo", reason: "compound" }),
          ]),
        }),
      },
    },
  );
  const request = draft("lujvo", {
    compound: {
      components: [
        {
          word: { language: "jbo", spelling: "klama" },
          definition: publication.envelope.id,
          rafsi: "klam",
        },
      ],
      morphology: { id: "https://example.test/morphology", version: "1" },
      scoring: { id: "https://example.test/scoring", version: "1" },
    },
  });
  request.context = [publication.envelope.id];
  const headers = await session(instance);
  const rejected = await instance.fetch(
    privateRequest("/assist", headers, request),
  );
  assert.equal(rejected.status, 400);
  assert.equal(((await rejected.json()) as any).code, "component_context");
  assert.equal(keyReads, 0);
  const accepted = await instance.fetch(
    privateRequest("/assist", headers, draft()),
  );
  assert.equal(accepted.status, 202);
  assert.equal(
    (await poll(instance, ((await accepted.json()) as any).job, headers)).state,
    "completed",
  );
  assert.equal(keyReads, 1);
});

test("private job delivery streams bounded JSON chunks and preserves Unicode", async () => {
  const text = "x".repeat(8191) + "🙂" + "漢".repeat(20000);
  const instance = service({
    provider: makeConfig({
      fetch: queue([
        completion(
          { word_type: "lujvo", reason: "compound" },
          { content: text },
        ),
      ]),
    }),
  });
  const headers = await session(instance);
  const started = await instance.fetch(
    privateRequest("/assist", headers, draft()),
  );
  const id = ((await started.json()) as any).job;
  assert.equal((await poll(instance, id, headers)).state, "completed");
  const response = await instance.fetch(privateRequest(`/jobs/${id}`, headers));
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-type")!, /application\/json/);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  let count = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    count++;
    assert.ok(
      part.value.byteLength <= 65536,
      `Oversized JSON chunk: ${part.value.byteLength}`,
    );
    raw += decoder.decode(part.value, { stream: true });
  }
  raw += decoder.decode();
  assert.ok(count > 1);
  const value = JSON.parse(raw);
  assert.equal(value.state, "completed");
  assert.equal(value.result.log.exchanges[0].attempts[0].text, text);
});

test("largest admitted draft and context finish all four tasks with three answers each", async () => {
  const event = "jve1:" + "a".repeat(64);
  const sourceFrame = {
    ...structuredClone(frame),
    arity: { mode: "fixed", count: 256 },
    places: Array.from({ length: 256 }, (_, index) => ({
      ...structuredClone(frame.places[0]),
      index: index + 1,
    })),
  };
  const context: ContextDefinition[] = [
    {
      event,
      body: {
        word: { language: "jbo", spelling: "klama" },
        frame: sourceFrame,
        notes: [[""]],
      },
    },
  ];
  context[0].body.notes[0][0] = "C".repeat(
    131072 - utf8(JSON.stringify(context)).byteLength,
  );
  assert.equal(utf8(JSON.stringify(context)).byteLength, 131072);
  const request = draft("places-glosses", {
    spelling: "klamklama",
    text: [[""]],
    compound: {
      components: Array.from({ length: 64 }, () => ({
        word: { language: "jbo", spelling: "klama" },
        definition: event,
        rafsi: "klam",
      })),
      morphology: { id: "https://example.test/morphology", version: "1" },
      scoring: { id: "https://example.test/scoring", version: "1" },
    },
  });
  request.context = [event];
  request.meaning = "M".repeat(16384);
  request.current.text[0] = [
    "D".repeat(262144 - utf8(JSON.stringify(request)).byteLength),
  ];
  assert.equal(utf8(JSON.stringify(request)).byteLength, 262144);
  assert.doesNotThrow(() => parseAssistRequest(request));
  const keys = Array.from({ length: 16 }, (_, index) => `x${index + 1}`);
  const valid = [
    {
      places: keys.map((key) => ({
        description: `Role ${key}. ` + "p".repeat(128),
      })),
      reason: "Sixteen roles.",
    },
    Object.fromEntries([
      ...["word", ...keys].map((key) => [
        key,
        { gloss: `role-${key}`, sense: "a role in this predicate" },
      ]),
    ]),
    Object.fromEntries(
      keys.map((key) => [
        key,
        [{ type: "agent", reason: "The participant acts." }],
      ]),
    ),
    Object.fromEntries(
      keys.map((key) => [
        key,
        [
          {
            component: "klama[256]",
            reason: "direct: the exact last component role.",
          },
        ],
      ]),
    ),
  ];
  const responses = valid
    .flatMap((answer) => [{}, {}, answer])
    .map((answer) => {
      const response = completion(answer, { content: "" });
      response.choices[0].message.content = "R".repeat(
        262144 - utf8(JSON.stringify(response)).byteLength,
      );
      assert.equal(utf8(JSON.stringify(response)).byteLength, 262144);
      return response;
    });
  const config = makeConfig({ fetch: queue(responses) });
  const result = await runAssistance(
    request,
    config,
    context,
    AbortSignal.timeout(20000),
    newLog(request.operation, config, await promptVersion()),
    () => {},
  );
  assert.equal(result.log.answers, 12);
  assert.deepEqual(
    result.log.exchanges.map((exchange) => exchange.task),
    ["places", "glosses", "hints", "mappings"],
  );
  assert.deepEqual(
    result.log.exchanges.map((exchange) => exchange.attempts.length),
    [3, 3, 3, 3],
  );
  const proposed = result.proposals[0].value as any;
  assert.equal(proposed.places.length, 16);
  assert.equal(proposed.places[15].derivation[0].definition, event);
  assert.equal(proposed.places[15].derivation[0].place, 256);
});

test("private job delivery preserves deeply nested provider metadata without recursion", async () => {
  const depth = 5000;
  const response = JSON.stringify(
    completion({ word_type: "lujvo", reason: "compound" }),
  );
  const leaf = JSON.stringify({
    marker: "deep metadata stays exact",
    word: "risk-assessment",
    secret: disposableKey,
  });
  const raw =
    response.slice(0, -1) +
    ',"metadata":' +
    '{"next":['.repeat(depth) +
    leaf +
    "]}".repeat(depth) +
    "}";
  assert.ok(utf8(raw).byteLength < 262144);
  const instance = service({
    provider: makeConfig({
      fetch: (async () =>
        new Response(raw, {
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    }),
  });
  const headers = await session(instance);
  const started = await instance.fetch(
    privateRequest("/assist", headers, draft()),
  );
  const id = ((await started.json()) as any).job;
  const value = await poll(instance, id, headers);
  assert.equal(value.state, "completed");
  let metadata = value.result.log.exchanges[0].attempts[0].response.metadata;
  for (let level = 0; level < depth; level++) {
    assert.ok(
      metadata && typeof metadata === "object" && Array.isArray(metadata.next),
      `Metadata changed at level ${level}`,
    );
    metadata = metadata.next[0];
  }
  assert.deepEqual(metadata, {
    marker: "deep metadata stays exact",
    word: "risk-assessment",
    secret: "[redacted]",
  });
});

test("assistance interprets sparse draft and signed context values without changing originals", async () => {
  const body = {
    word: { language: "jbo" as const, spelling: "broda" },
    language: "en",
    text: [["A sparse context definition."]],
    frame: {
      role: "predicate",
      arity: { mode: "fixed", count: 1 },
      places: [{ index: 1 }],
    },
    classification: { kind: "gismu" },
    license: { expression: "CC0-1.0" },
  };
  const raw = utf8(canonicalize(utf8(JSON.stringify(body))));
  const seed = new Uint8Array(32).fill(93);
  const envelope = signHeader(seed, {
    version: 1,
    issuer: identityFromSeed(seed),
    previous: [],
    nonce: "d".repeat(32),
    action: {
      kind: "definition.publish",
      word: wordId(body.word),
      language: "en",
      parents: [],
      origin: "native",
    },
    content: { hash: contentHash(raw), bytes: raw.length },
  });
  const envelopeBytes = utf8(canonicalize(utf8(JSON.stringify(envelope))));
  const envelopeHash = contentHash(envelopeBytes);
  const objects = new Map([
    [envelopeHash, envelopeBytes],
    [envelope.header.content.hash, raw],
  ]);
  const state = emptyState();
  state.events[envelope.id] = {
    envelope_hash: envelopeHash,
    body_hash: envelope.header.content.hash,
    header: envelope.header,
    signature: [],
    position: 1,
  };
  let providerInput: any;
  const instance = new DictionaryService(
    { get: async (hash) => objects.get(hash) ?? null, put: async () => {} },
    {
      load: async () => state,
      getSnapshot: async () => null,
      compareAndSwap: async () => true,
    },
    {
      serverId: "sparse-context",
      policyUrl: "https://example.test/policy",
      assistance: {
        provider: makeConfig({
          fetch: queue(
            [completion({ word_type: "gismu", reason: "A test root." })],
            (request) => {
              providerInput = JSON.parse(
                request.messages.find((message: any) => message.role === "user")
                  .content,
              );
            },
          ),
        }),
      },
    },
  );
  const request = draft("type", {
    word_type: "gismu",
    classification: { kind: "gismu" },
    frame: body.frame,
    glosses: [{ language: "en", text: "test" }],
    formation: {
      method: "unknown",
      sources: [{ language: "en", word: "test" }],
    },
  });
  request.context = [envelope.id];
  const originalRequest = structuredClone(request);
  const parsed = parseAssistRequest(request);
  assert.deepEqual(parsed.current.classification!.selmaho, []);
  assert.equal(parsed.current.formation!.sources[0].word_ipa, null);
  assert.equal((parsed.current.glosses[0] as any).sense, null);
  assert.deepEqual(request, originalRequest);
  const headers = await session(instance);
  const started = await instance.fetch(
    privateRequest("/assist", headers, request),
  );
  assert.equal(started.status, 202, await started.clone().text());
  const done = await poll(
    instance,
    ((await started.json()) as any).job,
    headers,
  );
  assert.equal(done.state, "completed");
  assert.deepEqual(providerInput.current, parsed.current);
  const context = providerInput.definitions[0];
  assert.equal(context.event, envelope.id);
  assert.deepEqual(context.body.notes, []);
  assert.deepEqual(context.body.classification.selmaho, []);
  assert.deepEqual(context.body.frame.places[0].description, []);
  assert.deepEqual(context.body.frame.places[0].type_hints, []);
  assert.equal(context.body.frame.tail, null);
  assert.deepEqual(
    JSON.parse(done.result.log.exchanges[0].request),
    providerInput,
  );
  assert.deepEqual(objects.get(envelope.header.content.hash), raw);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(raw)), body);
  for (const invalid of [null, {}, "wrong"]) {
    const wrong = structuredClone(request);
    wrong.current.frame!.places[0].glosses = invalid;
    assert.throws(() => parseAssistRequest(wrong), /definition schema/);
  }
});

test("type inference accepts fuhivla and corrects the retired label", async () => {
  const { runner: inference, log } = await runner(
    queue([
      completion({ word_type: "fuivla", reason: "A borrowing fits." }),
      completion({ word_type: "fuhivla", reason: "A borrowing fits." }),
    ]),
  );
  const answer = await inference.run({
    task: "type",
    input: "A borrowed word.",
  });
  assert.equal(answer.word_type, "fuhivla");
  assert.equal(log.corrections, 1);
});

test("assistance drafts accept fuhivla without a legacy alias", () => {
  const current = {
    word_type: "fuhivla",
    classification: { kind: "fuhivla", selmaho: [] },
  };
  assert.equal(
    parseAssistRequest(draft("type", current)).current.word_type,
    "fuhivla",
  );
  for (const kind of ["fuivla", "fu'ivla"]) {
    assert.throws(() => parseAssistRequest(draft("type", { word_type: kind })));
    assert.throws(() =>
      parseAssistRequest(
        draft("type", { classification: { kind, selmaho: [] } }),
      ),
    );
  }
});
