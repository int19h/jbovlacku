import {
  semanticProjectionVersion,
  wordId,
  type Evaluation,
} from "../../../core/src/index.ts";
import type { Coordinator, ObjectStore, Snapshot } from "../storage.ts";
import { readSemanticRecord } from "./storage.ts";
import { semanticDocument } from "./records.ts";
import { profileId } from "./profile.ts";
import { SemanticError, type EmbeddingProfile } from "./types.ts";

export interface IndexContext {
  snapshot: string;
  view: string;
  profile: string;
  eligible: number;
}
export interface IndexDocument {
  event: string;
  envelope: string;
  body: string;
  extraction_version: number;
  word: string;
  language: string;
  input: Uint8Array | null;
  input_hash: string | null;
  error: string | null;
}
export interface DocumentPage {
  documents: IndexDocument[];
  next: string | null;
  done: boolean;
}
export interface SemanticSource {
  context: IndexContext;
  page(after: string | null, limit: number): Promise<DocumentPage>;
}

/** Only the evaluator decides selection, activity, and view eligibility. */
export function eligibleSemanticSource(
  profile: EmbeddingProfile,
  snapshot: Snapshot,
  evaluation: Evaluation,
  coordinator: Coordinator,
  objects: ObjectStore,
): SemanticSource {
  if (!evaluation.available)
    throw new SemanticError(
      503,
      "semantic_evaluation",
      "The selected view is unavailable.",
    );
  const ids = Object.keys(evaluation.publications)
    .filter((id) => {
      const publication = evaluation.publications[id];
      return (
        publication.kind === "definition.publish" &&
        publication.eligible === "eligible" &&
        publication.status === "active" &&
        publication.content_available &&
        evaluation.receipts[id]?.interpretation === "effective"
      );
    })
    .sort();
  const context = {
    snapshot: snapshot.snapshot,
    view: evaluation.selected_view,
    profile: profileId(profile),
    eligible: ids.length,
  };
  return {
    context,
    async page(after, limit) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 128)
        throw new SemanticError(
          400,
          "semantic_page",
          "A source page permits one through 128 records.",
        );
      if (!(await coordinator.getSnapshot(snapshot.snapshot)))
        throw new SemanticError(
          410,
          "snapshot_expired",
          "The indexing snapshot expired. Start a new generation.",
        );
      // Binary search keeps resume independent of the number of preceding records.
      let low = 0;
      let high = ids.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (after !== null && ids[middle] <= after) low = middle + 1;
        else high = middle;
      }
      const selected = ids.slice(low, low + limit);
      const documents: IndexDocument[] = [];
      for (const id of selected) {
        const binding = snapshot.events[id];
        const publication = evaluation.publications[id];
        if (!binding?.body_hash || !publication.language)
          throw new SemanticError(
            503,
            "semantic_binding",
            "An eligible definition has no body binding.",
          );
        const record = await readSemanticRecord(
          coordinator,
          objects,
          id,
          binding,
        );
        let input: Uint8Array | null = null;
        let input_hash: string | null = null;
        let error: string | null = null;
        try {
          const document = semanticDocument(profile, record);
          if (
            !document ||
            document.definition.language !== publication.language ||
            wordId(
              document.definition.word as { language: "jbo"; spelling: string },
            ) !== publication.word
          )
            throw new SemanticError(
              503,
              "semantic_binding",
              "The semantic record differs from the evaluated definition.",
            );
          input = document.input;
          input_hash = document.input_hash;
        } catch (failure) {
          // Only a recipe size failure becomes a failed entry. Broken private bindings stop preparation.
          if (
            !(failure instanceof SemanticError) ||
            failure.code !== "input_limit"
          )
            throw failure;
          error = failure.code;
        }
        documents.push({
          event: id,
          envelope: binding.envelope_hash,
          body: binding.body_hash,
          extraction_version: semanticProjectionVersion(),
          word: publication.word,
          language: publication.language,
          input,
          input_hash,
          error,
        });
      }
      const done = low + selected.length === ids.length;
      return { documents, next: selected.at(-1) ?? after, done };
    },
  };
}
