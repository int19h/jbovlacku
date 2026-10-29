import { placeGlyph } from "../../core/src/place-glyphs.ts";
import { prepareIndex, type SearchMetrics } from "../../search/src/index.ts";
import {
  canonicalize,
  contentHash,
  inspectBody,
  interpretDefinition,
  utf8,
  type EvaluationPackageRecord,
} from "../../core/src/index.ts";
import type { ObjectStore, Snapshot } from "./storage.ts";
import { orderedPrefetch, readRecordBytes } from "./record-reads.ts";
/**
 * Rafsi spellings listed per version 2 entry. The browser applies the same
 * bound. A longer list is cut, and the entry says so. The exact claims of a
 * word stay available through the word route and the claim bodies.
 */
export const PACKAGE_RAFSI_LIMIT = 64;
export interface SearchEntry {
  event: string;
  word: { language: "jbo"; spelling: string };
  language: string;
  glosses: { text: string }[];
  plain_text: string;
  classification: unknown;
  body: string;
}
/** Version 2 adds server-asserted metadata for result rows. */
export interface SearchEntryV2 extends SearchEntry {
  /** The signing identity of the publication. For imports, the importer. */
  issuer: string;
  /** Whether the definition has notes. */
  notes: boolean;
  /**
   * Rafsi spellings claimed for the word in this snapshot, from retained
   * claim bodies, sorted, at most `PACKAGE_RAFSI_LIMIT` of them.
   */
  rafsi: string[];
  /** False when the word has more claims than the list holds. */
  rafsi_complete: boolean;
  /** Imported source attribution, or null for native publications. */
  attribution: {
    source: string;
    author: string | null;
    account: { origin: string; account: number } | null;
    dates: Record<string, string>;
  } | null;
}
export interface SearchPackage {
  version: 1 | 2;
  language: string;
  snapshot: string;
  parts: { hash: string; bytes: number; count: number }[];
}
export interface MaterializedPackage {
  manifest: SearchPackage;
  hash: string;
  bytes: number;
}
export interface MaterializedPackages {
  entries: SearchEntry[];
  /** Private cache metadata. Null means that publication receipts are unavailable. */
  effectiveDefinitions?: string[] | null;
  packages: Record<string, MaterializedPackage>;
  /** Version 2 packages by language. */
  packages2: Record<string, MaterializedPackage>;
}
export interface SearchPreparation {
  metrics?: SearchMetrics;
  start?(): void;
  finish?(): void;
}
/** Complete the derived lexical index before a package becomes readable. */
export function preparePackageSearch<T extends MaterializedPackages>(
  packages: T,
  measurement?: SearchPreparation,
): T {
  measurement?.start?.();
  try {
    prepareIndex(packages.entries, measurement?.metrics);
  } finally {
    measurement?.finish?.();
  }
  return packages;
}
export interface PackageRecord extends EvaluationPackageRecord {
  envelope_hash: string;
  missing: boolean;
}
export function sameEffectiveDefinitions(
  previous: readonly string[] | null | undefined,
  current: readonly string[] | null,
): boolean {
  if (current === null) return previous === null;
  return (
    previous !== null &&
    previous?.length === current.length &&
    previous.every((id, index) => id === current[index])
  );
}
export function plainDefinitionText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((paragraph) => {
      if (!Array.isArray(paragraph)) return "";
      return paragraph
        .map((node) => {
          if (typeof node === "string") return node;
          if (typeof node === "number" && Number.isInteger(node) && node > 0)
            return node <= 50 ? placeGlyph(node) : `[place ${node}]`;
          if (node && typeof node === "object" && !Array.isArray(node)) {
            if (typeof node.label === "string") return node.label;
            if (typeof node.code === "string") return node.code;
            if (typeof node.operand === "string")
              return `[operand ${node.operand}]`;
          }
          return "";
        })
        .join("");
    })
    .join("\n");
}
const canonical = (value: unknown) =>
  utf8(canonicalize(utf8(JSON.stringify(value))));
