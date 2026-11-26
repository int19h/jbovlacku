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
  // Inspect actual own keys without charging a request budget or sampling indices:
  // work scales with supplied keys, so sparse huge lengths always fail as invalid.
  // An array lists its indices first, then its intrinsic length, then extra keys.
  const keys = Reflect.ownKeys(value);
  return keys.length === value.length + 1 && keys[value.length] === "length";
}

const WORD_FIELDS = ["language", "spelling"];
const CLASSIFICATION_FIELDS = ["kind", "selmaho"];
const GLOSS_FIELDS = ["language", "text", "sense"];
const ATTRIBUTION_FIELDS = ["source", "author", "account", "dates"];
const ACCOUNT_FIELDS = ["origin", "account"];
const LEGACY_STATUS_FIELDS = ["view", "status"];

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
  const { entries } = pkg;
  requireDenseList(entries);
  let checkedLists: Set<unknown> | undefined;
  const checkDense = (list: unknown) => {
    if (Array.isArray(list) && list.length >= 4) {
      if (checkedLists?.has(list)) return;
      requireDenseList(list);
      (checkedLists ??= new Set()).add(list);
      return;
    }
    requireDenseList(list);
  };
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!isRecord(entry)) throw new PackageValidationError();
    const { glosses, classification, rafsi } = entry;
    if (!Array.isArray(glosses) || glosses.length > PACKAGE_GLOSS_LIMIT)
      throw new PackageValidationError();
    checkDense(glosses);
    if (!isRecord(classification)) throw new PackageValidationError();
    checkDense(classification.selmaho);
    if (Object.hasOwn(entry, "rafsi")) {
      if (!Array.isArray(rafsi) || rafsi.length > PACKAGE_RAFSI_LIMIT)
        throw new PackageValidationError();
      checkDense(rafsi);
    }
  }
}

