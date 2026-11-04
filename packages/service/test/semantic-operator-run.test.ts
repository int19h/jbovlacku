import assert from "node:assert/strict";
import { before, test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  initializeCore,
  semanticProjectionVersion,
  utf8,
} from "../../core/src/index.ts";
import { SqliteVectorStore } from "../../../apps/server/src/semantic.ts";
import { AssistanceError } from "../src/inference.ts";
import {
  SemanticIndexer,
  type IndexEmbedder,
  type IndexConcurrencyChange,
} from "../src/semantic/indexer.ts";
import {
  createQwenProfile,
  inputHash,
  profileId,
} from "../src/semantic/profile.ts";
import type { IndexDocument, SemanticSource } from "../src/semantic/source.ts";

before(async () =>
  initializeCore(
    await readFile(
      new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  ),
);
const hash = (n: number, prefix = "sha256:") =>
  prefix + n.toString(16).padStart(64, "0");
const usage = { inputTokens: 1, totalTokens: 1, costUsd: 0 };
const unit = () =>
  Float32Array.from({ length: 4096 }, (_, i) => (i === 0 ? 1 : 0));
function provider(
  onSend?: (inputs: readonly Uint8Array[], call: number) => Promise<void>,
) {
  const calls: Uint8Array[][] = [];
  const embedder: IndexEmbedder = {
    async embed(inputs, _caller, _signal, beforeSend) {
      const operation = `embedding:index:${crypto.randomUUID()}`;
      await beforeSend!(operation);
      calls.push([...inputs]);
      await onSend?.(inputs, calls.length);
      return {
        operation,
        model: "qwen/qwen3-embedding-8b",
        vectors: inputs.map(unit),
        usage,
      };
    },
  };
  return { ...embedder, calls };
}
async function fixture(
  count: number,
  run: (store: SqliteVectorStore, id: string) => Promise<void>,
  bytes = 20,
) {
  const store = new SqliteVectorStore(":memory:");
  try {
    const profile = createQwenProfile("12".repeat(16));
    const rows: IndexDocument[] = Array.from({ length: count }, (_, i) => {
      const input = utf8(String(i).padStart(bytes, "x"));
      return {
        event: hash(i + 1, "jve1:"),
        envelope: hash(i + 2000),
        body: hash(i + 4000),
        extraction_version: semanticProjectionVersion(),
        word: hash(i + 6000, "jvw1:"),
        language: "en",
        input,
        input_hash: inputHash(input),
        error: null,
      };
    });
    const source: SemanticSource = {
      context: {
        snapshot: hash(10000),
        view: hash(10001, "jve1:"),
        profile: profileId(profile),
        eligible: count,
      },
      async page(after, limit) {
        const remaining = rows.filter(
          (row) => after === null || row.event > after,
        );
        const documents = remaining.slice(0, limit);
        return {
          documents,
          next: documents.at(-1)?.event ?? after,
          done: documents.length === remaining.length,
        };
      },
    };
    const generation = await store.create(source.context, profile);
    await new SemanticIndexer(store, provider()).prepare(generation.id, source);
    await run(store, generation.id);
  } finally {
    store.close();
  }
}

test("operator workers exceed four and batches exceed eight", () =>
  fixture(256, async (store, id) => {
    let active = 0;
    let peak = 0;
    const embedder = provider(async () => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
    });
    const result = await new SemanticIndexer(store, embedder).run(id, {
      operator: true,
      concurrency: 8,
      batchSize: 32,
      batchBytes: 131072,
    });
    assert.equal(result.coverage.indexed, 256);
    assert.equal(peak, 8);
    assert.deepEqual(
      embedder.calls.map((call) => call.length),
      Array(8).fill(32),
    );
  }));

test("standard defaults retain eight inputs and two workers", () =>
  fixture(40, async (store, id) => {
    let active = 0;
    let peak = 0;
    const embedder = provider(async () => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
    });
    await new SemanticIndexer(store, embedder).run(id);
    assert.equal(peak, 2);
    assert.deepEqual(
      embedder.calls.map((call) => call.length),
      Array(5).fill(8),
    );
  }));