export async function buildPackages(
  snapshot: Snapshot,
  objects: ObjectStore,
  prepared?: PackageRecord[],
  reuse?: { previous: MaterializedPackages; changed: PackageRecord[] },
  trustedHostRecords = false,
  effectiveDefinitions?: string[] | null,
  searchPreparation?: SearchPreparation,
): Promise<MaterializedPackages> {
  const entries: SearchEntry[] = [];
  const entries2: SearchEntryV2[] = [];
  const included =
    effectiveDefinitions === undefined
      ? undefined
      : new Set(effectiveDefinitions ?? []);
  // Rafsi spellings from retained claim bodies, by word ID.
  const rafsiByWord = new Map<string, Set<string>>();
  const incompleteRafsi = new Set<string>();
  async function* records(kind: EvaluationPackageRecord["kind"]) {
    if (prepared) {
      if (reuse || trustedHostRecords) {
        for (const record of prepared) if (record.kind === kind) yield record;
        return;
      }
      for await (const { value: record, result: loaded } of orderedPrefetch(
        prepared.filter((record) => record.kind === kind),
        (record) => {
          const event = snapshot.events[record.id];
          return readRecordBytes(
            objects,
            event.body_hash ? event.envelope_hash : null,
            event.body_hash,
          );
        },
      )) {
        const event = snapshot.events[record.id];
        const { envelope } = loaded;
        if (loaded.body.status === "rejected") throw loaded.body.reason;
        const bytes = loaded.body.value;
        let body: PackageRecord["body"] = null;
        if (envelope && bytes) {
          if (
            !record.missing &&
            contentHash(envelope) === record.envelope_hash &&
            contentHash(bytes) === record.body_hash
          )
            body = record.body;
          else {
            const checked = inspectBody(envelope, bytes);
            if (checked.availability === "valid")
              body =
                kind === "definition.publish"
                  ? interpretDefinition(checked.body)
                  : (checked.body as Record<string, unknown>);
          }
        }
        yield {
          ...record,
          body_hash: event.body_hash,
          body,
          missing: event.body_hash !== null && (!envelope || !bytes),
        };
      }
      return;
    }
    for await (const { value: id, result: loaded } of orderedPrefetch(
      Object.keys(snapshot.events)
        .sort()
        .filter((id) => snapshot.events[id].header.action.kind === kind),
      (id) => {
        const event = snapshot.events[id];
        return readRecordBytes(
          objects,
          event.body_hash ? event.envelope_hash : null,
          event.body_hash,
        );
      },
    )) {
      const event = snapshot.events[id];
      const { envelope } = loaded;
      if (loaded.body.status === "rejected") throw loaded.body.reason;
      const bytes = loaded.body.value;
      const checked = envelope && bytes ? inspectBody(envelope, bytes) : null;
      yield {
        id,
        kind,
        issuer: event.header.issuer,
        word: String(event.header.action.word),
        body_hash: event.body_hash,
        envelope_hash: event.envelope_hash,
        body:
          checked?.availability === "valid"
            ? kind === "definition.publish"
              ? interpretDefinition<Record<string, unknown>>(checked.body)
              : (checked.body as Record<string, unknown>)
            : null,
        missing: event.body_hash !== null && (!envelope || !bytes),
      };
    }
  }
  for await (const record of records("rafsi.publish")) {
    const word = String(record.word);
    if (!record.body) {
      incompleteRafsi.add(word);
      continue;
    }
    const body = record.body;
    if (typeof word === "string" && typeof body.rafsi === "string") {
      const set = rafsiByWord.get(word) ?? new Set<string>();
      set.add(body.rafsi);
      rafsiByWord.set(word, set);
    }
  }
  for await (const record of records("definition.publish")) {
    if (record.body_hash === null) continue;
    if (record.missing)
      throw new Error("Retained publication bytes are unavailable.");
    if (!record.body) continue;
    const body = record.body as Record<string, any>;
    const entry: SearchEntry = {
      event: record.id,
      word: body.word,
      language: body.language,
      glosses: body.glosses,
      plain_text: plainDefinitionText(body.text),
      classification: body.classification,
      body: record.body_hash,
    };
    entries.push(entry);
    const legacy = body.legacy as Record<string, any> | null;
    const account = legacy?.attribution?.author_account;
    const dates: Record<string, string> = {};
    for (const [label, value] of Object.entries(
      legacy?.attribution?.dates ?? {},
    ))
      if (typeof value === "string") dates[label] = value;
    entries2.push({
      ...entry,
      issuer: record.issuer,
      notes: Array.isArray(body.notes) && body.notes.length > 0,
      rafsi: [...(rafsiByWord.get(String(record.word)) ?? [])]
        .sort()
        .slice(0, PACKAGE_RAFSI_LIMIT),
      rafsi_complete:
        !incompleteRafsi.has(String(record.word)) &&
        (rafsiByWord.get(String(record.word))?.size ?? 0) <=
          PACKAGE_RAFSI_LIMIT,
      attribution: legacy
        ? {
            source: String(legacy.source),
            author:
              typeof legacy.attribution?.author === "string"
                ? legacy.attribution.author
                : null,
            account:
              account &&
              typeof account.origin === "string" &&
              Number.isSafeInteger(account.account)
                ? { origin: account.origin, account: account.account }
                : null,
            dates,
          }
        : null,
    });
  }
  const build = async <T extends SearchEntry>(
    all: T[],
    version: 1 | 2,
  ): Promise<Record<string, MaterializedPackage>> => {
    const packages: Record<string, MaterializedPackage> = {};
    const changedIds = new Set(reuse?.changed.map((record) => record.id));
    const changedWords = new Set(
      reuse?.changed
        .filter((record) => record.kind === "rafsi.publish")
        .map((record) => record.word),
    );
    const changedLanguages = new Set(
      reuse?.previous.entries
        .filter((entry) => changedIds.has(entry.event))
        .map((entry) => entry.language),
    );
    if (reuse && included) {
      const previousIncluded =
        reuse.previous.effectiveDefinitions === undefined
          ? undefined
          : new Set(reuse.previous.effectiveDefinitions ?? []);
      // Lifecycle and dependency changes can change the membership of unchanged publications.
      for (const records of [reuse.previous.entries, entries])
        for (const entry of records)
          if (
            !previousIncluded ||
            previousIncluded.has(entry.event) !== included.has(entry.event)
          )
            changedLanguages.add(entry.language);
    }
    for (const record of prepared ?? [])
      if (
        changedIds.has(record.id) ||
        (record.kind === "definition.publish" && changedWords.has(record.word))
      )
        if (typeof record.body?.language === "string")
          changedLanguages.add(record.body.language);
    for (const language of [
      ...new Set(all.map((entry) => entry.language)),
    ].sort()) {
      const selected = all.filter(
        (entry) =>
          entry.language === language &&
          (!included || included.has(entry.event)),
      );
      const previous = (
        version === 1 ? reuse?.previous.packages : reuse?.previous.packages2
      )?.[language];
      if (previous && !changedLanguages.has(language)) {
        packages[language] = await rebasePackage(
          previous,
          snapshot.snapshot,
          objects,
        );
        continue;
      }
      const parts: SearchPackage["parts"] = [];
      let part: Uint8Array[] = [];
      let partBytes = 2;
      async function save() {
        if (!part.length) return;
        // Each entry is already canonical. Array punctuation preserves those bytes.
        const bytes = new Uint8Array(partBytes);
        bytes[0] = 91;
        let offset = 1;
        for (const [index, entry] of part.entries()) {
          if (index) bytes[offset++] = 44;
          bytes.set(entry, offset);
          offset += entry.length;
        }
        bytes[offset] = 93;
        const hash = contentHash(bytes);
        await objects.put(hash, bytes);
        parts.push({ hash, bytes: bytes.length, count: part.length });
        part = [];
        partBytes = 2;
      }
      for (const entry of selected) {
        const encoded = canonical(entry);
        const entryBytes = encoded.length;
        if (
          part.length === 2000 ||
          partBytes + entryBytes + (part.length ? 1 : 0) > 4194304
        )
          await save();
        partBytes += entryBytes + (part.length ? 1 : 0);
        part.push(encoded);
      }
      await save();
      const manifest: SearchPackage = {
        version,
        language,
        snapshot: snapshot.snapshot,
        parts,
      };
      const bytes = canonical(manifest);
      const hash = contentHash(bytes);
      await objects.put(hash, bytes);
      packages[language] = { manifest, hash, bytes: bytes.length };
    }
    return packages;
  };
  return preparePackageSearch(
    {
      entries,
      ...(effectiveDefinitions !== undefined ? { effectiveDefinitions } : {}),
      packages: await build(entries, 1),
      packages2: await build(entries2, 2),
    },
    searchPreparation,
  );
}

async function rebasePackage(
  previous: MaterializedPackage,
  snapshot: string,
  objects: ObjectStore,
): Promise<MaterializedPackage> {
  const manifest = { ...previous.manifest, snapshot };
  const bytes = canonical(manifest);
  const hash = contentHash(bytes);
  await objects.put(hash, bytes);
  return { manifest, hash, bytes: bytes.length };
}

export async function rebasePackages(
  previous: MaterializedPackages,
  snapshot: string,
  objects: ObjectStore,
): Promise<MaterializedPackages> {
  const packages: Record<string, MaterializedPackage> = {};
  const packages2: Record<string, MaterializedPackage> = {};
  const jobs = [
    { previous: previous.packages, result: packages },
    { previous: previous.packages2, result: packages2 },
  ].flatMap(({ previous, result }) =>
    Object.keys(previous)
      .sort()
      .map((language) => ({
        language,
        previous: previous[language],
        result,
      })),
  );
  for await (const { value: job, result } of orderedPrefetch(
    jobs,
    (job) => rebasePackage(job.previous, snapshot, objects),
    8,
  ))
    job.result[job.language] = result;
  return preparePackageSearch({
    ...previous,
    packages,
    packages2,
  });
}
