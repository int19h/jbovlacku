import assert from "node:assert/strict";
import { before, test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createEvent,
  initializeCore,
  semanticProjectionVersion,
  utf8,
  wordId,
} from "../../core/src/index.ts";
import { DictionaryService } from "../src/service.ts";
import { SemanticIndexer } from "../src/semantic/indexer.ts";
import {
  createQwenProfile,
  profileId,
  inputHash,
} from "../src/semantic/profile.ts";
import {
  FileObjectStore,
  SqliteCoordinator,
} from "../../../apps/server/src/storage.ts";
import { SqliteVectorStore } from "../../../apps/server/src/semantic.ts";
import { SqliteAssistanceBudgetStore } from "../../../apps/server/src/assistance.ts";

before(async () =>
  initializeCore(
    await readFile(
      new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  ),
);
const hash = (n: number, prefix = "sha256:") =>
  prefix + n.toString(16).padStart(64, "0");
const unit = () => Float32Array.from({ length: 4096 }, (_, i) => (i ? 0 : 1));
const seed = new Uint8Array(32).fill(83);
const viewBody = {
  name: "Operator test",
  description: [],
  notes: [],
  roots: [],
  rafsi_threshold: { numerator: 1, denominator: 1 },
  H: { numerator: 3, denominator: 1 },
  alpha: { numerator: 1, denominator: 2 },
  excluded: [],
  calculation: "simple-routes-bounds-v1",
  work: 1000,
  import_sets: [],
  account_witnesses: [],
  account_authority: false,
};
const word = { language: "jbo", spelling: "klama" } as const;
const definitionBody = (text: string) => ({
  word,
  language: "en",
  text: [[text]],
  frame: null,
  operands: [],
  glosses: [],
  notes: [],
  etymology: { text: [], formation: null, compound: null },
  examples: [],
  classification: { kind: "gismu", selmaho: [] },
  labels: [],
  sources: [],
  license: {
    expression: "CC0-1.0",
    url: "https://creativecommons.org/publicdomain/zero/1.0/",
    attribution: "",
  },
  legacy: null,
});
async function fixture(
  run: (value: {
    directory: string;
    vectors: SqliteVectorStore;
    service: DictionaryService;
    view: string;
    definition: ReturnType<typeof createEvent>;
    profile: ReturnType<typeof createQwenProfile>;
  }) => Promise<void>,
) {
  const base = process.env.JVC_TEST_ROOT ?? tmpdir();
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "operator-cli-"));
  const coordinator = new SqliteCoordinator(
    join(directory, "coordinator.sqlite"),
  );
  const vectors = new SqliteVectorStore(
    join(directory, "semantic-vectors.sqlite"),
  );
  const view = createEvent(
    seed,
    [],
    "a".repeat(32),
    { kind: "view.publish", parents: [] },
    viewBody,
  );
  const one = createEvent(
    seed,
    [view.envelope.id],
    "b".repeat(32),
    {
      kind: "definition.publish",
      word: wordId(word),
      language: "en",
      parents: [],
      origin: "native",
    },
    definitionBody("A traveler goes somewhere."),
  );
  const two = createEvent(
    seed,
    [view.envelope.id],
    "c".repeat(32),
    {
      kind: "definition.publish",
      word: wordId(word),
      language: "en",
      parents: [],
      origin: "native",
    },
    definitionBody("A second traveler goes elsewhere."),
  );
  const service = new DictionaryService(
    new FileObjectStore(join(directory, "objects")),
    coordinator,
    {
      serverId: "operator-test",
      selectedView: view.envelope.id,
      policyUrl: "https://example.invalid",
    },
  );
  const profile = createQwenProfile("19".repeat(16));
  try {
    await service.admitMany(
      [view, one, two].map((event) => utf8(JSON.stringify(event))),
    );
    const source = await service.semanticSource(profile);
    const generation = await vectors.create(source.context, profile);
    const indexer = new SemanticIndexer(vectors, {
      embed: async (inputs, _caller, _signal, before) => {
        const operation = "embedding:index:operator-fixture";
        await before?.(operation);
        return {
          operation,
          model: profile.model,
          vectors: inputs.map(unit),
          usage: {
            inputTokens: inputs.length,
            totalTokens: inputs.length,
            costUsd: 0.000001,
          },
        };
      },
    });
    await indexer.prepare(generation.id, source);
    await indexer.run(generation.id);
    await run({
      directory,
      vectors,
      service,
      view: view.envelope.id,
      definition: two,
      profile,
    });
  } finally {
    await service.prepareEvaluationShutdown();
    vectors.close();
    coordinator.close();
    await rm(directory, { recursive: true });
  }
}
async function cli(
  directory: string,
  args: string[],
  env: Record<string, string> = {},
  preload?: string,
) {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--import",
      "tsx",
      ...(preload ? ["--import", pathToFileURL(preload).href] : []),
      fileURLToPath(
        new URL("../../../apps/server/src/semantic-cli.ts", import.meta.url),
      ),
      "--data",
      directory,
      ...args,
    ],
    {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      env: { PATH: process.env.PATH, TMPDIR: directory, ...env },
      timeout: 30000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  return stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

test("operator prepare reuses an existing profile across views and rejects unsafe reuse", async () =>
  fixture(
    async ({ directory, vectors, service, view, definition, profile }) => {
      const nextView = createEvent(
        seed,
        [view],
        "d".repeat(32),
        { kind: "view.publish", parents: [] },
        { ...viewBody, name: "New operator view" },
      );
      const revision = createEvent(
        seed,
        [definition.envelope.id],
        "e".repeat(32),
        {
          kind: "definition.publish",
          word: wordId(word),
          language: "en",
          parents: [definition.envelope.id],
          origin: "native",
        },
        definitionBody("The traveler uses a changed definition."),
      );
      await service.admitMany(
        [nextView, revision].map((event) => utf8(JSON.stringify(event))),
      );
      const env = { JVC_VIEW: nextView.envelope.id };
      const selected = profileId(profile);
      const output = await cli(
        directory,
        ["--command", "prepare", "--profile", selected],
        env,
      );
      const prepared = output.find((row) => row.event === "prepared");
      assert.equal(prepared.generation.profile, selected);
      assert.equal(prepared.generation.view, nextView.envelope.id);
      assert.equal(prepared.reused_inputs, 2);
      const changed = (await vectors.page(prepared.generation.id)).rows.find(
        (row) => row.event === revision.envelope.id,
      )!;
      assert(changed);
      assert.equal(changed.vector, null);
      assert.deepEqual(output.at(-1).coverage, {
        eligible: 3,
        indexed: 2,
        pending: 1,
        failed: 0,
      });
      const fresh = await cli(directory, ["--command", "prepare"], env);
      assert.notEqual(fresh[0].generation.profile, selected);
      assert.equal(
        fresh.find((row) => row.event === "prepared").reused_inputs,
        0,
      );
      await assert.rejects(
        cli(directory, ["--command", "prepare", "--profile", hash(99999)], env),
        (failure: any) =>
          failure.stdout.includes("stored embedding profile is unavailable"),
      );
      const incompatible = {
        ...profile,
        runtime: { name: "different-runtime", version: "1" },
      };
      await vectors.create(
        {
          snapshot: hash(9991),
          view,
          profile: profileId(incompatible),
          eligible: 0,
        },
        incompatible,
      );
      await assert.rejects(
        cli(
          directory,
          ["--command", "prepare", "--profile", profileId(incompatible)],
          env,
        ),
        (failure: any) => failure.stdout.includes("incompatible"),
      );
      await assert.rejects(
        cli(
          directory,
          [
            "--command",
            "prepare",
            "--job",
            prepared.generation.id,
            "--profile",
            fresh[0].generation.profile,
          ],
          env,
        ),
        (failure: any) =>
          failure.stdout.includes(
            "The selected profile does not match the saved job.",
          ),
      );
      await vectors.suspend(selected, "semantic_model_drift");
      await assert.rejects(
        cli(directory, ["--command", "prepare", "--profile", selected], env),
        (failure: any) => failure.stdout.includes("suspended"),
      );
    },
  ));

test("operator prepare selects a route and preserves stored profile routes", async () =>
  fixture(async ({ directory, vectors, profile, view }) => {
    const env = { JVC_VIEW: view };
    const prepared = async (args: string[]) =>
      (await cli(directory, ["--command", "prepare", ...args], env)).find(
        (row) => row.event === "prepared",
      ).generation;
    const fresh = await prepared([]);
    const freshProfile = await vectors.profile(fresh.id);
    assert.equal(freshProfile.provider, "openrouter:nebius");
    assert.equal(freshProfile.parameters.route, "nebius");
    const routed = await prepared(["--route", "deepinfra/us"]);
    const routedProfile = await vectors.profile(routed.id);
    assert.equal(routedProfile.provider, "openrouter:deepinfra/us");
    assert.equal(routedProfile.parameters.route, "deepinfra/us");
    assert.notEqual(routed.profile, fresh.profile);
    const reused = await prepared(["--profile", routed.profile]);
    assert.equal(reused.profile, routed.profile);
    assert.equal(
      (await vectors.profile(reused.id)).provider,
      "openrouter:deepinfra/us",
    );
    const matching = await prepared([
      "--profile",
      routed.profile,
      "--route",
      "deepinfra/us",
    ]);
    assert.equal(matching.profile, routed.profile);
    const saved = await prepared(["--job", routed.id]);
    assert.equal(saved.id, routed.id);
    assert.equal(saved.profile, routed.profile);
    const matchingJob = await prepared([
      "--job",
      routed.id,
      "--route",
      "deepinfra/us",
    ]);
    assert.equal(matchingJob.id, routed.id);
    assert.equal(matchingJob.profile, routed.profile);
    const legacy = await prepared(["--profile", profileId(profile)]);
    assert.equal(legacy.profile, profileId(profile));
    const explicitDefault = await prepared(["--route", "nebius"]);
    assert.equal(
      (await vectors.profile(explicitDefault.id)).provider,
      "openrouter:nebius",
    );
    for (const selector of [
      ["--profile", routed.profile],
      ["--job", routed.id],
      ["--job", routed.id, "--profile", routed.profile],
    ]) {
      await assert.rejects(
        prepared([...selector, "--route", "nebius"]),
        (failure: any) =>
          failure.stdout.includes(
            "The selected route does not match the stored profile.",
          ),
      );
    }
    for (const route of ["unknown", "deepinfra", "DeepInfra/US", ""]) {
      await assert.rejects(prepared(["--route", route]), (failure: any) =>
        failure.stdout.includes(
          route
            ? "Use nebius or deepinfra/us with --route."
            : "Use semantic-cli.ts",
        ),
      );
    }
    await assert.rejects(
      cli(directory, [
        "--command",
        "status",
        "--job",
        routed.id,
        "--route",
        "deepinfra/us",
      ]),
      (failure: any) =>
        failure.stdout.includes("Use --route only with prepare."),
    );
    assert.equal((await vectors.generation(routed.id)).profile, routed.profile);
  }));

test("the shipped operator run admits eight large batches despite user ceilings and honors its own cost ceiling", async () =>
  fixture(async ({ directory, vectors, view }) => {
    const profile = createQwenProfile("29".repeat(16), "deepinfra/us");
    async function generation(prefix: string, count: number) {
      const job = await vectors.create(
        {
          snapshot: hash(9992),
          view,
          profile: profileId(profile),
          eligible: count,
        },
        profile,
      );
      for (let offset = 0; offset < count; offset += 128) {
        const documents = Array.from(
          { length: Math.min(128, count - offset) },
          (_, j) => {
            const i = j + offset;
            const input = utf8(`${prefix} ${i}`);
            return {
              event: hash(i + 10000, "jve1:"),
              envelope: hash(i + 20000),
              body: hash(i + 30000),
              word: hash(i + 40000, "jvw1:"),
              language: "en",
              extraction_version: semanticProjectionVersion(),
              input,
              input_hash: inputHash(input),
              error: null,
            };
          },
        );
        await vectors.stage(
          job.id,
          offset ? hash(offset - 1 + 10000, "jve1:") : null,
          {
            documents,
            next: documents.at(-1)!.event,
            done: offset + documents.length === count,
          },
        );
      }
      return job;
    }
    const job = await generation("Bulk operator input", 256);
    const key = join(directory, "disposable-key.txt");
    await writeFile(key, "disposable-operator-key", { mode: 0o600 });
    const evidence = join(directory, "mock-calls.jsonl");
    const preload = join(directory, "mock-provider.mjs");
    await writeFile(
      preload,
      `import { appendFileSync } from 'node:fs';
let active=0; let release; const gate=new Promise(resolve=>{release=resolve;});
globalThis.fetch=async(url,init)=>{if(String(url)!=='https://openrouter.ai/api/v1/embeddings')throw new Error('Unexpected network request');
const body=JSON.parse(init.body); active++; appendFileSync(process.env.OPERATOR_TEST_EVIDENCE,JSON.stringify({active,count:body.input.length,provider:body.provider})+'\\n'); if(active===Number(process.env.OPERATOR_TEST_GATE??8))release(); await gate; active--;
return Response.json({model:'qwen/qwen3-embedding-8b',data:body.input.map((_,index)=>({index,embedding:Array.from({length:4096},(_,i)=>i?0:1)})),usage:{prompt_tokens:1,total_tokens:1,cost:0.000001}});};`,
    );
    const env = {
      JVC_AI_ENABLED: "enabled",
      JVC_AI_KEY_FILE: key,
      JVC_AI_CONCURRENCY: "1",
      JVC_AI_HOURLY_BUDGET_USD: "0.000001",
      JVC_AI_DAILY_BUDGET_USD: "0.000001",
      JVC_AI_MAX_COST_USD: "0.000001",
      OPERATOR_TEST_EVIDENCE: evidence,
    };
    const output = await cli(
      directory,
      [
        "--command",
        "run",
        "--job",
        job.id,
        "--concurrency",
        "8",
        "--batch-size",
        "32",
      ],
      env,
      preload,
    );
    const result = output.find((row) => row.event === "run");
    assert.equal(result.generation.state, "completed");
    assert.equal(result.coverage.indexed, 256);
    const calls = (await readFile(evidence, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(calls.length, 8);
    assert.equal(Math.max(...calls.map((call) => call.active)), 8);
    assert(calls.every((call) => call.count === 32));
    assert(
      calls.every(
        (call) =>
          JSON.stringify(call.provider.only) ===
            JSON.stringify(["deepinfra/us"]) &&
          call.provider.allow_fallbacks === false,
      ),
    );
    const ledger = new SqliteAssistanceBudgetStore(
      join(directory, "assistance-spending.sqlite"),
    );
    try {
      const snapshot = await ledger.load();
      assert(snapshot);
      assert(
        Math.abs(
          snapshot.entries.reduce((sum, entry) => sum + entry.settledUsd, 0) -
            0.000008,
        ) < 1e-12,
      );
    } finally {
      ledger.close();
    }
    const limited = await generation("Cost ceiling input", 32);
    const stopped = await cli(
      directory,
      ["--command", "run", "--job", limited.id, "--max-cost-usd", "0"],
      env,
      preload,
    );
    assert.equal(
      stopped.find((row) => row.event === "run").generation.error,
      "billing_operator_limit",
    );
    assert.equal(
      (await readFile(evidence, "utf8")).trim().split("\n").length,
      8,
    );
    const resumed = await cli(
      directory,
      ["--command", "run", "--job", limited.id, "--max-cost-usd", "10"],
      { ...env, OPERATOR_TEST_GATE: "1" },
      preload,
    );
    assert.equal(
      resumed.find((row) => row.event === "run").generation.state,
      "completed",
    );
    assert.equal(
      resumed.find((row) => row.event === "run").coverage.indexed,
      32,
    );
    const resumedCalls = (await readFile(evidence, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(resumedCalls.length, 9);
    assert.equal(resumedCalls.at(-1).count, 32);
  }));

test("bulk retry walks all pages and keeps the store ownership checks", async () =>
  fixture(async ({ directory, vectors, profile, view }) => {
    const job = await vectors.create(
      { snapshot: hash(9993), view, profile: profileId(profile), eligible: 72 },
      profile,
    );
    const documents = Array.from({ length: 72 }, (_, i) => {
      const input = utf8(`Retry input ${i}`);
      return {
        event: hash(i + 50000, "jve1:"),
        envelope: hash(i + 60000),
        body: hash(i + 70000),
        word: hash(i + 80000, "jvw1:"),
        language: "en",
        extraction_version: semanticProjectionVersion(),
        input,
        input_hash: inputHash(input),
        error: null,
      };
    });
    await vectors.stage(job.id, null, {
      documents,
      next: documents.at(-1)!.event,
      done: true,
    });
    await vectors.start(job.id);
    const failed: Awaited<ReturnType<SqliteVectorStore["batches"]>> = [];
    for (let i = 0; i < 70; i++) {
      const batch = (await vectors.claim(job.id, undefined, {
        batchSize: 1,
        batchBytes: 4096,
      }))!;
      if (i % 2) await vectors.sent(batch.id, `embedding:index:retry-${i}`);
      await vectors.fail(batch.id, "fixture_failure");
      failed.push(batch);
    }
    // Leave two active intents. Bulk selection must leave these alone.
    const prepared = (await vectors.claim(job.id, undefined, {
      batchSize: 1,
      batchBytes: 4096,
    }))!;
    const sent = (await vectors.claim(job.id, undefined, {
      batchSize: 1,
      batchBytes: 4096,
    }))!;
    await vectors.sent(sent.id, "embedding:index:still-sent");
    await vectors.pause(job.id);
    await vectors.retry(failed[0].id);
    await vectors.start(job.id);
    const replacement = (await vectors.claim(job.id))!;
    assert.equal(replacement.previous, failed[0].id);
    await vectors.fail(replacement.id, "fixture_failure");
    await vectors.pause(job.id);

    const other = await vectors.create(
      { snapshot: hash(9994), view, profile: profileId(profile), eligible: 1 },
      profile,
    );
    await vectors.stage(other.id, null, {
      documents: [documents[0]],
      next: documents[0].event,
      done: true,
    });
    await vectors.start(other.id);
    const otherBatch = (await vectors.claim(other.id))!;
    await vectors.fail(otherBatch.id, "fixture_failure");
    await vectors.pause(other.id);

    const output = await cli(directory, [
      "--command",
      "retry",
      "--job",
      job.id,
      "--all",
    ]);
    assert.deepEqual(
      output.find((row) => row.event === "retry"),
      {
        event: "retry",
        job: job.id,
        selected: 70,
        skipped: 1,
      },
    );
    const secondPage = await vectors.batches(
      job.id,
      output.at(-1).batches_next,
    );
    assert(secondPage.length > 0);
    const late = secondPage.find(
      (batch) =>
        ["failed", "ambiguous"].includes(batch.state) &&
        batch.id !== failed[0].id,
    )!;
    assert(late);
    await cli(directory, [
      "--command",
      "retry",
      "--job",
      job.id,
      "--batch",
      late.id,
    ]);
    await assert.rejects(
      cli(directory, [
        "--command",
        "retry",
        "--job",
        job.id,
        "--batch",
        failed[0].id,
      ]),
      (failure: any) =>
        failure.stdout.includes("A later attempt already owns these inputs."),
    );
    const repeated = await cli(directory, [
      "--command",
      "retry",
      "--job",
      job.id,
      "--all",
    ]);
    assert.equal(repeated.find((row) => row.event === "retry").selected, 70);
    await vectors.start(job.id);
    const selected = [];
    for (;;) {
      const batch = await vectors.claim(job.id);
      if (!batch) break;
      selected.push(batch.previous);
      await vectors.fail(batch.id, "fixture_failure");
    }
    assert.equal(selected.length, 70);
    assert.equal(new Set(selected).size, 70);
    assert(!selected.includes(failed[0].id));
    assert(!selected.includes(prepared.id));
    assert(!selected.includes(sent.id));
    await vectors.start(other.id);
    assert.equal(await vectors.claim(other.id), null);
  }));

test("bulk retry rejects missing, conflicting, and misplaced selectors", async () =>
  fixture(async ({ directory, vectors, profile, view }) => {
    const job = await vectors.create(
      { snapshot: hash(9995), view, profile: profileId(profile), eligible: 0 },
      profile,
    );
    for (const selectors of [[], ["--all", "--batch", "unused"]]) {
      await assert.rejects(
        cli(directory, ["--command", "retry", "--job", job.id, ...selectors]),
        (failure: any) =>
          failure.stdout.includes("Use either --batch ID or --all with retry."),
      );
    }
    await assert.rejects(
      cli(directory, ["--command", "status", "--job", job.id, "--all"]),
      (failure: any) => failure.stdout.includes("Use --all only with retry."),
    );
    await vectors.stage(job.id, null, {
      documents: [],
      next: null,
      done: true,
    });
    await vectors.start(job.id);
    await assert.rejects(
      cli(directory, ["--command", "retry", "--job", job.id, "--all"]),
      (failure: any) => failure.stdout.includes("Pause the generation"),
    );
    await vectors.pause(job.id);
    const output = await cli(directory, [
      "--command",
      "retry",
      "--job",
      job.id,
      "--all",
    ]);
    assert.deepEqual(
      output.find((row) => row.event === "retry"),
      {
        event: "retry",
        job: job.id,
        selected: 0,
        skipped: 0,
      },
    );
  }));

test("status lists every saved generation in its job scope with a separate cursor", async () =>
  fixture(async ({ directory, vectors, profile, view }) => {
    const context = {
      snapshot: hash(10001),
      view,
      profile: profileId(profile),
      eligible: 0,
    };
    const anchor = await vectors.create({ ...context, eligible: 2 }, profile);
    const documents = Array.from({ length: 2 }, (_, i) => {
      const input = utf8(`Generation status input ${i}`);
      return {
        event: hash(i + 11000, "jve1:"),
        envelope: hash(i + 12000),
        body: hash(i + 13000),
        word: hash(i + 14000, "jvw1:"),
        language: "en",
        extraction_version: semanticProjectionVersion(),
        input,
        input_hash: inputHash(input),
        error: null,
      };
    });
    await vectors.stage(anchor.id, null, {
      documents,
      next: documents.at(-1)!.event,
      done: true,
    });
    await vectors.start(anchor.id);
    for (let i = 0; i < 2; i++) {
      const batch = (await vectors.claim(anchor.id, undefined, {
        batchSize: 1,
        batchBytes: 4096,
      }))!;
      await vectors.fail(batch.id, "fixture_failure");
    }
    await vectors.pause(anchor.id);
    const ids = [
      anchor.id,
      ...(await vectors.generations(context.profile, view))
        .filter((row) => row.id !== anchor.id)
        .map((row) => row.id),
    ];
    let retired = "";
    let orphan = "";
    for (let i = 0; i < 64; i++) {
      const generation = await vectors.create(
        { ...context, snapshot: hash(15000 + i) },
        profile,
      );
      ids.push(generation.id);
      if (i < 2) await vectors.setBackgroundGeneration(generation.id);
      if (i === 0) orphan = generation.id;
      if (i >= 2) {
        await vectors.retire(generation.id);
        if (i === 2) retired = generation.id;
      }
    }
    const otherView = await vectors.create(
      { ...context, view: hash(16000, "jve1:") },
      profile,
    );
    const different = createQwenProfile("25".repeat(16));
    const otherProfile = await vectors.create(
      { ...context, profile: profileId(different) },
      different,
    );
    const expected = ids.sort();
    const first = (
      await cli(directory, ["--command", "status", "--job", anchor.id])
    ).at(-1);
    assert.equal(first.generations.length, 64);
    assert.deepEqual(
      first.generations.map((row: any) => row.id),
      expected.slice(0, 64),
    );
    assert.equal(first.generations_next, expected[63]);
    const second = (
      await cli(directory, [
        "--command",
        "status",
        "--job",
        anchor.id,
        "--generations-after",
        first.generations_next,
      ])
    ).at(-1);
    assert.deepEqual(
      second.generations.map((row: any) => row.id),
      expected.slice(64),
    );
    assert.equal(second.generations_next, null);
    const rows = [...first.generations, ...second.generations];
    assert.equal(rows.find((row: any) => row.id === retired).state, "retired");
    assert(rows.some((row: any) => row.id === orphan));
    assert(
      !rows.some((row: any) =>
        [otherView.id, otherProfile.id].includes(row.id),
      ),
    );
    assert.deepEqual(
      second.batches,
      first.batches,
      "The generation cursor must not change the batch page",
    );
    const batchPage = (
      await cli(directory, [
        "--command",
        "status",
        "--job",
        anchor.id,
        "--after",
        first.batches[0].id,
      ])
    ).at(-1);
    assert.deepEqual(batchPage.generations, first.generations);
    assert.deepEqual(
      batchPage.batches.map((row: any) => row.id),
      [first.batches[1].id],
    );
    const small = await vectors.generations(context.profile, view, null, 3);
    assert.deepEqual(
      small.map((row) => row.id),
      expected.slice(0, 3),
    );
    assert.deepEqual(
      (
        await vectors.generations(context.profile, view, small.at(-1)!.id, 3)
      ).map((row) => row.id),
      expected.slice(3, 6),
    );
    assert.deepEqual(
      await vectors.generations(context.profile, view, expected.at(-1)!),
      [],
    );
    for (const limit of [0, 65, 1.5])
      await assert.rejects(
        vectors.generations(context.profile, view, null, limit),
        /one through 64 rows/,
      );
    await assert.rejects(
      cli(directory, [
        "--command",
        "prepare",
        "--generations-after",
        anchor.id,
      ]),
      (failure: any) =>
        failure.stdout.includes("Use --generations-after only with status."),
    );
    for (const args of [
      ["--generations-after"],
      ["--generations-after", anchor.id, "--generations-after", anchor.id],
    ])
      await assert.rejects(
        cli(directory, ["--command", "status", "--job", anchor.id, ...args]),
      );
  }));
