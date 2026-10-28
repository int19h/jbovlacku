import assert from "node:assert/strict";
import { before, test, type TestContext } from "node:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeCore, utf8 } from "../../core/src/index.ts";
import { SqliteVectorStore } from "../../../apps/server/src/semantic.ts";
import { SqliteAssistanceBudgetStore } from "../../../apps/server/src/assistance.ts";
import { AssistanceService } from "../src/assistance.ts";
import {
  AssistanceError,
  providerConfig,
  type ProviderConfig,
} from "../src/inference.ts";
import { BackgroundSemanticIndexer } from "../src/semantic/background.ts";
import {
  createQwenProfile,
  inputHash,
  profileId,
} from "../src/semantic/profile.ts";
import type { IndexDocument } from "../src/semantic/source.ts";

before(async () =>
  initializeCore(
    await readFile(
      new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  ),
);
const hash = (n: number, prefix = "sha256:") =>
  prefix + n.toString(16).padStart(64, "0");
const quote = 0.00032;
const cost = 0.000001;
const success = (count = 1, price = cost) =>
  Response.json({
    model: "qwen/qwen3-embedding-8b",
    data: Array.from({ length: count }, (_, index) => ({
      index,
      embedding: Array.from({ length: 4096 }, (_, i) => (i ? 0 : 1)),
    })),
    usage: { prompt_tokens: 100, total_tokens: 100, cost: price },
  });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 1000; i++) {
    if (predicate()) return;
    await new Promise(setImmediate);
  }
  assert.fail("The mock transport did not reach the expected state.");
}
function documents(count: number): IndexDocument[] {
  return Array.from({ length: count }, (_, i) => {
    const input = utf8(`Background definition ${i}.`);
    return {
      event: hash(i + 1, "jve1:"),
      envelope: hash(i + 100),
      body: hash(i + 200),
      extraction_version: 2,
      word: hash(i + 300, "jvw1:"),
      language: "en",
      input,
      input_hash: inputHash(input),
      error: null,
    };
  });
}
async function fixture(
  t: TestContext,
  fetcher: typeof fetch,
  count = 1,
  overrides: Partial<ProviderConfig> = {},
) {
  const root = process.env.JVC_TEST_ROOT ?? tmpdir();
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "background-recovery-"));
  let now = Date.UTC(2026, 9, 27, 12);
  t.mock.method(Date, "now", () => now);
  let store = new SqliteVectorStore(join(directory, "vectors.sqlite"));
  let budget = new SqliteAssistanceBudgetStore(
    join(directory, "budget.sqlite"),
  );
  const config = {
    ...providerConfig(
      { JVC_AI_ENABLED: "enabled" },
      async () => "disposable-recovery-key",
    )!,
    fetch: fetcher,
    ...overrides,
  };
  let assistance = new AssistanceService(
    { provider: config, budgetStore: budget },
    "test",
    async () => [],
  );
  const profile = createQwenProfile("43".repeat(16));
  const context = {
    snapshot: hash(1000),
    view: hash(1100, "jve1:"),
    profile: profileId(profile),
    eligible: 0,
  };
  const initial = await store.create(context, profile);
  await store.stage(initial.id, null, {
    documents: [],
    next: null,
    done: true,
  });
  await store.start(initial.id);
  await store.finish(initial.id);
  await store.publish(initial.id, null);
  const docs = documents(count);
  const source = {
    context: { ...context, snapshot: hash(1001), eligible: count },
    page: async () => ({
      documents: docs,
      next: docs.at(-1)!.event,
      done: true,
    }),
  };
  const reports: unknown[] = [];
  const options = {
    store,
    profile: context.profile,
    view: context.view,
    assistance,
    source: async () => source,
    probe: async () => {},
    report: (error: unknown) => {
      reports.push(error);
    },
  };
  const hosts: BackgroundSemanticIndexer[] = [];
  const host = () => {
    const value = new BackgroundSemanticIndexer(options);
    hosts.push(value);
    return value;
  };
  const job = async () =>
    (await store.backgroundGeneration(context.profile, context.view))!;
  const advance = (ms: number) => {
    now += ms;
  };
  const next = async (background: BackgroundSemanticIndexer) => {
    now = Math.max(
      now + 1000,
      (await job()).background_recovery?.next_attempt ?? 0,
    );
    await background.cycle();
  };
  t.after(async () => {
    for (const background of hosts) await background.close();
    await assistance.drainEmbeddingTransports();
    store.close();
    budget.close();
    await rm(directory, { recursive: true });
  });
  return {
    get store() {
      return store;
    },
    get budget() {
      return budget;
    },
    get assistance() {
      return assistance;
    },
    async reopen() {
      await assistance.drainEmbeddingTransports();
      store.close();
      budget.close();
      store = new SqliteVectorStore(join(directory, "vectors.sqlite"));
      budget = new SqliteAssistanceBudgetStore(
        join(directory, "budget.sqlite"),
      );
      assistance = new AssistanceService(
        { provider: config, budgetStore: budget },
        "test",
        async () => [],
      );
      options.store = store;
      options.assistance = assistance;
    },
    config,
    profile,
    source,
    docs,
    options,
    reports,
    host,
    job,
    advance,
    next,
  };
}
const charge = async (budget: SqliteAssistanceBudgetStore) =>
  (await budget.load())?.entries.reduce(
    (sum, entry) => sum + Math.max(entry.reservedUsd, entry.settledUsd),
    0,
  ) ?? 0;

