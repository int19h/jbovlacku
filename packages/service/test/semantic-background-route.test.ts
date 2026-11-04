import assert from "node:assert/strict";
import { before, test } from "node:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createEvent,
  initializeCore,
  utf8,
  wordId,
} from "../../core/src/index.ts";
import { DictionaryService } from "../src/service.ts";
import { providerConfig } from "../src/inference.ts";
import { createQwenProfile, profileId } from "../src/semantic/profile.ts";
import { SemanticIndexer } from "../src/semantic/indexer.ts";
import { BackgroundSemanticIndexer } from "../src/semantic/background.ts";
import { SqliteVectorStore } from "../../../apps/server/src/semantic.ts";
import { NodeVectorScanner } from "../../../apps/server/src/semantic-scanner.ts";
import {
  FileObjectStore,
  SqliteCoordinator,
} from "../../../apps/server/src/storage.ts";

before(async () =>
  initializeCore(
    await readFile(
      new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  ),
);
const unit = () => Float32Array.from({ length: 4096 }, (_, i) => (i ? 0 : 1));

for (const route of ["nebius", undefined] as const) {
  test(`background probes and document writes use ${route ?? "siliconflow/fp8 by default"}`, async (t) => {
    const base = process.env.JVC_TEST_ROOT ?? tmpdir();
    await mkdir(base, { recursive: true });
    const directory = await mkdtemp(join(base, "semantic-background-route-"));
    const coordinator = new SqliteCoordinator(
      join(directory, "coordinator.sqlite"),
      2,
    );
    const objects = new FileObjectStore(join(directory, "objects"));
    const store = new SqliteVectorStore(join(directory, "semantic.sqlite"));
    const scanner = new NodeVectorScanner(join(directory, "semantic.sqlite"));
    const profile = createQwenProfile("29".repeat(16), "nebius");
    const seed = new Uint8Array(32).fill(94);
    const view = createEvent(
      seed,
      [],
      "a".repeat(32),
      { kind: "view.publish", parents: [] },
      {
        name: "Semantic test",
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
      },
    );

    function definition(spelling: string, nonce: string) {
      const word = { language: "jbo", spelling } as const;
      return createEvent(
        seed,
        [view.envelope.id],
        nonce.repeat(32),
        {
          kind: "definition.publish",
          word: wordId(word),
          language: "en",
          parents: [],
          origin: "native",
        },
        {
          word,
          language: "en",
          text: [[`A definition for ${spelling}.`]],
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
        },
      );
    }
    const calls: {
      input: string[];
      provider: { only: string[]; order: string[]; allow_fallbacks: boolean };
    }[] = [];
    const config = providerConfig(
      { JVC_AI_ENABLED: "enabled" },
      async () => "disposable-key",
    )!;
    config.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      calls.push(body);
      return Response.json({
        model: profile.model,
        data: body.input.map((_: unknown, index: number) => ({
          index,
          embedding: Array.from(unit()),
        })),
        usage: { prompt_tokens: 1, total_tokens: 1, cost: 0.00000001 },
      });
    };
    const errors: unknown[] = [];
    const service = new DictionaryService(objects, coordinator, {
      serverId: "background-route",
      policyUrl: "https://example.invalid",
      selectedView: view.envelope.id,
      assistance: { provider: config },
      semantic: {
        profile: profileId(profile),
        route,
        store,
        cache: store.queryCache,
        scanner,
      },
      reportError: (error) => errors.push(error),
    });
    let cycle: Promise<void> | undefined;
    // Run one scheduled cycle through the service without a repeating timer.
    t.mock.method(
      BackgroundSemanticIndexer.prototype,
      "start",
      function (this: BackgroundSemanticIndexer) {
        cycle = this.cycle();
      },
    );
    try {
      await service.admitMany(
        [view, definition("klama", "b")].map((event) =>
          utf8(JSON.stringify(event)),
        ),
      );
      const source = await service.semanticSource(profile);
      const generation = await store.create(source.context, profile);
      const indexer = new SemanticIndexer(store, {
        embed: async (inputs, _caller, _signal, before) => {
          const operation = "embedding:index:seed";
          await before?.(operation);
          return {
            operation,
            model: profile.model,
            vectors: inputs.map(unit),
            usage: { inputTokens: 1, totalTokens: 1, costUsd: 0 },
          };
        },
      });
      await indexer.prepare(generation.id, source);
      await indexer.run(generation.id);
      await store.publish(generation.id, null);
      const references = await store.references(generation.id);
      assert.equal(references.length, 1);
      await service.admitMany([utf8(JSON.stringify(definition("blanu", "c")))]);
      service.startSemanticIndexing();
      assert.ok(cycle, "The service must start background indexing.");
      await cycle;
      assert.deepEqual(errors, []);
      assert.equal(
        calls.length,
        2,
        "One probe must precede one document request.",
      );
      assert.deepEqual(
        calls[0].input,
        references.map((reference) =>
          new TextDecoder().decode(reference.input),
        ),
      );
      assert.equal(calls[1].input.length, 1);
      assert.notDeepEqual(calls[1].input, calls[0].input);
      for (const call of calls) {
        assert.deepEqual(call.provider.only, [route ?? "siliconflow/fp8"]);
        assert.deepEqual(call.provider.order, [route ?? "siliconflow/fp8"]);
        assert.equal(call.provider.allow_fallbacks, false);
      }
      const current = await store.current(profileId(profile), view.envelope.id);
      assert.notEqual(current, generation.id);
      assert.equal((await store.generation(current!)).state, "completed");
      assert.equal((await store.coverage(current!)).indexed, 2);
    } finally {
      await service.stopSemanticIndexing();
      await scanner.close();
      store.close();
      coordinator.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
