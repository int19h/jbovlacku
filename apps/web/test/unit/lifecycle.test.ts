import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// The API module reads the page origin at load time. Give it one before importing.
(globalThis as { location?: unknown }).location = {
  origin: "http://peer.test",
  host: "peer.test",
};
const core = await import("../../../../packages/core/src/index.ts");
const { askPeers, SCAN_LIMITS } = await import("../../src/data/lifecycle.ts");

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
function serve(routes: Record<string, Route>) {
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
  assert.match(mismatched.status, /another snapshot/);
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
