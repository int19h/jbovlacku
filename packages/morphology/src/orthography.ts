/**
 * Text orthography follows gencmu 0b3da7d2ec2f727a6730d77c775f88214a7ffc89,
 * grammars/phonemes/{latin-strict,latin,latin-experimental,cyrillic,
 * cyrillic-experimental,zbalermorna}.md. See ../THIRD-PARTY-NOTICES.md.
 * This layer is for text segmentation. Headword admission does not use it.
 */
export interface OrthographySpan {
  start: number;
  end: number;
}
export interface OrthographyRun {
  text: string;
  spans: OrthographySpan[];
  foreign: boolean;
}

export interface OrthographyOptions {
  features?: readonly string[];
  withoutFeatures?: readonly string[];
}

interface Scalar extends OrthographySpan {
  value: string;
}
interface Letter extends OrthographySpan {
  text: string;
  vowel: boolean;
  capital?: boolean;
  accented?: boolean;
  syllabic?: boolean;
  dieresis?: boolean;
  shorthand?: boolean;
  foldingBlocked?: boolean;
}

const consonants = "bcdfgjklmnprstvxz";
const cyrillicConsonants: Record<string, string> = {
  б: "b",
  ш: "c",
  щ: "c",
  д: "d",
  ф: "f",
  г: "g",
  ґ: "g",
  ж: "j",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  в: "v",
  х: "x",
  з: "z",
};
const cyrillicVowels: Record<string, string> = {
  а: "a",
  е: "e",
  э: "e",
  є: "e",
  и: "i",
  і: "i",
  о: "o",
  у: "u",
  ъ: "y",
  ы: "y",
  ә: "y",
  ј: "i",
};
const digits = ["no", "pa", "re", "ci", "vo", "mu", "xa", "ze", "bi", "so"];
const mark = /\p{M}/u;
const letter = /\p{L}/u;
const punctuation = /[\p{P}\p{S}]/u;
const format = /\p{Cf}/u;
const whitespace = /\p{White_Space}/u;
const quote = new Set(["'", "’", "‘", "`", "´"]);
const silent = new Set([",", "~", "～", "〜", "ー", "ｰ", "·"]);

function zbalCode(value: string): number {
  const code = value.codePointAt(0)!;
  return code >= 0xf28a0 && code <= 0xf28df ? code - 0xe3b20 : code;
}
function breakingFormat(value: string): boolean {
  const c = value.codePointAt(0)!;
  return (
    c === 0x200b ||
    (c >= 0x600 && c <= 0x605) ||
    c === 0x6dd ||
    c === 0x70f ||
    c === 0x890 ||
    c === 0x891 ||
    c === 0x8e2 ||
    c === 0x110bd ||
    c === 0x110cd
  );
}
function ignored(value: string): boolean {
  return (
    silent.has(value) ||
    (format.test(value) && !breakingFormat(value)) ||
    [0xed8c, 0xed99, 0xed9a, 0xed9b].includes(zbalCode(value))
  );
}
function period(value: string): boolean {
  return (
    value === "." ||
    value === "ӏ" ||
    value === "Ӏ" ||
    zbalCode(value) === 0xed89
  );
}
function quoteLetter(value: string): boolean {
  return letter.test(value) && !ignored(value) && !period(value);
}
function innerQuote(items: Scalar[], index: number): boolean {
  let left = index - 1;
  let right = index + 1;
  while (left >= 0 && ignored(items[left]!.value)) left--;
  while (left >= 0 && mark.test(items[left]!.value)) left--;
  while (right < items.length && ignored(items[right]!.value)) right++;
  return (
    left >= 0 &&
    right < items.length &&
    quoteLetter(items[left]!.value) &&
    quoteLetter(items[right]!.value)
  );
}

/** Expand canonical decompositions while keeping the original UTF-16 offsets. */
function scalars(input: string, caseInsensitive: boolean): Scalar[] {
  const result: Scalar[] = [];
  let start = 0;
  for (const value of input) {
    const end = start + value.length;
    for (const part of value.normalize("NFD"))
      result.push({
        value: caseInsensitive ? part.toLowerCase() : part,
        start,
        end,
      });
    start = end;
  }
  return result;
}

