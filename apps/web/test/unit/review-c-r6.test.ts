import { test } from "node:test";
import assert from "node:assert/strict";
import {
  editorToRichText,
  richTextToEditor,
  remapPlaces,
} from "../../src/model/draft.ts";
import type { RichNode, RichText } from "../../src/model/types.ts";

for (const content of ["x\n\n① ", "\nfirst\n\n①", " first\n \n\n① "]) {
  for (const kind of ["code", "word", "web"] as const) {
    test(`R6 editing beside padded ${kind} keeps its node type: ${JSON.stringify(content)}`, () => {
      const normalized = content.replace(/\n\s*\n/gu, "\n");
      const node = (value: string): RichNode =>
        kind === "code"
          ? { code: value }
          : kind === "word"
            ? { word: { language: "jbo", spelling: "cukta" }, label: value }
            : { url: "https://example.org/", label: value };
      const original: RichText = [[node(content)]];
      const before = structuredClone(original);
      const source = richTextToEditor(original);
      assert.deepEqual(editorToRichText(source + " appended", true), [
        [node(normalized), " appended"],
      ]);
      assert.equal(
        remapPlaces(source, () => 2),
        source,
      );
      assert.deepEqual(original, before);
    });
  }
}

for (const [first, last, expectedLast] of [
  ["don`t panic.", "isn`t it.", ["isn`t it."]],
  ["Write `x and more", "See (`ko'a`).", ["See (", { code: "ko'a" }, ")."]],
  [
    "See [[https://example.org|the source",
    "Also [[cukta]].",
    [
      "Also ",
      { word: { language: "jbo", spelling: "cukta" }, label: "cukta" },
      ".",
    ],
  ],
] as const) {
  test(`R6 unmatched delimiters do not capture later paragraphs: ${first}`, () => {
    for (const boundary of [
      "\n\n",
      "\n \t\n",
      "\n\u00a0\n",
      "\r\n\r\n",
      "\r\r",
    ]) {
      const source = `${first}${boundary}① is the agent.${boundary}${last}`;
      assert.deepEqual(editorToRichText(source, true), [
        [first],
        [1, " is the agent."],
        expectedLast,
      ]);
      assert.equal(
        remapPlaces(source, () => 2),
        source.replace("①", "②"),
      );
    }
  });
}

test("R6 a backslash cannot carry a span across a blank line", () => {
  for (const [first, last] of [
    ["`left\\", "right`"],
    ["[[https://example.org|left\\", "right]]"],
  ]) {
    const source = `${first}\n\n①\n\n${last}`;
    assert.deepEqual(editorToRichText(source, true), [[first], [1], [last]]);
    assert.equal(
      remapPlaces(source, () => 2),
      source.replace("①", "②"),
    );
  }
});

test("R6 single line breaks and ordinary inline padding stay inside code and links", () => {
  const rich: RichText = [
    [
      { code: " left\n① " },
      " ",
      { url: "https://example.org/", label: " left\n① " },
      " ",
      { code: "" },
    ],
  ];
  const source = richTextToEditor(rich);
  assert.deepEqual(editorToRichText(source, true), rich);
  assert.equal(
    remapPlaces(source, () => 2),
    source,
  );
});
