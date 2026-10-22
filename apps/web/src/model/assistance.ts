/** Private browser data for optional draft suggestions. */
import type { Draft } from "./draft.ts";
import {
  choiceForHint,
  coreProblems,
  draftToBody,
  hintForChoice,
} from "./draft.ts";
import type {
  DefinitionBody,
  Compound,
  Formation,
  Frame,
  Gloss,
  RichText,
} from "./types.ts";
import { lexicalKinds } from "./types.ts";
import {
  buildLujvo,
  analyzeWord,
  rafsiPairId,
  wordId,
} from "../../../../packages/core/src/index.ts";
import { componentId, rational } from "./builders.ts";

export type Operation =
  | "type"
  | "lujvo"
  | "gismu-sources"
  | "cmavo-class"
  | "definition"
  | "places-glosses";
export interface Current {
  word_type: string | null;
  classification: DefinitionBody["classification"] | null;
  spelling: string | null;
  text: RichText;
  frame: Frame | null;
  glosses: Gloss[];
  formation: Formation | null;
  compound: Compound | null;
}
export interface Suggestion {
  operation: Operation;
  draft_revision: string;
  proposals: { path: string; value: unknown }[];
  explanation: string;
  provenance: {
    provider: string;
    model: string;
    revision: string | null;
    recipe: string;
    seed: number | null;
  };
  usage: { input_tokens: number | null; output_tokens: number | null } | null;
  log: Record<string, unknown>;
}
export interface AssistanceRecord {
  id: string;
  key: string;
  label: string;
  operation: Operation;
  fingerprint: string;
  requested: Current;
  result: Suggestion | null;
  log: Record<string, unknown> | null;
  error: string | null;
  state: "done" | "failed" | "accepted" | "dismissed" | "undone";
  patches?: { path: (string | number)[]; before: unknown; after: unknown }[];
  before?: Partial<Draft>;
  after?: Partial<Draft>;
}
export interface AssistanceData {
  records: AssistanceRecord[];
}

