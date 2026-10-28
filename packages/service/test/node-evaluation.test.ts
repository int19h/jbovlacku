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
  identityFromSeed,
} from "../../core/src/index.ts";
import {
  canonical,
  importCapture,
  type CaptureManifest,
} from "../../importer/src/index.ts";

const wasm = await readFile(
  new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
);
before(() => initializeCore(wasm));
const options = {
  selected_view: "jve1:" + "0".repeat(64),
  import_selections: {},
};

test("Node sessions reject a changed signature and preserve additions and removals across forks", async () => {
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
  const second = createEvent(
    seed,
    [record.envelope.id],
    "2".repeat(32),
    { kind: "identity.merge" },
    null,
  );
  const addedInline = evaluateSession({
    ...options,
    events: [record, second].map((value) =>
      canonicalize(utf8(JSON.stringify(value.envelope))),
    ),
    bodies: {},
  });
  const removedInline = evaluateSession({
    ...options,
    events: [canonicalize(utf8(JSON.stringify(second.envelope)))],
    bodies: {},
  });
  try {
    const invalid = await runtime.create(options);
    const forged = structuredClone(record.envelope);
    const signature = Buffer.from(forged.signature, "base64");
    signature[signature.length - 1] ^= 1;
    forged.signature = signature.toString("base64");
    await assert.rejects(
      Promise.resolve(invalid.addRecord(utf8(JSON.stringify(forged)))),
      /signature/i,
    );
    invalid.free();
    const builder = await runtime.create(options);
    await builder.addRecord(utf8(JSON.stringify(record.envelope)));
    const parent = await builder.finish();
    builder.free();
    assert.deepEqual(parent.state, inline.state);
    const childBuilder = await parent.fork(options);
    await childBuilder.addRecord(utf8(JSON.stringify(second.envelope)));
    const child = await childBuilder.finish();
    childBuilder.free();
    assert.deepEqual(child.state, addedInline.state);
    assert.notDeepEqual(child.state, parent.state);
    assert.equal(runtime.liveWorkers, 2);
    parent.free();
    const removalBuilder = await child.fork(options);
    await removalBuilder.removeRecord(record.envelope.id);
    const removed = await removalBuilder.finish();
    removalBuilder.free();
    assert.deepEqual(removed.state, removedInline.state);
    assert.notDeepEqual(removed.state, child.state);
    removed.free();
    const bytes = await child.checkpoint("private-test-binding");
    child.free();
    await assert.rejects(runtime.restore(bytes, "wrong-binding"));
    const restored = await runtime.restore(bytes, "private-test-binding");
    assert.deepEqual(restored.state, child.state);
    restored.free();
  } finally {
    inline.free();
    addedInline.free();
    removedInline.free();
    await runtime.close();
  }
  assert.equal(runtime.liveWorkers, 0);
});

function guardedRuntime(configuration: Record<string, boolean>) {
  return new NodeEvaluationRuntime(wasm, {
    workerFactory: (data) =>
      new Worker(
        new URL("./fixtures/guarded-evaluation-worker.ts", import.meta.url),
        {
          workerData: { ...data, entry: "test", ...configuration },
          execArgv: ["--experimental-transform-types"],
        },
      ),
  });
}

test("a Wasm trap makes a Node session unavailable before the error reaches its caller", async () => {
  const runtime = guardedRuntime({ trapRank: true });
  try {
    const builder = await runtime.create(options);
    const session = await builder.finish();
    builder.free();
    const ranking = Promise.resolve(session.rankWord("test"));
    const pendingCheckpoint = assert.rejects(
      Promise.resolve(session.checkpoint("queued-with-trap")),
      /unreachable|closed|stopped/,
    );
    await assert.rejects(ranking, /unreachable/);
    assert.equal(session.isAvailable?.(), false);
    await pendingCheckpoint;
    await assert.rejects(
      Promise.resolve(session.checkpoint("after-trap")),
      /unreachable|closed|stopped/,
    );
    await assert.rejects(
      Promise.resolve(session.fork(options)),
      /unreachable|closed|stopped/,
    );
    const replacement = await runtime.create(options);
    const recovered = await replacement.finish();
    replacement.free();
    assert.equal(recovered.isAvailable?.(), true);
    assert.ok(runtime.liveWorkers <= 2);
    recovered.free();
  } finally {
    await runtime.close();
  }
  assert.equal(runtime.liveWorkers, 0);
});

