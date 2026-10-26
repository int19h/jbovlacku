/**
 * Production transitions for headword and builder state.
 * See docs/typed-headword-state.md for fields, events, and invariants.
 */
import {
  analyzeWord,
  buildLujvo,
  morphologyProfile,
  rafsiPairId,
  wordId,
  type LujvoCandidate,
  type LujvoResult,
  type LujvoRequest,
  type MorphologyProfile,
  type RecoveredPart,
} from "../../../../packages/core/src/browser.ts";
import type { CachedPackage } from "../data/search.ts";
import type {
  Compound,
  Formation,
  LexicalKind,
  PackageEntryV2,
} from "./types.ts";
import type { Draft } from "./draft.ts";
import {
  componentId,
  compoundMetadata,
  newLujvoState,
  manualFormation,
  syncFormationSources,
  normalizeLujvoEvidence,
  rememberLujvoEvidence,
  type LujvoComponentState,
  type LujvoState,
} from "./builders.ts";

import { detectWord, supportsJoins } from "./word-form.ts";
export { detectWord } from "./word-form.ts";

export const typedWord = (spelling: string) => spelling.trim().normalize("NFC");
/** Keep authored fields and flag evidence and annotations after a spelling edit. */
export function changeTypedWord(draft: Draft, spelling: string) {
  const previousSpelling = typedWord(draft.spelling);
  const changed = typedWord(draft.spelling) !== typedWord(spelling);
  const state = draft.lujvo;
  if (changed && state?.typedOrigin) state.ordinarySpelling = "";
  if (
    draft.lujvo?.components.length &&
    !draft.lujvo.typedOrigin &&
    draft.lujvo.ordinarySpelling === undefined
  )
    draft.lujvo.ordinarySpelling = typedWord(draft.spelling);
  draft.spelling = spelling;
  draft.typedSpelling = typedWord(spelling) || null;
  if (!changed) return;
  draft.publishAcknowledged = [];
  if (state?.typed || state?.typedOrigin) {
    leaveTypedMode(
      state,
      !!state.typedOrigin ||
        (typedWord(state.typed ?? "") === previousSpelling &&
          !!matchingJoinedReading(state, previousSpelling)),
    );
    state.acknowledged = [];
  }
  if (
    draft.compound ||
    draft.formation ||
    draft.places.length ||
    draft.glosses.length
  )
    draft.review = [...new Set([...draft.review, "spelling"])];
}

/** New word advances the current draft. It does not replace its content. */
export function continueWithWord(draft: Draft) {
  if (typedWord(draft.spelling))
    draft.typedSpelling = typedWord(draft.spelling);
  draft.step = Math.max(draft.step, 2) as Draft["step"];
}

/** Apply a type choice after the caller confirms any evidence loss. */
export function selectWordKind(draft: Draft, kind: LexicalKind | null) {
  if (
    draft.kind !== kind &&
    ((kind !== "lujvo" && draft.compound) ||
      (kind !== "gismu" && draft.formation))
  ) {
    if (kind !== "lujvo") draft.compound = null;
    if (kind !== "gismu") {
      draft.formation = null;
      for (const row of draft.gismu?.rows ?? []) delete row.sourceReview;
    }
    if (!draft.compound && !draft.formation) draft.evidenceForm = null;
  }
  draft.kind = kind;
  delete draft.autoDetectedKind;
  draft.review = draft.review.filter((field) => field !== "word type");
}

/** Apply explicit evidence removal without discarding builder inputs. */
export function clearWordEvidence(draft: Draft) {
  if (draft.lujvo) reconcileLujvoRows(draft.lujvo);
  draft.compound = null;
  draft.formation = null;
  draft.evidenceForm = null;
  draft.publishAcknowledged = [];
}

function rowParts(state: LujvoState) {
  return state.components.map((component) => ({
    id: component.id,
    rafsi: component.locked,
  }));
}

