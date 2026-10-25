import assert from "node:assert/strict";
import { before, test } from "node:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  initializeCore,
  utf8,
  wordId,
  type Evaluation,
} from "../../core/src/index.ts";
import {
  closeSemanticIndexHost,
  SqliteVectorStore,
} from "../../../apps/server/src/semantic.ts";
import { lockDataDirectory } from "../../importer/src/load-lock.ts";
import { SqliteAssistanceBudgetStore } from "../../../apps/server/src/assistance.ts";
import { AssistanceService } from "../src/assistance.ts";
import { AssistanceError, providerConfig } from "../src/inference.ts";
import {
  createQwenProfile,
  inputHash,
  profileId,
} from "../src/semantic/profile.ts";
import {
  SemanticIndexer,
  type IndexEmbedder,
} from "../src/semantic/indexer.ts";
import { DEFAULT_VECTOR_LIMITS } from "../src/semantic/sql-vector-store.ts";
import {
  eligibleSemanticSource,
  type IndexDocument,
  type SemanticSource,
} from "../src/semantic/source.ts";
import { projectSemanticRecord } from "../src/semantic/storage.ts";
import { semanticDocument } from "../src/semantic/records.ts";
import type { Coordinator, Snapshot } from "../src/storage.ts";

before(async () =>
  initializeCore(
    await readFile(
      new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  ),
);
const hash = (n: number, prefix = "sha256:") =>
  prefix + n.toString(16).padStart(64, "0");
const profile = () => createQwenProfile("12".repeat(16));
const unit = () => Float32Array.from({ length: 4096 }, (_, i) => (i ? 0 : 1));
const usage = { inputTokens: 20, totalTokens: 20, costUsd: 0.0000002 };
const base = process.env.JVC_TEST_ROOT ?? tmpdir();
async function fixture(
  run: (store: SqliteVectorStore, path: string) => Promise<void>,
  limits = DEFAULT_VECTOR_LIMITS,
) {
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "vectors-"));
  const path = join(directory, "vectors.sqlite");
  const store = new SqliteVectorStore(path, limits);
  try {
    await run(store, path);
  } finally {
    store.close();
    await rm(directory, { recursive: true });
  }
}
function documents(count: number, duplicates = false): IndexDocument[] {
  return Array.from({ length: count }, (_, i) => {
    const input = utf8(`Public definition ${duplicates ? 0 : i}.`);
    return {
      event: hash(i + 1, "jve1:"),
      envelope: hash(i + 300),
      body: hash(i + 600),
      extraction_version: 1,
      word: hash(i + 1000, "jvw1:"),
      language: i % 2 ? "en" : "ru",
      input,
      input_hash: inputHash(input),
      error: null,
    };
  });
}
function source(
  rows: IndexDocument[],
  snapshot = hash(2000),
  p = profile(),
): SemanticSource {
  return {
    context: {
      snapshot,
      view: hash(2100, "jve1:"),
      profile: profileId(p),
      eligible: rows.length,
    },
    async page(after, limit) {
      const remaining = rows.filter(
        (row) => after === null || row.event > after,
      );
      const selected = remaining.slice(0, limit);
      return {
        documents: selected,
        next: selected.at(-1)?.event ?? after,
        done: selected.length === remaining.length,
      };
    },
  };
}
function embedder(
  onSend?: (inputs: readonly Uint8Array[], operation: string) => Promise<void>,
): IndexEmbedder & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async embed(inputs, caller, signal, beforeSend) {
      assert.equal(caller.kind, "index");
      assert.equal(signal, undefined);
      const operation = `embedding:index:${crypto.randomUUID()}`;
      await beforeSend!(operation);
      calls.push(inputs.map(inputHash));
      await onSend?.(inputs, operation);
      return {
        operation,
        model: "qwen/qwen3-embedding-8b",
        vectors: inputs.map(unit),
        usage,
      };
    },
  };
}
async function prepared(
  store: SqliteVectorStore,
  rows: IndexDocument[],
  snapshot?: string,
  p = profile(),
) {
  const input = source(rows, snapshot, p);
  const job = await store.create(input.context, p);
  await new SemanticIndexer(store, embedder()).prepare(job.id, input);
  return job;
}

