import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  initializeCore,
  prepareAdmission,
  signHeader,
  identityFromSeed,
  canonicalize,
  contentHash,
  utf8,
  buildLujvo,
  builderPresets,
  generateGismu,
} from "../../../../packages/core/src/index.ts";
import {
  compoundMetadata,
  formationMetadata,
  manualFormation,
  newGismuState,
  formationSource,
  type GismuRowState,
} from "../../src/model/builders.ts";
import {
  draftFromBody,
  draftToBody,
  editorText,
  editorToRichText,
  literalize,
  newDraft,
  newPlace,
  normalizeDraft,
  numberPlaceholders,
  referenceFields,
  remapPlaces,
  rewriteReferences,
  richTextToEditor,
  switchMode,
  LENSISKU_RIGHTS_REFERENCE,
} from "../../src/model/draft.ts";
import { textToRichText, richTextToText } from "../../src/model/richtext.ts";

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
import {
  applySource,
  sourceCurrent,
  mappingKind,
  type Suggestion,
} from "../../src/model/assistance.ts";
const seed = new Uint8Array(32).fill(77);
/** Signs the body and checks it against the version 1 action and body rules. */
function admissible(body: unknown, parents: string[] = []) {
  const { wordId } = draftToBody(
    newDraft({
      spelling: (body as { word: { spelling: string } }).word.spelling,
      kind: "gismu",
      text: "x",
    }),
  );
  const canonical = canonicalize(utf8(JSON.stringify(body)));
  const header = {
    version: 1 as const,
    issuer: identityFromSeed(seed),
    previous: [],
    nonce: "1".repeat(32),
    action: {
      kind: "definition.publish",
      word: wordId!,
      language: (body as { language: string }).language,
      parents,
      origin: "native",
    },
    content: {
      hash: contentHash(utf8(canonical)),
      bytes: utf8(canonical).length,
    },
  };
  const envelope = signHeader(seed, header);
  const prepared = prepareAdmission(utf8(JSON.stringify({ envelope, body })));
  return prepared.action_valid && prepared.body_status === "present";
}

test("structured text keeps declared place order and literal mode keeps circled characters", () => {
  const structured = editorToRichText(
    "③ runs before ① and [[cukta|the book]] {place 21}",
    true,
  );
  assert.deepEqual(structured, [
    [
      3,
      " runs before ",
      1,
      " and ",
      { word: { language: "jbo", spelling: "cukta" }, label: "the book" },
      " ",
      21,
    ],
  ]);
  const literal = textToRichText("③ runs before ①", false);
  assert.deepEqual(literal, [["③ runs before ①"]]);
  assert.equal(
    richTextToEditor(structured),
    "③ runs before ① and [[cukta|the book]] {place 21}",
  );
  assert.equal(literalize("see {place 21} and ①"), "see \\{place 21} and \\①");
  // Every node kind has a text form, and literal characters stay literal.
  const every = [
    [
      "see ① and `ko'a` with {operand x} at ",
      { url: "https://example.org/a?b=[1]", label: "the source" },
      " ",
      { code: "ba`ck" },
    ],
  ] as const;
  const text = richTextToEditor(every as never);
  assert.deepEqual(editorToRichText(text, true), [
    [
      "see ① and `ko'a` with {operand x} at ",
      { url: "https://example.org/a?b=[1]", label: "the source" },
      " ",
      { code: "ba`ck" },
    ],
  ]);
  assert.equal(
    richTextToEditor([
      [
        "①",
        { operand: "x" },
        { word: { language: "jbo", spelling: "cukta" }, label: "cukta" },
      ],
    ]),
    "\\①{operand x}[[cukta]]",
  );
});

test("a short literal definition publishes without advanced fields under the fixed CC0 terms", () => {
  const draft = newDraft({
    spelling: "broda",
    kind: "gismu",
    text: "A disposable test meaning.",
    structured: false,
  });
  const { body, problems } = draftToBody(draft);
  assert.deepEqual(
    problems.filter((pr) => pr.blocking),
    [],
  );
  assert.ok(body);
  assert.equal(body.frame, null);
  assert.deepEqual(body.license, {
    expression: "CC0-1.0",
    url: "https://creativecommons.org/publicdomain/zero/1.0/",
    attribution: "",
  });
  assert.equal(body.legacy, null);
  assert.ok(admissible(body));
});

test("a reference to an undeclared place blocks signing and the literal escape preserves the text", () => {
  const draft = newDraft({
    spelling: "broda",
    kind: "gismu",
    text: "① is near ③.",
    frameMode: "fixed",
    places: [newPlace(1)],
    numberingApproved: true,
  });
  const { problems } = draftToBody(draft);
  assert.ok(
    problems.some(
      (pr) => pr.blocking && /Place 3 is referenced/.test(pr.message),
    ),
  );
  const escaped = newDraft({
    ...draft,
    text: literalize(editorText(draft.text, true)),
  });
  const { body, problems: after } = draftToBody(escaped);
  assert.deepEqual(
    after.filter((pr) => pr.blocking),
    [],
  );
  assert.deepEqual(body!.text, [["① is near ③."]]);
});

test("the numbering needs approval and a fixed frame declares every index in order", () => {
  const draft = newDraft({
    spelling: "broda",
    kind: "gismu",
    text: "③ before ①",
    frameMode: "fixed",
    places: [newPlace(1), newPlace(2), newPlace(3)],
  });
  assert.ok(draftToBody(draft).problems.some((pr) => pr.field === "numbering"));
  draft.numberingApproved = true;
  const { body, problems } = draftToBody(draft);
  assert.deepEqual(
    problems.filter((pr) => pr.blocking),
    [],
  );
  assert.deepEqual(
    body!.frame!.places.map((pl) => pl.index),
    [1, 2, 3],
  );
  assert.deepEqual(body!.text, [[3, " before ", 1]]);
  assert.ok(admissible(body));
  draft.places = [newPlace(1), newPlace(3)];
  assert.ok(
    draftToBody(draft).problems.some((pr) =>
      /out of sequence/.test(pr.message),
    ),
  );
});

test("variadic and context frames and type hints round-trip through the body", () => {
  const draft = newDraft({
    spelling: "broda",
    kind: "cmavo",
    selmaho: ["UI"],
    text: "① and ②, then more.",
    frameMode: "variadic",
    variadicMinimum: 2,
    places: [
      {
        ...newPlace(1),
        glosses: [{ language: "en", text: "first", sense: "" }],
        kind: "property",
      },
      {
        ...newPlace(2),
        kind: "custom",
        hint: {
          alternatives: [
            {
              tags: ["set", "text"],
              abstractor: null,
              relation_arity: { mode: "context" },
            },
          ],
          note: [["custom"]],
        },
      },
    ],
    tail: { description: "further items", kind: "object", hint: null },
    numberingApproved: true,
  });
  const { body, problems } = draftToBody(draft);
  assert.deepEqual(
    problems.filter((pr) => pr.blocking),
    [],
  );
  assert.deepEqual(body!.frame!.arity, { mode: "variadic", minimum: 2 });
  assert.equal(body!.frame!.tail!.from, 3);
  assert.deepEqual(body!.frame!.places[0].type_hints[0].alternatives[0], {
    tags: ["relation"],
    abstractor: "ka",
    relation_arity: { mode: "fixed", count: 1 },
  });
  assert.deepEqual(body!.frame!.places[1].type_hints[0].alternatives[0].tags, [
    "set",
    "text",
  ]);
  assert.ok(admissible(body));
  const back = draftFromBody(body!, "jve1:" + "a".repeat(64), "native");
  assert.equal(back.frameMode, "variadic");
  assert.equal(back.places[0].kind, "property");
  assert.equal(back.places[1].kind, "custom");
  assert.deepEqual(back.parents, ["jve1:" + "a".repeat(64)]);
  const again = draftToBody({ ...back, numberingApproved: true });
  assert.deepEqual(again.body!.frame, body!.frame);
  assert.deepEqual(again.body!.classification, body!.classification);
});

test("a revision of imported text cites the imported publication and copies the rights reference", () => {
  const imported = draftToBody(
    newDraft({
      spelling: "ckusro",
      kind: "lujvo",
      text: "x1 is a library.",
      structured: false,
    }),
  ).body!;
  const legacy = {
    ...imported,
    license: {
      expression: "unknown",
      url: null,
      attribution: "Lensisku source author unknown",
    },
    legacy: { source: "https://lensisku.invalid" } as never,
  };
  const parent = "jve1:" + "b".repeat(64);
  const draft = draftFromBody(legacy, parent, "import");
  assert.deepEqual(draft.parents, [parent]);
  assert.equal(draft.sources[0].event, parent);
  assert.deepEqual(draft.sources.at(-1), LENSISKU_RIGHTS_REFERENCE);
  const { body } = draftToBody(draft);
  assert.equal(body!.license.expression, "CC0-1.0");
  assert.equal(body!.license.attribution, "");
  assert.equal(body!.legacy, null);
  assert.ok(admissible(body, [parent]));
});

