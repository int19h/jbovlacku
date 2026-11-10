/** Opt-in browser worker measurements. Never pass a live service data directory. */
import { chromium } from "playwright";
import { build } from "esbuild";
import { createServer, request as httpRequest } from "node:http";
import { createReadStream, createWriteStream } from "node:fs";
import {
  readFile,
  writeFile,
  mkdir,
  stat,
  appendFile,
  realpath,
} from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { deserialize } from "node:v8";
import { workerTimings, profileSummary } from "./metrics.mjs";
import { childRunning, stopChild, configureWorkerThrottle } from "./limits.mjs";
import { ancestryShape } from "./ancestry.mjs";
import { validateSample, readCachedDataset } from "./samples.mjs";
import { createLifecycle, cleanupInOrder } from "./lifecycle.mjs";
import { WorkerCDP } from "./worker-cdp.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const i = a.indexOf("=");
    return i < 0 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)];
  }),
);
if (!args.out || (!args.data && !args.probe))
  throw Error(
    "Use --out=SCRATCH --data=DISPOSABLE_COPY, or --out=SCRATCH --probe.",
  );
if (args["delta-reload"] && args["product-reload"])
  throw Error("Choose only one of --delta-reload and --product-reload.");
if (args["product-only"] && !args["product-reload"])
  throw Error("--product-only requires --product-reload.");
const out = resolve(String(args.out));
await mkdir(out, { recursive: true });
const data = args.data ? await realpath(String(args.data)) : null;
if (data && (!data.startsWith(out + "/") || data === out))
  throw Error(
    "The disposable data copy must be inside this task's scratch directory.",
  );
if (
  data &&
  (
    await readFile(join(data, ".browser-eval-disposable-copy"), "utf8")
  ).trim() !== "disposable-browser-evaluation-copy"
)
  throw Error(
    "Create the marker only in a disposable copy before starting the measurement server.",
  );
const port = Number(args.port ?? 9251),
  apiPort = Number(args["api-port"] ?? 9250);
if (
  !Number.isInteger(port) ||
  !Number.isInteger(apiPort) ||
  port < 1024 ||
  apiPort < 1024 ||
  port > 65535 ||
  apiPort > 65535 ||
  port === apiPort
)
  throw Error("Use two different local ports between 1024 and 65535.");
