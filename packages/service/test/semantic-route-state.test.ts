import assert from "node:assert/strict";
import { before, test } from "node:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  initializeCore,
  semanticProjectionVersion,
  utf8,
} from "../../core/src/index.ts";
import { SqliteVectorStore } from "../../../apps/server/src/semantic.ts";
import {
  createQwenProfile,
  inputHash,
  profileId,
} from "../src/semantic/profile.ts";
import { SemanticIndexer } from "../src/semantic/indexer.ts";
import { AssistanceService } from "../src/assistance.ts";
import { providerConfig } from "../src/inference.ts";

before(async () =>
  initializeCore(
    await readFile(
      new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  ),
);
const hash = (n: number, prefix = "sha256:") =>
  prefix + n.toString(16).padStart(64, "0");
const profile = createQwenProfile("36".repeat(16));
const unit = () => Float32Array.from({ length: 4096 }, (_, i) => (i ? 0 : 1));

for (const legacy of [false, true]) {
  test(
    legacy
      ? "legacy batches remain unknown and the old cooldown migrates once"
      : "batch routes survive retries and restart while vectors remain reusable",
    async () => {
      const context = {
        snapshot: hash(100),
        view: hash(101, "jve1:"),
        profile: profileId(profile),
        eligible: 2,
      };
      const documents = Array.from({ length: 2 }, (_, i) => {
        const input = utf8(`Route provenance definition ${i}.`);
        return {
          event: hash(i + 1, "jve1:"),
          envelope: hash(i + 10),
          body: hash(i + 20),
          word: hash(i + 30, "jvw1:"),
          language: "en",
          extraction_version: semanticProjectionVersion(),
          input,
          input_hash: inputHash(input),
          error: null,
        };
      });

      const root = process.env.JVC_TEST_ROOT ?? tmpdir();
      await mkdir(root, { recursive: true });
      const directory = await mkdtemp(join(root, "route-state-"));
      const path = join(directory, "vectors.sqlite");
      let store = new SqliteVectorStore(path);
      try {
        const job = await store.create(context, profile);
        await store.stage(job.id, null, {
          documents,
          next: documents.at(-1)!.event,
          done: true,
        });
        const config = providerConfig(
          { JVC_AI_ENABLED: "enabled" },
          async () => "disposable-route-state-key",
        )!;
        let limited = true;
        config.fetch = async (_url, init) => {
          const body = JSON.parse(String(init?.body));
          if (limited && body.provider.only[0] === "nebius")
            return new Response("", {
              status: 429,
              headers: { "retry-after": "60" },
            });
          return Response.json({
            model: profile.model,
            data: body.input.map((_: unknown, index: number) => ({
              index,
              embedding: [...unit()],
            })),
            usage: { prompt_tokens: 1, total_tokens: 1, cost: 0.000001 },
          });
        };
        const assistance = new AssistanceService(
          { provider: config },
          "route-state",
          async () => [],
        );
        const indexer = new SemanticIndexer(store, assistance, {
          now: () => Date.now(),
          sleep: async () =>
            assert.fail("The second provider must not inherit a cooldown."),
        });
        try {
          await indexer.run(job.id, {
            route: "nebius",
            automaticRetries: false,
          });
          const [failed] = await store.batches(job.id);
          assert.equal(failed.route, "nebius");
          assert.equal(failed.error, "embedding_rate_limited");
          assert(
            (await store.retryAfter(context.profile, "nebius"))! > Date.now(),
          );
          assert.equal(
            await store.retryAfter(context.profile, "siliconflow/fp8"),
            null,
          );
          await store.retry(failed.id);
          limited = false;
          const done = await indexer.run(job.id, { route: "siliconflow/fp8" });
          assert.equal(done.generation.state, "completed");
          const retry = (await store.batches(job.id)).find(
            (batch) => batch.previous === failed.id,
          )!;
          assert.equal(retry.route, "siliconflow/fp8");
          const next = await store.create(
            { ...context, snapshot: hash(102) },
            profile,
          );
          await store.stage(next.id, null, {
            documents,
            next: documents.at(-1)!.event,
            done: true,
          });
          assert.equal((await store.coverage(next.id)).indexed, 2);
          assert.equal(await store.reusableInputs(next.id), 2);
          store.close();
          if (legacy) {
            const sql = new DatabaseSync(path);
            try {
              sql.exec("ALTER TABLE semantic_batches DROP COLUMN route");
              sql.exec("DROP TABLE semantic_profile_backoff");
              sql.exec(
                "CREATE TABLE semantic_profile_backoff(profile TEXT PRIMARY KEY,retry_after INTEGER NOT NULL)",
              );
              sql
                .prepare("INSERT INTO semantic_profile_backoff VALUES(?,?)")
                .run(context.profile, 123456);
            } finally {
              sql.close();
            }
          }
          store = new SqliteVectorStore(path);
          const batches = await store.batches(job.id);
          assert.equal(
            batches.find((batch) => batch.id === failed.id)!.route,
            legacy ? null : "nebius",
          );
          assert.equal(
            batches.find((batch) => batch.id === retry.id)!.route,
            legacy ? null : "siliconflow/fp8",
          );
          assert.equal((await store.coverage(next.id)).indexed, 2);
          if (legacy) {
            assert.equal(
              await store.retryAfter(context.profile, "siliconflow/fp8"),
              123456,
            );
            assert.equal(
              await store.retryAfter(context.profile, "nebius"),
              null,
            );
            store.close();
            store = new SqliteVectorStore(path);
            assert.equal(
              await store.retryAfter(context.profile, "siliconflow/fp8"),
              123456,
            );
          }
        } finally {
          await assistance.drainEmbeddingTransports();
        }
      } finally {
        store.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}
