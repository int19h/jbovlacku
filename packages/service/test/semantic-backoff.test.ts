import assert from "node:assert/strict";
import { before, test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { initializeCore, utf8 } from "../../core/src/index.ts";
import { SqliteVectorStore } from "../../../apps/server/src/semantic.ts";
import { SqliteAssistanceBudgetStore } from "../../../apps/server/src/assistance.ts";
import { AssistanceService } from "../src/assistance.ts";
import { providerConfig, type ProviderConfig } from "../src/inference.ts";
import {
  createQwenProfile,
  inputHash,
  profileId,
} from "../src/semantic/profile.ts";
import {
  SemanticIndexer,
  type IndexBackoff,
  type IndexClock,
} from "../src/semantic/indexer.ts";
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
const success = (count: number, cost = 0.000001) =>
  Response.json({
    model: "qwen/qwen3-embedding-8b",
    data: Array.from({ length: count }, (_, index) => ({
      index,
      embedding: Array.from({ length: 4096 }, (_, i) => (i ? 0 : 1)),
    })),
    usage: { prompt_tokens: 100, total_tokens: 100, cost },
  });
const limited = (retry?: string) =>
  new Response("<html>Provider private message</html>", {
    status: 429,
    headers: retry === undefined ? {} : { "retry-after": retry },
  });
function fakeClock() {
  let now = Date.UTC(2026, 9, 27, 12);
  const waits: number[] = [];
  return {
    waits,
    now: () => now,
    async sleep(ms: number, signal?: AbortSignal) {
      signal?.throwIfAborted();
      waits.push(ms);
      now += ms;
    },
  } satisfies IndexClock & { waits: number[] };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 1000; i++) {
    if (await check()) return;
    await new Promise(setImmediate);
  }
  assert.fail("The mocked work did not reach the expected state.");
}
async function prepare(store: SqliteVectorStore, count = 1, snapshot = 2000) {
  const profile = createQwenProfile("42".repeat(16));
  const rows: IndexDocument[] = Array.from({ length: count }, (_, i) => {
    const input = utf8(`Public test definition ${i}.`);
    return {
      event: hash(i + 1, "jve1:"),
      envelope: hash(i + 100),
      body: hash(i + 200),
      extraction_version: 1,
      word: hash(i + 300, "jvw1:"),
      language: "en",
      input,
      input_hash: inputHash(input),
      error: null,
    };
  });
  const generation = await store.create(
    {
      snapshot: hash(snapshot),
      view: hash(2100, "jve1:"),
      profile: profileId(profile),
      eligible: count,
    },
    profile,
  );
  await store.stage(generation.id, null, {
    documents: rows,
    next: rows.at(-1)!.event,
    done: true,
  });
  return generation;
}
async function fixture(
  fetcher: typeof fetch,
  run: (context: {
    store: SqliteVectorStore;
    budget: SqliteAssistanceBudgetStore;
    assistance: AssistanceService;
    id: string;
    path: string;
  }) => Promise<void>,
  count = 1,
  overrides: Partial<ProviderConfig> = {},
) {
  const base = process.env.JVC_TEST_ROOT ?? tmpdir();
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "semantic-backoff-"));
  const store = new SqliteVectorStore(join(directory, "vectors.sqlite"));
  const budget = new SqliteAssistanceBudgetStore(
    join(directory, "budget.sqlite"),
  );
  const config = {
    ...providerConfig(
      { JVC_AI_ENABLED: "enabled" },
      async () => "disposable-backoff-key",
    )!,
    fetch: fetcher,
    ...overrides,
  };
  const assistance = new AssistanceService(
    { provider: config, budgetStore: budget },
    "test",
    async () => [],
  );
  try {
    const generation = await prepare(store, count);
    await run({
      store,
      budget,
      assistance,
      id: generation.id,
      path: join(directory, "vectors.sqlite"),
    });
  } finally {
    await assistance.drainEmbeddingTransports();
    budget.close();
    store.close();
    await rm(directory, { recursive: true });
  }
}

