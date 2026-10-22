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
} from "../../core/src/index.ts";
import { DictionaryService } from "../src/service.ts";
import { emptyState } from "../src/storage.ts";
import {
  parseAssistRequest,
  runAssistance,
  type AssistRequest,
  type AssistanceOptions,
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
    body: JSON.stringify({ tool_choice: "required" }),
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
    new InferenceRunner(
      config,
      newLog("type", config, await promptVersion()),
      AbortSignal.timeout(1000),
    ).run({ task: "type", input: "draft" }),
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
      "languages/english.txt",
      "explain.txt",
    ]
      .map((name) => promptFiles[name].trim())
      .join("\n\n"),
  );
  assert.equal(sent.tool_choice, "auto");
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
async function session(instance: DictionaryService) {
  const response = await instance.fetch(
    new Request("http://localhost/api/v1/session"),
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
          { spelling: "klama", definition: exactDefinition },
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
test("every actual core preset source tag selects its prompt and remains unchanged in proposals", async () => {
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
    assert.equal(rows[0].language, language);
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
  assert.equal(crowded.headers.get("retry-after"), "1");
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
      Math.max(0, Date.parse(accepted.expires_at) - Date.now()) + 10,
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
