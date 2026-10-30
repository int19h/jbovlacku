import assert from "node:assert/strict";
import { assertResponseStatus } from "./adapter-status.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  initializeCore,
  createEvent,
  contentHash,
  wordId,
} from "../packages/core/src/index.ts";

const root = resolve(import.meta.dirname, "..");
const testRoot = resolve(
  process.env.JVC_TEST_ROOT ?? join(root, "data", "adapter-tests"),
);
await mkdir(testRoot, { recursive: true });
const directory = await mkdtemp(join(testRoot, "case-"));
const inferenceKey = "disposable-adapter-inference-canary-1987";
const inferenceKeyPath = join(directory, "disposable-provider-key.txt");
await writeFile(inferenceKeyPath, inferenceKey, { mode: 0o600 });
const inferenceProvider = createHttpServer(async (request, response) => {
  try {
    if (
      request.url !== "/chat/completions" ||
      request.headers.authorization !== `Bearer ${inferenceKey}`
    )
      throw new Error("Unexpected mock provider request.");
    let raw = "";
    for await (const chunk of request) {
      raw += String(chunk);
      if (raw.length > 262144)
        throw new Error("Mock request exceeded its limit.");
    }
    const body = JSON.parse(raw);
    if (body.tool_choice !== "auto") {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: { message: 'Only "auto" is supported for tool_choice.' },
        }),
      );
      return;
    }
    assert.deepEqual(body.provider.only, ["meta"]);
    assert.equal(body.reasoning.effort, "medium");
    assert.deepEqual(body.usage, { include: true });
    const answer =
      body.messages.length === 2
        ? {}
        : {
            word_type: "lujvo",
            alternative: null,
            alternative_reason: null,
            existing: null,
            reason: "The meaning combines two component roles.",
          };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        model: body.model,
        provider: "mock",
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: inferenceKey,
              reasoning_details: [
                {
                  type: "reasoning.summary",
                  summary: "The supplied meaning describes a compound.",
                },
                {
                  type: "reasoning.encrypted",
                  data: "encrypted-adapter-canary",
                },
              ],
              tool_calls: [
                {
                  id: "mock-call",
                  type: "function",
                  function: {
                    name: "submit_answer",
                    arguments: JSON.stringify(answer),
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 40, completion_tokens: 20, cost: 0.001 },
      }),
    );
  } catch {
    response.writeHead(500);
    response.end("The local mock rejected the request.");
  }
});
await new Promise<void>((done) =>
  inferenceProvider.listen(0, "127.0.0.1", done),
);
const inferenceUrl = `http://127.0.0.1:${(inferenceProvider.address() as { port: number }).port}`;
await initializeCore(
  await readFile(join(root, "packages/core/generated/jvc_runtime_bg.wasm")),
);
const corpus = process.env.JVC_ADAPTER_CARRIER
  ? await readFile(process.env.JVC_ADAPTER_CARRIER)
  : null;
