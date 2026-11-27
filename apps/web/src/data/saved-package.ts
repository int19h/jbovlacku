/** The shared read rules for saved search packages. */
import {
  validWordIdSpellings,
  wordId,
  wordIdSpellings,
  wordSpellingStatus,
} from "../../../../packages/core/src/browser.ts";
import type { SearchRequestBudget } from "../../../../packages/search/src/index.ts";
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

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function hasCleanPrototypes(): boolean {
  for (const _ in Object.prototype) return false;
  for (const _ in Array.prototype) return false;
  return true;
}

const structuredPackages = new WeakSet<object>();

/**
 * Mark a package object freshly deserialized by IndexedDB structured clone.
 * Structured deserialization creates arrays and plain objects with enumerable
 * own string keys only, never Symbol keys or extra non-enumerable properties.
 */
export function markStructuredPackage(value: unknown): void {
  if (isRecord(value)) structuredPackages.add(value);
}

/** Whether a value is an object with exactly these own fields. The worker uses the same test. */
export function fields(
  value: unknown,
  names: readonly string[],
  extra = 0,
): value is Record<string, any> {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== names.length + extra) return false;
  for (let i = 0; i < names.length; i++)
    if (keys[i] !== names[i] && !Object.hasOwn(value, names[i])) return false;
  return true;
}

function fieldsExact(
  value: unknown,
  names: readonly string[],
  cleanProto: boolean,
): value is Record<string, any> {
  if (!isRecord(value)) return false;
  if (cleanProto && Object.getPrototypeOf(value) === Object.prototype) {
    let i = 0;
    for (const key in value) {
      if (key !== names[i++]) return fields(value, names);
    }
    return i === names.length;
  }
  return fields(value, names);
}

// Keep one `for..in` site per hot object shape so JS engines do not go
// megamorphic across entry, word, classification, gloss, attribution, and account.
function fieldsExact2(
  value: unknown,
  names: readonly string[],
  cleanProto: boolean,
): value is Record<string, any> {
  if (!isRecord(value)) return false;
  if (cleanProto && Object.getPrototypeOf(value) === Object.prototype) {
    let i = 0;
    for (const key in value) {
      if (key !== names[i++]) return fields(value, names);
    }
    return i === 2;
  }
  return fields(value, names);
}

function fieldsExactClass(
  value: unknown,
  cleanProto: boolean,
): value is Record<string, any> {
  if (!isRecord(value)) return false;
  if (cleanProto && Object.getPrototypeOf(value) === Object.prototype) {
    let i = 0;
    for (const key in value) {
      if (key !== CLASSIFICATION_FIELDS[i++])
        return fields(value, CLASSIFICATION_FIELDS);
    }
    return i === 2;
  }
  return fields(value, CLASSIFICATION_FIELDS);
}

function fieldsExactGloss(
  value: unknown,
  cleanProto: boolean,
): value is Record<string, any> {
  if (!isRecord(value)) return false;
  if (cleanProto && Object.getPrototypeOf(value) === Object.prototype) {
    let i = 0;
    for (const key in value) {
      if (key !== GLOSS_FIELDS[i++]) return fields(value, GLOSS_FIELDS);
    }
    return i === 3;
  }
  return fields(value, GLOSS_FIELDS);
}

function fieldsExactAttribution(
  value: unknown,
  cleanProto: boolean,
): value is Record<string, any> {
  if (!isRecord(value)) return false;
  if (cleanProto && Object.getPrototypeOf(value) === Object.prototype) {
    let i = 0;
    for (const key in value) {
      if (key !== ATTRIBUTION_FIELDS[i++])
        return fields(value, ATTRIBUTION_FIELDS);
    }
    return i === 4;
  }
  return fields(value, ATTRIBUTION_FIELDS);
}

function fieldsExactAccount(
  value: unknown,
  cleanProto: boolean,
): value is Record<string, any> {
  if (!isRecord(value)) return false;
  if (cleanProto && Object.getPrototypeOf(value) === Object.prototype) {
    let i = 0;
    for (const key in value) {
      if (key !== ACCOUNT_FIELDS[i++]) return fields(value, ACCOUNT_FIELDS);
    }
    return i === 2;
  }
  return fields(value, ACCOUNT_FIELDS);
}

