import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// The API module reads the page origin at load time. Give it one before importing.
(globalThis as { location?: unknown }).location = {
  origin: "http://peer.test",
  host: "peer.test",
};
const core = await import("../../../../packages/core/src/index.ts");
const { askPeers, SCAN_LIMITS, fetchBranches, loadOwnHistory } =
  await import("../../src/data/lifecycle.ts");

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
const seed = new Uint8Array(32).fill(5);
const otherSeed = new Uint8Array(32).fill(6);
const identity = () => core.identityFromSeed(seed);
const successor = () => core.identityFromSeed(otherSeed);
const snapshot = "sha256:" + "a".repeat(64);
const peer = { id: "mirror", base: "http://peer.test/api/v1", label: "mirror" };
type Route = (url: URL) => unknown;
/** Serves JSON routes through a mocked fetch. Unknown paths answer 404. */
function serve(routes: Record<string, Route>, accepted = true) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const key = Object.keys(routes).find((prefix) =>
      url.pathname.startsWith(prefix),
    );
    if (!key)
      return new Response(
        JSON.stringify({ code: "missing", message: "No route." }),
        {
          status: 404,
          headers: { "content-type": "application/json" },
        },
      );
    const body = routes[key](url);
    if (body instanceof Response) return body;
    if (
      accepted &&
      url.searchParams.get("accepted") === "1" &&
      body &&
      typeof body === "object" &&
      "items" in body
    )
      (body as Record<string, unknown>).history = "accepted";
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}
function manifest() {
  return {
    snapshot,
    logical_inventory: snapshot,
    manifest: {},
    accepted_cursor: "x.1",
    materialized_cursor: "x.1",
    packages: [],
  };
}
function transferEvent() {
  return core.createEvent(
    seed,
    [],
    "1".repeat(32),
    { kind: "identity.transfer", successor: successor() },
    null,
  ).envelope;
}

test("a transfer listed after the first activity page is found and authenticated", async () => {
  const transfer = transferEvent();
  const filler = (n: number) => ({
    id: "jve1:" + n.toString(16).padStart(64, "0"),
    action: { kind: "judgment.set" },
    interpretation: "effective",
    seen: null,
  });
  serve({
    "/api/v1/manifest": manifest,
    "/api/v1/identity-heads/": () => ({
      snapshot,
      identity: identity(),
      heads: [],
      next: null,
    }),
    "/api/v1/identities/": (url) => {
      const after = url.searchParams.get("after");
      if (!after)
        return {
          snapshot,
          view: "jve1:" + "0".repeat(64),
          identity: identity(),
          items: [filler(1), filler(2)],
          next: filler(2).id,
        };
      return {
        snapshot,
        view: "jve1:" + "0".repeat(64),
        identity: identity(),
        items: [
          {
            id: transfer.id,
            action: transfer.header.action,
            interpretation: "effective",
            seen: null,
          },
        ],
        next: null,
      };
    },
    "/api/v1/events/": () => transfer,
  });
  const [knowledge] = await askPeers([peer], identity(), null);
  assert.equal(knowledge.complete, true);
  assert.equal(knowledge.outcome, "complete");
  assert.equal(knowledge.status, "answered");
  assert.deepEqual(knowledge.transfers, [
    { id: transfer.id, successor: successor() },
  ]);
  assert.deepEqual(knowledge.unverified, []);
});

test("a scan that never reaches a terminal cursor is reported incomplete and blocks nothing silently", async () => {
  let page = 0;
  serve({
    "/api/v1/manifest": manifest,
    "/api/v1/identity-heads/": () => {
      page++;
      const head = "jve1:" + page.toString(16).padStart(64, "0");
      return { snapshot, identity: identity(), heads: [head], next: head };
    },
    "/api/v1/identities/": () => ({
      snapshot,
      view: "jve1:" + "0".repeat(64),
      identity: identity(),
      items: [],
      next: null,
    }),
  });
  const [knowledge] = await askPeers([peer], identity(), null);
  assert.equal(knowledge.complete, false);
  assert.match(
    knowledge.status,
    /^incomplete: the head scan did not end within/,
  );
  assert.ok(page <= SCAN_LIMITS.pages + 1);
});

