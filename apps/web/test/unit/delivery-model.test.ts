// An extended model of delivery recovery. A scripted server keeps its own
// truth for every record and recipient, and a scripted store fails chosen
// writes and reads. The oracle never reads the engine's page view. It
// decides from its own record of failed outcome writes, committed send
// marks, Stop calls, Retry-After deadlines that it sent, and the server
// truth:
//
// - No request goes to a recipient whose outcome write failed until that
//   write commits or the oracle itself installs a superseding row.
// - Every POST carries a send mark that committed and was not used before.
// - After a Stop resolves, no POST starts until a later Try now or Resume.
// - No automatic request goes out before a Retry-After deadline that the
//   server sent with a usable header.
// - A failed outcome write commits within 16 s once storage works, also
//   while another request is held open.
// - When faults end, every recipient reaches the server's truth.
// - Each scenario names the POSTs it permits.
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

let variantBytes: string;
let variantHash: string;
before(async () => {
  await core.initializeCore(
    await readFile(
      new URL(
        "../../../../packages/core/generated/jvc_runtime_bg.wasm",
        import.meta.url,
      ),
    ),
  );
  variantBytes = canonical(variants[0].envelope);
  variantHash = core.contentHash(core.utf8(variantBytes));
});

const flush = async () => {
  for (let i = 0; i < 25; i++)
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
const profile = (seed: number, previous: string[] = []) =>
  core.createEvent(
    new Uint8Array(32).fill(seed),
    previous,
    "1".repeat(32),
    { kind: "identity.profile" },
    { name: `Record ${seed}`, bio: [], links: [] },
  );

type Kind = "post" | "receipt" | "envelope";
type Holds = "none" | "header" | "full";
type Answer = (now: number) => Response | Promise<Response>;
type Truth = {
  holds: Holds;
  refuse: boolean;
  /** The server keeps the other signature variant of the stored record. */
  variant: boolean;
  /** Answers that replace the next default answers, by request kind. */
  script: Partial<Record<Kind, Answer[]>>;
  /** Fake milliseconds that each request of this kind stays open. */
  hold: Partial<Record<Kind, number>>;
};
const json = (status: number, value: unknown, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

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

type Violation = string;
const key = (id: string, peer: string) => `${id}|${peer}`;

/**
 * Records, a scripted server with its own truth, and a scripted store.
 * The oracle state lives here and never reads the engine.
 */
function world(
  t: TestContext,
  rows: OutboxItem[],
  truths: Record<string, Partial<Truth>>,
) {
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: new EventTarget() },
    document: { configurable: true, value: new EventTarget() },
  });
  nav.onLine = true;
  t.after(() => {
    nav.onLine = true;
  });
  const start = Date.now();
  const records = new Map(rows.map((row) => [row.id, row]));
  const truth = new Map<string, Truth>();
  for (const row of rows)
    for (const peer of Object.keys(row.peers))
      truth.set(key(row.id, peer), {
        holds: "none",
        refuse: false,
        variant: false,
        script: {},
        hold: {},
        ...(truths[key(row.id, peer)] ?? truths[peer] ?? {}),
      });
  const violations: Violation[] = [];
  const log: string[] = [];
  const pending = new Map<string, string>();
  const committedMarks = new Set<string>();
  const usedMarks = new Set<string>();
  const deadlines = new Map<string, number>();
  let stoppedAt = new Map<string, number>();
  let explicit = 0;
  const fault = {
    outcome: (_id: string, _peer: string, _next: PeerDelivery) => false,
    mark: (_id: string, _peer: string) => false,
    read: (_id: string) => false,
    /** Fails every write that would change the row. */
    changes: () => false,
  };
  const at = () => Date.now() - start;
  const answerFor = (
    id: string,
    peer: string,
    kind: Kind,
  ): Response | Promise<Response> => {
    const row = records.get(id)!;
    const server = truth.get(key(id, peer))!;
    const scripted = server.script[kind]?.shift();
    if (scripted) return scripted(at());
    const envelopeHash = server.variant
      ? variantHash
      : storedEnvelopeHash(row.transport);
    if (kind === "envelope") return new Response(variantBytes);
    if (kind === "receipt") {
      if (server.refuse && server.holds === "none")
        return Response.json(
          receiptFor(row, { admission: "refused", reasons: ["test"] }),
        );
      if (server.holds === "none") return json(404, { message: "Not found" });
      return Response.json(
        receiptFor(row, {
          envelope_hash: envelopeHash,
          ...(server.holds === "header"
            ? { body_status: "missing", body_hash: null }
            : {}),
        }),
      );
    }
    if (server.refuse)
      return json(422, { code: "refused", message: "Refused" });
    server.holds = "full";
    return Response.json(receiptFor(row, { envelope_hash: envelopeHash }), {
      status: 201,
    });
  };
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
      const k = key(id, peer);
      const label = `${at()}:${peer}:${kind}:${id.slice(5, 9)}`;
      log.push(label);
      if (pending.has(k))
        violations.push(`${label} while its outcome write is pending`);
      if (explicit === 0 && (deadlines.get(k) ?? 0) > Date.now())
        violations.push(`${label} before the server's Retry-After deadline`);
      if (kind === "post") {
        const row = records.get(id)!;
        assert.equal(options!.body, row.transport);
        const mark = row.peers[peer].sendAttempt;
        if (!mark || !committedMarks.has(k + mark) || usedMarks.has(k + mark))
          violations.push(`${label} without its own committed mark`);
        if (mark) usedMarks.add(k + mark);
        const stopped = stoppedAt.get(id);
        if (stopped !== undefined && explicit === 0)
          violations.push(`${label} after Stop resolved`);
      }
      const delay = truth.get(k)!.hold[kind] ?? 0;
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      const response = await answerFor(id, peer, kind);
      const header = response.headers.get("retry-after");
      if (header && /^\d+$/.test(header))
        deadlines.set(k, Date.now() + Number(header) * 1000);
      return response;
    },
  );
  const store = {
    async get(_store: string, id: string) {
      if (fault.read(id)) throw quota();
      return records.get(id);
    },
    async list() {
      return [...records.values()];
    },
    async mergeOutbox(id: string, mutate: (s: OutboxItem) => OutboxItem) {
      const current = records.get(id);
      if (!current) return undefined;
      const next = mutate(current);
      if (next === current) return current;
      // Classify the write by the recipient that it changes.
      for (const [peer, after] of Object.entries(next.peers)) {
        const before = current.peers[peer];
        if (JSON.stringify(before) === JSON.stringify(after)) continue;
        const k = key(id, peer);
        const isMark =
          after.sendAttempt !== undefined &&
          after.sendAttempt !== before?.sendAttempt;
        const failed =
          fault.changes() ||
          (isMark ? fault.mark(id, peer) : fault.outcome(id, peer, after));
        if (failed) {
          if (!isMark && after.attempt) pending.set(k, after.attempt);
          throw quota();
        }
        if (isMark) committedMarks.add(k + after.sendAttempt);
        else if (pending.get(k) === after.attempt) pending.delete(k);
      }
      if (fault.changes()) throw quota();
      records.set(id, next);
      return next;
    },
    async discardOutbox(id: string) {
      records.delete(id);
    },
  };
  const engine = new DeliveryEngine(store as unknown as LocalStore);
  const advance = async (ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 1000) {
      await flush();
      t.mock.timers.tick(Math.min(1000, ms - elapsed));
      await flush();
    }
  };
  return {
    engine,
    records,
    truth,
    violations,
    log,
    pending,
    fault,
    advance,
    at,
    /** Another tab installs a newer row. It supersedes a pending write. */
    install(id: string, peer: string, next: Partial<PeerDelivery>) {
      const row = records.get(id)!;
      records.set(id, {
        ...row,
        peers: { ...row.peers, [peer]: { ...row.peers[peer], ...next } },
      });
      if (next.sendAttempt)
        committedMarks.add(key(id, peer) + next.sendAttempt);
      pending.delete(key(id, peer));
    },
    async explicitly<T>(run: () => Promise<T>) {
      explicit++;
      try {
        return await run();
      } finally {
        explicit--;
      }
    },
    async stop(id: string) {
      await engine.stop(id);
      stoppedAt.set(id, at());
    },
    started(id: string) {
      stoppedAt.delete(id);
    },
    /** Liveness: every recipient matches the server's truth. */
    settled() {
      for (const [k, server] of truth) {
        const [id, peer] = k.split("|");
        const state = records.get(id)?.peers[peer]?.state;
        const expected = server.refuse ? "refused" : "accepted";
        if (state !== expected)
          violations.push(
            `${k} ends ${state}, the server truth is ${expected}`,
          );
      }
      for (const k of pending.keys())
        violations.push(`${k} keeps a pending outcome write`);
    },
    posts(id?: string, peer?: string) {
      return log.filter(
        (entry) =>
          entry.includes(":post:") &&
          (!peer || entry.includes(`:${peer}:`)) &&
          (!id || entry.endsWith(id.slice(5, 9))),
      ).length;
    },
  };
}

