import assert from "node:assert/strict";
import { before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { parseConfigFileTextToJson } from "typescript";
import { initializeCore } from "../../core/src/index.ts";
import {
  AssistanceService,
  estimateAssistanceCost,
  runAssistance,
  type AssistRequest,
  type ContextDefinition,
} from "../src/assistance.ts";
import {
  estimateInferenceCost,
  INFERENCE_CORRECTION_BYTES,
  INFERENCE_RESPONSE_BYTES,
  INFERENCE_RESPONSE_BYTES_PER_TOKEN,
  INFERENCE_RESPONSE_OVERHEAD_BYTES,
  INFERENCE_MAX_OUTPUT_TOKENS,
  INFERENCE_INITIAL_REQUEST_BYTES,
  INFERENCE_GENERATED_FRAME_BYTES,
  inferenceTurnCost,
  InferenceRunner,
  newLog,
  providerConfig,
  taskMessages,
  taskMaxTokens,
  type ProviderConfig,
  type TaskCase,
} from "../src/inference.ts";

before(async () =>
  initializeCore(
    await readFile(
      new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  ),
);
const config = (overrides: Partial<ProviderConfig> = {}) => ({
  ...providerConfig(
    { JVC_AI_ENABLED: "enabled" },
    async () => "disposable-reservation-key",
  )!,
  ...overrides,
});
const draft = (): AssistRequest => ({
  operation: "type",
  draft_revision: "reservation-fixture",
  language: "en",
  meaning: "A traveler.",
  current: {
    word_type: null,
    classification: null,
    spelling: null,
    text: [["A traveler."]],
    frame: null,
    glosses: [],
    formation: null,
    compound: null,
  },
  context: [],
  profile: "default",
});
const frame = (description = "A traveler.") => ({
  role: "predicate",
  arity: { mode: "fixed", count: 1 },
  places: [
    {
      index: 1,
      description: [[description]],
      glosses: [],
      type_hints: [],
      defaults: [],
      constraints: [],
      derivation: [],
    },
  ],
  tail: null,
  constraints: [],
});
function completion(answer: unknown, summary = "") {
  if (answer && typeof answer === "object" && "word_type" in answer)
    answer = {
      alternative: null,
      alternative_reason: null,
      existing: null,
      ...answer,
    };
  return {
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: "",
          reasoning_details: [{ type: "reasoning.summary", summary }],
          tool_calls: [
            {
              id: "answer",
              type: "function",
              function: {
                name: "submit_answer",
                arguments: JSON.stringify(answer),
              },
            },
          ],
        },
      },
    ],
    usage: {},
  };
}
function maximumCorrection() {
  const value = completion(
    { word_type: "invalid", reason: "A".repeat(100000) },
    "",
  );
  value.choices[0].message.reasoning_details[0].summary = "R".repeat(
    INFERENCE_RESPONSE_BYTES - JSON.stringify(value).length,
  );
  const encoded = JSON.stringify(value);
  assert.equal(
    new TextEncoder().encode(encoded).byteLength,
    INFERENCE_RESPONSE_BYTES,
  );
  return encoded;
}

