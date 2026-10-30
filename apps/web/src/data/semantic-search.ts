import { api, type RequestOptions } from "./api.ts";
import { eventId, hashId, wordIdValid } from "../model/types.ts";

export interface EmbeddingProfile {
  id: string;
  label: string;
  query_available: boolean;
  indexed: number;
  eligible: number;
  pending: number;
  limitations: string[];
}
export interface SemanticContext {
  snapshot: string;
  view: string;
}
export interface SemanticResult extends SemanticContext {
  profile: string;
  query_hash: string;
  hits: { event: string; word: string; distance: number; position: number }[];
  coverage: {
    indexed: number;
    eligible: number;
    pending: number;
    failed: number;
  };
}
const object = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

export async function embeddingProfiles(
  context: SemanticContext | null,
  language: string,
  options: RequestOptions = {},
): Promise<EmbeddingProfile[]> {
  const result = await api<unknown>(
    `/embedding-profiles?${new URLSearchParams({ ...(context ?? {}), language })}`,
    options,
  );
  if (
    !object(result) ||
    !Array.isArray(result.profiles) ||
    result.profiles.length > 64 ||
    result.profiles.some(
      (profile: unknown) =>
        !object(profile) ||
        !hashId(profile.id) ||
        typeof profile.label !== "string" ||
        !profile.label.trim() ||
        typeof profile.query_available !== "boolean" ||
        ![profile.indexed, profile.eligible, profile.pending].every(count) ||
        !Array.isArray(profile.limitations) ||
        profile.limitations.some((value: unknown) => typeof value !== "string"),
    )
  )
    throw new Error("The server returned invalid meaning search profiles.");
  return result.profiles;
}

/** Query text travels only in the consented POST body. */
export async function semanticSearch(
  query: string,
  language: string,
  context: SemanticContext,
  profile: string,
  options: RequestOptions = {},
): Promise<SemanticResult> {
  const result = await api<unknown>("/search/semantic", {
    ...options,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, language, ...context, profile, limit: 100 }),
  });
  if (
    !object(result) ||
    result.snapshot !== context.snapshot ||
    result.view !== context.view ||
    result.profile !== profile ||
    !hashId(result.query_hash) ||
    !Array.isArray(result.hits) ||
    result.hits.length > 100 ||
    !object(result.coverage) ||
    !["indexed", "eligible", "pending", "failed"].every((key) =>
      count(result.coverage[key]),
    ) ||
    result.hits.some(
      (hit: unknown, index: number) =>
        !object(hit) ||
        !eventId(hit.event) ||
        !wordIdValid(hit.word) ||
        !Number.isFinite(hit.distance) ||
        hit.position !== index + 1 ||
        result.hits
          .slice(0, index)
          .some((prior: { event: string }) => prior.event === hit.event),
    )
  )
    throw new Error("The server returned invalid meaning search results.");
  return result as unknown as SemanticResult;
}