/** Revision changes from saving do not make an otherwise unchanged suggestion stale. */
export function draftFingerprint(draft: Draft): string {
  const { revision, updatedAt, ai, ...fields } = draft;
  void revision;
  void updatedAt;
  void ai;
  return semanticKey(fields)!;
}
export function currentDraft(draft: Draft): Current {
  const body = draftToBody(draft).body;
  const gloss = (g: Draft["glosses"][number]): Gloss => ({
    ...g,
    sense: g.sense || null,
  });
  const frame: Frame | null =
    draft.frameMode === "none"
      ? null
      : {
          role: draft.frameRole,
          arity:
            draft.frameMode === "fixed"
              ? { mode: "fixed", count: draft.places.length }
              : draft.frameMode === "variadic"
                ? { mode: "variadic", minimum: draft.variadicMinimum }
                : { mode: "context" },
          places: draft.places.map((p) => ({
            index: p.index,
            description: p.description,
            glosses: p.glosses.map(gloss),
            type_hints: (p.kind === "custom" ? p.hint : hintForChoice(p.kind))
              ? [(p.kind === "custom" ? p.hint : hintForChoice(p.kind))!]
              : [],
            defaults: p.defaults.map((d) => ({
              kind: d.kind,
              value:
                d.format === "lojban"
                  ? { format: "lojban" as const, text: d.text }
                  : {
                      format: "prose" as const,
                      language: d.language,
                      text: d.text,
                    },
              condition: d.condition,
              explanation: d.explanation,
            })),
            constraints: p.constraints,
            derivation: p.derivations
              .filter((d) => d.place !== null)
              .map((d) => ({
                word: { language: "jbo" as const, spelling: d.word },
                definition: d.definition,
                place: d.place!,
                explanation: d.explanation,
              })),
          })),
          tail: draft.tail
            ? {
                from: draft.variadicMinimum + 1,
                description: draft.tail.description,
                type_hints: draft.tail.hint ? [draft.tail.hint] : [],
              }
            : null,
          constraints: draft.frameConstraints,
        };
  return structuredClone({
    word_type: draft.kind,
    classification: draft.kind
      ? { kind: draft.kind, selmaho: draft.selmaho }
      : null,
    spelling: draft.spelling || null,
    text: draft.text,
    frame: body?.frame ?? frame,
    glosses: draft.glosses.map(gloss),
    formation: draft.formation,
    compound: draft.compound,
  });
}
const roots: Record<Operation, string[]> = {
  type: ["/word_type"],
  lujvo: ["/spelling", "/compound"],
  "gismu-sources": ["/formation/sources"],
  "cmavo-class": ["/classification/selmaho"],
  definition: ["/text"],
  "places-glosses": ["/frame", "/glosses"],
};
/** Reject fields that the chosen action cannot change before any apply control appears. */
export function validateSuggestion(
  value: unknown,
  operation: Operation,
  revision: string,
): Suggestion {
  const s = value as Suggestion;
  if (
    !s ||
    s.operation !== operation ||
    s.draft_revision !== revision ||
    !Array.isArray(s.proposals) ||
    !s.proposals.length ||
    typeof s.explanation !== "string" ||
    !s.provenance ||
    typeof s.provenance.provider !== "string" ||
    typeof s.provenance.model !== "string" ||
    typeof s.provenance.recipe !== "string" ||
    !s.log ||
    typeof s.log !== "object"
  )
    throw new Error("The server returned an invalid suggestion.");
  const seen = new Set<string>();
  for (const p of s.proposals) {
    if (!p || !roots[operation].includes(p.path) || seen.has(p.path))
      throw new Error("The suggestion changes a field outside this action.");
    seen.add(p.path);
    if (p.path === "/word_type" && !lexicalKinds.includes(p.value as never))
      throw new Error("The suggested word type is invalid.");
    if (
      p.path === "/spelling" &&
      (typeof p.value !== "string" || !p.value.trim())
    )
      throw new Error("The suggested spelling is invalid.");
    if (
      p.path === "/classification/selmaho" &&
      (!Array.isArray(p.value) ||
        !p.value.length ||
        p.value.some((v) => typeof v !== "string" || !v.trim()))
    )
      throw new Error("The suggested selma'o is invalid.");
  }
  if (operation === "lujvo" && !s.proposals.some((p) => p.path === "/compound"))
    throw new Error("A lujvo suggestion needs checked components.");
  return structuredClone(s);
}
export function applyFrame(draft: Draft, frame: Frame | null) {
  draft.frameMode = frame?.arity.mode ?? "none";
  draft.frameRole = frame?.role ?? "predicate";
  draft.variadicMinimum =
    frame?.arity.mode === "variadic" ? frame.arity.minimum : 0;
  draft.fixedZeroApproved =
    frame?.arity.mode === "fixed" && frame.arity.count === 0;
  draft.places = (frame?.places ?? []).map((p) => ({
    index: p.index,
    description: p.description,
    glosses: p.glosses.map((g) => ({ ...g, sense: g.sense ?? "" })),
    kind: choiceForHint(p.type_hints[0] ?? null),
    hint: p.type_hints[0] ?? null,
    derivations: p.derivation.map((d) => ({
      word: d.word.spelling,
      definition: d.definition,
      place: d.place,
      explanation: d.explanation,
    })),
    defaults: p.defaults.map((d) => ({
      kind: d.kind,
      format: d.value.format,
      language: d.value.format === "prose" ? d.value.language : "",
      text: d.value.text,
      condition: d.condition,
      explanation: d.explanation,
    })),
    constraints: p.constraints,
  }));
  draft.tail = frame?.tail
    ? {
        description: frame.tail.description,
        kind: choiceForHint(frame.tail.type_hints[0] ?? null),
        hint: frame.tail.type_hints[0] ?? null,
      }
    : null;
  draft.frameConstraints = frame?.constraints ?? [];
  draft.numberingApproved = false;
}
/** Proposals remain ordinary editable data. Publication uses the existing signer. */
export function applyProposals(draft: Draft, result: Suggestion) {
  for (const proposal of result.proposals) {
    const value = structuredClone(proposal.value);
    switch (proposal.path) {
      case "/word_type":
        if (draft.kind !== value) draft.selmaho = [];
        draft.kind = value as Draft["kind"];
        break;
      case "/classification/selmaho":
        draft.selmaho = value as string[];
        break;
      case "/text":
        draft.text = value as RichText;
        break;
      case "/frame":
        applyFrame(draft, value as Frame | null);
        break;
      case "/glosses":
        draft.glosses = (value as Gloss[]).map((g) => ({
          ...g,
          sense: g.sense ?? "",
        }));
        break;
      case "/spelling":
        draft.spelling = value as string;
        draft.publishAcknowledged = [];
        break;
      case "/compound": {
        const compound = value as Compound;
        if (
          !compound ||
          !Array.isArray(compound.components) ||
          compound.components.length < 2
        )
          throw new Error("The suggested components are invalid.");
        const components = compound.components.map((c) => ({
          id: componentId(),
          spelling: c.word.spelling,
          kind: analyzeWord(draft.lujvo?.profile ?? "cll", c.word.spelling)
            .kind,
          definition: c.definition,
          gloss: "",
          claims: c.rafsi
            ? [{ rafsi: c.rafsi, pair: rafsiPairId(wordId(c.word), c.rafsi) }]
            : [],
          locked: c.rafsi || null,
        }));
        const built = buildLujvo({
          profile: draft.lujvo?.profile ?? "cll",
          components,
          inventory: { snapshot: null, claims: [] },
          limits: { choice_product: 20000, results: 64 },
        });
        const spelling = result.proposals.find(
          (p) => p.path === "/spelling",
        )?.value;
        if (spelling && !built.candidates.some((c) => c.spelling === spelling))
          throw new Error(
            "The proposed form does not match its deterministic construction.",
          );
        draft.lujvo = {
          ...draft.lujvo,
          profile: draft.lujvo?.profile ?? "cll",
          components,
          selected: typeof spelling === "string" ? spelling : null,
          acknowledged: [],
        };
        // The builder supplies formation evidence only after the author uses a checked candidate.
        draft.compound = null;
        draft.evidenceForm = null;
        break;
      }
    }
  }
  if (
    result.operation === "definition" ||
    result.operation === "places-glosses"
  ) {
    const checked = draftToBody(draft);
    const invalid = checked.problems.filter(
      (p) => p.blocking && p.field !== "numbering",
    );
    if (checked.body && checked.wordId)
      invalid.push(
        ...coreProblems(checked.body, checked.wordId, draft.parents, "native"),
      );
    if (invalid.length)
      throw new Error(invalid.map((p) => p.message).join(" "));
  }
}

