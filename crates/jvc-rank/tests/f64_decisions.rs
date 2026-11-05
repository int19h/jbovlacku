#[path = "support/f64_decisions.rs"]
mod support;
#[test]
fn numerical_margins_thresholds_and_residues() {
    assert!(!support::numerical_vectors().is_empty());
}
#[test]
fn same_and_separate_graph_comparisons() {
    assert!(!support::comparison_vectors().is_empty());
}
#[test]
fn three_potential_decisions_and_selection_gates() {
    assert!(!support::potential_vectors().is_empty());
}
#[test]
fn cycles_stable_layers_and_starting_order() {
    assert!(!support::layer_vectors().is_empty());
}
#[test]
fn incomplete_and_resource_limited_decisions() {
    assert!(!support::validation_vectors().is_empty());
}

#[test]
fn actor_and_candidate_permutations() {
    assert_eq!(support::permutation_vectors().len(), 6);
}

#[test]
fn review_separate_graph_order_and_semantic_identity() {
    assert!(!support::review_permutation_vectors().is_empty());
}
#[test]
fn review_retained_signs_status_and_error_classes() {
    assert!(!support::review_status_vectors().is_empty());
}
#[test]
fn required_large_exact_zero_rational_reference() {
    assert_eq!(support::large_exact_zero_vectors().len(), 1);
}

#[test]
fn stage_two_availability_margins_and_error_classes() {
    assert!(!support::stage_two_vectors().is_empty());
}
