/**
 * Search packages and local search. Package bytes are checked against the
 * manifest hashes before activation. Local search never sends the query.
 */
import {
  canonicalize,
  contentHash,
  wordId,
} from "../../../../packages/core/src/browser.ts";
import {
  entryContentUnits,
  selectMatches,
  selectRafsiMatches,
  withSegmentation,
  matchRank,
  isPatternQuery,
  comparePatternSpelling,
  searchMetrics,
  SearchRequestBudget,
  type SearchOptions,
  type SegmentationStatus,
  type SearchMetrics,
  type PreparedQuery,
} from "../../../../packages/search/src/index.ts";
export {
  normalizeQuery,
  matchKind,
} from "../../../../packages/search/src/index.ts";
import {
  getManifest,
  objectBytes,
  RequestError,
  TransportError,
  type RequestOptions,
} from "./api.ts";
import {
  eventId,
  hashId,
  languageTag,
  lexicalKinds,
  identityId,
  type PackageEntry,
  type PackageEntryV2,
  type SearchHit,
} from "../model/types.ts";
import {
  invalidPackage,
  validateEntry,
  type CachedPackage,
} from "./package-check.ts";
export {
  checkSavedPackage,
  checkSavedRow,
  invalidPackage,
  validateCachedPackage,
  validateEntry,
  PACKAGE_RAFSI_LIMIT,
  type CachedPackage,
} from "./package-check.ts";

/** Package objects are immutable snapshots. Reuse their identity index across renders. */
export function createPackageWordIndex(identify: typeof wordId = wordId) {
  const indexes = new WeakMap<
    CachedPackage,
    { words: Map<string, PackageEntry[]>; invalidEntries: number }
  >();
  const indexFor = (pkg: CachedPackage) => {
    let index = indexes.get(pkg);
    if (!index) {
      index = { words: new Map(), invalidEntries: 0 };
      for (const entry of pkg.entries) {
        let id;
        try {
          id = identify(entry.word);
        } catch {
          index.invalidEntries++;
          continue;
        }
        const rows = index.words.get(id) ?? [];
        rows.push(entry);
        index.words.set(id, rows);
      }
      indexes.set(pkg, index);
    }
    return index;
  };
  return Object.assign(
    (pkg: CachedPackage, identity: string): readonly PackageEntry[] =>
      indexFor(pkg).words.get(identity) ?? [],
    { invalidEntryCount: (pkg: CachedPackage) => indexFor(pkg).invalidEntries },
  );
}
export const packageWordEntries = createPackageWordIndex();

export function isV2(entry: PackageEntry): entry is PackageEntryV2 {
  return !!entry && typeof entry === "object" && "issuer" in entry;
}
/**
 * Per-artifact bounds (W07). A package manifest is one HTTP object of at most
 * 1 MiB. A part is one HTTP object of at most 4 MiB and 2,000 entries. There
 * is no per-language total: a valid package of any part, entry, or byte count
 * downloads. An optional download quota can cap one download when configured.
 */
const MANIFEST_BYTE_LIMIT = 1048576;
const PART_BYTE_LIMIT = 4194304;
const PART_ENTRY_LIMIT = 2000;
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
/** A package download or save that the device cannot fit. */
export class PackageStorageError extends Error {
  constructor(
    message = "The search package does not fit in this browser's storage or memory. Free space and try again, or search this server.",
  ) {
    super(message);
  }
}
/** A package download that a configured quota stops. */
export class PackageQuotaError extends Error {}
const quotaMessage = (kind: string, used: number, allowed: number) =>
  new PackageQuotaError(
    `The search package exceeds the configured package quota of ${allowed} ${kind} (has ${used}). Raise the quota or search this server.`,
  );
/** Maps a platform failure to its own message; every other error passes through. */
export function reportPackageError(error: unknown): Error {
  if (
    error instanceof Error &&
    (error as { name?: string } | null)?.name === "QuotaExceededError"
  )
    return new PackageStorageError();
  return error instanceof Error ? error : new Error(String(error));
}
/**
 * Optional per-download package quota. Every bound is off by default
 * (undefined). Set a bound to cap one download; the download then fails with
 * PackageQuotaError instead of consuming unbounded memory or storage.
 */
