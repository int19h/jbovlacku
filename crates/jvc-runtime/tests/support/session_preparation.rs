//! Session preparation uses the existing authenticated state and no numerical results.
use super::*;
use jvc_runtime::{
    EvaluationSession, EvaluationSessionBuilder, RankingPreparationDescriptor,
    RankingPreparationLimits, RankingPreparationPolicy, RankingPreparationRequest,
    RankingPreparationSummary,
};

fn policy() -> RankingPreparationPolicy {
    RankingPreparationPolicy {
        core_binding: format!("sha256:{}", "a".repeat(64)),
        limits: RankingPreparationLimits::default(),
    }
}
fn options(f: &Fixture) -> Vec<u8> {
    canonical_value(
        &json!({"selected_view":f.selected_view,"import_selections":{},"overlay":f.overlay}),
    )
    .unwrap()
}
fn request(d: &RankingPreparationDescriptor, word: &str) -> RankingPreparationRequest {
    RankingPreparationRequest {
        owner_session: d.owner_session.clone(),
        descriptor_binding: d.binding.clone(),
        word: word.into(),
    }
}
fn prepared(s: &EvaluationSession, word: &str) -> RankingPreparationSummary {
    let d = s.ranking_descriptor_native(&policy()).unwrap();
    assert!(d.available, "{:?}", d.reasons);
    s.prepare_ranking_native(&request(&d, word)).unwrap()
}
fn normalized<T: serde::Serialize>(value: &T) -> Value {
    let mut value = serde_json::to_value(value).unwrap();
    value.as_object_mut().unwrap().remove("owner_session");
    value.as_object_mut().unwrap().remove("preparation_id");
    value
}
fn export(f: &Fixture, name: &str, summary: &RankingPreparationSummary) {
    export_with_policy(f, name, summary, &policy());
}
fn export_with_policy(
    f: &Fixture,
    name: &str,
    summary: &RankingPreparationSummary,
    selected_policy: &RankingPreparationPolicy,
) {
    let mut input = jvc_state::PreparedEvaluationInput::new(jvc_state::EvaluationOptions {
        selected_view: f.selected_view.clone(),
        overlay: f.overlay.clone(),
        import_selections: BTreeMap::new(),
        limits: jvc_state::Limits::default(),
    });
    for envelope in &f.events {
        let event = jvc_core::verify_envelope(envelope.as_bytes()).unwrap();
        input.add_record(&event, f.bodies.get(event.id()).map(|b| b.as_bytes()));
    }
    let state = input.into_state();
    state.ensure_ranking_index().unwrap();
    for context in &summary.contexts {
        let indexed = state
            .prepare_indexed_approximate_context(&context.context)
            .unwrap();
        let direct = jvc_state::prepare_approximate_context(state.evaluation(), &context.context);
        assert_eq!(
            serde_json::to_value(&indexed).unwrap(),
            serde_json::to_value(&direct).unwrap()
        );
    }
    if let Ok(directory) = std::env::var("JVC_PREPARATION_PARITY_DIR") {
        std::fs::create_dir_all(&directory).unwrap();
        let session = EvaluationSession::new(&f.bytes()).unwrap();
        let descriptor = session.ranking_descriptor_native(selected_policy).unwrap();
        let native = session
            .prepare_ranking_native(&request(&descriptor, &f.word))
            .unwrap();
        assert_eq!(normalized(summary), normalized(&native));
        let data = json!({"input":String::from_utf8(f.bytes()).unwrap(),"word":f.word,"policy":selected_policy,"descriptor":normalized(&descriptor),"summary":normalized(&native)});
        std::fs::write(
            std::path::Path::new(&directory).join(format!("{name}.json")),
            serde_json::to_vec(&data).unwrap(),
        )
        .unwrap();
    }
}
fn fixture() -> (Fixture, String) {
    let mut f = Fixture::new();
    let target = f.definition("en");
    f.trust(1, 2, "heed", "en");
    f.trust(2, 3, "shun", "en");
    f.bless(2, &target);
    f.view(jvc_rank::approximate::ALGORITHM, &[1], 1000);
    (f, target)
}

