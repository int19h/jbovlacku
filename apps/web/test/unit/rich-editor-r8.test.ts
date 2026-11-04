import assert from "node:assert/strict";
import { test } from "node:test";
import { EditorState, TextSelection } from "prosemirror-state";
import { closeHistory, history, undo } from "prosemirror-history";
import {
  deleteRichInput,
  editorToRich,
  mapRichRange,
  replaceRichText,
  richToEditor,
  snapshotRichRange,
} from "../../src/model/rich-editor.ts";

const edge = { url: "https://example.org/edge", label: "edge\r\n" };
const outside = { url: "https://example.org/raw", label: "outside\r\n" };

function pending() {
  const doc = richToEditor([[{ code: "a漢字b" }], [edge], [outside]]);
  const state = EditorState.create({ doc, plugins: [history()] });
  const from = 2;
  const to = doc.child(0).nodeSize + 2;
  return { state, range: snapshotRichRange(doc, from, to) };
}

test("r8 deferred range keeps an insertion at its start outside deletion", () => {
  const { state, range } = pending();
  const tr = state.tr.insertText("X", range.from);
  const mapped = mapRichRange(range, tr);
  assert.ok(mapped);
  assert.equal(mapped.from, range.from + 1);
  const deletion = EditorState.create({ doc: tr.doc }).tr.setSelection(
    TextSelection.between(
      tr.doc.resolve(mapped.from),
      tr.doc.resolve(mapped.to),
    ),
  );
  deleteRichInput(deletion, "deleteCompositionText", () => {});
  assert.deepEqual(editorToRich(deletion.doc), [
    [{ code: "X" }, edge],
    [outside],
  ]);
});

test("r8 deferred range keeps an insertion at its end outside deletion", () => {
  const { state, range } = pending();
  const tr = state.tr.insertText("Y", range.to);
  const mapped = mapRichRange(range, tr);
  assert.ok(mapped);
  assert.equal(mapped.to, range.to);
  assert.ok(mapped.slice.eq(range.slice));
});

test("r8 deferred range rejects changed content with unchanged container types", () => {
  const { state, range } = pending();
  assert.equal(
    mapRichRange(range, state.tr.insertText("Z", range.from, range.from + 1)),
    null,
  );
  assert.equal(
    mapRichRange(range, state.tr.insertText("Q", range.from + 1)),
    null,
  );
  assert.equal(
    mapRichRange(range, state.tr.delete(range.from, range.to)),
    null,
  );
});

test("r8 deferred range rejects a different document and preserves equal parser replacements", () => {
  const { state, range } = pending();
  const equal = state.tr.replaceWith(
    0,
    state.doc.content.size,
    state.doc.content,
  );
  const mapped = mapRichRange(range, equal);
  assert.ok(mapped);
  assert.equal(mapped.from, range.from);
  assert.equal(mapped.to, range.to);
  const other = EditorState.create({ doc: richToEditor([["other"]]) });
  assert.equal(mapRichRange(range, other.tr), null);
});

test("r8 known cross-container commit is one lossless owned replacement", () => {
  const word = {
    word: { language: "jbo" as const, spelling: "cukta" },
    label: "cd",
  };
  let state = EditorState.create({
    doc: richToEditor([[{ code: "ab" }, word], [outside]]),
    plugins: [history()],
  });
  const apply = (tr: typeof state.tr) => {
    state = state.applyTransaction(tr).state;
  };
  apply(
    replaceRichText(
      state.tr.setSelection(TextSelection.create(state.doc, 3, 7)),
      "漢字",
    ),
  );
  const committed = [[{ code: "a漢字" }, { ...word, label: "d" }], [outside]];
  assert.deepEqual(editorToRich(state.doc), committed);
  const from = 2;
  const to = state.doc.child(0).nodeSize + 2;
  deleteRichInput(
    closeHistory(state.tr).setSelection(
      TextSelection.create(state.doc, from, to),
    ),
    "deleteCompositionText",
    apply,
  );
  assert.equal(undo(state, apply), true);
  assert.deepEqual(editorToRich(state.doc), committed);
});
