/**
 * Saved-package shape checks. This module has no server or browser-storage
 * dependency, so pages and models can check saved rows on the main thread
 * and unit tests can load it without a page.
 */
import { wordId } from "../../../../packages/core/src/browser.ts";
import {
  entryContentUnits,
  type SearchRequestBudget,
} from "../../../../packages/search/src/index.ts";
import {
  eventId,
  hashId,
  languageTag,
  lexicalKinds,
  identityId,
  type PackageEntry,
  type PackageEntryV2,
} from "../model/types.ts";

export interface CachedPackage {
  snapshot: string;
  /** The server view that binds compact per-entry ordering statuses. */
  search_view?: string;
  /** 1 for the default package, 2 when the entries carry row metadata. */
  version?: 1 | 2;
  entries: PackageEntry[];
  /**
   * Set when the server advertised version 2 and that download failed, so
   * the version 1 package is in use instead. The text explains the failure.
   * Pages that describe the package show this state.
   */
  downgrade?: string | null;
}
function fields(value: unknown, names: string[]): value is Record<string, any> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === names.length &&
    names.every((name) => Object.hasOwn(value, name))
  );
}
/** Rafsi spellings per version 2 entry. The server applies the same bound. */
export const PACKAGE_RAFSI_LIMIT = 64;
export function isV2(entry: PackageEntry): entry is PackageEntryV2 {
  return !!entry && typeof entry === "object" && "issuer" in entry;
}
/**
 * A downloaded package that fails shape checks is malformed. This error never
 * covers a valid large package: per-language totals were removed, so size
 * alone never rejects a package. A package that fails for a physical reason
 * (storage full, out of memory) reports PackageStorageError instead, and a
 * configured quota reports PackageQuotaError.
 */
export const invalidPackage = () =>
  new Error(
    "The search package is invalid. Search this server or download another package.",
  );
