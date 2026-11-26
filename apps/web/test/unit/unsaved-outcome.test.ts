import { before, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type {
  LocalStore,
  OutboxItem,
  PeerDelivery,
} from "../../src/data/store.ts";
import type { Receipt, Transport } from "../../src/model/types.ts";

Object.defineProperties(globalThis, {
  location: { value: { origin: "http://peer.test", host: "peer.test" } },
  navigator: { value: { onLine: true } },
});

const core = await import("../../../../packages/core/src/index.ts");
const { DeliveryEngine, storedEnvelopeHash, describePeer } =
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

const flush = async () => {
  for (let i = 0; i < 5; i++)
    await new Promise<void>((resolve) => setImmediate(resolve));
};
const quota = () =>
  new DOMException("Test storage quota.", "QuotaExceededError");
const variants = JSON.parse(
  await readFile(
    new URL(
      "../../../../packages/service/test/fixtures/signature-variants.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Transport[];
// The server keeps variants[0]. The browser stores variants[1].
const variantBytes = () =>
  core.canonicalize(core.utf8(JSON.stringify(variants[0].envelope)));
const variantHash = () => core.contentHash(core.utf8(variantBytes()));
// Valid envelope bytes of a different record.
const otherBytes = () =>
  core.canonicalize(
    core.utf8(
      JSON.stringify(
        core.createEvent(
          new Uint8Array(32).fill(3),
          [],
          "1".repeat(32),
          { kind: "identity.profile" },
          { name: "Other", bio: [], links: [] },
        ).envelope,
      ),
    ),
  );

function receiptFor(item: OutboxItem, over: Partial<Receipt> = {}): Receipt {
  const body = (JSON.parse(item.transport) as Transport).envelope.header
    .content;
  return {
    id: item.id,
    admission: "accepted",
    interpretation: "effective",
    body_status: body ? "present" : "none",
    body_hash: body?.hash ?? null,
    envelope_hash: storedEnvelopeHash(item.transport),
    cursor: "x.1",
    snapshot: null,
    view: "jve1:" + "a".repeat(64),
    reasons: [],
    ...over,
  } as Receipt;
}

type Kind = "post" | "receipt" | "envelope";

/**
 * One stored record for the peer "self". The handler answers each request.
 * `failWrite` decides which outbox writes fail with a quota error. The log
 * holds "milliseconds since start:request kind".
 */
function fixture(
  t: TestContext,
  handler: (kind: Kind) => Response | Promise<Response>,
  peer: Partial<PeerDelivery> = {},
) {
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: new EventTarget() },
    document: { configurable: true, value: new EventTarget() },
  });
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  const item = outboxItem(variants[1], "test", 0, {
    self: { origin: "http://peer.test", base: "/api/v1", label: "This server" },
  });
  Object.assign(item.peers.self, peer);
  const records = new Map([[item.id, item]]);
  const log: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, options?: RequestInit) => {
      const kind: Kind =
        options?.method === "POST"
          ? "post"
          : url.includes("/receipts/")
            ? "receipt"
            : "envelope";
      if (kind === "post") {
        // Every send carries the stored signed bytes and its own mark.
        assert.equal(options!.body, records.get(item.id)!.transport);
        assert.equal(records.get(item.id)!.transport, item.transport);
        assert.ok(records.get(item.id)!.peers.self.sendAttempt);
      }
      log.push(`${Date.now() - 10_000}:${kind}`);
      return handler(kind);
    },
  );
  const control = {
    failWrite: (_next: PeerDelivery): boolean => false,
  };
  const store = {
    async get(_store: string, id: string) {
      return records.get(id);
    },
    async list() {
      return [...records.values()];
    },
    async mergeOutbox(id: string, mutate: (s: OutboxItem) => OutboxItem) {
      const next = mutate(records.get(id)!);
      if (control.failWrite(next.peers.self)) throw quota();
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
    log,
    engine,
    advance,
    control,
    get row() {
      return records.get(item.id)!;
    },
    get peer() {
      return records.get(item.id)!.peers.self;
    },
  };
}

function busy(retryAfter?: string) {
  return new Response(
    JSON.stringify({ code: "busy", message: "Busy", event: null, field: null }),
    {
      status: 503,
      headers: {
        "content-type": "application/json",
        ...(retryAfter ? { "retry-after": retryAfter } : {}),
      },
    },
  );
}

