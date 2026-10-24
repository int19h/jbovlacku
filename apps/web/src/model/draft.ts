/**
 * The local definition draft. The wizard and the full editor edit the same
 * draft. Nothing here signs or sends. The draft keeps the original meaning
 * apart from the editable definition prose and preserves every structured field.
 */
import {
  canonicalize,
  contentHash,
  identityFromSeed,
  inspectBody,
  interpretDefinition,
  omitDefinitionDefaults,
  signHeader,
  utf8,
  validateAction,
  wordId,
} from "../../../../packages/core/src/browser.ts";
import {
  CIRCLED,
  countNodes,
  referencedPlaces,
  richTextToText,
  textToRichText,
} from "./richtext.ts";
import { placeGlyph } from "../lib/format.ts";
import { cloneAssistance } from "./assistance.ts";
import {
  syncFormationSources,
  formationSourcesFromRows,
  sameFormationSources,
} from "./builders.ts";
import {
  lexicalKinds,
  type Arity,
  type Compound,
  type Default,
  type DefinitionBody,
  type Example,
  type Formation,
  type FormationSource,
  type Gloss,
  type LexicalKind,
  type Operand,
  type Place,
  type RichNode,
  type RichText,
  type SourceReference,
  type TypeHint,
  type TypeAlternative,
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
  { value: "object", label: "anything (referent)" },
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
          { tags: ["referent"], abstractor: null, relation_arity: null },
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
    if (
      canonicalize(utf8(JSON.stringify(hintForChoice(choice)))) ===
      canonicalize(utf8(JSON.stringify(hint)))
    )
      return choice;
  return "custom";
}
export interface DraftDerivation {
  word: string;
  definition: string | null;
  /** The source place number. Null until the author enters one. */
  place: number | null;
  explanation: RichText;
}
export interface DraftGloss {
  language: string;
  text: string;
  sense: string;
}
export interface DraftDefault {
  kind: "conventional" | "suggested";
  format: "lojban" | "prose";
  language: string;
  text: string;
  condition: RichText;
  explanation: RichText;
}
/**
 * Rich text fields of the draft hold the exact rich text value. The editor
 * shows each value in its text form and parses the text back only when the
 * author edits that field, so an untouched value never changes.
 */
export interface DraftPlace {
  index: number;
  description: RichText;
  /** Every gloss keeps its own language and sense. */
  glosses: DraftGloss[];
  kind: KindChoice;
  /** Full type hint when kind is custom. The format allows one hint per place. */
  hint: TypeHint | null;
  /** The parent's exact hint, for a warning about retained annotations only. */
  parentHint?: TypeHint | null;
  /** Every derivation of this place, in order. */
  derivations: DraftDerivation[];
  defaults: DraftDefault[];
  constraints: RichText[];
}
export interface DraftExample {
  language: string;
  text: string;
  translation: RichText;
  notes: RichText;
}
import {
  normalizeSourceRow,
  sourceRowKey,
  type GismuState,
  type LujvoState,
} from "./builders.ts";
export interface DraftRafsiClaim {
  rafsi: string;
  rationale: string;
}
export interface DraftOperand {
  id: string;
  category: string;
  description: RichText;
  minimum: number;
  maximum: number | null;
}
export type FrameMode = "none" | "fixed" | "variadic" | "context";
interface LiteralModeSnapshot {
  literal: RichText;
  structured: RichText;
  /** Earlier visible values that an undo can restore after renumbering. */
  previousLiterals?: RichText[];
}
/** Private source evidence survives draft reload and export, but never enters a signed body. */
export interface DraftFormationSource extends FormationSource {
  stem?: string | null;
  ipa?: string | null;
}
export interface DraftFormation extends Omit<Formation, "sources"> {
  sources: DraftFormationSource[];
}
export interface Draft {
  /** Private suggestions, logs, and undo records. These fields never enter a signed body. */
  ai?: import("./assistance.ts").AssistanceData;
  version: 2;
  id: string;
  /** Changes with every save. A publication commits one exact revision. */
  revision: string;
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
  /** The definition. Structured mode reads typed circled numerals as place references. */
  text: RichText;
  structured: boolean;
  frameMode: FrameMode;
  /** True only after an explicit zero-place choice or a copy of that frame. */
  fixedZeroApproved: boolean;
  /** The frame role of the format. Revise keeps the parent's role. */
  frameRole: "predicate" | "constructed-predicate";
  variadicMinimum: number;
  places: DraftPlace[];
  tail: {
    description: RichText;
    kind: KindChoice;
    hint: TypeHint | null;
    parentHint?: TypeHint | null;
  } | null;
  frameConstraints: RichText[];
  glosses: { language: string; text: string; sense: string }[];
  notes: RichText;
  examples: DraftExample[];
  etymologyText: RichText;
  formation: DraftFormation | null;
  /** Empty source rows copied from authenticated history remain authored evidence. */
  retainedFormationSources?: number[];
  /** Explicit null pronunciations copied from signed history without builder state. */
  retainedWordIpaNullSources?: number[];
  compound: Compound | null;
  /** The spelling that the formation or compound evidence describes. */
  evidenceForm: string | null;
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
  /** Publish reviews bound to the spelling, package snapshot, and known conflict group. */
  publishAcknowledged: string[];
  /** Fields marked for review after a type or language change. */
  review: string[];
  /** Whether the author approved the current place numbering. */
  numberingApproved: boolean;
  /** Draft-only values for unchanged fields during a literal-mode cycle. */
  literalModeRestore?: Record<string, LiteralModeSnapshot>;
}
/** A rich field given as editor text or as rich text. */
type RichInput = string | RichText;
/** The draft shape that `newDraft` accepts: rich fields as text or rich text. */
export type DraftInput = Partial<
  Omit<
    Draft,
    | "text"
    | "notes"
    | "etymologyText"
    | "frameConstraints"
    | "tail"
    | "places"
    | "examples"
    | "operands"
  >
> & {
  text?: RichInput;
  notes?: RichInput;
  etymologyText?: RichInput;
  frameConstraints?: RichInput[];
  tail?: {
    description: RichInput;
    kind: KindChoice;
    hint: TypeHint | null;
    parentHint?: TypeHint | null;
  } | null;
  places?: PlaceInput[];
  examples?: (Omit<DraftExample, "translation" | "notes"> & {
    translation?: RichInput;
    notes?: RichInput;
  })[];
  operands?: (Omit<DraftOperand, "description"> & {
    description?: RichInput;
  })[];
};
export type PlaceInput = Omit<
  DraftPlace,
  "description" | "constraints" | "defaults" | "derivations"