/** A source action sends exactly one language row, including rows without a word. */
export function sourceCurrent(draft: Draft, index: number): Current {
  const row = draft.gismu!.rows[index];
  const current = currentDraft(draft);
  current.formation = {
    method: "non-algorithmic",
    algorithm: null,
    sources: [
      {
        language: row.language,
        word: row.word,
        input: row.input ? { format: "lojbanized", text: row.input } : null,
        weight: row.weight ? rational(row.weight) : null,
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
  };
  return current;
}
export function applySource(draft: Draft, index: number, result: Suggestion) {
  const sources = result.proposals.find((p) => p.path === "/formation/sources")
    ?.value as Formation["sources"];
  const old = draft.gismu?.rows[index];
  if (
    !old ||
    !Array.isArray(sources) ||
    sources.length !== 1 ||
    sources[0].language !== old.language ||
    typeof sources[0].word !== "string" ||
    !(
      sources[0].input === null ||
      (sources[0].input.format === "lojbanized" &&
        typeof sources[0].input.text === "string")
    )
  )
    throw new Error("The source suggestion does not match this language row.");
  const source = sources[0];
  const rows = draft.gismu!.rows;
  const notes = source.notes
    .flat()
    .filter((n) => typeof n === "string")
    .join("\n");
  const labels = ["Sense", "Word IPA", "Stem", "Stem IPA", "Note"];
  const extract = (label: string) => {
    const pattern = (name: string) =>
      new RegExp(`(?:^|\\n)${name}:[ \t]*`, "i").exec(notes);
    const match = pattern(label);
    if (!match) return "";
    const start = match.index + match[0].length;
    const following = labels
      .slice(labels.indexOf(label) + 1)
      .map(pattern)
      .filter(
        (entry): entry is RegExpExecArray => !!entry && entry.index >= start,
      );
    const end = following.length
      ? Math.min(...following.map((entry) => entry.index))
      : notes.length;
    return notes.slice(start, end).trim();
  };
  rows[index] = {
    ...old,
    word: source.word,
    input: source.input?.text ?? "",
    sense: extract("Sense"),
    wordIpa: extract("Word IPA"),
    stem: extract("Stem"),
    stemIpa: extract("Stem IPA"),
    note: extract("Note") || notes,
  };
  draft.gismu!.selected = null;
  draft.gismu!.acknowledged = [];
  draft.publishAcknowledged = [];
}

/** Rich-field IDs belong to the editor, so they do not change a field value. */
function semanticKey(value: unknown): string | undefined {
  return JSON.stringify(value, (key, item) => {
    if (key === "richFieldIds") return undefined;
    if (item && typeof item === "object" && !Array.isArray(item))
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((k) => [k, item[k]]),
      );
    return item;
  });
}
/** Undo changes only the accepted fields whose values still match the suggestion. */
export function undoPatches(
  before: unknown,
  after: unknown,
  path: (string | number)[] = [],
): NonNullable<AssistanceRecord["patches"]> {
  if (semanticKey(before) === semanticKey(after)) return [];
  if (
    before &&
    after &&
    typeof before === "object" &&
    typeof after === "object" &&
    Array.isArray(before) === Array.isArray(after) &&
    (!Array.isArray(before) || before.length === (after as unknown[]).length)
  ) {
    return [
      ...new Set([...Object.keys(before), ...Object.keys(after)]),
    ].flatMap((k) =>
      undoPatches(
        (before as Record<string, unknown>)[k],
        (after as Record<string, unknown>)[k],
        [...path, k],
      ),
    );
  }
  return [
    { path, before: structuredClone(before), after: structuredClone(after) },
  ];
}
export function restorePatches(draft: Draft, record: AssistanceRecord): number {
  let kept = 0;
  const patches =
    record.patches ??
    Object.keys(record.after ?? {}).map((k) => ({
      path: [k],
      before: (record.before as Record<string, unknown>)[k],
      after: (record.after as Record<string, unknown>)[k],
    }));
  for (const patch of patches) {
    let parent: Record<string, unknown> = draft as unknown as Record<
      string,
      unknown
    >;
    for (const key of patch.path.slice(0, -1)) {
      if (!parent || typeof parent !== "object") break;
      parent = parent[key] as Record<string, unknown>;
    }
    const key = patch.path.at(-1)!;
    if (
      parent &&
      typeof parent === "object" &&
      semanticKey(parent[key]) === semanticKey(patch.after)
    ) {
      if (patch.before === undefined) delete parent[key];
      else parent[key] = structuredClone(patch.before);
    } else kept++;
  }
  return kept;
}

export function hintLabel(hint: import("./types.ts").TypeHint | null): string {
  return (
    hint?.alternatives
      .map((a) =>
        a.tags
          .map((tag) => (tag === "referent" ? "object" : tag))
          .join(" and "),
      )
      .filter(Boolean)
      .join(" or ") || "unspecified"
  );
}
export function mappingKind(explanation: RichText): string | null {
  const words = explanation
    .flat()
    .filter((n) => typeof n === "string")
    .join(" ");
  return (
    /^(direct|merged|distributed|functional):/i
      .exec(words.trim())?.[1]
      .toLowerCase() ?? null
  );
}