/** A stored array must have only its own elements and its intrinsic length. */
export function requireDenseList(value: unknown): asserts value is unknown[] {
  if (!isDenseList(value)) throw new PackageValidationError();
}

function isDenseList(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  // Inspect actual own keys without charging a request budget or sampling indices:
  // work scales with supplied keys, so sparse huge lengths always fail as invalid.
  // An array lists its indices first, then its intrinsic length, then extra keys.
  const keys = Reflect.ownKeys(value);
  return keys.length === value.length + 1 && keys[value.length] === "length";
}

const SMALL_INDICES = Array.from({ length: 65 }, (_, i) => String(i));

/**
 * Dense-list check for an array deserialized by IndexedDB structured clone when
 * `Object.prototype` and `Array.prototype` have no enumerable properties.
 * Inspects actual own keys so sparse lengths, holes, and extra own properties
 * all fail in proportion to supplied keys.
 */
function isDenseStructuredArray(value: unknown[]): boolean {
  const len = value.length;
  if (len === 0) {
    for (const _ in value) return false;
    return true;
  }
  const keys = Object.keys(value);
  return (
    keys.length === len &&
    keys[len - 1] === (len <= 64 ? SMALL_INDICES[len - 1] : String(len - 1))
  );
}

function isDenseArray(value: unknown[], structured: boolean): boolean {
  if (structured) return isDenseStructuredArray(value);
  const keys = Reflect.ownKeys(value);
  return keys.length === value.length + 1 && keys[value.length] === "length";
}

/** Check the outer `entries` list of a package before a single-pass direct row walk. */
export function requireSavedEntriesList(pkg: unknown): void {
  if (!isRecord(pkg)) throw new PackageValidationError();
  const { entries } = pkg;
  if (
    !Array.isArray(entries) ||
    !isDenseArray(entries, structuredPackages.has(pkg) && hasCleanPrototypes())
  )
    throw new PackageValidationError();
}

const WORD_FIELDS = ["language", "spelling"];
const CLASSIFICATION_FIELDS = ["kind", "selmaho"];
const GLOSS_FIELDS = ["language", "sense", "text"];
const ATTRIBUTION_FIELDS = ["account", "author", "dates", "source"];
const ACCOUNT_FIELDS = ["account", "origin"];
const LEGACY_STATUS_FIELDS = ["status", "view"];

export const PACKAGE_GLOSS_LIMIT = 8192;
export const PACKAGE_RAFSI_LIMIT = 64;
const COMPONENT_BYTE_LIMIT = 128;

export interface SavedRowListCache {
  glosses?: Set<unknown>;
  selmaho?: Set<unknown>;
  rafsi?: Set<unknown>;
  dates?: Set<unknown>;
}

export const savedRowListCache = (): SavedRowListCache => ({});

/**
 * Check the outer `entries` list and every row's nested lists in one
 * unbudgeted pass before any budget charge or content measurement.
 * Lists with a format cap (`glosses` and `rafsi`) reject over-cap lengths
 * before inspecting own keys.
 */
