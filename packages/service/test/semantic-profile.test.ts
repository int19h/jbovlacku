import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { before, test } from "node:test";
import {
  contentHash,
  createEvent,
  initializeCore,
  interpretDefinition,
  prepareAdmission,
  utf8,
  wordId,
} from "../../core/src/index.ts";
import {
  canonicalBytes,
  createQwenProfile,
  documentInput,
  inputHash,
  MAX_INPUT_BYTES,
  parseProfile,
  profileId,
  QUERY_PREFIX,
  queryInput,
  validateProfile,
} from "../src/semantic/profile.ts";

before(async () =>
  initializeCore(
    await readFile(
      new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  ),
);

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const definition = () => ({
  word: { language: "jbo" as const, spelling: "broda" },
  language: "en",
  text: [["A public test definition."]],
  classification: { kind: "gismu" },
  license: { expression: "CC0-1.0" },
});

test("portable profile parsing rejects invalid schemas, Unicode, and non-JSON values", () => {
  const profile = createQwenProfile();
  assert.deepEqual(parseProfile(canonicalBytes(profile)), profile);
  assert.deepEqual(validateProfile(structuredClone(profile)), profile);
  const invalid: unknown[] = [null, [], {}, { ...profile, unknown: true }];
  for (const key of Object.keys(profile)) {
    const missing = structuredClone(profile) as unknown as Record<
      string,
      unknown
    >;
    delete missing[key];
    invalid.push(missing);
  }
  invalid.push(
    { ...profile, version: 2 },
    { ...profile, model: "" },
    { ...profile, revision: 42 },
    { ...profile, epoch: "A".repeat(32) },
    ...[0, -1, 0.5, 65537, "4096"].map((dimension) => ({
      ...profile,
      dimension,
    })),
    {
      ...profile,
      artifacts: ["sha256:" + "a".repeat(64), "sha256:" + "a".repeat(64)],
    },
    {
      ...profile,
      artifacts: ["sha256:" + "b".repeat(64), "sha256:" + "a".repeat(64)],
    },
    { ...profile, artifacts: ["sha256:bad"] },
    { ...profile, encoding: "f64le" },
    { ...profile, normalization: "unknown" },
    { ...profile, distance: "unknown" },
    { ...profile, runtime: { name: "runtime" } },
    { ...profile, document: { ...profile.document, prefix: "\ud800" } },
    { ...profile, query: { ...profile.query, unknown: true } },
    { ...profile, query: { ...profile.query, truncation: "silent" } },
    { ...profile, parameters: { nan: NaN } },
    { ...profile, parameters: { omitted: undefined } },
    { ...profile, parameters: { malformed: "\udfff" } },
    { ...profile, parameters: { value: new Date() } },
  );
  for (const value of invalid) assert.throws(() => profileId(value));
  assert.throws(() => parseProfile(utf8('{"version":1,"version":1}')));
  assert.throws(() => parseProfile(Uint8Array.of(0xff)));
  assert.throws(() => parseProfile(new Uint8Array(65537)), /64 KiB/);
});

test("application profiles create fresh epochs and hash the entire canonical declaration", () => {
  const a = createQwenProfile();
  const b = createQwenProfile();
  assert.match(a.epoch, /^[0-9a-f]{32}$/);
  assert.notEqual(a.epoch, b.epoch);
  assert.equal(a.revision, null);
  assert.deepEqual(a.artifacts, []);
  assert.equal(a.dimension, 4096);
  assert.equal(a.document.recipe, "definition-json-v1");
  assert.equal(a.query.recipe, "literal-query-v1");
  assert.equal(a.parameters.allow_fallbacks, false);
  assert.equal(a.parameters.route, "nebius");
  assert.equal(profileId(a), contentHash(canonicalBytes(a)));
  assert.notEqual(profileId(a), profileId(b));
  const stable = createQwenProfile("a".repeat(32));
  assert.equal(profileId(stable), profileId(createQwenProfile("a".repeat(32))));
  for (const mutate of [
    (p: typeof stable) => (p.epoch = "b".repeat(32)),
    (p: typeof stable) => (p.dimension = 2048),
    (p: typeof stable) => (p.revision = "immutable-revision"),
    (p: typeof stable) => (p.document.prefix = "Document: "),
    (p: typeof stable) => (p.document.recipe = "another-recipe-v1"),
    (p: typeof stable) => (p.query.prefix = "Query: "),
    (p: typeof stable) => (p.parameters.pooling = "different"),
  ]) {
    const changed = structuredClone(stable);
    mutate(changed);
    assert.notEqual(profileId(stable), profileId(changed));
  }
  for (const epoch of ["", "A".repeat(32), "a".repeat(31), "g".repeat(32)])
    assert.throws(() => createQwenProfile(epoch), /epoch/);
  assert.throws(
    () => profileId({ ...stable, parameters: { large: "x".repeat(65536) } }),
    /64 KiB/,
  );
});

test("literal queries preserve exact Unicode and prefix bytes within the input limit", () => {
  const profile = createQwenProfile();
  const query = "  e\u0301\r\n① $x_{1}$ 🧵  ";
  assert.equal(text(queryInput(profile, query)), QUERY_PREFIX + query);
  assert.notEqual(
    inputHash(queryInput(profile, "é")),
    inputHash(queryInput(profile, "e\u0301")),
  );
  const room = MAX_INPUT_BYTES - utf8(QUERY_PREFIX).length;
  assert.equal(queryInput(profile, "x".repeat(room)).length, MAX_INPUT_BYTES);
  assert.throws(() => queryInput(profile, "x".repeat(room + 1)), /4096/);
  assert.throws(() => queryInput(profile, "界".repeat(room)), /4096/);
  for (const query of ["", "\ud800", "\udfff", "a\ud800b"])
    assert.throws(() => queryInput(profile, query), /valid text/);
  for (const field of ["document", "query"] as const) {
    const changed = structuredClone(profile);
    changed[field].recipe = "unknown-v1";
    assert.throws(
      () =>
        field === "query"
          ? queryInput(changed, "text")
          : documentInput(changed, definition()),
      /recipe/,
    );
  }
  const malformedPrefix = structuredClone(profile);
  malformedPrefix.query.prefix = "\ud800";
  assert.throws(() => queryInput(malformedPrefix, "text"), /recipe/);
});

test("reference documents use interpreted defaults and exclude unrelated evidence", () => {
  const profile = createQwenProfile();
  const body = definition();
  const original = JSON.stringify(body);
  const expected = { language: "en", text: body.text, glosses: [], places: [] };
  assert.deepEqual(documentInput(profile, body), canonicalBytes(expected));
  assert.deepEqual(
    documentInput(profile, body),
    documentInput(profile, interpretDefinition(body)),
  );
  assert.equal(JSON.stringify(body), original);
  const other = {
    ...body,
    word: { language: "jbo", spelling: "brode" },
    notes: [["Different notes."]],
    etymology: { text: [["Different etymology."]] },
    sources: [{ label: "Different source." }],
    examples: [{ language: "en", text: "Different example." }],
    legacy: { original: { text: "Different imported source." } },
    votes: 100000,
  };
  assert.deepEqual(documentInput(profile, other), documentInput(profile, body));
  assert.equal(
    inputHash(documentInput(profile, body)),
    contentHash(canonicalBytes(expected)),
  );
  const prefixed = structuredClone(profile);
  prefixed.document.prefix = "Document: ";
  assert.equal(
    text(documentInput(prefixed, body)),
    "Document: " + text(canonicalBytes(expected)),
  );
});

test("literal imported marker forms and unmatched mathematics do not invent frames", () => {
  const profile = createQwenProfile();
  const literal =
    "$x_{1}$, $x_2$, x3, x_{n}, ①, 2, $a+b$ and unmatched $x_{4}.";
  const body = { ...definition(), text: [[literal]] };
  const input = JSON.parse(text(documentInput(profile, body)));
  assert.deepEqual(input.text, [[literal]]);
  assert.deepEqual(input.places, []);
  assert.deepEqual(body.text, [[literal]]);
});

test("native frames retain numbered references and all interpreted place values", () => {
  const profile = createQwenProfile();
  const body = {
    ...definition(),
    text: [[2, " relates to ", 1, " and literal ①."]],
    glosses: [{ language: "en", text: "relation" }],
    frame: {
      role: "predicate",
      arity: { mode: "fixed", count: 2 },
      places: [
        { index: 1, glosses: [{ language: "en", text: "first" }] },
        { index: 2, description: [["Second place."]] },
      ],
      constraints: [[["This frame constraint is outside the recipe."]]],
    },
  };
  const publication = createEvent(
    new Uint8Array(32).fill(73),
    [],
    "2".repeat(32),
    {
      kind: "definition.publish",
      word: wordId(body.word),
      language: body.language,
      parents: [],
      origin: "native",
    },
    body,
  );
  const admitted = prepareAdmission(utf8(JSON.stringify(publication)));
  assert.equal(admitted.action_valid, true);
  assert.equal(admitted.body_status, "present");
  const input = JSON.parse(text(documentInput(profile, body)));
  const interpreted = interpretDefinition(body);
  assert.deepEqual(input.text, body.text);
  assert.deepEqual(input.glosses, [
    { language: "en", text: "relation", sense: null },
  ]);
  assert.deepEqual(
    input.places,
    (interpreted.frame as { places: unknown }).places,
  );
  assert.deepEqual(input.places[0].description, []);
  assert.deepEqual(input.places[0].type_hints, []);
  assert.deepEqual(input.places[0].defaults, []);
  assert.equal(input.constraints, undefined);
});

test("document inputs reject malformed Unicode, invalid present fields, and oversize inputs", () => {
  const profile = createQwenProfile();
  for (const field of ["glosses", "frame", "text"]) {
    if (field === "frame") continue;
    assert.throws(() =>
      documentInput(profile, { ...definition(), [field]: null }),
    );
  }
  assert.throws(() =>
    documentInput(profile, { ...definition(), frame: { places: null } }),
  );
  assert.throws(() =>
    documentInput(profile, { ...definition(), text: [["\ud800"]] }),
  );
  assert.throws(
    () =>
      documentInput(profile, {
        ...definition(),
        text: [["x".repeat(MAX_INPUT_BYTES)]],
      }),
    /4096/,
  );
});
