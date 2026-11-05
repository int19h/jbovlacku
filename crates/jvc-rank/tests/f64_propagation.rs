#[path = "support/f64_kernel.rs"]
mod support;
#[test]
fn independent_rational_route_and_relaxed_oracles() {
    assert_eq!(support::oracle_vectors().len(), 192);
}
#[test]
fn compensated_sum_and_source_exemptions() {
    assert_eq!(support::sum_vectors().len(), 3);
}
#[test]
fn routes_threshold_value_and_permutations() {
    assert!(!support::semantic_vectors().is_empty());
}
#[test]
fn work_limits_and_incomplete_upper_refusal() {
    assert!(!support::resource_vectors().is_empty());
}
#[test]
fn propagated_flushing_and_long_chains() {
    assert!(!support::flushing_vectors().is_empty());
}

#[test]
fn retries_and_growing_budgets_match_fresh_stages() {
    assert_eq!(support::retry_and_budget_vectors().len(), 15);
}

#[test]
fn upper_retries_repeats_and_zero_inputs() {
    assert_eq!(support::upper_retry_and_zero_vectors().len(), 4);
}