const seed = new Uint8Array(32).fill(91);
const entry = createEvent(
  seed,
  [],
  "a".repeat(32),
  { kind: "identity.profile" },
  { name: "Adapter fixture", bio: [], links: [] },
);
async function unusedPort() {
  const listener = createServer();
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((done) => listener.close(() => done()));
  return port;
}
const port = await unusedPort();
let child: ChildProcess | undefined;
const logs: string[] = [];
async function start(aiEnabled = true, invalidEmbedding = false) {
  child = spawn(process.execPath, [join(root, "apps/server/dist/main.js")], {
    cwd: root,
    detached: true,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      JVC_DATA_DIR: join(directory, "node"),
      JVC_LOG_ERRORS: "enabled",
      JVC_SNAPSHOT_LIMIT: "3",
      JVC_PROTOTYPE_BATCH: corpus ? "enabled" : "disabled",
      JVC_AI_ENABLED: aiEnabled ? "enabled" : "disabled",
      JVC_AI_BASE_URL: inferenceUrl,
      JVC_AI_KEY_FILE: inferenceKeyPath,
      JVC_AI_MODEL: "meta/muse-spark-1.3-contributor",
      JVC_AI_PROVIDER_ROUTE: "meta",
      JVC_AI_PROVIDER_NAME: "Local test provider",
      JVC_AI_REASONING_EFFORT: "medium",
      JVC_AI_EMBEDDING_MODEL: invalidEmbedding ? "" : "qwen/qwen3-embedding-8b",
      JVC_AI_EMBEDDING_PROVIDER_ROUTE: invalidEmbedding ? "" : "nebius",
      JVC_AI_EMBEDDING_INPUT_PRICE: invalidEmbedding ? "" : "0.01",
      JVC_AI_DECISION_REPORTS: "disabled",
      JVC_AI_OPERATIONS:
        "type,lujvo,gismu-sources,cmavo-class,definition,places-glosses",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr!.on("data", (chunk) => logs.push(String(chunk)));
  const until = Date.now() + 60000;
  while (Date.now() < until) {
    if (child.exitCode !== null)
      throw new Error(`Adapter exited: ${logs.join("")}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health/ready`)).ok) return;
    } catch {}
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Adapter failed readiness: ${logs.join("")}`);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, "exit");
  process.kill(-child.pid!, "SIGTERM");
  await Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Adapter did not stop.")),
        10000,
      ).unref(),
    ),
  ]);
}
const api = (path: string, body?: unknown) =>
  fetch(
    `http://127.0.0.1:${port}/api/v1${path}`,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: `http://127.0.0.1:${port}`,
          },
          body: JSON.stringify(body),
        },
  );
