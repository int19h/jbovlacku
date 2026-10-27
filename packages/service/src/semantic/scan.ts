import { SemanticError } from "./types.ts";
import { vectorFromBytes } from "./vector.ts";
import type { ExpectedAssociation, VectorAssociation } from "./vector-store.ts";

export interface SemanticHit {
  event: string;
  word: string;
  distance: number;
  position: number;
}
export interface ScanRequest {
  generation: string;
  profile: string;
  snapshot: string;
  view: string;
  language: string;
  vector: Float32Array;
  limit: number;
  eligible: string[];
  /** The host identity is used only for concurrent scan admission. */
  network?: string;
  /** Public search supplies exact bindings from its requested evaluation. */
  bindings?: ExpectedAssociation[];
  /** Host callers can request distinct words after excluding comparison holdouts. */
  distinctWords?: boolean;
}
export interface VectorScanner {
  scan(request: ScanRequest, signal?: AbortSignal): Promise<SemanticHit[]>;
}
export type VectorPageReader = (
  after: string | null,
) => Promise<{ rows: VectorAssociation[]; next: string | null }>;
const compare = (a: SemanticHit, b: SemanticHit) =>
  a.distance - b.distance ||
  (a.event < b.event ? -1 : a.event === b.event ? 0 : 1);

/** Retain at most limit results and one bounded page. No definition bodies are read. */
export async function scanPages(
  request: ScanRequest,
  page: VectorPageReader,
  canceled: () => boolean = () => false,
): Promise<SemanticHit[]> {
  if (
    !Number.isInteger(request.limit) ||
    request.limit < 1 ||
    request.limit > 100
  )
    throw new SemanticError(
      400,
      "limit",
      "The search limit must be from 1 through 100.",
    );
  const allowed = new Set(request.eligible);
  const bindings =
    request.bindings &&
    new Map(request.bindings.map((row) => [row.event, row]));
  const hits: SemanticHit[] = [];
  const query = request.vector;
  let qq = 0;
  for (const n of query) qq += n * n;
  let after: string | null = null;
  do {
    if (canceled())
      throw new SemanticError(
        499,
        "semantic_canceled",
        "The search was canceled.",
      );
    const result = await page(after);
    for (const row of result.rows) {
      if (
        !allowed.has(row.event) ||
        row.language !== request.language ||
        !row.vector ||
        row.error
      )
        continue;
      const expected = bindings?.get(row.event);
      if (
        bindings &&
        (!expected ||
          expected.envelope !== row.envelope ||
          expected.body !== row.body ||
          expected.word !== row.word ||
          expected.language !== row.language ||
          expected.extraction_version !== row.extraction_version)
      )
        continue;
      const vector = vectorFromBytes(row.vector, query.length);
      let dot = 0;
      let vv = 0;
      for (let i = 0; i < query.length; i++) {
        dot += query[i] * vector[i];
        vv += vector[i] * vector[i];
      }
      const hit = {
        event: row.event,
        word: row.word,
        distance: Math.max(0, Math.min(2, 1 - dot / Math.sqrt(qq * vv))),
        position: 0,
      };
      if (!Number.isFinite(hit.distance))
        throw new SemanticError(
          503,
          "semantic_vector",
          "The query vector is invalid.",
        );
      if (request.distinctWords) {
        const old = hits.findIndex((candidate) => candidate.word === hit.word);
        if (old !== -1) {
          if (compare(hits[old], hit) <= 0) continue;
          hits.splice(old, 1);
        }
      }
      if (hits.length === request.limit && compare(hit, hits.at(-1)!) >= 0)
        continue;
      let low = 0,
        high = hits.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (compare(hits[middle], hit) <= 0) low = middle + 1;
        else high = middle;
      }
      hits.splice(low, 0, hit);
      if (hits.length > request.limit) hits.pop();
    }
    if (result.next !== null && after !== null && result.next <= after)
      throw new SemanticError(
        503,
        "semantic_page",
        "The vector page did not advance.",
      );
    after = result.next;
  } while (after !== null);
  if (canceled())
    throw new SemanticError(
      499,
      "semantic_canceled",
      "The search was canceled.",
    );
  return hits.map((hit, i) => ({ ...hit, position: i + 1 }));
}
