import {
  semanticProjectionVersion,
  type Evaluation,
} from "../../../core/src/index.ts";
import { abortable, AssistanceError } from "../inference.ts";
import type { AssistanceService } from "../assistance.ts";
import type { Snapshot } from "../storage.ts";
import {
  createQwenProfile,
  inputHash,
  profileId,
  queryInput,
} from "./profile.ts";
import { distance, vectorBytes, vectorFromBytes } from "./vector.ts";
import { SemanticError } from "./types.ts";
import type { EmbeddingProfile } from "./types.ts";
import type {
  VectorStore,
  IndexGeneration,
  IndexCoverage,
} from "./vector-store.ts";
import type { QueryCache } from "./query-cache.ts";
import type { VectorScanner } from "./scan.ts";

/** Independent public reference runs include ordinary differences near 0.0002. This fixed tolerance is not fitted to search targets. */
export const PROBE_MAX_DISTANCE = 0.0005;

export interface SemanticOptions {
  profile: string;
  store: VectorStore;
  cache: QueryCache;
  scanner: VectorScanner;
}
export interface SearchContext {
  snapshot: Snapshot;
  evaluation: Evaluation;
  retained(): Promise<boolean>;
}
export interface ProfileDescription {
  id: string;
  label: string;
  query_available: boolean;
  indexed: number;
  eligible: number;
  pending: number;
  limitations: string[];
}
export function eligibleEvents(
  context: SearchContext,
  language?: string,
): string[] {
  return Object.keys(context.evaluation.publications).filter((id) => {
    const p = context.evaluation.publications[id];
    return (
      p.kind === "definition.publish" &&
      p.eligible === "eligible" &&
      p.status === "active" &&
      p.content_available &&
      context.evaluation.receipts[id]?.interpretation === "effective" &&
      (language === undefined || p.language === language)
    );
  });
}
const unavailable = () =>
  new SemanticError(
    503,
    "semantic_unavailable",
    "A compatible index is unavailable for this view.",
  );

/** Cache vectors only. Every result uses a newly pinned dictionary context. */
export class SemanticSearch {
  private pending = new Map<string, Promise<Float32Array>>();
  private probeWork = new Map<string, Promise<void>>();
  private checked = new Map<string, number>();
  private coverageCache = new WeakMap<
    Evaluation,
    Map<
      string,
      Promise<{ all: IndexCoverage; languages: Record<string, IndexCoverage> }>
    >
  >();
  constructor(
    readonly options: SemanticOptions,
    private inference: Pick<AssistanceService, "embed">,
    private providerAvailable: boolean,
  ) {}

