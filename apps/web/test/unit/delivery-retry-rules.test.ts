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
    failRead: (): boolean => false,
  };
  const store = {
    async get(_store: string, id: string) {
      if (control.failRead()) throw quota();
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

/** The browser reports offline while the server stays reachable. */
function setOnline(t: TestContext, online: boolean) {
  const nav = globalThis.navigator as { onLine: boolean };
  nav.onLine = online;
  t.after(() => {
    nav.onLine = true;
  });
}

for (const action of ["Try now", "Stop and Resume"] as const) {
  for (const lookup of ["refused", "error"] as const) {
    test(`${action} after an unsaved refusal of a never sent record looks up the receipt first (${lookup} answer)`, async (t) => {
      let lookupError = false;
      const f = fixture(t, ["self"], (_peer, kind) => {
        if (kind === "post")
          return Response.json(receiptFor(f.item), { status: 201 });
        if (lookupError) return json(500, { message: "Server error" });
        return Response.json(
          receiptFor(f.item, { admission: "refused", reasons: ["test"] }),
        );
      });
      // A refused receipt while the browser reports offline. Its save fails.
      setOnline(t, false);
      let failures = 1;
      f.control.failWrite = (_current, next) =>
        next.peers.self.state === "refused" && failures-- > 0;
      await assert.rejects(f.engine.tryNow(f.item.id), {
        name: "QuotaExceededError",
      });
      assert.equal(f.peer().state, "queued");
      assert.equal(f.peer().sendStarted, undefined);
      setOnline(t, true);
      lookupError = lookup === "error";
      const explicit = async () => {
        if (action === "Try now") await f.engine.tryNow(f.item.id);
        else {
          await f.engine.stop(f.item.id);
          await f.engine.resume(f.item.id);
        }
      };
      await explicit();
      assert.deepEqual(f.log, ["0:self:receipt", "0:self:receipt"]);
      if (lookup === "refused") {
        assert.equal(f.peer().state, "refused");
        return;
      }
      // The error answer is not a server answer about the record. The
      // saved outcome keeps the receipt lookup for the next attempt.
      assert.equal(f.peer().state, "unknown");
      lookupError = false;
      await explicit();
      assert.deepEqual(f.log, [
        "0:self:receipt",
        "0:self:receipt",
        "0:self:receipt",
      ]);
      assert.equal(f.peer().state, "refused");
    });
  }
}

/** Valid envelope bytes of a different record, and their hash. */
function otherEnvelope() {
  const bytes = core.canonicalize(
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
  return { bytes, hash: core.contentHash(core.utf8(bytes)) };
}

for (const stop of ["an offline lookup", "a failed record read"] as const) {
  test(`Try now that ends with ${stop} keeps an unsaved refusal`, async (t) => {
    let offline = false;
    const f = fixture(t, ["self"], (_peer, kind) => {
      if (kind === "post") return json(409, refused);
      if (offline) return Promise.reject(new TypeError("offline"));
      return json(404, notFound);
    });
    let failures = 1;
    f.control.failWrite = (_current, next) =>
      next.peers.self.state === "refused" && failures-- > 0;
    await assert.rejects(f.engine.tryNow(f.item.id), {
      name: "QuotaExceededError",
    });
    assert.ok(f.peer().sendAttempt);
    if (stop === "an offline lookup") {
      // The lookup fails while the browser reports offline, so the attempt
      // decides nothing.
      setOnline(t, false);
      offline = true;
      await f.engine.tryNow(f.item.id);
      setOnline(t, true);
      offline = false;
    } else {
      let reads = 1;
      f.control.failRead = () => reads-- > 0;
      await assert.rejects(f.engine.tryNow(f.item.id), {
        name: "QuotaExceededError",
      });
    }
    (globalThis.window as EventTarget).dispatchEvent(new Event("online"));
    for (let i = 0; i < 8; i++) await f.advance(15_000);
    // The kept refusal pauses sends. Its lookup only saves the refusal.
    assert.deepEqual(
      f.log.filter((entry) => entry.endsWith(":post")),
      ["0:self:post"],
    );
    assert.equal(f.peer().state, "refused");
  });
}

test("a kept outcome that ended verification decides over a stale stored flag", async (t) => {
  const other = otherEnvelope();
  let found = true;
  const f = fixture(t, ["self"], (_peer, kind) => {
    if (kind === "envelope") return new Response(other.bytes);
    if (!found)
      return kind === "post"
        ? Response.json(receiptFor(f.item), { status: 201 })
        : json(404, notFound);
    return Response.json(receiptFor(f.item, { envelope_hash: other.hash }), {
      status: kind === "post" ? 201 : 200,
    });
  });
  Object.assign(f.item.peers.self, {
    state: "unknown",
    attempts: 1,
    verifyReceipt: true,
    sendAttempt: "a0",
    sendStarted: 1,
    attempt: "a0",
  });
  // The proved mismatch ends verification. Its save fails once.
  let failures = 1;
  f.control.failWrite = (_current, next) =>
    next.peers.self.sendAttempt === undefined && failures-- > 0;
  await assert.rejects(f.engine.tryNow(f.item.id), {
    name: "QuotaExceededError",
  });
  assert.deepEqual(f.log, [
    "0:self:receipt",
    "0:self:envelope",
    "0:self:post",
    "0:self:envelope",
  ]);
  // The send mark does not carry the ended verification.
  assert.equal(f.peer().verifyReceipt, undefined);
  // A 404 now permits the identical retry, as after a working save.
  found = false;
  await f.engine.tryNow(f.item.id);
  assert.deepEqual(f.log.slice(4), ["0:self:receipt", "0:self:post"]);
  assert.equal(f.peer().state, "accepted");
  assert.equal(f.row.transport, f.item.transport);
});

for (const predecessor of ["accepted", "busy"] as const) {
  test(`a dependent ${predecessor === "accepted" ? "goes ahead of a predecessor with a kept acceptance" : "waits for a predecessor whose outcome save failed"}`, async (t) => {
    Object.defineProperties(globalThis, {
      window: { configurable: true, value: new EventTarget() },
      document: { configurable: true, value: new EventTarget() },
    });
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
    const recipients = {
      self: { origin: "http://self.test", base: "/api/v1", label: "self" },
    };
    const profile = (seed: number) =>
      core.createEvent(
        new Uint8Array(32).fill(seed),
        [],
        "1".repeat(32),
        { kind: "identity.profile" },
        { name: `Record ${seed}`, bio: [], links: [] },
      );
    const x = outboxItem(profile(21), "chain", 0, recipients);
    const y = outboxItem(profile(22), "chain", 1, recipients);
    const records = new Map([
      [x.id, x],
      [y.id, y],
    ]);
    const name = (id: string) => (id === x.id ? "X" : "Y");
    const log: string[] = [];
    t.mock.method(
      globalThis,
      "fetch",
      async (url: string, options?: RequestInit) => {
        if (options?.method === "POST") {
          const id = (JSON.parse(options.body as string) as Transport).envelope
            .id;
          assert.equal(options.body, records.get(id)!.transport);
          log.push(`${Date.now() - 10_000}:${name(id)}:post`);
          return id === x.id && predecessor === "busy"
            ? json(503, { message: "Busy" })
            : Response.json(receiptFor(records.get(id)!), { status: 201 });
        }
        const id = decodeURIComponent(new URL(url).pathname.split("/").at(-1)!);
        log.push(`${Date.now() - 10_000}:${name(id)}:receipt`);
        return id === x.id
          ? json(503, { message: "Busy" })
          : Response.json(receiptFor(records.get(id)!));
      },
    );
    let failures = 1;
    const store = {
      async get(_store: string, id: string) {
        return records.get(id);
      },
      async list() {
        return [...records.values()];
      },
      async mergeOutbox(id: string, mutate: (s: OutboxItem) => OutboxItem) {
        const next = mutate(records.get(id)!);
        if (
          id === x.id &&
          next.peers.self.state ===
            (predecessor === "accepted" ? "accepted" : "unknown") &&
          next.peers.self.sendAttempt === undefined &&
          failures-- > 0
        )
          throw quota();
        records.set(id, next);
        return next;
      },
      async discardOutbox() {},
    };
    const engine = new DeliveryEngine(store as unknown as LocalStore);
    await engine.tick();
    if (predecessor === "busy") {
      // The failed save delays the predecessor, and its dependent waits.
      assert.deepEqual(log, ["0:X:post"]);
      assert.equal(records.get(y.id)!.peers.self.state, "queued");
      return;
    }
    for (let i = 0; i < 4; i++) {
      await flush();
      t.mock.timers.tick(15_000);
      await flush();
    }
    assert.ok(log.includes("0:X:post"));
    assert.equal(log.filter((entry) => entry.endsWith(":X:post")).length, 1);
    assert.equal(records.get(y.id)!.peers.self.state, "accepted");
    assert.equal(records.get(y.id)!.transport, y.transport);
  });
}

test("offline Resume makes a kept unknown outcome due at once", async (t) => {
  let ready = false;
  let offline = false;
  const f = fixture(t, ["self"], (_peer, kind) => {
    if (offline) return Promise.reject(new TypeError("offline"));
    if (kind === "receipt") return json(404, notFound);
    return ready
      ? Response.json(receiptFor(f.item), { status: 201 })
      : json(503, { message: "Busy" });
  });
  Object.assign(f.item.peers.self, {
    state: "unknown",
    attempts: 4,
    failure: "server",
    attempt: "a0",
  });
  let failures = 1;
  f.control.failWrite = (_current, next) =>
    next.peers.self.sendAttempt === undefined &&
    next.peers.self.state === "unknown" &&
    failures-- > 0;
  await assert.rejects(f.engine.tryNow(f.item.id), {
    name: "QuotaExceededError",
  });
  // The kept outcome waits 240 s after the fifth attempt.
  assert.equal(f.engine.nextTryAt(f.row, "self"), 250_000);
  await f.engine.stop(f.item.id);
  await f.advance(10_000);
  setOnline(t, false);
  offline = true;
  await f.engine.resume(f.item.id);
  await f.advance(1_000);
  setOnline(t, true);
  offline = false;
  ready = true;
  (globalThis.window as EventTarget).dispatchEvent(new Event("online"));
  await flush();
  await flush();
  assert.equal(f.peer().state, "accepted");
  assert.deepEqual(f.log.slice(-2), ["11000:self:receipt", "11000:self:post"]);
});

for (const action of ["Try now", "Stop and Resume"] as const) {
  test(`offline ${action} leaves a kept verification and its schedule unchanged`, async (t) => {
    let envelopes = 0;
    let offline = false;
    const f = fixture(t, ["self"], (_peer, kind) => {
      if (offline) return Promise.reject(new TypeError("offline"));
      if (kind === "envelope")
        return ++envelopes === 1
          ? Promise.reject(new TypeError("dropped"))
          : new Response(
              core.canonicalize(
                core.utf8(JSON.stringify(variants[0].envelope)),
              ),
            );
      return Response.json(
        receiptFor(f.item, { envelope_hash: variantHash() }),
        {
          status: kind === "post" ? 201 : 200,
        },
      );
    });
    let failures = 1;
    f.control.failWrite = (_current, next) =>
      next.peers.self.verifyReceipt === true && failures-- > 0;
    await assert.rejects(f.engine.tryNow(f.item.id), {
      name: "QuotaExceededError",
    });
    const due = f.engine.nextTryAt(f.row, "self");
    assert.equal(due, 25_000);
    setOnline(t, false);
    offline = true;
    if (action === "Try now") await f.engine.tryNow(f.item.id);
    else {
      await f.engine.stop(f.item.id);
      await f.engine.resume(f.item.id);
    }
    // Try now keeps the schedule. Resume makes the record due now, as it
    // does for a saved row.
    assert.equal(
      f.engine.nextTryAt(f.row, "self"),
      action === "Try now" ? 25_000 : Date.now(),
    );
    setOnline(t, true);
    offline = false;
    (globalThis.window as EventTarget).dispatchEvent(new Event("online"));
    await f.advance(15_000);
    assert.equal(f.peer().state, "accepted");
    assert.equal(f.log.filter((entry) => entry.endsWith(":post")).length, 1);
  });
}

test("a pending failure on one recipient does not delay another recipient", async (t) => {
  let envelopes = 0;
  let limited = false;
  const f = fixture(t, ["peer1", "peer2"], (peer, kind) => {
    if (peer === "peer1") {
      if (kind === "envelope")
        return ++envelopes === 1
          ? Promise.reject(new TypeError("dropped"))
          : new Response(
              core.canonicalize(
                core.utf8(JSON.stringify(variants[0].envelope)),
              ),
            );
      if (kind === "receipt" && limited)
        return json(429, { code: "rate_limited", message: "Wait" }, "600");
      return Response.json(
        receiptFor(f.item, { envelope_hash: variantHash() }),
        {
          status: kind === "post" ? 201 : 200,
        },
      );
    }
    if (kind === "receipt") return json(404, notFound);
    return limited
      ? Response.json(receiptFor(f.item), { status: 201 })
      : json(503, { message: "Busy" }, "20");
  });
  let failures = 1;
  f.control.failWrite = (_current, next) =>
    next.peers.peer1.verifyReceipt === true && failures-- > 0;
  await f.engine.tick();
  assert.equal(f.engine.nextTryAt(f.row, "peer2"), 30_000);
  limited = true;
  await f.advance(15_000);
  assert.ok(f.log.includes("15000:peer1:receipt"));
  assert.equal(f.engine.nextTryAt(f.row, "peer2"), 30_000);
  await f.advance(5_000);
  assert.equal(f.peer("peer2").state, "accepted");
  assert.ok(f.log.includes("20000:peer2:post"));
});

test("a stopped record with a kept outcome shows unconfirmed text", async (t) => {
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
  await f.engine.stop(f.item.id);
  assert.equal(f.row.stopped, true);
  // No automatic lookup runs while the record is stopped.
  assert.equal(f.engine.needsReceipt(f.row, "self"), false);
  const text = f.engine.describe(f.row, "self");
  assert.match(text, /unconfirmed/);
  assert.doesNotMatch(text, /will be sent again|check the receipt again/);
});
