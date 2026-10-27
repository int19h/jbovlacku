import type { AssistanceService } from "../assistance.ts";
import type { EmbeddingUsage } from "../embedding.ts";
import { AssistanceError } from "../inference.ts";
import { createQwenProfile, profileId } from "./profile.ts";
import type { SemanticSource } from "./source.ts";
import type { EmbeddingProfile } from "./types.ts";
import { SemanticError } from "./types.ts";
import type { IndexBatch, VectorStore } from "./vector-store.ts";

export type IndexEmbedder = Pick<AssistanceService, "embed"> &
  Partial<Pick<AssistanceService, "embeddingOperationPending">>;

export interface IndexBackoff {
  /** Zero waits for a saved profile cooldown. One through three name retry rounds. */
  attempt: number;
  delayMs: number;
  /** Number of failed batches selected for linked retry after the wait. */
  batches: number;
}
export interface IndexClock {
  now(): number;
  /** Reject when the signal aborts. */
  sleep(delayMs: number, signal?: AbortSignal): Promise<void>;
}
const realClock: IndexClock = {
  now: () => Date.now(),
  sleep: (delayMs, signal) =>
    new Promise((resolve, reject) => {
      signal?.throwIfAborted();
      const aborted = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", aborted);
        reject(signal?.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", aborted);
        resolve();
      }, delayMs);
      signal?.addEventListener("abort", aborted, { once: true });
    }),
};

/** Durable intent precedes every paid dispatch. Resume never selects an old sent batch. */
export class SemanticIndexer {
  private running = new Set<string>();
  constructor(
    readonly store: VectorStore,
    private assistance: IndexEmbedder,
    private clock: IndexClock = realClock,
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
      /** The background host schedules its own durable retries. The CLI keeps the default. */
      automaticRetries?: boolean;
      onFailure?: (failure: unknown, batch: IndexBatch) => void;
      maxBatches?: number;
      signal?: AbortSignal;
      /** Called after all workers settle and before each bounded retry wait. */
      onBackoff?: (event: IndexBackoff) => void;
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
      let claims = 0;
      let waited = 0;
      const waitForCooldown = async (attempt: number, batches: number) => {
        while (!options.signal?.aborted) {
          const until = await this.store.retryAfter(identity);
          if (options.signal?.aborted) return false;
          const delayMs = Math.max(0, (until ?? 0) - this.clock.now());
          if (!delayMs) return true;
          if (delayMs > 60000 || waited + delayMs > 120000) return false;
          options.onBackoff?.({ attempt, delayMs, batches });
          try {
            await this.clock.sleep(delayMs, options.signal);
          } catch (failure) {
            if (options.signal?.aborted) return false;
            throw failure;
          }
          waited += delayMs;
          // Another generation can extend the profile cooldown while this job waits.
        }
        return false;
      };
      if (!(await waitForCooldown(0, 0))) {
        await this.store.pause(
          id,
          options.signal?.aborted ? "index_paused" : "embedding_rate_limited",
        );
        return {
          generation: await this.store.generation(id),
          coverage: await this.store.coverage(id),
        };
      }
      await this.store.start(id);
      for (let round = 0; ; round++) {
        let halted = false;
        let stopCode: string | undefined;
        const retries: string[] = [];
        const worker = async () => {
          while (claims < maximum && !halted && !options.signal?.aborted) {
            // A different generation can receive a rate limit while this job runs.
            const cooldown = await this.store.retryAfter(identity);
            if ((cooldown ?? 0) > this.clock.now()) {
              halted = true;
              await this.store.pause(id, stopCode ?? "embedding_rate_limited");
              break;
            }
            if (claims >= maximum || halted || options.signal?.aborted) break;
            claims++;
            const batch = await this.store.claim(id);
            if (!batch) {
              claims--;
              const generation = await this.store.generation(id);
              if (
                generation.state === "paused" &&
                generation.error !== "embedding_rate_limited"
              ) {
                halted = true;
                stopCode = generation.error ?? "index_paused";
              }
              break;
            }
            if (options.signal?.aborted) {
              await this.store.fail(batch.id, "index_paused");
              await this.store.pause(id, "index_paused");
              break;
            }
            let usage: EmbeddingUsage | undefined;
            let operation: string | null = null;
            try {
              const inputs = await this.store.inputs(batch.id);
              if (options.signal?.aborted) {
                await this.store.fail(batch.id, "index_paused");
                await this.store.pause(id, "index_paused");
                break;
              }
              // Do not detach provider settlement when an operator pauses or exits.
              const result = await this.assistance.embed(
                inputs,
                { kind: "index" },
                undefined,
                async (id) => {
                  await this.store.sent(batch.id, id);
                  operation = id;
                },
              );
              usage = result.usage;
              await this.store.complete(
                batch.id,
                result.operation,
                result.vectors,
                result.usage,
              );
            } catch (failure) {
              halted = true;
              const code =
                failure instanceof Error && "code" in failure
                  ? String(failure.code)
                  : "index_failed";
              if (failure instanceof AssistanceError)
                usage ??= failure.embeddingUsage;
              const hint =
                failure instanceof AssistanceError
                  ? failure.retryAfterMs
                  : undefined;
              const rateLimited = code === "embedding_rate_limited";
              if (rateLimited) retries.push(batch.id);
              else stopCode = code;
              if (
                rateLimited ||
                (!code.startsWith("billing_") &&
                  typeof hint === "number" &&
                  Number.isFinite(hint) &&
                  hint >= 0)
              ) {
                const delayMs = Math.max(
                  rateLimited ? 1000 * 2 ** round : 0,
                  typeof hint === "number" && Number.isFinite(hint) ? hint : 0,
                );
                const now = this.clock.now();
                await this.store.defer(
                  identity,
                  Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(now + delayMs)),
                  now,
                );
              }
              if (
                [
                  "embedding_model_mismatch",
                  "semantic_vector_conflict",
                ].includes(code)
              )
                await this.store.suspend(identity, code);
              await this.store.fail(batch.id, code, usage);
              options.onFailure?.(failure, {
                ...batch,
                operation,
                state: operation ? "ambiguous" : "failed",
                error: code,
              });
              const generation = await this.store.generation(id);
              if (
                generation.state === "paused" &&
                generation.error &&
                generation.error !== "embedding_rate_limited"
              )
                stopCode ??= generation.error;
              await this.store.pause(id, stopCode ?? code);
              break;
            }
          }
        };
        const results = await Promise.allSettled(
          Array.from({ length: concurrency }, worker),
        );
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
        if (
          options.automaticRetries === false ||
          !retries.length ||
          stopCode ||
          round >= 3 ||
          claims >= maximum ||
          options.signal?.aborted
        )
          break;
        const generation = await this.store.generation(id);
        if (
          generation.error !== "embedding_rate_limited" ||
          (await this.store.compatibility(identity))
        )
          break;
        if (!(await waitForCooldown(round + 1, retries.length))) break;
        for (const retry of retries) {
          if (options.signal?.aborted) break;
          await this.store.retry(retry);
        }
        if (options.signal?.aborted) break;
        await this.store.start(id);
      }
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