test("preparation and vector reads use bounded pages and exact associations", async () =>
  fixture(async (store) => {
    const rows = documents(260);
    const input = source(rows);
    const job = await store.create(input.context, profile());
    const indexer = new SemanticIndexer(store, embedder());
    assert.equal(
      (await indexer.prepare(job.id, input, 1)).cursor,
      rows[127].event,
    );
    assert.equal((await store.coverage(job.id)).pending, 260);
    await assert.rejects(store.publish(job.id, null), /incomplete/);
    await assert.rejects(store.page(job.id), /incomplete/);
    await indexer.prepare(job.id, input);
    const first = await store.page(job.id);
    assert.equal(first.rows.length, 128);
    assert.equal(first.next, rows[127].event);
    const second = await store.page(job.id, first.next);
    const third = await store.page(job.id, second.next);
    assert.equal(third.rows.length, 4);
    assert.equal(third.next, null);
    const { input: _, ...expected } = rows[0];
    assert.deepEqual(first.rows[0], { ...expected, vector: null });
    assert.equal((await store.page(job.id, null, 128, "en")).rows.length, 128);
    await assert.rejects(store.page(job.id, null, 129), /page permits/);
    await assert.rejects(
      indexer.prepare(job.id, source(rows, hash(4000))),
      /source differs/,
    );
  }));

test("identical inputs share fresh vectors without merging events or bodies", async () =>
  fixture(async (store) => {
    const rows = documents(10, true);
    const job = await prepared(store, rows);
    const provider = embedder();
    const result = await new SemanticIndexer(store, provider).run(job.id);
    assert.deepEqual(result.coverage, {
      eligible: 10,
      indexed: 10,
      pending: 0,
      failed: 0,
    });
    assert.equal(provider.calls.length, 1);
    assert.equal(provider.calls[0].length, 1);
    assert.deepEqual(await store.summary(job.id), {
      batches: 1,
      dispatch_intents: 1,
      completed_batches: 1,
      completed_inputs: 1,
      failed_batches: 0,
      ambiguous_batches: 0,
      known_input_tokens: 20,
      unknown_token_batches: 0,
      reported_cost_usd: usage.costUsd,
      unknown_cost_batches: 0,
    });
    assert.equal(
      new Set((await store.page(job.id)).rows.map((row) => row.body)).size,
      10,
    );
    const nextRows = rows.map((row) => ({
      ...row,
      envelope: hash(3000),
      body: hash(3001),
    }));
    const next = await prepared(store, nextRows, hash(2001));
    await new SemanticIndexer(store, provider).run(next.id);
    assert.equal(provider.calls.length, 1);
    assert.equal((await store.page(next.id)).rows[0].body, hash(3001));
    const changed = documents(1);
    changed[0].input = utf8("A changed meaning.");
    changed[0].input_hash = inputHash(changed[0].input);
    const changedJob = await prepared(store, changed, hash(2002));
    assert.equal((await store.coverage(changedJob.id)).pending, 1);
    const alternate = createQwenProfile("34".repeat(16));
    const other = await prepared(store, rows, hash(2003), alternate);
    assert.equal((await store.coverage(other.id)).pending, 10);
  }));

test("partial indexing resumes only unfinished inputs and uses bounded concurrent batches", async () =>
  fixture(async (store) => {
    const job = await prepared(store, documents(25));
    let active = 0;
    let peak = 0;
    const provider = embedder(async (_, operation) => {
      peak = Math.max(peak, ++active);
      assert(
        (await store.batches(job.id)).some(
          (batch) => batch.operation === operation && batch.state === "sent",
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 4));
      active--;
    });
    const indexer = new SemanticIndexer(store, provider);
    const partial = await indexer.run(job.id, { maxBatches: 1 });
    assert.equal(partial.coverage.indexed, 8);
    assert.equal(partial.generation.state, "paused");
    const completed = await indexer.run(job.id, { concurrency: 2 });
    assert.equal(completed.generation.state, "completed");
    assert.equal(peak, 2);
    assert.equal(provider.calls.length, 4);
    assert.equal(new Set(provider.calls.flat()).size, 25);
    await indexer.run(job.id);
    assert.equal(provider.calls.length, 4);
  }));

