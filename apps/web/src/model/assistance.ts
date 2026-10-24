/** Private browser data for optional draft suggestions. */
import type { Draft } from "./draft.ts";
import { compactJson } from "../../../../packages/service/src/json.ts";
import {
  choiceForHint,
  coreProblems,
  draftToBody,
  hintForChoice,
  signedFormation,
  retainedNullPronunciations,
} from "./draft.ts";
import type { DraftProblem } from "./draft.ts";
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
} from "../../../../packages/core/src/browser.ts";
import {
  componentId,
  formationSource,
  normalizeSourceRow,
  syncFormationSources,
  sourceNotes,
  editSourceNotes,
  sourceReviewMatches,
  type GismuRowState,
  type SourceReview,
} from "./builders.ts";

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
  log?: Record<string, unknown>;
  log_json?: string;
}
export interface AssistanceRecord {
  id: string;
  key: string;
  label: string;
  operation: Operation;
  fingerprint: string;
  requested: Current;
  result: Suggestion | null;
  /** Legacy object logs migrate before the draft is cloned or saved. */
  log: Record<string, unknown> | null;
  log_json?: string;
  log_id?: string;
  error: string | null;
  state: "done" | "failed" | "accepted" | "dismissed" | "undone";
  sourceTarget?: SourceTarget;
  patches?: { path: (string | number)[]; before: unknown; after: unknown }[];
  before?: Partial<Draft>;
  after?: Partial<Draft>;
}
export interface AssistanceData {
  records: AssistanceRecord[];
  changes?: number;
}

