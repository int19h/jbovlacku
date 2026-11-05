#[path = "support/f64_rows.rs"]
mod rows;

#[test]
fn row_preparation_matches_versioned_golden_bits() {
    let expected: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/f64-rows-v1.json")).unwrap();
    assert_eq!(rows::vectors(), expected);
}
