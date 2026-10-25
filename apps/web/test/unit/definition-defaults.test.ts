import { before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  initializeCore,
  interpretDefinition,
  omitDefinitionDefaults,
  createEvent,
  prepareSigning,
  prepareAdmission,
  signHeader,
  identityFromSeed,
  inspectBody,
  canonicalize,
  contentHash,
  utf8,
  wordId,
} from "../../../../packages/core/src/index.ts";
import {
  draftFromBody,
  draftToBody,
  normalizeDraft,
  newDraft,
} from "../../src/model/draft.ts";
import type { DefinitionBody } from "../../src/model/types.ts";

before(async () =>
  initializeCore(
    await readFile(
      new URL(
        "../../../../packages/core/generated/jvc_runtime_bg.wasm",
        import.meta.url,
      ),
    ),
  ),
);
const seed = new Uint8Array(32).fill(83);
const minimal = () => ({
  word: { language: "jbo" as const, spelling: "broda" },
  language: "en",
  text: [["A minimal definition."]],
  classification: { kind: "gismu" },
  license: { expression: "CC0-1.0" },
});
const action = (body = minimal()) => ({
  kind: "definition.publish",
  word: wordId(body.word),
  language: "en",
  parents: [],
  origin: "native",
});
const canonical = (value: unknown) => canonicalize(utf8(JSON.stringify(value)));

test("Wasm interprets nested defaults while new signing omits them without changing input", () => {
  const raw = {
    ...minimal(),
    frame: {
      role: "predicate",
      arity: { mode: "variadic", minimum: 1 },
      places: [
        { index: 1, type_hints: [{ alternatives: [{ abstractor: "nu" }] }] },
      ],
      tail: { from: 2 },
    },
    operands: [{ id: "term", category: "term", cardinality: { minimum: 0 } }],
    etymology: {
      formation: {
        method: "unknown",
        sources: [{ language: "en", word: "source" }],
        weights_profile: {},
        candidates: [{ form: "broda" }],
      },
    },
    examples: [{ language: "jbo", text: "broda" }],
    sources: [{ label: "source" }],
  };
  const before = canonical(raw);
  const interpreted = interpretDefinition<DefinitionBody>(raw);
  assert.equal(interpreted.frame!.tail!.from, 2);
  assert.deepEqual(interpreted.frame!.places[0].type_hints[0].note, []);
  assert.deepEqual(
    interpreted.frame!.places[0].type_hints[0].alternatives[0].tags,
    [],
  );
  assert.equal(interpreted.operands[0].cardinality.maximum, null);
  assert.equal(interpreted.etymology.formation!.sources[0].input, null);
  assert.equal(interpreted.etymology.formation!.weights_profile!.source, null);
  assert.equal(interpreted.etymology.formation!.candidates[0].score, null);
  assert.deepEqual(omitDefinitionDefaults(interpreted), raw);
  assert.equal(canonical(raw), before);
  const publication = createEvent(
    seed,
    [],
    "1".repeat(32),
    action(),
    interpreted,
  );
  assert.deepEqual(publication.body, raw);
  const prepared = prepareSigning(
    identityFromSeed(seed),
    [],
    "1".repeat(32),
    action(),
    interpreted,
  );
  assert.deepEqual(prepared.body, raw);
  assert.deepEqual(prepared.header, publication.envelope.header);
  const inspected = inspectBody(
    utf8(canonical(publication.envelope)),
    utf8(before),
  );
  assert.equal(inspected.availability, "valid");
  assert.deepEqual(inspected.body, raw);
  const transport = utf8(canonical(publication));
  assert.deepEqual(prepareAdmission(transport), prepareAdmission(transport));
  assert.equal(prepareAdmission(transport).body, before);
});

test("explicit and omitted defaults retain separate IDs and exact retries", () => {
  const raw = minimal();
  const full = interpretDefinition(raw);
  const publishRaw = (body: unknown) => {
    const bytes = utf8(canonical(body));
    const header = {
      version: 1,
      issuer: identityFromSeed(seed),
      previous: [],
      nonce: "2".repeat(32),
      action: action(),
      content: { hash: contentHash(bytes), bytes: bytes.length },
    };
    return { envelope: signHeader(seed, header), body };
  };
  const omitted = publishRaw(raw);
  const explicit = publishRaw(full);
  assert.notEqual(omitted.envelope.id, explicit.envelope.id);
  for (const publication of [omitted, explicit]) {
    const result = prepareAdmission(utf8(canonical(publication)));
    assert.equal(result.body_status, "present");
    assert.equal(result.body, canonical(publication.body));
    assert.equal(result.header.content!.hash, contentHash(utf8(result.body!)));
  }
});