/** Revision changes from saving do not make an otherwise unchanged suggestion stale. */
export function draftFingerprint(draft: Draft): string {
  const { revision, updatedAt, ai, retainedWordIpaNullSources, ...fields } =
    draft;
  void revision;
  void updatedAt;
  void ai;
  void retainedWordIpaNullSources;
  return semanticKey({
    ...fields,
    gismu: fields.gismu
      ? {
          ...fields.gismu,
          rows: fields.gismu.rows.map(
            ({ aiNoteGroup, sourceReview, wordIpaNullOriginal, ...row }) => {
              void aiNoteGroup;
              void sourceReview;
              void wordIpaNullOriginal;
              return row;
            },
          ),
        }
      : null,
  })!;
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
    formation:
      body?.etymology.formation ??
      signedFormation(
        draft.formation,
        draft.gismu ? true : (draft.retainedFormationSources ?? false),
        retainedNullPronunciations(draft),
      ),
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
  if (operation === "gismu-sources") sourceProposal(s);
  if (operation === "lujvo" && !s.proposals.some((p) => p.path === "/compound"))
    throw new Error("A lujvo suggestion needs checked components.");
  // Provider metadata can exceed the browser's structured-clone nesting limit.
  // Keep it as JSON text before cloning the ordinary proposal fields.
  return {
    ...structuredClone({
      operation: s.operation,
      draft_revision: s.draft_revision,
      proposals: s.proposals,
      explanation: s.explanation,
      provenance: s.provenance,
      usage: s.usage,
    }),
    log_json: compactJson(s.log),
  };
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
  const baseline =
    result.operation === "definition" || result.operation === "places-glosses"
      ? assistanceProblems(draft)
      : undefined;
  for (const proposal of result.proposals) {
    const value = structuredClone(proposal.value);
    switch (proposal.path) {
      case "/word_type":
        if (draft.kind !== value) draft.selmaho = [];
        draft.kind = value as Draft["kind"];
        delete draft.autoDetectedKind;
        draft.review = draft.review.filter((field) => field !== "word type");
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
    checkAssistanceDraft(draft, baseline);
  }
}

function assistanceProblems(draft: Draft): DraftProblem[] {
  const checked = draftToBody(draft);
  const invalid = checked.problems.filter(
    (p) => p.blocking && p.field !== "numbering",
  );
  if (!checked.body || !checked.wordId) {
    invalid.push({
      field: "body",
      message:
        "Choose the word type and enter its spelling before applying this suggestion.",
      blocking: true,
    });
    return invalid;
  }
  if (checked.body && checked.wordId) {
    for (const problem of coreProblems(
      checked.body,
      checked.wordId,
      draft.parents,
      "native",
    )) {
      if (
        !invalid.some(
          (p) => p.field === problem.field && p.message === problem.message,
        )
      )
        invalid.push(problem);
    }
  }
  return invalid;
}
/** Full and partial acceptance refuse new problems, including repeated problems. */
export function checkAssistanceDraft(
  draft: Draft,
  baseline: DraftProblem[] = [],
) {
  const key = (problem: DraftProblem) =>
    JSON.stringify([problem.field, problem.message]);
  const remaining = new Map<string, number>();
  for (const problem of baseline)
    remaining.set(
      key(problem),
      (remaining.get(key(problem)) ?? 0) + (problem.occurrences ?? 1),
    );
  const invalid = assistanceProblems(draft).filter((problem) => {
    // The core reports only its first body error. The same message can hide
    // a new invalid field, so opaque body errors cannot use the baseline.
    if (problem.field === "body") return true;
    const count = remaining.get(key(problem)) ?? 0;
    const occurrences = problem.occurrences ?? 1;
    if (count < occurrences) return true;
    remaining.set(key(problem), count - occurrences);
    return false;
  });
  if (invalid.length) throw new Error(invalid.map((p) => p.message).join(" "));
}

/** A source action sends exactly one language row, including rows without a word. */
export function sourceCurrent(draft: Draft, id: string | number): Current {
  const row =
    typeof id === "number"
      ? draft.gismu?.rows[id]
      : draft.gismu?.rows.find((r) => r.id === id);
  if (!row) throw new Error("This source row no longer exists.");
  const current = currentDraft(draft);
  current.formation = {
    method: "non-algorithmic",
    algorithm: null,
    sources: [formationSource(row)],
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
export interface SourceTarget {
  id: string;
  index: number;
  language: string;
  row: GismuRowState;
}
export function captureSourceTarget(draft: Draft, id: string): SourceTarget {
  const index = draft.gismu?.rows.findIndex((row) => row.id === id) ?? -1;
  const row = draft.gismu?.rows[index];
  if (!row) throw new Error("This source row no longer exists.");
  return { id, index, language: row.language, row: structuredClone(row) };
}
/** Row order can change after comparison. Changed row values need a new request. */
export function sourceTargetMatches(
  draft: Draft,
  target: SourceTarget,
): boolean {
  const row = draft.gismu?.rows.find((row) => row.id === target.id);
  const values = (row: GismuRowState) => {
    const {
      id,
      aiNoteGroup,
      sourceReview,
      notesStale,
      wordIpaNullOriginal,
      ...value
    } = row;
    void id;
    void aiNoteGroup;
    void sourceReview;
    void notesStale;
    void wordIpaNullOriginal;
    return semanticKey(value);
  };
  return (
    !!row &&
    row.language === target.language &&
    values(row) === values(target.row)
  );
}
/** A source proposal is a partial private edit, separate from a signed source. */
export interface SourceProposal {
  word?: string;
  word_ipa?: string;
  stem?: string;
  ipa?: string;
  input?: { format: "lojbanized"; text: string };
  notes: RichText;
}
export function sourceProposal(result: Suggestion): SourceProposal {
  const sources = result.proposals.find(
    (proposal) => proposal.path === "/formation/sources",
  )?.value;
  const invalid = () => {
    throw new Error("The source suggestion contains invalid draft edits.");
  };
  if (!Array.isArray(sources) || sources.length !== 1) return invalid();
  const source = sources[0];
  if (!source || typeof source !== "object" || Array.isArray(source))
    return invalid();
  const allowed = ["word", "word_ipa", "stem", "ipa", "input", "notes"];
  if (Object.keys(source).some((key) => !allowed.includes(key)))
    return invalid();
  for (const key of ["word", "word_ipa", "stem", "ipa"])
    if (
      Object.hasOwn(source, key) &&
      (typeof source[key] !== "string" || !source[key].trim())
    )
      return invalid();
  if (
    Object.hasOwn(source, "input") &&
    (!source.input ||
      typeof source.input !== "object" ||
      Array.isArray(source.input) ||
      Object.keys(source.input).sort().join(",") !== "format,text" ||
      source.input.format !== "lojbanized" ||
      typeof source.input.text !== "string" ||
      !source.input.text.trim())
  )
    return invalid();
  if (
    !Array.isArray(source.notes) ||
    source.notes.some(
      (paragraph: unknown) =>
        !Array.isArray(paragraph) ||
        paragraph.length !== 1 ||
        typeof paragraph[0] !== "string" ||
        !/^(Sense|Note): [\s\S]*\S[\s\S]*$/.test(paragraph[0]),
    )
  )
    return invalid();
  // A model can provide only one new paragraph for each answer field.
  if (
    new Set(
      source.notes.map((paragraph: string[]) => paragraph[0].split(": ")[0]),
    ).size !== source.notes.length
  )
    return invalid();
  return structuredClone(source) as SourceProposal;
}
/** Replace the tracked AI paragraphs and preserve authored notes in their order. */
function replaceSourceAiNotes(
  row: GismuRowState,
  notes: RichText,
): Set<number> {
  if (!row.aiNoteGroup)
    throw new Error(
      "Identify the earlier AI notes or choose No earlier AI notes before accepting this source.",
    );
  // Direct edits that bypass the ordinary editor also become authored text.
  const before = sourceNotes(row);
  editSourceNotes(row, before);
  const group = new Set(row.aiNoteGroup!.map((entry) => entry.index));
  const insertion = group.size ? Math.min(...group) : before.length;
  const after: RichText = [];
  const retained = new Set<number>();
  let aiStart = 0;
  for (let index = 0; index <= before.length; index++) {
    if (index === insertion) {
      aiStart = after.length;
      after.push(...structuredClone(notes));
    }
    if (index < before.length && !group.has(index)) {
      retained.add(after.length);
      after.push(before[index]);
    }
  }
  // Preserve earlier review marks while their paragraphs move around the AI group.
  for (const mark of row.sourceReview ?? []) {
    if (mark.field !== "notes") continue;
    const preceding = before
      .slice(0, mark.index)
      .filter((_, index) => !group.has(index)).length;
    mark.index = preceding + (mark.index! >= insertion ? notes.length : 0);
  }
  row.sourceReview = row.sourceReview?.filter(
    (mark) => mark.field !== "notes" || retained.has(mark.index!),
  );
  row.notes = after;
  row.aiNoteGroup = notes.map((paragraph, index) => ({
    index: aiStart + index,
    paragraph: structuredClone(paragraph),
  }));
  return retained;
}
export function applySource(
  draft: Draft,
  id: string | number,
  result: Suggestion,
  target?: SourceTarget,
) {
  if (target && !sourceTargetMatches(draft, target))
    throw new Error("This source row changed. Request a new suggestion.");
  const old =
    typeof id === "number"
      ? draft.gismu?.rows[id]
      : draft.gismu?.rows.find((row) => row.id === id);
  if (!old) throw new Error("This source row no longer exists.");
  const source = sourceProposal(result);
  const row = normalizeSourceRow(structuredClone(old));
  const before = formationSource(row);
  const previous = {
    word_ipa: row.word_ipa,
    stem: row.stem,
    ipa: row.ipa,
    input: before.input,
  };
  const retainedNotes = replaceSourceAiNotes(row, source.notes);
  for (const field of ["word", "word_ipa", "stem", "ipa"] as const)
    if (Object.hasOwn(source, field)) row[field] = source[field]!;
  if (Object.hasOwn(source, "word_ipa")) delete row.wordIpaNullOriginal;
  if (source.input) {
    row.input = source.input.text;
    row.inputOriginal = structuredClone(source.input);
  }
  if (source.word !== undefined && source.word !== old.word) {
    const marks: SourceReview[] = [];
    for (const field of ["word_ipa", "stem", "ipa", "input"] as const) {
      const value = previous[field];
      if (
        (typeof value === "string" ? value.trim() : value) &&
        sourceReviewMatches(row, { field, word: old.word, value })
      )
        marks.push({
          field,
          word: old.word,
          value: structuredClone(value),
          ...(field === "input"
            ? {
                inputText: old.input,
                ...(Object.hasOwn(old, "inputOriginal")
                  ? {
                      inputOriginal: structuredClone(old.inputOriginal ?? null),
                    }
                  : {}),
              }
            : {}),
        });
    }
    for (const index of retainedNotes) {
      const paragraph = row.notes![index];
      if (paragraph.length)
        marks.push({
          field: "notes",
          index,
          word: old.word,
          value: structuredClone(paragraph),
        });
    }
    row.sourceReview = marks;
  } else
    row.sourceReview = row.sourceReview?.filter((mark) =>
      sourceReviewMatches(row, mark),
    );
  // Keep legacy editor summaries in sync without deriving note ownership from prefixes.
  const paragraphValue = (label: string) =>
    source.notes.find(
      (paragraph) =>
        typeof paragraph[0] === "string" &&
        paragraph[0].startsWith(`${label}: `),
    )?.[0] as string | undefined;
  row.sense = paragraphValue("Sense")?.slice(7) ?? "";
  row.note = paragraphValue("Note")?.slice(6) ?? "";
  row.notesStale = false;
  if (!row.wordIpaNullOriginal) delete old.wordIpaNullOriginal;
  Object.assign(old, row);
  draft.gismu!.selected = null;
  draft.gismu!.acknowledged = [];
  draft.publishAcknowledged = [];
  syncFormationSources(draft);
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
  let restoredFormation = false;
  const sourceUndos = new Map<
    GismuRowState,
    {
      before: GismuRowState;
      after: GismuRowState;
      marks: SourceReview[] | undefined;
      restored: (string | number)[][];
    }
  >();
  const patches =
    record.patches ??
    Object.keys(record.after ?? {}).map((k) => ({
      path: [k],
      before: (record.before as Record<string, unknown>)[k],
      after: (record.after as Record<string, unknown>)[k],
    }));
  for (const patch of patches) {
    let path = patch.path;
    let sourceUndo: ReturnType<typeof sourceUndos.get>;
    if (path[0] === "gismu" && path[1] === "rows" && path.length > 2) {
      const sourceId =
        record.after?.gismu?.rows[Number(path[2])]?.id ??
        (record.key.startsWith("source-") ? record.key.slice(7) : undefined);
      if (sourceId) {
        const index =
          draft.gismu?.rows.findIndex((row) => row.id === sourceId) ?? -1;
        if (index < 0) {
          kept++;
          continue;
        }
        path = ["gismu", "rows", String(index), ...path.slice(3)];
        const row = draft.gismu!.rows[index];
        const before = record.before?.gismu?.rows.find(
          (row) => row.id === sourceId,
        );
        const after = record.after?.gismu?.rows.find(
          (row) => row.id === sourceId,
        );
        if (before && after) {
          if (!sourceUndos.has(row))
            sourceUndos.set(row, {
              before,
              after,
              marks: structuredClone(row.sourceReview),
              restored: [],
            });
          sourceUndo = sourceUndos.get(row)!;
          // Review arrays contain decisions, so never patch their numeric indexes.
          if (path[3] === "sourceReview") continue;
        }
      }
    }
    let parent: Record<string, unknown> = draft as unknown as Record<
      string,
      unknown
    >;
    for (const key of path.slice(0, -1)) {
      if (!parent || typeof parent !== "object") break;
      parent = parent[key] as Record<string, unknown>;
    }
    const key = path.at(-1)!;
    if (
      parent &&
      typeof parent === "object" &&
      semanticKey(parent[key]) === semanticKey(patch.after)
    ) {
      if (patch.before === undefined) delete parent[key];
      else parent[key] = structuredClone(patch.before);
      if (
        path.length === 1 &&
        path[0] === "formation" &&
        patch.after === null &&
        draft.formation
      )
        restoredFormation = true;
      sourceUndo?.restored.push(path.slice(3));
    } else kept++;
  }
  for (const [row, undo] of sourceUndos) {
    const { before, after, marks, restored } = undo;
    const same = (left: unknown, right: unknown) =>
      semanticKey(left) === semanticKey(right);
    const unchanged = same(marks, after.sourceReview);
    if (!unchanged) kept++;
    const restoredField = (field: string) =>
      restored.some((path) => path[0] === field);
    const restoredValue = (mark: SourceReview) => {
      if (mark.field === "input")
        return (
          (restoredField("input") || restoredField("inputOriginal")) &&
          row.input === before.input &&
          Object.hasOwn(row, "inputOriginal") ===
            Object.hasOwn(before, "inputOriginal") &&
          same(row.inputOriginal, before.inputOriginal)
        );
      return restored.some(
        (path) =>
          path[0] === mark.field &&
          (mark.field !== "notes" ||
            path.length === 1 ||
            Number(path[1]) === mark.index),
      );
    };
    // Pair duplicate paragraphs in order. Their indexes can shift with the AI group.
    const available = new Set(
      (after.sourceReview ?? []).map((_, index) => index),
    );
    const carried = new Map<SourceReview, SourceReview>();
    const identity = ({ index, ...mark }: SourceReview) => {
      void index;
      return semanticKey(mark);
    };
    for (const mark of before.sourceReview ?? []) {
      const index = [...available].find(
        (index) => identity(mark) === identity(after.sourceReview![index]),
      );
      if (index !== undefined) {
        carried.set(mark, after.sourceReview![index]);
        available.delete(index);
      }
    }
    let reviews = unchanged
      ? (before.sourceReview ?? []).filter(
          (mark) =>
            carried.has(mark) ||
            restoredValue(mark) ||
            restoredField("word") ||
            restoredFormation,
        )
      : (marks ?? []).map((mark) => {
          if (
            mark.field === "notes" &&
            restoredField("notes") &&
            same(row.notes, before.notes)
          ) {
            const pair = [...carried].find(([, afterMark]) =>
              same(mark, afterMark),
            );
            if (pair) return pair[0];
          }
          return mark;
        });
    if (!unchanged)
      for (const mark of before.sourceReview ?? [])
        if (
          !carried.has(mark) &&
          restoredValue(mark) &&
          !reviews.some((other) => same(mark, other))
        )
          reviews.push(mark);
    reviews = reviews.filter(
      (mark) =>
        sourceReviewMatches(row, mark) &&
        (mark.field !== "input" ||
          mark.inputText === undefined ||
          row.input === mark.inputText),
    );
    if (
      reviews.length ||
      before.sourceReview !== undefined ||
      (!unchanged && marks !== undefined)
    )
      row.sourceReview = structuredClone(reviews);
    else delete row.sourceReview;
  }
  syncFormationSources(draft);
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
    /^(direct|merged|distributed|functional): [\s\S]*\S/.exec(words)?.[1] ??
    null
  );
}

export type Mapping = NonNullable<
  Current["frame"]
>["places"][number]["derivation"][number];
/** Older partial records used a key without the exact definition. */
export function mappingRecordMatches(
  record: AssistanceRecord,
  key: string,
  legacyKey: string,
  mapping: Mapping,
): boolean {
  if (record.key === key) return true;
  if (record.key !== legacyKey) return false;
  for (const patch of record.patches ?? []) {
    if (patch.path.at(-1) !== "derivations" || !Array.isArray(patch.after))
      continue;
    const before = Array.isArray(patch.before) ? patch.before : [];
    for (const added of patch.after) {
      if (before.some((old) => semanticKey(old) === semanticKey(added)))
        continue;
      if (
        added.word === mapping.word.spelling &&
        added.place === mapping.place &&
        added.definition === mapping.definition
      )
        return true;
    }
  }
  return false;
}
/** A rejected partial proposal leaves the complete author draft untouched. */
export function applyMapping(draft: Draft, index: number, derivation: Mapping) {
  const baseline = assistanceProblems(draft);
  const candidate = { ...draft, places: structuredClone(draft.places) };
  const target = candidate.places.find((p) => p.index === index);
  if (!target) throw new Error("This place no longer exists.");
  target.derivations.push({
    word: derivation.word.spelling,
    definition: derivation.definition,
    place: derivation.place,
    explanation: structuredClone(derivation.explanation),
  });
  checkAssistanceDraft(candidate, baseline);
  draft.places = candidate.places;
}
/** Older mapping records copied the parent result and complete log. */
function shareLegacyMappingLogs(records: AssistanceRecord[]) {
  for (const record of records) {
    const parentKey = record.key.split(":mapping:")[0];
    if (parentKey === record.key || record.log_id || !record.result) continue;
    const revision = record.result.draft_revision;
    const parent = records.find(
      (other) =>
        other.key === parentKey && other.result?.draft_revision === revision,
    );
    if (!parent) continue;
    record.log_id = parent.id;
    record.log = null;
    delete record.log_json;
    record.result = null;
  }
}
/** Store raw metadata once as text. Native clones then see a shallow graph. */
function compactRecordLog(record: AssistanceRecord) {
  const raw = record.result?.log ?? record.log;
  const encoded =
    record.result?.log_json ??
    record.log_json ??
    (raw ? compactJson(raw) : undefined);
  if (encoded !== undefined) record.log_json = encoded;
  record.log = null;
  if (record.result) {
    delete record.result.log;
    delete record.result.log_json;
  }
}
/** Migrate old logs before any native structured clone traverses them. */
export function cloneAssistance(ai: AssistanceData): AssistanceData {
  const copy = {
    ...ai,
    records: ai.records.map((record) => ({
      ...record,
      result: record.result ? { ...record.result } : null,
    })),
  };
  shareLegacyMappingLogs(copy.records);
  for (const record of copy.records) compactRecordLog(record);
  return structuredClone(copy);
}
/** Retain one recent run and one accepted Undo for each action. */
export function retainAssistance(draft: Draft) {
  if (!draft.ai) return;
  shareLegacyMappingLogs(draft.ai.records);
  const latest = new Map<string, AssistanceRecord>();
  const accepted = new Map<string, AssistanceRecord>();
  const sourceKeys = new Set(
    draft.gismu?.rows.map((row) => `source-${row.id}`) ?? [],
  );
  draft.ai.records = draft.ai.records.filter(
    (record) => !record.key.startsWith("source-") || sourceKeys.has(record.key),
  );
  for (const record of draft.ai.records) {
    latest.set(record.key, record);
    if (record.state === "accepted") accepted.set(record.key, record);
  }
  // A removed dynamic control must not keep a private log forever.
  const recent = draft.ai.records
    .filter((record) => latest.get(record.key) === record)
    .slice(-32);
  const retained = new Set([...recent, ...accepted.values()]);
  for (const record of retained) {
    if (record.log_id) {
      const parent = draft.ai.records.find((r) => r.id === record.log_id);
      if (parent) retained.add(parent);
    }
  }
  draft.ai.records = draft.ai.records.filter((r) => retained.has(r));
  for (const record of draft.ai.records) compactRecordLog(record);
}
export function storeAssistanceRecord(draft: Draft, record: AssistanceRecord) {
  draft.ai ??= { records: [] };
  compactRecordLog(record);
  draft.ai.records.push(record);
  retainAssistance(draft);
}
/** Saving compares small record metadata rather than full private exchanges. */
export function assistanceSaveKey(ai: AssistanceData | undefined): unknown {
  return ai ? [ai.changes ?? 0, ai.records.map((r) => [r.id, r.state])] : null;
}
/** Resolve parent references without putting a deep graph back in the draft. */
export function assistanceLog(
  record: AssistanceRecord,
  draft?: Draft,
): Record<string, unknown> {
  if (record.log_json !== undefined)
    return JSON.parse(record.log_json) as Record<string, unknown>;
  if (record.log) return record.log;
  if (record.result?.log_json !== undefined)
    return JSON.parse(record.result.log_json) as Record<string, unknown>;
  if (record.result?.log) return record.result.log;
  const parent = draft?.ai?.records.find((r) => r.id === record.log_id);
  return parent ? assistanceLog(parent) : {};
}
/** Raw export keeps the public object shape and does not indent deep metadata. */
export function assistanceLogJson(
  record: AssistanceRecord,
  draft?: Draft,
): string {
  if (record.log_json !== undefined) return record.log_json;
  const parent = draft?.ai?.records.find((r) => r.id === record.log_id);
  if (parent) return assistanceLogJson(parent);
  return compactJson(assistanceLog(record));
}
export type LogRow = {
  kind: "heading" | "text" | "code" | "link";
  text: string;
  level?: number;
  href?: string;
  collapsed?: boolean;
};
const logJson = compactJson;
function logUsage(usage: Record<string, unknown>): string {
  return [
    usage.input_tokens == null
      ? ""
      : `Input tokens: ${String(usage.input_tokens)}.`,
    usage.output_tokens == null
      ? ""
      : `Output tokens: ${String(usage.output_tokens)}.`,
    usage.cost_usd == null ? "" : `Cost: ${String(usage.cost_usd)} USD.`,
  ]
    .filter(Boolean)
    .join(" ");
}
/** The dialog and Markdown export show exactly these same rows. */
export function assistanceLogRows(
  record: AssistanceRecord,
  log = assistanceLog(record),
): LogRow[] {
  const rows: LogRow[] = [];
  const text = (value: string) => rows.push({ kind: "text", text: value });
  const code = (value: unknown) =>
    rows.push({
      kind: "code",
      text: typeof value === "string" ? value : logJson(value),
    });
  const heading = (value: string, level = 3) =>
    rows.push({ kind: "heading", text: value, level });
  text(
    `${record.label}. Model: ${String(log.model ?? record.result?.provenance.model ?? "unavailable")}. Reasoning level: ${String(log.reasoning_effort ?? "unavailable")}. Provider: ${String(log.provider ?? record.result?.provenance.provider ?? "unavailable")}.`,
  );
  text(
    `Prompt version: ${String(log.prompt_version ?? record.result?.provenance.recipe ?? "unavailable")}.`,
  );
  for (const file of Array.isArray(log.prompt_files) ? log.prompt_files : []) {
    if (
      typeof file === "string" &&
      /^[a-zA-Z0-9_./-]+$/.test(file) &&
      !file.includes("..")
    )
      rows.push({
        kind: "link",
        text: file,
        href: file.startsWith("/api/v1/assist/prompts/")
          ? file
          : `https://github.com/int19h/jbovlacku/blob/main/${file.startsWith("prompts/") ? "" : "prompts/"}${file}`,
      });
  }
  text(
    `Time: ${String(log.started_at ?? "unavailable")}. Duration: ${String(log.duration_ms ?? "unavailable")} ms. Answers: ${String(log.answers ?? 0)}. Corrections: ${String(log.corrections ?? 0)}.`,
  );
  text(logUsage(log));
  text(
    "The provider does not make the assistant’s private reasoning available. This log holds the shared reasoning summary and everything that the assistant wrote.",
  );
  text("This log stays in this browser with the draft. It is never published.");
  if (record.error) text(record.error);
  for (const exchange of (Array.isArray(log.exchanges)
    ? log.exchanges
    : []) as Record<string, unknown>[]) {
    rows.push({
      kind: "heading",
      text: `System prompt: ${String(exchange.task)}`,
      level: 3,
      collapsed: true,
    });
    code(exchange.system_prompt ?? "");
    heading("App request");
    code(exchange.request);
    for (const attempt of (Array.isArray(exchange.attempts)
      ? exchange.attempts
      : []) as Record<string, unknown>[]) {
      heading(`Answer ${String(attempt.attempt)}`);
      text(
        String(
          attempt.reasoning_summary ||
            "No reasoning summary was shared for this answer.",
        ),
      );
      code(attempt.text ?? "");
      heading("Tool call", 4);
      code(attempt.tool_calls);
      const usage =
        attempt.usage && typeof attempt.usage === "object"
          ? (attempt.usage as Record<string, unknown>)
          : {};
      text(
        logUsage({
          input_tokens: usage.prompt_tokens ?? usage.input_tokens,
          output_tokens: usage.completion_tokens ?? usage.output_tokens,
          cost_usd: attempt.cost_usd,
        }),
      );
      heading("App check", 4);
      code(attempt.check);
    }
  }
  return rows;
}
export function assistanceLogMarkdown(
  record: AssistanceRecord,
  log = assistanceLog(record),
): string {
  return [
    `# ${record.label}`,
    ...assistanceLogRows(record, log).map((row) => {
      if (row.kind === "heading")
        return `${"#".repeat(row.level ?? 3)} ${row.text}`;
      if (row.kind === "link") return `[${row.text}](${row.href})`;
      if (row.kind === "text") {
        // Model summaries can contain Markdown delimiters too.
        return row.text.replace(/[\\`*_{}\[\]<>#!|]/g, "\\$&");
      }
      const fence = "`".repeat(
        Math.max(
          3,
          ...Array.from(
            row.text.matchAll(/`+/g),
            (match) => match[0].length + 1,
          ),
        ),
      );
      return `${fence}text\n${row.text}\n${fence}`;
    }),
  ].join("\n\n");
}
