import assert from "node:assert/strict";
import { test } from "node:test";
import {
  providerConfig,
  AssistanceError,
  type ProviderConfig,
} from "../src/inference.ts";
import {
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_RESPONSE_BYTES,
  prepareEmbedding,
  requestEmbedding,
  qwenResponseModel,
  type EmbeddingUsage,
} from "../src/embedding.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const vector = (first = 2) =>
  Array.from({ length: EMBEDDING_DIMENSIONS }, (_, index) =>
    index === 0 ? first : 0,
  );
const response = (count = 1) => ({
  model: "Qwen/Qwen3-Embedding-8B",
  data: Array.from({ length: count }, (_, index) => ({
    index,
    embedding: vector(index + 2),
  })),
  usage: { prompt_tokens: 12, total_tokens: 12, cost: 0.00000012 },
});
function config(
  fetcher: typeof fetch,
  overrides: Partial<ProviderConfig> = {},
) {
  return {
    ...providerConfig(
      { JVC_AI_ENABLED: "enabled" },
      async () => "disposable-embedding-key",
    )!,
    fetch: fetcher,
    ...overrides,
  };
}
function run(
  value: unknown,
  inputCount = 1,
  overrides: Partial<ProviderConfig> = {},
) {
  const provider = config(async () => Response.json(value), overrides);
  const costs: EmbeddingUsage[] = [];
  let sent = 0;
  let ended = 0;
  const work = requestEmbedding(
    prepareEmbedding(
      Array.from({ length: inputCount }, () => bytes("public fixture")),
      provider,
    ),
    provider,
    new AbortController().signal,
    {
      sent: () => {
        sent++;
      },
      transportEnded: () => {
        ended++;
      },
      cost: async (usage) => {
        costs.push(usage);
      },
    },
  );
  return { work, costs, sent: () => sent, ended: () => ended };
}

test("embedding configuration pins the model and route with a separate input price", () => {
  const defaults = config(fetch);
  assert.deepEqual(defaults.embedding, {
    model: EMBEDDING_MODEL,
    route: "nebius",
    inputPrice: 0.01,
  });
  assert.equal(defaults.inputPrice, 0.1);
  assert.equal(
    prepareEmbedding([bytes("a"), bytes("b")], defaults).estimatedUsd,
    0.00064,
  );
  assert.equal(
    providerConfig({ JVC_AI_ENABLED: "disabled" }, async () => "unused"),
    undefined,
  );
  for (const env of [
    { JVC_AI_EMBEDDING_MODEL: "another-model" },
    { JVC_AI_EMBEDDING_PROVIDER_ROUTE: "another-route" },
    { JVC_AI_EMBEDDING_INPUT_PRICE: "NaN" },
    { JVC_AI_EMBEDDING_INPUT_PRICE: "-1" },
  ])
    assert.throws(() =>
      providerConfig(
        { JVC_AI_ENABLED: "enabled", ...env },
        async () => "unused",
      ),
    );
  const configured = providerConfig(
    { JVC_AI_ENABLED: "enabled", JVC_AI_EMBEDDING_INPUT_PRICE: "0.02" },
    async () => "unused",
  )!;
  assert.equal(
    prepareEmbedding([bytes("a")], configured).estimatedUsd,
    0.00064,
  );
});

test("the provider preserves exact input bytes and forbids redirects and route fallback", async () => {
  const exact = "\uFEFFInstruct: Find a meaning\nQuery: e\u0301";
  const provider = config(async (url, init) => {
    assert.equal(url, "https://openrouter.ai/api/v1/embeddings");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer disposable-embedding-key",
    );
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body, {
      model: EMBEDDING_MODEL,
      input: [exact, "document"],
      encoding_format: "float",
      provider: {
        order: ["nebius"],
        only: ["nebius"],
        allow_fallbacks: false,
        max_price: { prompt: 10 },
      },
      usage: { include: true },
    });
    const value = response(2);
    value.data.reverse();
    value.data[0].embedding = vector(-2);
    return Response.json(value);
  });
  const result = await requestEmbedding(
    prepareEmbedding([bytes(exact), bytes("document")], provider),
    provider,
    new AbortController().signal,
    { sent() {}, transportEnded() {}, async cost() {} },
  );
  assert.equal(result.model, "Qwen/Qwen3-Embedding-8B");
  assert.equal(result.vectors[0].length, 4096);
  assert.equal(result.vectors[0][0], 1);
  assert.equal(result.vectors[1][0], -1);
  assert.deepEqual(result.usage, {
    inputTokens: 12,
    totalTokens: 12,
    costUsd: 0.00000012,
  });
});

test("input bounds reject malformed UTF-8 and oversized encoded requests before dispatch", () => {
  const provider = config(async () => {
    throw new Error("No dispatch expected.");
  });
  for (const inputs of [
    [],
    [bytes("")],
    [bytes("a".repeat(4097))],
    [new Uint8Array([0xc0, 0x80])],
    Array.from({ length: 9 }, () => bytes("a")),
    Array.from({ length: 8 }, () => bytes("\0".repeat(4096))),
  ])
    assert.throws(
      () => prepareEmbedding(inputs, provider),
      (failure: any) => failure.code === "embedding_input",
    );
  assert.equal(
    prepareEmbedding(
      Array.from({ length: 8 }, () => bytes("a".repeat(4096))),
      provider,
    ).count,
    8,
  );
  // Provider normalization expands this input. The quote remains 32,000 tokens.
  assert.equal(
    prepareEmbedding([bytes("\u0344".repeat(2048))], provider).estimatedUsd,
    0.00032,
  );
});

