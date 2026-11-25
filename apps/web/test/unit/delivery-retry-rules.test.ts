import { before, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { base64url } from "jose";
import type {
  KeyBackup,
  LocalStore,
  OutboxItem,
  PeerDelivery,
} from "../../src/data/store.ts";
import type { Receipt, Transport } from "../../src/model/types.ts";
import type { Session } from "../../src/app/session.ts";

Object.defineProperties(globalThis, {
  location: { value: { origin: "http://peer.test", host: "peer.test" } },
  navigator: { value: { onLine: true } },
});

const core = await import("../../../../packages/core/src/index.ts");
const { DeliveryEngine, storedEnvelopeHash, UNCONFIRMED_TEXT } =
  await import("../../src/data/delivery.ts");
const { outboxItem } = await import("../../src/data/lifecycle.ts");
const { defaultPreferences } = await import("../../src/data/store.ts");
const { Signer } = await import("../../src/app/actions.ts");
const { OwnState } = await import("../../src/app/context.ts");

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
  for (let i = 0; i < 6; i++)
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
const variantHash = () =>
  core.contentHash(
    core.utf8(
      core.canonicalize(core.utf8(JSON.stringify(variants[0].envelope))),
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

const json = (status: number, value: unknown, retryAfter?: string) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      ...(retryAfter ? { "retry-after": retryAfter } : {}),
    },
  });

type Kind = "post" | "receipt" | "envelope";

/**
 * One record with the given recipients. `handler` answers each request by
 * recipient origin. `failWrite` sees the current and the next row and
 * returns true to fail that outbox write with a quota error.
 */
function fixture(
  t: TestContext,
  peerIds: string[],
  handler: (peer: string, kind: Kind) => Response | Promise<Response>,
) {
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: new EventTarget() },
    document: { configurable: true, value: new EventTarget() },
  });
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  const item = outboxItem(
    variants[1],
    "retry-rules",
    0,
    Object.fromEntries(
      peerIds.map((id) => [
        id,
        { origin: `http://${id}.test`, base: "/api/v1", label: id },
      ]),
    ),
  );
  const records = new Map([[item.id, item]]);
  const log: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, options?: RequestInit) => {
      const peer = new URL(url).hostname.replace(/\.test$/, "");
      const kind: Kind =
        options?.method === "POST"
          ? "post"
          : url.includes("/receipts/")
            ? "receipt"
            : "envelope";
      if (kind === "post")
        assert.equal(options!.body, records.get(item.id)!.transport);
      log.push(`${Date.now() - 10_000}:${peer}:${kind}`);
      return handler(peer, kind);
    },
  );
  const control = {
    failWrite: (_current: OutboxItem, _next: OutboxItem): boolean => false,
  };
  const store = {
    async get(_store: string, id: string) {
      return records.get(id);
    },
    async list() {
      return [...records.values()];
    },
    async mergeOutbox(id: string, mutate: (s: OutboxItem) => OutboxItem) {
      const current = records.get(id)!;
      const next = mutate(current);
      if (control.failWrite(current, next)) throw quota();
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
    peer(id = "self"): PeerDelivery {
      return records.get(item.id)!.peers[id];
    },
  };
}

const refused = {
  code: "refused",
  message: "Refused",
  event: null,
  field: null,
};
const notFound = { message: "Not found" };

for (const action of ["Stop and Resume", "Try now"] as const) {
  test(`${action} sends again after an unsaved refusal`, async (t) => {
    let ready = false;
    let accepted = false;
    const f = fixture(t, ["self"], (_peer, kind) => {
      if (kind === "post") {
        if (!ready) return json(422, refused);
        accepted = true;
        return Response.json(receiptFor(f.item), { status: 201 });
      }
      return accepted ? Response.json(receiptFor(f.item)) : json(404, notFound);
    });
    let failures = 1;
    f.control.failWrite = (_current, next) =>
      next.peers.self.state === "refused" && failures-- > 0;
    await assert.rejects(f.engine.tryNow(f.item.id), {
      name: "QuotaExceededError",
    });
    ready = true;
    if (action === "Try now") await f.engine.tryNow(f.item.id);
    else {
      await f.engine.stop(f.item.id);
      await f.engine.resume(f.item.id);
    }
    assert.deepEqual(f.log, ["0:self:post", "0:self:receipt", "0:self:post"]);
    assert.equal(f.peer().state, "accepted");
    assert.equal(f.row.transport, f.item.transport);
  });
}

