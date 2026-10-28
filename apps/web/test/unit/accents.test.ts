import { before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  initializeCore,
  wordId,
  rafsiPairId,
  interpretDefinition,
} from "../../../../packages/core/src/index.ts";
import { newDraft, draftToBody, draftFromBody } from "../../src/model/draft.ts";
import {
  changeTypedWord,
  prepareLujvoBuilder,
  buildLujvoState,
  selectLujvoCandidate,
  sourceOptions,
} from "../../src/model/typed-headword.ts";
import { detectWord, wordFormFeedback } from "../../src/model/word-form.ts";
import type { CachedPackage } from "../../src/data/search.ts";
import type { DefinitionBody, PackageEntry } from "../../src/model/types.ts";

let localSearch: typeof import("../../src/data/search.ts").localSearch;
before(async () => {
  await initializeCore(
    await readFile(
      new URL(
        "../../../../packages/core/generated/jvc_runtime_bg.wasm",
        import.meta.url,
      ),
    ),
  );
  Object.assign(globalThis, { location: new URL("http://local.invalid") });
  localSearch = (await import("../../src/data/search.ts")).localSearch;
});
const entry = (spelling: string, digit: string): PackageEntry => ({
  event: "jve1:" + digit.repeat(64),
  word: { language: "jbo", spelling },
  language: "en",
  glosses: [],
  plain_text: "A synthetic name.",
  classification: { kind: "cmevla", selmaho: [] },
  body: null,
});
const cache = (): CachedPackage => ({
  snapshot: "sha256:" + "a".repeat(64),
  entries: [entry("djan", "b"), entry("dján", "a")],
});

test("typed name display survives authoring, core validation, and revision", () => {
  const spelling = "ḾA'AN";
  const draft = newDraft({
    kind: "cmevla",
    spelling,
    text: [["A synthetic name."]],
  });
  changeTypedWord(draft, spelling);
  assert.equal(detectWord(spelling).normalized, "ma'an");
  assert.equal(wordFormFeedback(draft).blocking, false);
  const result = draftToBody(draft);
  assert.deepEqual(
    result.problems.filter((problem) => problem.blocking),
    [],
  );
  assert.equal(result.body?.word.spelling, spelling);
  assert.equal(result.wordId, wordId({ language: "jbo", spelling: "MA'AN" }));
  const copied = draftFromBody(
    interpretDefinition(result.body),
    "jve1:" + "f".repeat(64),
    "native",
  );
  assert.equal(draftToBody(copied).body?.word.spelling, spelling);
  assert.equal(
    rafsiPairId(result.wordId!, "ma'a"),
    rafsiPairId(wordId({ language: "jbo", spelling: "MA'AN" }), "ma'a"),
  );
});

test("acute gismu and malformed marks block even experimental name classifications", () => {
  for (const kind of ["gismu", "cmevla", "other"] as const)
    for (const spelling of ["blánu", "\u0301djan", "dja'\u0301an"]) {
      const draft = newDraft({
        kind,
        spelling,
        labels: ["experimental"],
        text: [["Synthetic."]],
      });
      const problems = draftToBody(draft).problems;
      assert.ok(
        problems.some(
          (problem) =>
            problem.blocking && /acute accent/i.test(problem.message),
        ),
        `${kind}: ${spelling}`,
      );
    }
});

test("local search groups accent aliases and binds display to its selected definition", () => {
  assert.deepEqual(localSearch(cache().entries, "\u0301"), []);
  for (const query of ["djan", "dján", "dja\u0301n", "DJÁN"]) {
    const hits = localSearch(cache().entries, query);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].word.spelling, "dján");
    assert.equal(hits[0].preview?.event, entry("dján", "a").event);
    assert.equal(
      hits[0].word_id,
      wordId({ language: "jbo", spelling: "djan" }),
    );
    assert.equal(hits[0].definitions.length, 2);
  }
});

test("zei sources match by plain name and retain entered display in compound evidence", () => {
  const draft = newDraft({
    kind: "lujvo",
    spelling: "dján zei blanu",
    text: [["A synthetic compound."]],
  });
  changeTypedWord(draft, draft.spelling);
  const prepared = prepareLujvoBuilder(draft, cache());
  const result = buildLujvoState(prepared);
  const candidate = result.candidates[0];
  assert.equal(candidate.spelling, draft.spelling);
  assert.equal(prepared.components[0].spelling, "dján");
  assert.equal(prepared.components[0].definitions?.length, 2);
  assert.equal(
    sourceOptions(detectWord(draft.spelling).readings[0][0], cache(), true)
      .length,
    1,
  );
  selectLujvoCandidate(draft, result, candidate, true);
  const body = draftToBody(draft);
  assert.deepEqual(
    body.problems.filter((problem) => problem.blocking),
    [],
  );
  assert.equal(
    body.body?.etymology.compound?.components[0].word.spelling,
    "dján",
  );
  assert.equal(body.body?.etymology.compound?.components[0].rafsi, "djan");
  assert.equal(
    body.wordId,
    wordId({ language: "jbo", spelling: "djan zei blanu" }),
  );
  const copied = draftFromBody(
    interpretDefinition<DefinitionBody>(body.body),
    "jve1:" + "c".repeat(64),
    "native",
  );
  assert.equal(draftToBody(copied).body?.word.spelling, "dján zei blanu");
});
