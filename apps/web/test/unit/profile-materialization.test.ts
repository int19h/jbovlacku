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
  assert.equal(await restore(), true);
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
  assert.equal(fixture.evidence.size, 2);
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
  const deadline = new AbortController();
  const original = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", (ms: number) =>
    ms === 15000 ? deadline.signal : original(ms),
  );
  t.mock.method(globalThis, "fetch", async () => {
    setImmediate(() =>
      deadline.abort(new DOMException("Timed out.", "TimeoutError")),
    );
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

for (const outcome of [
  "404",
  "refused",
  "withheld",
  "mismatch",
  "not pending",
] as const) {
  for (const phase of ["first read", "poll"] as const) {
    test(`${outcome} during ${phase} stops waiting across visits`, async (t) => {
      const { restore, receipt, completed, evidence, item } = profile(30);
      let reads = 0;
      let warnings = 0;
      const before = JSON.stringify(item);
      t.mock.method(globalThis, "fetch", async () => {
        reads++;
        if (phase === "poll" && reads === 1) return Response.json(receipt);
        if (outcome === "404")
          return Response.json({ code: "missing" }, { status: 404 });
        const changed =
          outcome === "refused"
            ? { admission: "refused" }
            : outcome === "withheld"
              ? { body_status: "withheld", body_hash: null }
              : outcome === "mismatch"
                ? { cursor: "other.1" }
                : { snapshot: null, reasons: ["evaluation_unavailable"] };
        return Response.json({ ...completed, ...changed });
      });
      assert.equal(await restore({ unconfirmable: () => warnings++ }), true);
      assert.equal(hasPendingMaterialization(), false);
      const beforeVisit = reads;
      assert.equal(await restore({ unconfirmable: () => warnings++ }), false);
      assert.equal(reads, beforeVisit);
      assert.equal(warnings, 1);
      assert.equal([...evidence.values()][0], "unconfirmable");
      assert.equal(JSON.stringify(item), before);
      const reloaded = profile(30);
      for (const [key, value] of evidence) reloaded.evidence.set(key, value);
      assert.equal(
        await reloaded.restore({ unconfirmable: () => warnings++ }),
        true,
      );
      assert.equal(warnings, 1);
      assert.equal(reads, beforeVisit);
    });
  }
}

test("failed marker writes do not hide a completed profile", async (t) => {
  const { restore, engine, completed, evidence } = profile(31);
  let reads = 0;
  (engine as any).store.put = async () => {
    throw new Error("Storage is full.");
  };
  t.mock.method(globalThis, "fetch", async () => {
    reads++;
    return Response.json(completed);
  });
  let warnings = 0;
  assert.equal(await restore({ unconfirmable: () => warnings++ }), true);
  assert.equal(await restore({ unconfirmable: () => warnings++ }), false);
  assert.equal(warnings, 0);
  assert.equal(evidence.size, 0);
  assert.equal(reads, 1);
  assert.equal(hasPendingMaterialization(), false);
});

test("malformed profile records and failed outbox reads do not block the profile", async () => {
  const { restore, item, engine } = profile(32);
  item.transport = '{"action":"identity.profile"';
  let warnings = 0;
  assert.equal(await restore({ unconfirmable: () => warnings++ }), false);
  engine.items = async () => {
    throw new Error("The outbox is unreadable.");
  };
  assert.equal(await restore({ unconfirmable: () => warnings++ }), false);
  assert.equal(warnings, 0);
});

test("non-profile records are filtered before transport parsing", async () => {
  const { restore, item } = profile(33);
  let warnings = 0;
  for (const transport of ["not a profile transport", undefined, null, 42]) {
    item.transport = transport as string;
    assert.equal(await restore({ unconfirmable: () => warnings++ }), false);
  }
  assert.equal(warnings, 0);
});

test("a stored profile without its transport body is skipped", async () => {
  const { item, restore } = profile(34);
  const transport = JSON.parse(item.transport);
  delete transport.body;
  item.transport = JSON.stringify(transport);
  let warnings = 0;
  assert.equal(await restore({ unconfirmable: () => warnings++ }), false);
  assert.equal(warnings, 0);
});

test("a marker failure after polling also permits the profile", async (t) => {
  const { restore, engine, receipt, completed } = profile(35);
  (engine as any).store.put = async () => {
    throw new Error("Storage is full.");
  };
  let reads = 0;
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(++reads === 1 ? receipt : completed),
  );
  let warnings = 0;
  assert.equal(await restore({ unconfirmable: () => warnings++ }), true);
  assert.equal(await restore({ unconfirmable: () => warnings++ }), false);
  assert.equal(warnings, 0);
  assert.equal(reads, 2);
  assert.equal(hasPendingMaterialization(), false);
});

for (const phase of ["first read", "poll"] as const) {
  test(`a retried marker write keeps completed evidence during ${phase}`, async (t) => {
    const { restore, engine, receipt, completed, evidence } = profile(36);
    const put = (engine as any).store.put;
    let writes = 0;
    (engine as any).store.put = async (...args: unknown[]) => {
      if (++writes === 1)
        throw new Error("Storage was temporarily unavailable.");
      return put(...args);
    };
    let reads = 0;
    let warnings = 0;
    t.mock.method(globalThis, "fetch", async () =>
      Response.json(++reads === 1 && phase === "poll" ? receipt : completed),
    );
    assert.equal(await restore({ unconfirmable: () => warnings++ }), true);
    assert.equal(await restore({ unconfirmable: () => warnings++ }), false);
    assert.equal(warnings, 0);
    assert.equal(writes, 2);
    assert.deepEqual([...evidence.values()], [true]);
    assert.equal(reads, phase === "poll" ? 2 : 1);
  });
}

for (const status of [408, 429]) {
  for (const phase of ["first read", "poll"] as const) {
    test(`HTTP ${status} during ${phase} remains transient`, async (t) => {
      const { restore, receipt, completed, evidence } = profile(37);
      let reads = 0;
      let warnings = 0;
      t.mock.method(globalThis, "fetch", async () => {
        reads++;
        if (phase === "poll" && reads === 1) return Response.json(receipt);
        if (reads === (phase === "poll" ? 2 : 1))
          return Response.json({ code: "temporary" }, { status });
        return Response.json(completed);
      });
      assert.equal(await restore({ unconfirmable: () => warnings++ }), true);
      assert.equal(warnings, 0);
      assert.equal(reads, phase === "poll" ? 3 : 2);
      assert.deepEqual([...evidence.values()], [true]);
      assert.equal(hasPendingMaterialization(), false);
    });
  }
}

test("a failed marker read skips only this session without writing evidence", async (t) => {
  const { restore, engine, item, evidence } = profile(38);
  let gets = 0;
  let writes = 0;
  let warnings = 0;
  (engine as any).store.get = async () => {
    gets++;
    throw new Error("Storage was temporarily unavailable.");
  };
  (engine as any).store.put = async () => writes++;
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("This session must skip the unreadable marker.");
  });
  const before = JSON.stringify(item);
  assert.equal(await restore({ unconfirmable: () => warnings++ }), true);
  assert.equal(await restore({ unconfirmable: () => warnings++ }), false);
  assert.equal(gets, 1);
  assert.equal(writes, 0);
  assert.equal(warnings, 0);
  assert.equal(evidence.size, 0);
  assert.equal(JSON.stringify(item), before);
  const reloaded = profile(38);
  let reads = 0;
  t.mock.method(globalThis, "fetch", async () => {
    reads++;
    return Response.json(reloaded.completed);
  });
  assert.equal(await reloaded.restore(), true);
  assert.equal(reads, 1);
  assert.deepEqual([...reloaded.evidence.values()], [true]);
});

