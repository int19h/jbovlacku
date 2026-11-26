// Delivery recovery after a failed local write. A failed outcome write stays
// in this tab as one immutable write and retries locally. Its recipient gets
// no new request until it commits or a newer saved row supersedes it.
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

const nav = { onLine: true };
Object.defineProperties(globalThis, {
  location: { value: { origin: "http://peer.test", host: "peer.test" } },
  navigator: { value: nav },
});

const core = await import("../../../../packages/core/src/index.ts");
const { DeliveryEngine, storedEnvelopeHash } =
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
  for (let i = 0; i < 20; i++)
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
const canonical = (envelope: unknown) =>
  core.canonicalize(core.utf8(JSON.stringify(envelope)));
const variantBytes = () => canonical(variants[0].envelope);
const variantHash = () => core.contentHash(core.utf8(variantBytes()));
const otherBytes = () =>
  canonical(
    core.createEvent(
      new Uint8Array(32).fill(3),
      [],
      "1".repeat(32),
      { kind: "identity.profile" },
      { name: "Other", bio: [], links: [] },
    ).envelope,
  );
const profile = (seed: number) =>
  core.createEvent(
    new Uint8Array(32).fill(seed),
    [],
    "1".repeat(32),
    { kind: "identity.profile" },
    { name: `Record ${seed}`, bio: [], links: [] },
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
const refusedBody = {
  code: "refused",
  message: "Refused",
  event: null,
  field: null,
};
const notFound = () => json(404, { message: "Not found" });

type Kind = "post" | "receipt" | "envelope";
type Request = { peer: string; kind: Kind; id: string; at: number };

/**
 * Records with saved recipients, a scripted server, and a scripted store.
 * The transport fails the test on a request for a recipient with a pending
 * local write, and on a POST without its own committed send mark.
 */
function harness(
  t: TestContext,
  options: { peers?: string[]; records?: OutboxItem[] } = {},
) {
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: new EventTarget() },
    document: { configurable: true, value: new EventTarget() },
  });
  nav.onLine = true;
  t.after(() => {
    nav.onLine = true;
  });
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  const peers = options.peers ?? ["self"];
  const recipients = Object.fromEntries(
    peers.map((id) => [
      id,
      { origin: `http://${id}.test`, base: "/api/v1", label: id },
    ]),
  );
  const item = outboxItem(variants[1], "main", 0, recipients);
  const records = new Map<string, OutboxItem>([[item.id, item]]);
  for (const extra of options.records ?? []) records.set(extra.id, extra);
  const requests: Request[] = [];
  const violations: string[] = [];
  const marks = new Set<string>();
  const control = {
    respond: (_request: Request): Response | Promise<Response> => notFound(),
    failWrite: (_id: string, _next: OutboxItem): boolean => false,
    failRead: (): boolean => false,
    failList: (): boolean => false,
    beforeMerge: async (_id: string): Promise<void> => {},
  };
  let engine!: InstanceType<typeof DeliveryEngine>;
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, options?: RequestInit) => {
      const parsed = new URL(url);
      const peer = parsed.hostname.replace(/\.test$/, "");
      const kind: Kind =
        options?.method === "POST"
          ? "post"
          : url.includes("/receipts/")
            ? "receipt"
            : "envelope";
      const id =
        kind === "post"
          ? (JSON.parse(options!.body as string) as Transport).envelope.id
          : decodeURIComponent(parsed.pathname.split("/").at(-1)!);
      const row = records.get(id);
      // The guard reads the harness's own record of failed outcome writes,
      // never the engine's page view.
      if (failedOutcomes.has(`${id}|${peer}`))
        violations.push(`${kind} to ${peer} with a pending write`);
      if (kind === "post") {
        assert.equal(options!.body, row!.transport);
        const mark = row!.peers[peer].sendAttempt;
        if (!mark || marks.has(mark))
          violations.push(`POST to ${peer} without its own mark`);
        if (mark) marks.add(mark);
      }
      const request = { peer, kind, id, at: Date.now() - 10_000 };
      requests.push(request);
      return control.respond(request);
    },
  );
  const writes: { id: string; next: OutboxItem; failed: boolean }[] = [];
  const failedOutcomes = new Map<string, string>();
  const store = {
    async get(_store: string, id: string) {
      if (control.failRead()) throw quota();
      return records.get(id);
    },
    async list() {
      if (control.failList()) throw quota();
      return [...records.values()];
    },
    async mergeOutbox(id: string, mutate: (s: OutboxItem) => OutboxItem) {
      await control.beforeMerge(id);
      const current = records.get(id);
      if (!current) return undefined;
      const next = mutate(current);
      const failed = control.failWrite(id, next);
      writes.push({ id, next, failed });
      for (const [peer, after] of Object.entries(next.peers)) {
        const before = current.peers[peer];
        if (JSON.stringify(before) === JSON.stringify(after)) continue;
        const mark =
          after.sendAttempt !== undefined &&
          after.sendAttempt !== before?.sendAttempt;
        if (mark) continue;
        const key = `${id}|${peer}`;
        if (failed && after.attempt) failedOutcomes.set(key, after.attempt);
        else if (!failed && failedOutcomes.get(key) === after.attempt)
          failedOutcomes.delete(key);
      }
      if (failed) throw quota();
      records.set(id, next);
      return next;
    },
    async discardOutbox(id: string) {
      const row = records.get(id)!;
      if (Object.values(row.peers).every((peer) => peer.state === "accepted"))
        throw new Error("This record was delivered to every recipient.");
      if (!row.stopped)
        throw new Error("Stop retrying before you discard this record.");
      records.delete(id);
    },
  };
  engine = new DeliveryEngine(store as unknown as LocalStore);
  const advance = async (ms: number) => {
    await flush();
    t.mock.timers.tick(ms);
    await flush();
  };
  /** Steps the clock in one-second turns, so each timer gets its turn. */
  const run = async (ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 1000)
      await advance(Math.min(1000, ms - elapsed));
  };
  return {
    item,
    records,
    requests,
    violations,
    writes,
    control,
    store,
    get engine() {
      return engine;
    },
    /** Empties the store, so this harness's engine has nothing left to do. */
    close() {
      records.clear();
    },
    reopen() {
      engine = new DeliveryEngine(store as unknown as LocalStore);
      return engine;
    },
    advance,
    run,
    peer(id = "self", record = item.id): PeerDelivery {
      return records.get(record)!.peers[id];
    },
    row(record = item.id) {
      return records.get(record)!;
    },
    log(peer?: string) {
      return requests
        .filter((request) => !peer || request.peer === peer)
        .map((request) => `${request.at}:${request.kind}`);
    },
  };
}
type Harness = ReturnType<typeof harness>;
const setOnline = (online: boolean) => {
  nav.onLine = online;
  (globalThis.window as EventTarget).dispatchEvent(
    new Event(online ? "online" : "offline"),
  );
};
/** The fields that recovery must reproduce exactly. */
const durable = (peer: PeerDelivery) => ({
  state: peer.state,
  attempts: peer.attempts,
  nextAttempt: peer.nextAttempt,
  receipt: peer.receipt?.envelope_hash ?? null,
  verifyReceipt: peer.verifyReceipt ?? false,
  failure: peer.failure,
});