/** Release restored boundaries only after their actual rows or rafsi change. */
export function reconcileLujvoRows(state: LujvoState) {
  normalizeLujvoEvidence(state);
  if (state.restoredSpelling && state.restoredProfile)
    rememberLujvoEvidence(state, state.restoredSpelling, state.restoredProfile);
  if (
    !state.typedOrigin &&
    state.restoredJoinParts &&
    ((state.restoredProfile !== undefined &&
      state.profile !== state.restoredProfile) ||
      state.components.length !== state.restoredJoinParts.length ||
      state.components.some(
        (component, index) =>
          component.id !== state.restoredJoinParts![index].id ||
          component.locked !== state.restoredJoinParts![index].rafsi,
      ))
  ) {
    state.restoredReleased = true;
    delete state.joins;
    delete state.restoredJoinParts;
    delete state.restoredSpelling;
    delete state.restoredProfile;
  }
}

/** A changed profile returns restored ordinary boundaries to automatic joins. */
export function selectLujvoProfile(
  state: LujvoState,
  profile: MorphologyProfile,
) {
  if (state.typedOrigin) return;
  if (state.profile !== profile) state.profileChosen = true;
  state.profile = profile;
  reconcileLujvoRows(state);
}

/** Apply a row control and release construction before the next save or build. */
export function editLujvoRows(
  state: LujvoState,
  edit: (rows: LujvoComponentState[]) => void,
) {
  edit(state.components);
  reconcileLujvoRows(state);
}

/** A source choice changes attribution while its exact part and row stay fixed. */
export function selectLujvoSource(
  state: LujvoState,
  index: number,
  source: LujvoComponentState | string,
) {
  const row = state.components[index];
  if (typeof source !== "string") {
    state.components[index] = { ...source, id: row.id, locked: row.locked };
  } else {
    const spelling = typedWord(source);
    Object.assign(row, {
      spelling,
      kind: detectWord(spelling).kind,
      definition: null,
      definitions: [],
      claims: [],
    });
    if (spelling) delete row.unresolvedSource;
    else row.unresolvedSource = "Link a source word if you know it.";
  }
}

/** Record a confirmed gismu choice and keep the previous component inputs. */
export function selectGismuSpelling(
  draft: Draft,
  spelling: string,
  formation: Formation,
  evidenceOnly = false,
) {
  const typed =
    evidenceOnly && draft.spelling === spelling ? draft.typedSpelling : null;
  draft.compound = null;
  draft.formation = null;
  changeTypedWord(draft, spelling);
  draft.typedSpelling = typed;
  draft.formation = formation;
  draft.evidenceForm = spelling;
}

/** Form accepts changed source inputs as manual evidence without old scores. */
export function useManualForm(draft: Draft) {
  if (
    draft.kind === "gismu" &&
    draft.gismu &&
    (!draft.formation || syncFormationSources(draft))
  ) {
    draft.formation = manualFormation(draft.gismu.rows, draft.gismu.reason);
    if (draft.formation) draft.evidenceForm = draft.spelling;
  }
  draft.step = Math.max(draft.step, 4) as Draft["step"];
}

function matchingJoinedReading(state: LujvoState, spelling: string) {
  if (!spelling) return undefined;
  const analysis = detectWord(spelling, state.profile);
  return analysis.readings.find(
    (parts) =>
      parts.length === state.components.length &&
      parts.every(
        (part, index) => part.text === state.components[index].locked,
      ) &&
      state.joins?.length === parts.length - 1 &&
      state.joins.every(
        (join, index) => join === (parts[index + 1].join_before ?? ""),
      ),
  );
}

function leaveTypedMode(state: LujvoState, keepJoins: boolean) {
  const spelling = state.typed;
  delete state.typedOrigin;
  delete state.typed;
  delete state.typedReading;
  delete state.readingIndex;
  state.selected = null;
  if (keepJoins && state.joins) {
    state.restoredJoinParts = rowParts(state);
    state.restoredSpelling = spelling;
    state.restoredProfile = state.profile;
    if (spelling) rememberLujvoEvidence(state, spelling, state.profile);
  } else {
    delete state.joins;
    delete state.restoredJoinParts;
    delete state.restoredSpelling;
    delete state.restoredProfile;
  }
}

