import assert from "node:assert/strict";
import { before, test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  initializeCore,
  utf8,
  extractHostVerifiedRecord,
  extractHostSemanticRecord,
  checkHostVerifiedRecord,
  checkHostSemanticRecord,
  hostRecordVersion,
  semanticProjectionVersion,
} from "../src/index.ts";

before(async () => {
  await initializeCore(
    await readFile(
      new URL("../generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  );
});

test("current extraction applies comma boundaries and plain rafsi claim admission to retained originals", async () => {
  const rows: { name: string; envelope: string; body: string }[] = JSON.parse(
    await readFile(
      new URL(
        "../../../crates/jvc-runtime/tests/fixtures/host-record-inputs-v7.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  let checked = 0;
  for (const row of rows.filter((row) => row.name.startsWith("r2-"))) {
    const compact = JSON.parse(
      extractHostVerifiedRecord(utf8(row.envelope), utf8(row.body)),
    );
    const semantic = JSON.parse(
      extractHostSemanticRecord(utf8(row.envelope), utf8(row.body)),
    );
    const valid = [
      "r2-zei-spaced",
      "r2-zei-joined",
      "r2-zei-comma-letters",
      "r2-rafsi-plain",
    ].includes(row.name);
    assert.equal(compact.body_status, valid ? "present" : "invalid", row.name);
    assert.equal(semantic.body_status, valid ? "present" : "invalid", row.name);
    assert.equal(compact.version, hostRecordVersion());
    assert.equal(semantic.version, semanticProjectionVersion());
    compact.version = 6;
    semantic.version = 3;
    assert.throws(() => checkHostVerifiedRecord(JSON.stringify(compact)));
    assert.throws(() => checkHostSemanticRecord(JSON.stringify(semantic)));
    checked++;
  }
  assert.equal(checked, 9);
});