#[test]
fn fresh_fork_restore_and_compact_records_share_semantic_bindings() {
    let (f, _) = fixture();
    let parent = EvaluationSession::new(&f.bytes()).unwrap();
    let checkpoint = parent.checkpoint("host-inventory-core").unwrap();
    let state = parent.state().unwrap();
    let baseline = prepared(&parent, &f.word);
    assert_eq!(baseline.contexts.len(), 1);
    assert!(baseline.contexts[0].available);
    assert_eq!(baseline.contexts[0].edges, 1);
    assert_eq!(baseline.contexts[0].refusals, 1);
    assert_eq!(parent.state().unwrap(), state);
    assert_eq!(
        parent.checkpoint("host-inventory-core").unwrap(),
        checkpoint
    );
    let child = parent.fork(&options(&f)).unwrap().finish();
    let restored =
        EvaluationSession::restore_host_checkpoint(&checkpoint, "host-inventory-core").unwrap();
    // These compact records contain no signatures. Preparation cannot authenticate them again.
    let mut compact = Vec::new();
    let mut trusted = EvaluationSessionBuilder::new(&options(&f)).unwrap();
    for envelope in &f.events {
        let id = serde_json::from_str::<Value>(envelope).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let body = f.bodies.get(&id).map(|b| b.as_bytes());
        let record = jvc_runtime::extract_host_record_bytes(envelope.as_bytes(), body).unwrap();
        assert!(
            !String::from_utf8(record.clone())
                .unwrap()
                .contains("signature")
        );
        trusted.add_host_verified_record(&record).unwrap();
        compact.push(serde_json::from_slice::<Value>(&record).unwrap());
    }
    let trusted = trusted.finish();
    let result_checkpoint = parent.result_checkpoint("host-results").unwrap();
    let results = EvaluationSession::restore_host_result_checkpoint(
        &result_checkpoint,
        "host-results",
        &serde_json::to_vec(&compact).unwrap(),
    )
    .unwrap();
    for other in [&child, &restored, &trusted, &results] {
        assert_eq!(other.ranking_preparation().unwrap(), "null");
        assert_eq!(normalized(&prepared(other, &f.word)), normalized(&baseline));
        assert_ne!(other.state_identity(), parent.state_identity());
    }
    export(&f, "fresh-fork-restore", &baseline);
}

#[test]
fn effective_receipts_filter_targets_before_contexts_and_late_bodies_rebuild() {
    let (mut f, visible) = fixture();
    let hidden = f.definition_after(6, Vec::new(), "fr");
    let transfer = f.event(
        6,
        json!({"kind":"identity.transfer","successor":key(10)}),
        None,
    );
    let after = f.definition_after(6, vec![transfer], "fr");
    let pending = f.definition_after(7, vec![format!("jve1:{}", "f".repeat(64))], "fr");
    let late = f.definition_after(8, Vec::new(), "fr");
    let body = f.bodies.remove(&late).unwrap();
    for target in [&hidden, &after, &pending, &late] {
        f.bless(2, target);
    }
    let parent = EvaluationSession::new(&f.bytes()).unwrap();
    let before = prepared(&parent, &f.word);
    assert_eq!(
        before.targets.iter().map(|t| &t.id).collect::<Vec<_>>(),
        vec![&visible]
    );
    assert_eq!(before.contexts.len(), 1);
    export(&f, "effective-receipts-missing-body", &before);
    f.bodies.insert(late.clone(), body.clone());
    let mut fork = parent.fork(&options(&f)).unwrap();
    let envelope = f
        .events
        .iter()
        .find(|e| serde_json::from_str::<Value>(e).unwrap()["id"] == late)
        .unwrap();
    fork.add_record(envelope.as_bytes(), Some(body.into_bytes()))
        .unwrap();
    let child = fork.finish();
    let child_summary = prepared(&child, &f.word);
    assert_eq!(
        normalized(&child_summary),
        normalized(&prepared(
            &EvaluationSession::new(&f.bytes()).unwrap(),
            &f.word
        ))
    );
    assert_eq!(child_summary.targets.len(), 2);
    assert!(
        child_summary
            .targets
            .iter()
            .any(|t| t.id == late && t.eligible)
    );
    assert_eq!(child_summary.contexts.len(), 2);
    assert_ne!(child_summary.binding, before.binding);
    assert_eq!(normalized(&prepared(&parent, &f.word)), normalized(&before));
    export(&f, "late-body", &child_summary);
}

