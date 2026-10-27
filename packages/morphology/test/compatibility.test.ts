import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  analyzeWord as analyzePublic,
  buildLujvo as buildPublic,
  generateGismu as generatePublic,
} from "../src/index.ts";
import type { GismuRequest, GismuResult, LujvoRequest } from "../src/types.ts";
import {
  canonicalJson,
  lockedRequest,
  boundaryRequests,
  callTypeScript,
  compareResults,
  type Request,
} from "../../../scripts/compare-morphology.ts";

test("comparison ignores object key order and preserves every array and field value", () => {
  const left = {
    ok: {
      kind: "lujvo",
      tokens: ["sai", "r", "zba"],
      diagnostics: [],
      optional: null,
    },
  };
  const reordered = {
    ok: {
      optional: null,
      diagnostics: [],
      tokens: ["sai", "r", "zba"],
      kind: "lujvo",
    },
  };
  assert.equal(canonicalJson(left), canonicalJson(reordered));
  for (const changed of [
    { ok: { ...left.ok, tokens: ["sai", "zba", "r"] } },
    { ok: { ...left.ok, diagnostics: ["warning"] } },
    { ok: { kind: "lujvo", tokens: left.ok.tokens, diagnostics: [] } },
    {
      error: {
        kind: "resource-limit",
        measure: "recognition work",
        value: 50001,
        limit: 50000,
      },
    },
  ])
    assert.notEqual(canonicalJson(left), canonicalJson(changed));
});

function explanationFixture(weight = 0) {
  const request: Request = {
    op: "generate",
    request: {
      sources: [
        {
          language: "eng",
          word: "makru",
          input: "makru",
          weight: { numerator: 1, denominator: 1 },
        },
        ...["mak", weight === 0 ? "makrum" : "makru"].map((input) => ({
          language: "deu",
          word: input,
          input,
          weight: { numerator: weight, denominator: 1 },
        })),
      ],
      window: 0,
      manual: "makru",
    },
  };
  const actual = callTypeScript(request) as { ok: GismuResult };
  const rust = structuredClone(actual);
  const old = rust.ok.manual!.contributions[1];
  old.input = "mak";
  old.matched = 3;
  old.length = 3;
  return { request, rust, actual };
}

test("compatibility records exact explanation changes for zero and positive weighted ties", () => {
  for (const weight of [0, 1]) {
    const { request, rust, actual } = explanationFixture(weight);
    const rawRust = canonicalJson(rust),
      rawActual = canonicalJson(actual);
    assert.notEqual(rawRust, rawActual);
    const result = compareResults(request, rust, actual);
    assert.equal(result.matches, true);
    assert.deepEqual(result.approvedDifferences, [
      {
        path: "ok.manual.contributions[1]",
        before: rust.ok.manual!.contributions[1],
        after: actual.ok.manual!.contributions[1],
      },
    ]);
    assert.equal(
      canonicalJson(rust),
      rawRust,
      "the oracle result stays unchanged",
    );
    assert.equal(
      canonicalJson(actual),
      rawActual,
      "the TypeScript result stays unchanged",
    );
    assert.deepEqual(compareResults(request, rust, rust), {
      matches: true,
      approvedDifferences: [],
    });
    rust.ok.candidates = [structuredClone(rust.ok.manual!)];
    actual.ok.candidates = [structuredClone(actual.ok.manual!)];
    assert.deepEqual(
      compareResults(request, rust, actual).approvedDifferences.map(
        (d) => d.path,
      ),
      ["ok.candidates[0].contributions[1]", "ok.manual.contributions[1]"],
    );
  }
});

test("explanation allowance rejects numerical and unrelated changes without partial approval", () => {
  const mutations: ((value: GismuResult) => void)[] = [
    (r) => {
      r.manual!.score.numerator = "2";
    },
    (r) => {
      r.manual!.rank = 123;
    },
    (r) => {
      r.manual!.contributions[1].weighted.numerator = "1";
    },
    (r) => {
      r.manual!.contributions[1].weighted.denominator = "2";
    },
    (r) => {
      r.manual!.contributions[1].matched = 4;
    },
    (r) => {
      r.manual!.contributions[1].length = 7;
    },
    (r) => {
      r.manual!.contributions[1].input = "makruz";
    },
    (r) => {
      r.manual!.contributions[1].language = "fra";
    },
    (r) => {
      r.manual!.contributions.reverse();
    },
    (r) => {
      r.manual!.contributions[0].input = "mak";
    },
    (r) => {
      r.manual!.conflicts.push({
        word: "changed",
        spelling: "makru",
        rule: "identical",
      });
    },
    (r) => {
      r.manual!.short_rafsi.reverse();
    },
    (r) => {
      r.manual!.form = "makra";
    },
    (r) => {
      r.considered++;
    },
    (r) => {
      r.complete = false as true;
    },
    (r) => {
      r.diagnostics.push("changed");
    },
    (r) => {
      r.algorithm.version = "2";
    },
    (r) => {
      r.languages.reverse();
    },
    (r) => {
      r.parameters.aggregation = "changed";
    },
    (r) => {
      Object.assign(r.manual!.contributions[1], { extra: "changed" });
    },
    (r) => {
      Reflect.deleteProperty(r.manual!, "short_rafsi");
    },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const { request, rust, actual } = explanationFixture();
    mutate(actual.ok);
    assert.deepEqual(
      compareResults(request, rust, actual),
      {
        matches: false,
        approvedDifferences: [],
      },
      `mutation ${index}`,
    );
  }
  const { request, rust, actual } = explanationFixture();
  rust.ok.manual!.contributions[1].matched = 2;
  assert.equal(
    compareResults(request, rust, actual).matches,
    false,
    "the old match must also be correct",
  );
});

