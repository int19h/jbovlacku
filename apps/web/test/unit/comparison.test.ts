import { test } from "node:test";
import assert from "node:assert/strict";
import { changedItems, sameValue } from "../../src/model/comparison.ts";

test("comparison equality retains node types, array order, and every nested field", () => {
  assert.equal(
    sameValue({ text: [[1]], notes: [] }, { notes: [], text: [[1]] }),
    true,
  );
  assert.equal(sameValue([[{ code: "①" }]], [[1]]), false);
  assert.equal(sameValue(["a", "b"], ["b", "a"]), false);
  assert.equal(sameValue({ value: null }, {}), false);
});

test("sequence alignment keeps middle insertions and removals separate from later items", () => {
  assert.deepEqual(changedItems(["a", "c", "d"], ["a", "b", "c", "d"]), [
    [undefined, "b"],
  ]);
  assert.deepEqual(changedItems(["a", "b", "c", "d"], ["a", "c", "d"]), [
    ["b", undefined],
  ]);
  assert.deepEqual(changedItems(["a", "old", "c"], ["a", "new", "c"]), [
    ["old", "new"],
  ]);
  assert.deepEqual(changedItems(["a", "a", "b"], ["a", "b"]), [
    ["a", undefined],
  ]);
  assert.deepEqual(changedItems(["a", "b"], ["b", "a"]), [
    ["a", undefined],
    [undefined, "a"],
  ]);
  assert.deepEqual(changedItems([], ["a", "b"]), [
    [undefined, "a"],
    [undefined, "b"],
  ]);
  assert.deepEqual(changedItems([{ a: 1, b: 2 }], [{ b: 2, a: 1 }]), []);
});
