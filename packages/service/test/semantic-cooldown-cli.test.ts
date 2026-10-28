import assert from "node:assert/strict";
import { before, test } from "node:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { initializeCore, utf8 } from "../../core/src/index.ts";
import { lockDataDirectory } from "../../importer/src/load-lock.ts";
import { SqliteVectorStore } from "../../../apps/server/src/semantic.ts";
import { SqliteAssistanceBudgetStore } from "../../../apps/server/src/assistance.ts";
import {
  createQwenProfile,
  inputHash,
  profileId,
} from "../src/semantic/profile.ts";
import type {
  IndexBatch,
  IndexCoverage,
  IndexGeneration,
  IndexSummary,
} from "../src/semantic/vector-store.ts";

before(async () =>
  initializeCore(
    await readFile(
      new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  ),
);

const hash = (n: number, prefix = "sha256:") =>
  prefix + n.toString(16).padStart(64, "0");
const secret = "disposable-cooldown-cli-key";
interface Status {
  event: "status";
  generation: IndexGeneration;
  coverage: IndexCoverage;
  summary: IndexSummary;
  compatibility: string | null;
  retry_after: number | null;
  batches: IndexBatch[];
}

async function prepare(
  store: SqliteVectorStore,
  n: number,
  epoch = "42".repeat(16),
) {
  const profile = createQwenProfile(epoch);
  const input = utf8(`Public cooldown fixture definition ${n}.`);
  const generation = await store.create(
    {
      snapshot: hash(n),
      view: hash(100, "jve1:"),
      profile: profileId(profile),
      eligible: 1,
    },
    profile,
  );
  const event = hash(n, "jve1:");
  await store.stage(generation.id, null, {
    documents: [
      {
        event,
        envelope: hash(n + 100),
        body: hash(n + 200),
        extraction_version: 1,
        word: hash(n, "jvw1:"),
        language: "en",
        input,
        input_hash: inputHash(input),
        error: null,
      },
    ],
    next: event,
    done: true,
  });
  return generation;
}

async function ledger(path: string) {
  const budget = new SqliteAssistanceBudgetStore(path);
  try {
    const snapshot = (await budget.load())!;
    assert.equal(snapshot.version, 2);
    return snapshot;
  } finally {
    budget.close();
  }
}

test("the CLI clears a legacy profile cooldown without retrying or changing retained evidence", async () => {
  const base = process.env.JVC_TEST_ROOT ?? tmpdir();
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "semantic-cooldown-cli-"));
  const path = join(directory, "semantic-vectors.sqlite");
  const budgetPath = join(directory, "assistance-spending.sqlite");
  const keyPath = join(directory, "disposable-key.txt");
  const preload = join(directory, "provider-mock.mjs");
  const eventsPath = join(directory, "call-events.jsonl");

  async function cli(
    command: string,
    job: string,
    mode = "blocked",
    expectedCode = 0,
    extra: string[] = [],
  ) {
    const environment: Record<string, string | undefined> = {
      PATH: process.env.PATH,
      TMPDIR: directory,
      JVC_TEST_CLI_EVENTS: eventsPath,
      JVC_TEST_CLI_MODE: mode,
      ...(command === "run"
        ? {
            JVC_AI_ENABLED: "enabled",
            JVC_AI_KEY_FILE: keyPath,
            JVC_AI_CONCURRENCY: "1",
          }
        : {}),
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
        command,
        "--job",
        job,
        ...(command === "run"
          ? ["--concurrency", "1", "--max-batches", "1"]
          : []),
        ...extra,
      ],
      {
        cwd: fileURLToPath(new URL("../../../", import.meta.url)),
        // Worker environment types do not describe this isolated Node process.
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
    }, 10000);
    try {
      const code = await exited;
      assert(!timedOut, "The cooldown CLI fixture reached its deadline.");
      assert(!stdout.includes(secret));
      assert(!stderr.includes(secret));
      assert.equal(
        code,
        expectedCode,
        `Unexpected CLI exit for ${command}: ${stdout}`,
      );
      return stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await exited.catch(() => {});
    }
  }
  const status = async (command: string, job: string, mode = "blocked") => {
    const output = await cli(command, job, mode);
    assert.equal(output.at(-1).event, "status");
    return output.at(-1) as Status;
  };

  try {
    const vectors = new SqliteVectorStore(path);
    let old: IndexGeneration;
    let fresh: IndexGeneration;
    let other: IndexGeneration;
    try {
      old = await prepare(vectors, 1);
      fresh = await prepare(vectors, 2);
      other = await prepare(vectors, 3, "43".repeat(16));
      await vectors.suspend(other.profile, "embedding_model_mismatch");
    } finally {
      vectors.close();
    }
    await writeFile(join(directory, "coordinator.sqlite"), "");
    await writeFile(keyPath, secret, { mode: 0o600 });
    await writeFile(
      preload,
      `
import { appendFileSync } from "node:fs";
globalThis.fetch = async (url, init) => {
  appendFileSync(process.env.JVC_TEST_CLI_EVENTS, process.env.JVC_TEST_CLI_MODE + "\\n");
  if (String(url) !== "https://openrouter.ai/api/v1/embeddings")
    throw new Error("The fixture blocks every other endpoint.");
  if (new Headers(init?.headers).get("authorization") !== "Bearer ${secret}")
    throw new Error("The fixture credentials differ.");
  if (process.env.JVC_TEST_CLI_MODE === "limited")
    return new Response("Fixture rate limit", { status: 429, headers: { "retry-after": "0" } });
  if (process.env.JVC_TEST_CLI_MODE !== "success")
    throw new Error("This command must not dispatch provider work.");
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
    const failed = await status("run", old.id, "limited");
    assert.equal(failed.generation.error, "embedding_rate_limited");
    assert.equal(failed.batches.length, 1);
    const batch = failed.batches[0];
    assert.equal(batch.state, "ambiguous");
    const originalLedger = await ledger(budgetPath);
    assert.equal(originalLedger.entries.length, 1);
    const oldCharge = originalLedger.entries[0];
    assert.equal(oldCharge.id, batch.operation);
    assert.equal(oldCharge.costKnown, false);
    assert.equal(oldCharge.settledUsd, 0.00032);
    assert.equal(oldCharge.reservedUsd, 0.00032);

    // Old databases can contain deadlines that exceed the current write cap.
    const huge = Number.MAX_SAFE_INTEGER;
    const database = new DatabaseSync(path);
    try {
      const insert = database.prepare(
        "INSERT OR REPLACE INTO semantic_profile_backoff(profile,retry_after) VALUES(?,?)",
      );
      insert.run(old.profile, huge);
      insert.run(other.profile, huge - 1);
    } finally {
      database.close();
    }
    const before = await status("status", old.id);
    assert.equal(before.retry_after, huge);
    assert.equal((await status("status", fresh.id)).retry_after, huge);
    const otherBefore = await status("status", other.id);

    const release = await lockDataDirectory(directory, "cooldown-cli-test");
    try {
      const output = await cli("clear-cooldown", old.id, "blocked", 1);
      assert.match(output[0].message, /The data directory is locked/);
    } finally {
      await release();
    }
    const missing = await cli(
      "clear-cooldown",
      "missing-generation",
      "blocked",
      1,
    );
    assert.equal(missing[0].code, "semantic_generation");
    assert.equal((await status("status", old.id)).retry_after, huge);

    // A directory at the ledger path proves that clear does not open the budget.
    const savedBudget = join(directory, "saved-spending.sqlite");
    await rename(budgetPath, savedBudget);
    await mkdir(budgetPath);
    try {
      const cleared = await status("clear-cooldown", old.id);
      assert.deepEqual(cleared, { ...before, retry_after: null });
      assert.deepEqual(await status("clear-cooldown", old.id), cleared);
      assert.equal((await status("status", fresh.id)).retry_after, null);
      assert.deepEqual(await status("status", other.id), otherBefore);
    } finally {
      await rm(budgetPath, { recursive: true });
      await rename(savedBudget, budgetPath);
    }
    assert.deepEqual(await ledger(budgetPath), originalLedger);

    const completed = await status("run", fresh.id, "success");
    assert.equal(completed.generation.state, "completed");
    assert.equal(completed.coverage.indexed, 1);
    assert.equal(completed.batches.length, 1);
    assert.equal(completed.batches[0].previous, null);
    assert.notEqual(completed.batches[0].operation, batch.operation);

    // A resumed job still needs an explicit retry for its old ambiguous batch.
    const resumed = await status("run", old.id);
    assert.equal(resumed.generation.state, "paused");
    assert.equal(resumed.generation.error, "index_incomplete");
    assert.deepEqual(resumed.batches, [batch]);
    assert.equal(resumed.coverage.indexed, 0);
    const currentLedger = await ledger(budgetPath);
    assert.equal(currentLedger.entries.length, 2);
    assert.deepEqual(
      currentLedger.entries.find((entry) => entry.id === oldCharge.id),
      oldCharge,
    );

    const suspended = await status("clear-cooldown", other.id);
    assert.deepEqual(suspended, { ...otherBefore, retry_after: null });
    assert.equal(suspended.compatibility, "embedding_model_mismatch");
    const denied = await cli("run", other.id, "blocked", 1);
    assert.equal(denied[0].code, "semantic_profile_suspended");
    assert.deepEqual((await readFile(eventsPath, "utf8")).trim().split("\n"), [
      "limited",
      "success",
    ]);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("R7 the CLI retires a suspended completed background job after exact unpublication", async () => {
  const base = process.env.JVC_TEST_ROOT ?? tmpdir();
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "semantic-retirement-cli-"));
  const path = join(directory, "semantic-vectors.sqlite");
  const coordinator = new DatabaseSync(join(directory, "coordinator.sqlite"));
  coordinator.close();
  let store: SqliteVectorStore | undefined = new SqliteVectorStore(path);
  try {
    const { BackgroundSemanticIndexer } =
      await import("../src/semantic/background.ts");
    const prepared = await prepare(store, 200);
    const profile = await store.profile(prepared.id);
    const input = utf8("Completed background retirement fixture.");
    const initial = await store.create(
      { ...prepared, eligible: 0, snapshot: hash(199) },
      profile,
    );
    await store.stage(initial.id, null, {
      documents: [],
      next: null,
      done: true,
    });
    await store.start(initial.id);
    await store.finish(initial.id);
    await store.publish(initial.id, null);
    const background = new BackgroundSemanticIndexer({
      store,
      profile: prepared.profile,
      view: prepared.view,
      assistance: {
        embed: async (inputs, _caller, _signal, before) => {
          const operation = "embedding:index:retirement-fixture";
          await before?.(operation);
          return {
            operation,
            model: profile.model,
            vectors: inputs.map(() =>
              Float32Array.from({ length: 4096 }, (_, i) => (i ? 0 : 1)),
            ),
            usage: { inputTokens: 0, totalTokens: 0, costUsd: 0 },
          };
        },
      },
      source: async () => ({
        context: { ...prepared, eligible: 1 },
        page: async () => ({
          documents: [
            {
              event: hash(200, "jve1:"),
              envelope: hash(300),
              body: hash(400),
              extraction_version: 2,
              word: hash(200, "jvw1:"),
              language: "en",
              input,
              input_hash: inputHash(input),
              error: null,
            },
          ],
          next: hash(200, "jve1:"),
          done: true,
        }),
      }),
      probe: async () => {},
      report: (error) => {
        throw error;
      },
    });
    await background.cycle();
    const job = (await store.backgroundGeneration(
      prepared.profile,
      prepared.view,
    ))!;
    assert.equal(job.state, "completed");
    assert.equal((await store.coverage(job.id)).indexed, 1);
    await store.suspend(job.profile, "embedding_model_mismatch");
    await background.close();
    store.close();
    store = undefined;
    async function cli(command: string) {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          fileURLToPath(
            new URL(
              "../../../apps/server/src/semantic-cli.ts",
              import.meta.url,
            ),
          ),
          "--data",
          directory,
          "--command",
          command,
          "--job",
          job.id,
        ],
        {
          cwd: fileURLToPath(new URL("../../../", import.meta.url)),
          env: {
            PATH: process.env.PATH,
            TMPDIR: directory,
          } as unknown as NodeJS.ProcessEnv,
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
      const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
      const code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      }).finally(() => clearTimeout(timer));
      assert.equal(code, 0, `R7 ${command} must succeed: ${stdout} ${stderr}`);
      return stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .at(-1);
    }
    const unpublished = await cli("unpublish");
    assert.equal(unpublished.current, null);
    const retired = await cli("retire");
    assert.equal(retired.generation.state, "retired");
    assert.equal(retired.coverage, null);
    assert.equal(retired.compatibility, "embedding_model_mismatch");
    store = new SqliteVectorStore(path);
    assert.equal(await store.backgroundGeneration(job.profile, job.view), null);
    assert.equal(
      (store as unknown as { database: DatabaseSync }).database
        .prepare("SELECT COUNT(*) AS n FROM semantic_vectors WHERE profile=?")
        .get(job.profile)?.n,
      0,
    );
    await assert.rejects(store.setBackgroundGeneration(job.id), /retired/);
  } finally {
    store?.close();
    await rm(directory, { recursive: true });
  }
});
