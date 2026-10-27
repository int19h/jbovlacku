import { spawn } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const request = (path: string, body?: unknown, signal?: AbortSignal) =>
  new Request(
    `http://localhost/api/v1${path}`,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal,
        },
  );
const read = async (response: Response): Promise<any> => {
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
};

test("routes advertise compatible partial indexes, retain lexical reads, and validate public inputs", async () => {
  const base = process.env.JVC_TEST_ROOT ?? tmpdir();
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "semantic-routes-"));
  const coordinator = new SqliteCoordinator(
    join(directory, "coordinator.sqlite"),
    2,
  );
  const objects = new FileObjectStore(join(directory, "objects"));
  const store = new SqliteVectorStore(
    join(directory, "semantic-vectors.sqlite"),
  );
  const scanner = new NodeVectorScanner(
    join(directory, "semantic-vectors.sqlite"),
  );
  const profile = createQwenProfile("28".repeat(16));
  const seed = new Uint8Array(32).fill(93);
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
  const word = { language: "jbo", spelling: "klama" } as const;
  const definition = createEvent(
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
    {
      word,
      language: "en",
      text: [["A traveler goes somewhere."]],
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
  let sends = 0;
  let release!: () => void;
  let gate = Promise.resolve();
  const config = providerConfig(
    { JVC_AI_ENABLED: "enabled" },
    async () => "disposable-key",
  )!;
  config.fetch = async (_url, init) => {
    sends++;
    const body = JSON.parse(String(init?.body));
    await gate;
    return Response.json({
      model: "qwen/qwen3-embedding-8b",
      data: body.input.map((_: unknown, index: number) => ({
        index,
        embedding: Array.from(unit()),
      })),
      usage: { prompt_tokens: 1, total_tokens: 1, cost: 0.00000001 },
    });
  };
  const options = {
    serverId: "semantic-routes",
    selectedView: view.envelope.id,
    policyUrl: "https://example.invalid",
    assistance: { provider: config },
    semantic: {
      profile: profileId(profile),
      store,
      cache: store.queryCache,
      scanner,
    },
  };
  const service = new DictionaryService(objects, coordinator, options);
  try {
    await service.admitMany(
      [view, definition].map((event) => utf8(JSON.stringify(event))),
    );
    const manifest = await read(await service.fetch(request("/manifest")));
    assert.equal(
      (await read(await service.fetch(request("/capabilities")))).features
        .semantic_search,
      false,
    );
    assert.deepEqual(
      await read(await service.fetch(request("/embedding-profiles"))),
      { profiles: [] },
    );
    const source = await service.semanticSource(profile);
    assert.equal(source.context.eligible, 1);
    const generation = await store.create(source.context, profile);
    const indexer = new SemanticIndexer(store, {
      embed: async (inputs, _caller, _signal, before) => {
        const operation = "embedding:index:mock";
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
    await store.publish(generation.id, null);
    assert.equal(
      (await read(await service.fetch(request("/embedding-profiles"))))
        .profiles[0].query_available,
      true,
    );
    const pendingOnly = await read(
      await service.fetch(
        request("/search/semantic", {
          query: "pending meaning",
          language: "en",
          snapshot: manifest.snapshot,
          view: view.envelope.id,
          profile: profileId(profile),
          limit: 1,
        }),
      ),
    );
    assert.deepEqual(pendingOnly.hits, []);
    assert.equal(pendingOnly.coverage.pending, 1);
    assert.equal(sends, 0);
    await indexer.run(generation.id);
    assert.equal(
      (await read(await service.fetch(request("/capabilities")))).features
        .semantic_search,
      true,
    );
    const description = await read(
      await service.fetch(request("/embedding-profiles?language=en")),
    );
    assert.deepEqual(Object.keys(description), ["profiles"]);
    assert.deepEqual(
      Object.keys(description.profiles[0]).sort(),
      [
        "id",
        "label",
        "query_available",
        "indexed",
        "eligible",
        "pending",
        "limitations",
      ].sort(),
    );
    const body = {
      query: "a traveler",
      language: "en",
      snapshot: manifest.snapshot,
      view: view.envelope.id,
      profile: profileId(profile),
      limit: 30,
    };
    for (const invalid of [
      { ...body, limit: 0 },
      { ...body, limit: 101 },
      { ...body, extra: 1 },
      { ...body, language: "EN" },
      { ...body, snapshot: "wrong" },
      { ...body, query: "" },
    ])
      assert.equal(
        (await service.fetch(request("/search/semantic", invalid))).status,
        400,
      );
    assert.equal(
      (await service.fetch(request("/search/semantic?q=leak", body))).status,
      400,
    );
    assert.equal(
      (
        await service.fetch(
          request("/search/semantic", { ...body, query: "x".repeat(4096) }),
        )
      ).status,
      413,
    );
    assert.equal(sends, 0);
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = service.fetch(request("/search/semantic", body));
    while (!sends) await new Promise((resolve) => setTimeout(resolve, 1));
    const lexical = await read(
      await service.fetch(
        request(
          `/search?q=traveler&language=en&snapshot=${manifest.snapshot}&view=${view.envelope.id}`,
        ),
      ),
    );
    assert.equal(lexical.hits.length, 1);
    release();
    const result = await read(await running);
    assert.deepEqual(result.hits, [
      {
        event: definition.envelope.id,
        word: wordId(word),
        distance: 0,
        position: 1,
      },
    ]);
    assert.deepEqual(result.coverage, {
      eligible: 1,
      indexed: 1,
      failed: 0,
      pending: 0,
    });
    await read(await service.fetch(request("/search/semantic", body)));
    assert.equal(sends, 2);
    const disabled = new DictionaryService(objects, coordinator, {
      ...options,
      semantic: undefined,
    });
    assert.equal(
      (await read(await disabled.fetch(request("/capabilities")))).features
        .semantic_search,
      false,
    );
    assert.deepEqual(
      await read(await disabled.fetch(request("/embedding-profiles"))),
      { profiles: [] },
    );
    assert.equal(
      (await disabled.fetch(request("/search/semantic", body))).status,
      503,
    );
    const otherEndpoint = new DictionaryService(objects, coordinator, {
      ...options,
      assistance: {
        provider: { ...config, baseUrl: "https://other.invalid/v1" },
      },
    });
    assert.equal(
      (await read(await otherEndpoint.fetch(request("/capabilities")))).features
        .semantic_search,
      false,
    );
    assert.equal(
      (await otherEndpoint.fetch(request("/search/semantic", body))).status,
      503,
    );
    const missing = "sha256:" + "f".repeat(64);
    assert.equal(
      (
        await service.fetch(
          request("/search/semantic", { ...body, snapshot: missing }),
        )
      ).status,
      410,
    );
    const healthyCapabilities = await read(
      await service.fetch(request("/capabilities")),
    );
    const published = store.published;
    store.published = async () => {
      throw new Error("Broken optional vector store");
    };
    const failedCapabilities = await read(
      await service.fetch(request("/capabilities")),
    );
    assert.equal(failedCapabilities.features.semantic_search, false);
    assert.deepEqual(failedCapabilities.embedding_profiles, []);
    assert.equal(
      failedCapabilities.features.assistance,
      healthyCapabilities.features.assistance,
    );
    assert.deepEqual(
      failedCapabilities.assistance_profiles,
      healthyCapabilities.assistance_profiles,
    );
    store.published = published;
    const noView = new DictionaryService(objects, coordinator, {
      ...options,
      selectedView: undefined,
    });
    const noViewCapabilities = await read(
      await noView.fetch(request("/capabilities")),
    );
    assert.equal(noViewCapabilities.features.semantic_search, false);
    assert.deepEqual(
      noViewCapabilities.assistance_profiles,
      healthyCapabilities.assistance_profiles,
    );
    const change = createEvent(
      seed,
      [definition.envelope.id],
      "c".repeat(32),
      { kind: "identity.profile" },
      { name: "Changed context", bio: [], links: [] },
    );
    await service.admitMany([utf8(JSON.stringify(change))]);
    assert.equal(
      (await read(await service.fetch(request("/capabilities")))).features
        .semantic_search,
      true,
    );
    assert.equal(
      (await read(await service.fetch(request("/embedding-profiles"))))
        .profiles[0].pending,
      0,
    );

    // Exercise the shipped host, its directory lock, and its own background timer.
    const key = join(directory, "mock-key.txt");
    await writeFile(key, "disposable-semantic-key", { mode: 0o600 });
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        new URL("./fixtures/semantic-live-provider.ts", import.meta.url).href,
        "apps/server/src/main.ts",
      ],
      {
        cwd: new URL("../../../", import.meta.url),
        env: {
          ...process.env,
          HOST: "127.0.0.1",
          PORT: process.env.JVC_TEST_API_PORT ?? "9120",
          JVC_DATA_DIR: directory,
          JVC_VIEW: view.envelope.id,
          JVC_AI_ENABLED: "enabled",
          JVC_AI_KEY_FILE: key,
          JVC_SEMANTIC_PROFILE: profileId(profile),
          JVC_SEMANTIC_INDEXING: "enabled",
        } as unknown as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    let logs = "";
    child.stdout!.on("data", (chunk) => {
      logs += chunk.toString();
    });
    child.stderr!.on("data", (chunk) => {
      logs += chunk.toString();
    });
    const exited = once(child, "exit");
    const baseUrl = `http://127.0.0.1:${process.env.JVC_TEST_API_PORT ?? "9120"}/api/v1`;
    const until = async (check: () => Promise<boolean>) => {
      for (let i = 0; i < 1000; i++) {
        if (await check()) return;
        if (child.exitCode !== null) throw new Error(logs);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("The semantic host test timed out. " + logs);
    };
    try {
      await until(async () => logs.includes('"event":"listening"'));
      const profiles = async () =>
        (await read(await fetch(baseUrl + "/embedding-profiles"))).profiles[0];
      for (let n = 0; n < 2; n++) {
        const added = createEvent(
          seed,
          [change.envelope.id],
          (n ? "e" : "d").repeat(32),
          {
            kind: "definition.publish",
            word: wordId(word),
            language: "en",
            parents: [],
            origin: "native",
          },
          {
            ...(definition.body as Record<string, unknown>),
            text: [[`A new traveler ${n} goes somewhere.`]],
          },
        );
        const pending = once(child, "message");
        const admitted = await fetch(baseUrl + "/events", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(added),
        });
        assert(admitted.ok, await admitted.text());
        await until(async () => (await profiles()).pending === 1);
        assert.equal((await profiles()).query_available, true);
        const semantic = await read(
          await fetch(baseUrl + "/search/semantic", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              ...body,
              snapshot: (await read(await fetch(baseUrl + "/manifest")))
                .snapshot,
            }),
          }),
        );
        assert.equal(semantic.coverage.pending, 1);
        assert.equal(semantic.hits.length, n + 1);
        assert.equal(
          (await fetch(baseUrl + "/search?q=traveler&language=en")).status,
          200,
        );
        await pending;
        if (n === 0) {
          child.send({ release: true });
          await until(async () => (await profiles()).pending === 0);
          assert.equal((await profiles()).indexed, 2);
        } else {
          child.kill("SIGTERM");
          await new Promise((resolve) => setTimeout(resolve, 100));
          assert.equal(
            child.exitCode,
            null,
            "Shutdown must retain the host while its provider transport waits",
          );
          child.send({ release: true });
          const [code] = await exited;
          assert.equal(code, 0, logs);
        }
      }
    } finally {
      if (child.exitCode === null) {
        child.send({ release: true });
        child.kill("SIGTERM");
        await exited;
      }
    }
  } finally {
    release?.();
    await service.drainSemanticQueries();
    await scanner.close();
    store.close();
    coordinator.close();
    await rm(directory, { recursive: true });
  }
});