/** Check the shapes that content measurement reads before measuring content. */
export function requireSavedRowLists(
  value: unknown,
  budget?: SearchRequestBudget,
  listsVerified = false,
  checked?: SavedRowListCache,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new PackageValidationError();
  const { word, classification, glosses, rafsi, attribution } = value;
  if (
    !fields(word, WORD_FIELDS) ||
    typeof word.spelling !== "string" ||
    !fields(classification, CLASSIFICATION_FIELDS)
  )
    throw new PackageValidationError();

  if (!listsVerified) {
    if (!Array.isArray(glosses) || glosses.length > PACKAGE_GLOSS_LIMIT)
      throw new PackageValidationError();
    if (glosses.length < 4 || !checked?.glosses?.has(glosses))
      requireDenseList(glosses);
  }
  const glossList = glosses as unknown[];
  if (glossList.length < 4 || !checked?.glosses?.has(glossList)) {
    for (let i = 0; i < glossList.length; i++) {
      const gloss = glossList[i];
      if (
        !fields(gloss, GLOSS_FIELDS) ||
        !languageTag(gloss.language) ||
        typeof gloss.text !== "string" ||
        !(gloss.sense === null || typeof gloss.sense === "string")
      )
        throw new PackageValidationError();
    }
    if (checked && glossList.length >= 4)
      (checked.glosses ??= new Set()).add(glossList);
  }

  const { selmaho } = classification;
  if (
    !listsVerified &&
    (!Array.isArray(selmaho) ||
      selmaho.length < 4 ||
      !checked?.selmaho?.has(selmaho))
  )
    requireDenseList(selmaho);
  const selmahoList = selmaho as unknown[];
  if (selmahoList.length < 4 || !checked?.selmaho?.has(selmahoList)) {
    for (let i = 0; i < selmahoList.length; i++) {
      if (typeof selmahoList[i] !== "string")
        throw new PackageValidationError();
      if (budget && (i + 1) % 64 === 0) budget.ensure(2 + i, "prepare");
    }
    if (checked && selmahoList.length >= 4)
      (checked.selmaho ??= new Set()).add(selmahoList);
  }

  if (Object.hasOwn(value, "rafsi")) {
    if (!listsVerified) {
      if (!Array.isArray(rafsi) || rafsi.length > PACKAGE_RAFSI_LIMIT)
        throw new PackageValidationError();
      if (rafsi.length < 4 || !checked?.rafsi?.has(rafsi))
        requireDenseList(rafsi);
    }
    const rafsiList = rafsi as unknown[];
    if (rafsiList.length < 4 || !checked?.rafsi?.has(rafsiList)) {
      for (let i = 0; i < rafsiList.length; i++)
        if (!validPackageRafsi(rafsiList[i]))
          throw new PackageValidationError();
      if (checked && rafsiList.length >= 4)
        (checked.rafsi ??= new Set()).add(rafsiList);
    }
  }

  if (attribution != null) {
    if (
      !fields(attribution, ATTRIBUTION_FIELDS) ||
      typeof attribution.source !== "string" ||
      !(
        attribution.author === null || typeof attribution.author === "string"
      ) ||
      !(
        attribution.account === null ||
        (fields(attribution.account, ACCOUNT_FIELDS) &&
          typeof attribution.account.origin === "string" &&
          Number.isSafeInteger(attribution.account.account))
      ) ||
      !isDateMap(attribution.dates) ||
      Object.getOwnPropertySymbols(attribution.dates).length !== 0
    )
      throw new PackageValidationError();

    if (!checked?.dates?.has(attribution.dates)) {
      let count = 0;
      for (const key in attribution.dates) {
        if (!Object.hasOwn(attribution.dates, key)) continue;
        if (typeof attribution.dates[key] !== "string")
          throw new PackageValidationError();
        count++;
        if (budget && count % 64 === 0) budget.ensure(1 + count, "prepare");
      }
      if (checked && count >= 4)
        (checked.dates ??= new Set()).add(attribution.dates);
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
  "event",
  "word",
  "language",
  "glosses",
  "plain_text",
  "classification",
  "body",
];
const V2_FIELDS = [...V1_FIELDS, "issuer", "notes", "rafsi", "attribution"];
const STATUS = ["active", "retired", "ineligible"];

/** Check one package row. The worker and direct readers use the same rule. */
export function savedRow(
  entry: unknown,
  version: 1 | 2 | undefined,
  language: string,
  packageView?: string,
  budget?: SearchRequestBudget,
  listsVerified = false,
  checked?: SavedRowListCache,
): PackageEntry {
  requireSavedRowLists(entry, budget, listsVerified, checked);
  if (
    !eventId(entry.event) ||
    entry.language !== language ||
    !languageTag(entry.language) ||
    (entry.word as Record<string, unknown>).language !== "jbo" ||
    typeof entry.plain_text !== "string" ||
    !(entry.body === null || hashId(entry.body)) ||
    !lexicalKinds.includes(
      (entry.classification as PackageEntry["classification"]).kind,
    )
  )
    throw new PackageValidationError();
  if (version === 2) {
    const hasStatus = Object.hasOwn(entry, "search_status");
    const extra =
      Number(hasStatus) + Number(Object.hasOwn(entry, "rafsi_complete"));
    const status = entry.search_status;
    if (
      !fields(entry, V2_FIELDS, extra) ||
      !identityId(entry.issuer) ||
      typeof entry.notes !== "boolean" ||
      !Array.isArray(entry.rafsi) ||
      entry.attribution === undefined ||
      !(
        entry.rafsi_complete === undefined ||
        typeof entry.rafsi_complete === "boolean"
      ) ||
      (packageView !== undefined
        ? !hasStatus ||
          !eventId(packageView) ||
          !STATUS.includes(status as string)
        : hasStatus &&
          (!fields(status, LEGACY_STATUS_FIELDS) ||
            !eventId(status.view) ||
            !STATUS.includes(status.status)))
    )
      throw new PackageValidationError();
  } else if (!fields(entry, V1_FIELDS) || packageView !== undefined) {
    throw new PackageValidationError();
  }
  return entry as unknown as PackageEntry;
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
  return (value: unknown) => {
    const row = savedRow(
      value,
      pkg.version,
      language,
      pkg.search_view,
      budget,
      listsVerified,
      checked,
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

/** Check rafsi claim unions by canonical core word ID in small core batches. */
export function savedRafsiClaims() {
  const countRafsi = savedRafsiUnion();
  const ids = new Map<string, string>();
  const pending: { spelling: string; entry: PackageEntryV2 }[] = [];
  const needed: string[] = [];
  const queued = new Set<string>();
  const flush = () => {
    if (!pending.length) return;
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
    for (let i = 0; i < pending.length; i++) {
      const item = pending[i];
      countRafsi(ids.get(item.spelling)!, item.entry);
    }
    pending.length = 0;
  };
  return {
    add(entry: PackageEntryV2) {
      if (!entry.rafsi.length) return;
      const { spelling } = entry.word;
      const known = ids.get(spelling);
      if (known !== undefined) {
        countRafsi(known, entry);
        return;
      }
      if (wordSpellingStatus(spelling) === "invalid")
        throw new PackageValidationError();
      pending.push({ spelling, entry });
      if (!queued.has(spelling)) {
        queued.add(spelling);
        needed.push(spelling);
      }
      if (needed.length === 128 || pending.length === 128) flush();
    },
    finish: flush,
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
