import assert from "node:assert/strict";
import { test } from "node:test";
import { EditorState, TextSelection } from "prosemirror-state";
import { undoInputRule } from "prosemirror-inputrules";
import { baseKeymap } from "prosemirror-commands";
import {
  editorToRich,
  nextAutomaticPlace,
  pastedRichText,
  placeInputPlugins,
  richToEditor,
  richValue,
  deleteRichBackward,
  richInsertionSelection,
} from "../../src/model/rich-editor.ts";
import {
  PLACE_GLYPHS,
  circledPlace,
  placeGlyph,
} from "../../src/model/place-glyphs.ts";
import type { RichNode, RichText } from "../../src/model/types.ts";
import {
  plainText,
  richTextToText,
  textToRichText,
} from "../../src/model/richtext.ts";
import {
  explicitMeaningPlaces,
  placeSuggestionProblem,
} from "../../../../packages/core/src/place-assistance.ts";

test("stored nodes keep every boundary, empty label, and line ending", () => {
  const value: RichText = [
    [
      "a",
      "b",
      { code: "" },
      { code: "first\r\n\r\n①" },
      { code: "next" },
      { word: { language: "jbo", spelling: "https://cukta" }, label: "" },
      { url: "https:example.org", label: " \n\n " },
      50,
      65535,
      { operand: "bridi" },
    ],
  ];
  const doc = richToEditor(value);
  doc.check();
  assert.deepEqual(editorToRich(doc), value);
  assert.deepEqual(editorToRich(richToEditor([])), []);
  assert.deepEqual(editorToRich(richToEditor([[]])), []);
  const copied = richToEditor([[1, " ", { operand: "bridi" }, " ", 50]]);
  assert.equal(copied.textBetween(0, copied.content.size), "① [bridi] ㊿");
});

test("legacy plain-string imports omit empty paragraphs and keep stored arrays exact", () => {
  assert.deepEqual(richValue(""), []);
  assert.deepEqual(richValue("\n\n\n\n"), []);
  assert.deepEqual(richValue("\n\nFirst\n\n\n\nSecond\n\n"), [
    ["First"],
    ["Second"],
  ]);
  assert.deepEqual(richValue("\r\n\r\nFirst\r\n\r\n"), [["First"]]);
  const stored: RichText = [
    [
      "a",
      "b",
      { code: "\r\n\r\n" },
      { word: { language: "jbo", spelling: "cukta" }, label: "" },
    ],
  ];
  assert.equal(richValue(stored), stored);
  assert.deepEqual(richValue(stored), stored);
});

test("boundary Backspace deletes grapheme clusters and preserves neighboring nodes", () => {
  let state = EditorState.create({
    doc: richToEditor([
      [
        { code: "keep\r\n\r\nexact" },
        { word: { language: "jbo", spelling: "cukta" }, label: "e\u0301🙂" },
      ],
    ]),
  });
  state = state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)));
  const dispatch = (tr: ReturnType<EditorState["tr"]["insertText"]>) => {
    state = state.applyTransaction(tr).state;
  };
  assert.equal(deleteRichBackward(state, dispatch), true);
  assert.deepEqual(editorToRich(state.doc), [
    [
      { code: "keep\r\n\r\nexact" },
      { word: { language: "jbo", spelling: "cukta" }, label: "e\u0301" },
    ],
  ]);
  assert.equal(deleteRichBackward(state, dispatch), true);
  assert.deepEqual(editorToRich(state.doc), [
    [
      { code: "keep\r\n\r\nexact" },
      { word: { language: "jbo", spelling: "cukta" }, label: "" },
    ],
  ]);
});

