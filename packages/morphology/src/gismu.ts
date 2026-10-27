/** CLL 4.14 generation with exact rational scores and complete conflict lists. */
import type {
  CalculatedRational,
  GismuCandidate,
  GismuRequest,
  GismuResult,
  GismuSourceRow,
  RafsiInventoryClaim,
} from "./types.ts";
import { DetailBudget } from "./detail-budget.ts";
import { invalid, requireLimit } from "./errors.ts";
import {
  CONSONANTS,
  VOWELS,
  asciiLower,
  isConsonant,
  isInitialPair,
  isPermissiblePair,
  isVowel,
  normalizeWord,
  trimWord,
  utf8Length,
} from "./phonotactics.ts";
import { gismuShape, possibleShortRafsi } from "./rafsi.ts";

export const ALGORITHM_ID =
  "https://github.com/int19h/jbovlacku/blob/main/docs/morphology.md#gismu-generator";
export const ALGORITHM_VERSION = "1";
export const WEIGHTING = "normalize-positive-sum-v1";
export const MATCHING = "cll-letter-match-v1";
export const TRANSLITERATION = "literal-lojbanized-v1";
export const CANDIDATES_SOURCE_LETTERS = "cll-gismu-forms-v1";
export const CANDIDATES_ALL_LETTERS = "cll-gismu-forms-all-letters-v1";
export const AGGREGATION = "maximum-per-language-v1";

type Rational = readonly [bigint, bigint];
function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}
const lcm = (a: bigint, b: bigint): bigint => (a / gcd(a, b)) * b;
function rational(n: bigint, d: bigint): Rational {
  const divisor = gcd(n, d);
  return [n / divisor, d / divisor];
}
const add = (a: Rational, b: Rational): Rational =>
  rational(a[0] * b[1] + b[0] * a[1], a[1] * b[1]);
const calculated = (value: Rational): CalculatedRational => ({
  numerator: String(value[0]),
  denominator: String(value[1]),
});
function parseRational(value: GismuSourceRow["weight"]): Rational | null {
  const part = (v: unknown): bigint | null => {
    if (
      typeof v === "number" &&
      Number.isInteger(v) &&
      v >= 0 &&
      v < Number(1n << 64n)
    ) {
      const n = BigInt(String(v));
      return n <= (1n << 64n) - 1n ? n : null;
    }
    if (typeof v === "string" && v.length <= 64 && /^(0|[1-9][0-9]*)$/.test(v))
      return BigInt(v);
    return null;
  };
  if (!value) return null;
  const n = part(value.numerator),
    d = part(value.denominator);
  return n !== null && d !== null && d !== 0n ? rational(n, d) : null;
}
/** CLL recognition count, including its special rule for two matched letters. */
export function matchScore(
  candidate: readonly string[] | string,
  source: readonly string[] | string,
): number {
  const left = typeof candidate === "string" ? [...candidate] : candidate;
  const right = typeof source === "string" ? [...source] : source;
  let previous = new Uint32Array(right.length + 1),
    current = new Uint32Array(right.length + 1);
  for (const l of left) {
    for (let j = 0; j < right.length; j++) {
      current[j + 1] =
        l === right[j]
          ? previous[j] + 1
          : Math.max(previous[j + 1], current[j]);
    }
    [previous, current] = [current, previous];
    current.fill(0);
  }
  const length = previous[right.length];
  if (length >= 3) return length;
  if (length !== 2) return 0;
  for (let a = 0; a < left.length; a++) {
    for (let b = a + 1; b < left.length && b - a <= 2; b++) {
      const gap = b - a;
      for (let c = 0; c + gap < right.length; c++) {
        if (left[a] === right[c] && left[b] === right[c + gap]) return 2;
      }
    }
  }
  return 0;
}
const SIMILAR: Record<string, string> = {
  b: "pv",
  c: "js",
  d: "t",
  f: "pv",
  g: "kx",
  j: "cz",
  k: "gx",
  l: "r",
  m: "n",
  n: "m",
  p: "bf",
  r: "l",
  s: "cz",
  t: "d",
  v: "bf",
  x: "gk",
  z: "js",
};
/** The directional similar-consonant rule recorded by jbotci. */
export const tooSimilarConsonant = (
  proposed: string,
  existing: string,
): boolean =>
  existing.length === 1 && (SIMILAR[proposed]?.includes(existing) ?? false);