test("a pending verification that finds a missing body sends the identical record again", async (t) => {
  let envelopes = 0;
  const f = fixture(t, (kind) => {
    if (kind === "envelope")
      return ++envelopes === 1
        ? Promise.reject(new TypeError("dropped"))
        : new Response(variantBytes());
    return Response.json(
      receiptFor(f.item, {
        envelope_hash: variantHash(),
        body_status: "missing",
        body_hash: null,
      }),
      { status: kind === "post" ? 201 : 200 },
    );
  });
  let failures = 1;
  f.control.failWrite = (next) => next.verifyReceipt === true && failures-- > 0;
  await assert.rejects(f.engine.tryNow(f.item.id), {
    name: "QuotaExceededError",
  });
  assert.deepEqual(f.log, ["0:post", "0:envelope"]);
  await f.advance(15_000);
  assert.deepEqual(f.log, [
    "0:post",
    "0:envelope",
    "15000:receipt",
    "15000:envelope",
    "15000:post",
    "15000:envelope",
  ]);
  assert.equal(f.peer.state, "missing-body");
  assert.equal(f.peer.verifyReceipt, undefined);
});

test("a pending verification that proves a mismatch saves it and sends the identical record again", async (t) => {
  let envelopes = 0;
  const f = fixture(t, (kind) => {
    if (kind === "envelope")
      return ++envelopes === 1
        ? Promise.reject(new TypeError("dropped"))
        : new Response(otherBytes());
    return Response.json(receiptFor(f.item, { envelope_hash: variantHash() }), {
      status: kind === "post" ? 201 : 200,
    });
  });
  let failures = 1;
  f.control.failWrite = (next) => next.verifyReceipt === true && failures-- > 0;
  await assert.rejects(f.engine.tryNow(f.item.id), {
    name: "QuotaExceededError",
  });
  await f.advance(15_000);
  assert.deepEqual(f.log, [
    "0:post",
    "0:envelope",
    "15000:receipt",
    "15000:envelope",
    "15000:post",
    "15000:envelope",
  ]);
  assert.equal(f.peer.state, "unknown");
  assert.equal(f.peer.verifyReceipt, undefined);
  assert.match(f.peer.error ?? "", /does not match the stored record/);
  assert.equal(f.engine.needsReceipt(f.row, "self"), false);
});

test("a failed outcome save keeps the Retry-After of the unsaved outcome", async (t) => {
  const f = fixture(t, (kind) =>
    kind === "receipt"
      ? Response.json({ message: "Not found" }, { status: 404 })
      : busy("600"),
  );
  // Fail the outcome writes. A send mark write carries its attempt ID.
  f.control.failWrite = (next) =>
    next.state !== "queued" && next.sendAttempt === undefined;
  await assert.rejects(f.engine.tryNow(f.item.id), {
    name: "QuotaExceededError",
  });
  assert.equal(f.engine.nextTryAt(f.row, "self"), Date.now() + 600_000);
  for (let i = 0; i < 39; i++) await f.advance(15_000);
  assert.deepEqual(f.log, ["0:post"]);
  await f.advance(15_000);
  assert.deepEqual(f.log, ["0:post", "600000:receipt", "600000:post"]);
});

test("a failed outcome save keeps the growing backoff of the unsaved outcome", async (t) => {
  const f = fixture(t, (kind) =>
    kind === "receipt"
      ? Response.json({ message: "Not found" }, { status: 404 })
      : busy(),
  );
  f.control.failWrite = (next) =>
    next.state !== "queued" && next.sendAttempt === undefined;
  await f.engine.tick();
  for (let i = 0; i < 8; i++) await f.advance(15_000);
  assert.deepEqual(
    f.log.filter((entry) => entry.endsWith(":post")),
    ["0:post", "15000:post", "45000:post", "105000:post"],
  );
});

test("a definite mismatch ends receipt verification and shows the mismatch", async (t) => {
  let envelopes = 0;
  const f = fixture(t, (kind) => {
    if (kind === "envelope")
      return ++envelopes === 1
        ? Promise.reject(new TypeError("dropped"))
        : new Response(otherBytes());
    return Response.json(receiptFor(f.item, { envelope_hash: variantHash() }), {
      status: kind === "post" ? 201 : 200,
    });
  });
  await f.engine.tryNow(f.item.id);
  assert.equal(f.peer.verifyReceipt, true);
  assert.match(describePeer(f.peer), /verification is pending/);
  await f.engine.tryNow(f.item.id);
  assert.equal(f.peer.state, "unknown");
  assert.equal(f.peer.verifyReceipt, undefined);
  const text = describePeer(f.peer);
  assert.match(text, /does not match the stored record/);
  assert.doesNotMatch(text, /verification is pending/);
});

