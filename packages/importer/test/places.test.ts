import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
    "x_1 · x_2",
    "x_1: x_2",
    "x_1 ∈ S",
    "x_1 ≤ x_2",
    "x_1 → x_2",
    "x_1–x_2",
    "$x_1$ - $x_2$",
    "$x_1$ — g_1",
    "$x_1$-1",
    "$x_1$ - y",
    "$x_1$ - α",
    "$x_1$ - ٢",
    "$x_1$ - x2",
    "$x_1$ - foo_1",
    "f(($x_1$))",
    "[$x_1$ + $x_2$]",
    "($x_1$/$x_2$)",
    "($x_1$)^2",
    "2*($x_1$)",
    "f($x_1$)",
    "$x_1$ + ($x_2$)",
    "$x_1$ - \\alpha",
    "x_1 \\times x_2",
    '"x_1 sees x_2"',
    "`x_1`",
    "``x_1``",
    "```x_1```",
    "``x_1''",
    "“x_1 sees x_2”",
    "«x_1 sees x_2»",
    "(x_1 sees x_2)",
    "lu x_1 li'u",
    "lo'u x_2 le'u",
    "ax_1",
    "a$x_1$",
    "$x_1$b",
    "$x_5$th",
    "$x_2$s",
    "1$x_1$0**-15",
    "１$x_1$",
    "α$x_1$",
    "a\u0301$x_1$",
    "$x_1$\u0301",
    "$x_1$б",
    "ع$x_1$",
    "漢x_1",
    "x_1a",
    "a\u0301x_1",
    "x_1\u0301",
    "x_{01}",
    "x_0",
    "x_65536",
    "x_1^2",
    "x_1_{2}",
    "\\text{x_1}",
    "$x_1",
    "\\(x_1",
    "\\[x_1\\)",
    "\\(x_1\\]",
    "x1",
    '"x_1',
    "'x_1'",
    "((x_1) means x_2)",
    "([x_1) and x_2]",
    "zoi gy. x_1 gy.",
    "la'o gy. x_1 gy.",
    "zo x_1",
    "lu x_1",
    "lu.$x_1$ li'u",
    "lo'u.$x_1$ le'u",
    "zo.$x_1$",
    "lo'u x_1",
    "$$x_1$",
    "$x_1$$",
    "x_1$",
    "x_1$$",
    "x_1\\)",
    "x_1\\]",
    "$5 and $x_1$",
  ]) {
    const converted = convertPlaces(source, "/definition");
    assert.deepEqual(converted.text, [[source]], source);
    assert.equal(converted.frame, null, source);
    assert.equal(converted.conversion.method, "literal", source);
    assert.deepEqual(converted.conversion.mappings, [], source);
  }
});

test("finished places next to CJK scripts and punctuation need no spaces", () => {
  for (const char of [
    "漢",
    "𠀀",
    "あ",
    "ア",
    "ー",
    "가",
    "。",
    "、",
    "（",
    "）",
  ]) {
    const source = `${char}$x_1$${char}`;
    const result = convertPlaces(source, "/definition");
    assert.deepEqual(result.text, [[char, 1, char]], source);
    assert.equal(result.conversion.mappings[0].start, 1, source);
    assert.equal(result.conversion.mappings[0].end, 6, source);
  }
});

test("apostrophe cmavo do not open lu quotations", () => {
  for (const cmavo of ["lu'e", "lu'a", "lu'o"]) {
    const source = `${cmavo} $x_3$ via $x_4$`;
    const result = convertPlaces(source, "/definition");
    assert.deepEqual(result.text, [[`${cmavo} `, 3, " via ", 4]]);
    assert.deepEqual(result.unresolved, {});
  }
});

