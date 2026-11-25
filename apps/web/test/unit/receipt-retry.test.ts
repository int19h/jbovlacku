import { before, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { LocalStore, OutboxItem } from "../../src/data/store.ts";
import type { Receipt, Transport } from "../../src/model/types.ts";

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

function signedProfile(seed = 9): Transport {
  return core.createEvent(
    new Uint8Array(32).fill(seed),
    [],
    "1".repeat(32),
    { kind: "identity.profile" },
    { name: "Receipt retry", bio: [], links: [] },
  );
}

function receiptFor(
  item: OutboxItem,
  envelopeHash = storedEnvelopeHash(item.transport),
): Receipt {
  const body = (JSON.parse(item.transport) as Transport).envelope.header
    .content;
  return {
    id: item.id,
    admission: "accepted",
    interpretation: "effective",
    body_status: body ? "present" : "none",
    body_hash: body?.hash ?? null,
    envelope_hash: envelopeHash,
    cursor: "x.1",
    snapshot: null,
    view: "jve1:" + "a".repeat(64),
    reasons: [],
  };
}

function fixture(t: TestContext, signed = signedProfile()) {
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: new EventTarget() },
    document: { configurable: true, value: new EventTarget() },
  });
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  const item = outboxItem(signed, "test", 0, {
    self: { origin: "http://peer.test", base: "/api/v1", label: "This server" },
  });
  const records = new Map([[item.id, item]]);
  const serverAccepted = new Set<string>();
  const requests: string[] = [];
  const sentIds: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, options?: RequestInit) => {
      if (options?.method === "POST") {
        const { envelope } = JSON.parse(options.body as string) as Transport;
        const row = records.get(envelope.id)!;
        assert.equal(options.body, row.transport);
        assert.ok(row.peers.self.sendAttempt);
        requests.push("post");
        sentIds.push(row.id);
        serverAccepted.add(row.id);
        return Response.json(receiptFor(row), { status: 201 });
      }
      requests.push("receipt");
      const id = decodeURIComponent(new URL(url).pathname.split("/").at(-1)!);
      return serverAccepted.has(id)
        ? Response.json(receiptFor(records.get(id)!))
        : Response.json({ error: "Not found" }, { status: 404 });
    },
  );
  const fail = {
    get: 0,
    list: 0,
    mark: 0,
    outcome: 0,
    refusal: 0,
    verification: 0,
  };
  let gets = 0;
  let lists = 0;
  const store = {
    async get(_store: string, id: string) {
      if (++gets === fail.get) throw quota();
      return records.get(id);
    },
    async list() {
      if (++lists === fail.list) throw quota();
      return [...records.values()];
    },
    async mergeOutbox(
      id: string,
      mutate: (snapshot: typeof item) => typeof item,
    ) {
      const next = mutate(records.get(id)!);
      const peer = next.peers.self;
      if (id === item.id && peer.state === "accepted" && fail.outcome > 0) {
        fail.outcome--;
        throw quota();
      }
      if (id === item.id && peer.state === "refused" && fail.refusal > 0) {
        fail.refusal--;
        throw quota();
      }
      if (id === item.id && peer.verifyReceipt && fail.verification > 0) {
        fail.verification--;
        throw quota();
      }
      if (peer.sendAttempt && fail.mark > 0) {
        fail.mark--;
        throw quota();
      }
      records.set(id, next);
      return next;
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
    sentIds,
    records,
    serverAccepted,
    fail,
    store,
    engine,
    advance,
    get saved() {
      return records.get(item.id)!;
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

test("a failed acceptance save retries the receipt of a refused record without a POST", async (t) => {
  const f = fixture(t);
  Object.assign(f.item.peers.self, {
    state: "refused",
    nextAttempt: null,
    failure: "refused",
    attempt: "older-refusal",
  });
  f.serverAccepted.add(f.item.id);
  f.fail.outcome = 1;
  await assert.rejects(f.engine.tryNow(f.item.id), {
    name: "QuotaExceededError",
  });
  assert.equal(f.saved.peers.self.state, "refused");
  assert.deepEqual(f.requests, ["receipt"]);
  await f.advance(14_999);
  assert.deepEqual(f.requests, ["receipt"]);
  await f.advance(1);
  assert.deepEqual(f.requests, ["receipt", "receipt"]);
  assert.equal(f.saved.peers.self.state, "accepted");
  assert.equal(f.saved.transport, f.item.transport);
});

for (const failSave of [true, false]) {
  test(`a failed envelope read retries verification ${failSave ? "after a failed receipt save" : "after reopening the engine"}`, async (t) => {
    const variants = JSON.parse(
      await readFile(
        new URL(
          "../../../../packages/service/test/fixtures/signature-variants.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as Transport[];
    const f = fixture(t, variants[1]);
    const bytes = core.canonicalize(
      core.utf8(JSON.stringify(variants[0].envelope)),
    );
    const receipt = receiptFor(f.item, core.contentHash(core.utf8(bytes)));
    assert.notEqual(
      receipt.envelope_hash,
      storedEnvelopeHash(f.item.transport),
    );
    const requests: string[] = [];
    let reads = 0;
    t.mock.method(
      globalThis,
      "fetch",
      async (url: string, options?: RequestInit) => {
        if (options?.method === "POST") {
          requests.push("post");
          assert.equal(options.body, f.item.transport);
          return Response.json(receipt, { status: 201 });
        }
        if (url.includes("/receipts/")) {
          requests.push("receipt");
          return Response.json(receipt);
        }
        requests.push("envelope");
        if (++reads === (failSave ? 2 : 1))
          throw new TypeError(
            "The connection to the envelope endpoint dropped.",
          );
        return new Response(bytes);
      },
    );
    if (failSave) {
      f.fail.outcome = 1;
      await assert.rejects(f.engine.tryNow(f.item.id), {
        name: "QuotaExceededError",
      });
      await f.advance(15_000);
      assert.deepEqual(requests, ["post", "envelope", "receipt", "envelope"]);
    } else {
      // Reuse only persisted state after the envelope read fails.
      const first = await new DeliveryEngine(
        f.store as unknown as LocalStore,
      ).tryNow(f.item.id);
      assert.equal(first?.peers.self.verifyReceipt, true);
      t.mock.timers.reset();
      t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 25_000 });
      await f.engine.tick();
    }
    if (failSave) await f.advance(15_000);
    assert.deepEqual(
      requests,
      failSave
        ? ["post", "envelope", "receipt", "envelope", "receipt", "envelope"]
        : ["post", "envelope", "receipt", "envelope"],
    );
    assert.equal(f.saved.peers.self.state, "accepted");
    assert.equal(f.saved.transport, f.item.transport);
  });
}

test("a missing receipt does not end pending envelope verification on a refused record", async (t) => {
  const variants = JSON.parse(
    await readFile(
      new URL(
        "../../../../packages/service/test/fixtures/signature-variants.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as Transport[];
  const f = fixture(t, variants[1]);
  Object.assign(f.item.peers.self, {
    state: "refused",
    nextAttempt: null,
    failure: "refused",
    attempt: "older-refusal",
  });
  const bytes = core.canonicalize(
    core.utf8(JSON.stringify(variants[0].envelope)),
  );
  const receipt = receiptFor(f.item, core.contentHash(core.utf8(bytes)));
  let lookups = 0;
  let envelopes = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, options?: RequestInit) => {
      assert.notEqual(options?.method, "POST");
      if (url.includes("/receipts/"))
        return ++lookups === 2
          ? Response.json({ message: "Not found" }, { status: 404 })
          : Response.json(receipt);
      if (++envelopes === 1) throw new TypeError("The envelope read failed.");
      return new Response(bytes);
    },
  );
  f.fail.verification = 1;
  await assert.rejects(f.engine.tryNow(f.item.id), {
    name: "QuotaExceededError",
  });
  await f.advance(15_000);
  assert.equal(lookups, 2);
  assert.equal(f.saved.peers.self.state, "refused");
  await f.advance(15_000);
  assert.equal(lookups, 3);
  assert.equal(envelopes, 2);
  assert.equal(f.saved.peers.self.state, "accepted");
  assert.equal(f.saved.transport, f.item.transport);
});

test("one record's repeated receipt write failure leaves independent records due", async (t) => {
  const f = fixture(t);
  const independent = outboxItem(
    signedProfile(10),
    "unrelated",
    0,
    f.item.recipients!,
  );
  const dependent = outboxItem(
    signedProfile(11),
    f.item.group,
    1,
    f.item.recipients!,
  );
  f.records.set(independent.id, independent);
  f.records.set(dependent.id, dependent);
  f.fail.outcome = 3;
  await f.engine.tick();
  assert.deepEqual(f.sentIds, [f.item.id, independent.id]);
  assert.equal(f.records.get(independent.id)?.peers.self.state, "accepted");
  for (let retry = 0; retry < 2; retry++) {
    const count = f.requests.length;
    await f.advance(14_999);
    assert.equal(f.requests.length, count);
    await f.advance(1);
    assert.equal(f.requests.at(-1), "receipt");
    assert.deepEqual(f.sentIds, [f.item.id, independent.id]);
  }
  await f.advance(15_000);
  assert.equal(f.saved.peers.self.state, "accepted");
  assert.equal(f.saved.transport, f.item.transport);
  assert.deepEqual(f.sentIds, [f.item.id, independent.id, dependent.id]);
});

test("an unrepresentable Retry-After falls back to a finite receipt retry", async (t) => {
  const f = fixture(t);
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string, options?: RequestInit) => {
      f.requests.push(options?.method === "POST" ? "post" : "receipt");
      return options?.method === "POST"
        ? Response.json(
            { message: "Retry later" },
            {
              status: 503,
              headers: { "Retry-After": "9".repeat(309) },
            },
          )
        : Response.json(receiptFor(f.item));
    },
  );
  await f.engine.tick();
  assert.equal(f.saved.peers.self.nextAttempt, Date.now() + 15_000);
  await f.advance(15_000);
  assert.deepEqual(f.requests, ["post", "receipt"]);
  assert.equal(f.saved.peers.self.state, "accepted");
  assert.equal(f.saved.transport, f.item.transport);
});

test("a failed refusal save checks the receipt and preserves the refusal without another POST", async (t) => {
  const f = fixture(t);
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string, options?: RequestInit) => {
      const post = options?.method === "POST";
      f.requests.push(post ? "post" : "receipt");
      return Response.json(
        { message: post ? "Refused" : "Not found" },
        { status: post ? 422 : 404 },
      );
    },
  );
  f.fail.refusal = 1;
  await f.engine.tick();
  assert.ok(f.saved.peers.self.sendAttempt);
  await f.advance(15_000);
  assert.deepEqual(f.requests, ["post", "receipt"]);
  assert.equal(f.saved.peers.self.state, "refused");
  assert.equal(f.saved.peers.self.nextAttempt, null);
  await f.advance(60_000);
  assert.deepEqual(f.requests, ["post", "receipt"]);
  assert.equal(f.saved.transport, f.item.transport);
});

test("a progress listener cannot interrupt a send after the mark commits", async (t) => {
  const f = fixture(t);
  let received = false;
  f.engine.subscribe((items) => {
    if (items[0]?.peers.self.sendAttempt)
      throw new Error("Test listener failure.");
  });
  f.engine.subscribe((items) => {
    received ||= items[0]?.peers.self.state === "accepted";
  });
  await flush();
  await f.engine.tick();
  assert.deepEqual(f.requests, ["post"]);
  assert.ok(received);
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