test("rebuilding deleted completion evidence still requires a current profile", async (t) => {
  const { restore, completed, evidence } = profile(39);
  let invalidations = 0;
  let reads = 0;
  const options = { invalidate: () => invalidations++ };
  t.mock.method(globalThis, "fetch", async () => {
    reads++;
    return Response.json(completed);
  });
  assert.equal(await restore(options), true);
  evidence.clear();
  assert.equal(await restore(options), true);
  assert.equal(await restore(options), false);
  assert.equal(invalidations, 2);
  assert.equal(reads, 2);
});

test("rebuilding an unconfirmable marker does not repeat its notice", async (t) => {
  const { restore, evidence } = profile(40);
  let warnings = 0;
  const options = { unconfirmable: () => warnings++ };
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ code: "missing" }, { status: 404 }),
  );
  assert.equal(await restore(options), true);
  evidence.clear();
  assert.equal(await restore(options), true);
  assert.equal(warnings, 1);
});

test("a 404 with failed marker writes can repeat its notice in a new engine", async (t) => {
  const engines = [profile(41), profile(41)];
  assert.equal(engines[0].item.id, engines[1].item.id);
  let reads = 0;
  let notices = 0;
  t.mock.method(globalThis, "fetch", async () => {
    reads++;
    return Response.json({ code: "missing" }, { status: 404 });
  });
  for (const [index, fixture] of engines.entries()) {
    let writes = 0;
    const unchanged = JSON.stringify(fixture.item);
    (fixture.engine as any).store.put = async () => {
      writes++;
      throw new Error("Storage is full.");
    };
    const options = { unconfirmable: () => notices++ };
    assert.equal(await fixture.restore(options), true);
    assert.equal(await fixture.restore(options), false);
    assert.equal(writes, 2);
    assert.equal(reads, index + 1);
    assert.equal(notices, index + 1);
    assert.equal(fixture.evidence.size, 0);
    assert.equal(JSON.stringify(fixture.item), unchanged);
    assert.equal(hasPendingMaterialization(), false);
  }
});