test("background recovery completes busy then 5xx then timeout then success with exact shared charges", async (t) => {
  const gate = deferred();
  let calls = 0;
  const sizes: number[] = [];
  const f = await fixture(
    t,
    async (_url, init) => {
      calls++;
      const size = JSON.parse(String(init?.body)).input.length;
      sizes.push(size);
      if (calls === 1) {
        await gate.promise;
        return success();
      }
      if (calls === 2) return new Response("Unknown", { status: 503 });
      if (calls === 3)
        return await new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener(
            "abort",
            () => reject(init!.signal!.reason),
            { once: true },
          );
        });
      return success(size);
    },
    9,
    { concurrency: 1, timeoutMs: 2000 },
  );
  const occupying = f.assistance.embed([utf8("Other query")], {
    kind: "query",
    network: "local",
  });
  await until(() => calls === 1);
  const background = f.host();
  await background.cycle();
  assert.equal((await f.job()).error, "embedding_busy");
  assert.equal((await f.store.batches((await f.job()).id))[0].operation, null);
  assert.equal(
    (await f.budget.load())!.entries.length,
    1,
    "Busy indexing must add no reservation",
  );
  gate.resolve();
  await occupying;
  f.config.timeoutMs = 200;
  await f.next(background);
  assert.equal(
    calls,
    2,
    "A busy background job must retry without operator selection",
  );
  await f.next(background);
  await f.assistance.drainEmbeddingTransports();
  assert.equal(calls, 3);
  await f.next(background);
  assert.equal((await f.job()).state, "completed");
  const batches = await f.store.batches((await f.job()).id);
  assert.equal(batches.length, 5);
  assert.equal(batches.filter((b) => b.previous).length, 3);
  assert.equal(
    new Set(batches.flatMap((b) => (b.operation ? [b.operation] : []))).size,
    4,
  );
  assert.deepEqual(sizes, [1, 8, 8, 8, 1]);
  assert(Math.abs((await charge(f.budget)) - (16 * quote + 3 * cost)) < 1e-12);
  const retained = await f.store.summary((await f.job()).id);
  assert.equal(retained.completed_inputs, 9);
  await background.cycle();
  assert.equal(calls, 5, "A completed vector must not be replayed");
});