test("a full response with reasoning and tool arguments stays inside the admission reservation without reported cost", async () => {
  let turn = 0;
  let settled = 0;
  let reservation = 0;
  let latest: any;
  const provider = config({
    fetch: (async () =>
      new Response(
        turn++ < 2
          ? maximumCorrection()
          : JSON.stringify(
              completion({ word_type: "gismu", reason: "A root." }),
            ),
      )) as typeof fetch,
  });
  const app = new AssistanceService(
    {
      provider,
      budgetStore: {
        load: async () => null,
        save: async (snapshot) => {
          latest = structuredClone(snapshot);
          reservation = Math.max(
            reservation,
            ...snapshot.entries.map((entry) => entry.reservedUsd),
          );
          settled = snapshot.entries.reduce(
            (sum, entry) => sum + entry.settledUsd,
            0,
          );
        },
      },
    },
    "reservation-fixture",
    async () => [],
  );
  const route = (
    path: string,
    headers: Record<string, string> = {},
    body?: unknown,
  ) =>
    app.route(
      new Request(`http://localhost${path}`, {
        method: body ? "POST" : "GET",
        headers: { origin: "http://localhost", ...headers },
        body: body ? JSON.stringify(body) : undefined,
      }),
      path,
      async () => new TextEncoder().encode(JSON.stringify(body)),
      "local",
    );
  const session = (await route("/session"))!;
  const headers = {
    cookie: session.headers.get("set-cookie")!.split(";")[0],
    "x-csrf-token": ((await session.json()) as any).csrf,
  };
  const accepted = (await route("/assist", headers, draft()))!;
  assert.equal(accepted.status, 202);
  const { job } = (await accepted.json()) as any;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (latest?.entries[0]?.active === false) break;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  const result = (await (await route(`/jobs/${job}`, headers))!.json()) as any;
  assert.equal(result.state, "completed");
  assert.equal(result.result.log.answers, 3);
  assert.equal(result.result.log.cost_usd, null);
  assert.equal(latest.entries[0].active, false);
  assert.equal(latest.entries[0].reservedUsd, reservation);
  assert.equal(Math.max(latest.entries[0].reservedUsd, settled), reservation);
  assert.ok(
    settled <= reservation,
    `${settled} exceeds admission reservation ${reservation}`,
  );
});

test("the estimator reserves the full correction allowance on each later attempt", async () => {
  const provider = config();
  const spec: TaskCase = { task: "type", input: "A traveler." };
  let firstBytes = 0;
  provider.fetch = (async (_url, init) => {
    firstBytes = new TextEncoder().encode(String(init?.body)).byteLength;
    return Response.json(completion({ word_type: "gismu", reason: "A root." }));
  }) as typeof fetch;
  await new InferenceRunner(
    provider,
    newLog("type", provider, "fixture"),
    AbortSignal.timeout(2000),
  ).run(spec);
  assert.equal(
    estimateInferenceCost(provider, spec),
    [0, 1, 2].reduce(
      (sum, prior) =>
        sum +
        inferenceTurnCost(
          provider,
          firstBytes + prior * INFERENCE_CORRECTION_BYTES,
          taskMaxTokens(provider, spec.task),
        ),
      0,
    ),
  );
});

test("generated frames reserve full response descriptions in later task requests", async () => {
  let turn = 0;
  const provider = config({
    maxTokens: 128,
    fetch: (async () => {
      const answer =
        turn++ === 0
          ? { places: [{ description }], reason: "The traveler acts." }
          : turn === 2
            ? {
                word: { gloss: "travel", sense: "act of travel" },
                x1: { gloss: "traveler", sense: "" },
              }
            : { x1: [{ type: "agent", reason: "The traveler acts." }] };
      return Response.json(completion(answer));
    }) as typeof fetch,
  });
  const request = { ...draft(), operation: "places-glosses" as const };
  const description = "D".repeat(220000);
  const actual = structuredClone(request);
  actual.current.frame = frame(description);
  const estimatedGenerated = estimateAssistanceCost(request, [], provider);
  const actualFollowing = estimateAssistanceCost(actual, [], provider);
  assert.ok(
    estimatedGenerated > actualFollowing,
    `${estimatedGenerated} does not cover following tasks ${actualFollowing}`,
  );
  const result = await runAssistance(
    request,
    provider,
    [],
    AbortSignal.timeout(5000),
    newLog(request.operation, provider, "generated-frame-fixture"),
    () => {},
  );
  assert.equal(
    (result.proposals[0].value as any).places[0].description[0][0],
    description,
  );
  assert.equal(result.log.answers, 3);
});