test("draft restoration and complete revisions apply defaults without parent inheritance", () => {
  const raw = minimal() as unknown as DefinitionBody;
  const before = canonical(raw);
  const draft = draftFromBody(raw, "jve1:" + "a".repeat(64), "native");
  assert.deepEqual(draft.notes, []);
  assert.equal(draft.frameMode, "none");
  assert.deepEqual(draft.sources, []);
  const restored = normalizeDraft(JSON.parse(JSON.stringify(draft)));
  const result = draftToBody(restored);
  assert.deepEqual(
    result.problems.filter((p) => p.blocking),
    [],
  );
  assert.deepEqual(result.body!.notes, []);
  assert.equal(result.body!.frame, null);
  assert.equal(canonical(raw), before);
  const publication = createEvent(
    seed,
    [],
    "3".repeat(32),
    { ...action(), parents: draft.parents },
    result.body,
  );
  assert.ok(!Object.hasOwn(publication.body as object, "notes"));
  assert.ok(!Object.hasOwn(publication.body as object, "legacy"));
  const sparseDraft = {
    ...draft,
    places: [
      {
        index: 1,
        kind: "custom",
        hint: { alternatives: [{ abstractor: "nu" }] },
        glosses: [{ language: "en", text: "gloss" }],
        derivations: [{ word: "brode", place: 1 }],
      },
    ],
    tail: { kind: "custom", hint: { alternatives: [{ tags: ["entity"] }] } },
    glosses: [{ language: "en", text: "word" }],
    operands: [{ id: "term", category: "term", minimum: 0 }],
    formation: {
      method: "unknown",
      sources: [{ language: "en", word: "test" }],
    },
    compound: null,
    sources: [{ label: "source" }],
  };
  const restoredSparse = normalizeDraft(sparseDraft as unknown as typeof draft);
  assert.deepEqual(restoredSparse.formation!.sources[0].notes, []);
  assert.equal(restoredSparse.sources[0].event, null);
  assert.deepEqual(restoredSparse.places[0].hint!.note, []);
  assert.deepEqual(restoredSparse.places[0].hint!.alternatives[0].tags, []);
  assert.equal(restoredSparse.places[0].glosses[0].sense, "");
  assert.equal(restoredSparse.places[0].derivations[0].definition, null);
  assert.deepEqual(restoredSparse.tail!.hint!.note, []);
  assert.equal(restoredSparse.operands[0].maximum, null);
});

test("draft validation uses the compact body byte count that publication signs", () => {
  const draft = newDraft({
    spelling: "broda",
    kind: "gismu",
    text: "x".repeat(261_800),
    structured: false,
  });
  const result = draftToBody(draft);
  assert.deepEqual(
    result.problems.filter((p) => p.blocking),
    [],
  );
  assert.ok(utf8(canonical(result.body)).length > 256 * 1024);
  const publication = createEvent(
    seed,
    [],
    "4".repeat(32),
    action(),
    result.body,
  );
  assert.ok(publication.envelope.header.content.bytes <= 256 * 1024);
  assert.equal(
    prepareAdmission(utf8(canonical(publication))).body_status,
    "present",
  );
});

test("revision markers use raw pronunciation presence while new signatures omit unknown values", () => {
  for (const present of [false, true]) {
    const raw = {
      ...minimal(),
      etymology: {
        formation: {
          method: "unknown",
          sources: [
            {
              language: "en",
              word: "test",
              ...(present ? { word_ipa: null } : {}),
            },
          ],
        },
      },
    };
    const interpreted = interpretDefinition<DefinitionBody>(raw);
    const draft = draftFromBody(
      interpreted,
      "jve1:" + "b".repeat(64),
      "native",
      raw,
    );
    assert.deepEqual(draft.retainedWordIpaNullSources, present ? [0] : []);
    const restored = normalizeDraft(JSON.parse(JSON.stringify(draft)));
    assert.deepEqual(restored.retainedWordIpaNullSources, present ? [0] : []);
    assert.equal(restored.formation!.sources[0].word_ipa, null);
    const signed = prepareSigning(
      identityFromSeed(seed),
      [],
      "e".repeat(32),
      action(),
      draftToBody(restored).body,
    );
    assert.equal(
      Object.hasOwn(
        (signed.body as any).etymology.formation.sources[0],
        "word_ipa",
      ),
      false,
    );
    assert.equal(
      Object.hasOwn(raw.etymology.formation.sources[0], "word_ipa"),
      present,
    );
  }
});
