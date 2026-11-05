#[path = "support/f64_owned.rs"]
mod support;
#[test]
fn owned_steps_and_consuming_transfer() {
    assert!(!support::step_vectors().is_empty());
}
#[test]
fn invalid_steps_cancellation_and_exactly_once_release() {
    assert!(!support::invalid_and_release_vectors().is_empty());
}
#[test]
fn allocation_refusal_and_inclusive_reservations() {
    assert!(!support::allocation_vectors().is_empty());
}
#[test]
fn pending_stages_inclusive_limits_and_incomplete_upper() {
    assert!(!support::limit_vectors().is_empty());
}
#[test]
fn unique_flushing_and_failed_operation_accounting() {
    assert!(!support::flushing_vectors().is_empty());
}
