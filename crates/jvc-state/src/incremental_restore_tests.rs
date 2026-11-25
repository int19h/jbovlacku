use super::*;

#[test]
fn results_refusal_binds_same_size_record_list() {
    let mut input = base();
    input.options.limits.traversal = Some(19);
    let issuer = identity_from_seed(&[5; 32]);
    let target = format!("jvr1:{:064x}", 1);
    let action = json!({"kind":"judgment.set","target":target,"value":"bless"});
    let light = host(
        format!("jve1:{:064x}", 60_002),
        &issuer,
        vec![],
        action.clone(),
    );
    let mut replacement = input.clone();
    replacement.add_host_verified_record(light.clone());
    assert!(replacement.evaluate().available);
    input.add_host_verified_record(host(
        format!("jve1:{:064x}", 60_001),
        &issuer,
        (0..200)
            .map(|i| format!("jve1:{:064x}", 70_000 + i))
            .collect(),
        action,
    ));
    assert!(
        input
            .clone()
            .evaluate()
            .reasons
            .contains("resource_unavailable")
    );
    let results = restore_gap_checkpoints(input, |_, records| {
        if let Some(records) = records {
            records.retain(|record| record.id() != format!("jve1:{:064x}", 60_001));
            records.push(light.clone());
        }
    });
    assert!(results[0].is_ok());
    assert!(results[1].is_err());
}

#[test]
fn checkpoints_require_registers_for_effective_records() {
    let mut input = base();
    let (publication, body) = publication();
    input.add_record(&publication, body.as_deref());
    let judgment = format!("jve1:{:064x}", 80_001);
    let reviewer = identity_from_seed(&[5; 32]);
    input.add_host_verified_record(host(
        judgment.clone(),
        &reviewer,
        vec![],
        json!({"kind":"judgment.set","target":publication.id(),"value":"curse"}),
    ));
    let evaluation = input.clone().evaluate();
    assert_eq!(
        evaluation.judgments[publication.id()][&reviewer],
        Judgment::Curse
    );
    assert_eq!(evaluation.registers.len(), 1);
    for hide_receipt in [false, true] {
        assert_restore_gap_rejected(input.clone(), |cp, _| {
            cp["evaluation"]["registers"] = json!({});
            cp["evaluation"]["judgments"] = json!({});
            cp["register_maxima_work"] = json!([]);
            cp["register_maxima_member_work"] = json!([]);
            if hide_receipt {
                cp["evaluation"]["receipts"][&judgment]["interpretation"] = json!("pending");
                cp["evaluation"]["receipts"][&judgment]["reasons"] = json!(["target_pending"]);
            }
        });
    }
}

#[test]
fn checkpoints_derive_publication_eligibility() {
    let (input, _) = rich_checkpoint_fixture();
    let evaluation = input.clone().evaluate();
    for (id, publication) in &evaluation.publications {
        for wrong in ["eligible", "not_selected", "unknown", "inactive"] {
            if serde_json::to_value(&publication.eligible).unwrap() != wrong {
                assert_restore_gap_rejected(input.clone(), |cp, _| {
                    cp["evaluation"]["publications"][id]["eligible"] = json!(wrong);
                });
            }
        }
    }
}

#[test]
fn checkpoints_derive_publication_authority() {
    let mut input = base();
    let (definition, _) = publication();
    let action = serde_json::to_value(&definition.header().action).unwrap();
    let issuer = identity_from_seed(&[6; 32]);
    let publication = format!("jve1:{:064x}", 80_002);
    input.add_host_verified_record(host_missing_body(
        publication.clone(),
        &issuer,
        vec![],
        action,
    ));
    input.add_host_verified_record(host(
        format!("jve1:{:064x}", 80_003),
        &issuer,
        vec![format!("jve1:{:064x}", 80_004)],
        json!({"kind":"identity.merge"}),
    ));
    assert_eq!(
        input.clone().evaluate().publications[&publication].authority,
        Authority::Uncertain
    );
    assert_restore_gap_rejected(input, |cp, _| {
        cp["evaluation"]["publications"][&publication]["authority"] = json!("native");
        cp["evaluation"]["publications"][&publication]["controller"] = json!(issuer);
        cp["evaluation"]["publications"][&publication]["reasons"] = json!([]);
    });

    let (input, _) = rich_checkpoint_fixture();
    let evaluation = input.clone().evaluate();
    let imported = evaluation
        .publications
        .values()
        .find(|p| p.imported)
        .unwrap();
    assert_eq!(imported.authority, Authority::SourceAccount);
    assert_restore_gap_rejected(input, |cp, _| {
        cp["evaluation"]["publications"][&imported.id]["authority"] = json!("none");
    });
}

