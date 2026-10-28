import { before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { initializeCore } from "../../../../packages/core/src/index.ts";
import {
  draftToBody,
  editorToRichText,
  newDraft,
  richTextToEditor,
  remapPlaces,
} from "../../src/model/draft.ts";
import type { RichNode, RichText } from "../../src/model/types.ts";

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

for (const text of [
  String.raw`$T_{cr}$ {lf} {join} {char d800}`,
  String.raw`\rightarrow \rho \rm Tom \& Jerry hello\ world`,
]) {
  for (const field of ["prose", "code", "label"] as const) {
    test(`R5 ${field} keeps typed TeX and ordinary braces: ${text}`, () => {
      const node =
        field === "prose"
          ? text
          : field === "code"
            ? { code: text }
            : { url: "https://example.org/", label: text };
      const source =
        field === "prose"
          ? text
          : field === "code"
            ? `\`${text}\``
            : `[[https://example.org/|${text}]]`;
      assert.deepEqual(editorToRichText(source, true), [[node]]);
      assert.equal(richTextToEditor([[node]]), source.replaceAll("\\", "\\\\"));
    });
  }
}

test("R5 edited fields normalize line endings, string fragments, and paragraph whitespace", () => {
  const original: RichText = [
    ["first\r\n\r\nsecond ", "adjacent \t"],
    [" \u00a0\t"],
    ["last\rline \n"],
  ];
  const source = richTextToEditor(original);
  const normalized = [["first"], ["second adjacent"], ["last\nline"]];
  assert.deepEqual(editorToRichText(source, true), normalized);
  assert.deepEqual(editorToRichText(source, false), normalized);
  assert.doesNotMatch(source, /\{(?:cr|lf|join|char [\da-f]{4})\}|\\\n/u);
});

test("R5 an untouched field keeps rare stored values when another field changes", () => {
  const notes: RichText = [["note\r", " adjacent "], [" \t"]];
  const draft = newDraft({
    spelling: "broda",
    kind: "gismu",
    frameMode: "none",
    text: [["old\r", " text "]],
    notes,
  });
  draft.text = editorToRichText("new\r\ntext \n\n  ", true);
  const result = draftToBody(draft);
  assert.deepEqual(
    result.problems.filter((p) => p.blocking),
    [],
  );
  assert.deepEqual(result.body!.text, [["new\ntext"]]);
  assert.deepEqual(result.body!.notes, notes);
});

test("R5 merging string fragments never creates a place or operand reference", () => {
  const original: RichText = [["{pla", "ce 1} and {operand ", "bridi}"]];
  assert.deepEqual(editorToRichText(richTextToEditor(original), true), [
    ["{place 1} and {operand bridi}"],
  ]);
});

test("R5 multiline code uses tight backticks and keeps ordinary inline padding", () => {
  const code = { code: "first\n\n① `quoted` \\ end" };
  const source = richTextToEditor([[code]]);
  assert.deepEqual(editorToRichText(source, true), [[code]]);
  assert.equal(
    remapPlaces(source, () => 2),
    source,
  );
  assert.deepEqual(editorToRichText("` padded ` and ``", true), [
    [{ code: " padded " }, " and ", { code: "" }],
  ]);
  assert.deepEqual(editorToRichText("` padded\n\ncode `", true), [
    ["` padded"],
    ["code `"],
  ]);
  const unmatched = "Use the ` key.\n\n① is the agent.\n\nThen ` again.";
  assert.deepEqual(editorToRichText(unmatched, true), [
    ["Use the ` key."],
    [1, " is the agent."],
    ["Then ` again."],
  ]);
  assert.match(
    remapPlaces(unmatched, () => 2),
    /② is the agent/,
  );
});

test("R5 complete multiline labels keep padding and literal notation", () => {
  const label = " first\n\n① | ] \\ last ";
  const rich: RichText = [
    [
      { word: { language: "jbo", spelling: "CUKTA" }, label },
      " ",
      { url: "https://example.org/", label },
    ],
  ];
  assert.deepEqual(
    editorToRichText(richTextToEditor(rich) + " appended", true),
    [[...rich[0], " appended"]],
  );
});

for (const node of [
  "bad\ud800x",
  { code: "bad\udfff" },
  { url: "https://example.org/", label: "bad\ud800" },
] satisfies RichNode[]) {
  test(`R5 invalid Unicode in ${typeof node === "string" ? "text" : "code" in node ? "code" : "a label"} gives a plain field error`, () => {
    const result = draftToBody(
      newDraft({
        spelling: "broda",
        kind: "gismu",
        frameMode: "none",
        text: [[node]],
      }),
    );
    const problem = result.problems.find((p) => p.blocking)!;
    assert.equal(problem.field, "text");
    assert.match(problem.message, /definition.*invalid Unicode character/u);
    assert.doesNotMatch(problem.message, /[{}]|"code"|"message"/u);
  });
}

test("R5 valid surrogate pairs remain publishable and invalid plain fields get a plain error", () => {
  const draft = newDraft({
    spelling: "broda",
    kind: "gismu",
    frameMode: "none",
    text: [["🦉"]],
  });
  assert.deepEqual(
    draftToBody(draft).problems.filter((p) => p.blocking),
    [],
  );
  draft.glosses = [{ language: "en", text: "bad\ud800", sense: "" }];
  const problem = draftToBody(draft).problems.find((p) => p.blocking)!;
  assert.match(problem.message, /invalid Unicode character/u);
  assert.doesNotMatch(problem.message, /[{}]|"code"|"message"/u);
});