test("explanation allowance rejects incomplete ties, complete-tie reordering, and other operations", () => {
  const { request, rust, actual } = explanationFixture(1);
  // A positive weight makes 3/3 greater than 5/6, so this is no longer a weighted tie.
  for (const result of [rust, actual])
    result.ok.languages[1].inputs[1] = "makrum";
  Object.assign(actual.ok.manual!.contributions[1], {
    input: "makrum",
    length: 6,
  });
  assert.equal(compareResults(request, rust, actual).matches, false);
  for (const result of [rust, actual]) {
    result.ok.languages[1].inputs = ["makrum", "makruz"];
    result.ok.languages[1].normalized = { numerator: "0", denominator: "1" };
    Object.assign(result.ok.manual!.contributions[1], {
      input: "makrum",
      matched: 5,
      length: 6,
      weighted: { numerator: "0", denominator: "1" },
    });
  }
  actual.ok.manual!.contributions[1].input = "makruz";
  assert.equal(compareResults(request, rust, actual).matches, false);
  const fixture = explanationFixture();
  assert.equal(
    compareResults(
      { op: "score", tokens: ["makru"] },
      fixture.rust,
      fixture.actual,
    ).matches,
    false,
  );
  assert.equal(
    compareResults(request, { error: "failed" }, fixture.actual).matches,
    false,
  );
});

test("explanation reference applies the special two-letter rule and keeps the first larger match", () => {
  for (const [input, matched] of [
    ["akp", 2],
    ["mzr", 0],
  ] as const) {
    const { request, rust, actual } = explanationFixture();
    for (const result of [rust, actual])
      result.ok.languages[1].inputs = [input, "makrum", "makruz"];
    Object.assign(rust.ok.manual!.contributions[1], {
      input,
      matched,
      length: 3,
    });
    assert.equal(compareResults(request, rust, actual).matches, true);
    actual.ok.manual!.contributions[1].input = "makruz";
    assert.equal(compareResults(request, rust, actual).matches, false);
  }
});

test("reconstruction preserves exact joins and uses explicit synthetic claims", () => {
  const reading = [
    { text: "sai", kind: "rafsi" as const, join_before: null },
    { text: "zba", kind: "rafsi" as const, join_before: "r" },
  ];
  const extended = lockedRequest("extended", "sairzba", reading);
  assert.equal(extended.spelling, "sairzba");
  assert.deepEqual(extended.joins, ["r"]);
  assert.deepEqual(
    extended.components.map((row) => [row.spelling, row.locked, row.claims]),
    [
      ["sai", "sai", [{ rafsi: "sai", pair: "synthetic-claim-0" }]],
      ["zba", "zba", [{ rafsi: "zba", pair: "synthetic-claim-1" }]],
    ],
  );
  for (const profile of ["cll", "extended-v2"] as const) {
    const request = lockedRequest(profile, "sairzba", reading);
    assert.equal(Object.hasOwn(request, "spelling"), false);
    assert.equal(Object.hasOwn(request, "joins"), false);
    assert.deepEqual(request.components, extended.components);
  }
});

test("the comparison adapter preserves structured resource failures", () => {
  assert.deepEqual(callTypeScript({ op: "score", tokens: ["a".repeat(129)] }), {
    error: {
      kind: "resource-limit",
      measure: "score bytes",
      value: 129,
      limit: 128,
    },
  });
  assert.deepEqual(callTypeScript({ op: "score", tokens: ["cku", "sni"] }), {
    ok: 5858,
  });
  assert.ok(
    boundaryRequests().some(
      (request) =>
        request.op === "generate" && request.request.sources.length === 65,
    ),
  );
});

test("help succeeds before required argument validation and data access", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(
        new URL("../../../scripts/compare-morphology.ts", import.meta.url),
      ),
      "--help",
    ],
    { encoding: "utf8" },
  );
  for (const option of [
    "--oracle",
    "--data",
    "--typed-data",
    "--gencmu",
    "--out",
  ])
    assert.ok(output.includes(option), option);
  assert.ok(output.includes("without reading data or writing evidence"));
});

test("public wrappers preserve omitted and explicit defaults for retained profiles", () => {
  for (const profile of ["cll", "extended-v2", "extended"] as const) {
    assert.deepEqual(
      { ok: analyzePublic(profile, "ckusni") },
      callTypeScript({ op: "analyze", profile, word: "ckusni" }),
    );
    const request: LujvoRequest = {
      profile,
      components: [
        { id: "a", spelling: "cukta", kind: "gismu" },
        { id: "b", spelling: "sinxa", kind: "gismu" },
      ],
    };
    for (const value of [
      request,
      {
        ...request,
        joins: [],
        inventory: { claims: [], snapshot: null },
        limits: {},
        components: request.components.map((row) => ({
          ...row,
          definition: null,
          locked: null,
          claims: [],
        })),
      },
    ])
      assert.deepEqual(
        { ok: buildPublic(value) },
        callTypeScript({ op: "build", request: value }),
      );
  }
  const request: GismuRequest = {
    sources: [
      {
        language: "eng",
        word: "banta",
        input: "banta",
        weight: { numerator: 1, denominator: 1 },
      },
    ],
    window: 1,
  };
  for (const value of [
    request,
    {
      ...request,
      manual: null,
      inventory: {},
      limits: {},
      candidates: "source-letters" as const,
    },
  ])
    assert.deepEqual(
      { ok: generatePublic(value) },
      callTypeScript({ op: "generate", request: value }),
    );
});