// ---------------------------------------------------------------------------
// 1. A small reference model for one recipient.
//
// Saved state S, pending result P, server mode, and one user event. The model
// gives the requests after the event and the final saved state. Storage works
// again when the event starts. It does not read the engine.

type Saved = "queued" | "unknown" | "refused";
type Pending = "none" | "accepted" | "refused" | "unknown";
type Server = "holds" | "absent";
type Event = "timer" | "try" | "resume" | "discard";

function model(s: Saved, p: Pending, server: Server, event: Event) {
  // A pending write commits first. Its result becomes the saved state.
  const x: Saved | "accepted" = p === "none" ? s : p;
  const network = (state: Saved | "accepted", explicit: boolean) => {
    if (state === "accepted") return { requests: [], final: "accepted" };
    if (state === "refused" && !explicit)
      return { requests: [], final: "refused" };
    // A saved send mark exists after the first POST, so every attempt but
    // a fresh first send looks up the receipt first.
    const fresh = state === "queued" && p === "none";
    if (fresh) return { requests: ["post"], final: "accepted" };
    return server === "holds"
      ? { requests: ["receipt"], final: "accepted" }
      : { requests: ["receipt", "post"], final: "accepted" };
  };
  if (event === "discard")
    return {
      requests: [],
      final: x === "accepted" ? "accepted" : "deleted",
    };
  if (event === "timer") return network(x, false);
  // Resume makes a refusal unknown. Try now retries it.
  return network(x === "refused" && event === "resume" ? "unknown" : x, true);
}

async function buildState(f: Harness, s: Saved, p: Pending) {
  const self = f.item.peers.self;
  if (s !== "queued")
    Object.assign(self, {
      state: s,
      attempts: 1,
      nextAttempt: s === "refused" ? null : 10_000,
      failure: s === "refused" ? "refused" : "server",
      sendAttempt: "older",
      sendStarted: 1,
      attempt: "older",
    });
  if (p === "none") return;
  // One attempt computes P, and its write fails until the event.
  f.control.respond = (request) => {
    if (request.kind === "post")
      return p === "accepted"
        ? Response.json(receiptFor(f.item), { status: 201 })
        : p === "refused"
          ? json(422, refusedBody)
          : json(503, { message: "Busy" });
    return p === "accepted"
      ? Response.json(receiptFor(f.item))
      : p === "refused"
        ? Response.json(
            receiptFor(f.item, { admission: "refused", reasons: ["test"] }),
          )
        : json(500, { message: "Lookup failed" });
  };
  // Outcome rows carry no send mark. Mark writes do.
  f.control.failWrite = (_id, next) =>
    next.peers.self.sendAttempt === undefined;
  await f.engine.tryNow(f.item.id).catch(() => {});
  assert.ok(f.engine.hasPendingWrite(f.item.id), `pending ${p} from ${s}`);
}

