import type { AssistanceService } from "../assistance.ts";
import type { EmbeddingUsage } from "../embedding.ts";
import { AssistanceError, type EmbeddingRoute } from "../inference.ts";
import { qwenRequestRoute } from "./profile.ts";
import type { SemanticSource } from "./source.ts";
import type { EmbeddingProfile } from "./types.ts";
import { SemanticError } from "./types.ts";
import type { IndexBatch, VectorStore } from "./vector-store.ts";

export type IndexEmbedder = Pick<AssistanceService, "embed"> &
  Partial<Pick<AssistanceService, "embeddingOperationPending">>;

export interface IndexConcurrencyChange {
  concurrency: number;
  reason: "embedding_rate_limited" | "embedding_timeout" | "success" | "resume";
}

export interface IndexBackoff {
  /** Zero waits for a saved profile cooldown. Positive values name retry waves. */
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
      operator?: boolean;
      route?: EmbeddingRoute;
      batchSize?: number;
      batchBytes?: number;
      adaptive?: boolean;
      onConcurrencyChange?: (event: IndexConcurrencyChange) => void;
      /** The background host schedules its own durable retries. The CLI keeps the default. */
      automaticRetries?: boolean;
      background?: boolean;
      onFailure?: (failure: unknown, batch: IndexBatch) => void;
      maxBatches?: number;
      signal?: AbortSignal;
      /** Called after all workers settle and before each bounded retry wait. */
      onBackoff?: (event: IndexBackoff) => void;
    } = {},
  ) {
    const concurrency = options.concurrency ?? 2;
    const batchSize = options.batchSize ?? 8;
    const batchBytes = options.batchBytes ?? 32768;
    const maximum = options.maxBatches ?? Number.MAX_SAFE_INTEGER;
    if (
      !Number.isInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > (options.operator ? 32 : 4) ||
      !Number.isInteger(batchSize) ||
      batchSize < 1 ||
      batchSize > (options.operator ? 128 : 8) ||
      !Number.isInteger(batchBytes) ||
      batchBytes < 1 ||
      batchBytes > (options.operator ? 524288 : 32768) ||
      (options.adaptive === true && !options.operator) ||
      !Number.isSafeInteger(maximum) ||
      maximum < 1
    )
      throw new SemanticError(
        400,
        "semantic_limit",
        "The indexing worker or batch limits are invalid.",
      );
    if (this.running.has(id))
      throw new SemanticError(
        409,
        "semantic_running",
        "This generation already has a running index job.",
      );
    this.running.add(id);
    let release: (() => void) | undefined;
    try {
      // Keep a live pass distinct from an abandoned background job during cleanup.
      release = await this.store.retainGeneration(id);
      const identity = (await this.store.generation(id)).profile;
      if (await this.store.compatibility(identity))
        throw new SemanticError(
          409,
          "semantic_profile_suspended",
          "The embedding profile is suspended. Create a fresh profile after repairing the provider.",
        );
      if ((await this.store.generation(id)).state === "completed")
        return {
          generation: await this.store.generation(id, options.background),
          coverage: await this.store.coverage(id),
        };
      const profile = await this.store.profile(id);
      // This adapter computes one exact application profile. A recipe or route change needs a new adapter.
      const route = qwenRequestRoute(profile, options.route);
      if (!route)
        throw new SemanticError(
          409,
          "semantic_profile",
          "The indexing adapter does not match the complete profile.",
        );
      const adaptiveOperator = options.operator && options.adaptive;
      let activeConcurrency = concurrency;
      let successes = 0;
      let timeoutWaves = 0;
      const changeConcurrency = (
        next: number,
        reason: IndexConcurrencyChange["reason"],
      ) => {
        if (next === activeConcurrency) return;
        activeConcurrency = next;
        options.onConcurrencyChange?.({ concurrency: next, reason });
      };
      if (
        adaptiveOperator &&
        ((await this.store.hasProviderPressure(id)) ||
          ((await this.store.retryAfter(identity)) ?? 0) > this.clock.now())
      )
        changeConcurrency(1, "resume");
      let claims = 0;
      let waited = 0;
      const waitForCooldown = async (attempt: number, batches: number) => {
        while (!options.signal?.aborted) {
          const until = await this.store.retryAfter(identity);
          if (options.signal?.aborted) return false;
          const remaining = Math.max(0, (until ?? 0) - this.clock.now());
          if (!remaining) return true;
          if (
            !adaptiveOperator &&
            (remaining > 60000 || waited + remaining > 120000)
          )
            return false;
          const delayMs = Math.min(60000, remaining);
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
          generation: await this.store.generation(id, options.background),
          coverage: await this.store.coverage(id),
        };
      }
      await this.store.start(id);
      for (let round = 0; ; ) {
        let halted = false;
        let stopCode: string | undefined;
        const retries: string[] = [];
        let exhausted = false;
        let completed = 0;
        let timedOut = false;
        let reduced = false;
        const worker = async () => {
          if (claims < maximum && !halted && !options.signal?.aborted) {
            // A different generation can receive a rate limit while this job runs.
            const cooldown = await this.store.retryAfter(identity);
            if ((cooldown ?? 0) > this.clock.now()) {
              halted = true;
              await this.store.pause(id, stopCode ?? "embedding_rate_limited");
              return;
            }
            if (claims >= maximum || halted || options.signal?.aborted) return;
            claims++;
            const batch = await this.store.claim(
              id,
              options.background
                ? {
                    now: this.clock.now(),
                    pending: (operation) =>
                      this.assistance.embeddingOperationPending?.(operation) ??
                      false,
                  }
                : undefined,
              { batchSize, batchBytes },
            );
            if (!batch) {
              exhausted = true;
              claims--;
              const generation = await this.store.generation(id);
              if (
                generation.state === "paused" &&
                generation.error !== "embedding_rate_limited"
              ) {
                halted = true;
                stopCode = generation.error ?? "index_paused";
              }
              return;
            }
            if (options.signal?.aborted) {
              await this.store.fail(batch.id, "index_paused");
              await this.store.pause(id, "index_paused");
              return;
            }
            let usage: EmbeddingUsage | undefined;
            let operation: string | null = null;
            try {
              const inputs = await this.store.inputs(batch.id);
              if (options.signal?.aborted) {
                await this.store.fail(batch.id, "index_paused");
                await this.store.pause(id, "index_paused");
                return;
              }
              // Do not detach provider settlement when an operator pauses or exits.
              const result = await this.assistance.embed(
                inputs,
                { kind: "index", route },
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
              completed++;
              if (adaptiveOperator && !halted && ++successes >= 8) {
                successes = 0;
                round = 0;
                changeConcurrency(
                  Math.min(concurrency, activeConcurrency + 1),
                  "success",
                );
              }
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
              if (code === "embedding_timeout") timedOut = true;
              if (
                adaptiveOperator &&
                !reduced &&
                (rateLimited || code === "embedding_timeout")
              ) {
                reduced = true;
                successes = 0;
                changeConcurrency(
                  Math.max(1, Math.floor(activeConcurrency / 2)),
                  code as "embedding_rate_limited" | "embedding_timeout",
                );
              }
              if (rateLimited) retries.push(batch.id);
              else if (
                options.operator &&
                options.adaptive &&
                code === "embedding_timeout"
              )
                stopCode ??= code;
              else stopCode = code;
              if (
                rateLimited ||
                (!code.startsWith("billing_") &&
                  typeof hint === "number" &&
                  Number.isFinite(hint) &&
                  hint >= 0)
              ) {
                const delayMs = Math.max(
                  rateLimited
                    ? adaptiveOperator
                      ? Math.min(60000, 1000 * 2 ** Math.min(round, 6))
                      : 1000 * 2 ** round
                    : 0,
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
              if (
                options.operator &&
                operation === null &&
                [
                  "billing_operator_limit",
                  "billing_history_limit",
                  "embedding_busy",
                ].includes(code)
              )
                await this.store.retry(batch.id);
              return;
            }
          }
        };
        const pending = new Set<Promise<void>>();
        let workerFailure: unknown;
        let workerRejected = false;
        while (true) {
          while (
            !halted &&
            !exhausted &&
            !options.signal?.aborted &&
            claims < maximum &&
            pending.size < activeConcurrency
          ) {
            const task = worker()
              .catch((failure) => {
                workerRejected = true;
                workerFailure = failure;
                halted = true;
              })
              .finally(() => pending.delete(task));
            pending.add(task);
          }
          if (!pending.size) break;
          await Promise.race(pending);
        }
        if (workerRejected) {
          if (
            workerFailure instanceof SemanticError &&
            workerFailure.code === "semantic_limit"
          )
            await this.store.pause(id, workerFailure.code);
          throw workerFailure;
        }
        if (completed) timeoutWaves = 0;
        else if (timedOut) timeoutWaves++;
        if (adaptiveOperator && options.automaticRetries !== false)
          // Definite refusals remain selected even when cancellation or a local limit stops this run.
          for (const retry of retries) await this.store.retry(retry);
        if (adaptiveOperator && timeoutWaves >= 3) break;
        const continueAfterTimeout =
          adaptiveOperator && stopCode === "embedding_timeout";
        const retryRateLimited =
          options.automaticRetries !== false &&
          retries.length > 0 &&
          (adaptiveOperator || round < 3);
        if (
          (!continueAfterTimeout && (!retryRateLimited || stopCode)) ||
          claims >= maximum ||
          options.signal?.aborted
        )
          break;
        const generation = await this.store.generation(id);
        if (
          (continueAfterTimeout
            ? generation.state !== "paused" ||
              generation.error !== "embedding_timeout"
            : generation.error !== "embedding_rate_limited") ||
          (await this.store.compatibility(identity))
        )
          break;
        if (
          !(await waitForCooldown(
            retryRateLimited ? round + 1 : 0,
            retryRateLimited ? retries.length : 0,
          ))
        )
          break;
        if (retryRateLimited) {
          // Select only 429 batches, including those that overlap a timeout.
          // Timeout batches keep their ownership until an explicit retry.
          if (!adaptiveOperator)
            for (const retry of retries) {
              if (options.signal?.aborted) break;
              await this.store.retry(retry);
            }
          round++;
        }
        if (options.signal?.aborted) break;
        await this.store.start(id);
      }
      await this.store.finish(id);
      const generation = await this.store.generation(id);
      if (generation.state === "running") await this.store.pause(id);
      return {
        generation: await this.store.generation(id, options.background),
        coverage: await this.store.coverage(id),
      };
    } finally {
      release?.();
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
