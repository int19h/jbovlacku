import { CIRCLED_SOURCE, circledPlace, placeGlyph } from "./place-glyphs.ts";

/** The original Meaning field retains its narrow circled-character escape. */
export function explicitMeaningPlaces(meaning: string): number[] {
  const numbers = new Set<number>();
  const pattern = new RegExp(
    `\\\\([${CIRCLED_SOURCE}])|([${CIRCLED_SOURCE}])|\\{place (\\d{1,5})\\}`,
    "gu",
  );
  for (const match of meaning.matchAll(pattern)) {
    if (match[1]) continue;
    const index = match[2] ? circledPlace(match[2])! : Number(match[3]);
    if (index > 0) numbers.add(index);
  }
  return [...numbers].sort((a, b) => a - b);
}

export interface NumberedMeaningPart {
  segments: { text: string; place?: number }[];
  places: number[];
}
/** Reserve explicit numbers first, then number blanks within each part. */
export function numberMeaningParts(meaning: string): NumberedMeaningPart[] {
  type Segment = { text: string; place?: number; blank?: boolean };
  const parts: Segment[][] = [[]];
  const append = (segment: Segment) => parts.at(-1)!.push(segment);
  const pattern = new RegExp(`\\\\([${CIRCLED_SOURCE}])|([${CIRCLED_SOURCE}])|\\{place (\\d{1,5})\\}|(;)|(_{2,})`, "gu");
  let offset = 0;
  for (const match of meaning.matchAll(pattern)) {
    append({ text: meaning.slice(offset, match.index) });
    const [, escaped, circled, explicit, separator, blank] = match;
    if (escaped !== undefined) append({ text: escaped });
    else if (separator) parts.push([]);
    else if (blank) append({ text: "", blank: true });
    else append({ text: match[0], place: circled ? circledPlace(circled)! : Number(explicit) });
    offset = match.index! + match[0].length;
  }
  append({ text: meaning.slice(offset) });
  return parts.map((part) => {
    const used = new Set(part.flatMap((segment) => segment.place === undefined ? [] : [segment.place]));
    let next = 1;
    const segments = part.map((segment) => {
      if (!segment.blank) return { text: segment.text, ...(segment.place === undefined ? {} : { place: segment.place }) };
      while (used.has(next)) next++;
      const place = next++;
      used.add(place);
      return { text: placeGlyph(place), place };
    });
    return { segments, places: [...used].sort((a, b) => a - b) };
  });
}

/** The AI's positional answer can generate at most 16 consecutive places. */
export function placeSuggestionProblem(
  meaning: string,
  text: unknown[],
  frame: unknown,
): string | null {
  if (frame !== null) return null;
  const current = text.flat().filter((node): node is number => typeof node === "number");
  const explicit = [...new Set(current.length ? current : numberMeaningParts(meaning).flatMap((part) => part.places))]
    .filter((index) => index > 0).sort((a, b) => a - b);
  const highest = explicit.at(-1) ?? 0;
  if (highest > 16)
    return "AI can generate at most 16 places. Declare the explicit places manually. Then ask for glosses and types.";
  if (explicit.some((index, position) => index !== position + 1))
    return "The explicit place numbers have gaps. Declare those numbers manually with Depends on context, or fill the fixed positions yourself before asking for suggestions.";
  return null;
}
