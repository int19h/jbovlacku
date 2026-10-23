import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import type { Unstable_DevWorker } from "wrangler";
import {
  createEvent,
  initializeCore,
  inspectBody,
  canonicalize,
  utf8,
  wordId,
} from "../packages/core/src/index.ts";
import { parseAssistRequest } from "../packages/service/src/assistance.ts";

// Run only after the coordinator grants these local ports. No paid provider runs.
// JVC_TEST_WORKER_AI_MEMORY_R4=enabled node --import tsx scripts/test-worker-ai-memory-r4.ts
// --fixtures-only validates the synthetic inputs without opening a listener.
const fixturesOnly = process.argv.includes("--fixtures-only");
if (!fixturesOnly && process.env.JVC_TEST_WORKER_AI_MEMORY_R4 !== "enabled") {
  console.log(
    "Skipped. Set JVC_TEST_WORKER_AI_MEMORY_R4=enabled to run the local Worker stress test.",
  );
  process.exit(0);
}

type Data = Record<string, any>;
type Task = "places" | "glosses" | "hints" | "mappings";
type Session = { network: string; cookie: string; csrf: string };
const root = resolve(import.meta.dirname, "..");
const tasks: Task[] = ["places", "glosses", "hints", "mappings"];
const keys = Array.from({ length: 16 }, (_, index) => `x${index + 1}`);
const responseBytes = 262144;
const requestBytes = 262144;
const contextBytes = 131072;
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const port = (name: string, fallback: number) => {
  const value = Number(process.env[name] ?? fallback);
  assert.ok(
    Number.isInteger(value) && value > 0 && value <= 65535,
    `Invalid ${name}.`,
  );
  return value;
};
const providerPort = port("JVC_TEST_AI_PROVIDER_PORT", 8910);
const workerPort = port("JVC_TEST_AI_WORKER_PORT", 9910);
assert.notEqual(providerPort, workerPort);
const origin = `http://127.0.0.1:${workerPort}`;

await initializeCore(
  await readFile(join(root, "packages/core/generated/jvc_runtime_bg.wasm")),
);
const word = { language: "jbo" as const, spelling: "klama" };
const sourceBody: Data = {
  word,
  language: "en",
  text: [["Synthetic source with 256 places."]],
  frame: {
    role: "predicate",
    arity: { mode: "fixed", count: 256 },
    places: Array.from({ length: 256 }, (_, index) => ({
      index: index + 1,
      description: [[`Synthetic role ${index + 1}.`]],
      glosses: [],
      type_hints: [],
      defaults: [],
      constraints: [],
      derivation: [],
    })),
    tail: null,
    constraints: [],
  },
  glosses: [],
  operands: [],
  notes: [["C"]],
  examples: [],
  labels: [],
  sources: [],
  legacy: null,
  etymology: { text: [], formation: null, compound: null },
  classification: { kind: "gismu", selmaho: [] },
  license: {
    expression: "CC0-1.0",
    url: "https://creativecommons.org/publicdomain/zero/1.0/",
    attribution: "",
  },
};
const signSource = () =>
  createEvent(
    new Uint8Array(32).fill(87),
    [],
    "42".repeat(16),
    {
      kind: "definition.publish",
      word: wordId(word),
      language: "en",
      parents: [],
      origin: "native",
    },
    sourceBody,
  );
let source = signSource();
sourceBody.notes[0][0] += "C".repeat(
  contextBytes - size([{ event: source.envelope.id, body: sourceBody }]),
);
source = signSource();
const context = [{ event: source.envelope.id, body: sourceBody }];
assert.equal(
  size(context),
  contextBytes,
  "The service counts the complete context array.",
);
assert.equal(
  inspectBody(
    utf8(JSON.stringify(source.envelope)),
    utf8(canonicalize(utf8(JSON.stringify(sourceBody)))),
  ).availability,
  "valid",
);