function readLetter(
  items: Scalar[],
  index: number,
  cllCyrillic = false,
): { letter: Letter; next: number } | undefined {
  const first = items[index]!;
  const lower = first.value.toLowerCase();
  const code = zbalCode(first.value);
  let next = index + 1;
  let marks = "";
  // Only Latin and Cyrillic letters take arbitrary Unicode combining marks.
  const takesMarks =
    consonants.includes(lower) ||
    "aeiouyhqwɩꜷꜶʼһ".includes(lower) ||
    cyrillicConsonants[lower] !== undefined ||
    cyrillicVowels[lower] !== undefined;
  if (takesMarks)
    while (next < items.length && mark.test(items[next]!.value))
      marks += items[next++]!.value;
  let end = items[next - 1]!.end;
  const accented = /[\u0300\u0301]/u.test(marks);
  const capital = first.value !== lower;
  const result = (
    text: string,
    vowel = false,
    extra: Partial<Letter> = {},
  ) => ({
    letter: { text, vowel, start: first.start, end, ...extra },
    next,
  });
  if (consonants.includes(lower)) return result(lower);
  if (cyrillicConsonants[lower] && (!cllCyrillic || !"щґ".includes(lower)))
    return result(cyrillicConsonants[lower]!);
  if (
    lower === "h" ||
    (lower === "һ" && !cllCyrillic) ||
    lower === "ʼ" ||
    code === 0xed8a
  )
    return result("'");
  if (/^[0-9]$/u.test(lower)) return result(digits[Number(lower)]!);
  if ("aeiouyqwɩꜷ".includes(lower) || lower === "Ꜷ") {
    let text = lower;
    const breve = marks.includes("\u0306") && (lower === "i" || lower === "u");
    const glide = breve || "qwɩ".includes(lower);
    if (glide)
      text = breve ? (lower === "i" ? "ɩ" : "ʋ") : lower === "w" ? "w" : "q";
    else if (lower === "ꜷ" || lower === "Ꜷ") text = "au";
    else if (
      lower === "a" &&
      marks.includes("\u0328") &&
      marks.includes("\u030c")
    )
      return undefined;
    else if ("aeo".includes(lower) && marks.includes("\u0328")) text += "i";
    else if (lower === "a" && marks.includes("\u030c")) text = "au";
    if (!glide && (capital || accented))
      text = text[0]!.toUpperCase() + text.slice(1);
    return result(text, true, {
      capital,
      accented: accented && !glide,
      dieresis: marks.includes("\u0308"),
    });
  }
  if (cyrillicVowels[lower] && (!cllCyrillic || "аеиоуъ".includes(lower))) {
    const glide =
      !cllCyrillic &&
      (lower === "ј" ||
        ((lower === "и" || lower === "у") && marks.includes("\u0306")));
    const value = cyrillicVowels[lower]!;
    return result(
      !glide && (capital || accented) ? value.toUpperCase() : value,
      true,
      {
        capital,
        accented: accented && !glide,
        syllabic: !glide && !cllCyrillic,
        foldingBlocked: cllCyrillic,
      },
    );
  }
  const zbalConsonants: Record<number, string> = {
    0xed80: "p",
    0xed81: "t",
    0xed82: "k",
    0xed83: "f",
    0xed84: "l",
    0xed85: "s",
    0xed86: "c",
    0xed87: "m",
    0xed88: "x",
    0xed90: "b",
    0xed91: "d",
    0xed92: "g",
    0xed93: "v",
    0xed94: "r",
    0xed95: "z",
    0xed96: "j",
    0xed97: "n",
  };
  if (zbalConsonants[code]) return result(zbalConsonants[code]!);
  let zbalVowel =
    code >= 0xeda0 && code <= 0xeda5
      ? "aeiouy"[code - 0xeda0]
      : code >= 0xedb0 && code <= 0xedb5
        ? "aeiouy"[code - 0xedb0]
        : code >= 0xeda6 && code <= 0xeda9
          ? ["ai", "ei", "oi", "au"][code - 0xeda6]
          : code === 0xedaa
            ? "i"
            : code === 0xedab
              ? "u"
              : undefined;
  if (zbalVowel) {
    if (
      code !== 0xedaa &&
      code !== 0xedab &&
      next < items.length &&
      zbalCode(items[next]!.value) === 0xed98
    ) {
      while (next < items.length && zbalCode(items[next]!.value) === 0xed98)
        end = items[next++]!.end;
      zbalVowel = zbalVowel[0]!.toUpperCase() + zbalVowel.slice(1);
    }
    return result(zbalVowel, true);
  }
  if (
    code === 0xed8b &&
    next < items.length &&
    zbalCode(items[next]!.value) !== 0xed8b
  ) {
    const vowel = readLetter(items, next, cllCyrillic);
    if (
      vowel?.letter.vowel &&
      vowel.letter.text.length === 1 &&
      !vowel.letter.dieresis
    ) {
      return {
        letter: {
          ...vowel.letter,
          start: first.start,
          text: vowel.letter.text + "'",
          vowel: false,
          shorthand: true,
        },
        next: vowel.next,
      };
    }
  }
  return undefined;
}