test("byte boundaries retain every excluded input for the next claim", () =>
  fixture(
    13,
    async (store, id) => {
      const embedder = provider();
      const result = await new SemanticIndexer(store, embedder).run(id, {
        operator: true,
        concurrency: 1,
        batchSize: 128,
        batchBytes: 9000,
      });
      assert.equal(result.coverage.indexed, 13);
      assert.deepEqual(
        embedder.calls.map((call) => call.length),
        [2, 2, 2, 2, 2, 2, 1],
      );
      assert.equal(new Set(embedder.calls.flat().map(inputHash)).size, 13);
      for (const call of embedder.calls)
        assert(call.reduce((sum, input) => sum + input.byteLength, 0) <= 9000);
    },
    4096,
  ));

test("operator limits validate before claims or provider calls", () =>
  fixture(1, async (store, id) => {
    const embedder = provider();
    const indexer = new SemanticIndexer(store, embedder);
    for (const options of [
      { concurrency: 5 },
      { batchSize: 9 },
      { batchBytes: 32769 },
      { adaptive: true },
      { operator: true, concurrency: 33 },
      { operator: true, batchSize: 129 },
      { operator: true, batchBytes: 524289 },
      { operator: true, batchSize: 0 },
      { operator: true, batchBytes: 0 },
      { operator: true, batchSize: 1.5 },
    ]) {
      await assert.rejects(indexer.run(id, options), {
        code: "semantic_limit",
      });
    }
    await assert.rejects(indexer.run(id, { operator: true, batchBytes: 1 }), {
      code: "semantic_limit",
    });
    assert.equal((await store.batches(id)).length, 0);
    assert.equal(embedder.calls.length, 0);
  }));

test("adaptive rate limits halve concurrency and successful batches restore it", () =>
  fixture(70, async (store, id) => {
    let now = 0;
    const events: IndexConcurrencyChange[] = [];
    let active = 0;
    const embedder = provider(async (_inputs, call) => {
      if (call === 1)
        throw new AssistanceError(
          429,
          "embedding_rate_limited",
          "Rate limited.",
        );
      active++;
      if (call > 8) assert(active <= events.at(-1)!.concurrency);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
    });
    const result = await new SemanticIndexer(store, embedder, {
      now: () => now,
      async sleep(delay) {
        now += delay;
      },
    }).run(id, {
      operator: true,
      adaptive: true,
      concurrency: 8,
      batchSize: 1,
      onConcurrencyChange: (event) => events.push(event),
    });
    assert.equal(result.coverage.indexed, 70);
    assert.deepEqual(events[0], {
      concurrency: 4,
      reason: "embedding_rate_limited",
    });
    assert.deepEqual(
      events
        .filter((event) => event.reason === "success")
        .map((event) => event.concurrency),
      [5, 6, 7, 8],
    );
    assert.equal(embedder.calls.length, 71);
    const batches = await store.batches(id, null, 128);
    const failed = batches.find(
      (batch) => batch.error === "embedding_rate_limited",
    )!;
    assert(failed);
    const retry = batches.find((batch) => batch.previous === failed.id)!;
    assert.deepEqual(retry.inputs, failed.inputs);
    assert.equal(retry.state, "completed");
  }));

