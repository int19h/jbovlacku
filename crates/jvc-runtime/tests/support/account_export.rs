use super::*;

const ORIGIN: &str = "https://source.example";

fn concentrated_input(n: usize) -> (Fixture, Value, Vec<String>) {
    let mut fixture = Fixture::new();
    let claim = fixture.event(
        1,
        json!({"kind":"account.set","origin":ORIGIN,"account":41,"value":"claim","previous":null,"carry":[]}),
        None,
    );
    let hash = format!("sha256:{}", "f".repeat(64));
    for _ in 0..n {
        fixture.event(10, json!({"kind":"account.observe","origin":ORIGIN,"account":41,"claim":claim,"result":"present"}), Some(json!({
            "origin":ORIGIN,"account":41,"username":"author","field_hash":hash,"markers":[claim],
            "method":"lensisku-public-profile-v1","observed_at":"2026-10-11T00:00:00Z"
        })));
    }
    let mut body: Value = serde_json::from_str(include_str!(
        "../../../jvc-core/tests/fixtures/definition.json"
    ))
    .unwrap();
    body["legacy"] = json!({
        "source":"fixture","snapshot":hash,"extraction":"fixture-v1",
        "record":{"kind":"definition","id":1},"locator":"fixture","original":{},
        "attribution":{"author":"author","editor":null,"author_account":{
            "origin":ORIGIN,"account":41,"username":"author","evidence":{
                "kind":"source-id","source":{"label":"source author numeric field","url":null,"event":null,"locator":"author_id"}
            }
        },"dates":{}},
        "conversion":{"method":"literal","tool":"fixture","version":"1","model":null,
                      "review":"unreviewed","mappings":[],"warnings":[]},"limitations":[]
    });
    let mut ids = Vec::new();
    for i in 1..=n {
        body["legacy"]["record"]["id"] = json!(i);
        ids.push(fixture.event(9, json!({
            "kind":"definition.publish","word":fixture.word,"language":"en","parents":[],"origin":"import"
        }), Some(body.clone())));
    }
    ids.sort();
    let selection = jvc_core::hash_id("sha256:", b"", &canonical_value(&json!(ids)).unwrap());
    fixture.selected_view = fixture.event(20, json!({"kind":"view.publish","parents":[]}), Some(json!({
        "name":"fixture","description":[],"roots":[{"identity":key(30),"q":{"numerator":1,"denominator":1}}],
        "rafsi_threshold":{"numerator":1,"denominator":1},"H":{"numerator":3,"denominator":1},
        "alpha":{"numerator":1,"denominator":2},"excluded":[],"calculation":"simple-routes-bounds-v1",
        "work":1000,"import_sets":[{"source":"fixture","importer":key(9),"selection":selection}],
        "account_witnesses":[key(10)],"account_authority":false,"notes":[]
    })));
    let mut request: Value = serde_json::from_slice(&fixture.bytes()).unwrap();
    request["import_selections"][selection] = json!(ids);
    (fixture, request, ids)
}

