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
import { SemanticSearch, type SearchContext } from "../src/semantic/search.ts";
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

async function seedReference(f: Awaited<ReturnType<typeof fixture>>) {
  const seeded = await f.store.create(
    { ...f.source.context, snapshot: hash(1200), eligible: 1 },
    f.profile,
  );
  await f.store.stage(seeded.id, null, {
    documents: [f.docs[0]],
    next: f.docs[0].event,
    done: true,
  });
  await f.store.start(seeded.id);
  const batch = (await f.store.claim(seeded.id))!;
  await f.store.sent(batch.id, "embedding:index:fixture");
  await f.store.complete(
    batch.id,
    "embedding:index:fixture",
    [Float32Array.from({ length: 4096 }, (_, i) => (i ? 0 : 1))],
    { inputTokens: 0, totalTokens: 0, costUsd: 0 },
  );
  await f.store.finish(seeded.id);
  await f.store.publish(
    seeded.id,
    await f.store.current(seeded.profile, seeded.view),
  );
}

for (const mode of ["sent", "unknown"] as const) {
  test(`R4-1 ${mode} probe failures stop after four attempts per recovery round`, async (t) => {
    let sends = 0;
    const f = await fixture(
      t,
      async () => {
        sends++;
        return new Response("Unknown", { status: 503 });
      },
      2,
    );
    await seedReference(f);
    f.options.probe = async () => {
      if (mode === "unknown") {
        sends++;
        throw new Error("Unknown dispatch outcome");
      }
      await f.assistance.embed([utf8("Probe")], { kind: "probe" });
    };
    const background = f.host();
    await background.cycle();
    for (let i = 0; i < 3; i++) await f.next(background);
    assert.equal(sends, 4);
    assert.equal(
      (await f.job()).background_recovery?.sent_attempts,
      4,
      "A paid or unknown probe must count as a sent attempt",
    );
    assert.equal(
      (await f.job()).background_recovery?.next_attempt,
      Date.now() + 3600000,
    );
    f.advance(3599999);
    await background.cycle();
    assert.equal(sends, 4);
    f.advance(1);
    await background.cycle();
    for (let i = 0; i < 3; i++) await f.next(background);
    assert.equal(sends, 8);
    if (mode === "sent")
      assert(Math.abs((await charge(f.budget)) - 8 * quote) < 1e-12);
  });
}

test("R4-2 isolates poison, carries its hold across snapshots and restart, and retries without a new snapshot", async (t) => {
  const docs = documents(16);
  const poison = new TextDecoder().decode(
    [...docs].sort((a, b) => a.input_hash!.localeCompare(b.input_hash!))[0]
      .input!,
  );
  let fixed = false;
  const sends: { inputs: string[]; failed: boolean }[] = [];
  const f = await fixture(
    t,
    async (_url, init) => {
      const inputs = JSON.parse(String(init?.body)).input as string[];
      const failed = !fixed && inputs.includes(poison);
      sends.push({ inputs, failed });
      return failed
        ? new Response("Unknown", { status: 503 })
        : success(inputs.length);
    },
    16,
  );
  let background = f.host();
  for (let i = 0; i < 40; i++) {
    await background.cycle();
    if (
      (await f.store.coverage((await f.job()).id)).indexed === 15 &&
      (await f.job()).background_inputs?.next_attempt! > Date.now()
    )
      break;
    await f.next(background);
  }
  const first = await f.job();
  assert.deepEqual(
    await f.store.coverage(first.id),
    { eligible: 16, indexed: 15, failed: 1, pending: 0 },
    "Both the healthy batch and healthy inputs inside the poison batch must finish",
  );
  assert.equal(first.background_inputs?.count, 1);
  const deadline = first.background_inputs!.next_attempt;
  assert(deadline > Date.now());
  const before = sends.length;
  await background.close();
  await f.reopen();
  background = f.host();
  const more = documents(17);
  f.source.context.snapshot = hash(1002);
  f.source.context.eligible = 17;
  f.source.page = async () => ({
    documents: more,
    next: more[16].event,
    done: true,
  });
  await background.cycle();
  const second = await f.job();
  assert.notEqual(second.id, first.id);
  assert.deepEqual(await f.store.coverage(second.id), {
    eligible: 17,
    indexed: 16,
    failed: 1,
    pending: 0,
  });
  assert.equal((await f.store.coverageFor(second.id, more)).all.failed, 1);
  assert.equal(second.background_inputs?.next_attempt, deadline);
  assert.equal(
    sends.length,
    before + 1,
    "Only the new input can dispatch before the parked deadline",
  );
  const revision = await f.store.coverageRevision(second.id);
  Object.assign(f.options, { needed: async () => false });
  fixed = true;
  f.advance(deadline - Date.now() - 1);
  await background.cycle();
  assert.equal(sends.length, before + 1);
  f.advance(1);
  await background.cycle();
  assert.equal(sends.length, before + 2);
  assert.deepEqual(sends.at(-1)?.inputs, [poison]);
  assert.deepEqual(await f.store.coverage(second.id), {
    eligible: 17,
    indexed: 17,
    failed: 0,
    pending: 0,
  });
  assert.notEqual(await f.store.coverageRevision(second.id), revision);
  assert.equal((await f.job()).background_inputs, undefined);
  const retry = (await f.store.batches(second.id)).find(
    (b) => b.inputs.length === 1 && b.previous,
  )!;
  assert(
    retry?.previous,
    "The later generation must retain its prior batch link",
  );
  assert(
    (await f.store.batches(first.id)).some((b) => b.id === retry.previous),
  );
  const expected = sends.reduce(
    (sum, s) => sum + (s.failed ? s.inputs.length * quote : cost),
    0,
  );
  assert(
    Math.abs((await charge(f.budget)) - expected) < 1e-12,
    "Every failed dispatch keeps its conservative charge",
  );
});