test("adaptive timeout continues fresh inputs at a lower cap without replay", () =>
  fixture(30, async (store, id) => {
    const events: IndexConcurrencyChange[] = [];
    let active = 0;
    let continued = 0;
    const embedder = provider(async (_inputs, call) => {
      if (call === 1)
        throw new AssistanceError(504, "embedding_timeout", "Timed out.");
      active++;
      if (call > 8) {
        continued++;
        assert(active <= events.at(-1)!.concurrency);
      }
      await new Promise((resolve) => setImmediate(resolve));
      active--;
    });
    const indexer = new SemanticIndexer(store, embedder);
    const options = {
      operator: true,
      adaptive: true,
      concurrency: 8,
      batchSize: 1,
      onConcurrencyChange: (event: IndexConcurrencyChange) =>
        events.push(event),
    };
    const result = await indexer.run(id, options);
    assert.equal(result.generation.state, "paused");
    assert.equal(result.generation.error, "index_incomplete");
    assert.equal(result.coverage.indexed, 29);
    assert.equal(result.coverage.failed, 1);
    assert.equal(continued, 22);
    assert.deepEqual(events[0], {
      concurrency: 4,
      reason: "embedding_timeout",
    });
    const batch = (await store.batches(id)).find(
      (batch) => batch.error === "embedding_timeout",
    )!;
    assert.equal(batch.state, "ambiguous");
    assert.equal(batch.previous, null);
    assert.notEqual(batch.operation, null);
    const failedInput = batch.inputs[0];
    const calls = embedder.calls.length;
    await indexer.run(id, options);
    assert.equal(embedder.calls.length, calls);
    assert.equal(
      embedder.calls
        .flat()
        .map(inputHash)
        .filter((hash) => hash === failedInput).length,
      1,
    );
    assert.equal(
      (await store.batches(id)).filter(
        (attempt) => attempt.previous === batch.id,
      ).length,
      0,
    );
    await store.retry(batch.id);
    await indexer.run(id, { operator: true, concurrency: 1, batchSize: 1 });
    assert.equal((await store.coverage(id)).indexed, 30);
    assert.equal(
      embedder.calls
        .flat()
        .map(inputHash)
        .filter((hash) => hash === failedInput).length,
      2,
    );
  }));

test("timeout continuation retries concurrent 429 batches without losing or replaying inputs", async () => {
  for (const timeoutCall of [1, 3])
    await fixture(8, async (store, id) => {
      let now = 0;
      const waits: number[] = [];
      const completed: string[] = [];
      const embedder = provider(async (inputs, call) => {
        if (call <= 3) {
          // All three requests enter the provider before the failures settle.
          await new Promise((resolve) => setImmediate(resolve));
          if (call === timeoutCall)
            throw new AssistanceError(504, "embedding_timeout", "Timed out.");
          const failure = new AssistanceError(
            429,
            "embedding_rate_limited",
            "Rate limited.",
          );
          failure.retryAfterMs = call === 2 ? 5000 : 2000;
          throw failure;
        }
        assert(now >= 5000);
        completed.push(...inputs.map(inputHash));
      });
      const indexer = new SemanticIndexer(store, embedder, {
        now: () => now,
        async sleep(delay) {
          const identity = (await store.generation(id)).profile;
          assert.equal(await store.retryAfter(identity), now + delay);
          waits.push(delay);
          now += delay;
        },
      });
      const options = {
        operator: true,
        adaptive: true,
        concurrency: 3,
        batchSize: 1,
      };
      const result = await indexer.run(id, options);
      assert.deepEqual(waits, [5000]);
      assert.equal(result.coverage.indexed, 7);
      assert.equal(result.coverage.failed, 1);
      assert.equal(result.coverage.pending, 0);
      assert.equal(result.generation.error, "index_incomplete");
      const batches = await store.batches(id);
      const limited = batches.filter(
        (batch) => batch.error === "embedding_rate_limited",
      );
      assert.equal(limited.length, 2);
      for (const batch of limited) {
        const linked = batches.filter((retry) => retry.previous === batch.id);
        assert.equal(linked.length, 1);
        assert.equal(linked[0].state, "completed");
        assert.deepEqual(linked[0].inputs, batch.inputs);
      }
      const timeout = batches.find(
        (batch) => batch.error === "embedding_timeout",
      )!;
      assert.equal(timeout.state, "ambiguous");
      assert.equal(
        batches.filter((batch) => batch.previous === timeout.id).length,
        0,
      );
      const attempts = embedder.calls.flat().map(inputHash);
      assert.equal(
        attempts.filter((input) => input === timeout.inputs[0]).length,
        1,
      );
      for (const input of new Set(attempts))
        assert.equal(
          attempts.filter((sent) => sent === input).length,
          limited.some((batch) => batch.inputs.includes(input)) ? 2 : 1,
        );
      assert.equal(completed.length, 7);
      assert.equal(new Set(completed).size, 7);
      const calls = embedder.calls.length;
      await indexer.run(id, options);
      assert.equal(embedder.calls.length, calls);
      await store.retry(timeout.id);
      const final = await indexer.run(id, options);
      assert.equal(final.generation.state, "completed");
      assert.equal(final.coverage.indexed, 8);
      assert.equal(completed.length, 8);
      assert.equal(new Set(completed).size, 8);
    });
});