function draft(job: "A" | "B" | "C") {
  const value: Data = {
    operation: "places-glosses",
    draft_revision: `memory-r4-${job}`,
    language: "en",
    meaning: job + "M".repeat(16383),
    current: {
      word_type: "lujvo",
      classification: { kind: "lujvo", selmaho: [] },
      spelling: "klamklama",
      text: [[""]],
      frame: null,
      glosses: [],
      formation: null,
      compound: {
        components: Array.from({ length: 64 }, () => ({
          word,
          definition: source.envelope.id,
          rafsi: "klam",
        })),
        morphology: { id: "https://example.test/morphology", version: "1" },
        scoring: { id: "https://example.test/scoring", version: "1" },
      },
    },
    context: [source.envelope.id],
    profile: "default",
  };
  value.current.text[0][0] = "D".repeat(requestBytes - size(value));
  assert.equal(size(value), requestBytes);
  assert.equal(Buffer.byteLength(value.meaning), 16384);
  return JSON.stringify(value);
}

function answer(task: Task): Data {
  if (task === "places")
    return {
      places: keys.map((key) => ({
        description: `Role ${key}. `.padEnd(128, "p"),
      })),
      reason: "Sixteen synthetic roles.",
    };
  if (task === "glosses")
    return Object.fromEntries(
      ["word", ...keys].map((key) => [
        key,
        { gloss: `role-${key}`, sense: "a role in this predicate" },
      ]),
    );
  return Object.fromEntries(
    keys.map((key) => [
      key,
      task === "hints"
        ? [{ type: "agent", reason: "The participant acts." }]
        : [
            {
              component: "c64[256]",
              reason: "direct: the last role of the last exact component.",
            },
          ],
    ]),
  );
}

function completion(job: string, task: Task, attempt: number): Data {
  // Small containers expose heap growth that a single long string cannot show.
  const tiny = () => Array.from({ length: 6000 }, () => [{}, []]);
  const value: Data = {
    model: "local-memory-r4",
    provider: "mock",
    unknown: { tiny: tiny() },
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          content: "",
          reasoning_details: [
            {
              type: "reasoning.summary",
              summary: "Synthetic memory fixture.",
              unknown: tiny(),
            },
          ],
          tool_calls: [
            {
              id: `${job}-${task}-${attempt}`,
              type: "function",
              function: {
                name: "submit_answer",
                arguments: JSON.stringify(attempt === 3 ? answer(task) : {}),
                unknown: tiny(),
              },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 },
  };
  value.choices[0].message.content = "R".repeat(responseBytes - size(value));
  assert.equal(size(value), responseBytes);
  return value;
}
for (const job of ["A", "B", "C"] as const)
  parseAssistRequest(JSON.parse(draft(job)));
for (const task of tasks)
  for (let attempt = 1; attempt <= 3; attempt++) completion("A", task, attempt);
if (fixturesOnly) {
  console.log(
    JSON.stringify({
      status: "fixtures_valid",
      request_bytes: requestBytes,
      loaded_context_bytes: size(context),
      provider_response_bytes: responseBytes,
      source_places: 256,
      components: 64,
    }),
  );
  process.exit(0);
}

const scratch = join(
  resolve(process.env.JVC_TEST_ROOT ?? root),
  ".cache",
  "worker-ai-memory-r4",
);
await mkdir(scratch, { recursive: true });
const directory = await mkdtemp(join(scratch, "case-"));
const configPath = join(directory, "wrangler.json");
const emptyEnvPath = join(directory, "empty.env");
const key = `disposable-memory-r4-${randomBytes(24).toString("hex")}`;
const keyPath = join(directory, "disposable-provider-key.txt");
const logs: string[] = [];
const providerFailures: string[] = [];
const turns = new Map<string, number>();
const firstJobs = new Set<string>();
let releaseFirst!: () => void;
const firstBarrier = new Promise<void>((done) => {
  releaseFirst = done;
});
let worker: Unstable_DevWorker | undefined;
let stopPromise: Promise<void> | undefined;
let providerListening = false;
let maxProviderRequestBytes = 0;
let receivedTurns = 0;
let stopping = false;
let baseline: number | null = null;
let report: Data = { status: "failed", directory };
const provider = createHttpServer(async (request, response) => {
  try {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/chat/completions");
    assert.equal(request.headers.authorization, `Bearer ${key}`);
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += Buffer.byteLength(chunk);
      assert.ok(bytes <= 4 * 1024 * 1024, "A provider request exceeded 4 MiB.");
      chunks.push(Buffer.from(chunk));
    }
    maxProviderRequestBytes = Math.max(maxProviderRequestBytes, bytes);
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(value.tool_choice, "auto");
    assert.deepEqual(value.provider.only, ["mock"]);
    assert.equal(value.provider.allow_fallbacks, false);
    assert.deepEqual(value.usage, { include: true });
    assert.equal(value.tools.length, 1);
    assert.equal(value.tools[0].function.name, "submit_answer");
    const props = value.tools[0].function.parameters.properties;
    const task: Task = props.places
      ? "places"
      : props.word
        ? "glosses"
        : props.x1?.items?.properties?.type
          ? "hints"
          : "mappings";
    if (task === "mappings")
      assert.equal(props.x1.items.properties.component.type, "string");
    // The runner appends its key legend after the single-line JSON case.
    const input = JSON.parse(value.messages[1].content.split("\n", 1)[0]);
    const job = input.meaning[0];
    assert.ok(job === "A" || job === "B");
    assert.equal(size(input.definitions), contextBytes);
    assert.equal(input.current.compound.components.length, 64);
    assert.equal(
      input.current.compound.components[63].definition,
      source.envelope.id,
    );
    if (task === "mappings") {
      assert.equal(input.component_places.length, 64);
      assert.equal(input.component_places[63].label, "c64");
      assert.deepEqual(
        input.component_places[63].places,
        Array.from({ length: 256 }, (_, index) => index + 1),
      );
    }
    const id = `${job}:${task}`;
    const attempt = (turns.get(id) ?? 0) + 1;
    turns.set(id, attempt);
    assert.ok(attempt <= 3);
    assert.equal(value.messages.length, attempt * 2);
    const jobTurns = [...turns.entries()]
      .filter(([name]) => name.startsWith(`${job}:`))
      .reduce((sum, [, count]) => sum + count, 0);
    assert.equal(task, tasks[Math.floor((jobTurns - 1) / 3)]);
    if (task === "places" && attempt === 1) {
      firstJobs.add(job);
      if (firstJobs.size === 2) releaseFirst();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          firstBarrier,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(new Error("Two first provider turns did not overlap.")),
              20000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    const raw = JSON.stringify(completion(job, task, attempt));
    receivedTurns++;
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(raw)),
    });
    response.end(raw);
  } catch (error) {
    providerFailures.push(
      (error instanceof Error ? error.message : String(error))
        .split(key)
        .join("[redacted]"),
    );
    response.writeHead(500, { "content-type": "text/plain" });
    response.end("The local mock rejected the request.");
  }
});

