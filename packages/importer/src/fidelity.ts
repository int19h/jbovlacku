import { rafsiPairId, wordId } from "../../core/src/index.ts";
import type { Carrier, Lexical } from "./index.ts";
import { convertPlaces } from "./places.ts";

/** Display evidence never supplies the numeric account association. */
export function displayUsername(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function originalField(original: Record<string, any>, key: string) {
  if (Array.isArray(original.$source_object)) {
    const index = original.$source_object.findIndex(
      (pair: any[]) => pair[0] === key,
    );
    return {
      value: original.$source_object[index]?.[1],
      pointer: `/$source_object/${index}/1`,
    };
  }
  return { value: original[key], pointer: `/${key}` };
}

export function rafsiClaimKey(body: Record<string, any>): string {
  return JSON.stringify([
    body.legacy.source,
    body.legacy.record.kind,
    body.legacy.record.id,
    body.legacy.locator,
    wordId(body.word),
    body.rafsi,
  ]);
}

/** Each source field retains its own claim and source record. */
export function importedRafsiClaims(definition: Carrier, lexical: Lexical) {
  const original = definition.body.legacy.original;
  const legacy = definition.body.legacy;
  const sql = legacy.extraction.startsWith("lensisku-sql-");
  const claims = [];
  for (const authority of ["official", "experimental"] as const) {
    const field = `${authority}_rafsi` as const;
    const value = lexical[field];
    if (!("known" in value) || !Array.isArray(value.known)) continue;
    for (const rafsi of value.known as string[]) {
      const wordLevel = sql && authority === "official";
      const record = wordLevel
        ? { kind: "word", id: Number(original.valsi.valsiid.$source_number) }
        : legacy.record;
      const locator = wordLevel
        ? `valsi/valsiid=${record.id}/rafsi`
        : `${legacy.locator}/${sql ? "rafsi" : field}`;
      const source = {
        label: wordLevel
          ? "Lensisku word-level official rafsi"
          : `Lensisku definition-level ${authority} rafsi`,
        url: definition.body.sources[0].url ?? null,
        event: null,
        locator,
      };
      const body = {
        word: {
          ...definition.body.word,
          spelling: definition.body.word.spelling
            .normalize("NFD")
            .replaceAll("\u0301", "")
            .normalize("NFC"),
        },
        rafsi,
        rationale: [
          [
            `Imported ${authority} rafsi evidence. This claim carries no implicit endorsement.`,
          ],
        ],
        sources: [source],
        legacy: {
          source: legacy.source,
          snapshot: legacy.snapshot,
          extraction: legacy.extraction,
          record,
          locator,
          original: wordLevel
            ? { valsi: original.valsi }
            : sql
              ? {
                  definitions: {
                    definitionid: original.definitions.definitionid,
                    valsiid: original.definitions.valsiid,
                    rafsi: original.definitions.rafsi,
                  },
                }
              : { [field]: originalField(original, field).value },
          attribution: {
            author: null,
            editor: null,
            author_account: null,
            dates: {},
          },
          conversion: {
            method: "literal",
            tool: "jbovlacku-lensisku-import",
            version: "source-rafsi-v1",
            model: null,
            review: "unreviewed",
            mappings: [],
            warnings: [],
          },
          limitations: [
            `The source marks this rafsi as ${authority}. The importer supplies no endorsement or historical author claim.`,
            "Word-level and definition-level rafsi remain separate source evidence. The active definition gate still applies.",
          ],
        },
      };
      claims.push({
        key: rafsiClaimKey(body),
        authority,
        action: {
          kind: "rafsi.publish",
          word: wordId(body.word),
          assignment: rafsiPairId(wordId(body.word), rafsi),
          origin: "import",
        },
        body,
      });
    }
  }
  return claims;
}

export function emptyFidelity() {
  return {
    places: {
      fully_converted: 0,
      partly_converted: 0,
      untouched: 0,
      unconverted_patterns: {} as Record<string, number>,
    },
    named_definitions: 0,
    official_rafsi_claims: 0,
    experimental_rafsi_claims: 0,
  };
}
export function countFidelity(
  result: ReturnType<typeof emptyFidelity>,
  carrier: Carrier,
) {
  const body = carrier.body;
  if (body.legacy.attribution.author) result.named_definitions++;
  const original = body.legacy.original;
  const source = body.legacy.extraction.startsWith("lensisku-sql-")
    ? original.definitions.definition
    : originalField(original, "definition").value;
  const conversion = convertPlaces(
    typeof source === "string" ? source : null,
    "/definition",
  );
  const converted = body.legacy.conversion.mappings.length > 0;
  result.places[
    converted
      ? Object.keys(conversion.unresolved).length
        ? "partly_converted"
        : "fully_converted"
      : "untouched"
  ]++;
  for (const [pattern, count] of Object.entries(conversion.unresolved))
    result.places.unconverted_patterns[pattern] =
      (result.places.unconverted_patterns[pattern] ?? 0) + count;
}
