import * as wasm from "../generated/jvc_runtime.js";

export interface WordResultPolicy {
  numerical_operations?: number;
  memory_bytes?: number;
  output_bytes?: number;
  targets?: number;
  comparisons?: number;
  actor_terms?: number;
  reviewers?: number | null;
  reviewer_terms?: number;
}

/** Bind and size the same frozen input before cache admission. Core must be initialized. */
export function wordResultPolicyIdentity(policy: WordResultPolicy = {}) {
  const serialized = JSON.stringify(policy);
  const binding = wasm.word_result_policy_binding(
    new TextEncoder().encode(serialized),
  );
  // Native validation above rejects unknown fields and invalid limits.
  const frozen = JSON.parse(serialized) as WordResultPolicy;
  return { binding, output_bytes: frozen.output_bytes ?? 4 * 1024 * 1024 };
}
export const wordResultPolicyBinding = (
  policy: WordResultPolicy = {},
): string => wordResultPolicyIdentity(policy).binding;