let completedManifest: any;
async function waitMaterialized(posted?: any) {
  const until =
    Date.now() +
    Number(process.env.JVC_ADAPTER_MATERIALIZATION_TIMEOUT_MS ?? 120000);
  while (Date.now() < until) {
    const response = await api("/manifest");
    if (response.status === 503) {
      await new Promise((done) => setTimeout(done, 25));
      continue;
    }
    await assertResponseStatus(response, 200);
    const manifest: any = await response.json();
    let receipt: any;
    if (posted) {
      const received = await api("/receipts/" + posted.id);
      await assertResponseStatus(received, 200);
      receipt = await received.json();
      assert.equal(receipt.cursor, posted.cursor);
      assert.equal(receipt.envelope_hash, posted.envelope_hash);
      assert.equal(receipt.body_hash, posted.body_hash);
      assert.equal(receipt.body_status, posted.body_status);
      if (receipt.reasons.includes("index_lag"))
        assert.equal(receipt.interpretation, "unavailable");
    }
    if (
      manifest.accepted_cursor === manifest.materialized_cursor &&
      (!posted ||
        (receipt.snapshot === manifest.snapshot &&
          !receipt.reasons.includes("evaluation_pending")))
    ) {
      completedManifest = manifest;
      return {
        manifest,
        receipt: posted
          ? { ...receipt, admission: posted.admission }
          : undefined,
      };
    }
    const previous = completedManifest;
    if (previous && manifest.accepted_cursor !== manifest.materialized_cursor) {
      assert.equal(manifest.snapshot, previous.snapshot);
      assert.equal(manifest.materialized_cursor, previous.materialized_cursor);
    }
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error(
    "The adapter did not materialize the accepted snapshot before the deadline.",
  );
}
const materializedReceipt = async (posted: any) =>
  (await waitMaterialized(posted)).receipt;
try {
  {
    await start(false);
    const disabled: any = await (await api("/capabilities")).json();
    assert.equal(disabled.features.assistance, false);
    await assertResponseStatus(await api("/assist", {}), 503);
    await stop();
    // Invalid embedding fields must leave generation jobs available.
    await start(true, true);
    const capabilities: any = await (await api("/capabilities")).json();
    assert.equal(capabilities.features.assistance, true);
    assert.equal(capabilities.features.semantic_search, false);
    assert.deepEqual(capabilities.embedding_profiles, []);
    assert.equal(JSON.stringify(capabilities).includes(inferenceKey), false);
    assert.equal(JSON.stringify(capabilities).includes(inferenceUrl), false);
    const privateSession = await api("/session");
    const cookie = privateSession.headers.get("set-cookie")!.split(";")[0];
    assert.match(
      privateSession.headers.get("set-cookie")!,
      /Secure; HttpOnly; SameSite=Strict/,
    );
    const csrf = ((await privateSession.json()) as any).csrf;
    const assist = await fetch(`http://127.0.0.1:${port}/api/v1/assist`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: `http://127.0.0.1:${port}`,
        cookie,
        "x-csrf-token": csrf,
      },
      body: JSON.stringify({
        operation: "type",
        draft_revision: "adapter-private",
        language: "en",
        meaning: "x1 is a C*-algebra and writes to name@example.org.",
        current: {
          word_type: null,
          classification: null,
          spelling: null,
          text: [["x1 is a C*-algebra and writes to name@example.org."]],
          frame: null,
          glosses: [],
          formation: null,
          compound: null,
        },
        context: [],
        profile: "default",
      }),
    });
    await assertResponseStatus(assist, 202);
    const accepted = (await assist.json()) as any;
    assert.match(accepted.expires_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    let result: any;
    for (let attempt = 0; attempt < 100; attempt++) {
      const poll = await fetch(
        `http://127.0.0.1:${port}/api/v1/jobs/${accepted.job}`,
        { headers: { cookie } },
      );
      await assertResponseStatus(poll, 200);
      result = await poll.json();
      if (!["queued", "running"].includes(result.state)) break;
      await new Promise((done) => setTimeout(done, 50));
    }
    assert.equal(result.state, "completed", JSON.stringify(result));
    assert.equal(result.result.proposals[0].path, "/word_type");
    assert.equal(result.result.proposals[0].value, "lujvo");
    assert.equal(result.result.log.answers, 2);
    assert.equal(result.result.log.corrections, 1);
    assert.equal(JSON.stringify(result).includes(inferenceKey), false);
    assert.equal(
      JSON.stringify(result).includes("encrypted-adapter-canary"),
      false,
    );
    const acknowledged = await fetch(
      `http://127.0.0.1:${port}/api/v1/jobs/${accepted.job}`,
      {
        method: "DELETE",
        headers: {
          cookie,
          "x-csrf-token": csrf,
          origin: `http://127.0.0.1:${port}`,
        },
      },
    );
    assert.equal(((await acknowledged.json()) as any).result, null);
    if (process.env.JVC_ADAPTER_CORPUS_ONLY !== "enabled") {
      const missing = await api("/events", { ...entry, body: null });
      await assertResponseStatus(missing, 201);
      const original: any = await materializedReceipt(await missing.json());
      const complete = await api("/events", entry);
      await assertResponseStatus(complete, 200);
      const receipt: any = await materializedReceipt(await complete.json());
      assert.equal(receipt.cursor, original.cursor);
      assert.notEqual(receipt.snapshot, original.snapshot);
      await assertResponseStatus(
        await api(
          `/bodies/${entry.envelope.header.content!.hash}?snapshot=${original.snapshot}`,
        ),
        404,
      );
      await stop();
      await start();
      assert.deepEqual(
        ((await (await api("/capabilities")).json()) as any)
          .assistance_profiles,
        capabilities.assistance_profiles,
      );
      const retry = await api("/events", entry);
      await assertResponseStatus(retry, 200);
      assert.deepEqual(await materializedReceipt(await retry.json()), receipt);
      const changes: any = await (await api("/changes")).json();
      assert.equal(changes.items.length, 1);
      assert.equal(changes.items[0].id, entry.envelope.id);
      await assertResponseStatus(
        await api(`/events/${entry.envelope.id}`),
        200,
      );
      // A definition makes the adapter build search packages in both package versions.
      const definitionWord = { language: "jbo" as const, spelling: "klama" };
      const definition = createEvent(
        seed,
        [],
        "12".repeat(16),
        {
          kind: "definition.publish",
          word: wordId(definitionWord),
          language: "en",
          parents: [],
          origin: "native",
        },
        {
          word: definitionWord,
          language: "en",
          text: [["x1 goes to x2."]],
          frame: null,
          operands: [],
          glosses: [
            { language: "en", text: "go", sense: null },
            { language: "en", text: "c*-algebra", sense: null },
            { language: "en", text: "name@example.org", sense: null },
          ],
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
      const published = await api("/events", definition);
      await assertResponseStatus(published, 201);
      await materializedReceipt(await published.json());
      // The newer read routes answer with the expected shapes.
      const manifest: any = await (await api("/manifest")).json();
      assert.ok(Array.isArray(manifest.package_versions));
      // Version 2 package bytes match their descriptor, and their entry carries the row fields.
      const descriptor = manifest.package_versions.find(
        (p: any) => p.language === "en" && p.version === 2,
      );
      assert.ok(
        descriptor,
        "manifest advertises the English version 2 package",
      );
      const packageResponse = await api(
        `/packages/en?version=2&snapshot=${encodeURIComponent(manifest.snapshot)}`,
      );
      await assertResponseStatus(packageResponse, 200);
      const packageBytes = new Uint8Array(await packageResponse.arrayBuffer());
      assert.equal(packageBytes.length, descriptor.bytes);
      assert.equal(contentHash(packageBytes), descriptor.hash);
      const pkg = JSON.parse(new TextDecoder().decode(packageBytes));
      assert.equal(pkg.version, 2);
      assert.equal(pkg.language, "en");
      assert.equal(pkg.snapshot, manifest.snapshot);
      assert.equal(pkg.parts.length, 1);
      const partResponse = await api(
        `/package-parts/${encodeURIComponent(pkg.parts[0].hash)}`,
      );
      await assertResponseStatus(partResponse, 200);
      const partBytes = new Uint8Array(await partResponse.arrayBuffer());
      assert.equal(partBytes.length, pkg.parts[0].bytes);
      assert.equal(contentHash(partBytes), pkg.parts[0].hash);
      const entries = JSON.parse(new TextDecoder().decode(partBytes));
      assert.equal(entries.length, pkg.parts[0].count);
      const row = entries.find((e: any) => e.event === definition.envelope.id);
      assert.ok(row, "version 2 part lists the published definition");
      assert.equal(row.issuer, entry.envelope.header.issuer);
      assert.equal(row.notes, false);
      assert.deepEqual(row.rafsi, []);
      assert.equal(row.rafsi_complete, true);
      assert.equal(row.attribution, null);
      assert.equal(row.body, definition.envelope.header.content!.hash);
      const v1Descriptor = manifest.packages.find(
        (p: any) => p.language === "en",
      );
      assert.ok(v1Descriptor, "manifest lists the English version 1 package");
      const v1Bytes = new Uint8Array(
        await (await api("/packages/en")).arrayBuffer(),
      );
      assert.equal(contentHash(v1Bytes), v1Descriptor.hash);
      assert.equal(JSON.parse(new TextDecoder().decode(v1Bytes)).version, 1);
      const records: any = await (await api("/records?limit=200")).json();
      const record = records.items.find((i: any) => i.id === entry.envelope.id);
      assert.ok(record, "records route lists the fixture event");
      assert.equal(record.body_status, "present");
      assert.equal(record.body.name, "Adapter fixture");
      assert.equal(records.snapshot, manifest.snapshot);
      // Identity reads need a retained view. The fixture key publishes one.
      const view = createEvent(
        seed,
        [],
        "f".repeat(32),
        { kind: "view.publish", parents: [] },
        {
          name: "Adapter view",
          description: [],
          roots: [
            {
              identity: entry.envelope.header.issuer,
              q: { numerator: 1, denominator: 1 },
            },
          ],
          rafsi_threshold: { numerator: 1, denominator: 1 },
          H: { numerator: 3, denominator: 1 },
          alpha: { numerator: 1, denominator: 2 },
          excluded: [],
          calculation: "simple-routes-bounds-v1",
          work: 1000,
          import_sets: [],
          account_witnesses: [],
          account_authority: false,
          notes: [],
        },
      );
      const viewResponse = await api("/events", view);
      await assertResponseStatus(viewResponse, 201);
      await materializedReceipt(await viewResponse.json());
      // A second signed view selects the route-refusal profile. Each view
      // reports its own profile through the server.
      const shunView = createEvent(
        seed,
        [view.envelope.id],
        "e".repeat(32),
        { kind: "view.publish", parents: [] },
        {
          name: "Adapter shun view",
          description: [],
          roots: [
            {
              identity: entry.envelope.header.issuer,
              q: { numerator: 1, denominator: 1 },
            },
          ],
          rafsi_threshold: { numerator: 1, denominator: 1 },
          H: { numerator: 3, denominator: 1 },
          alpha: { numerator: 1, denominator: 2 },
          excluded: [],
          calculation: "simple-routes-shun-v1",
          work: 1000,
          import_sets: [],
          account_witnesses: [],
          account_authority: false,
          notes: [],
        },
      );
      const shunResponse = await api("/events", shunView);
      await assertResponseStatus(shunResponse, 201);
      await materializedReceipt(await shunResponse.json());
      const wordPath = `/words/${encodeURIComponent(wordId(definitionWord))}`;
      for (const [chosen, algorithm] of [
        [view, "simple-routes-bounds-v1"],
        [shunView, "simple-routes-shun-v1"],
      ] as const) {
        const ranked: any = await (
          await api(
            `${wordPath}?view=${encodeURIComponent(chosen.envelope.id)}`,
          )
        ).json();
        assert.equal(ranked.view, chosen.envelope.id);
        assert.equal(ranked.calculation?.algorithm, algorithm);
        assert.equal(ranked.calculation?.exact, true);
      }
      for (const q of ["c*-algebra", "name@example.org"]) {
        const fields = {
          q,
          language: "en",
          literal: "1",
          view: view.envelope.id,
        };
        for (const response of [
          await api(`/search?${new URLSearchParams(fields)}`),
          await api("/search", fields),
        ]) {
          await assertResponseStatus(response, 200);
          const result: any = await response.json();
          assert.equal(result.hits.length, 1);
          assert.equal(result.hits[0].word_id, wordId(definitionWord));
          assert.equal(result.hits[0].match, "gloss");
        }
      }
      const searchFields = {
        q: "go",
        language: "en",
        view: view.envelope.id,
        limit: 1,
        retired: "1",
      };
      const postSearch = await api("/search", searchFields);
      await assertResponseStatus(postSearch, 200);
      const getSearch = await api(
        `/search?${new URLSearchParams(Object.entries(searchFields).map(([name, value]) => [name, String(value)]))}`,
      );
      await assertResponseStatus(getSearch, 200);
      const searched: any = await postSearch.json();
      assert.deepEqual(searched, await getSearch.json());
      assert.equal(searched.query, searchFields.q);
      for (const q of ["/^KLA/", "/ma$/", "kla*", "?lama", "/(a+)+$/"]) {
        const fields = { ...searchFields, q };
        const post = await api("/search", fields);
        await assertResponseStatus(post, 200);
        const get = await api(
          `/search?${new URLSearchParams(Object.entries(fields).map(([name, value]) => [name, String(value)]))}`,
        );
        await assertResponseStatus(get, 200);
        const pattern: any = await post.json();
        assert.deepEqual(pattern, await get.json());
        assert.ok(pattern.hits.length > 0);
        assert.ok(
          pattern.hits.every(
            (hit: any) =>
              hit.match === "headword-pattern" || hit.match === "rafsi-pattern",
          ),
        );
      }
      const invalidPattern = await api("/search", {
        ...searchFields,
        q: "/[/",
      });
      await assertResponseStatus(invalidPattern, 400);
      assert.equal(
        ((await invalidPattern.json()) as any).code,
        "pattern_invalid",
      );
      await assertResponseStatus(
        await api("/search", { ...searchFields, q: null }),
        400,
      );
      const identity = encodeURIComponent(entry.envelope.header.issuer);
      const withView = `view=${encodeURIComponent(view.envelope.id)}`;
      const personResponse = await api(`/identities/${identity}?${withView}`);
      await assertResponseStatus(personResponse, 200);
      const person: any = await personResponse.json();
      assert.equal(person.profile.state, "known");
      assert.equal(person.profile.claims_complete, true);
      assert.equal(person.profile.claims[0].body_status, "present");
      assert.equal(person.profile.claims[0].body.name, "Adapter fixture");
      const activity: any = await (
        await api(`/identities/${identity}/activity?limit=5&${withView}`)
      ).json();
      assert.ok(activity.items.some((i: any) => i.id === entry.envelope.id));
      await assertResponseStatus(
        await api(`/identities/${identity}/activity/extra`),
        404,
      );
      await assertResponseStatus(
        await api(`/records?snapshot=sha256:${"0".repeat(64)}`),
        410,
      );
      const invalid = await fetch(`http://127.0.0.1:${port}/api/v1/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"envelope":{},"body":null,"body":null}',
      });
      await assertResponseStatus(invalid, 400);
      const forbidden = await fetch(`http://127.0.0.1:${port}/api/v1/events`, {
        method: "POST",
        headers: {
          origin: "https://attacker.example",
          "content-type": "application/json",
        },
        body: JSON.stringify(entry),
      });
      await assertResponseStatus(forbidden, 403);
      let latest: any;
      for (const nonce of ["b", "c", "d", "e"]) {
        const extra = createEvent(
          seed,
          [],
          nonce.repeat(32),
          { kind: "identity.merge" },
          null,
        );
        const response = await api("/events", extra);
        await assertResponseStatus(response, 201);
        latest = await materializedReceipt(await response.json());
      }
      await assertResponseStatus(
        await api(`/inventory?kind=events&snapshot=${original.snapshot}`),
        410,
      );
      {
        const asset = await fetch(`http://127.0.0.1:${port}/`);
        assert.equal(asset.headers.get("x-frame-options"), "DENY");
        assert(
          asset.headers
            .get("content-security-policy")
            ?.includes("'wasm-unsafe-eval'"),
        );
      }
      await stop();
      await start();
      await assertResponseStatus(
        await api(`/inventory?kind=events&snapshot=${original.snapshot}`),
        410,
      );
      const finalRetry: any = await materializedReceipt(
        await (await api("/events", entry)).json(),
      );
      assert.equal(finalRetry.cursor, receipt.cursor);
      assert.equal(finalRetry.snapshot, latest.snapshot);
    }
    if (corpus) {
      const batch = await fetch(
        `http://127.0.0.1:${port}/api/v1/prototype/batch`,
        {
          method: "POST",
          headers: {
            "content-type": "application/x-ndjson",
            origin: `http://127.0.0.1:${port}`,
          },
          body: corpus,
        },
      );
      await assertResponseStatus(batch, 201);
      const result: any = await batch.json();
      assert.equal(
        result.receipts.length,
        corpus.toString().trim().split("\n").length,
      );
      if (process.env.JVC_ADAPTER_SELECTION) {
        const selection = await fetch(
          `http://127.0.0.1:${port}/api/v1/import-selections`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin: `http://127.0.0.1:${port}`,
            },
            body: await readFile(process.env.JVC_ADAPTER_SELECTION),
          },
        );
        await assertResponseStatus(selection, 201);
      }
      if (process.env.JVC_ADAPTER_VIEW) {
        await waitMaterialized();
        const search = await api(
          `/search?q=klama&language=en&view=${process.env.JVC_ADAPTER_VIEW}`,
        );
        await assertResponseStatus(search, 200);
        assert(((await search.json()) as any).hits.length > 0);
      }
      const manifest: any = (await waitMaterialized()).manifest;
      await stop();
      await start();
      assert.equal(
        ((await (await api("/manifest")).json()) as any).snapshot,
        manifest.snapshot,
      );
    }
    await stop();
  }
  console.log(
    JSON.stringify({
      status: "passed",
      adapters: ["node"],
      checks:
        "Node mocked inference with invalid embedding settings, disabled inference, unchanged generation profiles after valid embedding settings return, session and CSRF, retry checks, secret and encrypted-reasoning redaction, log acknowledgment, admission, late body, exact old snapshot, duplicate retry, process restart, strict JSON, same-origin writes, bounded snapshot expiry and restart, package_versions, records, identities and activity reads, 404 suffix, 410 snapshot, version 2 package bytes and parts, both calculation profiles",
      directory,
    }),
  );
} finally {
  await Promise.allSettled([stop()]);
  await new Promise<void>((done) => inferenceProvider.close(() => done()));
  assert.equal(
    logs.join("").includes(inferenceKey),
    false,
    "An adapter printed its disposable provider key.",
  );
  await writeFile(join(directory, "adapters.log"), logs.join(""));
}