test("R4-3 oversized requests split before a paid send", async (t) => {
  const sizes: number[] = [];
  const f = await fixture(
    t,
    async (_url, init) => {
      const inputs = JSON.parse(String(init?.body)).input;
      sizes.push(inputs.length);
      return success(inputs.length);
    },
    8,
    { maxCostUsd: quote * 1.1 },
  );
  const background = f.host();
  await background.cycle();
  for (
    let i = 0;
    i < 10 && (await f.store.coverage((await f.job()).id)).indexed < 8;
    i++
  )
    await f.next(background);
  assert.equal(
    (await f.store.coverage((await f.job()).id)).indexed,
    8,
    "A request that exceeds an empty limit must split into admissible inputs",
  );
  assert.deepEqual(sizes, Array(8).fill(1));
  assert(Math.abs((await charge(f.budget)) - 8 * cost) < 1e-12);
});

for (const reason of [
  "billing_request_too_large",
  "semantic_capacity",
  "snapshot_expired",
]) {
  test(`R4-3 ${reason} waits one hour and logs only a state change across restart`, async (t) => {
    let attempts = 0;
    const f = await fixture(t, async () => success());
    if (reason === "billing_request_too_large") f.config.maxCostUsd = quote / 2;
    else if (reason === "semantic_capacity")
      t.mock.method(f.store, "claim", async () => {
        attempts++;
        await f.store.pause((await f.job()).id, reason);
        return null;
      });
    else
      f.source.page = async () => {
        attempts++;
        throw new AssistanceError(410, reason, "Expired synthetic source");
      };
    let background = f.host();
    await background.cycle();
    assert.equal(
      (await f.job()).background_recovery?.next_attempt,
      Date.now() + 3600000,
      "Permanent refusals must not retry each minute",
    );
    const reports = f.reports.length;
    for (let hour = 0; hour < 3; hour++) {
      await background.close();
      background = f.host();
      f.advance(3599999);
      await background.cycle();
      f.advance(1);
      await background.cycle();
    }
    assert.equal(
      f.reports.length,
      reports,
      "An unchanged permanent refusal must not add hourly or restart log lines",
    );
    if (reason !== "billing_request_too_large") assert.equal(attempts, 4);
    assert.equal(await charge(f.budget), 0);
  });
}

