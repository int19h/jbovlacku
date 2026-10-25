import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { before, test } from "node:test";
import {
  canonicalize,
  checkHostSemanticRecord,
  contentHash,
  semanticProjectionVersion,
  identityFromSeed,
  initializeCore,
  interpretDefinition,
  signHeader,
  utf8,
  wordId,
  verifyEnvelope,
} from "../../core/src/index.ts";
import { projectVerifiedRecord } from "../src/verified-records.ts";
import { projectSemanticRecord } from "../src/semantic/storage.ts";
import { createQwenProfile, documentInput } from "../src/semantic/profile.ts";
import { semanticDocument } from "../src/semantic/records.ts";

interface Input {
  name: string;
  envelope: string;
  body?: string;
}
let inputs: Input[];
before(async () => {
  await initializeCore(
    await readFile(
      new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  );
  inputs = JSON.parse(
    await readFile(
      new URL(
        "../../../crates/jvc-runtime/tests/fixtures/host-record-inputs-v3.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
});
function project(input: Input) {
  const envelope = JSON.parse(input.envelope);
  const bytes = utf8(input.envelope);
  const event = {
    envelope_hash: contentHash(bytes),
    body_hash: input.body ? (envelope.header.content.hash as string) : null,
  };
  return projectSemanticRecord(
    envelope.id,
    event,
    bytes,
    input.body ? utf8(input.body) : undefined,
  );
}

test("private semantic projections retain complete interpreted evidence and original bindings", () => {
  const profile = createQwenProfile();
  for (const input of inputs.filter(
    (value) =>
      /^legacy-import-\d$|^native-definition$|^definition-sparse-defaults$/.test(
        value.name,
      ) &&
      JSON.parse(value.envelope).header.action.kind === "definition.publish",
  )) {
    const record = project(input);
    const document = semanticDocument(profile, record)!;
    const body = JSON.parse(input.body!);
    const compact = JSON.parse(
      projectVerifiedRecord(
        record.id,
        record,
        utf8(input.envelope),
        utf8(input.body!),
      ).compact,
    );
    assert.equal(compact.semantic, undefined);
    assert.deepEqual(
      document.definition,
      interpretDefinition(body),
      input.name,
    );
    assert.equal(document.event, record.id);
    assert.equal(document.envelope, record.envelope_hash);
    assert.equal(document.body, contentHash(utf8(input.body!)));
    assert.equal(document.extraction_version, semanticProjectionVersion());
    assert.equal(document.input_hash, contentHash(document.input));
    assert.deepEqual(document.input, documentInput(profile, body));
    assert.equal(canonicalize(utf8(JSON.stringify(body))), input.body);
    if (body.legacy) {
      assert.deepEqual(document.definition.legacy, body.legacy);
      assert.deepEqual(
        (document.definition.legacy as any).original,
        body.legacy.original,
      );
      assert.equal(compact.package.body.legacy.original, undefined);
      assert.equal(compact.package.body.frame, undefined);
    }
    assert.equal(
      JSON.parse(new TextDecoder().decode(document.input)).legacy,
      undefined,
    );
  }
});

test("missing, invalid, and nondefinition compact records cannot become semantic inputs", () => {
  const profile = createQwenProfile();
  for (const input of inputs.filter((value) =>
    /missing$|^invalid-|^native-rafsi$|^profile$|^merge$/.test(value.name),
  ))
    assert.equal(semanticDocument(profile, project(input)), null, input.name);
});

test("a signed invalid definition action retains an inert compact record that decodes", () => {
  const input = inputs.find(
    (value) => value.name === "invalid-definition-action",
  )!;
  const envelope = verifyEnvelope(utf8(input.envelope));
  const record = project(input);
  assert.equal(
    checkHostSemanticRecord(record.projection),
    envelope.envelope.id,
  );
  assert.equal(envelope.action_valid, false);
  const compact = JSON.parse(record.projection);
  assert.equal(compact.action_valid, false);
  assert.equal(compact.semantic, null);
  assert.equal(semanticDocument(createQwenProfile(), record), null);
});

test("semantic extraction requires the current schema and exact event/body binding", () => {
  const profile = createQwenProfile();
  const record = project(
    inputs.find((input) => input.name === "native-definition")!,
  );
  assert.equal(semanticProjectionVersion(), 1);
  assert.throws(
    () => semanticDocument(profile, { ...record, version: 2 }),
    /binding/,
  );
  assert.throws(
    () =>
      semanticDocument(profile, { ...record, id: "jve1:" + "0".repeat(64) }),
    /binding/,
  );
  assert.throws(
    () =>
      semanticDocument(profile, {
        ...record,
        body_hash: "sha256:" + "0".repeat(64),
      }),
    /binding/,
  );
  for (const oldVersion of [0, 2]) {
    const compact = JSON.parse(record.projection);
    compact.version = oldVersion;
    assert.throws(() => checkHostSemanticRecord(JSON.stringify(compact)));
  }
  const changed = JSON.parse(record.projection);
  changed.semantic.id = "jve1:" + "0".repeat(64);
  assert.throws(() =>
    semanticDocument(profile, {
      ...record,
      projection: JSON.stringify(changed),
    }),
  );
});

test("equivalent interpreted bodies keep distinct signed hashes and the same recipe input", () => {
  const profile = createQwenProfile();
  const input = inputs.find(
    (value) => value.name === "definition-sparse-defaults",
  )!;
  const sparse = JSON.parse(input.body!);
  const seed = new Uint8Array(32).fill(71);
  const documents = [sparse, interpretDefinition(sparse)].map((body) => {
    const bytes = utf8(canonicalize(utf8(JSON.stringify(body))));
    const envelope = signHeader(seed, {
      version: 1,
      issuer: identityFromSeed(seed),
      previous: [],
      nonce: "1".repeat(32),
      action: {
        kind: "definition.publish",
        word: wordId(body.word),
        language: body.language,
        parents: [],
        origin: "native",
      },
      content: { hash: contentHash(bytes), bytes: bytes.length },
    });
    const envelopeBytes = utf8(JSON.stringify(envelope));
    const record = projectSemanticRecord(
      envelope.id,
      {
        envelope_hash: contentHash(envelopeBytes),
        body_hash: contentHash(bytes),
      },
      envelopeBytes,
      bytes,
    );
    return semanticDocument(profile, record)!;
  });
  assert.notEqual(documents[0].event, documents[1].event);
  assert.notEqual(documents[0].body, documents[1].body);
  assert.equal(documents[0].input_hash, documents[1].input_hash);
  assert.deepEqual(documents[0].input, documents[1].input);
  assert.deepEqual(documents[0].definition, documents[1].definition);
});
