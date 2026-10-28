/** Unicode uses three separate ranges for circled numbers 1 through 50. */
export const PLACE_GLYPHS = [
  ..."①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳㉑㉒㉓㉔㉕㉖㉗㉘㉙㉚㉛㉜㉝㉞㉟㊱㊲㊳㊴㊵㊶㊷㊸㊹㊺㊻㊼㊽㊾㊿",
] as readonly string[];
export const CIRCLED_SOURCE = "①-⑳㉑-㉟㊱-㊿";
export const CIRCLED = new RegExp(`([${CIRCLED_SOURCE}])`, "u");
export function circledPlace(value: string): number | null {
  const index = PLACE_GLYPHS.indexOf(value);
  return index < 0 ? null : index + 1;
}
export function placeGlyph(index: number): string {
  return PLACE_GLYPHS[index - 1] ?? `{place ${index}}`;
}
