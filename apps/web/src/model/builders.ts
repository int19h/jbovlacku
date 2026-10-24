/**
 * Builder state kept in the draft, inventories from the local package, and
 * the formation and compound metadata that a chosen form records.
 */
import {
  generateGismu,
  rafsiPairId,
  wordId,
  type BuilderPreset,
  type GismuCandidate,
  type GismuResult,
  type LujvoCandidate,
  type LujvoResult,
  type MorphologyProfile,
  type RafsiInventoryClaim,
} from "../../../../packages/core/src/index.ts";
import type { CachedPackage } from "../data/search.ts";
import type {
  Compound,
  Formation,
  FormationSource,
  RichText,
} from "./types.ts";
import { textToRichText } from "./richtext.ts";

/** One component row of the lujvo builder. */
export interface LujvoComponentState {
  id: string;
  spelling: string;
  kind: string;
  /** The exact source definition, when the author chose one. */
  definition: string | null;
  /** The definitions the package lists for the word, for that choice. */
  definitions?: { event: string; summary: string }[];
  gloss: string;
  /** Known rafsi claims of the word, from the package or entered by hand. */
  claims: { rafsi: string; pair: string }[];
  locked: string | null;
  unresolvedSource?: string;
}
export interface LujvoState {
  profile: MorphologyProfile;
  /** Exact spelling and boundary locks for a typed lujvo. */
  typed?: string;
  typedReading?: import("../../../../packages/core/src/index.ts").RecoveredPart[];
  readingIndex?: number;
  joins?: (string | null)[];
  components: LujvoComponentState[];
  /** The chosen candidate spelling, when the author chose one. */
  selected: string | null;
  /** Conflict keys bound to the chosen spelling, snapshot, and competing claims. */
  acknowledged: string[];
}
export interface GismuRowState {
  /** Stable browser identity. Older drafts receive it when they open. */
  id?: string;
  sense?: string;
  note?: string;
  /** Supplementary evidence, retained without parsing it into signed fields. */
  notes?: RichText;
  notesStale?: boolean;
  /** Absent on older drafts until the author identifies earlier AI paragraphs. */
  aiNoteGroup?: { index: number; paragraph: RichText[number] }[];
  /** Retained evidence that the author must approve for a changed source word. */
  sourceReview?: SourceReview[];
  language: string;
  name: string;
  word: string;
  word_ipa?: string | null;
  /** Only an explicit null copied from signed history keeps its field presence. */
  wordIpaNullOriginal?: true;
  stem?: string | null;
  ipa?: string | null;
  input: string;
  /** Original signed input, separate from the supported scoring letters. */
  inputOriginal?: FormationSource["input"];
  weight: { numerator: string; denominator: string } | null;
}
export interface SourceReview {
  field: "word_ipa" | "stem" | "ipa" | "input" | "notes";
  index?: number;
  word: string;
  value: unknown;
  /** Preserve the private scoring preview and original-input presence on Keep. */
  inputText?: string;
  inputOriginal?: FormationSource["input"];
}
/** Migrate browser aliases only when the signed field is absent, including null. */
export function normalizeSourceRow(row: GismuRowState): GismuRowState {
  const { wordIpa, stemIpa, ...canonical } = row as GismuRowState & {
    wordIpa?: string;
    stemIpa?: string;
  };
  canonical.id ||= sourceRowId();
  if (!Object.hasOwn(row, "word_ipa") && wordIpa) canonical.word_ipa = wordIpa;
  if (!Object.hasOwn(row, "ipa") && stemIpa) canonical.ipa = stemIpa;
  if (canonical.word_ipa !== null) delete canonical.wordIpaNullOriginal;
  return canonical;
}
/** Browser identity never enters the signed formation source. */
export function sourceRowId(): string {
  return `s${crypto.randomUUID()}`;
}
export function sourceRowKey(row: GismuRowState): string {
  return `source-${(row.id ||= sourceRowId())}`;
}
/** Open signed evidence without guessing scoring letters or pronunciation. */
export function sourceRowsFromFormation(
  sources: FormationSource[],
  nullPronunciations = sources.flatMap((source, index) =>
    source.word_ipa === null ? [index] : [],
  ),
): GismuRowState[] {
  return sources.map((source, index) =>
    normalizeSourceRow({
      ...structuredClone(source),
      name: source.language,
      input: source.input?.format === "lojbanized" ? source.input.text : "",
      inputOriginal: structuredClone(source.input ?? null),
      ...(source.word_ipa === null && nullPronunciations.includes(index)
        ? { wordIpaNullOriginal: true as const }
        : {}),
      aiNoteGroup: [],
      weight: source.weight
        ? {
            numerator: String(source.weight.numerator),
            denominator: String(source.weight.denominator),
          }
        : null,
    }),
  );
}
/** Start another word without copying its evidence or private review state. */
export function alternativeSourceRow(row: GismuRowState): GismuRowState {
  return {
    id: sourceRowId(),
    language: row.language,
    name: row.name,
    word: "",
    input: "",
    word_ipa: null,
    stem: null,
    ipa: null,
    weight: row.weight ? { ...row.weight } : null,
    aiNoteGroup: [],
  };
}
/** The author identifies earlier AI notes without relying on paragraph prefixes. */
export function setSourceAiNoteGroup(row: GismuRowState, indexes: number[]) {
  const notes = sourceNotes(row);
  if (indexes.some((index) => !Number.isInteger(index) || !notes[index]))
    throw new Error("Choose existing paragraphs for the earlier AI notes.");
  row.aiNoteGroup = [...new Set(indexes)]
    .sort((a, b) => a - b)
    .map((index) => ({
      index,
      paragraph: structuredClone(notes[index]),
    }));
}
const sameValue = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);
/** Edited AI paragraphs become authored notes. Exact retained paragraphs keep their group. */
export function editSourceNotes(row: GismuRowState, notes: RichText) {
  const before = sourceNotes(row);
  if (sameValue(before, notes)) {
    row.aiNoteGroup = row.aiNoteGroup?.filter((entry) =>
      sameValue(before[entry.index], entry.paragraph),
    );
    row.notes = structuredClone(notes);
    return;
  }
  const available = new Set(notes.map((_, index) => index));
  const mapped = new Map<number, number>();
  // Match exact paragraphs in their original order, including duplicate text.
  for (let oldIndex = 0; oldIndex < before.length; oldIndex++) {
    const index = [...available].find((index) =>
      sameValue(before[oldIndex], notes[index]),
    );
    if (index === undefined) continue;
    mapped.set(oldIndex, index);
    available.delete(index);
  }
  if (row.aiNoteGroup)
    row.aiNoteGroup = row.aiNoteGroup.flatMap((entry) => {
      const index = mapped.get(entry.index);
      const copiesBefore = before.filter((paragraph) =>
        sameValue(paragraph, entry.paragraph),
      ).length;
      const copiesAfter = notes.filter((paragraph) =>
        sameValue(paragraph, entry.paragraph),
      ).length;
      return copiesBefore === copiesAfter &&
        index !== undefined &&
        sameValue(before[entry.index], entry.paragraph)
        ? [{ index, paragraph: structuredClone(notes[index]) }]
        : [];
    });
  row.sourceReview = (row.sourceReview ?? []).flatMap((mark) => {
    if (mark.field !== "notes") return [mark];
    const index = mapped.get(mark.index!);
    return index === undefined ? [] : [{ ...mark, index }];
  });
  row.notes = structuredClone(notes);
}
export function sourceReviewMarks(row: GismuRowState): SourceReview[] {
  return row.sourceReview ?? [];
}
/** A review applies only to the exact retained value that the author saw. */
export function sourceReviewMatches(
  row: GismuRowState,
  mark: SourceReview,
): boolean {
  if (mark.field === "input") {
    const input = formationSource(row).input;
    const retained = mark.value as FormationSource["input"];
    return input === null
      ? retained === null
      : input.format === retained?.format && input.text === retained?.text;
  }
  const value =
    mark.field === "notes" ? sourceNotes(row)[mark.index!] : row[mark.field];
  return sameValue(value, mark.value);
}
/** Keep approves one retained value. Clear removes only that value. */
export function resolveSourceReview(
  row: GismuRowState,
  markIndex: number,
  action: "keep" | "clear",
) {
  const mark = row.sourceReview?.[markIndex];
  if (!mark) throw new Error("This source review no longer exists.");
  const matches =
    sourceReviewMatches(row, mark) &&
    (mark.field !== "input" ||
      mark.inputText === undefined ||
      row.input === mark.inputText);
  if (action === "keep" && matches) {
    if (mark.field === "input") {
      const value = structuredClone(mark.value) as FormationSource["input"];
      row.input =
        mark.inputText ?? (value?.format === "lojbanized" ? value.text : "");
      if (Object.hasOwn(mark, "inputOriginal"))
        row.inputOriginal = structuredClone(mark.inputOriginal ?? null);
      else if (mark.inputText !== undefined) delete row.inputOriginal;
      else row.inputOriginal = value;
    }
  } else if (action === "clear" && matches) {
    if (mark.field === "notes") {
      const index = mark.index!;
      const notes = sourceNotes(row);
      notes.splice(index, 1);
      row.notes = notes;
      row.aiNoteGroup = row.aiNoteGroup?.flatMap((entry) =>
        entry.index === index
          ? []
          : [
              {
                ...entry,
                index: entry.index > index ? entry.index - 1 : entry.index,
              },
            ],
      );
      for (const other of row.sourceReview!)
        if (other.field === "notes" && other.index! > index) other.index!--;
    } else if (mark.field === "input") {
      row.input = "";
      row.inputOriginal = null;
    } else row[mark.field] = null;
  }
  if (mark.field === "word_ipa" && matches) delete row.wordIpaNullOriginal;
  row.sourceReview!.splice(markIndex, 1);
}
export interface GismuState {
  preset: string | null;
  rows: GismuRowState[];
  candidates: "source-letters" | "all-letters";
  selected: string | null;
  manual: string;
  /** Root conflict keys bound to the chosen spelling and snapshot. */
  acknowledged: string[];
  reason: string;
  window: number;
}
export const newLujvoState = (): LujvoState => ({
  profile: "extended",
  components: [],
  selected: null,
  acknowledged: [],
});
export const newGismuState = (): GismuState => ({
  preset: null,
  rows: [],
  candidates: "source-letters",
  selected: null,
  manual: "",
  acknowledged: [],
  reason: "",
  window: 12,
});
let counter = 0;
export function componentId(): string {
  return `c${Date.now().toString(36)}${(counter++).toString(36)}`;
}
export interface PackageInventory {
  snapshot: string | null;
  /** Every rafsi claim in the package, across every word type. Empty for version 1 packages. */
  claims: RafsiInventoryClaim[];
  gismu: { spelling: string; word: string }[];
  /** Whether the package carries rafsi claims at all. */
  hasClaims: boolean;
  /**
   * Words whose rafsi list the server cut at its bound. Their claims in
   * `claims` are a sample, not the complete set. Empty when `complete`.
   */
  incompleteWords: { word: string; spelling: string }[];
  /** False when any word's rafsi list was cut. A cut inventory is not a complete conflict check. */
  complete: boolean;
}
/** The cached package with the most entries, preferring version 2, for inventories and search. */
export async function cachedPackage(store: {
  list<T>(name: string): Promise<T[]>;
}): Promise<CachedPackage | null> {
  try {
    const all = await store.list<CachedPackage>("packages");
    return (
      all.sort(
        (a, b) =>
          (b.version ?? 1) - (a.version ?? 1) ||
          b.entries.length - a.entries.length,
      )[0] ?? null
    );
  } catch {
    return null;
  }
}
/** The conflict inventory from the local package. */
export function inventoryFromPackage(
  cached: CachedPackage | null,
): PackageInventory {
  if (!cached)
    return {
      snapshot: null,
      claims: [],
      gismu: [],
      hasClaims: false,
      incompleteWords: [],
      complete: true,
    };
  const claims = new Map<string, RafsiInventoryClaim>();
  const gismu = new Map<string, string>();
  const incomplete = new Map<string, string>();
  let hasClaims = false;
  for (const entry of cached.entries) {
    const id = wordId({ language: "jbo", spelling: entry.word.spelling });
    const kind = (entry.classification as { kind?: string } | null)?.kind;
    if (kind === "gismu") gismu.set(id, entry.word.spelling);
    if ("rafsi" in entry && Array.isArray(entry.rafsi)) {
      hasClaims = true;
      if ((entry as { rafsi_complete?: boolean }).rafsi_complete === false)
        incomplete.set(id, entry.word.spelling);
      for (const rafsi of entry.rafsi) {
        const pair = rafsiPairId(id, rafsi);
        claims.set(pair, {
          rafsi,
          word: id,
          spelling: entry.word.spelling,
          pair,
        });
      }
    }
  }
  return {
    snapshot: cached.snapshot,
    claims: [...claims.values()],
    gismu: [...gismu.entries()].map(([word, spelling]) => ({ spelling, word })),
    hasClaims,
    incompleteWords: [...incomplete.entries()].map(([word, spelling]) => ({
      word,
      spelling,
    })),
    complete: incomplete.size === 0,
  };
}
/** The limits of the downloaded rafsi inventory, shared by builders and Publish. */
export function inventoryCoverage(inventory: PackageInventory): string {
  if (!inventory.snapshot)
    return "No local package is downloaded, so conflict coverage is unknown.";
  if (!inventory.hasClaims)
    return "The local package carries no rafsi claims, so rafsi conflict coverage is unknown.";
  return `Competing claims come from the local package of snapshot ${inventory.snapshot.slice(7, 19)}…. They cover retained claims in that package only.${
    inventory.complete
      ? ""
      : ` The package lists at most 64 claims per word, so coverage is incomplete for ${inventory.incompleteWords.map((w) => w.spelling).join(", ")}. Missing claims are unknown. The word page of each lists every claim.`
  }`;
}
/** A review belongs to one spelling, snapshot, and complete group of known conflicts. */
export function conflictReviewKey(
  spelling: string,
  snapshot: string | null,
  group: string,
  conflicts: string[],
): string {
  return JSON.stringify([
    spelling,
    snapshot,
    group,
    [...new Set(conflicts)].sort(),
  ]);
}
export function rootConflictKey(
  spelling: string,
  conflict: { word: string; rule: string },
  snapshot: string | null,
): string {
  return conflictReviewKey(spelling, snapshot, "root", [
    `${conflict.word}|${conflict.rule}`,
  ]);
}
export function lujvoConflictKey(
  spelling: string,
  conflict: { rafsi: string; pair: string },
  conflicts: { rafsi: string; pair: string }[],
  snapshot: string | null,
): string {
  return conflictReviewKey(
    spelling,
    snapshot,
    `component:${conflict.rafsi}:${conflict.pair}`,
    conflicts.filter((c) => c.rafsi === conflict.rafsi).map((c) => c.pair),
  );
}
/** Checks roots without source evidence. The synthetic scoring run is never saved. */
export function currentRootConflicts(
  spelling: string,
  inventory: PackageInventory,
) {
  return (
    generateGismu({
      sources: [
        {
          language: "jbo",
          word: spelling,
          input: spelling,
          weight: { numerator: "1", denominator: "1" },
        },
      ],
      candidates: "source-letters",
      inventory: {
        snapshot: inventory.snapshot,
        gismu: inventory.gismu,
        claims: [],
      },
      window: 1,
      manual: spelling,
      limits: { work: 60_000_000 },
    }).manual?.conflicts ?? []
  );
}
/** Compare the saved compound, including revisions that have no builder state. */
export function currentCompoundConflicts(
  compound: Compound,
  inventory: PackageInventory,
) {
  return inventory.claims.filter((claim) =>
    compound.components.some(
      (component) =>
        // The core offers only short assigned rafsi. Long forms are automatic morphology.
        (component.rafsi.length === 3 ||
          /^[bcdfgjklmnprstvxz][aeiou]'[aeiou]$/.test(component.rafsi)) &&
        component.rafsi === claim.rafsi &&
        wordId(component.word) !== claim.word,
    ),
  );
}
/** Compound metadata for a chosen lujvo candidate. Joins stay out of the rafsi fields. */
export function compoundMetadata(
  result: LujvoResult,
  candidate: LujvoCandidate,
  components: LujvoComponentState[],
  notes: string,
): Compound {
  return {
    components: candidate.parts.map((part) => {
      const component = components.find((c) => c.id === part.id);
      return {
        word: { language: "jbo", spelling: component?.spelling.trim() ?? "" },
        definition: component?.definition ?? null,
        rafsi: part.form,
      };
    }),
    morphology: { ...result.morphology },
    scoring: { ...result.scoring },
    score: candidate.score,
    notes: textToRichText(notes, false),
  };
}
/** A section 8 rational in lowest terms, as the body rules require. */
export function rational(value: { numerator: string; denominator: string }) {
  let a = BigInt(value.numerator);
  let b = BigInt(value.denominator);
  let x = a;
  let y = b;
  while (y) [x, y] = [y, x % y];
  if (x > 1n) {
    a /= x;
    b /= x;
  }
  return { numerator: Number(a), denominator: Number(b) };
}
/** Keep supplementary notes separate from pronunciation and private stem fields. */
export function sourceNotes(row: GismuRowState) {
  if (row.notes) return structuredClone(row.notes);
  return [
    ["Sense", row.sense],
    ["Note", row.note],
  ]
    .filter(([, value]) => value)
    .map(([label, value]) => [`${label}: ${value}`]);
}
/** Keep source evidence separate from the letters used for scoring. */
export function formationSource(raw: GismuRowState): FormationSource {
  const row = normalizeSourceRow(raw);
  const source: FormationSource = {
    language: row.language,
    word: row.word,
    input: Object.hasOwn(row, "inputOriginal")
      ? structuredClone(row.inputOriginal ?? null)
      : row.input.trim()
        ? { format: "lojbanized", text: row.input }
        : null,
    weight: row.weight ? rational(row.weight) : null,
    notes: sourceNotes(row),
  };
  if (
    (row.word_ipa === null && row.wordIpaNullOriginal) ||
    row.word_ipa?.trim()
  )
    source.word_ipa = row.word_ipa;
  return source;
}
/** Compare interpreted evidence without changing exact input or note text. */
export function sameFormationSources(
  left: FormationSource[],
  right: FormationSource[],
): boolean {
  const key = (sources: FormationSource[]) =>
    JSON.stringify(
      sources.map((source) => ({
        ...source,
        input: source.input ?? null,
        weight: source.weight ?? null,
        notes: source.notes ?? [],
        word_ipa: source.word_ipa?.trim() ? source.word_ipa : null,
      })),
      (_name, value) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(
              Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
            )
          : value,
    );
  return key(left) === key(right);
}
/** Only language, exact algorithm input, and weight determine the source score. */
export function sameScoringSources(
  left: FormationSource[],
  right: FormationSource[],
): boolean {
  const scoring = (sources: FormationSource[]) =>
    sources.map((source) => ({
      language: source.language,
      word: "",
      input: source.input,
      weight: source.weight,
      notes: [],
    }));
  return sameFormationSources(scoring(left), scoring(right));
}
/** Ignore empty editor rows when building source evidence. */
export function formationSourcesFromRows(
  rows: GismuRowState[],
): FormationSource[] {
  return rows
    .map(normalizeSourceRow)
    .filter(
      (row) =>
        [row.word, row.input, row.sense, row.note].some((value) =>
          value?.trim(),
        ) ||
        !!row.word_ipa?.trim() ||
        Object.hasOwn(row, "inputOriginal") ||
        !!row.notes?.length,
    )
    .map(formationSource);
}
/** Update the publication copy after descriptive edits. Return true for stale scores. */
export function syncFormationSources(draft: {
  formation: Formation | null;
  gismu: GismuState | null;
}): boolean {
  if (!draft.formation || !draft.gismu) return false;
  const sources = formationSourcesFromRows(draft.gismu.rows);
  if (
    draft.formation.method === "algorithmic" &&
    !sameScoringSources(draft.formation.sources, sources)
  )
    return true;
  if (!sameFormationSources(draft.formation.sources, sources))
    draft.formation.sources = sources;
  return false;
}
/** Formation metadata for a generated or manual gismu under the recorded run. */
export function formationMetadata(options: {
  result: GismuResult;
  candidate: GismuCandidate;
  rows: GismuRowState[];
  preset: BuilderPreset | null;
  acknowledged: {
    word: string;
    rule: "identical" | "final-vowel" | "similar-consonant";
    snapshot: string;
  }[];
  reason: string;
  /** True when the form is the candidate the author chose from the run or entered under it. */
}): Formation {
  const { result, candidate, rows, preset } = options;
  const sources = formationSourcesFromRows(rows);
  return {
    method: "algorithmic",
    algorithm: {
      id: result.algorithm.id,
      version: result.algorithm.version,
      implementation: null,
      parameters: { ...result.parameters },
    },
    sources,
    weights_profile: preset
      ? {
          name: preset.label,
          source: {
            label: preset.label,
            url: preset.source_url,
            event: null,
            locator: null,
          },
        }
      : null,
    generated: candidate.form,
    selected_score: {
      numerator: candidate.score.numerator,
      denominator: candidate.score.denominator,
    },
    selected_rank: candidate.rank,
    selection_reason: textToRichText(options.reason, false),
    candidates: result.candidates.slice(0, 32).map((c) => ({
      form: c.form,
      score: {
        numerator: c.score.numerator,
        denominator: c.score.denominator,
      },
      rank: c.rank,
    })),
    conflicts: options.acknowledged.map((a) => ({ ...a })),
  };
}
/** Formation metadata for a manual gismu without a run: no algorithm, no fabricated scores. */
export function manualFormation(
  rows: GismuRowState[],
  reason: string,
): Formation | null {
  const sources = formationSourcesFromRows(rows);
  if (!sources.length && !reason.trim()) return null;
  return {
    method: "non-algorithmic",
    algorithm: null,
    sources,
    weights_profile: null,
    generated: null,
    selected_score: null,
    selected_rank: null,
    selection_reason: textToRichText(reason, false),
    candidates: [],
    conflicts: [],
  };
}
/** A calculated rational as a short decimal for display. */
export function decimal(
  value: { numerator: string; denominator: string },
  digits = 4,
): string {
  const n = BigInt(value.numerator);
  const d = BigInt(value.denominator);
  if (d === 0n) return "?";
  const scale = 10n ** BigInt(digits);
  const scaled = (n * scale + d / 2n) / d;
  const whole = scaled / scale;
  const fraction = (scaled % scale).toString().padStart(digits, "0");
  return `${whole}.${fraction}`;
}