test("current insertion ranges replace stale selections and keep equivalent outer carets", () => {
  let state = EditorState.create({
    doc: richToEditor([["keep"], ["replace"]]),
  });
  state = state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)));
  const from = state.doc.firstChild!.nodeSize + 2;
  const selection = richInsertionSelection(
    state,
    from,
    from + "replace".length,
  );
  assert.deepEqual(
    editorToRich(state.tr.setSelection(selection).insertText("new").doc),
    [["keep"], ["new"]],
  );
  assert.equal(richInsertionSelection(state, 2, 2).from, 2);
  const values: RichNode[] = [
    "literal",
    { code: "keep\r\n\r\ncode" },
    { word: { language: "jbo", spelling: "cukta" }, label: "keep\rword" },
    { url: "https://example.org/raw", label: "keep\r\nweb" },
    { code: "" },
    { word: { language: "jbo", spelling: "cukta" }, label: "" },
  ];
  for (const value of values) {
    let boundary = EditorState.create({ doc: richToEditor([[value]]) });
    boundary = boundary.apply(
      boundary.tr.setSelection(TextSelection.atEnd(boundary.doc)),
    );
    const end = boundary.selection.from;
    assert.equal(
      richInsertionSelection(boundary, end - 1, end - 1),
      boundary.selection,
    );
    assert.deepEqual(editorToRich(boundary.tr.insertText("!").doc), [
      typeof value === "string" ? [value + "!"] : [value, "!"],
    ]);
    boundary = boundary.apply(
      boundary.tr.setSelection(TextSelection.create(boundary.doc, 1)),
    );
    assert.equal(richInsertionSelection(boundary, 2, 2), boundary.selection);
  }
  let native = EditorState.create({ doc: richToEditor([]) });
  native = native.apply(native.tr.insertText("ab", 1));
  native = native.apply(
    native.tr.setSelection(TextSelection.create(native.doc, 1)),
  );
  assert.equal(richInsertionSelection(native, 2, 2).from, 2);
});

test("random stored rich values round trip exactly with a fixed seed", () => {
  let seed = 0xcafe1234;
  const random = (limit: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % limit;
  };
  const fragments = [
    "",
    "a",
    " ",
    "\n",
    "\r\n",
    "\n\n",
    "①㊿⓪",
    "\\{\\[\\\\",
    "[[https://cukta]]",
    "🙂",
    "אב",
    "`|]",
  ];
  const string = () =>
    Array.from(
      { length: random(5) },
      () => fragments[random(fragments.length)],
    ).join("");
  const node = (): RichNode => {
    switch (random(6)) {
      case 0:
        return string() || " ";
      case 1:
        return random(65535) + 1;
      case 2:
        return { operand: `operand-${random(10)}` };
      case 3:
        return { code: string() };
      case 4:
        return {
          word: {
            language: "jbo",
            spelling: ["cukta", "CUKTA", "https://cukta", "co'e"][random(4)],
          },
          label: string(),
        };
      default:
        return { url: `https://example.org/${random(10)}`, label: string() };
    }
  };
  for (let sample = 0; sample < 2000; sample++) {
    const value = Array.from({ length: random(7) }, () =>
      Array.from({ length: 1 + random(12) }, node),
    );
    const doc = richToEditor(value);
    doc.check();
    assert.deepEqual(editorToRich(doc), value, `sample ${sample}`);
  }
});

test("cleared fields stay empty and blank paragraphs use a newline string", () => {
  let state = EditorState.create({ doc: richToEditor([["existing"]]) });
  state = state.apply(state.tr.delete(0, state.doc.content.size));
  assert.deepEqual(editorToRich(state.doc), []);
  state = EditorState.create({ doc: richToEditor([["first"]]) });
  state = state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)));
  assert.equal(
    baseKeymap.Enter(state, (tr) => {
      state = state.apply(tr);
    }),
    true,
  );
  assert.equal(state.doc.childCount, 2);
  assert.deepEqual(editorToRich(state.doc), [["first"], ["\n"]]);
  state = state.apply(state.tr.insertText("second"));
  assert.deepEqual(editorToRich(state.doc), [["first"], ["second"]]);
});