  private async compatible(profile: string) {
    if (await this.options.store.compatibility(profile))
      throw new SemanticError(
        503,
        "semantic_profile_suspended",
        "The embedding profile is suspended. Create a fresh index after repairing the provider.",
      );
  }
  private async generation(
    context: SearchContext,
  ): Promise<IndexGeneration | undefined> {
    return (
      await this.options.store.published(context.evaluation.selected_view)
    ).find((g) => g.profile === this.options.profile);
  }
  private coverage(context: SearchContext, generation: IndexGeneration) {
    let cached = this.coverageCache.get(context.evaluation);
    if (!cached)
      this.coverageCache.set(context.evaluation, (cached = new Map()));
    const old = cached.get(generation.id);
    if (old) return old;
    const expected = eligibleEvents(context).map((id) => {
      const event = context.snapshot.events[id];
      const publication = context.evaluation.publications[id];
      if (!event?.body_hash || !publication.language) throw unavailable();
      return {
        event: id,
        envelope: event.envelope_hash,
        body: event.body_hash,
        word: publication.word,
        language: publication.language,
        extraction_version: semanticProjectionVersion(),
      };
    });
    const work = this.options.store.coverageFor(generation.id, expected);
    // Completed associations are immutable. Pending generations must reflect indexing progress.
    if (generation.state === "completed") {
      cached.set(generation.id, work);
      void work.catch(() => cached!.delete(generation.id));
    }
    return work;
  }
  private async ready(
    context: SearchContext,
    generation: IndexGeneration,
    profile: EmbeddingProfile,
    coverage: IndexCoverage,
  ) {
    return (
      this.providerAvailable &&
      context.evaluation.available &&
      generation.state !== "retired" &&
      generation.source_done &&
      (coverage.indexed > 0 || coverage.eligible === 0) &&
      coverage.eligible === eligibleEvents(context).length &&
      profileId(profile) === profileId(createQwenProfile(profile.epoch)) &&
      !(await this.options.store.compatibility(generation.profile))
    );
  }
  async profiles(
    context: SearchContext,
    language?: string,
  ): Promise<ProfileDescription[]> {
    const generation = await this.generation(context);
    if (!generation) return [];
    const profile = await this.options.store.profile(generation.id);
    const bound = await this.coverage(context, generation);
    const all = bound.all;
    const counts =
      language === undefined
        ? all
        : (bound.languages[language] ?? {
            indexed: 0,
            eligible: 0,
            pending: 0,
            failed: 0,
          });
    const query_available = await this.ready(context, generation, profile, all);
    return [
      {
        id: generation.profile,
        label: "Qwen3 Embedding 8B through OpenRouter / Nebius",
        query_available,
        indexed: counts.indexed,
        eligible: counts.eligible,
        pending: counts.pending,
        limitations: [
          "The hosted model revision is unknown. Compatibility probes cannot prove that it never changes.",
          "The browser needs this server to compute query vectors. Offline meaning search and derived exchange are unavailable.",
          ...(!query_available
            ? [
                "A compatible published index and query provider are required for this view.",
              ]
            : []),
          ...(counts.failed
            ? [`${counts.failed} definitions failed indexing.`]
            : []),
        ],
      },
    ];
  }
  private async checkRetained(context: SearchContext) {
    if (!(await context.retained()))
      throw new SemanticError(
        410,
        "snapshot_expired",
        "The search snapshot expired. Start a new search.",
      );
  }
  /** Recheck public reference inputs before the first miss and once per hour of new computations. */
  async probe(
    generation: IndexGeneration,
    profile: EmbeddingProfile,
  ): Promise<void> {
    await this.compatible(generation.profile);
    if (Date.now() - (this.checked.get(generation.profile) ?? 0) < 3600000)
      return;
    let work = this.probeWork.get(generation.profile);
    if (!work) {
      work = (async () => {
        const references = await this.options.store.references(generation.id);
        if (!references.length) throw unavailable();
        const result = await this.inference.embed(
          references.map((r) => r.input),
          { kind: "probe" },
        );
        if (result.vectors.length !== references.length) throw unavailable();
        const comparisons = result.vectors.map((v, i) => ({
          input: inputHash(references[i].input),
          distance: distance(
            v,
            vectorFromBytes(references[i].vector, profile.dimension),
          ),
        }));
        await this.options.store.recordProbe(generation.profile, {
          operation: result.operation,
          checked_at: Date.now(),
          tolerance: PROBE_MAX_DISTANCE,
          model: result.model,
          references: comparisons,
        });
        if (
          comparisons.some(
            (reference) => reference.distance > PROBE_MAX_DISTANCE,
          )
        ) {
          await this.options.store.suspend(
            generation.profile,
            "semantic_model_drift",
          );
          throw new SemanticError(
            503,
            "semantic_model_drift",
            "The provider vectors changed beyond the compatibility tolerance. This profile is suspended.",
          );
        }
        this.checked.set(generation.profile, Date.now());
      })()
        .catch(async (failure) => {
          if (
            failure instanceof AssistanceError &&
            failure.code === "embedding_model_mismatch"
          )
            await this.options.store.suspend(generation.profile, failure.code);
          throw failure;
        })
        .finally(() => {
          this.probeWork.delete(generation.profile);
        });
      this.probeWork.set(generation.profile, work);
    }
    return work;
  }
  private async vector(
    generation: IndexGeneration,
    profile: EmbeddingProfile,
    bytes: Uint8Array,
    network: string,
  ): Promise<Float32Array> {
    const hash = inputHash(bytes);
    const key = `${generation.profile}:${hash}`;
    await this.compatible(generation.profile);
    const cached = await this.options.cache.get(generation.profile, hash);
    if (cached) {
      await this.compatible(generation.profile);
      return vectorFromBytes(cached, profile.dimension);
    }
    let work = this.pending.get(key);
    if (!work) {
      if (this.pending.size >= 16)
        throw new SemanticError(
          503,
          "semantic_busy",
          "The meaning search queue is full. Try again later.",
        );
      work = (async () => {
        // Another waiter can fill the cache while this caller waits for its first read.
        const retained = await this.options.cache.get(generation.profile, hash);
        if (retained) return vectorFromBytes(retained, profile.dimension);
        const retry = await this.options.store.retryAfter(generation.profile);
        if (retry !== null && retry > Date.now())
          throw new SemanticError(
            429,
            "embedding_rate_limited",
            "The embedding provider is cooling down. Try again later.",
          );
        await this.probe(generation, profile);
        await this.compatible(generation.profile);
        const result = await this.inference.embed([bytes], {
          kind: "query",
          network,
        });
        await this.compatible(generation.profile);
        const vector = result.vectors[0];
        if (result.vectors.length !== 1)
          throw new SemanticError(
            502,
            "embedding_vector",
            "The query result has an invalid vector count.",
          );
        await this.options.cache.put(
          generation.profile,
          hash,
          vectorBytes(vector, profile.dimension),
        );
        return vector;
      })()
        .catch(async (failure) => {
          if (failure instanceof AssistanceError) {
            if (failure.code === "embedding_model_mismatch")
              await this.options.store.suspend(
                generation.profile,
                failure.code,
              );
            if (failure.code === "embedding_rate_limited")
              await this.options.store.defer(
                generation.profile,
                Date.now() + Math.max(1000, failure.retryAfterMs ?? 1000),
              );
          }
          throw failure;
        })
        .finally(() => {
          this.pending.delete(key);
        });
      this.pending.set(key, work);
    }
    return work;
  }
  async search(
    context: SearchContext,
    request: {
      query: string;
      profile: string;
      language: string;
      limit: number;
    },
    network: string,
    signal?: AbortSignal,
    selection: { distinctWords?: boolean; excludedEvents?: Set<string> } = {},
  ) {
    signal?.throwIfAborted();
    await this.checkRetained(context);
    const generation = await this.generation(context);
    if (!generation || request.profile !== this.options.profile)
      throw unavailable();
    const profile = await this.options.store.profile(generation.id);
    // Validate the complete profile and exact query before any reservation.
    const bytes = queryInput(profile, request.query);
    const bound = await this.coverage(context, generation);
    const all = bound.all;
    await this.compatible(generation.profile);
    if (!(await this.ready(context, generation, profile, all)))
      throw unavailable();
    const coverage = bound.languages[request.language] ?? {
      indexed: 0,
      eligible: 0,
      pending: 0,
      failed: 0,
    };
    const eligible = eligibleEvents(context, request.language).filter(
      (id) => !selection.excludedEvents?.has(id),
    );
    let hits = [] as Awaited<ReturnType<VectorScanner["scan"]>>;
    if (eligible.length && coverage.indexed > 0) {
      signal?.throwIfAborted();
      const work = this.vector(generation, profile, bytes, network);
      const vector = await (signal ? abortable(work, signal) : work);
      await this.checkRetained(context);
      await this.compatible(generation.profile);
      hits = await this.options.scanner.scan(
        {
          generation: generation.id,
          profile: generation.profile,
          snapshot: context.snapshot.snapshot,
          view: generation.view,
          language: request.language,
          vector,
          limit: request.limit,
          eligible,
          network,
          bindings: eligible.map((event) => ({
            event,
            envelope: context.snapshot.events[event].envelope_hash,
            body: context.snapshot.events[event].body_hash!,
            word: context.evaluation.publications[event].word,
            language: context.evaluation.publications[event].language!,
            extraction_version: semanticProjectionVersion(),
          })),
          distinctWords: selection.distinctWords,
        },
        signal,
      );
      for (const hit of hits) {
        const p = context.evaluation.publications[hit.event];
        if (!p || p.word !== hit.word)
          throw new SemanticError(
            503,
            "semantic_binding",
            "A vector association differs from its evaluated definition.",
          );
      }
    }
    await this.checkRetained(context);
    await this.compatible(generation.profile);
    if (
      (await this.options.store.generation(generation.id)).state === "retired"
    )
      throw unavailable();
    return {
      snapshot: context.snapshot.snapshot,
      view: context.evaluation.selected_view,
      profile: generation.profile,
      query_hash: inputHash(bytes),
      hits,
      coverage,
    };
  }
  async drain() {
    await Promise.allSettled([
      ...this.pending.values(),
      ...this.probeWork.values(),
    ]);
  }
}