test("real capture places retain expected frames and exact source spans", () => {
  const capture = JSON.parse(
    readFileSync(
      new URL("../fixtures/place-prose-capture.json", import.meta.url),
      "utf8",
    ),
  );
  for (const row of capture.definitions) {
    const result = convertPlaces(row.definition, "/definitions/definition");
    assert.deepEqual(
      result.conversion.mappings.map((mapping) => mapping.place),
      row.places,
      `source definition ${row.id}`,
    );
    assert.deepEqual(
      result.frame?.places.map((place) => place.index),
      [...new Set<number>(row.places)].sort((a, b) => a - b),
    );
    assert.deepEqual(result.unresolved, {});
    let index = 0;
    const restored = result.text[0]
      .map((node) => {
        if (typeof node === "string") return node;
        const mapping = result.conversion.mappings[index++];
        assert.equal(mapping.place, node);
        return [...row.definition].slice(mapping.start, mapping.end).join("");
      })
      .join("");
    assert.equal(restored, row.definition);
  }
});

test("gloss brackets and stray closers stay text around finished delimited places", () => {
  const result = convertPlaces("[$x_1$] ) $x_2$ and ($x_{3}$)", "/definition");
  assert.deepEqual(result.text, [["[", 1, "] ) ", 2, " and (", 3, ")"]]);
  assert.deepEqual(result.unresolved, {});
  assert.deepEqual(convertPlaces("] x_1", "/definition").text, [["] ", 1]]);
  assert.deepEqual(
    convertPlaces("[$$x_1$$] (\\(x_2\\)) [\\[x_3\\]]", "/definition").text,
    [["[", 1, "] (", 2, ") [", 3, "]"]],
  );
  assert.deepEqual(convertPlaces("$x_1$ - runner", "/definition").text, [
    [1, " - runner"],
  ]);
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
  for (const pattern of Object.keys(converted.unresolved))
    assert.ok(
      converted.conversion.warnings.some((warning) =>
        warning.includes(pattern),
      ),
    );
  assert.equal(convertPlaces("", "/definition").text.length, 0);
});

test("a long literal word preserves its boundary before a later place", () => {
  const literal = "a".repeat(100000);
  assert.deepEqual(convertPlaces(literal + " x_1", "/definition").text, [
    [literal + " ", 1],
  ]);
});

test("unconverted pattern summaries retain complete Unicode scalar values", () => {
  const source = '\"' + "a".repeat(75) + "😀 x_1 " + "b".repeat(20) + '\"';
  const result = convertPlaces(source, "/definition");
  const pattern = Object.keys(result.unresolved)[0];
  assert.equal([...pattern].length, 80);
  assert.equal(
    new TextDecoder("utf-8", { fatal: true }).decode(
      new TextEncoder().encode(pattern),
    ),
    pattern,
  );
  assert.deepEqual(result.text, [[source]]);
});

test("a dash does not hide the five extra mathematical operators", () => {
  for (const operator of ["*", "/", "^", "·", ":", "+"]) {
    for (const source of [`$x_1$ - ${operator} 2`, `$x_1$-${operator}2`]) {
      const result = convertPlaces(source, "/definition");
      assert.deepEqual(result.text, [[source]], source);
      assert.equal(result.frame, null, source);
      assert.deepEqual(result.conversion.mappings, [], source);
      assert.deepEqual(result.unresolved, { $x_1$: 1 }, source);
      assert.ok(
        result.conversion.warnings.some((warning) =>
          warning.includes('"$x_1$"'),
        ),
        source,
      );
    }
  }
});

test("extra math closers after finished places stay literal", () => {
  for (const source of [
    "$x_1$\\)",
    "$x_1$\\]",
    "\\(x_1\\)$",
    "\\[x_1\\]$",
    "$$ x_{2} $$\\)",
    "$$ x_{2} $$\\]",
  ]) {
    const result = convertPlaces(source, "/definition");
    assert.deepEqual(result.text, [[source]], source);
    assert.equal(result.frame, null, source);
    assert.equal(result.conversion.method, "literal", source);
    assert.deepEqual(result.conversion.mappings, [], source);
    assert.equal(
      Object.values(result.unresolved).reduce((sum, count) => sum + count, 0),
      1,
      source,
    );
    assert.ok(
      result.conversion.warnings.some((warning) =>
        warning.startsWith("Unconverted pattern "),
      ),
      source,
    );
  }
  assert.deepEqual(convertPlaces("\\(x_1\\) $x_2$", "/definition").text, [
    [1, " ", 2],
  ]);
});
