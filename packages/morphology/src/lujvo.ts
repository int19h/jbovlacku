/** Lujvo bonding, scoring, segmentation, and component construction.
 * These profiles preserve the pinned Rust implementation and its work limits.
 */
import type {
  MorphologyProfile,
  RecoveredPart,
  WordAnalysis,
  LujvoComponentRequest,
  LujvoRequest,
  LujvoChoice,
  LujvoCandidate,
  LujvoResult,
  RafsiInventoryClaim,
} from "./types.ts";
import { DetailBudget } from "./detail-budget.ts";
import { BuilderError, invalid, requireLimit, resource } from "./errors.ts";
import {
  asciiLower,
  isConsonant,
  isInitialPair,
  isVowel,
  pairClass,
  normalizeWord,
  trimWord,
  isPermissiblePair,
} from "./phonotactics.ts";
import {
  gismuShape,
  isShortRafsiForm,
  rafsiShape,
  rafsiShapeScore,
  universalGismuForms,
} from "./rafsi.ts";
import {
  parse,
  parseProfileMetered,
  MAX_WORD_BYTES,
} from "./legacy-recognize.ts";
import type { Reading } from "./legacy-recognize.ts";

import { analyzePeggyWord, parsePeggyMetered } from "./recognize.ts";
import {
  ACUTE_ACCENT_ERROR,
  applyAcuteRules,
  normalizeAcuteDisplay,
  stripAcuteAccents,
} from "./accents.ts";
import {
  ZEI_JOIN,
  ZEI_SCORING_ID,
  zeiOperand,
  zeiOperands,
  zeiReading,
} from "./zei.ts";

export const CLL_MORPHOLOGY_ID =
  "https://github.com/int19h/jbovlacku/blob/main/docs/morphology.md#cll-lujvo";
export const EXTENDED_MORPHOLOGY_ID =
  "https://github.com/int19h/jbovlacku/blob/main/docs/morphology.md#extended-lujvo";
export const CLL_SCORING_ID =
  "https://github.com/int19h/jbovlacku/blob/main/docs/morphology.md#cll-lujvo-scoring";
export const EXTENDED_SCORING_ID =
  "https://github.com/int19h/jbovlacku/blob/main/docs/morphology.md#extended-lujvo-scoring";
export const MORPHOLOGY_VERSION = "2";
export const SCORING_VERSION = "1";
export type Profile = MorphologyProfile;
export interface Part {
  text: string;
  kind: "rafsi" | "core";
}
export type RowAnalysis = LujvoResult["rows"][number];
type Inventory = NonNullable<LujvoRequest["inventory"]>;
const bytes = (text: string): number => new TextEncoder().encode(text).length;
const tail = (text: string): string => Array.from(text).at(-1) ?? "";
const same = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length &&
  left.every((item, index) => item === right[index]);
const lexical = (left: string, right: string): number => {
  const a = Array.from(left, (character) => character.codePointAt(0)!);
  const b = Array.from(right, (character) => character.codePointAt(0)!);
  for (let i = 0; i < Math.min(a.length, b.length); i++)
    if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
};
const brivla = (reading: Reading): boolean =>
  ["gismu", "lujvo", "fuhivla"].includes(reading.kind);
const isExtended = (profile: Profile): boolean =>
  profile === "extended" || String(profile) === "extended-v4";