test("ambiguous batches survive reopen and need an explicit linked retry", async () =>
  fixture(async (store, path) => {
    const job = await prepared(store, documents(2));
    const provider = embedder(async () => {
      throw new Error("A simulated lost response.");
    });
    await new SemanticIndexer(store, provider).run(job.id);
    const old = (await store.batches(job.id))[0];
    assert.equal(old.state, "ambiguous");
    assert(old.operation?.startsWith("embedding:index:"));
    assert.equal((await store.summary(job.id)).unknown_cost_batches, 1);
    assert.equal((await store.summary(job.id)).reported_cost_usd, 0);
    const reopened = new SqliteVectorStore(path);
    try {
      await reopened.recover(job.id);
      const successful = embedder();
      const indexer = new SemanticIndexer(reopened, successful);
      const skipped = await indexer.run(job.id);
      assert.equal(successful.calls.length, 0);
      assert.equal(skipped.coverage.failed, 2);
      await reopened.retry(old.id);
      await indexer.run(job.id);
      const batches = await reopened.batches(job.id);
      assert.equal(successful.calls.length, 1);
      assert.equal(
        batches.find((batch) => batch.previous === old.id)?.state,
        "completed",
      );
      assert.deepEqual(
        batches.find((batch) => batch.id === old.id),
        old,
      );
      await assert.rejects(reopened.retry(old.id), /Pause the generation/);
    } finally {
      reopened.close();
    }
  }));

test("interrupted prepared and sent batches never enter automatic resume", async () =>
  fixture(async (store) => {
    const job = await prepared(store, documents(17));
    await store.start(job.id);
    const first = (await store.claim(job.id))!;
    const second = (await store.claim(job.id))!;
    await store.sent(second.id, "embedding:index:interrupted");
    await store.recover(job.id);
    assert.equal(
      (await store.batches(job.id)).find((batch) => batch.id === first.id)
        ?.state,
      "failed",
    );
    assert.equal(
      (await store.batches(job.id)).find((batch) => batch.id === second.id)
        ?.state,
      "ambiguous",
    );
    const provider = embedder();
    const result = await new SemanticIndexer(store, provider).run(job.id);
    assert.equal(provider.calls.length, 1);
    assert.equal(result.coverage.indexed, 1);
    assert.equal(result.coverage.failed, 16);
  }));

test("snapshot publication is atomic, retains rollback, and prevents retirement of served generations", async () =>
  fixture(async (store) => {
    const old = await prepared(store, documents(3));
    assert.equal(await store.publish(old.id, null), true);
    const next = await prepared(store, documents(1), hash(2001));
    assert.equal(await store.publish(next.id, null), false);
    assert.equal(await store.current(old.profile, old.view), old.id);
    assert.equal(await store.publish(next.id, old.id), true);
    assert.deepEqual(await store.coverage(next.id), {
      eligible: 1,
      indexed: 0,
      pending: 1,
      failed: 0,
    });
    await assert.rejects(store.retire(old.id), /rollback reference/);
    assert.equal(await store.rollback(old.profile, old.view, next.id), old.id);
    await assert.rejects(
      store.rollback(old.profile, old.view, next.id),
      /publication changed/,
    );
    const latest = await prepared(store, [], hash(2002));
    assert.equal(await store.publish(latest.id, old.id), true);
    await store.retire(next.id);
    assert.equal((await store.generation(next.id)).state, "retired");
    await assert.rejects(store.page(next.id), /retired/);
    assert.equal((await store.coverage(old.id)).eligible, 3);
  }));