for (const s of ["queued", "unknown", "refused"] as Saved[])
  for (const p of ["none", "accepted", "refused", "unknown"] as Pending[])
    for (const server of ["holds", "absent"] as Server[])
      for (const event of ["timer", "try", "resume", "discard"] as Event[])
        test(`model: saved ${s}, pending ${p}, server ${server}, ${event}`, async (t) => {
          const f = harness(t);
          await buildState(f, s, p);
          const before = f.requests.length;
          f.control.failWrite = () => false;
          let held = server === "holds";
          f.control.respond = (request) => {
            if (request.kind === "post") {
              held = true;
              return Response.json(receiptFor(f.item), { status: 201 });
            }
            return held ? Response.json(receiptFor(f.item)) : notFound();
          };
          const expected = model(s, p, server, event);
          if (event === "timer") f.engine.start();
          if (event === "try") await f.engine.tryNow(f.item.id);
          if (event === "resume") {
            await f.engine.stop(f.item.id);
            await f.engine.resume(f.item.id);
          }
          if (event === "discard") {
            await f.engine.stop(f.item.id);
            await f.engine.discard(f.item.id).catch(() => {});
          }
          await f.run(60_000);
          const trace = {
            requests: f.requests.slice(before).map((r) => r.kind),
            final: f.records.has(f.item.id) ? f.peer().state : "deleted",
          };
          assert.deepEqual(
            trace,
            expected,
            `counterexample: ${JSON.stringify({ s, p, server, event, trace })}`,
          );
          assert.deepEqual(f.violations, []);
        });

test("model: two pending recipients commit in either order to the same rows", async (t) => {
  const finals: string[] = [];
  for (const first of ["a", "b"]) {
    const f = harness(t, { peers: ["a", "b"] });
    f.control.respond = (request) =>
      request.peer === "a"
        ? Response.json(receiptFor(f.item), { status: 201 })
        : json(422, refusedBody);
    // Each recipient's outcome write fails until its turn.
    const open = new Set<string>();
    f.control.failWrite = (_id, next) =>
      ["a", "b"].some(
        (peer) =>
          next.peers[peer].sendAttempt === undefined &&
          next.peers[peer].state !== "queued" &&
          !open.has(peer),
      );
    await f.engine.tick();
    assert.equal(f.engine.view(f.row()).saving, true);
    open.add(first);
    await f.run(2_000);
    open.add(first === "a" ? "b" : "a");
    await f.run(20_000);
    finals.push(JSON.stringify([f.peer("a").state, f.peer("b").state]));
    assert.deepEqual(f.log(), ["0:post", "0:post"]);
    assert.deepEqual(f.violations, []);
    f.close();
    t.mock.timers.reset();
  }
  assert.deepEqual(finals, [
    JSON.stringify(["accepted", "refused"]),
    JSON.stringify(["accepted", "refused"]),
  ]);
});

// ---------------------------------------------------------------------------
// 2. Paired traces: the same answers with a working save and with failed
// outcome writes. The failed-save trace makes no request until its write
// commits, then saves the same peer row as the control.

type OutcomeCase =
  | "accepted"
  | "refused"
  | "unknown"
  | "missing-body"
  | "unreadable variant"
  | "proved mismatch";
const outcomes: OutcomeCase[] = [
  "accepted",
  "refused",
  "unknown",
  "missing-body",
  "unreadable variant",
  "proved mismatch",
];
function answer(f: Harness, kind: OutcomeCase) {
  return (request: Request) => {
    if (request.kind === "envelope")
      return kind === "unreadable variant"
        ? Promise.reject(new TypeError("dropped"))
        : new Response(
            kind === "proved mismatch" ? otherBytes() : variantBytes(),
          );
    if (request.kind === "receipt") return notFound();
    switch (kind) {
      case "accepted":
        return Response.json(receiptFor(f.item), { status: 201 });
      case "refused":
        return json(422, refusedBody);
      case "unknown":
        return json(503, { message: "Busy" });
      case "missing-body":
        return Response.json(
          receiptFor(f.item, { body_status: "missing", body_hash: null }),
          { status: 201 },
        );
      case "unreadable variant":
        return Response.json(
          receiptFor(f.item, { envelope_hash: variantHash() }),
          { status: 201 },
        );
      case "proved mismatch":
        return Response.json(
          receiptFor(f.item, {
            envelope_hash: core.contentHash(core.utf8(otherBytes())),
          }),
          { status: 201 },
        );
    }
  };
}
for (const kind of outcomes)
  for (const failures of [1, 3, Infinity])
    test(`paired trace: ${kind} with ${failures === Infinity ? "persistent" : failures} failed outcome writes`, async (t) => {
      const control = harness(t);
      control.control.respond = answer(control, kind);
      await control.engine.tick();
      const expected = durable(control.peer());
      control.close();
      t.mock.timers.reset();

      const f = harness(t);
      f.control.respond = answer(f, kind);
      let left = failures;
      let failedAttempt: string | undefined;
      f.control.failWrite = (_id, next) => {
        const peer = next.peers.self;
        if (peer.sendAttempt !== undefined || left <= 0) return false;
        failedAttempt ??= peer.attempt;
        // Every replay carries the original attempt ID.
        assert.equal(peer.attempt, failedAttempt);
        left--;
        return true;
      };
      await f.engine.tick();
      const after = f.requests.length;
      assert.equal(f.engine.hasPendingWrite(f.item.id), true);
      // Persistent failure: no request for a minute of local retries.
      await f.run(failures === Infinity ? 60_000 : 1_000);
      if (failures === Infinity) {
        assert.equal(f.requests.length, after);
        assert.equal(f.engine.hasPendingWrite(f.item.id), true);
        left = 0;
      }
      await f.run(30_000);
      assert.equal(f.engine.hasPendingWrite(f.item.id), false);
      // The replay that committed saved the same row as the control.
      const replay = f.writes.find(
        (write) =>
          !write.failed && write.next.peers.self.attempt === failedAttempt,
      );
      assert.ok(replay, "the original write committed");
      assert.deepEqual(durable(replay.next.peers.self), expected);
      assert.deepEqual(f.violations, []);
      assert.equal(f.row().transport, f.item.transport);
    });

