import assert from "node:assert/strict";
import { before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { initializeCore, utf8 } from "../../core/src/index.ts";
import {
  AssistanceService,
  type AssistanceBudgetSnapshot,
  type AssistanceBudgetStore,
} from "../src/assistance.ts";
import { providerConfig, type ProviderConfig } from "../src/inference.ts";
import {
  prepareEmbedding,
  requestEmbedding,
  OPERATOR_EMBEDDING_LIMITS,
} from "../src/embedding.ts";

before(async () =>
  initializeCore(
    await readFile(
      new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  ),
);
const inputs = (count = 1) =>
  Array.from({ length: count }, (_, i) => utf8(`Operator definition ${i}`));
const quote = 0.00032;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until(condition: () => boolean) {
  for (let i = 0; i < 1000; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("The mocked provider did not become active.");
}
function response(count: number, dense = false) {
  return Response.json({
    model: "qwen/qwen3-embedding-8b",
    data: Array.from({ length: count }, (_, index) => ({
      index,
      embedding: Array.from({ length: 4096 }, (_, i) =>
        dense ? 0.1234567 : i ? 0 : 1,
      ),
    })),
    usage: { prompt_tokens: count, total_tokens: count, cost: 0.000001 },
  });
}
function provider(overrides: Partial<ProviderConfig> = {}) {
  return {
    ...providerConfig(
      { JVC_AI_ENABLED: "enabled" },
      async () => "disposable-operator-key",
    )!,
    fetch: async (_url: unknown, init?: RequestInit) =>
      response(JSON.parse(String(init?.body)).input.length),
    ...overrides,
  } as ProviderConfig;
}
function ledger() {
  let snapshot: AssistanceBudgetSnapshot | null = null;
  const store: AssistanceBudgetStore = {
    load: async () => structuredClone(snapshot),
    save: async (value) => {
      snapshot = structuredClone(value);
    },
  };
  return { store, entries: () => snapshot?.entries ?? [] };
}

test("operator embedding exceeds server slots and budgets while recording charges", async () => {
  const gate = deferred();
  let active = 0;
  const budget = ledger();
  const config = provider({
    concurrency: 2,
    maxCostUsd: 0.0000001,
    hourlyBudgetUsd: 0.0000001,
    dailyBudgetUsd: 0.0000001,
    fetch: async (_url, init) => {
      active++;
      await gate.promise;
      return response(JSON.parse(String(init?.body)).input.length);
    },
  });
  const service = new AssistanceService(
    {
      provider: config,
      budgetStore: budget.store,
      operatorIndexing: { concurrency: 8 },
    },
    "operator-test",
    async () => [],
  );
  const jobs = Array.from({ length: 8 }, () =>
    service.embed(inputs(16), { kind: "index" }),
  );
  try {
    await until(() => active === 8);
    await assert.rejects(service.embed(inputs(), { kind: "index" }), {
      code: "embedding_busy",
    });
    await assert.rejects(
      service.embed(inputs(), { kind: "query", network: "local" }),
      { code: "embedding_busy" },
    );
  } finally {
    gate.resolve();
    await Promise.all(jobs);
    await service.drainEmbeddingTransports();
  }
  assert.equal(config.concurrency, 2);
  assert(
    budget.entries().every((entry) => !entry.active && entry.reservedUsd === 0),
  );
  assert(
    Math.abs(
      budget.entries().reduce((sum, entry) => sum + entry.settledUsd, 0) -
        0.000008,
    ) < 1e-12,
  );
  await assert.rejects(
    service.embed(inputs(), { kind: "query", network: "local" }),
    { code: "billing_request_too_large" },
  );
  await assert.rejects(
    service.embed(inputs(16), { kind: "query", network: "local" }),
    { code: "embedding_input" },
  );
});

test("server indexing keeps its original input, slot, and spending limits", async () => {
  const gate = deferred();
  let active = 0;
  const service = new AssistanceService(
    {
      provider: provider({
        concurrency: 2,
        fetch: async (_url, init) => {
          active++;
          await gate.promise;
          return response(JSON.parse(String(init?.body)).input.length);
        },
      }),
      budgetStore: ledger().store,
    },
    "server-test",
    async () => [],
  );
  await assert.rejects(service.embed(inputs(9), { kind: "index" }), {
    code: "embedding_input",
  });
  const jobs = [
    service.embed(inputs(), { kind: "index" }),
    service.embed(inputs(), { kind: "query", network: "local" }),
  ];
  try {
    await until(() => active === 2);
    await assert.rejects(service.embed(inputs(), { kind: "index" }), {
      code: "embedding_busy",
    });
  } finally {
    gate.resolve();
    await Promise.all(jobs);
    await service.drainEmbeddingTransports();
  }
  const limited = new AssistanceService(
    {
      provider: provider({
        hourlyBudgetUsd: 0.0000001,
        dailyBudgetUsd: 0.0000001,
      }),
      budgetStore: ledger().store,
    },
    "limited",
    async () => [],
  );
  await assert.rejects(limited.embed(inputs(), { kind: "index" }), {
    code: "billing_request_too_large",
  });
  await assert.rejects(
    limited.embed(inputs(), { kind: "query", network: "local" }),
    { code: "billing_request_too_large" },
  );
});

test("an operator run ceiling includes concurrent reservations and releases unused quotes", async () => {
  const gate = deferred();
  let active = 0;
  const budget = ledger();
  const service = new AssistanceService(
    {
      provider: provider({
        fetch: async (_url, init) => {
          active++;
          await gate.promise;
          return response(JSON.parse(String(init?.body)).input.length);
        },
      }),
      budgetStore: budget.store,
      operatorIndexing: { concurrency: 8, maxCostUsd: quote * 2 },
    },
    "ceiling",
    async () => [],
  );
  const jobs = [
    service.embed(inputs(), { kind: "index" }),
    service.embed(inputs(), { kind: "index" }),
  ];
  try {
    await until(() => active === 2);
    await assert.rejects(service.embed(inputs(), { kind: "index" }), {
      code: "billing_operator_limit",
    });
  } finally {
    gate.resolve();
    await Promise.all(jobs);
  }
  await service.embed(inputs(), { kind: "index" });
  await service.drainEmbeddingTransports();
  assert.equal(active, 3);
  assert(
    Math.abs(
      budget.entries().reduce((sum, entry) => sum + entry.settledUsd, 0) -
        0.000003,
    ) < 1e-12,
  );
});

test("unsent operator failures release the run ceiling but unknown sent charges remain", async () => {
  const service = new AssistanceService(
    {
      provider: provider(),
      budgetStore: ledger().store,
      operatorIndexing: { concurrency: 8, maxCostUsd: quote },
    },
    "unsent",
    async () => [],
  );
  await assert.rejects(
    service.embed(inputs(), { kind: "index" }, undefined, async () => {
      throw new Error("The intent was not saved.");
    }),
  );
  await service.embed(inputs(), { kind: "index" });
  await service.drainEmbeddingTransports();
  const gate = deferred();
  const budget = ledger();
  const timeout = new AssistanceService(
    {
      provider: provider({
        timeoutMs: 30,
        fetch: async (_url, init) => {
          await gate.promise;
          return response(JSON.parse(String(init?.body)).input.length);
        },
      }),
      budgetStore: budget.store,
      operatorIndexing: { concurrency: 8, maxCostUsd: quote },
    },
    "unknown",
    async () => [],
  );
  try {
    await assert.rejects(timeout.embed(inputs(), { kind: "index" }), {
      code: "embedding_timeout",
    });
    await assert.rejects(timeout.embed(inputs(), { kind: "index" }), {
      code: "billing_operator_limit",
    });
  } finally {
    gate.resolve();
    await timeout.drainEmbeddingTransports();
  }
  assert(
    budget
      .entries()
      .some(
        (entry) =>
          entry.reservedUsd === quote &&
          "costKnown" in entry &&
          !entry.costKnown,
      ),
  );
});

test("operator request and response caps expand only the transport envelope", async () => {
  const config = provider({
    fetch: async (_url, init) =>
      response(JSON.parse(String(init?.body)).input.length, true),
  });
  const batch = Array.from({ length: 128 }, () => utf8("\u0001".repeat(4096)));
  const prepared = prepareEmbedding(batch, config, true);
  assert.equal(prepared.count, 128);
  assert.equal(prepared.responseBytes, OPERATOR_EMBEDDING_LIMITS.responseBytes);
  assert(
    new TextEncoder().encode(prepared.body).length <=
      OPERATOR_EMBEDDING_LIMITS.requestBytes,
  );
  assert.throws(() => prepareEmbedding(batch, config), {
    code: "embedding_input",
  });
  assert.throws(() => prepareEmbedding([...batch, batch[0]], config, true), {
    code: "embedding_input",
  });
  assert.throws(
    () => prepareEmbedding([utf8("a".repeat(4097))], config, true),
    { code: "embedding_input" },
  );
  const result = await requestEmbedding(
    prepared,
    config,
    new AbortController().signal,
    { sent() {}, transportEnded() {}, async cost() {} },
  );
  assert.equal(result.vectors.length, 128);
  assert(result.vectors.every((vector) => vector.length === 4096));
});

test("operator admission preserves the durable ledger record bound", async () => {
  const now = Date.now();
  let snapshot: AssistanceBudgetSnapshot = {
    version: 1,
    entries: Array.from({ length: 16384 }, (_, i) => ({
      id: `retained-${i}`,
      at: now,
      reservedUsd: 0.000001,
      settledUsd: 0,
      active: false,
    })),
  };
  const budget: AssistanceBudgetStore = {
    load: async () => structuredClone(snapshot),
    save: async (value) => {
      snapshot = structuredClone(value);
    },
  };
  const service = new AssistanceService(
    {
      provider: provider(),
      budgetStore: budget,
      operatorIndexing: { concurrency: 8 },
    },
    "full-ledger",
    async () => [],
  );
  await assert.rejects(service.embed(inputs(), { kind: "index" }), {
    code: "billing_history_limit",
  });
  assert.equal(snapshot.entries.length, 16384);
});
