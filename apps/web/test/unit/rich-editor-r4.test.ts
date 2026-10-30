import assert from "node:assert/strict";
import { before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { initializeCore } from "../../../../packages/core/src/index.ts";
import {
  draftToBody,
  newDraft,
  normalizeDraft,
  switchMode,
} from "../../src/model/draft.ts";
import type { RichText } from "../../src/model/types.ts";

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
const exact: RichText = [["first\r\n", " adjacent\r"], [" \t"], ["last"]];

test("r4 construction and restored drafts preserve untouched rich fields exactly", () => {
  const draft = newDraft({
    spelling: "broda",
    kind: "gismu",
    text: exact,
    notes: exact,
  });
  assert.deepEqual(draft.text, exact);
  assert.deepEqual(normalizeDraft(draft).notes, exact);
  draft.glosses.push({ language: "en", text: "changed gloss", sense: "" });
  const { body } = draftToBody(draft);
  assert.ok(body);
  assert.deepEqual(body.text, exact);
  assert.deepEqual(body.notes, exact);
});
test("r4 literal snapshots restore untouched paragraphs and saved string boundaries", () => {
  const original: RichText = [["left\r", " right", 1], [" \t"], ["literal ②"]];
  const draft = newDraft({ spelling: "broda", kind: "gismu", text: original });
  switchMode(draft, false);
  const restored = normalizeDraft(draft);
  switchMode(restored, true);
  assert.deepEqual(restored.text, original);
});
