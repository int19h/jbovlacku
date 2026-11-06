//! Heap regression windows exclude the test harness and input construction.
#![cfg(unix)]
#[allow(dead_code)]
#[path = "../examples/support/setup_measurement.rs"]
mod measurement;

#[test]
fn small_indexes_and_tree_splits_fit_the_admission_envelope() {
    let coverage = measurement::small_shapes();
    assert_eq!(coverage.cases, 420);
    #[cfg(target_pointer_width = "64")]
    assert!(coverage.tree_nodes.into_iter().all(|count| count > 0));
}
