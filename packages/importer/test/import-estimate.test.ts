import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareImportSize,
  estimateImportArtifacts,
} from "../src/import-estimate.ts";

test("the calibrated full estimate covers the measured SQL proposal, loaded copy, and staging", () => {
  const estimate = estimateImportArtifacts({
    stage_bytes: 143_433_728,
    definition_rows: 65_224,
  });
  const measuredPeak = 1_702_961_152 + 143_433_728;
  assert.ok(
    estimate.estimated_total_bytes >= measuredPeak,
    `${estimate.estimated_total_bytes} estimated bytes do not cover ${measuredPeak} measured bytes.`,
  );
});

test("an unchanged proposal check includes the existing ledger and stays within its separate budget", () => {
  const estimate = estimateImportArtifacts({
    stage_bytes: 143_433_728,
    definition_rows: 65_224,
    existing_journal_bytes: 523_272_192,
    retained_carrier_bytes: 325_410_269,
    retained_carrier_count: 59_126,
    existing_output_carrier_bytes: 0,
    check_existing: true,
  });
  assert.equal(estimate.scope, "proposal");
  assert.equal(estimate.components.loaded_copy_bytes, 0);
  assert.equal(estimate.estimated_total_bytes, 1_174_486_493);
  assert.equal(estimate.budget_bytes, 1_500_000_000);
  assert.equal(estimate.within_budget, true);
  assert.ok(estimate.estimated_proposal_bytes >= 853_782_528);
});

test("retained journal, carriers, observation growth, rollback, and replacement all contribute", () => {
  const fresh = estimateImportArtifacts({
    stage_bytes: 1024,
    definition_rows: 4,
  });
  const repeat = estimateImportArtifacts({
    stage_bytes: 1024,
    definition_rows: 4,
    existing_journal_bytes: 200_000_000,
    retained_carrier_bytes: 100_000_000,
    retained_carrier_count: 10000,
    existing_output_carrier_bytes: 50_000_000,
  });
  assert.ok(
    repeat.components.journal_bytes >=
      fresh.components.journal_bytes + 200_000_000,
  );
  assert.ok(
    repeat.components.carrier_bytes >=
      fresh.components.carrier_bytes + 100_000_000,
  );
  assert.ok(
    repeat.components.loaded_copy_bytes >
      fresh.components.loaded_copy_bytes + 100_000_000,
  );
  assert.equal(repeat.components.carrier_replacement_reserve_bytes, 50_000_000);
  assert.ok(repeat.components.journal_rollback_reserve_bytes >= 25_000_000);
});

test("check budget refusal includes a large retained ledger even when no new publications are allowed", () => {
  const estimate = estimateImportArtifacts({
    stage_bytes: 100_000_000,
    definition_rows: 65_224,
    existing_journal_bytes: 1_200_000_000,
    retained_carrier_bytes: 325_410_269,
    retained_carrier_count: 59_126,
    existing_output_carrier_bytes: 0,
    check_existing: true,
  });
  assert.equal(estimate.within_budget, false);
});

test("a verified committed repeat budgets one new view and fits the normal full-run budget", () => {
  const estimate = estimateImportArtifacts({
    stage_bytes: 0,
    definition_rows: 65_224,
    existing_journal_bytes: 523_272_192,
    retained_carrier_bytes: 325_410_269,
    retained_carrier_count: 59_126,
    reuse_committed_snapshot: true,
  });
  assert.equal(estimate.scope, "proposal-and-load");
  assert.ok(estimate.estimated_total_bytes < 3_000_000_000);
  assert.equal(estimate.within_budget, true);
});

test("a changed full snapshot budgets only definitions that need new publications", () => {
  const retained = {
    stage_bytes: 143_433_728,
    definition_rows: 65_224,
    existing_journal_bytes: 523_272_192,
    retained_carrier_bytes: 325_410_269,
    retained_carrier_count: 59_126,
  };
  const few = estimateImportArtifacts({
    ...retained,
    new_publication_count: 3,
  });
  const all = estimateImportArtifacts({
    ...retained,
    new_publication_count: 65_224,
  });
  assert.equal(few.new_publication_count, 3);
  assert.equal(few.within_budget, true);
  assert.equal(all.estimated_total_bytes, 4_564_927_383);
  assert.equal(all.within_budget, false);
  assert.equal(
    few.components.journal_bytes,
    retained.existing_journal_bytes + 4 * 6144 * 1.5 + 65_224 * 1536,
  );
  assert.equal(
    few.components.loaded_copy_bytes,
    retained.retained_carrier_bytes + 4 * 6144 + (59_126 + 4) * 10_752,
  );
});

