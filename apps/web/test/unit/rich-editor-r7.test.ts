import assert from "node:assert/strict";
import { before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { EditorState, TextSelection } from "prosemirror-state";
import { undoInputRule } from "prosemirror-inputrules";
import { initializeCore } from "../../../../packages/core/src/index.ts";
import {
  editorToRich,
  editedTextPlugin,
  placeInputPlugins,
  richToEditor,
} from "../../src/model/rich-editor.ts";
import {
  draftToBody,
  newDraft,
  newPlace,
  switchMode,
} from "../../src/model/draft.ts";
import { applyProposals, type Suggestion } from "../../src/model/assistance.ts";
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

/** This unit fixture tests the commit protocol. The browser file supplies real pending composition. */
function commit(
  text: string,
  initial: RichText = [],
  normalize = false,
  wholeContainer = false,
) {
  let composing = true;
  let state = EditorState.create({
    doc: richToEditor(initial),
    plugins: [
      ...(normalize ? [editedTextPlugin({ composing: () => composing })] : []),
      ...placeInputPlugins({ enabled: () => true, composing: () => composing }),
    ],
  });
  state = state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)));
  const dispatch = (transaction: EditorState["tr"]) => {
    state = state.applyTransaction(transaction).state;
  };
  dispatch(state.tr.setMeta("richCompositionStart", true));
  if (wholeContainer) {
    const node = state.doc.firstChild!.firstChild!;
    dispatch(
      state.tr.replaceWith(
        1,
        1 + node.nodeSize,
        node.type.create(
          node.attrs,
          node.type.schema.text(node.textContent + text),
        ),
      ),
    );
  } else dispatch(state.tr.insertText(text));
  composing = false;
  dispatch(state.tr.setMeta("richCompositionEnd", true));
  return {
    value: () => editorToRich(state.doc),
    undo: () =>
      undoInputRule(state, (transaction) =>
        dispatch(transaction.setMeta("richRuleUndo", true)),
      ),
  };
}

for (const [text, expected] of [
  ["____", [[1, "_"]]],
  ["__50___", [[50, "_"]]],
] as const) {
  test(`r7 S2 one committed ${text} follows incremental completion order`, () => {
    const editor = commit(text);
    assert.deepEqual(editor.value(), expected);
    assert.equal(editor.undo(), true);
    assert.deepEqual(editor.value(), [[text]]);
  });
}

test("r7 S2 committed tokens reserve existing places without reading code as tokens", () => {
  const editor = commit("____", [[1, " ", { code: "__50__" }, " "]]);
  assert.deepEqual(editor.value(), [[1, " ", { code: "__50__" }, " ", 2, "_"]]);
});

for (const token of ["__50__", "___"]) {
  test(`r7 S2 unrelated committed text does not convert the saved literal ${token}`, () => {
    const editor = commit("x", [[token]]);
    assert.deepEqual(editor.value(), [[token + "x"]]);
  });
  for (const wholeContainer of [false, true]) {
    test(`r7 S2 normalization keeps old literal ${token} beside unrelated x through ${wholeContainer ? "whole-container replacement" : "insertion"}`, () => {
      const editor = commit("x", [["a\r\nb\rc" + token]], true, wholeContainer);
      assert.deepEqual(editor.value(), [["a\nb\nc" + token + "x"]]);
    });
  }
}

test("r7 S2 normalization maps a newly completed saved prefix and its whole-commit undo", () => {
  const editor = commit("_", [["a\r\nb\rc__50_"]], true);
  assert.deepEqual(editor.value(), [["a\nb\nc", 50]]);
  assert.equal(editor.undo(), true);
  assert.deepEqual(editor.value(), [["a\nb\nc__50__"]]);
});

test("r7 S2 normalization keeps overlong committed conversion order and whole-commit undo", () => {
  const editor = commit("__50___", [["a\r\nb\rc "]], true, true);
  assert.deepEqual(editor.value(), [["a\nb\nc ", 50, "_"]]);
  assert.equal(editor.undo(), true);
  assert.deepEqual(editor.value(), [["a\nb\nc __50___"]]);
});

for (const literal of ["{place 0}", "{place 99999}", "{place 65536}"]) {
  test(`r7 S3 literal mode keeps out-of-range ${literal} as text`, () => {
    const draft = newDraft({ structured: false, text: [[literal]] });
    switchMode(draft, true);
    assert.deepEqual(draft.text, [[literal]]);
  });
}

for (const [literal, expected] of [
  ["{place 007}", 7],
  ["{place 3}", 3],
  ["{place 51}", 51],
  ["{place 65535}", 65535],
] as const) {
  test(`r7 S3 valid literal notation ${literal} keeps its existing meaning`, () => {
    const draft = newDraft({ structured: false, text: [[literal]] });
    switchMode(draft, true);
    assert.deepEqual(draft.text, [[expected]]);
  });
}

test("r7 M1 accepted definition text invalidates numbering approval and blocks publication", () => {
  const draft = newDraft({
    spelling: "ckusni",
    kind: "lujvo",
    meaning: "A private test meaning.",
    text: [[1, " gives ", 2]],
    frameMode: "fixed",
    places: [newPlace(1), newPlace(2)],
    numberingApproved: true,
  });
  const result: Suggestion = {
    operation: "definition",
    draft_revision: draft.revision,
    proposals: [{ path: "/text", value: [[2, " is given by ", 1]] }],
    explanation: "Synthetic proposal.",
    provenance: {
      provider: "mock",
      model: "mock",
      revision: null,
      recipe: "test",
      seed: null,
    },
    usage: null,
  };
  applyProposals(draft, result);
  assert.deepEqual(draft.text, [[2, " is given by ", 1]]);
  assert.equal(draft.numberingApproved, false);
  assert.equal(
    draftToBody(draft).problems.some(
      (problem) => problem.field === "numbering" && problem.blocking,
    ),
    true,
  );
});