async function freePort(value: number) {
  const listener = createServer();
  await new Promise<void>((done, reject) => {
    listener.once("error", reject);
    listener.listen(value, "127.0.0.1", done);
  });
  await new Promise<void>((done, reject) =>
    listener.close((error) => (error ? reject(error) : done())),
  );
}
async function api(
  path: string,
  session?: Session,
  method = "GET",
  body?: string,
) {
  const headers: Record<string, string> = {
    origin,
    "CF-Connecting-IP": session?.network ?? "192.0.2.1",
  };
  if (session) {
    headers.cookie = session.cookie;
    headers["x-csrf-token"] = session.csrf;
  }
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${origin}/api/v1${path}`, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(120000),
  });
}
async function session(network: string): Promise<Session> {
  const response = await api("/session", { network, cookie: "", csrf: "" });
  assert.equal(response.status, 200, await response.clone().text());
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  assert.match(
    response.headers.get("set-cookie")!,
    /Secure; HttpOnly; SameSite=Strict/,
  );
  return { network, cookie, csrf: ((await response.json()) as Data).csrf };
}
async function readJob(id: string, owner: Session) {
  const response = await api(`/jobs/${id}`, owner);
  if (response.status !== 200)
    assert.fail(
      `Job read returned ${response.status}: ${await response.text()}`,
    );
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-type")!, /application\/json/);
  assert.ok(response.body);
  const reader = response.body.getReader();
  const buffers: Buffer[] = [];
  const hash = createHash("sha256");
  let bytes = 0;
  let chunks = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    chunks++;
    bytes += part.value.byteLength;
    assert.ok(bytes <= 96 * 1024 * 1024, "A private job read exceeded 96 MiB.");
    hash.update(part.value);
    buffers.push(Buffer.from(part.value));
  }
  const raw = Buffer.concat(buffers).toString("utf8");
  assert.equal(
    raw.includes(key),
    false,
    "The response exposed the disposable key.",
  );
  return { value: JSON.parse(raw), bytes, chunks, sha256: hash.digest("hex") };
}
function inspectResult(
  result: Awaited<ReturnType<typeof readJob>>,
  job: string,
) {
  assert.equal(
    result.value.state,
    "completed",
    JSON.stringify(result.value.error),
  );
  assert.ok(
    result.chunks > 1,
    "The full result did not arrive in multiple stream chunks.",
  );
  const log = result.value.result.log;
  assert.equal(log.answers, 12);
  assert.equal(log.corrections, 8);
  assert.deepEqual(
    log.exchanges.map((exchange: Data) => exchange.task),
    tasks,
  );
  for (const exchange of log.exchanges) {
    assert.equal(exchange.attempts.length, 3);
    for (const [index, attempt] of exchange.attempts.entries()) {
      const expected = completion(job, exchange.task, index + 1);
      assert.deepEqual(
        attempt.response,
        expected,
        "Raw response metadata changed.",
      );
      assert.deepEqual(
        attempt.tool_calls,
        expected.choices[0].message.tool_calls,
        "Raw tool metadata changed.",
      );
      assert.equal(attempt.check.accepted, index === 2);
      if (index < 2) assert.ok(attempt.check.problems.length > 0);
      if (index > 0) {
        assert.deepEqual(
          attempt.request.messages[2].reasoning_details,
          completion(job, exchange.task, 1).choices[0].message
            .reasoning_details,
        );
        assert.deepEqual(
          attempt.request.messages[2].tool_calls,
          completion(job, exchange.task, 1).choices[0].message.tool_calls,
        );
      }
    }
  }
  const frame = result.value.result.proposals.find(
    (proposal: Data) => proposal.path === "/frame",
  ).value;
  assert.equal(frame.places.length, 16);
  assert.equal(frame.places[15].derivation[0].definition, source.envelope.id);
  assert.equal(frame.places[15].derivation[0].place, 256);
}
async function complete(id: string, owner: Session, job: string) {
  const until = Date.now() + 180000;
  while (Date.now() < until) {
    assert.equal(stopping, false, "The stress test stopped.");
    assert.deepEqual(providerFailures, []);
    const result = await readJob(id, owner);
    if (!["queued", "running"].includes(result.value.state)) {
      inspectResult(result, job);
      return {
        bytes: result.bytes,
        chunks: result.chunks,
        sha256: result.sha256,
      };
    }
    await delay(200);
  }
  throw new Error(`Job ${job} did not complete.`);
}
async function stop() {
  if (worker) await (stopPromise ??= worker.stop());
}
const interrupt = () => {
  stopping = true;
  releaseFirst();
  void stop();
  provider.closeAllConnections();
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
// Wrangler owns the local workerd process. Capture its console output when available.
const originalWrites = [process.stdout, process.stderr].map((stream) => {
  const write = stream.write;
  stream.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    const safe = (
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
    )
      .split(key)
      .join("[redacted]");
    logs.push(safe);
    return Reflect.apply(write, stream, [safe, ...args]);
  }) as typeof stream.write;
  return () => {
    stream.write = write;
  };
});
const localEnvironment = {
  WRANGLER_SEND_METRICS: "false",
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
  CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
};
const previousEnvironment = Object.fromEntries(
  Object.keys(localEnvironment).map((name) => [name, process.env[name]]),
);
const sourceFiles = [
  "scripts/test-worker-ai-memory-r4.ts",
  "apps/worker/src/index.ts",
  "apps/worker/src/index-store.ts",
  "packages/service/src/assistance.ts",
  "packages/service/src/inference.ts",
  "packages/service/src/service.ts",
  "packages/service/src/sql-coordinator.ts",
  "packages/service/src/prompt-bundle.ts",
  "packages/core/src/index.ts",
  "packages/core/generated/jvc_runtime_bg.wasm",
];
const sourceHashes = async () =>
  Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (file) => [
        file,
        createHash("sha256")
          .update(await readFile(join(root, file)))
          .digest("hex"),
      ]),
    ),
  );
try {
  report.source_hashes = await sourceHashes();
  await freePort(workerPort);
  await writeFile(keyPath, key, { mode: 0o600, flag: "wx" });
  await writeFile(emptyEnvPath, "", { flag: "wx" });
  await writeFile(
    configPath,
    JSON.stringify(
      {
        name: "jvc-memory-r4",
        main: join(root, "apps/worker/src/index.ts"),
        compatibility_date: "2026-10-11",
        compatibility_flags: ["nodejs_compat"],
        r2_buckets: [
          {
            binding: "OBJECTS",
            bucket_name: "memory-r4-objects",
            remote: false,
          },
        ],
        d1_databases: [
          {
            binding: "INDEX",
            database_name: "memory-r4-index",
            database_id: "00000000-0000-0000-0000-000000000001",
            remote: false,
          },
        ],
        durable_objects: {
          bindings: [
            { name: "COORDINATOR", class_name: "AdmissionCoordinator" },
          ],
        },
        migrations: [
          { tag: "v1", new_sqlite_classes: ["AdmissionCoordinator"] },
        ],
      },
      null,
      2,
    ),
  );
  await new Promise<void>((done, reject) => {
    provider.once("error", reject);
    provider.listen(providerPort, "127.0.0.1", done);
  });
  providerListening = true;
  Object.assign(process.env, localEnvironment);
  const { unstable_dev } = await import("wrangler");
  worker = await unstable_dev(join(root, "apps/worker/src/index.ts"), {
    config: configPath,
    envFiles: [emptyEnvPath],
    ip: "127.0.0.1",
    port: workerPort,
    persistTo: join(directory, "worker"),
    local: true,
    logLevel: "none",
    vars: {
      PUBLIC_ORIGIN: origin,
      SELECTED_VIEW: "",
      SERVER_ID: "local-memory-r4",
      JVC_AI_ENABLED: "enabled",
      JVC_AI_BASE_URL: `http://127.0.0.1:${providerPort}`,
      JVC_AI_KEY: (await readFile(keyPath, "utf8")).trim(),
      JVC_AI_MODEL: "local-memory-r4",
      JVC_AI_PROVIDER_ROUTE: "mock",
      JVC_AI_PROVIDER_NAME: "Local mock",
      JVC_AI_REASONING_EFFORT: "medium",
      JVC_AI_DECISION_REPORTS: "disabled",
      JVC_AI_MAX_TOKENS: "16384",
      JVC_AI_TIMEOUT_MS: "180000",
      JVC_AI_CONCURRENCY: "2",
      JVC_AI_MAX_COST_USD: "329",
      JVC_AI_MAX_PRICE: "10",
      JVC_AI_OPERATIONS: "places-glosses",
      JVC_LOCAL_WORKER: "disabled",
      JVC_TRUST_CF_CONNECTING_IP: "enabled",
      PROTOTYPE_BATCH: "enabled",
      SNAPSHOT_LIMIT: "3",
    },
    experimental: {
      disableExperimentalWarning: true,
      disableDevRegistry: true,
      watch: false,
      showInteractiveDevSession: false,
    },
  });
  assert.equal(worker.port, workerPort);
  assert.equal(worker.address, "127.0.0.1");
  const readyUntil = Date.now() + 60000;
  let ready = false;
  while (Date.now() < readyUntil && !stopping) {
    try {
      const response = await fetch(`${origin}/api/health/ready`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        ready = true;
        break;
      }
      await response.body?.cancel();
    } catch {}
    await delay(100);
  }
  assert.ok(ready, "The Worker did not become ready.");
  const capabilities = await api("/capabilities");
  assert.equal(((await capabilities.json()) as Data).features.assistance, true);
  // Record the Worker baseline before signed dictionary admission.
  const samples = logs.join("").matchAll(/"wasm_linear_bytes"\s*:\s*(\d+)/g);
  baseline = [...samples].map((match) => Number(match[1])).at(-1) ?? null;
  const admission = await api(
    "/events",
    undefined,
    "POST",
    JSON.stringify(source),
  );
  assert.equal(admission.status, 201, await admission.clone().text());
  const owners = await Promise.all([
    session("192.0.2.1"),
    session("192.0.2.2"),
  ]);
  const admitted = await Promise.all(
    owners.map(async (owner, index) => {
      const response = await api(
        "/assist",
        owner,
        "POST",
        draft(index === 0 ? "A" : "B"),
      );
      assert.equal(response.status, 202, await response.clone().text());
      return ((await response.json()) as Data).job as string;
    }),
  );
  const first = await Promise.all(
    admitted.map((id, index) =>
      complete(id, owners[index], index === 0 ? "A" : "B"),
    ),
  );
  assert.equal(
    firstJobs.size,
    2,
    "Both jobs must overlap at the mock provider.",
  );
  assert.equal(receivedTurns, 24);
  assert.equal(turns.size, 8);
  for (const count of turns.values()) assert.equal(count, 3);
  const thirdOwner = await session("192.0.2.3");
  const refused = await api("/assist", thirdOwner, "POST", draft("C"));
  assert.equal(refused.status, 429, await refused.clone().text());
  assert.equal(((await refused.json()) as Data).code, "quota");
  assert.ok(Number(refused.headers.get("retry-after")) > 0);
  assert.equal(
    receivedTurns,
    24,
    "Retained capacity refusal must not call the provider.",
  );
  const repeated = await Promise.all(
    admitted.map(async (id, index) => {
      const result = await readJob(id, owners[index]);
      inspectResult(result, index === 0 ? "A" : "B");
      assert.equal(
        result.sha256,
        first[index].sha256,
        "A retained result changed between reads.",
      );
      assert.equal(result.bytes, first[index].bytes);
      return {
        bytes: result.bytes,
        chunks: result.chunks,
        sha256: result.sha256,
      };
    }),
  );
  for (const [index, id] of admitted.entries()) {
    const response = await api(`/jobs/${id}`, owners[index], "DELETE");
    assert.equal(response.status, 200);
    const acknowledged = (await response.json()) as Data;
    assert.equal(acknowledged.state, "completed");
    assert.equal(acknowledged.result, null);
    const reread = await readJob(id, owners[index]);
    assert.equal(reread.value.state, "completed");
    assert.equal(reread.value.result, null);
  }
  assert.deepEqual(providerFailures, []);
  assert.deepEqual(
    await sourceHashes(),
    report.source_hashes,
    "The source changed during the stress test.",
  );
  report = {
    ...report,
    status: "passed",
    directory,
    adapter: "actual-local-worker-workerd",
    provider_turns: receivedTurns,
    overlapping_jobs: firstJobs.size,
    request_bytes: requestBytes,
    loaded_context_bytes: contextBytes,
    provider_response_bytes: responseBytes,
    max_provider_request_bytes: maxProviderRequestBytes,
    retained_results: repeated,
    retained_capacity_status: 429,
    acknowledged_jobs: 2,
  };
} catch (error) {
  report.error = (error instanceof Error ? error.message : String(error))
    .split(key)
    .join("[redacted]");
  throw error;
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  releaseFirst();
  const cleanup = await Promise.allSettled([
    stop(),
    (async () => {
      if (providerListening) {
        provider.closeAllConnections();
        await new Promise<void>((done) => provider.close(() => done()));
      }
    })(),
    unlink(keyPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    }),
  ]);
  for (const restore of originalWrites) restore();
  for (const [name, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  const cleanupFailures = cleanup
    .filter((item) => item.status === "rejected")
    .map((item) => String(item.reason));
  if (cleanupFailures.length) {
    report.status = "failed";
    report.cleanup_failures = cleanupFailures;
  }
  await writeFile(join(directory, "worker.log"), logs.join(""));
  const wasmSamples = [
    ...logs.join("").matchAll(/"wasm_linear_bytes"\s*:\s*(\d+)/g),
  ].map((match) => Number(match[1]));
  report.wasm_linear_baseline_bytes = baseline;
  report.wasm_linear_peak_bytes = wasmSamples.length
    ? Math.max(...wasmSamples)
    : null;
  report.wasm_diagnostic_samples = wasmSamples.length;
  report.limitation =
    "Local workerd completion and Wasm samples do not establish a formal 128 MiB total-memory bound or hosted Worker compliance.";
  report.provider_failures = providerFailures;
  await writeFile(
    join(directory, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
  assert.deepEqual(
    cleanupFailures,
    [],
    "The stress test could not release all owned resources.",
  );
}