function normalizeRun(
  input: string,
  items: Scalar[],
  cllCyrillic: boolean,
): OrthographyRun | undefined {
  let first = 0;
  let last = items.length;
  while (first < last && ignored(items[first]!.value)) first++;
  while (last > first && ignored(items[last - 1]!.value)) last--;
  items = items.slice(first, last);
  if (!items.length) return undefined;
  const letters: Letter[] = [];
  for (let index = 0; index < items.length; ) {
    const item = items[index]!;
    if (ignored(item.value)) {
      index++;
      continue;
    }
    if (quote.has(item.value)) {
      letters.push({
        text: "'",
        vowel: false,
        start: item.start,
        end: item.end,
      });
      index++;
      continue;
    }
    if (item.value === ".") {
      letters.push({
        text: "pi",
        vowel: false,
        start: item.start,
        end: item.end,
      });
      index++;
      continue;
    }
    const read = readLetter(items, index, cllCyrillic);
    if (!read) {
      const start = items[0]!.start;
      const end = items[items.length - 1]!.end;
      const text = input.slice(start, end);
      const spans: OrthographySpan[] = [];
      for (let offset = start; offset < end; offset++)
        spans.push({ start: offset, end: offset + 1 });
      return { text, spans, foreign: true };
    }
    letters.push(read.letter);
    index = read.next;
  }
  let groups = 0;
  let previousVowel = false;
  let canFold = true;
  for (const item of letters) {
    if (item.shorthand || item.foldingBlocked) canFold = false;
    if (item.vowel) {
      if (!item.capital) canFold = false;
      if (!previousVowel || item.dieresis) groups++;
    }
    previousVowel = item.vowel;
  }
  const fold = canFold && groups >= 2;
  let text = "";
  const spans: OrthographySpan[] = [];
  let previousSyllabic = false;
  for (const item of letters) {
    if (item.dieresis || (previousSyllabic && item.syllabic)) {
      text += "'";
      spans.push({ start: item.start, end: item.start });
    }
    const value = fold && !item.accented ? item.text.toLowerCase() : item.text;
    text += value;
    for (let i = 0; i < value.length; i++)
      spans.push({ start: i ? item.end : item.start, end: item.end });
    previousSyllabic = item.vowel && Boolean(item.syllabic);
  }
  return { text, spans, foreign: false };
}

/** Read pause-bounded runs and map every grammar character to its source span. */
export function normalizeTextOrthography(
  input: string,
  options: OrthographyOptions = {},
): { runs: OrthographyRun[] } {
  const enabled = (name: string) =>
    Boolean(options.features?.includes(name)) &&
    !options.withoutFeatures?.includes(name);
  const cllCyrillic = enabled("cll-cyrillic");
  const items = scalars(input, enabled("case-insensitive"));
  const runs: OrthographyRun[] = [];
  let current: Scalar[] = [];
  const finish = () => {
    const run = normalizeRun(input, current, cllCyrillic);
    if (run) runs.push(run);
    current = [];
  };
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!;
    const value = item.value;
    const decimal =
      value === "." &&
      /^[0-9]$/u.test(items[index - 1]?.value ?? "") &&
      /^[0-9]$/u.test(items[index + 1]?.value ?? "");
    const recognized = readLetter(items, index, cllCyrillic) !== undefined;
    const boundary =
      !ignored(value) &&
      (whitespace.test(value) ||
        breakingFormat(value) ||
        (period(value) &&
          !(cllCyrillic && (value === "ӏ" || value === "Ӏ")) &&
          !decimal) ||
        (quote.has(value)
          ? !innerQuote(items, index)
          : punctuation.test(value) && !recognized && !decimal));
    if (boundary) {
      finish();
      if (!whitespace.test(value) && !period(value)) {
        while (index + 1 < items.length && mark.test(items[index + 1]!.value))
          index++;
      }
    } else current.push(item);
  }
  finish();
  return { runs };
}