test("R4-2 split children wait for their parent's timed-out transport across a newer snapshot", async (t) => {
  const gate = deferred();
  t.after(() => gate.resolve());
  let calls = 0;
  let held = false;
  const f = await fixture(
    t,
    async (_url, init) => {
      const inputs = JSON.parse(String(init?.body)).input;
      calls++;
      if (calls === 4) {
        held = true;
        await gate.promise;
        return new Response("Unknown", { status: 503 });
      }
      return calls < 4
        ? new Response("Unknown", { status: 503 })
        : success(inputs.length);
    },
    8,
    { timeoutMs: 100, concurrency: 2 },
  );
  const background = f.host();
  await background.cycle();
  for (let i = 0; i < 3; i++) await f.next(background);
  assert(held);
  assert.equal(calls, 4);
  assert.equal(
    (await f.job()).background_inputs?.count,
    8,
    "The exhausted batch must split into held children",
  );
  const first = await f.job();
  const parent = (await f.store.batches(first.id)).find(
    (b) => b.operation === first.background_recovery?.operation,
  )!;
  assert(f.assistance.embeddingOperationPending(parent.operation!));
  const more = documents(9);
  f.source.context.snapshot = hash(1003);
  f.source.context.eligible = 9;
  f.source.page = async () => ({
    documents: more,
    next: more[8].event,
    done: true,
  });
  await background.cycle();
  assert.equal(
    calls,
    5,
    "Only the new input can use the free slot while the old transport remains active",
  );
  await background.cycle();
  assert.equal(calls, 5);
  gate.resolve();
  await f.assistance.drainEmbeddingTransports();
  await background.cycle();
  assert.equal(calls, 13);
  const current = await f.job();
  assert.equal((await f.store.coverage(current.id)).indexed, 9);
  assert.equal(
    (await f.store.batches(current.id)).filter((b) => b.previous === parent.id)
      .length,
    8,
  );
  assert(Math.abs((await charge(f.budget)) - (32 * quote + 9 * cost)) < 1e-12);
});

test("R4-2 a fresh failing batch starts its own send count after an exhausted batch splits", async (t) => {
  let sends = 0;
  const f = await fixture(
    t,
    async () => {
      sends++;
      return new Response("Unknown", { status: 503 });
    },
    16,
  );
  const background = f.host();
  await background.cycle();
  for (let i = 0; i < 3; i++) await f.next(background);
  assert.equal((await f.job()).background_inputs?.count, 8);
  await f.next(background);
  assert.equal(sends, 5);
  assert.equal(
    (await f.job()).background_recovery?.sent_attempts,
    1,
    "A fresh batch cannot inherit the preceding batch's exhausted count",
  );
  assert.equal((await f.job()).background_recovery?.exhausted, false);
});

test("R4-2 a parked input removed by the latest snapshot never retries", async (t) => {
  let sends = 0;
  const f = await fixture(t, async () =>
    ++sends <= 4 ? new Response("Unknown", { status: 503 }) : success(),
  );
  let background = f.host();
  await background.cycle();
  for (let i = 0; i < 3; i++) await f.next(background);
  assert.equal((await f.job()).background_inputs?.count, 1);
  const replacement = documents(2)[1];
  f.source.context.snapshot = hash(1004);
  f.source.page = async () => ({
    documents: [replacement],
    next: replacement.event,
    done: true,
  });
  await background.cycle();
  assert.equal(sends, 5);
  await background.close();
  await f.reopen();
  background = f.host();
  Object.assign(f.options, { needed: async () => false });
  f.advance(3600000);
  await background.cycle();
  assert.equal(sends, 5);
  assert.equal((await f.job()).background_inputs, undefined);
});

test("R4-3 an expired unpublished source moves to a fresh snapshot without a one-hour delay", async (t) => {
  let sends = 0;
  const f = await fixture(t, async () => {
    sends++;
    return success();
  });
  f.source.page = async () => {
    throw new AssistanceError(
      410,
      "snapshot_expired",
      "Expired synthetic source",
    );
  };
  const background = f.host();
  await background.cycle();
  assert.equal(
    (await f.job()).background_recovery?.next_attempt,
    Date.now() + 3600000,
  );
  const old = await f.job();
  const fresh = {
    context: { ...f.source.context, snapshot: hash(1005) },
    page: async () => ({
      documents: f.docs,
      next: f.docs[0].event,
      done: true,
    }),
  };
  f.options.source = async (_profile?: unknown, snapshot?: string) => {
    if (snapshot === old.snapshot)
      throw new AssistanceError(
        410,
        "snapshot_expired",
        "Expired synthetic source",
      );
    return fresh;
  };
  f.advance(3600000);
  await background.cycle();
  assert.notEqual((await f.job()).id, old.id);
  await background.cycle();
  assert.equal(sends, 1);
  assert.equal((await f.job()).state, "completed");
  assert.equal((await f.store.generation(old.id)).state, "retired");
});

