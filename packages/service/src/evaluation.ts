import type {
  Evaluation,
  EvaluationPackageRecord,
  EvaluationSessionOptions,
} from "../../core/src/index.ts";

type Result<T> = T | Promise<T>;

/** The host can run authenticated core sessions outside the request thread. */
export interface EvaluationRuntime {
  create(options: EvaluationSessionOptions): Result<EvaluationBuilder>;
  restore(bytes: Uint8Array, binding: string): Result<EvaluationSession>;
}
export interface EvaluationSession {
  readonly state: Evaluation;
  isAvailable?(): boolean;
  rankWord(word: string, reviewers?: number): Result<any>;
  fork(options: EvaluationSessionOptions): Result<EvaluationBuilder>;
  checkpoint(binding: string): Result<Uint8Array>;
  free(): void;
}
export interface EvaluationBuilder {
  addRecord(
    envelope: Uint8Array,
    body?: Uint8Array,
  ): Result<EvaluationPackageRecord | null>;
  removeRecord(id: string): Result<void>;
  finish(): Result<EvaluationSession>;
  free(): void;
}
