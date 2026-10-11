#[test]
fn malformed_overlay_is_unavailable_without_a_panic() {
    let result = jvc_runtime::evaluate_bytes(include_bytes!("invalid-overlay.json")).unwrap();
    assert_eq!(result["available"], false);
    assert!(
        result["reasons"]
            .as_array()
            .unwrap()
            .iter()
            .any(|reason| reason == "invalid_overlay")
    );
}