#[test]
fn bad_overlay_on_resource_refusal_cannot_reach_context_rules() {
    let mut input = base();
    input.options.limits.traversal = Some(0);
    input.options.overlay = Some(json!({"trust":[{"issuer":1}]}).into());
    let context = Context {
        kind: "definition".into(),
        word: format!("jvw1:{:064x}", 1),
        language: Some("en".into()),
    };
    let check = |evaluation: &Evaluation| {
        let exact = evaluate_context(evaluation, &context);
        assert!(!exact.available);
        assert!(exact.reasons.contains("resource_unavailable"));
        let approximate = prepare_approximate_context(evaluation, &context);
        assert!(!approximate.available);
        assert_eq!(approximate.reasons, exact.reasons);
    };
    check(&input.clone().evaluate());
    for restored in restore_gap_checkpoints(input, |_, _| {}) {
        check(restored.unwrap().evaluation());
    }
}

#[test]
fn checkpoints_require_a_proven_native_frontier() {
    let mut input = base();
    let (publication, body) = publication();
    input.add_record(&publication, body.as_deref());
    let id = publication.id();
    let status = format!("jve1:{:064x}", 80_005);
    input.add_host_verified_record(host(
        status.clone(),
        &publication.header().issuer,
        vec![id.into()],
        json!({"kind":"status.set","target":id,"value":"deprecated"}),
    ));
    let evaluation = input.clone().evaluate();
    assert_eq!(
        evaluation.publications[id].status_frontier,
        BTreeSet::from([status])
    );
    assert_restore_gap_rejected(input, |cp, _| {
        cp["evaluation"]["publications"][id]["status_frontier"] = json!([]);
        cp["evaluation"]["publications"][id]["status"] = json!("active");
    });
}

#[test]
fn checkpoints_distinguish_standalone_candidate_decisions() {
    let (mut input, _) = rich_checkpoint_fixture();
    let evaluation = input.clone().evaluate();
    let publication = evaluation
        .publications
        .values()
        .find(|p| p.imported)
        .unwrap();
    let target = &publication.id;
    let first_claim = publication.claim.as_ref().unwrap();
    let old_command = publication.status_frontier.first().unwrap();
    std::rc::Rc::make_mut(&mut input.nodes).remove(old_command);
    input.add_host_verified_record(host(
        old_command.clone(),
        &identity_from_seed(&[1; 32]),
        vec![first_claim.clone()],
        json!({"kind":"import.status","target":target,"claim":first_claim,"value":"deprecated"}),
    ));
    let second_claim = format!("jve1:{:064x}", 80_006);
    let second_issuer = identity_from_seed(&[6; 32]);
    input.add_host_verified_record(host(
        second_claim.clone(),
        &second_issuer,
        vec![],
        json!({"kind":"account.set","origin":"https://source.example","account":41,"value":"claim","previous":null,"carry":[]}),
    ));
    observe(&mut input, 10, 2, &second_claim);
    observe(&mut input, 11, 2, &second_claim);
    let second_command = host(
        format!("jve1:{:064x}", 80_007),
        &second_issuer,
        vec![second_claim.clone()],
        json!({"kind":"import.status","target":target,"claim":second_claim,"value":"deprecated"}),
    );
    for (both_command, actual, wrong) in [
        (false, Status::Conflicted, "deprecated"),
        (true, Status::Deprecated, "conflicted"),
    ] {
        let mut input = input.clone();
        if both_command {
            input.add_host_verified_record(second_command.clone());
        }
        let fresh = input.clone().evaluate();
        assert_eq!(fresh.publications[target].controller_candidates.len(), 2);
        assert_eq!(fresh.publications[target].status, actual);
        for result in restore_gap_checkpoints(input.clone(), |_, _| {}) {
            assert_eq!(result.unwrap().evaluation(), &fresh);
        }
        assert_restore_gap_rejected(input, |cp, _| {
            cp["evaluation"]["publications"][target]["status"] = json!(wrong);
        });
    }
}

