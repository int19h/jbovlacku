import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { distribution, profileSummary, workerTimings } from "./metrics.mjs";
import {
  rendererLimiter,
  childRunning,
  stopChild,
  configureWorkerThrottle,
} from "./limits.mjs";
import { validateSample, readCachedDataset } from "./samples.mjs";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
test("an active renderer limiter skips even a successful worker throttle command", async () => {
  const commands = [];
  const cdp = { send: async (...args) => commands.push(args) };
  assert.equal(
    await configureWorkerThrottle(cdp, 4, {}),
    "skipped: renderer limiter active",
  );
  assert.deepEqual(commands, []);
  assert.equal(await configureWorkerThrottle(cdp, 4, null), "applied");
  assert.deepEqual(commands, [["Emulation.setCPUThrottlingRate", { rate: 4 }]]);
});

test("worker distributions count missing timings without substituting parent time", () => {
  const result = workerTimings([
    { ms: 100, value: { measurement: { worker_ms: 4 } } },
    { ms: 200, value: {} },
    { ms: 300, value: { measurement: { worker_ms: NaN } } },
    { ms: 400, value: { measurement: { worker_ms: 0 } } },
  ]);
  assert.equal(result.n, 2);
  assert.equal(result.max, 4);
  assert.equal(result.p50, 0);
  assert.equal(result.missing_worker_timings, 2);
});
test("nearest-rank distributions retain zeros and exclude non-finite observations", () => {
  assert.deepEqual(distribution([]), {
    n: 0,
    min: null,
    p50: null,
    p90: null,
    p95: null,
    p99: null,
    max: null,
    mean: null,
  });
  assert.deepEqual(distribution([4, 0, 2, NaN, Infinity]), {
    n: 3,
    min: 0,
    p50: 2,
    p90: 4,
    p95: 4,
    p99: 4,
    max: 4,
    mean: 2,
  });
});
test("profile categories use ancestry callers and keep idle time separate", () => {
  const names = [
    "(root)",
    "jvc_state::graph::Graph::build_cache",
    "memcpy",
    "ed25519_dalek::verify",
    "jvc_rank::rank",
    "(idle)",
    "(garbage collector)",
  ];
  const nodes = names.map((name, id) => ({
    id,
    callFrame: { functionName: name },
    children: id === 0 ? [1, 3, 4, 5, 6] : id === 1 ? [2] : [],
  }));
  const summary = profileSummary({
    nodes,
    samples: [2, 3, 4, 5, 6],
    timeDeltas: [10, 20, 30, 40, 50],
  });
  assert.equal(summary.ancestry_us, 10);
  assert.equal(summary.signature_us, 20);
  assert.equal(summary.ranking_us, 30);
  assert.equal(summary.idle_us, 40);
  assert.equal(summary.gc_us, 50);
});
test("the renderer limiter resumes its owned process after cancellation", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"]);
  const state = async () => {
    try {
      return (await readFile(`/proc/${child.pid}/stat`, "utf8"))
        .split(") ")[1]
        .split(" ")[0];
    } catch {
      return null;
    }
  };
  let limiter;
  try {
    limiter = await rendererLimiter(
      {
        send: async () => ({
          processInfo: [{ type: "renderer", id: child.pid }],
        }),
      },
      6,
    );
    for (let i = 0; i < 100 && (await state()) !== "T"; i++) await delay(5);
    assert.equal(await state(), "T");
    await limiter.stop();
    await delay(100);
    assert.notEqual(await state(), "T");
  } finally {
    await limiter?.stop();
    child.kill("SIGCONT");
    await stopChild(child);
  }
});

test(
  "server shutdown recognizes an earlier signal exit without a new waiter",
  { timeout: 5000 },
  async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"]);
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, "SIGKILL");
    assert.equal(childRunning(child), false);
    const listeners = child.listenerCount("exit");
    await stopChild(child);
    await stopChild(child);
    assert.equal(child.listenerCount("exit"), listeners);
  },
);

