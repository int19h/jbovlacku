import { before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  initializeCore,
  analyzeWord,
  rafsiPairId,
  wordId,
  type MorphologyProfile,
} from "../../../../packages/core/src/index.ts";
import type { LujvoState } from "../../src/model/builders.ts";
import {
  draftFromBody,
  draftToBody,
  newDraft,
  normalizeDraft,
  type Draft,
} from "../../src/model/draft.ts";
import {
  buildLujvoState,
  changeTypedWord,
  clearWordEvidence,
  continueWithWord,
  detectWord,
  linkedSources,
  prepareLujvoBuilder,
  reconcileLujvoRows,
  selectLujvoCandidate,
  selectLujvoProfile,
  selectWordKind,
  typedLujvoState,
  typedWord,
} from "../../src/model/typed-headword.ts";
import type { CachedPackage } from "../../src/data/search.ts";

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

const words = [
  "ckusnu",
  "ckusni",
  "sairzba",
  "bangu'y'ismu",
  ".SAI,rZBA.",
  "bau,cla",
  "spageti'ykla",
  "ckusni'ybroda",
];
const sourceFor: Record<string, string> = {
  cku: "cukta",
  snu: "casnu",
  sni: "sinxa",
  sai: "sanmi",
  zba: "zbasu",
  bangu: "bangu",
  ismu: "ismu",
  bau: "bangu",
  cla: "clani",
  spageti: "spageti",
  kla: "klama",
  ckusni: "ckusni",
  broda: "broda",
};
const definition = "jve1:" + "b".repeat(64);
// Deliberately compete with the author's cku choice. Cache order cannot replace it.
const cached = {
  snapshot: "sha256:" + "a".repeat(64),
  version: 2,
  entries: ["cukte", "cukta"].map((spelling, index) => ({
    event: "jve1:" + String(index).repeat(64),
    word: { language: "jbo", spelling },
    language: "en",
    glosses: [],
    plain_text: spelling,
    classification: { kind: "gismu", selmaho: [] },
    body: null,
    issuer: "ed25519:" + "a".repeat(64),
    notes: false,
    rafsi: ["cku"],
    rafsi_complete: true,
    attribution: null,
  })),
} as CachedPackage;

function linkRows(state: LujvoState) {
  for (const row of state.components) {
    row.spelling = sourceFor[row.locked!] ?? "broda";
    row.kind = detectWord(row.spelling).kind;
    row.definition = definition;
    row.definitions = [
      { event: definition, summary: "The author's exact source." },
    ];
    row.gloss = "An authored gloss.";
    row.claims = [
      {
        rafsi: row.locked!,
        pair: rafsiPairId(
          wordId({ language: "jbo", spelling: row.spelling }),
          row.locked!,
        ),
      },
    ];
    delete row.unresolvedSource;
  }
}

function fixture(
  spelling: string,
  mode: "typed" | "legacy" | "revision",
  version: boolean | MorphologyProfile = false,
) {
  const profile =
    typeof version === "boolean"
      ? version
        ? "extended-v2"
        : "extended"
      : version;
  const parts =
    profile === "extended"
      ? detectWord(spelling).readings[0]
      : analyzeWord(profile, spelling).readings[0];
  const state: LujvoState = typedLujvoState(spelling, parts, null, profile);
  linkRows(state);
  const draft = newDraft({
    spelling,
    typedSpelling: spelling,
    kind: "lujvo",
    text: "An authored definition.",
    meaning: "An original meaning.",
    glosses: [{ language: "en", text: "An authored gloss.", sense: "" }],
    notes: "An authored note.",
    lujvo: state,
    frameMode: "none",
  });
  if (mode === "legacy") {
    delete state.typedOrigin;
    draft.typedSpelling = null;
    return draft;
  }
  if (mode === "revision") {
    const result = buildLujvoState(state);
    selectLujvoCandidate(draft, result, result.candidates[0], true);
    const { body, problems } = draftToBody(draft);
    assert.ok(body, JSON.stringify(problems));
    return draftFromBody(body, definition, "native");
  }
  return draft;
}

function candidate(state: LujvoState) {
  try {
    return buildLujvoState(state);
  } catch {
    return null;
  }
}