/** All profile recognition passes through this function, including work accounting. */
export function parseFor(
  profile: Profile,
  word: string,
): { reading: Reading; spent: number } {
  return profile === "extended-v4"
    ? parsePeggyMetered(word)
    : parseProfileMetered(word, isExtended(profile));
}
function morphology(profile: Profile) {
  return {
    id: profile === "cll" ? CLL_MORPHOLOGY_ID : EXTENDED_MORPHOLOGY_ID,
    version:
      String(profile) === "extended-v4"
        ? "4"
        : profile === "extended"
          ? "3"
          : MORPHOLOGY_VERSION,
  };
}
export function isHyphen(token: string): boolean {
  return ["y", "y'", "'y", "'y'", "r", "n"].includes(token);
}
function needsYHyphen(
  previous: string,
  next: string,
  allowMz: boolean,
): boolean {
  const left = tail(previous),
    right = next[0] ?? "";
  return (
    ["cvcc", "ccvc"].includes(rafsiShape(previous)) ||
    (isConsonant(left) &&
      isConsonant(right) &&
      pairClass(left, right) === "forbidden" &&
      !(allowMz && left === "m" && right === "z")) ||
    (left === "n" &&
      ["ts", "tc", "dz", "dj"].some((pair) => next.startsWith(pair)))
  );
}
function startsWithVowelNucleusAfterY(text: string): boolean {
  const [first = "", second = ""] = text;
  return isVowel(first) && (!["i", "u"].includes(first) || !isVowel(second));
}
function hyphenForPair(
  previous: Part,
  next: Part,
  allowMz: boolean,
): string | null {
  if (previous.kind === "core" && isVowel(tail(previous.text))) return "'y";
  if (
    needsYHyphen(previous.text, next.text, allowMz) ||
    (isConsonant(tail(previous.text)) && isVowel(next.text[0] ?? ""))
  )
    return startsWithVowelNucleusAfterY(next.text) ? "y'" : "y";
  return null;
}
function pairIsInitial(left: string, right: string): boolean {
  return (
    isConsonant(tail(left)) &&
    isConsonant(right[0] ?? "") &&
    isInitialPair(tail(left), right[0])
  );
}
export function tosmabru(tokens: readonly string[]): boolean {
  const last = tokens.at(-1);
  if (
    last === undefined ||
    !["a", "e", "i", "o", "u", "y", "'"].includes(tail(last))
  )
    return false;
  const y = tokens.indexOf("y");
  if (y >= 0) {
    const heads = tokens.slice(0, y);
    return (
      heads.length > 1 &&
      heads.every((token) => rafsiShape(token) === "cvc") &&
      heads.slice(1).every((token, index) => pairIsInitial(heads[index], token))
    );
  }
  if (rafsiShape(last) === "cvccv" && isInitialPair(last[2], last[3])) {
    const heads = tokens.slice(0, -1);
    return (
      heads.length > 0 &&
      heads.every((token) => rafsiShape(token) === "cvc") &&
      tokens
        .slice(1)
        .every((token, index) => pairIsInitial(tokens[index], token))
    );
  }
  return false;
}
export function bond(parts: readonly Part[]): string[] | null {
  return bondProfile("extended-v2", parts);
}
export function bondProfile(
  profile: Profile,
  parts: readonly Part[],
): string[] | null {
  if (
    parts.length < 2 ||
    parts.length > 64 ||
    parts.some((part) => !part.text || bytes(part.text) > 128)
  )
    return null;
  const [first, second] = parts;
  const tokens = [first.text];
  if (
    first.kind === "rafsi" &&
    ["cvv", "cv'v"].includes(rafsiShape(first.text)) &&
    (parts.length > 2 || rafsiShape(second.text) !== "ccv")
  )
    tokens.push(second.text.startsWith("r") ? "n" : "r");
  for (let index = 1; index < parts.length; index++) {
    const join = hyphenForPair(
      parts[index - 1],
      parts[index],
      isExtended(profile),
    );
    if (join !== null) tokens.push(join);
    tokens.push(parts[index].text);
  }
  if (tosmabru(tokens)) tokens.splice(1, 0, "y");
  return tokens;
}
export function score(tokens: readonly string[]): number {
  requireLimit("score tokens", tokens.length, 128);
  requireLimit(
    "score bytes",
    tokens.reduce((sum, token) => sum + bytes(token), 0),
    MAX_WORD_BYTES,
  );
  const text = Array.from(tokens.join(""));
  const apostrophes = text.filter((character) => character === "'").length;
  const hyphens = tokens.filter(isHyphen).length;
  const ranks = tokens
    .filter((token) => !isHyphen(token))
    .reduce((sum, token) => sum + rafsiShapeScore(rafsiShape(token)), 0);
  return (
    1000 * text.length -
    500 * apostrophes +
    100 * hyphens -
    10 * ranks -
    text.filter(isVowel).length
  );
}
function rafsiTokenOk(token: string, last: boolean): boolean {
  switch (rafsiShape(token)) {
    case "cvc":
      return !last;
    case "cvcc":
      return !last && isPermissiblePair(token[2], token[3]);
    case "ccvc":
      return !last && isInitialPair(token[0], token[1]);
    case "ccv":
      return isInitialPair(token[0], token[1]);
    case "cvv":
      return isShortRafsiForm(token);
    case "cv'v":
      return true;
    case "cvccv":
    case "ccvcv":
      return last && gismuShape(token) !== null;
    default:
      return false;
  }
}
export function classicTokens(tokens: readonly string[]): boolean {
  const parts = tokens.filter((token) => !isHyphen(token));
  return (
    parts.length >= 2 &&
    parts.every((token, index) =>
      rafsiTokenOk(token, index + 1 === parts.length),
    ) &&
    tokens.every((token) => !["'y", "y'", "'y'"].includes(token))
  );
}
export function segmentCll(word: string): string[][] {
  const reading = parse(word);
  return reading.kind === "lujvo" && classicTokens(reading.tokens)
    ? [reading.tokens]
    : [];
}
export function isBrivlaCore(text: string): boolean {
  return isBrivlaCoreFor("extended-v2", text);
}
function isBrivlaCoreFor(profile: Profile, text: string): boolean {
  if (text.includes("y")) return false;
  try {
    return brivla(parseFor(profile, text).reading);
  } catch {
    return false;
  }
}
function recovered(
  tokens: readonly string[],
  parts: readonly Part[],
): RecoveredPart[] {
  const out: RecoveredPart[] = [];
  let pending: string | null = null;
  for (const token of tokens) {
    if (isHyphen(token)) {
      pending = (pending ?? "") + token;
      continue;
    }
    out.push({
      text: token,
      kind: parts[out.length]?.kind ?? "rafsi",
      join_before: pending,
    });
    pending = null;
  }
  return out;
}
/** This cache belongs to one build. Failed work charges never create a cache entry. */
export class RecognitionBudget {
  spent = 0;
  cores = new Map<string, boolean>();
  charge(spent: number): void {
    this.spent += spent;
    requireLimit("build recognition work", this.spent, 2_000_000);
  }
  coreIsBrivla(text: string, profile: Profile): boolean {
    const cached = this.cores.get(text);
    if (cached !== undefined) return cached;
    const { reading, spent } = parseFor(profile, text);
    this.charge(spent);
    const valid = !text.includes("y") && brivla(reading);
    this.cores.set(text, valid);
    return valid;
  }
}
export function validate(
  profile: Profile,
  parts: readonly Part[],
  tokens: readonly string[],
): RecoveredPart[] {
  return validateChecked(profile, parts, tokens, new RecognitionBudget(), true);
}
export function validateChecked(
  profile: Profile,
  parts: readonly Part[],
  tokens: readonly string[],
  budget: RecognitionBudget,
  requiredOnly: boolean,
): RecoveredPart[] {
  requireLimit("validation parts", parts.length, 64);
  requireLimit("validation tokens", tokens.length, 128);
  for (const part of parts)
    requireLimit("component bytes", bytes(part.text), 128);
  for (const token of tokens) requireLimit("token bytes", bytes(token), 128);
  const bonded = requiredOnly ? bondProfile(profile, parts) : null;
  if (requiredOnly && (bonded === null || !same(bonded, tokens)))
    invalid("The tokens do not use the required construction joins.");
  if (profile === "cll" && parts.some((part) => part.kind === "core"))
    invalid("A whole-word component needs the extended profile.");
  for (const part of parts.filter((part) => part.kind === "core"))
    if (!budget.coreIsBrivla(part.text, profile))
      invalid("A whole-word component must parse as one brivla.");
  requireLimit(
    "word bytes",
    tokens.reduce((sum, token) => sum + bytes(token), 0),
    MAX_WORD_BYTES,
  );
  const { reading, spent } = parseFor(profile, tokens.join(""));
  budget.charge(spent);
  if (reading.kind !== "lujvo")
    invalid("The selected profile does not read this form as one lujvo.");
  if (profile === "cll" && !classicTokens(reading.tokens))
    invalid("CLL rules do not read this form as one lujvo.");
  if (!same(reading.tokens, tokens))
    invalid("The parsed parts differ from the intended parts.");
  if (
    !same(
      reading.tokens.filter((token) => !isHyphen(token)),
      parts.map((part) => part.text),
    )
  )
    invalid("The parsed components differ from the intended components.");
  return recovered(reading.tokens, parts);
}
function isGismuFor(profile: Profile, word: string): boolean {
  return (
    gismuShape(word) !== null ||
    (isExtended(profile) &&
      rafsiShape(word) === "cvccv" &&
      word.slice(2, 4) === "mz")
  );
}
export function rowChoices(
  profile: Profile,
  component: LujvoComponentRequest,
): RowAnalysis {
  return rowChoicesWithParser(
    profile,
    component,
    (word) => parseFor(profile, word).reading,
  );
}
export function rowChoicesWithParser(
  profile: Profile,
  component: LujvoComponentRequest,
  parser: (word: string) => Reading,
): RowAnalysis {
  const diagnostics: string[] = [],
    choices: LujvoChoice[] = [];
  const claims = component.claims ?? [],
    locked = component.locked ?? null;
  const row = (
    normalized: string,
    lockValid: boolean,
    incomplete = false,
  ): RowAnalysis => ({
    id: component.id,
    normalized,
    choices,
    lock_valid: lockValid,
    recognition_incomplete: incomplete,
    diagnostics,
  });
  if (
    bytes(component.spelling) > MAX_WORD_BYTES ||
    claims.length > 64 ||
    claims.some((claim) => bytes(claim.rafsi) > 128)
  ) {
    diagnostics.push(
      "The component exceeds the limit of 128 bytes or 64 claims.",
    );
    return row("", false);
  }
  if (
    stripAcuteAccents(component.spelling) !== component.spelling &&
    (profile === "extended-v4"
      ? analyzePeggyWord(component.spelling)
      : analyzeWord(profile, component.spelling)
    ).kind !== "cmevla"
  )
    invalid(ACUTE_ACCENT_ERROR);
  const normalized = normalizeWord(stripAcuteAccents(component.spelling));
  if (normalized === null) {
    diagnostics.push("The spelling uses characters outside Lojban letters.");
    return row("", locked === null);
  }
  const gismu = isGismuFor(profile, normalized);
  if (component.kind === "gismu" && !gismu)
    diagnostics.push(
      "The spelling is not a gismu shape, so it has no automatic long forms.",
    );
  if (gismu) {
    const forms =
      universalGismuForms(normalized) ??
      (isGismuFor(profile, normalized)
        ? ([normalized.slice(0, 4), normalized] as const)
        : null);
    if (forms !== null) {
      const [stem, full] = forms;
      if (stem !== null)
        choices.push({
          form: stem,
          shape: rafsiShape(stem),
          origin: "stem",
          position: "nonfinal",
          pair: null,
        });
      choices.push({
        form: full,
        shape: rafsiShape(full),
        origin: "final",
        position: "final",
        pair: null,
      });
    }
  }
  for (const claim of claims) {
    const form = normalizeWord(claim.rafsi);
    if (form === null) {
      diagnostics.push(`Claimed rafsi "${claim.rafsi}" is not Lojban letters.`);
      continue;
    }
    if (!isShortRafsiForm(form)) {
      diagnostics.push(
        `Claimed rafsi "${form}" is not a short rafsi shape and is not offered.`,
      );
      continue;
    }
    if (choices.some((choice) => choice.form === form)) continue;
    const shape = rafsiShape(form);
    choices.push({
      form,
      origin: "claim",
      position: shape === "cvc" ? "nonfinal" : "any",
      shape,
      pair: claim.pair,
    });
  }
  if (component.kind === "cmavo") {
    if (claims.length === 0)
      diagnostics.push(
        "A cmavo needs a listed combining form. Its class alone creates none.",
      );
  } else if (component.kind === "cmevla") {
    diagnostics.push("A name has no combining form in a lujvo.");
  } else if (!gismu) {
    let reading: Reading;
    try {
      reading = parser(normalized);
    } catch (error) {
      diagnostics.push(
        `Whole-word recognition is incomplete: ${error instanceof Error ? error.message : String(error)}`,
      );
      const wholeWordLock = locked === normalized;
      const lockValid =
        locked === null ||
        (profile !== "cll" && wholeWordLock) ||
        choices.some((choice) => choice.form === locked);
      if (wholeWordLock) {
        const policy =
          profile !== "cll"
            ? "The whole-word lock waits for complete recognition."
            : "The whole-word lock is invalid under the CLL profile.";
        diagnostics.push(
          `${policy} Candidates use the listed rafsi until recognition finishes.`,
        );
      } else if (!lockValid)
        diagnostics.push(
          `The locked form "${locked ?? ""}" is not one of this component's choices.`,
        );
      return row(normalized, lockValid, true);
    }
    if (!normalized.includes("y") && brivla(reading)) {
      if (profile !== "cll")
        choices.push({
          form: normalized,
          origin: "core",
          shape: "other",
          position: "any",
          pair: null,
        });
      else
        diagnostics.push(
          "The whole word is usable as a long form only under the extended profile.",
        );
    } else if (claims.length === 0)
      diagnostics.push(
        "The spelling is not a brivla shape and has no listed rafsi.",
      );
  }
  const lockValid =
    locked === null || choices.some((choice) => choice.form === locked);
  if (!lockValid)
    diagnostics.push(
      `The locked form "${locked ?? ""}" is not one of this component's choices.`,
    );
  return row(normalized, lockValid);
}
function normalizeTypedPresentation(spelling: string): string | null {
  let word = spelling.startsWith(".") ? spelling.slice(1) : spelling;
  if (word.endsWith(".")) word = word.slice(0, -1);
  return normalizeWord(word);
}
export function analyzeWord(profile: Profile, spelling: string): WordAnalysis {
  const analysis: WordAnalysis = {
    original: spelling,
    normalized: null,
    kind: "unknown",
    readings: [],
    diagnostics: [],
    morphology: morphology(profile),
  };
  if (bytes(spelling) > MAX_WORD_BYTES) {
    try {
      resource("word bytes", bytes(spelling), 128);
    } catch (error) {
      analysis.diagnostics.push((error as Error).message);
    }
    return analysis;
  }
  const normalized = normalizeWord(stripAcuteAccents(spelling));
  if (normalized === null) {
    analysis.diagnostics.push(
      "The spelling uses characters outside Lojban letters, apostrophes, and commas.",
    );
    return applyAcuteRules(analysis);
  }
  try {
    const reading = parseFor(profile, normalized).reading;
    analysis.kind =
      reading.kind === "lujvo" &&
      profile === "cll" &&
      !classicTokens(reading.tokens)
        ? "unknown"
        : reading.kind;
    if (profile === "cll" && analysis.kind === "fuhivla")
      analysis.diagnostics.push(
        "Fu'ivla recognition uses the extended jbotci lineage. This classification does not establish CLL validity.",
      );
    if (analysis.kind === "lujvo") {
      const components = reading.tokens.filter((token) => !isHyphen(token));
      const parts: Part[] = components.map((text, index) => ({
        text,
        kind:
          isConsonant(tail(text)) ||
          rafsiTokenOk(text, index + 1 === components.length)
            ? "rafsi"
            : "core",
      }));
      analysis.readings.push(recovered(reading.tokens, parts));
    }
    if (analysis.kind === "unknown")
      analysis.diagnostics.push(
        "The form is not one word under the selected profile.",
      );
  } catch (error) {
    analysis.diagnostics.push(
      error instanceof Error ? error.message : String(error),
    );
  }
  analysis.normalized = normalized;
  return applyAcuteRules(analysis);
}
export function buildLujvo(request: LujvoRequest): LujvoResult {
  return buildLujvoWithDetailBudget(request, new DetailBudget());
}
export function buildLujvoWithDetailBudget(
  request: LujvoRequest,
  detailBudget: DetailBudget,
): LujvoResult {
  const profile = request.profile,
    joins = request.joins ?? [],
    inventory = request.inventory ?? {};
  const results = request.limits?.results ?? 64,
    choiceProduct = request.limits?.choice_product ?? 20_000;
  if (request.spelling !== undefined && request.spelling !== null) {
    requireLimit("typed spelling bytes", bytes(request.spelling), 128);
    if (!isExtended(profile) || trimWord(request.spelling) !== request.spelling)
      invalid(
        "A typed spelling needs the extended profile and no outer whitespace.",
      );
  }
  if (request.components.length < 2 || request.components.length > 64)
    invalid("A lujvo needs 2 through 64 components.");
  requireLimit("inventory claims", (inventory.claims ?? []).length, 20_000);
  if (profile === "extended-v4" && joins.includes(ZEI_JOIN))
    return buildZeiLujvo(request);
  for (const component of request.components) {
    requireLimit("component bytes", bytes(component.spelling), 128);
    requireLimit("component claims", (component.claims ?? []).length, 64);
    if (component.locked !== undefined && component.locked !== null) {
      requireLimit("locked rafsi bytes", bytes(component.locked), 128);
      if (!component.locked || isHyphen(component.locked))
        invalid(
          "A component lock must contain a rafsi, not an empty form or a join.",
        );
    }
    for (const claim of component.claims ?? [])
      requireLimit("rafsi bytes", bytes(claim.rafsi), 128);
  }
  if (!isExtended(profile) && joins.length !== 0)
    invalid("Explicit joins need the extended profile.");
  if (
    joins.length !== 0 &&
    (joins.length + 1 !== request.components.length ||
      joins.some((join) => join !== null && join !== "" && !isHyphen(join)))
  )
    invalid("Choose one permitted join for each boundary.");
  const rows = request.components.map((component, index) => {
    const row = rowChoices(profile, component),
      locked = component.locked;
    if (
      joins.length !== 0 &&
      locked !== undefined &&
      locked !== null &&
      (!row.choices.some((choice) => choice.form === locked) ||
        (isExtended(profile) &&
          isGismuFor(profile, locked) &&
          index + 1 < request.components.length))
    ) {
      const core = isExtended(profile) && isBrivlaCoreFor(profile, locked);
      row.choices.push({
        form: locked,
        origin: core ? "core" : "claim",
        shape: rafsiShape(locked),
        position: "any",
        pair: null,
      });
      row.lock_valid = true;
      row.diagnostics = [];
    }
    return row;
  });
  const diagnostics: string[] = [];
  const perRow = rows.map((row, index) => {
    const component = request.components[index],
      locked = component.locked;
    let options = row.choices.filter(
      (choice) =>
        choice.position === "any" ||
        (choice.position === "nonfinal"
          ? index !== rows.length - 1
          : index === rows.length - 1),
    );
    if (locked !== undefined && locked !== null) {
      if (row.recognition_incomplete && locked === row.normalized) {
        // Keep the listed rafsi while whole-word recognition remains incomplete.
      } else if (row.lock_valid) {
        options = options.filter((choice) => choice.form === locked);
        if (options.length === 0)
          diagnostics.push(
            `The locked form "${locked}" of "${component.spelling}" cannot stand in position ${index + 1}.`,
          );
      } else options = [];
    }
    if (options.length === 0 && row.diagnostics.length === 0)
      diagnostics.push(
        `"${component.spelling}" has no form that can stand in position ${index + 1}.`,
      );
    return options;
  });
  let product = 1n;
  for (const options of perRow) {
    product *= BigInt(options.length);
    if (product > 18_446_744_073_709_551_615n) {
      product = 18_446_744_073_709_551_615n;
      break;
    }
  }
  requireLimit(
    "choice combinations",
    Number(product),
    Math.min(choiceProduct, 20_000),
  );
  const candidates: LujvoCandidate[] = [],
    rejected: LujvoResult["rejected"] = [];
  let considered = 0;
  function walk(chosen: LujvoChoice[]): void {
    if (chosen.length !== perRow.length) {
      for (const choice of perRow[chosen.length]) {
        chosen.push(choice);
        walk(chosen);
        chosen.pop();
      }
      return;
    }
    considered++;
    const parts: Part[] = chosen.map((choice) => ({
      text: choice.form,
      kind: choice.origin === "core" ? "core" : "rafsi",
    }));
    const defaults = bondProfile(profile, parts);
    if (defaults === null) return;
    let tokens = defaults;
    if (joins.length !== 0) {
      const defaultParts = recovered(defaults, parts);
      if (defaultParts.length !== parts.length)
        invalid("The default joins do not recover every component.");
      tokens = [parts[0].text];
      for (let index = 1; index < parts.length; index++) {
        const join = joins[index - 1] ?? defaultParts[index]?.join_before ?? "";
        if (join !== "") tokens.push(join);
        tokens.push(parts[index].text);
      }
    }
    const spelling = tokens.join("");
    const wordBytes = bytes(spelling);
    if (wordBytes > MAX_WORD_BYTES) {
      if (rejected.length < 64)
        rejected.push({
          spelling,
          parts: chosen.map((choice) => choice.form),
          reason: new BuilderError({
            kind: "resource-limit",
            measure: "word bytes",
            value: wordBytes,
            limit: MAX_WORD_BYTES,
          }).message,
        });
      return;
    }
    candidates.push({
      spelling,
      parts: chosen.map((choice, index) => ({
        id: request.components[index].id,
        form: choice.form,
        origin: choice.origin,
        pair: choice.pair,
      })),
      score: score(tokens),
      tokens,
      recovered: [],
      conflicts: [],
      unlisted: [],
    });
  }
  if (perRow.every((options) => options.length !== 0)) walk([]);
  candidates.sort((a, b) => {
    const key = a.score - b.score || lexical(a.spelling, b.spelling);
    if (key !== 0) return key;
    for (
      let index = 0;
      index < Math.min(a.parts.length, b.parts.length);
      index++
    ) {
      const order = lexical(a.parts[index].form, b.parts[index].form);
      if (order !== 0) return order;
    }
    return a.parts.length - b.parts.length;
  });
  const budget = new RecognitionBudget(),
    validated: LujvoCandidate[] = [];
  for (const candidate of candidates) {
    if (validated.length === Math.min(results, 512)) break;
    const parts: Part[] = candidate.parts.map((part) => ({
      text: part.form,
      kind: part.origin === "core" ? "core" : "rafsi",
    }));
    try {
      candidate.recovered = validateChecked(
        profile,
        parts,
        candidate.tokens,
        budget,
        joins.length === 0,
      );
      if (request.spelling !== undefined && request.spelling !== null) {
        if (normalizeTypedPresentation(request.spelling) !== candidate.spelling)
          continue;
        const originals = candidate.tokens.map(() => "");
        let index = 0,
          consumed = 0;
        for (const character of request.spelling) {
          if (character !== "," && character !== ".") {
            while (
              index + 1 < candidate.tokens.length &&
              consumed === bytes(candidate.tokens[index])
            ) {
              index++;
              consumed = 0;
            }
            consumed++;
          }
          originals[index] += character;
        }
        candidate.spelling = request.spelling;
        candidate.tokens = originals;
      }
      validated.push(candidate);
    } catch (error) {
      if (
        error instanceof BuilderError &&
        error.failure.kind === "resource-limit"
      )
        throw error;
      if (rejected.length < 64)
        rejected.push({
          spelling: candidate.spelling,
          parts: candidate.parts.map((part) => part.form),
          reason: error instanceof Error ? error.message : String(error),
        });
    }
  }
  addConflictDetails(validated, inventory, detailBudget);
  return {
    rows,
    candidates: validated,
    complete: true,
    considered,
    rejected,
    morphology: morphology(profile),
    scoring: {
      id: profile === "cll" ? CLL_SCORING_ID : EXTENDED_SCORING_ID,
      version: SCORING_VERSION,
    },
    diagnostics,
  };
}
/** Link whole words with zei. This path never reads or creates rafsi claims. */
function buildZeiLujvo(request: LujvoRequest): LujvoResult {
  if (request.profile !== "extended-v4")
    invalid("Zei linking needs morphology version 4.");
  if (
    request.joins?.length !== request.components.length - 1 ||
    request.joins.some((join) => join !== ZEI_JOIN)
  )
    invalid("A zei chain needs zei at every boundary.");
  const budget = new RecognitionBudget();
  const analyze = (spelling: string) =>
    analyzePeggyWord(spelling, {
      throwResourceErrors: true,
      chargeWork: (spent) => budget.charge(spent),
    });
  const forms: string[] = [];
  const rows: RowAnalysis[] = request.components.map((component) => {
    requireLimit("component bytes", bytes(component.spelling), 128);
    requireLimit("component claims", (component.claims ?? []).length, 64);
    for (const claim of component.claims ?? [])
      requireLimit("rafsi bytes", bytes(claim.rafsi), 128);
    const selected = component.locked ?? component.spelling;
    requireLimit("component bytes", bytes(selected), 128);
    const analysis = analyze(selected);
    const part =
      analysis.normalized === null
        ? null
        : zeiOperand(analysis.words ?? [], analysis.normalized);
    const valid =
      part !== null &&
      part.start === 0 &&
      part.end === analysis.normalized!.length;
    if (!valid)
      invalid("Each zei component must be one word or a word followed by bu.");
    if (component.spelling) {
      const source = analyze(component.spelling);
      const operand =
        source.normalized === null
          ? null
          : zeiOperand(source.words ?? [], source.normalized);
      if (
        !operand ||
        operand.start !== 0 ||
        operand.end !== source.normalized!.length ||
        operand.text !== part.text
      )
        invalid("A linked zei source must match its whole component spelling.");
    }
    forms.push(part.text);
    return {
      id: component.id,
      normalized: part.text,
      choices: [
        {
          form: part.text,
          origin: "core",
          shape: "word",
          position: "any",
          pair: null,
        },
      ],
      lock_valid: true,
      recognition_incomplete: false,
      diagnostics: [],
    };
  });
  requireLimit(
    "choice combinations",
    1,
    Math.min(request.limits?.choice_product ?? 20_000, 20_000),
  );
  const spelling =
    request.spelling ??
    request.components
      .map((component, index) => {
        const selected = component.locked ?? component.spelling;
        return stripAcuteAccents(selected) !== selected
          ? normalizeAcuteDisplay(selected)
          : stripAcuteAccents(component.spelling) !== component.spelling
            ? normalizeAcuteDisplay(component.spelling)
            : forms[index];
      })
      .join(ZEI_JOIN);
  requireLimit("word bytes", bytes(spelling), 128);
  const analysis = analyze(spelling);
  const operands =
    analysis.normalized === null
      ? null
      : zeiOperands(analysis.words ?? [], analysis.normalized);
  if (
    analysis.kind !== "lujvo" ||
    operands === null ||
    !same(
      operands.map((part) => part.text),
      forms,
    )
  )
    invalid("The zei spelling does not match its whole-word components.");
  const positions: { start: number; end: number; char: string }[] = [];
  let offset = 0;
  for (const original of spelling) {
    const start = offset;
    offset += original.length;
    const plain = stripAcuteAccents(original);
    if (!plain) {
      if (positions.length) positions[positions.length - 1].end = offset;
      continue;
    }
    if (plain === ",") continue;
    const char = asciiLower(plain).replace(/[h’]/g, "'");
    positions.push({ start, end: offset, char });
  }
  if (positions[0]?.char === ".") positions.shift();
  if (positions.at(-1)?.char === ".") positions.pop();
  const tokens: string[] = [];
  let previous = 0;
  for (const [index, part] of operands.entries()) {
    const start = index === 0 ? 0 : positions[part.start].start;
    if (index > 0) tokens.push(spelling.slice(previous, start));
    const end =
      index === operands.length - 1
        ? spelling.length
        : positions[part.end - 1].end;
    tokens.push(spelling.slice(start, end));
    previous = end;
  }
  const candidate: LujvoCandidate = {
    spelling,
    parts: forms.map((form, index) => ({
      id: request.components[index].id,
      form,
      origin: "core",
      pair: null,
    })),
    tokens,
    score: 0,
    recovered: zeiReading(operands),
    conflicts: [],
    unlisted: [],
  };
  return {
    rows,
    candidates: (request.limits?.results ?? 64) === 0 ? [] : [candidate],
    complete: true,
    considered: 1,
    rejected: [],
    morphology: morphology(request.profile),
    scoring: { id: ZEI_SCORING_ID, version: "1" },
    diagnostics: [],
  };
}