test("a repeated activity cursor is a malformed scan, not an answer", async () => {
  serve({
    "/api/v1/manifest": manifest,
    "/api/v1/identity-heads/": () => ({
      snapshot,
      identity: identity(),
      heads: [],
      next: null,
    }),
    "/api/v1/identities/": () => ({
      snapshot,
      view: "jve1:" + "0".repeat(64),
      identity: identity(),
      items: [],
      next: "jve1:" + "f".repeat(64),
    }),
  });
  const [knowledge] = await askPeers([peer], identity(), null);
  assert.equal(knowledge.complete, false);
  assert.equal(knowledge.outcome, "malformed");
  assert.match(knowledge.status, /repeated or malformed a cursor/);
});

test("a listed transfer that the peer cannot supply as a valid signed record is unverified, not evidence", async () => {
  const transfer = transferEvent();
  const forged = core.createEvent(
    otherSeed,
    [],
    "2".repeat(32),
    { kind: "identity.transfer", successor: successor() },
    null,
  ).envelope;
  serve({
    "/api/v1/manifest": manifest,
    "/api/v1/identity-heads/": () => ({
      snapshot,
      identity: identity(),
      heads: [],
      next: null,
    }),
    "/api/v1/identities/": () => ({
      snapshot,
      view: "jve1:" + "0".repeat(64),
      identity: identity(),
      items: [
        {
          id: transfer.id,
          action: transfer.header.action,
          interpretation: "effective",
          seen: null,
        },
      ],
      next: null,
    }),
    // The peer answers the claimed ID with a record signed by another key.
    "/api/v1/events/": () => forged,
  });
  const [knowledge] = await askPeers([peer], identity(), null);
  assert.equal(knowledge.complete, true);
  assert.equal(knowledge.outcome, "malformed");
  assert.deepEqual(knowledge.transfers, []);
  assert.equal(knowledge.unverified.length, 1);
  assert.match(knowledge.status, /could not supply as valid signed evidence/);
});

test("an activity page for another snapshot and an unreachable peer are told apart", async () => {
  serve({
    "/api/v1/manifest": manifest,
    "/api/v1/identity-heads/": () => ({
      snapshot,
      identity: identity(),
      heads: [],
      next: null,
    }),
    "/api/v1/identities/": () => ({
      snapshot: "sha256:" + "b".repeat(64),
      view: "jve1:" + "0".repeat(64),
      identity: identity(),
      items: [],
      next: null,
    }),
  });
  const [mismatched] = await askPeers([peer], identity(), null);
  assert.equal(mismatched.outcome, "malformed");
  assert.match(mismatched.status, /another snapshot/i);
  serve({});
  const [down] = await askPeers([peer], identity(), null);
  assert.equal(down.outcome, "unreachable");
  assert.equal(down.complete, false);
});

test("transport failures and unreadable pages after the heads arrived are partial or malformed, never unreachable", async () => {
  const headsRoute = () => ({
    snapshot,
    identity: identity(),
    heads: ["jve1:" + "b".repeat(64)],
    next: null,
  });
  const cases: [string, () => unknown, string, RegExp][] = [
    [
      "lost connection",
      () => {
        throw new TypeError("Failed to fetch");
      },
      "partial",
      /incomplete: the activity scan stopped \(No connection to the server\.\)/,
    ],
    [
      "timeout",
      () => {
        throw new DOMException("Timed out", "TimeoutError");
      },
      "partial",
      /incomplete: the activity scan stopped \(The server did not answer in time\.\)/,
    ],
    [
      "unreadable shape",
      () => ({
        snapshot,
        identity: identity(),
        items: "not an array",
        next: null,
      }),
      "malformed",
      /malformed answer: The server returned an invalid activity page\./,
    ],
  ];
  for (const [name, activity, outcome, status] of cases) {
    serve({
      "/api/v1/manifest": manifest,
      "/api/v1/identity-heads/": headsRoute,
      "/api/v1/identities/": activity,
    });
    const [knowledge] = await askPeers([peer], identity(), null);
    assert.equal(knowledge.outcome, outcome, name);
    assert.equal(knowledge.complete, false, name);
    assert.deepEqual(knowledge.heads, ["jve1:" + "b".repeat(64)], name);
    assert.match(knowledge.status, status, name);
  }
});