#[test]
fn judgment_forks_and_selected_policy_changes_invalidate_all_preparation() {
    let (mut f, target) = fixture();
    let parent = EvaluationSession::new(&f.bytes()).unwrap();
    let descriptor = parent.ranking_descriptor_native(&policy()).unwrap();
    let before = prepared(&parent, &f.word);
    f.bless(4, &target);
    let mut builder = parent.fork(&options(&f)).unwrap();
    builder
        .add_record(f.events.last().unwrap().as_bytes(), None)
        .unwrap();
    let child = builder.finish();
    assert_eq!(child.ranking_preparation().unwrap(), "null");
    assert_eq!(
        child
            .prepare_ranking_native(&request(&descriptor, &f.word))
            .unwrap_err()
            .code,
        "ranking_preparation"
    );
    let changed = prepared(&child, &f.word);
    assert_ne!(changed.descriptor_binding, before.descriptor_binding);
    assert_ne!(
        changed.contexts[0].context_binding,
        before.contexts[0].context_binding
    );
    assert_eq!(changed.contexts[0].actors, before.contexts[0].actors + 1);
    assert_eq!(
        normalized(&changed),
        normalized(&prepared(
            &EvaluationSession::new(&f.bytes()).unwrap(),
            &f.word
        ))
    );
    export(&f, "judgment-fork", &changed);
    f.view(jvc_rank::approximate::ALGORITHM, &[2], 500);
    let mut builder = child.fork(&options(&f)).unwrap();
    let envelope = f.events.last().unwrap();
    let body = f.bodies.get(&f.selected_view).unwrap();
    builder
        .add_record(envelope.as_bytes(), Some(body.as_bytes().to_vec()))
        .unwrap();
    let policy_child = builder.finish();
    let changed_policy = prepared(&policy_child, &f.word);
    assert_ne!(
        changed_policy.descriptor_binding,
        changed.descriptor_binding
    );
    assert_eq!(
        policy_child
            .ranking_descriptor_native(&policy())
            .unwrap()
            .parameters
            .unwrap()
            .work,
        500
    );
    assert_eq!(
        normalized(&changed_policy),
        normalized(&prepared(
            &EvaluationSession::new(&f.bytes()).unwrap(),
            &f.word
        ))
    );
    export(&f, "selected-policy-fork", &changed_policy);
}

#[test]
fn private_overlays_bind_weights_blocks_roots_and_work_without_changing_parent() {
    let (mut f, _) = fixture();
    let parent = EvaluationSession::new(&f.bytes()).unwrap();
    let site = prepared(&parent, &f.word);
    for (i, overlay) in [
        json!({"version":1,"base_view":f.selected_view,"root_changes":[],"trust":[],"blocked":[],"work":null}),
        json!({"version":2,"base_view":f.selected_view,"public_shun_issuer":key(2),"root_changes":[{"identity":key(1),"q":{"numerator":2,"denominator":1}}],"trust":[{"issuer":key(1),"subject":key(2),"scope":{"kind":"definition","word":"*","language":"*"},"value":"heed","weight":{"numerator":2,"denominator":3}}],"blocked":[{"identity":key(3),"scope":{"kind":"definition","word":"*","language":"*"}}],"work":700}),
    ].into_iter().enumerate() {
        f.overlay = Some(overlay);
        let fork = parent.fork(&options(&f)).unwrap().finish();
        let summary = prepared(&fork, &f.word);
        assert_eq!(fork.ranking_descriptor_native(&policy()).unwrap().mode, "personal");
        assert_ne!(summary.descriptor_binding, site.descriptor_binding);
        assert_eq!(normalized(&summary), normalized(&prepared(&EvaluationSession::new(&f.bytes()).unwrap(), &f.word)));
        assert_eq!(normalized(&prepared(&parent, &f.word)), normalized(&site));
        export(&f, &format!("private-overlay-{i}"), &summary);
    }
}

#[test]
fn exact_profiles_reject_float_preparation_and_keep_exact_dispatch() {
    for profile in ["simple-routes-bounds-v1", "simple-routes-shun-v1"] {
        let mut f = Fixture::new();
        let target = f.definition("en");
        f.bless(1, &target);
        f.view(profile, &[1], 1000);
        let session = EvaluationSession::new(&f.bytes()).unwrap();
        let before = session.rank(&f.word).unwrap();
        let descriptor = session.ranking_descriptor_native(&policy()).unwrap();
        assert!(!descriptor.available);
        assert!(descriptor.reasons.contains("unsupported_calculation"));
        assert_eq!(
            session
                .prepare_ranking_native(&request(&descriptor, &f.word))
                .unwrap_err()
                .code,
            "unsupported_calculation"
        );
        assert_eq!(session.rank(&f.word).unwrap(), before);
        assert_eq!(
            serde_json::from_str::<Value>(&before).unwrap(),
            jvc_runtime::rank_word_bytes(&f.bytes(), &f.word).unwrap()
        );
    }
    let (f, _) = fixture();
    assert_eq!(
        jvc_runtime::rank_word_bytes(&f.bytes(), &f.word)
            .unwrap_err()
            .code,
        "unsupported_calculation"
    );
}

