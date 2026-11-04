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
const { hasPendingMaterialization } = await import("../../src/data/api.ts");

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

test("profile waits restore only matching accepted local receipts", async () => {
  const event = core.createEvent(
    new Uint8Array(32).fill(9),
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
  const restore = (candidate = item, requested = identity) =>
    DeliveryEngine.prototype.restorePendingProfileReceipts.call(
      { items: async () => [candidate] } as unknown as InstanceType<
        typeof DeliveryEngine
      >,
      requested,
    );
  assert.equal(
    await restore(item, core.identityFromSeed(new Uint8Array(32).fill(10))),
    false,
  );
  const remote = structuredClone(item);
  remote.recipients!.self.origin = "http://remote.test";
  assert.equal(await restore(remote), false);
  const mismatched = structuredClone(item);
  mismatched.peers.self.receipt!.body_hash = "sha256:" + "0".repeat(64);
  assert.equal(await restore(mismatched), false);
  const unfinished = structuredClone(item);
  unfinished.peers.self.state = "unknown";
  assert.equal(await restore(unfinished), false);
  assert.equal(hasPendingMaterialization(), false);
  assert.equal(await restore(), true);
  assert.equal(hasPendingMaterialization(), true);
});