test("R4-3 full storage before job creation keeps its cooldown and log state", async (t) => {
  let attempts = 0;
  const f = await fixture(t, async () => success());
  t.mock.method(f.store, "create", async () => {
    attempts++;
    throw new AssistanceError(409, "semantic_capacity", "Full synthetic store");
  });
  let background = f.host();
  await background.cycle().catch(() => {});
  assert.equal(attempts, 1);
  for (let i = 0; i < 10; i++) {
    f.advance(1000);
    await background.cycle().catch(() => {});
  }
  assert.equal(
    attempts,
    1,
    "A full store must not retry job creation on every host tick",
  );
  await background.close();
  background = f.host();
  await background.cycle();
  assert.equal(attempts, 1);
  f.advance(3590000);
  await background.cycle();
  assert.equal(attempts, 2);
  assert.equal(f.reports.length, 1);
  assert.equal(await charge(f.budget), 0);
});

test("R7 restart preserves an exhausted probe round and an unrelated input hold", async (t) => {
  const poison = new TextDecoder().decode(documents(2)[1].input!);
  let probeSends = 0;
  let brokenProbe = false;
  const f = await fixture(
    t,
    async (_url, init) => {
      const inputs = JSON.parse(String(init?.body)).input as string[];
      if (inputs.includes("Probe")) {
        probeSends++;
        return brokenProbe
          ? new Response("Unknown", { status: 503 })
          : success(inputs.length);
      }
      return inputs.includes(poison)
        ? new Response("Unknown", { status: 503 })
        : success(inputs.length);
    },
    2,
  );
  await seedReference(f);
  let background = f.host();
  await background.cycle();
  for (let i = 0; i < 3; i++) await f.next(background);
  assert.equal((await f.job()).background_inputs?.count, 1);
  const deadline = (await f.job()).background_inputs!.next_attempt;
  const more = documents(3);
  f.source.context.snapshot = hash(1006);
  f.source.context.eligible = 3;
  f.source.page = async () => ({
    documents: more,
    next: more[2].event,
    done: true,
  });
  f.options.probe = async () => {
    await f.assistance.embed([utf8("Probe")], { kind: "probe" });
  };
  brokenProbe = true;
  await background.cycle();
  for (let i = 0; i < 3; i++) await f.next(background);
  assert.equal(probeSends, 4);
  assert.equal((await f.job()).background_recovery?.exhausted, true);
  await background.close();
  background = f.host();
  await background.cycle();
  assert.equal(probeSends, 4, "A restart must preserve the probe cooldown");
  assert.equal((await f.job()).background_inputs?.next_attempt, deadline);
  assert.equal((await f.job()).background_recovery?.sent_attempts, 4);
});

test("R4-2 status finds one hold through indexed lookups among 59001 associations", async (t) => {
  const f = await fixture(
    t,
    async () => new Response("Unknown", { status: 503 }),
  );
  const background = f.host();
  await background.cycle();
  for (let i = 0; i < 3; i++) await f.next(background);
  const generation = await f.job();
  assert.equal(generation.background_inputs?.count, 1);
  const internal = f.store as unknown as {
    database: import("node:sqlite").DatabaseSync;
    sql: {
      exec(
        sql: string,
        ...bindings: (string | number | Uint8Array | null)[]
      ): Record<string, unknown>[];
    };
  };
  const db = internal.database;
  db.prepare(
    `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<59000)
    INSERT INTO semantic_associations SELECT generation, 'synthetic:' || printf('%064d',x), envelope,body,extraction_version,word,language,input,error
    FROM semantic_associations,n WHERE generation=?`,
  ).run(generation.id);
  db.prepare(
    "UPDATE semantic_usage SET associations=associations+59000 WHERE id=1",
  ).run();
  const exec = internal.sql.exec.bind(internal.sql);
  let plan: string[] = [];
  t.mock.method(
    internal.sql,
    "exec",
    (sql: string, ...bindings: (string | number | Uint8Array | null)[]) => {
      if (sql.includes("AS held") && sql.includes("ORDER BY h.input LIMIT 128"))
        plan = db
          .prepare("EXPLAIN QUERY PLAN " + sql)
          .all(...bindings)
          .map((row) => String(row.detail));
      return exec(sql, ...bindings);
    },
  );
  assert.equal(
    (await f.store.generation(generation.id, true)).background_inputs?.count,
    1,
  );
  assert(
    plan.some((line) => /SEARCH h.*\(profile=\? AND input>\?\)/.test(line)),
    JSON.stringify(plan),
  );
  assert(
    plan.some((line) =>
      /SEARCH a.*\((?:generation=\? AND input=\?|input=\? AND generation=\?)\)/.test(
        line,
      ),
    ),
    JSON.stringify(plan),
  );
  assert(
    !plan.some((line) => /SCAN a\b/.test(line)),
    "Status must not scan every association to count one input hold",
  );
  console.log(
    JSON.stringify({ associations: 59001, holds: 1, statusQueryPlan: plan }),
  );
});

