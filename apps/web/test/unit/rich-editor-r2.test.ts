import assert from "node:assert/strict";
import { test } from "node:test";
import * as editorModel from "../../src/model/rich-editor.ts";
import { EditorState, TextSelection } from "prosemirror-state";
import { baseKeymap } from "prosemirror-commands";
import {
  richToEditor,
  editorToRich,
  replaceInline,
  richEditorSchema,
  deleteRichBackward,
} from "../../src/model/rich-editor.ts";
import { plainText } from "../../src/model/richtext.ts";
import { manualFormation } from "../../src/model/builders.ts";
import { placeSuggestionProblem } from "../../../../packages/core/src/place-assistance.ts";
import type { RichNode, RichText } from "../../src/model/types.ts";

test("r2 AI guard includes blank numbering before explicit places", () => {
  for (const meaning of [
    "___ gives ___ to ③",
    "___ ___ ③ ___",
    "___ ③; ___ ___ ③",
  ]) {
    assert.equal(placeSuggestionProblem(meaning, [], null), null, meaning);
  }
});
test("r2 AI guard prioritizes current definition places over stale Meaning", () => {
  assert.equal(placeSuggestionProblem("x ⑳", [[1, " and ", 2]], null), null);
});
test("r2 numeric display and copied text retain places above 50", () => {
  assert.equal(plainText([[51, " ", 65535]]), "51 65535");
  const doc = richToEditor([[51, " ", 65535]]);
  assert.equal(doc.textBetween(0, doc.content.size), "51 65535");
});
test("r2 writing new adjacent text merges runs and keeps untouched stored boundaries", () => {
  let state = EditorState.create({ doc: richToEditor([["old", " boundary"]]) });
  state = state.apply(
    state.tr.setSelection(TextSelection.atEnd(state.doc)).insertText(" plus"),
  );
  assert.deepEqual(editorToRich(state.doc), [["old", " boundary plus"]]);
});
test("r2 trailing blank paragraphs survive storage and reload", () => {
  let state = EditorState.create({ doc: richToEditor([["first"]]) });
  state = state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)));
  assert.equal(
    baseKeymap.Enter(state, (tr) => {
      state = state.apply(tr);
    }),
    true,
  );
  assert.deepEqual(editorToRich(state.doc), [["first"], ["\n"]]);
  const doc = richToEditor(editorToRich(state.doc));
  assert.equal(doc.childCount, 2);
  assert.equal(doc.lastChild!.textContent, "");
  assert.deepEqual(editorToRich(richToEditor([["\n"], ["a", "b"], ["\n"]])), [
    ["\n"],
    ["a", "b"],
    ["\n"],
  ]);
});
test("r2 whitespace alone creates no manual formation", () => {
  assert.equal(manualFormation([], [[" \n\t"]]), null);
});
test("r2 cross-container toolbar replacement consumes the whole selection", () => {
  for (const node of [
    { code: "abcd" },
    { word: { language: "jbo", spelling: "cukta" }, label: "abcd" },
    { url: "https://example.org/", label: "abcd" },
  ]) {
    const state = EditorState.create({ doc: richToEditor([[node, " after"]]) });
    const tr = replaceInline(
      state,
      4,
      state.doc.content.size - 1,
      richEditorSchema.nodes.place.create({ index: 1 }),
    );
    const prefix = "code" in node ? { code: "ab" } : { ...node, label: "ab" };
    assert.deepEqual(editorToRich(tr.doc), [[prefix, 1]]);
  }
});
test("r2 seeded random edit sequences retain legal values and untouched boundaries", () => {
  let seed = 0x51ed17;
  const random = (limit: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % limit;
  };
  const fragments = ["a", "e\u0301", "🙂", " ", "\\", "①", "\n"];
  for (let sample = 0; sample < 120; sample++) {
    const keep: RichText = [
      [
        "untouched",
        " boundary",
        { code: "" },
        { word: { language: "jbo", spelling: "https://cukta" }, label: "" },
      ],
    ];
    let state = EditorState.create({ doc: richToEditor([...keep, ["start"]]) });
    let expected = "start";
    for (let step = 0; step < 16; step++) {
      const text = fragments[random(fragments.length)];
      state = state.apply(
        state.tr.setSelection(TextSelection.atEnd(state.doc)).insertText(text),
      );
      expected += text;
      assert.deepEqual(
        editorToRich(state.doc),
        [...keep, [expected]],
        `append sample ${sample} step ${step}`,
      );
      if (random(3) === 0) {
        deleteRichBackward(state, (tr) => {
          state = state.apply(tr);
        });
        const parts = [
          ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
            expected,
          ),
        ];
        expected = expected.slice(0, parts.at(-1)!.index);
        assert.deepEqual(
          editorToRich(state.doc),
          [...keep, [expected]],
          `backspace sample ${sample} step ${step}`,
        );
      }
      if (random(4) === 0 && expected) {
        const start = state.doc.firstChild!.nodeSize + 1;
        state = state.apply(
          state.tr.setSelection(TextSelection.create(state.doc, start)),
        );
        (editorModel.deleteRichForward ?? baseKeymap.Delete)(state, (tr) => {
          state = state.apply(tr);
        });
        const first = new Intl.Segmenter(undefined, { granularity: "grapheme" })
          .segment(expected)
          .containing(0)!;
        expected = expected.slice(first.segment.length);
        assert.deepEqual(
          editorToRich(state.doc),
          [...keep, [expected]],
          `forward Delete sample ${sample} step ${step}`,
        );
      }
      const stored = editorToRich(state.doc);
      richToEditor(stored).check();
      assert.deepEqual(editorToRich(richToEditor(stored)), stored);
    }
    state = state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)));
    assert.equal(
      baseKeymap.Enter(state, (tr) => {
        state = state.apply(tr);
      }),
      true,
    );
    assert.deepEqual(editorToRich(state.doc), [...keep, [expected], ["\n"]]);
    const pasted = fragments[random(fragments.length)] + "paste";
    state = state.apply(
      state.tr.insertText(pasted).setMeta("uiEvent", "paste"),
    );
    assert.deepEqual(editorToRich(state.doc), [...keep, [expected], [pasted]]);
    const index = random(50) + 1;
    state = state.apply(
      replaceInline(
        state,
        state.selection.from,
        state.selection.to,
        richEditorSchema.nodes.place.create({ index }),
      ),
    );
    assert.deepEqual(editorToRich(state.doc), [
      ...keep,
      [expected],
      [pasted, index],
    ]);
    const editable: RichNode = random(2)
      ? { code: "abcd" }
      : { url: "https://example.org/", label: "abcd" };
    state = EditorState.create({
      doc: richToEditor([...keep, [editable, " after"]]),
    });
    const start = state.doc.firstChild!.nodeSize + 4;
    const replaced = replaceInline(
      state,
      start,
      state.doc.content.size - 1,
      richEditorSchema.nodes.place.create({ index: random(50) + 1 }),
    );
    assert.deepEqual(editorToRich(replaced.doc)[0], keep[0]);
    assert.equal(editorToRich(replaced.doc)[1].length, 2);
    assert.equal(
      plainText([editorToRich(replaced.doc)[1]]).includes("after"),
      false,
    );
  }
});
