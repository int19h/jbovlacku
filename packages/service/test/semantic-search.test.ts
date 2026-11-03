import assert from "node:assert/strict";
import { before, test } from "node:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  initializeCore,
  semanticProjectionVersion,
  utf8,
  type Evaluation,
} from "../../core/src/index.ts";
import { SqliteVectorStore } from "../../../apps/server/src/semantic.ts";
import { NodeVectorScanner } from "../../../apps/server/src/semantic-scanner.ts";
import { SqlQueryCache } from "../src/semantic/query-cache.ts";
import {
  SemanticSearch,
  expectedAssociations,
  type SearchContext,
} from "../src/semantic/search.ts";
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
import type { IndexEmbedder } from "../src/semantic/indexer.ts";
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
      extraction_version: semanticProjectionVersion(),
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
function recordingEmbedder(axis = 0) {
  const calls: string[] = [];
  const assistance: IndexEmbedder = {
    embed: async (inputs, caller, _signal, before) => {
      calls.push(caller.kind);
      const operation = `embedding:${caller.kind}:recorded-${calls.length}`;
      await before?.(operation);
      return {
        operation,
        vectors: inputs.map(() => unit(axis)),
        usage,
        model: profile.model,
      };
    },
    embeddingOperationPending: () => false,
  };
  return { calls, assistance };
}
async function failedBackgroundGeneration(
  store: SqliteVectorStore,
  docs: IndexDocument[],
  ctx: SearchContext,
  state: "failed" | "ambiguous",
) {
  const generation = await store.create(
    {
      snapshot: ctx.snapshot.snapshot,
      view: ctx.evaluation.selected_view,
      profile: profileId(profile),
      eligible: docs.length,
    },
    profile,
  );
  await store.stage(generation.id, null, {
    documents: docs,
    next: docs.at(-1)!.event,
    done: true,
  });
  await store.setBackgroundGeneration(generation.id);
  await store.start(generation.id);
  const batch = (await store.claim(generation.id))!;
  if (state === "ambiguous")
    await store.sent(batch.id, "embedding:index:failed-parent");
  await store.fail(batch.id, "embedding_provider");
  await store.pause(generation.id, "embedding_provider");
  return { generation, batch };
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
        engine.search(ctx, request(), "another-network"),
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

test("coverage follows exact events across snapshots and refuses unsupported input before payment", async () =>
  fixture(async ({ store, scanner, docs, ctx }) => {
    const provider = mock();
    const engine = new SemanticSearch(
      { profile: profileId(profile), store, cache: store.queryCache, scanner },
      provider.assistance,
      true,
    );
    const newer = context(docs, hash(9999));
    const advertised = await engine.profiles(newer);
    assert.equal(advertised[0].query_available, true);
    assert.equal(advertised[0].indexed, 4);
    assert.equal(advertised[0].pending, 0);
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

test("scan filtering precedes top-k and distinct-word grouping", async () =>
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
    const hits = await scanner.scan(input);
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

test("current coverage filters old inert associations and counts stale bindings as pending", async () =>
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
      for (const [field, value] of [
        ["extraction_version", 2],
        ["envelope", hash(99998)],
        ["body", hash(99999)],
        ["word", hash(99999, "jvw1:")],
        ["language", "fr"],
      ] as const) {
        sql
          .prepare(`UPDATE semantic_associations SET ${field}=? WHERE event=?`)
          .run(value, docs[2].event);
        const changed = new SemanticSearch(options, provider.assistance, true);
        const description = (await changed.profiles(selected))[0];
        assert.equal(description.query_available, true);
        assert.equal(description.pending, 1);
        assert(
          !description.limitations.some((line) =>
            line.includes("failed indexing"),
          ),
        );
        assert.deepEqual(
          await store.coverage(
            (await store.current(
              profileId(profile),
              ctx.evaluation.selected_view,
            ))!,
            undefined,
            expectedAssociations(selected),
          ),
          {
            eligible: 2,
            indexed: 1,
            pending: 1,
            failed: 0,
          },
        );
        const result = await changed.search(selected, request(), "local");
        assert.deepEqual(result.coverage, {
          eligible: 2,
          indexed: 1,
          pending: 1,
          failed: 0,
        });
        assert.deepEqual(
          result.hits.map((hit) => hit.event),
          [docs[3].event],
        );
        sql
          .prepare(`UPDATE semantic_associations SET ${field}=? WHERE event=?`)
          .run(docs[2][field], docs[2].event);
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
        )[0].pending,
        1,
      );
    } finally {
      sql.close();
    }
    assert.deepEqual(provider.calls, ["probe", "query"]);
  }));

for (const batchState of ["failed", "ambiguous"] as const)
  test(`exact input and provider failures stay failed while stale failures become pending (${batchState})`, async () =>
    fixture(async ({ store, scanner, path }) => {
      const docs = rows(6);
      docs[4] = {
        ...docs[4],
        input: null,
        input_hash: null,
        error: "input_limit",
      };
      const ctx = context(docs, hash(9850));
      const generation = await store.create(
        {
          snapshot: ctx.snapshot.snapshot,
          view: ctx.evaluation.selected_view,
          profile: profileId(profile),
          eligible: docs.length,
        },
        profile,
      );
      await store.stage(generation.id, null, {
        documents: docs,
        next: docs.at(-1)!.event,
        done: true,
      });
      await store.start(generation.id);
      const batch = (await store.claim(generation.id))!;
      assert.deepEqual(batch.inputs, [docs[5].input_hash]);
      if (batchState === "ambiguous")
        await store.sent(batch.id, "embedding:index:provider-failure");
      await store.fail(batch.id, "embedding_provider");
      await store.pause(generation.id, "embedding_provider");
      await store.publish(
        generation.id,
        await store.current(generation.profile, generation.view),
      );
      const engine = new SemanticSearch(
        {
          profile: generation.profile,
          store,
          cache: store.queryCache,
          scanner,
        },
        mock().assistance,
        true,
      );
      const exact = await engine.search(
        ctx,
        { ...request(), limit: 100 },
        "local",
      );
      assert.deepEqual(exact.coverage, {
        eligible: 6,
        indexed: 4,
        pending: 0,
        failed: 2,
      });
      assert(
        (await engine.profiles(ctx))[0].limitations.includes(
          "2 definitions failed indexing.",
        ),
      );
      const sql = new DatabaseSync(path);
      try {
        sql
          .prepare(
            "UPDATE semantic_associations SET extraction_version=2 WHERE event IN (?,?)",
          )
          .run(docs[4].event, docs[5].event);
        const stale = await engine.search(
          ctx,
          { ...request(), limit: 100 },
          "local",
        );
        assert.deepEqual(stale.coverage, {
          eligible: 6,
          indexed: 4,
          pending: 2,
          failed: 0,
        });
        assert.deepEqual(await store.coverage(generation.id), stale.coverage);
        assert.equal((await store.batches(generation.id))[0].state, batchState);
        assert.equal(
          (await store.page(generation.id)).rows[4].error,
          "input_limit",
        );
      } finally {
        sql.close();
      }
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

test("partial coverage retains unchanged definitions and omits missing or mismatched events", async () =>
  fixture(async ({ store, scanner, docs }) => {
    const provider = mock();
    const engine = new SemanticSearch(
      { profile: profileId(profile), store, cache: store.queryCache, scanner },
      provider.assistance,
      true,
    );
    const added = rows(5);
    const changed = context(added, hash(9999));
    changed.snapshot.events[docs[0].event].body_hash = hash(9876);
    const description = (await engine.profiles(changed))[0];
    assert.equal(description.query_available, true);
    assert.equal(description.indexed, 3);
    assert.equal(description.pending, 2);
    const result = await engine.search(
      changed,
      { ...request(), limit: 100 },
      "local",
    );
    assert.equal(result.snapshot, changed.snapshot.snapshot);
    assert.deepEqual(result.coverage, {
      eligible: 5,
      indexed: 3,
      pending: 2,
      failed: 0,
    });
    assert.deepEqual(
      result.hits.map((hit) => hit.event),
      docs.slice(1).map((row) => row.event),
    );
  }));

test("unequal distances replace worse definitions and evict the worst top-k hit", async () => {
  // Event order deliberately opposes distance order. One word improves after eviction.
  const distances = [0.8, 0.6, 0.4, 0.1, 0.2, 0.1];
  const docs = rows(6).map((row, i) => {
    const vector = unit();
    vector[0] = 1 - distances[i];
    vector[1] = Math.sqrt(1 - vector[0] ** 2);
    return {
      ...row,
      word: hash(i === 3 ? 300 : i === 5 ? 302 : i + 300, "jvw1:"),
      vector: vectorBytes(vector),
    };
  });
  const request = {
    generation: "test",
    profile: profileId(profile),
    snapshot: hash(1000),
    view: hash(1001, "jve1:"),
    language: "en",
    vector: unit(),
    eligible: docs.map((row) => row.event),
    limit: 2,
  };
  for (const limit of [2, 3])
    for (const distinctWords of [false, true]) {
      const hits = await scanPages(
        { ...request, limit, distinctWords },
        async (after) => {
          const index =
            after === null
              ? 0
              : docs.findIndex((row) => row.event === after) + 1;
          return {
            rows: [docs[index]],
            next: index + 1 === docs.length ? null : docs[index].event,
          };
        },
      );
      assert.deepEqual(
        hits.map((hit) => hit.event),
        limit === 2
          ? [docs[3].event, docs[5].event]
          : [docs[3].event, docs[5].event, docs[4].event],
      );
      assert(
        hits.slice(0, 2).every((hit) => Math.abs(hit.distance - 0.1) < 1e-7),
      );
    }
});

test("warm scans leave the main loop runnable and reserve one worker per client until cancellation settles", async () =>
  fixture(async ({ store, scanner, ctx }) => {
    const docs = rows(1024);
    const generation = await publish(store, docs, context(docs, hash(4500)));
    const request = {
      generation: generation.id,
      snapshot: ctx.snapshot.snapshot,
      view: generation.view,
      profile: generation.profile,
      language: "en",
      vector: unit(),
      limit: 3,
      eligible: docs.map((row) => row.event),
      network: "one",
    };
    await scanner.scan(request);
    let done = false;
    const controller = new AbortController();
    const scan = scanner.scan(request, controller.signal).then(() => {
      done = true;
    });
    const canceled = assert.rejects(scan);
    await assert.rejects(scanner.scan(request), /already has an active/);
    const other = scanner.scan({ ...request, network: "two" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      done,
      false,
      "A warm scan must still run while HTTP work can execute",
    );
    controller.abort();
    await assert.rejects(scanner.scan(request), /already has an active/);
    await canceled;
    // A settled cancellation must release its real worker, not only the caller's promise.
    const resumed = scanner.scan(request);
    await other;
    assert.equal((await resumed).length, 3);
  }));

test("cold coverage yields between bounded metadata pages", async () =>
  fixture(async ({ store }) => {
    const docs = rows(1024);
    const generation = await publish(store, docs, context(docs, hash(4500)));
    let done = false;
    const work = store.coverageFor(generation.id, docs).then((coverage) => {
      done = true;
      return coverage;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      done,
      false,
      "Cold coverage must allow main-loop work before it ends",
    );
    assert.equal((await work).all.indexed, 1024);
  }));

test("background jobs keep partial search available and finish new inputs without another lock", async () =>
  fixture(async ({ store, scanner, docs, ctx }) => {
    const { BackgroundSemanticIndexer } =
      await import("../src/semantic/background.ts");
    const { lockDataDirectory } =
      await import("../../importer/src/load-lock.ts");
    const directory = await mkdtemp(
      join(process.env.JVC_TEST_ROOT ?? tmpdir(), "semantic-lock-"),
    );
    const releaseLock = await lockDataDirectory(directory, "test-live-server");
    const provider = mock();
    const engine = new SemanticSearch(
      { profile: profileId(profile), store, cache: store.queryCache, scanner },
      provider.assistance,
      true,
    );
    const added = rows(5);
    const changed = context(added, hash(9999));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    const background = new BackgroundSemanticIndexer({
      store,
      profile: profileId(profile),
      view: ctx.evaluation.selected_view,
      assistance: {
        embed: async (...args) => {
          started = true;
          await gate;
          return provider.assistance.embed(...args);
        },
      },
      source: async () => ({
        context: {
          snapshot: changed.snapshot.snapshot,
          view: changed.evaluation.selected_view,
          profile: profileId(profile),
          eligible: 5,
        },
        page: async () => ({
          documents: added,
          next: added.at(-1)!.event,
          done: true,
        }),
      }),
      probe: (generation, profile) => engine.probe(generation, profile),
      report: () => {},
    });
    try {
      const running = background.cycle();
      while (!started) await new Promise((resolve) => setTimeout(resolve, 1));
      const pending = await engine.search(changed, request(), "local");
      assert.equal(pending.coverage.pending, 1);
      assert.equal(pending.coverage.indexed, docs.length);
      let closed = false;
      const closing = background.close().then(() => {
        closed = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(
        closed,
        false,
        "Shutdown must wait for the admitted index transport",
      );
      release();
      await Promise.all([running, closing]);
      const complete = await engine.search(
        changed,
        { ...request(), limit: 10 },
        "local",
      );
      assert.equal(complete.coverage.pending, 0);
      assert.equal(complete.hits.length, 5);
      const calls = provider.calls.length;
      await background.cycle();
      assert.equal(
        provider.calls.length,
        calls,
        "Shutdown must disable later work",
      );
    } finally {
      release();
      await background.close();
      await releaseLock();
      await rm(directory, { recursive: true });
    }
  }));

test("background recovery keeps the same job across restart and snapshot changes", async () =>
  fixture(async ({ store, ctx }) => {
    const { BackgroundSemanticIndexer } =
      await import("../src/semantic/background.ts");
    let calls = 0;
    let snapshot = hash(9999);
    let now = Date.now();
    const added = rows(5);
    const options = {
      now: () => now,
      store,
      profile: profileId(profile),
      view: ctx.evaluation.selected_view,
      assistance: {
        embed: async (
          _inputs: Uint8Array[],
          _caller: unknown,
          _signal: unknown,
          before?: (operation: string) => Promise<void>,
        ) => {
          calls++;
          await before?.("embedding:index:unknown-delivery");
          throw new Error("Unknown transport result");
        },
      },
      source: async () => ({
        context: {
          snapshot,
          view: ctx.evaluation.selected_view,
          profile: profileId(profile),
          eligible: 5,
        },
        page: async () => ({
          documents: added,
          next: added.at(-1)!.event,
          done: true,
        }),
      }),
      probe: async () => {},
      report: () => {},
    };
    const first = new BackgroundSemanticIndexer(options);
    await first.cycle();
    await first.close();
    assert.equal(calls, 1);
    const generation = (await store.backgroundGeneration(
      profileId(profile),
      ctx.evaluation.selected_view,
    ))!;
    assert.equal(generation.error, "index_failed");
    snapshot = hash(10000);
    now += 1000;
    const restarted = new BackgroundSemanticIndexer(options);
    await restarted.cycle();
    await restarted.close();
    assert.equal(calls, 2);
    const oldBatch = (await store.retryableBatch(generation.id))!;
    await store.retry(oldBatch.id);
    await store.start(generation.id);
    const uncertain = (await store.claim(generation.id))!;
    await store.sent(uncertain.id, "embedding:index:interrupted");
    now += 2000;
    const afterCrash = new BackgroundSemanticIndexer(options);
    await afterCrash.cycle();
    assert.equal(
      (await store.batches(generation.id)).find(
        (batch) => batch.id === uncertain.id,
      )!.state,
      "ambiguous",
    );
    await afterCrash.cycle();
    await afterCrash.close();
    assert.equal(calls, 3);
    assert.equal(
      (await store.backgroundGeneration(
        profileId(profile),
        ctx.evaluation.selected_view,
      ))!.id,
      generation.id,
    );
  }));

test("background indexing can add the first definition to a published empty context", async () =>
  fixture(async ({ store }) => {
    const { BackgroundSemanticIndexer } =
      await import("../src/semantic/background.ts");
    const empty = {
      snapshot: hash(6000),
      view: hash(6001, "jve1:"),
      profile: profileId(profile),
      eligible: 0,
    };
    const initial = await store.create(empty, profile);
    await store.stage(initial.id, null, {
      documents: [],
      next: null,
      done: true,
    });
    await store.start(initial.id);
    await store.finish(initial.id);
    await store.publish(initial.id, null);
    const provider = mock();
    const docs = rows(5).slice(4);
    const background = new BackgroundSemanticIndexer({
      store,
      profile: empty.profile,
      view: empty.view,
      assistance: provider.assistance,
      source: async () => ({
        context: { ...empty, snapshot: hash(6002), eligible: 1 },
        page: async () => ({
          documents: docs,
          next: docs[0].event,
          done: true,
        }),
      }),
      probe: async () => {
        throw new Error("An empty index has no reference vectors to probe");
      },
      report: () => {},
    });
    await background.cycle();
    await background.close();
    const generation = (await store.backgroundGeneration(
      empty.profile,
      empty.view,
    ))!;
    assert.equal(generation.state, "completed");
    assert.equal((await store.coverage(generation.id)).indexed, 1);
    assert.equal(provider.calls.length, 1);
  }));

test("background indexing never replaces an unfinished operator job to replay its inputs", async () =>
  fixture(async ({ store, ctx }) => {
    const { BackgroundSemanticIndexer } =
      await import("../src/semantic/background.ts");
    const docs = rows(5);
    const incomplete = await store.create(
      {
        snapshot: hash(7777),
        view: ctx.evaluation.selected_view,
        profile: profileId(profile),
        eligible: 5,
      },
      profile,
    );
    await store.stage(incomplete.id, null, {
      documents: docs,
      next: docs.at(-1)!.event,
      done: true,
    });
    const current = await store.current(incomplete.profile, incomplete.view);
    await store.publish(incomplete.id, current);
    const background = new BackgroundSemanticIndexer({
      store,
      profile: incomplete.profile,
      view: incomplete.view,
      assistance: {
        embed: async () => {
          throw new Error("No automatic dispatch from an operator job");
        },
      },
      source: async () => {
        throw new Error("No replacement source for an unfinished operator job");
      },
      probe: async () => {},
      report: () => {},
    });
    await background.cycle();
    await background.close();
    assert.equal(
      await store.backgroundGeneration(incomplete.profile, incomplete.view),
      null,
    );
  }));

test("a delayed query retains its generation through multiple background publications", async () =>
  fixture(async ({ store, scanner, docs, ctx }) => {
    const { BackgroundSemanticIndexer } =
      await import("../src/semantic/background.ts");
    const initial = (await store.published(ctx.evaluation.selected_view))[0];
    await store.setBackgroundGeneration(initial.id);
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
    let count = 5;
    const background = new BackgroundSemanticIndexer({
      store,
      profile: profileId(profile),
      view: ctx.evaluation.selected_view,
      assistance: provider.assistance,
      source: async () => {
        const documents = rows(count);
        return {
          context: {
            snapshot: hash(8000 + count),
            view: ctx.evaluation.selected_view,
            profile: profileId(profile),
            eligible: count,
          },
          page: async () => ({
            documents,
            next: documents.at(-1)!.event,
            done: true,
          }),
        };
      },
      probe: (generation, profile) => engine.probe(generation, profile),
      report: () => {},
    });
    const searching = engine.search(ctx, request(), "local");
    try {
      while (!provider.calls.includes("query"))
        await new Promise((resolve) => setTimeout(resolve, 1));
      await background.cycle();
      count = 6;
      await background.cycle();
      assert.equal((await store.generation(initial.id)).state, "completed");
      await assert.rejects(store.retire(initial.id), /active search/);
      release();
      const result = await searching;
      assert.equal(result.snapshot, ctx.snapshot.snapshot);
      assert.deepEqual(
        result.hits.map((hit) => hit.event),
        docs.slice(0, 3).map((row) => row.event),
      );
      await background.cycle();
      assert.equal((await store.generation(initial.id)).state, "retired");
    } finally {
      release();
      await searching.catch(() => {});
      await background.close();
    }
  }));

test("an entirely pending population remains query-available without paid inference", async () =>
  fixture(async ({ store, scanner }) => {
    const provider = mock();
    const engine = new SemanticSearch(
      { profile: profileId(profile), store, cache: store.queryCache, scanner },
      provider.assistance,
      true,
    );
    const pending = context(rows(5).slice(4), hash(9000));
    const description = (await engine.profiles(pending))[0];
    assert.equal(description.query_available, true);
    assert.equal(description.indexed, 0);
    assert.equal(description.pending, 1);
    const result = await engine.search(pending, request(), "local");
    assert.deepEqual(result.hits, []);
    assert.deepEqual(result.coverage, {
      eligible: 1,
      indexed: 0,
      pending: 1,
      failed: 0,
    });
    assert.equal(provider.calls.length, 0);
  }));

test("partial coverage shares concurrent work and caches unchanged progress", async () =>
  fixture(async ({ store, scanner }) => {
    const docs = rows(260);
    const ctx = context(docs, hash(9100));
    const generation = await store.create(
      {
        snapshot: ctx.snapshot.snapshot,
        view: ctx.evaluation.selected_view,
        profile: profileId(profile),
        eligible: docs.length,
      },
      profile,
    );
    for (let offset = 0; offset < docs.length; offset += 128) {
      const page = docs.slice(offset, offset + 128);
      await store.stage(generation.id, offset ? docs[offset - 1].event : null, {
        documents: page,
        next: page.at(-1)!.event,
        done: offset + 128 >= docs.length,
      });
    }
    await store.publish(
      generation.id,
      await store.current(generation.profile, generation.view),
    );
    const coverageFor = store.coverageFor.bind(store);
    let computations = 0;
    store.coverageFor = async (...args) => {
      computations++;
      return coverageFor(...args);
    };
    const engine = new SemanticSearch(
      {
        profile: generation.profile,
        store,
        cache: store.queryCache,
        scanner,
      },
      mock().assistance,
      true,
    );
    const [one, two] = await Promise.all([
      engine.profiles(ctx),
      engine.profiles(ctx),
    ]);
    assert.deepEqual(one, two);
    assert.equal(one[0].pending, 256);
    assert.equal(
      computations,
      1,
      "Concurrent partial coverage must share one calculation",
    );
    await engine.profiles(ctx);
    assert.equal(
      computations,
      1,
      "Unchanged partial coverage must stay cached",
    );
  }));

test("empty networks share the same one-worker scan limit", async () =>
  fixture(async ({ store, scanner, docs, ctx }) => {
    const generation = (await store.published(ctx.evaluation.selected_view))[0];
    const request = {
      generation: generation.id,
      profile: generation.profile,
      snapshot: generation.snapshot,
      view: generation.view,
      language: "en",
      vector: unit(),
      eligible: docs.map((row) => row.event),
      limit: 3,
    };
    const first = scanner.scan(request);
    try {
      await assert.rejects(
        scanner.scan({ ...request, network: "" }),
        /already has an active/,
      );
      const other = scanner.scan({ ...request, network: "known-client" });
      assert.equal((await other).length, 3);
      assert.equal((await first).length, 3);
    } finally {
      await first;
    }
  }));

test("retirement yields with rows remaining and blocks concurrent publication or new readers", async () =>
  fixture(async ({ store, path }) => {
    const docs = rows(1024);
    const target = await publish(store, docs, context(docs, hash(9200)));
    const current = await publish(store, docs, context(docs, hash(9201)));
    await publish(store, docs, context(docs, hash(9202)));
    const release = await store.retainGeneration(target.id);
    await assert.rejects(store.retire(target.id), /active search/);
    release();
    const db = new DatabaseSync(path, { readOnly: true });
    const connection = (
      store as unknown as {
        sql: import("../src/sqlite.ts").SqliteConnection;
      }
    ).sql;
    const transaction = connection.transaction.bind(connection);
    const pages: number[] = [];
    const remainingRows = () =>
      Number(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM semantic_associations WHERE generation=?",
          )
          .get(target.id)!.n,
      );
    connection.transaction = (operation) => {
      const before = remainingRows();
      const result = transaction(operation);
      const removed = before - remainingRows();
      if (removed) pages.push(removed);
      return result;
    };
    let done = false;
    const work = store.retire(target.id).then(() => {
      done = true;
    });
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      assert.equal(
        done,
        false,
        "Retirement must yield before all rows leave storage",
      );
      const remaining = Number(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM semantic_associations WHERE generation=?",
          )
          .get(target.id)!.n,
      );
      assert(
        remaining > 0 && remaining < docs.length,
        `Remaining rows: ${remaining}`,
      );
      await assert.rejects(store.retainGeneration(target.id), /retired/);
      await assert.rejects(
        store.publish(
          target.id,
          await store.current(target.profile, target.view),
        ),
        /retired/,
      );
      // Reads and publication of a different retained generation remain available across the yield.
      assert.equal((await store.page(current.id, null, 1)).rows.length, 1);
      const head = await store.current(current.profile, current.view);
      assert.equal(await store.publish(current.id, head), true);
      await work;
      assert.equal((await store.generation(target.id)).state, "retired");
      assert.equal((await store.coverage(current.id)).indexed, docs.length);
      assert.deepEqual(pages, Array(8).fill(128));
    } finally {
      await work;
      connection.transaction = transaction;
      db.close();
    }
  }));

test("shutdown after an unsent claim keeps a failed batch for linked background recovery", async () =>
  fixture(async ({ store, ctx }) => {
    const { BackgroundSemanticIndexer } =
      await import("../src/semantic/background.ts");
    const docs = rows(5);
    let sends = 0;
    const assistance = {
      embed: async (
        inputs: Uint8Array[],
        _caller: unknown,
        _signal: unknown,
        before?: (operation: string) => Promise<void>,
      ) => {
        sends++;
        const operation = `embedding:index:shutdown-${sends}`;
        await before?.(operation);
        return {
          operation,
          vectors: inputs.map(() => unit()),
          usage,
          model: profile.model,
        };
      },
    };
    const options = {
      store,
      profile: profileId(profile),
      view: ctx.evaluation.selected_view,
      assistance,
      source: async () => ({
        context: {
          snapshot: hash(9300),
          view: ctx.evaluation.selected_view,
          profile: profileId(profile),
          eligible: 5,
        },
        page: async () => ({
          documents: docs,
          next: docs.at(-1)!.event,
          done: true,
        }),
      }),
      probe: async () => {},
      report: () => {},
    };
    const background = new BackgroundSemanticIndexer(options);
    const claim = store.claim.bind(store);
    let closing: Promise<void> | undefined;
    let claims = 0;
    store.claim = async (id) => {
      claims++;
      const batch = await claim(id);
      if (batch && !closing) closing = background.close();
      return batch;
    };
    await background.cycle();
    await closing;
    const job = (await store.backgroundGeneration(
      options.profile,
      options.view,
    ))!;
    const oldBatch = (await store.batches(job.id))[0];
    assert.equal(sends, 0);
    assert.equal(oldBatch.state, "failed");
    assert.equal(oldBatch.error, "index_paused");
    const restarted = new BackgroundSemanticIndexer(options);
    try {
      await restarted.cycle();
      const completedClaims = claims;
      for (let i = 0; i < 3; i++) await restarted.cycle();
      assert.equal(
        claims,
        completedClaims,
        "Completed work must not spin through empty claims",
      );
      assert.equal(
        sends,
        1,
        "Restart must make one linked attempt for the unsent batch",
      );
      store.claim = claim;
      assert.equal((await store.generation(job.id)).state, "completed");
      const batches = await store.batches(job.id);
      assert.equal(batches.length, 2);
      assert.equal(
        batches.find((batch) => batch.previous === oldBatch.id)!.state,
        "completed",
      );
      assert.equal(sends, 1);
    } finally {
      await restarted.close();
    }
  }));

test("coverage invalidates for failure recovery retry and vectors completed in another generation", async () =>
  fixture(async ({ store, scanner }) => {
    const docs = rows(5);
    const ctx = context(docs, hash(9400));
    const make = async (snapshot: string) => {
      const generation = await store.create(
        {
          snapshot,
          view: ctx.evaluation.selected_view,
          profile: profileId(profile),
          eligible: docs.length,
        },
        profile,
      );
      await store.stage(generation.id, null, {
        documents: docs,
        next: docs.at(-1)!.event,
        done: true,
      });
      return generation;
    };
    const generation = await make(ctx.snapshot.snapshot);
    await store.publish(
      generation.id,
      await store.current(generation.profile, generation.view),
    );
    const engine = new SemanticSearch(
      { profile: generation.profile, store, cache: store.queryCache, scanner },
      mock().assistance,
      true,
    );
    const coverageFor = store.coverageFor.bind(store);
    let calculations = 0;
    store.coverageFor = async (...args) => {
      calculations++;
      return coverageFor(...args);
    };
    const counts = async (
      indexed: number,
      pending: number,
      failed: boolean,
    ) => {
      const value = (await engine.profiles(ctx))[0];
      assert.equal(value.indexed, indexed);
      assert.equal(value.pending, pending);
      assert.equal(
        value.limitations.some((line) => line.includes("failed indexing")),
        failed,
      );
    };
    await counts(4, 1, false);
    await store.start(generation.id);
    const first = (await store.claim(generation.id))!;
    await counts(4, 1, false);
    await store.fail(first.id, "embedding_busy");
    await store.pause(generation.id, "embedding_busy");
    await counts(4, 0, true);
    await store.retry(first.id);
    const beforeRetry = calculations;
    await counts(4, 0, true);
    assert.equal(
      calculations,
      beforeRetry + 1,
      "Explicit retry selection invalidates the cached version",
    );
    await store.start(generation.id);
    const retry = (await store.claim(generation.id))!;
    await counts(4, 1, false);
    await store.sent(retry.id, "embedding:index:interrupted-coverage");
    await counts(4, 1, false);
    await store.recover(generation.id);
    await counts(4, 0, true);
    const other = await make(hash(9401));
    await store.start(other.id);
    const batch = (await store.claim(other.id))!;
    const operation = "embedding:index:reusable-coverage";
    await store.sent(batch.id, operation);
    await store.complete(
      batch.id,
      operation,
      batch.inputs.map(() => unit()),
      usage,
    );
    await counts(5, 0, false);
    const stable = calculations;
    await counts(5, 0, false);
    assert.equal(
      calculations,
      stable,
      "Other-generation completion must refresh once, then stay cached",
    );
  }));

test("coverage progress during a shared calculation invalidates its settled result", async () =>
  fixture(async ({ store, scanner }) => {
    const docs = rows(5);
    const ctx = context(docs, hash(9450));
    const generation = await store.create(
      {
        snapshot: ctx.snapshot.snapshot,
        view: ctx.evaluation.selected_view,
        profile: profileId(profile),
        eligible: 5,
      },
      profile,
    );
    await store.stage(generation.id, null, {
      documents: docs,
      next: docs.at(-1)!.event,
      done: true,
    });
    await store.publish(
      generation.id,
      await store.current(generation.profile, generation.view),
    );
    const engine = new SemanticSearch(
      { profile: generation.profile, store, cache: store.queryCache, scanner },
      mock().assistance,
      true,
    );
    const coverageFor = store.coverageFor.bind(store);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calculations = 0;
    let scanned = false;
    store.coverageFor = async (...args) => {
      calculations++;
      const result = await coverageFor(...args);
      scanned = true;
      if (calculations === 1) await gate;
      return result;
    };
    const first = engine.profiles(ctx);
    try {
      while (!scanned)
        await new Promise<void>((resolve) => setImmediate(resolve));
      await store.start(generation.id);
      const batch = (await store.claim(generation.id))!;
      await store.fail(batch.id, "embedding_busy");
      const second = engine.profiles(ctx);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(
        calculations,
        1,
        "Changed progress must not duplicate work already in flight",
      );
      release();
      await Promise.all([first, second]);
      const fresh = (await engine.profiles(ctx))[0];
      assert.equal(calculations, 2);
      assert.equal(fresh.pending, 0);
      assert(
        fresh.limitations.some((line) => line.includes("1 definitions failed")),
      );
    } finally {
      release();
      await first;
    }
  }));

test("shutdown while reading claimed inputs prevents dispatch and retains explicit retry evidence", async () =>
  fixture(async ({ store, ctx }) => {
    const { SemanticIndexer } = await import("../src/semantic/indexer.ts");
    const docs = rows(5);
    const generation = await store.create(
      {
        snapshot: hash(9500),
        view: ctx.evaluation.selected_view,
        profile: profileId(profile),
        eligible: docs.length,
      },
      profile,
    );
    await store.stage(generation.id, null, {
      documents: docs,
      next: docs.at(-1)!.event,
      done: true,
    });
    const signal = new AbortController();
    const inputs = store.inputs.bind(store);
    store.inputs = async (id) => {
      const result = await inputs(id);
      signal.abort();
      return result;
    };
    let calls = 0;
    const embed = async () => {
      calls++;
      throw new Error("Dispatch after shutdown");
    };
    await new SemanticIndexer(store, { embed }).run(generation.id, {
      concurrency: 1,
      signal: signal.signal,
    });
    assert.equal(calls, 0);
    const batch = (await store.batches(generation.id))[0];
    assert.equal(batch.state, "failed");
    assert.equal(batch.operation, null);
    assert.equal((await store.generation(generation.id)).error, "index_paused");
  }));

for (const mode of ["batch", "probe"] as const)
  test(`background pre-send ${mode} refusals stay paused during their backoff`, async () =>
    fixture(async ({ store, ctx }) => {
      const { BackgroundSemanticIndexer } =
        await import("../src/semantic/background.ts");
      const { AssistanceError } = await import("../src/inference.ts");
      let attempts = 0;
      const docs = rows(5);
      const refuse = async () => {
        attempts++;
        throw new AssistanceError(
          429,
          "embedding_busy",
          "No slot is available.",
        );
      };
      const options = {
        store,
        profile: profileId(profile),
        view: ctx.evaluation.selected_view,
        assistance: {
          embed:
            mode === "batch"
              ? refuse
              : async () => {
                  throw new Error("Probe must stop dispatch");
                },
        },
        source: async () => ({
          context: {
            snapshot: hash(9550),
            view: ctx.evaluation.selected_view,
            profile: profileId(profile),
            eligible: 5,
          },
          page: async () => ({
            documents: docs,
            next: docs.at(-1)!.event,
            done: true,
          }),
        }),
        probe: mode === "probe" ? refuse : async () => {},
        report: () => {},
      };
      const background = new BackgroundSemanticIndexer(options);
      try {
        await background.cycle().catch((error) => {
          assert.equal(error.code, "embedding_busy");
        });
        for (let i = 0; i < 3; i++) await background.cycle();
        const job = (await store.backgroundGeneration(
          options.profile,
          options.view,
        ))!;
        assert.equal(job.error, "embedding_busy");
        assert.equal(attempts, 1);
        assert.equal((await store.summary(job.id)).dispatch_intents, 0);
      } finally {
        await background.close();
      }
    }));

for (const owner of ["operator", "background"] as const)
  test(`${owner} generation with stale extraction rebuilds in the same snapshot and reuses vectors`, async () =>
    fixture(async ({ store, scanner, path, docs, ctx }) => {
      const { BackgroundSemanticIndexer } =
        await import("../src/semantic/background.ts");
      const identity = profileId(profile);
      const view = ctx.evaluation.selected_view;
      const old = (await store.current(identity, view))!;
      if (owner === "background") await store.setBackgroundGeneration(old);
      const sql = new DatabaseSync(path);
      const staleCount = owner === "operator" ? 2 : docs.length;
      sql
        .prepare(
          `UPDATE semantic_associations SET extraction_version=2 WHERE event IN (${docs
            .slice(0, staleCount)
            .map(() => "?")
            .join(",")})`,
        )
        .run(...docs.slice(0, staleCount).map((row) => row.event));
      assert.deepEqual(await store.coverage(old), {
        eligible: docs.length,
        indexed: docs.length - staleCount,
        pending: staleCount,
        failed: 0,
      });
      const engine = new SemanticSearch(
        { profile: identity, store, cache: store.queryCache, scanner },
        mock().assistance,
        true,
      );
      let staged!: () => void;
      const staging = new Promise<void>((resolve) => {
        staged = resolve;
      });
      let resume!: () => void;
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      let sources = 0;
      let pages = 0;
      const background = new BackgroundSemanticIndexer({
        store,
        profile: identity,
        view,
        bindings: async () => expectedAssociations(ctx),
        needed: async () =>
          (await engine.profiles(ctx)).some((row) => row.pending > 0),
        source: async () => {
          sources++;
          return {
            context: {
              snapshot: ctx.snapshot.snapshot,
              view,
              profile: identity,
              eligible: docs.length,
            },
            page: async (after) => {
              pages++;
              if (after === null)
                return {
                  documents: docs.slice(0, 2),
                  next: docs[1].event,
                  done: false,
                };
              assert.equal(after, docs[1].event);
              staged();
              await gate;
              return {
                documents: docs.slice(2),
                next: docs.at(-1)!.event,
                done: true,
              };
            },
          };
        },
        assistance: {
          embed: async () => {
            throw new Error("Unchanged inputs need no embedding call");
          },
        },
        probe: async () => {
          throw new Error("Reused vectors need no new indexing probe");
        },
        report: (error) => {
          throw error;
        },
      });
      const work = background.cycle();
      try {
        assert.equal(
          await Promise.race([
            staging.then(() => true),
            work.then(() => false),
          ]),
          true,
          "Pending extraction changes must start a new generation for the same snapshot",
        );
        assert.equal(await store.current(identity, view), old);
        const partial = await engine.search(
          ctx,
          { ...request(), limit: 100 },
          "local",
        );
        assert.deepEqual(partial.coverage, {
          eligible: 4,
          indexed: docs.length - staleCount,
          pending: staleCount,
          failed: 0,
        });
        assert.deepEqual(
          partial.hits.map((hit) => hit.event),
          docs.slice(staleCount).map((row) => row.event),
        );
        resume();
        await work;
        const current = (await store.current(identity, view))!;
        assert.notEqual(current, old);
        assert.equal(
          (await store.generation(current)).snapshot,
          ctx.snapshot.snapshot,
        );
        assert.equal((await store.generation(current)).state, "completed");
        assert.equal((await store.summary(current)).batches, 0);
        assert(
          (await store.page(current)).rows.every(
            (row) => row.extraction_version === semanticProjectionVersion(),
          ),
        );
        for (const table of ["semantic_inputs", "semantic_vectors"])
          assert.equal(
            sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n,
            docs.length,
          );
        const rebuilt = await engine.search(
          ctx,
          { ...request(), limit: 100 },
          "local",
        );
        assert.deepEqual(rebuilt.coverage, {
          eligible: 4,
          indexed: 4,
          pending: 0,
          failed: 0,
        });
        assert.deepEqual(
          rebuilt.hits.map((hit) => hit.event),
          docs.map((row) => row.event),
        );
        await background.cycle();
        assert.equal(await store.current(identity, view), current);
        assert.equal(sources, 2);
        assert.equal(pages, 2);
      } finally {
        resume();
        await work;
        await background.close();
        sql.close();
      }
    }));

test("stale cached inputs and an unchanged input limit rebuild without any embedding or probe call", async () =>
  fixture(async ({ store, scanner }) => {
    const { BackgroundSemanticIndexer } =
      await import("../src/semantic/background.ts");
    const docs = rows(5);
    docs[4] = {
      ...docs[4],
      input: null,
      input_hash: null,
      error: "input_limit",
    };
    const ctx = context(docs, hash(9650));
    const old = await publish(
      store,
      docs.map((row) => ({ ...row, extraction_version: 2 })),
      ctx,
    );
    const provider = recordingEmbedder();
    const engine = new SemanticSearch(
      { profile: old.profile, store, cache: store.queryCache, scanner },
      provider.assistance,
      true,
    );
    assert.equal((await engine.profiles(ctx))[0].pending, docs.length);
    const background = new BackgroundSemanticIndexer({
      store,
      profile: old.profile,
      view: old.view,
      assistance: provider.assistance,
      source: async () => ({
        context: {
          snapshot: old.snapshot,
          view: old.view,
          profile: old.profile,
          eligible: docs.length,
        },
        page: async () => ({
          documents: docs,
          next: docs.at(-1)!.event,
          done: true,
        }),
      }),
      bindings: async () => expectedAssociations(ctx),
      needed: async () =>
        (await engine.profiles(ctx)).some((row) => row.pending > 0),
      probe: (generation, selectedProfile) =>
        engine.probe(generation, selectedProfile),
      report: (error) => {
        throw error;
      },
    });
    try {
      await background.cycle();
      const current = (await store.current(old.profile, old.view))!;
      assert.notEqual(current, old.id);
      assert.equal((await store.generation(current)).snapshot, old.snapshot);
      assert.equal((await store.generation(current)).state, "completed");
      assert.deepEqual(await store.coverage(current), {
        eligible: 5,
        indexed: 4,
        pending: 0,
        failed: 1,
      });
      assert.equal((await store.summary(current)).batches, 0);
      assert.equal((await store.page(current)).rows[4].error, "input_limit");
      assert(
        (await engine.profiles(ctx))[0].limitations.includes(
          "1 definitions failed indexing.",
        ),
      );
      assert.deepEqual(provider.calls, []);
    } finally {
      await background.close();
    }
  }));

for (const state of ["failed", "ambiguous"] as const)
  for (const outcome of ["missing", "cached", "drift"] as const)
    test(`${state} background retry probes only missing vectors before dispatch (${outcome})`, async () =>
      fixture(async ({ store, scanner }) => {
        const { BackgroundSemanticIndexer } =
          await import("../src/semantic/background.ts");
        const docs = rows(5);
        const ctx = context(docs, hash(9660));
        const { generation, batch } = await failedBackgroundGeneration(
          store,
          docs,
          ctx,
          state,
        );
        if (outcome === "cached") await publish(store, docs, ctx);
        const provider = recordingEmbedder(outcome === "drift" ? 1 : 0);
        const statuses: string[] = [];
        const engine = new SemanticSearch(
          {
            profile: generation.profile,
            store,
            cache: store.queryCache,
            scanner,
          },
          provider.assistance,
          true,
        );
        const background = new BackgroundSemanticIndexer({
          store,
          profile: generation.profile,
          view: generation.view,
          assistance: provider.assistance,
          source: async () => {
            throw new Error("A prepared retry needs no source read");
          },
          probe: (selected, selectedProfile) =>
            engine.probe(selected, selectedProfile),
          report: (error) => {
            throw error;
          },
          status: (message) => statuses.push(message),
        });
        try {
          await background.cycle();
          const batches = await store.batches(generation.id);
          assert.equal(
            batches.find((row) => row.id === batch.id)!.state,
            state,
          );
          if (outcome === "drift") {
            assert.deepEqual(provider.calls, ["probe"]);
            assert.equal(
              await store.compatibility(generation.profile),
              "semantic_model_drift",
            );
            assert.equal(
              (await store.generation(generation.id)).state,
              "paused",
            );
            assert.equal(batches.length, 1);
            assert(
              statuses.some((message) =>
                message.includes("semantic_model_drift"),
              ),
            );
          } else {
            assert.deepEqual(
              provider.calls,
              outcome === "cached" ? [] : ["probe", "index"],
            );
            assert.equal(
              (await store.generation(generation.id)).state,
              "completed",
            );
            assert.deepEqual(await store.coverage(generation.id), {
              eligible: 5,
              indexed: 5,
              pending: 0,
              failed: 0,
            });
            assert.equal(batches.length, outcome === "cached" ? 1 : 2);
            if (outcome === "missing")
              assert.equal(
                batches.find((row) => row.previous === batch.id)!.state,
                "completed",
              );
          }
        } finally {
          await background.close();
        }
      }));

test("a held input that becomes due before claim still receives a drift probe", async (t) =>
  fixture(async ({ store, scanner }) => {
    const { BackgroundSemanticIndexer } =
      await import("../src/semantic/background.ts");
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const docs = rows(5);
    const ctx = context(docs, hash(9670));
    const { generation, batch } = await failedBackgroundGeneration(
      store,
      docs,
      ctx,
      "failed",
    );
    const deadline = now + 1000;
    await store.holdBackgroundInputs(
      batch,
      {
        next_attempt: deadline,
        not_before: 0,
        sent_attempts: 4,
        refusals: 0,
        exhausted: true,
        reason: "embedding_provider",
      },
      false,
      now,
    );
    const provider = recordingEmbedder();
    const engine = new SemanticSearch(
      { profile: generation.profile, store, cache: store.queryCache, scanner },
      provider.assistance,
      true,
    );
    const background = new BackgroundSemanticIndexer({
      store,
      profile: generation.profile,
      view: generation.view,
      assistance: provider.assistance,
      source: async () => {
        throw new Error("A prepared retry needs no source read");
      },
      probe: (selected, selectedProfile) =>
        engine.probe(selected, selectedProfile),
      report: (error) => {
        throw error;
      },
    });
    const start = store.start.bind(store);
    store.start = async (id) => {
      assert.deepEqual(provider.calls, ["probe"]);
      now = deadline;
      await start(id);
    };
    try {
      await background.cycle();
      assert.deepEqual(provider.calls, ["probe", "index"]);
      assert.equal((await store.generation(generation.id)).state, "completed");
      assert.equal((await store.coverage(generation.id)).indexed, docs.length);
      const batches = await store.batches(generation.id);
      assert.equal(batches.length, 2);
      assert.equal(
        batches.find((row) => row.previous === batch.id)!.state,
        "completed",
      );
    } finally {
      store.start = start;
      await background.close();
    }
  }));

test("a snapshot change with complete exact coverage does not create a background generation", async () =>
  fixture(async ({ store, scanner, docs, ctx }) => {
    const { BackgroundSemanticIndexer } =
      await import("../src/semantic/background.ts");
    const engine = new SemanticSearch(
      { profile: profileId(profile), store, cache: store.queryCache, scanner },
      mock().assistance,
      true,
    );
    const changed = context(docs, hash(9600));
    const before = await store.current(
      profileId(profile),
      ctx.evaluation.selected_view,
    );
    const background = new BackgroundSemanticIndexer({
      store,
      profile: profileId(profile),
      view: ctx.evaluation.selected_view,
      needed: async () =>
        (await engine.profiles(changed)).some((row) => row.pending > 0),
      source: async () => {
        throw new Error("Complete coverage needs no source generation");
      },
      assistance: {
        embed: async () => {
          throw new Error("Complete coverage needs no provider");
        },
      },
      probe: async () => {
        throw new Error("Complete coverage needs no probe");
      },
      report: () => {},
    });
    try {
      await background.cycle();
      assert.equal(
        await store.current(profileId(profile), ctx.evaluation.selected_view),
        before,
      );
      assert.equal(
        await store.backgroundGeneration(
          profileId(profile),
          ctx.evaluation.selected_view,
        ),
        null,
      );
    } finally {
      await background.close();
    }
  }));

test("interrupted retirement resumes bounded cleanup with exact storage accounting", async () =>
  fixture(async ({ store, path, docs }) => {
    const targetDocs = rows(260);
    const target = await publish(
      store,
      targetDocs,
      context(targetDocs, hash(9700)),
    );
    await store.setBackgroundGeneration(target.id);
    await publish(store, docs, context(docs, hash(9701)));
    const latest = await publish(store, docs, context(docs, hash(9702)));
    await store.setBackgroundGeneration(latest.id);
    const connection = (
      store as unknown as {
        sql: import("../src/sqlite.ts").SqliteConnection;
      }
    ).sql;
    const exec = connection.exec.bind(connection);
    let deletions = 0;
    connection.exec = (sql, ...bindings) => {
      if (
        sql.startsWith("DELETE FROM semantic_associations") &&
        ++deletions === 129
      )
        throw new Error("Interrupted after the first retirement page");
      return exec(sql, ...bindings);
    };
    try {
      await assert.rejects(
        store.retire(target.id),
        /Interrupted after the first/,
      );
    } finally {
      connection.exec = exec;
    }
    assert.equal((await store.generation(target.id)).state, "retired");
    assert.equal(
      Number(
        exec(
          "SELECT COUNT(*) AS n FROM semantic_associations WHERE generation=?",
          target.id,
        )[0].n,
      ),
      132,
    );
    const reopened = new SqliteVectorStore(path);
    try {
      await reopened.pruneBackgroundGenerations(target.profile, target.view);
      assert.equal(
        Number(
          exec(
            "SELECT COUNT(*) AS n FROM semantic_associations WHERE generation=?",
            target.id,
          )[0].n,
        ),
        0,
      );
      assert.equal(
        Number(
          exec(
            "SELECT COUNT(*) AS n FROM semantic_batch_inputs WHERE generation=?",
            target.id,
          )[0].n,
        ),
        0,
      );
      assert.equal(
        Number(exec("SELECT COUNT(*) AS n FROM semantic_retirements")[0].n),
        0,
      );
      const stored = exec("SELECT * FROM semantic_usage WHERE id=1")[0];
      assert.equal(
        stored.associations,
        exec("SELECT COUNT(*) AS n FROM semantic_associations")[0].n,
      );
      assert.equal(
        stored.vectors,
        exec("SELECT COUNT(*) AS n FROM semantic_vectors")[0].n,
      );
      assert.equal(
        stored.bytes,
        Number(
          exec(
            "SELECT COALESCE(SUM(length(bytes)),0) AS n FROM semantic_inputs",
          )[0].n,
        ) +
          Number(
            exec(
              "SELECT COALESCE(SUM(length(bytes)),0) AS n FROM semantic_vectors",
            )[0].n,
          ),
      );
      assert.equal((await reopened.coverage(latest.id)).indexed, 4);
    } finally {
      reopened.close();
    }
  }));

test("profile coverage holds a generation lease across background publication and retirement", async () =>
  fixture(async ({ store, scanner, ctx, docs }) => {
    const initial = (await store.published(ctx.evaluation.selected_view))[0];
    await store.setBackgroundGeneration(initial.id);
    const engine = new SemanticSearch(
      { profile: initial.profile, store, cache: store.queryCache, scanner },
      mock().assistance,
      true,
    );
    const coverageFor = store.coverageFor.bind(store);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    store.coverageFor = async (...args) => {
      started = true;
      await gate;
      return coverageFor(...args);
    };
    const work = engine.profiles(ctx);
    try {
      while (!started)
        await new Promise<void>((resolve) => setImmediate(resolve));
      await publish(store, docs, context(docs, hash(9800)));
      const last = await publish(store, docs, context(docs, hash(9801)));
      await store.setBackgroundGeneration(last.id);
      await store.pruneBackgroundGenerations(initial.profile, initial.view);
      assert.equal((await store.generation(initial.id)).state, "completed");
      release();
      assert.equal((await work)[0].indexed, docs.length);
      await store.pruneBackgroundGenerations(initial.profile, initial.view);
      assert.equal((await store.generation(initial.id)).state, "retired");
    } finally {
      release();
      await work;
    }
  }));

test("an extraction rebuild embeds changed bytes and reuses unchanged inputs", async () =>
  fixture(async ({ store, scanner, docs, ctx }) => {
    const { BackgroundSemanticIndexer } =
      await import("../src/semantic/background.ts");
    const oldDocs = docs.map((row) => ({ ...row, extraction_version: 2 }));
    docs = docs.map((row, i) => {
      const input = i < 2 ? utf8(`New extraction recipe ${i}`) : row.input!;
      return { ...row, input, input_hash: inputHash(input) };
    });
    const old = await publish(store, oldDocs, ctx);
    const provider = recordingEmbedder();
    const embedded: string[] = [];
    const embed = provider.assistance.embed;
    provider.assistance.embed = async (inputs, ...args) => {
      if (args[0].kind === "index") embedded.push(...inputs.map(inputHash));
      return embed(inputs, ...args);
    };
    const engine = new SemanticSearch(
      { profile: old.profile, store, cache: store.queryCache, scanner },
      provider.assistance,
      true,
    );
    const background = new BackgroundSemanticIndexer({
      store,
      profile: old.profile,
      view: old.view,
      assistance: provider.assistance,
      needed: async () =>
        (await engine.profiles(ctx)).some((row) => row.pending > 0),
      source: async () => ({
        context: { ...old, eligible: docs.length },
        page: async () => ({
          documents: docs,
          next: docs.at(-1)!.event,
          done: true,
        }),
      }),
      probe: (generation, selected) => engine.probe(generation, selected),
      report: (error) => {
        throw error;
      },
    });
    try {
      await background.cycle();
      const current = (await store.current(old.profile, old.view))!;
      assert.notEqual(current, old.id);
      assert.deepEqual(provider.calls, ["probe", "index"]);
      assert.deepEqual(
        embedded.sort(),
        docs
          .slice(0, 2)
          .map((row) => row.input_hash!)
          .sort(),
      );
      assert.deepEqual(await store.coverage(current), {
        eligible: 4,
        indexed: 4,
        pending: 0,
        failed: 0,
      });
      assert.equal((await store.generation(current)).state, "completed");
      await background.cycle();
      assert.equal(await store.current(old.profile, old.view), current);
      assert.deepEqual(provider.calls, ["probe", "index"]);
    } finally {
      await background.close();
    }
  }));

test("a completed extraction repair with mismatched bindings waits before rebuilding again", async () =>
  fixture(async ({ store, scanner, docs, ctx, path }) => {
    const { BackgroundSemanticIndexer } =
      await import("../src/semantic/background.ts");
    let now = Date.now();
    const sql = new DatabaseSync(path);
    sql.prepare("UPDATE semantic_associations SET extraction_version=2").run();
    const identity = profileId(profile);
    const engine = new SemanticSearch(
      { profile: identity, store, cache: store.queryCache, scanner },
      recordingEmbedder().assistance,
      true,
    );
    let sources = 0;
    const statuses: string[] = [];
    const background = new BackgroundSemanticIndexer({
      store,
      profile: identity,
      view: ctx.evaluation.selected_view,
      now: () => now,
      assistance: recordingEmbedder().assistance,
      bindings: async () => expectedAssociations(ctx),
      status: (message) => statuses.push(message),
      needed: async () =>
        (await engine.profiles(ctx)).some((row) => row.pending > 0),
      source: async () => {
        sources++;
        return {
          context: {
            snapshot: ctx.snapshot.snapshot,
            view: ctx.evaluation.selected_view,
            profile: identity,
            eligible: docs.length,
          },
          page: async () => ({
            documents: docs.map((row) => ({
              ...row,
              word: hash(9970, "jvw1:"),
            })),
            next: docs.at(-1)!.event,
            done: true,
          }),
        };
      },
      probe: async () => {},
      report: (error) => {
        throw error;
      },
    });
    try {
      await background.cycle();
      const current = (await store.current(
        identity,
        ctx.evaluation.selected_view,
      ))!;
      assert.equal((await store.generation(current)).state, "completed");
      assert.equal((await engine.profiles(ctx))[0].pending, docs.length);
      const wait = (await store.backgroundWait(
        identity,
        ctx.evaluation.selected_view,
      ))!;
      assert.equal(wait.next_attempt, now + 60 * 60 * 1000);
      assert.equal(wait.snapshot, ctx.snapshot.snapshot);
      assert.deepEqual(statuses, [
        `Background semantic indexing for profile ${identity} and view ${ctx.evaluation.selected_view} paused: semantic_rebuild_pending. Retry at ${new Date(wait.next_attempt).toISOString()}.`,
      ]);
      now += 5000;
      await background.cycle();
      assert.equal(sources, 3);
      assert.equal(statuses.length, 1);
      assert.equal(
        await store.current(identity, ctx.evaluation.selected_view),
        current,
      );
      now = wait.next_attempt;
      await background.cycle();
      assert.equal(sources, 5);
      assert.equal(statuses.length, 2);
    } finally {
      await background.close();
      sql.close();
    }
  }));

test("due held inputs resume without calling a failing coverage callback", async (t) =>
  fixture(async ({ store, scanner }) => {
    const { BackgroundSemanticIndexer } =
      await import("../src/semantic/background.ts");
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const docs = rows(5);
    const ctx = context(docs, hash(9980));
    const { generation, batch } = await failedBackgroundGeneration(
      store,
      docs,
      ctx,
      "failed",
    );
    await store.holdBackgroundInputs(
      batch,
      {
        next_attempt: now + 1000,
        not_before: 0,
        sent_attempts: 4,
        refusals: 0,
        exhausted: true,
        reason: "embedding_provider",
      },
      false,
      now,
    );
    await store.start(generation.id);
    await store.finish(generation.id);
    assert.equal((await store.generation(generation.id)).state, "completed");
    await store.setBackgroundWait(generation.profile, generation.view, {
      next_attempt: now + 60 * 60 * 1000,
      not_before: 0,
      sent_attempts: 0,
      refusals: 0,
      exhausted: false,
      reason: "semantic_rebuild_pending",
      snapshot: generation.snapshot,
    });
    now += 1000;
    const provider = recordingEmbedder();
    const engine = new SemanticSearch(
      { profile: generation.profile, store, cache: store.queryCache, scanner },
      provider.assistance,
      true,
    );
    let needed = 0;
    const background = new BackgroundSemanticIndexer({
      store,
      profile: generation.profile,
      view: generation.view,
      assistance: provider.assistance,
      needed: async () => {
        needed++;
        throw new Error("Coverage is unavailable");
      },
      source: async () => ({
        context: { ...generation, eligible: docs.length },
        page: async () => {
          throw new Error("The prepared retry needs no page");
        },
      }),
      probe: (selected, p) => engine.probe(selected, p),
      report: (error) => {
        throw error;
      },
    });
    try {
      await background.cycle();
      assert.equal(needed, 0);
      assert.equal(
        await store.backgroundWait(generation.profile, generation.view),
        null,
      );
      assert.deepEqual(provider.calls, ["probe", "index"]);
      assert.deepEqual(await store.coverage(generation.id), {
        eligible: 5,
        indexed: 5,
        pending: 0,
        failed: 0,
      });
    } finally {
      await background.close();
    }
  }));

test("a coverage callback failure enters the guarded background wait", async () =>
  fixture(async ({ store, ctx }) => {
    const { BackgroundSemanticIndexer } =
      await import("../src/semantic/background.ts");
    const identity = profileId(profile);
    await store.setBackgroundGeneration(
      (await store.current(identity, ctx.evaluation.selected_view))!,
    );
    let calls = 0;
    const background = new BackgroundSemanticIndexer({
      store,
      profile: identity,
      view: ctx.evaluation.selected_view,
      assistance: recordingEmbedder().assistance,
      needed: async () => {
        calls++;
        throw new Error("Coverage is unavailable");
      },
      source: async () => {
        throw new Error("No source is needed");
      },
      probe: async () => {},
      report: () => {},
      status: () => {},
    });
    try {
      await background.cycle();
      assert.equal(
        (await store.backgroundWait(identity, ctx.evaluation.selected_view))!
          .reason,
        "background_index_failed",
      );
      await background.cycle();
      assert.equal(calls, 1);
    } finally {
      await background.close();
    }
  }));

test("a newer snapshot after extraction repair proceeds without the same-snapshot wait", async () =>
  fixture(async ({ store, scanner, docs, ctx, path }) => {
    const { BackgroundSemanticIndexer } =
      await import("../src/semantic/background.ts");
    const sql = new DatabaseSync(path);
    sql.prepare("UPDATE semantic_associations SET extraction_version=2").run();
    const identity = profileId(profile);
    const nextDocs = rows(5);
    const next = context(nextDocs, hash(9990));
    let latest = ctx;
    let now = Date.now();
    const provider = recordingEmbedder();
    const engine = new SemanticSearch(
      { profile: identity, store, cache: store.queryCache, scanner },
      provider.assistance,
      true,
    );
    const background = new BackgroundSemanticIndexer({
      store,
      profile: identity,
      view: ctx.evaluation.selected_view,
      assistance: provider.assistance,
      now: () => now,
      bindings: async (snapshot) =>
        expectedAssociations(snapshot === ctx.snapshot.snapshot ? ctx : next),
      needed: async () =>
        (await engine.profiles(latest)).some((row) => row.pending > 0),
      source: async () => {
        const selected = latest;
        const documents = selected === ctx ? docs : nextDocs;
        return {
          context: {
            snapshot: selected.snapshot.snapshot,
            view: selected.evaluation.selected_view,
            profile: identity,
            eligible: documents.length,
          },
          page: async () => {
            // A new completed snapshot arrives while the earlier source is prepared.
            latest = next;
            return { documents, next: documents.at(-1)!.event, done: true };
          },
        };
      },
      probe: (generation, selected) => engine.probe(generation, selected),
      report: (error) => {
        throw error;
      },
    });
    try {
      await background.cycle();
      const first = (await store.current(
        identity,
        ctx.evaluation.selected_view,
      ))!;
      assert.equal(
        (await store.generation(first)).snapshot,
        ctx.snapshot.snapshot,
      );
      assert.equal((await store.generation(first)).state, "completed");
      assert.equal((await engine.profiles(latest))[0].pending, 1);
      assert.equal(
        await store.backgroundWait(identity, ctx.evaluation.selected_view),
        null,
      );
      now += 5000;
      await background.cycle();
      const second = (await store.current(
        identity,
        ctx.evaluation.selected_view,
      ))!;
      assert.notEqual(second, first);
      assert.equal(
        (await store.generation(second)).snapshot,
        next.snapshot.snapshot,
      );
      assert.equal((await store.generation(second)).state, "completed");
      assert.deepEqual(await store.coverage(second), {
        eligible: 5,
        indexed: 5,
        pending: 0,
        failed: 0,
      });
      assert.deepEqual(provider.calls, ["probe", "index"]);
    } finally {
      await background.close();
      sql.close();
    }
  }));

test("concurrent paged profile coverage does not impose a false repair wait", async () =>
  fixture(async ({ store, scanner }) => {
    const { BackgroundSemanticIndexer } =
      await import("../src/semantic/background.ts");
    const docs = rows(129);
    const ctx = context(docs, hash(19980));
    const old = await publish(
      store,
      docs.map((row) => ({ ...row, extraction_version: 2 })),
      ctx,
    );
    const input = utf8("Changed extraction for first page");
    docs[0] = { ...docs[0], input, input_hash: inputHash(input) };
    const provider = recordingEmbedder();
    const engine = new SemanticSearch(
      { profile: old.profile, store, cache: store.queryCache, scanner },
      provider.assistance,
      true,
    );
    let latest = ctx;
    let concurrent: ReturnType<typeof engine.profiles> | undefined;
    let observePage = false;
    let firstPage!: () => void;
    const firstPageRead = new Promise<void>((resolve) => {
      firstPage = resolve;
    });
    // Observe the real first SQL page. Do not alter its rows or add a delay.
    const sql = (store as any).sql;
    const exec = sql.exec.bind(sql);
    sql.exec = (statement: string, ...args: unknown[]) => {
      const result = exec(statement, ...args);
      if (
        observePage &&
        statement.startsWith("SELECT a.*,v.input IS NOT NULL")
      ) {
        observePage = false;
        firstPage();
      }
      return result;
    };
    const embed = provider.assistance.embed;
    provider.assistance.embed = async (...args) => {
      const result = await embed(...args);
      if (args[1].kind === "index" && !concurrent) {
        observePage = true;
        concurrent = engine.profiles(ctx);
        await firstPageRead;
      }
      return result;
    };
    let now = Date.now();
    const nextDocs = [...docs, rows(130)[129]];
    let sources = 0;
    const background = new BackgroundSemanticIndexer({
      store,
      profile: old.profile,
      view: old.view,
      assistance: provider.assistance,
      now: () => now,
      bindings: async (snapshot) =>
        expectedAssociations(snapshot === ctx.snapshot.snapshot ? ctx : latest),
      needed: async () =>
        (await engine.profiles(latest)).some((p) => p.pending > 0),
      source: async () => {
        sources++;
        const selected = latest;
        const documents = selected === ctx ? docs : nextDocs;
        return {
          context: {
            snapshot: selected.snapshot.snapshot,
            view: old.view,
            profile: old.profile,
            eligible: documents.length,
          },
          page: async (after: string | null) => {
            const offset =
              after === null
                ? 0
                : documents.findIndex((row) => row.event === after) + 1;
            const page = documents.slice(offset, offset + 128);
            return {
              documents: page,
              next: page.at(-1)!.event,
              done: offset + page.length === documents.length,
            };
          },
        };
      },
      probe: (generation, profile) => engine.probe(generation, profile),
      report: (error) => {
        throw error;
      },
    });
    try {
      await background.cycle();
      const id = (await store.current(old.profile, old.view))!;
      assert.equal((await store.generation(id)).state, "completed");
      assert.equal((await store.coverage(id)).pending, 0);
      assert.equal((await concurrent!)[0].pending, 1);
      assert.equal((await engine.profiles(ctx))[0].pending, 0);
      assert.equal(await store.backgroundWait(old.profile, old.view), null);
      latest = context(nextDocs, hash(19981));
      now += 5000;
      await background.cycle();
      const nextId = (await store.current(old.profile, old.view))!;
      assert.notEqual(nextId, id);
      assert.equal(
        (await store.generation(nextId)).snapshot,
        latest.snapshot.snapshot,
      );
      assert.equal((await store.generation(nextId)).state, "completed");
      assert.deepEqual(await store.coverage(nextId), {
        eligible: 130,
        indexed: 130,
        pending: 0,
        failed: 0,
      });
      assert.equal((await engine.profiles(latest))[0].pending, 0);
      assert.equal(await store.backgroundWait(old.profile, old.view), null);
      assert.deepEqual(provider.calls, ["probe", "index", "index"]);
    } finally {
      sql.exec = exec;
      await background.close();
      await concurrent;
    }
  }));

test("a newer snapshot bypasses a saved repair wait after restarting the indexer", async () =>
  fixture(async ({ store, scanner, docs, ctx, path }) => {
    const { BackgroundSemanticIndexer } =
      await import("../src/semantic/background.ts");
    const sql = new DatabaseSync(path);
    sql.prepare("UPDATE semantic_associations SET extraction_version=2").run();
    const identity = profileId(profile);
    let latest = ctx;
    let now = Date.now();
    const nextDocs = rows(5);
    const next = context(nextDocs, hash(19990));
    const provider = recordingEmbedder();
    const engine = new SemanticSearch(
      { profile: identity, store, cache: store.queryCache, scanner },
      provider.assistance,
      true,
    );
    const options = {
      store,
      profile: identity,
      view: ctx.evaluation.selected_view,
      assistance: provider.assistance,
      now: () => now,
      bindings: async (snapshot: string) =>
        expectedAssociations(snapshot === ctx.snapshot.snapshot ? ctx : next),
      needed: async () =>
        (await engine.profiles(latest)).some((row) => row.pending > 0),
      source: async () => {
        const selected = latest;
        const documents =
          selected === ctx
            ? docs.map((row) => ({ ...row, word: hash(19991, "jvw1:") }))
            : nextDocs;
        return {
          context: {
            snapshot: selected.snapshot.snapshot,
            profile: identity,
            view: selected.evaluation.selected_view,
            eligible: documents.length,
          },
          page: async () => ({
            documents,
            next: documents.at(-1)!.event,
            done: true,
          }),
        };
      },
      probe: (
        generation: Parameters<typeof engine.probe>[0],
        selected: Parameters<typeof engine.probe>[1],
      ) => engine.probe(generation, selected),
      report: (error: unknown) => {
        throw error;
      },
      status: () => {},
    };
    let background = new BackgroundSemanticIndexer(options);
    try {
      await background.cycle();
      const first = (await store.current(identity, options.view))!;
      const wait = (await store.backgroundWait(identity, options.view))!;
      assert.equal(wait.reason, "semantic_rebuild_pending");
      assert.equal(wait.snapshot, ctx.snapshot.snapshot);
      assert.equal(wait.next_attempt, now + 60 * 60 * 1000);
      await background.close();
      background = new BackgroundSemanticIndexer(options);
      now += 5000;
      await background.cycle();
      assert.equal(await store.current(identity, options.view), first);
      assert.deepEqual(
        await store.backgroundWait(identity, options.view),
        wait,
      );
      latest = next;
      await background.cycle();
      const second = (await store.current(identity, options.view))!;
      assert.notEqual(second, first);
      assert.equal(
        (await store.generation(second)).snapshot,
        next.snapshot.snapshot,
      );
      assert.deepEqual(await store.coverage(second), {
        eligible: 5,
        indexed: 5,
        pending: 0,
        failed: 0,
      });
      assert.equal(await store.backgroundWait(identity, options.view), null);
    } finally {
      await background.close();
      sql.close();
    }
  }));

test("completion repeats direct coverage when its SQLite revision changes between pages", async () =>
  fixture(async ({ store, scanner, path }) => {
    const { BackgroundSemanticIndexer } =
      await import("../src/semantic/background.ts");
    const docs = rows(129);
    const ctx = context(docs, hash(19995));
    const old = await publish(
      store,
      docs.map((row) => ({ ...row, extraction_version: 2 })),
      ctx,
    );
    const provider = recordingEmbedder();
    const engine = new SemanticSearch(
      { profile: old.profile, store, cache: store.queryCache, scanner },
      provider.assistance,
      true,
    );
    const sql = (store as any).sql;
    const exec = sql.exec.bind(sql);
    const writer = new DatabaseSync(path);
    let direct = false;
    let changed = false;
    let scans = 0;
    const coverage = store.coverageFor.bind(store);
    store.coverageFor = async (...args) => {
      if (direct) scans++;
      return coverage(...args);
    };
    sql.exec = (statement: string, ...args: unknown[]) => {
      const result = exec(statement, ...args);
      if (
        direct &&
        !changed &&
        statement.startsWith("SELECT a.*,v.input IS NOT NULL")
      ) {
        changed = true;
        writer
          .prepare(
            "UPDATE semantic_associations SET word=? WHERE generation=? AND event=?",
          )
          .run(docs[0].word, String(args[2]), docs[0].event);
      }
      return result;
    };
    const background = new BackgroundSemanticIndexer({
      store,
      profile: old.profile,
      view: old.view,
      assistance: provider.assistance,
      needed: async () =>
        (await engine.profiles(ctx)).some((row) => row.pending > 0),
      bindings: async () => {
        direct = true;
        return expectedAssociations(ctx);
      },
      source: async () => ({
        context: { ...old, eligible: docs.length },
        page: async (after) => {
          const offset =
            after === null
              ? 0
              : docs.findIndex((row) => row.event === after) + 1;
          const documents = docs
            .slice(offset, offset + 128)
            .map((row) =>
              row.event === docs[0].event
                ? { ...row, word: hash(19996, "jvw1:") }
                : row,
            );
          return {
            documents,
            next: documents.at(-1)!.event,
            done: offset + documents.length === docs.length,
          };
        },
      }),
      probe: async () => {},
      report: (error) => {
        throw error;
      },
    });
    try {
      await background.cycle();
      assert.equal(changed, true);
      assert.equal(scans, 2);
      assert.equal(await store.backgroundWait(old.profile, old.view), null);
      assert.deepEqual(provider.calls, []);
    } finally {
      sql.exec = exec;
      store.coverageFor = coverage;
      writer.close();
      await background.close();
    }
  }));

test("a completed repair keeps its completed state when direct coverage fails", async () =>
  fixture(async ({ store, scanner, path, docs, ctx }) => {
    const { BackgroundSemanticIndexer } =
      await import("../src/semantic/background.ts");
    const sql = new DatabaseSync(path);
    sql.prepare("UPDATE semantic_associations SET extraction_version=2").run();
    const identity = profileId(profile);
    const old = await store.current(identity, ctx.evaluation.selected_view);
    const provider = recordingEmbedder();
    const engine = new SemanticSearch(
      { profile: identity, store, cache: store.queryCache, scanner },
      provider.assistance,
      true,
    );
    const background = new BackgroundSemanticIndexer({
      store,
      profile: identity,
      view: ctx.evaluation.selected_view,
      assistance: provider.assistance,
      needed: async () =>
        (await engine.profiles(ctx)).some((row) => row.pending > 0),
      source: async () => ({
        context: {
          snapshot: ctx.snapshot.snapshot,
          view: ctx.evaluation.selected_view,
          profile: identity,
          eligible: docs.length,
        },
        page: async () => ({
          documents: docs,
          next: docs.at(-1)!.event,
          done: true,
        }),
      }),
      bindings: async () => {
        throw new Error("Current bindings are unavailable");
      },
      probe: async () => {
        throw new Error("Cached vectors need no probe");
      },
      report: (error) => {
        throw error;
      },
      status: () => {},
    });
    try {
      await background.cycle();
      const current = (await store.current(
        identity,
        ctx.evaluation.selected_view,
      ))!;
      assert.notEqual(current, old);
      const completed = await store.generation(current, true);
      assert.equal(completed.state, "completed");
      assert.equal(completed.background_recovery, undefined);
      assert.equal(
        (await store.backgroundWait(identity, ctx.evaluation.selected_view))!
          .reason,
        "background_index_failed",
      );
      assert.deepEqual(provider.calls, []);
    } finally {
      await background.close();
      sql.close();
    }
  }));

for (const reason of ["semantic_rebuild_pending", "embedding_busy"])
  test(`a newer snapshot bypasses only an unbound legacy repair wait (${reason})`, async () =>
    fixture(async ({ store, scanner, ctx }) => {
      const { BackgroundSemanticIndexer } =
        await import("../src/semantic/background.ts");
      const identity = profileId(profile);
      const view = ctx.evaluation.selected_view;
      const first = await store.current(identity, view);
      const docs = rows(5);
      const latest = context(docs, hash(19998));
      const wait = {
        next_attempt: Date.now() + 60 * 60 * 1000,
        not_before: 0,
        sent_attempts: 0,
        refusals: 0,
        exhausted: false,
        reason,
      };
      await store.setBackgroundWait(identity, view, wait);
      const provider = recordingEmbedder();
      const engine = new SemanticSearch(
        { profile: identity, store, cache: store.queryCache, scanner },
        provider.assistance,
        true,
      );
      let sources = 0;
      const background = new BackgroundSemanticIndexer({
        store,
        profile: identity,
        view,
        assistance: provider.assistance,
        needed: async () =>
          (await engine.profiles(latest)).some((row) => row.pending > 0),
        bindings: async () => expectedAssociations(latest),
        source: async () => {
          sources++;
          return {
            context: {
              snapshot: latest.snapshot.snapshot,
              profile: identity,
              view,
              eligible: docs.length,
            },
            page: async () => ({
              documents: docs,
              next: docs.at(-1)!.event,
              done: true,
            }),
          };
        },
        probe: (generation, selected) => engine.probe(generation, selected),
        report: (error) => {
          throw error;
        },
      });
      try {
        await background.cycle();
        if (reason === "semantic_rebuild_pending") {
          assert.notEqual(await store.current(identity, view), first);
          assert.equal((await engine.profiles(latest))[0].pending, 0);
          assert.equal(await store.backgroundWait(identity, view), null);
        } else {
          assert.equal(await store.current(identity, view), first);
          assert.equal(sources, 0);
          assert.deepEqual(provider.calls, []);
          assert.deepEqual(await store.backgroundWait(identity, view), wait);
        }
      } finally {
        await background.close();
      }
    }));

for (const cooldown of [false, true])
  test(`a stale due-input resume leaves the next cycle free to rebuild (cooldown: ${cooldown})`, async (t) =>
    fixture(async ({ store, scanner }) => {
      const { BackgroundSemanticIndexer } =
        await import("../src/semantic/background.ts");
      let now = Date.now();
      t.mock.method(Date, "now", () => now);
      const docs = rows(2).map((row, i) => {
        const input = utf8(`Stale retry definition ${i}`);
        return { ...row, input, input_hash: inputHash(input) };
      });
      const ctx = context(docs, hash(20001));
      const identity = profileId(profile);
      const view = ctx.evaluation.selected_view;
      const generation = await store.create(
        {
          snapshot: ctx.snapshot.snapshot,
          view,
          profile: identity,
          eligible: docs.length,
        },
        profile,
      );
      await store.stage(generation.id, null, {
        documents: docs.map((row) => ({ ...row, extraction_version: 2 })),
        next: docs.at(-1)!.event,
        done: true,
      });
      await store.setBackgroundGeneration(generation.id);
      await store.start(generation.id);
      const batch = (await store.claim(generation.id))!;
      await store.fail(batch.id, "embedding_provider");
      await store.pause(generation.id, "embedding_provider");
      await store.holdBackgroundInputs(
        batch,
        {
          next_attempt: now,
          not_before: 0,
          sent_attempts: 4,
          refusals: 0,
          exhausted: true,
          reason: "embedding_provider",
        },
        false,
        now,
      );
      await store.start(generation.id);
      await store.finish(generation.id);
      assert.equal((await store.generation(generation.id)).state, "completed");
      assert(
        await store.publish(generation.id, await store.current(identity, view)),
      );
      const provider = recordingEmbedder();
      const engine = new SemanticSearch(
        { profile: identity, store, cache: store.queryCache, scanner },
        provider.assistance,
        true,
      );
      let ordinary = false;
      let neededReads = 0;
      let bindingReads = 0;
      let pages = 0;
      const options = {
        store,
        profile: identity,
        view,
        assistance: provider.assistance,
        now: () => now,
        needed: async () => {
          assert.equal(
            ordinary,
            true,
            "Retry cycles must skip shared coverage",
          );
          neededReads++;
          return (await engine.profiles(ctx)).some((row) => row.pending > 0);
        },
        bindings: async () => {
          bindingReads++;
          return expectedAssociations(ctx);
        },
        source: async () => ({
          context: {
            snapshot: ctx.snapshot.snapshot,
            view,
            profile: identity,
            eligible: docs.length,
          },
          page: async () => {
            pages++;
            return { documents: docs, next: docs.at(-1)!.event, done: true };
          },
        }),
        probe: async () => {
          throw new Error(
            "The initial retry has no reference vectors and the rebuild reuses its vectors",
          );
        },
        report: (error: unknown) => {
          throw error;
        },
        status: () => {},
      };
      let background = new BackgroundSemanticIndexer(options);
      try {
        if (cooldown) await store.defer(identity, now + 1000, now);
        await background.cycle();
        if (cooldown) {
          assert.equal((await store.generation(generation.id)).state, "paused");
          assert.deepEqual(provider.calls, []);
          assert.equal(await store.backgroundWait(identity, view), null);
          now += 5000;
          await background.close();
          background = new BackgroundSemanticIndexer(options);
          await background.cycle();
        }
        assert.equal(
          (await store.generation(generation.id)).state,
          "completed",
        );
        assert.equal(await store.current(identity, view), generation.id);
        assert.equal(neededReads, 0);
        assert.equal(bindingReads, 0);
        assert.equal(pages, 0);
        assert.equal(await store.backgroundWait(identity, view), null);
        assert.deepEqual(provider.calls, ["index", "index"]);
        assert.deepEqual(
          (await store.coverageFor(generation.id, expectedAssociations(ctx)))
            .all,
          { eligible: 2, indexed: 0, pending: 2, failed: 0 },
        );
        ordinary = true;
        now += 5000;
        await background.cycle();
        const current = (await store.current(identity, view))!;
        assert.notEqual(current, generation.id);
        assert.equal(
          (await store.generation(current)).snapshot,
          ctx.snapshot.snapshot,
        );
        assert.equal((await store.generation(current)).state, "completed");
        assert(
          (await store.page(current)).rows.every(
            (row) => row.extraction_version === semanticProjectionVersion(),
          ),
        );
        assert.deepEqual(await store.coverage(current), {
          eligible: 2,
          indexed: 2,
          pending: 0,
          failed: 0,
        });
        assert.equal(neededReads, 1);
        assert.equal(bindingReads, 1);
        assert.equal(pages, 1);
        assert.equal(await store.backgroundWait(identity, view), null);
        assert.deepEqual(provider.calls, ["index", "index"]);
      } finally {
        await background.close();
      }
    }));
