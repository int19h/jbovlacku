import { test } from "node:test";
import assert from "node:assert/strict";
import { selectMatches } from "../src/index.ts";
const entries = [
  "lo",
  "ve",
  "ti",
  "me",
  "ni",
  "ce",
  "ma",
  "ke",
  "ba",
  "mo",
  "u",
  "se",
  "mi",
  "klama",
  "iseri'abo",
].map((spelling) => ({
  word: { spelling },
  glosses: [],
  plain_text: "Synthetic definition.",
}));
for (const query of [
  "love",
  "time",
  "nice",
  "make",
  "base",
  "move",
  "use",
  "klama ☃",
  "riha",
])
  test(`known-word ordering requires exact dictionary tokens: ${query}`, () => {
    assert.equal(selectMatches(entries, query).allLojban, false);
  });
for (const query of ["klama", "klama.", "mi klama", "MI KLÁMA", "iseri'abo"])
  test(`known dictionary spelling orders Lojban first: ${query}`, () => {
    assert.equal(selectMatches(entries, query).allLojban, true);
  });
test("component spellings alone never establish a known compound token", () => {
  assert.equal(selectMatches(entries, "love time").allLojban, false);
});