test("network spending configuration defaults to one quarter of each server limit and validates overrides", () => {
  const defaults = config() as any;
  assert.equal(defaults.hourlyBudgetUsd, 32);
  assert.equal(defaults.dailyBudgetUsd, 160);
  assert.equal(defaults.networkHourlyBudgetUsd, 8);
  assert.equal(defaults.networkDailyBudgetUsd, 40);
  const custom = providerConfig(
    {
      JVC_AI_ENABLED: "enabled",
      JVC_AI_HOURLY_BUDGET_USD: "8",
      JVC_AI_DAILY_BUDGET_USD: "30",
    },
    async () => "disposable",
  ) as any;
  assert.equal(custom.networkHourlyBudgetUsd, 2);
  assert.equal(custom.networkDailyBudgetUsd, 7.5);
  for (const name of [
    "JVC_AI_NETWORK_HOURLY_BUDGET_USD",
    "JVC_AI_NETWORK_DAILY_BUDGET_USD",
  ]) {
    assert.equal(
      (
        providerConfig(
          { JVC_AI_ENABLED: "enabled", [name]: "0.25" },
          async () => "disposable",
        ) as any
      )[
        name.includes("HOURLY")
          ? "networkHourlyBudgetUsd"
          : "networkDailyBudgetUsd"
      ],
      0.25,
    );
    for (const value of ["NaN", "-1", "0", "Infinity"])
      assert.throws(
        () =>
          providerConfig(
            { JVC_AI_ENABLED: "enabled", [name]: value },
            async () => "disposable",
          ),
        /Invalid/,
      );
  }
});

test("each task uses its studied output cap for all answers and its reservation", async () => {
  const caps: Record<TaskCase["task"], number> = {
    glosses: 4096,
    hints: 8192,
    mappings: 6144,
    sources: 8192,
    type: 2048,
    components: 2048,
    "cmavo-class": 2048,
    definition: 6144,
    places: 2048,
  };
  for (const [task, cap] of Object.entries(caps)) {
    const spec: TaskCase = {
      task: task as TaskCase["task"],
      input: "A traveler.",
      language: "en",
      check: () => ["Correct this answer."],
    };
    let turns = 0;
    let firstBytes = 0;
    const provider = config({
      fetch: (async (_url, init) => {
        const body = String(init?.body);
        assert.equal(JSON.parse(body).max_tokens, cap, task);
        if (!turns++) firstBytes = new TextEncoder().encode(body).byteLength;
        return Response.json(completion({}));
      }) as typeof fetch,
    });
    await assert.rejects(
      new InferenceRunner(
        provider,
        newLog(task, provider, "caps"),
        AbortSignal.timeout(2000),
      ).run(spec),
      { code: "invalid_answer" },
    );
    assert.equal(turns, 3, task);
    const expected = [0, 1, 2].reduce(
      (total, prior) =>
        total +
        (2 *
          ((firstBytes + prior * INFERENCE_CORRECTION_BYTES) *
            provider.inputPrice +
            cap * provider.outputPrice)) /
          1000000,
      0,
    );
    assert.equal(estimateInferenceCost(provider, spec), expected, task);
    assert.equal(
      taskMaxTokens({ ...provider, maxTokens: 128 }, spec.task),
      128,
    );
  }
});

test("explicit output limits accept the ceiling and reject values above it at startup", () => {
  const configured = (value: string) =>
    providerConfig(
      { JVC_AI_ENABLED: "enabled", JVC_AI_MAX_TOKENS: value },
      async () => "disposable-limit-key",
    )!;
  assert.equal(configured("20480").maxTokens, 20480);
  assert.equal(configured("128.9").maxTokens, 128);
  for (const value of ["20481", "20480.5", "32768"])
    assert.throws(() => configured(value), {
      message: "JVC_AI_MAX_TOKENS must be from 128 through 20480.",
    });
  for (const value of ["", "127", "-1", "NaN", "Infinity"])
    assert.throws(() => configured(value), {
      message: "Invalid JVC_AI_MAX_TOKENS.",
    });
});