test("mixed timeout retries retain automatic retry and wait bounds", async () => {
  for (const mode of ["disabled", "maximum", "cancel"])
    await fixture(8, async (store, id) => {
      let now = 0;
      let limitedInput: string;
      const waits: number[] = [];
      const controller = new AbortController();
      const embedder = provider(async (inputs, call) => {
        if (call <= 2) await new Promise((resolve) => setImmediate(resolve));
        if (call === 1)
          throw new AssistanceError(504, "embedding_timeout", "Timed out.");
        if (call === 2 || inputHash(inputs[0]) === limitedInput) {
          limitedInput = inputHash(inputs[0]);
          const failure = new AssistanceError(
            429,
            "embedding_rate_limited",
            "Rate limited.",
          );
          failure.retryAfterMs = 0;
          throw failure;
        }
      });
      await new SemanticIndexer(store, embedder, {
        now: () => now,
        async sleep(delay) {
          waits.push(delay);
          now += delay;
        },
      }).run(id, {
        operator: true,
        adaptive: true,
        concurrency: 2,
        batchSize: 1,
        automaticRetries: mode !== "disabled",
        maxBatches: mode === "maximum" ? 2 : 100,
        signal: controller.signal,
        onFailure: () => {
          if (mode === "cancel") controller.abort();
        },
      });
      const batches = await store.batches(id);
      const limited = batches.filter(
        (batch) => batch.error === "embedding_rate_limited",
      );
      assert.equal(limited.length, 1);
      assert.equal(
        limited.filter((batch) => batch.previous !== null).length,
        limited.length - 1,
      );
      assert.deepEqual(waits, mode === "disabled" ? [1000] : []);
      assert.equal(
        batches.filter((batch) => batch.error === "embedding_timeout").length,
        1,
      );
      assert.equal(
        embedder.calls
          .flat()
          .map(inputHash)
          .filter((input) => input === inputHash(embedder.calls[0][0])).length,
        1,
      );
    });
});

test("explicit linked retries keep a larger batch intact under smaller new limits", () =>
  fixture(12, async (store, id) => {
    await store.start(id);
    const old = (await store.claim(id, undefined, {
      batchSize: 12,
      batchBytes: 32768,
    }))!;
    await store.sent(old.id, "embedding:index:old");
    await store.fail(old.id, "embedding_timeout");
    await store.pause(id);
    await store.retry(old.id);
    const embedder = provider();
    await new SemanticIndexer(store, embedder).run(id, {
      operator: true,
      batchSize: 1,
      batchBytes: 20,
    });
    assert.deepEqual(
      embedder.calls.map((call) => call.length),
      [12],
    );
    const retry = (await store.batches(id)).find(
      (batch) => batch.previous === old.id,
    )!;
    assert.deepEqual(retry.inputs, old.inputs);
  }));

test("stored profiles and reusable input counts use exact metadata", () =>
  fixture(3, async (store, id) => {
    const identity = (await store.generation(id)).profile;
    assert.equal(profileId(await store.storedProfile(identity)), identity);
    await assert.rejects(store.storedProfile(hash(99)), /unavailable/);
    assert.equal(await store.reusableInputs(id), 0);
    await new SemanticIndexer(store, provider()).run(id);
    assert.equal(await store.reusableInputs(id), 3);
    const original = await store.generation(id);
    const duplicate = await store.create(
      { ...original, snapshot: hash(20000), eligible: 2 },
      await store.storedProfile(identity),
    );
    const input = (await store.inputs((await store.batches(id))[0].id))[0];
    const documents = [1, 2].map((i) => ({
      event: hash(i, "jve1:"),
      envelope: hash(i + 2000),
      body: hash(i + 4000),
      extraction_version: semanticProjectionVersion(),
      word: hash(i + 6000, "jvw1:"),
      language: "en",
      input,
      input_hash: inputHash(input),
      error: null,
    }));
    await store.stage(duplicate.id, null, {
      documents,
      next: documents[1].event,
      done: true,
    });
    assert.equal(await store.reusableInputs(duplicate.id), 1);
  }));

