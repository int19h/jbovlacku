import {
  canonicalize,
  contentHash,
  inspectBody,
  utf8,
  type Header,
} from "../../core/src/index.ts";
import type { ObjectStore, Snapshot } from "./storage.ts";
export interface SearchEntry {
  event: string;
  word: { language: "jbo"; spelling: string };
  language: string;
  glosses: { text: string }[];
  plain_text: string;
  classification: unknown;
  body: string;
}
export interface SearchPackage {
  version: 1;
  language: string;
  snapshot: string;
  parts: { hash: string; bytes: number; count: number }[];
}
export interface MaterializedPackages {
  entries: SearchEntry[];
  packages: Record<
    string,
    { manifest: SearchPackage; hash: string; bytes: number }
  >;
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
    entries.push({
      event: id,
      word: body.word,
      language: body.language,
      glosses: body.glosses,
      plain_text: plainDefinitionText(body.text),
      classification: body.classification,
      body: event.body_hash,
    });
  }
  const packages: MaterializedPackages["packages"] = {};
  for (const language of [
    ...new Set(entries.map((entry) => entry.language)),
  ].sort()) {
    const selected = entries.filter((entry) => entry.language === language);
    const parts: SearchPackage["parts"] = [];
    let part: SearchEntry[] = [];
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
      version: 1,
      language,
      snapshot: snapshot.snapshot,
      parts,
    };
    const bytes = canonical(manifest);
    const hash = contentHash(bytes);
    await objects.put(hash, bytes);
    packages[language] = { manifest, hash, bytes: bytes.length };
  }
  return { entries, packages };
}
