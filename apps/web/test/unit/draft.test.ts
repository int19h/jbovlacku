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
} from "../../src/model/builders.ts";
import {
  draftFromBody,
  draftToBody,
  editorToRichText,
  literalize,
  newDraft,
  newPlace,
  numberPlaceholders,
  richTextToEditor,
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
  assert.equal(literalize("see {place 21} and ①"), "see (21) and ①");
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
    text: literalize(draft.text),
    structured: false,
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
      { ...newPlace(1), gloss: "first", kind: "property" },
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
  const preset = builderPresets().find((pr) => pr.id === "cll-1995")!;
  const rows = preset.languages.map((l) => ({
    language: l.language,
    name: l.name,
    word: l.language,
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
