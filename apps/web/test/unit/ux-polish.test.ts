import { test } from "node:test";
import assert from "node:assert/strict";
import { readableProse } from "../../src/model/richtext.ts";
import { languageName, listedLanguage } from "../../src/lib/format.ts";

test("readable prose drops TeX and wiki markup from previews", () => {
  assert.equal(
    readableProse("$z_1$, more than $z_2$, goes to $k_2$"),
    "z₁, more than z₂, goes to k₂",
  );
  assert.equal(readableProse("$x_{3}$ is $$x_1 + x_2$$"), "x₃ is x₁ + x₂");
  assert.equal(readableProse("''kla'' and '''kla'''"), "kla and kla");
  assert.equal(readableProse("\\(x_1\\) and \\[x_2\\]"), "x₁ and x₂");
  // Text without markup stays exact.
  assert.equal(readableProse("comes/goes to ① place"), "comes/goes to ① place");
});

test("language names are readable and hide the test tag", () => {
  assert.equal(languageName("tok"), "Toki Pona");
  assert.equal(languageName("tpi"), "Tok Pisin");
  assert.equal(languageName("art-loglan"), "Loglan");
  assert.equal(languageName("art-picture"), "Picture");
  assert.equal(languageName("art-guaspi"), "Guaspi");
  assert.equal(languageName("en"), "English");
  assert.equal(listedLanguage("test"), false);
  assert.equal(listedLanguage("en"), true);
});
