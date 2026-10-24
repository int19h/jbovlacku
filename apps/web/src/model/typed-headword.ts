/** Local detection and exact component choices for a spelling the author entered. */
import {
  analyzeWord,
  rafsiPairId,
  wordId,
  type RecoveredPart,
  type WordAnalysis,
} from "../../../../packages/core/src/index.ts";
import type { CachedPackage } from "../data/search.ts";
import type { PackageEntryV2 } from "./types.ts";
import type { Draft } from "./draft.ts";
import {
  componentId,
  newLujvoState,
  type LujvoComponentState,
} from "./builders.ts";

export const typedWord = (spelling: string) => spelling.trim().normalize("NFC");
export function detectWord(spelling: string) {
  const word = typedWord(spelling);
  const analysis = analyzeWord("extended", word);
  if (analysis.kind === "unknown" && /^\.|\.$/.test(word)) {
    const framed = analyzeWord("extended", word.replace(/^\.|\.$/g, ""));
    if (framed.kind === "cmevla") return { ...framed, original: word };
  }
  return analysis;
}

/** Keep authored fields and flag evidence and annotations after a spelling edit. */
export function changeTypedWord(draft: Draft, spelling: string) {
  const changed = typedWord(draft.spelling) !== typedWord(spelling);
  draft.spelling = spelling;
  draft.typedSpelling = typedWord(spelling) || null;
  if (!changed) return;
  draft.publishAcknowledged = [];
  if (
    draft.compound ||
    draft.formation ||
    draft.places.length ||
    draft.glosses.length
  )
    draft.review = [...new Set([...draft.review, "spelling"])];
}

export function readingOptions(
  analysis: WordAnalysis,
): { label: string; parts: RecoveredPart[] }[] {
  return analysis.readings.map((parts) => ({
    label: parts
      .map((part) => `${part.join_before ?? ""}${part.text}`)
      .join(" + "),
    parts,
  }));
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
  readingIndex = 0,
) {
  return {
    ...newLujvoState(),
    profile: "extended" as const,
    typed: spelling,
    typedReading: structuredClone(parts),
    readingIndex,
    selected: spelling,
    joins: parts.slice(1).map((part) => part.join_before ?? ""),
    components: parts.map((part) => {
      const choices = sourceOptions(part, cached);
      if (choices.length === 1) return choices[0];
      return {
        id: componentId(),
        spelling: part.text,
        kind: detectWord(part.text).kind,
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