test("a failed publication transaction preserves the preceding current pointer", async () =>
  fixture(async (store, path) => {
    const old = await prepared(store, documents(1));
    const next = await prepared(store, documents(2), hash(2001));
    await store.publish(old.id, null);
    const database = new DatabaseSync(path);
    try {
      database.exec(
        "CREATE TRIGGER fail_semantic_publication BEFORE UPDATE ON semantic_current BEGIN SELECT RAISE(ABORT,'injected publication failure'); END",
      );
      await assert.rejects(
        store.publish(next.id, old.id),
        /injected publication failure/,
      );
      assert.equal(await store.current(old.profile, old.view), old.id);
      database.exec("DROP TRIGGER fail_semantic_publication");
      assert.equal(await store.publish(next.id, old.id), true);
    } finally {
      database.close();
    }
  }));

test("retirement frees orphaned bytes and keeps vectors used by another generation", async () =>
  fixture(async (store, path) => {
    const old = await prepared(store, documents(2));
    await new SemanticIndexer(store, embedder()).run(old.id);
    const next = await prepared(store, documents(1), hash(2001));
    await store.retire(old.id);
    assert.equal((await store.coverage(next.id)).indexed, 1);
    const database = new DatabaseSync(path);
    try {
      assert.equal(
        database.prepare("SELECT COUNT(*) AS n FROM semantic_vectors").get()!.n,
        1,
      );
      await store.retire(next.id);
      assert.deepEqual(
        database
          .prepare("SELECT associations,vectors,bytes FROM semantic_usage")
          .get(),
        Object.assign(Object.create(null), {
          associations: 0,
          vectors: 0,
          bytes: 0,
        }),
      );
    } finally {
      database.close();
    }
  }));

test("unpublish compares the exact current generation and preserves other profile and view pointers", async () =>
  fixture(async (store, path) => {
    const old = await prepared(store, documents(2));
    await new SemanticIndexer(store, embedder()).run(old.id);
    await store.publish(old.id, null);
    const current = await prepared(store, documents(1), hash(2001));
    await new SemanticIndexer(store, embedder()).run(current.id);
    await store.publish(current.id, old.id);
    const otherViewSource = source(documents(1), hash(2002));
    otherViewSource.context.view = hash(2200, "jve1:");
    const otherView = await store.create(otherViewSource.context, profile());
    await new SemanticIndexer(store, embedder()).prepare(
      otherView.id,
      otherViewSource,
    );
    await store.publish(otherView.id, null);
    const otherProfile = await prepared(
      store,
      documents(1),
      hash(2003),
      createQwenProfile("78".repeat(16)),
    );
    await new SemanticIndexer(store, embedder()).run(otherProfile.id);
    await store.publish(otherProfile.id, null);
    const database = new DatabaseSync(path);
    try {
      const pointers = () =>
        database
          .prepare("SELECT * FROM semantic_current ORDER BY profile,view")
          .all();
      const before = pointers();
      assert.equal(
        await store.unpublish(current.profile, current.view, old.id),
        false,
      );
      assert.equal(
        await store.unpublish(current.profile, current.view, otherProfile.id),
        false,
      );
      assert.equal(
        await store.unpublish(current.profile, otherView.view, current.id),
        false,
      );
      assert.deepEqual(pointers(), before);
      const associations = database
        .prepare("SELECT COUNT(*) AS n FROM semantic_associations")
        .get()!.n;
      const vectors = database
        .prepare("SELECT COUNT(*) AS n FROM semantic_vectors")
        .get()!.n;
      assert.equal(
        await store.unpublish(current.profile, current.view, current.id),
        true,
      );
      assert.equal(await store.current(current.profile, current.view), null);
      assert.equal(
        await store.current(otherView.profile, otherView.view),
        otherView.id,
      );
      assert.equal(
        await store.current(otherProfile.profile, otherProfile.view),
        otherProfile.id,
      );
      assert.equal(
        database
          .prepare("SELECT COUNT(*) AS n FROM semantic_associations")
          .get()!.n,
        associations,
      );
      assert.equal(
        database.prepare("SELECT COUNT(*) AS n FROM semantic_vectors").get()!.n,
        vectors,
      );
      await store.retire(current.id);
      await store.retire(old.id);
      assert.equal((await store.generation(current.id)).state, "retired");
      assert.equal((await store.generation(old.id)).state, "retired");
      assert.equal((await store.coverage(otherView.id)).indexed, 1);
      assert.equal((await store.coverage(otherProfile.id)).indexed, 1);
      assert.equal(
        database.prepare("SELECT COUNT(*) AS n FROM semantic_vectors").get()!.n,
        2,
      );
      await assert.rejects(store.retire(otherView.id), /rollback reference/);
      await assert.rejects(store.retire(otherProfile.id), /rollback reference/);
    } finally {
      database.close();
    }
  }));

