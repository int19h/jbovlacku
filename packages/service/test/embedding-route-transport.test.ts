import assert from "node:assert/strict";
import { before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { initializeCore } from "../../core/src/index.ts";
import { AssistanceService } from "../src/assistance.ts";
import {
  EMBEDDING_MODEL,
  providerConfig,
  type EmbeddingRoute,
} from "../src/inference.ts";

before(async () =>
  initializeCore(
    await readFile(
      new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  ),
);

const input = [new TextEncoder().encode("Public route fixture.")];
const response = () =>
  Response.json({
    model: EMBEDDING_MODEL,
    data: [
      {
        index: 0,
        embedding: Array.from({ length: 4096 }, (_, i) => (i ? 0 : 1)),
      },
    ],
    usage: { prompt_tokens: 4, total_tokens: 4, cost: 0.000001 },
  });

test("parallel embedding calls require caller routes and ignore the configured route", async () => {
  for (const configuredRoute of [
    "nebius",
    "deepinfra/us",
    "siliconflow/fp8",
  ] as const) {
    const seen: string[] = [];
    const linked = new Set<string>();
    let bothSent!: () => void;
    const gate = new Promise<void>((resolve) => {
      bothSent = resolve;
    });
    const provider = {
      ...providerConfig(
        {
          JVC_AI_ENABLED: "enabled",
          JVC_AI_EMBEDDING_PROVIDER_ROUTE: configuredRoute,
        },
        async () => "disposable-route-key",
      )!,
      fetch: async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        const route = body.provider.order[0];
        assert.deepEqual(body.provider.only, [route]);
        assert.equal(body.provider.allow_fallbacks, false);
        assert.equal(body.provider.max_price.prompt, 0.01);
        seen.push(route);
        if (seen.length <= 3) {
          assert.equal(linked.has(route), true);
          if (seen.length === 3) bothSent();
          await gate;
        }
        return response();
      },
    };
    const originalEmbedding = provider.embedding;
    Object.freeze(originalEmbedding);
    Object.freeze(provider);
    const service = new AssistanceService(
      { provider },
      "route-test",
      async () => [],
    );
    const routes = ["nebius", "deepinfra/us", "siliconflow/fp8"] as const;
    await Promise.all(
      routes.map((route) =>
        service.embed(
          input,
          { route, kind: "index" },
          undefined,
          async (operation) => {
            assert.match(operation, /^embedding:index:/);
            linked.add(route);
          },
        ),
      ),
    );
    assert.deepEqual(seen.slice().sort(), [...routes].sort());
    assert.equal(provider.embedding, originalEmbedding);
    assert.equal(provider.embedding!.route, configuredRoute);
    await service.embed(input, { route: "nebius", kind: "probe" });
    assert.equal(seen[3], "nebius");
  }
});

test("missing and invalid caller routes fail before links, key reads, or dispatch", async () => {
  let keys = 0;
  let sends = 0;
  let links = 0;
  const provider = {
    ...providerConfig({ JVC_AI_ENABLED: "enabled" }, async () => {
      keys++;
      return "disposable-route-key";
    })!,
    fetch: async () => {
      sends++;
      return response();
    },
  };
  const service = new AssistanceService(
    { provider },
    "route-test",
    async () => [],
  );
  for (const route of [
    undefined,
    "deepinfra",
    "deepinfra/eu",
    "unknown",
    "",
    null,
    1,
    {},
  ]) {
    await assert.rejects(
      service.embed(
        input,
        { route: route as EmbeddingRoute, kind: "index" },
        undefined,
        async () => {
          links++;
        },
      ),
      { code: "embedding_configuration" },
    );
  }
  assert.deepEqual({ keys, sends, links }, { keys: 0, sends: 0, links: 0 });
  await service.embed(input, { route: "nebius", kind: "probe" });
  assert.deepEqual({ keys, sends, links }, { keys: 1, sends: 1, links: 0 });
});

test("an explicit route does not enable disabled embedding inference", async () => {
  const provider = providerConfig(
    {
      JVC_AI_ENABLED: "enabled",
      JVC_AI_EMBEDDING_PROVIDER_ROUTE: "unknown",
    },
    async () => {
      throw new Error("No key read expected.");
    },
  )!;
  const service = new AssistanceService(
    { provider },
    "route-test",
    async () => [],
  );
  await assert.rejects(
    service.embed(
      input,
      { route: "deepinfra/us", kind: "probe" },
      undefined,
      undefined,
    ),
    { code: "embedding_configuration" },
  );
});
