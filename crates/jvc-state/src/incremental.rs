use super::*;
use graph::{Graph, Node};

pub const CHECKPOINT_VERSION: &str = "jvc-evaluation-checkpoint-v1";
const APPENDS_BEFORE_REBASE: usize = 64;

#[derive(Clone, Debug, Default, Serialize)]
pub struct UpdateStatistics {
    pub incremental_records: usize,
    pub rebuilt: bool,
    pub reason: Option<String>,
}

/// Keys changed by an advance that contains only local judgments.
#[derive(Clone, Debug, Default)]
pub struct JudgmentChanges {
    pub receipts: BTreeSet<String>,
    pub registers: BTreeSet<String>,
    pub judgments: BTreeMap<String, BTreeSet<String>>,
    pub actors: BTreeSet<String>,
}

/// Retained authenticated input and its evaluated state.
/// A fork owns its result and shares only immutable ancestor payloads.
#[derive(Clone)]
pub struct EvaluatedState {
    prepared: PreparedEvaluationInput,
    evaluation: Evaluation,
    graph: Option<Graph>,
    unresolved: BTreeSet<String>,
    remaining_work: usize,
    statistics: UpdateStatistics,
    judgment_changes: Option<JudgmentChanges>,
}

impl EvaluatedState {
    pub fn from_input(input: &EvaluationInput) -> Self {
        let mut prepared = PreparedEvaluationInput::new(EvaluationOptions {
            selected_view: input.selected_view.clone(),
            import_selections: input.import_selections.clone(),
            overlay: input.overlay.clone(),
            limits: input.limits.clone(),
        });
        for event in &input.events {
            prepared.add_record(event, input.bodies.get(event.id()).map(Vec::as_slice));
        }
        prepared.into_state()
    }
    pub(crate) fn new(prepared: PreparedEvaluationInput) -> Self {
        let mut state = Self {
            evaluation: empty_evaluation(&prepared.options),
            prepared,
            graph: None,
            unresolved: BTreeSet::new(),
            remaining_work: 0,
            statistics: UpdateStatistics::default(),
            judgment_changes: None,
        };
        state.rebuild();
        state
    }

    pub fn evaluation(&self) -> &Evaluation {
        &self.evaluation
    }

    pub fn statistics(&self) -> &UpdateStatistics {
        &self.statistics
    }

    pub fn judgment_changes(&self) -> Option<&JudgmentChanges> {
        self.judgment_changes.as_ref()
    }

    fn rebuild(&mut self) {
        self.judgment_changes = None;
        if self.prepared.event_limit_exceeded {
            self.evaluation = event_limit_evaluation(&self.prepared.options);
            self.graph = None;
            self.remaining_work = self.prepared.options.limits.traversal;
            self.unresolved.clear();
            return;
        }
        // Discard this state's old ancestry before allocating its replacement.
        self.graph = None;
        let graph = Graph::new(self.prepared.nodes.clone(), &self.prepared.options.limits);
        self.evaluation = evaluate_graph(&self.prepared.options, &graph);
        self.remaining_work = graph.budget.get();
        self.graph = Some(graph);
        self.unresolved = unresolved(&self.prepared);
    }