function rowFor(
  transport: Transport,
  peers: string[],
  group = "g",
  order = 0,
  saved: Record<string, Partial<PeerDelivery>> = {},
) {
  const row = outboxItem(
    transport,
    group,
    order,
    Object.fromEntries(
      peers.map((id) => [
        id,
        { origin: `http://${id}.test`, base: "/api/v1", label: id },
      ]),
    ),
  );
  for (const [peer, values] of Object.entries(saved))
    Object.assign(row.peers[peer], values);
  return row;
}
const SENT = {
  state: "unknown",
  attempts: 1,
  nextAttempt: 0,
  failure: "server",
  sendAttempt: "older",
  sendStarted: 1,
  attempt: "older",
} as const;
const REFUSED = {
  state: "refused",
  attempts: 1,
  nextAttempt: null,
  failure: "refused",
  sendAttempt: undefined,
  sendStarted: undefined,
  attempt: "older",
} as const;
const VERIFYING = {
  ...SENT,
  verifyReceipt: true,
} as const;

function finish(w: ReturnType<typeof world>, label: string, permitted: number) {
  w.settled();
  const posts = w.posts();
  if (posts > permitted)
    w.violations.push(`${posts} POSTs, the scenario permits ${permitted}`);
  assert.deepEqual(
    w.violations,
    [],
    `${label}\ncounterexample trace: ${w.log.join(" ")}`,
  );
}