for (const recovery of ["cooldown", "restart"] as const) {
  test(`background exhaustion pauses visibly and recovers after ${recovery}`, async (t) => {
    let calls = 0;
    const f = await fixture(t, async () =>
      ++calls <= 4 ? new Response("Unknown", { status: 503 }) : success(),
    );
    let background = f.host();
    await background.cycle();
    for (let i = 0; i < 3; i++) await f.next(background);
    assert.equal(calls, 4, "Unknown sends must receive three linked retries");
    const exhausted = await f.job();
    assert.equal(exhausted.state, "completed");
    assert.equal(exhausted.background_inputs?.count, 1);
    assert.equal(exhausted.background_recovery!.exhausted, true);
    assert.equal(
      exhausted.background_recovery!.next_attempt - Date.now(),
      3600000,
    );
    assert.equal(f.reports.length, 2);
    assert.match(String(f.reports.at(-1)), /Automatic retries exhausted/);
    await background.cycle();
    if (recovery === "cooldown") {
      f.advance(3599999);
      await background.cycle();
      assert.equal(calls, 4);
    }
    if (recovery === "restart") {
      await background.close();
      background = f.host();
      await background.cycle();
      assert.equal(
        calls,
        4,
        "A restart must preserve the parked input deadline",
      );
      f.advance(3600000);
    } else f.advance(1);
    await background.cycle();
    assert.equal(calls, 5);
    assert.equal((await f.job()).state, "completed");
    assert.equal((await f.job()).background_recovery, undefined);
    assert.equal(
      (await f.store.batches(exhausted.id)).filter((b) => b.previous).length,
      4,
    );
    assert(Math.abs((await charge(f.budget)) - (4 * quote + cost)) < 1e-12);
  });
}

for (const window of ["hourlyBudgetUsd", "dailyBudgetUsd"] as const) {
  test(`background ${window} refusal waits for its full window across restart without another charge`, async (t) => {
    let calls = 0;
    const f = await fixture(
      t,
      async () => success(1, ++calls === 1 ? 0.002 : cost),
      1,
      { hourlyBudgetUsd: 1, dailyBudgetUsd: 1, [window]: 0.002 },
    );
    await f.assistance.embed([utf8("Earlier paid work")], { kind: "index" });
    let background = f.host();
    await background.cycle();
    const refused = await f.job();
    assert.equal(refused.error, "billing_limit");
    assert.equal(await charge(f.budget), 0.002);
    const duration = window === "hourlyBudgetUsd" ? 3600000 : 86400000;
    assert(
      refused.background_recovery,
      "A budget refusal must retain an automatic recovery deadline",
    );
    assert.equal(refused.background_recovery.not_before - Date.now(), duration);
    await background.close();
    background = f.host();
    f.advance(duration - 1);
    await background.cycle();
    assert.equal(calls, 1);
    f.advance(1);
    await background.cycle();
    assert.equal(calls, 2);
    assert.equal((await f.job()).state, "completed");
    assert.equal(f.config[window], 0.002);
    assert(
      Math.abs(
        (await charge(f.budget)) -
          ((window === "dailyBudgetUsd" ? 0 : 0.002) + cost),
      ) < 1e-12,
    );
  });
}

test("background retry waits for timed-out transport drain even when another slot is free", async (t) => {
  const gate = deferred();
  let calls = 0;
  const f = await fixture(
    t,
    async () => {
      if (++calls === 1) await gate.promise;
      return success();
    },
    1,
    { concurrency: 2, timeoutMs: 200 },
  );
  const background = f.host();
  await background.cycle();
  const failed = await f.job();
  assert.equal(failed.error, "embedding_timeout");
  f.advance(60000);
  await background.cycle();
  assert.equal(calls, 1);
  gate.resolve();
  await f.assistance.drainEmbeddingTransports();
  await background.cycle();
  assert.equal(
    calls,
    2,
    "The drained timeout must recover without operator action",
  );
  assert.equal((await f.job()).state, "completed");
  assert(Math.abs((await charge(f.budget)) - (quote + cost)) < 1e-12);
});