export interface PackageQuota {
  parts?: number;
  entries?: number;
  bytes?: number;
}
export interface PackageDownloadOptions extends RequestOptions {
  packageQuota?: PackageQuota;
}
/**
 * Downloads a search package. Version 2 is requested when the manifest offers it,
 * so result rows can show authors, notes, and rafsi. Version 1 remains the fallback.
 */
export async function downloadPackage(
  language: string,
  options: PackageDownloadOptions = {},
): Promise<CachedPackage> {
  try {
    return await downloadVersion(language, options, null);
  } catch (error) {
    // A version 2 package that the server advertised and that failed its
    // checks does not block search. The version 1 package is used instead,
    // and the cached package records why. A network failure, a cancel, a
    // physical failure, or a configured quota is reported as it is.
    if (
      !(error instanceof PackageVersionError) ||
      error.version !== 2 ||
      options.signal?.aborted
    )
      throw reportPackageError(error);
    const reason = error.message;
    return downloadVersion(language, options, reason);
  }
}
/** A package failure that names the version that failed. */
export class PackageVersionError extends Error {
  constructor(
    public version: 1 | 2,
    message: string,
  ) {
    super(message);
  }
}
async function downloadVersion(
  language: string,
  options: PackageDownloadOptions,
  downgrade: string | null,
): Promise<CachedPackage> {
  const deadline = AbortSignal.timeout(120000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline])
    : deadline;
  const manifest = await getManifest({ ...options, signal });
  if (manifest.packages_available === false)
    throw new Error(
      "Search packages are temporarily unavailable. The service cannot evaluate publication receipts.",
    );
  for (const descriptor of manifest.packages)
    if (!count(descriptor.bytes, MANIFEST_BYTE_LIMIT)) throw invalidPackage();
  const versions = Array.isArray(manifest.package_versions)
    ? manifest.package_versions
    : [];
  if (versions.length > 4096) throw invalidPackage();
  for (const descriptor of versions)
    if (
      !fields(descriptor, ["language", "version", "hash", "bytes"]) ||
      !languageTag(descriptor.language) ||
      !hashId(descriptor.hash) ||
      !count(descriptor.bytes, MANIFEST_BYTE_LIMIT) ||
      !Number.isSafeInteger(descriptor.version)
    )
      throw invalidPackage();
  const v2 = versions.filter((p) => p.language === language && p.version === 2);
  if (v2.length > 1) throw invalidPackage();
  // After a failed version 2 download, only version 1 is requested.
  const useV2 = v2.length > 0 && downgrade === null;
  const advertised = useV2
    ? v2
    : manifest.packages.filter((p) => p.language === language);
  const version: 1 | 2 = useV2 ? 2 : 1;
  if (!advertised.length)
    throw new Error("This server offers no search package for that language.");
  if (advertised.length !== 1) throw invalidPackage();
  try {
    const downloaded = await downloadEntries(
      language,
      version,
      manifest.snapshot,
      advertised[0],
      { ...options, signal },
    );
    return { snapshot: manifest.snapshot, version, ...downloaded, downgrade };
  } catch (error) {
    // Only a package that fails its checks names a version. A transport
    // failure, a server error, a cancel, a physical failure, or a configured
    // quota is reported as it is, and no other version is requested in its
    // place.
    const reported = reportPackageError(error);
    if (
      reported instanceof TransportError ||
      reported instanceof RequestError ||
      reported instanceof PackageStorageError ||
      reported instanceof PackageQuotaError ||
      (reported instanceof Error && reported.name === "AbortError")
    )
      throw reported;
    throw new PackageVersionError(
      version,
      error instanceof Error ? error.message : String(error),
    );
  }
}
/** Downloads and checks one advertised package and its parts. */
async function downloadEntries(
  language: string,
  version: 1 | 2,
  snapshot: string,
  advertised: { hash: string; bytes: number },
  options: PackageDownloadOptions,
): Promise<Pick<CachedPackage, "entries" | "search_view">> {
  const signal = options.signal;
  const quota = options.packageQuota;
  const manifest = { snapshot };
  const raw = await objectBytes(
    `/packages/${encodeURIComponent(language)}?snapshot=${encodeURIComponent(manifest.snapshot)}${version === 2 ? "&version=2" : ""}`,
    MANIFEST_BYTE_LIMIT,
    { ...options, signal },
  );
  if (raw.length !== advertised.bytes || contentHash(raw) !== advertised.hash)
    throw new Error(
      "The search package hash did not match. Search this server or download another package.",
    );
  const pkg = JSON.parse(canonicalize(raw));
  if (
    !(
      fields(pkg, ["version", "language", "snapshot", "parts"]) ||
      (version === 2 &&
        fields(pkg, [
          "version",
          "language",
          "snapshot",
          "parts",
          "search_view",
        ]) &&
        eventId(pkg.search_view))
    ) ||
    pkg.version !== version ||
    pkg.language !== language ||
    pkg.snapshot !== manifest.snapshot ||
    !Array.isArray(pkg.parts)
  )
    throw invalidPackage();
  // No per-language totals: any part count downloads unless a quota caps it.
  if (quota?.parts !== undefined && pkg.parts.length > quota.parts)
    throw quotaMessage("parts", pkg.parts.length, quota.parts);
  let totalBytes = 0;
  let totalEntries = 0;
  const hashes = new Set<string>();
  for (const part of pkg.parts) {
    if (
      !fields(part, ["hash", "bytes", "count"]) ||
      !hashId(part.hash) ||
      !count(part.bytes, PART_BYTE_LIMIT) ||
      part.bytes < 2 ||
      !count(part.count, PART_ENTRY_LIMIT) ||
      hashes.has(part.hash)
    )
      throw invalidPackage();
    hashes.add(part.hash);
    totalBytes += part.bytes;
    totalEntries += part.count;
    if (quota?.bytes !== undefined && totalBytes > quota.bytes)
      throw quotaMessage("bytes", totalBytes, quota.bytes);
    if (quota?.entries !== undefined && totalEntries > quota.entries)
      throw quotaMessage("entries", totalEntries, quota.entries);
  }
  const entries: PackageEntry[] = [];
  let previous = "";
  try {
    for (const part of pkg.parts) {
      const bytes = await objectBytes(
        `/package-parts/${encodeURIComponent(part.hash)}`,
        PART_BYTE_LIMIT,
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
        validateEntry(entry, language, version, pkg.search_view);
        if (pkg.search_view && typeof entry.search_status !== "string")
          throw invalidPackage();
        if (entry.event <= previous) throw invalidPackage();
        previous = entry.event;
        entries.push(entry);
      }
    }
  } catch (error) {
    // Growing the retained entry array without a per-language total can
    // exhaust memory on a small device. That physical failure keeps its own
    // message instead of looking malformed.
    if (error instanceof RangeError) throw new PackageStorageError();
    throw error;
  }
  return {
    entries,
    ...(pkg.search_view ? { search_view: pkg.search_view } : {}),
  };
}
export interface LocalHit extends SearchHit {
  /** Every matching entry of the word, strongest first. */
  entries: PackageEntry[];
  matchingRafsi?: string[];
}
/** Groups matching entries by word, ordered by match class and stable word ID. */
export function localSearch(
  entries: PackageEntry[],
  query: string | PreparedQuery,
  metrics?: SearchMetrics,
  rafsiOnly = false,
  options: SearchOptions = {},
): LocalHit[] & { segmentation: SegmentationStatus; allLojban: boolean } {
  // Grouping and sorting belong to the same request budget as the scan, so
  // the deadline covers the whole product operation.
  const measured = metrics ?? searchMetrics();
  const limit = SearchRequestBudget.for(measured, options);
  const childOptions = { ...options, requestBudget: limit };
  const queryText =
    typeof query === "string" ? query : (query.pattern ?? query.text);
  const selected = rafsiOnly
    ? selectRafsiMatches(entries, queryText, measured, {
        ...childOptions,
        // A prepared query already passed the cap on its raw spelling in
        // prepareQuery; only a raw string query is checked again here, so
        // text expanded by normalization or lowercasing still completes.
        enforceQueryLengthCap:
          typeof query === "string" && childOptions.enforceQueryLengthCap,
      })
    : selectMatches(entries, query, measured, undefined, {
        ...childOptions,
        knownWord: (entry) => {
          const evidence = entry.search_status;
          const view =
            typeof evidence === "string" ? options.packageView : evidence?.view;
          const status =
            typeof evidence === "string" ? evidence : evidence?.status;
          return (
            !!view &&
            (!options.view || view === options.view) &&
            (status === "active" ||
              (options.includeRetired === true && status === "retired"))
          );
        },
      });
  const grouped = new Map<string, LocalHit & { position: number }>();
  // Retained rafsi per word accumulate in a set and sort once below, so the
  // merge costs one unit per spelling instead of a sort per hit.
  const rafsiSets = new Map<string, Set<string>>();
  const takeRafsi = (id: string, spellings: readonly string[]) => {
    let set = rafsiSets.get(id);
    if (!set) {
      set = new Set();
      rafsiSets.set(id, set);
    }
    for (const spelling of spellings) {
      limit.reserve(1, "search");
      set.add(spelling);
    }
  };
  for (const { entry, match, position, rafsi } of selected.rows) {
    // Grouping one hit costs one unit, charged before the hit is grouped.
    limit.reserve(1, "search");
    const id = wordId({ language: "jbo", spelling: entry.word.spelling });
    const preview = {
      event: entry.event,
      word_kind: entry.classification.kind,
      // A code point uses at most two UTF-16 units. Read only the preview,
      // the same bound the client rebuild uses, so a huge definition is
      // never copied in full here. The first 240 code points always fit in
      // the first 480 units, so the shorter read is exact.
      plain_text: Array.from(entry.plain_text.slice(0, 480))
        .slice(0, 240)
        .join(""),
      status: "unavailable",
    };
    const old = grouped.get(id);
    if (old) {
      old.definitions.push(entry.event);
      old.entries.push(entry);
      if (rafsi) takeRafsi(id, rafsi);
      if (
        matchRank(match) < matchRank(old.match) ||
        (match === old.match && entry.event < old.preview!.event)
      ) {
        old.match = match;
        old.position = position;
        old.preview = preview;
        old.word = entry.word;
        // Move the preview entry first, keeping the rest stable. Each
        // comparison costs one unit, charged before the comparison runs.
        old.entries.sort((a, b) => {
          limit.reserve(1, "search");
          return a.event === preview.event
            ? -1
            : b.event === preview.event
              ? 1
              : 0;
        });
      }
    } else {
      if (rafsi) takeRafsi(id, rafsi);
      grouped.set(id, {
        word: entry.word,
        word_id: id,
        definitions: [entry.event],
        match,
        position,
        preview,
        entries: [entry],
        ...(rafsi ? { matchingRafsi: rafsi } : {}),
      });
    }
  }
  for (const [id, set] of rafsiSets) {
    const hit = grouped.get(id)!;
    // Merging kept every spelling once; one sort per word finishes the list.
    const merged = [...set].sort((a, b) => {
      limit.reserve(1, "search");
      return a < b ? -1 : a > b ? 1 : 0;
    });
    hit.matchingRafsi = merged;
  }
  // The pattern test depends only on the query, so classify once up front
  // instead of re-testing the full raw query on every tied comparison.
  const matchPattern = options.patterns !== false && isPatternQuery(queryText);
  const ordered = [...grouped.values()].sort((a, b) => {
    // One comparison costs one unit, charged before the comparison runs.
    limit.reserve(1, "search");
    return (
      matchRank(a.match) - matchRank(b.match) ||
      a.position - b.position ||
      (matchPattern
        ? comparePatternSpelling(a.word.spelling, b.word.spelling)
        : 0) ||
      (a.word_id < b.word_id ? -1 : a.word_id > b.word_id ? 1 : 0)
    );
  });
  return withSegmentation(
    ordered.map(({ position, ...hit }) => {
      void position;
      // One mapped row costs one unit, charged before the row is mapped.
      limit.reserve(1, "search");
      return hit;
    }),
    selected.segmentation,
    "allLojban" in selected ? selected.allLojban : false,
  );
}
