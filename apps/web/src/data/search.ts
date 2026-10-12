/**
 * Search packages and local search. Package bytes are checked against the
 * manifest hashes before activation. Local search never sends the query.
 */
import {
  canonicalize,
  contentHash,
  wordId,
} from "../../../../packages/core/src/index.ts";
import { getManifest, objectBytes, type RequestOptions } from "./api.ts";
import {
  eventId,
  hashId,
  languageTag,
  lexicalKinds,
  matchKinds,
  identityId,
  type MatchKind,
  type PackageEntry,
  type PackageEntryV2,
  type SearchHit,
} from "../model/types.ts";

export interface CachedPackage {
  snapshot: string;
  /** 1 for the default package, 2 when the entries carry row metadata. */
  version?: 1 | 2;
  entries: PackageEntry[];
}
export function isV2(entry: PackageEntry): entry is PackageEntryV2 {
  return "issuer" in entry;
}
const PACKAGE_LIMITS = { parts: 128, bytes: 134217728, entries: 200000 };
function fields(value: unknown, names: string[]): value is Record<string, any> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === names.length &&
    names.every((name) => Object.hasOwn(value, name))
  );
}
const count = (value: unknown, maximum: number): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= maximum;
const invalidPackage = () =>
  new Error(
    "The search package is invalid or exceeds the browser limit. Search this server or download another package.",
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
export function validateEntry(
  value: unknown,
  language: string,
  version: 1 | 2 = 1,
): asserts value is PackageEntry {
  if (version === 2) {
    if (
      !fields(value, V2_FIELDS) ||
      !identityId(value.issuer) ||
      typeof value.notes !== "boolean" ||
      !Array.isArray(value.rafsi) ||
      value.rafsi.length > 64 ||
      value.rafsi.some((r: unknown) => typeof r !== "string") ||
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
    const { issuer, notes, rafsi, attribution, ...base } = value;
    void issuer;
    void notes;
    void rafsi;
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
): asserts value is CachedPackage {
  if (
    !(
      fields(value, ["snapshot", "entries"]) ||
      fields(value, ["snapshot", "version", "entries"])
    ) ||
    !hashId(value.snapshot) ||
    !Array.isArray(value.entries) ||
    value.entries.length > PACKAGE_LIMITS.entries ||
    !(value.version === undefined || value.version === 1 || value.version === 2)
  )
    throw invalidPackage();
  const version = value.version === 2 ? 2 : 1;
  let previous = "";
  for (const entry of value.entries) {
    validateEntry(entry, language, version);
    if (entry.event <= previous) throw invalidPackage();
    previous = entry.event;
  }
}
/**
 * Downloads a search package. Version 2 is requested when the manifest offers it,
 * so result rows can show authors, notes, and rafsi. Version 1 remains the fallback.
 */
export async function downloadPackage(
  language: string,
  options: RequestOptions = {},
): Promise<CachedPackage> {
  const deadline = AbortSignal.timeout(120000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline])
    : deadline;
  const manifest = await getManifest({ ...options, signal });
  for (const descriptor of manifest.packages)
    if (!count(descriptor.bytes, 1048576)) throw invalidPackage();
  const versions = Array.isArray(manifest.package_versions)
    ? manifest.package_versions
    : [];
  if (versions.length > 4096) throw invalidPackage();
  for (const descriptor of versions)
    if (
      !fields(descriptor, ["language", "version", "hash", "bytes"]) ||
      !languageTag(descriptor.language) ||
      !hashId(descriptor.hash) ||
      !count(descriptor.bytes, 1048576) ||
      !Number.isSafeInteger(descriptor.version)
    )
      throw invalidPackage();
  const v2 = versions.filter((p) => p.language === language && p.version === 2);
  if (v2.length > 1) throw invalidPackage();
  const advertised = v2.length
    ? v2
    : manifest.packages.filter((p) => p.language === language);
  const version: 1 | 2 = v2.length ? 2 : 1;
  if (!advertised.length)
    throw new Error("This server offers no search package for that language.");
  if (advertised.length !== 1) throw invalidPackage();
  const raw = await objectBytes(
    `/packages/${encodeURIComponent(language)}?snapshot=${encodeURIComponent(manifest.snapshot)}${version === 2 ? "&version=2" : ""}`,
    1048576,
    { ...options, signal },
  );
  if (
    raw.length !== advertised[0].bytes ||
    contentHash(raw) !== advertised[0].hash
  )
    throw new Error(
      "The search package hash did not match. Search this server or download another package.",
    );
  const pkg = JSON.parse(canonicalize(raw));
  if (
    !fields(pkg, ["version", "language", "snapshot", "parts"]) ||
    pkg.version !== version ||
    pkg.language !== language ||
    pkg.snapshot !== manifest.snapshot ||
    !Array.isArray(pkg.parts) ||
    pkg.parts.length > PACKAGE_LIMITS.parts
  )
    throw invalidPackage();
  let totalBytes = 0;
  let totalEntries = 0;
  const hashes = new Set<string>();
  for (const part of pkg.parts) {
    if (
      !fields(part, ["hash", "bytes", "count"]) ||
      !hashId(part.hash) ||
      !count(part.bytes, 4194304) ||
      part.bytes < 2 ||
      !count(part.count, 2000) ||
      hashes.has(part.hash)
    )
      throw invalidPackage();
    hashes.add(part.hash);
    totalBytes += part.bytes;
    totalEntries += part.count;
    if (
      totalBytes > PACKAGE_LIMITS.bytes ||
      totalEntries > PACKAGE_LIMITS.entries
    )
      throw invalidPackage();
  }
  const entries: PackageEntry[] = [];
  let previous = "";
  for (const part of pkg.parts) {
    const bytes = await objectBytes(
      `/package-parts/${encodeURIComponent(part.hash)}`,
      4194304,
      { ...options, signal },
    );
    if (bytes.length !== part.bytes || contentHash(bytes) !== part.hash)
      throw new Error(
        "The search part hash did not match. Search this server or download another package.",
      );
    const data = JSON.parse(canonicalize(bytes));
    if (!Array.isArray(data) || data.length !== part.count)
      throw invalidPackage();
    for (const entry of data) {
      validateEntry(entry, language, version);
      if (entry.event <= previous) throw invalidPackage();
      previous = entry.event;
      entries.push(entry);
    }
  }
  return { snapshot: manifest.snapshot, version, entries };
}
/** Search normalization for lookup only. It never rewrites signed text. */
export function normalizeQuery(value: string): string {
  return value
    .normalize("NFC")
    .toLocaleLowerCase("en")
    .replaceAll("’", "'")
    .trim();
}
export function matchKind(entry: PackageEntry, q: string): MatchKind | null {
  const spelling = normalizeQuery(entry.word.spelling);
  const glosses = entry.glosses.map((gloss) => normalizeQuery(gloss.text));
  if (spelling === q) return "headword";
  if (glosses.includes(q)) return "gloss";
  if (spelling.startsWith(q)) return "headword-prefix";
  if (glosses.some((gloss) => gloss.startsWith(q))) return "gloss-prefix";
  if (normalizeQuery(entry.plain_text).includes(q)) return "token";
  return null;
}
export interface LocalHit extends SearchHit {
  /** Every matching entry of the word, strongest first. */
  entries: PackageEntry[];
}
/** Groups matching entries by word, ordered by match class and stable word ID. */
export function localSearch(
  entries: PackageEntry[],
  query: string,
): LocalHit[] {
  const q = normalizeQuery(query);
  if (!q) return [];
  const grouped = new Map<string, LocalHit>();
  for (const entry of entries) {
    const match = matchKind(entry, q);
    if (!match) continue;
    const id = wordId({ language: "jbo", spelling: entry.word.spelling });
    const preview = {
      event: entry.event,
      word_kind: entry.classification.kind,
      plain_text: Array.from(entry.plain_text).slice(0, 240).join(""),
      status: "unavailable",
    };
    const old = grouped.get(id);
    if (old) {
      old.definitions.push(entry.event);
      old.entries.push(entry);
      if (
        matchKinds.indexOf(match) < matchKinds.indexOf(old.match) ||
        (match === old.match && entry.event < old.preview!.event)
      ) {
        old.match = match;
        old.preview = preview;
        old.entries.sort((a, b) =>
          a.event === preview.event ? -1 : b.event === preview.event ? 1 : 0,
        );
      }
    } else
      grouped.set(id, {
        word: entry.word,
        word_id: id,
        definitions: [entry.event],
        match,
        preview,
        entries: [entry],
      });
  }
  return [...grouped.values()].sort(
    (a, b) =>
      matchKinds.indexOf(a.match) - matchKinds.indexOf(b.match) ||
      a.word_id.localeCompare(b.word_id, "en"),
  );
}