test("the compromise preview handles a 4096 event chain without recursion", async () => {
  const { causalOrder, cutoffPreview } =
    await import("../../src/data/lifecycle.ts");
  const events = new Map();
  let previous: string[] = [];
  for (let n = 4096; n > 0; n--) {
    const id = "jve1:" + n.toString(16).padStart(64, "0");
    events.set(id, {
      id,
      header: {
        issuer: identity(),
        previous,
        action: { kind: "judgment.set" },
      },
    });
    previous = [id];
  }
  const history = {
    identity: identity(),
    events,
    frontier: previous,
    complete: true,
  } as any;
  assert.equal(causalOrder(history).order.length, 4096);
  const preview = cutoffPreview(history, [
    "jve1:" + (2049).toString(16).padStart(64, "0"),
  ]);
  assert.equal(preview.retained.length, 2048);
  assert.equal(preview.excluded.length, 2048);
});

test("the first raw head page captures accepted history and every later read pins it", async () => {
  const transfer = transferEvent();
  const head = "jve1:" + "0".repeat(64);
  let headPages = 0;
  let activityPages = 0;
  serve({
    "/api/v1/manifest": () => {
      throw new Error("Lifecycle scans must not use the completed manifest.");
    },
    "/api/v1/identity-heads/": (url) => {
      headPages++;
      if (headPages === 1) {
        assert.equal(url.searchParams.has("snapshot"), false);
        return { snapshot, identity: identity(), heads: [head], next: head };
      }
      assert.equal(url.searchParams.get("snapshot"), snapshot);
      assert.equal(url.searchParams.get("after"), head);
      return {
        snapshot,
        identity: identity(),
        heads: [transfer.id],
        next: null,
      };
    },
    "/api/v1/identities/": (url) => {
      activityPages++;
      assert.equal(url.searchParams.get("accepted"), "1");
      assert.equal(url.searchParams.get("snapshot"), snapshot);
      return {
        snapshot,
        identity: identity(),
        items: [
          {
            id: transfer.id,
            action: transfer.header.action,
            interpretation: "unavailable",
            seen: null,
          },
        ],
        next: null,
      };
    },
    "/api/v1/events/": (url) => {
      assert.equal(url.searchParams.get("snapshot"), snapshot);
      return transfer;
    },
  });
  const [knowledge] = await askPeers([peer], identity(), null);
  assert.equal(knowledge.outcome, "complete");
  assert.equal(headPages, 2);
  assert.equal(activityPages, 1);
  assert.deepEqual(knowledge.transfers, [
    { id: transfer.id, successor: successor() },
  ]);
});

test("a peer that ignores accepted history mode blocks the lifecycle scan", async () => {
  serve(
    {
      "/api/v1/identity-heads/": () => ({
        snapshot,
        identity: identity(),
        heads: [],
        next: null,
      }),
      "/api/v1/identities/": () => ({
        snapshot,
        identity: identity(),
        items: [],
        next: null,
      }),
    },
    false,
  );
  const [knowledge] = await askPeers([peer], identity(), null);
  assert.equal(knowledge.outcome, "malformed");
  assert.equal(knowledge.complete, false);
  assert.match(knowledge.status, /did not confirm accepted history/);
});