#[test]
fn stale_requests_fail_before_replacement_and_policy_changes_drop_preparation() {
    let (f, _) = fixture();
    let session = EvaluationSession::new(&f.bytes()).unwrap();
    let descriptor = session.ranking_descriptor_native(&policy()).unwrap();
    prepared(&session, &f.word);
    let before = session.ranking_preparation().unwrap();
    for field in ["owner", "binding", "word"] {
        let mut request = request(&descriptor, &f.word);
        match field {
            "owner" => request.owner_session.push('x'),
            "binding" => request.descriptor_binding.push('x'),
            _ => request.word = "invalid".into(),
        }
        assert!(session.prepare_ranking_native(&request).is_err());
        assert_eq!(session.ranking_preparation().unwrap(), before);
    }
    assert_eq!(
        session.ranking_descriptor_native(&policy()).unwrap(),
        descriptor
    );
    assert_eq!(session.ranking_preparation().unwrap(), before);
    let mut invalid = policy();
    invalid.limits.contexts = 0;
    assert_eq!(
        session
            .ranking_descriptor_native(&invalid)
            .unwrap_err()
            .code,
        "ranking_policy"
    );
    assert_eq!(session.ranking_preparation().unwrap(), before);
    let mut new_policy = policy();
    new_policy.core_binding = format!("sha256:{}", "b".repeat(64));
    let changed = session.ranking_descriptor_native(&new_policy).unwrap();
    assert_ne!(changed.binding, descriptor.binding);
    assert_eq!(
        session
            .prepare_ranking_native(&request(&descriptor, &f.word))
            .unwrap_err()
            .code,
        "stale_binding"
    );
    let metadata: Value = serde_json::from_str(&session.ranking_preparation().unwrap()).unwrap();
    assert!(metadata["prepared"].is_null());
    assert_eq!(metadata["retained_graphs"], 0);
    let replaced = session
        .prepare_ranking_native(&request(&changed, &f.word))
        .unwrap();
    let restored_policy = session.ranking_descriptor_native(&policy()).unwrap();
    let next = session
        .prepare_ranking_native(&request(&restored_policy, &f.word))
        .unwrap();
    assert_eq!(restored_policy.binding, descriptor.binding);
    assert_ne!(next.preparation_id, replaced.preparation_id);
    assert!(next.preparation_id.ends_with("preparation-3"));
    session.clear_ranking_preparation();
    session.clear_ranking_preparation();
    let metadata: Value = serde_json::from_str(&session.ranking_preparation().unwrap()).unwrap();
    assert_eq!(metadata["retained_graphs"], 0);
    assert!(metadata["prepared"].is_null());
}

#[test]
fn inclusive_preparation_limits_refuse_before_context_allocation() {
    let (mut f, _) = fixture();
    f.definition("fr");
    let session = EvaluationSession::new(&f.bytes()).unwrap();
    let baseline = prepared(&session, &f.word);
    let d = session.ranking_descriptor_native(&policy()).unwrap();
    let mut exact = policy();
    exact.limits.records = d.setup.setup_records;
    exact.limits.setup_bytes = d.setup.setup_bytes as usize;
    exact.limits.units = baseline.usage.charged_units;
    exact.limits.setup_units = baseline.usage.setup_units;
    exact.limits.word_publications = baseline.usage.visited_publications;
    exact.limits.targets = baseline.targets.len();
    exact.limits.contexts = baseline.contexts.len();
    exact.limits.graph_bytes = baseline.usage.graph_bytes as usize;
    let descriptor = session.ranking_descriptor_native(&exact).unwrap();
    let bounded = session
        .prepare_ranking_native(&request(&descriptor, &f.word))
        .unwrap();
    assert_eq!(bounded.usage, baseline.usage);
    for limit in [
        "records",
        "setup_bytes",
        "setup_units",
        "units",
        "word_publications",
        "targets",
        "contexts",
        "graph_bytes",
        "metadata_bytes",
    ] {
        let mut policy = exact.clone();
        match limit {
            "records" => policy.limits.records -= 1,
            "setup_bytes" => policy.limits.setup_bytes -= 1,
            "setup_units" => policy.limits.setup_units -= 1,
            "units" => policy.limits.units -= 1,
            "word_publications" => policy.limits.word_publications -= 1,
            "targets" => policy.limits.targets -= 1,
            "contexts" => policy.limits.contexts -= 1,
            "graph_bytes" => policy.limits.graph_bytes -= 1,
            _ => policy.limits.metadata_bytes = 1,
        }
        let result = session
            .ranking_descriptor_native(&policy)
            .and_then(|d| session.prepare_ranking_native(&request(&d, &f.word)));
        assert_eq!(result.unwrap_err().code, "resource_unavailable", "{limit}");
    }
}

