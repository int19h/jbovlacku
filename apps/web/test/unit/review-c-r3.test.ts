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
import { changedItems } from "../../src/model/comparison.ts";
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

function referenceDraft(spelling: string, field: "link" | "derivation") {
  const place = newPlace(1);
  if (field === "derivation")
    place.derivations = [
      { word: spelling, definition: null, place: 1, explanation: [] },
    ];
  return newDraft({
    spelling: "broda",
    kind: "gismu",
    structured: true,
    frameMode: "fixed",
    numberingApproved: true,
    places: [place],
    text:
      field === "link"
        ? [[{ word: { language: "jbo", spelling }, label: "target" }]]
        : [["Test"]],
  });
}
for (const field of ["link", "derivation"] as const) {
  test(`F5 suspicious ${field} spelling gives advice without blocking`, () => {
    const result = draftToBody(referenceDraft("cukta?", field));
    assert.equal(
      result.problems.some((p) => p.blocking),
      false,
    );
    assert.ok(
      result.problems.some(
        (p) => !p.blocking && /spelling|morphology/i.test(p.message),
      ),
    );
    const uppercase = draftToBody(referenceDraft("CUKTA", field));
    assert.deepEqual(uppercase.problems, []);
  });
  test(`Grok invalid ${field} spelling gives a plain sentence`, () => {
    const result = draftToBody(
      referenceDraft(field === "link" ? "lo\0" : "é".repeat(129), field),
    );
    const problem = result.problems.find((p) => p.blocking)!;
    assert.ok(problem);
    assert.doesNotMatch(problem.message, /[{}]|"code"|"message"/);
    assert.match(problem.message, /invalid|valid|spelling/i);
  });
}
for (const [name, value] of [
  ["blank line in a string", [["first line\n\nsecond"]]],
  ["trailing spaces", [[{ code: "x" }, " trailing "]]],
  ["leading newline", [["a"], ["\nb"]]],
  ["space-only paragraph", [["a"], [" "]]],
  ["middle Unicode whitespace paragraph", [["a"], ["\u00a0\t"], ["b"]]],
] as const) {
  test(`F6 editor preserves ${name}`, () => {
    const rich = value as unknown as RichText;
    assert.deepEqual(editorToRichText(richTextToEditor(rich), true), rich);
  });
}
test("F7 unmatched backticks stay within their raw paragraph", () => {
  const source = "Use the ` key.\n\n① is the agent.\n\nThen ` again.";
  assert.deepEqual(editorToRichText(source, true), [
    ["Use the ` key."],
    [1, " is the agent."],
    ["Then ` again."],
  ]);
  assert.match(
    remapPlaces(source, () => 2),
    /② is the agent/,
  );
});
test("F3 alignment bounds comparisons for 3000 changed items", () => {
  let reads = 0;
  const items = (prefix: string) =>
    Array.from({ length: 3000 }, (_, i) => ({
      get label() {
        reads++;
        return `${prefix}${i}`;
      },
    }));
  const changes = changedItems(items("old"), items("new"));
  assert.equal(changes.length, 3000);
  assert.ok(reads < 100_000, `Read ${reads} values`);
});