test("a malformed first accepted head page is reported as malformed rather than unreachable", async () => {
  serve({
    "/api/v1/identity-heads/": () => ({
      snapshot: "invalid",
      identity: identity(),
      heads: [],
      next: null,
    }),
  });
  const [knowledge] = await askPeers([peer], identity(), null);
  assert.equal(knowledge.outcome, "malformed");
  assert.equal(knowledge.complete, false);
});

function expired(status = 410, code = "snapshot_expired") {
  return new Response(JSON.stringify({ code, message: "Snapshot expired." }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
const nextSnapshot = "sha256:" + "b".repeat(64);
function emptyHistory() {
  const saved: string[][] = [];
  return {
    saved,
    get: async () => [],
    list: async () => [],
    rememberOwn: async (_identity: string, records: { id: string }[]) => {
      saved.push(records.map((record) => record.id));
    },
    recordBranch: async (_identity: string, records: { id: string }[]) => {
      saved.push(records.map((record) => record.id));
    },
  };
}

test("ordinary own history pins the completed manifest while accepted history is an explicit choice", async () => {
  for (const accepted of [false, true]) {
    let manifests = 0;
    const captures: (string | null)[] = [];
    serve({
      "/api/v1/manifest": () => {
        manifests++;
        return { snapshot, packages: [] };
      },
      "/api/v1/identity-heads/": (url) => {
        const pinned = url.searchParams.get("snapshot");
        captures.push(pinned);
        return {
          snapshot: pinned ?? nextSnapshot,
          identity: identity(),
          heads: [],
          next: null,
        };
      },
    });
    const history = await loadOwnHistory(
      emptyHistory() as any,
      identity(),
      accepted ? { peer, accepted } : { peer },
    );
    assert.equal(history.snapshot, accepted ? nextSnapshot : snapshot);
    assert.equal(manifests, accepted ? 0 : 1);
    assert.deepEqual(captures, [accepted ? null : snapshot]);
  }
});

for (const stage of ["heads", "activity", "envelope"] as const) {
  test(`accepted peer scan restarts after ${stage} expiry and drops old evidence`, async () => {
    const transfer = transferEvent();
    let captures = 0;
    serve({
      "/api/v1/identity-heads/": (url) => {
        if (!url.searchParams.has("snapshot")) captures++;
        const current = captures === 1 ? snapshot : nextSnapshot;
        if (captures === 1 && url.searchParams.has("after")) return expired();
        const heads = captures === 1 ? [transfer.id] : [];
        return {
          snapshot: current,
          identity: identity(),
          heads,
          next: stage === "heads" && captures === 1 ? transfer.id : null,
        };
      },
      "/api/v1/identities/": (url) => {
        assert.equal(url.searchParams.get("accepted"), "1");
        assert.equal(
          url.searchParams.get("snapshot"),
          captures === 1 ? snapshot : nextSnapshot,
        );
        if (captures === 1 && stage === "activity") return expired();
        return {
          snapshot: captures === 1 ? snapshot : nextSnapshot,
          identity: identity(),
          items:
            captures === 1
              ? [
                  {
                    id: transfer.id,
                    action: transfer.header.action,
                    interpretation: "unavailable",
                    seen: null,
                  },
                ]
              : [],
          next: null,
        };
      },
      "/api/v1/events/": () => expired(),
    });
    const [knowledge] = await askPeers([peer], identity(), null);
    assert.equal(captures, 2);
    assert.equal(knowledge.outcome, "complete");
    assert.equal(knowledge.snapshot, nextSnapshot);
    assert.deepEqual(knowledge.heads, []);
    assert.deepEqual(knowledge.transfers, []);
    assert.deepEqual(knowledge.unverified, []);
  });
}

test("persistent accepted expiry stops after three captures as incomplete with no failed evidence", async () => {
  let captures = 0;
  serve({
    "/api/v1/identity-heads/": () => {
      captures++;
      return {
        snapshot,
        identity: identity(),
        heads: [transferEvent().id],
        next: null,
      };
    },
    "/api/v1/identities/": () => expired(),
  });
  const [knowledge] = await askPeers([peer], identity(), null);
  assert.equal(captures, 3);
  assert.equal(knowledge.complete, false);
  assert.equal(knowledge.outcome, "partial");
  assert.match(knowledge.status, /snapshots kept expiring.*Retry/);
  assert.equal(knowledge.snapshot, null);
  assert.deepEqual(knowledge.heads, []);
});

test("expiry retries keep one deadline and one page budget", async () => {
  const oldPages = SCAN_LIMITS.pages;
  const oldTimeout = AbortSignal.timeout;
  let deadlines = 0;
  let captures = 0;
  try {
    SCAN_LIMITS.pages = 3;
    AbortSignal.timeout = (millis) => {
      if (millis === SCAN_LIMITS.millis) deadlines++;
      return oldTimeout.call(AbortSignal, millis);
    };
    serve({
      "/api/v1/identity-heads/": () => {
        captures++;
        return { snapshot, identity: identity(), heads: [], next: null };
      },
      "/api/v1/identities/": () => expired(),
    });
    const [knowledge] = await askPeers([peer], identity(), null);
    assert.equal(knowledge.outcome, "partial");
    assert.match(knowledge.status, /scan limits/);
    assert.equal(captures, 2);
    assert.equal(deadlines, 1);
  } finally {
    SCAN_LIMITS.pages = oldPages;
    AbortSignal.timeout = oldTimeout;
  }
});

test("only HTTP 410 with snapshot_expired restarts a peer scan", async () => {
  for (const [status, code] of [
    [410, "other_error"],
    [503, "snapshot_expired"],
  ] as const) {
    let captures = 0;
    serve({
      "/api/v1/identity-heads/": () => {
        captures++;
        return { snapshot, identity: identity(), heads: [], next: null };
      },
      "/api/v1/identities/": () => expired(status, code),
    });
    const [knowledge] = await askPeers([peer], identity(), null);
    assert.equal(captures, 1);
    assert.equal(knowledge.outcome, "malformed");
  }
});

for (const stage of ["heads", "envelope"] as const) {
  test(`accepted own history restarts after ${stage} expiry without saving failed branches`, async () => {
    const stale = transferEvent();
    const fresh = core.createEvent(
      seed,
      [],
      "3".repeat(32),
      { kind: "identity.merge" },
      null,
    ).envelope;
    const store = emptyHistory();
    let captures = 0;
    serve({
      "/api/v1/identity-heads/": (url) => {
        if (!url.searchParams.has("snapshot")) captures++;
        if (url.searchParams.has("after")) return expired();
        return {
          snapshot: captures === 1 ? snapshot : nextSnapshot,
          identity: identity(),
          heads: [captures === 1 ? stale.id : fresh.id],
          next: captures === 1 && stage === "heads" ? stale.id : null,
        };
      },
      "/api/v1/events/": (url) => {
        if (url.searchParams.get("snapshot") === snapshot)
          return stage === "envelope" ? expired() : stale;
        assert.equal(url.searchParams.get("snapshot"), nextSnapshot);
        return fresh;
      },
    });
    const history = await loadOwnHistory(store as any, identity(), {
      peer,
      accepted: true,
    });
    assert.equal(captures, 2);
    assert.deepEqual([...history.events.keys()], [fresh.id]);
    assert.deepEqual(store.saved, [[fresh.id]]);
  });
}

test("accepted own history bounds expiry retries and does not retry other errors", async () => {
  for (const [status, code, attempts] of [
    [410, "snapshot_expired", 3],
    [410, "other_error", 1],
    [503, "snapshot_expired", 1],
  ] as const) {
    let captures = 0;
    const store = emptyHistory();
    serve({
      "/api/v1/identity-heads/": () => {
        captures++;
        return {
          snapshot,
          identity: identity(),
          heads: [transferEvent().id],
          next: null,
        };
      },
      "/api/v1/events/": () => expired(status, code),
    });
    await assert.rejects(
      loadOwnHistory(store as any, identity(), { peer, accepted: true }),
      attempts === 3 ? /incomplete.*Retry before signing/ : /Snapshot expired/,
    );
    assert.equal(captures, attempts);
    assert.deepEqual(store.saved, []);
  }
});

for (const alwaysExpire of [false, true]) {
  test(`branch expiry ${alwaysExpire ? "exhausts the common retry budget" : "refreshes peer evidence and successor scan"} before any save`, async () => {
    const parent = core.createEvent(
      seed,
      [],
      "4".repeat(32),
      { kind: "identity.merge" },
      null,
    ).envelope;
    const child = core.createEvent(
      seed,
      [parent.id],
      "5".repeat(32),
      { kind: "identity.merge" },
      null,
    ).envelope;
    const fresh = core.createEvent(
      seed,
      [],
      "6".repeat(32),
      { kind: "identity.merge" },
      null,
    ).envelope;
    const acceptance = core.createEvent(
      otherSeed,
      [],
      "7".repeat(32),
      { kind: "identity.accept", transfer: transferEvent().id },
      null,
    ).envelope;
    let captures = 0;
    let successorScans = 0;
    serve({
      "/api/v1/identity-heads/": () => {
        captures++;
        return {
          snapshot: captures === 1 ? snapshot : nextSnapshot,
          identity: identity(),
          heads: [captures === 1 || alwaysExpire ? child.id : fresh.id],
          next: null,
        };
      },
      "/api/v1/identities/": (url) => {
        const who = decodeURIComponent(url.pathname.split("/")[4]);
        if (who === successor()) successorScans++;
        return {
          snapshot: captures === 1 ? snapshot : nextSnapshot,
          identity: who,
          items:
            who === successor() && captures > 1
              ? [
                  {
                    id: acceptance.id,
                    action: acceptance.header.action,
                    interpretation: "unavailable",
                    seen: null,
                  },
                ]
              : [],
          next: null,
        };
      },
      "/api/v1/events/": (url) => {
        const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
        if (id === parent.id) return expired();
        return id === child.id ? child : id === fresh.id ? fresh : acceptance;
      },
    });
    const knowledge = await askPeers([peer], identity(), successor());
    const history = {
      identity: identity(),
      snapshot: null,
      events: new Map(),
      frontier: [],
      complete: true,
    };
    const store = emptyHistory();
    const operation = fetchBranches(store as any, history, knowledge);
    if (alwaysExpire) {
      await assert.rejects(
        operation,
        /snapshots kept expiring.*Retry before signing/,
      );
      assert.equal(captures, 3);
      assert.equal(knowledge[0].outcome, "partial");
      assert.equal(knowledge[0].complete, false);
      assert.deepEqual(knowledge[0].heads, []);
      assert.deepEqual(knowledge[0].acceptances, []);
      assert.deepEqual(store.saved, []);
      assert.equal(history.events.size, 0);
    } else {
      assert.deepEqual(await operation, { fetched: 1 });
      assert.equal(captures, 2);
      assert.equal(successorScans, 2);
      assert.equal(knowledge[0].snapshot, nextSnapshot);
      assert.deepEqual(knowledge[0].heads, [fresh.id]);
      assert.deepEqual(knowledge[0].acceptances, [
        { id: acceptance.id, transfer: transferEvent().id },
      ]);
      assert.deepEqual(store.saved, [[fresh.id]]);
      assert.deepEqual(history.frontier, [fresh.id]);
    }
  });
}

test("an expired claim discards other claims already authenticated in that attempt", async () => {
  const transfer = transferEvent();
  const compromise = core.createEvent(
    seed,
    [],
    "8".repeat(32),
    { kind: "identity.compromise", safe: [] },
    null,
  ).envelope;
  let captures = 0;
  serve({
    "/api/v1/identity-heads/": () => ({
      snapshot: ++captures === 1 ? snapshot : nextSnapshot,
      identity: identity(),
      heads: [],
      next: null,
    }),
    "/api/v1/identities/": () => ({
      snapshot: captures === 1 ? snapshot : nextSnapshot,
      identity: identity(),
      items:
        captures === 1
          ? [transfer, compromise]
              .sort((a, b) => a.id.localeCompare(b.id))
              .map((event) => ({
                id: event.id,
                action: event.header.action,
                interpretation: "unavailable",
                seen: null,
              }))
          : [],
      next: null,
    }),
    "/api/v1/events/": (url) => {
      const sorted = [transfer, compromise].sort((a, b) =>
        a.id.localeCompare(b.id),
      );
      return decodeURIComponent(url.pathname.split("/").at(-1)!) ===
        sorted[0].id
        ? sorted[0]
        : expired();
    },
  });
  const [knowledge] = await askPeers([peer], identity(), null);
  assert.equal(captures, 2);
  assert.equal(knowledge.outcome, "complete");
  assert.deepEqual(knowledge.transfers, []);
  assert.deepEqual(knowledge.compromises, []);
  assert.deepEqual(knowledge.unverified, []);
});

test("expired peer attempts share the item budget", async () => {
  const oldItems = SCAN_LIMITS.items;
  let captures = 0;
  try {
    SCAN_LIMITS.items = 2;
    const transfer = transferEvent();
    serve({
      "/api/v1/identity-heads/": () => ({
        snapshot: ++captures === 1 ? snapshot : nextSnapshot,
        identity: identity(),
        heads: [transfer.id],
        next: null,
      }),
      "/api/v1/identities/": () =>
        captures === 1
          ? expired()
          : {
              snapshot: nextSnapshot,
              identity: identity(),
              items: [
                {
                  id: transfer.id,
                  action: transfer.header.action,
                  interpretation: "unavailable",
                  seen: null,
                },
              ],
              next: null,
            },
    });
    const [knowledge] = await askPeers([peer], identity(), null);
    assert.equal(captures, 2);
    assert.equal(knowledge.outcome, "partial");
    assert.match(knowledge.status, /item limit/);
    assert.deepEqual(knowledge.transfers, []);
  } finally {
    SCAN_LIMITS.items = oldItems;
  }
});

test("accepted own-history retries share the head-page budget and original deadline", async () => {
  const records = Array.from(
    { length: 64 },
    (_, index) =>
      core.createEvent(
        seed,
        [],
        (index + 100).toString(16).padStart(32, "0"),
        { kind: "identity.merge" },
        null,
      ).envelope,
  ).sort((a, b) => a.id.localeCompare(b.id));
  let captures = 0;
  let pages = 0;
  let pageInAttempt = 0;
  let deadlines = 0;
  const oldTimeout = AbortSignal.timeout;
  const store = emptyHistory();
  try {
    AbortSignal.timeout = (millis) => {
      if (millis === 120000) deadlines++;
      return oldTimeout.call(AbortSignal, millis);
    };
    serve({
      "/api/v1/identity-heads/": (url) => {
        if (!url.searchParams.has("snapshot")) {
          captures++;
          pageInAttempt = 0;
        }
        pages++;
        if (captures === 1 && ++pageInAttempt === 32) return expired();
        const index = captures === 1 ? pageInAttempt - 1 : ++pageInAttempt - 1;
        return {
          snapshot: captures === 1 ? snapshot : nextSnapshot,
          identity: identity(),
          heads: [records[index].id],
          next: records[index].id,
        };
      },
      "/api/v1/events/": (url) =>
        records.find(
          (record) =>
            record.id === decodeURIComponent(url.pathname.split("/").at(-1)!),
        ),
    });
    await assert.rejects(
      loadOwnHistory(store as any, identity(), { peer, accepted: true }),
      /browser work limit/,
    );
    assert.equal(captures, 2);
    assert.equal(pages, 64);
    assert.equal(deadlines, 1);
    assert.deepEqual(store.saved, []);
  } finally {
    AbortSignal.timeout = oldTimeout;
  }
});