for (const mode of ["unsent", "sent"] as const) {
  test(`background ${mode} probe failure backs off and preserves only actual charges`, async (t) => {
    let calls = 0;
    const f = await fixture(t, async () =>
      ++calls === 1 && mode === "sent"
        ? new Response("Unknown", { status: 503 })
        : success(),
    );
    // Give the initial publication a reference vector so that background probing runs.
    const seeded = await f.store.create(
      { ...f.source.context, snapshot: hash(1200) },
      f.profile,
    );
    await f.store.stage(seeded.id, null, {
      documents: f.docs,
      next: f.docs[0].event,
      done: true,
    });
    await f.store.start(seeded.id);
    const seedBatch = (await f.store.claim(seeded.id))!;
    await f.store.sent(seedBatch.id, "embedding:index:fixture");
    await f.store.complete(
      seedBatch.id,
      "embedding:index:fixture",
      [Float32Array.from({ length: 4096 }, (_, i) => (i ? 0 : 1))],
      { inputTokens: 0, totalTokens: 0, costUsd: 0 },
    );
    await f.store.finish(seeded.id);
    await f.store.publish(
      seeded.id,
      await f.store.current(seeded.profile, seeded.view),
    );
    const more = documents(2);
    f.source.context.eligible = 2;
    f.source.page = async () => ({
      documents: more,
      next: more[1].event,
      done: true,
    });
    let probes = 0;
    f.options.probe = async () => {
      if (++probes === 1) {
        if (mode === "unsent")
          throw new AssistanceError(429, "embedding_busy", "Busy probe.");
        await f.assistance.embed([utf8("Probe")], { kind: "probe" });
      }
    };
    const background = f.host();
    await background.cycle().catch((error) => {
      assert.equal(
        error.code,
        mode === "unsent" ? "embedding_busy" : "embedding_provider",
      );
    });
    assert.equal(probes, 1);
    assert.equal((await f.store.batches((await f.job()).id)).length, 0);
    assert.equal(await charge(f.budget), mode === "sent" ? quote : 0);
    await background.cycle();
    assert.equal(probes, 1);
    await f.next(background);
    assert.equal(probes, 2, "A failed probe must recover after backoff");
    assert.equal((await f.job()).state, "completed");
    assert(
      Math.abs(
        (await charge(f.budget)) - ((mode === "sent" ? quote : 0) + cost),
      ) < 1e-12,
    );
  });
}

test("background long rate limit and a shutdown during cooldown resume without an early send", async (t) => {
  let calls = 0;
  const f = await fixture(t, async () =>
    ++calls === 1
      ? new Response("Limited", {
          status: 429,
          headers: { "retry-after": "120" },
        })
      : success(),
  );
  let background = f.host();
  await background.cycle();
  const failed = await f.job();
  assert.equal(failed.error, "embedding_rate_limited");
  await background.close();
  // This is the old server's durable stop state during a rate-limit wait.
  await f.store.pause(failed.id, "index_paused");
  background = f.host();
  f.advance(119999);
  await background.cycle();
  assert.equal(calls, 1);
  f.advance(1);
  await background.cycle();
  assert.equal(
    calls,
    2,
    "The stopped cooldown job must resume at its saved deadline",
  );
  assert.equal((await f.job()).state, "completed");
  assert.equal(
    (await f.store.batches(failed.id)).find((b) => b.previous)!.state,
    "completed",
  );
});

for (const state of ["preparing", "running", "paused_sent"] as const) {
  test(`background restart recovers legacy ${state} jobs without requiring a staged source snapshot`, async (t) => {
    let calls = 0;
    const f = await fixture(t, async () => {
      calls++;
      return success();
    });
    const saved = await f.store.create(f.source.context, f.profile);
    await f.store.setBackgroundGeneration(saved.id);
    if (state !== "preparing") {
      await f.store.stage(saved.id, null, {
        documents: f.docs,
        next: f.docs[0].event,
        done: true,
      });
      await f.store.start(saved.id);
      const batch = (await f.store.claim(saved.id))!;
      await f.store.sent(batch.id, "embedding:index:interrupted");
      if (state === "paused_sent")
        await f.store.pause(saved.id, "index_paused");
      f.options.source = async () => {
        throw new Error("The old source snapshot expired.");
      };
    }
    const background = f.host();
    await background.cycle();
    assert.equal(
      calls,
      1,
      "The server must recover its unfinished background job",
    );
    assert.equal((await f.job()).state, "completed");
    if (state !== "preparing")
      assert.equal(
        (await f.store.batches(saved.id)).filter((b) => b.state === "ambiguous")
          .length,
        1,
      );
  });
}