#[test]
fn unknown_word_and_rafsi_discovery_have_no_numerical_results() {
    let (mut f, _) = fixture();
    let pair = jvc_core::rafsi_pair_id(&f.word, "ban").unwrap();
    f.event(9, json!({"kind":"rafsi.publish","word":f.word,"assignment":pair,"origin":"native"}), Some(json!({"word":{"language":"jbo","spelling":"banli"},"rafsi":"ban","rationale":[],"sources":[],"legacy":null})));
    let session = EvaluationSession::new(&f.bytes()).unwrap();
    let summary = prepared(&session, &f.word);
    assert!(
        summary
            .targets
            .iter()
            .any(|t| t.id == pair && !t.definition && t.eligible)
    );
    assert_eq!(summary.contexts.len(), 2);
    let encoded = serde_json::to_value(&summary).unwrap();
    assert!(encoded.get("scores").is_none());
    assert!(encoded.get("layers").is_none());
    export(&f, "rafsi-and-definition", &summary);
    let unknown = format!("jvw1:{}", "0".repeat(64));
    let missing = prepared(&session, &unknown);
    assert!(missing.targets.is_empty());
    assert!(missing.contexts.is_empty());
    assert_eq!(missing.usage.context_calls, 0);
}

#[test]
fn large_source_is_streamed_and_context_charges_do_not_repeat_dictionary_bytes() {
    let (mut f, _) = fixture();
    f.definition("fr");
    // Authenticated unrelated profile records enlarge the retained state, not this word's contexts.
    for n in 0..50 {
        f.event(
            6,
            json!({"kind":"identity.profile"}),
            Some(json!({"name":format!("synthetic-{n}"),"bio":[["x".repeat(200_000)]],"links":[]})),
        );
    }
    let session = EvaluationSession::new(&f.bytes()).unwrap();
    let baseline = prepared(&session, &f.word);
    let d = session.ranking_descriptor_native(&policy()).unwrap();
    let source_bytes = d.setup.source_bytes;
    assert!(source_bytes > 3_000_000);
    assert_eq!(baseline.contexts.len(), 2);
    let mut source_bounded = policy();
    source_bounded.limits.source_bytes = source_bytes as usize;
    assert!(session.ranking_descriptor_native(&source_bounded).is_ok());
    source_bounded.limits.source_bytes -= 1;
    assert_eq!(
        session
            .ranking_descriptor_native(&source_bounded)
            .unwrap_err()
            .code,
        "resource_unavailable"
    );
    assert!(baseline.usage.charged_units < policy().limits.units);
    let mut bounded = policy();
    bounded.limits.metadata_bytes = 8192;
    let streamed = session.ranking_descriptor_native(&bounded).unwrap();
    assert_eq!(streamed.input_binding, d.input_binding);
    let summary = session
        .prepare_ranking_native(&request(&streamed, &f.word))
        .unwrap();
    assert_eq!(summary.usage, baseline.usage);
    export_with_policy(&f, "large-streamed-source", &summary, &bounded);
}

#[test]
fn exact_profiles_skip_the_source_walk_and_float_unavailability_keeps_its_reason() {
    let mut f = Fixture::new();
    f.definition("en");
    f.view("simple-routes-bounds-v1", &[1], 1000);
    let exact = EvaluationSession::new(&f.bytes()).unwrap();
    let mut tiny = policy();
    tiny.limits.records = 1;
    tiny.limits.setup_bytes = 1;
    tiny.limits.units = 1;
    let d = exact.ranking_descriptor_native(&tiny).unwrap();
    assert!(!d.available && d.reasons.contains("unsupported_calculation"));
    assert_eq!(d.setup.setup_bytes, 0);
    assert_eq!(d.setup.setup_records, 0);
    assert_eq!(
        exact
            .prepare_ranking_native(&request(&d, &f.word))
            .unwrap_err()
            .code,
        "unsupported_calculation"
    );
    export_unavailable("exact-skips-source", &f, &tiny, "unsupported_calculation");
    f.view(jvc_rank::approximate::ALGORITHM, &[1], 1000);
    f.overlay = Some(json!({"invalid":true}));
    let unavailable = EvaluationSession::new(&f.bytes()).unwrap();
    let d = unavailable.ranking_descriptor_native(&policy()).unwrap();
    assert!(!d.available && d.reasons.contains("invalid_overlay"));
    let error = unavailable
        .prepare_ranking_native(&request(&d, &f.word))
        .unwrap_err();
    assert_eq!(error.code, "ranking_unavailable");
    assert!(error.message.contains("invalid_overlay"));
    export_unavailable(
        "unavailable-float-reason",
        &f,
        &policy(),
        "ranking_unavailable",
    );
}

