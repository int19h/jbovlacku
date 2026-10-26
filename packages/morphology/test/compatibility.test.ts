import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  analyzeWord as analyzePublic,
  buildLujvo as buildPublic,
  generateGismu as generatePublic,
} from "../src/index.ts";
import type { GismuRequest, LujvoRequest } from "../src/types.ts";
import {
  canonicalJson,
  lockedRequest,
  boundaryRequests,
  callTypeScript,
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