function invariants(draft: Draft) {
  const state = draft.lujvo;
  if (!state) return;
  assert.equal(
    new Set(state.components.map((row) => row.id)).size,
    state.components.length,
  );
  if (state.restoredJoinParts) {
    assert.deepEqual(
      state.restoredJoinParts,
      state.components.map((row) => ({ id: row.id, rafsi: row.locked })),
    );
    if (state.restoredProfile)
      assert.equal(state.restoredProfile, state.profile);
    assert.ok(state.joins || state.profile !== "extended");
    assert.equal(state.typedOrigin, undefined);
  } else {
    assert.equal(state.restoredSpelling, undefined);
    assert.equal(state.restoredProfile, undefined);
  }
  if (state.typedOrigin) {
    assert.equal(state.typed, typedWord(draft.spelling));
    assert.equal(draft.typedSpelling, state.typed);
    assert.equal(state.restoredJoinParts, undefined);
    const built = buildLujvoState(state);
    assert.equal(built.candidates.length, 1);
    assert.equal(built.candidates[0].spelling, state.typed);
    assert.equal(built.candidates[0].tokens.join(""), state.typed);
  } else if (state.restoredSpelling) {
    const built = candidate(state);
    assert.ok(
      built?.candidates.length,
      "Unchanged restored rows must still construct their spelling.",
    );
    assert.equal(built.candidates[0].spelling, state.restoredSpelling);
  }
  if (state.selected && state.typedOrigin)
    assert.equal(state.selected, state.typed);
}

test("legacy and published rows retain exact spelling, boundaries, and editability through spelling round trips", () => {
  for (const mode of ["legacy", "revision"] as const)
    for (const spelling of [
      "sairzba",
      "bangu'y'ismu",
      ".SAI,rZBA.",
      "bau,cla",
    ]) {
      const draft = fixture(spelling, mode);
      const state = prepareLujvoBuilder(draft, cached);
      const rows = structuredClone(state.components);
      const joins = structuredClone(state.joins);
      const compound = structuredClone(draft.compound);
      for (const next of [spelling + "x", "zzzz", spelling]) {
        changeTypedWord(draft, next);
        invariants(draft);
        assert.deepEqual(state.components, rows);
        assert.deepEqual(state.joins, joins);
      }
      prepareLujvoBuilder(draft, cached);
      invariants(draft);
      assert.equal(draft.lujvo?.typedOrigin, undefined);
      assert.equal(
        buildLujvoState(draft.lujvo!).candidates[0].spelling,
        spelling,
      );
      assert.deepEqual(draft.compound, compound);
      clearWordEvidence(draft);
      assert.deepEqual(draft.lujvo?.joins, joins);
      selectLujvoProfile(state, "cll");
      assert.equal(state.joins, undefined);
      assert.equal(state.restoredSpelling, undefined);
    }
});

test("fresh analysis keeps hand-linked row identity, exact definitions and claims with or without compound evidence", () => {
  for (const metadata of [false, true]) {
    const draft = fixture("ckusnu", "typed");
    if (metadata) {
      const result = buildLujvoState(draft.lujvo!);
      selectLujvoCandidate(draft, result, result.candidates[0], true);
    }
    const rows = structuredClone(draft.lujvo!.components);
    const compound = structuredClone(draft.compound);
    changeTypedWord(draft, "ckusni");
    invariants(draft);
    changeTypedWord(draft, "ckusnu");
    invariants(draft);
    prepareLujvoBuilder(draft, cached);
    invariants(draft);
    assert.equal(draft.lujvo?.typedOrigin, true);
    assert.deepEqual(draft.lujvo?.components, rows);
    assert.deepEqual(draft.compound, compound);
    changeTypedWord(draft, "ckusni");
    const state = prepareLujvoBuilder(draft, cached);
    assert.deepEqual(state.components[0], rows[0]);
    assert.notEqual(state.components[1].id, rows[1].id);
    assert.equal(state.components[1].locked, "sni");
    assert.equal(state.components[1].spelling, "");
    assert.ok(state.components[1].unresolvedSource);
  }
});

