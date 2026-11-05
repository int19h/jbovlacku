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
  coreCheckpointVersion,
  evaluateSession,
  restoreHostEvaluationSession,
} from "../src/index.ts";

before(async () => {
  await initializeCore(
    await readFile(
      new URL("../generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  );
});

test("float schema admission invalidates old projection and checkpoint bindings", async () => {
  const rows: { name: string; envelope: string; body: string }[] = JSON.parse(
    await readFile(
      new URL(
        "../../../crates/jvc-runtime/tests/fixtures/host-record-inputs-v8.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(hostRecordVersion(), 8);
  assert.equal(semanticProjectionVersion(), 5);
  assert.equal(coreCheckpointVersion(), "jvc-evaluation-checkpoint-v2");
  for (const row of rows.filter((row) =>
    row.name.startsWith("f64-contract-"),
  )) {
    const compact = JSON.parse(
      extractHostVerifiedRecord(utf8(row.envelope), utf8(row.body)),
    );
    const semantic = JSON.parse(
      extractHostSemanticRecord(utf8(row.envelope), utf8(row.body)),
    );
    const expected = row.name === "f64-contract-0" ? "present" : "invalid";
    assert.equal(compact.body_status, expected);
    assert.equal(semantic.body_status, expected);
    compact.version = 7;
    semantic.version = 4;
    assert.throws(() => checkHostVerifiedRecord(JSON.stringify(compact)));
    assert.throws(() => checkHostSemanticRecord(JSON.stringify(semantic)));
  }
});

test("an admitted float view gives no synchronous exact score", async () => {
  const rows: { name: string; envelope: string; body: string }[] = JSON.parse(
    await readFile(
      new URL(
        "../../../crates/jvc-runtime/tests/fixtures/host-record-inputs-v8.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const row = rows.find((row) => row.name === "f64-contract-0")!;
  const id = JSON.parse(row.envelope).id;
  const session = evaluateSession({
    events: [row.envelope],
    bodies: { [id]: row.body },
    selected_view: id,
    import_selections: {},
  });
  try {
    assert.equal(session.state.available, true);
    assert.throws(
      () => session.rankWord("jvw1:" + "0".repeat(64)),
      /unsupported_calculation/,
    );
    const saved = JSON.parse(
      new TextDecoder().decode(session.checkpoint("f64-contract")),
    );
    saved.version = "jvc-evaluation-checkpoint-v1";
    assert.throws(() =>
      restoreHostEvaluationSession(utf8(JSON.stringify(saved)), "f64-contract"),
    );
    const result = JSON.parse(
      new TextDecoder().decode(session.checkpoint("f64-contract", true)),
    );
    assert.equal(result.version, "jvc-evaluation-results-v2");
    result.version = "jvc-evaluation-results-v1";
    const compact = extractHostVerifiedRecord(
      utf8(row.envelope),
      utf8(row.body),
    );
    assert.throws(() =>
      restoreHostEvaluationSession(
        utf8(JSON.stringify(result)),
        "f64-contract",
        [compact],
      ),
    );
  } finally {
    session.free();
  }
});
