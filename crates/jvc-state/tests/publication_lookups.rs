//! Rafsi-pair judgments and managed bridges find their publication by
//! lookup. A scan of the whole publication map for each such record
//! would need records times publications units, which for a real-size
//! dictionary is more than the default budget. These shapes have one
//! judgment or bridge per definition, at a size where that product
//! (16 million units) passes the default budget (about 12 million).

use jvc_core::{BodyAvailability, ContentDescriptor, Header};
use jvc_state::{
    EvaluatedState, EvaluationOptions, HostVerifiedRecord, Interpretation, Limits,
    PreparedEvaluationInput,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

const SIZE: usize = 4_000;

fn record(id: &str, issuer: &str, action: Value) -> HostVerifiedRecord {
    let publish = matches!(
        action["kind"].as_str(),
        Some("definition.publish" | "rafsi.publish")
    );
    let header = Header {
        version: 1,
        issuer: issuer.to_owned(),
        previous: Vec::new(),
        nonce: "00".repeat(16),
        action,
        content: publish.then(|| ContentDescriptor {
            hash: format!("sha256:{}", "a".repeat(64)),
            bytes: 2,
        }),
    };
    let availability = if publish {
        BodyAvailability::Missing
    } else {
        BodyAvailability::Absent
    };
    HostVerifiedRecord::extract_with(id, &header, availability, |_| ()).0
}

fn id(n: usize) -> String {
    format!("jve1:{n:064x}")
}

fn identity(n: usize) -> String {
    format!("ed25519:{n:064x}")
}

fn evaluate(records: &[HostVerifiedRecord]) -> EvaluatedState {
    let mut prepared = PreparedEvaluationInput::new(EvaluationOptions {
        selected_view: format!("jve1:{}", "f".repeat(64)),
        import_selections: BTreeMap::new(),
        overlay: None,
        limits: Limits::default(),
    });
    for r in records {
        prepared.add_host_verified_record(r.clone());
    }
    prepared.into_state()
}

/// `size` native definitions by one author, with IDs that sort before
/// every other record.
fn definitions(size: usize) -> Vec<HostVerifiedRecord> {
    (0..size)
        .map(|i| {
            record(
                &id(1_000_000 + i),
                &identity(1),
                json!({
                    "kind": "definition.publish", "word": format!("jvw1:{i:064x}"),
                    "language": "en", "parents": [], "origin": "native"
                }),
            )
        })
        .collect()
}

/// Work stays linear: twice the records cost at most a little more
/// than twice the units.
fn assert_linear(half: &EvaluatedState, full: &EvaluatedState) {
    assert!(
        full.consumed_work() <= 2 * half.consumed_work() + 1_000,
        "{} units for the full shape, {} for half",
        full.consumed_work(),
        half.consumed_work()
    );
}

fn rafsi_pair_shape(size: usize) -> (Vec<HostVerifiedRecord>, Vec<String>) {
    let mut records = definitions(size);
    // Four claimed pairs whose publications sort after every
    // definition, so a scan in ID order visits every definition
    // before it reaches a claim.
    let pairs: Vec<String> = (1..=4).map(|i| format!("jvr1:{i:064x}")).collect();
    for (i, pair) in pairs.iter().enumerate() {
        records.push(record(
            &format!("jve1:f{i:063x}"),
            &identity(1),
            json!({
                "kind": "rafsi.publish", "word": format!("jvw1:{i:064x}"),
                "assignment": pair, "origin": "native"
            }),
        ));
    }
    let unmatched = format!("jvr1:{:064x}", 99);
    let mut judgments = Vec::new();
    for i in 0..size {
        let target = if i == 0 {
            &unmatched
        } else {
            &pairs[i % pairs.len()]
        };
        let judgment = id(2_000_000 + i);
        records.push(record(
            &judgment,
            &identity(10_000 + i),
            json!({"kind": "judgment.set", "target": target, "value": "bless"}),
        ));
        judgments.push(judgment);
    }
    (records, judgments)
}

#[test]
fn rafsi_pair_judgments_on_a_large_dictionary_evaluate_under_the_default_budget() {
    let (records, judgments) = rafsi_pair_shape(SIZE);
    let state = evaluate(&records);
    let evaluation = state.evaluation();
    // The selected view is missing from the records, so the view is
    // unavailable; the records themselves are evaluated.
    assert!(
        !evaluation.reasons.contains("resource_unavailable"),
        "refused: {:?}, {} of {} units",
        evaluation.reasons,
        state.consumed_work(),
        state.traversal_budget()
    );
    assert!(state.consumed_work() * 10 < state.traversal_budget());
    // The first judgment names an unclaimed pair; every other one
    // names a claimed pair.
    let first = &evaluation.receipts[&judgments[0]];
    assert_eq!(first.interpretation, Interpretation::Pending);
    assert!(first.reasons.contains("target_pending"));
    for judgment in &judgments[1..] {
        assert_eq!(
            evaluation.receipts[judgment].interpretation,
            Interpretation::Effective
        );
    }
    let (half, _) = rafsi_pair_shape(SIZE / 2);
    assert_linear(&evaluate(&half), &state);
}

fn managed_bridge_shape(size: usize) -> (Vec<HostVerifiedRecord>, Vec<String>) {
    let mut records = definitions(size);
    let target = id(1_000_000);
    let mut bridges = Vec::new();
    for i in 0..size {
        let bridge = id(3_000_000 + i);
        records.push(record(
            &bridge,
            &identity(1),
            json!({
                "kind": "bridge.set", "origin": "https://source.example",
                "source_definition": i + 1, "target": target, "value": "managed"
            }),
        ));
        bridges.push(bridge);
    }
    (records, bridges)
}

#[test]
fn managed_bridges_on_a_large_dictionary_evaluate_under_the_default_budget() {
    let (records, bridges) = managed_bridge_shape(SIZE);
    let state = evaluate(&records);
    let evaluation = state.evaluation();
    // The selected view is missing from the records, so the view is
    // unavailable; the records themselves are evaluated.
    assert!(
        !evaluation.reasons.contains("resource_unavailable"),
        "refused: {:?}, {} of {} units",
        evaluation.reasons,
        state.consumed_work(),
        state.traversal_budget()
    );
    assert!(state.consumed_work() * 10 < state.traversal_budget());
    // No imported definition exists, so no bridge finds its source.
    for bridge in &bridges {
        let receipt = &evaluation.receipts[bridge];
        assert_eq!(receipt.interpretation, Interpretation::Pending);
        assert!(receipt.reasons.contains("account_binding_unavailable"));
    }
    let (half, _) = managed_bridge_shape(SIZE / 2);
    assert_linear(&evaluate(&half), &state);
}
