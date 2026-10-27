/** Rafsi and gismu shapes of CLL chapter 4, ported from jbotci. */
import {
  isConsonant,
  isInitialPair,
  isPermissiblePair,
  isVowel,
} from "./phonotactics.ts";
export type RafsiShape =
  | "cvccv"
  | "cvcc"
  | "ccvcv"
  | "ccvc"
  | "cvc"
  | "cv'v"
  | "ccv"
  | "cvv"
  | "other";
export type GismuShape = "ccvcv" | "cvccv";
const SCORES: Record<RafsiShape, number> = {
  cvccv: 1,
  cvcc: 2,
  ccvcv: 3,
  ccvc: 4,
  cvc: 5,
  "cv'v": 6,
  ccv: 7,
  cvv: 8,
  other: 0,
};
export const rafsiShapeScore = (shape: RafsiShape): number => SCORES[shape];
export const isShortRafsiShape = (shape: RafsiShape): boolean =>
  ["cvc", "cv'v", "ccv", "cvv"].includes(shape);
export function rafsiShape(text: string): RafsiShape {
  let pattern = "";
  for (const c of text) {
    if (isVowel(c)) pattern += "v";
    else if (isConsonant(c)) pattern += "c";
    else if (c === "'") pattern += "'";
    else if (c === "y") pattern += "y";
    else return "other";
  }
  return Object.hasOwn(SCORES, pattern) ? (pattern as RafsiShape) : "other";
}
export function gismuShape(word: string): GismuShape | null {
  const letters = [...word];
  if (letters.length !== 5) return null;
  const shape = rafsiShape(word);
  if (shape === "cvccv" && isPermissiblePair(letters[2], letters[3]))
    return shape;
  if (shape === "ccvcv" && isInitialPair(letters[0], letters[1])) return shape;
  return null;
}
export function isShortRafsiForm(form: string): boolean {
  const letters = [...form];
  switch (rafsiShape(form)) {
    case "cvc":
    case "cv'v":
      return true;
    case "ccv":
      return isInitialPair(letters[0], letters[1]);
    case "cvv":
      return ["ai", "ei", "oi", "au"].includes(letters[1] + letters[2]);
    default:
      return false;
  }
}
export function possibleShortRafsi(gismu: string): string[] {
  const shape = gismuShape(gismu);
  if (shape === null) return [];
  const l = [...gismu];
  const forms =
    shape === "cvccv"
      ? [
          l[0] + l[1] + l[2],
          l[0] + l[1] + l[3],
          l[0] + l[1] + "'" + l[4],
          l[0] + l[1] + l[4],
          l[2] + l[3] + l[4],
          l[0] + l[2] + l[1],
        ]
      : [
          l[0] + l[2] + l[3],
          l[1] + l[2] + l[3],
          l[0] + l[2] + "'" + l[4],
          l[0] + l[2] + l[4],
          l[1] + l[2] + "'" + l[4],
          l[1] + l[2] + l[4],
          l[0] + l[1] + l[2],
        ];
  return [...new Set(forms.filter(isShortRafsiForm))].sort();
}
export function universalGismuForms(
  gismu: string,
): [string | null, string] | null {
  if (gismuShape(gismu) === null) return null;
  const stem = gismu.slice(0, 4);
  return [stem === "brod" ? null : stem, gismu];
}