/** Partial Undo cannot bind restored typed rows to a later edited headword. */
export function reconcileLujvoUndo(draft: Draft, original?: LujvoState | null) {
  const state = draft.lujvo;
  if (!state) return;
  if (
    state.typedOrigin &&
    (state.typed !== typedWord(draft.spelling) ||
      draft.typedSpelling !== state.typed ||
      state.profileChosen ||
      !exactTypedConstruction(state))
  ) {
    const keepJoins =
      exactTypedConstruction(state) &&
      !!matchingJoinedReading(state, state.typed ?? "");
    leaveTypedMode(state, keepJoins);
    if (original?.typedOrigin && original.typed)
      rememberLujvoEvidence(state, original.typed, original.profile, true);
    state.ordinarySpelling = "";
  }
  reconcileLujvoRows(state);
}

function matchingLockedReading(state: LujvoState, spelling: string) {
  if (!spelling) return undefined;
  const analysis = detectWord(spelling, state.profile);
  return analysis.readings.find(
    (parts) =>
      parts.length === state.components.length &&
      parts.every(
        (part, index) => part.text === state.components[index].locked,
      ),
  );
}

function signedComponent(
  component: Compound["components"][number],
  profile: MorphologyProfile,
): LujvoComponentState {
  return {
    id: componentId(),
    spelling: component.word.spelling,
    kind: detectWord(component.word.spelling, profile).kind,
    definition: component.definition,
    claims: [
      {
        rafsi: component.rafsi,
        pair: rafsiPairId(wordId(component.word), component.rafsi),
      },
    ],
    locked: component.rafsi,
    gloss: "",
  };
}

/** An exact surviving part keeps the author's complete source choice. */
function retainSources(
  components: LujvoComponentState[],
  previous: LujvoComponentState[],
  compound: Compound | null,
  profile: MorphologyProfile,
) {
  const used = new Set<LujvoComponentState>();
  const linked = (row: LujvoComponentState) =>
    !!row.spelling.trim() && !row.unresolvedSource;
  const compatible = (row: LujvoComponentState, rafsi: string | null) => {
    if (!linked(row) || row.locked !== null || !rafsi) return false;
    const analysis = analyzeWord(profile, row.spelling);
    return (
      analysis.kind !== "unknown" &&
      (row.claims.some((claim) => claim.rafsi === rafsi) ||
        analysis.normalized === rafsi ||
        (analysis.kind === "gismu" &&
          analysis.normalized?.slice(0, 4) === rafsi))
    );
  };
  return components.map((component, index) => {
    const same = previous[index];
    const remaining = previous.filter((row) => !used.has(row));
    const exact = remaining.filter((row) => row.locked === component.locked);
    const authoredExact = exact.filter(linked);
    const fallback = remaining.filter((row) =>
      compatible(row, component.locked),
    );
    const atPosition = same && !used.has(same) ? same : undefined;
    const old =
      atPosition && authoredExact.includes(atPosition)
        ? atPosition
        : authoredExact.length === 1
          ? authoredExact[0]
          : atPosition && fallback.includes(atPosition)
            ? atPosition
            : fallback.length === 1
              ? fallback[0]
              : atPosition && exact.includes(atPosition)
                ? atPosition
                : exact.length === 1
                  ? exact[0]
                  : undefined;
    if (old) used.add(old);
    if (old && linked(old))
      return old.locked === component.locked
        ? old
        : { ...old, locked: component.locked };
    const signed = compound?.components[index];
    if (signed?.rafsi === component.locked)
      return {
        ...signedComponent(signed, profile),
        ...(old ? { id: old.id } : {}),
      };
    if (authoredExact.length > 1 || fallback.length > 1)
      return {
        ...component,
        ...(old ? { id: old.id } : {}),
        spelling: "",
        kind: "other",
        definition: null,
        definitions: [],
        gloss: "",
        claims: [],
        unresolvedSource: "Choose a source word.",
      };
    return { ...component, ...(old ? { id: old.id } : {}) };
  });
}

function exactTypedConstruction(state: LujvoState): boolean {
  try {
    const candidates = buildLujvoState(state).candidates;
    return (
      candidates.length === 1 &&
      candidates[0].spelling === state.typed &&
      candidates[0].tokens.join("") === state.typed
    );
  } catch {
    return false;
  }
}