test("R4-3 invalid embedding configuration waits one hour without charges or repeated logs", async (t) => {
  let sends = 0;
  const f = await fixture(t, async () => {
    sends++;
    return success();
  });
  f.config.embedding = undefined;
  const background = f.host();
  await background.cycle();
  assert.equal(
    (await f.job()).background_recovery?.reason,
    "embedding_configuration",
  );
  assert.equal(
    (await f.job()).background_recovery?.next_attempt,
    Date.now() + 3600000,
  );
  for (let i = 0; i < 3; i++) {
    f.advance(3600000);
    await background.cycle();
  }
  assert.equal(sends, 0);
  assert.equal(await charge(f.budget), 0);
  assert.equal(f.reports.length, 1);
});

test("R4-2 each claim loads at most 128 due holds through the deadline index", async (t) => {
  const f = await fixture(
    t,
    async () => new Response("Unknown", { status: 503 }),
  );
  const background = f.host();
  await background.cycle();
  for (let i = 0; i < 3; i++) await f.next(background);
  const generation = await f.job();
  assert.equal(generation.background_inputs?.count, 1);
  const internal = f.store as unknown as {
    database: import("node:sqlite").DatabaseSync;
    sql: {
      exec(
        sql: string,
        ...bindings: (string | number | Uint8Array | null)[]
      ): Record<string, unknown>[];
    };
  };
  const db = internal.database;
  db.prepare(
    `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<256)
    INSERT INTO semantic_background_inputs SELECT profile,'synthetic:' || printf('%064d',x),previous,value FROM semantic_background_inputs,n`,
  ).run();
  db.prepare(
    `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<256)
    INSERT INTO semantic_associations SELECT generation,'synthetic:' || printf('%064d',x),envelope,body,extraction_version,word,language,'synthetic:' || printf('%064d',x),error
    FROM semantic_associations,n WHERE generation=?`,
  ).run(generation.id);
  db.prepare(
    "UPDATE semantic_usage SET associations=associations+256 WHERE id=1",
  ).run();
  const exec = internal.sql.exec.bind(internal.sql);
  let rows = 0;
  let plan: string[] = [];
  t.mock.method(
    internal.sql,
    "exec",
    (sql: string, ...bindings: (string | number | Uint8Array | null)[]) => {
      const result = exec(sql, ...bindings);
      if (sql.includes("SELECT h.input,h.previous,b.operation")) {
        rows = result.length;
        plan = db
          .prepare("EXPLAIN QUERY PLAN " + sql)
          .all(...bindings)
          .map((row) => String(row.detail));
      }
      return result;
    },
  );
  f.advance(3600000);
  await f.store.resumeBackground(generation.id);
  await f.store.start(generation.id);
  assert(
    await f.store.claim(generation.id, {
      now: Date.now(),
      pending: () => false,
    }),
  );
  assert.equal(rows, 128);
  assert(
    plan.some((line) =>
      /SEARCH h USING INDEX semantic_background_input_deadline/.test(line),
    ),
    JSON.stringify(plan),
  );
  console.log(
    JSON.stringify({ dueHolds: 257, loadedRows: rows, claimQueryPlan: plan }),
  );
});