test("Node workers transfer evaluated state without parsing a full JavaScript state", async () => {
  const runtime = guardedRuntime({ rejectParsedState: true });
  try {
    const builder = await runtime.create(options);
    const parent = await builder.finish();
    builder.free();
    const childBuilder = await parent.fork(options);
    const child = await childBuilder.finish();
    childBuilder.free();
    assert.deepEqual(child.state, parent.state);
    const bytes = await child.checkpoint("unparsed-state");
    child.free();
    const restored = await runtime.restore(bytes, "unparsed-state");
    assert.deepEqual(restored.state, parent.state);
    restored.free();
    parent.free();
  } finally {
    await runtime.close();
  }
});

test("Node judgment forks share unchanged state and match full evaluation after a checkpoint transfer", async () => {
  const sourceBytes = await readFile(
    new URL("../../importer/fixtures/lensisku-sample.json", import.meta.url),
  );
  const manifest = JSON.parse(
    await readFile(
      new URL(
        "../../importer/fixtures/lensisku-sample.manifest.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as CaptureManifest;
  const reviewer = new Uint8Array(32).fill(73);
  const imported = importCapture({
    sourceBytes,
    manifest,
    seed: new Uint8Array(32).fill(72),
    roots: [
      {
        identity: identityFromSeed(reviewer),
        q: { numerator: 1, denominator: 1 },
      },
    ],
  });
  const context = {
    selected_view: imported.view.envelope.id,
    import_selections: { [imported.selection.hash]: imported.selection.ids },
  };
  const runtime = guardedRuntime({ rejectParsedState: true });
  const input = {
    ...context,
    events: imported.carriers.map((record) => canonical(record.envelope)),
    bodies: Object.fromEntries(
      imported.carriers.map((record) => [
        record.envelope.id,
        canonical(record.body),
      ]),
    ),
  };
  try {
    const builder = await runtime.create(context);
    for (const record of imported.carriers) {
      const envelope = utf8(JSON.stringify(record.envelope));
      const body = utf8(canonical(record.body));
      const originals = [envelope.slice(), body.slice()];
      await builder.addRecord(envelope, body);
      assert.deepEqual(envelope, originals[0]);
      assert.deepEqual(body, originals[1]);
    }
    const parent = await builder.finish();
    builder.free();
    assert.equal(parent.state.available, true);
    const original = structuredClone(parent.state);
    const target = Object.values(parent.state.publications)[0];
    const rank = await parent.rankWord(target.word);
    const judgment = createEvent(
      reviewer,
      [],
      "9".repeat(32),
      { kind: "judgment.set", target: target.id, value: "bless" },
      null,
    );
    const childBuilder = await parent.fork(context);
    await childBuilder.addRecord(utf8(JSON.stringify(judgment.envelope)));
    const child = await childBuilder.finish();
    childBuilder.free();
    const full = evaluateSession({
      ...input,
      events: [...input.events, canonical(judgment.envelope)],
    });
    try {
      assert.deepEqual(child.state, full.state);
      assert.notDeepEqual(child.state, parent.state);
      assert.equal(child.state.publications, parent.state.publications);
      assert.equal(
        child.state.publication_statuses,
        parent.state.publication_statuses,
      );
      assert.deepEqual(parent.state, original);
      assert.deepEqual(await parent.rankWord(target.word), rank);
      assert.deepEqual(
        await child.rankWord(target.word),
        full.rankWord(target.word),
      );
      assert.throws(() => {
        child.state.receipts[judgment.envelope.id].body = "forged";
      }, TypeError);
      assert.ok(Object.isFrozen(child.state.lifecycle));
    } finally {
      full.free();
      child.free();
      parent.free();
    }
  } finally {
    await runtime.close();
  }
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