// ---------------------------------------------------------------------------
// Family A: a receipt that permits repair, then a failed send mark. The
// evidence from the receipt must survive, and a timed recovery follows.

for (const saved of ["refused", "verifying", "unknown"] as const)
  for (const driver of ["Try now", "timer"] as const)
    for (const later of ["header", "404"] as const) {
      // A saved refusal has no automatic attempt. Only Try now starts it.
      if (saved === "refused" && driver === "timer") continue;
      test(`model A: saved ${saved}, ${driver}, missing-body receipt, failed mark, later lookups ${later}`, async (t) => {
        t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
        const base =
          saved === "refused"
            ? REFUSED
            : saved === "verifying"
              ? VERIFYING
              : SENT;
        const row = rowFor(variants[1], ["self"], "g", 0, {
          self: {
            ...base,
            ...(saved === "refused" ? {} : { nextAttempt: Date.now() }),
          },
        });
        const w = world(t, [row], {
          self: { holds: "header", variant: saved === "verifying" },
        });
        if (later === "404") {
          // The first receipt shows the header without its body. Later
          // lookups answer 404, as after a server restore.
          const first = () =>
            Response.json(
              receiptFor(row, {
                envelope_hash:
                  saved === "verifying"
                    ? variantHash
                    : storedEnvelopeHash(row.transport),
                body_status: "missing",
                body_hash: null,
              }),
            );
          w.truth.get(key(row.id, "self"))!.script.receipt = [
            first,
            ...Array(30).fill(() => json(404, { message: "Not found" })),
          ];
        }
        let marks = 1;
        w.fault.mark = () => marks-- > 0;
        if (driver === "Try now")
          await w.explicitly(() => w.engine.tryNow(row.id).catch(() => {}));
        else w.engine.start();
        // No user action follows. A timed recovery must repair the record.
        await w.advance(600_000);
        finish(w, `A ${saved} ${driver} ${later}`, 1);
      });
    }

// ---------------------------------------------------------------------------
// Family B: an open verification receives answers that prove nothing. Only
// positive evidence may close it. The server holds the full record, so no
// further POST is permitted.

