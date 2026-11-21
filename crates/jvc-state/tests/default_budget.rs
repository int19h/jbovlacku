//! Inputs that the default work budget must evaluate, and account
//! evidence that the evaluation and the status export must share
//! instead of copying per publication.

use jvc_core::{
    BodyAvailability, ContentDescriptor, Header, body_descriptor, canonical_value, hash_id,
};
use jvc_state::{
    EvaluatedState, EvaluationOptions, HostVerifiedRecord, Limits, PreparedEvaluationInput,
    publication_status, publication_status_ref,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

const ORIGIN: &str = "https://source.example";

fn id(n: usize) -> String {
    format!("jve1:{n:064x}")
}

/// A real identity, so that checkpoint restore can validate the bodies
/// that name it.
fn identity(n: usize) -> String {
    jvc_core::identity_from_seed(&[u8::try_from(n).unwrap(); 32])
}

fn record(
    id: &str,
    issuer: &str,
    previous: Vec<String>,
    action: Value,
    body: Option<Value>,
) -> HostVerifiedRecord {
    let header = Header {
        version: 1,
        issuer: issuer.to_owned(),
        previous,
        nonce: "00".repeat(16),
        action,
        content: body
            .as_ref()
            .map(|body| body_descriptor(&canonical_value(body).unwrap()).unwrap()),
    };
    let availability = match body {
        Some(body) => BodyAvailability::Valid { body },
        None => BodyAvailability::Absent,
    };
    HostVerifiedRecord::extract_with(id, &header, availability, |_| ()).0
}

const VIEW: usize = 1;
const IMPORTER: usize = 9;

fn view(import_sets: Vec<Value>, witnesses: &[usize]) -> HostVerifiedRecord {
    let mut witnesses: Vec<String> = witnesses.iter().map(|w| identity(*w)).collect();
    witnesses.sort();
    record(
        &id(VIEW),
        &identity(VIEW),
        vec![],
        json!({"kind": "view.publish", "parents": []}),
        Some(json!({
            "name": "fixture", "description": [], "roots": [],
            "rafsi_threshold": {"numerator": 1, "denominator": 1},
            "H": {"numerator": 3, "denominator": 1},
            "alpha": {"numerator": 1, "denominator": 2},
            "excluded": [], "calculation": "simple-routes-bounds-v1", "work": 1000,
            "import_sets": import_sets, "account_witnesses": witnesses,
            "account_authority": !witnesses.is_empty(), "notes": []
        })),
    )
}

/// The digest of a selection of `ids`, and the sorted list.
fn selection(ids: &[String]) -> (String, Vec<String>) {
    let mut ids = ids.to_vec();
    ids.sort();
    let digest = hash_id("sha256:", b"", &canonical_value(&json!(ids)).unwrap());
    (digest, ids)
}

/// An imported definition from source `fixture`, record `record`,
/// credited to account 41 at `ORIGIN`.
fn import(n: usize, record_id: u64) -> HostVerifiedRecord {
    let mut body: Value = serde_json::from_str(include_str!(
        "../../jvc-core/tests/fixtures/definition.json"
    ))
    .unwrap();
    body["legacy"] = json!({
        "source": "fixture", "snapshot": format!("sha256:{}", "f".repeat(64)),
        "extraction": "fixture-v1", "record": {"kind": "definition", "id": record_id},
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
    let word = jvc_core::word_id(&body["word"]).unwrap();
    record(
        &id(n),
        &identity(IMPORTER),
        vec![],
        json!({
            "kind": "definition.publish", "word": word, "language": "en",
            "parents": [], "origin": "import"
        }),
        Some(body),
    )
}

fn evaluate(
    records: &[HostVerifiedRecord],
    selections: &BTreeMap<String, Vec<String>>,
    traversal: Option<usize>,
) -> EvaluatedState {
    let mut prepared = PreparedEvaluationInput::new(EvaluationOptions {
        selected_view: id(VIEW),
        import_selections: selections.clone(),
        overlay: None,
        limits: Limits {
            traversal,
            ..Limits::default()
        },
    });
    for r in records {
        prepared.add_host_verified_record(r.clone());
    }
    prepared.into_state()
}

fn refused(state: &EvaluatedState) -> bool {
    state.evaluation().reasons.contains("resource_unavailable")
}

/// The default budget grows by more per added record than the
/// evaluation's work does, so the shape fits at any size.
fn assert_fits_at_any_size(name: &str, small: &EvaluatedState, large: &EvaluatedState) {
    assert!(!refused(small) && !refused(large), "{name}: refused");
    let work = large.consumed_work() - small.consumed_work();
    let budget = large.traversal_budget() - small.traversal_budget();
    assert!(
        work < budget,
        "{name}: {work} more units of work, {budget} more units of budget"
    );
}

#[test]
fn a_selection_that_several_entries_name_is_charged_once() {
    let ids: Vec<String> = (0..1_000).map(|i| id(1_000_000 + i)).collect();
    let (digest, ids) = selection(&ids);
    let selections = BTreeMap::from([(digest.clone(), ids)]);
    let entry = |i: usize| json!({"source": format!("s{i}"), "importer": identity(IMPORTER), "selection": digest});
    let one = evaluate(&[view(vec![entry(0)], &[])], &selections, Some(1_500));
    let two = evaluate(
        &[view(vec![entry(0), entry(1)], &[])],
        &selections,
        Some(1_500),
    );
    assert!(!refused(&one) && !refused(&two));
    // The second entry costs its own unit and nothing for the selection.
    assert_eq!(two.consumed_work(), one.consumed_work() + 1);
    let selections_of = |state: &EvaluatedState| {
        serde_json::to_value(state.evaluation()).unwrap()["selections"].clone()
    };
    assert_eq!(selections_of(&one), selections_of(&two));

    // Under the default budget: 600 entries that name one selection of
    // 20,000 IDs. Charged per entry, that is 12 million units.
    let ids: Vec<String> = (0..20_000).map(|i| id(2_000_000 + i)).collect();
    let (digest, ids) = selection(&ids);
    let selections = BTreeMap::from([(digest.clone(), ids)]);
    let entries: Vec<Value> = (0..600)
        .map(|i| json!({"source": format!("s{i}"), "importer": identity(IMPORTER), "selection": digest}))
        .collect();
    let state = evaluate(&[view(entries, &[])], &selections, None);
    assert!(
        !refused(&state),
        "{} of {} units",
        state.consumed_work(),
        state.traversal_budget()
    );
}

/// A view with 512 import entries: one selects every import, the rest
/// name other sources with an empty selection.
fn many_entries(imports: usize) -> EvaluatedState {
    let mut records = Vec::new();
    let mut ids = Vec::new();
    for i in 0..imports {
        records.push(import(1_000_000 + i, i as u64 + 1));
        ids.push(id(1_000_000 + i));
    }
    let (all, all_ids) = selection(&ids);
    let (empty, empty_ids) = selection(&[]);
    let mut entries =
        vec![json!({"source": "fixture", "importer": identity(IMPORTER), "selection": all})];
    for i in 1..512 {
        entries.push(json!({"source": format!("source-{i:05}"), "importer": identity(IMPORTER), "selection": empty}));
    }
    records.push(view(entries, &[]));
    evaluate(
        &records,
        &BTreeMap::from([(all, all_ids), (empty, empty_ids)]),
        None,
    )
}

#[test]
fn many_import_entries_cost_work_linear_in_the_imports() {
    let small = many_entries(500);
    let large = many_entries(1_000);
    // Every import is selected.
    assert!(
        large
            .evaluation()
            .publications
            .values()
            .all(|p| p.eligible == jvc_state::Eligibility::Eligible)
    );
    assert_fits_at_any_size("512 import entries", &small, &large);
}

/// `records` judgments, each naming the same 64 absent predecessors.
fn absent_predecessors(records: usize) -> EvaluatedState {
    let absent: Vec<String> = (0..64).map(|i| id(9_000_000 + i)).collect();
    let mut input = vec![view(vec![], &[])];
    for i in 0..records {
        input.push(record(
            &id(1_000_000 + i),
            &identity(2),
            absent.clone(),
            json!({"kind": "judgment.set", "target": id(5_000 + i % 7), "value": "bless"}),
            None,
        ));
    }
    evaluate(&input, &BTreeMap::new(), None)
}

#[test]
fn records_with_64_absent_predecessors_fit_the_default_budget() {
    let small = absent_predecessors(500);
    let large = absent_predecessors(1_000);
    assert_fits_at_any_size("64 absent predecessors", &small, &large);
}

/// One account claim that `witnesses` witnesses each observe, and
/// `imports` imported definitions credited to the account.
fn account_fixture(
    claims: usize,
    witnesses: usize,
    imports: usize,
) -> (Vec<HostVerifiedRecord>, BTreeMap<String, Vec<String>>) {
    let mut records = Vec::new();
    let mut next = 2_000_000;
    let claim_ids: Vec<String> = (0..claims)
        .map(|c| {
            let claim = id(next + c);
            records.push(record(
                &claim,
                &identity(100 + c),
                vec![],
                json!({
                    "kind": "account.set", "origin": ORIGIN, "account": 41, "value": "claim",
                    "previous": null, "carry": []
                }),
                None,
            ));
            claim
        })
        .collect();
    next += claims;
    for w in 0..witnesses {
        for claim in &claim_ids {
            records.push(record(
                &id(next),
                &identity(10 + w),
                vec![],
                json!({
                    "kind": "account.observe", "origin": ORIGIN, "account": 41,
                    "claim": claim, "result": "present"
                }),
                Some(json!({
                    "origin": ORIGIN, "account": 41, "username": "author",
                    "field_hash": format!("sha256:{}", "f".repeat(64)),
                    "markers": [claim], "method": "lensisku-public-profile-v1",
                    "observed_at": "2026-10-11T00:00:00Z"
                })),
            ));
            next += 1;
        }
    }
    let ids: Vec<String> = (0..imports)
        .map(|i| {
            records.push(import(1_000_000 + i, i as u64 + 1));
            id(1_000_000 + i)
        })
        .collect();
    let (digest, ids) = selection(&ids);
    let witness_seeds: Vec<usize> = (0..witnesses).map(|w| 10 + w).collect();
    records.push(view(
        vec![json!({"source": "fixture", "importer": identity(IMPORTER), "selection": digest})],
        &witness_seeds,
    ));
    (records, BTreeMap::from([(digest, ids)]))
}

/// Every credited publication points at its account's one map.
fn assert_shared(state: &EvaluatedState, context: &str) {
    let e = state.evaluation();
    let mut credited = 0;
    for p in e.publications.values() {
        let Some(account) = &p.account else { continue };
        let state = &e.accounts[&format!("{}#{}", account.origin, account.account)];
        if p.witness_contributions.is_empty() {
            continue;
        }
        assert!(
            std::rc::Rc::ptr_eq(&p.witness_contributions, &state.contributions),
            "{context}: {} holds its own copy",
            p.id
        );
        credited += 1;
    }
    assert!(credited > 0, "{context}: no credited publication");
}

#[test]
fn account_contributions_are_shared_by_every_credited_publication() {
    let (records, selections) = account_fixture(8, 8, 40);
    let state = evaluate(&records, &selections, None);
    assert!(
        state.evaluation().available,
        "{:?}",
        state.evaluation().reasons
    );
    let account = state.evaluation().accounts.values().next().unwrap();
    assert_eq!(account.contributions.len(), 8);
    assert_eq!(
        account
            .contributions
            .values()
            .map(|c| c.len())
            .sum::<usize>(),
        64
    );
    assert_shared(&state, "evaluation");
    let full =
        EvaluatedState::restore_host_checkpoint(&state.checkpoint("shared").unwrap(), "shared")
            .unwrap();
    assert_eq!(full.evaluation(), state.evaluation());
    assert_shared(&full, "full checkpoint");
    let results = EvaluatedState::restore_host_result_checkpoint(
        &state.result_checkpoint("shared").unwrap(),
        "shared",
        records,
    )
    .unwrap();
    assert_eq!(results.evaluation(), state.evaluation());
    assert_shared(&results, "results checkpoint");
}

/// Seals `value` with a fresh digest, as `checkpoint` does.
fn sealed(mut value: Value) -> Vec<u8> {
    value.as_object_mut().unwrap().remove("digest");
    let mut bytes = serde_json::to_vec(&value).unwrap();
    let digest = hash_id("sha256:", b"", &bytes);
    bytes.pop();
    bytes.extend_from_slice(format!(",\"digest\":\"{digest}\"}}").as_bytes());
    bytes
}

#[test]
fn checkpoints_store_each_account_map_once_and_refuse_a_publication_copy() {
    let (records, selections) = account_fixture(8, 8, 40);
    let state = evaluate(&records, &selections, None);
    let account =
        serde_json::to_value(state.evaluation().accounts.values().next().unwrap()).unwrap();
    for (results_only, bytes) in [
        (false, state.checkpoint("shared").unwrap()),
        (true, state.result_checkpoint("shared").unwrap()),
    ] {
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        let publications = value["evaluation"]["publications"].as_object().unwrap();
        assert_eq!(publications.len(), 40);
        assert!(
            publications
                .values()
                .all(|p| p.get("witness_contributions").is_none())
        );
        let restore = |bytes: &[u8]| {
            if results_only {
                EvaluatedState::restore_host_result_checkpoint(bytes, "shared", records.clone())
            } else {
                EvaluatedState::restore_host_checkpoint(bytes, "shared")
            }
        };
        assert!(restore(&sealed(value.clone())).is_ok());
        // A publication that carries its own map is refused, even when
        // the map equals the account's.
        let mut copied = value.clone();
        let first = copied["evaluation"]["publications"]
            .as_object_mut()
            .unwrap()
            .values_mut()
            .find(|p| !p["account"].is_null())
            .unwrap();
        first["witness_contributions"] = account["contributions"].clone();
        assert!(
            restore(&sealed(copied)).is_err(),
            "results_only={results_only}"
        );
        // An explicit empty map is refused too: checkpoints never
        // write the field, and this publication's account has claims.
        let mut empty = value.clone();
        empty["evaluation"]["publications"]
            .as_object_mut()
            .unwrap()
            .values_mut()
            .find(|p| !p["account"].is_null())
            .unwrap()["witness_contributions"] = json!({});
        assert!(
            restore(&sealed(empty)).is_err(),
            "results_only={results_only}: an explicit empty map was accepted"
        );
    }
}

#[test]
fn the_borrowed_status_export_writes_the_same_json_as_the_owned_status() {
    // Many observations of one claim by one witness, and many claims
    // observed by many witnesses.
    for (claims, witnesses, imports) in [(1, 1, 30), (40, 1, 30), (8, 8, 30)] {
        let (records, selections) = account_fixture(claims, witnesses, imports);
        let state = evaluate(&records, &selections, None);
        let e = state.evaluation();
        let mut observations = 0;
        for id in e.publications.keys() {
            let owned = publication_status(e, id).unwrap();
            observations += owned
                .witness_contributions
                .iter()
                .map(|c| c.observations.len())
                .sum::<usize>();
            let borrowed = publication_status_ref(e, id).unwrap();
            assert_eq!(
                serde_json::to_string(&borrowed).unwrap(),
                serde_json::to_string(&owned).unwrap(),
                "{id}"
            );
        }
        assert!(observations > 0, "{claims} claims: no exported observation");
        assert!(publication_status_ref(e, &id(7)).is_none());
    }
}

/// An imported definition whose body is missing: a fresh evaluation
/// gives it no source, record or account.
fn import_without_body(n: usize) -> HostVerifiedRecord {
    let word = jvc_core::word_id(&json!({"language": "jbo", "spelling": "klama"})).unwrap();
    let header = Header {
        version: 1,
        issuer: identity(IMPORTER),
        previous: vec![],
        nonce: "00".repeat(16),
        action: json!({
            "kind": "definition.publish", "word": word, "language": "en",
            "parents": [], "origin": "import"
        }),
        content: Some(ContentDescriptor {
            hash: format!("sha256:{}", "a".repeat(64)),
            bytes: 2,
        }),
    };
    HostVerifiedRecord::extract_with(&id(n), &header, BodyAvailability::Missing, |_| ()).0
}

#[test]
fn restore_refuses_an_attribution_on_an_import_without_a_body() {
    let (mut records, selections) = account_fixture(2, 2, 3);
    let missing = id(3_000_000);
    records.push(import_without_body(3_000_000));
    let state = evaluate(&records, &selections, None);
    let e = state.evaluation();
    let bare = &e.publications[&missing];
    assert!(!bare.content_available && bare.account.is_none() && bare.source.is_none());
    assert!(bare.witness_contributions.is_empty());
    for (results_only, bytes) in [
        (false, state.checkpoint("bare").unwrap()),
        (true, state.result_checkpoint("bare").unwrap()),
    ] {
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        let restore = |bytes: &[u8]| {
            if results_only {
                EvaluatedState::restore_host_result_checkpoint(bytes, "bare", records.clone())
            } else {
                EvaluatedState::restore_host_checkpoint(bytes, "bare")
            }
        };
        assert!(restore(&sealed(value.clone())).is_ok());
        let credited = value["evaluation"]["publications"]
            .as_object()
            .unwrap()
            .values()
            .find(|p| !p["account"].is_null())
            .unwrap()
            .clone();
        // Each field that a body would supply, copied from a credited
        // import onto the import without a body.
        for field in ["account", "source", "source_record"] {
            let mut copied = value.clone();
            copied["evaluation"]["publications"][&missing][field] = credited[field].clone();
            assert!(
                restore(&sealed(copied)).is_err(),
                "results_only={results_only}: a saved {field} was accepted"
            );
        }
        // Each field that only the account pass sets, which a fresh
        // evaluation leaves empty without an account.
        let claim = id(2_000_000);
        for (field, saved) in [
            ("controller", json!(identity(100))),
            ("claim", json!(claim)),
            ("authority", json!("source-account")),
            ("observations", json!([claim])),
            ("status_frontier", json!([claim])),
            ("deciding_claim", json!(claim)),
            ("controller_candidates", json!([claim])),
            ("missing", json!([claim])),
        ] {
            let mut copied = value.clone();
            copied["evaluation"]["publications"][&missing][field] = saved;
            assert!(
                restore(&sealed(copied)).is_err(),
                "results_only={results_only}: a saved {field} was accepted"
            );
        }
    }
}

/// The ID of witness `w`'s observation of claim `c` in
/// `account_fixture(claims, ..)`.
fn observation_id(claims: usize, w: usize, c: usize) -> String {
    id(2_000_000 + claims + w * claims + c)
}

#[test]
fn restore_refuses_evidence_that_is_not_the_witness_observation() {
    let token = format!("{ORIGIN}#41");
    let w0 = identity(10);
    // Two witnesses observe two claims. The first witness's evidence is
    // replaced by the second witness's observation of the first claim,
    // and its contribution by that one claim.
    let (records, selections) = account_fixture(2, 2, 3);
    let swapped = |value: &mut Value| {
        let account = &mut value["evaluation"]["accounts"][&token];
        account["observation_evidence"][&w0] = json!([observation_id(2, 1, 0)]);
        account["contributions"][&w0] = json!([id(2_000_000)]);
    };
    assert_evidence_refused(&records, &selections, &swapped);
    // One claim: only the observation ID changes, to the second
    // witness's observation of the same claim.
    let (records, selections) = account_fixture(1, 2, 3);
    let renamed = |value: &mut Value| {
        value["evaluation"]["accounts"][&token]["observation_evidence"][&w0] =
            json!([observation_id(1, 1, 0)]);
    };
    assert_evidence_refused(&records, &selections, &renamed);
    // Two claims: the first witness's observation of the second claim,
    // and that claim, are cut from its evidence and its contribution.
    // What is left is valid on its own, but a fresh evaluation gives
    // the witness both claims.
    let (records, selections) = account_fixture(2, 2, 3);
    let cut = |value: &mut Value| {
        let account = &mut value["evaluation"]["accounts"][&token];
        account["observation_evidence"][&w0] = json!([observation_id(2, 0, 0)]);
        account["contributions"][&w0] = json!([id(2_000_000)]);
    };
    assert_evidence_refused(&records, &selections, &cut);
}

fn assert_evidence_refused(
    records: &[HostVerifiedRecord],
    selections: &BTreeMap<String, Vec<String>>,
    mutate: &dyn Fn(&mut Value),
) {
    let state = evaluate(records, selections, None);
    let w0 = identity(10);
    let account = state.evaluation().accounts.values().next().unwrap();
    // The fixture's IDs are the ones the mutation replaces.
    assert!(account.observation_evidence[&w0].contains(&observation_id(
        account.candidates.len(),
        0,
        0
    )));
    for (results_only, bytes) in [
        (false, state.checkpoint("evidence").unwrap()),
        (true, state.result_checkpoint("evidence").unwrap()),
    ] {
        let restore = |bytes: &[u8]| {
            if results_only {
                EvaluatedState::restore_host_result_checkpoint(bytes, "evidence", records.to_vec())
            } else {
                EvaluatedState::restore_host_checkpoint(bytes, "evidence")
            }
        };
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert!(restore(&sealed(value.clone())).is_ok());
        let mut changed = value;
        mutate(&mut changed);
        assert!(
            restore(&sealed(changed)).is_err(),
            "results_only={results_only}: changed witness evidence was accepted"
        );
    }
}