    /// Advance from original records that already passed record preparation.
    /// Existing record replacements and removals always rebuild the state.
    pub fn advance(mut self, delta: PreparedEvaluationInput, removed: &[String]) -> Self {
        let mut rebuild_reason =
            (self.prepared.options != delta.options).then(|| "configuration_changed".to_owned());
        self.prepared.options = delta.options;
        let mut added = BTreeMap::new();
        for id in removed {
            if self.prepared.nodes.remove(id).is_some() {
                rebuild_reason = Some("record_removed".into());
            }
        }
        for (id, node) in delta.nodes {
            match self.prepared.nodes.get(&id) {
                Some(previous) if previous == &node => {}
                Some(_) => {
                    self.prepared.nodes.insert(id, node);
                    rebuild_reason = Some("record_replaced".into());
                }
                None => {
                    added.insert(id, node);
                }
            }
        }
        self.prepared.event_limit_exceeded = delta.event_limit_exceeded
            || self.prepared.nodes.len().saturating_add(added.len())
                > self.prepared.options.limits.events;
        self.statistics = UpdateStatistics::default();
        self.judgment_changes = Some(JudgmentChanges::default());
        if self.prepared.event_limit_exceeded {
            rebuild_reason = Some("event_limit".into());
        }
        // An unavailable base or any global action requires a full rebuild.
        // Decide before constructing ancestry that the rebuild would discard.
        if rebuild_reason.is_none() && self.graph.is_none() && !added.is_empty() {
            if !self.evaluation.available {
                rebuild_reason = Some("base_unavailable".into());
            } else if added.values().any(|node| !supports_local_update(node)) {
                rebuild_reason = Some(
                    if next_ready_id(&added).is_some() {
                        "global_action"
                    } else {
                        "batch_dependencies"
                    }
                    .into(),
                );
            }
        }
        if rebuild_reason.is_none() && self.graph.is_none() {
            let graph = Graph::new(self.prepared.nodes.clone(), &self.prepared.options.limits);
            if graph.resource.get() {
                rebuild_reason = Some("history_resource_unavailable".into());
            } else {
                graph.budget.set(self.remaining_work);
                self.graph = Some(graph);
            }
        }
        while rebuild_reason.is_none() && !added.is_empty() {
            // Prefer dependencies from this same batch before their consumers.
            let next = next_ready_id(&added);
            let Some(id) = next else {
                rebuild_reason = Some("batch_dependencies".into());
                break;
            };
            let node = &added[&id];
            match self.fast_work(node) {
                Ok(work) => {
                    let node = added.remove(&id).unwrap();
                    self.append(node, work);
                    self.statistics.incremental_records += 1;
                }
                Err(reason) => rebuild_reason = Some(reason.into()),
            }
        }
        if let Some(reason) = rebuild_reason {
            self.prepared.nodes.extend(added);
            self.rebuild();
            self.statistics.rebuilt = true;
            self.statistics.reason = Some(reason);
        }
        self
    }