/** Check all selected detail rows before copying any values into the result. */
export function addConflictDetails(
  candidates: LujvoCandidate[],
  inventory: Inventory,
  budget: DetailBudget,
): void {
  if (candidates.length === 0) return;
  const claims = inventory.claims ?? [];
  budget.scan(claims.length);
  const byRafsi = new Map<string, RafsiInventoryClaim[]>();
  for (const claim of claims) {
    const group = byRafsi.get(claim.rafsi);
    if (group) group.push(claim);
    else byRafsi.set(claim.rafsi, [claim]);
  }
  for (const candidate of candidates)
    for (const part of candidate.parts.filter(
      (part) => part.origin === "claim",
    )) {
      const known = byRafsi.get(part.form) ?? [];
      budget.scan(known.length * 2);
      for (const other of known.filter((claim) => claim.pair !== part.pair))
        budget.detail([
          part.form,
          part.id,
          other.word,
          other.spelling,
          other.pair,
        ]);
    }
  for (const candidate of candidates)
    for (const part of candidate.parts.filter(
      (part) => part.origin === "claim",
    )) {
      const known = byRafsi.get(part.form) ?? [];
      if (!known.some((claim) => claim.pair === part.pair))
        candidate.unlisted.push(part.form);
      for (const other of known.filter((claim) => claim.pair !== part.pair))
        candidate.conflicts.push({
          rafsi: part.form,
          id: part.id,
          word: other.word,
          spelling: other.spelling,
          pair: other.pair,
        });
    }
}