test("post-run measurements report a large miss in the proposal even when reserves cover it", () => {
  const estimate = estimateImportArtifacts({
    stage_bytes: 1000,
    definition_rows: 4,
  });
  const proposal = Math.ceil(estimate.estimated_proposal_bytes * 1.2);
  const measured = compareImportSize(estimate, {
    proposal_bytes: proposal,
    stage_bytes: 1000,
  });
  assert.equal(measured.measured_scope, "proposal");
  assert.equal(measured.loaded_copy_measured, false);
  assert.equal(
    measured.estimated_comparison_bytes,
    estimate.estimated_proposal_peak_bytes,
  );
  assert.ok(
    measured.warnings.some(
      (warning) => warning.code === "import_proposal_estimate_miss",
    ),
  );
});

test("post-run audit detects the old full-run miss and a budget breach", () => {
  const estimate = estimateImportArtifacts({
    stage_bytes: 143_433_728,
    definition_rows: 65_224,
  });
  const old = { ...estimate, estimated_total_bytes: 1_108_049_920 };
  const measured = compareImportSize(old, {
    proposal_bytes: 853_782_528,
    stage_bytes: 143_433_728,
    loaded_copy_bytes: 849_178_624,
  });
  assert.equal(measured.measured_total_bytes, 1_846_394_880);
  assert.equal(measured.loaded_copy_measured, true);
  assert.ok(
    measured.warnings.some(
      (warning) => warning.code === "import_estimate_miss",
    ),
  );
  const exceeded = compareImportSize(estimate, {
    proposal_bytes: 3_000_000_001,
    stage_bytes: 0,
  });
  assert.equal(exceeded.budget_exceeded, true);
  assert.ok(
    exceeded.warnings.some(
      (warning) => warning.code === "import_budget_exceeded",
    ),
  );
});

test("measurement scope never claims an unmeasured loaded copy", () => {
  const estimate = estimateImportArtifacts({
    stage_bytes: 0,
    definition_rows: 0,
    check_existing: true,
  });
  assert.throws(
    () =>
      compareImportSize(estimate, {
        proposal_bytes: 0,
        stage_bytes: 0,
        loaded_copy_bytes: 0,
      }),
    /outside the estimate scope/,
  );
});

test("invalid byte counts and arithmetic overflow fail before a budget claim", () => {
  for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    for (const field of ["stage_bytes", "new_publication_count"])
      assert.throws(() =>
        estimateImportArtifacts({
          stage_bytes: 0,
          definition_rows: 0,
          [field]: value,
        }),
      );
  assert.throws(
    () =>
      estimateImportArtifacts({
        stage_bytes: 0,
        definition_rows: 1,
        new_publication_count: 2,
      }),
    /exceeds the staged definition rows/,
  );
  assert.throws(() =>
    estimateImportArtifacts({
      stage_bytes: Number.MAX_SAFE_INTEGER,
      definition_rows: 1,
    }),
  );
  assert.throws(
    () =>
      estimateImportArtifacts({
        stage_bytes: 0,
        definition_rows: 0,
        retained_carrier_bytes: 1,
      }),
    /carrier count/,
  );
});

test("official rafsi growth enters the proposal and loaded copy estimates", () => {
  const input = {
    stage_bytes: 1024,
    definition_rows: 1,
    new_publication_count: 1,
  };
  const definitions = estimateImportArtifacts(input);
  const claims = estimateImportArtifacts({
    ...input,
    new_rafsi_claim_count: 3,
  });
  assert.equal(
    claims.components.carrier_bytes - definitions.components.carrier_bytes,
    3 * 6144,
  );
  assert.ok(
    claims.components.loaded_copy_bytes >
      definitions.components.loaded_copy_bytes,
  );
  assert.ok(claims.estimated_total_bytes > definitions.estimated_total_bytes);
});