export function requirePackageListShapes(pkg: unknown): void {
  if (!isRecord(pkg)) throw new PackageValidationError();
  const structured = structuredPackages.has(pkg) && hasCleanPrototypes();
  const { entries } = pkg;
  if (!Array.isArray(entries) || !isDenseArray(entries, structured))
    throw new PackageValidationError();
  let checkedLists: Set<unknown> | undefined;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!isRecord(entry)) throw new PackageValidationError();
    const { glosses, classification, rafsi } = entry;
    if (!Array.isArray(glosses) || glosses.length > PACKAGE_GLOSS_LIMIT)
      throw new PackageValidationError();
    if (glosses.length < 4) {
      if (!isDenseArray(glosses, structured)) throw new PackageValidationError();
    } else if (!checkedLists?.has(glosses)) {
      if (!isDenseArray(glosses, structured)) throw new PackageValidationError();
      (checkedLists ??= new Set()).add(glosses);
    }
    if (!isRecord(classification)) throw new PackageValidationError();
    const selmaho = classification.selmaho;
    if (!Array.isArray(selmaho)) throw new PackageValidationError();
    if (selmaho.length < 4) {
      if (!isDenseArray(selmaho, structured)) throw new PackageValidationError();
    } else if (!checkedLists?.has(selmaho)) {
      if (!isDenseArray(selmaho, structured)) throw new PackageValidationError();
      (checkedLists ??= new Set()).add(selmaho);
    }
    if (Object.hasOwn(entry, "rafsi")) {
      if (!Array.isArray(rafsi) || rafsi.length > PACKAGE_RAFSI_LIMIT)
        throw new PackageValidationError();
      if (rafsi.length < 4) {
        if (!isDenseArray(rafsi, structured)) throw new PackageValidationError();
      } else if (!checkedLists?.has(rafsi)) {
        if (!isDenseArray(rafsi, structured)) throw new PackageValidationError();
        (checkedLists ??= new Set()).add(rafsi);
      }
    }
  }
}

/** Check the shapes that content measurement reads before measuring content. */
export function requireSavedRowLists(
  value: unknown,
  budget?: SearchRequestBudget,
  listsVerified = false,
  checked?: SavedRowListCache,
  glossLanguageHint?: { value: string },
  cleanProto = false,
  structured = false,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new PackageValidationError();
  const { word, classification, glosses, rafsi, attribution } = value;
  if (
    !fieldsExact2(word, WORD_FIELDS, cleanProto) ||
    typeof word.spelling !== "string" ||
    !fieldsExactClass(classification, cleanProto)
  )
    throw new PackageValidationError();

  if (!Array.isArray(glosses) || glosses.length > PACKAGE_GLOSS_LIMIT)
    throw new PackageValidationError();
  if (glosses.length < 4 || !checked?.glosses?.has(glosses)) {
    if (!listsVerified && !isDenseArray(glosses, structured))
      throw new PackageValidationError();
    for (let i = 0; i < glosses.length; i++) {
      const gloss = glosses[i];
      if (
        !fieldsExactGloss(gloss, cleanProto) ||
        (glossLanguageHint && gloss.language === glossLanguageHint.value
          ? false
          : !languageTag(gloss.language)) ||
        typeof gloss.text !== "string" ||
        !(gloss.sense === null || typeof gloss.sense === "string")
      )
        throw new PackageValidationError();
      if (glossLanguageHint && gloss.language !== glossLanguageHint.value)
        glossLanguageHint.value = gloss.language;
    }
    if (checked && glosses.length >= 4)
      (checked.glosses ??= new Set()).add(glosses);
  }

  const { selmaho } = classification;
  if (!Array.isArray(selmaho)) throw new PackageValidationError();
  if (selmaho.length < 4 || !checked?.selmaho?.has(selmaho)) {
    if (!listsVerified && !isDenseArray(selmaho, structured))
      throw new PackageValidationError();
    for (let i = 0; i < selmaho.length; i++) {
      if (typeof selmaho[i] !== "string") throw new PackageValidationError();
      if (budget && (i + 1) % 64 === 0) budget.ensure(2 + i, "prepare");
    }
    if (checked && selmaho.length >= 4)
      (checked.selmaho ??= new Set()).add(selmaho);
  }

  if (Object.hasOwn(value, "rafsi")) {
    if (!Array.isArray(rafsi) || rafsi.length > PACKAGE_RAFSI_LIMIT)
      throw new PackageValidationError();
    if (rafsi.length < 4 || !checked?.rafsi?.has(rafsi)) {
      if (!listsVerified && !isDenseArray(rafsi, structured))
        throw new PackageValidationError();
      for (let i = 0; i < rafsi.length; i++)
        if (!validPackageRafsi(rafsi[i])) throw new PackageValidationError();
      if (checked && rafsi.length >= 4)
        (checked.rafsi ??= new Set()).add(rafsi);
    }
  }

  if (attribution != null) {
    if (
      !fieldsExactAttribution(attribution, cleanProto) ||
      typeof attribution.source !== "string" ||
      !(
        attribution.author === null || typeof attribution.author === "string"
      ) ||
      !(
        attribution.account === null ||
        (fieldsExactAccount(attribution.account, cleanProto) &&
          typeof attribution.account.origin === "string" &&
          Number.isSafeInteger(attribution.account.account))
      )
    )
      throw new PackageValidationError();

    if (!checked?.dates?.has(attribution.dates)) {
      const dates = attribution.dates;
      if (!isRecord(dates)) throw new PackageValidationError();
      const proto = Object.getPrototypeOf(dates);
      if (proto !== Object.prototype && proto !== null)
        throw new PackageValidationError();
      if (!structured && Object.getOwnPropertySymbols(dates).length !== 0)
        throw new PackageValidationError();
      let count = 0;
      if (cleanProto && proto === Object.prototype) {
        for (const key in dates) {
          if (typeof dates[key] !== "string")
            throw new PackageValidationError();
          count++;
          if (budget && count % 64 === 0) budget.ensure(1 + count, "prepare");
        }
      } else {
        for (const key in dates) {
          if (!Object.hasOwn(dates, key)) continue;
          if (typeof dates[key] !== "string")
            throw new PackageValidationError();
          count++;
          if (budget && count % 64 === 0) budget.ensure(1 + count, "prepare");
        }
      }
      if (checked && count >= 4) (checked.dates ??= new Set()).add(dates);
    }
  }
}