test("signed version 2 boundaries and sources survive fresh typed analysis after a round trip", () => {
  const draft = fixture("ckusni'ybroda", "revision", true);
  prepareLujvoBuilder(draft, cached);
  // A saved version 2 typed draft also occurs in older browser state.
  draft.lujvo!.typedOrigin = true;
  draft.lujvo!.typed = draft.spelling;
  draft.typedSpelling = draft.spelling;
  const rows = structuredClone(draft.lujvo!.components);
  const compound = structuredClone(draft.compound);
  changeTypedWord(draft, "ckusni'ybrodax");
  invariants(draft);
  changeTypedWord(draft, "ckusni'ybroda");
  invariants(draft);
  const state = prepareLujvoBuilder(draft, cached);
  invariants(draft);
  assert.equal(state.profile, "extended-v2");
  assert.deepEqual(state.components, rows);
  assert.deepEqual(draft.compound, compound);
  assert.deepEqual(
    state.components.map((row) => row.locked),
    ["ckusni", "broda"],
  );
});

test("older profiles keep validated case and commas for typed and restored forms without changing morphology", () => {
  for (const [profile, spelling] of [
    ["extended-v2", "CKUSNI'yBRODA"],
    ["extended-v2", "cku,sni'ybroda"],
    ["extended-v2", "ckusnihybroda"],
    ["extended-v2", "CKUSNIHYBRODA"],
    ["extended-v2", "ckusni’ybroda"],
    ["cll", "BAU,CLA"],
  ] as const)
    for (const mode of ["typed", "legacy", "revision"] as const) {
      const draft = fixture(spelling, mode, profile);
      let state = prepareLujvoBuilder(draft, cached);
      const original = buildLujvoState(state);
      assert.equal(original.candidates.length, 1);
      assert.equal(original.candidates[0].spelling, spelling);
      assert.equal(original.candidates[0].tokens.join(""), spelling);
      if (mode === "typed")
        selectLujvoCandidate(draft, original, original.candidates[0], true);
      const rows = structuredClone(state.components);
      const compound = structuredClone(draft.compound);
      changeTypedWord(draft, spelling + "x");
      invariants(draft);
      changeTypedWord(draft, spelling);
      invariants(draft);
      state = prepareLujvoBuilder(draft, cached);
      invariants(draft);
      assert.equal(state.profile, profile);
      assert.deepEqual(state.components, rows);
      assert.deepEqual(draft.compound, compound);
      const built = buildLujvoState(state);
      assert.equal(built.candidates[0].spelling, spelling);
      assert.equal(built.candidates[0].tokens.join(""), spelling);
      assert.equal(built.candidates[0].score, original.candidates[0].score);
      assert.deepEqual(built.candidates[0].parts, original.candidates[0].parts);
      assert.deepEqual(built.morphology, original.morphology);
      assert.deepEqual(built.scoring, original.scoring);
      if (!state.typedOrigin) {
        state.components.reverse();
        reconcileLujvoRows(state);
        assert.equal(state.restoredSpelling, undefined);
        assert.equal(state.restoredJoinParts, undefined);
      }
    }
  assert.equal(analyzeWord("extended-v2", ".ckusni'ybroda.").kind, "unknown");
});

test("matching signed evidence fills missing sources without changing surviving author choices", () => {
  const draft = fixture("ckusnu", "typed");
  const result = buildLujvoState(draft.lujvo!);
  selectLujvoCandidate(draft, result, result.candidates[0], true);
  const authored = structuredClone(draft.lujvo!.components[0]);
  const missing = draft.lujvo!.components[1];
  missing.spelling = "";
  missing.unresolvedSource = "Link a source word if you know it.";
  changeTypedWord(draft, "ckusni");
  changeTypedWord(draft, "ckusnu");
  const state = prepareLujvoBuilder(draft, cached);
  assert.deepEqual(state.components[0], authored);
  assert.equal(state.components[1].id, missing.id);
  assert.equal(state.components[1].spelling, "casnu");
  assert.equal(state.components[1].definition, definition);
  assert.equal(
    state.components[1].claims[0].pair,
    rafsiPairId(wordId({ language: "jbo", spelling: "casnu" }), "snu"),
  );
  assert.equal(linkedSources(state), true);
});