/** Reconcile a builder visit. No browser, storage, or provider work occurs here. */
export function prepareLujvoBuilder(
  draft: Draft,
  cached: CachedPackage | null,
) {
  let state = (draft.lujvo ??= newLujvoState());
  reconcileLujvoRows(state);
  const spelling = typedWord(draft.spelling);
  const typedIdentity =
    !!draft.typedSpelling && typedWord(draft.typedSpelling) === spelling;
  const legacyTypedRows = !!state.typed && !state.typedOrigin;
  const legacyTypedIdentity =
    legacyTypedRows && typedWord(state.typed ?? "") === spelling;
  const retainedCompound =
    draft.compound && draft.evidenceForm === spelling ? draft.compound : null;
  if (legacyTypedIdentity && retainedCompound && !state.profileChosen)
    state.profile = morphologyProfile(retainedCompound.morphology);
  if (
    !state.typedOrigin &&
    state.components.length &&
    state.ordinarySpelling === undefined
  )
    state.ordinarySpelling = typedWord(state.typed ?? draft.spelling);
  if (
    (state.typed || state.typedOrigin) &&
    (!state.typedOrigin || !typedIdentity || state.typed !== spelling)
  )
    leaveTypedMode(
      state,
      state.typedOrigin
        ? !!matchingJoinedReading(state, state.typed ?? "")
        : legacyTypedIdentity && !!matchingJoinedReading(state, spelling),
    );

  if (retainedCompound) {
    const signedProfile = morphologyProfile(retainedCompound.morphology);
    rememberLujvoEvidence(state, spelling, signedProfile, true);
    // Empty rows request a complete new restoration, including signed boundaries.
    const empty = !state.components.length;
    if (empty) {
      delete state.restoredReleased;
      delete state.profileChosen;
      state.ordinarySpelling = spelling;
    }
    const profile =
      state.profileChosen && !state.typedOrigin ? state.profile : signedProfile;
    if (!state.typedOrigin && state.ordinarySpelling !== "")
      state.ordinarySpelling = spelling;
    const hydrate =
      !state.components.length ||
      (profile === "extended-v2" &&
        typedIdentity &&
        (state.typedOrigin || legacyTypedRows) &&
        (state.components.length !== retainedCompound.components.length ||
          state.components.some((component, index) => {
            const signed = retainedCompound.components[index];
            return (
              typedWord(component.spelling) !==
                typedWord(signed.word.spelling) ||
              (component.locked !== null && component.locked !== signed.rafsi)
            );
          })));
    state.profile = profile;
    reconcileLujvoRows(state);
    if (hydrate)
      state.components = retainSources(
        retainedCompound.components.map((component) =>
          signedComponent(component, profile),
        ),
        state.components,
        retainedCompound,
        profile,
      );
    const retainedLocks =
      state.components.length === retainedCompound.components.length &&
      state.components.every(
        (component, index) =>
          component.locked === retainedCompound.components[index].rafsi,
      );
    if (state.typedOrigin && (!typedIdentity || !retainedLocks))
      leaveTypedMode(state, false);
    if (
      supportsJoins(profile) &&
      retainedLocks &&
      !state.restoredReleased &&
      (hydrate || state.typedOrigin || legacyTypedIdentity)
    ) {
      const parts = detectWord(spelling, profile).readings.find(
        (parts) =>
          parts.length === state.components.length &&
          parts.every(
            (part, index) => part.text === state.components[index].locked,
          ),
      );
      if (parts)
        state.joins = parts.slice(1).map((part) => part.join_before ?? "");
    }
  }
  // An ordinary profile choice never changes the word's retained analysis evidence.
  const savedProfile = state.restoredEvidenceHistory?.find(
    (entry) => entry.spelling === spelling,
  )?.profile;
  const analysisProfile = retainedCompound
    ? morphologyProfile(retainedCompound.morphology)
    : (savedProfile ?? "extended-v4");
  const analysis = typedIdentity ? detectWord(spelling, analysisProfile) : null;
  if (
    (!retainedCompound || state.ordinarySpelling === "") &&
    state.ordinarySpelling !== spelling &&
    analysis?.kind === "lujvo" &&
    state.typed !== spelling
  ) {
    const next = typedLujvoState(
      spelling,
      analysis.readings[0],
      cached,
      analysisProfile,
    );
    if (state.restoredEvidenceHistory)
      next.restoredEvidenceHistory = structuredClone(
        state.restoredEvidenceHistory,
      );
    next.components = retainSources(
      next.components,
      state.components,
      retainedCompound,
      next.profile,
    );
    if (exactTypedConstruction(next)) state = draft.lujvo = next;
    else {
      // Historical analyzers can accept joins their constructor cannot produce.
      // Keep ordinary controls available so the author can choose another profile.
      state.components = next.components;
      if (!state.profileChosen) state.profile = analysisProfile;
      // Missing dictionary sources can become available on the next visit.
      state.ordinarySpelling = linkedSources(next) ? spelling : "";
      state.restoredReleased = true;
      delete state.joins;
      delete state.restoredJoinParts;
      delete state.restoredSpelling;
      delete state.restoredProfile;
    }
  }
  if (state.typedOrigin && !exactTypedConstruction(state)) {
    leaveTypedMode(state, false);
    state.ordinarySpelling = spelling;
    state.restoredReleased = true;
  }
  if (
    !state.typedOrigin &&
    !state.restoredReleased &&
    (state.joins || (!supportsJoins(state.profile) && !state.profileChosen))
  ) {
    const matches = supportsJoins(state.profile)
      ? matchingJoinedReading
      : matchingLockedReading;
    const associated = [spelling, state.ordinarySpelling ?? ""].find((word) =>
      matches(state, word),
    );
    if (state.joins || associated) {
      state.restoredJoinParts ??= rowParts(state);
      state.restoredProfile ??= state.profile;
      if (!state.restoredSpelling && associated)
        state.restoredSpelling = associated;
      if (state.restoredSpelling)
        rememberLujvoEvidence(state, state.restoredSpelling, state.profile);
    }
  }
  return state;
}

