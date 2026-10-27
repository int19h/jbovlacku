import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { analyzeWord } from "../src/index.ts";
import {
  projectHesitationWords,
  apostrophePauseProof,
  foreignRunProof,
  assertBundledGrammarIdentity,
  assertCacheIdentity,
  REFERENCE_REVISION,
  fallingDiphthongSpacing,
  randomForms,
  RANDOM_SEED,
  type Word,
  type Reference,
} from "../../../scripts/compare-gencmu-morphology.ts";

const word = (text: string, kind = "cmavo"): Word => ({
  text,
  kind,
  warning: false,
});

test("the seeded reference comparison retains the reviewer's exact distribution", () => {
  const inputs = randomForms();
  assert.equal(inputs.length, 8654);
  assert.deepEqual(inputs, randomForms());
  assert.ok(inputs.includes("baoz"));
  assert.ok(inputs.includes("uylaolje"));
  assert.notDeepEqual(inputs, randomForms(1));
  assert.equal(
    new Set([...inputs, ...randomForms((RANDOM_SEED + 1) >>> 0, 500)]).size,
    9485,
  );
});

test("the reference exception inserts pauses only after a falling diphthong before a cmavo", () => {
  assert.equal(
    fallingDiphthongSpacing("taia", [word("tai"), word("a")]),
    "tai a",
  );
  assert.equal(
    fallingDiphthongSpacing("baoz", [word("ba"), word("oz", "cmevla")]),
    null,
  );
  assert.equal(
    fallingDiphthongSpacing("baiolje", [word("bai"), word("olje", "brivla")]),
    null,
  );
  assert.equal(fallingDiphthongSpacing("aia", [word("a"), word("ia")]), null);
  assert.equal(
    fallingDiphthongSpacing("tai'a", [word("tai"), word("a")]),
    null,
  );
  assert.equal(
    fallingDiphthongSpacing("tai a", [word("tai"), word("a")]),
    null,
  );
});