    fn fast_work(&self, node: &Node) -> std::result::Result<usize, &'static str> {
        let graph = self.graph.as_ref().unwrap();
        if !self.evaluation.available || graph.resource.get() {
            return Err("base_unavailable");
        }
        if !supports_local_update(node) {
            return Err("global_action");
        }
        if graph.appended >= APPENDS_BEFORE_REBASE {
            return Err("ancestry_rebase");
        }
        if self.unresolved.contains(&node.id) {
            return Err("reference_completed");
        }
        let actor = graph.actor(&node.issuer);
        if actor != node.issuer
            || graph
                .lifecycle
                .groups
                .get(&actor)
                .is_some_and(|group| group.len() != 1)
            || graph.suspended(&node.issuer)
            || graph.lifecycle.retired.contains(&node.issuer)
            || graph.lifecycle.compromised.contains(&node.issuer)
        {
            return Err("issuer_lifecycle");
        }
        if node.previous.iter().any(|id| {
            graph
                .nodes
                .get(id)
                .is_none_or(|previous| previous.issuer != node.issuer)
                || !graph.own.get(id).is_some_and(graph::Closure::complete)
                || !graph
                    .structural
                    .get(id)
                    .is_some_and(graph::Closure::complete)
                || !graph.accepted.get(id).is_some_and(graph::Closure::complete)
        }) {
            return Err("history_changed");
        }
        if node.kind == "judgment.set" {
            let target = node.action["target"].as_str().unwrap_or_default();
            let known = if target.starts_with("jvr1:") {
                self.evaluation
                    .publications
                    .values()
                    .any(|p| p.assignment.as_deref() == Some(target))
            } else {
                graph.nodes.get(target).is_some_and(|n| {
                    n.semantic && matches!(n.kind.as_str(), "definition.publish" | "rafsi.publish")
                })
            };
            if !known {
                return Err("target_unresolved");
            }
        }
        let count = graph.nodes.len();
        let words = count.saturating_add(1).div_ceil(64);
        let growth = words - count.div_ceil(64);
        if growth > 0
            && graph.nodes.values().any(|n| {
                n.semantic
                    && matches!(
                        n.kind.as_str(),
                        "identity.accept"
                            | "identity.compromise"
                            | "account.set"
                            | "account.observe"
                            | "import.status"
                    )
            })
        {
            return Err("width_sensitive_history");
        }
        let edges: usize = graph.nodes.values().map(|n| n.previous.len()).sum();
        // This bounds the corresponding full rebuild, not the cached work.
        // Existing missing sets and account decisions do not change here.
        let work = 3usize
            .saturating_mul(
                growth
                    .saturating_mul(count.saturating_add(edges))
                    .saturating_add(1 + node.previous.len())
                    .saturating_add(words.saturating_mul(1 + node.previous.len())),
            )
            .saturating_add(2);
        if work > self.remaining_work {
            return Err("work_budget");
        }
        Ok(work)
    }

    fn append(&mut self, node: Node, work: usize) {
        let graph = self.graph.as_mut().unwrap();
        graph.append_ordinary(node.clone());
        self.remaining_work -= work;
        graph.budget.set(self.remaining_work);
        self.evaluation.lifecycle = graph.lifecycle.clone();
        self.evaluation.receipts.insert(
            node.id.clone(),
            Receipt {
                interpretation: Interpretation::Effective,
                body: node.body_label.clone(),
                reasons: BTreeSet::new(),
            },
        );
        if node.kind == "judgment.set" {
            let target = node.action["target"].as_str().unwrap();
            let key = format!("{}|judgment|{target}", node.issuer);
            if let Some(changes) = &mut self.judgment_changes {
                changes.receipts.insert(node.id.clone());
                changes.registers.insert(key.clone());
                changes.actors.insert(node.issuer.clone());
                changes
                    .judgments
                    .entry(target.into())
                    .or_default()
                    .insert(node.issuer.clone());
            }
            let mut heads = self
                .evaluation
                .registers
                .get(&key)
                .map(|r| r.heads.clone())
                .unwrap_or_default();
            heads.insert(node.id.clone());
            let heads = graph.maxima(heads, false);
            let values: BTreeSet<String> = heads
                .iter()
                .map(|id| graph.nodes[id].action["value"].as_str().unwrap().into())
                .collect();
            let judgment = if values.len() > 1 {
                Judgment::Conflicted
            } else {
                match values.first().map(String::as_str) {
                    Some("bless") => Judgment::Bless,
                    Some("curse") => Judgment::Curse,
                    _ => Judgment::Clear,
                }
            };
            self.evaluation
                .judgments
                .entry(target.into())
                .or_default()
                .insert(node.issuer.clone(), judgment);
            self.evaluation.registers.insert(
                key.clone(),
                Register {
                    actor: node.issuer.clone(),
                    key,
                    heads,
                    conflicted: values.len() > 1,
                    values,
                },
            );
        } else {
            self.judgment_changes = None;
            publications_for(
                graph,
                &mut self.evaluation,
                Some(&BTreeSet::from([node.id.clone()])),
            );
            native_status_for(graph, &mut self.evaluation, Some(&node.id));
            action_targets_for(graph, &mut self.evaluation, Some(&node.id));
            // Pair gates consume eligibility before the gate itself. Restore
            // that input before evaluating a changed word's gate again.
            let claims: BTreeSet<_> = self
                .evaluation
                .publications
                .values()
                .filter(|p| p.kind == "rafsi.publish")
                .map(|p| p.id.clone())
                .collect();
            if !claims.is_empty() {
                let mut raw = empty_evaluation(&self.prepared.options);
                raw.policy = self.evaluation.policy.clone();
                raw.selections = self.evaluation.selections.clone();
                publications_for(graph, &mut raw, Some(&claims));
                for (id, publication) in raw.publications {
                    self.evaluation.publications.get_mut(&id).unwrap().eligible =
                        publication.eligible;
                }
                rafsi_gate(&mut self.evaluation);
            }
        }
        add_node_references(&node, &mut self.unresolved);
        self.prepared.nodes.insert(node.id.clone(), node);
        self.unresolved
            .retain(|id| !self.prepared.nodes.contains_key(id));
    }

    pub fn checkpoint(&self, binding: &str) -> jvc_core::Result<Vec<u8>> {
        self.save_checkpoint(binding, false)
    }
    /// Persistent checkpoints contain results. Private records remain in their own store.
    pub fn result_checkpoint(&self, binding: &str) -> jvc_core::Result<Vec<u8>> {
        self.save_checkpoint(binding, true)
    }
    fn save_checkpoint(&self, binding: &str, results_only: bool) -> jvc_core::Result<Vec<u8>> {
        #[derive(Serialize)]
        struct Saved<'a> {
            version: &'static str,
            binding: &'a str,
            options: &'a EvaluationOptions,
            #[serde(skip_serializing_if = "Option::is_none")]
            nodes: Option<&'a BTreeMap<String, Node>>,
            evaluation: &'a Evaluation,
            event_limit_exceeded: bool,
            remaining_work: usize,
        }
        serde_json::to_vec(&Saved {
            version: if results_only {
                "jvc-evaluation-results-v1"
            } else {
                CHECKPOINT_VERSION
            },
            binding,
            options: &self.prepared.options,
            nodes: (!results_only).then_some(&self.prepared.nodes),
            evaluation: &self.evaluation,
            event_limit_exceeded: self.prepared.event_limit_exceeded,
            remaining_work: self.remaining_work,
        })
        .map_err(|e| jvc_core::Error::new("checkpoint", e.to_string()))
    }

    /// Restore only bytes checked against an independent trusted host pin.
    /// This API does not authenticate caller-supplied projected content.
    pub fn restore_host_checkpoint(bytes: &[u8], binding: &str) -> jvc_core::Result<Self> {
        Self::restore_checkpoint(bytes, binding, None)
    }
    pub fn restore_host_result_checkpoint(
        bytes: &[u8],
        binding: &str,
        records: Vec<HostVerifiedRecord>,
    ) -> jvc_core::Result<Self> {
        Self::restore_checkpoint(bytes, binding, Some(records))
    }
    fn restore_checkpoint(
        bytes: &[u8],
        binding: &str,
        records: Option<Vec<HostVerifiedRecord>>,
    ) -> jvc_core::Result<Self> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Saved {
            version: String,
            binding: String,
            options: EvaluationOptions,
            #[serde(default)]
            nodes: Option<BTreeMap<String, Node>>,
            evaluation: Evaluation,
            event_limit_exceeded: bool,
            remaining_work: usize,
        }
        let saved: Saved = serde_json::from_slice(bytes)
            .map_err(|e| jvc_core::Error::new("checkpoint", e.to_string()))?;
        let expected_version = if records.is_some() {
            "jvc-evaluation-results-v1"
        } else {
            CHECKPOINT_VERSION
        };
        let nodes = match (records, saved.nodes) {
            (Some(records), None) => records
                .into_iter()
                .map(|r| (r.node.id.clone(), r.node))
                .collect(),
            (None, Some(nodes)) => nodes,
            _ => {
                return Err(jvc_core::Error::new(
                    "checkpoint",
                    "checkpoint records do not match its format",
                ));
            }
        };
        if saved.version != expected_version
            || saved.binding != binding
            || saved.evaluation.selected_view != saved.options.selected_view
            || saved.evaluation.overlay != saved.options.overlay
            || saved.remaining_work > saved.options.limits.traversal
            || nodes.iter().any(|(id, node)| id != &node.id)
        {
            return Err(jvc_core::Error::new(
                "checkpoint",
                "checkpoint version or binding does not match",
            ));
        }
        let prepared = PreparedEvaluationInput {
            options: saved.options,
            nodes,
            event_limit_exceeded: saved.event_limit_exceeded,
        };
        Ok(Self {
            unresolved: unresolved(&prepared),
            prepared,
            evaluation: saved.evaluation,
            graph: None,
            remaining_work: saved.remaining_work,
            statistics: UpdateStatistics::default(),
            judgment_changes: None,
        })
    }
}