#[test]
fn resource_refused_policy_releases_controller_and_old_requests_without_resetting_generation() {
    let (f, _) = fixture();
    let session = EvaluationSession::new(&f.bytes()).unwrap();
    let before = prepared(&session, &f.word);
    let d = session.ranking_descriptor_native(&policy()).unwrap();
    let mut limited = policy();
    limited.limits.records = 1;
    assert_eq!(
        session
            .ranking_descriptor_native(&limited)
            .unwrap_err()
            .code,
        "resource_unavailable"
    );
    assert_eq!(session.ranking_preparation().unwrap(), "null");
    assert_eq!(
        session
            .prepare_ranking_native(&request(&d, &f.word))
            .unwrap_err()
            .code,
        "ranking_preparation"
    );
    let after = prepared(&session, &f.word);
    assert_eq!(before.binding, after.binding);
    assert!(after.preparation_id.ends_with("preparation-2"));
}

#[test]
fn equal_graphs_share_execution_bindings_but_contexts_and_metadata_boundaries_stay_distinct() {
    let mut f = Fixture::new();
    f.definition("en");
    f.definition("fr");
    f.view(jvc_rank::approximate::ALGORITHM, &[1], 1000);
    let session = EvaluationSession::new(&f.bytes()).unwrap();
    let baseline = prepared(&session, &f.word);
    assert_eq!(baseline.contexts.len(), 2);
    assert_eq!(
        baseline.contexts[0].execution_binding,
        baseline.contexts[1].execution_binding
    );
    assert_ne!(
        baseline.contexts[0].context_binding,
        baseline.contexts[1].context_binding
    );
    let bytes = session.ranking_preparation().unwrap().len();
    assert!(
        bytes
            > serde_json::to_vec(&session.ranking_descriptor_native(&policy()).unwrap())
                .unwrap()
                .len()
    );
    let mut exact = policy();
    exact.limits.metadata_bytes = bytes;
    let d = session.ranking_descriptor_native(&exact).unwrap();
    session
        .prepare_ranking_native(&request(&d, &f.word))
        .unwrap();
    assert_eq!(session.ranking_preparation().unwrap().len(), bytes);
    exact.limits.metadata_bytes -= 1;
    let d = session.ranking_descriptor_native(&exact).unwrap();
    assert_eq!(
        session
            .prepare_ranking_native(&request(&d, &f.word))
            .unwrap_err()
            .code,
        "resource_unavailable"
    );
    let metadata: Value = serde_json::from_str(&session.ranking_preparation().unwrap()).unwrap();
    assert_eq!(metadata["retained_graphs"], 0);
    export(&f, "equal-execution-distinct-contexts", &baseline);
}

fn export_input(name: &str, input: &Value, word: &str, summary: &RankingPreparationSummary) {
    if let Ok(directory) = std::env::var("JVC_PREPARATION_PARITY_DIR") {
        std::fs::create_dir_all(&directory).unwrap();
        let fresh = EvaluationSession::new(&canonical_value(input).unwrap()).unwrap();
        let descriptor = fresh.ranking_descriptor_native(&policy()).unwrap();
        let expected = fresh
            .prepare_ranking_native(&request(&descriptor, word))
            .unwrap();
        assert_eq!(normalized(summary), normalized(&expected));
        std::fs::write(std::path::Path::new(&directory).join(format!("{name}.json")),
            serde_json::to_vec(&json!({"input":String::from_utf8(canonical_value(input).unwrap()).unwrap(),"word":word,"policy":policy(),"descriptor":normalized(&descriptor),"summary":normalized(&expected)})).unwrap()).unwrap();
    }
}

