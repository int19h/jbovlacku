import assert from "node:assert/strict";
import { before, test } from "node:test";
import { readFile } from "node:fs/promises";
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
  inferenceTurnCost,
  InferenceRunner,
  newLog,
  providerConfig,
  taskMessages,
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

test("network spending configuration defaults to half of each server limit and validates overrides", () => {
  const defaults = config() as any;
  assert.equal(defaults.networkHourlyBudgetUsd, 0.5);
  assert.equal(defaults.networkDailyBudgetUsd, 2.5);
  const custom = providerConfig(
    {
      JVC_AI_ENABLED: "enabled",
      JVC_AI_HOURLY_BUDGET_USD: "8",
      JVC_AI_DAILY_BUDGET_USD: "30",
    },
    async () => "disposable",
  ) as any;
  assert.equal(custom.networkHourlyBudgetUsd, 4);
  assert.equal(custom.networkDailyBudgetUsd, 15);
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