for (const [code, cost] of [
  ["embedding_model_mismatch", 0.000007],
  ["embedding_response", 0.000008],
] as const) {
  test(`priced ${code} failures agree across the index summary and budget ledger`, async () => {
    let sends = 0;
    await fixture(
      async () => {
        sends++;
        return Response.json({
          model:
            code === "embedding_model_mismatch"
              ? "wrong-model"
              : "qwen/qwen3-embedding-8b",
          data: [],
          usage: { prompt_tokens: 12, total_tokens: 12, cost },
        });
      },
      async ({ store, budget, assistance, id }) => {
        const clock = fakeClock();
        const result = await new SemanticIndexer(store, assistance, clock).run(
          id,
        );
        assert.equal(result.generation.state, "paused");
        assert.equal(result.generation.error, code);
        const [batch] = await store.batches(id);
        assert.equal(batch.state, "ambiguous");
        assert.deepEqual(batch.usage, {
          inputTokens: 12,
          totalTokens: 12,
          costUsd: cost,
        });
        const summary = await store.summary(id);
        assert.equal(summary.unknown_cost_batches, 0);
        assert.equal(summary.reported_cost_usd, cost);
        const snapshot = (await budget.load())!;
        assert(snapshot.version === 2);
        const entry = snapshot.entries.find(
          (entry) => entry.id === batch.operation,
        )!;
        assert.equal(entry.costKnown, true);
        assert.equal(entry.settledUsd, cost);
        assert.equal(entry.reservedUsd, 0);
        assert.equal(sends, 1);
        assert.deepEqual(clock.waits, []);
      },
    );
  });
}

for (const kind of ["seconds", "date"] as const) {
  test(`Retry-After ${kind} delays a linked retry with a fresh shared charge`, async (t) => {
    const clock = fakeClock();
    t.mock.method(Date, "now", clock.now);
    let sends = 0;
    await fixture(
      async () =>
        ++sends === 1
          ? limited(
              kind === "seconds"
                ? "7"
                : new Date(clock.now() + 7000).toUTCString(),
            )
          : success(1),
      async ({ store, budget, assistance, id }) => {
        const events: IndexBackoff[] = [];
        const result = await new SemanticIndexer(store, assistance, clock).run(
          id,
          {
            onBackoff: (event) => events.push(event),
          },
        );
        assert.equal(result.generation.state, "completed");
        assert.deepEqual(clock.waits, [7000]);
        assert.deepEqual(events, [{ attempt: 1, delayMs: 7000, batches: 1 }]);
        const batches = await store.batches(id);
        const old = batches.find((batch) => batch.state === "ambiguous")!;
        const next = batches.find((batch) => batch.previous === old.id)!;
        assert.equal(next.state, "completed");
        assert.notEqual(old.operation, next.operation);
        const summary = await store.summary(id);
        assert.equal(summary.unknown_cost_batches, 1);
        assert.equal(summary.reported_cost_usd, 0.000001);
        const snapshot = (await budget.load())!;
        assert(snapshot.version === 2);
        const oldCharge = snapshot.entries.find(
          (entry) => entry.id === old.operation,
        )!;
        assert.equal(oldCharge.costKnown, false);
        assert.equal(oldCharge.settledUsd, quote);
        assert.equal(oldCharge.reservedUsd, quote);
        assert.equal(
          snapshot.entries.find((entry) => entry.id === next.operation)!
            .settledUsd,
          0.000001,
        );
        assert.equal(sends, 2);
      },
    );
  });
}

test("repeated rate limits stop after three retry rounds and preserve each attempt", async () => {
  let sends = 0;
  await fixture(
    async () => {
      sends++;
      return limited();
    },
    async ({ store, assistance, id }) => {
      const clock = fakeClock();
      const result = await new SemanticIndexer(store, assistance, clock).run(
        id,
      );
      assert.equal(result.generation.error, "embedding_rate_limited");
      assert.equal(sends, 4);
      assert.deepEqual(clock.waits, [1000, 2000, 4000]);
      const batches = await store.batches(id);
      assert.equal(batches.length, 4);
      assert(batches.every((batch) => batch.state === "ambiguous"));
      assert.equal(new Set(batches.map((batch) => batch.operation)).size, 4);
      assert.equal(batches.filter((batch) => batch.previous).length, 3);
    },
  );
});

test("the total wait limit stops repeated long cooldowns", async () => {
  let sends = 0;
  await fixture(
    async () => {
      sends++;
      return limited("60");
    },
    async ({ store, assistance, id }) => {
      const clock = fakeClock();
      const result = await new SemanticIndexer(store, assistance, clock).run(
        id,
      );
      assert.equal(result.generation.state, "paused");
      assert.deepEqual(clock.waits, [60000, 60000]);
      assert.equal(sends, 3);
    },
  );
});

