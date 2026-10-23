import { before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { initializeCore } from "../../../../packages/core/src/index.ts";
import {
  draftToBody,
  newDraft,
  newPlace,
  normalizeDraft,
  referenceFields,
} from "../../src/model/draft.ts";
import {
  applyMapping,
  applyProposals,
  currentDraft,
  draftFingerprint,
} from "../../src/model/assistance.ts";
import {
  newGismuState,
  sourceRowsFromFormation,
} from "../../src/model/builders.ts";
import type { Formation } from "../../src/model/types.ts";

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

function example() {
  const formation: Formation = {
    method: "algorithmic",
    algorithm: null,
    sources: [
      {
        language: "en",
        word: "book",
        input: { format: "lojbanized", text: "buk" },
        weight: { numerator: 1, denominator: 1 },
        notes: [["Original"]],
      },
    ],
    weights_profile: null,
    generated: "brodu",
    selected_score: { numerator: "1", denominator: "2" },
    selected_rank: 3,
    selection_reason: [["Chosen reason"]],
    candidates: [],
    conflicts: [],
  };
  return newDraft({
    kind: "gismu",
    spelling: "brodu",
    text: "A book.",
    formation,
    evidenceForm: "brodu",
    gismu: {
      ...newGismuState(),
      rows: sourceRowsFromFormation(formation.sources),
    },
  });
}

test("publication uses descriptive source edits even when navigation skips the form action", () => {
  const draft = example();
  const row = draft.gismu!.rows[0];
  row.word = "";
  row.notes = [];
  row.word_ipa = "bʊk";
  row.stem = "boo";
  row.ipa = "bʊ";
  const { body, problems } = draftToBody(draft);
  assert.equal(
    problems.some((p) => p.blocking),
    false,
  );
  assert.deepEqual(body?.etymology.formation?.sources[0], {
    language: "en",
    word: "",
    input: { format: "lojbanized", text: "buk" },
    weight: { numerator: 1, denominator: 1 },
    notes: [],
    word_ipa: "bʊk",
    stem: "boo",
    ipa: "bʊ",
  });
  assert.deepEqual(body?.etymology.formation?.selected_score, {
    numerator: "1",
    denominator: "2",
  });
});

for (const changed of ["language", "input", "weight"] as const) {
  test(`publication blocks a changed source ${changed} until the score is refreshed`, () => {
    const draft = example();
    const row = draft.gismu!.rows[0];
    if (changed === "language") row.language = "fr";
    if (changed === "input") {
      row.input = "buku";
      delete row.inputOriginal;
    }
    if (changed === "weight") row.weight = { numerator: "2", denominator: "1" };
    const { problems } = draftToBody(draft);
    assert.equal(
      problems.some(
        (p) =>
          p.blocking &&
          p.field === "formation" &&
          p.message.includes("source scoring inputs changed"),
      ),
      true,
    );
  });
}

test("a blank alternative does not change the saved scoring inputs", () => {
  const draft = example();
  draft.gismu!.rows.push({
    language: "en",
    name: "English",
    input: "",
    word: "",
    weight: { numerator: "1", denominator: "1" },
  });
  const { body, problems } = draftToBody(draft);
  assert.equal(
    problems.some((p) => p.blocking),
    false,
  );
  assert.equal(body?.etymology.formation?.sources.length, 1);
  assert.deepEqual(body?.etymology.formation?.selection_reason, [
    ["Chosen reason"],
  ]);
});

for (const method of ["algorithmic", "non-algorithmic", "unknown"] as const) {
  test(`opening ${method} evidence keeps signed sources with unknown words and inputs`, () => {
    const draft = example();
    draft.formation!.method = method;
    draft.formation!.sources.push({
      language: "hi",
      word: "",
      input: null,
      weight: { numerator: 1, denominator: 2 },
      notes: [],
    });
    draft.formation!.sources.push({
      language: "fr",
      word: "",
      input: null,
      weight: null,
      notes: [],
    });
    const sources = structuredClone(draft.formation!.sources);
    draft.gismu!.rows = sourceRowsFromFormation(sources);
    draft.gismu!.rows.push({
      language: "en",
      name: "English",
      word: "",
      input: "",
      weight: null,
    });
    const { body, problems } = draftToBody(draft);
    assert.equal(
      problems.some((p) => p.blocking),
      false,
    );
    assert.deepEqual(body?.etymology.formation?.sources, sources);
  });
}

test("body and request reads preserve the draft and its fingerprint without cloning private logs", () => {
  const draft = example();
  draft.frameMode = "fixed";
  draft.places = [newPlace(1)];
  draft.places[0].derivations = [
    {
      word: "klama",
      definition: null,
      place: 2,
      explanation: [["direct: A source place."]],
    },
  ];
  draft.gismu!.rows[0].notes = [["An edited note."]];
  const before = structuredClone(draft);
  const fingerprint = draftFingerprint(draft);
  const deep = JSON.parse(
    `{"unknown":${"[".repeat(10000)}0${"]".repeat(10000)}}`,
  );
  draft.ai = { records: [{ log: deep } as never] };
  assert.doesNotThrow(() => currentDraft(draft));
  assert.equal(draftFingerprint(draft), fingerprint);
  delete draft.ai;
  assert.deepEqual(draft, before);
  const loaded = normalizeDraft(draft);
  assert.deepEqual(loaded.formation!.sources[0].notes, [["An edited note."]]);
  assert.deepEqual(draft.formation!.sources[0].notes, [["Original"]]);
});

const mapping = {
  word: { language: "jbo" as const, spelling: "klama" },
  definition: null,
  place: 2,
  explanation: [["direct: A source place."]],
};

for (const operation of ["definition", "places-glosses", "mapping"] as const) {
  test(`${operation} acceptance permits existing stale scores and spelling evidence`, () => {
    const draft = example();
    draft.gismu!.rows[0].input = "buku";
    delete draft.gismu!.rows[0].inputOriginal;
    draft.evidenceForm = "cukta";
    draft.frameMode = "fixed";
    draft.places = [newPlace(1)];
    const frame = currentDraft(draft).frame!;
    frame.places[0].derivation.push(mapping);
    assert.doesNotThrow(() =>
      operation === "mapping"
        ? applyMapping(draft, 1, mapping)
        : applyProposals(draft, {
            operation,
            proposals:
              operation === "definition"
                ? [{ path: "/text", value: [["An improved definition."]] }]
                : [{ path: "/frame", value: frame }],
          } as never),
    );
    assert.equal(
      draftToBody(draft).problems.some(
        (p) => p.blocking && p.field === "formation",
      ),
      true,
    );
    if (operation === "definition")
      assert.deepEqual(draft.text, [["An improved definition."]]);
    else assert.equal(draft.places[0].derivations.length, 1);
  });
}

test("an existing opaque core frame error blocks an unrelated definition edit", () => {
  const draft = example();
  draft.frameMode = "fixed";
  draft.places = [newPlace(2)];
  assert.throws(
    () =>
      applyProposals(draft, {
        operation: "definition",
        proposals: [{ path: "/text", value: [["An improved definition."]] }],
      } as never),
    /frame places must form a contiguous prefix/,
  );
});

for (const operation of ["definition", "places-glosses"] as const) {
  test(`${operation} acceptance rejects a new empty paragraph hidden by the same core error`, () => {
    const draft = example();
    draft.notes = [[]];
    draft.frameMode = "fixed";
    draft.places = [newPlace(1)];
    draft.places[0].description = [["A valid place."]];
    const frame = currentDraft(draft).frame!;
    frame.places[0].description = [[]];
    const baseline = draftToBody(draft).problems.filter(
      (problem) => problem.blocking,
    );
    assert.equal(baseline.length, 1);
    assert.equal(baseline[0].field, "body");
    assert.match(
      baseline[0].message,
      /rich text paragraph must contain a node/,
    );
    assert.throws(
      () =>
        applyProposals(draft, {
          operation,
          proposals:
            operation === "definition"
              ? [
                  {
                    path: "/text",
                    value: [["A definition with an invalid paragraph."], []],
                  },
                ]
              : [{ path: "/frame", value: frame }],
        } as never),
      /rich text paragraph must contain a node/,
    );
  });
}

for (const operation of ["definition", "places-glosses", "mapping"] as const) {
  test(`${operation} acceptance rejects new references despite existing publication errors`, () => {
    const draft = example();
    draft.evidenceForm = "cukta";
    draft.frameMode = "fixed";
    draft.places = [newPlace(1)];
    draft.notes = [[999]];
    const frame = currentDraft(draft).frame!;
    frame.places[0].description = [[999]];
    assert.throws(
      () =>
        operation === "mapping"
          ? applyMapping(draft, 1, { ...mapping, explanation: [[999]] })
          : applyProposals(draft, {
              operation,
              proposals:
                operation === "definition"
                  ? [{ path: "/text", value: [[999]] }]
                  : [{ path: "/frame", value: frame }],
            } as never),
      /reference|place|explanation/i,
    );
  });
}

test("a places suggestion cannot add a second copy of an existing frame error", () => {
  const draft = example();
  draft.frameMode = "context";
  draft.places = [newPlace(1), newPlace(1)];
  const frame = currentDraft(draft).frame!;
  frame.places.push(structuredClone(frame.places[0]));
  assert.throws(
    () =>
      applyProposals(draft, {
        operation: "places-glosses",
        proposals: [{ path: "/frame", value: frame }],
      } as never),
    /declared twice/,
  );
});

test("validation keeps reference keys stable when the editor opens later", () => {
  const draft = example();
  draft.text = [[999]];
  draft.frameMode = "fixed";
  draft.places = [newPlace(1)];
  draft.frameConstraints = [[[998]]];
  const before = structuredClone(draft);
  const problems = draftToBody(draft).problems.filter((p) => p.richFieldKey);
  assert.deepEqual(draft, before);
  const keys = new Set(referenceFields(draft, true).map((field) => field.key));
  assert.equal(
    problems.every((problem) => keys.has(problem.richFieldKey!)),
    true,
  );
});

for (const node of [
  999,
  { operand: "absent" },
  { url: "http://invalid.test", label: "An invalid link" },
] as const) {
  test(`a definition suggestion cannot repeat an existing invalid reference ${JSON.stringify(node)}`, () => {
    const draft = example();
    draft.frameMode = "fixed";
    draft.places = [newPlace(1)];
    draft.text = [[node]];
    assert.throws(
      () =>
        applyProposals(draft, {
          operation: "definition",
          proposals: [{ path: "/text", value: [[node, node]] }],
        } as never),
      /place|operand|HTTPS/i,
    );
  });
}

test("accepting and undoing source text updates the publication copy immediately", async () => {
  const { applySource, restorePatches, undoPatches } =
    await import("../../src/model/assistance.ts");
  const draft = example();
  const before = structuredClone(draft.gismu);
  const changedSource = {
    ...draft.formation!.sources[0],
    word: "books",
    notes: [["Accepted note"]],
  };
  applySource(draft, draft.gismu!.rows[0].id!, {
    proposals: [{ path: "/formation/sources", value: [changedSource] }],
  } as never);
  assert.equal(draft.formation!.sources[0].word, "books");
  assert.deepEqual(draft.formation!.sources[0].notes, [["Accepted note"]]);
  const after = structuredClone(draft.gismu);
  const record = {
    key: `source-${draft.gismu!.rows[0].id!}`,
    before: { gismu: before },
    after: { gismu: after },
    patches: undoPatches({ gismu: before }, { gismu: after }),
  };
  restorePatches(draft, record as never);
  assert.equal(draft.formation!.sources[0].word, "book");
  assert.deepEqual(draft.formation!.sources[0].notes, [["Original"]]);
  assert.deepEqual(draft.formation!.selected_score, {
    numerator: "1",
    denominator: "2",
  });
});

for (const missing of ["kind", "spelling"] as const) {
  for (const operation of ["definition", "places-glosses"] as const) {
    test(`${operation} acceptance requires a body and word ID when ${missing} is missing`, () => {
      const draft = example();
      if (missing === "kind") draft.kind = null;
      else draft.spelling = "";
      draft.frameMode = "fixed";
      draft.places = [newPlace(1)];
      draft.places[0].description = [["A valid place."]];
      const checked = draftToBody(draft);
      assert.equal(checked.body, null);
      assert.equal(checked.wordId, null);
      const frame = currentDraft(draft).frame!;
      frame.places[0].description = [[]];
      assert.throws(
        () =>
          applyProposals(draft, {
            operation,
            proposals:
              operation === "definition"
                ? [
                    {
                      path: "/text",
                      value: [["A definition with an invalid paragraph."], []],
                    },
                  ]
                : [{ path: "/frame", value: frame }],
          } as never),
        /Choose the word type and enter its spelling before applying this suggestion/,
      );
    });
  }
}
