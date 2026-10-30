import assert from "node:assert/strict";
import { before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { initializeCore } from "../../core/src/index.ts";
import {
  selectMatches,
  selectRafsiMatches,
  naturalLanguageNote,
  isPatternQuery,
  PatternError,
} from "../src/index.ts";
import { compilePattern } from "../src/pattern.ts";
import { scanPatterns, type PatternCandidate } from "../src/pattern-scan.ts";
before(async () =>
  initializeCore(
    await readFile(
      new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  ),
);
const row = (spelling: string) => ({
  word: { spelling },
  glosses: [{ text: "c*-algebra" }, { text: "name@example.org" }],
  plain_text: "how do you say hello?",
  rafsi: [] as string[],
});
test("meaning retrieval and proposed rafsi use explicit literal modes", () => {
  for (const query of ["c*-algebra", "name@example.org"])
    assert.equal(
      selectMatches([row("r2word")], query, undefined, undefined, {
        patterns: false,
      }).rows.length,
      1,
    );
  const entry = { ...row("r2word"), rafsi: ["/", "ba* word", "a"] };
  for (const query of ["/", "ba* word"])
    assert.deepEqual(
      selectRafsiMatches([entry], query, undefined, { patterns: false }).rows[0]
        .rafsi,
      [query],
    );
  assert.equal(
    selectRafsiMatches([entry], "@", undefined, { patterns: false }).rows
      .length,
    0,
  );
});
test("generic wildcards consume spaces, punctuation, digits and Unicode characters", () => {
  const entries = [
    "ci zei tuple",
    "ba.ba",
    "ba ba",
    "ba,ba",
    "ba3ba",
    "ba界ba",
  ].map(row);
  assert.equal(selectMatches(entries, "*zei*").rows.length, 1);
  assert.deepEqual(
    selectMatches(entries, "ba?ba").rows.map((hit) => hit.entry.word.spelling),
    entries.slice(1).map((entry) => entry.word.spelling),
  );
  assert.equal(selectMatches(entries, "ba.ba*").rows.length, 1);
});
test("sentence punctuation falls back to ordinary text with a short note", () => {
  assert.equal(
    selectMatches([row("r2word")], "how do you say hello?").rows.length,
    1,
  );
  assert.ok(naturalLanguageNote("how do you say hello?"));
  for (const query of ["what is a C*-algebra?", "who uses name@example.org?"])
    assert.equal(
      selectMatches([{ ...row("r2word"), plain_text: query }], query).rows
        .length,
      1,
    );
  assert.equal(naturalLanguageNote("*zei*"), null);
  assert.equal(isPatternQuery("/missing slash ?"), true);
  assert.throws(() => selectMatches([], "/missing slash ?"), PatternError);
});
test("combining acute literal sequences normalize without changing escapes or ranges", () => {
  for (const query of [
    "/^dj\u0301an$/",
    "/^\u0301djan$/",
    "/^dja\u0301\u0301n$/",
  ])
    assert.equal(selectMatches([row("djan")], query).rows.length, 1, query);
  assert.equal(
    selectMatches([row("dja'an")], "/^dja'\u0301an$/").rows.length,
    1,
  );
  assert.equal(selectMatches([row("'")], "/h\u0301/").rows.length, 1);
  assert.equal(
    selectMatches([row("djan")], String.raw`/^dj\x{301}an$/`).rows.length,
    0,
  );
  assert.equal(selectMatches([row("h")], String.raw`/\x68/`).rows.length, 0);
  assert.equal(selectMatches([row("g")], "/[a-h]/").rows.length, 1);
  assert.equal(selectMatches([row("'")], "/(?P<head>h)/").rows.length, 1);
});
test("common counted Unicode classes retain non-ASCII semantics", () => {
  for (const query of [
    String.raw`/^\w{3,8}$/`,
    String.raw`/^\w{10,}$/`,
    String.raw`/^\p{L}{3,8}$/`,
    String.raw`/^\b\p{L}{3,8}\b$/`,
  ]) {
    const count = query.includes("10,") ? 10 : 5;
    for (const spelling of [
      "a".repeat(count),
      "Ж".repeat(count),
      "界".repeat(count),
    ])
      assert.equal(
        selectMatches([row(spelling)], query).rows.length,
        1,
        `${query}: ${spelling}`,
      );
  }
});
test("removed combining acute repetitions keep their operand scope", () => {
  const entries = ["djan", "djjan", "djjjan"].map(row);
  for (const query of [
    "/^dj\u0301+an$/",
    "/^dj\u0301{2}an$/",
    "/^dj\u0301?an$/",
    "/^dj(?:\u0301)+an$/",
    "/^dj(\u0301){2}an$/",
  ])
    assert.deepEqual(
      selectMatches(entries, query).rows.map((hit) => hit.entry.word.spelling),
      ["djan"],
      query,
    );
  assert.equal(
    selectMatches(entries, String.raw`/^dj\x{301}+an$/`).rows.length,
    0,
  );
  assert.deepEqual(
    selectMatches(entries, "/^dj+an$/").rows.map(
      (hit) => hit.entry.word.spelling,
    ),
    ["djan", "djjan", "djjjan"],
  );
});
test("compiled-state cost permits 35000 ordinary spellings and a long alternation", () => {
  const entries = Array.from({ length: 35_000 }, () => row("basturfa"));
  const alternation =
    "/(?:" +
    Array.from(
      { length: 27 },
      (_, i) => "basturf" + String.fromCharCode(97 + (i % 26)),
    ).join("|") +
    ")/";
  assert.ok(alternation.length >= 200);
  for (const query of ["$@$$@$$@", "$$@$@$$@", "$@$$@$$@*", alternation])
    assert.doesNotThrow(() => selectMatches(entries, query), query);
});
test(
  "real English shape patterns and counted classes complete",
  { skip: !process.env.JVC_PATTERN_EN_KEYS },
  async () => {
    const keys = (await readFile(process.env.JVC_PATTERN_EN_KEYS!, "utf8"))
      .trimEnd()
      .split("\n");
    assert.equal(keys.length, 33_267);
    for (const [query, count] of [
      ["$@$$@$$@", 1947],
      ["$$@$@$$@", 358],
      ["$@$$@$$@*", 2845],
      [String.raw`/^\w{3,8}$/`, 11673],
      [String.raw`/^\w{10,}$/`, 3390],
      ["*zei*", 197],
    ] as const)
      assert.equal(
        selectMatches(keys.map(row), query).rows.length,
        count,
        query,
      );
  },
);
test("expanded optional repetitions are refused before one expensive candidate", () => {
  const pattern = compilePattern("/(?:[ab]?){1000}c/");
  try {
    assert.ok(pattern.stats().asciiStates > 1000);
    assert.throws(
      () => pattern.test("ab".repeat(127) + "a"),
      (error: unknown) =>
        error instanceof PatternError && error.code === "pattern_timeout",
    );
    assert.equal(pattern.stats().spent, 0);
  } finally {
    pattern.free();
  }
});
test("server scans retain shared candidate and aggregate work bounds", () => {
  const entries = [
    { spelling: "klama", rafsi: ["kla"] },
    { spelling: "bangu", rafsi: ["ban"] },
    { spelling: "basturfa", rafsi: ["kla"] },
  ];
  assert.deepEqual(scanPatterns(entries, "kla*"), [
    { index: 0, match: "headword-pattern" },
    { index: 2, match: "rafsi-pattern" },
  ]);
  const limitedCases: [PatternCandidate[], string][] = [
    [[{ spelling: "ab".repeat(127) + "a", rafsi: [] }], "/(?:[ab]?){1000}c/"],
    [
      Array.from({ length: 25_000 }, () => ({
        spelling: "a".repeat(254) + "b",
        rafsi: [],
      })),
      "/(a+)+$/",
    ],
  ];
  for (const [candidates, query] of limitedCases)
    assert.throws(
      () => scanPatterns(candidates, query),
      (error: unknown) =>
        error instanceof PatternError && error.code === "pattern_timeout",
    );
});
