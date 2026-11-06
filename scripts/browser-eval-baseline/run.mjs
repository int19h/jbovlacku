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
import {
  rendererLimiter,
  childRunning,
  stopChild,
  configureWorkerThrottle,
} from "./limits.mjs";
import { ancestryShape } from "./ancestry.mjs";
import { validateSample, readCachedDataset } from "./samples.mjs";

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
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const capture = (command, argv) => {
  try {
    return execFileSync(command, argv, { encoding: "utf8" }).trim();
  } catch (e) {
    return String(e);
  }
};
const assets = join(out, "assets");
await mkdir(assets, { recursive: true });
await build({
  entryPoints: [join(root, "scripts/browser-eval-baseline/page.mjs")],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: join(assets, "page.js"),
  logLevel: "error",
});
await build({
  entryPoints: [join(root, "apps/web/src/workers/evaluate.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: join(assets, "product-worker.js"),
  logLevel: "error",
});
await build({
  entryPoints: [join(root, "scripts/browser-eval-baseline/worker.mjs")],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: join(assets, "worker.js"),
  logLevel: "error",
  plugins: [
    {
      name: "measurement-session-getter",
      setup(b) {
        b.onLoad(
          { filter: /apps\/web\/src\/workers\/evaluate\.ts$/ },
          async ({ path }) => ({
            loader: "ts",
            contents:
              (await readFile(path, "utf8")) +
              "\nself.__measurementSession = () => session;\n",
          }),
        );
      },
    },
  ],
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

class WorkerCDP {
  constructor(root, session) {
    this.root = root;
    this.session = session;
    this.id = 0;
    this.pending = new Map();
    root.on("Target.detachedFromTarget", ({ sessionId }) => {
      if (sessionId === session) {
        for (const p of this.pending.values())
          p.reject(Error("Worker target detached"));
        this.pending.clear();
      }
    });
    root.on("Target.receivedMessageFromTarget", ({ sessionId, message }) => {
      if (sessionId !== session) return;
      const value = JSON.parse(message);
      if (value.id) {
        const p = this.pending.get(value.id);
        if (p) {
          this.pending.delete(value.id);
          value.error
            ? p.reject(Error(JSON.stringify(value.error)))
            : p.resolve(value.result);
        }
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.root
        .send("Target.sendMessageToTarget", {
          sessionId: this.session,
          message: JSON.stringify({ id, method, params }),
        })
        .catch(reject);
    });
  }
  async evaluate(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
}

let serverProcess = null,
  interrupted = false,
  activeCleanup = null,
  shutdownPromise = null,
  outputFailure = null;

function shutdown() {
  if (!serverProcess && !activeCleanup) return Promise.resolve();
  return (shutdownPromise ??= (async () => {
    try {
      await activeCleanup?.();
    } finally {
      await stopChild(serverProcess);
    }
  })());
}

function failOutput(error) {
  if (outputFailure) return;
  outputFailure = error;
  interrupted = true;
  process.exitCode = 1;
  console.error("Measurement output failed:", error);
  void shutdown().catch((error) => console.error("Cleanup failed:", error));
}

for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    if (!interrupted) process.exitCode = signal === "SIGINT" ? 130 : 143;
    interrupted = true;
    void shutdown().catch((error) => console.error("Cleanup failed:", error));
  });
async function startProductServer() {
  // Refuse an occupied port before sending any request to it.
  const reserved = createServer();
  await new Promise((resolve, reject) => {
    reserved.once("error", reject);
    reserved.listen(apiPort, "127.0.0.1", resolve);
  });
  await new Promise((r) => reserved.close(r));
  const log = createWriteStream(join(out, "server.log"), { flags: "a" });
  await new Promise((r, reject) => {
    log.once("open", r);
    log.once("error", reject);
  });
  let ownedListening = false,
    lines = "";
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
  if (interrupted) await shutdown();
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
      await limiter?.stop();
      await browser?.close().catch(() => {});
    })());
  const cpuPids = new Map(),
    network = [];
  let caseId = `${condition.name}-${rep}${profile ? "-profile" : ""}`;
  const memory = async () => {
    const worker = workerCDP
      ? await workerCDP.send("Runtime.getHeapUsage")
      : null;
    const linear = workerCDP
      ? await workerCDP.evaluate("self.measurement() ")
      : null;
    return {
      page_js: pageCDP ? await pageCDP.send("Runtime.getHeapUsage") : null,
      page: page ? await page.evaluate(() => window.bench.mainMemory()) : null,
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
    const info = await rootCDP.send("SystemInfo.getProcessInfo");
    for (const p of info.processInfo)
      cpuPids.set(p.id, Math.max(cpuPids.get(p.id) ?? 0, p.cpuTime));
    return [...cpuPids.values()].reduce((a, b) => a + b, 0);
  };
  const operation = async (label, fn, extra = {}) => {
    phase = label;
    const before = await cpu();
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
        /^(actors|load|increment-actors|increment-load|stress-actors|stress-load)$/.test(
          label,
        )
      ) {
        await workerCDP.send("Profiler.enable");
        await workerCDP.send("Profiler.setSamplingInterval", {
          interval: 1000,
        });
        await workerCDP.send("Profiler.start");
      }
      const value = await Promise.race([
        fn(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                Error(`Operation exceeded ${args["timeout-ms"] ?? 600000} ms`),
              ),
            Number(args["timeout-ms"] ?? 600000),
          );
        }),
      ]);
      const ms = performance.now() - start;
      clearTimeout(timer);
      if (
        profile &&
        workerCDP &&
        /^(actors|load|increment-actors|increment-load|stress-actors|stress-load)$/.test(
          label,
        )
      ) {
        const { profile: p } = await workerCDP.send("Profiler.stop");
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
  };
  try {
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
    });
    activeCleanup = closeBrowser;
    if (interrupted) return;
    manifest.chromium = browser.version();
    rootCDP = await browser.newBrowserCDPSession();
    const context = await browser.newContext();
    page = await context.newPage();
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
    pageCDP = await context.newCDPSession(page);
    await pageCDP.send("Network.enable");
    await pageCDP.send("Network.setCacheDisabled", { cacheDisabled: true });
    await pageCDP.send("Emulation.setCPUThrottlingRate", {
      rate: condition.rate,
    });
    let sampling = false;
    watcher = setInterval(async () => {
      if (sampling || !browser?.isConnected()) return;
      sampling = true;
      try {
        const info = await rootCDP.send("SystemInfo.getProcessInfo");
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
        if (condition.pss && bytes > condition.pss) {
          budgetFailure = { budget: condition.pss, observed: bytes, phase };
          await browser.close();
        }
      } catch {
      } finally {
        sampling = false;
      }
    }, 500);
    const navigationStart = performance.now();
    heartbeat = setInterval(
      () =>
        record({
          type: "heartbeat",
          trial: caseId,
          condition: condition.name,
          phase,
          browser_pss_bytes: lastPss,
          browser_pss_peak: pssPeak,
          cpu_seconds: [...cpuPids.values()].reduce((a, b) => a + b, 0),
        }).catch((error) => {
          clearInterval(heartbeat);
          failOutput(error);
        }),
      30000,
    );
    await page.goto(`http://127.0.0.1:${port}`);
    await page.waitForFunction(() => !!window.bench);
    await record({
      type: "navigation",
      trial: caseId,
      condition: condition.name,
      ms: performance.now() - navigationStart,
    });
    if (!args.probe) {
      await operation("actual-personal-gate", () =>
        page.evaluate((view) => window.bench.gate(view), dataset.view),
      );
    }
    // Page-only CDP throttling does not slow dedicated workers. The diagnostic
    // uses a separately labeled renderer duty cycle, without double-throttling.
    if ((!args.probe || args["worker-limit"]) && condition.rate > 1) {
      await pageCDP.send("Emulation.setCPUThrottlingRate", { rate: 1 });
      limiter = await rendererLimiter(rootCDP, condition.rate);
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
    await page.evaluate(() => window.bench.start());
    const playwrightWorker = await workerReady;
    let target;
    for (let i = 0; i < 50; i++) {
      target = (await rootCDP.send("Target.getTargets")).targetInfos.find(
        (t) => t.type === "worker" && t.url.endsWith("/worker.js"),
      );
      if (target) break;
      await delay(20);
    }
    if (!target) throw Error("No dedicated evaluation worker target.");
    const attached = await rootCDP.send("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: false,
    });
    workerCDP = new WorkerCDP(rootCDP, attached.sessionId);
    await limiter?.sync();
    const workerThrottle = await configureWorkerThrottle(
      workerCDP,
      condition.rate,
      limiter,
    );
    await workerCDP.send("Runtime.enable");
    const calibrate = async () => {
      const value = await workerCDP.evaluate(
        "(()=>{let x=1;const start=performance.now();for(let i=0;i<400000000;i++)x=(Math.imul(x,1664525)+1013904223)|0;return {ms:performance.now()-start,iterations:400000000,checksum:x};})()",
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
    await page.evaluate(() => window.bench.releaseInput());
    await calibrate();
    if (context.pages().length !== 1 || page.workers().length !== 1)
      throw Error("Measurement requires one page and one worker.");
    const offset = (rep % 3) * 20;
    const sample = [
      ...dataset.sample.slice(offset),
      ...dataset.sample.slice(0, offset),
    ].map((w) =>
      args["stress-only"] && w.cohort === "common_manual"
        ? { ...w, cohort: "synthetic_reviewed_common" }
        : w,
    );
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
          budgetFailure ||
          !browser.isConnected() ||
          page.isClosed() ||
          /crash|closed|destroyed|Operation exceeded/i.test(String(e))
        )
          throw e;
      }
    };
    if (profile) {
      await workerCDP.send("Profiler.enable");
      await workerCDP.send("Profiler.start");
    }
    for (const [i, w] of sample.entries())
      await rankOne(
        { ...w, sample_index: i, first_word: i === 0 },
        "rank",
        "base",
      );
    if (profile) {
      const { profile: p } = await workerCDP.send("Profiler.stop");
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
      await workerCDP.send("HeapProfiler.collectGarbage");
      await pageCDP.send("HeapProfiler.collectGarbage");
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
    const targetWord = dataset.sample.find(
      (w) =>
        w.cohort === "heavily_judged" ||
        w.cohort === "many_definitions_no_judgments",
    );
    await operation("local-signed-submission", () =>
      page.evaluate(
        (target) => window.bench.submission(target),
        targetWord.targets[0],
      ),
    );
    await operation("increment-actors", () =>
      page.evaluate((limits) => window.bench.actors(limits), dataset.limits),
    );
    const updated = await operation("increment-load", () =>
      page.evaluate(
        (limits) => window.bench.load(limits, "after"),
        dataset.limits,
      ),
    );
    if (!updated.available)
      throw Error(`Updated evaluation unavailable: ${updated.reasons}`);
    await page.evaluate(() => window.bench.releaseInput());
    for (const [i, w] of sample.entries())
      await rankOne(
        { ...w, sample_index: i, first_word: i === 0 },
        "increment-rank",
        "after",
      );
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
    activeCleanup = null;
    await closeBrowser();
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
    if (!interrupted) await startProductServer();
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
  for (let rep = 0; rep < repeats && !interrupted; rep++)
    for (let i = 0; i < selected.length && !interrupted; i++)
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
            "increment-rank",
            "actors",
            "load",
            "increment-actors",
            "increment-load",
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
  if (!interrupted) throw error;
} finally {
  await shutdown();
  await new Promise((r) => http.close(r));
}
