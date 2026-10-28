import type { WordAnalysis } from "./types.ts";

export const ACUTE_ACCENT_ERROR =
  "Acute accents are allowed only on cmevla. Remove the accent or use a name that the selected profile recognizes.";

/** Acute stress marks affect display only. Keep every other diacritic. */
export function stripAcuteAccents(spelling: string): string {
  return spelling.normalize("NFD").replaceAll("\u0301", "").normalize("NFC");
}

/** Normalize a component like the plain parser, while keeping acute display marks. */
export function normalizeAcuteDisplay(spelling: string): string {
  return spelling
    .trim()
    .toLowerCase()
    .replaceAll("’", "'")
    .replaceAll("h", "'")
    .replaceAll(",", "")
    .replace(/^\.|\.$/g, "")
    .normalize("NFC");
}

/** Reject detached marks and marks on recognized words other than names. */
export function applyAcuteRules(analysis: WordAnalysis): WordAnalysis {
  const decomposed = analysis.original.normalize("NFD");
  if (!decomposed.includes("\u0301")) return analysis;
  let letter = false;
  let attached = true;
  for (const char of decomposed) {
    if (char === "\u0301" && !letter) attached = false;
    letter = /^[abcdefgijklmnoprstuvxyz]$/i.test(char);
  }
  const marked = decomposed
    .trim()
    .toLowerCase()
    .replaceAll("’", "'")
    .replaceAll("h", "'")
    .replaceAll(",", "")
    .replace(/^\.|\.$/g, "");
  let offset = 0;
  let names = true;
  for (const char of marked) {
    if (char === "\u0301") {
      const word = analysis.words?.find(
        (word) => word.start <= offset - 1 && word.end >= offset,
      );
      if (
        word
          ? word.kind !== "cmevla"
          : !["unknown", "cmevla"].includes(analysis.kind)
      )
        names = false;
    } else offset += char.length;
  }
  if (!attached || !names) {
    analysis.kind = "unknown";
    analysis.readings = [];
    if (analysis.words) analysis.words = [];
    analysis.diagnostics.push(
      attached
        ? ACUTE_ACCENT_ERROR
        : "An acute accent must follow a Lojban vowel or consonant.",
    );
  }
  return analysis;
}