test("the circled lookup covers all 50 places and excludes zero", () => {
  assert.equal(PLACE_GLYPHS.length, 50);
  assert.equal(new Set(PLACE_GLYPHS).size, 50);
  for (let index = 1; index <= 50; index++)
    assert.equal(circledPlace(placeGlyph(index)), index);
  assert.equal(placeGlyph(21), "㉑");
  assert.equal(placeGlyph(36), "㊱");
  assert.equal(placeGlyph(50), "㊿");
  assert.equal(circledPlace("⓪"), null);
  assert.equal(plainText([[21, 35, 36, 50]]), "㉑㉟㊱㊿");
  assert.equal(richTextToText([[21, 35, 36, 50]]), "㉑㉟㊱㊿");
  assert.deepEqual(textToRichText("㉑㉟㊱㊿⓪", true), [[21, 35, 36, 50, "⓪"]]);
});

function harness(value: RichText = [], enabled = true) {
  const plugins = placeInputPlugins({ enabled: () => enabled });
  let state = EditorState.create({ doc: richToEditor(value), plugins });
  state = state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)));
  const dispatch = (tr: ReturnType<EditorState["tr"]["insertText"]>) => {
    state = state.applyTransaction(tr).state;
  };
  const view = {
    get state() {
      return state;
    },
    composing: false,
    dispatch,
  };
  const type = (text: string) => {
    for (const char of text) {
      const { from, to } = state.selection;
      const handled = plugins[0].props.handleTextInput!.call(
        plugins[0],
        view as never,
        from,
        to,
        char,
        () => state.tr.insertText(char),
      );
      if (!handled) dispatch(state.tr.insertText(char));
    }
  };
  const backspace = () =>
    undoInputRule(state, (tr) => dispatch(tr.setMeta("richRuleUndo", true)));
  return {
    get state() {
      return state;
    },
    dispatch,
    type,
    backspace,
  };
}

test("typed rules convert on the final character and Backspace restores the complete token", () => {
  for (const [token, index] of [
    ["___", 1],
    ["__1__", 1],
    ["__50__", 50],
    ["㊱", 36],
  ] as const) {
    const h = harness();
    h.type(token);
    assert.deepEqual(editorToRich(h.state.doc), [[index]], token);
    assert.equal(h.backspace(), true);
    assert.equal(h.state.doc.textContent, token);
  }
  const h = harness([["prefix "]]);
  h.dispatch(
    h.state.tr.setSelection(
      TextSelection.create(h.state.doc, h.state.doc.content.size - 2),
    ),
  );
  h.type("__21__");
  assert.deepEqual(editorToRich(h.state.doc), [["prefix ", 21]]);
  h.backspace();
  assert.deepEqual(editorToRich(h.state.doc), [["prefix __21__"]]);
});

test("automatic numbering reserves explicit places and restarts after a semicolon", () => {
  const h = harness([[1, " and ", 4, " then "]]);
  h.type("___; ___ and ___");
  assert.deepEqual(editorToRich(h.state.doc), [
    [1, " and ", 4, " then ", 2, "; ", 1, " and ", 2],
  ]);
  const doc = richToEditor([
    [
      "; ",
      { code: ";" },
      1,
      " ",
      { word: { language: "jbo", spelling: "cukta" }, label: ";" },
      4,
    ],
  ]);
  assert.equal(nextAutomaticPlace(doc, doc.content.size - 1), 2);
});