fn supports_local_update(node: &Node) -> bool {
    node.semantic
        && (node.kind == "judgment.set"
            || node.kind == "definition.publish" && node.action["origin"] == "native")
}

fn next_ready_id(added: &BTreeMap<String, Node>) -> Option<String> {
    added
        .iter()
        .find(|(_, node)| {
            node.previous.iter().all(|id| !added.contains_key(id))
                && node.action["target"]
                    .as_str()
                    .is_none_or(|id| !added.contains_key(id))
                && node.action["parents"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .all(|id| id.as_str().is_none_or(|id| !added.contains_key(id)))
        })
        .map(|(id, _)| id.clone())
}

fn references(value: &Value, result: &mut BTreeSet<String>) {
    match value {
        Value::String(id) if jvc_core::valid_id(id, "jve1:") => {
            result.insert(id.clone());
        }
        Value::Array(values) => {
            for value in values {
                references(value, result);
            }
        }
        Value::Object(values) => {
            for value in values.values() {
                references(value, result);
            }
        }
        _ => {}
    }
}

fn add_node_references(node: &Node, result: &mut BTreeSet<String>) {
    result.extend(node.previous.iter().cloned());
    references(&node.action, result);
    if let Some(body) = &node.body {
        references(body, result);
    }
}

fn unresolved(prepared: &PreparedEvaluationInput) -> BTreeSet<String> {
    let mut result = BTreeSet::from([prepared.options.selected_view.clone()]);
    for ids in prepared.options.import_selections.values() {
        result.extend(ids.iter().cloned());
    }
    for node in prepared.nodes.values() {
        add_node_references(node, &mut result);
    }
    result.retain(|id| !prepared.nodes.contains_key(id));
    result
}

#[cfg(test)]
mod rebuild_tests {
    use super::*;
    use jvc_core::{
        Header, body_descriptor, canonical_value, identity_from_seed, sign_header, verify_envelope,
    };
    use serde_json::json;

    fn event(
        seed: u8,
        nonce: u8,
        action: Value,
        body: Option<Value>,
    ) -> (VerifiedEnvelope, Option<Vec<u8>>) {
        let body = body.map(|value| canonical_value(&value).unwrap());
        let signed = sign_header(
            &[seed; 32],
            Header {
                version: 1,
                issuer: identity_from_seed(&[seed; 32]),
                previous: Vec::new(),
                nonce: format!("{nonce:032x}"),
                action,
                content: body.as_deref().map(|bytes| body_descriptor(bytes).unwrap()),
            },
        )
        .unwrap();
        (
            verify_envelope(&signed.canonical_envelope().unwrap()).unwrap(),
            body,
        )
    }
    fn base() -> PreparedEvaluationInput {
        let (view, body) = event(
            1,
            1,
            json!({"kind":"view.publish","parents":[]}),
            Some(
                json!({"name":"fixture","description":[],"roots":[{"identity":identity_from_seed(&[1;32]),"q":{"numerator":1,"denominator":1}}],"rafsi_threshold":{"numerator":1,"denominator":1},"H":{"numerator":3,"denominator":1},"alpha":{"numerator":1,"denominator":2},"excluded":[],"calculation":"simple-routes-bounds-v1","work":1000,"import_sets":[],"account_witnesses":[],"account_authority":false,"notes":[]}),
            ),
        );
        let mut input = PreparedEvaluationInput::new(EvaluationOptions {
            selected_view: view.id().into(),
            import_selections: BTreeMap::new(),
            overlay: None,
            limits: Limits::default(),
        });
        input.add_record(&view, body.as_deref());
        assert!(input.clone().evaluate().available);
        input
    }

    fn publication() -> (VerifiedEnvelope, Option<Vec<u8>>) {
        event(
            1,
            4,
            json!({"kind":"definition.publish","word":jvc_core::word_id(&json!({"language":"jbo","spelling":"banli"})).unwrap(),"language":"en","parents":[],"origin":"native"}),
            Some(
                serde_json::from_str(include_str!(
                    "../../jvc-core/tests/fixtures/definition.json"
                ))
                .unwrap(),
            ),
        )
    }

    fn assert_restored_rebuild(
        mut complete: PreparedEvaluationInput,
        records: &[&(VerifiedEnvelope, Option<Vec<u8>>)],
        reason: &str,
    ) {
        let saved = complete
            .clone()
            .into_state()
            .checkpoint("host-checked")
            .unwrap();
        let state = EvaluatedState::restore_host_checkpoint(&saved, "host-checked").unwrap();
        assert!(state.graph.is_none());
        let mut delta = PreparedEvaluationInput::new(complete.options.clone());
        for (record, body) in records {
            complete.add_record(record, body.as_deref());
            delta.add_record(record, body.as_deref());
        }
        let before = graph::construction_count();
        let state = state.advance(delta, &[]);
        assert_eq!(
            graph::construction_count() - before,
            1,
            "a restored rebuild constructed ancestry twice"
        );
        assert!(state.statistics().rebuilt);
        assert_eq!(state.statistics().reason.as_deref(), Some(reason));
        assert_eq!(state.statistics().incremental_records, 0);
        assert!(state.judgment_changes().is_none());
        assert_eq!(state.evaluation(), &complete.clone().evaluate());
        let full = complete.into_state();
        assert_eq!(state.remaining_work, full.remaining_work);
        assert_eq!(state.unresolved, full.unresolved);
        let graph = state.graph.as_ref().unwrap();
        let full_graph = full.graph.as_ref().unwrap();
        assert_eq!(graph.budget.get(), full_graph.budget.get());
        assert_eq!(graph.resource.get(), full_graph.resource.get());
    }

    #[test]
    fn restored_mixed_updates_construct_one_graph_and_match_full_state() {
        let publication = publication();
        let profile = event(
            2,
            2,
            json!({"kind":"identity.profile"}),
            Some(json!({"name":"fixture","bio":[],"links":[]})),
        );
        let judgment = event(
            1,
            5,
            json!({"kind":"judgment.set","target":publication.0.id(),"value":"bless"}),
            None,
        );
        let mut complete = base();
        complete.add_record(&publication.0, publication.1.as_deref());
        assert!(complete.nodes[publication.0.id()].semantic);
        for records in [
            vec![&profile, &judgment],
            vec![&profile, &publication],
            vec![&profile, &publication, &judgment],
        ] {
            // A publication in the delta must be new, rather than a duplicate.
            let input = if records
                .iter()
                .any(|record| record.0.id() == publication.0.id())
            {
                base()
            } else {
                complete.clone()
            };
            assert_restored_rebuild(input, &records, "global_action");
        }
    }

    fn assert_unavailable_updates(unavailable_reason: &str) {
        let publication = publication();
        let trust = event(
            2,
            3,
            json!({"kind":"trust.set","subject":identity_from_seed(&[1;32]),"scope":{"kind":"*","word":"*","language":"*"},"value":"heed"}),
            None,
        );
        let judgment = event(
            1,
            5,
            json!({"kind":"judgment.set","target":publication.0.id(),"value":"bless"}),
            None,
        );
        for records in [
            vec![&trust],
            vec![&publication],
            vec![&judgment],
            vec![&trust, &publication, &judgment],
        ] {
            let mut complete = base();
            if unavailable_reason == "invalid_overlay" {
                complete.options.overlay = Some(json!({}));
            } else {
                complete.options.limits.traversal = 1;
            }
            let evaluation = complete.clone().evaluate();
            assert!(!evaluation.available);
            assert!(evaluation.reasons.contains(unavailable_reason));
            assert_restored_rebuild(complete, &records, "base_unavailable");
        }
    }

    #[test]
    fn restored_invalid_overlay_updates_construct_one_graph_and_match_full_state() {
        assert_unavailable_updates("invalid_overlay");
    }

    #[test]
    fn restored_resource_unavailable_updates_construct_one_graph_and_match_full_state() {
        assert_unavailable_updates("resource_unavailable");
    }

    #[test]
    fn restored_mixed_updates_preserve_traversal_exhaustion() {
        let publication = publication();
        let profile = event(
            2,
            2,
            json!({"kind":"identity.profile"}),
            Some(json!({"name":"fixture","bio":[],"links":[]})),
        );
        let mut complete = base();
        let used = complete.options.limits.traversal - complete.clone().into_state().remaining_work;
        complete.options.limits.traversal = used;
        assert!(complete.clone().evaluate().available);
        let mut expected = complete.clone();
        for (record, body) in [&profile, &publication] {
            expected.add_record(record, body.as_deref());
        }
        let evaluation = expected.evaluate();
        assert!(!evaluation.available);
        assert!(evaluation.reasons.contains("resource_unavailable"));
        assert_restored_rebuild(complete, &[&profile, &publication], "global_action");
    }

    #[test]
    fn restored_global_updates_construct_one_graph_and_match_full_state() {
        let profile = event(
            2,
            2,
            json!({"kind":"identity.profile"}),
            Some(json!({"name":"fixture","bio":[],"links":[]})),
        );
        let trust = event(
            2,
            3,
            json!({"kind":"trust.set","subject":identity_from_seed(&[1;32]),"scope":{"kind":"*","word":"*","language":"*"},"value":"heed"}),
            None,
        );
        for records in [vec![&profile], vec![&trust], vec![&profile, &trust]] {
            let mut complete = base();
            let saved = complete
                .clone()
                .into_state()
                .checkpoint("host-checked")
                .unwrap();
            let state = EvaluatedState::restore_host_checkpoint(&saved, "host-checked").unwrap();
            let mut delta = PreparedEvaluationInput::new(complete.options.clone());
            for (record, body) in records {
                complete.add_record(record, body.as_deref());
                delta.add_record(record, body.as_deref());
            }
            let before = graph::construction_count();
            let state = state.advance(delta, &[]);
            assert_eq!(
                graph::construction_count() - before,
                1,
                "a known global update rebuilt ancestry twice"
            );
            assert_eq!(state.statistics().reason.as_deref(), Some("global_action"));
            assert_eq!(state.statistics().incremental_records, 0);
            assert_eq!(state.evaluation(), &complete.evaluate());
        }
    }
}
