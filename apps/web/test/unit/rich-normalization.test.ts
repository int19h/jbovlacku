import assert from "node:assert/strict";
import { before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { initializeCore } from "../../../../packages/core/src/index.ts";
import {
  newDraft,
  newPlace,
  draftToBody,
  switchMode,
} from "../../src/model/draft.ts";
import { applyProposals, type Suggestion } from "../../src/model/assistance.ts";
import { EditorState, TextSelection } from "prosemirror-state";
import { history, undo, redo, undoDepth } from "prosemirror-history";
import { splitBlock, joinBackward } from "prosemirror-commands";
import {
  editedTextPlugin,
  placeInputPlugins,
  editorToRich,
  richToEditor,
} from "../../src/model/rich-editor.ts";
import { undoInputRule } from "prosemirror-inputrules";
import {
  canonicalRichFields,
  editedRich,
} from "../../src/model/rich-values.ts";
import type { RichNode, RichText } from "../../src/model/types.ts";

const raw = "a\r\nb\rc";
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
const left: RichNode[] = ["left\r\n", " adjacent\r", { code: "keep\r\n" }];
for (const kind of ["prose", "code", "word", "web"] as const) {
  const node = (text: string): RichNode =>
    kind === "prose"
      ? text
      : kind === "code"
        ? { code: text }
        : kind === "word"
          ? { word: { language: "jbo", spelling: "cukta" }, label: text }
          : { url: "https://example.org/", label: text };
  test(`edited ${kind} text uses LF through input undo redo and deletion`, () => {
    let state = EditorState.create({
      doc: richToEditor([[...left, node(raw), "right\r\n"]]),
      plugins: [editedTextPlugin(), history()],
    });
    const at =
      1 +
      left.reduce<number>(
        (sum, _node, index) =>
          sum + state.doc.firstChild!.child(index).nodeSize,
        0,
      ) +
      1;
    const dispatch = (transaction: typeof state.tr) => {
      state = state.applyTransaction(transaction).state;
    };
    dispatch(
      state.tr
        .setSelection(TextSelection.create(state.doc, at + raw.length))
        .insertText("X"),
    );
    const expected: RichText = [[...left, node("a\nb\ncX"), "right\r\n"]];
    assert.deepEqual(editorToRich(state.doc), expected);
    assert.equal(undoDepth(state), 1);
    assert.equal(undo(state, dispatch), true);
    assert.deepEqual(editorToRich(state.doc), [
      [...left, node("a\nb\nc"), "right\r\n"],
    ]);
    assert.equal(undoDepth(state), 0);
    assert.equal(redo(state, dispatch), true);
    assert.deepEqual(editorToRich(state.doc), expected);
    assert.equal(undoDepth(state), 1);
    dispatch(state.tr.delete(at + 2, at + 3));
    assert.deepEqual(editorToRich(state.doc), [
      [...left, node("a\n\ncX"), "right\r\n"],
    ]);
  });
}

test("split and join normalize edited prose fragments and preserve neighboring containers", () => {
  let state = EditorState.create({
    doc: richToEditor([[...left, raw, "right\r\n"]]),
    plugins: [editedTextPlugin(), history()],
  });
  const at =
    1 +
    left.reduce<number>(
      (sum, _, index) => sum + state.doc.firstChild!.child(index).nodeSize,
      0,
    ) +
    1;
  const dispatch = (transaction: typeof state.tr) => {
    state = state.applyTransaction(transaction).state;
  };
  dispatch(state.tr.setSelection(TextSelection.create(state.doc, at + 3)));
  assert.equal(splitBlock(state, dispatch), true);
  assert.deepEqual(editorToRich(state.doc), [
    [...left, "a\n"],
    ["b\nc", "right\r\n"],
  ]);
  dispatch(
    state.tr.setSelection(
      TextSelection.create(state.doc, state.doc.firstChild!.nodeSize + 1),
    ),
  );
  assert.equal(joinBackward(state, dispatch), true);
  assert.deepEqual(editorToRich(state.doc), [
    [...left, "a\nb\nc", "right\r\n"],
  ]);
});

test("accepted rich replacements clean only changed fields and text nodes", () => {
  const before = {
    text: [["before\r\n", { code: raw }], [" \t"]],
    notes: [["note\r"], [" "]],
  };
  const next = {
    text: [["before\r\n", { code: raw + "X" }], [" \t"]],
    notes: before.notes,
  };
  const result = canonicalRichFields(next, before);
  assert.deepEqual(result.text, [["before\r\n", { code: "a\nb\ncX" }]]);
  assert.equal(result.notes, before.notes);
  assert.deepEqual(
    editedRich(
      [[{ url: "https://example.org/new", label: raw }]],
      [[{ url: "https://example.org/old", label: raw }]],
    ),
    [[{ url: "https://example.org/new", label: raw }]],
  );
  const ai = {
    log_json: '{"text":[[" "]]}',
    records: [{ result: { proposals: [{ value: [[" \t"]] }] } }],
  };
  assert.equal(canonicalRichFields({ ai }).ai, ai);
});

test("accepted replacements preserve moved unchanged nodes and frame descriptions", () => {
  const code = { code: raw };
  const label = { url: "https://example.org/", label: raw };
  assert.deepEqual(editedRich([["inserted", label, code]], [[code, label]]), [
    ["inserted", label, code],
  ]);
  const description: RichText = [["description\r\n", " adjacent\r"], [" \t"]];
  const before = {
    frame: {
      places: [
        { index: 1, description },
        { index: 2, description: [["second"]] },
      ],
    },
  };
  const next = {
    frame: {
      places: [
        { index: 2, description: [["changed"]] },
        { index: 1, description: structuredClone(description) },
      ],
    },
  };
  assert.deepEqual(
    canonicalRichFields(next, before).frame.places[1].description,
    description,
  );
});

test("proposal acceptance keeps moved fields exact and changes only proposed text", () => {
  const exact: RichText = [[raw, " adjacent"], [" \t"]];
  const second = newPlace(2),
    third = newPlace(3);
  second.description = exact;
  third.description = [["third"]];
  const draft = newDraft({
    spelling: "broda",
    kind: "gismu",
    text: [["definition"]],
    notes: exact,
    frameMode: "context",
    places: [second, third],
  });
  const frame = structuredClone(draftToBody(draft).body!.frame!);
  frame.places.unshift({
    ...structuredClone(frame.places[1]),
    index: 1,
    description: [["new\r\nplace"]],
  });
  const suggestion = {
    operation: "definition",
    proposals: [
      { path: "/text", value: [["changed\r\ntext"]] },
      { path: "/frame", value: frame },
    ],
  } as Suggestion;
  const evidence = structuredClone(suggestion);
  applyProposals(draft, suggestion);
  assert.deepEqual(draft.text, [["changed\ntext"]]);
  assert.deepEqual(draft.places[0].description, [["new\nplace"]]);
  assert.deepEqual(draft.places[1].description, exact);
  assert.deepEqual(draft.notes, exact);
  assert.deepEqual(suggestion, evidence);
});

test("switching a restored literal mode without text changes preserves exact fields", () => {
  const exact: RichText = [[raw, " adjacent"], [" \t"]];
  const draft = newDraft({
    spelling: "broda",
    kind: "gismu",
    text: exact,
    notes: exact,
    structured: false,
  });
  switchMode(draft, true);
  assert.deepEqual(draft.text, exact);
  assert.deepEqual(draft.notes, exact);
});

test("line-ending normalization keeps immediate input-rule Backspace intact", () => {
  const rules = placeInputPlugins({ enabled: () => true });
  let state = EditorState.create({
    doc: richToEditor([["keep\r\n__"]]),
    plugins: [editedTextPlugin(), ...rules, history()],
  });
  const dispatch = (transaction: typeof state.tr) => {
    state = state.applyTransaction(transaction).state;
  };
  dispatch(
    state.tr.setSelection(
      TextSelection.create(state.doc, 2 + "keep\r\n__".length),
    ),
  );
  const view = {
    get state() {
      return state;
    },
    dispatch,
    composing: false,
  };
  assert.equal(
    rules[0].props.handleTextInput!.call(
      rules[0],
      view as never,
      state.selection.from,
      state.selection.to,
      "_",
      () => state.tr.insertText("_"),
    ),
    true,
  );
  assert.deepEqual(editorToRich(state.doc), [["keep\n", 1]]);
  assert.equal(
    undoInputRule(state, (transaction) =>
      dispatch(transaction.setMeta("richRuleUndo", true)),
    ),
    true,
  );
  assert.deepEqual(editorToRich(state.doc), [["keep\n___"]]);
});

test("preedit serializes edited nodes to LF before commit without changing the active model", () => {
  const base = richToEditor([[...left, raw]]);
  let composing = true;
  let state = EditorState.create({
    doc: base,
    plugins: [editedTextPlugin({ composing: () => composing }), history()],
  });
  const dispatch = (transaction: typeof state.tr) => {
    state = state.applyTransaction(transaction).state;
  };
  dispatch(state.tr.setMeta("richCompositionStart", true));
  const at = base.content.size - 2;
  dispatch(state.tr.insertText("漢", at).setMeta("composition", 1));
  assert.deepEqual(editorToRich(state.doc), [[...left, raw + "漢"]]);
  assert.deepEqual(editorToRich(state.doc, base), [[...left, "a\nb\nc漢"]]);
  composing = false;
  dispatch(state.tr.setMeta("richCompositionEnd", true));
  assert.deepEqual(editorToRich(state.doc), [[...left, "a\nb\nc漢"]]);
  assert.equal(undoDepth(state), 1);
  assert.equal(undo(state, dispatch), true);
  assert.deepEqual(editorToRich(state.doc), [[...left, "a\nb\nc"]]);
  assert.equal(undoDepth(state), 0);
});

test("deferred normalization preserves composition rule conversion and its Backspace", () => {
  let composing = true;
  const rules = placeInputPlugins({
    enabled: () => true,
    composing: () => composing,
  });
  let state = EditorState.create({
    doc: richToEditor([[raw + "__50_"]]),
    plugins: [
      editedTextPlugin({ composing: () => composing }),
      ...rules,
      history(),
    ],
  });
  const dispatch = (transaction: typeof state.tr) => {
    state = state.applyTransaction(transaction).state;
  };
  dispatch(
    state.tr.setSelection(
      TextSelection.create(state.doc, state.doc.content.size - 2),
    ),
  );
  dispatch(state.tr.setMeta("richCompositionStart", true));
  dispatch(state.tr.insertText("_").setMeta("composition", 1));
  assert.deepEqual(editorToRich(state.doc), [[raw + "__50__"]]);
  composing = false;
  dispatch(state.tr.setMeta("richCompositionEnd", true));
  assert.deepEqual(editorToRich(state.doc), [["a\nb\nc", 50]]);
  assert.equal(
    undoInputRule(state, (transaction) =>
      dispatch(transaction.setMeta("richRuleUndo", true)),
    ),
    true,
  );
  assert.deepEqual(editorToRich(state.doc), [["a\nb\nc__50__"]]);
});

const exactCode = { code: "code\r\nexact" };
const exactWord = {
  word: { language: "jbo" as const, spelling: "cukta" },
  label: "word\rexact",
};
const exactWeb = { url: "https://example.org/", label: "web\r\nexact" };
const exactTail = ["untouched\r", " adjacent\r\n"];

test("loaded paragraph joins normalize the combined stored string through undo and redo", () => {
  let state = EditorState.create({
    doc: richToEditor([
      [exactCode, "left\r"],
      ["right\r\n", exactWord, exactWeb, ...exactTail],
    ]),
    plugins: [editedTextPlugin(), history()],
  });
  const dispatch = (transaction: typeof state.tr) => {
    state = state.applyTransaction(transaction).state;
  };
  dispatch(
    state.tr.setSelection(
      TextSelection.create(state.doc, state.doc.firstChild!.nodeSize + 1),
    ),
  );
  assert.equal(undoDepth(state), 0);
  assert.equal(joinBackward(state, dispatch), true);
  const joined = [
    [exactCode, "left\nright\n", exactWord, exactWeb, ...exactTail],
  ];
  assert.deepEqual(editorToRich(state.doc), joined);
  assert.equal(undoDepth(state), 1);
  assert.equal(undo(state, dispatch), true);
  assert.deepEqual(editorToRich(state.doc), [
    [exactCode, "left\n"],
    ["right\n", exactWord, exactWeb, ...exactTail],
  ]);
  assert.equal(undoDepth(state), 0);
  assert.equal(redo(state, dispatch), true);
  assert.deepEqual(editorToRich(state.doc), joined);
  assert.equal(undoDepth(state), 1);
});

for (const side of ["prepend", "append"] as const) {
  test(`outside-container ${side} normalizes every contributor to its stored string`, () => {
    let state = EditorState.create({
      doc: richToEditor([[exactCode, raw, exactWord, exactWeb, ...exactTail]]),
      plugins: [editedTextPlugin(), history()],
    });
    const dispatch = (transaction: typeof state.tr) => {
      state = state.applyTransaction(transaction).state;
    };
    const start = 1 + state.doc.firstChild!.firstChild!.nodeSize;
    const at =
      start + (side === "append" ? state.doc.firstChild!.child(1).nodeSize : 0);
    dispatch(
      state.tr
        .setSelection(TextSelection.create(state.doc, at))
        .insertText("X"),
    );
    const target = side === "append" ? "a\nb\ncX" : "Xa\nb\nc";
    assert.deepEqual(editorToRich(state.doc), [
      [exactCode, target, exactWord, exactWeb, ...exactTail],
    ]);
    assert.equal(undoDepth(state), 1);
    assert.equal(undo(state, dispatch), true);
    assert.deepEqual(editorToRich(state.doc), [
      [exactCode, "a\nb\nc", exactWord, exactWeb, ...exactTail],
    ]);
    assert.equal(undoDepth(state), 0);
    assert.equal(redo(state, dispatch), true);
    assert.deepEqual(editorToRich(state.doc), [
      [exactCode, target, exactWord, exactWeb, ...exactTail],
    ]);
    assert.equal(undoDepth(state), 1);
  });
}

test("preedit exports LF for retained contributors to a newly combined stored string", () => {
  let composing = true;
  const base = richToEditor([
    [exactCode, raw, exactWord, exactWeb, ...exactTail],
  ]);
  let state = EditorState.create({
    doc: base,
    plugins: [editedTextPlugin({ composing: () => composing }), history()],
  });
  const dispatch = (transaction: typeof state.tr) => {
    state = state.applyTransaction(transaction).state;
  };
  const at =
    1 + base.firstChild!.child(0).nodeSize + base.firstChild!.child(1).nodeSize;
  dispatch(state.tr.setSelection(TextSelection.create(state.doc, at)));
  dispatch(state.tr.setMeta("richCompositionStart", true));
  dispatch(state.tr.insertText("漢").setMeta("composition", 1));
  const expected = [
    [exactCode, "a\nb\nc漢", exactWord, exactWeb, ...exactTail],
  ];
  assert.equal(state.doc.firstChild!.child(1), base.firstChild!.child(1));
  assert.deepEqual(editorToRich(state.doc, base), expected);
  assert.deepEqual(editorToRich(state.doc), [
    [exactCode, raw + "漢", exactWord, exactWeb, ...exactTail],
  ]);
  composing = false;
  dispatch(state.tr.setMeta("richCompositionEnd", true));
  assert.deepEqual(editorToRich(state.doc), expected);
  assert.equal(undoDepth(state), 1);
  assert.equal(undo(state, dispatch), true);
  assert.deepEqual(editorToRich(state.doc), [
    [exactCode, "a\nb\nc", exactWord, exactWeb, ...exactTail],
  ]);
  assert.equal(undoDepth(state), 0);
});

test("a retained saved-string boundary keeps its untouched CR text exact", () => {
  let state = EditorState.create({
    doc: richToEditor([
      ["left\r", " right\r\n", exactCode, exactWord, exactWeb],
    ]),
    plugins: [editedTextPlugin()],
  });
  state = state.applyTransaction(state.tr.insertText("X", 6)).state;
  assert.deepEqual(editorToRich(state.doc), [
    ["leftX\n", " right\r\n", exactCode, exactWord, exactWeb],
  ]);
});

test("a CRLF pair across combined fragments normalizes once in joins and preedit", () => {
  let state = EditorState.create({
    doc: richToEditor([
      [exactCode, "left\r"],
      ["\nright", exactWord, exactWeb],
    ]),
    plugins: [editedTextPlugin(), history()],
  });
  const dispatch = (transaction: typeof state.tr) => {
    state = state.applyTransaction(transaction).state;
  };
  dispatch(
    state.tr.setSelection(
      TextSelection.create(state.doc, state.doc.firstChild!.nodeSize + 1),
    ),
  );
  assert.equal(joinBackward(state, dispatch), true);
  const joined = [[exactCode, "left\nright", exactWord, exactWeb]];
  assert.deepEqual(editorToRich(state.doc), joined);
  assert.equal(undoDepth(state), 1);
  assert.equal(undo(state, dispatch), true);
  assert.deepEqual(editorToRich(state.doc), [
    [exactCode, "left\n"],
    ["right", exactWord, exactWeb],
  ]);
  assert.equal(undoDepth(state), 0);
  assert.equal(redo(state, dispatch), true);
  assert.deepEqual(editorToRich(state.doc), joined);
  assert.equal(undoDepth(state), 1);
  let composing = true;
  const base = richToEditor([[exactCode, "left\r", exactWord, exactWeb]]);
  state = EditorState.create({
    doc: base,
    plugins: [editedTextPlugin({ composing: () => composing }), history()],
  });
  dispatch(
    state.tr.setSelection(
      TextSelection.create(
        state.doc,
        1 +
          base.firstChild!.child(0).nodeSize +
          base.firstChild!.child(1).nodeSize,
      ),
    ),
  );
  dispatch(state.tr.setMeta("richCompositionStart", true));
  dispatch(state.tr.insertText("\nright").setMeta("composition", 1));
  assert.deepEqual(editorToRich(state.doc, base), joined);
  assert.deepEqual(editorToRich(state.doc), [
    [exactCode, "left\r\nright", exactWord, exactWeb],
  ]);
  composing = false;
  dispatch(state.tr.setMeta("richCompositionEnd", true));
  assert.deepEqual(editorToRich(state.doc), joined);
  assert.equal(undo(state, dispatch), true);
  assert.deepEqual(editorToRich(state.doc), [
    [exactCode, "left\n", exactWord, exactWeb],
  ]);
  assert.equal(undoDepth(state), 0);
  assert.equal(redo(state, dispatch), true);
  assert.deepEqual(editorToRich(state.doc), joined);
  const retained = richToEditor([
    ["left\r", "\nright", exactCode, exactWord, exactWeb],
  ]);
  state = EditorState.create({ doc: retained, plugins: [editedTextPlugin()] });
  const codeEnd =
    1 +
    retained.firstChild!.child(0).nodeSize +
    retained.firstChild!.child(1).nodeSize +
    retained.firstChild!.child(2).nodeSize -
    1;
  dispatch(state.tr.insertText("X", codeEnd));
  assert.deepEqual(editorToRich(state.doc), [
    ["left\r", "\nright", { code: "code\nexactX" }, exactWord, exactWeb],
  ]);
});