test("placeholders become numbered places only through explicit numbering", () => {
  const { text, count } = numberPlaceholders("___ reads ___ in ___");
  assert.equal(count, 3);
  assert.equal(text, "① reads ② in ③");
  assert.equal(richTextToText(editorToRichText(text, true)), "① reads ② in ③");
});

test("builder metadata for a chosen lujvo and a generated gismu satisfies the body rules", () => {
  const lujvo = buildLujvo({
    profile: "cll",
    components: [
      {
        id: "a",
        spelling: "cukta",
        kind: "gismu",
        claims: [{ rafsi: "cku", pair: "jvr1:" + "c".repeat(64) }],
      },
      { id: "b", spelling: "sinxa", kind: "gismu", claims: [] },
    ],
  });
  assert.equal(lujvo.candidates[0].spelling, "ckusinxa");
  const compound = compoundMetadata(
    lujvo,
    lujvo.candidates[0],
    [
      {
        id: "a",
        spelling: "cukta",
        kind: "gismu",
        definition: "jve1:" + "a".repeat(64),
        gloss: "book",
        claims: [],
        locked: null,
      },
      {
        id: "b",
        spelling: "sinxa",
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
    compound.components.map((c) => c.rafsi),
    ["cku", "sinxa"],
  );
  assert.equal(compound.score, 7917);
  const draft = newDraft({
    spelling: "ckusinxa",
    kind: "lujvo",
    text: "A bookmark.",
    structured: false,
    compound,
  });
  const { body, problems } = draftToBody(draft);
  assert.deepEqual(
    problems.filter((pr) => pr.blocking),
    [],
  );
  assert.ok(admissible(body));
  // Every preset names the digest of its pinned source bytes.
  for (const pr of builderPresets())
    assert.match(pr.source_digest, /^[0-9a-f]{64}$/, pr.id);
  const preset = builderPresets().find((pr) => pr.id === "cll-1995")!;
  const rows = preset.languages.map((l) => ({
    language: l.language,
    name: l.name,
    word: l.language,
    word_ipa: "ˈmakru",
    stem: "makr",
    ipa: "makr",
    input: "makru",
    weight: {
      numerator: String(l.numerator),
      denominator: String(preset.denominator),
    },
  }));
  const gismu = generateGismu({
    sources: rows.map((r) => ({
      language: r.language,
      word: r.word,
      input: r.input,
      weight: r.weight,
    })),
    window: 4,
    manual: "makru",
    inventory: {
      snapshot: "sha256:" + "0".repeat(64),
      gismu: [{ spelling: "makru", word: "jvw1:" + "1".repeat(64) }],
    },
  });
  const candidate = gismu.manual!;
  assert.equal(candidate.rank, 1);
  assert.equal(candidate.conflicts[0].rule, "identical");
  const formation = formationMetadata({
    result: gismu,
    candidate,
    rows,
    preset,
    acknowledged: [
      {
        word: candidate.conflicts[0].word,
        rule: "identical",
        snapshot: "sha256:" + "0".repeat(64),
      },
    ],
    reason: "Shortest form.",
  });
  assert.equal(formation.selected_score!.numerator, "1");
  assert.equal(formation.selected_rank, 1);
  assert.equal(formation.sources[0].word_ipa, "ˈmakru");
  assert.equal(formation.sources[0].stem, "makr");
  assert.equal(formation.sources[0].ipa, "makr");
  assert.equal(formation.weights_profile!.name, "CLL 1995");
  assert.equal(
    formation.algorithm!.parameters.weighting,
    "normalize-positive-sum-v1",
  );
  const gismuDraft = newDraft({
    spelling: "makru",
    kind: "gismu",
    text: "x",
    structured: false,
    formation,
  });
  const built = draftToBody(gismuDraft);
  assert.deepEqual(
    built.problems.filter((pr) => pr.blocking),
    [],
  );
  assert.ok(admissible(built.body));
  const manual = manualFormation(
    rows.map((r) => ({ ...r, input: "" })),
    "A name-like root.",
  );
  assert.equal(manual!.method, "non-algorithmic");
  assert.equal(manual!.algorithm, null);
  assert.ok(
    admissible(
      draftToBody(
        newDraft({
          spelling: "makru",
          kind: "gismu",
          text: "x",
          structured: false,
          formation: manual,
        }),
      ).body,
    ),
  );
});

test("builders omit blank source evidence and preserve meaningful values before admission", () => {
  const row: GismuRowState = {
    language: "en",
    name: "English",
    word: "running",
    word_ipa: " ˈrʌnɪŋ ",
    stem: " run\t",
    ipa: "\trʌn\n",
    input: "makru",
    weight: { numerator: "1", denominator: "1" },
  };
  const result = generateGismu({
    sources: [
      {
        language: row.language,
        word: row.word,
        input: row.input,
        weight: row.weight,
      },
    ],
    window: 1,
    manual: "makru",
  });
  const builders = [
    {
      name: "manual",
      build: (source: GismuRowState) =>
        manualFormation([source], "A manual root.")!,
    },
    {
      name: "generated",
      build: (source: GismuRowState) =>
        formationMetadata({
          result,
          candidate: result.manual!,
          rows: [source],
          preset: null,
          acknowledged: [],
          reason: "A generated root.",
        }),
    },
  ];
  const fields = ["word_ipa", "stem", "ipa"] as const;
  for (const builder of builders) {
    for (const field of fields) {
      for (const value of [null, "", " ", "\t", " \t\n "]) {
        const context = `${builder.name}: ${field} = ${JSON.stringify(value)}`;
        const formation = builder.build({ ...row, [field]: value });
        const source = formation.sources[0];
        assert.equal(Object.hasOwn(source, field), false, context);
        for (const other of fields) {
          if (other !== field) assert.equal(source[other], row[other], context);
        }
        const built = draftToBody(
          newDraft({
            spelling: "makru",
            kind: "gismu",
            text: "A fixture meaning.",
            formation,
            evidenceForm: "makru",
          }),
        );
        assert.deepEqual(built.problems, [], context);
        assert.ok(admissible(built.body), context);
      }
    }
    const formation = builder.build(row);
    for (const field of fields) {
      assert.equal(formation.sources[0][field], row[field], builder.name);
    }
    const built = draftToBody(
      newDraft({
        spelling: "makru",
        kind: "gismu",
        text: "A fixture meaning.",
        formation,
        evidenceForm: "makru",
      }),
    );
    assert.deepEqual(built.problems, [], builder.name);
    assert.ok(admissible(built.body), builder.name);
  }
});

test("source pronunciations and stems survive draft reload, publication, and revision", () => {
  const row = {
    language: "en",
    name: "English",
    word: "running",
    word_ipa: "ˈrʌnɪŋ",
    stem: "run",
    ipa: "rʌn",
    input: "ran",
    weight: null,
  };
  const formation = manualFormation([row], "A manual root.")!;
  assert.deepEqual(formation.sources[0], {
    language: "en",
    word: "running",
    word_ipa: "ˈrʌnɪŋ",
    stem: "run",
    ipa: "rʌn",
    input: { format: "lojbanized", text: "ran" },
    weight: null,
    notes: [],
  });
  const draft = newDraft({
    spelling: "broda",
    kind: "gismu",
    text: "A running thing.",
    formation,
    evidenceForm: "broda",
    gismu: { ...newGismuState(), rows: [row] },
  });
  const restored = normalizeDraft(JSON.parse(JSON.stringify(draft)));
  assert.equal(typeof restored.gismu!.rows[0].id, "string");
  assert.deepEqual(restored.gismu!.rows[0], {
    ...row,
    id: restored.gismu!.rows[0].id,
  });
  const built = draftToBody(restored);
  assert.deepEqual(built.problems, []);
  assert.deepEqual(built.body!.etymology.formation, formation);
  assert.ok(admissible(built.body));
  const parent = "jve1:" + "1".repeat(64);
  const revision = draftToBody(draftFromBody(built.body!, parent, "native"));
  assert.deepEqual(revision.problems, []);
  assert.deepEqual(revision.body!.etymology.formation, formation);
  assert.ok(admissible(revision.body, [parent]));

  const { word_ipa, stem, ipa, ...older } = row;
  assert.equal(word_ipa, "ˈrʌnɪŋ");
  assert.equal(stem, "run");
  assert.equal(ipa, "rʌn");
  const unknown = manualFormation([older], "Older evidence.")!;
  for (const field of ["word_ipa", "stem", "ipa"] as const) {
    assert.equal(Object.hasOwn(unknown.sources[0], field), false);
  }
  const nulls = manualFormation(
    [{ ...older, word_ipa: null, stem: null, ipa: null }],
    "Unknown evidence.",
  )!;
  assert.deepEqual(nulls.sources, unknown.sources);
  const evidenceOnly = manualFormation(
    [{ ...row, word: "", input: "" }],
    "Partial historical evidence.",
  )!;
  assert.equal(evidenceOnly.sources.length, 1);
  assert.equal(evidenceOnly.sources[0].word_ipa, row.word_ipa);
  assert.equal(evidenceOnly.sources[0].stem, row.stem);
  assert.equal(evidenceOnly.sources[0].ipa, row.ipa);
  assert.equal(evidenceOnly.sources[0].input, null);
});

/** An independent body that uses every field the format offers, not one the draft serializer made. */
function richParent() {
  const id = (c: string) => "jve1:" + c.repeat(64);
  return {
    word: { language: "jbo", spelling: "banli" },
    language: "en",
    text: [
      [
        "See ",
        { url: "https://example.org/source", label: "the source" },
        " and ",
        { code: "ko'a" },
        " and ",
        { operand: "x" },
        " with literal ① at ",
        1,
        ".",
      ],
      ["Second paragraph with [[brackets]] and `ticks` and a \\ slash."],
    ],
    frame: {
      role: "constructed-predicate",
      arity: { mode: "variadic", minimum: 1 },
      places: [
        {
          index: 1,
          glosses: [
            { language: "en", text: "one", sense: "a" },
            { language: "fr", text: "deux", sense: null },
          ],
          description: [
            [
              "thing ",
              { word: { language: "jbo", spelling: "cukta" }, label: "book" },
            ],
          ],
          type_hints: [
            {
              alternatives: [
                { tags: ["referent"], abstractor: null, relation_arity: null },
                { tags: ["event"], abstractor: "nu", relation_arity: null },
              ],
              note: [["note with ", 1]],
            },
          ],
          defaults: [
            {
              kind: "suggested",
              value: { format: "prose", language: "de", text: "etwas" },
              condition: [["when ", 1, " is ", { code: "zo'e" }]],
              explanation: [
                ["see ", { url: "https://example.org/x", label: "x" }],
              ],
            },
          ],
          constraints: [[["only ", 1]]],
          derivation: [
            {
              word: { language: "jbo", spelling: "banro" },
              definition: null,
              place: 1,
              explanation: [["first"]],
            },
            {
              word: { language: "jbo", spelling: "barda" },
              definition: id("d"),
              place: 2,
              explanation: [["second ", { code: "x" }]],
            },
          ],
        },
      ],
      tail: {
        from: 2,
        description: [["more ", 1]],
        type_hints: [
          {
            alternatives: [
              { tags: ["set"], abstractor: null, relation_arity: null },
            ],
            note: [],
          },
        ],
      },
      constraints: [[["frame ", 1]]],
    },
    operands: [
      {
        id: "x",
        category: "sumti",
        description: [["the ", 1]],
        cardinality: { minimum: 0, maximum: null },
      },
    ],
    glosses: [
      { language: "en", text: "great", sense: "in size" },
      { language: "jbo", text: "barda", sense: null },
    ],
    notes: [
      [
        "notes ",
        { word: { language: "jbo", spelling: "cukta" }, label: "cukta" },
      ],
    ],
    etymology: {
      text: [["from ", { url: "https://example.org/e", label: "e" }]],
      formation: null,
      compound: null,
    },
    examples: [
      {
        language: "jbo",
        text: "mi banli",
        translation: [["I am great ", { code: "mi" }]],
        notes: [["literal ①"]],
      },
    ],
    classification: { kind: "gismu", selmaho: [] },
    labels: ["a", "b"],
    sources: [
      {
        label: "src",
        url: "https://example.org/s",
        event: null,
        locator: "p1",
      },
    ],
    license: {
      expression: "CC0-1.0",
      url: "https://creativecommons.org/publicdomain/zero/1.0/",
      attribution: "",
    },
    legacy: null,
  };
}

test("Revise keeps every node, gloss, hint, derivation, role, and literal character of an independent body", () => {
  const parent = richParent();
  assert.ok(admissible(parent), "the independent parent must be admissible");
  const parentId = "jve1:" + "a".repeat(64);
  const draft = draftFromBody(parent as never, parentId, "native");
  assert.equal(draft.frameRole, "constructed-predicate");
  assert.equal(draft.places[0].glosses.length, 2);
  assert.equal(draft.places[0].derivations.length, 2);
  const { body, problems } = draftToBody(draft);
  assert.deepEqual(
    problems.filter((pr) => pr.blocking),
    [],
  );
  assert.deepEqual(body, parent);
  assert.ok(admissible(body, [parentId]));
});

test("an old draft of this prototype loads with its single gloss and derivation kept", () => {
  const { glosses, derivations, ...oldPlace } = newPlace(1);
  void glosses;
  void derivations;
  const old = {
    ...newDraft({ spelling: "broda", kind: "gismu", language: "en" }),
    places: [
      {
        ...oldPlace,
        gloss: "first",
        from: { word: "sinxa", definition: null, place: 2, explanation: "" },
      },
    ],
  } as never as Parameters<typeof normalizeDraft>[0];
  delete (old as { frameRole?: string }).frameRole;
  const draft = normalizeDraft(old);
  assert.deepEqual(draft.places[0].glosses, [
    { language: "en", text: "first", sense: "" },
  ]);
  assert.deepEqual(draft.places[0].derivations, [
    { word: "sinxa", definition: null, place: 2, explanation: [] },
  ]);
  assert.equal(draft.frameRole, "predicate");
  assert.equal("gloss" in draft.places[0], false);
});

test("removing a place keeps every reference's referent", () => {
  const text = "① gives ② to ③ and \\② stays";
  assert.equal(
    remapPlaces(text, (n) => (n === 2 ? "literal" : n > 2 ? n - 1 : n)),
    "① gives \\② to ② and \\② stays",
  );
});

test("the editor and the core agree on every reviewed invalid draft", () => {
  const blocking = (draft: ReturnType<typeof newDraft>) =>
    draftToBody(draft)
      .problems.filter((pr) => pr.blocking)
      .map((pr) => pr.message);
  const base = {
    spelling: "broda",
    kind: "gismu" as const,
    text: "fine",
    numberingApproved: true,
  };
  // P1 and P2: a reference in a constraint or the tail.
  assert.match(
    blocking(
      newDraft({
        ...base,
        frameMode: "fixed",
        places: [{ ...newPlace(1), constraints: ["only ②"] }],
      }),
    ).join("\n"),
    /Place 2 is referenced in place 1's constraint 1/,
  );
  assert.match(
    blocking(
      newDraft({
        ...base,
        frameMode: "variadic",
        places: [newPlace(1)],
        tail: { description: "more ③", kind: "object", hint: null },
      }),
    ).join("\n"),
    /Place 3 is referenced in the repeated places' description/,
  );
  // P3: a variadic frame needs a contiguous prefix.
  assert.match(
    blocking(
      newDraft({
        ...base,
        frameMode: "variadic",
        places: [newPlace(1), newPlace(3)],
        tail: { description: "more", kind: "object", hint: null },
      }),
    ).join("\n"),
    /out of sequence/,
  );
  // P4: a derivation needs a source place from 1.
  assert.match(
    blocking(
      newDraft({
        ...base,
        frameMode: "fixed",
        places: [
          {
            ...newPlace(1),
            derivations: [
              { word: "sinxa", definition: null, place: 0, explanation: "" },
            ],
          },
        ],
      }),
    ).join("\n"),
    /needs the source place number/,
  );
  assert.match(
    blocking(
      newDraft({
        ...base,
        frameMode: "fixed",
        places: [
          {
            ...newPlace(1),
            derivations: [
              { word: "sinxa", definition: null, place: null, explanation: "" },
            ],
          },
        ],
      }),
    ).join("\n"),
    /needs the source place number/,
  );
  // P5: custom tags are named kinds or HTTPS URLs, and alternatives are distinct.
  const custom = (alternatives: unknown[]) =>
    newDraft({
      ...base,
      frameMode: "fixed",
      places: [
        {
          ...newPlace(1),
          kind: "custom",
          hint: { alternatives: alternatives as never, note: [] },
        },
      ],
    });
  assert.match(
    blocking(
      custom([{ tags: ["thing"], abstractor: null, relation_arity: null }]),
    ).join("\n"),
    /uses the tag "thing"/,
  );
  assert.match(
    blocking(
      custom([
        { tags: ["referent"], abstractor: null, relation_arity: null },
        { tags: ["referent"], abstractor: null, relation_arity: null },
      ]),
    ).join("\n"),
    /same alternative twice/,
  );
  // P6: an empty word link.
  assert.match(
    blocking(newDraft({ ...base, text: "see [[ ]]" })).join("\n"),
    /word link without a spelling/,
  );
  // P7: formation rows need a BCP 47 language and bounded weights.
  const formation = draftToBody(
    newDraft({
      ...base,
      formation: {
        method: "non-algorithmic",
        algorithm: null,
        sources: [
          {
            language: "English",
            word: "big",
            input: null,
            weight: { numerator: 1e12, denominator: 1 } as never,
            notes: [],
          },
        ],
        weights_profile: null,
        generated: null,
        selected_score: null,
        selected_rank: null,
        selection_reason: [],
        candidates: [],
        conflicts: [],
      },
      evidenceForm: "broda",
    }),
  )
    .problems.filter((pr) => pr.blocking)
    .map((pr) => pr.message)
    .join("\n");
  assert.match(formation, /language "English"/);
  assert.match(formation, /weight outside/);
  // P11: the node budget covers every field.
  const long = Array.from({ length: 3000 }, () => "[[cukta]]").join(" ");
  assert.match(
    blocking(
      newDraft({
        ...base,
        frameMode: "fixed",
        places: [
          { ...newPlace(1), description: long },
          { ...newPlace(2), description: long },
          { ...newPlace(3), description: long },
        ],
      }),
    ).join("\n"),
    /rich text nodes across every field/,
  );
  // P12: an explicit fixed frame with zero places is not a guessed structure.
  assert.deepEqual(
    blocking(
      newDraft({
        ...base,
        frameMode: "fixed",
        fixedZeroApproved: true,
        places: [],
      }),
    ),
    [],
  );
  // Evidence for another form blocks publication.
  assert.match(
    blocking(
      newDraft({
        ...base,
        spelling: "brode",
        compound: {
          components: [],
          morphology: { id: "x", version: "1" },
          scoring: { id: "x", version: "1" },
          score: null,
          notes: [],
        },
        evidenceForm: "broda",
      }),
    ).join("\n"),
    /describes "broda", not "brode"/,
  );
  // The core has the final word on a body the editor checks pass.
  const operandRef = newDraft({
    ...base,
    text: "see {operand y}",
    operands: [
      {
        id: "x",
        category: "sumti",
        description: "",
        minimum: 0,
        maximum: null,
      },
    ],
  });
  assert.match(
    blocking(operandRef).join("\n"),
    /operand "y", which is not declared/,
  );
});

test("Revise keeps every core-valid parent value exactly when the field is not edited", () => {
  const parentId = "jve1:" + "c".repeat(64);
  const cases: { name: string; text: unknown }[] = [
    {
      name: "code with paragraph break",
      text: [[{ code: "first\n\nsecond" }]],
    },
    { name: "literal with paragraph break", text: [["first\n\nsecond"]] },
    { name: "trailing literal spaces", text: [["text  "]] },
    { name: "empty code", text: [[{ code: "" }]] },
    {
      name: "link with an empty label",
      text: [[{ url: "https://example.org/x", label: "" }]],
    },
    {
      name: "word link with an empty label",
      text: [[{ word: { language: "jbo", spelling: "cukta" }, label: "" }]],
    },
  ];
  for (const c of cases) {
    const parent = {
      ...draftToBody(
        newDraft({
          spelling: "broda",
          kind: "gismu",
          text: "x",
          structured: false,
        }),
      ).body!,
      text: c.text,
      glosses: [{ language: "en", text: "  spaced  ", sense: " s " }],
      sources: [{ label: " label ", url: null, event: null, locator: " loc " }],
    } as never;
    assert.ok(admissible(parent), `${c.name}: the parent must be admissible`);
    const draft = draftFromBody(parent, parentId, "native");
    const { body, problems } = draftToBody(draft);
    assert.deepEqual(
      problems.filter((pr) => pr.blocking),
      [],
      c.name,
    );
    assert.deepEqual(body!.text, c.text, c.name);
    assert.deepEqual(
      body!.glosses,
      (parent as { glosses: unknown }).glosses,
      c.name,
    );
    assert.deepEqual(
      body!.sources,
      (parent as { sources: unknown }).sources,
      c.name,
    );
    assert.ok(admissible(body, [parentId]), c.name);
    // An edited field goes through the editor. The others still keep the parent's values.
    draft.notes = editorToRichText("edited", true);
    const edited = draftToBody(draft).body!;
    assert.deepEqual(edited.text, c.text, c.name);
    assert.deepEqual(edited.notes, [["edited"]]);
  }
});

test("place rewrites touch only place nodes and cover type notes, and a frame constraint reference is a named problem", () => {
  const draft = newDraft({
    spelling: "broda",
    kind: "gismu",
    frameMode: "fixed",
    text: "① then ② then ③ with `code ②` and [[https://e.org/②|label ②]] and \\② kept",
    notes: "notes ③",
    frameConstraints: ["frame ③"],
    places: [
      newPlace(1),
      {
        ...newPlace(2),
        description: "second ③",
        constraints: ["only ③"],
        defaults: [
          {
            kind: "suggested",
            format: "lojban",
            language: "",
            text: "x",
            condition: "when ③",
            explanation: "see ③",
          },
        ],
      },
      {
        ...newPlace(3),
        description: "third",
        kind: "custom",
        hint: {
          alternatives: [
            { tags: ["referent"], abstractor: null, relation_arity: null },
          ],
          note: [["note ", 3]],
        },
      },
    ],
    operands: [
      {
        id: "x",
        category: "sumti",
        description: "operand ③",
        minimum: 0,
        maximum: null,
      },
    ],
    numberingApproved: true,
  });
  // Remove place 2: references to 2 become literal, references to 3 now name place 2.
  draft.places.splice(1, 1);
  rewriteReferences(draft, (n) => (n === 2 ? "literal" : n > 2 ? n - 1 : n));
  draft.places = draft.places.map((pl, i) => ({ ...pl, index: i + 1 }));
  assert.equal(
    editorText(draft.text, true),
    "① then \\② then ② with `code ②` and [[https://e.org/②|label ②]] and \\② kept",
  );
  assert.equal(editorText(draft.notes, true), "notes ②");
  assert.equal(editorText(draft.frameConstraints[0], true), "frame ②");
  assert.equal(editorText(draft.operands[0].description, true), "operand ②");
  assert.deepEqual(draft.places[1].hint!.note, [["note ", 2]]);
  const { body, problems } = draftToBody(draft);
  assert.deepEqual(
    problems.filter((pr) => pr.blocking),
    [],
  );
  assert.deepEqual(body!.text[0], [
    1,
    " then ② then ",
    2,
    " with ",
    { code: "code ②" },
    " and ",
    { url: "https://e.org/②", label: "label ②" },
    " and ② kept",
  ]);
  // P1 as reported: a reference in a frame constraint with only place 1 declared.
  const frameRef = newDraft({
    spelling: "broda",
    kind: "gismu",
    text: "x",
    frameMode: "fixed",
    places: [newPlace(1)],
    frameConstraints: ["only ②"],
    numberingApproved: true,
  });
  assert.match(
    draftToBody(frameRef)
      .problems.filter((pr) => pr.blocking)
      .map((pr) => pr.message)
      .join("\n"),
    /Place 2 is referenced in frame constraint 1 but not declared/,
  );
});

test("a core-only rule reaches the author as a blocking problem with the core's reason", () => {
  const draft = newDraft({
    spelling: "broda",
    kind: "gismu",
    text: "fine",
    evidenceForm: "broda",
    formation: {
      method: "non-algorithmic",
      algorithm: null,
      sources: [
        {
          language: "en",
          word: "big",
          input: null,
          weight: { numerator: 2, denominator: 4 } as never,
          notes: [],
        },
      ],
      weights_profile: null,
      generated: null,
      selected_score: null,
      selected_rank: null,
      selection_reason: [],
      candidates: [],
      conflicts: [],
    },
  });
  const messages = draftToBody(draft)
    .problems.filter((pr) => pr.blocking)
    .map((pr) => pr.message);
  assert.deepEqual(messages, [
    "The format rules reject the body: schema: rational must use lowest terms.",
  ]);
});

test("the place and minimum bounds hold at 256 and fail at 257, and morphology notes follow retained etymology", () => {
  const places = (n: number) =>
    Array.from({ length: n }, (_, i) => newPlace(i + 1));
  const at = newDraft({
    spelling: "broda",
    kind: "gismu",
    text: "x",
    frameMode: "variadic",
    variadicMinimum: 256,
    places: places(256),
    tail: { description: "more", kind: "object", hint: null },
  });
  assert.deepEqual(
    draftToBody(at).problems.filter((pr) => pr.blocking),
    [],
  );
  const over = newDraft({ ...at, variadicMinimum: 257, places: places(257) });
  const messages = draftToBody(over)
    .problems.filter((pr) => pr.blocking)
    .map((pr) => pr.message)
    .join("\n");
  assert.match(messages, /at most 256 places/);
  assert.match(messages, /minimum number of places is at most 256/);
  const parent = {
    ...draftToBody(
      newDraft({
        spelling: "broda",
        kind: "gismu",
        text: "x",
        structured: false,
      }),
    ).body!,
    etymology: {
      text: [["from ", { url: "https://e.org", label: "e" }]],
      formation: null,
      compound: null,
    },
  } as never;
  const draft = draftFromBody(parent, "jve1:" + "d".repeat(64), "native");
  draft.formNotes = "my note";
  assert.deepEqual(draftToBody(draft).body!.etymology.text, [
    ["from ", { url: "https://e.org", label: "e" }],
    ["my note"],
  ]);
});

test("validation reads the final values, an edit changes only its own control, and the mode governs references", () => {
  const base = draftToBody(
    newDraft({
      spelling: "broda",
      kind: "gismu",
      text: "x",
      structured: false,
    }),
  ).body!;
  const parentId = "jve1:" + "e".repeat(64);
  // R30: a code node holding a circled number is not a reference.
  const code = { ...base, text: [[{ code: "first\n\n①" }]] } as never;
  assert.ok(admissible(code));
  const d1 = draftFromBody(code, parentId, "native");
  d1.labels.push("changed");
  const r1 = draftToBody(d1);
  assert.deepEqual(
    r1.problems.filter((pr) => pr.blocking),
    [],
  );
  assert.deepEqual(r1.body!.text, [[{ code: "first\n\n①" }]]);
  // R31: a gloss edit keeps the place description, and a form note follows the exact etymology.
  const richPlace = {
    ...base,
    text: [[1, " is something."]],
    frame: {
      role: "predicate",
      arity: { mode: "fixed", count: 1 },
      places: [
        {
          index: 1,
          description: [[{ code: "first\n\nsecond" }]],
          glosses: [],
          type_hints: [],
          derivation: [],
          defaults: [
            {
              kind: "suggested",
              value: { format: "lojban", text: "x" },
              condition: [[{ code: "c\n\nd" }]],
              explanation: [],
            },
          ],
          constraints: [[[{ code: "k\n\nl" }]]],
        },
      ],
      tail: null,
      constraints: [],
    },
    etymology: {
      text: [[{ code: "e\n\nf" }]],
      formation: null,
      compound: null,
    },
  } as never;
  assert.ok(admissible(richPlace));
  const d2 = draftFromBody(richPlace, parentId, "native");
  d2.places[0].glosses.push({ language: "en", text: "something", sense: "" });
  d2.formNotes = "Added note";
  const r2 = draftToBody(d2).body!;
  assert.deepEqual(r2.frame!.places[0].description, [
    [{ code: "first\n\nsecond" }],
  ]);
  assert.deepEqual(r2.frame!.places[0].defaults[0].condition, [
    [{ code: "c\n\nd" }],
  ]);
  assert.deepEqual(r2.frame!.places[0].constraints, [[[{ code: "k\n\nl" }]]]);
  assert.deepEqual(r2.frame!.places[0].glosses, [
    { language: "en", text: "something", sense: null },
  ]);
  assert.deepEqual(r2.etymology.text, [[{ code: "e\n\nf" }], ["Added note"]]);
  // R32: the mode governs references, through the switch and through the flag.
  const d3 = draftFromBody(
    {
      ...(richPlace as object),
      frame: {
        ...(richPlace as unknown as { frame: Record<string, unknown> }).frame,
        places: [
          {
            index: 1,
            description: [["something"]],
            glosses: [],
            type_hints: [],
            derivation: [],
            defaults: [],
            constraints: [],
          },
        ],
      },
    } as never,
    parentId,
    "native",
  );
  switchMode(d3, false);
  assert.deepEqual(d3.text, [["① is something."]]);
  assert.deepEqual(draftToBody(d3).body!.text, [["① is something."]]);
  switchMode(d3, true);
  assert.deepEqual(d3.text, [[1, " is something."]]);
  d3.structured = false;
  assert.deepEqual(draftToBody(d3).body!.text, [["① is something."]]);
  // R33: an identity remap leaves rich type notes exact, for a place and the repeated places.
  const d4 = newDraft({
    spelling: "broda",
    kind: "gismu",
    text: "①",
    frameMode: "variadic",
    variadicMinimum: 1,
    places: [
      {
        ...newPlace(1),
        kind: "custom",
        hint: {
          alternatives: [
            { tags: ["referent"], abstractor: null, relation_arity: null },
          ],
          note: [[{ code: "first\n\nsecond" }]],
        },
      },
    ],
    tail: {
      description: "more",
      kind: "custom",
      hint: {
        alternatives: [
          { tags: ["set"], abstractor: null, relation_arity: null },
        ],
        note: [["tail ", { code: "t\n\nu" }]],
      },
    },
    numberingApproved: true,
  });
  const before = JSON.stringify(draftToBody(d4).body);
  rewriteReferences(d4, (n) => n);
  assert.equal(JSON.stringify(draftToBody(d4).body), before);
  assert.deepEqual(d4.places[0].hint!.note, [[{ code: "first\n\nsecond" }]]);
  assert.deepEqual(d4.tail!.hint!.note, [["tail ", { code: "t\n\nu" }]]);
});

test("a rewrite covers defaults, the repeated places' note, and leaves examples and derivation explanations untouched", () => {
  const draft = newDraft({
    spelling: "broda",
    kind: "gismu",
    text: "① then ② then ③",
    frameMode: "variadic",
    variadicMinimum: 1,
    places: [
      {
        ...newPlace(1),
        constraints: ["only ③"],
        defaults: [
          {
            kind: "suggested",
            format: "lojban",
            language: "",
            text: "x",
            condition: "when ③",
            explanation: "see ③ and `③`",
          },
        ],
        derivations: [
          {
            word: "sinxa",
            definition: null,
            place: 1,
            explanation: [["literal ③ stays"]],
          },
        ],
      },
      newPlace(2),
      newPlace(3),
    ],
    tail: {
      description: "more ③",
      kind: "custom",
      hint: {
        alternatives: [
          { tags: ["set"], abstractor: null, relation_arity: null },
        ],
        note: [["note ", 3, " and `③`"]],
      },
    },
    examples: [
      {
        language: "jbo",
        text: "mi broda",
        translation: [["literal ③"]],
        notes: "",
      },
    ],
    numberingApproved: true,
  });
  draft.places.splice(1, 1);
  rewriteReferences(draft, (n) => (n === 2 ? "literal" : n > 2 ? n - 1 : n));
  draft.places = draft.places.map((pl, i) => ({ ...pl, index: i + 1 }));
  assert.deepEqual(draft.text, [[1, " then ② then ", 2]]);
  assert.deepEqual(draft.places[0].constraints, [[["only ", 2]]]);
  assert.deepEqual(draft.places[0].defaults[0].condition, [["when ", 2]]);
  assert.deepEqual(draft.places[0].defaults[0].explanation, [
    ["see ", 2, " and ", { code: "③" }],
  ]);
  assert.deepEqual(draft.places[0].derivations[0].explanation, [
    ["literal ③ stays"],
  ]);
  assert.deepEqual(draft.tail!.description, [["more ", 2]]);
  assert.deepEqual(draft.tail!.hint!.note, [["note ", 2, " and `③`"]]);
  assert.deepEqual(draft.examples[0].translation, [["literal ③"]]);
  assert.deepEqual(
    draftToBody(draft).problems.filter((pr) => pr.blocking),
    [],
  );
});

test("a revision of an imported parent that already carries the rights reference keeps it once and every other source exact", () => {
  const base = draftToBody(
    newDraft({
      spelling: "ckusro",
      kind: "lujvo",
      text: "x",
      structured: false,
    }),
  ).body!;
  const parent = {
    ...base,
    sources: [
      {
        label: " other ",
        url: "https://example.org/o",
        event: null,
        locator: " p ",
      },
      { ...LENSISKU_RIGHTS_REFERENCE },
    ],
    license: {
      expression: "unknown",
      url: null,
      attribution: "Lensisku source author unknown",
    },
    legacy: { source: "https://lensisku.invalid" },
  } as never;
  const parentId = "jve1:" + "f".repeat(64);
  const draft = draftFromBody(parent, parentId, "import");
  const { body } = draftToBody(draft);
  assert.equal(
    body!.sources.filter((s) => s.url === LENSISKU_RIGHTS_REFERENCE.url).length,
    1,
  );
  assert.deepEqual(body!.sources[0], {
    label: "Imported publication revised by this definition",
    url: null,
    event: parentId,
    locator: null,
  });
  assert.deepEqual(body!.sources[1], {
    label: " other ",
    url: "https://example.org/o",
    event: null,
    locator: " p ",
  });
  assert.deepEqual(body!.sources[2], LENSISKU_RIGHTS_REFERENCE);
});

test("a place above 20 keeps one literal form through removal and mode changes", () => {
  const draft = newDraft({
    spelling: "broda",
    kind: "gismu",
    text: "{place 21} and ① with `{place 21}` and [[cukta|{place 21}]]",
    frameMode: "context",
    places: [newPlace(1), newPlace(21)],
    numberingApproved: true,
  });
  assert.deepEqual(draft.text, [
    [
      21,
      " and ",
      1,
      " with ",
      { code: "{place 21}" },
      " and ",
      { word: { language: "jbo", spelling: "cukta" }, label: "{place 21}" },
    ],
  ]);
  // Literal mode: the reference becomes the explicit notation as text, and the editor escapes it.
  switchMode(draft, false);
  assert.deepEqual(draft.text, [
    [
      "{place 21} and ① with ",
      { code: "{place 21}" },
      " and ",
      { word: { language: "jbo", spelling: "cukta" }, label: "{place 21}" },
    ],
  ]);
  assert.equal(
    editorText(draft.text, false),
    "{place 21} and ① with {place 21} and {place 21}",
  );
  // Structured mode reads the notation back as a reference.
  switchMode(draft, true);
  assert.deepEqual(draft.text[0][0], 21);
  assert.equal(
    editorText(draft.text, true),
    "{place 21} and ① with `{place 21}` and [[cukta|{place 21}]]",
  );
  // Removal of place 21 makes its reference literal in the same form.
  draft.places.splice(1, 1);
  rewriteReferences(draft, (n) => (n === 21 ? "literal" : n));
  assert.deepEqual(draft.text[0].slice(0, 3), ["{place 21} and ", 1, " with "]);
  assert.equal(
    editorText(draft.text, true),
    "\\{place 21} and ① with `{place 21}` and [[cukta|{place 21}]]",
  );
  assert.deepEqual(
    editorToRichText(editorText(draft.text, true), true),
    draft.text,
  );
});

test("context gaps and an explicit zero-place fixed frame survive revision", () => {
  for (const patch of [
    {
      frameMode: "context" as const,
      places: [newPlace(5), newPlace(2)],
      text: "② and ⑤",
    },
    {
      frameMode: "fixed" as const,
      fixedZeroApproved: true,
      places: [],
      text: "no places",
    },
  ]) {
    const draft = newDraft({
      spelling: "broda",
      kind: "gismu",
      numberingApproved: true,
      ...patch,
    });
    const { body, problems } = draftToBody(draft);
    assert.deepEqual(
      problems.filter((p) => p.blocking),
      [],
    );
    assert.ok(admissible(body));
    assert.deepEqual(
      body!.frame!.places.map((p) => p.index),
      patch.places.map((p) => p.index).sort((a, b) => a - b),
    );
    const revised = draftFromBody(body!, "jve1:" + "a".repeat(64), "native");
    assert.deepEqual(
      draftToBody(revised).problems.filter((p) => p.blocking),
      [],
    );
    assert.deepEqual(draftToBody(revised).body!.frame, body!.frame);
  }
  assert.equal(
    draftToBody(newDraft({ spelling: "broda", kind: "gismu", text: "plain" }))
      .body!.frame,
    null,
  );
});

test("a zero-place fixed frame needs an explicit author choice", () => {
  const draft = newDraft({
    spelling: "broda",
    kind: "gismu",
    text: "plain",
    frameMode: "fixed",
    places: [newPlace(1)],
  });
  draft.places.pop();
  assert.ok(
    draftToBody(draft).problems.some(
      (problem) =>
        problem.blocking && /explicit.*zero-place/.test(problem.message),
    ),
  );
  draft.fixedZeroApproved = true;
  const built = draftToBody(draft);
  assert.deepEqual(
    built.problems.filter((problem) => problem.blocking),
    [],
  );
  const revised = draftFromBody(
    built.body!,
    "jve1:" + "a".repeat(64),
    "native",
  );
  assert.equal(revised.fixedZeroApproved, true);
  assert.deepEqual(
    draftToBody(revised).problems.filter((problem) => problem.blocking),
    [],
  );
});

test("converting one invalid rich field keeps every other field and definition reference", () => {
  const draft = newDraft({
    spelling: "broda",
    kind: "gismu",
    text: [[1, " gives ", 2]],
    frameMode: "fixed",
    places: [newPlace(1), newPlace(2)],
    numberingApproved: true,
    etymologyText: [["from ", 1]],
    examples: [
      { language: "jbo", text: "broda", translation: [[2]], notes: [[1]] },
    ],
  });
  const problems = draftToBody(draft).problems;
  const etymology = problems.find((problem) =>
    /etymology cannot refer/.test(problem.message),
  )!;
  assert.ok(etymology.richFieldKey);
  rewriteReferences(draft, () => "literal", true, [etymology.richFieldKey]);
  assert.deepEqual(draft.etymologyText, [["from ①"]]);
  assert.deepEqual(draft.text, [[1, " gives ", 2]]);
  assert.deepEqual(draft.examples[0].translation, [[2]]);
  assert.deepEqual(draft.examples[0].notes, [[1]]);
  const remaining = draftToBody(draft).problems;
  assert.equal(
    remaining.some((problem) => /etymology cannot refer/.test(problem.message)),
    false,
  );
  assert.equal(remaining.filter((problem) => problem.richFieldKey).length, 2);
  assert.equal(
    new Set(remaining.map((problem) => problem.richFieldKey)).size,
    2,
  );
});

test("undeclared references name their exact rich fields for conversion", () => {
  const draft = newDraft({
    spelling: "broda",
    kind: "gismu",
    text: [[1]],
    notes: [[2]],
    frameMode: "fixed",
    places: [newPlace(1)],
    numberingApproved: true,
    frameConstraints: [[], [[2]]],
  });
  const problems = draftToBody(draft).problems.filter((problem) =>
    /not declared/.test(problem.message),
  );
  assert.equal(problems.length, 2);
  for (const problem of problems) {
    assert.ok(problem.richFieldKey);
    rewriteReferences(draft, () => "literal", true, [problem.richFieldKey]);
  }
  assert.deepEqual(draft.text, [[1]]);
  assert.deepEqual(draft.notes, [["②"]]);
  assert.deepEqual(draft.frameConstraints, [[], [["②"]]]);
  assert.deepEqual(draftToBody(draft).problems, []);
});

test("every rich-reference problem selects its own current field after empty rows", () => {
  const draft = newDraft({
    spelling: "broda",
    kind: "gismu",
    text: [[1]],
    notes: [[2]],
    frameMode: "variadic",
    variadicMinimum: 1,
    places: [
      {
        ...newPlace(1),
        description: [[2]],
        kind: "custom",
        hint: {
          alternatives: [
            { tags: ["referent"], abstractor: null, relation_arity: null },
          ],
          note: [[2]],
        },
        constraints: [[], [[2]]],
        defaults: [
          {
            kind: "suggested",
            format: "lojban",
            language: "",
            text: "x",
            condition: [[2]],
            explanation: [[2]],
          },
        ],
        derivations: [
          { word: "sinxa", definition: null, place: 1, explanation: [[2]] },
        ],
      },
    ],
    tail: {
      kind: "custom",
      description: [[2]],
      hint: {
        alternatives: [
          { tags: ["referent"], abstractor: null, relation_arity: null },
        ],
        note: [[2]],
      },
    },
    frameConstraints: [[], [[2]]],
    etymologyText: [[2]],
    examples: [
      { language: "jbo", text: "", translation: [], notes: [] },
      { language: "jbo", text: "broda", translation: [[2]], notes: [[2]] },
    ],
    operands: [
      {
        id: "x",
        category: "sumti",
        minimum: 0,
        maximum: 1,
        description: [[2]],
      },
    ],
    numberingApproved: true,
  });
  const problems = draftToBody(draft).problems;
  assert.equal(problems.length, 14);
  assert.equal(
    new Set(problems.map((problem) => problem.richFieldKey)).size,
    14,
  );
  for (const problem of problems) {
    assert.ok(problem.richFieldKey);
    const fields = referenceFields(draft, true);
    const before = fields.map((field) => structuredClone(field.get()));
    rewriteReferences(draft, () => "literal", true, [problem.richFieldKey]);
    fields.forEach((field, index) => {
      assert.deepEqual(
        field.get(),
        field.key === problem.richFieldKey ? [["②"]] : before[index],
      );
    });
  }
  assert.deepEqual(draft.text, [[1]]);
  assert.deepEqual(draftToBody(draft).problems, []);
});

test("literal edits keep backslashes before place notation when references return", () => {
  for (const [literal, expected] of [
    ["path C:\\①", [["path C:\\", 1]]],
    ["see \\{place 21} end", [["see \\", 21, " end"]]],
    ["C:\\temp", [["C:\\temp"]]],
  ] as const) {
    const draft = newDraft({ spelling: "broda", kind: "gismu", text: "note" });
    switchMode(draft, false);
    draft.text = editorToRichText(literal, false);
    switchMode(draft, true);
    assert.deepEqual(draft.text, expected);
    switchMode(draft, false);
    assert.equal(editorText(draft.text, false), literal);
  }
});

test("renumbering updates literal snapshots while their fields contain an edit", () => {
  const draft = newDraft({
    spelling: "broda",
    kind: "gismu",
    text: [[1, " gives ", 2, " to ", 3]],
    frameMode: "fixed",
    places: [newPlace(1), newPlace(2), newPlace(3), newPlace(4)],
  });
  switchMode(draft, false);
  const fieldKey = referenceFields(draft).find(
    (field) => field.label === "the definition",
  )!.key!;
  draft.text = editorToRichText("① gives ② to ③ edited", false);
  draft.places.shift();
  rewriteReferences(draft, (n) => (n === 1 ? "literal" : n - 1));
  draft.places.forEach((place, index) => {
    place.index = index + 1;
  });
  assert.deepEqual(draft.literalModeRestore![fieldKey].structured, [
    ["① gives ", 1, " to ", 2],
  ]);
  assert.deepEqual(draft.literalModeRestore![fieldKey].literal, [
    ["① gives ① to ②"],
  ]);
  draft.text = editorToRichText("① gives ① to ②", false);
  switchMode(draft, true);
  assert.deepEqual(draft.text, [["① gives ", 1, " to ", 2]]);
});

test("an undone literal edit keeps removed and renumbered references after reload", () => {
  let draft = newDraft({
    spelling: "broda",
    kind: "gismu",
    text: [[1, " gives ", 2, " to ", 3]],
    frameMode: "fixed",
    places: [newPlace(1), newPlace(2), newPlace(3), newPlace(4)],
  });
  switchMode(draft, false);
  draft.text = editorToRichText("① gives ② to ③ edited", false);
  draft.places.shift();
  rewriteReferences(draft, (n) => (n === 1 ? "literal" : n - 1));
  draft.places.forEach((place, index) => {
    place.index = index + 1;
  });
  draft = normalizeDraft(JSON.parse(JSON.stringify(draft)));
  draft.text = editorToRichText("① gives ② to ③", false);
  switchMode(draft, true);
  assert.deepEqual(draft.text, [["① gives ", 1, " to ", 2]]);
  assert.equal(draft.numberingApproved, false);
  draft.numberingApproved = true;
  const built = draftToBody(draft);
  assert.deepEqual(built.problems, []);
  assert.deepEqual(built.body!.text, [["① gives ", 1, " to ", 2]]);
  assert.equal("literalModeRestore" in built.body!, false);
});

test("numbering meaning placeholders preserves all other literal characters", () => {
  const meaning =
    "___ is C:\\temp `x` [[cukta]] {place 5} {operand x} ② of ___";
  const proposal = numberPlaceholders(meaning);
  assert.deepEqual(editorToRichText(proposal.text, true), [
    [1, " is C:\\temp `x` [[cukta]] {place 5} {operand x} ② of ", 2],
  ]);
});

test("structured text keeps ordinary and trailing backslashes", () => {
  const slash = String.fromCharCode(92);
  const text = `Use C:${slash}temp and x${slash}y and ${slash}`;
  assert.deepEqual(editorToRichText(text, true), [[text]]);
  assert.deepEqual(
    editorToRichText(
      `${slash}① ${slash}{place 2} ${slash}\`x${slash}\` ${slash}[x ${slash}${slash}`,
      true,
    ),
    [[`① {place 2} \`x\` [x ${slash}`]],
  );
});

test("a removed reference stays literal after mode changes and a saved draft reload", () => {
  let draft = newDraft({
    spelling: "broda",
    kind: "gismu",
    text: "① gives ② to ③",
    frameMode: "fixed",
    places: [newPlace(1), newPlace(2), newPlace(3)],
    numberingApproved: true,
  });
  draft.places.splice(1, 1);
  rewriteReferences(draft, (n) => (n === 2 ? "literal" : n > 2 ? n - 1 : n));
  draft.places[1].index = 2;
  switchMode(draft, false);
  assert.equal(draft.numberingApproved, false);
  draft = normalizeDraft(JSON.parse(JSON.stringify(draft)))!;
  switchMode(draft, true);
  assert.deepEqual(draft.text, [[1, " gives ② to ", 2]]);
  assert.equal(draft.numberingApproved, false);
  draft.numberingApproved = true;
  assert.deepEqual(draftToBody(draft).body!.text, [[1, " gives ② to ", 2]]);
});

test("literal conversion covers invalid references in all nonlocal fields", () => {
  const draft = newDraft({
    spelling: "broda",
    kind: "gismu",
    text: "plain",
    etymologyText: [["from ", 1]],
    examples: [
      { language: "jbo", text: "broda", translation: [[2]], notes: [[3]] },
    ],
    frameMode: "fixed",
    places: [
      {
        ...newPlace(1),
        derivations: [
          { word: "sinxa", definition: null, place: 1, explanation: [[4]] },
        ],
      },
    ],
  });
  switchMode(draft, false);
  assert.deepEqual(draft.etymologyText, [["from ①"]]);
  assert.deepEqual(draft.examples[0].translation, [["②"]]);
  assert.deepEqual(draft.examples[0].notes, [["③"]]);
  assert.deepEqual(draft.places[0].derivations[0].explanation, [["④"]]);
  assert.deepEqual(
    draftToBody(draft).problems.filter((p) => p.blocking),
    [],
  );
  switchMode(draft, true);
  assert.deepEqual(draft.etymologyText, [["from ①"]]);
});

test("an incomplete derivation never invents source place one in the preview", () => {
  for (const sourcePlace of [null, 0, 1.5, 65536]) {
    const draft = newDraft({
      spelling: "broda",
      kind: "gismu",
      text: "plain",
      frameMode: "fixed",
      places: [
        {
          ...newPlace(1),
          derivations: [
            {
              word: "sinxa",
              definition: null,
              place: sourcePlace,
              explanation: [],
            },
          ],
        },
      ],
    });
    const built = draftToBody(draft);
    assert.ok(
      built.problems.some(
        (p) => p.blocking && /source place number/.test(p.message),
      ),
    );
    assert.deepEqual(built.body!.frame!.places[0].derivation, []);
  }
});

test("literal-mode removal keeps stable field ownership when literal values match", () => {
  const draft = newDraft({
    spelling: "broda",
    kind: "gismu",
    text: "① gives ② to ③",
    frameMode: "fixed",
    places: [
      {
        ...newPlace(1),
        description: [[2]],
        constraints: [[[3]]],
        kind: "custom",
        hint: {
          alternatives: [
            { tags: ["referent"], abstractor: null, relation_arity: null },
          ],
          note: [[3]],
        },
      },
      newPlace(2),
      { ...newPlace(3), description: [["②"]] },
    ],
    numberingApproved: true,
  });
  switchMode(draft, false);
  draft.places.splice(1, 1);
  rewriteReferences(draft, (n) => (n === 2 ? "literal" : n > 2 ? n - 1 : n));
  draft.places = draft.places.map((p, i) => ({ ...p, index: i + 1 }));
  switchMode(draft, true);
  assert.deepEqual(draft.text, [[1, " gives ② to ", 2]]);
  assert.deepEqual(draft.places[0].description, [["②"]]);
  assert.deepEqual(draft.places[1].description, [["②"]]);
  assert.deepEqual(draft.places[0].hint!.note, [[2]]);
  draft.numberingApproved = true;
  assert.ok(admissible(draftToBody(draft).body));
});

test("glosses without a stored language bind when the draft loads", () => {
  const draft = newDraft({
    spelling: "broda",
    kind: "gismu",
    language: "en",
    text: "plain",
    frameMode: "fixed",
    places: [
      { ...newPlace(1), glosses: [{ language: "", text: "dog", sense: "" }] },
    ],
    glosses: [{ language: "", text: "canine", sense: "" }],
  });
  draft.language = "fr";
  assert.equal(draftToBody(draft).body!.glosses[0].language, "en");
  assert.equal(
    draftToBody(draft).body!.frame!.places[0].glosses[0].language,
    "en",
  );
});

test("literal-mode moves keep distinct owners with identical visible descriptions", () => {
  const draft = newDraft({
    spelling: "broda",
    kind: "gismu",
    text: "① sees ②",
    frameMode: "fixed",
    places: [
      { ...newPlace(1), description: [[2]] },
      { ...newPlace(2), description: [["②"]] },
    ],
  });
  switchMode(draft, false);
  rewriteReferences(draft, (n) => (n === 1 ? 2 : 1));
  draft.places.reverse();
  draft.places.forEach((p, i) => {
    p.index = i + 1;
  });
  const loaded = normalizeDraft(JSON.parse(JSON.stringify(draft)));
  switchMode(loaded, true);
  assert.deepEqual(loaded.places[0].description, [["②"]]);
  assert.deepEqual(loaded.places[1].description, [[1]]);
});

test("structured code and link labels keep ordinary backslashes", () => {
  const slash = String.fromCharCode(92);
  assert.deepEqual(
    editorToRichText(`\`C:${slash}temp\` [[cukta|x${slash}y]]`, true),
    [
      [
        { code: `C:${slash}temp` },
        " ",
        { word: { language: "jbo", spelling: "cukta" }, label: `x${slash}y` },
      ],
    ],
  );
});

for (const change of ["move", "remove"]) {
  test(`typing the old literal text after a place ${change} keeps the new reading`, () => {
    const draft = newDraft({
      spelling: "broda",
      kind: "gismu",
      text: [[1, " gives ", 2, " to ", 3]],
      frameMode: "fixed",
      places: [newPlace(1), newPlace(2), newPlace(3)],
    });
    switchMode(draft, false);
    if (change === "move") {
      rewriteReferences(draft, (n) => (n === 1 ? 2 : n === 2 ? 1 : n));
      [draft.places[0], draft.places[1]] = [draft.places[1], draft.places[0]];
    } else {
      draft.places.shift();
      rewriteReferences(draft, (n) => (n === 1 ? "literal" : n - 1));
    }
    draft.places.forEach((place, index) => {
      place.index = index + 1;
    });
    assert.notEqual(editorText(draft.text, false), "① gives ② to ③");
    draft.text = editorToRichText("① gives ② to ③", false);
    switchMode(draft, true);
    assert.deepEqual(draft.text, [[1, " gives ", 2, " to ", 3]]);
    assert.equal(draft.numberingApproved, false);
  });
}

test("browser source aliases migrate once with null precedence and independent signed evidence", () => {
  const old = {
    language: "en",
    name: "English",
    word: "running",
    input: "",
    weight: null,
    wordIpa: "old word",
    stemIpa: "old stem",
    stem: "run",
  };
  const draft = normalizeDraft(
    newDraft({
      gismu: {
        ...newGismuState(),
        rows: [
          old,
          { ...old, word_ipa: null, ipa: "new stem" },
          {
            language: "fr",
            name: "French",
            word: "",
            input: "",
            weight: null,
            notes: [["Word IPA: never infer this"]],
          },
        ],
      },
    }),
  );
  assert.equal(typeof draft.gismu!.rows[0].id, "string");
  assert.deepEqual(draft.gismu!.rows[0], {
    id: draft.gismu!.rows[0].id,
    language: "en",
    name: "English",
    word: "running",
    input: "",
    weight: null,
    word_ipa: "old word",
    ipa: "old stem",
    stem: "run",
  });
  assert.equal(draft.gismu!.rows[1].word_ipa, null);
  assert.equal(draft.gismu!.rows[1].ipa, "new stem");
  assert.equal(Object.hasOwn(draft.gismu!.rows[2], "word_ipa"), false);
  draft.gismu!.rows[0].word_ipa = "edited word";
  Object.assign(draft.gismu!.rows[0], { ipa: null });
  const source = sourceCurrent(draft, 0).formation!.sources[0];
  assert.equal(source.word_ipa, "edited word");
  assert.equal(Object.hasOwn(source, "ipa"), false);
  assert.equal(source.stem, "run");
  for (const field of ["word_ipa", "stem", "ipa"] as const) {
    const row = {
      language: "en",
      name: "English",
      word: "",
      input: "",
      weight: null,
      [field]: "evidence",
    };
    const source = manualFormation([row], "")!.sources[0];
    assert.equal(source[field], "evidence");
    assert.equal(source.input, null);
    for (const other of ["word_ipa", "stem", "ipa"] as const)
      if (other !== field) assert.equal(Object.hasOwn(source, other), false);
  }
  const blank = formationSource({ ...old, word_ipa: "", ipa: "" });
  assert.equal(Object.hasOwn(blank, "word_ipa"), false);
  assert.equal(Object.hasOwn(blank, "ipa"), false);
  const blankEvidence = manualFormation(
    [
      {
        language: "en",
        name: "English",
        word: "",
        input: "",
        weight: null,
        word_ipa: " ",
      },
    ],
    "",
  )!;
  assert.equal(blankEvidence.sources.length, 1);
  assert.equal(Object.hasOwn(blankEvidence.sources[0], "word_ipa"), false);
});

test("accepted sources preserve signed fields and exact supplementary notes through publication and revision", () => {
  const draft = newDraft({
    kind: "gismu",
    spelling: "broda",
    text: "A source.",
    gismu: {
      ...newGismuState(),
      rows: [
        {
          language: "en",
          name: "English",
          word: "old",
          input: "old",
          weight: null,
          word_ipa: "stale",
          stem: "stale",
          ipa: "stale",
          sense: "stale",
          note: "stale",
        },
      ],
    },
  });
  const notes = [
    ["Manual evidence."],
    ["Sense: previous"],
    ["Note: previous"],
    ["Word IPA: this must never override null"],
    ["Sense:  sense line 1\n\nNote: part of the sense  "],
    ["Note:  note line 1\n\nSense: part of the note  "],
  ];
  const source = {
    language: "en",
    word: "running",
    word_ipa: null,
    ipa: "rʌn",
    input: null,
    weight: null,
    notes,
  };
  applySource(draft, 0, {
    proposals: [{ path: "/formation/sources", value: [source] }],
  } as Suggestion);
  const row = draft.gismu!.rows[0];
  assert.equal(row.word_ipa, null);
  assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(row)), "stem"), false);
  assert.equal(row.ipa, "rʌn");
  assert.equal(row.sense, " sense line 1\n\nNote: part of the sense  ");
  assert.equal(row.note, " note line 1\n\nSense: part of the note  ");
  assert.deepEqual(row.notes, notes);
  assert.deepEqual(sourceCurrent(draft, 0).formation!.sources[0].notes, notes);
  draft.formation = manualFormation(draft.gismu!.rows, "Manual evidence.");
  draft.evidenceForm = "broda";
  const restored = normalizeDraft(JSON.parse(JSON.stringify(draft)));
  const built = draftToBody(restored);
  assert.deepEqual(built.problems, []);
  assert.equal(built.body!.etymology.formation!.sources[0].ipa, "rʌn");
  assert.deepEqual(built.body!.etymology.formation!.sources[0].notes, notes);
  assert.ok(admissible(built.body));
  const parent = "jve1:" + "1".repeat(64);
  const revised = draftToBody(draftFromBody(built.body!, parent, "native"));
  assert.deepEqual(
    revised.body!.etymology.formation,
    built.body!.etymology.formation,
  );
  assert.ok(admissible(revised.body, [parent]));
  const clearedNotes = [...notes, ["Sense: "], ["Note: "]];
  applySource(draft, 0, {
    proposals: [
      {
        path: "/formation/sources",
        value: [{ ...source, notes: clearedNotes }],
      },
    ],
  } as Suggestion);
  assert.equal(draft.gismu!.rows[0].sense, "");
  assert.equal(draft.gismu!.rows[0].note, "");
  assert.deepEqual(draft.gismu!.rows[0].notes, clearedNotes);
  for (const kind of ["direct", "merged", "distributed", "functional"])
    assert.equal(mappingKind([[`${kind}: A reason.`]]), kind);
  for (const reason of [
    "Direct: A reason.",
    " direct: A reason.",
    "direct:No space",
    "direct:",
    "none: A reason.",
  ])
    assert.equal(mappingKind([[reason]]), null);
});