test("R4-2 a marked retry excludes an input parked by another view", async (t) => {
  let fixed = false;
  const sends: string[][] = [];
  const f = await fixture(
    t,
    async (_url, init) => {
      const inputs = JSON.parse(String(init?.body)).input as string[];
      sends.push(inputs);
      return fixed
        ? success(inputs.length)
        : new Response("Unknown", { status: 503 });
    },
    2,
  );
  let background = f.host();
  await background.cycle();
  const old = await f.job();
  await background.close();
  const originalSource = { ...f.source, context: { ...f.source.context } };
  const otherView = hash(1300, "jve1:");
  const initial = await f.store.create(
    { ...f.source.context, view: otherView, snapshot: hash(1301), eligible: 0 },
    f.profile,
  );
  await f.store.stage(initial.id, null, {
    documents: [],
    next: null,
    done: true,
  });
  await f.store.start(initial.id);
  await f.store.finish(initial.id);
  await f.store.publish(initial.id, null);
  const isolated = f.docs[0];
  const otherSource = {
    context: {
      ...f.source.context,
      view: otherView,
      snapshot: hash(1302),
      eligible: 1,
    },
    page: async () => ({
      documents: [isolated],
      next: isolated.event,
      done: true,
    }),
  };
  f.options.view = otherView;
  f.options.source = async () => otherSource;
  background = f.host();
  await background.cycle();
  const otherJob = () => f.store.backgroundGeneration(old.profile, otherView);
  for (let i = 0; i < 3; i++) {
    f.advance(
      (await otherJob())!.background_recovery!.next_attempt - Date.now(),
    );
    await background.cycle();
  }
  assert.equal(
    (await otherJob())?.background_inputs?.count,
    1,
    "The second view must park its failed singleton",
  );
  const deadline = (await otherJob())!.background_inputs!.next_attempt;
  await background.close();
  f.options.view = old.view;
  f.options.source = async () => originalSource;
  fixed = true;
  background = f.host();
  await background.cycle();
  assert.deepEqual(
    sends.at(-1),
    [new TextDecoder().decode(f.docs[1].input!)],
    "The old marked batch must send only its unheld input",
  );
  assert.equal(
    (await f.store.generation(old.id, true)).background_inputs?.next_attempt,
    deadline,
  );
  assert.deepEqual(await f.store.coverage(old.id), {
    eligible: 2,
    indexed: 1,
    failed: 1,
    pending: 0,
  });
});

test("R4-3 capacity refusal during expired-source replacement waits and then recovers", async (t) => {
  let sends = 0;
  let attempts = 0;
  let full = true;
  const f = await fixture(t, async () => {
    sends++;
    return success();
  });
  f.source.page = async () => {
    throw new AssistanceError(
      410,
      "snapshot_expired",
      "Expired synthetic source",
    );
  };
  let background = f.host();
  await background.cycle();
  const old = await f.job();
  const fresh = {
    context: { ...f.source.context, snapshot: hash(1400) },
    page: async () => ({
      documents: f.docs,
      next: f.docs[0].event,
      done: true,
    }),
  };
  f.options.source = async (_profile?: unknown, snapshot?: string) => {
    if (snapshot === old.snapshot)
      throw new AssistanceError(
        410,
        "snapshot_expired",
        "Expired synthetic source",
      );
    return fresh;
  };
  const create = f.store.create.bind(f.store);
  t.mock.method(
    f.store,
    "create",
    async (
      context: Parameters<typeof create>[0],
      profile: Parameters<typeof create>[1],
    ) => {
      if (context.snapshot === fresh.context.snapshot) {
        attempts++;
        if (full)
          throw new AssistanceError(
            409,
            "semantic_capacity",
            "Full synthetic replacement store",
          );
      }
      return create(context, profile);
    },
  );
  f.advance(3600000);
  await background.cycle().catch(() => {});
  assert.equal(
    (await f.job()).background_recovery?.reason,
    "semantic_capacity",
    "Replacement capacity must replace the expired-source refusal as the recovery reason",
  );
  assert.equal(
    (await f.job()).background_recovery?.next_attempt,
    Date.now() + 3600000,
  );
  assert.equal(f.reports.length, 2);
  assert.equal(attempts, 1);
  await background.close();
  background = f.host();
  for (let i = 0; i < 12; i++) {
    f.advance(5000);
    await background.cycle();
  }
  assert.equal(attempts, 1);
  assert.equal(f.reports.length, 2);
  f.advance(3540000);
  await background.cycle();
  assert.equal(attempts, 2);
  assert.equal(f.reports.length, 2);
  full = false;
  f.advance(3600000);
  await background.cycle();
  assert.equal(attempts, 3);
  assert.notEqual((await f.job()).id, old.id);
  await background.cycle();
  assert.equal(sends, 1);
  assert.equal((await f.job()).state, "completed");
  assert.equal((await f.store.generation(old.id)).state, "retired");
});

