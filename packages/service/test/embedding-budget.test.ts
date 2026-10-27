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
import {
  AssistanceError,
  providerConfig,
  type ProviderConfig,
} from "../src/inference.ts";
import { EMBEDDING_MODEL } from "../src/embedding.ts";
import { DictionaryService } from "../src/service.ts";
import { emptyState } from "../src/storage.ts";
import { nodeAssistance } from "../../../apps/server/src/assistance.ts";

before(async () =>
  initializeCore(
    await readFile(
      new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  ),
);
const input = [new TextEncoder().encode("A public test definition.")];
const quote = 0.00032;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until(condition: () => boolean | Promise<boolean>) {
  for (let index = 0; index < 500; index++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("The mocked operation did not reach its expected state.");
}
function embedding(cost: number | null = 0.000001, model = EMBEDDING_MODEL) {
  return {
    model,
    data: [
      {
        index: 0,
        embedding: Array.from({ length: 4096 }, (_, index) => (index ? 0 : 2)),
      },
    ],
    usage: cost === null ? {} : { prompt_tokens: 100, total_tokens: 100, cost },
  };
}
function completion(cost = 0.001) {
  return {
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
    usage: { prompt_tokens: 100, completion_tokens: 50, cost },
  };
}
function config(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    ...providerConfig(
      { JVC_AI_ENABLED: "enabled" },
      async () => "disposable-shared-key",
    )!,
    fetch: async () => Response.json(embedding()),
    ...overrides,
  };
}
function store(initial: AssistanceBudgetSnapshot | null = null) {
  let snapshot = initial;
  const result: AssistanceBudgetStore & {
    snapshot(): AssistanceBudgetSnapshot | null;
  } = {
    async load() {
      return structuredClone(snapshot);
    },
    async save(value) {
      snapshot = structuredClone(value);
    },
    snapshot() {
      return structuredClone(snapshot);
    },
  };
  return result;
}
function fixture(provider = config(), budgetStore = store()) {
  const background: Promise<unknown>[] = [];
  const service = new AssistanceService(
    {
      provider,
      budgetStore,
      waitUntil: (work) => {
        background.push(work);
      },
    },
    "embedding-test",
    async () => [],
  );
  return { service, budgetStore, background };
}
const query = (network = "192.0.2.1") => ({ kind: "query" as const, network });
const rejectCode = (code: string) => (failure: any) =>
  failure instanceof AssistanceError && failure.code === code;
const entries = (budget: ReturnType<typeof store>) => {
  const snapshot = budget.snapshot();
  assert(snapshot?.version === 2);
  return snapshot.entries;
};

test("an operator saves its operation link before dispatch", async () => {
  let linked: string | null = null;
  const budget = store();
  const { service } = fixture(
    config({
      fetch: async () => {
        assert(linked?.startsWith("embedding:index:"));
        assert(
          entries(budget).some((entry) => entry.id === linked && entry.active),
        );
        return Response.json(embedding());
      },
    }),
    budget,
  );
  const result = await service.embed(
    input,
    { kind: "index" },
    undefined,
    async (operation) => {
      linked = operation;
    },
  );
  assert.equal(result.operation, linked);
});

test("a failed operator link prevents dispatch and releases the unsent reservation", async () => {
  let sends = 0;
  const budget = store();
  const { service } = fixture(
    config({
      fetch: async () => {
        sends++;
        return Response.json(embedding());
      },
    }),
    budget,
  );
  await assert.rejects(
    service.embed(input, { kind: "index" }, undefined, async () => {
      throw new Error("The job store did not save its operation link.");
    }),
  );
  assert.equal(sends, 0);
  assert.equal(entries(budget).length, 0);
  const operation = (await service.embeddingOperations())[0];
  assert.equal(operation.state, "failed");
  assert.equal(operation.transportPending, false);
  assert.equal(operation.reservedUsd, 0);
  assert.equal(operation.chargedUsd, 0);
});

test("host drain includes an interrupted admission before an execution slot exists", async () => {
  const durable = store();
  const gate = deferred<void>();
  let saving = false;
  let sends = 0;
  const budget: AssistanceBudgetStore = {
    load: durable.load,
    async save(snapshot) {
      if (!saving && snapshot.entries.some((entry) => entry.active)) {
        saving = true;
        await gate.promise;
      }
      await durable.save(snapshot);
    },
  };
  const service = new AssistanceService(
    {
      provider: config({
        timeoutMs: 40,
        fetch: async () => {
          sends++;
          return Response.json(embedding());
        },
      }),
      budgetStore: budget,
    },
    "test",
    async () => [],
  );
  const caller = service
    .embed(input, { kind: "index" })
    .catch((failure) => failure);
  await until(() => saving);
  const failure = await caller;
  assert.equal(failure.code, "embedding_timeout");
  let drained = false;
  const shutdown = service.drainEmbeddingTransports().then(() => {
    drained = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(drained, false);
  gate.resolve();
  await shutdown;
  assert.equal(sends, 0);
  assert.equal(entries(durable).length, 0);
});

test("host drain includes a preparing dispatch hook after its caller times out", async () => {
  const gate = deferred<void>();
  let preparing = false;
  let sends = 0;
  const { service, budgetStore } = fixture(
    config({
      timeoutMs: 40,
      fetch: async () => {
        sends++;
        return Response.json(embedding());
      },
    }),
  );
  const caller = service
    .embed(input, { kind: "index" }, undefined, async () => {
      preparing = true;
      await gate.promise;
    })
    .catch((failure) => failure);
  await until(() => preparing);
  assert.equal((await caller).code, "embedding_timeout");
  let drained = false;
  const shutdown = service.drainEmbeddingTransports().then(() => {
    drained = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(drained, false);
  gate.resolve();
  await shutdown;
  assert.equal(sends, 0);
  assert.equal(entries(budgetStore).length, 0);
});
const draft = (): AssistRequest => ({
  operation: "type",
  draft_revision: "shared-budget",
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
});
async function generation(
  service: AssistanceService,
  network = "198.51.100.1",
) {
  const session = (await service.route(
    new Request("http://localhost/session", {
      headers: { origin: "http://localhost" },
    }),
    "/session",
    async () => new Uint8Array(),
    network,
  ))!;
  const csrf = ((await session.json()) as any).csrf;
  const request = new Request("http://localhost/assist", {
    method: "POST",
    headers: {
      origin: "http://localhost",
      cookie: session.headers.get("set-cookie")!.split(";")[0],
      "x-csrf-token": csrf,
    },
  });
  return (await service.route(
    request,
    "/assist",
    async () => new TextEncoder().encode(JSON.stringify(draft())),
    network,
  ))!;
}

test("embedding reserves durably before dispatch and settles the actual reported charge", async () => {
  const budget = store();
  const { service } = fixture(
    config({
      fetch: async () => {
        const entry = entries(budget)[0];
        assert(entry.active);
        assert.equal(entry.reservedUsd, quote);
        return Response.json(embedding(0.000002));
      },
    }),
    budget,
  );
  const result = await service.embed(input, query());
  assert.match(result.operation, /^embedding:query:/);
  assert.equal(result.vectors.length, 1);
  assert.equal(entries(budget)[0].reservedUsd, 0);
  assert.equal(entries(budget)[0].settledUsd, 0.000002);
  assert.equal(entries(budget)[0].active, false);
  const serialized = JSON.stringify(budget.snapshot());
  for (const secret of [
    "192.0.2.1",
    "public test definition",
    "disposable-shared-key",
    "embedding-test",
  ])
    assert(!serialized.includes(secret));
  const status = await service.embeddingOperations();
  assert.equal(status[0].id, result.operation);
  assert.equal(status[0].state, "completed");
  assert.equal(status[0].chargedUsd, 0.000002);
});

test("generation, query, and indexing race for the same remaining server allowance", async () => {
  const gate = deferred<void>();
  let dispatches = 0;
  const provider = config({
    concurrency: 4,
    fetch: async (url) => {
      dispatches++;
      await gate.promise;
      return Response.json(
        String(url).endsWith("/embeddings") ? embedding() : completion(),
      );
    },
  });
  provider.hourlyBudgetUsd =
    estimateAssistanceCost(draft(), [], provider) + quote * 1.5;
  provider.dailyBudgetUsd = provider.hourlyBudgetUsd;
  provider.networkHourlyBudgetUsd = provider.hourlyBudgetUsd;
  provider.networkDailyBudgetUsd = provider.hourlyBudgetUsd;
  const { service, background, budgetStore } = fixture(provider);
  const started = await generation(service);
  assert.equal(started.status, 202);
  let refused = 0;
  const work = [
    service.embed(input, query()),
    service.embed(input, { kind: "index" }),
  ].map((pending) =>
    pending.catch((failure) => {
      assert.equal(failure.code, "billing_pending");
      refused++;
      return null;
    }),
  );
  await until(() => dispatches === 2 && refused === 1);
  assert.equal(entries(budgetStore).length, 2);
  gate.resolve();
  const results = await Promise.all(work);
  await Promise.all(background);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(dispatches, 2);
});

test("reported embedding charges block generation through the same ledger", async () => {
  const provider = config();
  const generationQuote = estimateAssistanceCost(draft(), [], provider);
  provider.hourlyBudgetUsd = generationQuote + 0.000001;
  provider.networkHourlyBudgetUsd = provider.hourlyBudgetUsd;
  provider.fetch = async () => Response.json(embedding(0.01));
  const { service } = fixture(provider);
  await service.embed(input, { kind: "probe" });
  const refused = await generation(service);
  assert.equal(refused.status, 429);
  assert.equal(((await refused.json()) as any).code, "billing_limit");
  assert(Number(refused.headers.get("retry-after")) > 0);
});

test("query admission shares IPv4, IPv6 /64, and IPv6 /48 spending identities", async () => {
  for (const [first, second] of [
    ["192.0.2.1", "::ffff:192.0.2.1"],
    ["2001:db8:abcd:1::1", "2001:db8:abcd:1::2"],
    ["2001:db8:abcd:1::1", "2001:db8:abcd:2::1"],
  ]) {
    const { service, budgetStore } = fixture(
      config({
        networkHourlyBudgetUsd: quote * 1.5,
        networkDailyBudgetUsd: quote * 1.5,
        fetch: async () => Response.json(embedding(null)),
      }),
    );
    await service.embed(input, query(first));
    await assert.rejects(
      service.embed(input, query(second)),
      rejectCode("billing_limit"),
    );
    assert.equal(entries(budgetStore).length, 1);
    await service.embed(input, query("203.0.113.7"));
    assert.equal(entries(budgetStore).length, 2);
  }
});

test("operator batches obey server ceilings without consuming unrelated network shares", async () => {
  const { service, budgetStore } = fixture(
    config({
      hourlyBudgetUsd: quote * 2.5,
      dailyBudgetUsd: quote * 2.5,
      networkHourlyBudgetUsd: quote * 1.1,
      networkDailyBudgetUsd: quote * 1.1,
      fetch: async () => Response.json(embedding(null)),
    }),
  );
  await service.embed(input, { kind: "index" });
  await service.embed(input, query());
  await assert.rejects(
    service.embed(input, { kind: "probe" }),
    rejectCode("billing_limit"),
  );
  assert.equal(entries(budgetStore).length, 2);
  assert(
    entries(budgetStore).every(
      (entry) => "networkHashes" in entry && entry.networkHashes.length > 0,
    ),
  );
});

test("missing costs and malformed sent responses retain conservative reservations", async () => {
  for (const fetcher of [
    async () => Response.json(embedding(null)),
    async () => new Response("invalid JSON"),
    async () => new Response("large".repeat(600000)),
    async () => {
      throw new Error("disposable-shared-key");
    },
    async () => Response.json({ ...embedding(null), model: "another-model" }),
  ] as (typeof fetch)[]) {
    const { service, budgetStore } = fixture(config({ fetch: fetcher }));
    await service
      .embed(input, query())
      .catch((failure) =>
        assert(!failure.message.includes("disposable-shared-key")),
      );
    const entry = entries(budgetStore)[0];
    assert.equal(entry.active, false);
    assert.equal(entry.reservedUsd, quote);
    assert.equal(entry.settledUsd, quote);
    assert.equal("costKnown" in entry && entry.costKnown, false);
  }
});

test("model mismatch and invalid vectors preserve known charges without a global financial stop", async () => {
  let calls = 0;
  const { service, budgetStore } = fixture(
    config({
      fetch: async () => {
        calls++;
        return Response.json(
          calls === 1
            ? embedding(0.000007, "another-model")
            : calls === 2
              ? { ...embedding(0.000008), data: [] }
              : embedding(),
        );
      },
    }),
  );
  await assert.rejects(
    service.embed(input, query()),
    rejectCode("embedding_model_mismatch"),
  );
  await assert.rejects(
    service.embed(input, query()),
    rejectCode("embedding_response"),
  );
  await service.embed(input, query());
  assert.equal(calls, 3);
  assert.equal(entries(budgetStore)[0].settledUsd, 0.000007);
  assert.equal(entries(budgetStore)[1].settledUsd, 0.000008);
  assert(entries(budgetStore).every((entry) => entry.reservedUsd === 0));
});

test("caller departure detaches the response while provider work settles once", async () => {
  const gate = deferred<void>();
  const caller = new AbortController();
  let calls = 0;
  let providerSignal: AbortSignal | null | undefined;
  const { service, budgetStore, background } = fixture(
    config({
      fetch: async (_url, init) => {
        calls++;
        providerSignal = init?.signal;
        await gate.promise;
        return Response.json(embedding(0.000009));
      },
    }),
  );
  const work = service.embed(input, query(), caller.signal);
  await until(() => calls === 1);
  caller.abort();
  await assert.rejects(work);
  assert.equal(providerSignal?.aborted, false);
  assert.equal(entries(budgetStore)[0].active, true);
  assert.equal(entries(budgetStore)[0].reservedUsd, quote);
  gate.resolve();
  await Promise.all(background);
  assert.equal(calls, 1);
  assert.equal(entries(budgetStore)[0].reservedUsd, 0);
  assert.equal(entries(budgetStore)[0].settledUsd, 0.000009);
});

test("a transport that ignores abort keeps its shared execution slot until it ends", async () => {
  const gate = deferred<void>();
  let calls = 0;
  const { service, budgetStore, background } = fixture(
    config({
      concurrency: 1,
      timeoutMs: 30,
      fetch: async () => {
        calls++;
        if (calls === 1) await gate.promise;
        return Response.json(embedding());
      },
    }),
  );
  await assert.rejects(
    service.embed(input, query()),
    rejectCode("embedding_timeout"),
  );
  await Promise.all(background);
  const [status] = await service.embeddingOperations();
  assert.equal(status.state, "timed_out");
  assert.equal(status.transportPending, true);
  assert.equal(status.active, false);
  assert.equal(status.reservedUsd, quote);
  await assert.rejects(
    service.embed(input, { kind: "index" }),
    rejectCode("embedding_busy"),
  );
  const refused = await generation(service);
  assert.equal(refused.status, 429);
  assert.equal(calls, 1);
  gate.resolve();
  await until(
    async () => !(await service.embeddingOperations())[0].transportPending,
  );
  await service.embed(input, { kind: "probe" });
  assert.equal(calls, 2);
  assert.equal(
    entries(budgetStore)[0].reservedUsd,
    quote,
    "A late reply never refunds the timed out charge.",
  );
});

test("generation occupies the same execution slots as embedding", async () => {
  const gate = deferred<void>();
  let calls = 0;
  const { service, background } = fixture(
    config({
      concurrency: 1,
      fetch: async () => {
        calls++;
        await gate.promise;
        return Response.json(completion());
      },
    }),
  );
  assert.equal((await generation(service)).status, 202);
  await until(() => calls === 1);
  await assert.rejects(
    service.embed(input, { kind: "index" }),
    rejectCode("embedding_busy"),
  );
  gate.resolve();
  await Promise.all(background);
  assert.equal(calls, 1);
});

test("restart keeps interrupted embedding reservations and permits supported later attempts", async () => {
  const gate = deferred<void>();
  let dispatched = false;
  const original = fixture(
    config({
      fetch: async () => {
        dispatched = true;
        await gate.promise;
        return Response.json(embedding());
      },
    }),
  );
  const inFlight = original.service.embed(input, { kind: "index" });
  await until(() => dispatched);
  const written = original.budgetStore.snapshot()!;
  assert.equal(written.entries[0].active, true);
  assert(written.version === 2);
  assert.equal(written.entries[0].costKnown, true);
  assert.equal(written.entries[0].settledUsd, 0);
  const budget = store(written);
  const { service } = fixture(
    config({ hourlyBudgetUsd: quote * 2, dailyBudgetUsd: quote * 1.5 }),
    budget,
  );
  const [interrupted] = await service.embeddingOperations();
  assert.equal(interrupted.id, written.entries[0].id);
  assert.equal(interrupted.state, "retained");
  assert.equal(interrupted.active, false);
  assert.equal(interrupted.reservedUsd, quote);
  assert.equal(interrupted.costKnown, false);
  assert.equal(interrupted.chargedUsd, quote);
  assert.equal(entries(budget)[0].costKnown, false);
  await assert.rejects(
    service.embed(input, { kind: "index" }),
    rejectCode("billing_limit"),
  );
  const recovered = fixture(config(), budget).service;
  await recovered.embed(input, { kind: "index" });
  assert.equal(entries(budget).length, 2);
  assert.equal(entries(budget)[0].reservedUsd, quote);
  gate.resolve();
  await inFlight;
});

test("storage failures block paid dispatch and recover through the same service", async () => {
  const durable = store();
  let failLoad = true;
  let failSave = false;
  let calls = 0;
  const budget: AssistanceBudgetStore = {
    async load() {
      if (failLoad) throw new Error("Unreadable");
      return durable.load();
    },
    async save(snapshot) {
      if (failSave) throw new Error("Unwritable");
      await durable.save(snapshot);
    },
  };
  const service = new AssistanceService(
    {
      provider: config({
        fetch: async () => {
          calls++;
          return Response.json(embedding());
        },
      }),
      budgetStore: budget,
    },
    "test",
    async () => [],
  );
  await assert.rejects(
    service.embed(input, { kind: "index" }),
    rejectCode("billing_unavailable"),
  );
  failLoad = false;
  failSave = true;
  await assert.rejects(
    service.embed(input, { kind: "index" }),
    rejectCode("billing_unavailable"),
  );
  assert.equal(calls, 0);
  failSave = false;
  await service.embed(input, { kind: "index" });
  assert.equal(calls, 1);
});

test("admission and settlement waits cannot extend the caller deadline or dispatch expired work", async () => {
  const durable = store();
  const gate = deferred<void>();
  let saves = 0;
  let calls = 0;
  const budget: AssistanceBudgetStore = {
    load: () => durable.load(),
    async save(snapshot) {
      saves++;
      await durable.save(snapshot);
      if (saves === 2) await gate.promise;
    },
  };
  const service = new AssistanceService(
    {
      provider: config({
        timeoutMs: 30,
        fetch: async () => {
          calls++;
          return Response.json(embedding());
        },
      }),
      budgetStore: budget,
    },
    "test",
    async () => [],
  );
  const first = service.embed(input, { kind: "index" });
  let timedOutOperation: string | undefined;
  const firstRejected = assert.rejects(first, (failure: any) => {
    assert.equal(failure.code, "embedding_timeout");
    timedOutOperation = failure.operation;
    return true;
  });
  await until(() => saves === 2);
  const reserved = durable.snapshot()!.entries[0];
  assert.equal(reserved.active, true);
  assert.equal(reserved.reservedUsd, quote);
  const secondRejected = assert.rejects(
    service.embed(input, query()),
    rejectCode("embedding_timeout"),
  );
  await Promise.all([firstRejected, secondRejected]);
  assert.equal(timedOutOperation, reserved.id);
  assert.equal(calls, 0);
  gate.resolve();
  await service.embeddingOperations();
  assert.equal(calls, 0);
  assert.equal(durable.snapshot()!.entries.length, 0);
  assert(saves >= 3);

  const settlement = deferred<void>();
  let settlementStarted = false;
  const delayed: AssistanceBudgetStore = {
    load: () => durable.load(),
    async save(snapshot) {
      if (snapshot.entries.some((entry) => entry.settledUsd > 0)) {
        settlementStarted = true;
        await settlement.promise;
      }
      await durable.save(snapshot);
    },
  };
  const settling = new AssistanceService(
    { provider: config({ timeoutMs: 30 }), budgetStore: delayed },
    "test",
    async () => [],
  );
  await assert.rejects(
    settling.embed(input, query()),
    rejectCode("embedding_timeout"),
  );
  assert(settlementStarted);
  settlement.resolve();
  await until(
    async () => (await settling.embeddingOperations())[0]?.active === false,
  );
});

for (const blockedSave of ["retry", "reservation"] as const) {
  test(`caller abort during the ${blockedSave} save leaves no dispatch, charge, or summary`, async () => {
    const durable = store();
    const entered = deferred<void>();
    const release = deferred<void>();
    const background: Promise<unknown>[] = [];
    let saves = 0;
    let calls = 0;
    const budgetStore: AssistanceBudgetStore = {
      load: () => durable.load(),
      async save(snapshot) {
        saves++;
        if (blockedSave === "retry" && saves === 2)
          throw new Error("The first reservation save failed.");
        await durable.save(snapshot);
        if (saves === (blockedSave === "retry" ? 3 : 2)) {
          entered.resolve();
          await release.promise;
        }
      },
    };
    const service = new AssistanceService(
      {
        provider: config({
          fetch: async () => {
            calls++;
            return Response.json(embedding());
          },
        }),
        budgetStore,
        waitUntil: (work) => {
          background.push(work);
        },
      },
      "embedding-test",
      async () => [],
    );
    if (blockedSave === "retry") {
      await assert.rejects(
        service.embed(input, { kind: "index" }),
        (failure: any) => {
          assert.equal(failure.code, "billing_unavailable");
          assert.match(failure.operation, /^embedding:index:/);
          return true;
        },
      );
      assert.deepEqual(entries(durable), []);
    }
    const caller = new AbortController();
    const pending = service
      .embed(input, { kind: "index" }, caller.signal)
      .catch((failure) => failure);
    await entered.promise;
    const saved = entries(durable);
    if (blockedSave === "reservation") {
      assert.equal(saved.length, 1);
      assert.equal(saved[0].active, true);
      assert.equal(saved[0].reservedUsd, quote);
    } else assert.deepEqual(saved, []);
    caller.abort();
    const failure = await pending;
    if (blockedSave === "reservation") {
      assert.equal(failure.code, "embedding_canceled");
      assert.equal(failure.operation, saved[0].id);
    } else {
      assert.equal(failure.name, "AbortError");
      assert.equal(failure.operation, undefined);
    }
    release.resolve();
    await Promise.all(background);
    const afterCancellation = entries(durable);
    const canceledDiagnostics = await service.embeddingOperations();
    const canceledCalls = calls;
    // Later admissions exercise compaction without creating a charge for canceled work.
    await service.embed(input, { kind: "index" });
    await service.embed(input, { kind: "index" });
    const later = entries(durable);
    assert.equal(canceledCalls, 0);
    assert.deepEqual(afterCancellation, []);
    assert.deepEqual(canceledDiagnostics, []);
    assert.equal(calls, 2);
    assert(
      later.some((entry) => entry.id.startsWith("embedding:index:summary:")),
    );
    assert.equal(
      later.reduce((sum, entry) => sum + entry.settledUsd, 0),
      0.000002,
    );
    assert(later.every((entry) => entry.id !== failure.operation));
    assert(
      !(await service.embeddingOperations()).some(
        (entry) => entry.id === failure.operation,
      ),
    );
  });
}

test("unsent failures release their reservation and no disabled capability is introduced", async () => {
  const { service, budgetStore } = fixture(
    config({
      key: async () => {
        throw new Error("No disposable key.");
      },
    }),
  );
  await assert.rejects(
    service.embed(input, query()),
    rejectCode("provider_credentials"),
  );
  assert.equal(entries(budgetStore).length, 0);
  assert.equal((await service.embeddingOperations())[0].state, "failed");
  await assert.rejects(
    new AssistanceService({}, "test", async () => []).embed(input, {
      kind: "probe",
    }),
    rejectCode("feature_disabled"),
  );
  const dictionary = new DictionaryService(
    { get: async () => null, put: async () => {} },
    {
      load: async () => emptyState(),
      getSnapshot: async () => null,
      compareAndSwap: async () => true,
    },
    {
      assistance: { provider: config() },
      serverId: "embedding-test",
      policyUrl: "https://example.test/policy",
    },
  );
  const capabilities = (await (
    await dictionary.fetch(new Request("http://localhost/api/v1/capabilities"))
  ).json()) as any;
  assert.equal(capabilities.features.assistance, true);
  assert.equal(capabilities.features.semantic_search, false);
  assert.deepEqual(capabilities.embedding_profiles, []);
  assert.equal(
    (
      await dictionary.fetch(
        new Request("http://localhost/api/v1/search/semantic"),
      )
    ).status,
    404,
  );
});

test("a generation admission queued on final settlement receives a finite retry interval", async () => {
  const durable = store();
  const finalSave = deferred<void>();
  let settling = false;
  const budget: AssistanceBudgetStore = {
    load: () => durable.load(),
    async save(snapshot) {
      if (
        snapshot.entries.some((entry) => !entry.active && entry.settledUsd > 0)
      ) {
        settling = true;
        await finalSave.promise;
      }
      await durable.save(snapshot);
    },
  };
  const service = new AssistanceService(
    { provider: config({ concurrency: 1 }), budgetStore: budget },
    "test",
    async () => [],
  );
  const embeddingWork = service.embed(input, { kind: "probe" });
  await until(() => settling);
  const generationWork = generation(service);
  await new Promise(setImmediate);
  finalSave.resolve();
  const response = await generationWork;
  await embeddingWork;
  assert.equal(response.status, 429);
  const retry = response.headers.get("retry-after");
  assert(retry && /^\d+$/.test(retry));
  assert(Number.isFinite(Number(retry)) && Number(retry) >= 1);
});

test("restored settled records use retained diagnostics without claiming an interruption", async () => {
  const budget = store();
  const original = fixture(config(), budget).service;
  await original.embed(input, query());
  const [retained] = await fixture(
    config(),
    budget,
  ).service.embeddingOperations();
  assert.equal(retained.state, "retained");
  assert.equal(retained.reservedUsd, 0);
  assert.equal(retained.chargedUsd, 0.000001);
  assert.equal(retained.active, false);
});

test("invalid query networks cannot create separate spending buckets", async () => {
  let calls = 0;
  const { service, budgetStore } = fixture(
    config({
      fetch: async () => {
        calls++;
        return Response.json(embedding());
      },
    }),
  );
  for (const network of [
    "",
    "operator",
    "192.0.2.1:443",
    "192.0.2.1:444",
    "192.0.2.1/64",
    "local:1",
    "2001:db8::/48",
    "not-an-address",
  ]) {
    await assert.rejects(
      service.embed(input, query(network)),
      rejectCode("embedding_network"),
    );
  }
  assert.equal(calls, 0);
  assert.equal(budgetStore.snapshot(), null);
  await service.embed(input, query("local"));
  await service.embed(input, query("2001:db8:0:1::/64"));
  assert.equal(calls, 2);
});

test("a lower route cap retains nonzero conservative charges when sent usage is missing", async () => {
  const { service, budgetStore } = fixture(
    config({
      maxPrice: 0.001,
      fetch: async (_url, init) => {
        assert.equal(
          JSON.parse(String(init?.body)).provider.max_price.prompt,
          0.001,
        );
        return Response.json(embedding(null));
      },
    }),
  );
  await service.embed(input, { kind: "index" });
  assert.equal(entries(budgetStore)[0].reservedUsd, quote);
  assert.equal(entries(budgetStore)[0].settledUsd, quote);
  assert.equal(entries(budgetStore)[0].costKnown, false);
  const invalid = fixture(
    config({
      embedding: { model: EMBEDDING_MODEL, route: "nebius", inputPrice: 0 },
    }),
  );
  await assert.rejects(
    invalid.service.embed(input, { kind: "index" }),
    rejectCode("embedding_configuration"),
  );
  assert.equal(invalid.budgetStore.snapshot(), null);
});

test("key-loader failures are unavailable credentials and route failures are not model drift", async () => {
  const failed = fixture(
    config({
      key: async () => {
        throw new Error("disposable-shared-key");
      },
    }),
  );
  await assert.rejects(failed.service.embed(input, query()), (failure: any) => {
    assert.equal(failure.status, 503);
    assert.equal(failure.code, "provider_credentials");
    assert(!failure.message.includes("disposable-shared-key"));
    return true;
  });
  for (const status of [402, 404, 429, 503]) {
    const { service } = fixture(
      config({
        fetch: async () =>
          Response.json(
            { error: { message: "No endpoints found" } },
            { status },
          ),
      }),
    );
    await assert.rejects(
      service.embed(input, query()),
      rejectCode("embedding_provider"),
    );
  }
});

test("invalid embedding settings leave Node generation and browser consent profiles unchanged", async (t) => {
  const warning = t.mock.method(console, "warn", () => {});
  const variants = [
    { JVC_AI_EMBEDDING_MODEL: "" },
    { JVC_AI_EMBEDDING_MODEL: "private-invalid-model" },
    { JVC_AI_EMBEDDING_PROVIDER_ROUTE: "" },
    { JVC_AI_EMBEDDING_PROVIDER_ROUTE: "private-invalid-route" },
    { JVC_AI_EMBEDDING_INPUT_PRICE: "" },
    { JVC_AI_EMBEDDING_INPUT_PRICE: "NaN" },
    { JVC_AI_EMBEDDING_INPUT_PRICE: "0" },
    { JVC_AI_EMBEDDING_INPUT_PRICE: "5e-324" },
  ];
  const capabilities = async (provider: ProviderConfig) => {
    const service = new DictionaryService(
      { get: async () => null, put: async () => {} },
      {
        load: async () => emptyState(),
        getSnapshot: async () => null,
        compareAndSwap: async () => true,
      },
      {
        serverId: "test",
        policyUrl: "https://example.test/policy",
        assistance: { provider },
      },
    );
    return (await (
      await service.fetch(new Request("http://localhost/api/v1/capabilities"))
    ).json()) as any;
  };
  const baseline = await capabilities(config());
  for (const variant of variants) {
    const budget = store();
    const options = nodeAssistance(
      {
        JVC_AI_ENABLED: "enabled",
        JVC_AI_KEY_FILE: "/synthetic/unread",
        ...variant,
      },
      budget,
    );
    const provider = options.provider!;
    assert(provider);
    assert.equal(provider.embedding, undefined);
    assert.match(
      provider.embeddingDisabledReason!,
      /^Embedding inference is disabled because JVC_AI_EMBEDDING_/,
    );
    assert(!provider.embeddingDisabledReason!.includes("private-invalid"));
    assert.deepEqual(
      (await capabilities(provider)).assistance_profiles,
      baseline.assistance_profiles,
    );
    provider.key = async () => "disposable-shared-key";
    let turns = 0;
    provider.fetch = async () => {
      turns++;
      return Response.json(completion());
    };
    const work: Promise<unknown>[] = [];
    const instance = new AssistanceService(
      {
        ...options,
        waitUntil: (promise) => {
          work.push(promise);
        },
      },
      "test",
      async () => [],
    );
    assert.equal((await generation(instance)).status, 202);
    await Promise.all(work);
    assert.equal(turns, 1);
    await assert.rejects(
      instance.embed(input, { kind: "probe" }),
      (failure: any) =>
        failure.code === "embedding_configuration" &&
        failure.message === provider.embeddingDisabledReason,
    );
    assert.equal(entries(budget).length, 1);
  }
  assert.equal(warning.mock.calls.length, variants.length);
});

test("every admitted embedding failure names its own operation, including shared caller aborts", async () => {
  for (const fetcher of [
    async () => {
      throw new Error("Transport failed.");
    },
    async () => Response.json({ ...embedding(), model: "different" }),
    async () => new Response("invalid JSON"),
  ] as (typeof fetch)[]) {
    const { service } = fixture(config({ fetch: fetcher }));
    let failureId: string | undefined;
    await assert.rejects(service.embed(input, query()), (failure: any) => {
      assert.match(failure.operation, /^embedding:query:/);
      failureId = failure.operation;
      return true;
    });
    assert.equal((await service.embeddingOperations())[0].id, failureId);
  }
  const caller = new AbortController();
  const reason = new AssistanceError(499, "caller_left", "The caller left.");
  const gate = deferred<void>();
  let calls = 0;
  const { service, background } = fixture(
    config({
      fetch: async () => {
        calls++;
        await gate.promise;
        return Response.json(embedding());
      },
    }),
  );
  const first = service
    .embed(input, query("192.0.2.1"), caller.signal)
    .catch((failure) => failure);
  const second = service
    .embed(input, query("192.0.2.2"), caller.signal)
    .catch((failure) => failure);
  await until(() => calls === 2);
  caller.abort(reason);
  const errors = await Promise.all([first, second]);
  assert.notEqual(errors[0], errors[1]);
  assert.notEqual(errors[0].operation, errors[1].operation);
  assert.equal(reason.operation, undefined);
  for (const failure of errors) {
    assert.equal(failure.code, reason.code);
    assert.equal(failure.status, reason.status);
    assert(
      (await service.embeddingOperations()).some(
        (entry) => entry.id === failure.operation,
      ),
    );
  }
  gate.resolve();
  await Promise.all(background);
});