#[test]
fn concentrated_account_export_sizes_grow_with_records() {
    let mut previous = None;
    for n in [250, 500, 1000] {
        let (_, request, ids) = concentrated_input(n);
        let bytes = serde_json::to_vec(&request).unwrap();
        let state = jvc_runtime::evaluate_bytes(&bytes).unwrap();
        assert_eq!(state["state_export_version"], 2);
        let controls = state["account_controls"].as_object().unwrap();
        assert_eq!(controls.len(), 1);
        let account = &controls[&format!("{ORIGIN}#41")];
        assert_eq!(account["contributions"].as_array().unwrap().len(), 1);
        assert_eq!(
            account["contributions"][0]["observations"]
                .as_array()
                .unwrap()
                .len(),
            n
        );
        assert_eq!(
            account["certificates"][0]["observations"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        for field in [
            "candidates",
            "contributions",
            "observation_evidence",
            "certificates",
            "chain",
            "current_observations",
        ] {
            assert!(
                state["accounts"][format!("{ORIGIN}#41")]
                    .get(field)
                    .is_none(),
                "{field}"
            );
        }
        for id in ids {
            for row in [
                &state["publication_statuses"][&id],
                &state["publications"][&id],
            ] {
                assert_eq!(
                    row["account_control"],
                    json!({"origin":ORIGIN,"account":41})
                );
                assert_eq!(row["account_authority_applied"], false);
                for field in [
                    "witness_contributions",
                    "controller_candidates",
                    "observations",
                ] {
                    assert!(row.get(field).is_none(), "{field}");
                }
            }
            assert_eq!(
                account["contributions"][0]["observations"]
                    .as_array()
                    .unwrap()
                    .len(),
                n,
                "each disabled status still gives the account's witness evidence"
            );
        }
        let size = serde_json::to_vec(&state).unwrap().len();
        if let Some(previous) = previous {
            assert!(
                size > previous * 19 / 10 && size < previous * 21 / 10,
                "{previous} -> {size}"
            );
        }
        previous = Some(size);
        if let Ok(directory) = std::env::var("JVC_STATE_PARITY_DIR") {
            std::fs::create_dir_all(&directory).unwrap();
            let name = format!("account-export-{n}");
            std::fs::write(
                std::path::Path::new(&directory).join(format!("{name}.json")),
                serde_json::to_vec(&json!({"name":name,"input":request,"expected":state})).unwrap(),
            )
            .unwrap();
        }
    }
}

#[test]
fn account_export_keeps_a_reference_through_restores_and_judgment_deltas() {
    let (mut fixture, mut input, ids) = concentrated_input(4);
    let bytes = serde_json::to_vec(&input).unwrap();
    let parent = jvc_runtime::EvaluationSession::new(&bytes).unwrap();
    let state = jvc_runtime::evaluate_bytes(&bytes).unwrap();
    assert_eq!(state["state_export_version"], 2);
    let records = fixture
        .events
        .iter()
        .map(|wire| {
            let id = serde_json::from_str::<Value>(wire).unwrap()["id"]
                .as_str()
                .unwrap()
                .to_owned();
            serde_json::from_slice::<Value>(
                &jvc_runtime::extract_host_record_bytes(
                    wire.as_bytes(),
                    fixture.bodies.get(&id).map(String::as_bytes),
                )
                .unwrap(),
            )
            .unwrap()
        })
        .collect::<Vec<_>>();
    let full = jvc_runtime::EvaluationSession::restore_host_checkpoint(
        &parent.checkpoint("account-projection").unwrap(),
        "account-projection",
    )
    .unwrap();
    let results = jvc_runtime::EvaluationSession::restore_host_result_checkpoint(
        &parent.result_checkpoint("account-projection").unwrap(),
        "account-projection",
        &serde_json::to_vec(&records).unwrap(),
    )
    .unwrap();
    let options = json!({
        "selected_view":input["selected_view"], "import_selections":input["import_selections"],
        "limits":input["limits"]
    });
    fixture.bless(30, &ids[0]);
    let judgment = fixture.events.last().unwrap();
    input["events"]
        .as_array_mut()
        .unwrap()
        .push(json!(judgment));
    let fresh = jvc_runtime::EvaluationSession::new(&serde_json::to_vec(&input).unwrap()).unwrap();
    for session in [&parent, &full, &results] {
        assert_eq!(
            serde_json::from_str::<Value>(&session.state().unwrap()).unwrap(),
            state
        );
        let mut delta = session
            .fork(&serde_json::to_vec(&options).unwrap())
            .unwrap();
        delta.add_record_text(judgment, None, None).unwrap();
        let advanced = delta.finish();
        let identity = session.state_identity();
        let patch = patched_state(state.clone(), &advanced, &identity);
        assert_eq!(
            patch,
            serde_json::from_str::<Value>(&fresh.state().unwrap()).unwrap()
        );
        assert_eq!(
            advanced.rank(&fixture.word).unwrap(),
            fresh.rank(&fixture.word).unwrap()
        );
    }
}