export function isV2(entry: PackageEntry): entry is PackageEntryV2 {
  return "issuer" in entry;
}

/** Whether a string fits within 128 UTF-8 bytes and contains no lone surrogate. */
export function fitsComponentSpelling(spelling: string): boolean {
  const len = spelling.length;
  if (len > COMPONENT_BYTE_LIMIT) return false;
  let bytes = 0;
  for (let i = 0; i < len; i++) {
    const code = spelling.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 >= len) return false;
      const low = spelling.charCodeAt(++i);
      if (low < 0xdc00 || low > 0xdfff) return false;
      bytes += 4;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    } else {
      bytes += 3;
    }
    if (bytes > COMPONENT_BYTE_LIMIT) return false;
  }
  return true;
}

export function validPackageRafsi(value: unknown): value is string {
  return typeof value === "string" && fitsComponentSpelling(value);
}

/** Count exact claims for an entire language package. */
export function savedRafsiUnion() {
  const words = new Map<string, readonly string[] | Set<string>>();
  return (id: string, entry: PackageEntry) => {
    if (!("issuer" in entry)) return;
    const { rafsi } = entry as PackageEntryV2;
    if (!rafsi.length) return;
    const existing = words.get(id);
    if (existing === undefined) {
      if (rafsi.length > PACKAGE_RAFSI_LIMIT)
        throw new PackageValidationError();
      words.set(id, rafsi);
      return;
    }
    let claims: Set<string>;
    if (existing instanceof Set) {
      claims = existing;
    } else {
      claims = new Set(existing);
      if (claims.size > PACKAGE_RAFSI_LIMIT) throw new PackageValidationError();
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
    Array.isArray(component.claims) &&
    component.claims.length <= PACKAGE_RAFSI_LIMIT &&
    isDenseList(component.claims) &&
    component.claims.every((claim) => isRecord(claim) && validPackageRafsi(claim.rafsi))
  );
}

const PACKAGE_FIELDS = ["snapshot", "entries"];
const VERSIONED_PACKAGE_FIELDS = [...PACKAGE_FIELDS, "version"];

/** Read a package header. An absent value gives null. */
export function savedPackage(
  value: unknown,
  language?: string,
): CachedPackage | null {
  if (value === undefined) return null;
  if (!isRecord(value)) throw new PackageValidationError();
  const versioned = Object.hasOwn(value, "version");
  const hasView = Object.hasOwn(value, "search_view");
  const hasDowngrade = Object.hasOwn(value, "downgrade");
  if (
    (language !== undefined && !languageTag(language)) ||
    !fields(
      value,
      versioned ? VERSIONED_PACKAGE_FIELDS : PACKAGE_FIELDS,
      Number(hasView) + Number(hasDowngrade),
    ) ||
    ((hasView || hasDowngrade) && !versioned) ||
    !hashId(value.snapshot) ||
    !Array.isArray(value.entries) ||
    !(
      value.version === undefined ||
      value.version === 1 ||
      value.version === 2
    ) ||
    (hasView && (value.version !== 2 || !eventId(value.search_view))) ||
    !(
      value.downgrade === undefined ||
      value.downgrade === null ||
      typeof value.downgrade === "string"
    )
  )
    throw new PackageValidationError();
  return value as unknown as CachedPackage;
}

const V1_FIELDS = [
  "body",
  "classification",
  "event",
  "glosses",
  "language",
  "plain_text",
  "word",
];
const V2_FIELDS = [
  "attribution",
  "body",
  "classification",
  "event",
  "glosses",
  "issuer",
  "language",
  "notes",
  "plain_text",
  "rafsi",
  "word",
];
const V2_FIELDS_COMPLETE = [
  "attribution",
  "body",
  "classification",
  "event",
  "glosses",
  "issuer",
  "language",
  "notes",
  "plain_text",
  "rafsi",
  "rafsi_complete",
  "word",
];
const V2_FIELDS_STATUS = [
  "attribution",
  "body",
  "classification",
  "event",
  "glosses",
  "issuer",
  "language",
  "notes",
  "plain_text",
  "rafsi",
  "search_status",
  "word",
];
const V2_FIELDS_BOTH = [
  "attribution",
  "body",
  "classification",
  "event",
  "glosses",
  "issuer",
  "language",
  "notes",
  "plain_text",
  "rafsi",
  "rafsi_complete",
  "search_status",
  "word",
];
const LEXICAL_KINDS = new Set<string>(lexicalKinds);
const STATUSES = new Set<string>(["active", "retired", "ineligible"]);

interface RowReaderHints {
  languageValidated: boolean;
  viewValidated: boolean;
  cleanProto: boolean;
  structured: boolean;
  issuerA: string;
  issuerB: string;
  validIssuers?: Set<string>;
  glossLanguage: { value: string };
}

function checkIssuerWithHints(
  issuer: unknown,
  hints?: RowReaderHints,
): boolean {
  if (hints) {
    if (
      (issuer === hints.issuerA && hints.issuerA !== "") ||
      (issuer === hints.issuerB && hints.issuerB !== "") ||
      (typeof issuer === "string" && hints.validIssuers?.has(issuer))
    )
      return true;
  }
  if (!identityId(issuer)) return false;
  if (hints) {
    if (hints.issuerA === "") hints.issuerA = issuer;
    else if (hints.issuerB === "") hints.issuerB = issuer;
    else {
      const set = (hints.validIssuers ??= new Set());
      if (set.size < 64) set.add(issuer);
    }
  }
  return true;
}

/** Check one package row. The worker and direct readers use the same rule. */
export function savedRow(
  entry: unknown,
  version: 1 | 2 | undefined,
  language: string,
  packageView?: string,
  budget?: SearchRequestBudget,
  listsVerified = false,
  checked?: SavedRowListCache,
  hints?: RowReaderHints,
): PackageEntry {
  const cleanProto = hints?.cleanProto ?? false;
  const structured = hints?.structured ?? false;
  requireSavedRowLists(
    entry,
    budget,
    listsVerified,
    checked,
    hints?.glossLanguage,
    cleanProto,
    structured,
  );
  if (
    !eventId(entry.event) ||
    entry.language !== language ||
    (!hints?.languageValidated && !languageTag(entry.language)) ||
    (entry.word as Record<string, unknown>).language !== "jbo" ||
    typeof entry.plain_text !== "string" ||
    !(entry.body === null || hashId(entry.body)) ||
    !LEXICAL_KINDS.has(
      (entry.classification as PackageEntry["classification"]).kind,
    )
  )
    throw new PackageValidationError();
  if (version === 2) {
    const hasStatus = Object.hasOwn(entry, "search_status");
    const hasComplete = Object.hasOwn(entry, "rafsi_complete");
    const v2Names = hasStatus
      ? hasComplete
        ? V2_FIELDS_BOTH
        : V2_FIELDS_STATUS
      : hasComplete
        ? V2_FIELDS_COMPLETE
        : V2_FIELDS;
    const status = entry.search_status;
    const issuerOk = checkIssuerWithHints(entry.issuer, hints);
    if (
      !fieldsExact(entry, v2Names, cleanProto) ||
      !issuerOk ||
      typeof entry.notes !== "boolean" ||
      !Array.isArray(entry.rafsi) ||
      entry.attribution === undefined ||
      !(
        entry.rafsi_complete === undefined ||
        typeof entry.rafsi_complete === "boolean"
      ) ||
      (packageView !== undefined
        ? !hasStatus ||
          (!hints?.viewValidated && !eventId(packageView)) ||
          typeof status !== "string" ||
          !STATUSES.has(status)
        : hasStatus &&
          (!fieldsExact(status, LEGACY_STATUS_FIELDS, cleanProto) ||
            !eventId(status.view) ||
            typeof status.status !== "string" ||
            !STATUSES.has(status.status)))
    )
      throw new PackageValidationError();
  } else if (
    !fieldsExact(entry, V1_FIELDS, cleanProto) ||
    packageView !== undefined
  ) {
    throw new PackageValidationError();
  }
  return entry as unknown as PackageEntry;
}

const OBJECT_PROTO = Object.prototype;

/**
 * Single-pass fast path for canonical version 2 rows deserialized by IndexedDB
 * when `Object.prototype` and `Array.prototype` have no enumerable properties.
 * Non-empty structured objects that match an exact own key set cannot be built-in
 * exotic objects (IndexedDB does not serialize expando properties onto Date, Map,
 * Set, RegExp, or typed arrays); `attribution.dates` may be empty so its prototype
 * is still checked explicitly. Returns `false` for any non-canonical or invalid
 * shape so the caller runs the full `savedRow` check.
 */
function validateStructuredV2Row(
  entry: unknown,
  language: string,
  checked: SavedRowListCache,
  hints: RowReaderHints,
): entry is PackageEntryV2 {
  if (!isRecord(entry)) return false;
  let kIdx = 0;
  for (const key in entry) {
    if (key !== V2_FIELDS_BOTH[kIdx++]) return false;
  }
  if (kIdx !== 13) return false;
  if (
    !eventId(entry.event) ||
    entry.language !== language ||
    typeof entry.plain_text !== "string" ||
    !(entry.body === null || hashId(entry.body)) ||
    typeof entry.notes !== "boolean" ||
    typeof entry.rafsi_complete !== "boolean" ||
    (entry.search_status !== "active" &&
      (typeof entry.search_status !== "string" ||
        !STATUSES.has(entry.search_status))) ||
    !checkIssuerWithHints(entry.issuer, hints)
  )
    return false;

  const word = entry.word;
  if (!isRecord(word)) return false;
  kIdx = 0;
  for (const key in word) {
    if (key !== WORD_FIELDS[kIdx++]) return false;
  }
  if (kIdx !== 2 || word.language !== "jbo" || typeof word.spelling !== "string")
    return false;

  const classification = entry.classification;
  if (!isRecord(classification)) return false;
  kIdx = 0;
  for (const key in classification) {
    if (key !== CLASSIFICATION_FIELDS[kIdx++]) return false;
  }
  if (
    kIdx !== 2 ||
    typeof classification.kind !== "string" ||
    !LEXICAL_KINDS.has(classification.kind)
  )
    return false;

  const selmaho = classification.selmaho;
  if (!Array.isArray(selmaho)) return false;
  if (selmaho.length < 4 || !checked.selmaho?.has(selmaho)) {
    if (!isDenseStructuredArray(selmaho)) return false;
    for (let i = 0; i < selmaho.length; i++)
      if (typeof selmaho[i] !== "string") return false;
    if (selmaho.length >= 4) (checked.selmaho ??= new Set()).add(selmaho);
  }

  const glosses = entry.glosses;
  if (!Array.isArray(glosses) || glosses.length > PACKAGE_GLOSS_LIMIT)
    return false;
  if (glosses.length < 4 || !checked.glosses?.has(glosses)) {
    if (!isDenseStructuredArray(glosses)) return false;
    const glossHint = hints.glossLanguage;
    for (let i = 0; i < glosses.length; i++) {
      const gloss = glosses[i];
      if (!isRecord(gloss)) return false;
      kIdx = 0;
      for (const key in gloss) {
        if (key !== GLOSS_FIELDS[kIdx++]) return false;
      }
      if (
        kIdx !== 3 ||
        typeof gloss.text !== "string" ||
        !(gloss.sense === null || typeof gloss.sense === "string")
      )
        return false;
      if (gloss.language !== glossHint.value) {
        if (!languageTag(gloss.language)) return false;
        glossHint.value = gloss.language;
      }
    }
    if (glosses.length >= 4) (checked.glosses ??= new Set()).add(glosses);
  }

  const rafsi = entry.rafsi;
  if (!Array.isArray(rafsi) || rafsi.length > PACKAGE_RAFSI_LIMIT) return false;
  if (rafsi.length < 4 || !checked.rafsi?.has(rafsi)) {
    if (!isDenseStructuredArray(rafsi)) return false;
    for (let i = 0; i < rafsi.length; i++)
      if (!validPackageRafsi(rafsi[i])) return false;
    if (rafsi.length >= 4) (checked.rafsi ??= new Set()).add(rafsi);
  }

  const attribution = entry.attribution;
  if (attribution !== null) {
    if (!isRecord(attribution)) return false;
    kIdx = 0;
    for (const key in attribution) {
      if (key !== ATTRIBUTION_FIELDS[kIdx++]) return false;
    }
    if (
      kIdx !== 4 ||
      typeof attribution.source !== "string" ||
      !(attribution.author === null || typeof attribution.author === "string")
    )
      return false;
    const account = attribution.account;
    if (account !== null) {
      if (!isRecord(account)) return false;
      kIdx = 0;
      for (const key in account) {
        if (key !== ACCOUNT_FIELDS[kIdx++]) return false;
      }
      if (
        kIdx !== 2 ||
        typeof account.origin !== "string" ||
        !Number.isSafeInteger(account.account)
      )
        return false;
    }
    const dates = attribution.dates;
    if (!checked.dates?.has(dates)) {
      if (!isRecord(dates) || Object.getPrototypeOf(dates) !== OBJECT_PROTO)
        return false;
      let count = 0;
      for (const key in dates) {
        if (typeof dates[key] !== "string") return false;
        count++;
      }
      if (count >= 4) (checked.dates ??= new Set()).add(dates);
    }
  }
  return true;
}

/** Read rows in event order. Each package starts a new reader. */
export function savedRowReader(
  pkg: CachedPackage,
  language: string,
  budget?: SearchRequestBudget,
  listsVerified = false,
) {
  let previous = "";
  const checked = savedRowListCache();
  const languageValid = languageTag(language);
  const viewValid =
    pkg.search_view !== undefined && eventId(pkg.search_view);
  const cleanProto = hasCleanPrototypes();
  const structured = cleanProto && structuredPackages.has(pkg);
  const fastStructuredV2 =
    structured &&
    !listsVerified &&
    budget === undefined &&
    pkg.version === 2 &&
    languageValid &&
    viewValid;
  const hints: RowReaderHints = {
    languageValidated: languageValid,
    viewValidated: viewValid,
    cleanProto,
    structured,
    issuerA: "",
    issuerB: "",
    glossLanguage: { value: languageValid ? language : "" },
  };
  return (value: unknown) => {
    const row =
      fastStructuredV2 &&
      validateStructuredV2Row(value, language, checked, hints)
        ? value
        : savedRow(
            value,
            pkg.version,
            language,
            pkg.search_view,
            budget,
            listsVerified,
            checked,
            hints,
          );
    if (row.event <= previous) throw new PackageValidationError();
    previous = row.event;
    return row;
  };
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

/** Reuse exact spelling-to-word-ID lookups within one package walk. */
export function savedWordIdCache(
  identify: typeof wordId = wordId,
): (spelling: string) => string {
  const ids = new Map<string, string>();
  return (spelling: string) => {
    let id = ids.get(spelling);
    if (id === undefined) {
      try {
        id = identify({ language: "jbo", spelling });
      } catch {
        throw new PackageValidationError();
      }
      ids.set(spelling, id);
    }
    return id;
  };
}

/** Check a row's spelling when the caller does not need its ID. */
export function checkSavedWord(word: {
  language: "jbo";
  spelling: string;
}): void {
  const status = wordSpellingStatus(word.spelling);
  if (status === "valid") return;
  if (status === "invalid" || !validWordIdSpellings([word.spelling]))
    throw new PackageValidationError();
}

/** Resolve canonical word IDs for saved rows in small core batches. */
export function savedWordIdBatcher<T>(onItem: (item: T, id: string) => void) {
  const ids = new Map<string, string>();
  const pendingSpellings: string[] = [];
  const pendingItems: T[] = [];
  const needed: string[] = [];
  const queued = new Set<string>();
  const flush = () => {
    if (!pendingItems.length) return;
    if (needed.length) {
      let resolved: string[];
      try {
        resolved = wordIdSpellings(needed);
      } catch {
        throw new PackageValidationError();
      }
      for (let i = 0; i < needed.length; i++) ids.set(needed[i], resolved[i]);
      needed.length = 0;
      queued.clear();
    }
    for (let i = 0; i < pendingItems.length; i++) {
      onItem(pendingItems[i], ids.get(pendingSpellings[i])!);
    }
    pendingSpellings.length = 0;
    pendingItems.length = 0;
  };
  return {
    add(spelling: string, item: T) {
      const known = ids.get(spelling);
      if (known !== undefined) {
        if (!pendingItems.length) {
          onItem(item, known);
          return;
        }
        pendingSpellings.push(spelling);
        pendingItems.push(item);
        if (pendingItems.length === 2048) flush();
        return;
      }
      if (wordSpellingStatus(spelling) === "invalid")
        throw new PackageValidationError();
      pendingSpellings.push(spelling);
      pendingItems.push(item);
      if (!queued.has(spelling)) {
        queued.add(spelling);
        needed.push(spelling);
      }
      if (needed.length === 512 || pendingItems.length === 2048) flush();
    },
    finish: flush,
  };
}

/** Check rafsi claim unions by canonical core word ID in small core batches. */
export function savedRafsiClaims(
  onEntry?: (entry: PackageEntryV2, id: string) => void,
) {
  const countRafsi = savedRafsiUnion();
  const batch = savedWordIdBatcher<PackageEntryV2>((entry, id) => {
    countRafsi(id, entry);
    onEntry?.(entry, id);
  });
  return {
    add(entry: PackageEntryV2) {
      if (!entry.rafsi.length) return;
      batch.add(entry.word.spelling, entry);
    },
    finish: batch.finish,
  };
}

/** Check spellings in small batches during the row walk. Finish before using the package. */
export function savedSpellingChecks() {
  const spellings: string[] = [];
  const finish = () => {
    if (spellings.length && !validWordIdSpellings(spellings))
      throw new PackageValidationError();
    spellings.length = 0;
  };
  return {
    add(spelling: string) {
      const status = wordSpellingStatus(spelling);
      if (status === "valid") return;
      if (status === "invalid") throw new PackageValidationError();
      spellings.push(spelling);
      if (spellings.length === 128) finish();
    },
    finish,
  };
}