test("operator batches accept the local count and byte caps", () =>
  fixture(
    128,
    async (store, id) => {
      const embedder = provider();
      await new SemanticIndexer(store, embedder).run(id, {
        operator: true,
        concurrency: 32,
        batchSize: 128,
        batchBytes: 524288,
      });
      assert.equal(embedder.calls.length, 1);
      assert.equal(embedder.calls[0].length, 128);
      assert.equal(
        embedder.calls[0].reduce((sum, input) => sum + input.byteLength, 0),
        524288,
      );
    },
    4096,
  ));

test("adaptive decreases stop at one and failed intents count toward the maximum", () =>
  fixture(20, async (store, id) => {
    let now = 0;
    const events: IndexConcurrencyChange[] = [];
    const embedder = provider(async () => {
      throw new AssistanceError(429, "embedding_rate_limited", "Rate limited.");
    });
    await new SemanticIndexer(store, embedder, {
      now: () => now,
      async sleep(delay) {
        now += delay;
      },
    }).run(id, {
      operator: true,
      adaptive: true,
      concurrency: 8,
      batchSize: 1,
      maxBatches: 4,
      onConcurrencyChange: (event) => events.push(event),
    });
    assert.equal(embedder.calls.length, 4);
    assert.deepEqual(
      events.map((event) => event.concurrency),
      [4],
    );
    assert.equal((await store.summary(id)).dispatch_intents, 4);
  }));

test("timeouts keep the existing stop behavior without operator adaptation", async () => {
  for (const operator of [false, true])
    await fixture(16, async (store, id) => {
      const embedder = provider(async (_inputs, call) => {
        if (call === 1)
          throw new AssistanceError(504, "embedding_timeout", "Timed out.");
      });
      const result = await new SemanticIndexer(store, embedder).run(id, {
        operator,
        concurrency: 4,
        batchSize: 1,
      });
      assert.equal(result.generation.error, "embedding_timeout");
      assert.equal(embedder.calls.length, 4);
      assert.equal(result.coverage.pending, 12);
    });
});

test("persistent timeouts stop after three waves without progress", () =>
  fixture(200, async (store, id) => {
    const events: IndexConcurrencyChange[] = [];
    const embedder = provider(async () => {
      throw new AssistanceError(504, "embedding_timeout", "Timed out.");
    });
    const result = await new SemanticIndexer(store, embedder).run(id, {
      operator: true,
      adaptive: true,
      concurrency: 8,
      batchSize: 1,
      onConcurrencyChange: (event) => events.push(event),
    });
    assert.equal(embedder.calls.length, 14);
    assert.deepEqual(
      events.map((event) => event.concurrency),
      [4, 2, 1],
    );
    assert.equal(result.generation.state, "paused");
    assert.equal(result.generation.error, "embedding_timeout");
    assert.equal(result.coverage.indexed, 0);
    assert.equal(result.coverage.failed, 14);
    assert.equal(result.coverage.pending, 186);
    assert.equal(
      (await store.batches(id)).filter((batch) => batch.previous !== null)
        .length,
      0,
    );
  }));

test("timeout continuation respects the batch maximum and cancellation", async () => {
  for (const cancel of [false, true])
    await fixture(10, async (store, id) => {
      const controller = new AbortController();
      const embedder = provider(async (_inputs, call) => {
        if (call === 1)
          throw new AssistanceError(504, "embedding_timeout", "Timed out.");
      });
      const result = await new SemanticIndexer(store, embedder).run(id, {
        operator: true,
        adaptive: true,
        concurrency: 2,
        batchSize: 1,
        maxBatches: cancel ? 10 : 2,
        signal: controller.signal,
        onFailure: () => {
          if (cancel) controller.abort();
        },
      });
      assert.equal(embedder.calls.length, 2);
      assert.equal(result.generation.state, "paused");
      assert.equal((await store.batches(id)).length, 2);
    });
});