#[test]
fn checkpoints_refuse_account_fields_on_native_publications() {
    let mut input = base();
    let (publication, body) = publication();
    input.add_record(&publication, body.as_deref());
    for (key, value) in [
        ("claim", json!("claim")),
        ("controller_candidates", json!(["claim"])),
        ("observations", json!(["observation"])),
        ("deciding_claim", json!("claim")),
        ("missing", json!(["jve1:x"])),
    ] {
        assert_restore_gap_rejected(input.clone(), |cp, _| {
            cp["evaluation"]["publications"][publication.id()][key] = value.clone();
        });
    }
}

const ACCOUNT_41: &str = "https://source.example#41";

fn witnessed_claim() -> (PreparedEvaluationInput, String, String) {
    let mut input = witnessed_view();
    let issuer = identity_from_seed(&[1; 32]);
    let claim = format!("jve1:{:064x}", 81_001);
    input.add_host_verified_record(host(
        claim.clone(),
        &issuer,
        vec![],
        json!({"kind":"account.set","origin":"https://source.example","account":41,"value":"claim","previous":null,"carry":[]}),
    ));
    observe(&mut input, 10, 1, &claim);
    observe(&mut input, 11, 1, &claim);
    (input, claim, issuer)
}

fn select_account_view(
    input: &mut PreparedEvaluationInput,
    parents: Vec<String>,
    witnesses: Option<Value>,
) {
    let mut body = serde_json::to_value(
        input.nodes[&input.options.selected_view]
            .body
            .as_ref()
            .unwrap(),
    )
    .unwrap();
    if let Some(witnesses) = witnesses {
        body["account_witnesses"] = witnesses;
    }
    let (view, body) = event(
        20,
        78,
        json!({"kind":"view.publish","parents":parents}),
        Some(body),
    );
    input.options.selected_view = view.id().into();
    input.add_record(&view, body.as_deref());
}

fn assert_fresh_account(input: &PreparedEvaluationInput, reason: &str) {
    let fresh = input.clone().evaluate();
    assert!(
        fresh.accounts[ACCOUNT_41].reasons.contains(reason),
        "{:#?}",
        fresh.accounts[ACCOUNT_41]
    );
    for checkpoint in restore_gap_checkpoints(input.clone(), |_, _| {}) {
        assert_eq!(checkpoint.unwrap().evaluation(), &fresh);
    }
}

#[test]
fn account_availability_follows_policy_ancestry() {
    let (mut input, claim, issuer) = witnessed_claim();
    select_account_view(&mut input, vec![format!("jve1:{:064x}", 81_999)], None);
    assert_fresh_account(&input, "policy_ancestry_unavailable");
    let fresh = input.clone().evaluate();
    assert!(fresh.accounts[ACCOUNT_41].unavailable);
    assert_restore_gap_rejected(input, |cp, _| {
        let account = &mut cp["evaluation"]["accounts"][ACCOUNT_41];
        let observations: BTreeSet<String> = account["observation_evidence"]
            .as_object()
            .unwrap()
            .values()
            .filter_map(|ids| ids.as_array()?.first()?.as_str().map(str::to_owned))
            .collect();
        account["unavailable"] = json!(false);
        account["reasons"] = json!([]);
        account["controller"] = json!(claim);
        account["controller_identity"] = json!(issuer);
        account["commands"] = json!(true);
        account["current_observations"] = json!(observations);
    });
}