test("historical construction gaps cannot be presented as exact spelling restoration", () => {
  const draft = fixture("SAI,rZBA", "typed", "cll");
  draft.compound = fixture("saizba", "revision", "cll").compound;
  draft.compound!.score = null;
  draft.evidenceForm = draft.spelling;
  prepareLujvoBuilder(draft, cached);
  const before = structuredClone(draft);
  assert.equal(analyzeWord("cll", draft.spelling).kind, "lujvo");
  assert.throws(
    () => buildLujvoState(draft.lujvo!),
    /saved spelling does not match a construction/,
  );
  assert.deepEqual(draft, before);
});

test("fresh readings retain compatible unlocked author sources and refuse ambiguous fallback sources", () => {
  for (const [spelling, source, lock] of [
    ["ckusni", "cukta", "cku"],
    ["cuktysinxa", "cukta", "cukt"],
    ["bangu'y'ismu", "bangu", "bangu"],
  ]) {
    const draft = fixture("ckusnu", "legacy");
    const ordinary = prepareLujvoBuilder(draft, cached);
    const old = ordinary.components[0];
    old.spelling = source;
    old.locked = null;
    old.kind = detectWord(source).kind;
    reconcileLujvoRows(ordinary);
    const authored = structuredClone(old);
    changeTypedWord(draft, spelling);
    const state = prepareLujvoBuilder(draft, cached);
    assert.equal(state.typedOrigin, true);
    assert.deepEqual(state.components[0], { ...authored, locked: lock });
    invariants(draft);
  }
  const draft = fixture("ckusnu", "legacy");
  const state = prepareLujvoBuilder(draft, cached);
  const authored = structuredClone(state.components[0]);
  state.components = [
    { ...state.components[1], locked: null },
    { ...authored, locked: null },
    { ...authored, id: "other-author-source", spelling: "cukte", locked: null },
  ];
  reconcileLujvoRows(state);
  changeTypedWord(draft, "ckusni");
  const next = prepareLujvoBuilder(draft, cached);
  assert.equal(next.components[0].spelling, "");
  assert.ok(next.components[0].unresolvedSource);
  // A partial cache cannot choose between the author's competing source rows.
  draft.lujvo = state;
  const partialCache = { ...cached, entries: cached.entries.slice(1) };
  const stillAmbiguous = prepareLujvoBuilder(draft, partialCache);
  assert.equal(stillAmbiguous.components[0].spelling, "");
  assert.ok(stillAmbiguous.components[0].unresolvedSource);
  // Only the one compatible remaining source can restore the chosen definition.
  state.components.pop();
  draft.lujvo = state;
  const unique = prepareLujvoBuilder(draft, cached);
  assert.equal(unique.components[0].id, authored.id);
  assert.equal(unique.components[0].definition, authored.definition);
  assert.equal(unique.components[0].locked, "cku");
});

test("explicit ordinary profile choices survive reopen and do not restore released boundaries", () => {
  const draft = fixture("sairzba", "revision");
  const state = prepareLujvoBuilder(draft, cached);
  const compound = structuredClone(draft.compound);
  selectLujvoProfile(state, "cll");
  assert.equal(state.restoredSpelling, undefined);
  assert.equal(state.joins, undefined);
  prepareLujvoBuilder(draft, cached);
  assert.equal(state.profile, "cll");
  assert.equal(state.joins, undefined);
  assert.deepEqual(draft.compound, compound);
  selectLujvoProfile(state, "extended");
  prepareLujvoBuilder(draft, cached);
  assert.equal(state.restoredSpelling, undefined);
  assert.equal(state.joins, undefined);
});

test("older restored row snapshots gain exact presentation without losing their joins", () => {
  const draft = fixture(".SAI,rZBA.", "legacy");
  const state = prepareLujvoBuilder(draft, null);
  delete state.restoredSpelling;
  delete state.restoredProfile;
  changeTypedWord(draft, "zzzz");
  prepareLujvoBuilder(draft, null);
  assert.equal(state.restoredSpelling, ".SAI,rZBA.");
  assert.deepEqual(state.joins, ["r"]);
  invariants(draft);
});

