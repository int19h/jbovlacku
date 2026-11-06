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
        let descriptor = session.ranking_descriptor_native(&policy()).unwrap();
        let native = session
            .prepare_ranking_native(&request(&descriptor, &f.word))
            .unwrap();
        assert_eq!(normalized(summary), normalized(&native));
        let data = json!({"input":String::from_utf8(f.bytes()).unwrap(),"word":f.word,"policy":policy(),"descriptor":normalized(&descriptor),"summary":normalized(&native)});
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