test("every output limit respects the ceiling and its response planning envelope", () => {
  let largest = 0;
  for (const reasoningEffort of [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ])
    for (const decisionReports of [false, true])
      for (const maxTokens of [undefined, 128, 20480, 32768, Infinity])
        for (const task of [
          "glosses",
          "hints",
          "mappings",
          "sources",
          "type",
          "components",
          "cmavo-class",
          "definition",
          "places",
        ] as const) {
          const cap = taskMaxTokens(
            { reasoningEffort, decisionReports, maxTokens },
            task,
          );
          assert.ok(
            cap <= 20480,
            `${task}/${reasoningEffort}/${decisionReports}/${maxTokens}: ${cap}`,
          );
          largest = Math.max(largest, cap);
        }
  assert.equal(largest, INFERENCE_MAX_OUTPUT_TOKENS);
  assert.equal(INFERENCE_RESPONSE_BYTES_PER_TOKEN, 12);
  assert.equal(INFERENCE_RESPONSE_OVERHEAD_BYTES, 4096);
  const envelope =
    largest * INFERENCE_RESPONSE_BYTES_PER_TOKEN +
    INFERENCE_RESPONSE_OVERHEAD_BYTES;
  assert.equal(envelope, 249856);
  assert.ok(envelope <= INFERENCE_RESPONSE_BYTES);
});

test("effort caps, decision reports, and explicit overrides agree across requests, reservations, and unknown charges", async () => {
  const tasks: TaskCase["task"][] = [
    "glosses",
    "hints",
    "mappings",
    "sources",
    "type",
    "components",
    "cmavo-class",
    "definition",
    "places",
  ];
  const caps = {
    low: [2304, 2816, 4608, 5120, 2048, 2048, 2048, 6144, 2048],
    medium: [4096, 8192, 6144, 8192, 2048, 2048, 2048, 6144, 2048],
    high: [4864, 10240, 12288, 17408, 4352, 4352, 4352, 13056, 4352],
    xhigh: [11520, 10496, 14336, 24576, 6144, 6144, 6144, 18432, 6144],
  };
  for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh"])
    for (const reports of [false, true])
      for (const explicit of [undefined, "128", "20480", "direct-32768"])
        for (const [index, task] of tasks.entries()) {
          const cap =
            explicit === undefined
              ? Math.min(
                  20480,
                  caps[
                    effort === "none" || effort === "minimal"
                      ? "low"
                      : (effort as keyof typeof caps)
                  ][index] * (reports ? 2 : 1),
                )
              : explicit === "direct-32768"
                ? 20480
                : Number(explicit);
          const label = `${task}/${effort}/${reports}/${explicit}`;
          const spec: TaskCase = {
            task,
            input: "A traveler.",
            language: "en",
            check: () => ["Correct this answer."],
          };
          const charges: number[] = [];
          const provider = providerConfig(
            {
              JVC_AI_ENABLED: "enabled",
              JVC_AI_REASONING_EFFORT: effort,
              JVC_AI_DECISION_REPORTS: reports ? "enabled" : "disabled",
              JVC_AI_MAX_TOKENS:
                explicit === "direct-32768" ? undefined : explicit,
            },
            async () => "disposable-effort-key",
          )!;
          if (explicit === "direct-32768") provider.maxTokens = 32768;
          assert.equal(
            provider.maxTokens,
            explicit === undefined
              ? undefined
              : explicit === "direct-32768"
                ? 32768
                : Number(explicit),
            label,
          );
          let turns = 0;
          let firstBytes = 0;
          provider.onCost = async (reported, estimated) => {
            assert.equal(reported, null);
            charges.push(estimated);
          };
          provider.fetch = (async (_url, init) => {
            const body = String(init?.body);
            const bytes = new TextEncoder().encode(body).byteLength;
            const request = JSON.parse(body);
            assert.equal(request.max_tokens, cap, label);
            assert.equal(request.reasoning.effort, effort);
            assert.equal(
              request.messages[0].content.includes(
                "Before you call submit_answer, write a report",
              ),
              reports,
            );
            if (!turns++) firstBytes = bytes;
            assert.equal(charges.length, (turns - 1) * 2);
            charges.push(inferenceTurnCost(provider, bytes, cap));
            return Response.json(completion({}));
          }) as typeof fetch;
          await assert.rejects(
            new InferenceRunner(
              provider,
              newLog(task, provider, "effort-caps"),
              AbortSignal.timeout(2000),
            ).run(spec),
            { code: "invalid_answer" },
          );
          assert.equal(turns, 3, label);
          for (let i = 0; i < 6; i += 2)
            assert.equal(charges[i + 1], charges[i], label);
          const reservation = [0, 1, 2].reduce(
            (sum, prior) =>
              sum +
              inferenceTurnCost(
                provider,
                firstBytes + prior * INFERENCE_CORRECTION_BYTES,
                cap,
              ),
            0,
          );
          assert.equal(
            estimateInferenceCost(provider, spec),
            reservation,
            label,
          );
          assert.ok(
            charges
              .filter((_charge, i) => i % 2 === 1)
              .reduce((sum, charge) => sum + charge, 0) <= reservation,
            label,
          );
        }
});

