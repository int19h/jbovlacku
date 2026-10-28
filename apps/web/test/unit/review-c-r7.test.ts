import { before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { initializeCore } from "../../../../packages/core/src/index.ts";
import {
  draftToBody,
  editorToRichText,
  newDraft,
  newPlace,
  richTextToEditor,
  remapPlaces,
} from "../../src/model/draft.ts";

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

const urls: readonly (readonly [string, string, boolean?])[] = [
  ["https:\n\nexample.org/path", "https://example.org/path", true],
  ["ht\r\n\r\ntps://example.org/path", "https://example.org/path"],
  ["https://example.org/\n\npath", "https://example.org/path"],
  ["https://example.org/a\n\n①", "https://example.org/a①"],
  [
    "https://example.org/a\r\n\t\r\npath?q=left \n\nright",
    "https://example.org/apath?q=left right",
  ],
  ["https://example.org/a\n \n①?q=a b", "https://example.org/a ①?q=a b"],
  [
    "https://example.org/a\n\u00a0\n①?q=a\u2028 b",
    "https://example.org/a\u00a0①?q=a\u2028 b",
  ],
  ["https://example.org/a\n\n①\u00a0", "https://example.org/a①\u00a0"],
  ["https://example.org/a?q=a\n\nb\u2000", "https://example.org/a?q=ab\u2000"],
  [
    "https://example.org/cafe\u0301\n\npath?q=e\u0301",
    "https://example.org/cafe\u0301path?q=e\u0301",
  ],
  [" \t\r\nhttps://example.org/\n\npath \t\r\n", "https://example.org/path"],
  ["\u0000https://example.org/a\n\n①\u001f", "https://example.org/a①"],
] as const;

test("R7 a distinct label stays explicit when the cleaned URL equals it", () => {
  const source = richTextToEditor([
    [
      {
        url: "https://example.org/\n\npath",
        label: "https://example.org/path",
      },
    ],
  ]);
  assert.equal(source, "[[https://example.org/path|https://example.org/path]]");
});

for (const [url, cleaned, canonical = false] of urls) {
  for (const short of [false, true]) {
    test(`R7 ${short ? "short" : "explicit"} stored URL keeps its destination: ${JSON.stringify(url)}`, () => {
      const label = short ? url : " first\n\n① | ] \\ last ";
      const original = [[{ url, label }]];
      const snapshot = structuredClone(original);
      const source = richTextToEditor(original);
      const parsed = editorToRichText(source + " appended", true);
      assert.deepEqual(parsed, [
        [
          {
            url: cleaned,
            label: short
              ? canonical
                ? "https:\nexample.org/path"
                : cleaned
              : " first\n① | ] \\ last ",
          },
          " appended",
        ],
      ]);
      assert.equal(
        new URL((parsed[0][0] as { url: string }).url).href,
        new URL(url).href,
      );
      assert.doesNotMatch(source, /\n\s*\n/u);
      if (short) assert.equal(source.includes("|"), canonical);
      assert.equal(
        remapPlaces(source, () => 2),
        source,
      );
      assert.deepEqual(original, snapshot);
      for (const text of [original, parsed]) {
        const result = draftToBody(
          newDraft({
            spelling: "broda",
            kind: "gismu",
            structured: true,
            frameMode: "fixed",
            places: [newPlace(1)],
            numberingApproved: true,
            text,
          }),
        );
        assert.deepEqual(
          result.problems.filter((p) => p.blocking),
          [],
        );
      }
    });
  }
}

test("R7 URL spaces, Unicode whitespace, and decomposed path text stay significant", () => {
  for (const url of [
    "https://example.org/a b?q=c d",
    "https://example.org/a\u00a0b?q=\u2000",
    "https://example.org/cafe\u0301?q=e\u0301",
  ]) {
    const rich = [[{ url, label: "①" }]];
    assert.deepEqual(editorToRichText(richTextToEditor(rich), true), rich);
  }
});

test("R7 a word link spelled https:example.org keeps the original typed syntax", () => {
  const rich = [
    [
      {
        word: { language: "jbo" as const, spelling: "https:example.org" },
        label: "https:example.org",
      },
    ],
  ];
  const source = richTextToEditor(rich);
  assert.equal(source, "[[https:example.org]]");
  assert.deepEqual(editorToRichText(source, true), rich);
});
