/**
 * Zbalermorna rendering for display only. The Crisa font maps Latin Lojban
 * letters into the Private Use Area. Signed spellings are never changed.
 * Characters outside the Lojban alphabet return null so the Latin text stays.
 */
const consonants: Record<string, number> = {
  p: 0xed80,
  t: 0xed81,
  k: 0xed82,
  f: 0xed83,
  l: 0xed84,
  s: 0xed85,
  c: 0xed86,
  m: 0xed87,
  x: 0xed88,
  ".": 0xed89,
  "'": 0xed8a,
  b: 0xed90,
  d: 0xed91,
  g: 0xed92,
  v: 0xed93,
  r: 0xed94,
  z: 0xed95,
  j: 0xed96,
  n: 0xed97,
};
const vowels: Record<string, number> = {
  a: 0xeda0,
  e: 0xeda1,
  i: 0xeda2,
  o: 0xeda3,
  u: 0xeda4,
  y: 0xeda5,
};
/** Returns the zbalermorna string, or null when the spelling has other characters. */
export function zbalermorna(spelling: string): string | null {
  let result = "";
  for (const ch of spelling.toLowerCase()) {
    if (ch === " " || ch === ",") {
      result += ch === " " ? " " : "";
      continue;
    }
    const code = consonants[ch] ?? vowels[ch];
    if (!code) return null;
    result += String.fromCodePoint(code);
  }
  return result || null;
}