test("form selection refuses unresolved attribution and stale rows without mutating the draft", () => {
  const state = typedLujvoState(
    "ckusnu",
    detectWord("ckusnu").readings[0],
    null,
  );
  const draft = newDraft({
    spelling: "ckusnu",
    typedSpelling: "ckusnu",
    lujvo: state,
  });
  const result = buildLujvoState(state);
  const before = structuredClone(draft);
  assert.throws(
    () => selectLujvoCandidate(draft, result, result.candidates[0], true),
    /Link every source/,
  );
  assert.deepEqual(draft, before);
  state.components[0].locked = "cuk";
  const changed = structuredClone(draft);
  assert.throws(
    () => selectLujvoCandidate(draft, result, result.candidates[0], false),
    /Rebuild the current components/,
  );
  assert.deepEqual(draft, changed);
});

test("random production event sequences preserve draft invariants after every event", () => {
  const coverage = new Map<string, number>();
  for (let seed = 1; seed <= 24; seed++) {
    let bits = seed * 0x9e3779b1;
    const random = (n: number) => {
      bits ^= bits << 13;
      bits ^= bits >>> 17;
      bits ^= bits << 5;
      return (bits >>> 0) % n;
    };
    const pick = <T>(values: readonly T[]) => values[random(values.length)];
    let draft = fixture(
      pick(words),
      pick(["typed", "legacy", "revision"] as const),
    );
    let earlier = draft.spelling;
    const history: string[] = [];
    const events = [
      "type",
      "paste",
      "replace",
      "Use this word",
      "restore spelling",
      "New word",
      "open lujvo",
      "open Form",
      "open Meaning",
      "open Places",
      "open full editor",
      "open gismu",
      "reload",
      "revise publication",
      "legacy draft",
      "remove evidence",
      "link sources",
      "add row",
      "remove row",
      "reorder rows",
      "change rafsi",
      "change profile",
      "Use candidate",
    ];
    for (let step = 0; step < 100; step++) {
      const event = pick(events);
      history.push(event);
      coverage.set(event, (coverage.get(event) ?? 0) + 1);
      const before = structuredClone(draft);
      try {
        switch (event) {
          case "type":
          case "paste":
          case "replace":
          case "Use this word":
          case "restore spelling": {
            const next =
              event === "restore spelling"
                ? earlier
                : event === "type"
                  ? draft.spelling + "x"
                  : pick([...words, "", "zzzz", "bangu"]);
            earlier = draft.spelling;
            changeTypedWord(draft, next);
            assert.deepEqual(draft.compound, before.compound);
            assert.deepEqual(draft.formation, before.formation);
            assert.equal(draft.evidenceForm, before.evidenceForm);
            assert.deepEqual(draft.lujvo?.components, before.lujvo?.components);
            if (typedWord(next) !== typedWord(before.spelling)) {
              assert.equal(draft.lujvo?.typedOrigin, undefined);
              assert.deepEqual(draft.publishAcknowledged, []);
              if (
                before.compound ||
                before.formation ||
                before.places.length ||
                before.glosses.length
              )
                assert.ok(draft.review.includes("spelling"));
            }
            if (before.lujvo?.restoredJoinParts)
              assert.deepEqual(draft.lujvo?.joins, before.lujvo.joins);
            break;
          }
          case "New word":
            continueWithWord(draft);
            break;
          case "open lujvo": {
            selectWordKind(draft, "lujvo");
            const state = prepareLujvoBuilder(draft, cached);
            assert.deepEqual(draft.compound, before.compound);
            const retained =
              before.compound &&
              before.evidenceForm === typedWord(before.spelling);
            if (retained && !before.lujvo?.profileChosen)
              assert.equal(
                state.profile,
                before.compound!.morphology.version === "2"
                  ? "extended-v2"
                  : "extended",
              );
            if (state.typedOrigin) {
              const previousRows = before.lujvo?.components ?? [];
              for (const previous of previousRows) {
                const surviving = state.components.filter(
                  (row) => row.locked === previous.locked,
                );
                if (
                  previous.spelling.trim() &&
                  !previous.unresolvedSource &&
                  previousRows.filter((row) => row.locked === previous.locked)
                    .length === 1 &&
                  surviving.length === 1
                )
                  assert.deepEqual(surviving[0], previous);
              }
              for (const [index, previous] of previousRows.entries()) {
                const row = state.components[index];
                if (
                  row &&
                  previous.locked === null &&
                  previous.spelling &&
                  !previous.unresolvedSource &&
                  previous.claims.some((claim) => claim.rafsi === row.locked) &&
                  !previousRows.some(
                    (old) =>
                      old.locked === row.locked &&
                      old.spelling &&
                      !old.unresolvedSource,
                  ) &&
                  state.components.filter((part) => part.locked === row.locked)
                    .length === 1
                )
                  assert.deepEqual(row, { ...previous, locked: row.locked });
              }
            }
            if (
              before.lujvo?.ordinarySpelling === typedWord(draft.spelling) &&
              !before.lujvo.typedOrigin
            )
              assert.equal(state.typedOrigin, undefined);
            break;
          }
          case "open Meaning":
            break; // The page reads the draft without a builder transition.
          case "open Form":
          case "open Places":
          case "open full editor":
            selectWordKind(draft, draft.kind);
            break;
          case "open gismu":
            selectWordKind(draft, "gismu");
            break; // Confirmed evidence loss, no generated form selection.
          case "reload":
            draft = normalizeDraft(structuredClone(draft));
            break;
          case "revise publication": {
            const v2 = !!random(2);
            draft = fixture(
              v2
                ? pick([
                    "ckusni'ybroda",
                    "CKUSNI'yBRODA",
                    "cku,sni'ybroda",
                    "ckusnihybroda",
                    "CKUSNIHYBRODA",
                    "ckusni’ybroda",
                  ])
                : pick(words),
              "revision",
              v2,
            );
            break;
          }
          case "legacy draft":
            draft = fixture(pick(words), "legacy");
            break;
          case "remove evidence":
            clearWordEvidence(draft);
            break;
          case "link sources":
            if (draft.lujvo) linkRows(draft.lujvo);
            break;
          case "change profile":
            if (draft.lujvo)
              selectLujvoProfile(
                draft.lujvo,
                pick(["cll", "extended", "extended-v2"] as const),
              );
            if (before.lujvo?.typedOrigin)
              assert.deepEqual(draft.lujvo, before.lujvo);
            break;
          case "Use candidate": {
            if (!draft.lujvo) break;
            const result = candidate(draft.lujvo);
            if (result?.candidates[0])
              selectLujvoCandidate(
                draft,
                result,
                result.candidates[0],
                linkedSources(draft.lujvo) && !!random(2),
              );
            break;
          }
          default: {
            const state = draft.lujvo;
            if (!state || state.typedOrigin) break; // The fixed typed layout does not expose row edits.
            if (event === "add row")
              state.components.push({
                id: `added-${seed}-${step}`,
                spelling: "broda",
                kind: "gismu",
                definition: null,
                claims: [],
                locked: null,
                gloss: "",
              });
            if (event === "remove row")
              state.components.splice(
                random(Math.max(1, state.components.length)),
                1,
              );
            if (event === "reorder rows") state.components.reverse();
            if (event === "change rafsi" && state.components.length)
              state.components[random(state.components.length)].locked = null;
            reconcileLujvoRows(state);
          }
        }
        invariants(draft);
        if (!["revise publication", "legacy draft"].includes(event)) {
          assert.deepEqual(draft.text, before.text);
          assert.deepEqual(draft.notes, before.notes);
          assert.deepEqual(draft.glosses, before.glosses);
          assert.deepEqual(draft.places, before.places);
          assert.deepEqual(draft.sources, before.sources);
          assert.deepEqual(draft.parents, before.parents);
          assert.equal(draft.meaning, before.meaning);
        }
      } catch (error) {
        throw new Error(
          `Seed ${seed}, step ${step}, events: ${history.join(", ")}`,
          { cause: error },
        );
      }
    }
  }
  assert.equal(coverage.size, 23);
  for (const [event, count] of coverage)
    assert.ok(count > 40, `${event}: ${count}`);
});
