import { test } from "node:test";
import assert from "node:assert/strict";
import { convertPlaces, PLACE_CONVERSION_VERSION } from "../src/places.ts";

test("explicit x-place forms retain Unicode scalar source spans and declare only observed places", () => {
  const source =
    "😀 $x_{1}$ contains x_3 and \\(x_{12}\\), $$ x_2 $$, \\[x_5\\].";
  const converted = convertPlaces(source, "/definitions/definition");
  assert.deepEqual(converted.text, [
    ["😀 ", 1, " contains ", 3, " and ", 12, ", ", 2, ", ", 5, "."],
  ]);
  assert.deepEqual(converted.frame, {
    role: "predicate",
    arity: { mode: "context" },
    places: [1, 2, 3, 5, 12].map((index) => ({ index })),
  });
  assert.equal(converted.conversion.version, PLACE_CONVERSION_VERSION);
  assert.deepEqual(converted.conversion.mappings[0], {
    field: "/definitions/definition",
    start: 2,
    end: 9,
    place: 1,
  });
  for (const mapping of converted.conversion.mappings) {
    const span = [...source].slice(mapping.start, mapping.end).join("");
    assert.match(
      span,
      new RegExp(`x_(?:${mapping.place}|\\{${mapping.place}\\})`),
    );
  }
});

test("equations, component variables, quotations, nested relations and malformed math stay literal", () => {
  for (const source of [
    "$x_{1} = g_{1}$",
    "$x_1 + x_2$",
    "g_1 and m_4",
    "x_1 = g_1",
    '"x_1 sees x_2"',
    "`x_1`",
    "(x_1 sees x_2)",
    "lu x_1 li'u",
    "lo'u x_2 le'u",
    "ax_1",
    "x_1a",
    "x_{01}",
    "x_0",
    "x_65536",
    "x_1^2",
    "x_1_{2}",
    "\\text{x_1}",
    "$x_1",
    "\\(x_1",
    "x1",
    '"x_1',
    "'x_1'",
    "((x_1) means x_2)",
    "([x_1) and x_2]",
    "zoi gy. x_1 gy.",
    "la'o gy. x_1 gy.",
    "zo x_1",
    "lu x_1",
    "lo'u x_1",
    "$$x_1$",
    "$x_1$$",
  ]) {
    const converted = convertPlaces(source, "/definition");
    assert.deepEqual(converted.text, [[source]], source);
    assert.equal(converted.frame, null, source);
    assert.equal(converted.conversion.method, "literal", source);
    assert.deepEqual(converted.conversion.mappings, [], source);
  }
});

test("mixed real TeX forms convert conservative places and retain unresolved expressions", () => {
  const source =
    "$x_{1}$ runs on surface $x_{2}$ using limbs $x_{3}$ with gait $x_{4}$. g_1=m_4. $x_2 + 1$";
  const converted = convertPlaces(source, "/definition");
  assert.deepEqual(
    converted.conversion.mappings.map((item) => item.place),
    [1, 2, 3, 4],
  );
  assert.ok(converted.conversion.warnings.length > 0);
  assert.deepEqual(converted.unresolved, { g_1: 1, m_4: 1, "$x_2 + 1$": 1 });
  assert.equal(convertPlaces("", "/definition").text.length, 0);
});

test("a long literal word preserves its boundary before a later place", () => {
  const literal = "a".repeat(100000);
  assert.deepEqual(convertPlaces(literal + " x_1", "/definition").text, [
    [literal + " ", 1],
  ]);
});
