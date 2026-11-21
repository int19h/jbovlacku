import { test } from "node:test";
import assert from "node:assert/strict";
import { languageName, listedLanguage } from "../../src/lib/format.ts";

test("language names are readable and hide the test tag", () => {
  assert.equal(languageName("tok"), "Toki Pona");
  assert.equal(languageName("tpi"), "Tok Pisin");
  assert.equal(languageName("art-loglan"), "Loglan");
  assert.equal(languageName("art-picture"), "Picture language");
  assert.equal(languageName("art-guaspi"), "Guaspi");
  assert.equal(languageName("en-simple"), "Simple English");
  assert.equal(languageName("fr-facile"), "Easy French");
  assert.equal(languageName("en"), "English");
  // A subtag after "art-" can be a region, so unknown tags keep the
  // platform name instead of a guessed language name.
  assert.notEqual(languageName("art-ca"), "Ca");
  assert.match(languageName("art-ca"), /^art[ -]/i);
  assert.equal(listedLanguage("test"), false);
  assert.equal(listedLanguage("en"), true);
});