// ---------------------------------------------------------------------------
// 3. A fault at each phase. Each test fires the next timer and checks the
// operation that it runs.

test("fault: a failed list read retries the list and keeps local writes", async (t) => {
  const f = harness(t);
  f.control.respond = answer(f, "accepted");
  let failOutcome = true;
  f.control.failWrite = (_id, next) =>
    failOutcome && next.peers.self.sendAttempt === undefined;
  await f.engine.tick();
  let lists = 0;
  f.control.failList = () => ++lists === 1;
  failOutcome = false;
  // The local write retries after 1 s although the list read fails.
  await f.advance(1_000);
  assert.equal(f.peer().state, "accepted");
  assert.deepEqual(f.log(), ["0:post"]);
});
test("fault: a failed record read delays that record alone", async (t) => {
  const f = harness(t);
  // Created after the fake clock starts, so that it is due now.
  const other = outboxItem(profile(31), "other", 0, f.item.recipients!);
  f.records.set(other.id, other);
  f.control.respond = (request) =>
    Response.json(receiptFor(f.records.get(request.id)!), { status: 201 });
  let reads = 0;
  f.control.failRead = () => ++reads === 1;
  await f.engine.tick();
  const states = () => [f.peer().state, f.peer("self", other.id).state].sort();
  assert.deepEqual(states(), ["accepted", "queued"]);
  await f.advance(15_000);
  assert.deepEqual(states(), ["accepted", "accepted"]);
});
test("fault: a failed send-mark write sends nothing and retries later", async (t) => {
  const f = harness(t);
  f.control.respond = answer(f, "accepted");
  let left = 1;
  f.control.failWrite = (_id, next) =>
    next.peers.self.sendAttempt !== undefined && left-- > 0;
  await f.engine.tick();
  assert.deepEqual(f.log(), []);
  assert.equal(f.engine.hasPendingWrite(f.item.id), false);
  await f.advance(15_000);
  assert.deepEqual(f.log(), ["15000:post"]);
  assert.equal(f.peer().state, "accepted");
});
for (const phase of ["receipt", "envelope"] as const)
  test(`fault: a failed ${phase} GET backs off and the timer runs the check`, async (t) => {
    const f = harness(t);
    Object.assign(f.item.peers.self, {
      state: "unknown",
      attempts: 1,
      nextAttempt: 10_000,
      sendAttempt: "older",
      sendStarted: 1,
      attempt: "older",
    });
    let broken = true;
    f.control.respond = (request) => {
      if (request.kind === "receipt")
        return broken && phase === "receipt"
          ? json(500, { message: "Failed" })
          : Response.json(receiptFor(f.item, { envelope_hash: variantHash() }));
      return broken
        ? Promise.reject(new TypeError("dropped"))
        : new Response(variantBytes());
    };
    await f.engine.tick();
    assert.equal(f.peer().state, "unknown");
    assert.equal(f.peer().nextAttempt, 10_000 + 30_000);
    // Both an open check and an unknown result look up the receipt next.
    assert.equal(f.engine.peerView(f.row(), "self").next?.kind, "receipt");
    broken = false;
    await f.run(30_000);
    assert.equal(f.peer().state, "accepted");
    assert.equal(f.log().filter((entry) => entry.endsWith("post")).length, 0);
  });
test("fault: a POST that fails before headers leaves an unknown outcome with a lookup next", async (t) => {
  const f = harness(t);
  let broken = true;
  f.control.respond = (request) =>
    request.kind === "post"
      ? broken
        ? Promise.reject(new TypeError("dropped"))
        : Response.json(receiptFor(f.item), { status: 201 })
      : broken
        ? notFound()
        : Response.json(receiptFor(f.item));
  await f.engine.tick();
  assert.equal(f.peer().state, "unknown");
  assert.equal(f.engine.peerView(f.row(), "self").next?.kind, "receipt");
  broken = false;
  await f.run(15_000);
  assert.deepEqual(f.log(), ["0:post", "15000:receipt"]);
  assert.equal(f.peer().state, "accepted");
});
for (const status of [201, 429])
  test(`fault: an interrupted ${status} body leaves the outcome unknown and keeps its Retry-After`, async (t) => {
    const f = harness(t);
    f.control.respond = (request) => {
      if (request.kind !== "post") return Response.json(receiptFor(f.item));
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"id":'));
          controller.error(new TypeError("dropped"));
        },
      });
      return new Response(body, {
        status,
        headers: { "retry-after": "600" },
      });
    };
    await f.engine.tick();
    assert.equal(f.peer().state, "unknown");
    // A damaged body never proves acceptance.
    assert.equal(f.peer().nextAttempt, 610_000);
  });