test("an excessive Retry-After pauses without an early retry or automatic replay on resume", async () => {
  let sends = 0;
  await fixture(
    async () => {
      sends++;
      return limited("9999999999999999999999999");
    },
    async ({ store, assistance, id }) => {
      const clock = fakeClock();
      const indexer = new SemanticIndexer(store, assistance, clock);
      const result = await indexer.run(id);
      assert.equal(result.generation.error, "embedding_rate_limited");
      assert.deepEqual(clock.waits, []);
      await indexer.run(id);
      assert.equal(sends, 1);
      assert.equal((await store.batches(id)).length, 1);
    },
  );
});

test("non-429 provider failures never enter automatic backoff", async () => {
  let sends = 0;
  await fixture(
    async () => {
      sends++;
      return Response.json({ error: "unavailable" }, { status: 503 });
    },
    async ({ store, assistance, id }) => {
      const clock = fakeClock();
      const result = await new SemanticIndexer(store, assistance, clock).run(
        id,
      );
      assert.equal(result.generation.error, "embedding_provider");
      assert.deepEqual(clock.waits, []);
      assert.equal(sends, 1);
    },
  );
});

test("a linked retry must pass shared budget admission again", async () => {
  let sends = 0;
  await fixture(
    async () => {
      sends++;
      return limited();
    },
    async ({ store, assistance, budget, id }) => {
      const clock = fakeClock();
      const result = await new SemanticIndexer(store, assistance, clock).run(
        id,
      );
      assert.equal(result.generation.error, "billing_limit");
      assert.equal(sends, 1);
      assert.deepEqual(clock.waits, [1000]);
      const batches = await store.batches(id);
      const next = batches.find((batch) => batch.previous)!;
      assert.equal(next.state, "failed");
      assert.equal(next.operation, null);
      assert.equal((await budget.load())!.entries.length, 1);
    },
    1,
    { hourlyBudgetUsd: quote * 1.5, dailyBudgetUsd: quote * 1.5 },
  );
});

test("the retry wait starts only after every active worker settles", async () => {
  const release = deferred();
  let sends = 0;
  let active = 0;
  await fixture(
    async (_url, init) => {
      const turn = ++sends;
      active++;
      if (turn === 2) await release.promise;
      active--;
      return turn <= 2
        ? limited(turn === 1 ? "3" : "5")
        : success(JSON.parse(String(init?.body)).input.length);
    },
    async ({ store, assistance, id }) => {
      const clock = fakeClock();
      const events: IndexBackoff[] = [];
      const running = new SemanticIndexer(store, assistance, clock).run(id, {
        concurrency: 2,
        onBackoff: (event) => {
          assert.equal(active, 0);
          assert.equal(sends, 2);
          events.push(event);
        },
      });
      try {
        await until(
          async () =>
            sends === 2 &&
            (await store.batches(id)).some(
              (batch) => batch.state === "ambiguous",
            ),
        );
        assert.deepEqual(clock.waits, []);
        release.resolve();
        assert.equal((await running).generation.state, "completed");
        assert.deepEqual(events, [{ attempt: 1, delayMs: 5000, batches: 2 }]);
        assert.equal(sends, 5);
      } finally {
        release.resolve();
        await running;
      }
    },
    24,
  );
});

test("another worker's non-429 failure cancels the automatic retry round", async () => {
  let sends = 0;
  await fixture(
    async () =>
      ++sends === 1
        ? limited()
        : Response.json({ error: "down" }, { status: 503 }),
    async ({ store, assistance, id }) => {
      const clock = fakeClock();
      const result = await new SemanticIndexer(store, assistance, clock).run(
        id,
        { concurrency: 2 },
      );
      assert.equal(result.generation.error, "embedding_provider");
      assert.deepEqual(clock.waits, []);
      assert.equal(sends, 2);
    },
    24,
  );
});

test("maxBatches includes initial and linked retry attempts across all rounds", async () => {
  let sends = 0;
  await fixture(
    async (_url, init) =>
      ++sends === 1
        ? limited()
        : success(JSON.parse(String(init?.body)).input.length),
    async ({ store, assistance, id }) => {
      const clock = fakeClock();
      const result = await new SemanticIndexer(store, assistance, clock).run(
        id,
        { concurrency: 1, maxBatches: 2 },
      );
      assert.equal(result.generation.state, "paused");
      assert.equal(result.coverage.indexed, 8);
      assert.equal(sends, 2);
      assert.equal((await store.batches(id)).length, 2);
      assert.deepEqual(clock.waits, [1000]);
    },
    24,
  );
});