test("background retries never bypass a suspended profile", async (t) => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    return new Response("Unknown", { status: 503 });
  });
  const background = f.host();
  await background.cycle();
  await f.store.suspend(f.source.context.profile, "embedding_model_mismatch");
  f.advance(86400000);
  await background.cycle();
  await background.close();
  await f.host().cycle();
  assert.equal(calls, 1);
});

test("background recovery selects the latest owner beyond 64 failed batches", async (t) => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    return success();
  });
  const saved = await f.store.create(f.source.context, f.profile);
  await f.store.stage(saved.id, null, {
    documents: f.docs,
    next: f.docs[0].event,
    done: true,
  });
  await f.store.setBackgroundGeneration(saved.id);
  let last: string | undefined;
  let first: string | undefined;
  for (let i = 0; i < 70; i++) {
    if (last) await f.store.retry(last);
    await f.store.start(saved.id);
    const batch = (await f.store.claim(saved.id))!;
    first ??= batch.id;
    last = batch.id;
    await f.store.fail(batch.id, "embedding_busy");
    await f.store.pause(saved.id, "embedding_busy");
  }
  await assert.rejects(f.store.retry(first!), { code: "semantic_retry" });
  await f.host().cycle();
  assert.equal(
    calls,
    1,
    "Recovery must find the current failed owner after a long history",
  );
  assert.equal((await f.job()).state, "completed");
  const completed = (await f.store.batches(saved.id, null, 128)).find(
    (b) => b.state === "completed",
  )!;
  assert.equal(completed.previous, last);
  assert.equal((await f.store.summary(saved.id)).batches, 71);
});

test("background recovery skips a failed batch whose vectors another generation completed", async (t) => {
  const sizes: number[] = [];
  const f = await fixture(
    t,
    async (_url, init) => {
      const size = JSON.parse(String(init?.body)).input.length;
      sizes.push(size);
      return success(size);
    },
    16,
  );
  const saved = await f.store.create(f.source.context, f.profile);
  await f.store.stage(saved.id, null, {
    documents: f.docs,
    next: f.docs.at(-1)!.event,
    done: true,
  });
  await f.store.setBackgroundGeneration(saved.id);
  await f.store.start(saved.id);
  const one = (await f.store.claim(saved.id))!;
  const two = (await f.store.claim(saved.id))!;
  await f.store.fail(one.id, "embedding_busy");
  await f.store.fail(two.id, "embedding_busy");
  await f.store.pause(saved.id, "embedding_busy");
  const external = await f.store.create(
    { ...f.source.context, snapshot: hash(1002), eligible: 8 },
    f.profile,
  );
  const shared = f.docs.filter((d) => one.inputs.includes(d.input_hash!));
  await f.store.stage(external.id, null, {
    documents: shared,
    next: shared.at(-1)!.event,
    done: true,
  });
  await f.store.start(external.id);
  const batch = (await f.store.claim(external.id))!;
  await f.store.sent(batch.id, "embedding:index:external");
  await f.store.complete(
    batch.id,
    "embedding:index:external",
    shared.map(() =>
      Float32Array.from({ length: 4096 }, (_, i) => (i ? 0 : 1)),
    ),
    { inputTokens: 0, totalTokens: 0, costUsd: 0 },
  );
  await f.store.finish(external.id);
  await f.host().cycle();
  assert.equal(
    (await f.job()).state,
    "completed",
    "Completed vectors must not hide a different failed batch",
  );
  assert.deepEqual(sizes, [8]);
  const linked = (await f.store.batches(saved.id)).find((b) => b.previous)!;
  assert.equal(linked.previous, two.id);
  assert.equal(linked.state, "completed");
});