test("unpublish lets a suspended profile retire and frees capacity for its fresh replacement", async () =>
  fixture(
    async (store, path) => {
      const old = await prepared(store, documents(2));
      await new SemanticIndexer(store, embedder()).run(old.id);
      await store.publish(old.id, null);
      await store.suspend(old.profile, "embedding_model_mismatch");
      const next = await prepared(
        store,
        documents(2),
        hash(2001),
        createQwenProfile("90".repeat(16)),
      );
      await store.publish(next.id, null);
      const replacement = new SemanticIndexer(store, embedder());
      assert.equal(
        (await replacement.run(next.id)).generation.error,
        "semantic_capacity",
      );
      await assert.rejects(store.retire(old.id), /rollback reference/);
      assert.equal(await store.unpublish(old.profile, old.view, old.id), true);
      assert.equal(
        await store.compatibility(old.profile),
        "embedding_model_mismatch",
      );
      await store.retire(old.id);
      assert.equal(await store.current(next.profile, next.view), next.id);
      const database = new DatabaseSync(path);
      try {
        assert.equal(
          database
            .prepare(
              "SELECT COUNT(*) AS n FROM semantic_vectors WHERE profile=?",
            )
            .get(old.profile)!.n,
          0,
        );
      } finally {
        database.close();
      }
      const failed = (await store.batches(next.id))[0];
      await store.retry(failed.id);
      assert.equal((await replacement.run(next.id)).coverage.indexed, 2);
    },
    { ...DEFAULT_VECTOR_LIMITS, vectors: 2 },
  ));

test("unpublish keeps retirement guards for running jobs and prepared or sent batches", async () =>
  fixture(async (store) => {
    const job = await prepared(store, documents(1));
    await store.publish(job.id, null);
    await store.start(job.id);
    const batch = (await store.claim(job.id))!;
    assert.equal(await store.unpublish(job.profile, job.view, job.id), true);
    await assert.rejects(store.retire(job.id), /Pause the job/);
    await store.pause(job.id);
    await assert.rejects(store.retire(job.id), /Pause the job/);
    await store.sent(batch.id, "embedding:index:retirement-guard");
    await assert.rejects(store.retire(job.id), /Pause the job/);
    await store.recover(job.id);
    await store.retire(job.id);
    assert.equal((await store.generation(job.id)).state, "retired");
  }));

test("operator pause stops new claims and waits for admitted batches to settle", async () =>
  fixture(async (store) => {
    const job = await prepared(store, documents(20));
    const controller = new AbortController();
    const provider = embedder(async () => {
      controller.abort();
    });
    const result = await new SemanticIndexer(store, provider).run(job.id, {
      concurrency: 1,
      signal: controller.signal,
    });
    assert.equal(provider.calls.length, 1);
    assert.equal(result.coverage.indexed, 8);
    assert.equal(result.coverage.pending, 12);
    assert.equal((await store.batches(job.id))[0].state, "completed");
  }));

