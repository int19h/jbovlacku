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
 * package costs no extra pass and no worker round trip.
 *
 * The search worker still validates every package that a page sends to it,
 * with its own stricter rules (exact field sets, row order, identities).
 * This rule accepts every package that the worker accepts.
 *
 * This module has no server or browser-storage dependency, so models and
 * Node unit tests can load it.
 */
import { wordId } from "../../../../packages/core/src/browser.ts";
import type { CachedPackage } from "./search.ts";
import type { PackageEntry } from "../model/types.ts";

export const INVALID_PACKAGE_MESSAGE =
  "The search package is invalid. Search this server or download another package.";

/** A saved or sent package that a reader cannot use. */
export class PackageValidationError extends Error {
  constructor(message = INVALID_PACKAGE_MESSAGE) {
    super(message);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * A stored value as a saved package. `undefined` means that nothing is
 * saved, and gives `null`. Any other value without the package fields that
 * pages read, including a stored `null`, raises `PackageValidationError`.
 * The rows are not checked here: readers check each row with `savedRow`.
 */
export function savedPackage(value: unknown): CachedPackage | null {
  if (value === undefined) return null;
  if (
    !isRecord(value) ||
    typeof value.snapshot !== "string" ||
    !Array.isArray(value.entries) ||
    !(
      value.version === undefined ||
      value.version === 1 ||
      value.version === 2
    ) ||
    !(
      value.downgrade === undefined ||
      value.downgrade === null ||
      typeof value.downgrade === "string"
    )
  )
    throw new PackageValidationError();
  return value as unknown as CachedPackage;
}

/**
 * One saved row, checked for the fields that main-thread readers use: the
 * word, classification, glosses, text, event and language, and the rafsi
 * list of a version 2 row. A row without them raises `PackageValidationError`.
 */
export function savedRow(entry: unknown): PackageEntry {
  if (!isRecord(entry)) throw new PackageValidationError();
  const { word, classification, glosses, rafsi } = entry;
  let usable =
    isRecord(word) &&
    Object.keys(word).length === 2 &&
    word.language === "jbo" &&
    typeof word.spelling === "string" &&
    isRecord(classification) &&
    typeof classification.kind === "string" &&
    Array.isArray(glosses) &&
    typeof entry.event === "string" &&
    typeof entry.plain_text === "string" &&
    typeof entry.language === "string";
  if (usable)
    for (const gloss of glosses as unknown[])
      if (!isRecord(gloss) || typeof gloss.text !== "string") usable = false;
  // A row with an issuer is a version 2 row, and readers then iterate its
  // rafsi list. A rafsi list must be a list of spellings wherever it is.
  if (usable && ("issuer" in entry || "rafsi" in entry)) {
    usable =
      Array.isArray(rafsi) &&
      (entry.rafsi_complete === undefined ||
        typeof entry.rafsi_complete === "boolean");
    if (usable)
      for (const item of rafsi as unknown[])
        if (typeof item !== "string") usable = false;
  }
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
