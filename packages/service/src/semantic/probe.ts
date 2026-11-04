import { AssistanceError, type EmbeddingRoute } from "../inference.ts";
import type { AssistanceService } from "../assistance.ts";
import { inputHash } from "./profile.ts";
import { distance, vectorFromBytes } from "./vector.ts";
import { SemanticError, type EmbeddingProfile } from "./types.ts";
import type { VectorStore } from "./vector-store.ts";

/** Earlier Nebius tests found differences near 0.0002. This fixed tolerance is not fitted to search targets. */
export const PROBE_MAX_DISTANCE = 0.0005;

export async function probeCompatibility(
  store: VectorStore,
  inference: Pick<AssistanceService, "embed">,
  identity: string,
  profile: EmbeddingProfile,
  route: EmbeddingRoute,
  references: { input: Uint8Array; vector: Uint8Array }[],
  signal?: AbortSignal,
) {
  const unavailable = () =>
    new SemanticError(
      503,
      "semantic_unavailable",
      "The embedding references are unavailable.",
    );
  const suspended = await store.compatibility(identity);
  if (suspended)
    throw new SemanticError(
      409,
      "semantic_profile_suspended",
      "The embedding profile is suspended. Create a fresh profile after repairing the provider.",
    );
  if (!references.length) throw unavailable();
  try {
    const result = await inference.embed(
      references.map((r) => r.input),
      { kind: "probe", route },
      signal,
    );
    if (result.vectors.length !== references.length) throw unavailable();
    const comparisons = result.vectors.map((v, i) => ({
      input: inputHash(references[i].input),
      distance: distance(
        v,
        vectorFromBytes(references[i].vector, profile.dimension),
      ),
    }));
    await store.recordProbe(identity, {
      operation: result.operation,
      route,
      checked_at: Date.now(),
      tolerance: PROBE_MAX_DISTANCE,
      model: result.model,
      references: comparisons,
    });
    if (
      comparisons.some((reference) => reference.distance > PROBE_MAX_DISTANCE)
    ) {
      await store.suspend(identity, "semantic_model_drift");
      throw new SemanticError(
        503,
        "semantic_model_drift",
        "The provider vectors changed beyond the compatibility tolerance. This profile is suspended.",
      );
    }
  } catch (failure) {
    if (failure instanceof AssistanceError) {
      if (failure.code === "embedding_model_mismatch")
        await store.suspend(identity, failure.code);
      if (failure.code === "embedding_rate_limited")
        await store.defer(
          identity,
          Date.now() + Math.max(1000, failure.retryAfterMs ?? 1000),
          Date.now(),
          route,
        );
    }
    throw failure;
  }
}