test("only the two exact returned model names match", async () => {
  assert(qwenResponseModel(EMBEDDING_MODEL));
  assert(qwenResponseModel("Qwen/Qwen3-Embedding-8B"));
  for (const model of [
    "QWEN/QWEN3-EMBEDDING-8B",
    "qwen3-embedding-8b",
    "qwen/qwen3-embedding-8b:free",
    null,
  ]) {
    assert(!qwenResponseModel(model));
    const fixture = run({ ...response(), model });
    await assert.rejects(
      fixture.work,
      (failure: any) => failure.code === "embedding_model_mismatch",
    );
    assert.equal(fixture.costs[0].costUsd, 0.00000012);
    assert.equal(fixture.sent(), 1);
    assert.equal(fixture.ended(), 1);
  }
});

test("vector validation rejects bad counts, indices, dimensions, and finite-value failures", async () => {
  const cases = [
    { ...response(), data: [] },
    { ...response(2), data: [response(2).data[0], response(2).data[0]] },
    { ...response(), data: [{ index: -1, embedding: vector() }] },
    { ...response(), data: [{ index: 0.5, embedding: vector() }] },
    { ...response(), data: [{ index: 1, embedding: vector() }] },
    { ...response(), data: [{ index: 0, embedding: [1, 2] }] },
    { ...response(), data: [{ index: 0, embedding: vector(0) }] },
    {
      ...response(),
      data: [{ index: 0, embedding: [null, ...vector().slice(1)] }],
    },
    {
      ...response(),
      data: [{ index: 0, embedding: ["2", ...vector().slice(1)] }],
    },
  ];
  for (const value of cases) {
    const fixture = run(value, value.data.length === 2 ? 2 : 1);
    await assert.rejects(fixture.work, AssistanceError);
    assert.equal(
      fixture.costs.length,
      1,
      "Reported charges survive invalid vectors.",
    );
  }
  for (const first of [Number.MAX_VALUE, Number.MIN_VALUE]) {
    const result = await run({
      ...response(),
      data: [{ index: 0, embedding: vector(first) }],
    }).work;
    assert.equal(result.vectors[0][0], 1);
  }
  const dense = await run({
    ...response(),
    data: [{ index: 0, embedding: Array(4096).fill(1) }],
  }).work;
  assert.equal(
    dense.vectors[0].reduce((sum, item) => sum + item * item, 0),
    1,
  );
});

test("missing and invalid usage stays unknown rather than a zero charge", async () => {
  for (const usage of [
    undefined,
    {},
    { prompt_tokens: -1, total_tokens: 1.5, cost: "0" },
    { cost: -1 },
  ]) {
    const fixture = run({ ...response(), usage });
    const result = await fixture.work;
    assert.deepEqual(result.usage, {
      inputTokens: null,
      totalTokens: null,
      costUsd: null,
    });
    assert.deepEqual(fixture.costs, [result.usage]);
  }
  const free = await run({
    ...response(),
    usage: { prompt_tokens: 0, total_tokens: 0, cost: 0 },
  }).work;
  assert.equal(free.usage.costUsd, 0);
});

test("response bounds cover headers, streamed bytes, invalid JSON, HTTP errors, and redirects", async () => {
  for (const make of [
    () =>
      new Response("{}", {
        headers: { "content-length": String(EMBEDDING_RESPONSE_BYTES + 1) },
      }),
    () => new Response("{}", { headers: { "content-length": "invalid" } }),
    () => new Response("a".repeat(EMBEDDING_RESPONSE_BYTES + 1)),
    () => new Response("not JSON"),
    () => new Response(new Uint8Array([0xff])),
    () => new Response(null),
    () =>
      Response.json(
        { ...response(), error: { message: "disposable-embedding-key" } },
        { status: 429 },
      ),
    () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://example.invalid/secret" },
      }),
  ]) {
    let count = 0;
    const provider = config(async () => {
      count++;
      return make();
    });
    await assert.rejects(
      requestEmbedding(
        prepareEmbedding([bytes("public")], provider),
        provider,
        new AbortController().signal,
        { sent() {}, transportEnded() {}, async cost() {} },
      ),
    );
    assert.equal(count, 1);
  }
});

test("a stalled response body stops at the provider deadline", async () => {
  const controller = new AbortController();
  let canceled = false;
  let ended = false;
  const provider = config(
    async () =>
      new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(bytes('{"model":'));
          },
          cancel() {
            canceled = true;
          },
        }),
      ),
  );
  const work = requestEmbedding(
    prepareEmbedding([bytes("public")], provider),
    provider,
    controller.signal,
    {
      sent() {},
      transportEnded() {
        ended = true;
      },
      async cost() {},
    },
  );
  const timer = setTimeout(() => controller.abort(), 20);
  await assert.rejects(work);
  clearTimeout(timer);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(canceled);
  assert(ended);
});