test("a full initial batch allowance does not start a retry wait", async () => {
  let sends = 0;
  await fixture(
    async () => {
      sends++;
      return limited();
    },
    async ({ store, assistance, id }) => {
      const clock = fakeClock();
      await new SemanticIndexer(store, assistance, clock).run(id, {
        concurrency: 2,
        maxBatches: 2,
      });
      assert.equal(sends, 2);
      assert.deepEqual(clock.waits, []);
    },
    24,
  );
});

test("cancellation ends the real backoff timer without selecting or sending a new attempt", async () => {
  let sends = 0;
  await fixture(
    async () => {
      sends++;
      return limited("60");
    },
    async ({ store, assistance, id }) => {
      const controller = new AbortController();
      const entered = deferred();
      const running = new SemanticIndexer(store, assistance).run(id, {
        signal: controller.signal,
        onBackoff: () => entered.resolve(),
      });
      await entered.promise;
      controller.abort();
      const result = await running;
      assert.equal(result.generation.state, "paused");
      assert.equal(sends, 1);
      assert.equal((await store.batches(id)).length, 1);
    },
  );
});

test("a reopened store applies the saved cooldown to another generation of the same profile", async () => {
  let sends = 0;
  const clock = fakeClock();
  await fixture(
    async () => (++sends === 1 ? limited("7") : success(1)),
    async ({ store, assistance, id, path }) => {
      await new SemanticIndexer(store, assistance, clock).run(id, {
        maxBatches: 1,
      });
      const old = (await store.batches(id))[0];
      const reopened = new SqliteVectorStore(path);
      try {
        const generation = await prepare(reopened, 1, 2001);
        const events: IndexBackoff[] = [];
        const result = await new SemanticIndexer(
          reopened,
          assistance,
          clock,
        ).run(generation.id, {
          onBackoff: (event) => {
            assert.equal(sends, 1);
            events.push(event);
          },
        });
        assert.equal(result.generation.state, "completed");
        assert.deepEqual(events, [{ attempt: 0, delayMs: 7000, batches: 0 }]);
        assert.equal(sends, 2);
        assert.deepEqual((await reopened.batches(id))[0], old);
        assert.equal((await reopened.batches(generation.id))[0].previous, null);
      } finally {
        reopened.close();
      }
    },
  );
});

test("a saved excessive cooldown blocks new generations after reopen without sending fresh work", async () => {
  let sends = 0;
  const clock = fakeClock();
  await fixture(
    async () => {
      sends++;
      return limited("61");
    },
    async ({ store, assistance, id, path }) => {
      await new SemanticIndexer(store, assistance, clock).run(id);
      const reopened = new SqliteVectorStore(path);
      try {
        const generation = await prepare(reopened, 1, 2001);
        const result = await new SemanticIndexer(
          reopened,
          assistance,
          clock,
        ).run(generation.id);
        assert.equal(result.generation.error, "embedding_rate_limited");
        assert.deepEqual(await reopened.batches(generation.id), []);
        assert.deepEqual(clock.waits, []);
        assert.equal(sends, 1);
      } finally {
        reopened.close();
      }
    },
  );
});

test("a cooldown extended during the wait is read again before dispatch", async () => {
  const clock = fakeClock();
  let sends = 0;
  await fixture(
    async () => {
      sends++;
      return success(1);
    },
    async ({ store, assistance, id }) => {
      const identity = (await store.generation(id)).profile;
      await store.defer(identity, clock.now() + 5000);
      const sleep = clock.sleep.bind(clock);
      clock.sleep = async (delay, signal) => {
        await sleep(delay, signal);
        if (clock.waits.length === 1)
          await store.defer(identity, clock.now() + 3000);
        assert.equal(sends, 0);
      };
      const events: IndexBackoff[] = [];
      const result = await new SemanticIndexer(store, assistance, clock).run(
        id,
        {
          onBackoff: (event) => events.push(event),
        },
      );
      assert.equal(result.generation.state, "completed");
      assert.deepEqual(clock.waits, [5000, 3000]);
      assert(
        events.every((event) => event.attempt === 0 && event.batches === 0),
      );
      assert.equal(sends, 1);
    },
  );
});