test("background success resets the send retry round and a later probe failure does not recount an old send", async (t) => {
  let calls = 0;
  const f = await fixture(
    t,
    async (_url, init) => {
      calls++;
      if (calls <= 3 || calls === 5)
        return new Response("Unknown", { status: 503 });
      return success(JSON.parse(String(init?.body)).input.length);
    },
    9,
  );
  const background = f.host();
  await background.cycle();
  for (let i = 0; i < 3; i++) await f.next(background);
  assert.equal(
    calls,
    5,
    "The third linked retry must complete the first batch and continue to fresh work",
  );
  assert.equal((await f.job()).background_recovery!.sent_attempts, 1);
  assert.equal((await f.job()).background_recovery!.exhausted, false);
  let probes = 0;
  f.options.probe = async () => {
    if (++probes === 1)
      throw new AssistanceError(429, "embedding_busy", "Probe refused.");
  };
  await f.next(background);
  assert.equal(calls, 5);
  assert.equal(
    (await f.job()).background_recovery!.sent_attempts,
    1,
    "A failed probe must not count the old indexing send again",
  );
  await f.next(background);
  assert.equal(calls, 6);
  assert.equal((await f.job()).state, "completed");
});

test("background unsent failures use capped exponential backoff without charges", async (t) => {
  let calls = 0;
  let unavailable = true;
  const f = await fixture(
    t,
    async () => {
      calls++;
      return success();
    },
    1,
    {
      key: async () => {
        if (unavailable) throw new Error("Unavailable test key.");
        return "disposable-recovery-key";
      },
    },
  );
  const background = f.host();
  const delays: number[] = [];
  await background.cycle();
  for (let i = 0; i < 8; i++) {
    const recovery = (await f.job()).background_recovery;
    assert(recovery, "An unsent refusal must receive a recovery deadline");
    delays.push(recovery.next_attempt - Date.now());
    await background.cycle();
    if (i < 7) await f.next(background);
  }
  assert.deepEqual(
    delays,
    [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000],
  );
  assert.equal(calls, 0);
  assert.equal(await charge(f.budget), 0);
  unavailable = false;
  await f.next(background);
  assert.equal(calls, 1);
  assert.equal((await f.job()).state, "completed");
});

test("background recovery survives closed SQLite handles and a new shared-budget service", async (t) => {
  let calls = 0;
  const f = await fixture(t, async () =>
    ++calls === 1 ? new Response("Unknown", { status: 503 }) : success(),
  );
  let background = f.host();
  await background.cycle();
  const before = await f.job();
  const batch = (await f.store.batches(before.id))[0];
  assert.equal(await charge(f.budget), quote);
  await background.close();
  await f.reopen();
  assert.equal((await f.job()).id, before.id);
  assert.deepEqual(
    (await f.job()).background_recovery,
    before.background_recovery,
  );
  assert.equal(await charge(f.budget), quote);
  background = f.host();
  await f.next(background);
  assert.equal(
    calls,
    2,
    "A reopened background job must recover from its saved failed send",
  );
  assert.equal((await f.job()).state, "completed");
  const retry = (await f.store.batches(before.id)).find(
    (entry) => entry.previous === batch.id,
  )!;
  assert.equal(retry.state, "completed");
  assert.notEqual(retry.operation, batch.operation);
  assert(Math.abs((await charge(f.budget)) - (quote + cost)) < 1e-12);
});

test("background restart after exhaustion preserves the provider deadline", async (t) => {
  let calls = 0;
  const f = await fixture(t, async () =>
    ++calls <= 4
      ? new Response("Limited", {
          status: 429,
          headers: { "retry-after": "120" },
        })
      : success(),
  );
  let background = f.host();
  await background.cycle();
  for (let i = 0; i < 3; i++) await f.next(background);
  assert.equal(
    calls,
    4,
    "Rate-limited sends must reach the bounded retry limit",
  );
  assert.equal((await f.job()).background_recovery!.exhausted, true);
  await background.close();
  background = f.host();
  await background.cycle();
  assert.equal(calls, 4);
  f.advance(119999);
  await background.cycle();
  assert.equal(calls, 4);
  f.advance(1);
  await background.cycle();
  assert.equal(calls, 4);
  f.advance(3480000);
  await background.cycle();
  assert.equal(calls, 5);
  assert.equal((await f.job()).state, "completed");
});

