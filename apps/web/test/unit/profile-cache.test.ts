import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as { location?: unknown }).location = {
  origin: "http://local.test",
  host: "local.test",
};
const { identityProfile, forgetProfile } =
  await import("../../src/components/attribution.ts");
const { rememberAcceptedReceipt, forgetMaterializedReceipt, selfPeer } =
  await import("../../src/data/api.ts");
const identity = "ed25519:" + "1".repeat(64);
const response = (name: string) =>
  Response.json({
    snapshot: "sha256:" + "a".repeat(64),
    identity,
    actor: identity,
    profile: {
      state: "known",
      claims: [{ body: { name, bio: [], links: [] } }],
    },
    counts: {},
  });

test("profile failures are not cached and successful optional reads are reused", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  forgetProfile(identity);
  let reads = 0;
  t.mock.method(globalThis, "fetch", async () => {
    if (++reads === 1) throw new TypeError("offline");
    return response("Current");
  });
  await assert.rejects(identityProfile(identity));
  assert.equal(
    (await identityProfile(identity)).profile.claims[0].body!.name,
    "Current",
  );
  await identityProfile(identity);
  assert.equal(reads, 2);
});

test("current profile reads keep the page signal without starting another receipt wait", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  forgetProfile(identity);
  const accepted = {
    id: "jve1:" + "b".repeat(64),
    admission: "accepted" as const,
    interpretation: "unavailable" as const,
    body_status: "present" as const,
    body_hash: "sha256:" + "c".repeat(64),
    envelope_hash: "sha256:" + "d".repeat(64),
    cursor: "local.1",
    snapshot: null,
    view: "jve1:" + "e".repeat(64),
    reasons: ["index_lag", "evaluation_pending"],
  };
  rememberAcceptedReceipt(accepted, selfPeer);
  const controller = new AbortController();
  let signal: AbortSignal | null | undefined;
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, options: RequestInit) => {
      assert.match(url, /\/identities\//);
      signal = options.signal;
      return new Promise<Response>((_resolve, reject) =>
        signal!.addEventListener("abort", () => reject(signal!.reason), {
          once: true,
        }),
      );
    },
  );
  const work = identityProfile(identity, {
    fresh: true,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(work, { name: "AbortError" });
  assert.equal(signal?.aborted, true);
  forgetMaterializedReceipt(accepted);
  t.mock.method(globalThis, "fetch", async () => response("Recovered"));
  assert.equal(
    (await identityProfile(identity)).profile.claims[0].body!.name,
    "Recovered",
  );
});

test("an older attribution request cannot overwrite a current profile cache", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  forgetProfile(identity);
  let release!: (value: Response) => void;
  let reads = 0;
  t.mock.method(globalThis, "fetch", async () => {
    if (++reads === 1)
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    return response("New");
  });
  const old = identityProfile(identity);
  assert.equal(
    (await identityProfile(identity, { fresh: true })).profile.claims[0].body!
      .name,
    "New",
  );
  release(response("Old"));
  await old;
  assert.equal(
    (await identityProfile(identity)).profile.claims[0].body!.name,
    "New",
  );
  assert.equal(reads, 2);
});

test("a page does not inherit an attribution request's missing cancellation signal", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  forgetProfile(identity);
  let release!: (value: Response) => void;
  let reads = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string, options: RequestInit) => {
      if (++reads === 1)
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      return new Promise<Response>((_resolve, reject) =>
        options.signal!.addEventListener(
          "abort",
          () => reject(options.signal!.reason),
          { once: true },
        ),
      );
    },
  );
  const optional = identityProfile(identity);
  const controller = new AbortController();
  const page = identityProfile(identity, { signal: controller.signal });
  controller.abort();
  await assert.rejects(page, { name: "AbortError" });
  release(response("Optional"));
  await optional;
  assert.equal(
    (await identityProfile(identity)).profile.claims[0].body!.name,
    "Optional",
  );
  assert.equal(reads, 2);
});
