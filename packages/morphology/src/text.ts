import { BuilderError, invalid, requireLimit, resource } from "./errors.ts";
import { normalizeTextOrthography } from "./orthography.ts";
import { utf8Length } from "./phonotactics.ts";
import { readPeggyWords } from "./recognize.ts";
import type { MorphologyWord } from "./types.ts";
import { ACUTE_ACCENT_ERROR } from "./accents.ts";

export const TEXT_BYTE_LIMIT = 1024 * 1024;
export const TEXT_WORK_LIMIT = 5_000_000;
export const TEXT_RUN_LIMIT = 128;

export interface TextSegmentationOptions {
  byteLimit?: number;
  workLimit?: number;
  features?: readonly string[];
  withoutFeatures?: readonly string[];
}

export interface ForeignRun {
  text: string;
  start: number;
  end: number;
}

export interface TextSegmentation {
  words: MorphologyWord[];
  foreign: ForeignRun[];
  spent: number;
}

/** Segment complete text. All source offsets count UTF-16 code units. */
export function segmentText(
  input: string,
  options: TextSegmentationOptions = {},
): TextSegmentation {
  const byteLimit = options.byteLimit ?? TEXT_BYTE_LIMIT;
  const workLimit = options.workLimit ?? TEXT_WORK_LIMIT;
  for (const limit of [byteLimit, workLimit]) {
    if (!Number.isSafeInteger(limit) || limit < 0)
      invalid("Text segmentation limits must be nonnegative safe integers.");
  }
  requireLimit("text byte limit", byteLimit, TEXT_BYTE_LIMIT);
  requireLimit("text work limit", workLimit, TEXT_WORK_LIMIT);
  requireLimit("text bytes", utf8Length(input), byteLimit);
  const { runs } = normalizeTextOrthography(input, {
    ...options,
    acuteAsDisplay: true,
  });
  const words: MorphologyWord[] = [];
  const foreign: ForeignRun[] = [];
  let spent = 0;
  for (const run of runs) {
    if (!run.spans.length) continue;
    const start = run.spans[0].start;
    const end = run.spans.at(-1)!.end;
    const original = input.slice(start, end);
    const accented = original.normalize("NFD").includes("\u0301");
    if (run.foreign) {
      foreign.push({ text: input.slice(start, end), start, end });
      continue;
    }
    requireLimit("text run phonemes", run.text.length, TEXT_RUN_LIMIT);
    let parsed: ReturnType<typeof readPeggyWords>;
    try {
      parsed = readPeggyWords(run.text, workLimit - spent, true);
    } catch (error) {
      if (
        error instanceof BuilderError &&
        error.failure.kind === "resource-limit"
      ) {
        resource(
          "text recognition work",
          spent + error.failure.value!,
          workLimit,
        );
      }
      throw error;
    }
    spent += parsed.spent;
    if (!parsed.words.length) {
      if (accented) invalid(ACUTE_ACCENT_ERROR);
      foreign.push({ text: input.slice(start, end), start, end });
      continue;
    }
    for (const word of parsed.words) {
      const source = input.slice(
        run.spans[word.start].start,
        run.spans[word.end - 1].end,
      );
      if (source.normalize("NFD").includes("\u0301")) {
        let letter = false;
        for (const char of source.normalize("NFD")) {
          if (char === "\u0301" && !letter)
            invalid("An acute accent must follow a Lojban vowel or consonant.");
          letter = /\p{L}/u.test(char);
        }
        if (word.kind !== "cmevla") invalid(ACUTE_ACCENT_ERROR);
      }
      words.push({
        ...word,
        text: word.text.replace(/[qɩ]/g, "i").replace(/[wʋ]/g, "u"),
        start: run.spans[word.start].start,
        end: run.spans[word.end - 1].end,
      });
    }
  }
  return { words, foreign, spent };
}