test("completing saved partial tokens maps literal boundaries and restores the typed token", () => {
  for (const [partial, index, prefix] of [
    [["before __"], 1, "before "],
    [["before _", "_"], 1, "before "],
    [["before __50_"], 50, "before "],
    [["before _", "_50_"], 50, "before "],
    [["__"], 1, ""],
    [["_", "_"], 1, ""],
    [["__50_"], 50, ""],
    [["_", "_50_"], 50, ""],
  ] as const) {
    const converted = [[...(prefix ? [prefix] : []), index]];
    for (const inside of [false, true]) {
      const h = harness([[...partial]]);
      if (inside)
        h.dispatch(
          h.state.tr.setSelection(
            TextSelection.create(h.state.doc, h.state.doc.content.size - 2),
          ),
        );
      h.type("_");
      assert.deepEqual(editorToRich(h.state.doc), converted);
      assert.deepEqual(editorToRich(richToEditor(editorToRich(h.state.doc))), converted);
      assert.equal(h.backspace(), true);
      assert.equal(h.state.doc.textContent, partial.join("") + "_");
      h.state.doc.check();
    }
    const fallback = harness([[...partial]]);
    fallback.dispatch(fallback.state.tr.insertText("_"));
    assert.deepEqual(editorToRich(fallback.state.doc), converted);
    assert.deepEqual(editorToRich(richToEditor(editorToRich(fallback.state.doc))), converted);
    assert.equal(fallback.backspace(), true);
    assert.equal(fallback.state.doc.textContent, partial.join("") + "_");
  }
});

test("partial tokens never continue across code, links, or their empty labels", () => {
  for (const boundary of [
    { code: "_" },
    { code: "" },
    { word: { language: "jbo", spelling: "cukta" }, label: "_" },
    { word: { language: "jbo", spelling: "cukta" }, label: "" },
    { url: "https://example.org/", label: "_" },
    { url: "https://example.org/", label: "" },
  ] as const) {
    const h = harness([["before _", boundary, "_"]]);
    h.type("_");
    assert.deepEqual(editorToRich(h.state.doc), [
      ["before _", boundary, "__"],
    ]);
    const label = harness([[boundary]]);
    label.type("__");
    assert.deepEqual(editorToRich(label.state.doc), [[boundary, "__"]]);
  }
});

test("IME fallback converts DOM insertions and undo restores them once", () => {
  const h = harness();
  h.dispatch(h.state.tr.insertText("__50__"));
  assert.deepEqual(editorToRich(h.state.doc), [[50]]);
  assert.equal(h.backspace(), true);
  assert.equal(h.state.doc.textContent, "__50__");
});

test("deleting after literal paste and canceling composition never converts old tokens", () => {
  for (const token of ["㊿", "___", "__4__"]) {
    const h = harness();
    h.dispatch(h.state.tr.insertText(token + " ").setMeta("uiEvent", "paste"));
    const end = h.state.selection.from;
    h.dispatch(h.state.tr.delete(end - 1, end));
    assert.deepEqual(editorToRich(h.state.doc), [[token]]);
    const reparsed = richToEditor([[token]]);
    h.dispatch(h.state.tr.insertText(" ").setMeta("uiEvent", "paste"));
    const deletion = h.state.tr.replaceWith(
      0,
      h.state.doc.content.size,
      reparsed.content,
    );
    deletion.setSelection(
      TextSelection.create(deletion.doc, deletion.doc.content.size - 2),
    );
    h.dispatch(deletion);
    assert.deepEqual(editorToRich(h.state.doc), [[token]]);
    const newline = harness([[token]]);
    newline.type("\n");
    assert.equal(newline.state.doc.textContent, token + "\n");
    h.dispatch(h.state.tr.setMeta("richCompositionStart", true));
    h.dispatch(h.state.tr.setMeta("richCompositionEnd", true));
    assert.deepEqual(editorToRich(h.state.doc), [[token]]);
    h.dispatch(h.state.tr.setMeta("richCompositionStart", true));
    h.dispatch(h.state.tr.insertText("x"));
    const canceledEnd = h.state.selection.from;
    h.dispatch(h.state.tr.delete(canceledEnd - 1, canceledEnd));
    h.dispatch(h.state.tr.setMeta("richCompositionEnd", true));
    assert.deepEqual(editorToRich(h.state.doc), [[token]]);
  }
});

