import assert from "node:assert/strict";
import { before, test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  createEvent,
  initializeCore,
  prepareAdmission,
  utf8,
  wordId,
} from "../../core/src/index.ts";
import { languageTag } from "../src/language.ts";
import { taskMessages } from "../src/inference.ts";

before(async () =>
  initializeCore(
    await readFile(
      new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  ),
);

test("service language syntax agrees with core admission, including private and grandfathered tags", () => {
  const limit = `x-${Array(6).fill("abcdefgh").join("-")}-abcdefg`;
  const accepted = [
    "en",
    "en-us",
    "jbo",
    "xyz",
    "xyz-zzzz-zz",
    "zh-hans",
    "zh-cmn-hans-cn",
    "i-klingon",
    "en-gb-oed",
    "sgn-be-fr",
    "x-private-private",
    "en-a-foobar-b-foobar-x-private-private",
    "de-ch-1901",
    "sl-rozaj-biske",
    "sl-rozaj-rozaj",
    "en-a-foo-a-bar",
    "en-abc-abc",
    limit,
  ];
  const rejected = [
    "",
    "e",
    "constructor",
    "__proto__",
    "en-US",
    "en_us",
    "en--us",
    "en-",
    "1",
    "en-123456789",
    "en-x",
    "x-",
    "x--a",
    "x-private-",
    "x-123456789",
    "é",
    "en-us-us",
    `${limit}h`,
  ];
  for (const [tags, expected] of [
    [accepted, true],
    [rejected, false],
  ] as const) {
    for (const language of tags) {
      const word = { language: "jbo", spelling: "klama" } as const;
      const admission = () => {
        const record = createEvent(
          new Uint8Array(32).fill(67),
          [],
          "9".repeat(32),
          {
            kind: "definition.publish",
            word: wordId(word),
            language,
            parents: [],
            origin: "native",
          },
          {
            word,
            language,
            text: [["A test definition."]],
            classification: { kind: "gismu" },
            license: { expression: "CC0-1.0" },
          },
        );
        const core = prepareAdmission(utf8(JSON.stringify(record)));
        assert(core.action_valid && core.body_status === "present");
      };
      assert.equal(languageTag(language), expected, language);
      if (expected) assert.doesNotThrow(admission, `core: ${language}`);
      else
        assert.throws(admission, /Draft does not satisfy/, `core: ${language}`);
    }
  }
});

test("source prompt lookup rejects inherited object names", () => {
  for (const language of ["constructor", "__proto__", "toString"]) {
    assert.throws(
      () =>
        taskMessages(
          { decisionReports: false },
          { task: "sources", language, input: "A source fixture." },
        ),
      /No source prompt is available/,
    );
  }
});
