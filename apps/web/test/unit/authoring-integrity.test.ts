import { before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { initializeCore, wordId } from "../../../../packages/core/src/index.ts";
import {
  coreProblems,
  draftFromBody,
  draftToBody,
  editorToRichText,
  newDraft,
  newPlace,
  richTextToEditor,
} from "../../src/model/draft.ts";
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

for (const [name, node] of [
  ["multiline code", { code: "first\n\n① `quoted` \\ end" }],
  [
    "multiline word label",
    {
      word: { language: "jbo", spelling: "CUKTA" },
      label: " first\n\n① | ] \\ last ",
    },
  ],
  [
    "multiline web label",
    { url: "https://example.org/", label: " first\n\n① last " },
  ],
  [
    "word label spaces",
    { word: { language: "jbo", spelling: "cukta" }, label: " label " },
  ],
  ["web label spaces", { url: "https://example.org/", label: " label " }],
] as const) {
  test(`editing beside ${name} keeps its type and normalizes blank lines`, () => {
    const rich = [[node]] as RichText;
    const normalized =
      "code" in node
        ? { code: node.code.replace(/\n\s*\n/gu, "\n") }
        : { ...node, label: node.label.replace(/\n\s*\n/gu, "\n") };
    assert.deepEqual(
      editorToRichText(richTextToEditor(rich) + " appended", true),
      [[normalized, " appended"]],
    );
  });
}

for (const field of ["link", "derivation"] as const) {
  test(`a valid uppercase ${field} stays publishable as an unchanged revision`, () => {
    const body = draftToBody(
      newDraft({
        spelling: "broda",
        kind: "gismu",
        text: "A test definition.",
        structured: true,
        frameMode: "fixed",
        places: [newPlace(1)],
        numberingApproved: true,
      }),
    ).body!;
    if (field === "link")
      body.text = [
        [{ word: { language: "jbo", spelling: "CUKTA" }, label: "CUKTA" }],
      ];
    else
      body.frame!.places[0].derivation = [
        {
          word: { language: "jbo", spelling: "CUKTA" },
          definition: null,
          place: 1,
          explanation: [],
        },
      ];
    assert.deepEqual(coreProblems(body, wordId(body.word), [], "native"), []);
    const result = draftToBody(
      draftFromBody(body, "jve1:" + "a".repeat(64), "native"),
    );
    assert.deepEqual(
      result.problems.filter((problem) => problem.blocking),
      [],
    );
    assert.deepEqual(
      field === "link"
        ? result.body!.text
        : result.body!.frame!.places[0].derivation,
      field === "link" ? body.text : body.frame!.places[0].derivation,
    );
  });
}

test("reference words still follow format limits without a morphology gate", () => {
  for (const field of ["link", "derivation"] as const) {
    for (const spelling of [
      "not a Lojban word!",
      "lo\u0000jbo",
      "é".repeat(129),
    ]) {
      const draft = newDraft({
        spelling: "broda",
        kind: "gismu",
        text: "Test definition.",
        structured: true,
        frameMode: "fixed",
        places: [newPlace(1)],
        numberingApproved: true,
      });
      if (field === "link")
        draft.text = [
          [{ word: { language: "jbo", spelling }, label: spelling }],
        ];
      else
        draft.places[0].derivations = [
          { word: spelling, definition: null, place: 1, explanation: [] },
        ];
      const result = draftToBody(draft);
      assert.equal(
        result.problems.some((problem) => problem.blocking),
        spelling !== "not a Lojban word!",
        `${field}: ${JSON.stringify(spelling)}`,
      );
      if (spelling === "not a Lojban word!") {
        const actual =
          field === "link"
            ? (result.body!.text[0][0] as { word: { spelling: string } }).word
                .spelling
            : result.body!.frame!.places[0].derivation[0].word.spelling;
        assert.equal(actual, spelling);
      }
    }
  }
});

test("paragraph breaks outside tokens keep local and literal editing rules", () => {
  const code = { code: "first\n \n①" };
  const source = `before\n\n${richTextToEditor([[code]])} after\n\n① {operand bridi}`;
  assert.deepEqual(editorToRichText(source, true), [
    ["before"],
    [{ code: "first\n①" }, " after"],
    [1, " ", { operand: "bridi" }],
  ]);
  assert.deepEqual(editorToRichText(source, true, false), [
    ["before"],
    [{ code: "first\n①" }, " after"],
    ["① {operand bridi}"],
  ]);
  assert.deepEqual(editorToRichText("literal ①\n\nnext", false), [
    ["literal ①"],
    ["next"],
  ]);
});
