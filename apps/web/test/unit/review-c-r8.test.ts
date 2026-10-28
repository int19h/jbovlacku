import { test } from "node:test";
import assert from "node:assert/strict";
import {
  editorToRichText,
  richTextToEditor,
  remapPlaces,
} from "../../src/model/draft.ts";
import type { RichText } from "../../src/model/types.ts";

for (const point of [0x00a0, 0xfeff, 0x2000, 0x2028, 0x3000]) {
  for (const short of [false, true]) {
    test(`R8 U+${point.toString(16).toUpperCase().padStart(4, "0")} ${short ? "short" : "labelled"} URL classification stays stable`, () => {
      const url = String.fromCodePoint(point) + "https://example.org/a①";
      const label = short ? url : "docs";
      const source = short ? `[[${url}]]` : `[[${url}|${label}]]`;
      const expected: RichText = [[{ url, label }]];
      const first = editorToRichText(source, true);
      assert.deepEqual(first, expected);
      const shown = richTextToEditor(first);
      assert.equal(shown, source);
      assert.equal(
        remapPlaces(shown, () => 2),
        shown,
      );
      assert.deepEqual(editorToRichText(shown + " appended", true), [
        [...expected[0], " appended"],
      ]);
    });
  }
}
