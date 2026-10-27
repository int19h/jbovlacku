/** Pure word-form feedback shared by authoring screens and draft checks. */
import {
  analyzeWord,
  morphologyProfile,
  type MorphologyProfile,
} from "../../../../packages/core/src/browser.ts";
import { kindLabel, type Compound, type LexicalKind } from "./types.ts";

export function detectWord(
  spelling: string,
  profile: MorphologyProfile = "extended-v4",
) {
  const word = spelling.trim().normalize("NFC");
  const analysis = analyzeWord(profile, word);
  if (
    profile === "extended" &&
    analysis.kind === "unknown" &&
    /^\.|\.$/.test(word)
  ) {
    const framed = analyzeWord(profile, word.replace(/^\.|\.$/g, ""));
    if (framed.kind !== "unknown") return { ...framed, original: word };
  }
  return analysis;
}
export function supportsJoins(profile: MorphologyProfile): boolean {
  return profile === "extended" || profile === "extended-v4";
}
interface WordFormDraft {
  spelling: string;
  kind: LexicalKind | null;
  labels: string[];
  compound: Compound | null;
  evidenceForm?: string | null;
  lujvo?: {
    profile: MorphologyProfile;
    typed?: string;
    selected: string | null;
    restoredSpelling?: string;
    restoredEvidenceHistory?: {
      spelling: string;
      profile: MorphologyProfile;
    }[];
  } | null;
}
export const isExperimental = (labels: string[]) =>
  labels.some((label) => label.trim().toLowerCase() === "experimental");
export function setExperimental(draft: { labels: string[] }, enabled: boolean) {
  draft.labels = draft.labels.filter(
    (label) => label.trim().toLowerCase() !== "experimental",
  );
  if (enabled) draft.labels.push("experimental");
}
export function wordFormProfile(draft: WordFormDraft): MorphologyProfile {
  const spelling = draft.spelling.trim().normalize("NFC");
  if (
    draft.compound &&
    draft.evidenceForm?.trim().normalize("NFC") === spelling
  )
    return morphologyProfile(draft.compound.morphology);
  const saved = draft.lujvo?.restoredEvidenceHistory?.find(
    (entry) => entry.spelling === spelling,
  );
  if (saved) return saved.profile;
  if (
    draft.lujvo &&
    [
      draft.lujvo.typed,
      draft.lujvo.selected,
      draft.lujvo.restoredSpelling,
    ].includes(spelling)
  )
    return draft.lujvo.profile;
  return "extended-v4";
}
export function wordFormFeedback(draft: WordFormDraft) {
  if (!draft.spelling.trim())
    return { text: "", mismatch: false, blocking: false, message: "" };
  let analysis: ReturnType<typeof detectWord>;
  try {
    analysis = detectWord(draft.spelling, wordFormProfile(draft));
  } catch (error) {
    return {
      text: `Word-form check unavailable. ${error instanceof Error ? error.message : String(error)}`,
      mismatch: false,
      blocking: false,
      message: "",
    };
  }
  const checked = [
    "gismu",
    "lujvo",
    "fuhivla",
    "cmavo",
    "cmevla",
    "compound",
  ].includes(draft.kind ?? "");
  const mismatch = checked && analysis.kind !== draft.kind;
  const experimental = isExperimental(draft.labels);
  const message = mismatch
    ? `The spelling does not match the selected ${kindLabel(draft.kind!)} type. ${experimental ? "The experimental label permits this classification." : "Choose another type or mark this classification as experimental."}`
    : "";
  const words =
    analysis.words && analysis.words.length >= 2
      ? ` Words: ${analysis.words.map((word) => word.text).join(" · ")}.`
      : "";
  const text = [
    `Detected form: ${kindLabel(analysis.kind)}.${words}`,
    message,
    ...analysis.diagnostics,
  ]
    .filter(Boolean)
    .join(" ");
  return { text, message, mismatch, blocking: mismatch && !experimental };
}
