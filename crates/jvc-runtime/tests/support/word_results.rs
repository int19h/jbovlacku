use super::*;
use jvc_runtime::{
    EvaluationSession, RankingPreparationLimits, RankingPreparationPolicy, WordResultPolicy,
    WordResultRequest,
};
fn setup(f: &Fixture) -> (EvaluationSession, WordResultRequest) {
    let session = EvaluationSession::new(&f.bytes()).unwrap();
    let descriptor = session
        .ranking_descriptor_native(&RankingPreparationPolicy {
            core_binding: format!("sha256:{}", "a".repeat(64)),
            limits: RankingPreparationLimits::default(),
        })
        .unwrap();
    let summary = session
        .prepare_ranking_native(&jvc_runtime::RankingPreparationRequest {
            owner_session: descriptor.owner_session.clone(),
            descriptor_binding: descriptor.binding.clone(),
            word: f.word.clone(),
        })
        .unwrap();
    (
        session,
        WordResultRequest {
            owner_session: descriptor.owner_session,
            descriptor_binding: descriptor.binding,
            preparation_id: summary.preparation_id,
            policy: WordResultPolicy::default(),
        },
    )
}
fn fixture() -> (Fixture, String, String) {
    let mut f = Fixture::new();
    let a = f.definition("en");
    let b = f.definition("en");
    f.trust(1, 2, "heed", "en");
    f.bless(2, &a);
    f.bless(1, &b);
    f.view(jvc_rank::approximate::ALGORITHM, &[1], 1000);
    (f, a, b)
}
fn run(session: &EvaluationSession, request: &WordResultRequest, step: u64) -> Value {
    let start = session.start_word_results_native(request).unwrap();
    let token = start["token"].as_str().unwrap();
    let mut previous = (0, 0, 0);
    for _ in 0..200000 {
        let p = session.step_word_results_native(token, step).unwrap();
        let now = (
            p["numerical_operations"].as_u64().unwrap(),
            p["flushed_terms"].as_u64().unwrap(),
            p["completed"].as_u64().unwrap(),
        );
        assert!(now.0 >= previous.0 && now.1 >= previous.1 && now.2 >= previous.2);
        previous = now;
        if p["phase"] != "running" {
            assert_eq!(p["phase"], "ready", "{p}");
            let bytes = session.take_word_result_native(token).unwrap();
            assert!(bytes.len() <= request.policy.output_bytes);
            assert!(session.take_word_result_native(token).is_err());
            return serde_json::from_slice(&bytes).unwrap();
        }
    }
    panic!("word did not terminate")
}
fn export(f: &Fixture, name: &str, policy: &WordResultPolicy, result: &Value) {
    if let Ok(dir) = std::env::var("JVC_WORD_RESULT_PARITY_DIR") {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(std::path::Path::new(&dir).join(format!("{name}.json")),serde_json::to_vec(&json!({"input":String::from_utf8(f.bytes()).unwrap(),"word":f.word,"policy":policy,"expected":result})).unwrap()).unwrap();
    }
}
#[test]
fn owned_word_scores_layers_comparisons_and_reviewer_details() {
    let (f, a, b) = fixture();
    let (s, r) = setup(&f);
    let aggregate = run(&s, &r, 1);
    assert_eq!(aggregate["layers"], json!([[a], [b]]));
    assert_eq!(aggregate["layers_complete"], true);
    assert_eq!(aggregate["numerically_approximate"], true);
    assert_eq!(aggregate["certified"], false);
    assert!(aggregate["progress"].get("token").is_none());
    assert_eq!(aggregate["scores"].as_array().unwrap().len(), 2);
    assert!(aggregate["scores"][0].get("reviewers").is_none());
    assert_eq!(aggregate["comparisons"].as_array().unwrap().len(), 1);
    export(&f, "aggregate", &r.policy, &aggregate);
    let (s, mut r) = setup(&f);
    r.policy.reviewers = Some(1);
    let reviewed = run(&s, &r, 65536);
    assert_ne!(aggregate["binding"], reviewed["binding"]);
    for score in reviewed["scores"].as_array().unwrap() {
        assert_eq!(score["reviewers"].as_array().unwrap().len(), 1);
        assert_eq!(score["reviewers_complete"], true);
    }
    assert_eq!(aggregate["layers"], reviewed["layers"]);
    export(&f, "reviewers", &r.policy, &reviewed);
    let (s, mut r) = setup(&f);
    r.policy.reviewers = Some(0);
    let zero = run(&s, &r, 7);
    assert_eq!(zero["scores"][0]["reviewers"], json!([]));
    assert_eq!(zero["scores"][0]["reviewers_complete"], false);
    export(&f, "zero-reviewers", &r.policy, &zero);
}
#[test]
fn invalid_steps_and_tokens_do_not_mutate_active_attempts() {
    let (f, _, _) = fixture();
    let (s, r) = setup(&f);
    let p = s.start_word_results_native(&r).unwrap();
    let token = p["token"].as_str().unwrap();
    let before = s.word_result_progress().unwrap();
    assert!(s.step_word_results_native(token, 0).is_err());
    assert!(s.step_word_results_native("stale", 1).is_err());
    assert!(s.cancel_word_results_native("stale").is_err());
    assert!(s.take_word_result_native(token).is_err());
    assert_eq!(s.word_result_progress().unwrap(), before);
    assert_eq!(
        s.start_word_results_native(&r).unwrap_err().code,
        "ranking_busy"
    );
    assert_eq!(
        s.cancel_word_results_native(token).unwrap()["phase"],
        "cancelled"
    );
    assert_eq!(s.word_result_progress().unwrap(), "null");
}
#[test]
fn same_graph_contexts_reuse_one_owned_outcome_and_work_count() {
    let mut f = Fixture::new();
    let a = f.definition("en");
    let b = f.definition("fr");
    f.trust(1, 2, "heed", "*");
    f.bless(2, &a);
    f.bless(2, &b);
    f.view(jvc_rank::approximate::ALGORITHM, &[1], 1000);
    let (s, r) = setup(&f);
    let result = run(&s, &r, 3);
    assert_eq!(result["progress"]["graphs_computed"], 1);
    assert_eq!(result["progress"]["in_call_reuse"], 1);
    assert_eq!(
        result["progress"]["numerical_operations"],
        result["progress"]["graphs"][0]["numerical_operations"]
    );
    assert_eq!(result["scores"].as_array().unwrap().len(), 2);
    export(&f, "in-call-reuse", &r.policy, &result);
}
#[test]
fn incomplete_upper_never_publishes_a_score_and_partial_layers_are_explicit() {
    let mut f = Fixture::new();
    let a = f.definition("en");
    let b = f.definition("fr");
    f.trust(1, 2, "heed", "en");
    f.trust(1, 3, "heed", "fr");
    f.bless(2, &a);
    f.bless(3, &b);
    f.view(jvc_rank::approximate::ALGORITHM, &[1], 1000);
    let (s, r) = setup(&f);
    let baseline = run(&s, &r, 65536);
    let first = baseline["progress"]["graphs"][0]["numerical_operations"]
        .as_u64()
        .unwrap();
    let (s, mut r) = setup(&f);
    r.policy.numerical_operations = first + 1;
    let partial = run(&s, &r, 1);
    assert_eq!(partial["partial"], true);
    assert_eq!(partial["layers_complete"], false);
    assert_eq!(partial["scores"].as_array().unwrap().len(), 1);
    assert_eq!(partial["scores"][0]["target"], a);
    assert_eq!(partial["unavailable_scores"][0]["target"], b);
    assert_eq!(partial["comparisons"], json!([]));
    export(&f, "partial-upper", &r.policy, &partial);
}
#[test]
fn incomplete_route_exploration_with_complete_upper_is_a_usable_range() {
    let mut f = Fixture::new();
    let a = f.definition("en");
    f.trust(1, 2, "heed", "en");
    f.trust(1, 3, "heed", "en");
    f.bless(2, &a);
    f.view(jvc_rank::approximate::ALGORITHM, &[1], 1);
    let (s, r) = setup(&f);
    let v = run(&s, &r, 17);
    assert_eq!(v["progress"]["graphs"][0]["exploration_complete"], false);
    assert_eq!(v["progress"]["graphs"][0]["upper_complete"], true);
    assert_eq!(v["scores"].as_array().unwrap().len(), 1);
    assert_eq!(v["layers_complete"], true);
    export(&f, "incomplete-exploration", &r.policy, &v);
}
#[test]
fn deterministic_caps_refuse_before_retaining_native_results() {
    let (f, _, _) = fixture();
    for limit in ["output", "terms", "memory", "pairs", "targets", "reviewers"] {
        let (s, mut r) = setup(&f);
        match limit {
            "output" => r.policy.output_bytes = 1,
            "terms" => r.policy.actor_terms = 1,
            "memory" => r.policy.memory_bytes = 1,
            "pairs" => r.policy.comparisons = 0,
            "targets" => r.policy.targets = 1,
            _ => {
                r.policy.reviewers = Some(2);
                r.policy.reviewer_terms = 0;
            }
        }
        assert_eq!(
            s.start_word_results_native(&r).unwrap_err().code,
            "resource_unavailable",
            "{limit}"
        );
        assert_eq!(s.word_result_progress().unwrap(), "null");
        // A valid but refused start leaves the same prepared graphs available.
        r.policy = WordResultPolicy::default();
        let result = run(&s, &r, 4096);
        assert_eq!(result["scores"].as_array().unwrap().len(), 2);
    }
}
#[test]
fn binding_changes_and_forks_drop_native_work_without_touching_evaluation() {
    let (f, _, _) = fixture();
    let (s, r) = setup(&f);
    let before = s.state().unwrap();
    let checkpoint = s.checkpoint("word").unwrap();
    s.start_word_results_native(&r).unwrap();
    s.step_word_results_native(&r.preparation_id, 1).unwrap();
    let options =
        canonical_value(&json!({"selected_view":f.selected_view,"import_selections":{}})).unwrap();
    let child = s.fork(&options).unwrap().finish();
    assert_eq!(child.word_result_progress().unwrap(), "null");
    assert_eq!(s.state().unwrap(), before);
    assert_eq!(s.checkpoint("word").unwrap(), checkpoint);
    let mut policy = RankingPreparationPolicy {
        core_binding: format!("sha256:{}", "a".repeat(64)),
        limits: RankingPreparationLimits::default(),
    };
    policy.limits.records = 1;
    assert!(s.ranking_descriptor_native(&policy).is_err());
    assert_eq!(s.word_result_progress().unwrap(), "null");
}