/** Preview another ordinary candidate without replacing the headword or evidence. */
export function chooseLujvoAlternative(draft: Draft, spelling: string) {
  const state = draft.lujvo!;
  if (state.selected !== spelling) {
    state.acknowledged = [];
    draft.publishAcknowledged = [];
  }
  state.selected = spelling;
}

/** Record a confirmed form choice after the page checks conflicts and replacement. */
export function selectLujvoCandidate(
  draft: Draft,
  result: LujvoResult,
  candidate: LujvoCandidate,
  withMetadata: boolean,
) {
  const state = draft.lujvo!;
  if (
    !result.candidates.includes(candidate) ||
    morphologyProfile(result.morphology) !== state.profile ||
    candidate.parts.length !== state.components.length ||
    candidate.parts.some((part, index) => {
      const row = state.components[index];
      return (
        part.id !== row.id || (row.locked !== null && row.locked !== part.form)
      );
    })
  )
    throw new Error(
      "Rebuild the current components before choosing this form.",
    );
  const compound = withMetadata
    ? compoundMetadata(result, candidate, state.components, "")
    : null;
  draft.formation = null;
  if (draft.spelling !== candidate.spelling) draft.publishAcknowledged = [];
  draft.spelling = candidate.spelling;
  draft.typedSpelling = state.typedOrigin
    ? typedWord(candidate.spelling)
    : null;
  if (!state.typedOrigin) {
    delete state.typed;
    state.ordinarySpelling = typedWord(candidate.spelling);
  }
  draft.evidenceForm = withMetadata ? candidate.spelling : null;
  draft.compound = compound;
  state.selected = candidate.spelling;
  draft.step = Math.max(draft.step, 4) as Draft["step"];
}

/** Possible source words remain choices. Dictionary order grants no source authority. */
export function sourceOptions(
  part: RecoveredPart,
  cached: CachedPackage | null,
) {
  const words = new Map<string, LujvoComponentState>();
  for (const entry of cached?.entries ?? []) {
    const spelling = entry.word.spelling;
    const listed = "issuer" in entry ? (entry as PackageEntryV2).rafsi : [];
    if (
      spelling !== part.text &&
      !(
        entry.classification.kind === "gismu" &&
        spelling.slice(0, 4) === part.text
      ) &&
      !listed.includes(part.text)
    )
      continue;
    let component = words.get(spelling);
    if (!component) {
      component = {
        id: componentId(),
        spelling,
        kind: entry.classification.kind,
        definition: null,
        definitions: [],
        gloss: entry.glosses[0]?.text ?? "",
        locked: part.text,
        claims: [],
      };
      words.set(spelling, component);
    }
    component.definitions!.push({
      event: entry.event,
      summary: entry.plain_text,
    });
    for (const rafsi of listed)
      if (!component.claims.some((claim) => claim.rafsi === rafsi))
        component.claims.push({
          rafsi,
          pair: rafsiPairId(wordId(entry.word), rafsi),
        });
  }
  return [...words.values()].sort((a, b) =>
    a.spelling.localeCompare(b.spelling),
  );
}