test("a receipt for another envelope permits the identical retry of a possibly sent record", async (t) => {
  const f = fixture(
    t,
    (kind) => {
      if (kind === "receipt")
        return Response.json(
          receiptFor(f.item, { envelope_hash: "sha256:" + "0".repeat(64) }),
        );
      if (kind === "post")
        return Response.json(receiptFor(f.item), { status: 201 });
      return new Response(variantBytes());
    },
    {
      state: "unknown",
      attempts: 1,
      failure: "timeout",
      sendAttempt: "a0",
      sendStarted: 1,
      attempt: "a0",
    },
  );
  await f.engine.tryNow(f.item.id);
  assert.deepEqual(f.log, ["0:receipt", "0:envelope", "0:post"]);
  assert.equal(f.peer.state, "accepted");
});

test("a refused record keeps a timer when its lookup and the unknown outcome save both fail", async (t) => {
  const f = fixture(
    t,
    (kind) =>
      kind === "receipt"
        ? Promise.reject(new TypeError("dropped"))
        : Response.json(receiptFor(f.item), { status: 201 }),
    {
      state: "refused",
      nextAttempt: null,
      failure: "refused",
      attempt: "older",
    },
  );
  let failures = 1;
  f.control.failWrite = (next) => next.state === "unknown" && failures-- > 0;
  await assert.rejects(f.engine.tryNow(f.item.id), {
    name: "QuotaExceededError",
  });
  assert.equal(f.peer.state, "refused");
  assert.equal(f.engine.nextTryAt(f.row, "self"), Date.now() + 15_000);
  assert.equal(f.engine.needsReceipt(f.row, "self"), true);
  await f.advance(15_000);
  assert.deepEqual(f.log, ["0:receipt", "15000:receipt"]);
  assert.equal(f.peer.state, "unknown");
  assert.equal(f.peer.nextAttempt, Date.now() + 30_000);
  assert.equal(f.row.transport, f.item.transport);
});

test("a kept refusal stays when the later receipt names another envelope", async (t) => {
  const f = fixture(t, (kind) => {
    if (kind === "post")
      return Response.json(
        { code: "refused", message: "Refused", event: null, field: null },
        { status: 422 },
      );
    if (kind === "receipt")
      return Response.json(
        receiptFor(f.item, { envelope_hash: "sha256:" + "0".repeat(64) }),
      );
    return new Response(variantBytes());
  });
  let failures = 1;
  f.control.failWrite = (next) => next.state === "refused" && failures-- > 0;
  await assert.rejects(f.engine.tryNow(f.item.id), {
    name: "QuotaExceededError",
  });
  await f.advance(15_000);
  assert.deepEqual(f.log, ["0:post", "15000:receipt", "15000:envelope"]);
  assert.equal(f.peer.state, "refused");
  assert.equal(f.peer.nextAttempt, null);
  // A refusal pauses automatic sends.
  await f.advance(120_000);
  assert.deepEqual(f.log, ["0:post", "15000:receipt", "15000:envelope"]);
  assert.equal(f.row.transport, f.item.transport);
});

test("a kept acceptance is saved when the later lookup finds no receipt", async (t) => {
  const f = fixture(t, (kind) =>
    kind === "post"
      ? Response.json(receiptFor(f.item), { status: 201 })
      : Response.json({ message: "Not found" }, { status: 404 }),
  );
  let failures = 1;
  f.control.failWrite = (next) => next.state === "accepted" && failures-- > 0;
  await assert.rejects(f.engine.tryNow(f.item.id), {
    name: "QuotaExceededError",
  });
  await f.advance(15_000);
  assert.deepEqual(f.log, ["0:post", "15000:receipt"]);
  assert.equal(f.peer.state, "accepted");
  assert.equal(f.peer.receipt?.id, f.item.id);
  await f.advance(120_000);
  assert.deepEqual(f.log, ["0:post", "15000:receipt"]);
});