test("all 220 pinned dictionary false warnings remain accepted without CgV warnings", () => {
  const evidence = JSON.parse(
    readFileSync(
      new URL("../evidence/cgv-false-warnings.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(evidence.count, 220);
  assert.equal(evidence.words.length, 220);
  assert.equal(
    new Set(evidence.words.map((row: { input: string }) => row.input)).size,
    220,
  );
  for (const row of evidence.words) {
    const analysis = analyzeWord("extended-v4", row.input);
    assert.equal(analysis.kind, row.kind, row.input);
    assert.deepEqual(analysis.diagnostics, [], row.input);
    assert.ok(
      analysis.words?.every((word) => word.diagnostics.length === 0),
      row.input,
    );
  }
});

test("reference evidence refuses changed bundle, source, input, and result digests", () => {
  const hashes = { "grammars/words/experimental.md": "abc" };
  assertBundledGrammarIdentity(hashes, { "words/experimental.md": "abc" });
  assert.throws(
    () =>
      assertBundledGrammarIdentity(hashes, {
        "words/experimental.md": "changed",
      }),
    /Bundled grammar differs/,
  );
  assert.throws(
    () => assertBundledGrammarIdentity(hashes, {}),
    /manifest is empty/,
  );
  const summary = {
    reference: { revision: REFERENCE_REVISION, sourceHashes: hashes },
    inputsSha256: "inputs",
    resultsSha256: "results",
  };
  assertCacheIdentity(summary, hashes, "inputs", "results");
  assert.throws(
    () =>
      assertCacheIdentity(summary, { changed: "source" }, "inputs", "results"),
    /sources or inputs differ/,
  );
  assert.throws(
    () => assertCacheIdentity(summary, hashes, "changed", "results"),
    /sources or inputs differ/,
  );
  assert.throws(
    () => assertCacheIdentity(summary, hashes, "inputs", "changed"),
    /results digest differs/,
  );
});

test("pure-y reference tokens merge only within one contiguous hesitation run", () => {
  const reference = {
    ok: true,
    words: [word("yy", "hesitation"), word("y", "hesitation"), word("bu")],
    tokens: [
      { text: "yy", tags: ["Hesitation"], source: [0, 2] },
      { text: "y", tags: ["Hesitation"], source: [2, 3] },
      { text: "bu", tags: ["Word", "Cmavo"], source: [3, 5] },
    ],
  };
  assert.deepEqual(projectHesitationWords(reference), [
    word("yyy"),
    word("bu"),
  ]);
  reference.tokens[1].source = [3, 4];
  assert.deepEqual(projectHesitationWords(reference), [
    word("yy"),
    word("y"),
    word("bu"),
  ]);
});

function projected(input: string) {
  const result = analyzeWord("extended-v4", input);
  return {
    normalized: result.normalized,
    words: (result.words ?? []).map((w) => ({
      text: w.text,
      kind: ["gismu", "lujvo", "fuhivla"].includes(w.kind) ? "brivla" : w.kind,
      warning: w.diagnostics.length !== 0,
    })),
  };
}

test("apostrophe pause proof requires both the unchanged reference words and the exact cmavo split", () => {
  const original: Reference = {
    ok: true,
    words: [word("ba"), word("uy")],
    tokens: [
      { text: "ba", tags: ["Word", "Cmavo"], source: [0, 2] },
      { text: "uy", tags: ["Word", "Cmavo"], source: [2, 4] },
      { text: " ", tags: ["PAUSE"], source: [4, 5] },
    ],
  };
  const spaced: Reference = {
    ok: true,
    words: [word("bau"), word("y", "hesitation")],
    tokens: [
      { text: "bau", tags: ["Word", "Cmavo"], source: [0, 3] },
      { text: " ", tags: ["PAUSE"], source: [3, 4] },
      { text: "y", tags: ["Hesitation"], source: [4, 5] },
    ],
  };
  const reference = (input: string) => {
    if (input === "bauy ") return original;
    assert.equal(input, "bau y");
    return spaced;
  };
  const proof = apostrophePauseProof("bauy'", original, projected, reference);
  assert.equal(proof?.input, "bauy ");
  assert.equal(proof?.spacing?.input, "bau y");
  assert.deepEqual(proof?.actual, [word("bau"), word("y")]);
  for (const mutation of [
    (r: Reference) => {
      r.words[0].warning = true;
    },
    (r: Reference) => {
      r.words[0].kind = "brivla";
    },
    (r: Reference) => {
      r.words.reverse();
    },
    (r: Reference) => {
      r.ok = false;
    },
  ]) {
    const changed = structuredClone(spaced);
    mutation(changed);
    assert.equal(
      apostrophePauseProof("bauy'", original, projected, (input) =>
        input === "bauy " ? original : changed,
      ),
      null,
    );
  }
  const changed = structuredClone(original);
  changed.words[0].text = "bo";
  assert.equal(
    apostrophePauseProof("bauy'", original, projected, () => changed),
    null,
  );
  const untagged = structuredClone(original);
  untagged.tokens[2].tags = ["FOREIGN"];
  assert.equal(
    apostrophePauseProof("bauy'", untagged, projected, reference),
    null,
  );
  const overlapping = structuredClone(original);
  overlapping.tokens[2].source = [3, 5];
  assert.equal(
    apostrophePauseProof("bauy'", overlapping, projected, reference),
    null,
  );
});

test("foreign-run proof keeps normalized source offsets and requires every surviving word and warning", () => {
  const input = "zoi .yy. bu. foo .ybu";
  const reference: Reference = { ok: true, words: [], tokens: [] };
  let cursor = 0;
  for (const [text, kind] of [
    ["zoi", "cmavo"],
    ["y", "hesitation"],
    ["y", "hesitation"],
    ["bu", "cmavo"],
    ["foo", "foreign"],
    ["y", "hesitation"],
    ["bu", "cmavo"],
  ]) {
    const start = input.indexOf(text, cursor);
    if (start > cursor)
      reference.tokens.push({
        text: " ",
        tags: ["PAUSE"],
        source: [cursor, start],
      });
    reference.tokens.push({
      text,
      source: [start, start + text.length],
      tags:
        kind === "foreign"
          ? ["FOREIGN"]
          : kind === "hesitation"
            ? ["Hesitation"]
            : ["Word", "Cmavo"],
    });
    if (kind !== "foreign") reference.words.push(word(text, kind));
    cursor = start + text.length;
  }
  const proof = foreignRunProof(input, reference, projected);
  assert.deepEqual(
    proof?.runs.map((run) => run.input),
    ["zoi", "yy", "bu", "foo", "ybu"],
  );
  assert.deepEqual(
    proof?.runs.flatMap((run) => run.actual),
    [word("zoi"), word("yy"), word("bu"), word("y"), word("bu")],
  );
  assert.equal(
    foreignRunProof("zoi .Y,y. bu. foo .ybu", reference, projected),
    null,
  );
  const changedWarning = structuredClone(reference);
  changedWarning.words[0].warning = true;
  assert.equal(foreignRunProof(input, changedWarning, projected), null);
  assert.equal(
    foreignRunProof(input, reference, (run) =>
      run === "foo"
        ? { normalized: run, words: [word("foo")] }
        : projected(run),
    ),
    null,
  );
  const noForeign = structuredClone(reference);
  noForeign.tokens = noForeign.tokens.filter(
    (token) => !token.tags.includes("FOREIGN"),
  );
  assert.equal(foreignRunProof(input, noForeign, projected), null);
});
