import assert from "node:assert/strict";
import { before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { initializeCore } from "../../core/src/index.ts";
import {
  AssistanceService,
  estimateAssistanceCost,
  type AssistanceBudgetSnapshot,
  type AssistanceBudgetStore,
  type AssistRequest,
} from "../src/assistance.ts";
import { providerConfig, type ProviderConfig } from "../src/inference.ts";
import { workerAssistanceBudgetStore } from "../../../apps/worker/src/assistance.ts";

before(async () =>
  initializeCore(
    await readFile(
      new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  ),
);
const bytes = new TextEncoder().encode("Public capacity fixture.");
const vector = [1, ...Array(4095).fill(0)];
const perInput = 1 / 2 ** 24;
const answer = {
  choices: [
    {
      finish_reason: "tool_calls",
      message: {
        tool_calls: [
          {
            id: "answer",
            type: "function",
            function: {
              name: "submit_answer",
              arguments: JSON.stringify({
                word_type: "gismu",
                alternative: null,
                alternative_reason: null,
                existing: null,
                reason: "Root.",
              }),
            },
          },
        ],
      },
    },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 },
};
function budget(initial: AssistanceBudgetSnapshot | null = null) {
  let snapshot = initial;
  let maxRows = 0;
  const store: AssistanceBudgetStore = {
    async load() {
      return structuredClone(snapshot);
    },
    async save(value) {
      snapshot = value;
      maxRows = Math.max(maxRows, value.entries.length);
    },
  };
  return {
    store,
    snapshot: () => structuredClone(snapshot!),
    maxRows: () => maxRows,
  };
}
function configured(fetcher: typeof fetch) {
  return {
    ...providerConfig(
      { JVC_AI_ENABLED: "enabled" },
      async () => "disposable-capacity-key",
    )!,
    fetch: fetcher,
  };
}
const draft: AssistRequest = {
  operation: "type",
  draft_revision: "capacity",
  language: "en",
  meaning: "A teacher.",
  current: {
    word_type: null,
    classification: null,
    spelling: null,
    text: [["A teacher."]],
    frame: null,
    glosses: [],
    formation: null,
    compound: null,
  },
  context: [],
  profile: "default",
};
async function generate(service: AssistanceService) {
  const session = (await service.route(
    new Request("http://localhost/session"),
    "/session",
    async () => new Uint8Array(),
    "192.0.2.8",
  ))!;
  const csrf = ((await session.json()) as any).csrf;
  return (await service.route(
    new Request("http://localhost/assist", {
      method: "POST",
      headers: {
        origin: "http://localhost",
        cookie: session.headers.get("set-cookie")!.split(";")[0],
        "x-csrf-token": csrf,
      },
    }),
    "/assist",
    async () => new TextEncoder().encode(JSON.stringify(draft)),
    "192.0.2.8",
  ))!;
}

test(
  "two 59,129-input index runs retain 8,192 assistance records of headroom",
  { timeout: 180000 },
  async (t) => {
    let clock = Date.now();
    t.mock.method(Date, "now", () => clock);
    const responses = Array.from({ length: 9 }, (_, count) =>
      JSON.stringify({
        model: "qwen/qwen3-embedding-8b",
        data: Array.from({ length: count }, (_, index) => ({
          index,
          embedding: vector,
        })),
        usage: {
          prompt_tokens: count,
          total_tokens: count,
          cost: count * perInput,
        },
      }),
    );
    let embeddingCalls = 0;
    let generationCalls = 0;
    const provider = configured(async (url, init) => {
      if (String(url).endsWith("/chat/completions")) {
        generationCalls++;
        return Response.json(answer);
      }
      embeddingCalls++;
      const count = JSON.parse(String(init?.body)).input.length;
      return new Response(responses[count]);
    });
    const durable = budget();
    const service = new AssistanceService(
      { provider, budgetStore: durable.store },
      "capacity",
      async () => [],
    );
    let recent: string[] = [];
    for (let run = 0; run < 2; run++) {
      if (run) clock += 2 * 3600000;
      for (let offset = 0; offset < 59129; offset += 8) {
        const result = await service.embed(
          Array(Math.min(8, 59129 - offset)).fill(bytes),
          { kind: "index" },
        );
        recent = [...recent.slice(-1), result.operation];
      }
    }
    assert.equal(embeddingCalls, 2 * Math.ceil(59129 / 8));
    assert(
      durable.maxRows() <= 4,
      "Successful index batches do not consume one durable row each.",
    );
    const snapshot = durable.snapshot();
    assert(snapshot.version === 2);
    assert.equal(
      snapshot.entries.reduce((sum, entry) => sum + entry.settledUsd, 0),
      2 * 59129 * perInput,
    );
    const diagnostics = await service.embeddingOperations();
    const compacted = diagnostics.find((entry) => entry.id === recent[0])!;
    assert(compacted);
    assert.equal(compacted.chargedUsd, 8 * perInput);
    assert.equal(compacted.reservedUsd, 0);
    assert.equal(compacted.costKnown, true);
    assert.match(compacted.summary!, /^embedding:index:summary:/);
    assert(snapshot.entries.some((entry) => entry.id === compacted.summary));

    // A realistic retained assistance population still leaves more than 8,000 rows free.
    for (let index = 0; index < 8192; index++)
      snapshot.entries.push({
        id: `generation-history-${index}`,
        at: clock,
        deadline: clock,
        reservedUsd: 0,
        settledUsd: perInput,
        costKnown: true,
        networkHashes: ["ab".repeat(32)],
        active: false,
      });
    assert(snapshot.entries.length < 16384 - 8000);
    assert(
      new TextEncoder().encode(JSON.stringify(snapshot)).byteLength <
        32 * 1024 * 1024,
    );
    const values = new Map<string, unknown>();
    const transaction = {
      async get<T>(key: string) {
        return values.get(key) as T | undefined;
      },
      async put<T>(key: string, value: T) {
        values.set(key, value);
      },
      async delete(key: string) {
        return values.delete(key);
      },
    };
    const workerStore = workerAssistanceBudgetStore({
      ...transaction,
      async transaction<T>(run: (value: typeof transaction) => Promise<T>) {
        return run(transaction);
      },
      async sync() {},
    });
    await workerStore.save(snapshot);
    assert.deepEqual(await workerStore.load(), snapshot);
    for (const part of values.values())
      if (part instanceof Uint8Array) assert(part.byteLength <= 64 * 1024);
    const work: Promise<unknown>[] = [];
    provider.networkHourlyBudgetUsd =
      estimateAssistanceCost(draft, [], provider) + perInput;
    const restored = new AssistanceService(
      {
        provider,
        budgetStore: workerStore,
        waitUntil: (promise) => {
          work.push(promise);
        },
      },
      "capacity",
      async () => [],
    );
    assert.equal((await generate(restored)).status, 202);
    await Promise.all(work);
    assert.equal(generationCalls, 1);
    const written = await workerStore.load();
    assert(written?.version === 2);
    assert.equal(
      written.entries.reduce((sum, entry) => sum + entry.settledUsd, 0),
      2 * 59129 * perInput + 8192 * perInput + 0.001,
    );
  },
);

test("operator summaries preserve errors, unknown charges, and conservative expiry after restart", async (t) => {
  const hour = 3600000;
  const start = Math.floor(Date.now() / hour) * hour;
  let clock = start + 1000;
  t.mock.method(Date, "now", () => clock);
  let calls = 0;
  const provider = configured(async () => {
    calls++;
    if (calls === 3) return new Response("unknown charge");
    if (calls === 4)
      return Response.json({ model: "different", usage: { cost: 1 / 16 } });
    return Response.json({
      model: "qwen/qwen3-embedding-8b",
      data: [{ index: 0, embedding: vector }],
      usage: { cost: 1 / 8 },
    });
  });
  const durable = budget();
  const service = new AssistanceService(
    { provider, budgetStore: durable.store },
    "capacity",
    async () => [],
  );
  await service.embed([bytes], { kind: "index" });
  clock = start + hour / 2;
  const second = await service.embed([bytes], { kind: "index" });
  const failures: string[] = [];
  for (let index = 0; index < 2; index++)
    await assert.rejects(
      service.embed([bytes], { kind: "index" }),
      (failure: any) => {
        assert.match(failure.operation, /^embedding:index:/);
        failures.push(failure.operation);
        return true;
      },
    );
  const snapshot = durable.snapshot();
  assert(snapshot.version === 2);
  const summary = snapshot.entries.find((entry) =>
    entry.id.includes(":summary:"),
  )!;
  assert.equal(summary.settledUsd, 1 / 4);
  assert.equal(summary.at, clock);
  assert.equal(summary.networkHashes.length, 1);
  assert(
    snapshot.entries.some(
      (entry) => entry.id === failures[0] && entry.costKnown === false,
    ),
  );
  assert(
    snapshot.entries.some(
      (entry) => entry.id === failures[1] && entry.settledUsd === 1 / 16,
    ),
  );
  const diagnostic = (await service.embeddingOperations()).find(
    (entry) => entry.id === second.operation,
  )!;
  assert.equal(diagnostic.chargedUsd, 1 / 8);
  assert.equal(diagnostic.summary, summary.id);
  const retained = budget(snapshot);
  const fullCharge = 1 / 4 + 1 / 16 + 0.00032;
  provider.hourlyBudgetUsd = fullCharge + 0.00016;
  provider.dailyBudgetUsd = fullCharge + 0.00016;
  const restored = new AssistanceService(
    { provider, budgetStore: retained.store },
    "capacity",
    async () => [],
  );
  await assert.rejects(
    restored.embed([bytes], { kind: "probe" }),
    (failure: any) => failure.code === "billing_limit",
  );
  clock = start + hour + 1001;
  await assert.rejects(
    restored.embed([bytes], { kind: "probe" }),
    (failure: any) => failure.code === "billing_limit",
  );
  // The summary ages from its newest charge. The daily window still applies afterward.
  clock = start + hour * 1.5 + 1;
  await assert.rejects(
    restored.embed([bytes], { kind: "probe" }),
    (failure: any) => failure.code === "billing_limit",
  );
  clock = start + hour * 24 + hour / 2 + 1;
  await restored.embed([bytes], { kind: "probe" });
});

test("operator batches whose caller stopped waiting keep their individual charge records", async () => {
  let resolve!: () => void;
  const gate = new Promise<void>((done) => {
    resolve = done;
  });
  let dispatched!: () => void;
  const sent = new Promise<void>((done) => {
    dispatched = done;
  });
  let calls = 0;
  const provider = configured(async () => {
    calls++;
    if (calls === 1) {
      dispatched();
      await gate;
    }
    return Response.json({
      model: "qwen/qwen3-embedding-8b",
      data: [{ index: 0, embedding: vector }],
      usage: { cost: perInput },
    });
  });
  const durable = budget();
  const background: Promise<unknown>[] = [];
  const service = new AssistanceService(
    {
      provider,
      budgetStore: durable.store,
      waitUntil: (work) => {
        background.push(work);
      },
    },
    "capacity",
    async () => [],
  );
  const caller = new AbortController();
  const work = service.embed([bytes], { kind: "index" }, caller.signal);
  await sent;
  caller.abort();
  let operation: string | undefined;
  await assert.rejects(work, (failure: any) => {
    operation = failure.operation;
    return !!operation;
  });
  resolve();
  await Promise.all(background);
  await service.embed([bytes], { kind: "probe" });
  assert(
    durable
      .snapshot()
      .entries.some(
        (entry) => entry.id === operation && entry.settledUsd === perInput,
      ),
  );
  const diagnostic = (await service.embeddingOperations()).find(
    (entry) => entry.id === operation,
  )!;
  assert.equal(diagnostic.chargedUsd, perInput);
  assert.equal(diagnostic.summary, null);
});
