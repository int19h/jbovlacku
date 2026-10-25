import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  initializeCore,
  extractHostVerifiedRecord,
  createEvaluationSession,
  restoreHostEvaluationSession,
  utf8,
} from "../../core/src/index.ts";

test("cold restore at current dictionary size keeps semantic evidence outside the joined records and Wasm heap", async () => {
  const runtime = (await initializeCore(
    await readFile(
      new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  )) as { memory: WebAssembly.Memory };
  const inputs = JSON.parse(
    await readFile(
      new URL(
        "../../../crates/jvc-runtime/tests/fixtures/host-record-inputs-v4.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  // Repeat an imported record with full source evidence in its original body.
  // This isolates the record transport and parser at the current dictionary count.
  const input = inputs.find(
    (value: { name: string }) => value.name === "legacy-import-1",
  );
  const compact = extractHostVerifiedRecord(
    utf8(input.envelope),
    utf8(input.body),
  );
  assert.equal("semantic" in JSON.parse(compact), false);
  assert.equal(compact.includes('"original"'), false);
  const builder = createEvaluationSession({
    selected_view: "jve1:" + "0".repeat(64),
    import_selections: {},
  });
  builder.addHostVerifiedRecord(compact);
  const original = builder.finish();
  const expected = original.state;
  const checkpoint = original.checkpoint("capacity", true);
  original.free();
  const records = Array<string>(59144).fill(compact);
  const joinedLength = 2 + records.length * compact.length + records.length - 1;
  assert.ok(joinedLength < 125_000_000, `Joined length: ${joinedLength}`);
  const before = runtime.memory.buffer.byteLength;
  const restored = restoreHostEvaluationSession(
    checkpoint,
    "capacity",
    records,
  );
  try {
    assert.deepEqual(restored.state, expected);
    const after = runtime.memory.buffer.byteLength;
    assert.ok(after < 850_000_000, `Wasm linear memory: ${after}`);
    assert.ok(after - before < 850_000_000, `Wasm growth: ${after - before}`);
    console.log(
      JSON.stringify({
        records: records.length,
        joined_units: joinedLength,
        wasm_before: before,
        wasm_after: after,
      }),
    );
  } finally {
    restored.free();
  }
});
