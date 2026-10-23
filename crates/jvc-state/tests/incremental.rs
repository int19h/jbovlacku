use jvc_core::{
    Header, VerifiedEnvelope, body_descriptor, canonical_value, hash_id, identity_from_seed,
    sign_header, word_id,
};
use jvc_state::{
    EvaluatedState, EvaluationInput, EvaluationOptions, Limits, PreparedEvaluationInput, evaluate,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

fn key(seed: u8) -> String {
    identity_from_seed(&[seed; 32])
}

struct Fixture {
    input: EvaluationInput,
    nonce: u64,
    word: String,
    definition: String,
}
impl Fixture {
    fn new() -> Self {
        let mut result = Self {
            input: EvaluationInput {
                events: Vec::new(),
                bodies: BTreeMap::new(),
                selected_view: String::new(),
                overlay: None,
                import_selections: BTreeMap::new(),
                limits: Limits::default(),
            },
            nonce: 0,
            word: word_id(&json!({"language":"jbo","spelling":"banli"})).unwrap(),
            definition: String::new(),
        };
        result.definition = result.publication();
        result.view();
        result
    }
    fn body(&self) -> Value {
        serde_json::from_str(include_str!(
            "../../jvc-core/tests/fixtures/definition.json"
        ))
        .unwrap()
    }
    fn event(
        &mut self,
        seed: u8,
        mut previous: Vec<String>,
        action: Value,
        body: Option<Value>,
    ) -> String {
        self.nonce += 1;
        previous.sort();
        previous.dedup();
        let bytes = body.as_ref().map(|body| canonical_value(body).unwrap());
        let header = Header {
            version: 1,
            issuer: key(seed),
            previous,
            nonce: format!("{:032x}", self.nonce),
            action,
            content: bytes.as_ref().map(|bytes| body_descriptor(bytes).unwrap()),
        };
        let event = sign_header(&[seed; 32], header).unwrap();
        let id = event.id().to_owned();
        if let Some(bytes) = bytes {
            self.input.bodies.insert(id.clone(), bytes);
        }
        self.input.events.push(event);
        id
    }
    fn publication(&mut self) -> String {
        self.event(9, vec![], json!({"kind":"definition.publish","word":self.word,"language":"en","parents":[],"origin":"native"}), Some(self.body()))
    }
    fn view(&mut self) {
        self.input.selected_view = self.event(20, vec![], json!({"kind":"view.publish","parents":[]}), Some(json!({"name":"fixture","description":[],"roots":[{"identity":key(1),"q":{"numerator":1,"denominator":1}}],"rafsi_threshold":{"numerator":1,"denominator":1},"H":{"numerator":3,"denominator":1},"alpha":{"numerator":1,"denominator":2},"excluded":[],"calculation":"simple-routes-bounds-v1","work":1000,"import_sets":[],"account_witnesses":[],"account_authority":false,"notes":[]})));
    }
    fn judgment(&mut self, previous: Vec<String>, value: &str) -> String {
        self.event(
            1,
            previous,
            json!({"kind":"judgment.set","target":self.definition,"value":value}),
            None,
        )
    }
    fn options(&self) -> EvaluationOptions {
        options(&self.input)
    }
    fn advance(&self, state: EvaluatedState, ids: &[String], removed: &[String]) -> EvaluatedState {
        let mut delta = PreparedEvaluationInput::new(self.options());
        for id in ids {
            let event = self
                .input
                .events
                .iter()
                .find(|event| event.id() == id)
                .unwrap();
            delta.add_record(event, self.input.bodies.get(id).map(Vec::as_slice));
        }
        let result = state.advance(delta, removed);
        let full = evaluate(&self.input);
        assert_eq!(result.evaluation(), &full);
        assert_eq!(
            score(result.evaluation(), &self.definition),
            score(&full, &self.definition)
        );
        result
    }
}
fn score(
    evaluation: &jvc_state::Evaluation,
    target: &str,
) -> Option<(Vec<jvc_rank::Interval>, jvc_rank::Score)> {
    let publication = evaluation.publications.get(target)?;
    if !evaluation.available
        || !publication.content_available
        || publication.eligible != jvc_state::Eligibility::Eligible
    {
        return None;
    }
    let context = jvc_state::evaluate_context(
        evaluation,
        &jvc_state::Context {
            kind: "definition".into(),
            word: publication.word.clone(),
            language: publication.language.clone(),
        },
    );
    if !context.available {
        return None;
    }
    let limits = jvc_rank::Limits::default();
    let graph = jvc_rank::Graph::with_refusals(
        jvc_rank::Profile::from_name(&context.calculation).unwrap(),
        context.actors.clone(),
        context.roots,
        context
            .rows
            .into_iter()
            .map(|row| {
                row.into_iter()
                    .map(|edge| jvc_rank::Edge {
                        to: edge.to,
                        share: edge.share,
                    })
                    .collect()
            })
            .collect(),
        context.refusals,
        &limits,
    )
    .unwrap();
    let ranking = jvc_rank::rank(
        &graph,
        &jvc_rank::Parameters {
            h: jvc_rank::rational(3, 1),
            alpha: jvc_rank::rational(1, 2),
            work: 1000,
        },
        limits,
    )
    .unwrap();
    let candidate = jvc_rank::Candidate {
        id: target.into(),
        eligibility: jvc_rank::Eligibility::Eligible,
        deprecated: publication.status == jvc_state::Status::Deprecated,
        verdicts: context
            .actors
            .iter()
            .map(|actor| {
                match context
                    .judgments
                    .get(target)
                    .and_then(|judgments| judgments.get(actor))
                {
                    Some(jvc_state::Judgment::Bless) => jvc_rank::Verdict::Bless,
                    Some(jvc_state::Judgment::Curse) => jvc_rank::Verdict::Curse,
                    _ => jvc_rank::Verdict::Absent,
                }
            })
            .collect(),
    };
    let score = jvc_rank::score(&candidate, &ranking.weights).unwrap();
    Some((ranking.weights, score))
}
fn options(input: &EvaluationInput) -> EvaluationOptions {
    EvaluationOptions {
        selected_view: input.selected_view.clone(),
        import_selections: input.import_selections.clone(),
        overlay: input.overlay.clone(),
        limits: input.limits.clone(),
    }
}

#[test]
fn mixed_writes_reuse_local_state_and_rebuild_global_changes() {
    let mut f = Fixture::new();
    let mut state = EvaluatedState::from_input(&f.input);
    let first = f.judgment(vec![], "bless");
    state = f.advance(state, std::slice::from_ref(&first), &[]);
    assert_eq!(state.statistics().incremental_records, 1);
    let second = f.judgment(vec![], "curse");
    state = f.advance(state, std::slice::from_ref(&second), &[]);
    assert_eq!(state.statistics().incremental_records, 1);
    let clear = f.judgment(vec![first, second], "clear");
    state = f.advance(state, std::slice::from_ref(&clear), &[]);
    assert_eq!(state.statistics().incremental_records, 1);
    let publication = f.publication();
    state = f.advance(state, &[publication], &[]);
    assert_eq!(state.statistics().incremental_records, 1);
    let trust = f.event(1, vec![clear], json!({"kind":"trust.set","subject":key(2),"scope":{"kind":"*","word":"*","language":"*"},"value":"heed"}), None);
    state = f.advance(state, &[trust], &[]);
    assert_eq!(state.statistics().reason.as_deref(), Some("global_action"));
    let judgment = f.judgment(vec![], "bless");
    state = f.advance(state, &[judgment], &[]);
    assert_eq!(state.statistics().incremental_records, 1);
    f.view();
    let view = f.input.selected_view.clone();
    state = f.advance(state, &[view], &[]);
    assert_eq!(
        state.statistics().reason.as_deref(),
        Some("configuration_changed")
    );
}

#[test]
fn a_native_publication_reopens_an_inactive_rafsi_word_gate() {
    let mut f = Fixture::new();
    let assignment = jvc_core::rafsi_pair_id(&f.word, "bal").unwrap();
    let claim = f.event(4, vec![], json!({"kind":"rafsi.publish","word":f.word,"assignment":assignment,"origin":"native"}), Some(json!({"word":{"language":"jbo","spelling":"banli"},"rafsi":"bal","rationale":[],"sources":[],"legacy":null})));
    f.event(
        9,
        vec![],
        json!({"kind":"status.set","target":f.definition,"value":"deprecated"}),
        None,
    );
    let state = EvaluatedState::from_input(&f.input);
    assert_eq!(
        state.evaluation().publications[&claim].eligible,
        jvc_state::Eligibility::Inactive
    );
    let publication = f.publication();
    let state = f.advance(state, &[publication], &[]);
    assert_eq!(state.statistics().incremental_records, 1);
    assert_eq!(
        state.evaluation().publications[&claim].eligible,
        jvc_state::Eligibility::Eligible
    );
}

#[test]
fn forks_and_host_checkpoints_keep_parent_results_unchanged() {
    let mut f = Fixture::new();
    let parent = EvaluatedState::from_input(&f.input);
    let expected = parent.evaluation().clone();
    let bytes = parent.checkpoint("snapshot/core/view/limits").unwrap();
    let saved: Value = serde_json::from_slice(&bytes).unwrap();
    assert!(saved.get("graph").is_none());
    assert!(EvaluatedState::restore_host_checkpoint(&bytes, "different").is_err());
    assert!(
        EvaluatedState::restore_host_checkpoint(b"damaged", "snapshot/core/view/limits").is_err()
    );
    let mut wrong_version = saved;
    wrong_version["version"] = json!("future");
    assert!(
        EvaluatedState::restore_host_checkpoint(
            &serde_json::to_vec(&wrong_version).unwrap(),
            "snapshot/core/view/limits"
        )
        .is_err()
    );
    let restored =
        EvaluatedState::restore_host_checkpoint(&bytes, "snapshot/core/view/limits").unwrap();
    assert_eq!(restored.evaluation(), &expected);
    let first = f.judgment(vec![], "bless");
    let child = f.advance(parent.clone(), std::slice::from_ref(&first), &[]);
    let restored_child = f.advance(restored, &[first], &[]);
    assert_eq!(restored_child.statistics().incremental_records, 1);
    assert_eq!(child.evaluation(), restored_child.evaluation());
    assert_eq!(parent.evaluation(), &expected);
}

#[test]
fn missing_publication_targets_and_parents_force_reference_rebuilds() {
    for judgment_target in [true, false] {
        let mut f = Fixture::new();
        let missing = f.publication();
        let held = f.input.events.pop().unwrap();
        let dependent = if judgment_target {
            f.event(
                1,
                vec![],
                json!({"kind":"judgment.set","target":missing,"value":"bless"}),
                None,
            )
        } else {
            f.event(9, vec![], json!({"kind":"definition.publish","word":f.word,"language":"en","parents":[missing],"origin":"native"}), Some(f.body()))
        };
        let state = EvaluatedState::from_input(&f.input);
        if judgment_target {
            assert!(
                state.evaluation().receipts[&dependent]
                    .reasons
                    .contains("target_pending")
            );
        } else {
            assert_eq!(
                state.evaluation().publications[&dependent].lineage[&missing],
                "pending"
            );
        }
        f.input.events.push(held);
        let state = f.advance(state, std::slice::from_ref(&missing), &[]);
        assert_eq!(
            state.statistics().reason.as_deref(),
            Some("reference_completed")
        );
        if judgment_target {
            assert!(
                !state.evaluation().receipts[&dependent]
                    .reasons
                    .contains("target_pending")
            );
            assert_eq!(
                state.evaluation().judgments[&missing][&key(1)],
                jvc_state::Judgment::Bless
            );
        } else {
            assert_eq!(
                state.evaluation().publications[&dependent].lineage[&missing],
                "resolved"
            );
        }
    }
}

#[test]
fn repeated_appends_rebase_after_restore_without_changing_tight_work_results() {
    let mut complete = Fixture::new();
    let base = complete.input.clone();
    let mut previous = Vec::new();
    for index in 0..72 {
        let id = complete.judgment(previous, if index % 2 == 0 { "bless" } else { "curse" });
        previous = vec![id];
    }
    let minimum = minimum_budget(&complete.input);
    for budget in [minimum - 1, minimum] {
        let mut f = Fixture::new();
        f.input = base.clone();
        f.input.limits.traversal = budget;
        let mut state = EvaluatedState::from_input(&f.input);
        let mut rebases = 0;
        for (index, event) in complete.input.events[base.events.len()..]
            .iter()
            .enumerate()
        {
            f.input.events.push(event.clone());
            let id = event.id().to_owned();
            state = f.advance(state, std::slice::from_ref(&id), &[]);
            assert_eq!(state.evaluation().available, evaluate(&f.input).available);
            if state.statistics().reason.as_deref() == Some("ancestry_rebase") {
                rebases += 1;
            }
            if index == 6 {
                let checkpoint = state.checkpoint("tight-work-sequence").unwrap();
                state = EvaluatedState::restore_host_checkpoint(&checkpoint, "tight-work-sequence")
                    .unwrap();
                assert_eq!(state.evaluation(), &evaluate(&f.input));
            }
        }
        assert_eq!(rebases, 1);
        assert_eq!(
            state.statistics().reason.as_deref(),
            Some("ancestry_rebase")
        );
        assert_eq!(state.evaluation().available, budget >= minimum);
    }
}

#[test]
fn host_checkpoint_rejects_invalid_fields_and_changed_options_keep_parent_isolated() {
    let mut f = Fixture::new();
    let parent = EvaluatedState::from_input(&f.input);
    let expected = parent.evaluation().clone();
    let bytes = parent.checkpoint("guard-checks").unwrap();
    let saved: Value = serde_json::from_slice(&bytes).unwrap();
    let mut missing = saved.clone();
    missing.as_object_mut().unwrap().remove("nodes");
    let mut wrong_id = saved.clone();
    let id = wrong_id["nodes"]
        .as_object()
        .unwrap()
        .keys()
        .next()
        .unwrap()
        .clone();
    wrong_id["nodes"][&id]["id"] = json!(format!("jve1:{}", "f".repeat(64)));
    let mut excess_work = saved;
    excess_work["remaining_work"] = json!(f.input.limits.traversal + 1);
    for invalid in [missing, wrong_id, excess_work] {
        assert!(
            EvaluatedState::restore_host_checkpoint(
                &serde_json::to_vec(&invalid).unwrap(),
                "guard-checks"
            )
            .is_err()
        );
    }
    let restored = EvaluatedState::restore_host_checkpoint(&bytes, "guard-checks").unwrap();
    let restored_expected = restored.evaluation().clone();
    f.input.limits.traversal += 1000;
    f.input.overlay = Some(
        json!({"version":1,"base_view":f.input.selected_view,"root_changes":[{"identity":key(1),"q":{"numerator":2,"denominator":1}}],"trust":[],"blocked":[],"work":null}),
    );
    let child = f.advance(restored.clone(), &[], &[]);
    assert_eq!(
        child.statistics().reason.as_deref(),
        Some("configuration_changed")
    );
    assert_eq!(parent.evaluation(), &expected);
    assert_eq!(restored.evaluation(), &restored_expected);
    assert_ne!(child.evaluation().overlay, restored.evaluation().overlay);
}

#[test]
fn body_replacement_removal_and_late_arrival_rebuild() {
    let mut f = Fixture::new();
    let bytes = f.input.bodies.remove(&f.definition).unwrap();
    let state = EvaluatedState::from_input(&f.input);
    f.input.bodies.insert(f.definition.clone(), bytes.clone());
    let state = f.advance(state, std::slice::from_ref(&f.definition), &[]);
    assert_eq!(
        state.statistics().reason.as_deref(),
        Some("record_replaced")
    );
    f.input
        .bodies
        .insert(f.definition.clone(), b"invalid".to_vec());
    let state = f.advance(state, std::slice::from_ref(&f.definition), &[]);
    assert_eq!(
        state.statistics().reason.as_deref(),
        Some("record_replaced")
    );
    let removed = f.definition.clone();
    f.input.events.retain(|event| event.id() != removed);
    let state = f.advance(state, &[], &[removed]);
    assert_eq!(state.statistics().reason.as_deref(), Some("record_removed"));
}

#[test]
fn gap_completion_and_lifecycle_changes_rebuild() {
    let mut f = Fixture::new();
    let missing = f.event(1, vec![], json!({"kind":"identity.merge"}), None);
    let held = f.input.events.pop().unwrap();
    f.judgment(vec![missing.clone()], "bless");
    let state = EvaluatedState::from_input(&f.input);
    f.input.events.push(held);
    let state = f.advance(state, &[missing], &[]);
    assert!(state.statistics().rebuilt);
    let transfer = f.event(
        1,
        vec![],
        json!({"kind":"identity.transfer","successor":key(2)}),
        None,
    );
    let state = f.advance(state, std::slice::from_ref(&transfer), &[]);
    assert!(state.statistics().rebuilt);
    let accept = f.event(
        2,
        vec![],
        json!({"kind":"identity.accept","transfer":transfer}),
        None,
    );
    let state = f.advance(state, std::slice::from_ref(&accept), &[]);
    assert!(state.statistics().rebuilt);
    let judgment = f.event(
        2,
        vec![accept],
        json!({"kind":"judgment.set","target":f.definition,"value":"curse"}),
        None,
    );
    let state = f.advance(state, &[judgment], &[]);
    assert_eq!(
        state.statistics().reason.as_deref(),
        Some("issuer_lifecycle")
    );
}

fn minimum_budget(input: &EvaluationInput) -> usize {
    let (mut low, mut high) = (0, 100_000);
    while low < high {
        let middle = (low + high) / 2;
        let mut trial = input.clone();
        trial.limits.traversal = middle;
        if evaluate(&trial).reasons.contains("resource_unavailable") {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    low
}

#[test]
fn bitset_width_growth_keeps_tight_resource_outcomes_with_control_history() {
    for control in ["plain", "compromise", "account"] {
        let mut f = Fixture::new();
        if control == "compromise" {
            let safe = f.event(3, vec![], json!({"kind":"identity.merge"}), None);
            f.event(
                3,
                vec![safe.clone()],
                json!({"kind":"identity.compromise","safe":[safe]}),
                None,
            );
        } else if control == "account" {
            f.event(3, vec![], json!({"kind":"account.set","origin":"https://source.example","account":1,"value":"claim","previous":null,"carry":[]}), None);
        }
        while f.input.events.len() < 64 {
            f.event(9, vec![], json!({"kind":"identity.merge"}), None);
        }
        let before = f.input.clone();
        let id = f.judgment(vec![], "bless");
        let after_min = minimum_budget(&f.input);
        for budget in [after_min - 1, after_min, after_min + 100] {
            f.input.limits.traversal = budget;
            let mut base = before.clone();
            base.limits.traversal = budget;
            let state = f.advance(
                EvaluatedState::from_input(&base),
                std::slice::from_ref(&id),
                &[],
            );
            if control != "plain" && base.limits.traversal >= minimum_budget(&base) {
                assert!(state.statistics().rebuilt);
            }
        }
    }
}

#[test]
fn event_limit_changes_retain_complete_authenticated_input() {
    let mut f = Fixture::new();
    f.input.limits.events = 0;
    let state = EvaluatedState::from_input(&f.input);
    assert!(!state.evaluation().available);
    f.input.limits.events = 200_000;
    let state = f.advance(state, &[], &[]);
    assert!(state.evaluation().available);
}

/// The local acceptance run sets this path. No source content enters the repo.
#[test]
fn lensisku_slice_mixed_writes_equal_full_evaluation() {
    let Ok(path) = std::env::var("JVC_LENSISKU_CARRIERS") else {
        return;
    };
    use std::io::BufRead;
    let mut f = Fixture::new();
    f.input.events.clear();
    f.input.bodies.clear();
    f.input.limits.traversal = 1_000_000_000;
    let mut first: Option<VerifiedEnvelope> = None;
    for line in std::io::BufReader::new(std::fs::File::open(&path).unwrap()).split(b'\n') {
        let line = line.unwrap();
        if line.is_empty() {
            continue;
        }
        let carrier: Value = serde_json::from_slice(&line).unwrap();
        if carrier["envelope"]["header"]["action"]["kind"] != "definition.publish" {
            continue;
        }
        let event =
            jvc_core::verify_envelope(&canonical_value(&carrier["envelope"]).unwrap()).unwrap();
        first.get_or_insert_with(|| event.clone());
        f.input.bodies.insert(
            event.id().into(),
            canonical_value(&carrier["body"]).unwrap(),
        );
        f.input.events.push(event);
        if f.input.events.len() == 1000 {
            break;
        }
    }
    assert_eq!(f.input.events.len(), 1000);
    let first = first.unwrap();
    f.definition = first.id().into();
    f.word = first.header().action["word"].as_str().unwrap().into();
    let mut selected: Vec<_> = f.input.events.iter().map(|e| e.id().to_owned()).collect();
    selected.sort();
    let hash = hash_id("sha256:", b"", &canonical_value(&json!(selected)).unwrap());
    f.input.import_selections.insert(hash.clone(), selected);
    let body: Value = serde_json::from_slice(&f.input.bodies[&f.definition]).unwrap();
    let mut view = json!({"name":"fixture","description":[],"roots":[{"identity":key(1),"q":{"numerator":1,"denominator":1}}],"rafsi_threshold":{"numerator":1,"denominator":1},"H":{"numerator":3,"denominator":1},"alpha":{"numerator":1,"denominator":2},"excluded":[],"calculation":"simple-routes-bounds-v1","work":1000,"import_sets":[],"account_witnesses":[],"account_authority":false,"notes":[]});
    view["import_sets"] = json!([{"source":body["legacy"]["source"],"importer":first.header().issuer,"selection":hash}]);
    f.input.selected_view = f.event(
        20,
        vec![],
        json!({"kind":"view.publish","parents":[]}),
        Some(view),
    );
    let mut state = EvaluatedState::from_input(&f.input);
    assert!(state.evaluation().available);
    let mut previous = Vec::new();
    for value in ["bless", "curse", "clear", "bless", "curse"] {
        let id = f.judgment(previous, value);
        state = f.advance(state, std::slice::from_ref(&id), &[]);
        assert_eq!(state.statistics().incremental_records, 1);
        previous = vec![id];
    }
    // A native publication and a global trust edit exercise both paths.
    f.word = word_id(&json!({"language":"jbo","spelling":"banli"})).unwrap();
    let id = f.publication();
    state = f.advance(state, &[id], &[]);
    assert_eq!(state.statistics().incremental_records, 1);
    let id = f.event(1, previous, json!({"kind":"trust.set","subject":key(2),"scope":{"kind":"*","word":"*","language":"*"},"value":"heed"}), None);
    state = f.advance(state, &[id], &[]);
    assert!(state.statistics().rebuilt);
    let checkpoint = state.checkpoint("lensisku-slice-v1").unwrap();
    assert_eq!(
        EvaluatedState::restore_host_checkpoint(&checkpoint, "lensisku-slice-v1")
            .unwrap()
            .evaluation(),
        &evaluate(&f.input)
    );
    eprintln!(
        "Lensisku slice: 1000 source definitions, source {path}, checkpoint {} bytes",
        checkpoint.len()
    );
}
