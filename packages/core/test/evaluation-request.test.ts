import assert from "node:assert/strict";
import { before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { encodeEvaluationRequest } from "../src/evaluation-request.ts";
import {
  evaluate,
  evaluateSession,
  initializeCore,
  rankWord,
  utf8,
  type EvaluationRequest,
} from "../src/index.ts";
import * as wasm from "../generated/jvc_runtime.js";
import {
  canonical,
  importCapture,
  type CaptureManifest,
} from "../../importer/src/index.ts";

const view = "jve1:" + "0".repeat(64);
function request(extra: Partial<EvaluationRequest> = {}): EvaluationRequest {
  return {
    events: [],
    bodies: {},
    selected_view: view,
    import_selections: {},
    ...extra,
  };
}

test("request bytes match JSON.stringify for Unicode, escaping, keys, and optional values", () => {
  const input = request({
    events: [
      'quote" slash\\ newline\n tab\t nul\0',
      "日本語 Русский café 😀\u2028\u2029",
      "\ud800 lone \udc00",
    ],
    bodies: { ['key"\\\n😀']: '{"text":"⑴ café"}', "2": "two", "10": "ten" },
    import_selections: { "sha256:selection": [view, 'second"\\\n'] },
    overlay: {
      root_changes: [],
      nested: { optional: undefined },
      array: [undefined, null, true, -0, 1.25, Infinity],
    },
    limits: undefined,
  });
  const expected = new TextEncoder().encode(JSON.stringify(input));
  const actual = encodeEvaluationRequest(input);
  assert.deepEqual(actual, expected);
  assert.deepEqual(
    JSON.parse(new TextDecoder().decode(actual)),
    JSON.parse(JSON.stringify(input)),
  );
  assert.ok(!new TextDecoder().decode(actual).includes('"limits"'));
});

test("null-prototype maps, empty containers, repeated references, and sparse arrays match native JSON", () => {
  const shared = { value: "same" };
  const bodies = Object.create(null);
  bodies["__proto__"] = "source key";
  bodies["missing"] = undefined;
  const array = ["first", , "third"];
  const input = request({
    bodies,
    overlay: { first: shared, second: shared, array, empty: {}, list: [] },
  });
  assert.deepEqual(encodeEvaluationRequest(input), utf8(JSON.stringify(input)));
});

test("request encoding never stringifies an aggregate container", () => {
  const input = request({
    events: ["envelope"],
    bodies: Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [
        String(index),
        'é\\"😀'.repeat(40_000),
      ]),
    ),
    import_selections: { selection: Array.from({ length: 1000 }, () => view) },
  });
  const expected = utf8(JSON.stringify(input));
  const stringify = JSON.stringify;
  let largest = 0;
  JSON.stringify = ((value: unknown) => {
    assert.ok(
      value === null || typeof value !== "object",
      "The encoder must not stringify a container.",
    );
    const encoded = stringify(value);
    largest = Math.max(largest, encoded?.length ?? 0);
    return encoded;
  }) as typeof JSON.stringify;
  let encoded: Uint8Array;
  try {
    encoded = encodeEvaluationRequest(input);
  } finally {
    JSON.stringify = stringify;
  }
  assert.deepEqual(encoded, expected);
  assert.ok(largest < expected.byteLength / 4);
});

test("unsupported objects and cycles fail before encoding", () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  let getterCalls = 0;
  const getter = Object.defineProperty({}, "value", {
    enumerable: true,
    get() {
      getterCalls++;
      return "value";
    },
  });
  for (const overlay of [
    cycle,
    new Date(),
    new Map(),
    2n,
    Symbol("value"),
    () => "value",
    {
      toJSON() {
        return {};
      },
    },
    getter,
  ])
    assert.throws(
      () => encodeEvaluationRequest(request({ overlay })),
      TypeError,
    );
  assert.equal(getterCalls, 0);
});

test("array subclasses and custom array prototypes fail without invoking inherited toJSON", () => {
  let calls = 0;
  class CustomArray extends Array<string> {
    toJSON() {
      calls++;
      return ["replacement"];
    }
  }
  const subclass = new CustomArray("original");
  assert.equal(JSON.stringify(subclass), '["replacement"]');
  calls = 0;
  for (const overlay of [subclass, Object.setPrototypeOf(["value"], null)])
    assert.throws(
      () => encodeEvaluationRequest(request({ overlay })),
      /plain JSON values/,
    );
  assert.equal(calls, 0);
});

before(async () =>
  initializeCore(
    await readFile(
      new URL("../generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  ),
);

test("evaluation, sessions, and ranking preserve the original core wire results", async () => {
  const sourceBytes = await readFile(
    new URL("../../importer/fixtures/lensisku-sample.json", import.meta.url),
  );
  const manifest = JSON.parse(
    await readFile(
      new URL(
        "../../importer/fixtures/lensisku-sample.manifest.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as CaptureManifest;
  const imported = importCapture({
    sourceBytes,
    manifest,
    seed: new Uint8Array(32).fill(42),
    roots: [],
  });
  const input = request({
    events: imported.carriers.map((carrier) => canonical(carrier.envelope)),
    bodies: Object.fromEntries(
      imported.carriers.map((carrier) => [
        carrier.envelope.id,
        canonical(carrier.body),
      ]),
    ),
    selected_view: imported.view.envelope.id,
    import_selections: { [imported.selection.hash]: imported.selection.ids },
    limits: { events: 200_000, traversal: 1_000_000, claim_depth: 1024 },
  });
  const originalBytes = utf8(JSON.stringify(input));
  const expected = JSON.parse(wasm.evaluate_records(originalBytes));
  assert.equal(expected.available, true);
  assert.deepEqual(evaluate(input), expected);
  const original = new wasm.EvaluationSession(originalBytes);
  const session = evaluateSession(input);
  try {
    assert.deepEqual(session.state, JSON.parse(original.state()));
    const word = Object.values(expected.publications)[0] as { word: string };
    assert.deepEqual(
      rankWord(input, word.word),
      JSON.parse(wasm.rank_word(originalBytes, word.word)),
    );
    assert.deepEqual(
      session.rankWord(word.word),
      JSON.parse(original.rank(word.word)),
    );
  } finally {
    original.free();
    session.free();
  }
});
