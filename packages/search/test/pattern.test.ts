import assert from "node:assert/strict";
import { before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { initializeCore } from "../../core/src/index.ts";
import {
  selectMatches,
  selectRafsiMatches,
  PatternError,
  prepareQuery,
} from "../src/index.ts";
import { PATTERN_TIMEOUT_MESSAGE } from "../src/pattern.ts";

before(async () =>
  initializeCore(
    await readFile(
      new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  ),
);
const spellings = [
  "bangu",
  "barda",
  "vecnu",
  "nu",
  "uen",
  "yen",
  "papa",
  "baba",
  "ba'i",
  "djan",
  "dján",
];
const entries = spellings.map((spelling) => ({
  word: { spelling },
  glosses: [{ text: "ba*" }],
  plain_text: "ba*",
  rafsi: [spelling],
}));
const cases: [string, string[]][] = [
  ["/^ba/", ["bangu", "barda", "baba", "ba'i"]],
  ["/nu$/", ["vecnu", "nu"]],
  ["ba*", ["bangu", "barda", "baba", "ba'i"]],
  ["@@$", ["uen", "yen"]],
  ["?a?a", ["papa", "baba"]],
  ["*'i", ["ba'i"]],
  ["*hi", ["ba'i"]],
];
for (const [query, expected] of cases) {
  test(`headword and rafsi patterns agree for ${query}`, () => {
    assert.deepEqual(
      selectMatches(entries, query).rows.map((row) => row.entry.word.spelling),
      expected,
    );
    assert.deepEqual(
      selectRafsiMatches(entries, query).rows.map(
        (row) => row.entry.word.spelling,
      ),
      expected,
    );
    assert.ok(
      selectMatches(entries, query).rows.every(
        (row) => row.match === "headword-pattern",
      ),
    );
    assert.equal(prepareQuery(query).components, null);
  });
}
test("patterns ignore capital letters and acute stress while preserving regexp escapes", () => {
  for (const query of ["/^DJÁN$/", "/^DJA\u0301N$/", "DJÁ?", "dja?"])
    assert.deepEqual(
      selectMatches(entries, query).rows.map((row) => row.entry.word.spelling),
      ["djan", "dján"],
    );
  assert.deepEqual(
    selectMatches(entries, "/(?P<head>BA)/").rows.map(
      (row) => row.entry.word.spelling,
    ),
    cases[0][1],
  );
  assert.equal(selectMatches(entries, "/\\D+/").rows.length, entries.length);
  assert.equal(
    selectMatches(entries, "/\\p{Alphabetic}+/").rows.length,
    entries.length,
  );
  assert.deepEqual(
    selectMatches(entries, "/hi$/").rows.map((row) => row.entry.word.spelling),
    ["ba'i"],
  );
  assert.equal(selectMatches(entries, "/\\x68/").rows.length, 0);
});
test("pattern mode matches no glosses, text, or segmented fallback cards", () => {
  const rows = [
    {
      word: { spelling: "klama" },
      glosses: [{ text: "ba*" }],
      plain_text: "ba*",
      rafsi: ["ban", "bav"],
    },
  ];
  assert.equal(selectMatches(rows, "ba*").rows[0].match, "rafsi-pattern");
  assert.equal(
    selectMatches([{ ...rows[0], rafsi: [] }], "ba*").rows.length,
    0,
  );
  assert.equal(selectRafsiMatches(rows, "BA*").rows[0].rafsi?.length, 2);
});
test("invalid syntax and compilation limits are explicit even for an empty dictionary", () => {
  for (const query of [
    "/[",
    "//",
    "/[/",
    "/(?=a)/",
    "/(a)\\1/",
    "/\\h/",
    "/(?-i)BA/",
    "*".repeat(257),
    "/a{1000000}/",
  ])
    assert.throws(
      () => selectMatches([], query),
      (error) =>
        error instanceof PatternError && error.code === "pattern_invalid",
    );
});
test("catastrophic repetition completes on one legal long word and exhausts the aggregate work budget cleanly", () => {
  const long = {
    word: { spelling: "a".repeat(254) + "b" },
    glosses: [],
    plain_text: "",
  };
  assert.deepEqual(selectMatches([long], "/(a+)+$/").rows, []);
  assert.throws(
    () =>
      selectMatches(
        [{ ...long, word: { spelling: "a" } }, ...Array(25_000).fill(long)],
        "/(a+)+$/",
      ),
    (error) =>
      error instanceof PatternError &&
      error.code === "pattern_timeout" &&
      error.message === PATTERN_TIMEOUT_MESSAGE,
  );
});