test("fault: a listener error after the outcome commit stops nothing", async (t) => {
  const f = harness(t);
  f.control.respond = answer(f, "unknown");
  let thrown = 0;
  f.engine.subscribe((items) => {
    if (items[0]?.peers.self.state === "unknown" && thrown++ === 0)
      throw new Error("Test listener failure.");
  });
  await flush();
  await f.engine.tick();
  assert.equal(f.peer().state, "unknown");
  assert.equal(f.engine.nextTryAt(f.row(), "self"), 25_000);
  await f.run(15_000);
  assert.deepEqual(f.log(), ["0:post", "15000:receipt", "15000:post"]);
});

// ---------------------------------------------------------------------------
// 4. Commands on each outcome while its write is pending.

for (const kind of [...outcomes, "missing address"] as const)
  for (const action of ["Stop", "Try now", "Resume", "Discard", "reload"])
    test(`command: ${action} while a ${kind} result awaits its save`, async (t) => {
      const f = harness(t);
      if (kind === "missing address") f.item.recipients = {};
      else f.control.respond = answer(f, kind);
      let storageWorks = false;
      // Outcome writes fail. Mark writes and stop writes work.
      f.control.failWrite = (_id, next) =>
        !storageWorks &&
        next.peers.self.sendAttempt === undefined &&
        next.stopped === f.row().stopped;
      await f.engine.tick();
      assert.equal(f.engine.hasPendingWrite(f.item.id), true);
      const posts = () => f.log().filter((entry) => entry.endsWith("post"));
      const sent = posts().length;
      if (action === "Stop") {
        await f.engine.stop(f.item.id);
        assert.equal(f.row().stopped, true);
        // Local writes still run while the record is stopped.
        storageWorks = true;
        await f.run(2_000);
        assert.equal(f.engine.hasPendingWrite(f.item.id), false);
        assert.equal(f.row().stopped, true);
      }
      if (action === "Try now") {
        // Storage still fails: Try now reports it and sends nothing.
        await assert.rejects(f.engine.tryNow(f.item.id), {
          name: "QuotaExceededError",
        });
        assert.equal(posts().length, sent);
        storageWorks = true;
        await f.engine.tryNow(f.item.id).catch(() => {});
        assert.equal(f.engine.hasPendingWrite(f.item.id), false);
      }
      if (action === "Resume") {
        await f.engine.stop(f.item.id);
        await assert.rejects(f.engine.resume(f.item.id), {
          name: "QuotaExceededError",
        });
        // A Resume that could not save leaves the stop as it was.
        assert.equal(f.row().stopped, true);
        assert.equal(posts().length, sent);
      }
      if (action === "Discard") {
        f.records.set(f.item.id, { ...f.row(), stopped: true });
        await assert.rejects(
          f.engine.discard(f.item.id),
          /Discard did not run/,
        );
        assert.ok(f.records.has(f.item.id));
        storageWorks = true;
        await f.engine.discard(f.item.id).catch(() => {});
        // A saved acceptance keeps the record. Anything else may go.
        assert.equal(f.records.has(f.item.id), kind === "accepted");
      }
      if (action === "reload") {
        // The pending write is lost with the tab. The new engine follows the
        // saved row, which keeps its send mark when a POST started.
        const engine = f.reopen();
        storageWorks = true;
        assert.equal(engine.hasPendingWrite(f.item.id), false);
        if (kind !== "missing address")
          assert.ok(f.peer().sendAttempt, "the saved mark survives a reload");
      }
      assert.deepEqual(f.violations, []);
      assert.equal(
        f.records.get(f.item.id)?.transport ?? f.item.transport,
        f.item.transport,
      );
    });

test("command: a missing address shows export text while its result awaits a save", async (t) => {
  const f = harness(t);
  f.item.recipients = {};
  f.control.failWrite = (_id, next) => next.peers.self.attempt !== undefined;
  await f.engine.tick();
  const view = f.engine.peerView(f.row(), "self");
  assert.equal(view.status, "unresolved");
  assert.match(view.text, /not configured in this record/);
  assert.equal(view.next?.kind, "save");
  assert.deepEqual(f.requests, []);
});

// ---------------------------------------------------------------------------
// 5. Races held open with barriers.

