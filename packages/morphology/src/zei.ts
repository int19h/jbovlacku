import type { MorphologyWord, RecoveredPart } from "./types.ts";

export const ZEI_JOIN = " zei ";
export const ZEI_SCORING_ID =
  "https://github.com/int19h/jbovlacku/blob/main/docs/morphology.md#zei-lujvo-linking";

export interface ZeiOperand {
  text: string;
  start: number;
  end: number;
}

/** The surrounding words supply components. The segmenter never executes zei. */
export function zeiOperands(
  words: readonly MorphologyWord[],
  input: string,
): ZeiOperand[] | null {
  if (
    words.length < 3 ||
    words[0].start !== 0 ||
    words.at(-1)!.end !== input.length
  )
    return null;
  const parts: ZeiOperand[] = [];
  let pending: MorphologyWord[] = [];
  for (const [index, word] of words.entries()) {
    if (
      index > 0 &&
      !/^[.\t\n\r ]*$/.test(input.slice(words[index - 1].end, word.start))
    )
      return null;
    if (word.kind === "cmavo" && word.text === "zei") {
      const part = zeiOperand(pending, input);
      if (part === null) return null;
      parts.push(part);
      pending = [];
    } else pending.push(word);
  }
  const last = zeiOperand(pending, input);
  if (last === null || parts.length === 0) return null;
  parts.push(last);
  return parts;
}

export function zeiOperand(
  words: readonly MorphologyWord[],
  input: string,
): ZeiOperand | null {
  if (
    words.length === 0 ||
    words[0].text === "zei" ||
    words.slice(1).some((word) => word.kind !== "cmavo" || word.text !== "bu")
  )
    return null;
  const start = words[0].start;
  const end = words.at(-1)!.end;
  return { text: input.slice(start, end), start, end };
}

export function zeiReading(parts: readonly ZeiOperand[]): RecoveredPart[] {
  return parts.map((part, index) => ({
    text: part.text,
    kind: "core",
    join_before: index === 0 ? null : ZEI_JOIN,
  }));
}