const malformed: Record<string, Partial<Record<Kind, Answer[]>>> = {
  "receipt with a null body hash": {
    receipt: [
      () =>
        Response.json({
          ...receiptFor(rowFor(variants[1], ["self"])),
          body_status: "present",
          body_hash: null,
        }),
    ],
  },
  "envelope bytes that do not parse": {
    envelope: [() => new Response("{")],
  },
  "envelope with another hash": {
    envelope: [() => new Response(canonical(variants[1].envelope))],
  },
  "404 during the check": {
    receipt: [() => json(404, { message: "Not found" })],
  },
  "receipt for another event": {
    receipt: [
      () =>
        Response.json(
          receiptFor(rowFor(variants[1], ["self"]), {
            id: "jve1:" + "f".repeat(64),
          }),
        ),
    ],
  },
};
for (const [name, script] of Object.entries(malformed))
  for (const failSave of [false, true])
    test(`model B: open verification, ${name}${failSave ? ", failed outcome write" : ""}`, async (t) => {
      t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
      const row = rowFor(variants[1], ["self"], "g", 0, {
        self: {
          ...VERIFYING,
          receipt: receiptFor(rowFor(variants[1], ["self"]), {
            envelope_hash: variantHash,
          }),
          nextAttempt: Date.now(),
        },
      });
      const w = world(t, [row], {
        self: {
          holds: "full",
          variant: true,
          script: {
            ...script,
            receipt: (script.receipt ?? []).map((answer) => answer),
          },
        },
      });
      let writes = failSave ? 1 : 0;
      w.fault.outcome = () => writes-- > 0;
      w.engine.start();
      await w.advance(300_000);
      finish(w, `B ${name}`, 0);
    });

// ---------------------------------------------------------------------------
// Family C: command order and Stop.

test("model C: Stop during a held automatic lookup, then the lookup answers 404", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  const row = rowFor(variants[1], ["self"], "g", 0, {
    self: { ...SENT, nextAttempt: Date.now() },
  });
  const w = world(t, [row], { self: { hold: { receipt: 5_000 } } });
  w.engine.start();
  await w.advance(1_000);
  await w.stop(row.id);
  await w.advance(30_000);
  assert.equal(w.records.get(row.id)!.stopped, true);
  assert.deepEqual(w.violations, [], w.log.join(" "));
});
for (const order of [
  ["resume", "stop"],
  ["stop", "resume"],
  ["try", "stop"],
  ["stop", "try"],
] as const)
  test(`model C: ${order.join(" then ")} called back to back run in order`, async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
    const row = rowFor(variants[1], ["self"], "g", 0, {
      self: { ...SENT, nextAttempt: Date.now() + 3_600_000 },
    });
    row.stopped = true;
    const w = world(t, [row], { self: { hold: { receipt: 2_000 } } });
    const calls = order.map((command) =>
      command === "stop"
        ? w.engine.stop(row.id)
        : w.explicitly(() =>
            (command === "resume"
              ? w.engine.resume(row.id)
              : w.engine.tryNow(row.id)
            ).catch(() => {}),
          ),
    );
    await w.advance(10_000);
    await Promise.all(calls);
    const last = order.at(-1);
    assert.equal(
      w.records.get(row.id)!.stopped,
      last === "stop" || (last === "try" && order[0] === "stop"),
      `${order.join(" then ")}: ${w.log.join(" ")}`,
    );
  });

// ---------------------------------------------------------------------------
// Family D: groups. A failed parent must not keep an eligible child from
// its recipient.

