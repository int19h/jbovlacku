/** The shared read rules for saved search packages. */
import { wordId } from "../../../../packages/core/src/browser.ts";
import type { CachedPackage } from "./search.ts";
import {
  eventId,
  hashId,
  identityId,
  languageTag,
  lexicalKinds,
  type PackageEntry,
  type PackageEntryV2,
} from "../model/types.ts";

export const INVALID_PACKAGE_MESSAGE =
  "The search package is invalid. Search this server or download another package.";

/** A saved or sent package that a reader cannot use. */
export class PackageValidationError extends Error {
  constructor(message = INVALID_PACKAGE_MESSAGE) {
    super(message);
  }
}

/** The core rejects a lone surrogate in a spelling. */
const LONE_SURROGATE = /\p{Cs}/u;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Whether a value is an object with exactly these own fields. The worker uses the same test. */
export function fields(
  value: unknown,
  names: string[],
): value is Record<string, any> {
  if (!isRecord(value) || Object.keys(value).length !== names.length)
    return false;
  for (const name of names) if (!Object.hasOwn(value, name)) return false;
  return true;
}

function isDateMap(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** A stored array must have only its own elements and its intrinsic length. */
export function requireDenseList(value: unknown): asserts value is unknown[] {
  if (!isDenseList(value)) throw new PackageValidationError();
}

function isDenseList(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  // Inspect supplied keys. A sparse list can claim a much larger length.
  const keys = Reflect.ownKeys(value);
  // An array lists its indices first. Its intrinsic length precedes all
  // other string and symbol keys. Every array index is below its length.
  return keys.length === value.length + 1 && keys[value.length] === "length";
}

/** Check list shape before reading element content or calling array methods. */
export function requireSavedRowLists(
  value: unknown,
): asserts value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    !isRecord(value.word) ||
    !isRecord(value.classification)
  )
    throw new PackageValidationError();
  if (!Array.isArray(value.glosses) || value.glosses.length > 8192)
    throw new PackageValidationError();
  requireDenseList(value.glosses);
  requireDenseList(value.classification.selmaho);
  if (Object.hasOwn(value, "rafsi")) {
    if (!Array.isArray(value.rafsi) || value.rafsi.length > PACKAGE_RAFSI_LIMIT)
      throw new PackageValidationError();
    requireDenseList(value.rafsi);
  }
  if (
    value.attribution != null &&
    (!isRecord(value.attribution) ||
      !isDateMap(value.attribution.dates) ||
      (value.attribution.account != null &&
        !isRecord(value.attribution.account)))
  )
    throw new PackageValidationError();
}

export const PACKAGE_RAFSI_LIMIT = 64;
const COMPONENT_BYTE_LIMIT = 128;
const encoder = new TextEncoder();

export function fitsComponentSpelling(spelling: string): boolean {
  return (
    spelling.length <= COMPONENT_BYTE_LIMIT &&
    (!/[^\x00-\x7f]/.test(spelling) ||
      (!LONE_SURROGATE.test(spelling) &&
        encoder.encode(spelling).length <= COMPONENT_BYTE_LIMIT))
  );
}

export function validPackageRafsi(value: unknown): value is string {
  return typeof value === "string" && fitsComponentSpelling(value);
}

/** Count exact claims for an entire language package. */
export function savedRafsiUnion() {
  const words = new Map<string, Set<string>>();
  return (id: string, entry: PackageEntry) => {
    if (!("issuer" in entry)) return;
    const { rafsi } = entry as PackageEntryV2;
    if (!rafsi.length) return;
    let claims = words.get(id);
    if (!claims) {
      claims = new Set();
      words.set(id, claims);
    }
    for (const claim of rafsi) {
      if (claims.size === PACKAGE_RAFSI_LIMIT && !claims.has(claim))
        throw new PackageValidationError();
      claims.add(claim);
    }
  };
}

/** Whether a package component fits the limits that the builder enforces. */
export function fitsSavedComponent(component: {
  spelling: string;
  claims: readonly { rafsi: string }[];
  locked?: string | null;
}): boolean {
  return (
    fitsComponentSpelling(component.spelling) &&
    (component.locked == null || fitsComponentSpelling(component.locked)) &&
    component.claims.length <= PACKAGE_RAFSI_LIMIT &&
    isDenseList(component.claims) &&
    component.claims.every((claim) => validPackageRafsi(claim?.rafsi))
  );
}

