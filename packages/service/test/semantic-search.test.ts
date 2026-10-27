import assert from "node:assert/strict";
import { before, test } from "node:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { initializeCore, utf8, type Evaluation } from "../../core/src/index.ts";
import { SqliteVectorStore } from "../../../apps/server/src/semantic.ts";
import { NodeVectorScanner } from "../../../apps/server/src/semantic-scanner.ts";
import { SqlQueryCache } from "../src/semantic/query-cache.ts";
import { SemanticSearch, type SearchContext } from "../src/semantic/search.ts";
import {
  createQwenProfile,
  inputHash,
  profileId,
} from "../src/semantic/profile.ts";
import { vectorBytes } from "../src/semantic/vector.ts";
import { scanPages, type VectorScanner } from "../src/semantic/scan.ts";
import { AssistanceService } from "../src/assistance.ts";
import { providerConfig } from "../src/inference.ts";
import type { IndexDocument } from "../src/semantic/source.ts";
import type { Snapshot } from "../src/storage.ts";

before(async () =>
  initializeCore(
    await readFile(
      new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  ),
);
const hash = (n: number, prefix = "sha256:") =>
  prefix + n.toString(16).padStart(64, "0");
const profile = createQwenProfile("31".repeat(16));
const unit = (axis = 0) =>
  Float32Array.from({ length: 4096 }, (_, i) => (i === axis ? 1 : 0));
const usage = { inputTokens: 1, totalTokens: 1, costUsd: 0.00000001 };
function rows(count = 4): IndexDocument[] {
  return Array.from({ length: count }, (_, i) => {
    const input = utf8(`Public definition ${i}`);
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
function context(
  documents: IndexDocument[],
  snapshot = hash(1000),
  view = hash(1100, "jve1:"),
): SearchContext {
  const publications = Object.fromEntries(
    documents.map((r) => [
      r.event,
      {
        id: r.event,
        kind: "definition.publish",
        eligible: "eligible",
        status: "active",
        content_available: true,
        word: r.word,
        language: r.language,
      },
    ]),
  );
  const receipts = Object.fromEntries(
    documents.map((r) => [
      r.event,
      { interpretation: "effective", body: "valid", reasons: [] },
    ]),
  );
  return {
    snapshot: {
      snapshot,
      events: Object.fromEntries(
        documents.map((r) => [
          r.event,
          { envelope_hash: r.envelope, body_hash: r.body },
        ]),
      ),
    } as Snapshot,
    evaluation: {
      available: true,
      selected_view: view,
      publications,
      receipts,
    } as unknown as Evaluation,
    retained: async () => true,
  };
}
async function publish(
  store: SqliteVectorStore,
  documents: IndexDocument[],
  ctx: SearchContext,
) {
  const old = await store.current(
    profileId(profile),
    ctx.evaluation.selected_view,
  );
  const generation = await store.create(
    {
      snapshot: ctx.snapshot.snapshot,
      view: ctx.evaluation.selected_view,
      profile: profileId(profile),
      eligible: documents.length,
    },
    profile,
  );
  for (let i = 0; i < documents.length; i += 128) {
    const selected = documents.slice(i, i + 128);
    await store.stage(generation.id, i ? documents[i - 1].event : null, {
      documents: selected,
      next: selected.at(-1)!.event,
      done: i + 128 >= documents.length,
    });
  }
  await store.start(generation.id);
  for (;;) {
    const batch = await store.claim(generation.id);
    if (!batch) break;
    const operation = `embedding:index:${batch.id}`;
    await store.sent(batch.id, operation);
    await store.complete(
      batch.id,
      operation,
      batch.inputs.map(() => unit()),
      usage,
    );
  }
  await store.finish(generation.id);
  await store.publish(generation.id, old);
  return await store.generation(generation.id);
}
async function fixture(
  run: (f: {
    store: SqliteVectorStore;
    path: string;
    scanner: NodeVectorScanner;
    docs: IndexDocument[];
    ctx: SearchContext;
  }) => Promise<void>,
) {
  const base = process.env.JVC_TEST_ROOT ?? tmpdir();
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "semantic-search-"));
  const path = join(directory, "vectors.sqlite");
  const store = new SqliteVectorStore(path);
  const scanner = new NodeVectorScanner(path);
  const docs = rows();
  const ctx = context(docs);
  try {
    await publish(store, docs, ctx);
    await run({ store, path, scanner, docs, ctx });
  } finally {
    await scanner.close();
    store.close();
    await rm(directory, { recursive: true });
  }
}
function mock() {
  const calls: string[] = [];
  let queryGate: Promise<void> = Promise.resolve();
  let drift = false;
  let sample: Float32Array | undefined;
  const config = providerConfig(
    { JVC_AI_ENABLED: "enabled" },
    async () => "disposable-test-key",
  )!;
  config.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const query = body.input[0].startsWith("Instruct:");
    calls.push(query ? "query" : "probe");
    if (query) await queryGate;
    return Response.json({
      model: "Qwen/Qwen3-Embedding-8B",
      data: body.input.map((_: unknown, index: number) => ({
        index,
        embedding: Array.from(sample ?? unit(drift ? 1 : 0)),
      })),
      usage: { prompt_tokens: 1, total_tokens: 1, cost: 0.00000001 },
    });
  };
  const assistance = new AssistanceService(
    { provider: config },
    "test",
    async () => [],
  );
  return {
    calls,
    config,
    assistance,
    setGate: (gate: Promise<void>) => {
      queryGate = gate;
    },
    sample: (vector: Float32Array) => {
      sample = vector;
    },
    drift: () => {
      drift = true;
    },
  };
}
const request = (query = "a meaning") => ({
  query,
  profile: profileId(profile),
  language: "en",
  limit: 3,
});

for (const mode of ["node", "paged backend"] as const)
  test(`${mode} shares misses, reuses persistent cache without payment, and applies current views`, async () =>
    fixture(async ({ store, scanner, path, docs, ctx }) => {
      const provider = mock();
      const backend: VectorScanner =
        mode === "node"
          ? scanner
          : {
              scan: (r, signal) =>
                scanPages(
                  r,
                  (after) => store.page(r.generation, after, 128, r.language),
                  () => signal?.aborted ?? false,
                ),
            };
      const engine = new SemanticSearch(
        {
          profile: profileId(profile),
          store,
          cache: store.queryCache,
          scanner: backend,
        },
        provider.assistance,
        true,
      );
      const [first, second] = await Promise.all([
        engine.search(ctx, request(), "local"),
        engine.search(ctx, request(), "local"),
      ]);
      assert.deepEqual(first, second);
      assert.deepEqual(provider.calls, ["probe", "query"]);
      assert.deepEqual(
        first.hits.map((hit) => hit.event),
        docs.slice(0, 3).map((row) => row.event),
      );
      assert.deepEqual(
        first.hits.map((hit) => hit.position),
        [1, 2, 3],
      );
      const changed = context(docs.slice(1), hash(1001), hash(1101, "jve1:"));
      await publish(store, docs.slice(1), changed);
      const restartedStore = new SqliteVectorStore(path);
      try {
        const restarted = new SemanticSearch(
          {
            profile: profileId(profile),
            store: restartedStore,
            cache: restartedStore.queryCache,
            scanner: backend,
          },
          {
            embed: async () => {
              throw new Error("A cache hit must not reserve or dispatch.");
            },
          },
          true,
        );
        const result = await restarted.search(changed, request(), "local");
        assert.deepEqual(
          result.hits.map((hit) => hit.event),
          docs.slice(1).map((row) => row.event),
        );
        assert.deepEqual(provider.calls, ["probe", "query"]);
      } finally {
        restartedStore.close();
      }
    }));

test("cancellation detaches one caller, retains settlement, and does not replay a shared miss", async () =>
  fixture(async ({ store, scanner, ctx }) => {
    const provider = mock();
    let release!: () => void;
    provider.setGate(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const engine = new SemanticSearch(
      { profile: profileId(profile), store, cache: store.queryCache, scanner },
      provider.assistance,
      true,
    );
    const controller = new AbortController();
    const canceled = engine.search(ctx, request(), "local", controller.signal);
    const observed = assert.rejects(canceled);
    while (!provider.calls.includes("query"))
      await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort();
    await observed;
    const waiting = engine.search(ctx, request(), "local");
    release();
    await waiting;
    await engine.drain();
    assert.deepEqual(provider.calls, ["probe", "query"]);
    const operations = await provider.assistance.embeddingOperations();
    assert.equal(
      operations.filter((operation) => !operation.aggregated).length,
      2,
    );
    assert(operations.every((operation) => !operation.transportPending));
    await engine.search(ctx, request(), "local");
    assert.equal(provider.calls.length, 2);
  }));

test("suspension blocks cached vectors and same-name model drift suspends the profile", async () =>
  fixture(async ({ store, scanner, ctx }) => {
    const provider = mock();
    const options = {
      profile: profileId(profile),
      store,
      cache: store.queryCache,
      scanner,
    };
    const first = new SemanticSearch(options, provider.assistance, true);
    await first.search(ctx, request(), "local");
    provider.drift();
    const restarted = new SemanticSearch(options, provider.assistance, true);
    await assert.rejects(
      restarted.search(ctx, request("another query"), "local"),
      /vectors changed/,
    );
    assert.equal(
      await store.compatibility(profileId(profile)),
      "semantic_model_drift",
    );
    await assert.rejects(first.search(ctx, request(), "local"), /suspended/);
    assert.equal((await first.profiles(ctx))[0].query_available, false);
    assert.deepEqual(provider.calls, ["probe", "query", "probe"]);
  }));

test("expiry before or during inference never returns hits and does not refund or replay", async () =>
  fixture(async ({ store, scanner, ctx }) => {
    const provider = mock();
    const engine = new SemanticSearch(
      { profile: profileId(profile), store, cache: store.queryCache, scanner },
      provider.assistance,
      true,
    );
    ctx.retained = async () => false;
    await assert.rejects(
      engine.search(ctx, request(), "local"),
      /snapshot expired/,
    );
    assert.equal(provider.calls.length, 0);
    ctx.retained = async () => true;
    let release!: () => void;
    provider.setGate(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const running = engine.search(ctx, request(), "local");
    const observed = assert.rejects(running, /snapshot expired/);
    while (!provider.calls.includes("query"))
      await new Promise((resolve) => setTimeout(resolve, 1));
    ctx.retained = async () => false;
    release();
    await observed;
    ctx.retained = async () => true;
    await engine.search(ctx, request(), "local");
    assert.deepEqual(provider.calls, ["probe", "query"]);
  }));

test("coverage requires exact complete context and refuses unsupported input before payment", async () =>
  fixture(async ({ store, scanner, docs, ctx }) => {
    const provider = mock();
    const engine = new SemanticSearch(
      { profile: profileId(profile), store, cache: store.queryCache, scanner },
      provider.assistance,
      true,
    );
    const newer = context(docs, hash(9999));
    const advertised = await engine.profiles(newer);
    assert.equal(advertised[0].query_available, false);
    assert.equal(advertised[0].indexed, 0);
    assert.equal(advertised[0].pending, 4);
    await assert.rejects(
      engine.search(newer, request(), "local"),
      /complete compatible/,
    );
    await assert.rejects(
      engine.search(ctx, request("x".repeat(4096)), "local"),
      /4096 prefixed/,
    );
    await assert.rejects(
      engine.search(ctx, request("\ud800"), "local"),
      /valid text/,
    );
    const off = new SemanticSearch(
      { profile: profileId(profile), store, cache: store.queryCache, scanner },
      provider.assistance,
      false,
    );
    assert.equal((await off.profiles(ctx))[0].query_available, false);
    assert.equal(provider.calls.length, 0);
  }));

test("scan filtering precedes top-k and distinct-word grouping and permits lexical event-loop work", async () =>
  fixture(async ({ store, scanner, docs, ctx }) => {
    // The internal comparison policy removes hidden events before the top 30 distinct-word limit.
    const provider = mock();
    const engine = new SemanticSearch(
      { profile: profileId(profile), store, cache: store.queryCache, scanner },
      provider.assistance,
      true,
    );
    const result = await engine.search(
      ctx,
      { ...request(), limit: 1 },
      "local",
      undefined,
      { excludedEvents: new Set([docs[0].event]), distinctWords: true },
    );
    assert.equal(result.hits[0].event, docs[1].event);
    const generation = (await store.published(ctx.evaluation.selected_view))[0];
    const input = {
      generation: generation.id,
      snapshot: generation.snapshot,
      view: generation.view,
      profile: generation.profile,
      language: "en",
      vector: unit(),
      limit: 2,
      eligible: [docs[2].event, docs[3].event],
    };
    let eventLoopWorked = false;
    const scanning = scanner.scan(input);
    await new Promise<void>((resolve) =>
      setImmediate(() => {
        eventLoopWorked = true;
        resolve();
      }),
    );
    const hits = await scanning;
    assert(eventLoopWorked);
    assert.deepEqual(
      hits.map((h) => h.event),
      [docs[2].event, docs[3].event],
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(scanner.scan(input, controller.signal));
  }));

test("query cache enforces byte and entry limits without retaining query text", async () => {
  const database = new DatabaseSync(":memory:");
  const cache = new SqlQueryCache(
    {
      exec(sql, ...args) {
        const s = database.prepare(sql);
        if (s.columns().length) return s.all(...args);
        s.run(...args);
        return [];
      },
      transaction(fn) {
        database.exec("BEGIN");
        try {
          const value = fn();
          database.exec("COMMIT");
          return value;
        } catch (e) {
          database.exec("ROLLBACK");
          throw e;
        }
      },
    },
    32768,
    2,
  );
  try {
    for (let i = 1; i <= 3; i++)
      await cache.put(profileId(profile), hash(i), vectorBytes(unit()));
    assert.equal(
      database.prepare("SELECT COUNT(*) AS n FROM semantic_queries").get()!.n,
      2,
    );
    assert.equal(await cache.get(profileId(profile), hash(1)), null);
    assert(await cache.get(profileId(profile), hash(3)));
    assert.deepEqual(
      database
        .prepare("PRAGMA table_info(semantic_queries)")
        .all()
        .map((row) => row.name),
      ["profile", "input", "vector", "used"],
    );
  } finally {
    database.close();
  }
});

test("current coverage filters old inert associations and checks exact extraction and body bindings", async () =>
  fixture(async ({ store, scanner, path, docs, ctx }) => {
    const provider = mock();
    const current = structuredClone(ctx.evaluation);
    current.receipts[docs[0].event].interpretation = "inert";
    current.publications[docs[1].event].status = "retired";
    const selected = { ...ctx, evaluation: current };
    const options = {
      profile: profileId(profile),
      store,
      cache: store.queryCache,
      scanner,
    };
    const engine = new SemanticSearch(options, provider.assistance, true);
    const description = (await engine.profiles(selected))[0];
    assert.equal(description.query_available, true);
    assert.equal(description.eligible, 2);
    assert.equal(description.indexed, 2);
    assert.deepEqual(
      (await engine.search(selected, request(), "local")).hits.map(
        (hit) => hit.event,
      ),
      docs.slice(2).map((row) => row.event),
    );
    const sql = new DatabaseSync(path);
    try {
      for (const mutation of [
        "extraction_version=1",
        `body='${hash(99999)}'`,
      ]) {
        sql.exec(
          `UPDATE semantic_associations SET ${mutation} WHERE event='${docs[2].event}'`,
        );
        const changed = new SemanticSearch(options, provider.assistance, true);
        assert.equal(
          (await changed.profiles(selected))[0].query_available,
          false,
        );
        await assert.rejects(
          changed.search(selected, request(), "local"),
          /complete compatible/,
        );
        sql
          .prepare(
            "UPDATE semantic_associations SET extraction_version=2,body=? WHERE event=?",
          )
          .run(docs[2].body, docs[2].event);
      }
      // Equal aggregate counts cannot hide one absent currently eligible association.
      sql
        .prepare("DELETE FROM semantic_associations WHERE event=?")
        .run(docs[2].event);
      assert.equal(
        (
          await new SemanticSearch(options, provider.assistance, true).profiles(
            selected,
          )
        )[0].query_available,
        false,
      );
    } finally {
      sql.close();
    }
    assert.deepEqual(provider.calls, ["probe", "query"]);
  }));

test("a complete empty context returns no hits or paid probe and a warm hit survives budget exhaustion", async () =>
  fixture(async ({ store, scanner, ctx }) => {
    const provider = mock();
    const options = {
      profile: profileId(profile),
      store,
      cache: store.queryCache,
      scanner,
    };
    const engine = new SemanticSearch(options, provider.assistance, true);
    await engine.search(ctx, request(), "local");
    provider.config.hourlyBudgetUsd = 0;
    assert.equal((await engine.search(ctx, request(), "local")).hits.length, 3);
    await assert.rejects(engine.search(ctx, request("uncached"), "local"));
    assert.deepEqual(provider.calls, ["probe", "query"]);
    const empty = context([], hash(4000), hash(4001, "jve1:"));
    const generation = await store.create(
      {
        snapshot: empty.snapshot.snapshot,
        view: empty.evaluation.selected_view,
        profile: profileId(profile),
        eligible: 0,
      },
      profile,
    );
    await store.stage(generation.id, null, {
      documents: [],
      next: null,
      done: true,
    });
    await store.start(generation.id);
    await store.finish(generation.id);
    await store.publish(generation.id, null);
    assert.equal((await engine.profiles(empty))[0].query_available, true);
    const result = await engine.search(
      empty,
      request("empty context"),
      "local",
    );
    assert.deepEqual(result.hits, []);
    assert.deepEqual(result.coverage, {
      indexed: 0,
      eligible: 0,
      pending: 0,
      failed: 0,
    });
    assert.equal(provider.calls.length, 2);
  }));

test("distinct-word scans keep the best definition after exclusions and stable ties", async () => {
  const docs = rows(5).map((row, i) => ({
    ...row,
    word: hash(i < 3 ? 300 : 301, "jvw1:"),
    vector: vectorBytes(unit()),
  }));
  const hits = await scanPages(
    {
      generation: "test",
      profile: profileId(profile),
      snapshot: hash(1000),
      view: hash(1001, "jve1:"),
      language: "en",
      vector: unit(),
      eligible: docs.slice(1).map((row) => row.event),
      limit: 2,
      distinctWords: true,
    },
    async () => ({ rows: docs, next: null }),
  );
  assert.deepEqual(
    hits.map((hit) => hit.event),
    [docs[1].event, docs[3].event],
  );
});

test("fixed probe tolerance admits small numerical variation and retains evidence before suspension", async () =>
  fixture(async ({ store, scanner, ctx }) => {
    const provider = mock();
    const options = {
      profile: profileId(profile),
      store,
      cache: store.queryCache,
      scanner,
    };
    const rotated = (cosineDistance: number) => {
      const vector = unit();
      vector[0] = 1 - cosineDistance;
      vector[1] = Math.sqrt(1 - vector[0] ** 2);
      return vector;
    };
    provider.sample(rotated(0.0002));
    await new SemanticSearch(options, provider.assistance, true).search(
      ctx,
      request(),
      "local",
    );
    let evidence = (await store.probeEvidence(profileId(profile)))!;
    assert.equal(evidence.tolerance, 0.0005);
    assert(evidence.references.every((r) => r.distance < evidence.tolerance));
    assert.equal(evidence.references.length, 2);
    provider.sample(rotated(0.0008));
    await assert.rejects(
      new SemanticSearch(options, provider.assistance, true).search(
        ctx,
        request("changed"),
        "local",
      ),
      /compatibility tolerance/,
    );
    evidence = (await store.probeEvidence(profileId(profile)))!;
    assert(evidence.references.every((r) => r.distance > evidence.tolerance));
    assert(evidence.operation.startsWith("embedding:probe:"));
    assert.equal(
      await store.compatibility(profileId(profile)),
      "semantic_model_drift",
    );
  }));