function barrier() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}
test("race: Stop then Resume during an automatic lookup runs a fresh attempt after it", async (t) => {
  const f = harness(t);
  unknownRow(f);
  const hold = barrier();
  let lookups = 0;
  f.control.respond = async (request) => {
    if (request.kind === "post")
      return Response.json(receiptFor(f.item), { status: 201 });
    if (++lookups === 1) await hold.opened;
    return notFound();
  };
  const first = f.engine.tick();
  await flush();
  await f.engine.stop(f.item.id);
  const resumed = f.engine.resume(f.item.id);
  await flush();
  hold.open();
  await first;
  await resumed;
  // The old attempt saved its own result. Resume then ran a fresh attempt.
  assert.equal(f.row().stopped, false);
  assert.equal(f.peer().state, "accepted");
  assert.deepEqual(f.violations, []);
});
test("race: Discard waits for an open POST and keeps the accepted record", async (t) => {
  const f = harness(t);
  const hold = barrier();
  f.control.respond = async () => {
    await hold.opened;
    return Response.json(receiptFor(f.item), { status: 201 });
  };
  const sending = f.engine.tick();
  await flush();
  await f.engine.stop(f.item.id);
  const discarding = f.engine.discard(f.item.id);
  await flush();
  hold.open();
  await sending;
  await assert.rejects(discarding, /delivered to every recipient/);
  assert.ok(f.records.has(f.item.id));
  assert.equal(f.peer().state, "accepted");
});
test("race: Try now during a held outcome commit joins it and then decides", async (t) => {
  const f = harness(t);
  f.control.respond = answer(f, "accepted");
  const hold = barrier();
  let holding = true;
  f.control.beforeMerge = async () => {
    if (holding && f.requests.length) {
      holding = false;
      await hold.opened;
    }
  };
  const sending = f.engine.tick();
  await flush();
  const trying = f.engine.tryNow(f.item.id);
  await flush();
  hold.open();
  await sending;
  await trying;
  assert.equal(f.peer().state, "accepted");
  assert.deepEqual(f.log(), ["0:post"]);
});
for (const other of ["acceptance", "refusal", "send mark"] as const)
  test(`race: another tab's ${other} during a pending write is not undone`, async (t) => {
    const f = harness(t);
    f.control.respond = answer(f, "refused");
    let fail = true;
    f.control.failWrite = (_id, next) =>
      fail && next.peers.self.sendAttempt === undefined;
    await f.engine.tick();
    const self = f.peer();
    // Another tab writes meanwhile.
    f.records.set(f.item.id, {
      ...f.row(),
      peers: {
        self:
          other === "acceptance"
            ? {
                ...self,
                state: "accepted",
                receipt: receiptFor(f.item),
                attempt: "tab2",
                sendAttempt: undefined,
                sendStarted: undefined,
                nextAttempt: null,
              }
            : other === "refusal"
              ? {
                  ...self,
                  state: "refused",
                  error: "Tab 2",
                  attempt: "tab2",
                  sendAttempt: undefined,
                  sendStarted: undefined,
                  nextAttempt: null,
                }
              : {
                  ...self,
                  sendAttempt: "tab2-mark",
                  sendStarted: Date.now(),
                  nextAttempt: Date.now() + 3_600_000,
                },
      },
    });
    const before = { ...f.peer() };
    fail = false;
    await f.run(2_000);
    assert.equal(f.engine.hasPendingWrite(f.item.id), false);
    // The stale refusal does not replace the newer row.
    assert.equal(f.peer().attempt === before.attempt, true);
    assert.equal(f.peer().state, before.state);
  });

// ---------------------------------------------------------------------------
// 6. Retry-After. The request starts at 10 s and its headers arrive at 18 s.

async function slowAnswer(
  f: Harness,
  phase: Kind,
  retryAfter: string,
  status = 429,
) {
  f.control.respond = async (request) => {
    if (request.kind === phase) {
      await new Promise((resolve) => setTimeout(resolve, 8_000));
      return json(status, { code: "busy", message: "Wait" }, retryAfter);
    }
    if (request.kind === "receipt")
      return phase === "envelope"
        ? Response.json(receiptFor(f.item, { envelope_hash: variantHash() }))
        : notFound();
    return new Response(variantBytes());
  };
}
function unknownRow(f: Harness) {
  Object.assign(f.item.peers.self, {
    state: "unknown",
    attempts: 1,
    nextAttempt: 10_000,
    sendAttempt: "older",
    sendStarted: 1,
    attempt: "older",
  });
}
for (const phase of ["post", "receipt", "envelope"] as Kind[])
  for (const [header, at] of [
    ["60", 78_000],
    [new Date(100_000).toUTCString(), 100_000],
  ] as const)
    test(`Retry-After ${header.length > 3 ? "date" : header} on the ${phase} counts from the headers`, async (t) => {
      const f = harness(t);
      if (phase !== "post") unknownRow(f);
      await slowAnswer(f, phase, header);
      const ticking = f.engine.tick();
      await f.advance(8_000);
      await ticking;
      assert.equal(f.peer().nextAttempt, at);
      assert.equal(f.engine.nextTryAt(f.row(), "self"), at);
      // No automatic request before the deadline.
      const count = f.requests.length;
      await f.run(at - 18_000 - 1_000);
      assert.equal(f.requests.length, count);
    });
for (const [label, header] of [
  ["malformed", "soon"],
  ["oversized", "9".repeat(309)],
] as const)
  test(`Retry-After ${label} falls back to ordinary backoff`, async (t) => {
    const f = harness(t);
    await slowAnswer(f, "post", header, 503);
    const ticking = f.engine.tick();
    await f.advance(8_000);
    await ticking;
    assert.equal(f.peer().nextAttempt, 25_000);
  });