type InventoryGismu = { spelling: string; word: string };
type RootConflict = GismuCandidate["conflicts"][number];
class ConflictIndex {
  private byCandidate = new Map<
    string,
    { entry: InventoryGismu; rule: string }[]
  >();
  constructor(inventory: InventoryGismu[], budget: DetailBudget) {
    budget.scan(inventory.length);
    const insert = (candidate: string, entry: InventoryGismu, rule: string) => {
      budget.scan(1);
      const entries = this.byCandidate.get(candidate) ?? [];
      entries.push({ entry, rule });
      this.byCandidate.set(candidate, entries);
    };
    for (const entry of inventory) {
      if (utf8Length(entry.spelling) !== 5) continue;
      const chars = [...entry.spelling];
      if (chars.length !== 5) continue;
      insert(entry.spelling, entry, "identical");
      if (isVowel(chars[4])) {
        for (const vowel of VOWELS) {
          if (vowel === chars[4]) continue;
          const c = [...chars];
          c[4] = vowel;
          insert(c.join(""), entry, "final-vowel");
        }
      }
      for (let index = 0; index < chars.length; index++) {
        if (!isConsonant(chars[index])) continue;
        for (const proposed of CONSONANTS) {
          if (!tooSimilarConsonant(proposed, chars[index])) continue;
          const c = [...chars];
          c[index] = proposed;
          insert(c.join(""), entry, "similar-consonant");
        }
      }
    }
  }
  preflight(candidate: string, budget: DetailBudget): void {
    const entries = this.byCandidate.get(candidate);
    if (!entries) return;
    budget.scan(entries.length * 2);
    for (const { entry, rule } of entries)
      budget.detail([entry.word, entry.spelling, rule]);
  }
  conflicts(candidate: string): RootConflict[] {
    const out = (this.byCandidate.get(candidate) ?? []).map(
      ({ entry, rule }) => ({
        word: entry.word,
        spelling: entry.spelling,
        rule,
      }),
    );
    out.sort(
      (a, b) => compare(a.spelling, b.spelling) || compare(a.rule, b.rule),
    );
    return out.filter(
      (entry, i) =>
        i === 0 ||
        entry.word !== out[i - 1].word ||
        entry.rule !== out[i - 1].rule,
    );
  }
}
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
interface Language {
  language: string;
  weight: Rational;
  inputs: string[][];
}
function normalizeInput(text: string): string[] {
  requireLimit("scoring input bytes", utf8Length(text), 256);
  const chars = [...asciiLower(trimWord(text))].filter(
    (c) => c !== "'" && c !== "," && c !== ".",
  );
  if (chars.length === 0) invalid("A scoring input is empty.");
  if (chars.length > 64) invalid("A scoring input has more than 64 letters.");
  const bad = chars.find((c) => !(isVowel(c) || isConsonant(c) || c === "y"));
  if (bad !== undefined)
    invalid(`A scoring input uses "${bad}", which is not a Lojban letter.`);
  return chars;
}
function resolveLanguages(sources: GismuSourceRow[]): Language[] {
  if (sources.length === 0 || sources.length > 64)
    invalid("The generator needs 1 through 64 source rows.");
  const byLanguage = new Map<string, Language>();
  for (const row of sources) {
    requireLimit("language bytes", utf8Length(row.language), 64);
    requireLimit("source word bytes", utf8Length(row.word), 256);
    for (const field of [row.weight?.numerator, row.weight?.denominator]) {
      if (typeof field === "string")
        requireLimit("weight digits", utf8Length(field), 64);
    }
    const language = trimWord(row.language);
    if (!language) invalid("A source row has no language.");
    const weight = parseRational(row.weight);
    if (!weight)
      invalid(
        `The weight of ${language} is missing or not a nonnegative rational.`,
      );
    if (row.input == null)
      invalid(`The source row for ${language} has no scoring input.`);
    const input = normalizeInput(row.input);
    const existing = byLanguage.get(language);
    if (existing) {
      if (
        existing.weight[0] !== weight[0] ||
        existing.weight[1] !== weight[1]
      ) {
        invalid(
          `The rows for ${language} have different weights. Alternatives of one language share one weight.`,
        );
      }
      existing.inputs.push(input);
    } else byLanguage.set(language, { language, weight, inputs: [input] });
  }
  return [...byLanguage.values()];
}
function generateInventory(
  recipe: GismuRequest["candidates"],
  languages: Language[],
): string[] {
  const inputs = languages.flatMap((l) => l.inputs.flat());
  const consonants =
    recipe === "all-letters"
      ? [...CONSONANTS]
      : [...new Set(inputs.filter(isConsonant))].sort();
  const vowels =
    recipe === "all-letters"
      ? [...VOWELS]
      : [...new Set(inputs.filter(isVowel))].sort();
  const out: string[] = [];
  for (const c0 of consonants)
    for (const c1 of consonants) {
      if (!isInitialPair(c0, c1)) continue;
      for (const v2 of vowels)
        for (const c3 of consonants)
          for (const v4 of vowels) out.push(c0 + c1 + v2 + c3 + v4);
    }
  for (const c0 of consonants)
    for (const v1 of vowels)
      for (const c2 of consonants)
        for (const c3 of consonants) {
          if (!isPermissiblePair(c2, c3)) continue;
          for (const v4 of vowels) out.push(c0 + v1 + c2 + c3 + v4);
        }
  return [...new Set(out)].sort();
}
interface Scored {
  sum: bigint;
  form: string;
  best: [number, number][];
}
class Scorer {
  tables: bigint[][][];
  denominator: bigint;
  constructor(languages: Language[], total: Rational) {
    let lengthLcm = 1n,
      weightLcm = 1n;
    for (const language of languages) {
      for (const input of language.inputs)
        lengthLcm = lcm(lengthLcm, BigInt(input.length));
      weightLcm = lcm(weightLcm, language.weight[1]);
    }
    weightLcm = lcm(weightLcm, total[1]);
    const scale = lengthLcm * weightLcm;
    this.denominator = (total[0] * scale) / total[1];
    this.tables = languages.map((language) =>
      language.inputs.map((input) =>
        Array.from(
          { length: 6 },
          (_, m) =>
            (language.weight[0] * scale * BigInt(m)) /
            (language.weight[1] * BigInt(input.length)),
        ),
      ),
    );
  }
  score(form: string, languages: Language[]): Scored {
    let sum = 0n;
    const best: [number, number][] = [];
    const candidate = [...form];
    for (let l = 0; l < languages.length; l++) {
      let chosen: [number, number] = [0, 0],
        chosenValue = 0n;
      for (let a = 0; a < languages[l].inputs.length; a++) {
        const m = Math.min(matchScore(candidate, languages[l].inputs[a]), 5);
        const value = this.tables[l][a][m];
        if (
          a === 0 ||
          value > chosenValue ||
          (value === chosenValue && m > chosen[1])
        ) {
          chosen = [a, m];
          chosenValue = value;
        }
      }
      sum += chosenValue;
      best.push(chosen);
    }
    return { sum, form, best };
  }
  rational(value: bigint): Rational {
    return this.denominator === 0n
      ? [0n, 1n]
      : rational(value, this.denominator);
  }
}
/** The search completes or throws. The window limits only the returned rows. */
export function generateGismu(
  request: GismuRequest,
  detailBudget = new DetailBudget(),
): GismuResult {
  const languages = resolveLanguages(request.sources);
  let denominatorLcm = 1n;
  const bits = (n: bigint) => (n === 0n ? 0 : n.toString(2).length);
  for (const language of languages) {
    denominatorLcm = lcm(denominatorLcm, language.weight[1]);
    requireLimit("weight arithmetic bits", bits(denominatorLcm), 4096);
  }
  const total = languages.reduce((sum, language) => add(sum, language.weight), [
    0n,
    1n,
  ] as Rational);
  if (total[0] === 0n)
    invalid("At least one language weight must be positive.");
  for (const part of total)
    requireLimit("weight arithmetic bits", bits(part), 4096);
  const roots = request.inventory?.gismu ?? [],
    claims = request.inventory?.claims ?? [];
  requireLimit("inventory rows", Math.max(roots.length, claims.length), 20_000);
  const window = Math.min(request.window ?? 32, 512);
  const inventory = generateInventory(request.candidates, languages);
  const letters = languages.reduce(
    (sum, l) => sum + l.inputs.reduce((n, input) => n + input.length, 0),
    0,
  );
  requireLimit(
    "candidates times input letters",
    inventory.length * Math.max(letters, 1),
    Math.min(request.limits?.work ?? 60_000_000, 60_000_000),
  );
  const scorer = new Scorer(languages, total);
  const scored = inventory.map((form) => scorer.score(form, languages));
  scored.sort((a, b) =>
    a.sum > b.sum ? -1 : a.sum < b.sum ? 1 : compare(a.form, b.form),
  );
  const ranks: number[] = [];
  for (let i = 0; i < scored.length; i++)
    ranks.push(
      i > 0 && scored[i].sum === scored[i - 1].sum ? ranks[i - 1] : i + 1,
    );
  const conflicts = new ConflictIndex(roots, detailBudget);
  detailBudget.scan(claims.length);
  const claimsByRafsi = new Map<string, RafsiInventoryClaim[]>();
  for (const claim of claims) {
    const entries = claimsByRafsi.get(claim.rafsi) ?? [];
    entries.push(claim);
    claimsByRafsi.set(claim.rafsi, entries);
  }
  const describe = (
    { form, sum, best }: Scored,
    rank: number | null,
  ): GismuCandidate => {
    const shortRafsi = possibleShortRafsi(form);
    conflicts.preflight(form, detailBudget);
    for (const rafsi of shortRafsi) {
      const entries = claimsByRafsi.get(rafsi);
      if (!entries) continue;
      detailBudget.scan(entries.length * 2);
      for (const claim of entries)
        detailBudget.detail([rafsi, claim.word, claim.spelling, claim.pair]);
    }
    return {
      form,
      score: calculated(scorer.rational(sum)),
      rank,
      contributions: languages.map((language, l) => {
        const [a, m] = best[l];
        return {
          language: language.language,
          input: language.inputs[a].join(""),
          matched: m,
          length: language.inputs[a].length,
          weighted: calculated(scorer.rational(scorer.tables[l][a][m])),
        };
      }),
      short_rafsi: shortRafsi,
      conflicts: conflicts.conflicts(form),
      rafsi_conflicts: shortRafsi.flatMap((rafsi) =>
        (claimsByRafsi.get(rafsi) ?? []).map((c) => ({
          rafsi,
          word: c.word,
          spelling: c.spelling,
          pair: c.pair,
        })),
      ),
    };
  };
  const candidates = scored
    .slice(0, window)
    .map((s, i) => describe(s, ranks[i]));
  const diagnostics: string[] = [];
  let manual: GismuCandidate | null = null;
  const entered = request.manual == null ? "" : trimWord(request.manual);
  if (entered) {
    const normalized = normalizeWord(entered);
    if (normalized === null)
      diagnostics.push(
        "The manual form uses characters outside Lojban letters.",
      );
    else if (gismuShape(normalized) === null)
      diagnostics.push(
        `"${normalized}" is not a gismu shape, so it has no generation score.`,
      );
    else {
      const score = scorer.score(normalized, languages);
      const index = scored.findIndex((s) => s.form === normalized);
      const rank = index < 0 ? null : ranks[index];
      if (rank === null)
        diagnostics.push(
          `"${normalized}" is outside the generated inventory, so it has a score but no rank.`,
        );
      manual = describe(score, rank);
    }
  }
  if (request.inventory?.snapshot == null)
    diagnostics.push(
      "No inventory snapshot was supplied. Conflict coverage is unknown.",
    );
  return {
    languages: languages.map((l) => ({
      language: l.language,
      weight: calculated(l.weight),
      normalized: calculated(
        rational(l.weight[0] * total[1], l.weight[1] * total[0]),
      ),
      inputs: l.inputs.map((i) => i.join("")),
    })),
    considered: inventory.length,
    complete: true,
    candidates,
    manual,
    algorithm: { id: ALGORITHM_ID, version: ALGORITHM_VERSION },
    parameters: {
      weighting: WEIGHTING,
      matching: MATCHING,
      transliteration: TRANSLITERATION,
      candidates:
        request.candidates === "all-letters"
          ? CANDIDATES_ALL_LETTERS
          : CANDIDATES_SOURCE_LETTERS,
      aggregation: AGGREGATION,
    },
    diagnostics,
  };
}
