import { CIRCLED_SOURCE, circledPlace } from "./place-glyphs.ts";

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

/** The AI's positional answer can generate at most 16 consecutive places. */
export function placeSuggestionProblem(
  meaning: string,
  text: unknown[],
  frame: unknown,
): string | null {
  if (frame !== null) return null;
  const explicit = [
    ...new Set([
      ...explicitMeaningPlaces(meaning),
      ...text.flat().filter((node): node is number => typeof node === "number"),
    ]),
  ].sort((a, b) => a - b);
  const highest = explicit.at(-1) ?? 0;
  if (highest > 16)
    return "AI can generate at most 16 places. Declare the explicit places manually, then ask for glosses and types.";
  if (explicit.some((index, position) => index !== position + 1))
    return "The explicit place numbers have gaps. Declare those numbers manually with Depends on context, or fill the fixed positions yourself before asking for suggestions.";
  return null;
}