test("Retry-After above the timer cap re-evaluates on wake and never sends early", async (t) => {
  const f = harness(t);
  const days = 30 * 24 * 3600;
  await slowAnswer(f, "post", String(days), 503);
  const ticking = f.engine.tick();
  await f.advance(8_000);
  await ticking;
  assert.equal(f.peer().nextAttempt, 18_000 + days * 1000);
  const count = f.requests.length;
  // The timer wakes after its 2^31 - 1 ms cap and finds nothing due.
  await f.advance(2 ** 31);
  assert.equal(f.requests.length, count);
});
test("Retry-After: a manual action may override the deadline", async (t) => {
  const f = harness(t);
  await slowAnswer(f, "post", "600", 503);
  const ticking = f.engine.tick();
  await f.advance(8_000);
  await ticking;
  f.control.respond = (request) =>
    request.kind === "post"
      ? Response.json(receiptFor(f.item), { status: 201 })
      : notFound();
  await f.engine.tryNow(f.item.id);
  assert.equal(f.peer().state, "accepted");
});
test("Retry-After: a local write commits during the server's wait without a request", async (t) => {
  const f = harness(t);
  await slowAnswer(f, "post", "600", 503);
  let fail = true;
  f.control.failWrite = (_id, next) =>
    fail && next.peers.self.sendAttempt === undefined;
  const ticking = f.engine.tick();
  await f.advance(8_000);
  await ticking.catch(() => {});
  assert.equal(f.engine.hasPendingWrite(f.item.id), true);
  fail = false;
  await f.run(2_000);
  assert.equal(f.engine.hasPendingWrite(f.item.id), false);
  // The saved network time is the server's, untouched by local retries.
  assert.equal(f.peer().nextAttempt, 618_000);
  assert.equal(f.requests.length, 1);
});

// ---------------------------------------------------------------------------
// 7. Verification through repeated 503s, with a working and a failed save.

for (const failSave of [false, true])
  test(`verification: repeated 503s back off 15, 30 and 60 s (${failSave ? "failed" : "working"} save)`, async (t) => {
    const f = harness(t);
    let envelopes = 0;
    f.control.respond = (request) => {
      if (request.kind === "post")
        return Response.json(
          receiptFor(f.item, { envelope_hash: variantHash() }),
          { status: 201 },
        );
      if (request.kind === "envelope")
        return ++envelopes === 1
          ? Promise.reject(new TypeError("dropped"))
          : new Response(variantBytes());
      return json(503, { message: "Busy" });
    };
    let left = failSave ? 1 : 0;
    f.control.failWrite = (_id, next) =>
      next.peers.self.verifyReceipt === true && left-- > 0;
    await f.engine.tick();
    await f.run(120_000);
    const lookups = f.log().filter((entry) => entry.endsWith("receipt"));
    // A failed local commit consumes no network attempt.
    assert.deepEqual(lookups, [
      "15000:receipt",
      "45000:receipt",
      "105000:receipt",
    ]);
    assert.equal(f.peer().verifyReceipt, true);
    assert.equal(f.log().filter((entry) => entry.endsWith("post")).length, 1);
  });
for (const phase of ["receipt", "envelope"] as const)
  test(`verification: an offline ${phase} failure keeps the saved check and its schedule`, async (t) => {
    const f = harness(t);
    Object.assign(f.item.peers.self, {
      state: "unknown",
      attempts: 2,
      verifyReceipt: true,
      receipt: receiptFor(f.item, { envelope_hash: variantHash() }),
      nextAttempt: 625_000,
      sendAttempt: "older",
      sendStarted: 1,
      attempt: "older",
    });
    f.control.respond = (request) =>
      request.kind === phase
        ? Promise.reject(new TypeError("offline"))
        : Response.json(receiptFor(f.item, { envelope_hash: variantHash() }));
    nav.onLine = false;
    await f.engine.tryNow(f.item.id);
    assert.equal(f.peer().nextAttempt, 625_000);
    assert.equal(f.peer().verifyReceipt, true);
    assert.equal(f.peer().attempts, 2);
  });
test("verification: a newly observed variant keeps its check when the envelope GET fails offline", async (t) => {
  const f = harness(t);
  unknownRow(f);
  f.control.respond = (request) =>
    request.kind === "receipt"
      ? Response.json(receiptFor(f.item, { envelope_hash: variantHash() }))
      : Promise.reject(new TypeError("offline"));
  nav.onLine = false;
  await f.engine.tryNow(f.item.id);
  assert.equal(f.peer().verifyReceipt, true);
  assert.ok(Number.isFinite(f.peer().nextAttempt));
  assert.equal(f.log().filter((entry) => entry.endsWith("post")).length, 0);
});
test("verification: a completed check then a 422 pauses sends", async (t) => {
  const f = harness(t);
  Object.assign(f.item.peers.self, {
    state: "unknown",
    attempts: 1,
    verifyReceipt: true,
    nextAttempt: 10_000,
    sendAttempt: "older",
    sendStarted: 1,
    attempt: "older",
  });
  f.control.respond = (request) =>
    request.kind === "receipt"
      ? Response.json(
          receiptFor(f.item, {
            envelope_hash: variantHash(),
            body_status: "missing",
            body_hash: null,
          }),
        )
      : request.kind === "envelope"
        ? new Response(variantBytes())
        : json(422, refusedBody);
  await f.engine.tick();
  assert.equal(f.peer().state, "refused");
  assert.equal(f.peer().verifyReceipt, undefined);
  await f.run(120_000);
  assert.deepEqual(f.log(), ["0:receipt", "0:envelope", "0:post"]);
});
test("verification: a lost POST answer then a 404 permits the identical retry", async (t) => {
  const f = harness(t);
  let lost = true;
  f.control.respond = (request) =>
    request.kind === "post"
      ? lost
        ? Promise.reject(new TypeError("dropped"))
        : Response.json(receiptFor(f.item), { status: 201 })
      : notFound();
  await f.engine.tick();
  lost = false;
  await f.run(15_000);
  assert.deepEqual(f.log(), ["0:post", "15000:receipt", "15000:post"]);
  assert.equal(f.peer().state, "accepted");
  assert.deepEqual(f.violations, []);
});

