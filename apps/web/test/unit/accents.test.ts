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
  Object.assign(globalThis, {
    location: new URL("http://local.invalid"),
    history: { state: null },
  });
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

test("R2 Astra 2: compound restoration retains exact-definition choices in either accent cache order", () => {
  for (const entries of [cache().entries, cache().entries.reverse()]) {
    const cached = { ...cache(), entries };
    const draft = newDraft({
      kind: "lujvo",
      spelling: "dján zei blanu",
      text: [["Synthetic."]],
    });
    changeTypedWord(draft, draft.spelling);
    const state = prepareLujvoBuilder(draft, cached);
    const result = buildLujvoState(state);
    selectLujvoCandidate(draft, result, result.candidates[0], true);
    const restored = draftFromBody(
      interpretDefinition<DefinitionBody>(draftToBody(draft).body),
      "jve1:" + "c".repeat(64),
      "native",
    );
    const hydrated = prepareLujvoBuilder(restored, cached);
    assert.equal(hydrated.components[0].spelling, "dján");
    assert.deepEqual(
      hydrated.components[0].definitions?.map((row) => row.event).sort(),
      entries.map((row) => row.event).sort(),
    );
  }
});

test("R2 Opus F1: implicitly normalized accented and plain zei candidates share one word ID", () => {
  for (const spelling of ["DŹÁN", ".dján.", "dja,ń", "djáhan"]) {
    const build = (spelling: string) =>
      buildLujvoState({
        profile: "extended-v4",
        components: [
          {
            id: "name",
            spelling,
            kind: "cmevla",
            locked: null,
            definition: null,
            claims: [],
            gloss: "",
          },
          {
            id: "root",
            spelling: "blanu",
            kind: "gismu",
            locked: null,
            definition: null,
            claims: [],
            gloss: "",
          },
        ],
        joins: [" zei "],
        selected: null,
        acknowledged: [],
      });
    const marked = build(spelling).candidates[0].spelling;
    const plain = build(
      spelling.normalize("NFD").replaceAll("\u0301", "").normalize("NFC"),
    ).candidates[0].spelling;
    assert.equal(
      wordId({ language: "jbo", spelling: marked }),
      wordId({ language: "jbo", spelling: plain }),
      spelling,
    );
  }
});

test("R2 Opus F5: zbalermorna renders the plain form of every accented name", async () => {
  const { zbalermorna } = await import("../../src/lib/zbalermorna.ts");
  for (const [spelling, plain] of [
    ["dján", "djan"],
    ["ḿa'an", "ma'an"],
    ["DŹÁN", "DZAN"],
  ]) {
    assert.ok(zbalermorna(plain));
    assert.equal(zbalermorna(spelling), zbalermorna(plain), spelling);
  }
});

test("R2 Opus F3: rafsi package rows group accent displays by word ID", async () => {
  const { wordsWithRafsi } = await import("../../src/pages/rafsi.ts");
  const cached = {
    ...cache(),
    version: 2,
    entries: cache().entries.map((entry) => ({
      ...entry,
      issuer: "ed25519:" + "a".repeat(64),
      rafsi: ["dja"],
    })),
  };
  const app = {
    session: {
      preferences: { definitionLanguage: "en" },
      storageAvailable: true,
    },
    store: { keys: async () => ["en"], get: async () => cached },
  };
  const found = await wordsWithRafsi(
    app as any,
    "dja",
    new AbortController().signal,
  );
  assert.equal(found.length, 1);
  assert.equal(
    wordId({ language: "jbo", spelling: found[0].spelling }),
    wordId({ language: "jbo", spelling: "djan" }),
  );
});

test("R2 Opus F8: an unknown accented name permits the same experimental classification as its plain form", () => {
  for (const [kind, spelling] of [
    ["cmevla", "dján smit"],
    ["cmevla", "djan smit"],
    ["lujvo", "dján zei blanu smit"],
    ["lujvo", "djan zei blanu smit"],
  ] as const) {
    const draft = newDraft({
      kind,
      spelling,
      labels: ["experimental"],
      text: [["Synthetic."]],
    });
    assert.equal(wordFormFeedback(draft).blocking, false, spelling);
    assert.deepEqual(
      draftToBody(draft).problems.filter((problem) => problem.blocking),
      [],
      spelling,
    );
  }
});

test("R2 Grok 3: an experimental label cannot permit a nonname classification for an accented name", () => {
  for (const kind of ["gismu", "other"] as const) {
    const draft = newDraft({
      kind,
      spelling: "dján",
      labels: ["experimental"],
      text: [["Synthetic."]],
    });
    const feedback = wordFormFeedback(draft);
    assert.equal(feedback.blocking, true, kind);
    assert.match(feedback.message, /cmevla|name/);
    assert.doesNotMatch(feedback.message, /permits this classification/);
  }
});

test("R2 Opus F4: package identity work runs once per package object", async () => {
  const { createPackageWordIndex } = await import("../../src/data/search.ts");
  let calls = 0;
  const lookup = createPackageWordIndex((word) => {
    calls++;
    return wordId(word);
  });
  const cached = {
    ...cache(),
    entries: Array.from({ length: 30_000 }, (_, index) =>
      entry(index % 2 ? "djan" : "dján", "a"),
    ),
  };
  const id = wordId({ language: "jbo", spelling: "dján" });
  assert.equal(lookup(cached, id).length, 30_000);
  assert.equal(calls, 30_000);
  assert.equal(lookup(cached, id).length, 30_000);
  assert.equal(
    lookup(cached, wordId({ language: "jbo", spelling: "blanu" })).length,
    0,
  );
  assert.equal(calls, 30_000);
  assert.equal(lookup({ ...cached }, id).length, 30_000);
  assert.equal(calls, 60_000);
});

test("unknown accented lujvo without zei reports its classification block accurately", () => {
  const draft = newDraft({
    kind: "lujvo",
    spelling: "dján smit",
    labels: ["experimental"],
    text: [["Synthetic."]],
  });
  const feedback = wordFormFeedback(draft);
  assert.equal(feedback.blocking, true);
  assert.match(feedback.message, /cmevla|zei/);
  assert.doesNotMatch(feedback.message, /permits this classification/);
  assert.ok(draftToBody(draft).problems.some((problem) => problem.blocking));
  const plain = newDraft({
    kind: "lujvo",
    spelling: "djan smit",
    labels: ["experimental"],
    text: [["Synthetic."]],
  });
  assert.equal(wordFormFeedback(plain).blocking, false);
  assert.deepEqual(
    draftToBody(plain).problems.filter((problem) => problem.blocking),
    [],
  );
});

test("unknown accented zei compounds keep ordinary experimental classification through comma aliases", () => {
  for (const spelling of [
    "dján zei blanu smit",
    "dján zei, blanu smit",
    "dján zei,blanu smit",
    "dján z,e,i blanu smit",
    "DJÁN Z,E,I,blanu smit",
  ]) {
    const draft = newDraft({
      kind: "lujvo",
      spelling,
      labels: ["experimental"],
      text: [["Synthetic."]],
    });
    assert.equal(wordFormFeedback(draft).blocking, false, spelling);
    assert.deepEqual(
      draftToBody(draft).problems.filter((problem) => problem.blocking),
      [],
      spelling,
    );
  }
});