/**
 * A stored value as a saved package. `undefined` means that nothing is
 * saved, and gives `null`. Any other value whose package fields fail the
 * worker's tests for them, including a stored `null`, raises
 * `PackageValidationError`. The rows are not checked here: readers check
 * each row with `savedRow`.
 */
export function savedPackage(value: unknown): CachedPackage | null {
  if (value === undefined) return null;
  if (
    !isRecord(value) ||
    !hashId(value.snapshot) ||
    !Array.isArray(value.entries) ||
    !(
      value.version === undefined ||
      value.version === 1 ||
      value.version === 2
    ) ||
    (Object.hasOwn(value, "search_view") &&
      (value.version !== 2 || !eventId(value.search_view))) ||
    !(
      value.downgrade === undefined ||
      value.downgrade === null ||
      typeof value.downgrade === "string"
    )
  )
    throw new PackageValidationError();
  return value as unknown as CachedPackage;
}

/** The fields that only a version 2 row carries. */
const V2_ONLY = ["issuer", "notes", "rafsi", "rafsi_complete", "attribution"];
const WORD_FIELDS = ["language", "spelling"];
const CLASSIFICATION_FIELDS = ["kind", "selmaho"];
const GLOSS_FIELDS = ["language", "text", "sense"];

/**
 * Check a saved row against the package language and version. Use the
 * worker's tests (`validateEntry`) for fields that pages read:
 * the event, language, word, plain text, body, glosses and
 * classification, and for a version 2 row the issuer, notes and rafsi
 * list. A version 1 row must carry no version 2 field, and a version 2 row
 * must carry the issuer and the rafsi list. A row that fails raises
 * `PackageValidationError`.
 */
export function savedRow(
  entry: unknown,
  version: 1 | 2 | undefined,
  language: string,
): PackageEntry {
  requireSavedRowLists(entry);
  const { word, classification, glosses } = entry;
  let usable =
    eventId(entry.event) &&
    entry.language === language &&
    languageTag(entry.language) &&
    fields(word, WORD_FIELDS) &&
    word.language === "jbo" &&
    typeof word.spelling === "string" &&
    typeof entry.plain_text === "string" &&
    (entry.body === null || hashId(entry.body)) &&
    Array.isArray(glosses) &&
    glosses.length <= 8192 &&
    fields(classification, CLASSIFICATION_FIELDS) &&
    lexicalKinds.includes(classification.kind) &&
    Array.isArray(classification.selmaho);
  if (usable)
    usable = (classification as { selmaho: unknown[] }).selmaho.every(
      (item) => typeof item === "string",
    );
  if (usable)
    usable = (glosses as unknown[]).every(
      (gloss) =>
        fields(gloss, GLOSS_FIELDS) &&
        languageTag(gloss.language) &&
        typeof gloss.text === "string" &&
        (gloss.sense === null || typeof gloss.sense === "string"),
    );
  if (usable && version === 2) {
    const rafsi = entry.rafsi;
    usable =
      identityId(entry.issuer) &&
      typeof entry.notes === "boolean" &&
      Array.isArray(rafsi) &&
      rafsi.length <= PACKAGE_RAFSI_LIMIT &&
      (entry.rafsi_complete === undefined ||
        typeof entry.rafsi_complete === "boolean");
    if (usable)
      usable =
        (rafsi as unknown[]).every(validPackageRafsi) &&
        (entry.attribution == null ||
          (isRecord(entry.attribution) &&
            isRecord(entry.attribution.dates) &&
            Object.values(entry.attribution.dates).every(
              (date) => typeof date === "string",
            )));
  } else if (usable)
    for (const name of V2_ONLY) if (Object.hasOwn(entry, name)) usable = false;
  if (!usable) throw new PackageValidationError();
  return entry as unknown as PackageEntry;
}

/** The word ID of a saved row's word. A word that the core rejects raises `PackageValidationError`. */
export function savedWordId(word: {
  language: "jbo";
  spelling: string;
}): string {
  try {
    return wordId(word);
  } catch {
    throw new PackageValidationError();
  }
}

/** Use the core for spellings that need normalization or other checks. */
export function checkSavedWord(word: {
  language: "jbo";
  spelling: string;
}): void {
  // Short lowercase ASCII spellings already satisfy the core checks for
  // byte length, NFC, controls, accents, and edge whitespace.
  const { spelling } = word;
  if (spelling.length > 0 && spelling.length <= 256 && !/[^a-z]/.test(spelling))
    return;
  savedWordId(word);
}
