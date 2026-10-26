import assert from "node:assert/strict";
import { before, test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  initializeCore,
  extractHostVerifiedRecord,
  extractHostSemanticRecord,
  checkHostVerifiedRecord,
  checkHostSemanticRecord,
  hostRecordVersion,
  semanticProjectionVersion,
  utf8,
} from "../src/index.ts";

before(async () => {
  await initializeCore(
    await readFile(
      new URL("../generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  );
});

async function fixtures() {
  const inputs: { name: string; envelope: string; body: string | null }[] =
    JSON.parse(
      await readFile(
        new URL(
          "../../../crates/jvc-runtime/tests/fixtures/host-record-inputs-v5.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
  return inputs.filter((row) => row.name.startsWith("lexical-kind-"));
}

test("private projections apply the current lexical kind when they read admitted originals", async () => {
  for (const row of await fixtures()) {
    const envelope = utf8(row.envelope);
    const body = utf8(row.body!);
    const compact = JSON.parse(extractHostVerifiedRecord(envelope, body));
    const semantic = JSON.parse(extractHostSemanticRecord(envelope, body));
    const valid = row.name === "lexical-kind-fuhivla";
    assert.equal(compact.version, hostRecordVersion());
    assert.equal(semantic.version, semanticProjectionVersion());
    assert.equal(compact.body_status, valid ? "present" : "invalid");
    assert.equal(semantic.body_status, valid ? "present" : "invalid");
    if (valid) {
      assert.equal(compact.package.body.classification.kind, "fuhivla");
      assert.equal(semantic.semantic.body.classification.kind, "fuhivla");
    } else {
      assert.equal(compact.package.body, null);
      assert.equal(semantic.semantic, null);
    }
  }
});

test("private decoders refuse validation results from before the lexical kind change", async () => {
  const row = (await fixtures()).find(
    (row) => row.name === "lexical-kind-fuhivla",
  )!;
  const envelope = utf8(row.envelope);
  const body = utf8(row.body!);
  const compact = JSON.parse(extractHostVerifiedRecord(envelope, body));
  const semantic = JSON.parse(extractHostSemanticRecord(envelope, body));
  compact.version = 2;
  semantic.version = 1;
  assert.throws(() => checkHostVerifiedRecord(JSON.stringify(compact)));
  assert.throws(() => checkHostSemanticRecord(JSON.stringify(semantic)));
});