> & {
  description?: RichInput;
  constraints?: RichInput[];
  defaults?: (Omit<DraftDefault, "condition" | "explanation"> & {
    condition?: RichInput;
    explanation?: RichInput;
  })[];
  derivations?: (Omit<DraftDerivation, "explanation"> & {
    explanation?: RichInput;
  })[];
};
/** Rich input to rich text. Text is read in the given mode. */
export function rich(
  value: RichInput | undefined,
  structured: boolean,
  local = true,
): RichText {
  if (value === undefined) return [];
  if (typeof value === "string")
    return editorToRichText(value, structured, local);
  return value;
}
function richPlace(place: PlaceInput, structured: boolean): DraftPlace {
  return {
    ...place,
    description: rich(place.description, structured),
    constraints: (place.constraints ?? []).map((c) => rich(c, structured)),
    defaults: (place.defaults ?? []).map((d) => ({
      ...d,
      condition: rich(d.condition, structured),
      explanation: rich(d.explanation, structured),
    })),
    derivations: (place.derivations ?? []).map((d) => ({
      ...d,
      explanation: rich(d.explanation, structured, false),
    })),
  };
}
export function newDraft(patch: DraftInput = {}): Draft {
  const now = Date.now();
  const structured = patch.structured ?? true;
  return {
    version: 2,
    id: "current",
    revision: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    step: 1,
    meaning: "",
    language: "en",
    spelling: "",
    kind: null,
    selmaho: [],
    formNotes: "",
    structured,
    frameMode: "none",
    fixedZeroApproved: false,
    frameRole: "predicate",
    variadicMinimum: 0,
    formation: null,
    compound: null,
    evidenceForm: null,
    sources: [],
    labels: [],
    parents: [],
    revisedImport: null,
    rafsiClaims: [],
    lujvo: null,
    gismu: null,
    publishAcknowledged: [],
    review: [],
    numberingApproved: false,
    ...patch,
    glosses: (patch.glosses ?? []).map((g) => ({
      ...g,
      language: g.language || patch.language || "en",
    })),
    text: rich(patch.text, structured),
    notes: rich(patch.notes, structured),
    etymologyText: rich(patch.etymologyText, structured, false),
    frameConstraints: (patch.frameConstraints ?? []).map((c) =>
      rich(c, structured),
    ),
    tail: patch.tail
      ? { ...patch.tail, description: rich(patch.tail.description, structured) }
      : null,
    places: (patch.places ?? []).map((pl) => ({
      ...richPlace(pl, structured),
      glosses: pl.glosses.map((g) => ({
        ...g,
        language: g.language || patch.language || "en",
      })),
    })),
    examples: (patch.examples ?? []).map((e) => ({
      ...e,
      translation: rich(e.translation, structured, false),
      notes: rich(e.notes, structured, false),
    })),
    operands: (patch.operands ?? []).map((o) => ({
      ...o,
      description: rich(o.description, structured),
    })),
  };
}
export function newPlace(index: number): DraftPlace {
  return {
    index,
    description: [],
    glosses: [],
    kind: "unspecified",
    hint: null,
    derivations: [],
    defaults: [],
    constraints: [],
  };
}
/**
 * Fills fields that an older draft of this prototype lacks. Nothing is
 * dropped: the old single gloss and the old single derivation become
 * one-item lists.
 */