test("Resume keeps an unsaved acceptance and sends nothing again", async (t) => {
  const f = fixture(t, ["self"], (_peer, kind) =>
    kind === "post"
      ? Response.json(receiptFor(f.item), { status: 201 })
      : Response.json(receiptFor(f.item)),
  );
  let failures = 1;
  f.control.failWrite = (_current, next) =>
    next.peers.self.state === "accepted" && failures-- > 0;
  await assert.rejects(f.engine.tryNow(f.item.id), {
    name: "QuotaExceededError",
  });
  await f.engine.stop(f.item.id);
  await f.engine.resume(f.item.id);
  assert.deepEqual(f.log, ["0:self:post", "0:self:receipt"]);
  assert.equal(f.peer().state, "accepted");
});

for (const failSave of [false, true]) {
  test(`a Retry-After on an envelope read delays the next check (${failSave ? "unsaved" : "saved"} verification)`, async (t) => {
    const f = fixture(t, ["self"], (_peer, kind) =>
      kind === "envelope"
        ? json(429, { code: "rate_limited", message: "Slow down" }, "600")
        : Response.json(receiptFor(f.item, { envelope_hash: variantHash() }), {
            status: kind === "post" ? 201 : 200,
          }),
    );
    if (failSave)
      f.control.failWrite = (_current, next) =>
        next.peers.self.verifyReceipt === true;
    await f.engine.tick();
    assert.equal(f.engine.nextTryAt(f.row, "self"), 610_000);
    for (let i = 0; i < 39; i++) await f.advance(15_000);
    assert.deepEqual(f.log, ["0:self:post", "0:self:envelope"]);
    await f.advance(15_000);
    assert.deepEqual(f.log, [
      "0:self:post",
      "0:self:envelope",
      "600000:self:receipt",
      "600000:self:envelope",
    ]);
    // The second 429 keeps the wait, also on the open verification path.
    assert.equal(f.engine.nextTryAt(f.row, "self"), 1_210_000);
  });
}

test("one recipient's error does not shorten another recipient's Retry-After", async (t) => {
  let limited = false;
  const f = fixture(t, ["peer1", "peer2"], (peer, kind) => {
    if (peer === "peer1") return json(503, { message: "Busy" });
    if (kind === "post")
      return Response.json(receiptFor(f.item), { status: 201 });
    return limited
      ? json(429, { code: "rate_limited", message: "Wait" }, "600")
      : Response.json(receiptFor(f.item));
  });
  let failPeer2 = 1;
  let failPeer1 = false;
  f.control.failWrite = (current, next) => {
    if (
      next.peers.peer2.state === "accepted" &&
      current.peers.peer2.state !== "accepted" &&
      failPeer2 > 0
    ) {
      failPeer2--;
      return true;
    }
    return (
      failPeer1 &&
      next.peers.peer1 !== current.peers.peer1 &&
      !next.peers.peer1.sendAttempt
    );
  };
  await f.engine.tick();
  limited = true;
  failPeer1 = true;
  await f.advance(15_000);
  const peer2 = () => f.log.filter((entry) => entry.includes(":peer2:"));
  assert.deepEqual(peer2(), ["0:peer2:post", "15000:peer2:receipt"]);
  assert.equal(f.engine.nextTryAt(f.row, "peer2"), 625_000);
  for (let i = 0; i < 39; i++) await f.advance(15_000);
  assert.deepEqual(peer2(), ["0:peer2:post", "15000:peer2:receipt"]);
  // peer1 keeps its own shorter retry.
  assert.ok(f.log.filter((entry) => entry.includes(":peer1:")).length > 4);
  await f.advance(14_999);
  assert.deepEqual(peer2(), ["0:peer2:post", "15000:peer2:receipt"]);
  await f.advance(1);
  assert.deepEqual(peer2(), [
    "0:peer2:post",
    "15000:peer2:receipt",
    "615000:peer2:receipt",
  ]);
});

