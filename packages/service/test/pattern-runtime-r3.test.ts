import assert from "node:assert/strict";
import { before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { EventEmitter, getEventListeners } from "node:events";
import { Worker } from "node:worker_threads";
import { initializeCore } from "../../core/src/index.ts";
import { NodePatternScanner } from "../../../apps/server/src/pattern-search.ts";
import type { PatternScanner } from "../../search/src/pattern-scan.ts";
import { DictionaryService } from "../src/service.ts";
let wasm: Uint8Array;
before(async () => {
  wasm = await readFile(
    new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
  );
  await initializeCore(wasm);
});
class ControlledWorker extends EventEmitter {
  messages: any[] = [];
  stopped = false;
  ref() {
    return this;
  }
  unref() {
    return this;
  }
  postMessage(data: unknown) {
    this.messages.push(data);
  }
  async terminate() {
    this.stopped = true;
    return 0;
  }
  ready() {
    this.emit("message", { ready: true });
  }
  reply(rows: unknown[] = []) {
    this.emit("message", { id: this.messages.at(-1).id, rows });
  }
}
const asWorker = (worker: ControlledWorker) => worker as unknown as Worker;
const abortError = (e: any) => e.name === "AbortError";
const busy = (e: any) => e.code === "search_busy" && e.status === 503;
function service(scanner: PatternScanner) {
  const internal = new DictionaryService({} as any, {} as any, {
    serverId: "r3-admission",
    policyUrl: "https://example.invalid",
    patternScanner: scanner,
  }) as any;
  internal.interpretedSnapshot = async () => ({
    snapshot: "sha256:" + "a".repeat(64),
    events: {},
  });
  internal.requireView = async () => {};
  internal.packages = async () => ({ entries: [], searchRafsi: {} });
  internal.evaluation = async () => ({
    available: true,
    publications: {},
    receipts: {},
  });
  return internal as DictionaryService;
}
const request = () =>
  new Request("http://local.invalid/api/v1/search?q=*&language=en");
test("warm Node workers release finished capacity immediately and retain the two/eight bound", async () => {
  const workers: ControlledWorker[] = [];
  const scanner = new NodePatternScanner(wasm, {
    workerFactory: () => {
      const worker = new ControlledWorker();
      workers.push(worker);
      return asWorker(worker);
    },
  });
  try {
    const first = scanner.scan([], "*");
    workers[0].ready();
    workers[0].reply();
    assert.deepEqual(await first, []);
    // No terminate promise stands between a delivered result and the next task.
    const jobs = Array.from({ length: 10 }, () => scanner.scan([], "*"));
    assert.equal(workers.length, 2);
    assert.equal(scanner.queuedRequests, 8);
    await assert.rejects(scanner.scan([], "*"), busy);
    workers[1].ready();
    for (let i = 0; i < 5; i++) {
      workers[0].reply();
      workers[1].reply();
    }
    assert.ok((await Promise.all(jobs)).every((rows) => rows.length === 0));
    assert.equal(scanner.liveWorkers, 2);
    assert.equal(scanner.queuedRequests, 0);
  } finally {
    await scanner.close();
  }
  assert.ok(workers.every((w) => w.stopped));
});
test("Node startup and task deadlines are separate and expired workers are replaced", async () => {
  const workers: ControlledWorker[] = [];
  const scanner = new NodePatternScanner(wasm, {
    taskTimeoutMs: 25,
    startupTimeoutMs: 1000,
    workerFactory: () => {
      const worker = new ControlledWorker();
      workers.push(worker);
      return asWorker(worker);
    },
  });
  try {
    const slow = scanner.scan([], "*");
    await new Promise((resolve) => setTimeout(resolve, 60));
    workers[0].ready();
    workers[0].reply();
    assert.deepEqual(await slow, []);
    const hung = scanner.scan([], "*");
    await assert.rejects(hung, (e: any) => e.code === "pattern_timeout");
    assert.equal(workers[0].stopped, true);
    const next = scanner.scan([], "*");
    workers[1].ready();
    workers[1].reply();
    assert.deepEqual(await next, []);
  } finally {
    await scanner.close();
  }
  const notReady = new NodePatternScanner(wasm, {
    startupTimeoutMs: 20,
    workerFactory: () => asWorker(new ControlledWorker()),
  });
  try {
    await assert.rejects(notReady.scan([], "*"), /did not become ready/);
  } finally {
    await notReady.close();
  }
});
test("warm Node error, exit, abort, constructor failure and close settle tasks once", async () => {
  const workers: ControlledWorker[] = [];
  const scanner = new NodePatternScanner(wasm, {
    workerFactory: () => {
      const worker = new ControlledWorker();
      workers.push(worker);
      return asWorker(worker);
    },
  });
  const active = new AbortController(),
    queued = new AbortController();
  const jobs = [
    scanner.scan([], "*", active.signal).catch((e) => e),
    scanner.scan([], "*").catch((e) => e),
    scanner.scan([], "*", queued.signal).catch((e) => e),
  ];
  queued.abort();
  active.abort();
  workers[1].emit("error", new Error("Synthetic worker error"));
  await Promise.all(jobs);
  assert.equal(getEventListeners(active.signal, "abort").length, 0);
  assert.equal(getEventListeners(queued.signal, "abort").length, 0);
  const exit = scanner.scan([], "*");
  workers[2].emit("exit", 1);
  await assert.rejects(exit, /worker stopped/);
  const closing = scanner.scan([], "*").catch((e) => e);
  await scanner.close();
  await closing;
  for (const worker of workers) {
    worker.emit("message", { ready: true });
    worker.emit("message", { id: 1, rows: [] });
  }
  assert.equal(scanner.liveWorkers, 0);
  assert.equal(scanner.queuedRequests, 0);
  const broken = new NodePatternScanner(wasm, {
    workerFactory: () => {
      throw new Error("Synthetic constructor failure");
    },
  });
  try {
    await assert.rejects(broken.scan([], "*"), /constructor failure/);
  } finally {
    await broken.close();
  }
});
test("Node overload is HTTP 503 search_busy with Retry-After and no partial hits", async () => {
  const scanner = new NodePatternScanner(wasm, {
    workerFactory: () => asWorker(new ControlledWorker()),
  });
  const jobs = Array.from({ length: 10 }, () =>
    scanner.scan([], "*").catch((e) => e),
  );
  try {
    const response = await service(scanner.scan).fetch(request());
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "1");
    const body: any = await response.json();
    assert.equal(body.code, "search_busy");
    assert.equal(body.hits, undefined);
  } finally {
    await scanner.close();
    await Promise.all(jobs);
  }
});
test("Node abort during worker construction settles before startup or task messages", async () => {
  const abort = new AbortController();
  const worker = new ControlledWorker();
  const scanner = new NodePatternScanner(wasm, {
    workerFactory: () => {
      abort.abort();
      return asWorker(worker);
    },
  });
  try {
    await assert.rejects(scanner.scan([], "*", abort.signal), abortError);
    worker.ready();
    assert.deepEqual(worker.messages, []);
    assert.equal(worker.stopped, true);
    assert.equal(getEventListeners(abort.signal, "abort").length, 0);
    assert.equal(scanner.liveWorkers, 0);
  } finally {
    await scanner.close();
  }
});