test("none and minimal effort use the low-effort caps without changing the provider effort", () => {
  for (const effort of ["none", "minimal"])
    for (const task of ["glosses", "sources", "definition"] as const) {
      const provider = config({ reasoningEffort: effort });
      assert.equal(
        taskMaxTokens(provider, task),
        taskMaxTokens({ ...provider, reasoningEffort: "low" }, task),
      );
    }
});

test("ordinary Worker variables select the same automatic caps as Node", async () => {
  const path = new URL("../../../apps/worker/wrangler.jsonc", import.meta.url);
  const { config: worker, error } = parseConfigFileTextToJson(
    path.pathname,
    await readFile(path, "utf8"),
  );
  assert.equal(error, undefined);
  assert.equal(Object.hasOwn(worker.vars, "JVC_AI_MAX_TOKENS"), false);
  const node = config();
  const provider = providerConfig(
    { ...worker.vars, JVC_AI_ENABLED: "enabled" },
    async () => "disposable-worker-key",
  )!;
  for (const task of ["type", "hints", "sources", "definition"] as const)
    assert.equal(taskMaxTokens(provider, task), taskMaxTokens(node, task));
});

test("initial inference requests enforce the same byte limit before reservation and provider work", async () => {
  let calls = 0;
  const provider = config({
    fetch: (async () => {
      calls++;
      return Response.json(
        completion({ word_type: "gismu", reason: "A root." }),
      );
    }) as typeof fetch,
  });
  const spec: TaskCase = {
    task: "type",
    input: "A".repeat(INFERENCE_INITIAL_REQUEST_BYTES),
  };
  assert.throws(() => estimateInferenceCost(provider, spec), {
    status: 413,
    code: "size",
  });
  await assert.rejects(
    new InferenceRunner(
      provider,
      newLog("type", provider, "initial-cap"),
      AbortSignal.timeout(2000),
    ).run(spec),
    { status: 413, code: "size" },
  );
  assert.equal(calls, 0);
});

test("a generated frame keeps its reserved initial allowance in downstream requests", async () => {
  let calls = 0;
  const provider = config({
    fetch: (async (_url, init) => {
      calls++;
      const bytes = new TextEncoder().encode(String(init?.body)).byteLength;
      assert.ok(bytes > INFERENCE_INITIAL_REQUEST_BYTES);
      assert.ok(
        bytes <=
          INFERENCE_INITIAL_REQUEST_BYTES + INFERENCE_GENERATED_FRAME_BYTES,
      );
      return Response.json(
        completion({ word: { gloss: "travel", sense: "the act of travel" } }),
      );
    }) as typeof fetch,
  });
  const spec: TaskCase = {
    task: "glosses",
    input: "A".repeat(INFERENCE_INITIAL_REQUEST_BYTES),
    keys: ["word"],
  };
  const result = await new InferenceRunner(
    provider,
    newLog("places-glosses", provider, "generated-cap"),
    AbortSignal.timeout(2000),
  ).run(spec, INFERENCE_GENERATED_FRAME_BYTES);
  assert.equal(result.word.gloss, "travel");
  assert.equal(calls, 1);
});