#[test]
fn account_availability_compares_claim_paths() {
    for (previous, depth, reason) in [
        ("missing", 10, "claim_pending"),
        ("foreign", 10, "binding_unavailable"),
        ("missing", 1, "resource_unavailable"),
        ("cycle", 10, "binding_unavailable"),
    ] {
        let mut input = witnessed_view();
        input.options.limits.claim_depth = depth;
        let issuer = identity_from_seed(&[2; 32]);
        let claim = format!("jve1:{:064x}", 81_002);
        let prior = format!("jve1:{:064x}", 81_003);
        if previous == "foreign" {
            input.add_host_verified_record(host(
                prior.clone(), &issuer, vec![],
                json!({"kind":"account.set","origin":"https://source.example","account":42,"value":"claim","previous":null,"carry":[]}),
            ));
        }
        let parent = if previous == "cycle" { &claim } else { &prior };
        input.add_host_verified_record(host(
            claim.clone(), &issuer, vec![],
            json!({"kind":"account.set","origin":"https://source.example","account":41,"value":"claim","previous":parent,"carry":[parent]}),
        ));
        observe(&mut input, 10, 1, &claim);
        observe(&mut input, 11, 1, &claim);
        assert_fresh_account(&input, reason);
        assert_restore_gap_rejected(input, |cp, _| {
            cp["evaluation"]["accounts"][ACCOUNT_41]["reasons"] = json!(["historical_guard"]);
        });
    }
}

#[test]
fn account_availability_compares_witness_and_historical_reasons() {
    let (mut historical, _, _) = witnessed_claim();
    let parent = historical.options.selected_view.clone();
    select_account_view(
        &mut historical,
        vec![parent],
        Some(json!([
            identity_from_seed(&[12; 32]),
            identity_from_seed(&[13; 32])
        ])),
    );
    assert_fresh_account(&historical, "policy_history_unavailable");
    assert_restore_gap_rejected(historical, |cp, _| {
        cp["evaluation"]["accounts"][ACCOUNT_41]["reasons"] = json!(["historical_guard"]);
    });

    let (mut suspended, _, _) = witnessed_claim();
    suspended.add_host_verified_record(host(
        format!("jve1:{:064x}", 81_004),
        &identity_from_seed(&[10; 32]),
        vec![format!("jve1:{:064x}", 81_005)],
        json!({"kind":"identity.merge"}),
    ));
    assert_fresh_account(&suspended, "witness_history_incomplete");
    assert_restore_gap_rejected(suspended, |cp, _| {
        cp["evaluation"]["accounts"][ACCOUNT_41]["reasons"]
            .as_array_mut()
            .unwrap()
            .retain(|reason| reason != "witness_history_incomplete");
    });
}

#[test]
fn account_availability_compares_pending_observation_evidence() {
    let (mut input, claim, _) = witnessed_claim();
    let (missing, _) = event(
        10,
        2,
        json!({"kind":"account.observe","origin":"https://source.example","account":41,"claim":claim,"result":"present"}),
        Some(
            json!({"origin":"https://source.example","account":41,"username":"author","field_hash":"sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","markers":[claim],"method":"lensisku-public-profile-v1","observed_at":"2026-10-11T00:00:00Z"}),
        ),
    );
    input.add_record(&missing, None);
    assert_fresh_account(&input, "observation_pending");
    assert_restore_gap_rejected(input, |cp, _| {
        let account = &mut cp["evaluation"]["accounts"][ACCOUNT_41];
        account["reasons"] = json!(["historical_guard"]);
    });
}

#[test]
fn account_availability_refuses_invented_reasons_and_missing_ids() {
    let (input, _, _) = witnessed_claim();
    for reason in ["observation_pending", "invented_reason"] {
        assert_restore_gap_rejected(input.clone(), |cp, _| {
            cp["evaluation"]["accounts"][ACCOUNT_41]["reasons"] = json!([reason]);
        });
    }
    assert_restore_gap_rejected(input, |cp, _| {
        cp["evaluation"]["accounts"][ACCOUNT_41]["missing"] =
            json!([format!("jve1:{:064x}", 81_999)]);
    });
}