test("failed source entries and transactional capacity failures keep honest coverage", async () =>
  fixture(async (store) => {
    const rows = documents(2);
    rows[1] = {
      ...rows[1],
      input: null,
      input_hash: null,
      error: "input_limit",
    };
    const job = await prepared(store, rows);
    const result = await new SemanticIndexer(store, embedder()).run(job.id);
    assert.deepEqual(result.coverage, {
      eligible: 2,
      indexed: 1,
      pending: 0,
      failed: 1,
    });
    assert.equal(result.generation.state, "paused");
    const invalid = source(documents(1), hash(3000));
    const other = await store.create(invalid.context, profile());
    const page = await invalid.page(null, 128);
    page.documents[0].input_hash = hash(404);
    await assert.rejects(store.stage(other.id, null, page), /input binding/);
    assert.equal((await store.generation(other.id)).cursor, null);
    assert.equal((await store.coverage(other.id)).pending, 1);
  }));

test("vector capacity failure rolls back every result in the batch", async () =>
  fixture(
    async (store, path) => {
      const job = await prepared(store, documents(2));
      const result = await new SemanticIndexer(store, embedder()).run(job.id);
      assert.equal(result.coverage.indexed, 0);
      assert.equal(result.coverage.failed, 2);
      const database = new DatabaseSync(path);
      try {
        assert.equal(
          database.prepare("SELECT COUNT(*) AS n FROM semantic_vectors").get()!
            .n,
          0,
        );
        assert.equal(
          database.prepare("SELECT vectors FROM semantic_usage").get()!.vectors,
          0,
        );
      } finally {
        database.close();
      }
    },
    { ...DEFAULT_VECTOR_LIMITS, vectors: 1 },
  ));

test("model mismatch suspends the full profile across restart and generations", async () =>
  fixture(async (store, path) => {
    const job = await prepared(store, documents(9));
    const provider = embedder(async () => {
      throw new AssistanceError(
        502,
        "embedding_model_mismatch",
        "The returned model differs.",
      );
    });
    const result = await new SemanticIndexer(store, provider).run(job.id, {
      concurrency: 1,
    });
    assert.equal(provider.calls.length, 1);
    assert.equal(result.generation.state, "paused");
    assert.equal(
      await store.compatibility(job.profile),
      "embedding_model_mismatch",
    );
    const reopened = new SqliteVectorStore(path);
    try {
      const next = await prepared(reopened, documents(1), hash(3000));
      const successful = embedder();
      await assert.rejects(
        new SemanticIndexer(reopened, successful).run(next.id),
        /profile is suspended/,
      );
      await assert.rejects(reopened.page(job.id), /profile is suspended/);
      await assert.rejects(
        reopened.publish(job.id, null),
        /profile is suspended/,
      );
      assert.equal(successful.calls.length, 0);
      const fresh = createQwenProfile("56".repeat(16));
      const replacement = await prepared(
        reopened,
        documents(1),
        hash(3001),
        fresh,
      );
      assert.equal(
        (await new SemanticIndexer(reopened, successful).run(replacement.id))
          .coverage.indexed,
        1,
      );
    } finally {
      reopened.close();
    }
  }));

