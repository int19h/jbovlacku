/**
 * The rule for a saved search package that pages read on the main thread.
 *
 * Pages read a saved package as it comes from the store, and read its rows
 * through these accessors as they go:
 *
 * - `savedPackage` checks the stored value and its package fields.
 * - `savedRow` checks one row's fields that main-thread readers use.
 * - `savedWordId` derives a row's word ID through the core.
 *
 * A saved package is unusable when any of these fails on it. Each failure
 * raises `PackageValidationError` with the documented invalid-package
 * message, so every page shows the same message instead of a raw error.
 * The checks run inside the loops that already read each row, so a valid
 * package costs no extra pass and no worker round trip. Settings is the
 * exception: it reads no rows, so it checks them in a pass of its own.
 *
 * For each field that a page reads before the search worker's verdict, the
 * rule uses the worker's own test (`validateCachedPackage` and
 * `validateEntry`). The worker still validates every package that a page
 * sends to it, and also checks what no page reads first: exact field sets,
 * the row order, and the attribution. The core checks each spelling where a
 * page derives the word ID. A rafsi with a lone surrogate passes the worker
 * check and fails the row check. The worker accepts any rafsi
 * string, but the core cannot serialize such a rafsi into a pair ID.
 *
 * This module has no server or browser-storage dependency, so models and
 * Node unit tests can load it.
 */
import { wordId } from "../../../../packages/core/src/browser.ts";
import type { CachedPackage } from "./search.ts";
import {
  eventId,
  hashId,
  identityId,
  languageTag,
  lexicalKinds,
  type PackageEntry,
} from "../model/types.ts";

export const INVALID_PACKAGE_MESSAGE =
  "The search package is invalid. Search this server or download another package.";

/** A saved or sent package that a reader cannot use. */
export class PackageValidationError extends Error {
  constructor(message = INVALID_PACKAGE_MESSAGE) {
    super(message);
  }
}

/**
 * Matches an unpaired surrogate. The core cannot serialize such a rafsi into
 * a pair ID, although the worker accepts any rafsi string.
 */
const LONE_SURROGATE = /\p{Cs}/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Whether a value is an object with exactly these own fields. The worker uses the same test. */
export function fields(
  value: unknown,
  names: string[],
): value is Record<string, any> {
  return (
    isRecord(value) &&
    Object.keys(value).length === names.length &&
    names.every((name) => Object.hasOwn(value, name))
  );
}

/**
 * Whether any element of a list fails, visited as the worker's `.some`
 * visits it: empty slots, which IndexedDB keeps, are skipped. The method is
 * taken from `Array.prototype`, so an own `some` property on a stored array
 * cannot replace it.
 */
const anyItem = (list: unknown[], test: (item: unknown) => boolean) =>
  Array.prototype.some.call(list, test);

/** Rafsi spellings per version 2 entry. The server applies the same bound. */
export const PACKAGE_RAFSI_LIMIT = 64;

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

/**
 * Check a saved row against the package language and version. Use the
 * worker's tests (`validateEntry`) for fields that pages read:
 * the event, language, word, plain text, body, glosses and
 * classification, and for a version 2 row the issuer, notes and rafsi
 * list. A version 1 row must carry no version 2 field, and a version 2 row
 * must carry the issuer and the rafsi list. The rule is stricter than the
 * worker in one case: a rafsi with a lone surrogate. A row that fails
 * raises `PackageValidationError`.
 */
export function savedRow(
  entry: unknown,
  version: 1 | 2 | undefined,
  language: string,
): PackageEntry {
  if (!isRecord(entry)) throw new PackageValidationError();
  const { word, classification, glosses } = entry;
  let usable =
    eventId(entry.event) &&
    entry.language === language &&
    languageTag(entry.language) &&
    fields(word, ["language", "spelling"]) &&
    word.language === "jbo" &&
    typeof word.spelling === "string" &&
    typeof entry.plain_text === "string" &&
    (entry.body === null || hashId(entry.body)) &&
    Array.isArray(glosses) &&
    glosses.length <= 8192 &&
    fields(classification, ["kind", "selmaho"]) &&
    lexicalKinds.includes(classification.kind) &&
    Array.isArray(classification.selmaho);
  if (usable)
    usable = !anyItem(
      (classification as { selmaho: unknown[] }).selmaho,
      (item) => typeof item !== "string",
    );
  if (usable)
    usable = !anyItem(
      glosses as unknown[],
      (gloss) =>
        !fields(gloss, ["language", "text", "sense"]) ||
        !languageTag(gloss.language) ||
        typeof gloss.text !== "string" ||
        !(gloss.sense === null || typeof gloss.sense === "string"),
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
      usable = !anyItem(
        rafsi as unknown[],
        (item) => typeof item !== "string" || LONE_SURROGATE.test(item),
      );
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
