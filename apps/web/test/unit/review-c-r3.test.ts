import { before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { initializeCore } from "../../../../packages/core/src/index.ts";
import {
  draftToBody,
  editorToRichText,
  newDraft,
  newPlace,
  remapPlaces,
} from "../../src/model/draft.ts";
import { changedItems } from "../../src/model/comparison.ts";

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

test("F7 Unicode blank lines bound code and link tokens", () => {
  for (const [opening, closing] of [
    ["Use the ` key.", "Then ` again."],
    ["Use [[cukta|text.", "Then again."],
  ]) {
    const source = `${opening}\n\u00a0\n① is the agent.\n\u00a0\n${closing}`;
    assert.deepEqual(editorToRichText(source, true), [
      [opening],
      [1, " is the agent."],
      [closing],
    ]);
    assert.match(
      remapPlaces(source, () => 2),
      /② is the agent/,
    );
  }
});

const editorWhitespace = [
  "\t",
  "\v",
  "\f",
  " ",
  "\u00a0",
  "\u1680",
  ...Array.from({ length: 11 }, (_, i) => String.fromCharCode(0x2000 + i)),
  "\u2028",
  "\u2029",
  "\u202f",
  "\u205f",
  "\u3000",
  "\ufeff",
];
test("F7 tokenizer and remapping share every supported blank-line boundary", () => {
  const boundaries = [
    "\r\n\r\n",
    "\r\r",
    "\n\r\n",
    "\r\n\n",
    ...editorWhitespace.map((space) => `\n${space}\n`),
  ];
  for (const boundary of boundaries) {
    assert.deepEqual(
      editorToRichText(`a${boundary}b`, true),
      [["a"], ["b"]],
      JSON.stringify(boundary),
    );
    for (const [opening, closing] of [
      ["Use the ` key.", "Then ` again."],
      ["Use [[cukta|text.", "Then again."],
    ]) {
      const source = `${opening}${boundary}① is the agent.${boundary}${closing}`;
      assert.deepEqual(
        editorToRichText(source, true),
        [[opening], [1, " is the agent."], [closing]],
        JSON.stringify(boundary),
      );
      assert.match(
        remapPlaces(source, () => 2),
        /② is the agent/,
      );
    }
  }
  assert.deepEqual(editorToRichText("one\r\ntwo", true), [["one\ntwo"]]);
});
