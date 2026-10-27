import type { EmbeddingUsage } from "../embedding.ts";
import type { EmbeddingProfile } from "./types.ts";
import type { DocumentPage, IndexContext, IndexDocument } from "./source.ts";

export const MAX_PROFILE_COOLDOWN_MS = 60 * 60 * 1000;

export interface IndexGeneration extends IndexContext {
  id: string;
  state: "paused" | "running" | "completed" | "retired";
  cursor: string | null;
  source_done: boolean;
  error: string | null;
}
export interface IndexBatch {
  id: string;
  generation: string;
  state: "prepared" | "sent" | "completed" | "failed" | "ambiguous";
  operation: string | null;
  previous: string | null;
  inputs: string[];
  error: string | null;
  usage: EmbeddingUsage | null;
}
export interface IndexCoverage {
  eligible: number;
  indexed: number;
  pending: number;
  failed: number;
}
export interface IndexSummary {
  batches: number;
  dispatch_intents: number;
  completed_batches: number;
  completed_inputs: number;
  failed_batches: number;
  ambiguous_batches: number;
  known_input_tokens: number;
  unknown_token_batches: number;
  reported_cost_usd: number;
  unknown_cost_batches: number;
}
export interface VectorAssociation extends Omit<IndexDocument, "input"> {
  vector: Uint8Array | null;
}
export interface VectorStore {
  published(view: string): Promise<IndexGeneration[]>;
  references(id: string): Promise<{ input: Uint8Array; vector: Uint8Array }[]>;
  create(
    context: IndexContext,
    profile: EmbeddingProfile,
  ): Promise<IndexGeneration>;
  generation(id: string): Promise<IndexGeneration>;
  profile(id: string): Promise<EmbeddingProfile>;
  stage(id: string, after: string | null, page: DocumentPage): Promise<void>;
  coverage(id: string, language?: string): Promise<IndexCoverage>;
  summary(id: string): Promise<IndexSummary>;
  compatibility(profile: string): Promise<string | null>;
  suspend(profile: string, reason: string): Promise<void>;
  defer(profile: string, until: number, now?: number): Promise<void>;
  clearCooldown(profile: string): Promise<void>;
  retryAfter(profile: string): Promise<number | null>;
  page(
    id: string,
    after?: string | null,
    limit?: number,
    language?: string,
  ): Promise<{ rows: VectorAssociation[]; next: string | null }>;
  start(id: string): Promise<void>;
  pause(id: string, error?: string): Promise<void>;
  recover(id: string): Promise<void>;
  claim(id: string): Promise<IndexBatch | null>;
  inputs(batch: string): Promise<Uint8Array[]>;
  sent(batch: string, operation: string): Promise<void>;
  complete(
    batch: string,
    operation: string,
    vectors: Float32Array[],
    usage: EmbeddingUsage,
  ): Promise<void>;
  fail(batch: string, error: string, usage?: EmbeddingUsage): Promise<void>;
  batches(
    id: string,
    after?: string | null,
    limit?: number,
  ): Promise<IndexBatch[]>;
  retry(batch: string): Promise<void>;
  finish(id: string): Promise<void>;
  current(profile: string, view: string): Promise<string | null>;
  publish(id: string, expected: string | null): Promise<boolean>;
  unpublish(profile: string, view: string, expected: string): Promise<boolean>;
  rollback(profile: string, view: string, expected: string): Promise<string>;
  retire(id: string): Promise<void>;
}
