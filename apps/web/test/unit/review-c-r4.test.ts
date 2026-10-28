import { test } from "node:test";
import assert from "node:assert/strict";
import {
  editorToRichText,
  richTextToEditor,
  remapPlaces,
} from "../../src/model/draft.ts";
import { changedItems } from "../../src/model/comparison.ts";

test("N1 only documented backslash escapes change direct input", () => {
  for (const codepoint of [
    ...Array.from({ length: 128 }, (_, i) => i),
    0xa0,
    0x2000,
    0x2028,
  ]) {
    const c = String.fromCodePoint(codepoint);
    const value = `before\\${c}after`;
    const normalized = value.replace(/\r/gu, "\n");
    if (!"\\`[{".includes(c))
      assert.deepEqual(
        editorToRichText(value, true),
        [[normalized]],
        JSON.stringify(value),
      );
    if (!"\\`".includes(c))
      assert.deepEqual(
        editorToRichText(`\`${value}\``, true),
        [[{ code: normalized }]],
        JSON.stringify(value),
      );
    if (!"\\]|`".includes(c))
      assert.deepEqual(
        editorToRichText(`[[cukta|${value}]]`, true),
        [[{ word: { language: "jbo", spelling: "cukta" }, label: normalized }]],
        JSON.stringify(value),
      );
  }
});

for (const value of [
  String.raw`\rightarrow \rho \rm Tom \& Jerry C:\readme hello\ world`,
  "slash\\\tand\\\nnext",
]) {
  test(`N1 typed backslashes stay literal: ${JSON.stringify(value)}`, () => {
    assert.deepEqual(editorToRichText(value, true), [[value]]);
    assert.deepEqual(
      editorToRichText(`\`${value}\` [[cukta|${value}]]`, true),
      [
        [
          { code: value },
          " ",
          { word: { language: "jbo", spelling: "cukta" }, label: value },
        ],
      ],
    );
  });
}

test("N1 a backslash before a raw blank line keeps the paragraph boundary", () => {
  for (const boundary of ["\n\n", "\n \n", "\r\n\r\n", "\n\u00a0\n"]) {
    const source = `C:\\${boundary}① next`;
    assert.deepEqual(editorToRichText(source, true), [["C:\\"], [1, " next"]]);
    assert.equal(
      remapPlaces(source, () => 2),
      `C:\\${boundary}② next`,
    );
    for (const [opening, closing] of [
      ["`C:\\", "next"],
      ["[[cukta|C:\\", "next"],
    ])
      assert.deepEqual(
        editorToRichText(`${opening}${boundary}${closing}`, true),
        [[opening], [closing]],
      );
  }
});

test("N2 raw trailing whitespace disappears from each paragraph and the field", () => {
  for (const tail of [" ", " \n", "\n\n  ", "\n\u00a0\n\t", "\r\n\r\n \t"]) {
    assert.deepEqual(editorToRichText(`Definition.${tail}`, true), [
      ["Definition."],
    ]);
  }
  assert.deepEqual(editorToRichText("word \n\nnext \t", true), [
    ["word"],
    ["next"],
  ]);
});

test("N3 distant sparse edits above the cell budget stay separate", () => {
  for (const size of [250, 3000]) {
    const before = Array.from({ length: size }, (_, i) => `item${i}`);
    const after = [...before];
    after.splice(4, 0, "added");
    after[size - 5] = "changed";
    assert.deepEqual(changedItems(before, after), [
      [undefined, "added"],
      [before[size - 6], "changed"],
    ]);
    assert.deepEqual(changedItems(after, before), [
      ["added", undefined],
      ["changed", before[size - 6]],
    ]);
    assert.deepEqual(changedItems(before, [...before.slice(1), before[0]]), [
      [before[0], undefined],
      [undefined, before[0]],
    ]);
  }
});

test("N4 ordinary single line breaks stay readable", () => {
  const text = "line one\nline two\nline three";
  assert.equal(richTextToEditor([[text]]), text);
  assert.deepEqual(editorToRichText(text, true), [[text]]);
});