test("a busy service after a timeout pauses without replaying the pending operation", () =>
  fixture(10, async (store, id) => {
    const base = provider(async (_inputs, call) => {
      if (call === 1)
        throw new AssistanceError(504, "embedding_timeout", "Timed out.");
    });
    const embedder: IndexEmbedder = {
      embeddingOperationPending: () => true,
      async embed(...args) {
        if (base.calls.length >= 2)
          throw new AssistanceError(
            429,
            "embedding_busy",
            "The embedding service is busy.",
          );
        return base.embed(...args);
      },
    };
    const result = await new SemanticIndexer(store, embedder).run(id, {
      operator: true,
      adaptive: true,
      concurrency: 2,
      batchSize: 1,
    });
    assert.equal(result.generation.error, "embedding_busy");
    assert.equal(base.calls.length, 2);
    const batches = await store.batches(id);
    assert.equal(batches.length, 3);
    assert.equal(
      batches.filter((batch) => batch.state === "ambiguous").length,
      1,
    );
    assert.equal(
      batches.filter(
        (batch) => batch.state === "failed" && batch.operation === null,
      ).length,
      1,
    );
    assert.equal(batches.filter((batch) => batch.previous !== null).length, 0);
  }));

test("timeout continuation waits for a saved provider cooldown", () =>
  fixture(2, async (store, id) => {
    let now = 0;
    const waits: number[] = [];
    const embedder = provider(async (_inputs, call) => {
      if (call === 1) {
        const failure = new AssistanceError(
          504,
          "embedding_timeout",
          "Timed out.",
        );
        failure.retryAfterMs = 1000;
        throw failure;
      }
      assert.equal(now, 1000);
    });
    const result = await new SemanticIndexer(store, embedder, {
      now: () => now,
      async sleep(delay) {
        waits.push(delay);
        now += delay;
      },
    }).run(id, {
      operator: true,
      adaptive: true,
      concurrency: 1,
      batchSize: 1,
    });
    assert.deepEqual(waits, [1000]);
    assert.equal(embedder.calls.length, 2);
    assert.equal(result.coverage.indexed, 1);
    assert.equal(result.coverage.failed, 1);
  }));

test("a local fresh-batch byte refusal leaves the generation resumable", () =>
  fixture(2, async (store, id) => {
    const embedder = provider();
    const indexer = new SemanticIndexer(store, embedder);
    await assert.rejects(
      indexer.run(id, { operator: true, batchBytes: 1 }),
      /input exceeds/,
    );
    assert.equal((await store.generation(id)).state, "paused");
    assert.equal((await store.summary(id)).dispatch_intents, 0);
    await indexer.run(id, { operator: true, batchBytes: 32768 });
    assert.equal((await store.generation(id)).state, "completed");
  }));

