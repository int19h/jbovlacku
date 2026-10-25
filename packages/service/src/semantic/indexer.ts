import type { AssistanceService } from "../assistance.ts";
import type { EmbeddingUsage } from "../embedding.ts";
import { createQwenProfile, profileId } from "./profile.ts";
import type { SemanticSource } from "./source.ts";
import type { EmbeddingProfile } from "./types.ts";
import { SemanticError } from "./types.ts";
import type { VectorStore } from "./vector-store.ts";

export type IndexEmbedder = Pick<AssistanceService, "embed">;

/** Durable intent precedes every paid dispatch. Resume never selects an old sent batch. */
export class SemanticIndexer {
  private running = new Set<string>();
  constructor(
    readonly store: VectorStore,
    private assistance: IndexEmbedder,
  ) {}

  async prepare(
    id: string,
    source: SemanticSource,
    maxPages = Number.MAX_SAFE_INTEGER,
  ) {
    if (!Number.isSafeInteger(maxPages) || maxPages < 1)
      throw new SemanticError(
        400,
        "semantic_limit",
        "The preparation page limit is invalid.",
      );
    let generation = await this.store.generation(id);
    if (
      generation.state !== "paused" ||
      ["snapshot", "view", "profile", "eligible"].some(
        (key) =>
          generation[key as keyof typeof source.context] !==
          source.context[key as keyof typeof source.context],
      )
    )
      throw new SemanticError(
        409,
        "semantic_context",
        "The source differs from the saved generation.",
      );
    for (let page = 0; page < maxPages && !generation.source_done; page++) {
      const result = await source.page(generation.cursor, 128);
      await this.store.stage(id, generation.cursor, result);
      generation = await this.store.generation(id);
    }
    return generation;
  }

  async run(
    id: string,
    options: {
      concurrency?: number;
      maxBatches?: number;
      signal?: AbortSignal;
    } = {},
  ) {
    const concurrency = options.concurrency ?? 2;
    const maximum = options.maxBatches ?? Number.MAX_SAFE_INTEGER;
    if (
      !Number.isInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > 4 ||
      !Number.isSafeInteger(maximum) ||
      maximum < 1
    )
      throw new SemanticError(
        400,
        "semantic_limit",
        "Use one through four workers and a positive batch limit.",
      );
    if (this.running.has(id))
      throw new SemanticError(
        409,
        "semantic_running",
        "This generation already has a running index job.",
      );
    this.running.add(id);
    try {
      const identity = (await this.store.generation(id)).profile;
      if (await this.store.compatibility(identity))
        throw new SemanticError(
          409,
          "semantic_profile_suspended",
          "The embedding profile is suspended. Create a fresh profile after repairing the provider.",
        );
      if ((await this.store.generation(id)).state === "completed")
        return {
          generation: await this.store.generation(id),
          coverage: await this.store.coverage(id),
        };
      const profile = await this.store.profile(id);
      // This adapter computes one exact application profile. A recipe or route change needs a new adapter.
      if (profileId(profile) !== profileId(createQwenProfile(profile.epoch)))
        throw new SemanticError(
          409,
          "semantic_profile",
          "The indexing adapter does not match the complete profile.",
        );
      await this.store.start(id);
      let claims = 0;
      const worker = async () => {
        while (claims < maximum && !options.signal?.aborted) {
          claims++;
          const batch = await this.store.claim(id);
          if (!batch) break;
          let usage: EmbeddingUsage | undefined;
          try {
            // Do not detach provider settlement when an operator pauses or exits.
            const result = await this.assistance.embed(
              await this.store.inputs(batch.id),
              { kind: "index" },
              undefined,
              (operation) => this.store.sent(batch.id, operation),
            );
            usage = result.usage;
            await this.store.complete(
              batch.id,
              result.operation,
              result.vectors,
              result.usage,
            );
          } catch (failure) {
            const code =
              failure instanceof Error && "code" in failure
                ? String(failure.code)
                : "index_failed";
            if (
              ["embedding_model_mismatch", "semantic_vector_conflict"].includes(
                code,
              )
            )
              await this.store.suspend(identity, code);
            await this.store.fail(batch.id, code, usage);
            await this.store.pause(id, code);
            break;
          }
        }
      };
      const results = await Promise.allSettled(
        Array.from({ length: concurrency }, worker),
      );
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      await this.store.finish(id);
      const generation = await this.store.generation(id);
      if (generation.state === "running") await this.store.pause(id);
      return {
        generation: await this.store.generation(id),
        coverage: await this.store.coverage(id),
      };
    } finally {
      this.running.delete(id);
    }
  }
}

export async function createIndexGeneration(
  store: VectorStore,
  source: SemanticSource,
  profile: EmbeddingProfile,
) {
  return store.create(source.context, profile);
}
