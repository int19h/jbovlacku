import assert from "node:assert/strict";
import { test } from "node:test";
import { history, undo, redo } from "prosemirror-history";
import { EditorState, TextSelection } from "prosemirror-state";
import {
  editorToRich,
  pastedRichText,
  replaceInline,
  richEditorSchema,
  richToEditor,
} from "../../src/model/rich-editor.ts";
import { richTextToText } from "../../src/model/richtext.ts";
import type { RichNode } from "../../src/model/types.ts";

test("plain projection keeps explicit tokens above place 50", () => {
  assert.equal(
    richTextToText([[50, " ", 51, " ", 65535]]),
    "㊿ {place 51} {place 65535}",
  );
});

for (const blank of ["\n\n\n", "\n \n", "\n\t\n", "\n \n\t\n", "\r\n\r\n"]) {
  test(`paste treats whitespace blank-line runs as one paragraph break ${JSON.stringify(blank)}`, () => {
    for (const convert of [false, true]) {
      assert.deepEqual(pastedRichText(`a${blank}b`, convert), [["a"], ["b"]]);
      assert.deepEqual(pastedRichText(`a\r\n${blank.slice(1)}b`, convert), [
        ["a"],
        ["b"],
      ]);
    }
    assert.deepEqual(pastedRichText("a\nb ", false), [["a\nb "]]);
  });
}

const containers: [string, RichNode][] = [
  ["code", { code: "ab" }],
  ["word link", { word: { language: "jbo", spelling: "cukta" }, label: "ab" }],
  ["web link", { url: "https://b.example/", label: "ab" }],
];
for (const [name, node] of containers) {
  test(`chip at offset zero goes before ${name}`, () => {
    const doc = richToEditor([[node]]);
    let state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 2),
      plugins: [history()],
    });
    const tr = replaceInline(
      state,
      2,
      2,
      richEditorSchema.nodes.place.create({ index: 1 }),
    );
    assert.deepEqual(editorToRich(tr.doc), [[1, node]]);
    assert.ok(tr.selection.from < tr.doc.child(0).nodeSize);
    state = state.apply(tr);
    const dispatch = (next: typeof tr) => {
      state = state.apply(next);
    };
    assert.equal(undo(state, dispatch), true);
    assert.deepEqual(editorToRich(state.doc), [[node]]);
    assert.equal(redo(state, dispatch), true);
    assert.deepEqual(editorToRich(state.doc), [[1, node]]);
    assert.equal(richTextToText(editorToRich(state.doc)), "①ab");
  });
}