#[test]
fn isolated_import_continuity_account_and_public_shun_changes_bind_forks() {
    for change in ["imports", "continuity", "account", "public-shun"] {
        let (mut f, target) = fixture();
        let claim = if change == "account" {
            Some(f.event(7, json!({"kind":"account.set","origin":"https://source.example","account":41,"value":"claim","previous":null,"carry":[]}), None))
        } else {
            None
        };
        if change == "account" {
            let mut view: Value = serde_json::from_str(&f.bodies[&f.selected_view]).unwrap();
            view["account_authority"] = json!(true);
            view["account_witnesses"] = json!([key(10)]);
            f.selected_view = f.event(
                20,
                json!({"kind":"view.publish","parents":[f.selected_view]}),
                Some(view),
            );
            f.event(10, json!({"kind":"account.observe","origin":"https://source.example","account":41,"claim":claim,"result":"present"}), Some(json!({
                "origin":"https://source.example","account":41,"username":"author","field_hash":format!("sha256:{}", "0".repeat(64)),"markers":[claim],"method":"lensisku-public-profile-v1","observed_at":"2026-10-11T00:00:00Z"
            })));
        }
        if change == "continuity" {
            f.overlay = Some(local_overlay(
                &f,
                None,
                json!([]),
                json!([{"identity":key(8),"scope":{"kind":"*","word":"*","language":"*"}}]),
            ));
        } else if change == "public-shun" {
            f.overlay = Some(local_overlay(&f, None, json!([]), json!([])));
        }
        let parent = EvaluationSession::new(&f.bytes()).unwrap();
        let before = prepared(&parent, &f.word);
        let begin = f.events.len();
        let mut imports = json!({});
        match change {
            "imports" => {
                let ids = canonical_value(&json!([target])).unwrap();
                imports[jvc_core::hash_id("sha256:", b"", &ids)] = json!([target]);
            }
            "continuity" => {
                let transfer = f.event(
                    1,
                    json!({"kind":"identity.transfer","successor":key(8)}),
                    None,
                );
                f.event(
                    8,
                    json!({"kind":"identity.accept","transfer":transfer}),
                    None,
                );
            }
            "account" => {
                f.event_after(7, vec![claim.unwrap()], json!({"kind":"account.set","origin":"https://source.example","account":41,"value":"clear"}), None);
            }
            _ => {
                f.overlay.as_mut().unwrap()["public_shun_issuer"] = json!(key(2));
            }
        }
        let mut input: Value = serde_json::from_slice(&f.bytes()).unwrap();
        input["import_selections"] = imports.clone();
        let options = canonical_value(&json!({"selected_view":f.selected_view,"import_selections":imports,"overlay":f.overlay})).unwrap();
        let mut builder = parent.fork(&options).unwrap();
        for envelope in &f.events[begin..] {
            let id = serde_json::from_str::<Value>(envelope).unwrap()["id"]
                .as_str()
                .unwrap()
                .to_owned();
            builder
                .add_record(
                    envelope.as_bytes(),
                    f.bodies.get(&id).map(|b| b.as_bytes().to_vec()),
                )
                .unwrap();
        }
        let child = builder.finish();
        let after = prepared(&child, &f.word);
        assert_ne!(
            before.descriptor_binding, after.descriptor_binding,
            "{change}"
        );
        let fresh = EvaluationSession::new(&canonical_value(&input).unwrap()).unwrap();
        assert_eq!(normalized(&after), normalized(&prepared(&fresh, &f.word)));
        if change == "account" {
            let old: Value = serde_json::from_str(&parent.state().unwrap()).unwrap();
            let new: Value = serde_json::from_str(&child.state().unwrap()).unwrap();
            assert_ne!(old["accounts"], new["accounts"]);
        }
        if change == "continuity" {
            let new: Value = serde_json::from_str(&child.state().unwrap()).unwrap();
            assert_eq!(new["lifecycle"]["key_actor"][key(8)], key(1));
        }
        assert_eq!(normalized(&prepared(&parent, &f.word)), normalized(&before));
        export_input(&format!("binding-{change}"), &input, &f.word, &after);
    }
}

