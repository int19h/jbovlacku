export interface ImportSizeInput {
  stage_bytes: number;
  definition_rows: number;
  /** Staged definitions that need a new signed publication. */
  new_publication_count?: number;
  new_rafsi_claim_count?: number;
  existing_journal_bytes?: number;
  retained_carrier_bytes?: number;
  retained_carrier_count?: number;
  /** The old carriers file that coexists with its replacement during export. */
  existing_output_carrier_bytes?: number;
  /** The caller must refuse every new publication and view before signing. */
  check_existing?: boolean;
  /** Only after the caller verifies the committed snapshot and manifest. */
  reuse_committed_snapshot?: boolean;
  budget_bytes?: number;
}

export interface ImportSizeEstimate {
  model: "lensisku-sql-artifacts-v1";
  scope: "proposal" | "proposal-and-load";
  budget_bytes: number;
  stage_bytes: number;
  definition_rows: number;
  new_publication_count: number;
  estimated_proposal_bytes: number;
  estimated_proposal_peak_bytes: number;
  estimated_total_bytes: number;
  within_budget: boolean;
  components: {
    staging_bytes: number;
    journal_bytes: number;
    carrier_bytes: number;
    journal_rollback_reserve_bytes: number;
    carrier_replacement_reserve_bytes: number;
    metadata_reserve_bytes: number;
    loaded_copy_bytes: number;
  };
}

const MiB = 1024 * 1024;
const reserve = 16 * MiB;
const size = (value: number, name: string) => {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${name} must be a nonnegative safe integer.`);
  return value;
};
const sum = (...values: number[]) =>
  size(
    values.reduce((total, value) => total + value, 0),
    "The estimated size",
  );

/** Calibrated against SQL extraction v2. This is not a filesystem upper bound. */
export function estimateImportArtifacts(
  input: ImportSizeInput,
): ImportSizeEstimate {
  const stage = size(input.stage_bytes, "stage_bytes");
  const rows = size(input.definition_rows, "definition_rows");
  const publications = size(
    input.new_publication_count ??
      (input.check_existing || input.reuse_committed_snapshot ? 0 : rows),
    "new_publication_count",
  );
  if (publications > rows)
    throw new Error(
      "New publication count exceeds the staged definition rows.",
    );
  const journal = size(
    input.existing_journal_bytes ?? 0,
    "existing_journal_bytes",
  );
  const retained = size(
    input.retained_carrier_bytes ?? 0,
    "retained_carrier_bytes",
  );
  const retainedCount = size(
    input.retained_carrier_count ?? 0,
    "retained_carrier_count",
  );
  if (retained > 0 && retainedCount === 0)
    throw new Error("Retained carrier bytes require a retained carrier count.");
  const replacement = size(
    input.existing_output_carrier_bytes ?? retained,
    "existing_output_carrier_bytes",
  );
  const budget = size(
    input.budget_bytes ??
      (input.check_existing ? 1_500_000_000 : 3_000_000_000),
    "budget_bytes",
  );
  if (budget === 0) throw new Error("budget_bytes must be positive.");
  // Normal imports reserve one view in addition to the planned definitions.
  const newCount = input.check_existing
    ? 0
    : sum(
        publications,
        size(input.new_rafsi_claim_count ?? 0, "new_rafsi_claim_count"),
        1,
      );
  const newCarriers = size(newCount * 6144, "New carrier bytes");
  const carrierBytes = sum(retained, newCarriers);
  // Version rows repeat carrier and lexical data. Each run also appends observations.
  const journalBytes = sum(
    journal,
    Math.ceil(newCarriers * 1.5),
    size(rows * 1536, "Observation bytes"),
  );
  const rollback = Math.max(reserve, Math.ceil(journal / 8));
  // Two immutable files per carrier need allocation slack, coordinator rows, and directories.
  const loaded = input.check_existing
    ? 0
    : sum(
        carrierBytes,
        size(sum(retainedCount, newCount) * 10_752, "Loaded allocation bytes"),
      );
  const proposal = sum(journalBytes, carrierBytes, reserve);
  const proposalPeak = sum(proposal, stage, rollback, replacement);
  const total = sum(proposalPeak, loaded);
  return {
    model: "lensisku-sql-artifacts-v1",
    scope: input.check_existing ? "proposal" : "proposal-and-load",
    budget_bytes: budget,
    stage_bytes: stage,
    definition_rows: rows,
    new_publication_count: publications,
    estimated_proposal_bytes: proposal,
    estimated_proposal_peak_bytes: proposalPeak,
    estimated_total_bytes: total,
    within_budget: total <= budget,
    components: {
      staging_bytes: stage,
      journal_bytes: journalBytes,
      carrier_bytes: carrierBytes,
      journal_rollback_reserve_bytes: rollback,
      carrier_replacement_reserve_bytes: replacement,
      metadata_reserve_bytes: reserve,
      loaded_copy_bytes: loaded,
    },
  };
}

export interface ImportSizeMeasurement {
  proposal_bytes: number;
  stage_bytes: number;
  loaded_copy_bytes?: number;
  journal_rollback_bytes?: number;
  carrier_replacement_bytes?: number;
}

/** Compare only measured components. An unmeasured loaded copy is never claimed. */
export function compareImportSize(
  estimate: ImportSizeEstimate,
  actual: ImportSizeMeasurement,
) {
  const proposal = size(actual.proposal_bytes, "proposal_bytes");
  const stage = size(actual.stage_bytes, "stage_bytes");
  const loaded =
    actual.loaded_copy_bytes === undefined
      ? undefined
      : size(actual.loaded_copy_bytes, "loaded_copy_bytes");
  if (loaded !== undefined && estimate.scope === "proposal")
    throw new Error(
      "The measurement includes a loaded copy outside the estimate scope.",
    );
  const total = sum(
    proposal,
    stage,
    loaded ?? 0,
    size(actual.journal_rollback_bytes ?? 0, "journal_rollback_bytes"),
    size(actual.carrier_replacement_bytes ?? 0, "carrier_replacement_bytes"),
  );
  const expected =
    loaded === undefined
      ? estimate.estimated_proposal_peak_bytes
      : estimate.estimated_total_bytes;
  const warnings: {
    code: string;
    message: string;
    estimated_bytes: number;
    actual_bytes: number;
  }[] = [];
  if (proposal > estimate.estimated_proposal_bytes * 1.1)
    warnings.push({
      code: "import_proposal_estimate_miss",
      message:
        "The measured proposal is more than 10 percent above its calibrated estimate.",
      estimated_bytes: estimate.estimated_proposal_bytes,
      actual_bytes: proposal,
    });
  if (total > expected * 1.1)
    warnings.push({
      code: "import_estimate_miss",
      message:
        "The measured artifacts are more than 10 percent above their calibrated estimate.",
      estimated_bytes: expected,
      actual_bytes: total,
    });
  if (total > estimate.budget_bytes)
    warnings.push({
      code: "import_budget_exceeded",
      message: "The measured artifacts exceed the size budget.",
      estimated_bytes: estimate.budget_bytes,
      actual_bytes: total,
    });
  return {
    measured_scope:
      loaded === undefined
        ? ("proposal" as const)
        : ("proposal-and-load" as const),
    loaded_copy_measured: loaded !== undefined,
    measured_proposal_bytes: proposal,
    measured_total_bytes: total,
    estimated_comparison_bytes: expected,
    estimate_miss_bytes: Math.max(0, total - expected),
    budget_exceeded: total > estimate.budget_bytes,
    warnings,
  };
}
