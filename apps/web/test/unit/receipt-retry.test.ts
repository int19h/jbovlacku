import { before, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { LocalStore } from "../../src/data/store.ts";
import type { Receipt } from "../../src/model/types.ts";

Object.defineProperties(globalThis, {
  location: { value: { origin: "http://peer.test", host: "peer.test" } },
  navigator: { value: { onLine: true } },
});

const core = await import("../../../../packages/core/src/index.ts");
const { DeliveryEngine, storedEnvelopeHash } =
  await import("../../src/data/delivery.ts");
const { outboxItem } = await import("../../src/data/lifecycle.ts");

before(async () =>
  core.initializeCore(
    await readFile(
      new URL(
        "../../../../packages/core/generated/jvc_runtime_bg.wasm",
        import.meta.url,
      ),
    ),
  ),
);

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const quota = () =>
  new DOMException("Test storage quota.", "QuotaExceededError");

function fixture(t: TestContext) {
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: new EventTarget() },
    document: { configurable: true, value: new EventTarget() },
  });
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  const signed = core.createEvent(
    new Uint8Array(32).fill(9),
    [],
    "1".repeat(32),
    { kind: "identity.profile" },
    { name: "Receipt retry", bio: [], links: [] },
  );
  const item = outboxItem(signed, "test", 0, {
    self: { origin: "http://peer.test", base: "/api/v1", label: "This server" },
  });
  let stored = item;
  let serverAccepted = false;
  const receipt: Receipt = {
    id: item.id,
    admission: "accepted",
    interpretation: "effective",
    body_status: "present",
    body_hash: signed.envelope.header.content!.hash,
    envelope_hash: storedEnvelopeHash(item.transport),
    cursor: "x.1",
    snapshot: null,
    view: "jve1:" + "a".repeat(64),
    reasons: [],
  };
  const requests: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: RequestInfo | URL, options?: RequestInit) => {
      if (options?.method === "POST") {
        assert.equal(options.body, item.transport);
        assert.ok(stored.peers.self.sendAttempt);
        requests.push("post");
        serverAccepted = true;
        return Response.json(receipt, { status: 201 });
      }
      requests.push("receipt");
      return serverAccepted
        ? Response.json(receipt)
        : Response.json({ error: "Not found" }, { status: 404 });
    },
  );
  const fail = { get: 0, list: 0, mark: 0, outcome: 0 };
  let gets = 0;
  let lists = 0;
  const store = {
    async get() {
      if (++gets === fail.get) throw quota();
      return stored;
    },
    async list() {
      if (++lists === fail.list) throw quota();
      return [stored];
    },
    async mergeOutbox(
      _id: string,
      mutate: (snapshot: typeof item) => typeof item,
    ) {
      const next = mutate(stored);
      const peer = next.peers.self;
      if (peer.state === "accepted" && fail.outcome > 0) {
        fail.outcome--;
        throw quota();
      }
      if (peer.sendAttempt && fail.mark > 0) {
        fail.mark--;
        throw quota();
      }
      stored = next;
      return stored;
    },
    async discardOutbox() {},
  };
  const engine = new DeliveryEngine(store as unknown as LocalStore);
  const advance = async (ms: number) => {
    await flush();
    t.mock.timers.tick(ms);
    await flush();
  };
  return {
    item,
    requests,
    fail,
    store,
    engine,
    advance,
    get saved() {
      return stored;
    },
  };
}

test("automatic delivery retries a failed receipt write with its send mark", async (t) => {
  const f = fixture(t);
  f.fail.outcome = 2;
  await f.engine.tick().catch(() => {});
  const sent = f.saved.peers.self;
  assert.ok(sent.sendAttempt);
  assert.equal(sent.sendStarted, Date.now());
  assert.deepEqual(f.requests, ["post"]);

  await f.advance(14_999);
  assert.deepEqual(f.requests, ["post"]);
  await f.advance(1);
  assert.deepEqual(f.requests, ["post", "receipt"]);
  assert.deepEqual(f.saved.peers.self, sent);
  await f.advance(15_000);
  assert.deepEqual(f.requests, ["post", "receipt", "receipt"]);
  assert.equal(f.saved.peers.self.state, "accepted");
  assert.equal(f.saved.transport, f.item.transport);
});

test("a direct delivery failure rejects to the caller and still retries", async (t) => {
  const f = fixture(t);
  f.fail.outcome = 1;
  await assert.rejects(f.engine.deliver(f.item.id, true), {
    name: "QuotaExceededError",
  });
  await f.advance(15_000);
  assert.deepEqual(f.requests, ["post", "receipt"]);
  assert.equal(f.saved.peers.self.state, "accepted");
});

for (const source of ["tick", "schedule", "dependencies"] as const) {
  test(`delivery recovers after the ${source} list read fails`, async (t) => {
    const f = fixture(t);
    if (source === "schedule")
      f.item.peers.self.nextAttempt = Date.now() + 1000;
    f.fail.list = source === "tick" ? 1 : 2;
    await f.engine.tick().catch(() => {});
    assert.deepEqual(f.requests, []);
    await f.advance(15_000);
    assert.deepEqual(f.requests, ["post"]);
    assert.equal(f.saved.peers.self.state, "accepted");
  });
}

for (const [read, source] of [
  [1, "initial"],
  [2, "after dependencies"],
  [3, "before the peer"],
  [4, "final"],
] as const) {
  test(`delivery recovers after the ${source} record read fails`, async (t) => {
    const f = fixture(t);
    f.fail.get = read;
    await f.engine.deliver(f.item.id, true).catch(() => {});
    await f.advance(15_000);
    assert.deepEqual(f.requests, ["post"]);
    assert.equal(f.saved.peers.self.state, "accepted");
  });
}

test("a failed mark write sends nothing until a later attempt commits a mark", async (t) => {
  const f = fixture(t);
  f.fail.mark = 1;
  await f.engine.tick();
  assert.deepEqual(f.requests, []);
  assert.equal(f.saved.peers.self.state, "unknown");
  await f.advance(15_000);
  assert.deepEqual(f.requests, ["receipt", "post"]);
  assert.equal(f.saved.peers.self.state, "accepted");
});

test("an older schedule read cannot remove the retry timer for a failed write", async (t) => {
  const f = fixture(t);
  const list = f.store.list;
  let reads = 0;
  let finish!: () => void;
  f.store.list = async () => {
    if (++reads === 2) {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return [];
    }
    return list();
  };
  f.item.peers.self.nextAttempt = Date.now() + 1000;
  await f.engine.tick();
  f.item.peers.self.nextAttempt = Date.now();
  f.fail.outcome = 1;
  await f.engine.deliver(f.item.id, true).catch(() => {});
  finish();
  await f.advance(15_000);
  assert.deepEqual(f.requests, ["post", "receipt"]);
  assert.equal(f.saved.peers.self.state, "accepted");
});

for (const action of ["invalidate", "discard", "resume"] as const) {
  test(`${action} keeps delivery active after a listener throws`, async (t) => {
    const f = fixture(t);
    if (action === "resume") f.item.stopped = true;
    let failNotice = false;
    f.engine.subscribe(() => {
      if (!failNotice) return;
      failNotice = false;
      throw new Error("Test listener failure.");
    });
    await flush();
    failNotice = true;
    await assert.rejects(f.engine[action](f.item.id), /Test listener failure/);
    await f.advance(250);
    assert.deepEqual(f.requests, ["post"]);
    assert.equal(f.saved.peers.self.state, "accepted");
  });
}