#[test]
fn indexed_float_contexts_match_direct_conflicts_clears_and_narrowing() {
    for case in ["conflict", "clear", "narrowing"] {
        let (mut f, _) = fixture();
        f.definition("fr");
        let rule = |scope: Value, value: &str, weight: Value| json!({"issuer":key(1),"subject":key(2),"scope":scope,"value":value,"weight":weight});
        let en = json!({"kind":"definition","word":"*","language":"en"});
        let mut trust = match case {
            "conflict" => vec![
                rule(en, "heed", json!({"numerator":1,"denominator":3})),
                rule(
                    json!({"kind":"definition","word":f.word,"language":"*"}),
                    "heed",
                    json!({"numerator":2,"denominator":3}),
                ),
            ],
            "clear" => vec![rule(en, "clear", Value::Null)],
            _ => vec![
                rule(
                    json!({"kind":"definition","word":"*","language":"*"}),
                    "heed",
                    json!({"numerator":1,"denominator":3}),
                ),
                rule(en, "heed", json!({"numerator":2,"denominator":3})),
            ],
        };
        trust.sort_by_key(|v| canonical_value(v).unwrap());
        f.overlay = Some(local_overlay(&f, Some(2), json!(trust), json!([])));
        let summary = prepared(&EvaluationSession::new(&f.bytes()).unwrap(), &f.word);
        let english = summary
            .contexts
            .iter()
            .find(|c| c.context.language.as_deref() == Some("en"))
            .unwrap();
        assert_eq!(english.edges, usize::from(case == "narrowing"));
        export(&f, &format!("indexed-private-{case}"), &summary);
    }
}

fn export_unavailable(name: &str, f: &Fixture, policy: &RankingPreparationPolicy, error: &str) {
    if let Ok(directory) = std::env::var("JVC_PREPARATION_PARITY_DIR") {
        std::fs::create_dir_all(&directory).unwrap();
        let session = EvaluationSession::new(&f.bytes()).unwrap();
        let descriptor = session.ranking_descriptor_native(policy).unwrap();
        assert_eq!(
            session
                .prepare_ranking_native(&request(&descriptor, &f.word))
                .unwrap_err()
                .code,
            error
        );
        std::fs::write(std::path::Path::new(&directory).join(format!("{name}.json")), serde_json::to_vec(&json!({"input":String::from_utf8(f.bytes()).unwrap(),"word":f.word,"policy":policy,"descriptor":normalized(&descriptor),"error":error})).unwrap()).unwrap();
    }
}

#[test]
fn unavailable_evaluations_skip_setup_bounds_for_raw_overlays() {
    let (f, _) = fixture();
    for (name, limits) in [
        ("event-limit", json!({"events":1})),
        ("graph-resource", json!({"traversal":0})),
    ] {
        let mut input: Value = serde_json::from_slice(&f.bytes()).unwrap();
        input["limits"] = limits;
        input["overlay"] = json!({"trust":[{"issuer":1}]});
        let bytes = serde_json::to_vec(&input).unwrap();
        let state = jvc_runtime::evaluate_bytes(&bytes).unwrap();
        assert_eq!(state["available"], false, "{name}");
        assert!(
            state["reasons"]
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v == "resource_unavailable")
        );
        assert!(
            !state["reasons"]
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v == "invalid_overlay")
        );
        let session = EvaluationSession::new(&bytes).unwrap();
        let mut tiny = policy();
        tiny.limits.setup_bytes = 1;
        tiny.limits.setup_units = 1;
        let descriptor = session.ranking_descriptor_native(&tiny).unwrap();
        assert!(!descriptor.available, "{name}");
        assert!(descriptor.reasons.contains("resource_unavailable"));
        assert_eq!(descriptor.setup.setup_bytes, 0);
        assert_eq!(descriptor.setup.setup_units, 0);
        assert_eq!(descriptor.setup.charged_units, 0);
        assert_eq!(
            serde_json::from_str::<Value>(&session.state().unwrap()).unwrap(),
            state
        );
    }
}

#[test]
fn restored_malformed_overlay_never_panics_in_setup() {
    let (f, _) = fixture();
    let session = EvaluationSession::new(&f.bytes()).unwrap();
    let mut saved: Value =
        serde_json::from_slice(&session.checkpoint("raw-overlay").unwrap()).unwrap();
    let overlay = json!({"trust":[{"issuer":1}]});
    saved["evaluation"]["overlay"] = overlay.clone();
    saved["options"]["overlay"] = overlay;
    for available in [false, true] {
        saved["evaluation"]["available"] = json!(available);
        saved["evaluation"]["reasons"] = if available {
            json!([])
        } else {
            json!(["resource_unavailable"])
        };
        let restored = EvaluationSession::restore_host_checkpoint(
            &serde_json::to_vec(&saved).unwrap(),
            "raw-overlay",
        )
        .unwrap();
        if available {
            assert_eq!(
                restored
                    .ranking_descriptor_native(&policy())
                    .unwrap_err()
                    .code,
                "invalid_overlay"
            );
        } else {
            let d = restored.ranking_descriptor_native(&policy()).unwrap();
            assert!(!d.available);
            assert_eq!((d.setup.setup_bytes, d.setup.setup_units), (0, 0));
        }
    }
}
