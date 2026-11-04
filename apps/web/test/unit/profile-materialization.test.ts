import { before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { Receipt } from "../../src/model/types.ts";

(globalThis as { location?: unknown }).location = {
  origin: "http://peer.test",
  host: "peer.test",
};
const core = await import("../../../../packages/core/src/index.ts");
const { DeliveryEngine, storedEnvelopeHash } =
  await import("../../src/data/delivery.ts");
const { outboxItem } = await import("../../src/data/lifecycle.ts");
const {
  hasPendingMaterialization,
  forgetMaterializedReceipt,
  rememberAcceptedReceipt,
} = await import("../../src/data/api.ts");

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

function profile(seed = 9) {
  const event = core.createEvent(
    new Uint8Array(32).fill(seed),
    [],
    "1".repeat(32),
    { kind: "identity.profile" },
    { name: "Tester", bio: [], links: [] },
  );
  const identity = event.envelope.header.issuer;
  const item = outboxItem(event, "profile", 0, {
    self: { origin: "http://peer.test", base: "/api/v1", label: "this server" },
  });
  const receipt: Receipt = {
    id: item.id,
    admission: "accepted",
    interpretation: "unavailable",
    body_status: "present",
    body_hash: event.envelope.header.content!.hash,
    envelope_hash: storedEnvelopeHash(item.transport),
    cursor: "x.1",
    snapshot: null,
    view: "jve1:" + "a".repeat(64),
    reasons: ["index_lag", "evaluation_pending"],
  };
  item.peers.self = { ...item.peers.self, state: "accepted", receipt };
  const evidence = new Map<string, unknown>();
  const engine = {
    items: async () => [item],
    store: {
      get: async (store: string, key: string) => {
        assert.equal(store, "prefs");
        return evidence.get(key);
      },
      put: async (store: string, key: string, value: unknown) => {
        assert.equal(store, "prefs");
        evidence.set(key, value);
      },
    },
  } as unknown as InstanceType<typeof DeliveryEngine>;
  const restore = (
    options: Parameters<
      typeof DeliveryEngine.prototype.restorePendingProfileReceipts
    >[1] = {},
    requested = identity,
  ) =>
    DeliveryEngine.prototype.restorePendingProfileReceipts.call(
      engine,
      requested,
      options,
    );
  const completed = {
    ...receipt,
    snapshot: "sha256:" + "a".repeat(64),
    reasons: [],
  };
  return { event, item, receipt, completed, evidence, engine, restore };
}

test("profile waits restore only matching accepted local receipts", async (t) => {
  const fixture = profile();
  const { item, restore, receipt, completed } = fixture;
  let reads = 0;
  t.mock.method(globalThis, "fetch", async () => {
    reads++;
    return Response.json(reads === 1 ? receipt : completed);
  });
  assert.equal(
    await restore({}, core.identityFromSeed(new Uint8Array(32).fill(10))),
    false,
  );
  const origin = item.recipients!.self.origin;
  item.recipients!.self.origin = "http://remote.test";
  assert.equal(await restore(), false);
  item.recipients!.self.origin = origin;
  const body = receipt.body_hash;
  receipt.body_hash = "sha256:" + "0".repeat(64);
  assert.equal(await restore(), false);
  receipt.body_hash = body;
  item.peers.self.state = "unknown";
  assert.equal(await restore(), false);
  item.peers.self.state = "accepted";
  assert.equal(reads, 0);
  assert.equal(hasPendingMaterialization(), false);
  const unchanged = JSON.stringify(item);
  let announced = 0;
  assert.equal(await restore({ pending: () => announced++ }), true);
  assert.equal(announced, 1);
  assert.equal(hasPendingMaterialization(), false);
  assert.equal(fixture.evidence.size, 1);
  assert.equal(JSON.stringify(item), unchanged);
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("No later receipt read is allowed.");
  });
  assert.equal(await restore(), false);
});

test("new completions refresh the cache and completion evidence binds the cursor", async (t) => {
  const { item, receipt, completed, restore, evidence } = profile(11);
  let reads = 0;
  let notices = 0;
  t.mock.method(globalThis, "fetch", async () => {
    reads++;
    return Response.json({ ...completed, cursor: receipt.cursor });
  });
  const unchanged = JSON.stringify(item);
  assert.equal(await restore({ pending: () => notices++ }), true);
  assert.equal(notices, 0);
  assert.equal(reads, 1);
  assert.equal(await restore(), false);
  assert.equal(reads, 1);
  receipt.cursor = "x.2";
  assert.equal(await restore(), true);
  assert.equal(reads, 2);
  assert.equal(evidence.size, 2);
  receipt.cursor = "x.1";
  assert.equal(JSON.stringify(item), unchanged);
  const anotherDocument = profile(11);
  for (const [key, value] of evidence) anotherDocument.evidence.set(key, value);
  assert.equal(await anotherDocument.restore(), true);
  assert.equal(await anotherDocument.restore(), false);
  assert.equal(reads, 2);
});

