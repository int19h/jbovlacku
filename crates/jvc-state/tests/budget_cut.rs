//! Budget-cut sweep: evaluate small signed fixtures at every explicit
//! traversal limit below the work their covered run uses. Each result
//! must be the covered result or the clean whole-evaluation refusal,
//! with no partial receipts, publications or other state, and every
//! checkpoint of it must restore to the same evaluation. The sweep runs
//! fresh evaluation, an advance (rebuild and fast path), a fork whose
//! base stays alive, and an overlay change.

use jvc_core::{
    BodyAvailability, ContentDescriptor, Header, VerifiedEnvelope, body_descriptor,
    canonical_value, hash_id, identity_from_seed, inspect_body, sign_header, verify_envelope,
    word_id,
};
use jvc_state::{
    EvaluatedState, Evaluation, EvaluationOptions, HostVerifiedRecord, Interpretation, Limits,
    PreparedEvaluationInput,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

fn signed(
    seed: u8,
    nonce: usize,
    previous: Vec<String>,
    action: Value,
    body: Option<&[u8]>,
) -> VerifiedEnvelope {
    let event = signed_with_content(
        seed,
        nonce,
        previous,
        action,
        body.map(|bytes| body_descriptor(bytes).unwrap()),
    );
    if let Some(bytes) = body {
        assert!(matches!(
            inspect_body(&event, Some(bytes)),
            BodyAvailability::Valid { .. }
        ));
    }
    event
}

fn signed_with_content(
    seed: u8,
    nonce: usize,
    mut previous: Vec<String>,
    action: Value,
    content: Option<ContentDescriptor>,
) -> VerifiedEnvelope {
    previous.sort();
    let header = Header {
        version: 1,
        issuer: identity_from_seed(&[seed; 32]),
        previous,
        nonce: format!("{nonce:032x}"),
        action,
        content,
    };
    let raw = sign_header(&[seed; 32], header)
        .unwrap()
        .canonical_envelope()
        .unwrap();
    verify_envelope(&raw).unwrap()
}

type Record = (VerifiedEnvelope, Option<Vec<u8>>);

fn view(import_sets: Value) -> Record {
    witnessed_view(import_sets, &[])
}

/// A view whose account witnesses are the identities of `witnesses`.
/// With witnesses, the view also gives accounts authority.
fn witnessed_view(import_sets: Value, witnesses: &[u8]) -> Record {
    let account_witnesses: Vec<String> = witnesses
        .iter()
        .map(|seed| identity_from_seed(&[*seed; 32]))
        .collect();
    let body = canonical_value(&json!({
        "name": "sweep", "description": [], "roots": [],
        "rafsi_threshold": {"numerator": 1, "denominator": 1},
        "H": {"numerator": 3, "denominator": 1},
        "alpha": {"numerator": 1, "denominator": 2},
        "excluded": [], "calculation": "simple-routes-bounds-v1", "work": 1000,
        "import_sets": import_sets, "account_witnesses": account_witnesses,
        "account_authority": !witnesses.is_empty(), "notes": []
    }))
    .unwrap();
    let event = signed(
        3,
        1,
        vec![],
        json!({"kind": "view.publish", "parents": []}),
        Some(&body),
    );
    (event, Some(body))
}

fn definition(seed: u8) -> Record {
    let body: Value = serde_json::from_str(include_str!(
        "../../jvc-core/tests/fixtures/definition.json"
    ))
    .unwrap();
    let word = word_id(&body["word"]).unwrap();
    let bytes = canonical_value(&body).unwrap();
    let event = signed(
        seed,
        2,
        vec![],
        json!({
            "kind": "definition.publish", "word": word, "parents": [],
            "origin": "native", "language": "en"
        }),
        Some(&bytes),
    );
    (event, Some(bytes))
}

/// A view, a definition, eight chained judgments by issuer A, A's
/// transfer to B and B's acceptance: the records whose retention checks
/// charge once a transfer exists.
fn transfer_fixture() -> (Vec<Record>, BTreeMap<String, Vec<String>>) {
    let (view, view_body) = view(json!([]));
    let (definition, definition_body) = definition(2);
    let mut records = vec![(view, view_body), (definition.clone(), definition_body)];
    let mut previous: Vec<String> = Vec::new();
    for i in 0..8 {
        let judgment = signed(
            5,
            100 + i,
            previous.clone(),
            json!({"kind": "judgment.set", "target": definition.id(), "value": "bless"}),
            None,
        );
        previous = vec![judgment.id().to_owned()];
        records.push((judgment, None));
    }
    let transfer = signed(
        5,
        4,
        previous,
        json!({"kind": "identity.transfer", "successor": identity_from_seed(&[6; 32])}),
        None,
    );
    let accept = signed(
        6,
        5,
        vec![],
        json!({"kind": "identity.accept", "transfer": transfer.id()}),
        None,
    );
    records.push((transfer, None));
    records.push((accept, None));
    (records, BTreeMap::new())
}

/// A view whose import sets name three invalid lists and then a valid
/// one, and a definition.
fn selection_fixture() -> (Vec<Record>, BTreeMap<String, Vec<String>>) {
    let valid: Vec<String> = (0..64).map(|i| format!("jve1:{i:064x}")).collect();
    let valid_digest = hash_id("sha256:", b"", &canonical_value(&json!(valid)).unwrap());
    let mut selections: BTreeMap<String, Vec<String>> = (0..3)
        .map(|i| (format!("sha256:{:064x}", i + 1), vec![String::new(); 20]))
        .collect();
    selections.insert(valid_digest.clone(), valid);
    let importer = identity_from_seed(&[3; 32]);
    let mut import_sets: Vec<Value> = (0..3)
        .map(|i| {
            json!({"source": format!("{i:03}"), "importer": importer, "selection": format!("sha256:{:064x}", i + 1)})
        })
        .collect();
    import_sets.push(json!({"source": "003", "importer": importer, "selection": valid_digest}));
    let (view, view_body) = view(json!(import_sets));
    let (definition, definition_body) = definition(2);
    (
        vec![(view, view_body), (definition, definition_body)],
        selections,
    )
}

/// A witnessed view, an account that two witnesses observe for
/// author A, A's native definition, an imported definition credited
/// to that account, A's managed bridge from that import to the native
/// definition, a rafsi-pair claim, and last a judgment on the pair:
/// the records whose targets are found by publication lookup. The
/// last record takes the fast path.
fn lookup_fixture() -> (Vec<Record>, BTreeMap<String, Vec<String>>) {
    const ORIGIN: &str = "https://source.example";
    let (view, view_body) = witnessed_view(json!([]), &[10, 11]);
    let (definition, definition_body) = definition(2);
    let claim = signed(
        2,
        3,
        vec![],
        json!({
            "kind": "account.set", "origin": ORIGIN, "account": 41, "value": "claim",
            "previous": null, "carry": []
        }),
        None,
    );
    let claim_id = claim.id().to_owned();
    let observation = |seed: u8| {
        let body = canonical_value(&json!({
            "origin": ORIGIN, "account": 41, "username": "author",
            "field_hash": format!("sha256:{}", "f".repeat(64)),
            "markers": [claim_id], "method": "lensisku-public-profile-v1",
            "observed_at": "2026-10-11T00:00:00Z"
        }))
        .unwrap();
        let event = signed(
            seed,
            1,
            vec![],
            json!({
                "kind": "account.observe", "origin": ORIGIN, "account": 41,
                "claim": claim_id, "result": "present"
            }),
            Some(&body),
        );
        (event, Some(body))
    };
    let mut import_body: Value = serde_json::from_str(include_str!(
        "../../jvc-core/tests/fixtures/definition.json"
    ))
    .unwrap();
    import_body["legacy"] = json!({
        "source": "fixture", "snapshot": format!("sha256:{}", "f".repeat(64)),
        "extraction": "fixture-v1", "record": {"kind": "definition", "id": 1},
        "locator": "fixture", "original": {},
        "attribution": {
            "author": "author", "editor": null,
            "author_account": {
                "origin": ORIGIN, "account": 41, "username": "author",
                "evidence": {"kind": "source-id", "source": {
                    "label": "source author numeric field", "url": null, "event": null,
                    "locator": "author_id"
                }}
            },
            "dates": {}
        },
        "conversion": {
            "method": "literal", "tool": "fixture", "version": "1", "model": null,
            "review": "unreviewed", "mappings": [], "warnings": []
        },
        "limitations": []
    });
    let word = word_id(&import_body["word"]).unwrap();
    let import_bytes = canonical_value(&import_body).unwrap();
    let imported = signed(
        9,
        2,
        vec![],
        json!({
            "kind": "definition.publish", "word": word, "parents": [],
            "origin": "import", "language": "en"
        }),
        Some(&import_bytes),
    );
    let bridge = signed(
        2,
        4,
        vec![],
        json!({
            "kind": "bridge.set", "origin": ORIGIN, "source_definition": 1,
            "target": definition.id(), "value": "managed"
        }),
        None,
    );
    // The rafsi claim's body is not supplied: the pair is claimed, and
    // the claim's content is unavailable.
    let pair = format!("jvr1:{}", "7".repeat(64));
    let rafsi = signed_with_content(
        4,
        1,
        vec![],
        json!({
            "kind": "rafsi.publish", "word": word, "assignment": pair, "origin": "native"
        }),
        Some(ContentDescriptor {
            hash: format!("sha256:{}", "a".repeat(64)),
            bytes: 2,
        }),
    );
    let judgment = signed(
        5,
        1,
        vec![],
        json!({"kind": "judgment.set", "target": pair, "value": "bless"}),
        None,
    );
    let records = vec![
        (view, view_body),
        (definition, definition_body),
        (claim, None),
        observation(10),
        observation(11),
        (imported, Some(import_bytes)),
        (bridge, None),
        (rafsi, None),
        (judgment, None),
    ];
    (records, BTreeMap::new())
}

fn options(
    records: &[Record],
    selections: &BTreeMap<String, Vec<String>>,
    traversal: Option<usize>,
    overlay: Option<&Value>,
) -> EvaluationOptions {
    EvaluationOptions {
        selected_view: records[0].0.id().to_owned(),
        import_selections: selections.clone(),
        overlay: overlay.cloned().map(Into::into),
        limits: Limits {
            traversal,
            ..Limits::default()
        },
    }
}

fn prepared(records: &[Record], options: EvaluationOptions) -> PreparedEvaluationInput {
    let mut prepared = PreparedEvaluationInput::new(options);
    for (event, body) in records {
        prepared.add_record(event, body.as_deref());
    }
    prepared
}

fn host_records(records: &[Record]) -> Vec<HostVerifiedRecord> {
    records
        .iter()
        .map(|(event, body)| {
            HostVerifiedRecord::extract_with(
                event.id(),
                event.header(),
                inspect_body(event, body.as_deref()),
                |_| (),
            )
            .0
        })
        .collect()
}

/// Both checkpoint formats of `state` restore to the same evaluation.
fn check_restores(state: &EvaluatedState, records: &[Record], context: &str) {
    let full =
        EvaluatedState::restore_host_checkpoint(&state.checkpoint("sweep").unwrap(), "sweep")
            .unwrap_or_else(|e| panic!("{context}: full checkpoint refused: {e:?}"));
    assert_eq!(
        full.evaluation(),
        state.evaluation(),
        "{context}: full restore"
    );
    let results = EvaluatedState::restore_host_result_checkpoint(
        &state.result_checkpoint("sweep").unwrap(),
        "sweep",
        host_records(records),
    )
    .unwrap_or_else(|e| panic!("{context}: results checkpoint refused: {e:?}"));
    assert_eq!(
        results.evaluation(),
        state.evaluation(),
        "{context}: results restore"
    );
}

/// `actual` is the covered result or the clean refusal.
fn check_outcome(actual: &Evaluation, covered: &Evaluation, refused: &Evaluation, context: &str) {
    assert!(
        actual == covered || actual == refused,
        "{context}: neither the covered result nor the clean refusal: available={} reasons={:?} receipts={}",
        actual.available,
        actual.reasons,
        actual.receipts.len()
    );
}

fn sweep(name: &str, records: &[Record], selections: &BTreeMap<String, Vec<String>>) -> usize {
    let overlay = json!({
        "version": 1, "base_view": records[0].0.id(), "trust": [], "blocked": [], "work": null,
        "root_changes": [{"identity": identity_from_seed(&[5; 32]), "q": null}]
    });
    let covered = prepared(records, options(records, selections, None, None)).into_state();
    assert!(covered.evaluation().available, "{name}: covered run");
    let work = covered.consumed_work();
    let covered_overlay =
        prepared(records, options(records, selections, None, Some(&overlay))).into_state();
    let refused = prepared(records, options(records, selections, Some(0), None)).into_state();
    let refused_overlay = prepared(
        records,
        options(records, selections, Some(0), Some(&overlay)),
    )
    .into_state();
    assert!(
        refused.evaluation().receipts.is_empty(),
        "{name}: clean refusal"
    );
    let split = records.len() - 2;
    for limit in 0..=work {
        let context = format!("{name} limit={limit}");
        let at = |overlay: Option<&Value>| options(records, selections, Some(limit), overlay);
        // Fresh evaluation.
        let fresh = prepared(records, at(None)).into_state();
        if limit < work {
            assert_eq!(fresh.evaluation(), refused.evaluation(), "{context}: fresh");
        } else {
            assert_eq!(fresh.evaluation(), covered.evaluation(), "{context}: fresh");
        }
        check_restores(&fresh, records, &format!("{context} fresh"));
        // Advance in two batch cuts: all but the last two records,
        // then the rest; and all but the last record, then that one.
        // Each batch takes the fast path or rebuilds, as its records
        // allow; both must equal the fresh evaluation.
        for cut in [split, records.len() - 1] {
            let base = prepared(&records[..cut], at(None)).into_state();
            let next = base.advance(prepared(&records[cut..], at(None)), &[]);
            assert_eq!(
                next.evaluation(),
                fresh.evaluation(),
                "{context}: advance after {cut} records"
            );
            check_restores(&next, records, &format!("{context} advance {cut}"));
        }
        // Fork: the base stays alive, so the append pays for copies.
        let base = prepared(&records[..records.len() - 1], at(None)).into_state();
        let holder = base.clone();
        let fork = base.advance(prepared(&records[records.len() - 1..], at(None)), &[]);
        check_outcome(
            fork.evaluation(),
            covered.evaluation(),
            refused.evaluation(),
            &format!("{context} fork"),
        );
        check_restores(&fork, records, &format!("{context} fork"));
        drop(holder);
        // Overlay change on the fresh state.
        let changed = fresh.with_overlay(Some(overlay.clone()));
        let fresh_overlay = prepared(records, at(Some(&overlay))).into_state();
        assert_eq!(
            changed.evaluation(),
            fresh_overlay.evaluation(),
            "{context}: overlay change"
        );
        check_outcome(
            changed.evaluation(),
            covered_overlay.evaluation(),
            refused_overlay.evaluation(),
            &format!("{context} overlay"),
        );
        check_restores(&changed, records, &format!("{context} overlay"));
    }
    work
}

#[test]
fn every_limit_below_the_covered_work_gives_the_covered_result_or_the_clean_refusal() {
    let started = std::time::Instant::now();
    let (records, selections) = transfer_fixture();
    let transfer_work = sweep("transfer", &records, &selections);
    let (records, selections) = selection_fixture();
    let selection_work = sweep("selection", &records, &selections);
    let (records, selections) = lookup_fixture();
    // The covered run finds both targets: the judgment's pair and the
    // bridge's imported source.
    let covered = prepared(&records, options(&records, &selections, None, None)).into_state();
    for index in [6, 8] {
        let receipt = &covered.evaluation().receipts[records[index].0.id()];
        assert_eq!(
            (&receipt.interpretation, receipt.reasons.is_empty()),
            (&Interpretation::Effective, true),
            "{:?}",
            receipt.reasons
        );
    }
    let lookup_work = sweep("lookup", &records, &selections);
    eprintln!(
        "transfer fixture: limits 0..={transfer_work}; selection fixture: limits 0..={selection_work}; lookup fixture: limits 0..={lookup_work}; {:?}",
        started.elapsed()
    );
}

#[test]
fn an_overlay_on_a_refused_evaluation_keeps_the_clean_refusal() {
    // Zero records, a zero budget and a selected view that is absent:
    // the evaluation refuses. The public `Evaluation::with_overlay` with
    // an invalid overlay must keep the single refusal reason, as the
    // session method (which rebuilds) does.
    let options = EvaluationOptions {
        selected_view: format!("jve1:{}", "0".repeat(64)),
        import_selections: BTreeMap::new(),
        overlay: None,
        limits: Limits {
            traversal: Some(0),
            ..Limits::default()
        },
    };
    let state = PreparedEvaluationInput::new(options).into_state();
    let refusal = std::collections::BTreeSet::from(["resource_unavailable".to_owned()]);
    assert_eq!(state.evaluation().reasons, refusal);
    let overlay = std::rc::Rc::new(json!({}));
    let direct = state
        .evaluation()
        .with_overlay(Some(overlay.clone()), |_| false);
    assert!(!direct.available);
    assert_eq!(direct.reasons, refusal);
    assert!(direct.receipts.is_empty());
    let session = state.with_overlay(Some(json!({})));
    assert_eq!(&direct, session.evaluation());
}