const V1_FIELDS = [
  "event",
  "word",
  "language",
  "glosses",
  "plain_text",
  "classification",
  "body",
];
const V2_FIELDS = [...V1_FIELDS, "issuer", "notes", "rafsi", "attribution"];
/** A server that bounds the rafsi list also says whether it is complete. */
const V2_BOUNDED_FIELDS = [...V2_FIELDS, "rafsi_complete"];
export function validateEntry(
  value: unknown,
  language: string,
  version: 1 | 2 = 1,
  packageView?: string,
): asserts value is PackageEntry {
  if (
    version === 2 &&
    value &&
    typeof value === "object" &&
    "search_status" in value
  ) {
    const { search_status, ...base } = value as Record<string, any>;
    if (
      packageView !== undefined
        ? !eventId(packageView) ||
          !["active", "retired", "ineligible"].includes(search_status)
        : !fields(search_status, ["view", "status"]) ||
          !eventId(search_status.view) ||
          !["active", "retired", "ineligible"].includes(search_status.status)
    )
      throw invalidPackage();
    validateEntry(base, language, version);
    return;
  }
  if (version === 2) {
    if (
      !(fields(value, V2_FIELDS) || fields(value, V2_BOUNDED_FIELDS)) ||
      !identityId(value.issuer) ||
      typeof value.notes !== "boolean" ||
      !Array.isArray(value.rafsi) ||
      value.rafsi.length > PACKAGE_RAFSI_LIMIT ||
      value.rafsi.some((r: unknown) => typeof r !== "string") ||
      !(
        value.rafsi_complete === undefined ||
        typeof value.rafsi_complete === "boolean"
      ) ||
      !(
        value.attribution === null ||
        (fields(value.attribution, ["source", "author", "account", "dates"]) &&
          typeof value.attribution.source === "string" &&
          (value.attribution.author === null ||
            typeof value.attribution.author === "string") &&
          (value.attribution.account === null ||
            (fields(value.attribution.account, ["origin", "account"]) &&
              typeof value.attribution.account.origin === "string" &&
              Number.isSafeInteger(value.attribution.account.account))) &&
          value.attribution.dates !== null &&
          typeof value.attribution.dates === "object" &&
          Object.values(value.attribution.dates).every(
            (d) => typeof d === "string",
          ))
      )
    )
      throw invalidPackage();
    const { issuer, notes, rafsi, rafsi_complete, attribution, ...base } =
      value;
    void issuer;
    void notes;
    void rafsi;
    void rafsi_complete;
    void attribution;
    validateEntry(base, language, 1);
    return;
  }
  if (
    !fields(value, V1_FIELDS) ||
    !eventId(value.event) ||
    value.language !== language ||
    !languageTag(value.language) ||
    !fields(value.word, ["language", "spelling"]) ||
    value.word.language !== "jbo" ||
    typeof value.word.spelling !== "string" ||
    typeof value.plain_text !== "string" ||
    !(value.body === null || hashId(value.body)) ||
    !Array.isArray(value.glosses) ||
    value.glosses.length > 8192 ||
    value.glosses.some(
      (gloss: unknown) =>
        !fields(gloss, ["language", "text", "sense"]) ||
        !languageTag(gloss.language) ||
        typeof gloss.text !== "string" ||
        !(gloss.sense === null || typeof gloss.sense === "string"),
    ) ||
    !fields(value.classification, ["kind", "selmaho"]) ||
    !lexicalKinds.includes(value.classification.kind) ||
    !Array.isArray(value.classification.selmaho) ||
    value.classification.selmaho.some(
      (item: unknown) => typeof item !== "string",
    )
  )
    throw invalidPackage();
  try {
    wordId({ language: "jbo", spelling: value.word.spelling });
  } catch {
    throw invalidPackage();
  }
}
export function validateCachedPackage(
  value: unknown,
  language: string,
  budget?: SearchRequestBudget,
): asserts value is CachedPackage {
  if (
    !(
      fields(value, ["snapshot", "entries"]) ||
      fields(value, ["snapshot", "version", "entries"]) ||
      fields(value, ["snapshot", "version", "entries", "downgrade"]) ||
      fields(value, ["snapshot", "version", "entries", "search_view"]) ||
      fields(value, [
        "snapshot",
        "version",
        "entries",
        "search_view",
        "downgrade",
      ])
    ) ||
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
    throw invalidPackage();
  const version = value.version === 2 ? 2 : 1;
  let previous = "";
  for (const entry of value.entries) {
    // One validated entry costs one unit plus its content, charged before
    // the entry is read so a bloated package refuses up front. The unit is
    // ensured before measuring, so an exhausted budget walks nothing.
    budget?.ensure(1, "prepare");
    budget?.reserve(1 + entryContentUnits(entry, budget, "prepare"), "prepare");
    validateEntry(entry, language, version, value.search_view);
    if (value.search_view && typeof entry.search_status !== "string")
      throw invalidPackage();
    if (entry.event <= previous) throw invalidPackage();
    previous = entry.event;
  }
}
/**
 * Checks a saved package before a page reads its rows on the main thread.
 * The worker checks packages with `validateCachedPackage`; pages that build
 * inventories or word indexes from saved rows use this check instead of
 * reading fields first. It checks every row with `validateEntry` and the
 * package fields those readers use. It does not require the row order the
 * worker requires, so a package the readers can use keeps working. A bad
 * package or row raises the documented invalid-package error.
 */
export function checkSavedPackage(
  value: unknown,
  language?: string,
): CachedPackage {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Array.isArray((value as { entries?: unknown }).entries) ||
    typeof (value as { snapshot?: unknown }).snapshot !== "string" ||
    !hashId((value as { snapshot: string }).snapshot) ||
    !(
      (value as { version?: unknown }).version === undefined ||
      (value as { version?: unknown }).version === 1 ||
      (value as { version?: unknown }).version === 2
    ) ||
    ((value as { search_view?: unknown }).search_view !== undefined &&
      ((value as { version?: unknown }).version !== 2 ||
        !eventId((value as { search_view: string }).search_view))) ||
    !(
      (value as { downgrade?: unknown }).downgrade === undefined ||
      (value as { downgrade?: unknown }).downgrade === null ||
      typeof (value as { downgrade?: unknown }).downgrade === "string"
    )
  )
    throw invalidPackage();
  const pkg = value as CachedPackage & { search_view?: string };
  for (const entry of pkg.entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw invalidPackage();
    const entryLanguage =
      language ??
      (typeof (entry as { language?: unknown }).language === "string"
        ? (entry as { language: string }).language
        : undefined);
    if (!entryLanguage) throw invalidPackage();
    const version =
      pkg.version === 2 ||
      (pkg.version === undefined &&
        ("issuer" in entry || "search_status" in entry))
        ? 2
        : 1;
    validateEntry(entry, entryLanguage, version, pkg.search_view);
    if (pkg.search_view && typeof entry.search_status !== "string")
      throw invalidPackage();
  }
  return pkg;
}
/**
 * Reads one language package from the store through `checkSavedPackage`.
 * A missing package returns null. A saved package that fails the check
 * raises the invalid-package error, so callers show that message instead
 * of reading malformed rows. A stored null counts as a saved package.
 */
export async function savedPackage(
  store: { get<T>(name: string, id: string): Promise<T | undefined> },
  language: string,
): Promise<CachedPackage | null> {
  const raw = await store.get<CachedPackage>("packages", language);
  if (raw === undefined) return null;
  return checkSavedPackage(raw, language);
}
