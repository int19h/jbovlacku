import assert from "node:assert/strict";
import { test } from "node:test";
import { EditorState, Plugin, TextSelection } from "prosemirror-state";
import {
  deleteRichBackward,
  editorToRich,
  richToEditor,
} from "../../src/model/rich-editor.ts";

test("paragraph joins keep step positions before plugins append coordinate changes", () => {
  let appends = 0;
  const shift = new Plugin({
    appendTransaction(transactions, _before, state) {
      if (!transactions.some((tr) => tr.docChanged) || appends) return null;
      appends++;
      return state.tr.insertText("prefix", 2);
    },
  });
  const doc = richToEditor([["ab"], ["", "cd"]]);
  const cursor = doc.firstChild!.nodeSize + 4;
  let state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, cursor),
    plugins: [shift],
  });
  assert.equal(
    deleteRichBackward(state, (tr) => {
      state = state.applyTransaction(tr).state;
    }),
    true,
  );
  assert.equal(appends, 1);
  assert.deepEqual(editorToRich(state.doc), [["prefixabcd"]]);
  assert.equal(state.doc.childCount, 1);
  state.doc.check();
});