const head = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hashId = (bytes) => `sha256:${sha(bytes)}`;
const hashJson = (value) => hashId(JSON.stringify(value));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function submittedInventory(input, envelope) {
  const id = JSON.parse(envelope).id;
  const events = input.events.map((value) => JSON.parse(value).id);
  const index = events.findIndex((event) => event > id);
  events.splice(index < 0 ? events.length : index, 0, id);
  const envelopes = [...input.events];
  envelopes.splice(index < 0 ? envelopes.length : index, 0, envelope);
  const bodies = [
    ...new Set(
      envelopes
        .map((value) => JSON.parse(value).header.content?.hash)
        .filter(Boolean),
    ),
  ].sort();
  const selections = Object.keys(input.import_selections).sort();
  const manifest = {
    events: {
      count: events.length,
      hash: hashId(envelopes.join("\n") + "\n"),
    },
    bodies: { count: bodies.length, hash: hashJson(bodies) },
    import_selections: { count: selections.length, hash: hashJson(selections) },
  };
  return {
    snapshot: hashJson(manifest),
    logical_inventory: hashJson({
      events,
      bodies,
      import_selections: selections,
    }),
    events_digest: manifest.events.hash,
    view: input.selected_view,
    events,
    bodies,
    selections,
  };
}
const capture = (command, argv) => {
  try {
    return execFileSync(command, argv, { encoding: "utf8" }).trim();
  } catch (e) {
    return String(e);
  }
};
const assets = join(out, "assets");
await mkdir(assets, { recursive: true });
const measurementSessionGetter = {
  name: "measurement-session-getter",
  setup(b) {
    b.onLoad(
      { filter: /apps\/web\/src\/workers\/evaluate\.ts$/ },
      async ({ path }) => ({
        loader: "ts",
        contents:
          (await readFile(path, "utf8")) +
          "\nself.__measurementSession = () => evaluation.currentSession;\n" +
          "self.measurement = async () => { const session = self.__measurementSession(); const summary = session?.summary?.(); return {wasm_bytes: (await initializeCore()).memory.buffer.byteLength, statistics: session?.updateStatistics?.(), available: summary ? summary.available : session?.state.available, reasons: summary ? summary.reasons : session?.state.reasons}; };\n",
      }),
    );
  },
};
await build({
  entryPoints: [join(root, "scripts/browser-eval-baseline/page.mjs")],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: join(assets, "page.js"),
  logLevel: "error",
});
await build({
  entryPoints: [join(root, "scripts/browser-eval-baseline/seed-worker.mjs")],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: join(assets, "seed-worker.js"),
  logLevel: "error",
});
await build({
  entryPoints: [join(root, "apps/web/src/workers/evaluate.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: join(assets, "product-worker.js"),
  logLevel: "error",
  plugins: [measurementSessionGetter],
});
await build({
  entryPoints: [join(root, "scripts/browser-eval-baseline/worker.mjs")],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: join(assets, "worker.js"),
  logLevel: "error",
  plugins: [measurementSessionGetter],
});
const wasmPath = join(root, "packages/core/generated/jvc_runtime_bg.wasm");
const manifest = {
  head,
  dirty: capture("git", ["status", "--porcelain"]),
  node: process.version,
  kernel: capture("uname", ["-a"]),
  cpu: capture("lscpu", []),
  memory: capture("free", ["-b"]),
  wasm_sha256: sha(await readFile(wasmPath)),
  worker_sha256: sha(await readFile(join(assets, "worker.js"))),
  seed_worker_sha256: sha(await readFile(join(assets, "seed-worker.js"))),
  product_worker_sha256: sha(await readFile(join(assets, "product-worker.js"))),
  page_sha256: sha(await readFile(join(assets, "page.js"))),
  config: args,
};
await writeFile(
  join(
    out,
    `${args.label ?? (args.probe ? "probe" : "measurements")}-environment.json`,
  ),
  JSON.stringify(manifest, null, 2),
);

async function prepare() {
  const cached = join(out, "input.json");
  const old = await readCachedDataset(join(out, "dataset.json"));
  try {
    if (old?.schema === 3) return old;
    if (old?.schema === 2) {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(join(data, "coordinator.sqlite"), {
        readOnly: true,
      });
      try {
        old.ancestry = ancestryShape(
          [...db.prepare("SELECT id,value FROM events").iterate()].map((r) => {
            const h = JSON.parse(r.value).header;
            return {
              id: r.id,
              issuer: h.issuer,
              previous: h.previous,
              kind: h.action.kind,
            };
          }),
        );
      } finally {
        db.close();
      }
      old.schema = 3;
      await writeFile(join(out, "dataset.json"), JSON.stringify(old, null, 2));
      return old;
    }
  } catch {}
  const { SqliteCoordinator, FileObjectStore } =
    await import("../../apps/server/src/storage.ts");
  const { initializeCore, prepareSelection } =
    await import("../../packages/core/src/index.ts");
  await initializeCore(await readFile(wasmPath));
  const coordinator = new SqliteCoordinator(join(data, "coordinator.sqlite"));
  try {
    const state = await coordinator.load();
    const pin = coordinator.checkpointPin();
    const checkpoint = await readFile(join(data, "evaluation-cache", pin.file));
    if (sha(checkpoint) !== pin.hash)
      throw Error("Checkpoint does not match the copied coordinator pin.");
    const saved = deserialize(gunzipSync(checkpoint));
    const evaluated = JSON.parse(
      Buffer.from(saved.payload.core).toString(),
    ).evaluation;
    if (!evaluated?.available)
      throw Error("The copied evaluation is unavailable.");
    const config = JSON.parse(
      await readFile(join(data, "loaded-view.json"), "utf8"),
    );
    const input = {
      events: [],
      bodies: {},
      selected_view: config.view,
      import_selections: {},
    };
    const objects = new FileObjectStore(join(data, "objects"));
    const groups = new Map(),
      targetWord = new Map(),
      judgmentTargets = [];
    const eventKinds = {};
    let envelopeBytes = 0,
      bodyBytes = 0;
    const ids = Object.keys(state.events).sort();
    for (let start = 0; start < ids.length; start += 8) {
      const rows = await Promise.all(
        ids.slice(start, start + 8).map(async (id) => {
          const meta = state.events[id];
          const envelope = await objects.get(meta.envelope_hash);
          const body = meta.body_hash
            ? await objects.get(meta.body_hash)
            : null;
          if (!envelope) throw Error(`Missing envelope ${id}`);
          return {
            id,
            envelope: Buffer.from(envelope).toString(),
            body: body ? Buffer.from(body).toString() : null,
          };
        }),
      );
      for (const row of rows) {
        input.events.push(row.envelope);
        envelopeBytes += Buffer.byteLength(row.envelope);
        if (row.body !== null) {
          input.bodies[row.id] = row.body;
          bodyBytes += Buffer.byteLength(row.body);
        }
        const event = JSON.parse(row.envelope),
          a = event.header.action;
        eventKinds[a.kind] = (eventKinds[a.kind] ?? 0) + 1;
        if (a.kind === "judgment.set") judgmentTargets.push(a.target);
        if (a.word) targetWord.set(a.assignment ?? row.id, a.word);
        const p = evaluated.publications[row.id];
        if (
          a.kind !== "definition.publish" ||
          !row.body ||
          p?.eligible !== "eligible" ||
          p?.status !== "active" ||
          evaluated.receipts[row.id]?.interpretation !== "effective"
        )
          continue;
        const body = JSON.parse(row.body);
        if (body.word.language !== "jbo") continue;
        const word = groups.get(a.word) ?? {
          word: a.word,
          spelling: body.word.spelling,
          targets: [],
          history_judgments: 0,
        };
        word.targets.push(row.id);
        groups.set(a.word, word);
      }
      if (start % 8000 === 0)
        console.log(JSON.stringify({ preparing: start, total: ids.length }));
    }
    for (const target of judgmentTargets) {
      const word = groups.get(targetWord.get(target));
      if (word) word.history_judgments++;
    }
    for (const hash of state.selections) {
      const bytes = await objects.get(hash);
      if (!bytes) throw Error("Missing selection");
      const parsed = prepareSelection(bytes);
      if (parsed.hash !== hash) throw Error("Selection hash mismatch");
      input.import_selections[hash] = parsed.ids;
    }
    const used = new Set(),
      sample = [];
    const take = (word, cohort) => {
      if (word && !used.has(word.word)) {
        sample.push({ ...word, cohort, targets: word.targets.sort() });
        used.add(word.word);
      }
    };
    for (const spelling of [
      "mi",
      "do",
      "ti",
      "ta",
      "tu",
      "lo",
      "le",
      "la",
      "cu",
      "na",
      "se",
      "te",
      "ve",
      "xe",
      "nu",
      "du",
      "da",
      "de",
      "di",
      "zo",
      "ko",
      "ka",
      "je",
      "poi",
      "no",
      "go'i",
      "ki'u",
      "gi'e",
      "be",
      "bei",
    ]) {
      if (sample.length >= 20) break;
      take(
        [...groups.values()].find((w) => w.spelling === spelling),
        "common_manual",
      );
    }
    if (sample.length !== 20)
      throw Error("The manual common-word sample needs 20 retained words.");
    for (const w of [...groups.values()].sort(
      (a, b) =>
        b.history_judgments - a.history_judgments ||
        b.targets.length - a.targets.length ||
        a.word.localeCompare(b.word),
    )) {
      if (sample.length >= 40) break;
      take(
        w,
        judgmentTargets.length
          ? "heavily_judged"
          : "many_definitions_no_judgments",
      );
    }
    for (const w of [...groups.values()].sort(
      (a, b) =>
        a.history_judgments - b.history_judgments ||
        a.word.localeCompare(b.word),
    )) {
      if (sample.length >= 60) break;
      take(w, "long_tail");
    }
    validateSample(sample);
    const serialized = JSON.stringify(input);
    await writeFile(cached, serialized);
    const dataset = {
      schema: 3,
      ancestry: ancestryShape(
        Object.entries(state.events).map(([id, event]) => ({
          id,
          issuer: event.header.issuer,
          previous: event.header.previous,
          kind: event.header.action.kind,
        })),
      ),
      event_kinds: eventKinds,
      envelope_bytes: envelopeBytes,
      body_bytes: bodyBytes,
      snapshot: state.materialized_snapshot,
      position: state.materialized_position,
      events: ids.length,
      view: config.view,
      profile: evaluated.policy.calculation,
      checkpoint_sha256: pin.hash,
      input_bytes: Buffer.byteLength(serialized),
      input_sha256: sha(serialized),
      limits: {
        events: 200000,
        traversal: config.state_traversal_limit ?? 1000000000,
        claim_depth: 1024,
      },
      sample,
    };
    await writeFile(
      join(out, "dataset.json"),
      JSON.stringify(dataset, null, 2),
    );
    return dataset;
  } finally {
    coordinator.close();
  }
}

let serverProcess = null,
  activeCleanup = null,
  outputFailure = null;
const lifecycle = createLifecycle({
  closeBrowser: async () => {
    await activeCleanup?.();
  },
  stopServer: () => stopChild(serverProcess),
  forceExit: (status) => {
    try {
      if (childRunning(serverProcess)) serverProcess.kill("SIGKILL");
    } finally {
      // Playwright's process-exit hook kills its owned browser process groups.
      process.exit(status);
    }
  },
});

function failOutput(error) {
  if (outputFailure) return;
  outputFailure = error;
  console.error("Measurement output failed:", error);
  lifecycle.fail(error);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(signal, () => lifecycle.handleSignal(signal));
async function startProductServer() {
  // Refuse an occupied port before sending any request to it.
  const reserved = createServer();
  let log,
    reservationReleased = false;
  let ownedListening = false,
    lines = "";
  try {
    await new Promise((resolve, reject) => {
      reserved.once("error", reject);
      reserved.listen(apiPort, "127.0.0.1", resolve);
    });
    await new Promise((r) => reserved.close(r));
    reservationReleased = true;
    log = createWriteStream(join(out, "server.log"), { flags: "a" });
    await new Promise((r, reject) => {
      log.once("open", r);
      log.once("error", reject);
    });
    lifecycle.assertActive();
    serverProcess = spawn(process.execPath, ["apps/server/dist/main.js"], {
      cwd: root,
      env: {
        ...process.env,
        JVC_DATA_DIR: data,
        HOST: "127.0.0.1",
        PORT: String(apiPort),
        JVC_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
        JVC_AI_ENABLED: "disabled",
        JVC_SEMANTIC_INDEXING: "disabled",
        JVC_SEMANTIC_PROFILE: "",
        JVC_SEMANTIC_ROUTE: undefined,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    log?.end();
    if (!reservationReleased)
      await new Promise((resolve) => reserved.close(resolve));
    throw error;
  }
  serverProcess.stdout.on("data", (chunk) => {
    log.write(chunk);
    lines += chunk.toString();
    while (lines.includes("\n")) {
      const i = lines.indexOf("\n");
      const line = lines.slice(0, i);
      lines = lines.slice(i + 1);
      try {
        const row = JSON.parse(line);
        if (
          row.event === "listening" &&
          row.data === data &&
          row.address.port === apiPort
        )
          ownedListening = true;
      } catch {}
    }
  });
  serverProcess.stderr.on("data", (chunk) => log.write(chunk));
  serverProcess.once("close", () => log.end());
  if (lifecycle.cancelled) await lifecycle.shutdown();
  for (let i = 0; i < 600; i++) {
    if (!childRunning(serverProcess))
      throw Error(
        `The disposable server exited: ${serverProcess.signalCode ?? serverProcess.exitCode}`,
      );
    if (!ownedListening) {
      await delay(1000);
      continue;
    }
    try {
      const response = await fetch(
        `http://127.0.0.1:${apiPort}/api/v1/manifest`,
      );
      if (response.ok) {
        const v = await response.json();
        if (v.snapshot !== dataset.snapshot)
          throw Error(
            "The served snapshot differs from the copied measurement input.",
          );
        await writeFile(
          join(out, "served-manifest.json"),
          JSON.stringify(v, null, 2),
        );
        return;
      }
    } catch {}
    await delay(1000);
  }
  throw Error("The disposable server did not become ready within 10 minutes.");
}
const http = createServer(async (req, res) => {
  if (req.url.startsWith("/api/")) {
    const upstream = httpRequest(
      {
        hostname: "127.0.0.1",
        port: apiPort,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${apiPort}` },
      },
      (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      },
    );
    upstream.on("error", (e) => {
      res.writeHead(503);
      res.end(String(e));
    });
    req.pipe(upstream);
    return;
  }
  const map = {
    "/": [null, "text/html"],
    "/page.js": [join(assets, "page.js"), "text/javascript"],
    "/worker.js": [join(assets, "worker.js"), "text/javascript"],
    "/seed-worker.js": [join(assets, "seed-worker.js"), "text/javascript"],
    "/workers/evaluate.ts": [
      join(assets, "product-worker.js"),
      "text/javascript",
    ],
    "/jvc_runtime_bg.wasm": [wasmPath, "application/wasm"],
    "/workers/jvc_runtime_bg.wasm": [wasmPath, "application/wasm"],
    "/input.json": [join(out, "input.json"), "application/json"],
  };
  const entry = map[req.url];
  if (!entry) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.setHeader("cache-control", "no-store");
  res.setHeader("cross-origin-opener-policy", "same-origin");
  res.setHeader("cross-origin-embedder-policy", "require-corp");
  res.setHeader("content-type", entry[1]);
  if (entry[0]) {
    res.setHeader("content-length", (await stat(entry[0])).size);
    const stream = createReadStream(entry[0]);
    res.once("close", () => stream.destroy());
    stream.once("error", () => res.destroy());
    stream.pipe(res);
  } else
    res.end(
      '<!doctype html><title>Worker measurement</title><script type="module" src="/page.js"></script>',
    );
});
await new Promise((r) => http.listen(port, "127.0.0.1", r));
let dataset = null;
const records = [];
const label = String(args.label ?? (args.probe ? "probe" : "measurements"));
if (!/^[A-Za-z0-9_.-]+$/.test(label))
  throw Error("Use a simple output label without path separators.");
const output = join(out, `${label}.ndjson`);
async function record(v) {
  if (outputFailure) throw outputFailure;
  lifecycle.assertActive();
  const row = { timestamp: new Date().toISOString(), head, ...v };
  try {
    await appendFile(output, JSON.stringify(row) + "\n");
  } catch (error) {
    failOutput(error);
    throw error;
  }
  records.push(row);
  console.log(
    JSON.stringify({
      trial: row.trial,
      condition: row.condition,
      phase: row.phase,
      word: row.spelling,
      type: row.type,
      ms: row.ms,
      error: row.error,
    }),
  );
}

async function trial(condition, rep, profile = false) {
  let browser = null,
    workerCDP = null,
    productWorkerCDP = null,
    rootCDP = null,
    pageCDP = null,
    page = null,
    watcher = null,
    heartbeat = null,
    limiter = null,
    phase = "launch",
    pssPeak = 0,
    lastPss = 0,
    lastPssAt = 0,
    budgetFailure = null,
    closing = null;
  const closeBrowser = () =>
    (closing ??= (async () => {
      clearInterval(watcher);
      clearInterval(heartbeat);
      await browser?.close().catch(() => {});
    })());
  const setup = (action) => lifecycle.runOperation(async () => {}, action);
  const cpuPids = new Map(),
    network = [];
  let caseId = `${condition.name}-${rep}${profile ? "-profile" : ""}`;
  const memory = async () => {
    lifecycle.assertActive();
    const worker = workerCDP
      ? await setup(() => workerCDP.send("Runtime.getHeapUsage"))
      : null;
    const linear = workerCDP
      ? await setup(() => workerCDP.evaluate("self.measurement() "))
      : null;
    return {
      page_js: pageCDP
        ? await setup(() => pageCDP.send("Runtime.getHeapUsage"))
        : null,
      page: page
        ? await setup(() => page.evaluate(() => window.bench.mainMemory()))
        : null,
      worker_js: worker,
      worker: linear,
      browser_pss_bytes: lastPss,
      browser_pss_sample_age_ms: lastPssAt
        ? performance.now() - lastPssAt
        : null,
      browser_pss_peak: pssPeak,
    };
  };
  const cpu = async () => {
    lifecycle.assertActive();
    const info = await rootCDP.send("SystemInfo.getProcessInfo");
    for (const p of info.processInfo)
      cpuPids.set(p.id, Math.max(cpuPids.get(p.id) ?? 0, p.cpuTime));
    return [...cpuPids.values()].reduce((a, b) => a + b, 0);
  };
  const operation = (label, fn, extra = {}) =>
    lifecycle.runOperation(
      async () => {
        phase = label;
        return cpu();
      },
      async (before) => {
        const start = performance.now();
        console.log(
          JSON.stringify({
            trial: caseId,
            starting: label,
            spelling: extra.spelling,
          }),
        );
        let timer;
        try {
          if (
            profile &&
            workerCDP &&
            /^(actors|load|increment-actors|increment-load|increment-advance|stress-actors|stress-load)$/.test(
              label,
            )
          ) {
            await setup(() => workerCDP.send("Profiler.enable"));
            await setup(() =>
              workerCDP.send("Profiler.setSamplingInterval", {
                interval: 1000,
              }),
            );
            await setup(() => workerCDP.send("Profiler.start"));
          }
          lifecycle.assertActive();
          const value = await Promise.race([
            fn(),
            new Promise((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    Error(
                      `Operation exceeded ${args["timeout-ms"] ?? 600000} ms`,
                    ),
                  ),
                Number(args["timeout-ms"] ?? 600000),
              );
            }),
          ]);
          lifecycle.assertActive();
          const ms = performance.now() - start;
          clearTimeout(timer);
          if (
            profile &&
            workerCDP &&
            /^(actors|load|increment-actors|increment-load|increment-advance|stress-actors|stress-load)$/.test(
              label,
            )
          ) {
            const { profile: p } = await setup(() =>
              workerCDP.send("Profiler.stop"),
            );
            const name = `${args.label ?? "measurements"}-${caseId}-${label.replaceAll(/[^a-z0-9-]/gi, "_")}.cpuprofile`;
            await writeFile(join(out, name), JSON.stringify(p));
            await record({
              type: "profile",
              trial: caseId,
              condition: condition.name,
              phase: label,
              file: name,
              summary: profileSummary(p),
            });
          }
          const row = {
            type: "operation",
            trial: caseId,
            condition: condition.name,
            phase: label,
            ms,
            cpu_seconds: (await cpu()) - before,
            value,
            memory: await memory(),
            ...extra,
          };
          await record(row);
          return value;
        } catch (e) {
          await record({
            type: "operation-error",
            trial: caseId,
            condition: condition.name,
            phase: label,
            ms: performance.now() - start,
            error: String(e),
            ...extra,
          });
          throw e;
        } finally {
          clearTimeout(timer);
        }
      },
    );
  try {
    lifecycle.assertActive();
    const launchArgs = [
      "--enable-precise-memory-info",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
    ];
    if (condition.oldSpace)
      launchArgs.push(`--js-flags=--max-old-space-size=${condition.oldSpace}`);
    browser = await chromium.launch({
      headless: true,
      args: launchArgs,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
    activeCleanup = closeBrowser;
    if (lifecycle.cancelled) return;
    manifest.chromium = browser.version();
    rootCDP = await setup(() => browser.newBrowserCDPSession());
    const context = await setup(() => browser.newContext());
    page = await setup(() => context.newPage());
    page.setDefaultTimeout(600000);
    context.on("requestfinished", async (request) => {
      const attribution = phase;
      try {
        network.push({
          phase: attribution,
          url: request.url(),
          ...(await request.sizes()),
        });
      } catch {}
    });
    page.on("console", (m) => {
      if (m.type() === "error")
        console.log(JSON.stringify({ trial: caseId, console: m.text() }));
    });
    pageCDP = await setup(() => context.newCDPSession(page));
    await setup(() => pageCDP.send("Network.enable"));
    await setup(() =>
      pageCDP.send("Network.setCacheDisabled", { cacheDisabled: true }),
    );
    await setup(() =>
      pageCDP.send("Emulation.setCPUThrottlingRate", {
        rate: condition.rate,
      }),
    );
    let sampling = false,
      setupBudgetPause = false;
    watcher = setInterval(async () => {
      if (sampling || lifecycle.cancelled || !browser?.isConnected()) return;
      sampling = true;
      try {
        const info = await rootCDP.send("SystemInfo.getProcessInfo");
        if (lifecycle.cancelled) return;
        let bytes = 0;
        for (const p of info.processInfo) {
          cpuPids.set(p.id, Math.max(cpuPids.get(p.id) ?? 0, p.cpuTime));
          try {
            const s = await readFile(`/proc/${p.id}/smaps_rollup`, "utf8");
            bytes += Number(s.match(/^Pss:\s+(\d+)/m)?.[1] ?? 0) * 1024;
          } catch {}
        }
        lastPss = bytes;
        lastPssAt = performance.now();
        pssPeak = Math.max(pssPeak, bytes);
        if (condition.pss && !setupBudgetPause && bytes > condition.pss) {
          budgetFailure = { budget: condition.pss, observed: bytes, phase };
          await browser.close();
        }
      } catch {
      } finally {
        sampling = false;
      }
    }, 500);
    const navigationStart = performance.now();
    heartbeat = setInterval(() => {
      if (lifecycle.cancelled) return;
      void record({
        type: "heartbeat",
        trial: caseId,
        condition: condition.name,
        phase,
        browser_pss_bytes: lastPss,
        browser_pss_peak: pssPeak,
        cpu_seconds: [...cpuPids.values()].reduce((a, b) => a + b, 0),
      }).catch((error) => {
        clearInterval(heartbeat);
        if (!lifecycle.cancelled) failOutput(error);
      });
    }, 30000);
    await setup(() => page.goto(`http://127.0.0.1:${port}`));
    await setup(() => page.waitForFunction(() => !!window.bench));
    await record({
      type: "navigation",
      trial: caseId,
      condition: condition.name,
      ms: performance.now() - navigationStart,
    });
    const offset = (rep % 3) * 20;
    const sample = [
      ...dataset.sample.slice(offset),
      ...dataset.sample.slice(0, offset),
    ].map((w) =>
      args["stress-only"] && w.cohort === "common_manual"
        ? { ...w, cohort: "synthetic_reviewed_common" }
        : w,
    );
    const targetWord = dataset.sample.find(
      (w) =>
        w.cohort === "heavily_judged" ||
        w.cohort === "many_definitions_no_judgments",
    );
    if (!args.probe) {
      if (args["product-reload"]) {
        setupBudgetPause = true;
        await setup(() =>
          page.evaluate(
            (view) => window.bench.prepareProduct(view),
            dataset.view,
          ),
        );
        await setup(() => pageCDP.send("HeapProfiler.collectGarbage"));
        await delay(750);
        setupBudgetPause = false;
        pssPeak = lastPss;
      }
      const gated = await operation("actual-personal-gate", () =>
        page.evaluate(({ view, keep }) => window.bench.gate(view, keep), {
          view: dataset.view,
          keep: Boolean(args["product-reload"]),
        }),
      );
      if (args["product-reload"] && gated.result.state !== "ready")
        throw Error(`Personal gate failed: ${gated.result.message}`);
    }
    if (args["product-reload"]) {
      let target;
      for (let i = 0; i < 50; i++) {
        lifecycle.assertActive();
        target = (await rootCDP.send("Target.getTargets")).targetInfos.find(
          (t) => t.type === "worker" && t.url.endsWith("/workers/evaluate.ts"),
        );
        if (target) break;
        await delay(20);
      }
      if (!target) throw Error("No personal-calculator worker target.");
      const attached = await setup(() =>
        rootCDP.send("Target.attachToTarget", {
          targetId: target.targetId,
          flatten: false,
        }),
      );
      productWorkerCDP = new WorkerCDP(rootCDP, attached.sessionId, {
        browser,
        lifecycle,
      });
      await setup(() => productWorkerCDP.send("Runtime.enable"));
      await operation("product-load-memory", () =>
        productWorkerCDP.evaluate("self.measurement()"),
      );
      const submission = await operation("product-signed-submission", () =>
        page.evaluate(
          (target) => window.bench.productSubmission(target),
          targetWord.targets[0],
        ),
      );
      const inventory = submittedInventory(
        JSON.parse(await readFile(join(out, "input.json"), "utf8")),
        submission.envelope,
      );
      const previousPeak = pssPeak;
      pssPeak = lastPss;
      await operation("product-reload", async () => {
        const value = await page.evaluate(
          (inventory) => window.bench.productReload(inventory),
          inventory,
        );
        const measurement =
          await productWorkerCDP.evaluate("self.measurement()");
        return { ...value, measurement, pss_peak: pssPeak };
      });
      pssPeak = Math.max(previousPeak, pssPeak);
      for (const [i, w] of sample.entries())
        await operation(
          "product-rank",
          () => page.evaluate((word) => window.bench.productRank(word), w.word),
          { ...w, sample_index: i, first_word: i === 0 },
        );
      await operation("product-finish", () =>
        page.evaluate(() => window.bench.productFinish()),
      );
      if (args["product-only"]) {
        await record({
          type: "trial-complete",
          trial: caseId,
          condition: condition.name,
          mode: "product_only",
          network,
          pss_peak: pssPeak,
        });
        return;
      }
    }
    // Page-only CDP throttling does not slow dedicated workers. The diagnostic
    // uses a separately labeled renderer duty cycle, without double-throttling.
    if ((!args.probe || args["worker-limit"]) && condition.rate > 1) {
      lifecycle.assertActive();
      if (closing) throw Error("Measurement interrupted during browser close.");
      await setup(() =>
        pageCDP.send("Emulation.setCPUThrottlingRate", { rate: 1 }),
      );
      limiter = await lifecycle.startLimiter(rootCDP, condition.rate);
      lifecycle.assertActive();
    }
    const diagnosticStart = performance.now();
    if (!args.probe)
      await operation("diagnostic-input-transfer", () =>
        page.evaluate(() => window.bench.fetchInput()),
      );
    if (args["stress-only"]) {
      await operation("synthetic-reviewer-setup", () =>
        page.evaluate(
          (words) => window.bench.stress(words),
          dataset.sample.filter((w) => w.cohort === "common_manual"),
        ),
      );
    }
    const workerReady = page.waitForEvent("worker");
    void workerReady.catch(() => {});
    await setup(() => page.evaluate(() => window.bench.start()));
    const playwrightWorker = await setup(() => workerReady);
    let target;
    for (let i = 0; i < 50; i++) {
      lifecycle.assertActive();
      target = (await rootCDP.send("Target.getTargets")).targetInfos.find(
        (t) => t.type === "worker" && t.url.endsWith("/worker.js"),
      );
      if (target) break;
      await delay(20);
    }
    if (!target) throw Error("No dedicated evaluation worker target.");
    const attached = await setup(() =>
      rootCDP.send("Target.attachToTarget", {
        targetId: target.targetId,
        flatten: false,
      }),
    );
    workerCDP = new WorkerCDP(rootCDP, attached.sessionId, {
      browser,
      lifecycle,
    });
    await setup(() => limiter?.sync());
    const workerThrottle = await setup(() =>
      configureWorkerThrottle(workerCDP, condition.rate, limiter),
    );
    await setup(() => workerCDP.send("Runtime.enable"));
    const calibrate = async () => {
      const value = await setup(() =>
        workerCDP.evaluate(
          "(()=>{let x=1;const start=performance.now();for(let i=0;i<400000000;i++)x=(Math.imul(x,1664525)+1013904223)|0;return {ms:performance.now()-start,iterations:400000000,checksum:x};})()",
        ),
      );
      await record({
        type: "calibration",
        trial: caseId,
        condition: condition.name,
        rate: condition.rate,
        worker_throttle_command: workerThrottle,
        worker_cpu_limiter: limiter
          ? "renderer SIGSTOP/SIGCONT duty cycle"
          : "none",
        value,
      });
    };
    if (args.probe) {
      await calibrate();
      return;
    }
    if (args["default-worker"] && rep === 0 && condition.name === "cpu1")
      await operation("default-limits-load", () =>
        page.evaluate(() => window.bench.load(undefined, "default")),
      );
    await operation("actors", () =>
      page.evaluate((limits) => window.bench.actors(limits), dataset.limits),
    );
    const loaded = await operation("load", () =>
      page.evaluate(
        (limits) => window.bench.load(limits, "base"),
        dataset.limits,
      ),
    );
    if (!loaded.available)
      throw Error(`Diagnostic evaluation unavailable: ${loaded.reasons}`);
    await record({
      type: "diagnostic-ready",
      trial: caseId,
      condition: condition.name,
      ms: performance.now() - diagnosticStart,
      network: [...network],
    });
    await setup(() => page.evaluate(() => window.bench.releaseInput()));
    await calibrate();
    if (context.pages().length !== 1 || page.workers().length !== 1)
      throw Error("Measurement requires one page and one worker.");
    const rankOne = async (w, label, session) => {
      try {
        await operation(
          label,
          () =>
            page.evaluate(
              ({ word, session }) => window.bench.rank(word, session),
              { word: w.word, session },
            ),
          w,
        );
      } catch (e) {
        if (
          lifecycle.cancelled ||
          outputFailure ||
          budgetFailure ||
          !browser.isConnected() ||
          page.isClosed() ||
          /crash|closed|destroyed|Operation exceeded/i.test(String(e))
        )
          throw e;
      }
    };
    if (profile) {
      await setup(() => workerCDP.send("Profiler.enable"));
      await setup(() => workerCDP.send("Profiler.start"));
    }
    for (const [i, w] of sample.entries())
      await rankOne(
        { ...w, sample_index: i, first_word: i === 0 },
        "rank",
        "base",
      );
    if (profile) {
      const { profile: p } = await setup(() => workerCDP.send("Profiler.stop"));
      const file = `${label}-${caseId}-ranks.cpuprofile`;
      await writeFile(join(out, file), JSON.stringify(p));
      await record({
        type: "profile",
        trial: caseId,
        condition: condition.name,
        phase: "ranks",
        file,
        summary: profileSummary(p),
      });
    }
    await operation("post-rank-gc", async () => {
      await setup(() => workerCDP.send("HeapProfiler.collectGarbage"));
      await setup(() => pageCDP.send("HeapProfiler.collectGarbage"));
      return { gc_requested: true };
    });
    if (args["stress-only"]) {
      await record({
        type: "trial-complete",
        trial: caseId,
        condition: condition.name,
        mode: "synthetic_only",
        network,
        pss_peak: pssPeak,
      });
      return;
    }
    await operation("increment-input-reconstruction", () =>
      page.evaluate(() => window.bench.fetchInput()),
    );
    await operation("local-signed-submission", () =>
      page.evaluate(
        (target) => window.bench.submission(target),
        targetWord.targets[0],
      ),
    );
    const advanceReload = Boolean(
      args["delta-reload"] || args["product-reload"],
    );
    if (!args["delta-reload"])
      await operation("increment-actors", () =>
        page.evaluate((limits) => window.bench.actors(limits), dataset.limits),
      );
    const updated = await operation(
      advanceReload ? "increment-advance" : "increment-load",
      () =>
        page.evaluate(
          ({ limits, delta }) =>
            delta
              ? window.bench.advance(limits, "after")
              : window.bench.load(limits, "after"),
          { limits: dataset.limits, delta: advanceReload },
        ),
    );
    if (!updated.available)
      throw Error(`Updated evaluation unavailable: ${updated.reasons}`);
    await setup(() => page.evaluate(() => window.bench.releaseInput()));
    for (const [i, w] of sample.entries())
      await rankOne(
        { ...w, sample_index: i, first_word: i === 0 },
        "increment-rank",
        "after",
      );
    if (args["verify-full-reload"]) {
      await operation("oracle-input-reconstruction", () =>
        page.evaluate(() => window.bench.fetchInput()),
      );
      await operation("oracle-signed-submission", () =>
        page.evaluate(
          (target) => window.bench.submission(target),
          targetWord.targets[0],
        ),
      );
      await operation("oracle-load", () =>
        page.evaluate(
          (limits) => window.bench.load(limits, "oracle"),
          dataset.limits,
        ),
      );
      await setup(() => page.evaluate(() => window.bench.releaseInput()));
      for (const [i, w] of sample.entries())
        await rankOne(
          { ...w, sample_index: i, first_word: i === 0 },
          "oracle-rank",
          "oracle",
        );
    }
    await record({
      type: "trial-complete",
      trial: caseId,
      condition: condition.name,
      network,
      pss_peak: pssPeak,
    });
  } catch (e) {
    await record({
      type: "trial-failure",
      trial: caseId,
      condition: condition.name,
      phase,
      error: String(e),
      budget_failure: budgetFailure,
      pss_peak: pssPeak,
      network,
    });
  } finally {
    clearInterval(watcher);
    clearInterval(heartbeat);
    await cleanupInOrder(() => lifecycle.stopLimiters(), closeBrowser);
    if (activeCleanup === closeBrowser) activeCleanup = null;
  }
}
try {
  if (!args.probe) {
    dataset = await prepare();
    if (
      !["simple-routes-bounds-v1", "simple-routes-shun-v1"].includes(
        dataset.profile,
      )
    )
      throw Error("The measurement requires an exact-profile view.");
    if (!lifecycle.cancelled && !args["product-reload"])
      await startProductServer();
    global.gc?.();
  }
  const modes = {
    cpu1: { name: "cpu1", rate: 1 },
    cpu4: { name: "cpu4", rate: 4 },
    cpu6: { name: "cpu6", rate: 6 },
    mid: { name: "mid", rate: 4, oldSpace: 512, pss: 1536 * 1024 * 1024 },
    phone: { name: "phone", rate: 6, oldSpace: 256, pss: 1024 * 1024 * 1024 },
  };
  const selected = String(
    args.conditions ??
      (args.probe ? "cpu1,cpu4,cpu6" : "cpu1,cpu4,cpu6,mid,phone"),
  )
    .split(",")
    .map((k) => {
      if (!modes[k]) throw Error(`Unknown condition ${k}`);
      return modes[k];
    });
  const repeats = Number(args.repeats ?? (args.probe ? 1 : 3));
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10)
    throw Error("Choose 1 through 10 repetitions.");
  for (let rep = 0; rep < repeats && !lifecycle.cancelled; rep++)
    for (let i = 0; i < selected.length && !lifecycle.cancelled; i++)
      await trial(selected[(i + rep) % selected.length], rep, !!args.profile);
  await writeFile(
    join(
      out,
      `${args.label ?? (args.probe ? "probe" : "measurements")}-environment.json`,
    ),
    JSON.stringify(manifest, null, 2),
  );
  const summary = {
    head,
    planned_trials: selected.length * repeats,
    attempted_trials: new Set(
      records.filter((r) => r.trial).map((r) => r.trial),
    ).size,
    completed_trials: records.filter((r) => r.type === "trial-complete").length,
    operation_errors: records.filter((r) => r.type === "operation-error"),
    conditions: Object.fromEntries(
      selected.map((c) => [
        c.name,
        Object.fromEntries(
          [
            "rank",
            "actual-personal-gate",
            "product-load-memory",
            "product-reload",
            "product-rank",
            "increment-rank",
            "actors",
            "load",
            "increment-actors",
            "increment-load",
            "increment-advance",
            "oracle-rank",
            "oracle-load",
          ].map((phase) => [
            phase,
            workerTimings(
              records.filter(
                (r) =>
                  r.type === "operation" &&
                  r.condition === c.name &&
                  r.phase === phase,
              ),
            ),
          ]),
        ),
      ]),
    ),
    failures: records.filter((r) => r.type === "trial-failure"),
  };
  await writeFile(
    join(out, `${label}-summary.json`),
    JSON.stringify(summary, null, 2),
  );
} catch (error) {
  if (!lifecycle.cancelled) throw error;
} finally {
  await lifecycle.shutdown();
  await new Promise((r) => http.close(r));
}
