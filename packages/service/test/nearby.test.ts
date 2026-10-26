import { test } from "node:test";
import assert from "node:assert/strict";
import { nearbyQuery, rankNearby } from "../src/nearby.ts";
test("nearby queries remove place marks and punctuation, then cap distinct words", () => {
  assert.deepEqual(
    nearbyQuery(
      "$x_1$ thin, $x_{2}$ bowl; x3 wide! ___ {place 4} ① (thin) vessel frame other seventh",
    ),
    ["thin", "bowl", "wide", "vessel", "frame", "other"],
  );
  assert.deepEqual(nearbyQuery("___ $x_{42}$ x_3 ② !!"), []);
});
test("nearby rank counts words, then summed positions, then word ID", () => {
  const a = { word_id: "a" },
    b = { word_id: "b" },
    c = { word_id: "c" },
    d = { word_id: "d" };
  assert.deepEqual(
    rankNearby([
      [b, a, c, d],
      [a, b, d, c],
    ]),
    [a, b, c, d],
  );
  assert.deepEqual(rankNearby([[b, a, a], [a]]), [a, b]);
});
