import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

// The existing lock pins Wrangler 4.149.0, Miniflare 5.20261006.1-alpha,
// and workerd 1.20261006.1. This uses that host without new dependencies.
test(
  "workerd embeds through real fetch and refuses a redirect without following it",
  { timeout: 20000 },
  async () => {
    const root = process.env.JVC_TEST_ROOT ?? tmpdir();
    await mkdir(root, { recursive: true });
    const scratch = await mkdtemp(join(root, "embedding-workerd-"));
    const paths: string[] = [];
    const value = {
      model: "Qwen/Qwen3-Embedding-8B",
      data: [
        {
          index: 0,
          embedding: Array.from({ length: 4096 }, (_, index) =>
            index ? 0 : 2,
          ),
        },
      ],
      usage: { prompt_tokens: 3, total_tokens: 3, cost: 0.00000003 },
    };
    const mock = createServer((request, response) => {
      paths.push(request.url!);
      response.setHeader("content-type", "application/json");
      if (request.url === "/generation/chat/completions") {
        response.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  tool_calls: [
                    {
                      id: "answer",
                      type: "function",
                      function: {
                        name: "submit_answer",
                        arguments: JSON.stringify({
                          word_type: "gismu",
                          reason: "Root.",
                        }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.000001 },
          }),
        );
        return;
      }
      if (request.url === "/redirect/embeddings") {
        response.statusCode = 302;
        response.setHeader("location", "/redirect-target");
      }
      response.end(JSON.stringify(value));
    });
    let worker: Miniflare | undefined;
    try {
      await new Promise<void>((resolve) =>
        mock.listen(0, "127.0.0.1", resolve),
      );
      const address = mock.address();
      assert(address && typeof address === "object");
      const bundle = await build({
        entryPoints: [
          fileURLToPath(
            new URL("./fixtures/embedding-worker.ts", import.meta.url),
          ),
        ],
        bundle: true,
        write: false,
        platform: "browser",
        format: "esm",
        target: "es2023",
      });
      worker = new Miniflare({
        ...convertV4MiniflareOptions({
          modules: true,
          script: bundle.outputFiles[0].text,
          compatibilityDate: "2026-10-11",
          bindings: { MOCK_ORIGIN: `http://127.0.0.1:${address.port}` },
          rootPath: scratch,
          cf: false,
          host: "127.0.0.1",
          port: 0,
        }),
        resourceTmpPath: scratch,
        resourcePersistencePath: scratch,
      });
      const success = (await (
        await worker.dispatchFetch("http://localhost/test")
      ).json()) as any;
      assert.deepEqual(success, {
        success: true,
        model: "Qwen/Qwen3-Embedding-8B",
        dimensions: 4096,
        usage: { inputTokens: 3, totalTokens: 3, costUsd: 0.00000003 },
        sent: true,
        costReports: 1,
      });
      const redirect = (await (
        await worker.dispatchFetch("http://localhost/test?mode=redirect")
      ).json()) as any;
      assert.deepEqual(redirect, {
        success: false,
        code: "embedding_provider",
        sent: true,
        costReports: 0,
      });
      assert.deepEqual(paths, ["/good/embeddings", "/redirect/embeddings"]);
      for (const field of [
        "JVC_AI_EMBEDDING_MODEL",
        "JVC_AI_EMBEDDING_PROVIDER_ROUTE",
        "JVC_AI_EMBEDDING_INPUT_PRICE",
      ]) {
        const generation = (await (
          await worker.dispatchFetch(
            `http://localhost/generation?field=${field}`,
          )
        ).json()) as any;
        assert.deepEqual(generation.answer, {
          word_type: "gismu",
          reason: "Root.",
        });
        assert.equal(generation.embedding, false);
        assert.equal(generation.answers, 1);
        assert.equal(
          generation.diagnostic,
          `Embedding inference is disabled because ${field} is invalid.`,
        );
      }
      assert.deepEqual(
        paths.slice(2),
        Array(3).fill("/generation/chat/completions"),
      );
    } finally {
      await worker?.dispose();
      if (mock.listening)
        await new Promise<void>((resolve, reject) =>
          mock.close((failure) => (failure ? reject(failure) : resolve())),
        );
      await rm(scratch, { recursive: true, force: true });
    }
  },
);