test("model D: explicit group publish while the browser reports offline, parent write fails", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const seed = base64url.decode(jwk.d!);
  const identity = core.identityFromSeed(seed);
  const genesis = profile(5);
  const heads = new Map<string, string[]>([[identity, [genesis.envelope.id]]]);
  const w = world(t, [], {});
  const outbox = w.records;
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
      for (const row of signed) {
        outbox.set(row.id, row);
        w.truth.set(key(row.id, "self"), {
          holds: "none",
          refuse: false,
          variant: false,
          script: {},
          hold: {},
        });
      }
      heads.set(identity, [signed.at(-1)!.id]);
    },
    async mergeOutbox(id: string, mutate: (s: OutboxItem) => OutboxItem) {
      const current = outbox.get(id)!;
      const next = mutate(current);
      const peer = next.peers.self;
      // The parent's acceptance write fails. Everything else works.
      if (
        peer.state === "accepted" &&
        [...outbox.keys()].indexOf(id) === 0 &&
        current.peers.self.state !== "accepted"
      )
        throw quota();
      outbox.set(id, next);
      return next;
    },
    async discardOutbox() {},
  };
  const session = {
    store,
    storageAvailable: true,
    backup: {
      format: "jbovlacku-key-backup",
      version: 1,
      identity,
      jwe: "",
    } as KeyBackup,
    identity,
    workingKey: pair.privateKey,
    preferences: {
      ...defaultPreferences,
      peers: [{ id: "self", base: "http://self.test/api/v1", label: "self" }],
    },
    subscribe() {
      return () => {};
    },
    async signingDisabled() {
      return null;
    },
    touch() {},
  } as unknown as Session;
  const delivery = new DeliveryEngine(store as unknown as LocalStore);
  const signer = new Signer(session, delivery, () => true);
  nav.onLine = false;
  await signer
    .publish([
      {
        action: {
          kind: "judgment.set",
          target: "jve1:" + "b".repeat(64),
          value: "bless",
        },
        body: null,
      },
      {
        action: {
          kind: "judgment.set",
          target: "jve1:" + "c".repeat(64),
          value: "bless",
        },
        body: null,
      },
    ])
    .catch(() => {});
  const ids = [...outbox.keys()];
  assert.equal(ids.length, 2);
  // The child was already authorized by the explicit call. It gets its turn.
  assert.equal(w.posts(ids[1]), 1, `child posts: ${w.log.join(" ")}`);
});
test("model D: a parent whose record reads fail does not hold a child at a recipient it finished", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  const parent = rowFor(profile(21), ["a", "b"], "chain", 0, {
    a: { state: "accepted", attempts: 1, nextAttempt: null },
    b: { ...REFUSED },
  });
  const child = rowFor(profile(22, [parent.id]), ["a"], "chain", 1);
  const w = world(t, [parent, child], {
    [key(parent.id, "a")]: { holds: "full" },
    [key(parent.id, "b")]: { refuse: true },
  });
  w.fault.read = (id) => id === parent.id;
  w.engine.start();
  await w.advance(30_000);
  assert.equal(
    w.records.get(child.id)!.peers.a.state,
    "accepted",
    `child at a: ${w.log.join(" ")}`,
  );
});

// ---------------------------------------------------------------------------
// Family E: a local save while another recipient's request is held, and a
// pending write superseded by another tab's newer send mark.

test("model E: a local save commits while another recipient's POST is held", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  const row = rowFor(variants[1], ["a", "b"]);
  const w = world(t, [row], { b: { hold: { post: 5_000 } } });
  let fails = 1;
  w.fault.outcome = (_id, peer, next) =>
    peer === "a" && next.state === "accepted" && fails-- > 0;
  w.engine.start();
  await w.advance(2_000);
  assert.equal(
    w.records.get(row.id)!.peers.a.state,
    "accepted",
    `a after 2 s: ${w.log.join(" ")}`,
  );
  await w.advance(10_000);
  finish(w, "E held sibling", 2);
});
test("model E: a pending refusal superseded by a newer send mark lets its recipient continue", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  const row = rowFor(variants[1], ["self"]);
  const w = world(t, [row], { self: { refuse: true } });
  w.fault.outcome = (_id, _peer, next) => next.state === "refused";
  w.engine.start();
  await w.advance(1_000);
  assert.equal(w.pending.size, 1);
  // Another tab sends again with a newer mark, and the server now accepts.
  w.truth.get(key(row.id, "self"))!.refuse = false;
  w.truth.get(key(row.id, "self"))!.holds = "full";
  w.install(row.id, "self", {
    state: "unknown",
    attempts: 2,
    sendAttempt: "tab2",
    sendStarted: Date.now(),
    attempt: "tab2",
    nextAttempt: Date.now(),
  });
  // Rows that change still fail to save until 40 s. A transaction that
  // changes nothing still commits.
  w.fault.changes = () => w.at() < 40_000;
  const installed = w.at();
  await w.advance(29_000);
  // The newer row's own receipt schedule runs. The old refusal holds nothing.
  assert.ok(
    w.log.some(
      (entry) =>
        entry.includes(":receipt:") && Number(entry.split(":")[0]) > installed,
    ),
    `no lookup after the newer mark: ${w.log.join(" ")}`,
  );
  await w.advance(120_000);
  finish(w, "E superseded", 1);
});

