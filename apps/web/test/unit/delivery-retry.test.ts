import { test } from "node:test";
import assert from "node:assert/strict";

(globalThis as { window?: unknown }).window = {
  addEventListener() {},
};
(globalThis as { document?: unknown }).document = {
  addEventListener() {},
};
(globalThis as { location?: unknown }).location = {
  origin: "http://peer.test",
  host: "peer.test",
};

const { DeliveryEngine, freshPeer } = await import(
  "../../src/data/delivery.ts"
);

function stored(id: string, order: number, stopped: boolean) {
  return {
    id,
    group: "g",
    order,
    stopped,
    signedAt: order,
    label: { subject: id, action: "judgment", href: "/" },
    transport: "{}",
    peers: {
      self: {
        ...freshPeer(),
        state: "refused" as const,
        origin: "http://peer.test",
        base: "/api/v1",
        label: "this server",
      },
    },
  };
}

function fakeEngine(items: ReturnType<typeof stored>[]) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const store = {
    get: async (_name: string, id: string) => byId.get(id),
    list: async () => [...byId.values()],
    mergeOutbox: async (
      id: string,
      update: (item: (typeof items)[number]) => (typeof items)[number],
    ) => {
      const next = update(byId.get(id)!);
      byId.set(id, next);
      return next;
    },
  };
  const engine = new DeliveryEngine(store as never);
  const counts = new Map<string, number>();
  (engine as unknown as { attempt: unknown }).attempt = async (
    item: { id: string },
    _peerId: string,
    peer: Record<string, unknown>,
    _started: number,
    attemptId: string,
  ) => {
    counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
    return { ...peer, state: "accepted", attempt: attemptId, nextAttempt: null };
  };
  return { engine, counts, byId };
}

test("an explicit attempt does not start for a stopped record", async () => {
  const { engine, counts } = fakeEngine([stored("a", 0, true)]);
  await engine.deliver("a", true);
  assert.equal(counts.get("a") ?? 0, 0);
});

test("a stop stored during the earlier record keeps the later record waiting", async () => {
  const transfer = stored("transfer", 0, false);
  const accept = stored("accept", 1, false);
  const { engine, counts, byId } = fakeEngine([transfer, accept]);
  const original = (engine as unknown as { attempt: Function }).attempt;
  (engine as unknown as { attempt: unknown }).attempt = async (
    item: { id: string },
    ...rest: unknown[]
  ) => {
    const result = await (original as Function)(item, ...rest);
    if (item.id === "transfer")
      byId.set("accept", { ...byId.get("accept")!, stopped: true });
    return result;
  };
  await engine.deliver("accept", true);
  assert.equal(counts.get("transfer"), 1);
  assert.equal(counts.get("accept") ?? 0, 0);
});

test("one explicit delivery attempts each group record once, transfer first", async () => {
  const { engine, counts } = fakeEngine([
    stored("transfer", 0, false),
    stored("accept", 1, false),
  ]);
  await engine.deliver("accept", true);
  assert.equal(counts.get("transfer"), 1);
  assert.equal(counts.get("accept"), 1);
});
