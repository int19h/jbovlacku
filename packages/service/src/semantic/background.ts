import { SemanticIndexer, type IndexEmbedder } from "./indexer.ts";
import type { SemanticSource } from "./source.ts";
import type { EmbeddingProfile } from "./types.ts";
import { MAX_PROFILE_COOLDOWN_MS } from "./vector-store.ts";
import type {
  BackgroundRecovery,
  IndexGeneration,
  IndexBatch,
  VectorStore,
} from "./vector-store.ts";

const LONG_COOLDOWN = 60 * 60 * 1000;

/** One durable job per host. Only this host retries its background attempts. */
export class BackgroundSemanticIndexer {
  private stop = new AbortController();
  private work?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private initialized?: string;
  constructor(
    private options: {
      store: VectorStore;
      profile: string;
      view: string;
      assistance: IndexEmbedder;
      source(
        profile: EmbeddingProfile,
        snapshot?: string,
      ): Promise<SemanticSource>;
      probe(
        generation: IndexGeneration,
        profile: EmbeddingProfile,
      ): Promise<void>;
      needed?(): Promise<boolean>;
      now?(): number;
      report(error: unknown): void;
      status?(message: string): void;
    },
  ) {
    const assistance = options.assistance;
    options.store.registerOperationGuard(
      (operation) => assistance.embeddingOperationPending?.(operation) ?? false,
    );
  }

