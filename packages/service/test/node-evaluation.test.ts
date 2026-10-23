import assert from "node:assert/strict";
import { before, test } from "node:test";
import { Worker } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import { NodeEvaluationRuntime } from "../../../apps/server/src/evaluation.ts";
import {
  initializeCore,
  createEvent,
  canonicalize,
  utf8,
  evaluateSession,
} from "../../core/src/index.ts";

const wasm = await readFile(
  new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
);
before(() => initializeCore(wasm));
const options = {
  selected_view: "jve1:" + "0".repeat(64),
  import_selections: {},
};

test("Node sessions authenticate originals, preserve fork parity, and release failed restore slots", async () => {
  const runtime = new NodeEvaluationRuntime(wasm);
  const seed = new Uint8Array(32).fill(83);
  const record = createEvent(
    seed,
    [],
    "1".repeat(32),
    { kind: "identity.merge" },
    null,
  );
  const inline = evaluateSession({
    ...options,
    events: [canonicalize(utf8(JSON.stringify(record.envelope)))],
    bodies: {},
  });
  try {
    const invalid = await runtime.create(options);
    await assert.rejects(
      Promise.resolve(invalid.addRecord(utf8("invalid original bytes"))),
    );
    invalid.free();
    const builder = await runtime.create(options);
    await builder.addRecord(utf8(JSON.stringify(record.envelope)));
    const parent = await builder.finish();
    builder.free();
    assert.deepEqual(parent.state, inline.state);
    const childBuilder = await parent.fork(options);
    const child = await childBuilder.finish();
    childBuilder.free();
    assert.deepEqual(child.state, parent.state);
    assert.equal(runtime.liveWorkers, 2);
    const bytes = await child.checkpoint("private-test-binding");
    child.free();
    await assert.rejects(runtime.restore(bytes, "wrong-binding"));
    const restored = await runtime.restore(bytes, "private-test-binding");
    assert.deepEqual(restored.state, parent.state);
    restored.free();
    parent.free();
  } finally {
    inline.free();
    await runtime.close();
  }
  assert.equal(runtime.liveWorkers, 0);
});

test("Node worker slots stay bounded and an exited worker does not prevent recovery", async () => {
  const workers: Worker[] = [];
  const runtime = new NodeEvaluationRuntime(wasm, {
    workerFactory: (data) => {
      const worker = new Worker(
        new URL(
          "../../../apps/server/src/evaluation-worker.ts",
          import.meta.url,
        ),
        {
          workerData: data,
          execArgv: ["--experimental-transform-types"],
        },
      );
      workers.push(worker);
      return worker;
    },
  });
  try {
    const first = await runtime.create(options);
    const second = await runtime.create(options);
    await assert.rejects(runtime.create(options), /Two evaluation runtimes/);
    assert.equal(runtime.liveWorkers, 2);
    await workers[0].terminate();
    await assert.rejects(
      Promise.resolve(first.removeRecord("jve1:" + "1".repeat(64))),
      /stopped|closed/,
    );
    first.free();
    const next = await runtime.create(options);
    const session = await next.finish();
    assert.equal(session.isAvailable?.(), true);
    second.free();
    session.free();
  } finally {
    await runtime.close();
  }
  assert.equal(runtime.liveWorkers, 0);
});

test("closing the Node runtime terminates a blocked finish without waiting for core work", async () => {
  const gate = new Int32Array(new SharedArrayBuffer(12));
  Atomics.store(gate, 2, 1);
  const runtime = new NodeEvaluationRuntime(wasm, {
    workerFactory: (data) =>
      new Worker(
        new URL("./fixtures/slow-evaluation-worker.ts", import.meta.url),
        {
          workerData: { ...data, entry: "test", gate: gate.buffer },
          execArgv: ["--experimental-transform-types"],
        },
      ),
  });
  try {
    const builder = await runtime.create(options);
    const pending = builder.finish();
    const rejected = assert.rejects(Promise.resolve(pending), /closed|stopped/);
    const until = Date.now() + 2000;
    while (!Atomics.load(gate, 0)) {
      assert.ok(Date.now() < until);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const started = performance.now();
    await runtime.close();
    assert.ok(performance.now() - started < 500);
    await rejected;
  } finally {
    await runtime.close();
  }
  assert.equal(runtime.liveWorkers, 0);
});

test(
  "a long Node evaluation leaves completed reads and the request thread responsive",
  { timeout: 15000 },
  async () => {
    const gate = new Int32Array(new SharedArrayBuffer(12));
    const host = new Worker(
      new URL("./fixtures/evaluation-host.ts", import.meta.url),
      {
        execArgv: ["--experimental-transform-types"],
        workerData: {
          gate: gate.buffer,
          inline: process.env.JVC_TEST_INLINE_EVALUATION === "1",
        },
      },
    );
    const messages: any[] = [];
    let failure: Error | undefined;
    host.on("message", (message) => messages.push(message));
    host.on("error", (error) => {
      failure = error;
    });
    const wait = async (predicate: () => any) => {
      const until = Date.now() + 10000;
      while (!predicate()) {
        if (failure) throw failure;
        assert.ok(
          Date.now() < until,
          "The fixture did not reach the expected phase.",
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return predicate();
    };
    try {
      const ready = await wait(() =>
        messages.find((value) => value.type === "ready"),
      );
      host.postMessage("write");
      await wait(() => Atomics.load(gate, 0));
      for (const path of [
        "/api/health/ready",
        "/api/v1/manifest",
        "/api/v1/search?q=klama&language=en",
        "/api/v1/words/" + ready.word,
      ]) {
        const started = performance.now();
        const result = await fetch(`http://127.0.0.1:${ready.port}${path}`, {
          signal: AbortSignal.timeout(500),
        });
        assert.equal(result.status, 200, await result.clone().text());
        assert.ok(performance.now() - started < 500);
        const value: any = await result.json();
        if (path !== "/api/health/ready")
          assert.equal(value.snapshot, ready.old);
      }
      Atomics.store(gate, 1, 1);
      Atomics.notify(gate, 1);
      const published = await wait(() =>
        messages.find((value) => value.type === "published"),
      );
      assert.notEqual(published.snapshot, ready.old);
      assert.equal(published.receipt.snapshot, published.snapshot);
      assert.equal(published.receipt.interpretation, "effective");
    } finally {
      Atomics.store(gate, 1, 1);
      Atomics.notify(gate, 1);
      await host.terminate();
    }
  },
);
