import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createLifecycle } from "./lifecycle.mjs";
import { WorkerCDP } from "./worker-cdp.mjs";

const transport = () => {
  const root = new EventEmitter();
  root.calls = [];
  root.send = async (...args) => {
    root.calls.push(args);
  };
  return root;
};
const owner = () => createLifecycle({ setExitStatus() {}, forceExit() {} });

test("worker cancellation rejects acknowledged requests without a detach event", async () => {
  const root = transport(),
    lifecycle = owner();
  const worker = new WorkerCDP(root, "worker", { lifecycle });
  const original = Error("cancelled memory request");
  const request = worker.send("Runtime.getHeapUsage");
  const rejected = assert.rejects(request, (error) => error === original);
  await Promise.resolve();
  assert.equal(worker.pending.size, 1);
  lifecycle.cancel(original);
  await rejected;
  worker.rejectPending(Error("second cancellation"));
  assert.equal(worker.pending.size, 0);
  await assert.rejects(
    worker.send("Runtime.getHeapUsage"),
    (error) => error === original,
  );
  assert.equal(root.calls.length, 1);
  await lifecycle.shutdown();
});

test("browser disconnect independently rejects every pending worker request", async () => {
  const root = transport(),
    browser = new EventEmitter();
  const worker = new WorkerCDP(root, "worker", { browser });
  const memory = assert.rejects(
    worker.send("Runtime.getHeapUsage"),
    /Browser disconnected/,
  );
  const calibration = assert.rejects(
    worker.evaluate("new Promise(()=>{})"),
    /Browser disconnected/,
  );
  browser.emit("disconnected");
  browser.emit("disconnected");
  await Promise.all([memory, calibration]);
  assert.equal(worker.pending.size, 0);
});

test("output failure releases pending memory and calibration requests", async () => {
  const root = transport(),
    lifecycle = owner(),
    browser = new EventEmitter();
  const worker = new WorkerCDP(root, "worker", { lifecycle, browser });
  const original = Error("ENOSPC");
  const memory = assert.rejects(
    worker.send("Runtime.getHeapUsage"),
    (error) => error === original,
  );
  const calibration = assert.rejects(
    worker.evaluate("new Promise(()=>{})"),
    (error) => error === original,
  );
  lifecycle.fail(original);
  browser.emit("disconnected");
  await Promise.all([memory, calibration]);
  assert.equal(worker.pending.size, 0);
  assert.equal(lifecycle.exitStatus, 1);
  await lifecycle.shutdown();
});

for (const synchronous of [false, true])
  test(`worker transport ${synchronous ? "throw" : "rejection"} removes its pending entry`, async () => {
    const root = transport();
    root.send = () => {
      if (synchronous) throw Error("transport failure");
      return Promise.reject(Error("transport failure"));
    };
    const worker = new WorkerCDP(root, "worker");
    await assert.rejects(worker.send("Runtime.enable"), /transport failure/);
    assert.equal(worker.pending.size, 0);
  });

test("worker replies and target detach retain their existing behavior", async () => {
  const root = transport(),
    worker = new WorkerCDP(root, "worker");
  const result = worker.evaluate("42");
  root.emit("Target.receivedMessageFromTarget", {
    sessionId: "worker",
    message: JSON.stringify({ id: 1, result: { result: { value: 42 } } }),
  });
  assert.equal(await result, 42);
  const pending = assert.rejects(
    worker.send("Runtime.getHeapUsage"),
    /Worker target detached/,
  );
  root.emit("Target.detachedFromTarget", { sessionId: "other" });
  assert.equal(worker.pending.size, 1);
  root.emit("Target.detachedFromTarget", { sessionId: "worker" });
  await pending;
  assert.equal(worker.pending.size, 0);
});