// ---------------------------------------------------------------------------
// 8. Two recipients, unrelated groups, and a child that names its parent.

for (const order of [
  ["a", "b"],
  ["b", "a"],
])
  test(`peers ${order.join(", ")}: a failing write for one never moves the other`, async (t) => {
    const f = harness(t, { peers: order });
    const unrelated = outboxItem(
      profile(41),
      "unrelated",
      0,
      f.item.recipients!,
    );
    const child = outboxItem(profile(42), "main", 1, f.item.recipients!);
    f.records.set(unrelated.id, unrelated);
    f.records.set(child.id, child);
    f.control.respond = (request) =>
      request.kind === "post"
        ? Response.json(receiptFor(f.records.get(request.id)!), { status: 201 })
        : notFound();
    // A's write for the first record fails for good. B works.
    f.control.failWrite = (id, next) =>
      id === f.item.id &&
      next.peers.a.state === "accepted" &&
      next.peers.a.sendAttempt === undefined;
    await f.engine.tick();
    await f.run(120_000);
    const count = (peer: string, id: string) =>
      f.requests.filter((r) => r.peer === peer && r.id === id).length;
    for (const id of [f.item.id, unrelated.id, child.id])
      for (const peer of ["a", "b"]) assert.equal(count(peer, id), 1);
    assert.equal(f.peer("b").state, "accepted");
    // A's pending acceptance lets the child go to A.
    assert.equal(f.peer("a", child.id).state, "accepted");
    assert.equal(f.engine.peerView(f.row(), "a").status, "saving-accepted");
    assert.deepEqual(f.violations, []);
  });
test("group: a pending nonacceptance holds the child for that recipient only, until it commits", async (t) => {
  const f = harness(t, { peers: ["a", "b"] });
  const child = outboxItem(profile(43), "main", 1, f.item.recipients!);
  f.records.set(child.id, child);
  f.control.respond = (request) =>
    request.kind === "post"
      ? request.id === f.item.id && request.peer === "a"
        ? json(503, { message: "Busy" }, "600")
        : Response.json(receiptFor(f.records.get(request.id)!), { status: 201 })
      : notFound();
  let fail = true;
  f.control.failWrite = (id, next) =>
    fail &&
    id === f.item.id &&
    next.peers.a.state === "unknown" &&
    next.peers.a.sendAttempt === undefined;
  await f.engine.tick();
  assert.equal(f.peer("b", child.id).state, "accepted");
  assert.equal(f.peer("a", child.id).state, "queued");
  // Early recovery: the write commits and the child goes at once.
  fail = false;
  await f.run(2_000);
  assert.equal(f.peer("a", child.id).state, "accepted");
  // The parent's saved 600 s wait was never copied into the child.
  assert.equal(f.peer("a").nextAttempt, 610_000);
});
test("group: a saved future delay on the parent gives the child its turn", async (t) => {
  const f = harness(t);
  Object.assign(f.item.peers.self, {
    state: "unknown",
    attempts: 1,
    nextAttempt: 600_000,
    sendAttempt: "older",
    sendStarted: 1,
    attempt: "older",
  });
  const child = outboxItem(profile(44), "main", 1, f.item.recipients!);
  f.records.set(child.id, child);
  f.control.respond = (request) =>
    Response.json(receiptFor(f.records.get(request.id)!), { status: 201 });
  await f.engine.tick();
  assert.equal(f.peer("self", child.id).state, "accepted");
  assert.equal(f.peer().state, "unknown");
});

// ---------------------------------------------------------------------------
// The signing boundary: a committed group returns after a failed delivery.

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
  const results = await signer.publish([
    { action: { kind: "judgment.set", target, value: "bless" }, body: null },
  ]);
  own.invalidate();
  assert.equal(results.length, 1);
  assert.equal(outbox.size, 1);
  assert.equal(results[0].transport, outbox.get(results[0].id)!.transport);
  const judgment = (await own.registers())?.judgments.get(target);
  assert.equal(
    judgment && "value" in judgment ? judgment.value : undefined,
    "bless",
  );
  assert.equal(posts, 1);
  // The pending acceptance commits locally. Nothing is sent again.
  await new Promise<void>((resolve) => setImmediate(resolve));
  t.mock.timers.tick(1_000);
  for (let i = 0; i < 20; i++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(outbox.get(results[0].id)!.peers.self.state, "accepted");
  assert.equal(posts, 1);
});
