/** Letters and consonant pairs of CLL chapter 3, ported from jbotci. */
export type PairClass = "forbidden" | "permissible" | "initial";
export const CONSONANTS = "bcdfgjklmnprstvxz";
export const VOWELS = "aeiou";
const CONSONANT_ORDER = "rlnmbvdgjzscxktfp";
const F = "forbidden",
  P = "permissible",
  I = "initial";
const PAIR_MATRIX: PairClass[][] = [
  [F, P, P, P, P, P, P, P, P, P, P, P, P, P, P, P, P],
  [P, F, P, P, P, P, P, P, P, P, P, P, P, P, P, P, P],
  [P, P, F, P, P, P, P, P, P, P, P, P, P, P, P, P, P],
  [I, I, P, F, P, P, P, P, P, F, P, P, P, P, P, P, P],
  [I, I, P, P, F, P, P, P, P, P, F, F, F, F, F, F, F],
  [I, I, P, P, P, F, P, P, P, P, F, F, F, F, F, F, F],
  [I, P, P, P, P, P, F, P, I, I, F, F, F, F, F, F, F],
  [I, I, P, P, P, P, P, F, P, P, F, F, F, F, F, F, F],
  [P, P, P, I, I, I, I, I, F, F, F, F, F, F, F, F, F],
  [P, P, P, I, I, I, I, I, F, F, F, F, F, F, F, F, F],
  [I, I, I, I, F, F, F, F, F, F, F, F, P, I, I, I, I],
  [I, I, I, I, F, F, F, F, F, F, F, F, F, I, I, I, I],
  [I, I, P, P, F, F, F, F, F, F, P, F, F, F, P, P, P],
  [I, I, P, P, F, F, F, F, F, F, P, P, F, F, P, P, P],
  [I, P, P, P, F, F, F, F, F, F, I, I, P, P, F, P, P],
  [I, I, P, P, F, F, F, F, F, F, P, P, P, P, P, F, P],
  [I, I, P, P, F, F, F, F, F, F, P, P, P, P, P, P, F],
];
export const isVowel = (value: string): boolean =>
  value.length === 1 && VOWELS.includes(value);
export const isConsonant = (value: string): boolean =>
  value.length === 1 && CONSONANTS.includes(value);
export function pairClass(first: string, second: string): PairClass | null {
  const a = CONSONANT_ORDER.indexOf(first),
    b = CONSONANT_ORDER.indexOf(second);
  return first.length === 1 && second.length === 1 && a >= 0 && b >= 0
    ? PAIR_MATRIX[a][b]
    : null;
}
export const isInitialPair = (first: string, second: string): boolean =>
  pairClass(first, second) === "initial";
export const isPermissiblePair = (first: string, second: string): boolean => {
  const pair = pairClass(first, second);
  return pair !== null && pair !== "forbidden";
};
/** Match Rust's Unicode whitespace and ASCII case conversion. */
export const trimWord = (text: string): string =>
  text.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
export const asciiLower = (text: string): string =>
  text.replace(/[A-Z]/g, (c) => c.toLowerCase());
export const utf8Length = (text: string): number =>
  new TextEncoder().encode(text).length;
export function normalizeWord(text: string): string | null {
  let out = "";
  for (const value of trimWord(text)) {
    const lower = asciiLower(value);
    if (lower === "’" || lower === "h") out += "'";
    else if (
      lower === "y" ||
      lower === "'" ||
      isVowel(lower) ||
      isConsonant(lower)
    )
      out += lower;
    else if (lower !== ",") return null;
  }
  return out || null;
}
