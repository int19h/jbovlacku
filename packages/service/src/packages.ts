import {
  canonicalize,
  contentHash,
  inspectBody,
  utf8,
  type Header,
} from "../../core/src/index.ts";
import type { ObjectStore, Snapshot } from "./storage.ts";
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
  packages: Record<string, MaterializedPackage>;
  /** Version 2 packages by language. */
  packages2: Record<string, MaterializedPackage>;
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
            return node <= 20
              ? String.fromCodePoint(0x245f + node)
              : `[place ${node}]`;
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
): Promise<MaterializedPackages> {
  const entries: SearchEntry[] = [];
  const entries2: SearchEntryV2[] = [];
  // Rafsi spellings from retained claim bodies, by word ID.
  const rafsiByWord = new Map<string, Set<string>>();
  const incompleteRafsi = new Set<string>();
  for (const id of Object.keys(snapshot.events).sort()) {
    const event = snapshot.events[id];
    if (event.header.action.kind !== "rafsi.publish") continue;
    const word = String(event.header.action.word);
    if (event.body_hash === null) {
      incompleteRafsi.add(word);
      continue;
    }
    const envelope = await objects.get(event.envelope_hash);
    const bytes = await objects.get(event.body_hash);
    if (!envelope || !bytes) {
      incompleteRafsi.add(word);
      continue;
    }
    const availability = inspectBody(envelope, bytes);
    if (availability.availability !== "valid") {
      incompleteRafsi.add(word);
      continue;
    }
    const body = availability.body as { rafsi?: unknown };
    if (typeof word === "string" && typeof body.rafsi === "string") {
      const set = rafsiByWord.get(word) ?? new Set<string>();
      set.add(body.rafsi);
      rafsiByWord.set(word, set);
    }
  }
  for (const id of Object.keys(snapshot.events).sort()) {
    const event = snapshot.events[id];
    if (
      event.header.action.kind !== "definition.publish" ||
      event.body_hash === null
    )
      continue;
    const envelope = await objects.get(event.envelope_hash);
    const bytes = await objects.get(event.body_hash);
    if (!envelope || !bytes)
      throw new Error("Retained publication bytes are unavailable.");
    const availability = inspectBody(envelope, bytes);
    if (availability.availability !== "valid") continue;
    const body = availability.body as Record<string, any>;
    const entry: SearchEntry = {
      event: id,
      word: body.word,
      language: body.language,
      glosses: body.glosses,
      plain_text: plainDefinitionText(body.text),
      classification: body.classification,
      body: event.body_hash,
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
      issuer: event.header.issuer,
      notes: Array.isArray(body.notes) && body.notes.length > 0,
      rafsi: [...(rafsiByWord.get(String(event.header.action.word)) ?? [])]
        .sort()
        .slice(0, PACKAGE_RAFSI_LIMIT),
      rafsi_complete:
        !incompleteRafsi.has(String(event.header.action.word)) &&
        (rafsiByWord.get(String(event.header.action.word))?.size ?? 0) <=
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
    for (const language of [
      ...new Set(all.map((entry) => entry.language)),
    ].sort()) {
      const selected = all.filter((entry) => entry.language === language);
      const parts: SearchPackage["parts"] = [];
      let part: T[] = [];
      let partBytes = 2;
      async function save() {
        if (!part.length) return;
        const bytes = canonical(part);
        const hash = contentHash(bytes);
        await objects.put(hash, bytes);
        parts.push({ hash, bytes: bytes.length, count: part.length });
        part = [];
        partBytes = 2;
      }
      for (const entry of selected) {
        const entryBytes = canonical(entry).length;
        if (
          part.length === 2000 ||
          partBytes + entryBytes + (part.length ? 1 : 0) > 4194304
        )
          await save();
        partBytes += entryBytes + (part.length ? 1 : 0);
        part.push(entry);
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
  return {
    entries,
    packages: await build(entries, 1),
    packages2: await build(entries2, 2),
  };
}