test("a cooldown saved by another job stops fresh claims in an active generation", async () => {
  const clock = fakeClock();
  let sends = 0;
  let saveCooldown: (() => Promise<void>) | undefined;
  await fixture(
    async (_url, init) => {
      sends++;
      await saveCooldown!();
      return success(JSON.parse(String(init?.body)).input.length);
    },
    async ({ store, assistance, id }) => {
      const identity = (await store.generation(id)).profile;
      saveCooldown = () => store.defer(identity, clock.now() + 7000);
      const result = await new SemanticIndexer(store, assistance, clock).run(
        id,
        { concurrency: 1 },
      );
      assert.equal(result.generation.error, "embedding_rate_limited");
      assert.equal(result.coverage.indexed, 8);
      assert.equal(result.coverage.pending, 8);
      assert.equal(sends, 1);
      assert.equal((await store.batches(id)).length, 1);
    },
    16,
  );
});

test("the shipped CLI logs backoff before a linked retry and retains the first charge", async () => {
  const base = process.env.JVC_TEST_ROOT ?? tmpdir();
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "semantic-cli-backoff-"));
  const secret = "disposable-cli-embedding-key";
  const path = join(directory, "semantic-vectors.sqlite");
  const keyPath = join(directory, "disposable-key.txt");
  const preload = join(directory, "provider-mock.mjs");
  const eventsPath = join(directory, "call-events.jsonl");
  try {
    const vectors = new SqliteVectorStore(path);
    let id: string;
    try {
      id = (await prepare(vectors)).id;
    } finally {
      vectors.close();
    }
    await writeFile(join(directory, "coordinator.sqlite"), "");
    await writeFile(keyPath, secret, { mode: 0o600 });
    await writeFile(
      preload,
      `
import { appendFileSync } from "node:fs";
const record = (value) => appendFileSync(process.env.JVC_TEST_CLI_EVENTS, JSON.stringify(value) + "\\n");
let calls = 0;
let backoff = false;
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...args) => {
  let event;
  try { event = JSON.parse(String(chunk)); } catch {}
  if (event?.event === "backoff") {
    backoff = true;
    record({ event: "backoff", at: performance.now(), delay_ms: event.delay_ms });
  }
  return write(chunk, ...args);
};
globalThis.fetch = async (url, init) => {
  if (String(url) !== "https://openrouter.ai/api/v1/embeddings") {
    record({ event: "unexpected_url" });
    throw new Error("The fixture blocks every other endpoint.");
  }
  if (new Headers(init?.headers).get("authorization") !== "Bearer disposable-cli-embedding-key")
    throw new Error("The fixture credentials differ.");
  calls++;
  record({ event: "call", at: performance.now(), sequence: calls });
  if (calls === 1) return new Response("Provider fixture rate limit", {
    status: 429, headers: { "retry-after": "0" },
  });
  if (calls !== 2 || !backoff) throw new Error("The fixture expected one logged retry.");
  const request = JSON.parse(String(init?.body));
  return Response.json({
    model: "qwen/qwen3-embedding-8b",
    data: request.input.map((_, index) => ({ index,
      embedding: Array.from({ length: 4096 }, (_, i) => i ? 0 : 1),
    })),
    usage: { prompt_tokens: 100, total_tokens: 100, cost: 0.000001 },
  });
};
`,
    );
    const environment: Record<string, string | undefined> = {
      PATH: process.env.PATH,
      TMPDIR: directory,
      JVC_AI_ENABLED: "enabled",
      JVC_AI_KEY_FILE: keyPath,
      JVC_AI_CONCURRENCY: "1",
      JVC_TEST_CLI_EVENTS: eventsPath,
    };
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        pathToFileURL(preload).href,
        fileURLToPath(
          new URL("../../../apps/server/src/semantic-cli.ts", import.meta.url),
        ),
        "--data",
        directory,
        "--command",
        "run",
        "--job",
        id,
        "--concurrency",
        "1",
        "--max-batches",
        "2",
      ],
      {
        cwd: fileURLToPath(new URL("../../../", import.meta.url)),
        // The generated Worker environment types do not describe this isolated Node process.
        env: environment as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 30000);
    try {
      const code = await exited;
      assert(!timedOut, "The CLI fixture reached its deadline.");
      assert(!stdout.includes(secret));
      assert(!stderr.includes(secret));
      assert.equal(code, 0, "The CLI fixture did not exit successfully.");
      const output = stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        output.map((event) => event.event),
        ["backoff", "run", "status"],
      );
      const [backoff, result, status] = output;
      assert.equal(backoff.job, id);
      assert.equal(backoff.attempt, 1);
      assert.equal(backoff.batches, 1);
      assert(backoff.delay_ms > 0 && backoff.delay_ms <= 1000);
      assert.equal(result.generation.state, "completed");
      assert.deepEqual(result.coverage, {
        eligible: 1,
        indexed: 1,
        pending: 0,
        failed: 0,
      });
      assert.deepEqual(status.coverage, result.coverage);
      assert(Number.isSafeInteger(status.retry_after));
      const events = (await readFile(eventsPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        events.map((event) => event.event),
        ["call", "backoff", "call"],
      );
      assert(events[2].at - events[0].at >= 900);
      assert(events[2].at - events[1].at >= backoff.delay_ms - 5);
      const old = status.batches.find(
        (batch: { state: string }) => batch.state === "ambiguous",
      );
      const next = status.batches.find(
        (batch: { previous: string | null }) => batch.previous === old.id,
      );
      assert.equal(next.state, "completed");
      assert.notEqual(old.operation, next.operation);
      assert.equal(result.summary.unknown_cost_batches, 1);
      assert.equal(result.summary.reported_cost_usd, 0.000001);
      const budget = new SqliteAssistanceBudgetStore(
        join(directory, "assistance-spending.sqlite"),
      );
      try {
        const snapshot = (await budget.load())!;
        assert(snapshot.version === 2);
        assert.equal(snapshot.entries.length, 2);
        const first = snapshot.entries.find(
          (entry) => entry.id === old.operation,
        )!;
        const second = snapshot.entries.find(
          (entry) => entry.id === next.operation,
        )!;
        assert.equal(first.costKnown, false);
        assert.equal(first.settledUsd, quote);
        assert.equal(first.reservedUsd, quote);
        assert.equal(first.active, false);
        assert.equal(second.costKnown, true);
        assert.equal(second.settledUsd, 0.000001);
        assert.equal(second.reservedUsd, 0);
      } finally {
        budget.close();
      }
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await exited.catch(() => {});
    }
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("a stalled 429 body preserves its header cooldown without automatically retrying the timeout", async () => {
  const clock = fakeClock();
  let sends = 0;
  let canceled = false;
  await fixture(
    async () => {
      sends++;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(utf8('{"error":'));
          },
          cancel() {
            canceled = true;
          },
        }),
        { status: 429, headers: { "retry-after": "61" } },
      );
    },
    async ({ store, assistance, budget, id, path }) => {
      const result = await new SemanticIndexer(store, assistance, clock).run(
        id,
      );
      assert.equal(result.generation.error, "embedding_timeout");
      assert.equal(result.generation.state, "paused");
      assert.equal(sends, 1);
      assert.deepEqual(clock.waits, []);
      assert.equal(
        await store.retryAfter(result.generation.profile),
        clock.now() + 61000,
      );
      await assistance.drainEmbeddingTransports();
      assert(canceled);
      const [batch] = await store.batches(id);
      assert.equal(batch.state, "ambiguous");
      const snapshot = (await budget.load())!;
      assert(snapshot.version === 2);
      const charge = snapshot.entries.find(
        (entry) => entry.id === batch.operation,
      )!;
      assert.equal(charge.costKnown, false);
      assert.equal(charge.settledUsd, quote);
      assert.equal(charge.reservedUsd, quote);
      const reopened = new SqliteVectorStore(path);
      try {
        const next = await prepare(reopened, 1, 2001);
        const blocked = await new SemanticIndexer(
          reopened,
          assistance,
          clock,
        ).run(next.id);
        assert.equal(blocked.generation.error, "embedding_rate_limited");
        assert.deepEqual(await reopened.batches(next.id), []);
        assert.equal(sends, 1);
        assert.deepEqual(clock.waits, []);
      } finally {
        reopened.close();
      }
    },
    1,
    { timeoutMs: 40 },
  );
});

test("an already canceled run reports an operator pause without a false rate limit", async () => {
  let sends = 0;
  await fixture(
    async () => {
      sends++;
      return success(1);
    },
    async ({ store, assistance, id }) => {
      const controller = new AbortController();
      controller.abort();
      const result = await new SemanticIndexer(store, assistance).run(id, {
        signal: controller.signal,
      });
      assert.equal(result.generation.error, "index_paused");
      assert.equal(result.generation.state, "paused");
      assert.equal(await store.retryAfter(result.generation.profile), null);
      assert.deepEqual(await store.batches(id), []);
      assert.equal(sends, 0);
    },
  );
});
