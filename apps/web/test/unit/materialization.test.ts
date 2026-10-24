import assert from "node:assert/strict";
import { test } from "node:test";
import type { Receipt } from "../../src/model/types.ts";

(globalThis as { location?: unknown }).location = {
  host: "local.test",
  origin: "http://local.test",
};
const {
  getWord,
  getIdentity,
  getManifest,
  selfPeer,
  rememberAcceptedReceipt,
  hasPendingMaterialization,
  MaterializationPendingError,
} = await import("../../src/data/api.ts");
const id = "jve1:" + "a".repeat(64);
const word = "jvw1:" + "b".repeat(64);
const snapshot = "sha256:" + "c".repeat(64);
function receipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    id,
    admission: "accepted",
    interpretation: "unavailable",
    body_status: "present",
    cursor: "local.1",
    snapshot: null,
    view: "jve1:" + "d".repeat(64),
    reasons: ["index_lag", "evaluation_pending"],
    envelope_hash: "sha256:" + "e".repeat(64),
    body_hash: "sha256:" + "f".repeat(64),
    ...overrides,
  };
}
const completed = () =>
  receipt({
    snapshot,
    interpretation: "pending",
    reasons: ["missing_prerequisite"],
  });
const response = () => ({
  snapshot,
  view: receipt().view,
  calculation: null,
  word: null,
  definitions: [],
  rafsi: [],
  assignments: [],
  scores: [],
  statuses: [],
  layers: [],
  unavailable_scores: [],
});
function serve(
  handler: (path: string, signal: AbortSignal) => unknown | Promise<unknown>,
) {
  globalThis.fetch = (async (input, options) => {
    const value = await handler(String(input), options!.signal!);
    if (value instanceof Response) return value;
    return new Response(JSON.stringify(value));
  }) as typeof fetch;
}
test("fresh local words wait for exact accepted receipts and keep response provenance", async () => {
  rememberAcceptedReceipt(receipt(), {
    ...selfPeer,
    base: "http://local.test/api/v1",
  });
  let resolve!: (value: Receipt) => void;
  const gate = new Promise<Receipt>((done) => {
    resolve = done;
  });
  const paths: string[] = [];
  serve((path) => {
    paths.push(path);
    return path.includes("/receipts/") ? gate : response();
  });
  const pending = getWord(word, { fresh: true, view: receipt().view });
  assert.equal(paths.length, 1);
  assert.match(paths[0], /\/receipts\//);
  resolve(completed());
  const result = await pending;
  assert.equal(result.snapshot, snapshot);
  assert.equal(result.view, receipt().view);
  assert.equal(paths.length, 2);
  assert.ok(!paths[1].includes("snapshot="));
  assert.equal(hasPendingMaterialization(), false);
});
test("ordinary, historical, and remote reads do not wait for local materialization", async () => {
  rememberAcceptedReceipt(receipt(), selfPeer);
  const paths: string[] = [];
  serve((path) => {
    paths.push(path);
    return response();
  });
  await getWord(word, { snapshot, fresh: true });
  await getWord(word, {
    fresh: true,
    peer: { id: "other", base: "/remote", label: "Other" },
  });
  await getWord(word);
  assert.equal(paths.length, 3);
  assert.ok(paths.every((path) => !path.includes("/receipts/")));
  rememberAcceptedReceipt(completed(), selfPeer);
  rememberAcceptedReceipt(receipt(), {
    id: "other",
    base: "/remote",
    label: "Other",
  });
  assert.equal(hasPendingMaterialization(), false);
});
test("navigation cancels the polling delay without clearing accepted delivery evidence", async () => {
  rememberAcceptedReceipt(receipt(), selfPeer);
  let polled!: () => void;
  const firstPoll = new Promise<void>((resolve) => {
    polled = resolve;
  });
  let requests = 0;
  serve(() => {
    requests++;
    polled();
    return receipt();
  });
  const controller = new AbortController();
  const pending = getWord(word, { fresh: true, signal: controller.signal });
  await firstPoll;
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(
    pending,
    (error: unknown) => (error as Error).name === "AbortError",
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 250));
  assert.equal(requests, 1);
  assert.equal(hasPendingMaterialization(), true);
  serve((path) => (path.includes("/receipts/") ? completed() : response()));
  await getWord(word, { fresh: true });
  assert.equal(hasPendingMaterialization(), false);
});
test("transient receipt failures retry before the word request within one deadline", async () => {
  rememberAcceptedReceipt(receipt(), selfPeer);
  const paths: string[] = [];
  const originalTimeout = AbortSignal.timeout;
  let deadlines = 0;
  AbortSignal.timeout = (ms) => {
    if (ms === 15000) deadlines++;
    return originalTimeout(ms);
  };
  try {
    serve((path) => {
      paths.push(path);
      if (!path.includes("/receipts/")) return response();
      if (paths.length === 1) throw new Error("Connection failed.");
      if (paths.length <= 4)
        return new Response(JSON.stringify({ code: "busy" }), {
          status: [500, 503, 599][paths.length - 2],
        });
      return completed();
    });
    await getWord(word, { fresh: true });
    assert.equal(paths.length, 6);
    assert.ok(paths.slice(0, -1).every((path) => path.includes("/receipts/")));
    assert.match(paths.at(-1)!, /\/words\//);
    assert.equal(deadlines, 1);
    assert.equal(hasPendingMaterialization(), false);
  } finally {
    AbortSignal.timeout = originalTimeout;
    rememberAcceptedReceipt(completed(), selfPeer);
  }
});
test("a permanent receipt failure preserves accepted records for a later refresh", async () => {
  rememberAcceptedReceipt(receipt(), selfPeer);
  let requests = 0;
  serve(() => {
    requests++;
    return new Response(JSON.stringify({ code: "withheld" }), { status: 403 });
  });
  await assert.rejects(
    getWord(word, { fresh: true }),
    MaterializationPendingError,
  );
  assert.equal(requests, 1);
  assert.equal(hasPendingMaterialization(), true);
  serve((path) => (path.includes("/receipts/") ? completed() : response()));
  await getWord(word, { fresh: true });
  assert.equal(hasPendingMaterialization(), false);
});
test("a receipt response interrupted during transfer retries before the word request", async () => {
  rememberAcceptedReceipt(receipt(), selfPeer);
  let requests = 0;
  serve((path) => {
    requests++;
    if (requests === 1)
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(
              new TypeError("Connection reset during transfer."),
            );
          },
        }),
      );
    return path.includes("/receipts/") ? completed() : response();
  });
  try {
    await getWord(word, { fresh: true });
    assert.equal(requests, 3);
    assert.equal(hasPendingMaterialization(), false);
  } finally {
    rememberAcceptedReceipt(completed(), selfPeer);
  }
});
test("navigation after a transient receipt failure cancels the retry", async () => {
  rememberAcceptedReceipt(receipt(), selfPeer);
  const controller = new AbortController();
  let requests = 0;
  serve(() => {
    requests++;
    setImmediate(() => controller.abort());
    return new Response(JSON.stringify({ code: "busy" }), { status: 503 });
  });
  try {
    await assert.rejects(
      getWord(word, { fresh: true, signal: controller.signal }),
      (error: unknown) => (error as Error).name === "AbortError",
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    assert.equal(requests, 1);
    assert.equal(hasPendingMaterialization(), true);
  } finally {
    rememberAcceptedReceipt(completed(), selfPeer);
  }
});
test("a mismatched receipt or missing required body cannot clear a pending accepted record", async () => {
  for (const changed of [
    { admission: "refused" as const },
    { id: "jve1:" + "0".repeat(64) },
    { envelope_hash: "sha256:" + "0".repeat(64) },
    { body_hash: "sha256:" + "0".repeat(64) },
    { body_status: "missing" as const },
    { cursor: "local.2" },
    {
      snapshot: null,
      interpretation: "unavailable" as const,
      reasons: ["evaluation_resource_unavailable"],
    },
  ]) {
    rememberAcceptedReceipt(receipt(), selfPeer);
    if (!("admission" in changed))
      rememberAcceptedReceipt({ ...completed(), ...changed }, selfPeer);
    assert.equal(hasPendingMaterialization(), true);
    const controller = new AbortController();
    serve(() => {
      setImmediate(() => controller.abort());
      return { ...completed(), ...changed };
    });
    await assert.rejects(
      getWord(word, { fresh: true, signal: controller.signal }),
    );
    assert.equal(hasPendingMaterialization(), true);
    rememberAcceptedReceipt(completed(), selfPeer);
  }
});
test("a materialization timeout preserves the accepted record for a later refresh", async () => {
  rememberAcceptedReceipt(receipt(), selfPeer);
  const originalTimeout = AbortSignal.timeout;
  const deadline = new AbortController();
  AbortSignal.timeout = (ms) =>
    ms === 15000 ? deadline.signal : originalTimeout(ms);
  try {
    serve(() => {
      setImmediate(() =>
        deadline.abort(new DOMException("Timed out.", "TimeoutError")),
      );
      return receipt();
    });
    await assert.rejects(
      getWord(word, { fresh: true }),
      MaterializationPendingError,
    );
    assert.equal(hasPendingMaterialization(), true);
  } finally {
    AbortSignal.timeout = originalTimeout;
    rememberAcceptedReceipt(completed(), selfPeer);
  }
});
test("repeated transient receipt failures stop at the original materialization deadline", async () => {
  rememberAcceptedReceipt(receipt(), selfPeer);
  const originalTimeout = AbortSignal.timeout;
  const deadline = new AbortController();
  let deadlines = 0;
  let requests = 0;
  AbortSignal.timeout = (ms) => {
    if (ms === 15000) {
      deadlines++;
      return deadline.signal;
    }
    return originalTimeout(ms);
  };
  try {
    serve(() => {
      requests++;
      if (requests === 3)
        setImmediate(() =>
          deadline.abort(new DOMException("Timed out.", "TimeoutError")),
        );
      return new Response(JSON.stringify({ code: "busy" }), { status: 503 });
    });
    await assert.rejects(
      getWord(word, { fresh: true }),
      MaterializationPendingError,
    );
    assert.equal(requests, 3);
    assert.equal(deadlines, 1);
    assert.equal(deadline.signal.aborted, true);
    assert.equal(hasPendingMaterialization(), true);
  } finally {
    AbortSignal.timeout = originalTimeout;
    rememberAcceptedReceipt(completed(), selfPeer);
  }
});

const identity = "ed25519:" + "1".repeat(64);
const identityResponse = () => ({
  snapshot,
  identity,
  actor: identity,
  profile: { state: "none", claims: [] },
  counts: {},
});
const manifestResponse = () => ({ snapshot, packages: [] });
for (const kind of ["profile", "manifest"] as const) {
  test(`a fresh local ${kind} waits before fetching the completed view`, async () => {
    rememberAcceptedReceipt(receipt(), selfPeer);
    let release!: (value: Receipt) => void;
    const gate = new Promise<Receipt>((resolve) => {
      release = resolve;
    });
    const paths: string[] = [];
    serve((path) => {
      paths.push(path);
      return path.includes("/receipts/")
        ? gate
        : kind === "profile"
          ? identityResponse()
          : manifestResponse();
    });
    const pending =
      kind === "profile"
        ? getIdentity(identity, { fresh: true })
        : getManifest({ fresh: true });
    try {
      assert.equal(paths.length, 1);
      assert.match(paths[0], /\/receipts\//);
      release(completed());
      assert.equal((await pending).snapshot, snapshot);
      assert.equal(paths.length, 2);
      assert.ok(!paths[1].includes("snapshot="));
      assert.equal(hasPendingMaterialization(), false);
    } finally {
      release(completed());
      await pending.catch(() => {});
      rememberAcceptedReceipt(completed(), selfPeer);
    }
  });
  test(`cancelling a fresh ${kind} prevents a later view request`, async () => {
    rememberAcceptedReceipt(receipt(), selfPeer);
    const controller = new AbortController();
    let requests = 0;
    serve(() => {
      requests++;
      setImmediate(() => controller.abort());
      return receipt();
    });
    try {
      const options = { fresh: true, signal: controller.signal };
      const pending =
        kind === "profile"
          ? getIdentity(identity, options)
          : getManifest(options);
      await assert.rejects(
        pending,
        (error: unknown) => (error as Error).name === "AbortError",
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      assert.equal(requests, 1);
      assert.equal(hasPendingMaterialization(), true);
    } finally {
      rememberAcceptedReceipt(completed(), selfPeer);
    }
  });
}
test("ordinary, historical, and remote identity and manifest requests remain immediate", async () => {
  rememberAcceptedReceipt(receipt(), selfPeer);
  const paths: string[] = [];
  serve((path) => {
    paths.push(path);
    return path.includes("/identities/")
      ? identityResponse()
      : manifestResponse();
  });
  try {
    await getIdentity(identity);
    await getIdentity(identity, { snapshot, fresh: true });
    const peer = { id: "remote", base: "/remote", label: "Remote" };
    await getIdentity(identity, { fresh: true, peer });
    await getManifest();
    await getManifest({ fresh: true, peer });
    assert.equal(paths.length, 5);
    assert.ok(paths.every((path) => !path.includes("/receipts/")));
    assert.equal(hasPendingMaterialization(), true);
  } finally {
    rememberAcceptedReceipt(completed(), selfPeer);
  }
});