test("an unconfirmed outcome replaces a stale stored state in page text", async (t) => {
  const f = fixture(t, ["self"], (_peer, kind) => {
    assert.equal(kind, "receipt");
    return Response.json(receiptFor(f.item));
  });
  Object.assign(f.item.peers.self, {
    state: "missing-body",
    attempts: 1,
    error:
      "The server stored the signed header without its body. The complete record will be sent again.",
    attempt: "a0",
  });
  let failures = 1;
  f.control.failWrite = (_current, next) =>
    next.peers.self.state === "accepted" && failures-- > 0;
  await assert.rejects(f.engine.tryNow(f.item.id), {
    name: "QuotaExceededError",
  });
  assert.equal(f.peer().state, "missing-body");
  assert.equal(f.engine.describe(f.row, "self"), UNCONFIRMED_TEXT);
});

test("Signer.publish returns the saved record after a failed outcome save", async (t) => {
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: new EventTarget() },
    document: { configurable: true, value: new EventTarget() },
  });
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const seed = base64url.decode(jwk.d!);
  const identity = core.identityFromSeed(seed);
  const genesis = core.createEvent(
    seed,
    [],
    "0".repeat(32),
    { kind: "identity.profile" },
    { name: "Initial", bio: [], links: [] },
  );
  const outbox = new Map<string, OutboxItem>();
  const heads = new Map<string, string[]>([[identity, [genesis.envelope.id]]]);
  let failAccept = 1;
  const store = {
    async get(table: string, id: string) {
      if (table === "outbox") return outbox.get(id);
      if (table === "heads") return heads.get(id);
      return undefined;
    },
    async list(table: string) {
      if (table === "outbox") return [...outbox.values()];
      if (table === "ownhistory") return [genesis.envelope];
      return [];
    },
    async queueGroup(signed: OutboxItem[]) {
      for (const row of signed) outbox.set(row.id, row);
      heads.set(identity, [signed.at(-1)!.id]);
    },
    async mergeOutbox(id: string, mutate: (s: OutboxItem) => OutboxItem) {
      const next = mutate(outbox.get(id)!);
      if (next.peers.self.state === "accepted" && failAccept-- > 0)
        throw quota();
      outbox.set(id, next);
      return next;
    },
    async discardOutbox() {},
  };
  let posts = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string, options?: RequestInit) => {
      assert.equal(options?.method, "POST");
      posts++;
      const parsed = JSON.parse(options!.body as string) as Transport;
      return Response.json(receiptFor(outbox.get(parsed.envelope.id)!), {
        status: 201,
      });
    },
  );
  const backup: KeyBackup = {
    format: "jbovlacku-key-backup",
    version: 1,
    identity,
    jwe: "",
  };
  const session = {
    store,
    storageAvailable: true,
    backup,
    identity,
    workingKey: pair.privateKey,
    preferences: defaultPreferences,
    subscribe() {
      return () => {};
    },
    async signingDisabled() {
      return null;
    },
    touch() {},
  } as unknown as Session;
  const delivery = new DeliveryEngine(store as unknown as LocalStore);
  const own = new OwnState(store as unknown as LocalStore, session, () => true);
  const signer = new Signer(session, delivery, () => true);
  const target = "jve1:" + "b".repeat(64);
  assert.equal((await own.registers())?.judgments.get(target), undefined);
  const results = await signer.publish([
    { action: { kind: "judgment.set", target, value: "bless" }, body: null },
  ]);
  own.invalidate();
  assert.equal(results.length, 1);
  assert.equal(outbox.size, 1);
  assert.equal(results[0].transport, outbox.get(results[0].id)!.transport);
  assert.notEqual(results[0].peers.self.state, "accepted");
  const judgment = (await own.registers())?.judgments.get(target);
  assert.equal(
    judgment && "value" in judgment ? judgment.value : undefined,
    "bless",
  );
  assert.equal(posts, 1);
});