test("a provider admitting four concurrent requests completes all 2000 inputs", () =>
  fixture(2000, async (store, id) => {
    let now = 0;
    let active = 0;
    let limited = 0;
    const completed: string[] = [];
    const events: IndexConcurrencyChange[] = [];
    const embedder = provider(async (inputs) => {
      if (active >= 4) {
        limited++;
        const failure = new AssistanceError(
          429,
          "embedding_rate_limited",
          "Rate limited.",
        );
        failure.retryAfterMs = 2000;
        throw failure;
      }
      active++;
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      completed.push(...inputs.map(inputHash));
    });
    const result = await new SemanticIndexer(store, embedder, {
      now: () => now,
      async sleep(delay) {
        now += delay;
      },
    }).run(id, {
      operator: true,
      adaptive: true,
      concurrency: 16,
      batchSize: 1,
      onConcurrencyChange: (event) => events.push(event),
    });
    assert.equal(result.generation.state, "completed");
    assert.equal(result.coverage.indexed, 2000);
    assert.equal(completed.length, 2000);
    assert.equal(new Set(completed).size, 2000);
    assert(limited > 3);
    assert(now > 120000);
    assert.equal(embedder.calls.length, 2000 + limited);
    assert.deepEqual(events[0], {
      concurrency: 8,
      reason: "embedding_rate_limited",
    });
    const batches = [];
    let after: string | null = null;
    for (;;) {
      const page = await store.batches(id, after, 128);
      if (!page.length) break;
      batches.push(...page);
      after = page.at(-1)!.id;
    }
    const retried = new Set(batches.map((batch) => batch.previous));
    assert.equal(
      batches.filter(
        (batch) =>
          batch.error === "embedding_rate_limited" && !retried.has(batch.id),
      ).length,
      0,
    );
  }));

test("long operator cooldowns use bounded sleeps across repeated 429 waves", () =>
  fixture(2, async (store, id) => {
    let now = 0;
    const waits: number[] = [];
    const embedder = provider(async (_inputs, call) => {
      if (call <= 5) {
        const failure = new AssistanceError(
          429,
          "embedding_rate_limited",
          "Rate limited.",
        );
        failure.retryAfterMs = 125000;
        throw failure;
      }
      assert(now >= 625000);
    });
    const result = await new SemanticIndexer(store, embedder, {
      now: () => now,
      async sleep(delay) {
        waits.push(delay);
        now += delay;
      },
    }).run(id, {
      operator: true,
      adaptive: true,
      concurrency: 1,
      batchSize: 1,
    });
    assert.equal(result.generation.state, "completed");
    assert.equal(embedder.calls.length, 7);
    assert.deepEqual(
      waits,
      Array.from({ length: 5 }, () => [60000, 60000, 5000]).flat(),
    );
  }));

test("a resumed rate-limited run starts safely and claims saved retries automatically", () =>
  fixture(20, async (store, id) => {
    let now = 0;
    let active = 0;
    let peak = 0;
    const events: IndexConcurrencyChange[] = [];
    const embedder = provider(async (_inputs, call) => {
      if (call === 1)
        throw new AssistanceError(
          429,
          "embedding_rate_limited",
          "Rate limited.",
        );
      active++;
      peak = Math.max(peak, active);
      if (call <= 9) assert.equal(active, 1);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
    });
    const indexer = new SemanticIndexer(store, embedder, {
      now: () => now,
      async sleep(delay) {
        now += delay;
      },
    });
    await indexer.run(id, {
      operator: true,
      adaptive: true,
      concurrency: 16,
      batchSize: 1,
      maxBatches: 1,
    });
    const failed = (await store.batches(id))[0];
    const result = await indexer.run(id, {
      operator: true,
      adaptive: true,
      concurrency: 16,
      batchSize: 1,
      onConcurrencyChange: (event) => events.push(event),
    });
    assert.equal(result.generation.state, "completed");
    assert.deepEqual(events[0], { concurrency: 1, reason: "resume" });
    assert(peak <= 3);
    assert.equal(embedder.calls.length, 21);
    assert.equal(
      (await store.batches(id)).filter((batch) => batch.previous === failed.id)
        .length,
      1,
    );
  }));

test("successful progress resets the timeout wave stop", () =>
  fixture(8, async (store, id) => {
    const completed: string[] = [];
    const embedder = provider(async (inputs, call) => {
      if ([1, 2, 4, 5, 7, 8].includes(call))
        throw new AssistanceError(504, "embedding_timeout", "Timed out.");
      completed.push(...inputs.map(inputHash));
    });
    const result = await new SemanticIndexer(store, embedder).run(id, {
      operator: true,
      adaptive: true,
      concurrency: 1,
      batchSize: 1,
    });
    assert.equal(embedder.calls.length, 8);
    assert.equal(result.coverage.indexed, 2);
    assert.equal(result.coverage.failed, 6);
    assert.equal(new Set(completed).size, 2);
  }));