test("R7 basic generation and public profile reads do no hold scans with 59125 parked inputs", async (t) => {
  const f = await fixture(t, async () => success());
  await f.host().cycle();
  const job = await f.job();
  const internal = f.store as unknown as {
    database: import("node:sqlite").DatabaseSync;
    sql: {
      exec(
        sql: string,
        ...bindings: (string | number | Uint8Array | null)[]
      ): Record<string, unknown>[];
    };
  };
  const db = internal.database;
  const deadline = Date.now() + 3600000;
  db.prepare(
    `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<59125)
    INSERT INTO semantic_background_inputs SELECT ?, 'synthetic:' || printf('%064d',x),'previous',? FROM n`,
  ).run(job.profile, JSON.stringify({ next_attempt: deadline }));
  db.prepare(
    `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<59125)
    INSERT INTO semantic_associations SELECT generation,'synthetic:' || printf('%064d',x),envelope,body,extraction_version,word,language,'synthetic:' || printf('%064d',x),NULL
    FROM semantic_associations,n WHERE generation=?`,
  ).run(job.id);
  const exec = internal.sql.exec.bind(internal.sql);
  const holdReads: { sql: string; rows: number }[] = [];
  t.mock.method(
    internal.sql,
    "exec",
    (sql: string, ...bindings: (string | number | Uint8Array | null)[]) => {
      const rows = exec(sql, ...bindings);
      if (/FROM semantic_background_inputs/.test(sql))
        holdReads.push({ sql, rows: rows.length });
      return rows;
    },
  );
  const context = {
    snapshot: { snapshot: job.snapshot, events: {} },
    evaluation: {
      available: true,
      selected_view: job.view,
      publications: {},
      receipts: {},
    },
    retained: async () => true,
  } as unknown as SearchContext;
  const search = new SemanticSearch(
    {
      profile: job.profile,
      store: f.store,
      cache: f.store.queryCache,
      scanner: { scan: async () => [] },
    },
    {
      embed: async () => {
        throw new Error("No inference is allowed.");
      },
    },
    true,
  );
  await search.profiles(context);
  for (let i = 0; i < 3; i++) {
    await f.store.generation(job.id);
    await search.profiles(context);
  }
  assert.equal(
    holdReads.length,
    0,
    "R7 ordinary generation and cached profile reads must not scan holds",
  );
  let callbackRan = false;
  setImmediate(() => {
    callbackRan = true;
  });
  const diagnostic = await f.store.generation(job.id, true);
  assert.equal(diagnostic.background_inputs?.count, 59125);
  assert.equal(diagnostic.background_inputs?.next_attempt, deadline);
  assert(
    callbackRan,
    "R7 diagnostics must let an already queued callback run between pages",
  );
  assert(holdReads.length > 1);
  assert(
    holdReads.every(
      (read) => read.rows <= 128 && read.sql.includes("LIMIT 128"),
    ),
  );
  console.log(
    JSON.stringify({
      holds: 59125,
      diagnosticPages: holdReads.length,
      maximumRows: Math.max(...holdReads.map((read) => read.rows)),
    }),
  );
});

test("R7 a due hold waits for its old transport without source, resume, probe, or finish work", async (t) => {
  const f = await fixture(
    t,
    async () => new Response("Unknown", { status: 503 }),
  );
  let pending = true;
  t.mock.method(f.assistance, "embeddingOperationPending", () => pending);
  Object.assign(f.options, { needed: async () => false });
  // The first snapshot needs work. Later cycles have no new snapshot.
  const needed = t.mock.method(
    f.options as typeof f.options & { needed(): Promise<boolean> },
    "needed",
    async () => true,
  );
  const background = f.host();
  await background.cycle();
  // Let retries reach a completed pass with one held input, then make that input due.
  pending = false;
  for (let i = 0; i < 3; i++) await f.next(background);
  const job = await f.job();
  await f.store.resumeBackground(job.id);
  await f.store.start(job.id);
  await f.store.finish(job.id);
  f.advance(job.background_inputs!.next_attempt - Date.now());
  pending = true;
  needed.mock.mockImplementation(async () => false);
  const source = t.mock.method(f.options, "source");
  const resume = t.mock.method(f.store, "resumeBackground");
  const probe = t.mock.method(f.options, "probe");
  const finish = t.mock.method(f.store, "finish");
  for (let i = 0; i < 6; i++) {
    await background.cycle();
    f.advance(5000);
  }
  assert.equal(
    source.mock.callCount(),
    0,
    "R7 a pending transport must not rebuild the source each cycle",
  );
  assert.equal(resume.mock.callCount(), 0);
  assert.equal(probe.mock.callCount(), 0);
  assert.equal(finish.mock.callCount(), 0);
  pending = false;
  await background.cycle();
  assert.equal(
    resume.mock.callCount(),
    1,
    "Settlement must wake the due hold on the next cycle",
  );
});

