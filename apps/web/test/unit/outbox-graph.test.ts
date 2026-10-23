import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hasOwnDependent,
  remainingHeads,
} from "../../src/data/outbox-graph.ts";

test("discard checks all branches and transitive predecessor links", () => {
  const graph = new Map([
    ["base", []],
    ["middle", ["base"]],
    ["leaf", ["middle"]],
    ["other", []],
  ]);
  assert.equal(hasOwnDependent(graph, "base"), true);
  assert.equal(hasOwnDependent(graph, "middle"), true);
  assert.equal(hasOwnDependent(graph, "leaf"), false);
  assert.equal(hasOwnDependent(graph, "other"), false);
  graph.set("cycle", ["cycle"]);
  assert.equal(hasOwnDependent(graph, "other"), false);
});

test("discard restores retained maximal predecessors and keeps independent heads", () => {
  const graph = new Map([
    ["base", []],
    ["left", ["base"]],
    ["right", ["base"]],
  ]);
  assert.deepEqual(
    remainingHeads(graph, ["discarded", "unfetched"], "discarded"),
    ["left", "right", "unfetched"],
  );
});

test("a long own-history chain marks every ancestor in one pass", async () => {
  const { dependentIds } = await import("../../src/data/outbox-graph.ts");
  const graph = new Map<string, string[]>();
  for (let index = 0; index < 4096; index++)
    graph.set(String(index), index ? [String(index - 1)] : []);
  const dependedOn = dependentIds(graph);
  assert.equal(dependedOn.size, 4095);
  assert.equal(dependedOn.has("0"), true);
  assert.equal(dependedOn.has("4095"), false);
});

test("only compromise, transfer, and acceptance require lifecycle delivery", async () => {
  const { requiresLifecycleDelivery } =
    await import("../../src/data/outbox-graph.ts");
  for (const kind of [
    "identity.compromise",
    "identity.transfer",
    "identity.accept",
    "identity.merge",
    "judgment.set",
  ])
    assert.equal(
      requiresLifecycleDelivery({
        transport: JSON.stringify({
          envelope: { header: { action: { kind } } },
        }),
      } as any),
      kind !== "identity.merge" && kind !== "judgment.set",
    );
});
