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
  t.after(() => gate.resolve());
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

test("R4-1 restart opens a probe round without shortening an unrelated input hold", async (t) => {
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
  assert.equal(
    probeSends,
    5,
    "A parked input must not suppress a fresh probe round on restart",
  );
  assert.equal((await f.job()).background_inputs?.next_attempt, deadline);
  assert.equal((await f.job()).background_recovery?.sent_attempts, 1);
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
      if (sql.includes("MIN(json_extract(h.value"))
        plan = db
          .prepare("EXPLAIN QUERY PLAN " + sql)
          .all(...bindings)
          .map((row) => String(row.detail));
      return exec(sql, ...bindings);
    },
  );
  assert.equal(
    (await f.store.generation(generation.id)).background_inputs?.count,
    1,
  );
  assert(
    plan.some((line) => /SEARCH h.*\(profile=\?\)/.test(line)),
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