test("private source paging uses evaluator eligibility and exact record bindings", async () => {
  const fixtures = JSON.parse(
    await readFile(
      new URL(
        "../../../crates/jvc-runtime/tests/fixtures/semantic-record-inputs-v1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const selected = fixtures.filter(
    (row: any) => row.body && row.name === "native-definition",
  );
  const records = new Map<string, ReturnType<typeof projectSemanticRecord>>();
  const snapshot = { snapshot: hash(9000), events: {} } as Snapshot;
  const evaluation = {
    available: true,
    selected_view: hash(9001, "jve1:"),
    publications: {},
    receipts: {},
  } as Evaluation;
  for (const fixture of selected) {
    const envelope = JSON.parse(fixture.envelope);
    const body = JSON.parse(fixture.body);
    const binding = {
      envelope_hash: inputHash(utf8(fixture.envelope)),
      body_hash: inputHash(utf8(fixture.body)),
      header: envelope.header,
      signature: [],
    };
    snapshot.events[envelope.id] = binding;
    records.set(
      envelope.id,
      projectSemanticRecord(
        envelope.id,
        binding,
        utf8(fixture.envelope),
        utf8(fixture.body),
      ),
    );
    evaluation.publications[envelope.id] = {
      id: envelope.id,
      kind: "definition.publish",
      eligible: "eligible",
      status: "active",
      content_available: true,
      language: body.language,
      word: wordId(body.word),
    } as any;
    evaluation.receipts[envelope.id] = {
      interpretation: "effective",
      body: "valid",
      reasons: [],
    };
  }
  let retained = true;
  const coordinator = {
    async getSnapshot() {
      return retained ? snapshot : null;
    },
    async getSemanticRecord(binding: any) {
      return records.get(binding.id)!;
    },
  } as unknown as Coordinator;
  const objects = {
    async get() {
      throw new Error("The source must reuse its private record.");
    },
    async put() {},
  };
  const current = eligibleSemanticSource(
    profile(),
    snapshot,
    evaluation,
    coordinator,
    objects,
  );
  assert.equal(current.context.eligible, 1);
  const page = await current.page(null, 1);
  const record = [...records.values()][0];
  assert.equal(
    page.documents[0].input_hash,
    semanticDocument(profile(), record)!.input_hash,
  );
  assert.equal(page.documents[0].body, record.body_hash);
  const publication = Object.values(evaluation.publications)[0];
  for (const field of ["retired", "not_selected", "ineffective", "missing"]) {
    const changed = structuredClone(evaluation);
    if (field === "retired")
      changed.publications[publication.id].status = "retired";
    if (field === "not_selected")
      changed.publications[publication.id].eligible = "not_selected";
    if (field === "ineffective")
      changed.receipts[publication.id].interpretation = "inert";
    if (field === "missing")
      changed.publications[publication.id].content_available = false;
    assert.equal(
      eligibleSemanticSource(profile(), snapshot, changed, coordinator, objects)
        .context.eligible,
      0,
    );
  }
  retained = false;
  await assert.rejects(current.page(null, 1), /snapshot expired/);
});

test("before-send persistence failure sends no request and releases its unsent reservation", async () =>
  fixture(async (store, path) => {
    const job = await prepared(store, documents(1));
    const budget = new SqliteAssistanceBudgetStore(path + ".budget");
    let sends = 0;
    const config = providerConfig(
      { JVC_AI_ENABLED: "enabled" },
      async () => "disposable-test-key",
    )!;
    config.fetch = async () => {
      sends++;
      throw new Error("No dispatch is permitted.");
    };
    const assistance = new AssistanceService(
      { provider: config, budgetStore: budget },
      "test",
      async () => [],
    );
    const original = store.sent.bind(store);
    store.sent = async () => {
      throw new Error("A simulated private storage failure.");
    };
    try {
      await new SemanticIndexer(store, assistance).run(job.id);
      assert.equal(sends, 0);
      assert.equal((await store.batches(job.id))[0].state, "failed");
      assert.equal((await budget.load())!.entries.length, 0);
      const diagnostics = await assistance.embeddingOperations();
      assert.equal(diagnostics[0].transportPending, false);
      assert.equal(diagnostics[0].reservedUsd, 0);
    } finally {
      store.sent = original;
      budget.close();
    }
  }));

test("a lost sent response retains the shared charge and a distinct explicit retry operation", async () =>
  fixture(async (store, path) => {
    const job = await prepared(store, documents(1));
    const budget = new SqliteAssistanceBudgetStore(path + ".budget");
    let sends = 0;
    const config = providerConfig(
      { JVC_AI_ENABLED: "enabled" },
      async () => "disposable-test-key",
    )!;
    config.fetch = async () => {
      sends++;
      const batch = (await store.batches(job.id)).find(
        (item) => item.state === "sent",
      )!;
      assert(batch.operation);
      if (sends === 1) throw new Error("A simulated lost response.");
      return Response.json({
        model: "qwen/qwen3-embedding-8b",
        data: [{ index: 0, embedding: Array.from(unit()) }],
        usage: { prompt_tokens: 20, total_tokens: 20, cost: 0.0000002 },
      });
    };
    const assistance = new AssistanceService(
      { provider: config, budgetStore: budget },
      "test",
      async () => [],
    );
    try {
      const indexer = new SemanticIndexer(store, assistance);
      await indexer.run(job.id);
      const old = (await store.batches(job.id))[0];
      const snapshot = (await budget.load())!;
      assert.equal(snapshot.version, 2);
      if (snapshot.version !== 2)
        throw new Error("The budget schema differs from version 2.");
      const firstCharge = snapshot.entries.find(
        (entry) => entry.id === old.operation,
      )!;
      assert(firstCharge.reservedUsd > 0);
      assert.equal(firstCharge.costKnown, false);
      await indexer.run(job.id);
      assert.equal(sends, 1);
      await store.retry(old.id);
      await indexer.run(job.id);
      assert.equal(sends, 2);
      const next = (await store.batches(job.id)).find(
        (item) => item.previous === old.id,
      )!;
      assert.notEqual(next.operation, old.operation);
      assert.equal((await store.coverage(job.id)).indexed, 1);
      assert.deepEqual(
        (await budget.load())!.entries.find(
          (entry) => entry.id === old.operation,
        ),
        firstCharge,
      );
    } finally {
      budget.close();
    }
  }));

test("CLI teardown keeps stores and the directory lock until an abort-ignoring transport ends", async () => {
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "drain-"));
  const vectors = new SqliteVectorStore(join(directory, "vectors.sqlite"));
  const budget = new SqliteAssistanceBudgetStore(
    join(directory, "budget.sqlite"),
  );
  const release = await lockDataDirectory(directory, "semantic-index-test");
  let resolveTransport!: () => void;
  const transport = new Promise<void>((resolve) => {
    resolveTransport = resolve;
  });
  let sends = 0;
  let closed = false;
  let closing: Promise<void> | undefined;
  const config = providerConfig(
    { JVC_AI_ENABLED: "enabled" },
    async () => "disposable-test-key",
  )!;
  config.timeoutMs = 40;
  config.fetch = async () => {
    sends++;
    await transport;
    return Response.json({
      model: "qwen/qwen3-embedding-8b",
      data: [{ index: 0, embedding: Array.from(unit()) }],
      usage: { prompt_tokens: 20, total_tokens: 20, cost: 0.0000002 },
    });
  };
  const assistance = new AssistanceService(
    { provider: config, budgetStore: budget },
    "test",
    async () => [],
  );
  try {
    const job = await prepared(vectors, documents(1));
    const result = await new SemanticIndexer(vectors, assistance).run(job.id, {
      concurrency: 1,
    });
    assert.equal(result.coverage.failed, 1);
    assert.equal(sends, 1);
    assert.equal(
      (await assistance.embeddingOperations())[0].transportPending,
      true,
    );
    closing = closeSemanticIndexHost(assistance, budget, vectors, async () => {
      closed = true;
      await release();
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(closed, false);
    await assert.rejects(
      lockDataDirectory(directory, "another-host"),
      /directory is locked/,
    );
    assert.equal((await vectors.coverage(job.id)).indexed, 0);
    const snapshot = (await budget.load())!;
    assert.equal(snapshot.version, 2);
    if (snapshot.version !== 2)
      throw new Error("The budget schema differs from version 2.");
    const charge = snapshot.entries[0];
    assert.equal(charge.costKnown, false);
    assert(charge.reservedUsd > 0);
    resolveTransport();
    await closing;
    assert.equal(closed, true);
    assert.equal(sends, 1);
    const budgetRead = new SqliteAssistanceBudgetStore(
      join(directory, "budget.sqlite"),
    );
    try {
      assert.deepEqual((await budgetRead.load())!.entries[0], charge);
    } finally {
      budgetRead.close();
    }
    await assert.rejects(
      vectors.coverage(job.id),
      /database is not open|statement has been finalized/,
    );
    const releaseNext = await lockDataDirectory(directory, "next-host");
    await releaseNext();
  } finally {
    resolveTransport();
    if (closing) await closing;
    else await closeSemanticIndexHost(assistance, budget, vectors, release);
    await rm(directory, { recursive: true });
  }
});