test("a saved provider cooldown refuses fresh background indexing without a paid batch", async (t) => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    return success();
  });
  await f.store.defer(f.source.context.profile, Date.now() + 120000);
  const background = f.host();
  await background.cycle();
  assert.equal(calls, 0);
  assert.equal((await f.store.batches((await f.job()).id)).length, 0);
  assert.equal(await charge(f.budget), 0);
  f.advance(120000);
  await background.cycle();
  assert.equal(
    calls,
    1,
    "A refusal before dispatch must resume when the saved cooldown ends",
  );
  assert.equal((await f.job()).state, "completed");
});

test("background success resets durable recovery before a stop and store reopen", async (t) => {
  let calls = 0;
  const f = await fixture(
    t,
    async (_url, init) => {
      calls++;
      return calls <= 3 || calls === 5
        ? new Response("Unknown", { status: 503 })
        : success(JSON.parse(String(init?.body)).input.length);
    },
    9,
  );
  let background = f.host();
  await background.cycle();
  await f.next(background);
  await f.next(background);
  assert.equal(calls, 3, "The saved job must reach its third sent failure");
  const complete = f.store.complete.bind(f.store);
  let closing: Promise<void> | undefined;
  f.store.complete = async (...args) => {
    await complete(...args);
    closing = background.close();
  };
  await f.next(background);
  await closing;
  assert.equal(calls, 4);
  assert.equal((await f.job()).state, "paused");
  assert.equal(
    (await f.job()).background_recovery,
    undefined,
    "The successful vector transaction must clear the old streak before shutdown",
  );
  await f.reopen();
  background = f.host();
  await background.cycle();
  assert.equal(calls, 5);
  assert.equal((await f.job()).background_recovery!.sent_attempts, 1);
  assert.equal((await f.job()).background_recovery!.exhausted, false);
  await f.next(background);
  assert.equal((await f.job()).state, "completed");
});

test("background exhaustion writes safe status even when raw error reporting is disabled", async (t) => {
  let calls = 0;
  const f = await fixture(t, async () =>
    ++calls <= 4
      ? new Response("Private provider response", { status: 503 })
      : success(),
  );
  const status: string[] = [];
  let rawErrors = 0;
  const background = new BackgroundSemanticIndexer({
    ...f.options,
    report: () => {
      rawErrors++;
    },
    status: (message) => {
      status.push(message);
    },
  });
  try {
    await background.cycle();
    for (let i = 0; i < 3; i++) await f.next(background);
    assert.equal(
      calls,
      4,
      "The background job must finish its automatic retry round",
    );
    assert.equal(rawErrors, 0);
    assert.equal(status.length, 2);
    assert.match(status.at(-1)!, /Automatic retries exhausted/);
    assert.match(status.at(-1)!, /Retry at/);
    assert(!status.join(" ").includes("Private provider response"));
  } finally {
    await background.close();
  }
});

for (const hint of ["31536000", "9007199254740991"]) {
  test(`background provider hint ${hint} stays within the one-hour cap and recovers`, async (t) => {
    let calls = 0;
    const f = await fixture(t, async () =>
      ++calls === 1
        ? new Response("Limited", {
            status: 429,
            headers: { "retry-after": hint },
          })
        : success(),
    );
    const background = f.host();
    await background.cycle();
    const saved = await f.job();
    assert.equal(
      saved.error,
      "embedding_rate_limited",
      "A large provider hint must not become an invalid-date error",
    );
    assert(
      saved.background_recovery,
      "A long provider refusal must receive a recovery deadline",
    );
    assert.equal(saved.background_recovery.next_attempt - Date.now(), 3600000);
    assert.equal(saved.background_recovery.not_before - Date.now(), 3600000);
    f.advance(3599999);
    await background.cycle();
    assert.equal(calls, 1);
    f.advance(1);
    await background.cycle();
    assert.equal(calls, 2);
    assert.equal((await f.job()).state, "completed");
    assert(Math.abs((await charge(f.budget)) - (quote + cost)) < 1e-12);
  });
}
