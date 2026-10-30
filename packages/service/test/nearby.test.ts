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

test("nearby cleanup keeps inner apostrophes and whole words that contain place-like text", () => {
  assert.deepEqual(nearbyQuery("the cu'i midpoint of i'e"), [
    "the",
    "cu'i",
    "midpoint",
    "i'e",
  ]);
  assert.deepEqual(nearbyQuery("mi nelci lo ka'e se citka"), [
    "nelci",
    "ka'e",
    "citka",
  ]);
  assert.deepEqual(nearbyQuery("x1 is a box1 of max2 items"), [
    "box1",
    "max2",
    "items",
  ]);
  assert.deepEqual(
    nearbyQuery("$x_1$ (cu'i), \"i'e\" 4x4 x_2 x_{3} thin-walled"),
    ["cu'i", "i'e", "4x4", "thin-walled"],
  );
});

test("circled and braced place markers separate adjacent words", () => {
  assert.deepEqual(nearbyQuery("①eats ②"), ["eats"]);
  assert.deepEqual(nearbyQuery("㉑eats ㉟food ㊱slowly ㊿"), [
    "eats",
    "food",
    "slowly",
  ]);
  assert.deepEqual(nearbyQuery("x₁ bowl ①bowl"), ["bowl"]);
  assert.deepEqual(nearbyQuery("before{place 2}after ⑳thin"), [
    "before",
    "after",
    "thin",
  ]);
  assert.deepEqual(nearbyQuery("box1 max2 4x4 cu'i x1"), [
    "box1",
    "max2",
    "4x4",
    "cu'i",
  ]);
});