test("an uncertain first read refreshes the profile after polling completes", async (t) => {
  const { completed, restore } = profile(12);
  let reads = 0;
  t.mock.method(globalThis, "fetch", async () => {
    if (++reads === 1) throw new TypeError("offline");
    return Response.json(completed);
  });
  let notices = 0;
  assert.equal(await restore({ pending: () => notices++ }), true);
  assert.equal(notices, 0);
  assert.equal(reads, 2);
});

test("profile restoration does not poll another identity's pending receipt", async (t) => {
  const other = profile(13);
  const current = profile(14);
  rememberAcceptedReceipt(other.receipt, {
    id: "self",
    base: "/api/v1",
    label: "local",
  });
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.ok(url.endsWith(encodeURIComponent(current.item.id)));
    return Response.json(current.completed);
  });
  try {
    assert.equal(await current.restore(), true);
    assert.equal(hasPendingMaterialization(), true);
  } finally {
    forgetMaterializedReceipt(other.receipt);
  }
});

test("a failed equivalent-variant read cannot expose an older profile", async (t) => {
  const { receipt, restore } = profile(15);
  receipt.envelope_hash = "sha256:" + "b".repeat(64);
  t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("offline");
  });
  await assert.rejects(restore(), /Its view is still updating/);
});

test("page cancellation stops a stalled variant read", async (t) => {
  const { receipt, restore } = profile(16);
  receipt.envelope_hash = "sha256:" + "b".repeat(64);
  const page = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => (started = resolve));
  let stopped = false;
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string, options: RequestInit) => {
      started();
      return new Promise((_resolve, reject) =>
        options.signal!.addEventListener(
          "abort",
          () => {
            stopped = true;
            reject(options.signal!.reason);
          },
          { once: true },
        ),
      );
    },
  );
  const work = restore({ signal: page.signal });
  await ready;
  page.abort();
  await assert.rejects(work, { name: "AbortError" });
  assert.equal(stopped, true);
});

test("page cancellation stops waiting for a stalled local store", async () => {
  const { engine, restore } = profile(17);
  engine.items = () => new Promise(() => {});
  const page = new AbortController();
  const work = restore({ signal: page.signal });
  page.abort();
  await assert.rejects(work, { name: "AbortError" });
});

test("variant checks and receipt polling use one materialization deadline", async (t) => {
  const { item, event, receipt, restore } = profile(18);
  // Different stored bytes force authentication of the valid server envelope.
  const stored = JSON.parse(item.transport);
  stored.envelope.signature = "0".repeat(128);
  item.transport = JSON.stringify(stored);
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  let deadlines = 0;
  const deadline = new AbortController();
  let pollingStarted!: () => void;
  const polling = new Promise<void>((resolve) => (pollingStarted = resolve));
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    if (ms === 15000) {
      deadlines++;
      return deadline.signal;
    }
    return timeout(ms);
  });
  let receiptReads = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, options: RequestInit) => {
      if (url.includes("/events/")) {
        return Response.json(event.envelope);
      }
      if (++receiptReads === 1) return Response.json(receipt);
      pollingStarted();
      return new Promise((_resolve, reject) => {
        options.signal!.addEventListener(
          "abort",
          () => reject(options.signal!.reason),
          { once: true },
        );
        if (options.signal!.aborted) reject(options.signal!.reason);
      });
    },
  );
  try {
    const work = restore();
    await polling;
    deadline.abort(new DOMException("The deadline expired.", "TimeoutError"));
    await assert.rejects(work, /Its view is still updating/);
    assert.equal(deadlines, 1);
    assert.equal(receiptReads, 2);
  } finally {
    forgetMaterializedReceipt(receipt);
  }
});

test("completion invalidates an older cache even if the page leaves before its next read", async (t) => {
  const { completed, restore } = profile(19);
  t.mock.method(globalThis, "fetch", async () => Response.json(completed));
  const page = new AbortController();
  let cached: string | null = "Older profile";
  await assert.rejects(
    restore({
      signal: page.signal,
      invalidate: () => {
        cached = null;
        page.abort();
      },
    }),
    { name: "AbortError" },
  );
  assert.equal(cached, null);
  assert.equal(await restore(), false);
});