export function normalizeDraft(stored: Draft): Draft {
  const old = stored as unknown as DraftInput & {
    places: (PlaceInput & { gloss?: string; from?: DraftDerivation | null })[];
    original?: unknown;
  };
  const structured = old.structured ?? true;
  const nested = interpretDefinition<DefinitionBody>({
    etymology: { formation: old.formation, compound: old.compound },
    sources: old.sources,
    frame: {
      places: (old.places ?? []).map((place) => ({
        type_hints: place.hint ? [place.hint] : [],
      })),
      tail: old.tail
        ? { type_hints: old.tail.hint ? [old.tail.hint] : [] }
        : null,
    },
  });
  const places: PlaceInput[] = (old.places ?? []).map((place, index) => {
    const { gloss, from, ...rest } = place as PlaceInput & {
      gloss?: string;
      from?: DraftDerivation | null;
    };
    return {
      ...rest,
      hint: nested.frame!.places[index].type_hints[0] ?? null,
      glosses:
        place.glosses?.map((gloss) => ({
          ...gloss,
          sense: gloss.sense ?? "",
        })) ??
        (gloss?.trim()
          ? [{ language: old.language ?? "en", text: gloss.trim(), sense: "" }]
          : []),
      derivations:
        place.derivations?.map((derivation) => ({
          ...derivation,
          definition: derivation.definition ?? null,
        })) ?? (from ? [{ ...from, explanation: from.explanation ?? "" }] : []),
    };
  });
  const { original, ...rest } = old;
  void original;
  const gismu = old.gismu
    ? { ...old.gismu, rows: old.gismu.rows.map(normalizeSourceRow) }
    : null;
  // Give old undo snapshots the same row identities as the current draft.
  const ai = old.ai ? cloneAssistance(old.ai) : undefined;
  const sourceValue = (row: import("./builders.ts").GismuRowState) => {
    const { id, ...value } = normalizeSourceRow(row);
    void id;
    return JSON.stringify(
      Object.fromEntries(
        Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
      ),
    );
  };
  const matchingSource = (row: import("./builders.ts").GismuRowState) => {
    const languageRows =
      gismu?.rows.filter((current) => current.language === row.language) ?? [];
    const exact = languageRows.filter(
      (current) => sourceValue(current) === sourceValue(row),
    );
    return exact.length === 1
      ? exact[0]
      : languageRows.length === 1
        ? languageRows[0]
        : undefined;
  };
  for (const record of ai?.records ?? []) {
    const legacy = /^source-(\d+)-(.+)$/.exec(record.key);
    let migratedRow: import("./builders.ts").GismuRowState | undefined;
    if (legacy) {
      const snapshot = record.after?.gismu?.rows[Number(legacy[1])];
      migratedRow = matchingSource(
        snapshot ?? {
          language: legacy[2],
          name: "",
          word: "",
          input: "",
          weight: null,
        },
      );
      if (migratedRow) record.key = sourceRowKey(migratedRow);
    }
    for (const snapshot of [record.before, record.after]) {
      if (!snapshot?.gismu) continue;
      snapshot.gismu.rows = snapshot.gismu.rows.map((row, index) => {
        const current =
          legacy && index === Number(legacy[1])
            ? migratedRow
            : matchingSource(row);
        return normalizeSourceRow({
          ...row,
          id: row.id ?? current?.id,
        });
      });
    }
  }
  const draft = newDraft({
    ...rest,
    formation: nested.etymology.formation,
    compound: nested.etymology.compound,
    sources: nested.sources,
    glosses:
      old.glosses?.map((gloss) => ({ ...gloss, sense: gloss.sense ?? "" })) ??
      [],
    operands:
      old.operands?.map((operand) => ({
        ...operand,
        maximum: operand.maximum ?? null,
      })) ?? [],
    tail: old.tail
      ? { ...old.tail, hint: nested.frame!.tail!.type_hints[0] ?? null }
      : null,
    gismu,
    ...(ai ? { ai } : {}),
    places,
    frameRole: old.frameRole ?? "predicate",
    evidenceForm:
      old.evidenceForm ??
      (old.formation || old.compound ? (old.spelling ?? "") : null),
  });
  if (draft.formation) draft.formation = { ...draft.formation };
  syncFormationSources(draft);
  return draft;
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
  const text = escapeLiteral(meaning).replace(/_{2,}/g, () => {
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
  /** Repeated invalid nodes share one displayed problem but retain their count. */
  occurrences?: number;
  /** The exact rich field that a place-reference conversion can change. */
  richFieldKey?: string;
  /** Problems that block signing. Warnings do not. */
  blocking: boolean;
}
const lojbanWord = /^[a-z',.]+(?: [a-z',.]+)*$/u;
/**
 * The editor's token syntax in structured mode. Every rich text node has a
 * text form, so a published body converts to editor text and back without
 * loss.
 *
 * - `①` through `⑳` or `{place N}`: a place reference.
 * - `{operand ID}`: an operand reference.
 * - `[[spelling]]` or `[[spelling|label]]`: a word link.
 * - `[[https://host/path]]` or `[[https://host/path|label]]`: a web link.
 * - `` `text` ``: code.
 * - A backslash before `\`, `[`, `{`, `` ` ``, or a circled numeral keeps
 *   that character as literal text.
 */
const TOKEN =
  /\\([\\`[{①-⑳])|([①-⑳])|\{place (\d{1,5})\}|\{operand ([a-z][a-z0-9_-]{0,31})\}|`((?:\\.|[^`])*)`|\[\[((?:\\.|[^\]|])+)(?:\|((?:\\.|[^\]])*))?\]\]/gu;
const unescape = (value: string, code = false) =>
  value.replace(code ? /\\([\\`])/gu : /\\([\\\]|`])/gu, "$1");
/** Editor text to rich text. Structured mode reads the token syntax. */
export function editorToRichText(
  source: string,
  structured: boolean,
  local = true,
): RichText {
  if (!structured) return textToRichText(source, false);
  const paragraphs = source
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+$/u, ""))
    .filter((paragraph) => paragraph.length);
  return paragraphs.map((paragraph) => {
    const nodes: RichNode[] = [];
    let pending = "";
    const flush = () => {
      if (pending) nodes.push(pending);
      pending = "";
    };
    let index = 0;
    for (const match of paragraph.matchAll(TOKEN)) {
      pending += paragraph.slice(index, match.index);
      index = match.index! + match[0].length;
      const [, escaped, circled, placeNumber, operand, code, target, label] =
        match;
      if (escaped !== undefined) {
        pending += escaped;
        continue;
      }
      if (!local && (circled || placeNumber || operand)) {
        pending += match[0];
        continue;
      }
      flush();
      if (circled) nodes.push(circled.codePointAt(0)! - 0x245f);
      else if (placeNumber) nodes.push(Number(placeNumber));
      else if (operand) nodes.push({ operand });
      else if (code !== undefined) nodes.push({ code: unescape(code, true) });
      else {
        const spelling = unescape(target).trim().normalize("NFC");
        const shown = label === undefined ? spelling : unescape(label).trim();
        if (/^https?:\/\//iu.test(spelling))
          nodes.push({ url: spelling, label: shown });
        else nodes.push({ word: { language: "jbo", spelling }, label: shown });
      }
    }
    pending += paragraph.slice(index);
    flush();
    return nodes;
  });
}
/** Escapes characters that the token syntax reads, so text stays literal. */
function escapeLiteral(value: string): string {
  return value.replace(/[\\`[{①-⑳]/gu, (c) => `\\${c}`);
}
const escapeInside = (value: string) => value.replace(/[\\\]|`]/gu, "\\$&");
/** Rich text to editor text in the token syntax. Lossless. */
export function richTextToEditor(value: RichText): string {
  return value
    .map((paragraph) =>
      paragraph
        .map((node) => {
          if (typeof node === "string") return escapeLiteral(node);
          if (typeof node === "number")
            return node <= 20
              ? String.fromCodePoint(0x245f + node)
              : `{place ${node}}`;
          // An empty label is written as `[[target|]]`. It is valid in the format.
          if ("word" in node)
            return node.label === node.word.spelling
              ? `[[${escapeInside(node.word.spelling)}]]`
              : `[[${escapeInside(node.word.spelling)}|${escapeInside(node.label)}]]`;
          if ("url" in node)
            return node.label === node.url
              ? `[[${escapeInside(node.url)}]]`
              : `[[${escapeInside(node.url)}|${escapeInside(node.label)}]]`;
          if ("code" in node)
            return `\`${node.code.replace(/[\\`]/gu, "\\$&")}\``;
          if ("operand" in node) return `{operand ${node.operand}}`;
          return "";
        })
        .join(""),
    )
    .join("\n\n");
}
/** The literal text form of one place number. */
const literalPlace = (index: number) =>
  index <= 20
    ? `\\${String.fromCodePoint(0x245f + index)}`
    : `\\{place ${index}}`;
/** The reference form of one place number. */
const referencePlace = (index: number) =>
  index <= 20 ? String.fromCodePoint(0x245f + index) : `{place ${index}}`;
/**
 * Maps place numbers in editor text, for removal, moves, and index edits.
 * The text is read with the token syntax, so a circled character inside
 * code, a link target, a link label, or an escape is not a reference and
 * stays as it is. A mapped reference keeps its referent.
 */
export function remapPlaces(
  text: string,
  map: (index: number) => number | "literal",
): string {
  return text.replace(TOKEN, (whole, _escaped, circled, placeNumber) => {
    if (!circled && !placeNumber) return whole;
    const index = circled
      ? (circled as string).codePointAt(0)! - 0x245f
      : Number(placeNumber);
    const target = map(index);
    return target === "literal" ? literalPlace(index) : referencePlace(target);
  });
}
/**
 * Turns every place reference in editor text into a literal circled
 * character. The visible text stays the same, and nothing refers to a place.
 */
export function literalize(text: string): string {
  return remapPlaces(text, () => "literal");
}
/** One rich text field of the draft that can hold a place reference, with a label. */
export interface ReferenceField {
  label: string;
  key: string;
  get: () => RichText;
  set: (value: RichText) => void;
}
const transientRichIds = new WeakMap<object, Record<string, string>>();
const transientConstraintIds = new WeakMap<object, string[]>();
function transientIds<T>(
  cache: WeakMap<object, T>,
  owner: object,
  create: () => T,
): T {
  let ids = cache.get(owner);
  if (!ids) cache.set(owner, (ids = create()));
  return ids;
}
function richFieldKey(owner: object, property: string, persist = true): string {
  const metadata = owner as { richFieldIds?: Record<string, string> };
  const transient = transientIds<Record<string, string>>(
    transientRichIds,
    owner,
    () => ({}),
  );
  const key =
    metadata.richFieldIds?.[property] ??
    (transient[property] ??= crypto.randomUUID());
  if (!persist) return key;
  metadata.richFieldIds ??= {};
  return (metadata.richFieldIds[property] = key);
}
function constraintKey(owner: object, index: number, persist = true): string {
  const metadata = owner as { constraintIds?: string[] };
  const transient = transientIds(transientConstraintIds, owner, () => []);
  const key =
    metadata.constraintIds?.[index] ??
    (transient[index] ??= crypto.randomUUID());
  if (!persist) return key;
  metadata.constraintIds ??= [];
  return (metadata.constraintIds[index] = key);
}
/**
 * Rich fields with stable draft-only identities. Nonlocal fields are included
 * only for conversion of invalid saved references into literal text.
 */
export function referenceFields(
  draft: Draft,
  includeNonlocal = false,
): ReferenceField[] {
  const fields: ReferenceField[] = [
    {
      label: "the definition",
      key: richFieldKey(draft, "text"),
      get: () => draft.text,
      set: (v) => (draft.text = v),
    },
    {
      label: "the notes",
      key: richFieldKey(draft, "notes"),
      get: () => draft.notes,
      set: (v) => (draft.notes = v),
    },
  ];
  for (const place of draft.places) {
    fields.push({
      label: `the description of place ${place.index}`,
      key: richFieldKey(place, "description"),
      get: () => place.description,
      set: (v) => (place.description = v),
    });
    if (place.kind === "custom" && place.hint)
      fields.push({
        label: `the type note of place ${place.index}`,
        key: richFieldKey(place, "hintNote"),
        get: () => place.hint!.note,
        set: (v) => (place.hint!.note = v),
      });
    place.constraints.forEach((_, i) =>
      fields.push({
        label: `constraint ${i + 1} of place ${place.index}`,
        key: constraintKey(place, i),
        get: () => place.constraints[i],
        set: (v) => (place.constraints[i] = v),
      }),
    );
    place.defaults.forEach((d, i) =>
      fields.push(
        {
          label: `the condition of default ${i + 1} of place ${place.index}`,
          key: richFieldKey(d, "condition"),
          get: () => d.condition,
          set: (v) => (d.condition = v),
        },
        {
          label: `the explanation of default ${i + 1} of place ${place.index}`,
          key: richFieldKey(d, "explanation"),
          get: () => d.explanation,
          set: (v) => (d.explanation = v),
        },
      ),
    );
  }
  if (draft.tail) {
    fields.push({
      label: "the description of the repeated places",
      key: richFieldKey(draft.tail, "description"),
      get: () => draft.tail!.description,
      set: (v) => (draft.tail!.description = v),
    });
    if (draft.tail.kind === "custom" && draft.tail.hint)
      fields.push({
        label: "the type note of the repeated places",
        key: richFieldKey(draft.tail, "hintNote"),
        get: () => draft.tail!.hint!.note,
        set: (v) => (draft.tail!.hint!.note = v),
      });
  }
  draft.frameConstraints.forEach((_, i) =>
    fields.push({
      label: `frame constraint ${i + 1}`,
      key: constraintKey(draft, i),
      get: () => draft.frameConstraints[i],
      set: (v) => (draft.frameConstraints[i] = v),
    }),
  );
  draft.operands.forEach((o) =>
    fields.push({
      label: `the description of operand ${o.id || "without ID"}`,
      key: richFieldKey(o, "description"),
      get: () => o.description,
      set: (v) => (o.description = v),
    }),
  );
  if (includeNonlocal) {
    fields.push({
      label: "the etymology",
      key: richFieldKey(draft, "etymologyText"),
      get: () => draft.etymologyText,
      set: (v) => (draft.etymologyText = v),
    });
    draft.examples.forEach((example, i) =>
      fields.push(
        {
          label: `the translation of example ${i + 1}`,
          key: richFieldKey(example, "translation"),
          get: () => example.translation,
          set: (v) => (example.translation = v),
        },
        {
          label: `the notes of example ${i + 1}`,
          key: richFieldKey(example, "notes"),
          get: () => example.notes,
          set: (v) => (example.notes = v),
        },
      ),
    );
    draft.places.forEach((place) =>
      place.derivations.forEach((derivation, i) =>
        fields.push({
          label: `the explanation of derivation ${i + 1} of place ${place.index}`,
          key: richFieldKey(derivation, "explanation"),
          get: () => derivation.explanation,
          set: (v) => (derivation.explanation = v),
        }),
      ),
    );
  }
  return fields;
}
/**
 * Maps the place nodes of rich text. Every other node stays exactly as it
 * is. A node mapped to "literal" becomes the circled character as text, and
 * adjacent text joins into one node.
 */
export function remapRich(
  value: RichText,
  map: (index: number) => number | "literal",
): RichText {
  return value.map((paragraph) => {
    const out: RichNode[] = [];
    for (const node of paragraph) {
      let next: RichNode = node;
      if (typeof node === "number") {
        const target = map(node);
        // The literal text form of a place: the circled character, or the
        // explicit notation above 20, which the editor escapes as `\{place N}`.
        next =
          target === "literal"
            ? node <= 20
              ? placeGlyph(node)
              : `{place ${node}}`
            : target;
      }
      const last = out[out.length - 1];
      if (typeof next === "string" && typeof last === "string")
        out[out.length - 1] = last + next;
      else out.push(next);
    }
    return out;
  });
}
/** The fields that refer to a place, by label. */
export function fieldsReferencing(draft: Draft, index: number): string[] {
  return referenceFields(draft)
    .filter((f) => referencedPlaces(f.get()).has(index))
    .map((f) => f.label);
}
/** Rewrites place references in every field, or in the selected field keys. */
export function rewriteReferences(
  draft: Draft,
  map: (index: number) => number | "literal",
  includeNonlocal = false,
  fieldKeys?: readonly string[],
) {
  for (const f of referenceFields(draft, includeNonlocal)) {
    if (fieldKeys && !fieldKeys.includes(f.key)) continue;
    const value = f.get();
    const saved = draft.literalModeRestore?.[f.key];
    const unchanged =
      !draft.structured && saved && matchesLiteral(value, saved);
    if (!draft.structured && saved) {
      const previousLiteral = saved.literal;
      saved.structured = remapRich(saved.structured, map);
      saved.literal = remapRich(saved.structured, () => "literal");
      if (
        !unchanged &&
        !sameRich(previousLiteral, saved.literal) &&
        !saved.previousLiterals?.some((literal) =>
          sameRich(literal, previousLiteral),
        )
      ) {
        saved.previousLiterals ??= [];
        saved.previousLiterals.push(structuredClone(previousLiteral));
      }
      if (unchanged) f.set(structuredClone(saved.literal));
    }
    if (!unchanged && referencedPlaces(value).size)
      f.set(remapRich(value, map));
  }
}
const sameRich = (a: RichText, b: RichText) =>
  JSON.stringify(a) === JSON.stringify(b);
function matchesLiteral(
  value: RichText,
  snapshot: LiteralModeSnapshot,
): boolean {
  return (
    sameRich(value, snapshot.literal) ||
    Boolean(
      snapshot.previousLiterals?.some((literal) => sameRich(value, literal)),
    )
  );
}
/** The text form of a rich value for the editor in the given mode. */
export function editorText(value: RichText, structured: boolean): string {
  return structured ? richTextToEditor(value) : richTextToText(value);
}
/** The fields whose place references literal mode turns into circled characters. */
export function literalLoss(draft: Draft): string[] {
  return referenceFields(draft, true)
    .filter((f) => referencedPlaces(f.get()).size > 0)
    .map((f) => f.label);
}
/**
 * Reads the place notation inside text nodes as place references: circled
 * numerals, and `{place N}` above 20. Every other node stays.
 */
function structureStrings(value: RichText): RichText {
  return value.map((paragraph) =>
    paragraph.flatMap((node): RichNode[] => {
      if (typeof node !== "string") return [node];
      const out: RichNode[] = [];
      let index = 0;
      const pattern = /([①-⑳])|\{place (\d{1,5})\}/gu;
      for (const match of node.matchAll(pattern)) {
        if (match.index! > index) out.push(node.slice(index, match.index));
        out.push(
          match[1] ? match[1].codePointAt(0)! - 0x245f : Number(match[2]),
        );
        index = match.index! + match[0].length;
      }
      if (index < node.length) out.push(node.slice(index));
      return out;
    }),
  );
}
/**
 * Literal mode turns place nodes into text in every rich field. An unchanged
 * local field keeps its exact value when structured mode returns. Edited
 * literal fields read circled characters as references. Nonlocal fields keep
 * their literal characters. Draft-only snapshots never enter the body.
 */
export function switchMode(draft: Draft, structured: boolean) {
  if (draft.structured === structured) return;
  if (!structured) {
    draft.literalModeRestore = {};
    for (const f of referenceFields(draft)) {
      const original = structuredClone(f.get());
      const literal = remapRich(original, () => "literal");
      draft.literalModeRestore[f.key!] = {
        structured: original,
        literal: structuredClone(literal),
      };
      f.set(literal);
    }
    for (const f of referenceFields(draft, true))
      if (referencedPlaces(f.get()).size)
        f.set(remapRich(f.get(), () => "literal"));
  } else {
    for (const f of referenceFields(draft)) {
      const saved = draft.literalModeRestore?.[f.key!];
      f.set(
        saved && matchesLiteral(f.get(), saved)
          ? structuredClone(saved.structured)
          : structureStrings(f.get()),
      );
    }
    delete draft.literalModeRestore;
  }
  draft.structured = structured;
  draft.numberingApproved = false;
}
/** A copy of the draft with every place reference as literal text. */
function literalView(draft: Draft): Draft {
  const { ai, ...fields } = draft;
  void ai;
  const copy = structuredClone(fields) as Draft;
  copy.structured = true;
  rewriteReferences(copy, () => "literal", true);
  copy.structured = false;
  return copy;
}
function plainRich(text: string): RichText {
  return textToRichText(text, false);
}
/** Every rich text field of the body, with its field name and whether place references are allowed. */
interface RichField {
  field: string;
  key: string;
  label: string;
  value: RichText;
  local: boolean;
}
/** Checks the nodes of one rich text field against the format rules. */
function richProblems(
  entry: RichField,
  operands: Set<string>,
  problems: DraftProblem[],
) {
  const seen = new Map<string, DraftProblem>();
  const report = (message: string, convertPlaceReference = false) => {
    const key = `${entry.field}:${message}`;
    const existing = seen.get(key);
    if (existing) {
      existing.occurrences = (existing.occurrences ?? 1) + 1;
      return;
    }
    const problem: DraftProblem = {
      field: entry.field,
      message,
      blocking: true,
      ...(convertPlaceReference ? { richFieldKey: entry.key } : {}),
    };
    seen.set(key, problem);
    problems.push(problem);
  };
  for (const paragraph of entry.value)
    for (const node of paragraph) {
      if (typeof node === "string") continue;
      if (typeof node === "number") {
        if (!entry.local)
          report(
            `${entry.label} cannot refer to a place. Convert the reference to literal text.`,
            true,
          );
        continue;
      }
      if ("operand" in node) {
        if (!entry.local) report(`${entry.label} cannot refer to an operand.`);
        else if (!operands.has(node.operand))
          report(
            `${entry.label} refers to the operand "${node.operand}", which is not declared.`,
          );
      } else if ("word" in node) {
        if (!node.word.spelling)
          report(`${entry.label} has a word link without a spelling.`);
        else if (!lojbanWord.test(node.word.spelling))
          report(
            `${entry.label} links the word "${node.word.spelling}", which is not a Lojban spelling.`,
          );
      } else if ("url" in node) {
        if (!/^https:\/\/[^\s/]+/u.test(node.url))
          report(
            `${entry.label} links "${node.url}", which is not an HTTPS URL.`,
          );
      }
    }
}
const KNOWN_TAGS = new Set([
  "referent",
  "agent",
  "event",
  "state",
  "process",
  "relation",
  "proposition",
  "number",
  "text",
  "set",
  "sequence",
]);
const RETIRED_TAGS = new Set(["entity", "mass", "tuple"]);
export function retiredTagMeaning(tag: string): string | null {
  if (tag === "entity") return "entity means referent.";
  if (tag === "tuple") return "tuple means sequence.";
  if (tag === "mass")
    return "mass is an opaque legacy annotation outside the current tag tree and has no current alias.";
  return null;
}
function alternativeKey(alternative: TypeAlternative): string {
  const arity = alternative.relation_arity;
  return JSON.stringify([
    alternative.tags,
    alternative.abstractor,
    arity?.mode ?? null,
    arity && "count" in arity
      ? arity.count
      : arity && "minimum" in arity
        ? arity.minimum
        : null,
  ]);
}
/** Replace an alias only after the author asks. Keep every other annotation. */
export function replaceRetiredHintTag(hint: TypeHint, tag: string): TypeHint {
  const replacement =
    tag === "entity" ? "referent" : tag === "tuple" ? "sequence" : null;
  if (!replacement) throw new Error("The retired tag has no current alias.");
  const result = structuredClone(hint);
  const seen = new Set<string>();
  result.alternatives = result.alternatives
    .map((alternative) => ({
      ...alternative,
      tags: [
        ...new Set(
          alternative.tags.map((value) =>
            value === tag ? replacement : value,
          ),
        ),
      ].sort(),
    }))
    .filter((alternative) => {
      const key = alternativeKey(alternative);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return result;
}
const ABSTRACTORS = new Set([
  "nu",
  "du'u",
  "ka",
  "ni",
  "jei",
  "li'i",
  "si'o",
  "su'u",
  "mu'e",
  "pu'u",
  "za'i",
  "zu'o",
]);
/** Checks a custom type hint against the format rules and returns the cleaned hint. */
function hintProblems(
  hint: TypeHint,
  field: string,
  label: string,
  problems: DraftProblem[],
  parentHint?: TypeHint | null,
): TypeHint {
  const alternatives = hint.alternatives.map((a) => ({
    tags: [...new Set(a.tags.map((t) => t.trim()).filter(Boolean))].sort(),
    abstractor: a.abstractor?.trim() || null,
    relation_arity: a.relation_arity,
  }));
  if (!alternatives.length)
    problems.push({
      field,
      message: `${label} needs at least one alternative.`,
      blocking: true,
    });
  const seen = new Set<string>();
  for (const a of alternatives) {
    const key = alternativeKey(a);
    if (seen.has(key))
      problems.push({
        field,
        message: `${label} lists the same alternative twice.`,
        blocking: true,
      });
    seen.add(key);
    if (!a.tags.length && !a.abstractor && !a.relation_arity)
      problems.push({
        field,
        message: `${label} has an alternative with no tag, abstractor, or arity.`,
        blocking: true,
      });
    for (const tag of a.tags)
      if (RETIRED_TAGS.has(tag)) {
        const change =
          tag === "mass"
            ? "Choose a current tag or remove it before a new signature. A replacement changes its meaning."
            : `Use Replace ${tag} with ${tag === "entity" ? "referent" : "sequence"}, or remove it, before a new signature.`;
        const fromParent = parentHint?.alternatives.some(
          (original) => alternativeKey(original) === key,
        );
        problems.push({
          field,
          message: `${label} keeps the retired tag "${tag}". ${retiredTagMeaning(tag)} ${change}${fromParent ? " The original signed body stays valid." : ""}`,
          blocking: true,
        });
      } else if (!KNOWN_TAGS.has(tag) && !/^https:\/\/[^\s/]+/u.test(tag))
        problems.push({
          field,
          message: `${label} uses the tag "${tag}". A tag is one of the named kinds or an HTTPS URL.`,
          blocking: true,
        });
    if (a.abstractor && !ABSTRACTORS.has(a.abstractor))
      problems.push({
        field,
        message: `${label} uses the abstractor "${a.abstractor}", which the format does not list.`,
        blocking: true,
      });
  }
  return { alternatives, note: hint.note };
}
const language = (tag: string) => /^[a-z]{1,8}(?:-[a-z0-9]{1,8})*$/.test(tag);
function buildFrame(draft: Draft, problems: DraftProblem[], rich: RichField[]) {
  if (draft.frameMode === "none") return null;
  const seen = new Set<number>();
  if (draft.places.length > 256)
    problems.push({
      field: "places",
      message: "A frame declares at most 256 places.",
      blocking: true,
    });
  const places: Place[] = draft.places.map((place) => {
    const field = `places.${place.index}`;
    const label = `Place ${place.index}`;
    if (seen.has(place.index))
      problems.push({
        field,
        message: `Place ${place.index} is declared twice.`,
        blocking: true,
      });
    seen.add(place.index);
    const hint =
      place.kind === "custom"
        ? place.hint
          ? hintProblems(
              place.hint,
              field,
              `${label}'s kind of thing`,
              problems,
              draft.parents.length ? place.parentHint : null,
            )
          : null
        : hintForChoice(place.kind);
    const description = place.description;
    rich.push({
      field,
      key: richFieldKey(place, "description", false),
      label: `${label}'s description`,
      value: description,
      local: true,
    });
    const hintNote = hint?.note ?? [];
    if (hint)
      rich.push({
        field,
        key: richFieldKey(place, "hintNote", false),
        label: `${label}'s type note`,
        value: hintNote,
        local: true,
      });
    const glosses: Gloss[] = place.glosses
      .filter((g) => g.text.trim())
      .map((g) => {
        const tag = g.language.trim() || draft.language;
        if (!language(tag))
          problems.push({
            field,
            message: `${label}'s gloss "${g.text.trim()}" has the language "${tag}", which is not a lowercase BCP 47 tag.`,
            blocking: true,
          });
        return {
          language: tag,
          text: g.text,
          sense: g.sense.trim() ? g.sense : null,
        };
      });
    const defaults = place.defaults
      .filter((d) => d.text.trim())
      .map((d, i): Default => {
        const condition = d.condition;
        const explanation = d.explanation;
        rich.push(
          {
            field,
            key: richFieldKey(d, "condition", false),
            label: `${label}'s default ${i + 1} condition`,
            value: condition,
            local: true,
          },
          {
            field,
            key: richFieldKey(d, "explanation", false),
            label: `${label}'s default ${i + 1} explanation`,
            value: explanation,
            local: true,
          },
        );
        const prose = d.language.trim() || draft.language;
        if (d.format === "prose" && !language(prose))
          problems.push({
            field,
            message: `${label}'s default ${i + 1} has the language "${prose}", which is not a lowercase BCP 47 tag.`,
            blocking: true,
          });
        return {
          kind: d.kind,
          value:
            d.format === "lojban"
              ? { format: "lojban", text: d.text }
              : { format: "prose", language: prose, text: d.text },
          condition,
          explanation,
        };
      });
    const constraints = place.constraints.flatMap((c, i) => {
      if (!countNodes(c)) return [];
      const value = c;
      rich.push({
        field,
        key: constraintKey(place, i, false),
        label: `${label}'s constraint ${i + 1}`,
        value,
        local: true,
      });
      return [value];
    });
    const derivation = place.derivations
      .filter((d) => d.word.trim() || d.definition || countNodes(d.explanation))
      .flatMap((d, i) => {
        const word = d.word.trim().normalize("NFC");
        const which = `${label}'s derivation ${i + 1}`;
        if (!word)
          problems.push({
            field,
            message: `${which} needs a source word.`,
            blocking: true,
          });
        else if (!lojbanWord.test(word))
          problems.push({
            field,
            message: `${which} names "${word}", which is not a Lojban spelling.`,
            blocking: true,
          });
        if (
          d.place === null ||
          !Number.isInteger(d.place) ||
          d.place < 1 ||
          d.place > 65535
        )
          problems.push({
            field,
            message: `${which} needs the source place number, from 1 to 65,535. A word alone does not name a place.`,
            blocking: true,
          });
        const definition = d.definition?.trim() || null;
        if (definition && !/^jve1:[0-9a-f]{64}$/.test(definition))
          problems.push({
            field,
            message: `${which} names the definition "${definition}", which is not an event ID.`,
            blocking: true,
          });
        const explanation = d.explanation;
        rich.push({
          field,
          key: richFieldKey(d, "explanation", false),
          label: `${which}'s explanation`,
          value: explanation,
          local: false,
        });
        if (
          d.place === null ||
          !Number.isInteger(d.place) ||
          d.place < 1 ||
          d.place > 65535
        )
          return [];
        return [
          {
            word: { language: "jbo" as const, spelling: word },
            definition,
            place: d.place,
            explanation,
          },
        ];
      });
    return {
      index: place.index,
      glosses,
      description,
      type_hints: hint ? [hint] : [],
      defaults,
      constraints,
      derivation,
    };
  });
  places.sort((a, b) => a.index - b.index);
  // Fixed and variable frames declare a contiguous prefix.
  if (draft.frameMode !== "context")
    places.forEach((place, i) => {
      if (place.index !== i + 1)
        problems.push({
          field: "places",
          message: `A frame declares places 1 through ${places.length} in order. Place ${place.index} is out of sequence.`,
          blocking: true,
        });
    });
  let arity: Arity;
  if (draft.frameMode === "fixed") {
    if (!places.length && !draft.fixedZeroApproved)
      problems.push({
        field: "places",
        message:
          "Make an explicit zero-place choice, or choose an unspecified place structure.",
        blocking: true,
      });
    arity = { mode: "fixed", count: places.length };
  } else if (draft.frameMode === "variadic") {
    arity = { mode: "variadic", minimum: draft.variadicMinimum };
    if (!draft.tail)
      problems.push({
        field: "tail",
        message: "A variable frame needs a description of the repeated places.",
        blocking: true,
      });
    if (draft.variadicMinimum > 256)
      problems.push({
        field: "places",
        message: "The minimum number of places is at most 256.",
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
        ? hintProblems(
            draft.tail.hint,
            "tail",
            "The repeated places' kind of thing",
            problems,
            draft.parents.length ? draft.tail.parentHint : null,
          )
        : null
      : hintForChoice(draft.tail.kind)
    : null;
  const tailDescription =
    draft.frameMode === "variadic" && draft.tail
      ? draft.tail.description
      : null;
  if (tailDescription)
    rich.push({
      field: "tail",
      key: richFieldKey(draft.tail!, "description", false),
      label: "The repeated places' description",
      value: tailDescription,
      local: true,
    });
  if (tailHint && draft.frameMode === "variadic")
    rich.push({
      field: "tail",
      key: richFieldKey(draft.tail!, "hintNote", false),
      label: "The repeated places' type note",
      value: tailHint.note,
      local: true,
    });
  const constraints = draft.frameConstraints.flatMap((c, i) => {
    if (!countNodes(c)) return [];
    const value = c;
    rich.push({
      field: "frame",
      key: constraintKey(draft, i, false),
      label: `Frame constraint ${i + 1}`,
      value,
      local: true,
    });
    return [value];
  });
  return {
    role: draft.frameRole,
    arity,
    places,
    tail:
      tailDescription !== null
        ? {
            from: places.length + 1,
            description: tailDescription,
            type_hints: tailHint ? [tailHint] : [],
          }
        : null,
    constraints,
  };
}
/** The labels of the kinds of change that a type or form change needs reviewed. */
export const FORMATION_EVIDENCE = "formation evidence";
/**
 * Checks the finished body with the shared core, exactly as admission will.
 * A disposable key signs a throwaway header, so no real key or history is
 * involved. The core's reason names the rule, not the field.
 */
export function coreProblems(
  body: DefinitionBody,
  id: string,
  parents: string[],
  origin: "native" | "import",
): DraftProblem[] {
  try {
    const canonical = utf8(
      canonicalize(utf8(JSON.stringify(omitDefinitionDefaults(body)))),
    );
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const header = {
      version: 1 as const,
      issuer: identityFromSeed(seed),
      previous: [],
      nonce: "0".repeat(32),
      action: {
        kind: "definition.publish",
        word: id,
        language: body.language,
        parents: [...parents].sort(),
        origin,
      },
      content: { hash: contentHash(canonical), bytes: canonical.length },
    };
    const envelope = utf8(JSON.stringify(signHeader(seed, header)));
    const problems: DraftProblem[] = [];
    if (!validateAction(envelope))
      problems.push({
        field: "body",
        message: "The format rules reject the action header for this word.",
        blocking: true,
      });
    const result = inspectBody(envelope, canonical);
    if (result.availability !== "valid")
      problems.push({
        field: "body",
        message: `The format rules reject the body: ${result.reason ?? result.availability}.`,
        blocking: true,
      });
    return problems;
  } catch (error) {
    return [
      {
        field: "body",
        message: `The shared core could not check the body: ${error instanceof Error ? error.message : String(error)}.`,
        blocking: true,
      },
    ];
  }
}
/** Copy signed fields only, including when a stored draft contains private source evidence. */
export function signedFormation(
  formation: DraftFormation | null,
  keepEmptySources: boolean | number[] = false,
  keepNullPronunciations: number[] = [],
): Formation | null {
  if (!formation) return null;
  const sources: FormationSource[] = [];
  for (const [index, row] of formation.sources.entries()) {
    const source: FormationSource = {
      language: row.language,
      word: row.word,
      input: row.input,
      weight: row.weight,
      notes: row.notes,
    };
    if (
      (row.word_ipa === null && keepNullPronunciations.includes(index)) ||
      row.word_ipa?.trim()
    )
      source.word_ipa = row.word_ipa;
    const hasSignedEvidence =
      source.word.trim() ||
      source.word_ipa ||
      source.input !== null ||
      source.weight !== null ||
      countNodes(source.notes);
    if (
      hasSignedEvidence ||
      keepEmptySources === true ||
      (Array.isArray(keepEmptySources) && keepEmptySources.includes(index))
    )
      sources.push(source);
  }
  return { ...formation, sources };
}
/** Match exact projected evidence so filtered or reordered rows keep their own presence. */
export function retainedNullPronunciations(
  draft: Pick<Draft, "formation" | "gismu" | "retainedWordIpaNullSources">,
): number[] {
  if (!draft.formation) return [];
  if (!draft.gismu) return draft.retainedWordIpaNullSources ?? [];
  const originals = formationSourcesFromRows(draft.gismu.rows).filter(
    (source) => source.word_ipa === null,
  );
  return draft.formation.sources.flatMap((source, index) => {
    if (source.word_ipa !== null) return [];
    const originalIndex = originals.findIndex((original) =>
      sameFormationSources([source], [original]),
    );
    if (originalIndex === -1) return [];
    originals.splice(originalIndex, 1);
    return [index];
  });
}
/** Builds the signed body from the draft and lists every problem. */
export function draftToBody(input: Draft): {
  body: DefinitionBody | null;
  problems: DraftProblem[];
  wordId: string | null;
} {
  // Literal mode publishes no place references, whatever set the mode. A
  // reference that reached a field becomes the circled character as text.
  const view = input.structured ? input : literalView(input);
  const draft = {
    ...view,
    formation: view.formation ? { ...view.formation } : null,
  };
  // Pure reads and later editors use the same keys before metadata is saved.
  transientRichIds.set(
    draft,
    transientIds(transientRichIds, input, () => ({})),
  );
  transientConstraintIds.set(
    draft,
    transientIds(transientConstraintIds, input, () => []),
  );

  const problems: DraftProblem[] = [];
  if (syncFormationSources(draft))
    problems.push({
      field: "formation",
      message:
        "The source scoring inputs changed. Use the form again to refresh its scores, enter it without generation, or remove the evidence.",
      blocking: true,
    });
  for (const row of draft.formation ? (draft.gismu?.rows ?? []) : []) {
    if (row.sourceReview?.length)
      problems.push({
        field: "formation",
        message:
          "The source evidence needs review. Keep or clear each retained value for its new word.",
        blocking: true,
      });
  }
  const rich: RichField[] = [];
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
  if (!language(draft.language))
    problems.push({
      field: "language",
      message:
        "The definition language needs a lowercase BCP 47 tag, such as en.",
      blocking: true,
    });
  const text = draft.text;
  rich.push({
    field: "text",
    key: richFieldKey(draft, "text", false),
    label: "The definition",
    value: text,
    local: true,
  });
  if (!countNodes(draft.text))
    problems.push({
      field: "text",
      message: "Write the definition.",
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
      if (
        o.minimum < 0 ||
        o.minimum > 65535 ||
        (o.maximum !== null && o.maximum > 65535)
      )
        problems.push({
          field: "operands",
          message: `Operand "${id}" needs a cardinality from 0 to 65,535.`,
          blocking: true,
        });
      const description = o.description;
      rich.push({
        field: "operands",
        key: richFieldKey(o, "description", false),
        label: `Operand "${id}"'s description`,
        value: description,
        local: true,
      });
      return {
        id,
        category: o.category.trim() ? o.category : "sumti",
        description,
        cardinality: { minimum: o.minimum, maximum: o.maximum },
      };
    });
  const frame = buildFrame(draft, problems, rich);
  const notes = draft.notes;
  rich.push({
    field: "notes",
    key: richFieldKey(draft, "notes", false),
    label: "The notes",
    value: notes,
    local: true,
  });
  const etymologyText = [...draft.etymologyText, ...plainRich(draft.formNotes)];
  rich.push({
    field: "etymology",
    key: richFieldKey(draft, "etymologyText", false),
    label: "The etymology",
    value: etymologyText,
    local: false,
  });
  const examples: Example[] = draft.examples
    .filter((e) => e.text.trim())
    .map((e, i) => {
      const translation = e.translation;
      const exampleNotes = e.notes;
      rich.push(
        {
          field: "examples",
          key: richFieldKey(e, "translation", false),
          label: `Example ${i + 1}'s translation`,
          value: translation,
          local: false,
        },
        {
          field: "examples",
          key: richFieldKey(e, "notes", false),
          label: `Example ${i + 1}'s notes`,
          value: exampleNotes,
          local: false,
        },
      );
      const tag = e.language.trim() || "jbo";
      if (!language(tag))
        problems.push({
          field: "examples",
          message: `Example ${i + 1} has the language "${tag}", which is not a lowercase BCP 47 tag.`,
          blocking: true,
        });
      return {
        language: tag,
        text: e.text,
        translation,
        notes: exampleNotes,
      };
    });
  // References in every local field need a declared place.
  const declared = new Set(frame?.places.map((p) => p.index) ?? []);
  const referenced = new Map<number, RichField[]>();
  for (const entry of rich) {
    richProblems(entry, operandIds, problems);
    if (entry.local)
      for (const n of referencedPlaces(entry.value))
        referenced.set(n, [...(referenced.get(n) ?? []), entry]);
  }
  for (const [n, entries] of [...referenced].sort((a, b) => a[0] - b[0])) {
    for (const entry of entries) {
      if (!declared.has(n))
        problems.push({
          field: entry.field,
          occurrences: entry.value.reduce(
            (count, paragraph) =>
              count + paragraph.filter((node) => node === n).length,
            0,
          ),
          richFieldKey: entry.key,
          message: frame
            ? `Place ${n} is referenced in ${entry.label.toLowerCase()} but not declared. Add the place, change the number, or convert it to literal text.`
            : `Place ${n} is referenced in ${entry.label.toLowerCase()} but the definition declares no places. Choose a place structure or convert the reference to literal text.`,
          blocking: true,
        });
      if (n > 65535)
        problems.push({
          field: entry.field,
          occurrences: entry.value.reduce(
            (count, paragraph) =>
              count + paragraph.filter((node) => node === n).length,
            0,
          ),
          richFieldKey: entry.key,
          message: `Place ${n} exceeds the limit of 65,535.`,
          blocking: true,
        });
    }
  }
  if (frame && draft.structured && referenced.size && !draft.numberingApproved)
    problems.push({
      field: "numbering",
      message: "Approve the place numbering before publishing.",
      blocking: true,
    });
  const nodeCount = rich.reduce(
    (sum, entry) => sum + countNodes(entry.value),
    0,
  );
  if (nodeCount > 8192)
    problems.push({
      field: "text",
      message: `The body has ${nodeCount.toLocaleString("en")} rich text nodes across every field. The limit is 8,192.`,
      blocking: true,
    });
  const sources: SourceReference[] = draft.sources
    .filter((s) => s.label.trim())
    .map((s) => ({
      label: s.label,
      url: s.url?.trim() ? s.url : null,
      event: s.event?.trim() ? s.event : null,
      locator: s.locator?.trim() ? s.locator : null,
    }));
  for (const source of sources) {
    if (source.url && !/^https:\/\/[^\s/]+/u.test(source.url))
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
  // Values are published as stored. The input handlers trim what the author types.
  const labels = draft.labels.filter((l) => l.trim());
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
    draft.places.some((p) => countNodes(p.description) || p.glosses.length)
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
  // Formation evidence describes one exact form. Another spelling needs new evidence.
  if (
    (draft.formation || draft.compound) &&
    draft.evidenceForm !== null &&
    draft.evidenceForm !== spelling
  )
    problems.push({
      field: "spelling",
      message: `The ${draft.compound ? "compound" : "generation"} evidence describes "${draft.evidenceForm}", not "${spelling}". Build the form again, or remove the evidence.`,
      blocking: true,
    });
  const formation = signedFormation(
    draft.formation,
    draft.gismu ? true : (draft.retainedFormationSources ?? false),
    retainedNullPronunciations(draft),
  );
  if (formation)
    formation.sources.forEach((row, i) => {
      if (!language(row.language))
        problems.push({
          field: "formation",
          message: `Source row ${i + 1} has the language "${row.language}", which is not a lowercase BCP 47 tag.`,
          blocking: true,
        });
      if (row.weight) {
        const n = Number(row.weight.numerator);
        const d = Number(row.weight.denominator);
        if (!(n >= 0 && n <= 1_000_000_000 && d >= 1 && d <= 1_000_000_000))
          problems.push({
            field: "formation",
            message: `Source row ${i + 1} has a weight outside 0 to 1,000,000,000 over 1 to 1,000,000,000.`,
            blocking: true,
          });
      }
    });
  if (!draft.kind || !spelling) return { body: null, problems, wordId: null };
  const glosses: Gloss[] = draft.glosses
    .filter((g) => g.text.trim())
    .map((g) => {
      const tag = g.language.trim() || draft.language;
      if (!language(tag))
        problems.push({
          field: "glosses",
          message: `The gloss "${g.text.trim()}" has the language "${tag}", which is not a lowercase BCP 47 tag.`,
          blocking: true,
        });
      return {
        language: tag,
        text: g.text,
        sense: g.sense.trim() ? g.sense : null,
      };
    });
  const body: DefinitionBody = {
    word: { language: "jbo", spelling },
    language: draft.language,
    text,
    frame,
    operands,
    glosses,
    notes,
    etymology: {
      text: etymologyText,
      formation,
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
  // The shared core has the final word, exactly as admission will.
  if (id && !problems.some((pr) => pr.blocking))
    problems.push(...coreProblems(body, id, draft.parents, "native"));
  return { body, problems, wordId: id };
}
/**
 * Fills a draft from a published body, for Revise. Every field of the body
 * has an editor form, so nothing is dropped. The draft changes only what a
 * native revision must change: the parent link, the CC0 license, the native
 * origin, and the imported attribution.
 */
export function draftFromBody(
  body: DefinitionBody,
  parentId: string,
  origin: "native" | "import",
  rawBody: unknown = body,
): Draft {
  const rawFormation = (rawBody as DefinitionBody | null)?.etymology?.formation;
  body = interpretDefinition<DefinitionBody>(body);
  const placeText = (place: Place): DraftPlace => {
    const hint = place.type_hints[0] ?? null;
    const choice = choiceForHint(hint);
    return {
      index: place.index,
      description: structuredClone(place.description),
      glosses: place.glosses.map((g) => ({
        language: g.language,
        text: g.text,
        sense: g.sense ?? "",
      })),
      kind: choice,
      hint: choice === "custom" ? hint : null,
      parentHint: hint ? structuredClone(hint) : null,
      derivations: place.derivation.map((d) => ({
        word: d.word.spelling,
        definition: d.definition,
        place: d.place,
        explanation: structuredClone(d.explanation),
      })),
      defaults: place.defaults.map((d) => ({
        kind: d.kind,
        format: d.value.format,
        language: d.value.format === "prose" ? d.value.language : "",
        text: d.value.text,
        condition: structuredClone(d.condition),
        explanation: structuredClone(d.explanation),
      })),
      constraints: place.constraints.map((c) => structuredClone(c)),
    };
  };
  const frame = body.frame;
  const legacy = body.legacy as { source?: string } | null;
  const sources = [...body.sources];
  let revisedImport: Draft["revisedImport"] = null;
  if (origin === "import") {
    // The parent link keeps the imported attribution. The revision cites the exact
    // imported publication and copies the source-rights reference once.
    revisedImport = { event: parentId, source: legacy?.source ?? "import" };
    sources.unshift({
      label: `Imported publication revised by this definition`,
      url: null,
      event: parentId,
      locator: null,
    });
    const rights = LENSISKU_RIGHTS_REFERENCE;
    if (
      legacy?.source?.includes("lensisku") &&
      !sources.some((s) => s.url === rights.url && s.locator === rights.locator)
    )
      sources.push({ ...rights });
  }
  const tailHint = frame?.tail?.type_hints[0] ?? null;
  const spelling = body.word.spelling;
  const draft = newDraft({
    step: 4,
    meaning: richTextToText(body.text),
    language: body.language,
    spelling,
    kind: body.classification.kind,
    selmaho: [...body.classification.selmaho],
    text: structuredClone(body.text),
    structured: true,
    frameMode: frame ? frame.arity.mode : "none",
    fixedZeroApproved: frame?.arity.mode === "fixed" && frame.arity.count === 0,
    frameRole: frame?.role ?? "predicate",
    variadicMinimum: frame?.arity.mode === "variadic" ? frame.arity.minimum : 0,
    places: frame ? frame.places.map(placeText) : [],
    tail: frame?.tail
      ? {
          description: structuredClone(frame.tail.description),
          kind: choiceForHint(tailHint),
          hint: choiceForHint(tailHint) === "custom" ? tailHint : null,
          parentHint: tailHint ? structuredClone(tailHint) : null,
        }
      : null,
    frameConstraints: frame?.constraints.map((c) => structuredClone(c)) ?? [],
    glosses: body.glosses.map((g) => ({
      language: g.language,
      text: g.text,
      sense: g.sense ?? "",
    })),
    notes: structuredClone(body.notes),
    examples: body.examples.map((e) => ({
      language: e.language,
      text: e.text,
      translation: structuredClone(e.translation),
      notes: structuredClone(e.notes),
    })),
    etymologyText: structuredClone(body.etymology.text),
    formNotes: "",
    formation: body.etymology.formation,
    retainedFormationSources: body.etymology.formation?.sources.map(
      (_, index) => index,
    ),
    retainedWordIpaNullSources: rawFormation?.sources?.flatMap(
      (source, index) => (source.word_ipa === null ? [index] : []),
    ),
    compound: body.etymology.compound,
    evidenceForm:
      body.etymology.formation || body.etymology.compound ? spelling : null,
    sources,
    labels: [...body.labels],
    operands: body.operands.map((o) => ({
      id: o.id,
      category: o.category,
      description: structuredClone(o.description),
      minimum: o.cardinality.minimum,
      maximum: o.cardinality.maximum,
    })),
    parents: [parentId],
    revisedImport,
    numberingApproved: true,
  });
  return draft;
}
/** What a native revision changes in a parent body. Everything else is copied. */
export function revisionChanges(
  body: DefinitionBody,
  origin: "native" | "import",
): string[] {
  body = interpretDefinition<DefinitionBody>(body);
  const changes: string[] = [];
  if (
    body.license.expression !== CC0_LICENSE.expression ||
    body.license.attribution
  )
    changes.push(
      `the license, from ${body.license.expression || "none"} to CC0 1.0 without attribution text`,
    );
  if (body.legacy)
    changes.push(
      "the imported legacy record, which a native revision does not carry",
    );
  if (origin === "import")
    changes.push(
      "the origin, from imported to native, with a source reference to the imported publication",
    );
  return changes;
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
  return fields;
}
