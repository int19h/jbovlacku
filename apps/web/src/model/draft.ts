/**
 * The local definition draft. The wizard and the full editor edit the same
 * draft. Nothing here signs or sends. The draft keeps the original meaning
 * apart from the editable definition prose and preserves every structured field.
 */
import { wordId } from "../../../../packages/core/src/index.ts";
import {
  countNodes,
  referencedPlaces,
  richTextToText,
  textToRichText,
} from "./richtext.ts";
import {
  lexicalKinds,
  type Arity,
  type Compound,
  type Default,
  type DefinitionBody,
  type Example,
  type Formation,
  type LexicalKind,
  type Operand,
  type Place,
  type RichNode,
  type RichText,
  type SourceReference,
  type TypeHint,
} from "./types.ts";

export const CC0_LICENSE = {
  expression: "CC0-1.0",
  url: "https://creativecommons.org/publicdomain/zero/1.0/",
  attribution: "",
} as const;
/** The source-rights reference that a revision of imported Lensisku text copies. */
export const LENSISKU_RIGHTS_REFERENCE: SourceReference = {
  label:
    "All content is public domain. By submitting content, you agree to place it in the public domain to the fullest extent allowed by local law.",
  url: "https://github.com/lojban/lensisku/blob/d5a12821ed1e8c24ede711b63625b0782d2f6ae8/frontend/src/locales/en.json#L362",
  event: null,
  locator: "footer.publicDomainNotice",
};
/** Shortcut choices for "Kind of thing". They are not a closed schema. */
export type KindChoice =
  | "unspecified"
  | "object"
  | "event"
  | "property"
  | "number"
  | "custom";