  /** Tests call a bounded cycle directly. The host schedules the same cycle. */
  cycle(): Promise<void> {
    return (this.work ??= this.run().finally(() => {
      this.work = undefined;
    }));
  }
  private async run() {
    const { store, profile: identity, view } = this.options;
    if (this.stop.signal.aborted || (await store.compatibility(identity)))
      return;
    const current = (await store.published(view)).find(
      (g) => g.profile === identity,
    );
    if (!current) return;
    const wait = await store.backgroundWait(identity, view);
    if (wait && Math.max(wait.next_attempt, wait.not_before) > this.now())
      return;
    const profile = await store.profile(current.id);
    let job = await store.backgroundGeneration(identity, view);
    // An unfinished operator job can contain failed or ambiguous sends. Do not adopt or replay it.
    if (!job && current.state !== "completed") return;
    await store.pruneBackgroundGenerations(identity, view);
    if (
      job?.background_recovery &&
      ["semantic_capacity", "snapshot_expired"].includes(
        job.background_recovery.reason,
      ) &&
      job.background_recovery.next_attempt > this.now()
    )
      return;
    if (job && job.state !== "completed") {
      if (this.initialized !== job.id) {
        this.initialized = job.id;
        await store.recoverBackground(job.id);
        job = await store.generation(job.id, true);
      }
      const recovery = job.background_recovery;
      if (
        Math.max(
          recovery?.next_attempt ?? 0,
          recovery?.not_before ?? 0,
          (await store.retryAfter(identity)) ?? 0,
        ) > this.now()
      )
        return;
      const retry = await store.retryableBatch(job.id);
      const operation = recovery?.operation ?? retry?.operation;
      if (
        operation &&
        this.options.assistance.embeddingOperationPending?.(operation)
      )
        return;
      if (recovery?.exhausted) {
        await store.setBackgroundRecovery(job.id, {
          ...recovery,
          sent_attempts: 0,
          exhausted: false,
        });
        job = await store.generation(job.id, true);
      }
      if (retry) await store.retry(retry.id);
    }
    const schedule =
      job?.state === "completed"
        ? await store.backgroundSchedule(
            job.id,
            this.now(),
            (operation) =>
              this.options.assistance.embeddingOperationPending?.(operation) ??
              false,
          )
        : null;
    const dueInputs = schedule !== null && schedule <= this.now();
    const needed =
      !job || job.state === "completed"
        ? await this.options.needed?.()
        : undefined;
    if (!dueInputs && needed === false) return;
    try {
      let source =
        job?.source_done && job.state !== "completed"
          ? undefined
          : await this.options.source(
              profile,
              job && job.state !== "completed" ? job.snapshot : undefined,
            );
      if (this.stop.signal.aborted) return;
      if (!job || job.state === "completed") {
        // Changed extraction can require fresh associations for the same snapshot.
        if (source!.context.snapshot === (job ?? current).snapshot && !needed) {
          if (!job || !dueInputs) return;
          await store.resumeBackground(job.id);
          job = await store.generation(job.id, true);
        } else {
          await store.pruneBackgroundGenerations(identity, view);
          job = await store.create(source!.context, profile);
          await store.setBackgroundGeneration(job.id);
          await store.setBackgroundWait(identity, view, null);
          this.initialized = job.id;
        }
      }
      const indexer = new SemanticIndexer(store, this.options.assistance);
      // Bounded source pages yield through storage and do not hold the directory lock again.
      while (!job.source_done && !this.stop.signal.aborted) {
        job = await indexer.prepare(job.id, source!, 1);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      if (this.stop.signal.aborted) return;
      const published = await store.current(identity, view);
      if (published !== job.id && !(await store.publish(job.id, published)))
        return;
      if (((await store.retryAfter(identity)) ?? 0) > this.now()) {
        await store.pause(job.id, "embedding_rate_limited");
        await this.defer(await store.generation(job.id, true), undefined);
        return;
      }
      const coverage = await store.coverage(job.id);
      if (
        (coverage.pending || coverage.failed) &&
        (await store.references(current.id)).length
      )
        await this.options.probe(current, profile);
      if (this.stop.signal.aborted) return;
      // Background indexing uses at most one of the shared provider slots.
      let failure: unknown;
      let attempt: IndexBatch | undefined;
      const result = await indexer.run(job.id, {
        concurrency: 1,
        signal: this.stop.signal,
        automaticRetries: false,
        background: true,
        onFailure: (error, batch) => {
          failure = error;
          attempt = batch;
        },
      });
      if (result.generation.state === "completed") {
        if (!result.generation.background_inputs)
          await store.setBackgroundRecovery(job.id, null);
      } else if (!this.stop.signal.aborted) {
        await this.defer(result.generation, failure, attempt);
      }
      await store.pruneBackgroundGenerations(identity, view);
    } catch (failure) {
      if (!job) {
        await this.defer(current, failure, undefined, true);
        return;
      }
      if (
        this.code(failure) === "snapshot_expired" &&
        !job.source_done &&
        (await store.current(identity, view)) !== job.id &&
        (await store.summary(job.id)).dispatch_intents === 0
      ) {
        let latest: SemanticSource | undefined;
        try {
          latest = await this.options.source(profile);
        } catch {
          /* Preserve the original refusal when the latest source is unavailable. */
        }
        if (latest && latest.context.snapshot !== job.snapshot) {
          const old = job.id;
          try {
            job = await store.create(latest.context, profile);
          } catch (replacementFailure) {
            await store.pause(old, this.code(replacementFailure));
            if (!this.stop.signal.aborted)
              await this.defer(
                await store.generation(old, true),
                replacementFailure,
              );
            return;
          }
          await store.setBackgroundGeneration(job.id);
          this.initialized = job.id;
          await store.retire(old);
          this.options.status?.(
            `Background semantic job ${old} replaced by ${job.id} after source expiry.`,
          );
          return;
        }
      }
      await store.pause(job.id, this.code(failure));
      if (!this.stop.signal.aborted)
        await this.defer(await store.generation(job.id, true), failure);
    }
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private code(failure: unknown) {
    return failure instanceof Error && "code" in failure
      ? String(failure.code)
      : "background_index_failed";
  }
  private async defer(
    job: IndexGeneration,
    failure: unknown,
    batch?: IndexBatch,
    beforeJob = false,
  ) {
    const { store } = this.options;
    const held = batch ? await store.backgroundInputRecovery(batch) : null;
    const saved = beforeJob
      ? await store.backgroundWait(job.profile, job.view)
      : job.background_recovery;
    const previous =
      held ?? (batch && saved?.batch !== batch.previous ? undefined : saved);
    const operation =
      failure instanceof Error &&
      "operation" in failure &&
      typeof failure.operation === "string"
        ? failure.operation
        : batch?.operation;
    const reason = beforeJob
      ? this.code(failure)
      : (job.error ?? this.code(failure));
    // Only explicit local refusals prove that an untracked probe did not dispatch.
    const unsent =
      /^(billing_|embedding_busy$|embedding_disabled$|embedding_configuration$|embedding_input$|embedding_network$|feature_disabled$|inference_disabled$|index_paused$|semantic_capacity$|semantic_context$|semantic_progress$|semantic_profile_suspended$|semantic_profile$|snapshot_expired$)/.test(
        reason,
      );
    const sent = batch
      ? batch.state === "ambiguous"
      : !!operation || (failure !== undefined && !unsent);
    const permanent = [
      "billing_request_too_large",
      "semantic_capacity",
      "snapshot_expired",
      "feature_disabled",
      "embedding_disabled",
      "inference_disabled",
      "embedding_configuration",
      "embedding_input",
      "embedding_network",
      "semantic_context",
      "semantic_progress",
      "semantic_profile",
    ].includes(reason);
    const hint =
      failure instanceof Error && "retryAfterMs" in failure
        ? Number(failure.retryAfterMs)
        : 0;
    const now = this.now();
    const notBefore = Math.max(
      (await store.retryAfter(job.profile)) ?? 0,
      Number.isFinite(hint) && hint > 0
        ? now +
            (reason.startsWith("billing_")
              ? hint
              : Math.min(hint, MAX_PROFILE_COOLDOWN_MS))
        : 0,
    );
    const priorAttempts =
      held?.exhausted && held.next_attempt <= now
        ? 0
        : (previous?.sent_attempts ?? 0);
    const sentAttempts = priorAttempts + (sent ? 1 : 0);
    const refusals = sent ? 0 : Math.min(16, (previous?.refusals ?? 0) + 1);
    const exhausted = sentAttempts >= 4;
    const delay =
      exhausted || permanent
        ? LONG_COOLDOWN
        : Math.min(
            60000,
            1000 * 2 ** Math.max(0, (sent ? sentAttempts : refusals) - 1),
          );
    const recovery: BackgroundRecovery = {
      next_attempt: Math.max(now + delay, notBefore),
      not_before: notBefore,
      refusals,
      sent_attempts: sentAttempts,
      exhausted,
      reason,
      ...(operation ? { operation } : {}),
      ...(batch ? { batch: batch.id } : {}),
    };
    const isolate =
      !!batch &&
      (!!held || exhausted || reason === "billing_request_too_large");
    const split =
      isolate &&
      batch!.inputs.length > 1 &&
      (exhausted || reason === "billing_request_too_large");
    if (isolate) {
      await store.holdBackgroundInputs(batch!, recovery, split, now);
      // Finish a pass with held inputs so a later snapshot can proceed.
      await store.start(job.id);
      await store.finish(job.id);
      if ((await store.generation(job.id, true)).state === "running")
        await store.pause(job.id, reason);
      recovery.next_attempt = Math.max(
        notBefore,
        (await store.backgroundSchedule(job.id, now)) ?? recovery.next_attempt,
      );
    }
    if (beforeJob)
      await store.setBackgroundWait(job.profile, job.view, recovery);
    else await store.setBackgroundRecovery(job.id, recovery);
    if (exhausted && !beforeJob)
      await store.pause(job.id, "background_retry_exhausted");
    const subject = beforeJob
      ? `Background semantic indexing for profile ${job.profile} and view ${job.view}`
      : `Background semantic job ${job.id}`;
    const message = `${subject} paused: ${reason}. ${exhausted ? "Automatic retries exhausted. " : ""}Retry at ${new Date(recovery.next_attempt).toISOString()}.`;
    if (
      previous?.reason !== reason ||
      previous?.exhausted !== exhausted ||
      split
    ) {
      if (this.options.status) this.options.status(message);
      else this.options.report(new Error(message));
    }
  }
  start() {
    if (this.timer || this.stop.signal.aborted) return;
    const next = () => {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.cycle()
          .catch(this.options.report)
          .finally(() => {
            if (!this.stop.signal.aborted) next();
          });
      }, 5000);
    };
    next();
  }
  async close() {
    this.stop.abort();
    if (this.timer) clearTimeout(this.timer);
    await this.work?.catch(() => {});
  }
}