test("a real composition insertion converts after its committed end", () => {
  let composing = true;
  let state = EditorState.create({
    doc: richToEditor([]),
    plugins: placeInputPlugins({
      enabled: () => true,
      composing: () => composing,
    }),
  });
  const dispatch = (tr: ReturnType<EditorState["tr"]["insertText"]>) => {
    state = state.applyTransaction(tr).state;
  };
  dispatch(state.tr.setMeta("richCompositionStart", true));
  dispatch(state.tr.insertText("__50__"));
  assert.deepEqual(editorToRich(state.doc), [["__50__"]]);
  composing = false;
  dispatch(state.tr.setMeta("richCompositionEnd", true));
  assert.deepEqual(editorToRich(state.doc), [[50]]);
  assert.equal(
    undoInputRule(state, (tr) => dispatch(tr.setMeta("richRuleUndo", true))),
    true,
  );
  assert.deepEqual(editorToRich(state.doc), [["__50__"]]);
});

test("literal mode, code labels, invalid numbers, and pasted text do not run rules", () => {
  const literal = harness([], false);
  literal.type("___ __50__ ㊿");
  assert.equal(literal.state.doc.textContent, "___ __50__ ㊿");
  const code = harness([[{ code: "" }]]);
  code.dispatch(
    code.state.tr.setSelection(TextSelection.create(code.state.doc, 2)),
  );
  code.type("___ ㊿");
  assert.deepEqual(editorToRich(code.state.doc), [[{ code: "___ ㊿" }]]);
  for (const token of ["__0__", "__51__", "__01__", "⓪"]) {
    const h = harness();
    h.type(token);
    assert.equal(h.state.doc.textContent, token);
  }
  const paste = harness();
  paste.dispatch(
    paste.state.tr.insertText("___ ㊿").setMeta("uiEvent", "paste"),
  );
  assert.deepEqual(editorToRich(paste.state.doc), [["___ ㊿"]]);
  assert.deepEqual(
    pastedRichText(
      "<img src=x onerror=alert(1)> [[cukta]] `code` ___ ㊿",
      false,
    ),
    [["<img src=x onerror=alert(1)> [[cukta]] `code` ___ ㊿"]],
  );
  assert.deepEqual(pastedRichText("㉑㊱㊿⓪", true), [[21, 36, 50, "⓪"]]);
});

test("a backslash before a typed explicit place stays a literal backslash", () => {
  const h = harness();
  h.type("\\㊿ \\__4__");
  assert.deepEqual(editorToRich(h.state.doc), [["\\", 50, " \\", 4]]);
});

test("manual frames keep more than 16 places and gaps without an impossible AI contract", () => {
  const seventeen = Array.from({ length: 17 }, (_, index) => index + 1);
  assert.match(placeSuggestionProblem("", [seventeen], null)!, /at most 16/);
  assert.match(
    placeSuggestionProblem(PLACE_GLYPHS.slice(0, 17).join(" "), [], null)!,
    /at most 16/,
  );
  assert.match(placeSuggestionProblem("① and ④", [], null)!, /gaps/);
  assert.match(placeSuggestionProblem("", [[1, " and ", 4]], null)!, /gaps/);
  const frame = {
    arity: { mode: "context" },
    places: [
      { index: 1, description: [] },
      { index: 4, description: [] },
    ],
  };
  assert.equal(
    placeSuggestionProblem("① and ④", [[1, " and ", 4]], frame),
    null,
  );
  assert.match(
    placeSuggestionProblem("① and ④", [[1, " and ", 4]], null)!,
    /gaps/,
  );
  assert.equal(
    placeSuggestionProblem("", [seventeen], {
      places: seventeen.map((index) => ({ index })),
    }),
    null,
  );
  assert.equal(placeSuggestionProblem("① and ②", [], null), null);
  assert.deepEqual(explicitMeaningPlaces("\\① ㊿ \\{place 4}"), [4, 50]);
});