function mappingFixture(includeUnique: boolean) {
  const components = ["a", "b", ...(includeUnique ? ["c"] : [])].map(
    (letter) => ({
      word: { language: "jbo", spelling: letter === "c" ? "karce" : "klama" },
      definition: `jve1:${letter.repeat(64)}`,
      rafsi: letter === "c" ? "karc" : "klam",
    }),
  );
  const request = { ...draft(), operation: "places-glosses" as const };
  request.current.spelling = "klamklama";
  request.current.frame = frame();
  request.current.compound = {
    components,
    morphology: { id: "https://example.test/morphology", version: "1" },
    scoring: { id: "https://example.test/scoring", version: "1" },
  };
  request.context = components.map((part) => part.definition);
  const context: ContextDefinition[] = components.map((part) => ({
    event: part.definition,
    body: { word: part.word, frame: frame() },
  }));
  return { request, context };
}

for (const unique of [true, false])
  test(`mapping requests identify ambiguous names before the first answer (${unique ? "some" : "all"} ambiguous)`, async () => {
    const { request, context } = mappingFixture(unique);
    let turn = 0;
    const input = JSON.stringify({
      meaning: request.meaning,
      language: request.language,
      current: request.current,
      definitions: context,
    });
    const mappingSpec: TaskCase = {
      task: "mappings",
      input: JSON.stringify({
        ...JSON.parse(input),
        component_places: request.current.compound!.components.map(
          (component: any) => ({
            word: component.word,
            definition: component.definition,
            places: [1],
          }),
        ),
      }),
      keys: ["x1"],
      word: request.current.spelling!,
      components: unique ? ["klama[1]", "karce[1]"] : ["klama[1]"],
      ambiguousComponents: ["klama[1]"],
    };
    const provider = config({
      fetch: (async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (turn++ === 0)
          return Response.json(
            completion({
              word: { gloss: "travel", sense: "act of travel" },
              x1: { gloss: "traveler", sense: "" },
            }),
          );
        if (turn === 2)
          return Response.json(
            completion({
              x1: [{ type: "agent", reason: "The traveler acts." }],
            }),
          );
        const input = body.messages[1].content;
        assert.match(input, /Ambiguous component places: klama\[1\]/);
        assert.match(input, /for example (karce\[1\]|unclear)/);
        if (unique) assert.match(input, /for example karce\[1\]/);
        else {
          assert.match(input, /for example unclear/);
          assert.match(
            input,
            /Each listed name refers to more than one selected definition/,
          );
        }
        assert.doesNotMatch(input, /for example klama\[1\]/);
        return Response.json(
          completion({
            x1: [
              {
                component: "unclear",
                reason: "unclear: the selected definitions differ.",
              },
            ],
          }),
        );
      }) as typeof fetch,
    });
    const result = await runAssistance(
      request,
      provider,
      context,
      AbortSignal.timeout(5000),
      newLog(request.operation, provider, "mapping-fixture"),
      () => {},
    );
    assert.equal(result.log.corrections, 0);
    assert.deepEqual(
      (result.proposals[0].value as any).places[0].derivation,
      [],
    );
    assert.equal(
      taskMessages(provider, mappingSpec).input,
      result.log.exchanges[2].request,
    );
    const actualCost = result.log.exchanges.reduce(
      (sum, exchange) =>
        sum +
        estimateInferenceCost(
          provider,
          exchange.task === "mappings"
            ? mappingSpec
            : {
                task: exchange.task,
                input,
                word: request.current.spelling!,
                keys: exchange.task === "glosses" ? ["word", "x1"] : ["x1"],
              },
        ),
      0,
    );
    assert.equal(
      estimateAssistanceCost(request, context, provider),
      actualCost,
    );
  });