// ---------------------------------------------------------------------------
// Family F: Retry-After on every path that schedules an automatic request.

const retryAnswers: Record<string, { kind: Kind; answer: Answer }> = {
  "a 201 with an unusable body": {
    kind: "post",
    answer: () =>
      new Response("{", { status: 201, headers: { "retry-after": "60" } }),
  },
  "a 404 lookup": {
    kind: "receipt",
    answer: () => json(404, { message: "Not found" }, { "retry-after": "60" }),
  },
  "a 503 POST": {
    kind: "post",
    answer: () => json(503, { message: "Busy" }, { "retry-after": "60" }),
  },
};
for (const [name, { kind, answer }] of Object.entries(retryAnswers))
  test(`model F: Retry-After on ${name} holds automatic requests`, async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
    const row = rowFor(
      variants[1],
      ["self"],
      "g",
      0,
      kind === "receipt" ? { self: { ...SENT, nextAttempt: Date.now() } } : {},
    );
    const w = world(t, [row], { self: { script: { [kind]: [answer] } } });
    w.engine.start();
    await w.advance(300_000);
    finish(w, `F ${name}`, kind === "receipt" ? 1 : 2);
  });
test("model F: a malformed Retry-After date uses ordinary backoff", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  const row = rowFor(variants[1], ["self"]);
  const w = world(t, [row], {
    self: {
      script: {
        post: [
          () => json(503, { message: "Busy" }, { "retry-after": "2050-01-01" }),
        ],
      },
    },
  });
  w.engine.start();
  await w.advance(60_000);
  finish(w, "F malformed date", 2);
});

// ---------------------------------------------------------------------------
// Regressions outside the model: page facts and scan cost.

test("page facts: a held first lookup is not a send, and an unknown outcome is unconfirmed", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  const row = rowFor(variants[1], ["self"]);
  const w = world(t, [row], { self: { hold: { receipt: 5_000 } } });
  nav.onLine = false;
  const trying = w.explicitly(() => w.engine.tryNow(row.id).catch(() => {}));
  await w.advance(1_000);
  const held = w.engine.peerView(w.records.get(row.id)!, "self");
  assert.equal(held.status, "sending");
  assert.doesNotMatch(held.text, /send started/);
  assert.match(
    held.text,
    /Checking whether the server already has this record/,
  );
  await w.advance(5_000);
  await trying;
  nav.onLine = true;
  const unknown = rowFor(variants[1], ["self"], "g", 0, {
    self: { ...SENT, nextAttempt: Date.now() + 60_000 },
  });
  const view = w.engine.view(unknown);
  assert.equal(view.unconfirmed, true);
  assert.equal(view.peers.self.next?.kind, "receipt");
});
test("page facts: a record without recipients is not delivered", () => {
  const empty = { ...rowFor(variants[1], ["self"]), peers: {} };
  const engine = new DeliveryEngine({} as unknown as LocalStore);
  assert.equal(engine.view(empty).delivered, false);
  assert.equal(engine.view(empty).notDelivered, true);
});
test("an idle outbox reads group keys in linear time", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  const count = 160;
  const rows = Array.from({ length: count }, (_, index) => {
    const row = rowFor(variants[1], ["self"], `group-${index}`, 0, {
      self: { ...REFUSED },
    });
    return {
      ...row,
      id: `jve1:${index.toString(16).padStart(64, "0")}`,
      signedAt: index,
    };
  });
  let reads = 0;
  const proxies = rows.map(
    (row) =>
      new Proxy(row, {
        get(target, property, receiver) {
          if (property === "group") reads++;
          return Reflect.get(target, property, receiver);
        },
      }),
  );
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: new EventTarget() },
    document: { configurable: true, value: new EventTarget() },
  });
  const engine = new DeliveryEngine({
    async list() {
      return proxies;
    },
    async get(_store: string, id: string) {
      return proxies.find((row) => row.id === id);
    },
  } as unknown as LocalStore);
  await engine.tick();
  await flush();
  for (const row of proxies) engine.view(row);
  assert.ok(reads <= 8 * count, `${reads} group reads for ${count} records`);
});
