import { before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  initializeCore,
  wordId,
  rafsiPairId,
  buildLujvo,
} from "../../../../packages/core/src/index.ts";
import {
  conflictReviewKey,
  currentCompoundConflicts,
  currentRootConflicts,
  compoundMetadata,
  manualFormation,
  inventoryCoverage,
  lujvoConflictKey,
  type PackageInventory,
} from "../../src/model/builders.ts";
import {
  draftToBody,
  newDraft,
  normalizeDraft,
} from "../../src/model/draft.ts";

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

function inventory(): PackageInventory {
  const word = wordId({ language: "jbo", spelling: "cukta" });
  return {
    snapshot: "sha256:" + "a".repeat(64),
    hasClaims: true,
    complete: true,
    incompleteWords: [],
    gismu: [{ word, spelling: "cukta" }],
    claims: ["cku", "sa'i", "cukt", "valsi"].map((rafsi) => ({
      word,
      spelling: "cukta",
      rafsi,
      pair: rafsiPairId(word, rafsi),
    })),
  };
}

test("manual roots use all core conflict rules without source evidence", () => {
  const expected = [
    ["cukta", "identical"],
    ["cukte", "final-vowel"],
    ["sukta", "similar-consonant"],
  ];
  for (const [spelling, rule] of expected)
    assert.equal(currentRootConflicts(spelling, inventory())[0].rule, rule);
});

test("saved compound conflicts include CV'V rafsi and exclude automatic long forms", () => {
  const result = buildLujvo({
    profile: "cll",
    components: [
      {
        id: "a",
        spelling: "sanji",
        kind: "gismu",
        claims: [
          {
            rafsi: "sa'i",
            pair: rafsiPairId(
              wordId({ language: "jbo", spelling: "sanji" }),
              "sa'i",
            ),
          },
        ],
      },
      { id: "b", spelling: "valsi", kind: "gismu", claims: [] },
    ],
  });
  const candidate = result.candidates.find((c) => c.parts[0].form === "sa'i")!;
  const compound = compoundMetadata(
    result,
    candidate,
    [
      {
        id: "a",
        spelling: "sanji",
        kind: "gismu",
        definition: null,
        gloss: "",
        claims: [],
        locked: null,
      },
      {
        id: "b",
        spelling: "valsi",
        kind: "gismu",
        definition: null,
        gloss: "",
        claims: [],
        locked: null,
      },
    ],
    "",
  );
  assert.deepEqual(
    currentCompoundConflicts(compound, inventory()).map((c) => c.rafsi),
    ["sa'i"],
  );
  compound.components[0].rafsi = "cukt";
  assert.deepEqual(currentCompoundConflicts(compound, inventory()), []);
});

test("review keys bind spelling, snapshot, and the complete competing group", () => {
  const first = conflictReviewKey("ckuvla", "one", "components", ["b", "a"]);
  assert.equal(
    first,
    conflictReviewKey("ckuvla", "one", "components", ["a", "b", "a"]),
  );
  assert.notEqual(
    first,
    conflictReviewKey("ckuvla", "two", "components", ["a", "b"]),
  );
  assert.notEqual(
    first,
    conflictReviewKey("ckuvalsi", "one", "components", ["a", "b"]),
  );
  assert.notEqual(
    first,
    conflictReviewKey("ckuvla", "one", "components", ["a", "b", "c"]),
  );
  const a = { rafsi: "cku", pair: "a" };
  assert.notEqual(
    lujvoConflictKey("ckuvla", a, [a], "one"),
    lujvoConflictKey("ckuvla", a, [a, { rafsi: "cku", pair: "b" }], "one"),
  );
});

test("normalizing a revision preserves both historical formation fields and private reviews", () => {
  const result = buildLujvo({
    profile: "cll",
    components: [
      { id: "a", spelling: "cukta", kind: "gismu", claims: [] },
      { id: "b", spelling: "valsi", kind: "gismu", claims: [] },
    ],
  });
  const candidate = result.candidates[0];
  const compound = compoundMetadata(
    result,
    candidate,
    [
      {
        id: "a",
        spelling: "cukta",
        kind: "gismu",
        definition: null,
        gloss: "",
        claims: [],
        locked: null,
      },
      {
        id: "b",
        spelling: "valsi",
        kind: "gismu",
        definition: null,
        gloss: "",
        claims: [],
        locked: null,
      },
    ],
    "",
  );
  const formation = manualFormation([], "Historical note.");
  const draft = newDraft({
    spelling: candidate.spelling,
    kind: "lujvo",
    text: "A test.",
    compound,
    formation,
    evidenceForm: candidate.spelling,
    publishAcknowledged: ["one"],
  });
  const copy = normalizeDraft(draft);
  currentCompoundConflicts(copy.compound!, inventory());
  assert.deepEqual(copy.compound, compound);
  assert.deepEqual(copy.formation, formation);
  assert.deepEqual(copy.publishAcknowledged, ["one"]);
  assert.equal(
    draftToBody(copy).problems.some((p) => p.blocking),
    false,
  );
});

test("cut inventory coverage names the missing words", () => {
  const value = inventory();
  value.complete = false;
  value.incompleteWords = value.gismu;
  assert.match(inventoryCoverage(value), /coverage is incomplete for cukta/);
  assert.match(inventoryCoverage(value), /Missing claims are unknown/);
});