/** Hydrate exact rafsi and boundaries. A missing source stays explicitly unresolved. */
export function typedLujvoState(
  spelling: string,
  parts: RecoveredPart[],
  cached: CachedPackage | null,
  profile: MorphologyProfile = "extended-v4",
) {
  return {
    ...newLujvoState(),
    profile,
    typedOrigin: true as const,
    typed: spelling,
    selected: spelling,
    joins: parts.slice(1).map((part) => part.join_before ?? ""),
    components: parts.map((part) => {
      const choices = sourceOptions(part, cached);
      if (choices.length === 1) return choices[0];
      return {
        id: componentId(),
        spelling: "",
        kind: "other",
        definition: null,
        gloss: "",
        claims: [],
        locked: part.text,
        unresolvedSource: choices.length
          ? "Choose a source word."
          : "Link a source word if you know it.",
      };
    }),
  };
}

/** Construct morphology from exact locks. Blank source fields create no attribution. */
export function typedLujvoRequest(state: import("./builders.ts").LujvoState) {
  return {
    profile: state.profile,
    components: state.components,
    joins: supportsJoins(state.profile) ? state.joins : undefined,
    spelling: supportsJoins(state.profile)
      ? state.typedOrigin
        ? state.typed
        : state.restoredSpelling
      : undefined,
  };
}
/** Keep exact presentation after older profiles validate the same normalized construction. */
const presentationLetter = (letter: string) => {
  if (letter === ",") return "";
  if (letter === "h" || letter === "H" || letter === "’") return "'";
  return /[A-Z]/.test(letter) ? letter.toLowerCase() : letter;
};

export function buildLujvoState(
  state: LujvoState,
  options: Pick<LujvoRequest, "inventory" | "limits"> = {},
): LujvoResult {
  const result = buildLujvo({ ...typedLujvoRequest(state), ...options });
  const spelling = state.typedOrigin ? state.typed : state.restoredSpelling;
  if (!spelling || supportsJoins(state.profile)) return result;
  const analysis = analyzeWord(state.profile, spelling);
  const exact = result.candidates.find(
    (candidate) =>
      analysis.kind === "lujvo" &&
      analysis.normalized === candidate.spelling &&
      candidate.tokens.join("") === candidate.spelling &&
      analysis.readings.some(
        (parts) =>
          parts.length === candidate.parts.length &&
          parts.length === candidate.recovered.length &&
          parts.every(
            (part, index) =>
              part.text === candidate.parts[index].form &&
              part.text === candidate.recovered[index].text &&
              (part.join_before ?? "") ===
                (candidate.recovered[index].join_before ?? ""),
          ),
      ),
  );
  if (
    !exact ||
    Array.from(spelling, presentationLetter).join("") !== exact.spelling
  )
    throw new Error(
      "The saved spelling does not match a construction under its morphology profile.",
    );
  let offset = 0;
  const tokens = exact.tokens.map((token, index) => {
    const start = offset;
    let normalized = "";
    while (offset < spelling.length && normalized.length < token.length) {
      const letter = spelling[offset++];
      normalized += presentationLetter(letter);
    }
    if (normalized !== token)
      throw new Error(
        "The saved spelling does not match its construction tokens.",
      );
    if (index === exact.tokens.length - 1) offset = spelling.length;
    return spelling.slice(start, offset);
  });
  if (tokens.join("") !== spelling)
    throw new Error(
      "The saved spelling does not match its construction tokens.",
    );
  return { ...result, candidates: [{ ...exact, spelling, tokens }] };
}

export function linkedSources(
  state: import("./builders.ts").LujvoState,
): boolean {
  return state.components.every(
    (component) => !!component.spelling.trim() && !component.unresolvedSource,
  );
}