export const kindChoices: { value: KindChoice; label: string }[] = [
  { value: "unspecified", label: "unspecified" },
  { value: "object", label: "object" },
  { value: "event", label: "event" },
  { value: "property", label: "property" },
  { value: "number", label: "number" },
  { value: "custom", label: "custom…" },
];
export function hintForChoice(choice: KindChoice): TypeHint | null {
  switch (choice) {
    case "object":
      return {
        alternatives: [
          { tags: ["entity"], abstractor: null, relation_arity: null },
        ],
        note: [],
      };
    case "event":
      return {
        alternatives: [
          { tags: ["event"], abstractor: "nu", relation_arity: null },
        ],
        note: [],
      };
    case "property":
      return {
        alternatives: [
          {
            tags: ["relation"],
            abstractor: "ka",
            relation_arity: { mode: "fixed", count: 1 },
          },
        ],
        note: [],
      };
    case "number":
      return {
        alternatives: [
          { tags: ["number"], abstractor: null, relation_arity: null },
        ],
        note: [],
      };
    default:
      return null;
  }
}
export function choiceForHint(hint: TypeHint | null): KindChoice {
  if (!hint) return "unspecified";
  for (const choice of ["object", "event", "property", "number"] as const)
    if (JSON.stringify(hintForChoice(choice)) === JSON.stringify(hint))
      return choice;
  return "custom";
}
export interface DraftDerivation {
  word: string;
  definition: string | null;
  place: number;
  explanation: string;
}
export interface DraftDefault {
  kind: "conventional" | "suggested";
  format: "lojban" | "prose";
  language: string;
  text: string;
  condition: string;
  explanation: string;
}
export interface DraftPlace {
  index: number;
  description: string;
  gloss: string;
  kind: KindChoice;
  /** Full type hint when kind is custom. */
  hint: TypeHint | null;
  from: DraftDerivation | null;
  defaults: DraftDefault[];
  constraints: string[];
}
export interface DraftExample {
  language: string;
  text: string;
  translation: string;
  notes: string;
}
import type { GismuState, LujvoState } from "./builders.ts";
export interface DraftRafsiClaim {
  rafsi: string;
  rationale: string;
}
export interface DraftOperand {
  id: string;
  category: string;
  description: string;
  minimum: number;
  maximum: number | null;
}
export type FrameMode = "none" | "fixed" | "variadic" | "context";
export interface Draft {
  version: 2;
  id: string;
  createdAt: number;
  updatedAt: number;
  step: 1 | 2 | 3 | 4 | 5;
  /** Original meaning from step 1, kept apart from the editable prose. */
  meaning: string;
  language: string;
  spelling: string;
  kind: LexicalKind | null;
  selmaho: string[];
  /** Attributed morphology notes from the manual Form step. */
  formNotes: string;
  /** Editor text. Structured mode reads circled numerals as place references. */
  text: string;
  structured: boolean;
  frameMode: FrameMode;
  variadicMinimum: number;
  places: DraftPlace[];
  tail: { description: string; kind: KindChoice; hint: TypeHint | null } | null;
  frameConstraints: string[];
  glosses: { language: string; text: string; sense: string }[];
  notes: string;
  examples: DraftExample[];
  etymologyText: string;
  formation: Formation | null;
  compound: Compound | null;
  sources: SourceReference[];
  labels: string[];
  operands: DraftOperand[];
  parents: string[];
  /** Set when the draft revises an imported publication. */
  revisedImport: { event: string; source: string } | null;
  rafsiClaims: DraftRafsiClaim[];
  /** Lujvo builder state, when the author opened the builder. */
  lujvo: LujvoState | null;
  /** Gismu generator state, when the author opened the generator. */
  gismu: GismuState | null;
  /** Fields marked for review after a type or language change. */
  review: string[];
  /** Whether the author approved the current place numbering. */
  numberingApproved: boolean;
}
export function newDraft(patch: Partial<Draft> = {}): Draft {
  const now = Date.now();
  return {
    version: 2,
    id: "current",
    createdAt: now,
    updatedAt: now,
    step: 1,
    meaning: "",
    language: "en",
    spelling: "",
    kind: null,
    selmaho: [],
    formNotes: "",
    text: "",
    structured: true,
    frameMode: "none",
    variadicMinimum: 0,
    places: [],
    tail: null,
    frameConstraints: [],
    glosses: [],
    notes: "",
    examples: [],
    etymologyText: "",
    formation: null,
    compound: null,
    sources: [],
    labels: [],
    operands: [],
    parents: [],
    revisedImport: null,
    rafsiClaims: [],
    lujvo: null,
    gismu: null,
    review: [],
    numberingApproved: false,
    ...patch,
  };
}
export function newPlace(index: number): DraftPlace {
  return {
    index,
    description: "",
    gloss: "",
    kind: "unspecified",
    hint: null,
    from: null,
    defaults: [],
    constraints: [],
  };
}
/** Renumbers places 1 through N in their current order. */
export function renumber(places: DraftPlace[]): DraftPlace[] {
  return places.map((place, i) => ({ ...place, index: i + 1 }));
}
/** Underscore spans in the meaning text, which the author can number later. */
export function placeholderCount(meaning: string): number {
  return (meaning.match(/_{2,}/g) ?? []).length;
}
/** Turns `___` placeholders into circled numerals in order. The author approves the numbering. */
export function numberPlaceholders(meaning: string): {
  text: string;
  count: number;
} {
  let count = 0;
  const text = meaning.replace(/_{2,}/g, () => {
    count++;
    return count <= 20
      ? String.fromCodePoint(0x245f + count)
      : `{place ${count}}`;
  });
  return { text, count };
}
export interface DraftProblem {
  field: string;
  message: string;
  /** Problems that block signing. Warnings do not. */
  blocking: boolean;
}
const lojbanWord = /^[a-z',.]+(?: [a-z',.]+)*$/u;
/** Editor text to rich text, with explicit `{place N}` and `[[word|label]]` tokens in structured mode. */
export function editorToRichText(
  source: string,
  structured: boolean,
): RichText {
  if (!structured) return textToRichText(source, false);
  const paragraphs = textToRichText(source, true);
  return paragraphs.map((paragraph) =>
    paragraph.flatMap((node): RichNode[] => {
      if (typeof node !== "string") return [node];
      const out: RichNode[] = [];
      const pattern = /\{place (\d{1,5})\}|\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/gu;
      let index = 0;
      for (const match of node.matchAll(pattern)) {
        if (match.index! > index) out.push(node.slice(index, match.index));
        if (match[1]) out.push(Number(match[1]));
        else {
          const spelling = match[2].trim().normalize("NFC");
          out.push({
            word: { language: "jbo", spelling },
            label: (match[3] ?? spelling).trim(),
          });
        }
        index = match.index! + match[0].length;
      }
      if (index < node.length) out.push(node.slice(index));
      return out;
    }),
  );
}
/** Rich text to editor text for structured mode. */
export function richTextToEditor(value: RichText): string {
  return value
    .map((paragraph) =>
      paragraph
        .map((node) => {
          if (typeof node === "string") return node;
          if (typeof node === "number")
            return node <= 20
              ? String.fromCodePoint(0x245f + node)
              : `{place ${node}}`;
          if ("word" in node)
            return node.label === node.word.spelling
              ? `[[${node.word.spelling}]]`
              : `[[${node.word.spelling}|${node.label}]]`;
          if ("code" in node) return node.code;
          if ("operand" in node) return `[${node.operand}]`;
          if ("url" in node) return node.label;
          return "";
        })
        .join(""),
    )
    .join("\n\n");
}
/** Replaces every place reference in the text with literal circled characters. Lossless escape. */
export function literalize(text: string): string {
  return text.replace(/\{place (\d{1,5})\}/gu, (_, n) => `(${n})`);
}
function plainRich(text: string): RichText {
  return textToRichText(text, false);
}
function buildFrame(draft: Draft, problems: DraftProblem[]) {
  if (draft.frameMode === "none") return null;
  const seen = new Set<number>();
  const places: Place[] = draft.places.map((place) => {
    if (seen.has(place.index))
      problems.push({
        field: `places.${place.index}`,
        message: `Place ${place.index} is declared twice.`,
        blocking: true,
      });
    seen.add(place.index);
    const hint =
      place.kind === "custom" ? place.hint : hintForChoice(place.kind);
    return {
      index: place.index,
      glosses: place.gloss.trim()
        ? [{ language: draft.language, text: place.gloss.trim(), sense: null }]
        : [],
      description: editorToRichText(place.description, draft.structured),
      type_hints: hint ? [hint] : [],
      defaults: place.defaults
        .filter((d) => d.text.trim())
        .map(
          (d): Default => ({
            kind: d.kind,
            value:
              d.format === "lojban"
                ? { format: "lojban", text: d.text.trim() }
                : {
                    format: "prose",
                    language: d.language || draft.language,
                    text: d.text.trim(),
                  },
            condition: plainRich(d.condition),
            explanation: plainRich(d.explanation),
          }),
        ),
      constraints: place.constraints
        .filter((c) => c.trim())
        .map((c) => editorToRichText(c, draft.structured)),
      derivation:
        place.from && place.from.word.trim()
          ? [
              {
                word: {
                  language: "jbo" as const,
                  spelling: place.from.word.trim().normalize("NFC"),
                },
                definition: place.from.definition || null,
                place: place.from.place,
                explanation: plainRich(place.from.explanation),
              },
            ]
          : [],
    };
  });
  places.sort((a, b) => a.index - b.index);
  let arity: Arity;
  if (draft.frameMode === "fixed") {
    arity = { mode: "fixed", count: places.length };
    places.forEach((place, i) => {
      if (place.index !== i + 1)
        problems.push({
          field: "places",
          message: `A fixed frame declares places 1 through ${places.length} in order. Place ${place.index} is out of sequence.`,
          blocking: true,
        });
    });
  } else if (draft.frameMode === "variadic") {
    arity = { mode: "variadic", minimum: draft.variadicMinimum };
    if (!draft.tail)
      problems.push({
        field: "tail",
        message: "A variable frame needs a description of the repeated places.",
        blocking: true,
      });
    if (draft.variadicMinimum > places.length)
      problems.push({
        field: "places",
        message: `The minimum of ${draft.variadicMinimum} places needs at least that many declared places.`,
        blocking: true,
      });
  } else arity = { mode: "context" };
  const tailHint = draft.tail
    ? draft.tail.kind === "custom"
      ? draft.tail.hint
      : hintForChoice(draft.tail.kind)
    : null;
  return {
    role: "predicate" as const,
    arity,
    places,
    tail:
      draft.frameMode === "variadic" && draft.tail
        ? {
            from: places.length + 1,
            description: editorToRichText(
              draft.tail.description,
              draft.structured,
            ),
            type_hints: tailHint ? [tailHint] : [],
          }
        : null,
    constraints: draft.frameConstraints
      .filter((c) => c.trim())
      .map((c) => editorToRichText(c, draft.structured)),
  };
}
/** Builds the signed body from the draft and lists every problem. */
export function draftToBody(draft: Draft): {
  body: DefinitionBody | null;
  problems: DraftProblem[];
  wordId: string | null;
} {
  const problems: DraftProblem[] = [];
  const spelling = draft.spelling.trim().normalize("NFC");
  if (!spelling)
    problems.push({
      field: "spelling",
      message: "Enter the Lojban word.",
      blocking: true,
    });
  else if (!lojbanWord.test(spelling))
    problems.push({
      field: "spelling",
      message:
        "Spelling uses Lojban letters, apostrophes, periods, commas, and single spaces.",
      blocking: false,
    });
  if (!draft.kind)
    problems.push({
      field: "kind",
      message: "Choose the word type.",
      blocking: true,
    });
  else if (!lexicalKinds.includes(draft.kind))
    problems.push({
      field: "kind",
      message: "The word type is not a permitted lexical kind.",
      blocking: true,
    });
  if (!/^[a-z]{1,8}(?:-[a-z0-9]{1,8})*$/.test(draft.language))
    problems.push({
      field: "language",
      message:
        "The definition language needs a lowercase BCP 47 tag, such as en.",
      blocking: true,
    });
  const text = editorToRichText(draft.text, draft.structured);
  if (!draft.text.trim())
    problems.push({
      field: "text",
      message: "Write the definition.",
      blocking: true,
    });
  const frame = buildFrame(draft, problems);
  const declared = new Set(frame?.places.map((p) => p.index) ?? []);
  const referenced = new Set<number>();
  for (const n of referencedPlaces(text)) referenced.add(n);
  for (const place of frame?.places ?? []) {
    for (const n of referencedPlaces(place.description)) referenced.add(n);
    for (const c of place.constraints)
      for (const n of referencedPlaces(c)) referenced.add(n);
  }
  const notes = editorToRichText(draft.notes, draft.structured);
  for (const n of referencedPlaces(notes)) referenced.add(n);
  for (const n of [...referenced].sort((a, b) => a - b)) {
    if (!declared.has(n))
      problems.push({
        field: "text",
        message: frame
          ? `Place ${n} is referenced but not declared. Add the place, change the number, or convert it to literal text.`
          : `Place ${n} is referenced but the definition declares no places. Choose a place structure or convert the reference to literal text.`,
        blocking: true,
      });
    if (n > 65535)
      problems.push({
        field: "text",
        message: `Place ${n} exceeds the limit of 65,535.`,
        blocking: true,
      });
  }
  if (frame && draft.structured && referenced.size && !draft.numberingApproved)
    problems.push({
      field: "numbering",
      message: "Approve the place numbering before publishing.",
      blocking: true,
    });
  if (countNodes(text) + countNodes(notes) > 8192)
    problems.push({
      field: "text",
      message: "The definition exceeds 8,192 rich text nodes.",
      blocking: true,
    });
  const operandIds = new Set<string>();
  const operands: Operand[] = draft.operands
    .filter((o) => o.id.trim())
    .map((o) => {
      const id = o.id.trim();
      if (!/^[a-z][a-z0-9_-]{0,31}$/.test(id))
        problems.push({
          field: "operands",
          message: `Operand ID "${id}" must match [a-z][a-z0-9_-]{0,31}.`,
          blocking: true,
        });
      if (operandIds.has(id))
        problems.push({
          field: "operands",
          message: `Operand ID "${id}" is used twice.`,
          blocking: true,
        });
      operandIds.add(id);
      if (o.maximum !== null && o.maximum < o.minimum)
        problems.push({
          field: "operands",
          message: `Operand "${id}" has a maximum below its minimum.`,
          blocking: true,
        });
      return {
        id,
        category: o.category.trim() || "sumti",
        description: plainRich(o.description),
        cardinality: { minimum: o.minimum, maximum: o.maximum },
      };
    });
  const examples: Example[] = draft.examples
    .filter((e) => e.text.trim())
    .map((e) => ({
      language: e.language || "jbo",
      text: e.text.trim(),
      translation: plainRich(e.translation),
      notes: plainRich(e.notes),
    }));
  const sources: SourceReference[] = draft.sources
    .filter((s) => s.label.trim())
    .map((s) => ({
      label: s.label.trim(),
      url: s.url?.trim() || null,
      event: s.event?.trim() || null,
      locator: s.locator?.trim() || null,
    }));
  for (const source of sources) {
    if (source.url && !/^https:\/\//.test(source.url))
      problems.push({
        field: "sources",
        message: `Source link "${source.url}" must use HTTPS.`,
        blocking: true,
      });
    if (source.event && !/^jve1:[0-9a-f]{64}$/.test(source.event))
      problems.push({
        field: "sources",
        message: `Source record "${source.event}" is not an event ID.`,
        blocking: true,
      });
  }
  const labels = draft.labels.map((l) => l.trim()).filter(Boolean);
  if (labels.length > 32)
    problems.push({
      field: "labels",
      message: "At most 32 labels are permitted.",
      blocking: true,
    });
  for (const label of labels)
    if (Array.from(label).length > 80)
      problems.push({
        field: "labels",
        message: `Label "${label.slice(0, 20)}…" exceeds 80 characters.`,
        blocking: true,
      });
  if (
    draft.frameMode === "none" &&
    draft.places.some((p) => p.description.trim() || p.gloss.trim())
  )
    problems.push({
      field: "places",
      message:
        "Places are filled in but the structure is unspecified. Choose a structure or the places are not published.",
      blocking: false,
    });
  for (const claim of draft.rafsiClaims)
    if (!claim.rafsi.trim())
      problems.push({
        field: "rafsi",
        message: "A rafsi claim needs a spelling.",
        blocking: true,
      });
  if (!draft.kind || !spelling) return { body: null, problems, wordId: null };
  const body: DefinitionBody = {
    word: { language: "jbo", spelling },
    language: draft.language,
    text,
    frame,
    operands,
    glosses: draft.glosses
      .filter((g) => g.text.trim())
      .map((g) => ({
        language: g.language || draft.language,
        text: g.text.trim(),
        sense: g.sense.trim() || null,
      })),
    notes,
    etymology: {
      text: plainRich(draft.etymologyText),
      formation: draft.formation,
      compound: draft.compound,
    },
    examples,
    classification: {
      kind: draft.kind,
      selmaho: draft.selmaho.map((s) => s.trim()).filter(Boolean),
    },
    labels,
    sources,
    license: { ...CC0_LICENSE },
    legacy: null,
  };
  let id: string | null = null;
  try {
    id = wordId(body.word);
  } catch (error) {
    problems.push({
      field: "spelling",
      message:
        error instanceof Error
          ? error.message
          : "The spelling is not a valid word.",
      blocking: true,
    });
  }
  return { body, problems, wordId: id };
}
/** Fills a draft from a published body, for Revise. */
export function draftFromBody(
  body: DefinitionBody,
  parentId: string,
  origin: "native" | "import",
): Draft {
  const placeText = (place: Place): DraftPlace => {
    const hint = place.type_hints[0] ?? null;
    const choice = choiceForHint(hint);
    const derivation = place.derivation[0];
    return {
      index: place.index,
      description: richTextToEditor(place.description),
      gloss: place.glosses.map((g) => g.text).join(", "),
      kind: choice,
      hint: choice === "custom" ? hint : null,
      from: derivation
        ? {
            word: derivation.word.spelling,
            definition: derivation.definition,
            place: derivation.place,
            explanation: richTextToText(derivation.explanation),
          }
        : null,
      defaults: place.defaults.map((d) => ({
        kind: d.kind,
        format: d.value.format,
        language: d.value.format === "prose" ? d.value.language : "",
        text: d.value.text,
        condition: richTextToText(d.condition),
        explanation: richTextToText(d.explanation),
      })),
      constraints: place.constraints.map((c) => richTextToEditor(c)),
    };
  };
  const frame = body.frame;
  const legacy = body.legacy as { source?: string } | null;
  const sources = [...body.sources];
  let revisedImport: Draft["revisedImport"] = null;
  if (origin === "import") {
    // The parent link keeps the imported attribution. The revision cites the exact
    // imported publication and copies the source-rights reference.
    revisedImport = { event: parentId, source: legacy?.source ?? "import" };
    sources.unshift({
      label: `Imported publication revised by this definition`,
      url: null,
      event: parentId,
      locator: null,
    });
    if (legacy?.source?.includes("lensisku"))
      sources.push({ ...LENSISKU_RIGHTS_REFERENCE });
  }
  const tailHint = frame?.tail?.type_hints[0] ?? null;
  return newDraft({
    step: 4,
    meaning: richTextToText(body.text),
    language: body.language,
    spelling: body.word.spelling,
    kind: body.classification.kind,
    selmaho: [...body.classification.selmaho],
    text: richTextToEditor(body.text),
    structured: true,
    frameMode: frame ? frame.arity.mode : "none",
    variadicMinimum: frame?.arity.mode === "variadic" ? frame.arity.minimum : 0,
    places: frame ? frame.places.map(placeText) : [],
    tail: frame?.tail
      ? {
          description: richTextToEditor(frame.tail.description),
          kind: choiceForHint(tailHint),
          hint: choiceForHint(tailHint) === "custom" ? tailHint : null,
        }
      : null,
    frameConstraints: frame?.constraints.map((c) => richTextToEditor(c)) ?? [],
    glosses: body.glosses.map((g) => ({
      language: g.language,
      text: g.text,
      sense: g.sense ?? "",
    })),
    notes: richTextToEditor(body.notes),
    examples: body.examples.map((e) => ({
      language: e.language,
      text: e.text,
      translation: richTextToText(e.translation),
      notes: richTextToText(e.notes),
    })),
    etymologyText: richTextToText(body.etymology.text),
    formation: body.etymology.formation,
    compound: body.etymology.compound,
    sources,
    labels: [...body.labels],
    operands: body.operands.map((o) => ({
      id: o.id,
      category: o.category,
      description: richTextToText(o.description),
      minimum: o.cardinality.minimum,
      maximum: o.cardinality.maximum,
    })),
    parents: [parentId],
    revisedImport,
    numberingApproved: true,
  });
}
/** Fields that no longer apply after a type change, for review before removal. */
export function formationFieldsFor(
  kind: LexicalKind | null,
  draft: Draft,
): string[] {
  const fields: string[] = [];
  if (kind !== "lujvo" && draft.compound) fields.push("compound evidence");
  if (kind !== "gismu" && draft.formation)
    fields.push("gismu generation evidence");
  if (kind !== "cmavo" && draft.selmaho.length) fields.push("selma'o");
  return fields;
}