test("R7 probe attempts and their cooldown survive repeated database and host restarts", async (t) => {
  let sends = 0;
  const f = await fixture(
    t,
    async () => {
      sends++;
      return new Response("Unknown", { status: 503 });
    },
    2,
  );
  await seedReference(f);
  f.options.probe = async () => {
    await f.assistance.embed([utf8("Probe")], { kind: "probe" });
  };
  let background = f.host();
  for (let attempt = 1; attempt <= 4; attempt++) {
    await background.cycle();
    const recovery = (await f.job()).background_recovery!;
    assert.equal(recovery.sent_attempts, attempt);
    const deadline = recovery.next_attempt;
    for (let restart = 0; restart < 2; restart++) {
      await background.close();
      await f.reopen();
      background = f.host();
      await background.cycle();
      const retained = (await f.job()).background_recovery!;
      assert.equal(
        sends,
        attempt,
        "R7 restarting during a saved delay must not pay for another probe",
      );
      assert.equal(retained.sent_attempts, attempt);
      assert.equal(retained.next_attempt, deadline);
    }
    f.advance(deadline - Date.now());
  }
  await background.cycle();
  assert.equal(
    sends,
    5,
    "The expired cooldown permits the next bounded recovery round",
  );
  assert.equal((await f.job()).background_recovery?.sent_attempts, 1);
  assert(Math.abs((await charge(f.budget)) - 5 * quote) < 1e-12);
});

test("R7 retirement keeps reader and old-host transport guards until exact background work is idle", async (t) => {
  const f = await fixture(
    t,
    async () => new Response("Unknown", { status: 503 }),
  );
  let pending = false;
  t.mock.method(f.assistance, "embeddingOperationPending", () => pending);
  const background = f.host();
  await background.cycle();
  for (let i = 0; i < 3; i++) await f.next(background);
  const job = await f.job();
  await f.store.resumeBackground(job.id);
  await f.store.start(job.id);
  await f.store.finish(job.id);
  await f.store.unpublish(job.profile, job.view, job.id);
  const release = await f.store.retainGeneration(job.id);
  await assert.rejects(f.store.retire(job.id), /active search/);
  release();
  const replacement = await f.store.create(
    { ...f.source.context, snapshot: hash(1900) },
    f.profile,
  );
  await f.store.stage(replacement.id, null, {
    documents: f.docs,
    next: f.docs[0].event,
    done: true,
  });
  await f.store.setBackgroundGeneration(replacement.id);
  await f.store.start(replacement.id);
  await f.store.finish(replacement.id);
  assert.equal((await f.store.batches(replacement.id)).length, 0);
  pending = true;
  await background.close();
  // A second host uses a separate callback. It cannot erase the old host's pending transport.
  const other = new BackgroundSemanticIndexer({
    ...f.options,
    assistance: {
      embed: f.assistance.embed.bind(f.assistance),
      embeddingOperationPending: () => false,
    },
  });
  await assert.rejects(f.store.retire(job.id), /active provider transport/);
  await assert.rejects(
    f.store.retire(replacement.id),
    /active provider transport/,
  );
  assert.equal(
    (await f.store.backgroundGeneration(job.profile, job.view))?.id,
    replacement.id,
  );
  pending = false;
  await f.store.retire(replacement.id);
  await f.store.retire(job.id);
  assert.equal(await f.store.backgroundGeneration(job.profile, job.view), null);
  await assert.rejects(f.store.setBackgroundGeneration(job.id), /retired/);
  await assert.rejects(f.store.resumeBackground(job.id), /retired/);
  await other.cycle();
  await other.close();
  assert.equal((await f.store.generation(job.id)).state, "retired");
});

test("R7 completed schedules skip the fresh association search", async (t) => {
  const f = await fixture(t, async () => success());
  await f.host().cycle();
  const job = await f.job();
  assert.equal(job.state, "completed");
  const internal = f.store as unknown as {
    sql: {
      exec(
        sql: string,
        ...bindings: (string | number | Uint8Array | null)[]
      ): Record<string, unknown>[];
    };
  };
  const exec = internal.sql.exec.bind(internal.sql);
  let freshQueries = 0;
  t.mock.method(
    internal.sql,
    "exec",
    (sql: string, ...bindings: (string | number | Uint8Array | null)[]) => {
      if (
        sql.includes(
          "LEFT JOIN semantic_batch_inputs b ON b.generation=a.generation",
        )
      )
        freshQueries++;
      return exec(sql, ...bindings);
    },
  );
  for (let i = 0; i < 10; i++)
    assert.equal(
      await f.store.backgroundSchedule(job.id, Date.now(), () => false),
      null,
    );
  assert.equal(
    freshQueries,
    0,
    "R7 an idle completed pass must not scan fresh associations every cycle",
  );
});
