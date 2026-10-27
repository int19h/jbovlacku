import { SemanticIndexer, type IndexEmbedder } from "./indexer.ts";
import type { SemanticSource } from "./source.ts";
import type { EmbeddingProfile } from "./types.ts";
import type { IndexGeneration, VectorStore } from "./vector-store.ts";

/** One durable job per host. Failed attempts require explicit operator recovery. */
export class BackgroundSemanticIndexer {
  private stop = new AbortController();
  private work?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
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
      report(error: unknown): void;
    },
  ) {}

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
    const profile = await store.profile(current.id);
    let job = await store.backgroundGeneration(identity, view);
    // An unfinished operator job can contain failed or ambiguous sends. Do not adopt or replay it.
    if (!job && current.state !== "completed") return;
    await store.pruneBackgroundGenerations(identity, view);
    // Never replace a failed job with a fresh generation that can replay its inputs.
    if (
      job &&
      job.state !== "completed" &&
      (job.state !== "paused" ||
        (job.error && job.error !== "index_incomplete"))
    )
      return;
    if (
      (!job || job.state === "completed") &&
      this.options.needed &&
      !(await this.options.needed())
    )
      return;
    const source = await this.options.source(
      profile,
      job && job.state !== "completed" ? job.snapshot : undefined,
    );
    if (this.stop.signal.aborted) return;
    if (!job || job.state === "completed") {
      if (source.context.snapshot === (job ?? current).snapshot) return;
      await store.pruneBackgroundGenerations(identity, view);
      job = await store.create(source.context, profile);
      await store.setBackgroundGeneration(job.id);
    }
    try {
      const indexer = new SemanticIndexer(store, this.options.assistance);
      // Bounded source pages yield through storage and do not hold the directory lock again.
      while (!job.source_done && !this.stop.signal.aborted) {
        job = await indexer.prepare(job.id, source, 1);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      if (this.stop.signal.aborted) return;
      const published = await store.current(identity, view);
      if (published !== job.id && !(await store.publish(job.id, published)))
        return;
      const coverage = await store.coverage(job.id);
      if (coverage.pending && (await store.references(current.id)).length)
        await this.options.probe(current, profile);
      if (this.stop.signal.aborted) return;
      // Background indexing uses at most one of the shared provider slots.
      await indexer.run(job.id, { concurrency: 1, signal: this.stop.signal });
      await store.pruneBackgroundGenerations(identity, view);
    } catch (failure) {
      await store.pause(
        job.id,
        failure instanceof Error && "code" in failure
          ? String(failure.code)
          : "background_index_failed",
      );
      throw failure;
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