test(
  "normal server shutdown waits before signaling and is repeat-safe",
  { timeout: 5000 },
  async () => {
    const child = spawn(process.execPath, [
      "-e",
      "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),20));setInterval(()=>{},1000);console.log('ready')",
    ]);
    try {
      await once(child.stdout, "data");
      let signals = 0;
      const kill = child.kill.bind(child);
      child.kill = (signal) => {
        assert.equal(child.listenerCount("exit"), 1);
        signals++;
        return kill(signal);
      };
      assert.equal(childRunning(child), true);
      const stopped = stopChild(child);
      assert.equal(stopChild(child), stopped);
      await stopped;
      await stopChild(child);
      assert.equal(signals, 1);
      assert.equal(child.exitCode, 0);
      assert.equal(child.signalCode, null);
      assert.equal(childRunning(child), false);
    } finally {
      await stopChild(child);
    }
  },
);

const sampleWords = (count = 60, middle = "heavily_judged") =>
  Array.from({ length: count }, (_, index) => ({
    word: String(index),
    cohort: index < 20 ? "common_manual" : index < 40 ? middle : "long_tail",
  }));

test("sample admission requires 60 distinct words and three cohorts of 20", () => {
  assert.throws(
    () => validateSample(sampleWords(59)),
    /60 distinct eligible words/,
  );
  assert.doesNotThrow(() => validateSample(sampleWords()));
  assert.doesNotThrow(() =>
    validateSample(sampleWords(60, "many_definitions_no_judgments")),
  );
  const duplicate = sampleWords();
  duplicate[59].word = duplicate[0].word;
  assert.throws(() => validateSample(duplicate), /60 distinct eligible words/);
  const uneven = sampleWords();
  uneven[59].cohort = "common_manual";
  assert.throws(() => validateSample(uneven), /60 distinct eligible words/);
});

test("cached sample admission rejects undersized schema-2 and schema-3 datasets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browser-eval-sample-"));
  const path = join(directory, "dataset.json");
  try {
    for (const schema of [2, 3]) {
      await writeFile(
        path,
        JSON.stringify({ schema, sample: sampleWords(59) }),
      );
      await assert.rejects(
        readCachedDataset(path),
        /60 distinct eligible words/,
      );
      const bytes = Buffer.from("{}");
      await writeFile(join(directory, "input.json"), bytes);
      const valid = {
        schema,
        sample: sampleWords(),
        input_bytes: bytes.length,
        input_sha256: createHash("sha256").update(bytes).digest("hex"),
      };
      await writeFile(path, JSON.stringify(valid));
      assert.deepEqual(await readCachedDataset(path), valid);
    }
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("cached input integrity rejects changed hashes, byte counts, and missing files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browser-eval-integrity-"));
  const path = join(directory, "dataset.json");
  const input = join(directory, "input.json");
  try {
    for (const schema of [2, 3]) {
      const bytes = Buffer.from("{}");
      const dataset = {
        schema,
        sample: sampleWords(),
        input_bytes: 2,
        input_sha256: createHash("sha256").update(bytes).digest("hex"),
      };
      await writeFile(path, JSON.stringify(dataset));
      await writeFile(input, "[]");
      await assert.rejects(
        readCachedDataset(path),
        /Cached input is missing or differs/,
      );
      await writeFile(input, "{} ");
      await assert.rejects(
        readCachedDataset(path),
        /Cached input is missing or differs/,
      );
      await rm(input);
      await assert.rejects(
        readCachedDataset(path),
        /Cached input is missing or differs/,
      );
    }
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("ancestry storage bounds apply only to complete single-parent histories", async () => {
  const { ancestryShape } = await import("./ancestry.mjs");
  const chain = Array.from({ length: 100 }, (_, i) => ({
    id: String(i),
    issuer: "a",
    previous: i ? [String(i - 1)] : [],
    kind: "definition.publish",
  }));
  const m = ancestryShape(chain);
  assert.equal(m.single_parent_model_valid, true);
  assert.equal(m.max_chain_depth, 100);
  assert.equal(m.wasm32_dense_payload_per_closure, 16);
  assert.equal(m.dense_closures, 96);
  assert.equal(m.minimum_identifier_payload_bytes, 1576);
  chain.push({
    id: "join",
    issuer: "a",
    previous: ["1", "2"],
    kind: "definition.publish",
  });
  assert.equal(ancestryShape(chain).minimum_identifier_payload_bytes, null);
});