fn rafsi_fixture() -> (Fixture, String, String, String) {
    let (mut f, a, _) = fixture();
    let mut pairs = Vec::new();
    let mut publications = Vec::new();
    for rafsi in ["ban", "bal"] {
        let pair = jvc_core::rafsi_pair_id(&f.word, rafsi).unwrap();
        let id=f.event(9,json!({"kind":"rafsi.publish","word":f.word,"assignment":pair,"origin":"native"}),Some(json!({"word":{"language":"jbo","spelling":"banli"},"rafsi":rafsi,"rationale":[],"sources":[],"legacy":null})));
        pairs.push(pair);
        publications.push(id);
    }
    f.bless(1, &pairs[0]);
    f.event(
        1,
        json!({"kind":"judgment.set","target":pairs[1],"value":"curse"}),
        None,
    );
    (f, a, pairs[0].clone(), publications[1].clone())
}
#[test]
fn rafsi_pairs_expose_independent_potential_and_threshold_decisions() {
    let (f, _, positive, _) = rafsi_fixture();
    let (s, r) = setup(&f);
    let v = run(&s, &r, 4096);
    let score = v["scores"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["target"] == positive)
        .unwrap();
    assert_eq!(score["actual_positive_support"], "positive");
    assert_eq!(score["eligible_potential"], "possible");
    assert!(score["threshold_margin"].is_object());
    assert!(v.get("selected_rafsi").is_none());
    assert_eq!(v["rafsi_scope"], "requested_word");
    assert_eq!(v["layers_complete"], true);
    export(&f, "rafsi-decisions", &r.policy, &v);
}
#[test]
fn missing_rafsi_upper_does_not_make_definition_layers_incomplete() {
    let (f, _, _, _) = rafsi_fixture();
    let (s, r) = setup(&f);
    let baseline = run(&s, &r, 65536);
    let first = baseline["progress"]["graphs"][0]["numerical_operations"]
        .as_u64()
        .unwrap();
    let (s, mut r) = setup(&f);
    r.policy.numerical_operations = first + 1;
    let v = run(&s, &r, 1);
    assert_eq!(v["partial"], true);
    assert_eq!(v["layers_complete"], true);
    assert!(v.get("selected_rafsi").is_none());
    assert_eq!(v["scores"].as_array().unwrap().len(), 2);
    export(&f, "rafsi-unavailable-only", &r.policy, &v);
}
#[test]
fn unresolved_rafsi_retains_potential_without_a_zero_placeholder() {
    let (mut f, _, _, publication) = rafsi_fixture();
    let pair = serde_json::from_str::<Value>(
        f.events
            .iter()
            .find(|s| serde_json::from_str::<Value>(s).unwrap()["id"] == publication)
            .unwrap(),
    )
    .unwrap()["header"]["action"]["assignment"]
        .clone();
    let previous = serde_json::from_str::<Value>(f.events.last().unwrap()).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    // Replace the curse with a positive unresolved competitor.
    f.event_after(
        1,
        vec![previous],
        json!({"kind":"judgment.set","target":pair,"value":"bless"}),
        None,
    );
    f.bodies.remove(&publication);
    let (s, r) = setup(&f);
    let v = run(&s, &r, 7);
    assert!(v.get("selected_rafsi").is_none());
    assert_eq!(v["layers_complete"], true);
    assert_eq!(v["unresolved_rafsi"][0]["potential"], "possible");
    assert!(
        v["unavailable_scores"]
            .as_array()
            .unwrap()
            .iter()
            .any(|u| u["target"] == pair)
    );
    export(&f, "rafsi-unknown", &r.policy, &v);
}

#[test]
fn known_inactive_pairs_do_not_make_a_complete_retired_word_partial() {
    let (mut f, _, _, _) = rafsi_fixture();
    let mut definitions: Vec<String> = f
        .events
        .iter()
        .filter_map(|event| {
            let event: Value = serde_json::from_str(event).unwrap();
            (event["header"]["action"]["kind"] == "definition.publish")
                .then(|| event["id"].as_str().unwrap().to_owned())
        })
        .collect();
    for definition in &definitions {
        f.event_after(
            9,
            vec![definition.clone()],
            json!({"kind":"status.set","target":definition,"value":"deprecated"}),
            None,
        );
    }
    definitions.sort();
    let (s, r) = setup(&f);
    let v = run(&s, &r, 11);
    assert_eq!(v["partial"], false);
    assert_eq!(v["layers_complete"], true);
    assert_eq!(v["layers"], json!([definitions]));
    assert_eq!(v["inactive_targets"].as_array().unwrap().len(), 2);
    assert_eq!(v["scores"].as_array().unwrap().len(), 2);
    for score in v["scores"].as_array().unwrap() {
        assert_eq!(score["support"], json!([0.0, 0.0]));
    }
    export(&f, "inactive-pairs", &r.policy, &v);
}
