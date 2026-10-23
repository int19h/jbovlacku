//! Rebuild editorial state from authenticated records and explicitly selected policy.
//! Missing inputs remain visible. Record delivery order does not select a winner.
mod accounts;
mod api;
mod graph;
mod incremental;
mod policy;
pub use api::{
    AccountControl, Authority, Certificate, PublicationStatus, account_control, publication_status,
};
pub use incremental::{CHECKPOINT_VERSION, EvaluatedState, UpdateStatistics};

use jvc_core::{BodyAvailability, VerifiedEnvelope, inspect_body, validate_action};
pub use policy::{Context, ContextGraph, PositiveEdge, evaluate_context};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
pub type Rational = num_rational::BigRational;

#[derive(Clone, Debug)]
pub struct EvaluationInput {
    pub events: Vec<VerifiedEnvelope>,
    /// Bodies are keyed by publication event ID, rather than body hash.
    pub bodies: BTreeMap<String, Vec<u8>>,
    pub selected_view: String,
    pub overlay: Option<Value>,
    /// Selection hashes authenticate canonical sorted publication IDs.
    pub import_selections: BTreeMap<String, Vec<String>>,
    pub limits: Limits,
}
/// State configuration without record payloads.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct EvaluationOptions {
    pub selected_view: String,
    pub import_selections: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub overlay: Option<Value>,
    #[serde(default)]
    pub limits: Limits,
}
/// Authenticated records with only the content that state evaluation needs.
/// Fields stay private so callers cannot supply an unvalidated projection.
#[derive(Clone)]
pub struct PreparedEvaluationInput {
    options: EvaluationOptions,
    nodes: BTreeMap<String, graph::Node>,
    event_limit_exceeded: bool,
}
impl PreparedEvaluationInput {
    pub fn new(options: EvaluationOptions) -> Self {
        Self {
            options,
            nodes: BTreeMap::new(),
            event_limit_exceeded: false,
        }
    }
    /// Inspect the original body before retaining its state fields.
    /// Duplicate event IDs keep their first record, as in ordinary evaluation.
    pub fn add_record(&mut self, event: &VerifiedEnvelope, body: Option<&[u8]>) {
        self.add_record_with(event, body, |_| ());
    }
    /// Read the complete body-validation result before its state projection.
    /// This callback cannot change the validation result or stored fields.
    pub fn add_record_with<T>(
        &mut self,
        event: &VerifiedEnvelope,
        body: Option<&[u8]>,
        inspect: impl FnOnce(&BodyAvailability) -> T,
    ) -> T {
        let (node, content) = graph::Node::new_with(event, body, inspect);
        if !self.nodes.contains_key(event.id()) {
            if self.nodes.len() >= self.options.limits.events {
                self.event_limit_exceeded = true;
            }
            self.nodes.insert(event.id().into(), node);
        }
        content
    }
    pub fn evaluate(self) -> Evaluation {
        evaluate_prepared(self)
    }
    pub fn into_state(self) -> EvaluatedState {
        EvaluatedState::new(self)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct Limits {
    pub events: usize,
    pub traversal: usize,
    pub claim_depth: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            events: 200_000,
            traversal: 1_000_000,
            claim_depth: 1024,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Interpretation {
    Effective,
    Pending,
    Suspended,
    Inert,
    Unavailable,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Receipt {
    pub interpretation: Interpretation,
    pub body: String,
    pub reasons: BTreeSet<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Active,
    Deprecated,
    Conflicted,
    Uncertain,
    Unavailable,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Eligibility {
    Eligible,
    Inactive,
    Unknown,
    NotSelected,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct AccountKey {
    pub origin: String,
    pub account: u64,
}
impl AccountKey {
    fn token(&self) -> String {
        format!("{}#{}", self.origin, self.account)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Publication {
    pub id: String,
    pub issuer: String,
    pub kind: String,
    pub word: String,
    pub language: Option<String>,
    pub assignment: Option<String>,
    pub lineage: BTreeMap<String, String>,
    pub imported: bool,
    pub source: Option<String>,
    pub source_record: Option<u64>,
    pub account: Option<AccountKey>,
    pub authority: Authority,
    pub controller: Option<String>,
    pub claim: Option<String>,
    pub observations: BTreeSet<String>,
    pub status_frontier: BTreeSet<String>,
    pub deciding_claim: Option<String>,
    pub controller_candidates: BTreeSet<String>,
    pub witness_contributions: BTreeMap<String, BTreeSet<String>>,
    pub missing: BTreeSet<String>,
    pub content_available: bool,
    pub eligible: Eligibility,
    pub status: Status,
    pub reasons: BTreeSet<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct AccountState {
    pub account: AccountKey,
    pub controller: Option<String>,
    pub candidates: BTreeSet<String>,
    pub contributions: BTreeMap<String, BTreeSet<String>>,
    pub observation_evidence: BTreeMap<String, BTreeSet<String>>,
    pub certificates: Vec<Certificate>,
    pub chain: BTreeSet<String>,
    pub controller_identity: Option<String>,
    pub current_observations: BTreeSet<String>,
    pub historical: BTreeSet<String>,
    pub closed: BTreeSet<String>,
    pub unavailable: bool,
    pub disputed: bool,
    pub commands: bool,
    pub reasons: BTreeSet<String>,
    pub missing: BTreeSet<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Judgment {
    Bless,
    Curse,
    Clear,
    Conflicted,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Register {
    pub actor: String,
    pub key: String,
    pub heads: BTreeSet<String>,
    pub values: BTreeSet<String>,
    pub conflicted: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Lifecycle {
    pub key_actor: BTreeMap<String, String>,
    pub groups: BTreeMap<String, BTreeSet<String>>,
    pub successor: BTreeMap<String, String>,
    pub suspended: BTreeMap<String, BTreeSet<String>>,
    pub retired: BTreeSet<String>,
    pub compromised: BTreeSet<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Evaluation {
    pub selected_view: String,
    pub available: bool,
    pub reasons: BTreeSet<String>,
    pub receipts: BTreeMap<String, Receipt>,
    pub lifecycle: Lifecycle,
    pub publications: BTreeMap<String, Publication>,
    pub accounts: BTreeMap<String, AccountState>,
    pub registers: BTreeMap<String, Register>,
    pub judgments: BTreeMap<String, BTreeMap<String, Judgment>>,
    pub policy: Option<Value>,
    pub overlay: Option<Value>,
    pub(crate) policies: Vec<Value>,
    pub(crate) policy_history: BTreeMap<String, Value>,
    pub(crate) selections: BTreeMap<String, BTreeSet<String>>,
    pub(crate) trust: Vec<TrustRule>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub(crate) struct TrustRule {
    pub actor: String,
    pub subject: String,
    pub scope: Value,
    pub values: BTreeSet<String>,
}

pub fn evaluate(input: &EvaluationInput) -> Evaluation {
    let mut prepared = PreparedEvaluationInput::new(EvaluationOptions {
        selected_view: input.selected_view.clone(),
        import_selections: input.import_selections.clone(),
        overlay: input.overlay.clone(),
        limits: input.limits.clone(),
    });
    for event in &input.events {
        prepared.add_record(event, input.bodies.get(event.id()).map(Vec::as_slice));
    }
    prepared.evaluate()
}
fn evaluate_prepared(prepared: PreparedEvaluationInput) -> Evaluation {
    let PreparedEvaluationInput {
        options: input,
        nodes,
        event_limit_exceeded,
    } = prepared;
    let graph = graph::Graph::new(nodes, &input.limits);
    evaluate_graph(&input, &graph, event_limit_exceeded)
}
fn empty_evaluation(input: &EvaluationOptions) -> Evaluation {
    Evaluation {
        selected_view: input.selected_view.clone(),
        available: true,
        reasons: BTreeSet::new(),
        receipts: BTreeMap::new(),
        lifecycle: Lifecycle {
            key_actor: BTreeMap::new(),
            groups: BTreeMap::new(),
            successor: BTreeMap::new(),
            suspended: BTreeMap::new(),
            retired: BTreeSet::new(),
            compromised: BTreeSet::new(),
        },
        publications: BTreeMap::new(),
        accounts: BTreeMap::new(),
        registers: BTreeMap::new(),
        judgments: BTreeMap::new(),
        policy: None,
        overlay: input.overlay.clone(),
        policies: Vec::new(),
        policy_history: BTreeMap::new(),
        selections: BTreeMap::new(),
        trust: Vec::new(),
    }
}
fn evaluate_graph(
    input: &EvaluationOptions,
    graph: &graph::Graph,
    event_limit_exceeded: bool,
) -> Evaluation {
    let mut result = empty_evaluation(input);
    if event_limit_exceeded {
        result.available = false;
        result.reasons.insert("resource_unavailable".into());
        return result;
    }
    if graph.resource.get() {
        resource_unavailable(&mut result);
        return result;
    }
    result.lifecycle = graph.lifecycle.clone();
    if !result.lifecycle.suspended.is_empty() {
        result.reasons.insert("conditional_on_suspension".into());
    }
    for (id, node) in &graph.nodes {
        let mut reasons = BTreeSet::new();
        let interpretation = if !node.semantic {
            reasons.insert("invalid_action".into());
            Interpretation::Inert
        } else if !graph.own_complete(id) {
            reasons.insert("own_history_pending".into());
            Interpretation::Pending
        } else if graph.suspended(&node.issuer)
            && !matches!(
                node.kind.as_str(),
                "definition.publish" | "rafsi.publish" | "view.publish"
            )
        {
            reasons.insert("incomplete_group".into());
            Interpretation::Suspended
        } else if !graph.retained(id) && !node.kind.starts_with("identity.") {
            reasons.insert("outside_retained_history".into());
            Interpretation::Inert
        } else {
            Interpretation::Effective
        };
        result.receipts.insert(
            id.clone(),
            Receipt {
                interpretation,
                body: node.body_label.clone(),
                reasons,
            },
        );
    }
    policy::select(graph, input, &mut result);
    if result.reasons.contains("resource_unavailable") {
        resource_unavailable(&mut result);
        return result;
    }
    if input
        .overlay
        .as_ref()
        .is_some_and(|o| !policy::valid_overlay(o, &input.selected_view))
    {
        result.available = false;
        result.reasons.insert("invalid_overlay".into());
    } else if input
        .overlay
        .as_ref()
        .and_then(|overlay| overlay["public_shun_issuer"].as_str())
        .is_some_and(|issuer| graph.suspended(issuer))
    {
        result.available = false;
        result
            .reasons
            .insert("public_shun_issuer_unavailable".into());
    }
    publications(graph, &mut result);
    reconcile_selections(graph, &mut result);
    accounts::evaluate(graph, input, &mut result);
    if graph.resource.get() {
        resource_unavailable(&mut result);
        return result;
    }
    native_status(graph, &mut result);
    action_targets(graph, &mut result);
    registers(graph, &mut result);
    rafsi_gate(&mut result);
    result
}
fn resource_unavailable(result: &mut Evaluation) {
    result.available = false;
    result.reasons.insert("resource_unavailable".into());
    result.registers.clear();
    result.judgments.clear();
    result.trust.clear();
    for p in result.publications.values_mut() {
        p.authority = Authority::None;
        p.controller = None;
        p.claim = None;
        p.deciding_claim = None;
        p.status = Status::Unavailable;
        p.eligible = Eligibility::Unknown;
        p.reasons.insert("resource_unavailable".into());
    }
    for a in result.accounts.values_mut() {
        a.unavailable = true;
        a.commands = false;
        a.controller = None;
        a.controller_identity = None;
        a.reasons.insert("resource_unavailable".into());
    }
    for receipt in result.receipts.values_mut() {
        if receipt.interpretation != Interpretation::Inert {
            receipt.interpretation = Interpretation::Unavailable;
            receipt.reasons.insert("resource_unavailable".into());
        }
    }
}

fn publications(graph: &graph::Graph, result: &mut Evaluation) {
    publications_for(graph, result, None);
}
fn publications_for(
    graph: &graph::Graph,
    result: &mut Evaluation,
    only: Option<&BTreeSet<String>>,
) {
    for (id, node) in &graph.nodes {
        if only.is_some_and(|ids| !ids.contains(id)) {
            continue;
        }
        if !node.semantic || !matches!(node.kind.as_str(), "definition.publish" | "rafsi.publish") {
            continue;
        }
        let imported = node.action["origin"] == "import";
        let body = node.body.as_ref();
        let legacy = body.and_then(|b| b.get("legacy"));
        let source = legacy.and_then(|l| l["source"].as_str()).map(str::to_owned);
        let source_record = legacy.and_then(|l| l["record"]["id"].as_u64());
        let account = legacy.and_then(|l| {
            let a = &l["attribution"]["author_account"];
            if a["evidence"]["kind"] != "source-id" {
                return None;
            }
            Some(AccountKey {
                origin: a["origin"].as_str()?.into(),
                account: a["account"].as_u64()?,
            })
        });
        let mut reasons = BTreeSet::new();
        let mut eligible = if node.body.is_some() {
            Eligibility::Eligible
        } else {
            reasons.insert("body_unavailable".into());
            Eligibility::Unknown
        };
        if imported {
            let mut selected = false;
            let mut unknown = false;
            if let Some(policy) = &result.policy {
                for entry in policy["import_sets"].as_array().into_iter().flatten() {
                    if entry["importer"].as_str() != Some(&node.issuer)
                        || source
                            .as_deref()
                            .is_some_and(|s| Some(s) != entry["source"].as_str())
                    {
                        continue;
                    }
                    match entry["selection"]
                        .as_str()
                        .and_then(|s| result.selections.get(s))
                    {
                        Some(ids) => {
                            if ids.contains(id) {
                                if source.is_some() {
                                    selected = true;
                                } else {
                                    unknown = true;
                                    reasons.insert("source_attribution_pending".into());
                                }
                            }
                        }
                        None => unknown = true,
                    }
                }
            } else {
                unknown = true;
            }
            if !selected {
                eligible = if unknown {
                    reasons.insert("import_selection_unavailable".into());
                    Eligibility::Unknown
                } else {
                    Eligibility::NotSelected
                };
            }
        }
        result.publications.insert(
            id.clone(),
            Publication {
                id: id.clone(),
                issuer: node.issuer.clone(),
                kind: node.kind.clone(),
                word: node.action["word"].as_str().unwrap_or_default().into(),
                language: node.action["language"].as_str().map(str::to_owned),
                assignment: node.action["assignment"].as_str().map(str::to_owned),
                lineage: lineage(graph, node),
                imported,
                source,
                source_record,
                account,
                authority: Authority::None,
                controller: None,
                claim: None,
                observations: BTreeSet::new(),
                status_frontier: BTreeSet::new(),
                deciding_claim: None,
                controller_candidates: BTreeSet::new(),
                witness_contributions: BTreeMap::new(),
                missing: BTreeSet::new(),
                content_available: body.is_some(),
                eligible,
                status: if imported && body.is_none() {
                    reasons.insert("source_attribution_unavailable".into());
                    Status::Unavailable
                } else {
                    Status::Active
                },
                reasons,
            },
        );
    }
}
fn native_status(graph: &graph::Graph, result: &mut Evaluation) {
    native_status_for(graph, result, None);
}
fn native_status_for(graph: &graph::Graph, result: &mut Evaluation, only: Option<&str>) {
    let mut status_records: BTreeMap<&str, Vec<&graph::Node>> = BTreeMap::new();
    for node in graph
        .nodes
        .values()
        .filter(|n| n.semantic && n.kind == "status.set")
    {
        if let Some(target) = node.action["target"].as_str() {
            status_records.entry(target).or_default().push(node);
        }
    }
    for publication in result
        .publications
        .values_mut()
        .filter(|p| !p.imported && only.is_none_or(|id| p.id == id))
    {
        let actor = graph.actor(&publication.issuer);
        let keys = graph.downstream(&publication.issuer);
        if !graph.suspended(&publication.issuer)
            && keys.iter().any(|k| {
                !graph.lifecycle.retired.contains(k) && !graph.lifecycle.compromised.contains(k)
            })
        {
            publication.authority = Authority::Native;
            publication.controller = Some(actor.clone());
        }
        if graph.suspended(&publication.issuer) {
            publication.authority = Authority::Uncertain;
            publication.controller = None;
            publication.status = Status::Uncertain;
            publication.reasons.insert("incomplete_group".into());
            continue;
        }
        let records: Vec<_> = status_records
            .get(publication.id.as_str())
            .into_iter()
            .flatten()
            .copied()
            .filter(|n| {
                graph.structurally_connected(&publication.issuer, &n.issuer, &n.id)
                    && graph.transfers.get(&n.issuer).is_none_or(|ts| {
                        ts.iter()
                            .all(|t| t != &n.id && graph.own[t].ids.contains(&n.id))
                    })
                    && (graph.retained(&n.id) || graph.actor(&n.issuer) != actor)
            })
            .collect();
        let frontier = graph.maxima(records.iter().map(|n| n.id.clone()).collect(), true);
        publication.status_frontier = frontier.clone();
        if frontier
            .iter()
            .any(|id| graph.actor(&graph.nodes[id].issuer) != actor)
        {
            publication.authority = Authority::Uncertain;
            publication.controller = None;
            publication.status = Status::Uncertain;
            publication
                .reasons
                .insert("contested_status_authority".into());
            continue;
        }
        let values: BTreeSet<_> = frontier
            .iter()
            .map(|id| graph.nodes[id].action["value"].as_str().unwrap_or_default())
            .collect();
        publication.status = if values.len() > 1 {
            Status::Conflicted
        } else if values.contains("deprecated") {
            Status::Deprecated
        } else {
            Status::Active
        };
    }
}
fn registers(graph: &graph::Graph, result: &mut Evaluation) {
    let mut groups: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (id, n) in &graph.nodes {
        if !n.semantic
            || !graph.retained(id)
            || graph.suspended(&n.issuer)
            || !graph.own_complete(id)
            || result.receipts[id].reasons.contains("invalid_target")
            || result.receipts[id].reasons.contains("target_pending")
            || result.receipts[id]
                .reasons
                .contains("account_binding_unavailable")
        {
            continue;
        }
        let actor = graph.actor(&n.issuer);
        let key = match n.kind.as_str() {
            "judgment.set" => format!(
                "judgment|{}",
                n.action["target"].as_str().unwrap_or_default()
            ),
            "trust.set" => format!(
                "trust|{}|{}",
                graph.actor(n.action["subject"].as_str().unwrap_or_default()),
                n.action["scope"]
            ),
            "identity.profile" => "profile".into(),
            "report.set" => format!("report|{}|{}", n.action["subject"], n.action["category"]),
            "bridge.set" => format!(
                "bridge|{}|{}",
                n.action["origin"], n.action["source_definition"]
            ),
            "account.set" => format!("account|{}|{}", n.action["origin"], n.action["account"]),
            "account.observe" => format!("observe|{}|{}", n.action["origin"], n.action["account"]),
            _ => continue,
        };
        groups
            .entry(format!("{actor}|{key}"))
            .or_default()
            .push(id.clone());
    }
    for (key, ids) in groups {
        let heads = graph.maxima(ids.into_iter().collect(), false);
        let node = &graph.nodes[heads.iter().next().unwrap()];
        let actor = graph.actor(&node.issuer);
        let values: BTreeSet<String> = heads
            .iter()
            .map(|id| {
                let n = &graph.nodes[id];
                match n.kind.as_str() {
                    "identity.profile" => n.body_hash.clone().unwrap_or_default(),
                    "bridge.set" if n.action["value"] == "managed" => {
                        format!("managed|{}", n.action["target"])
                    }
                    "account.observe" => format!("{}|{}", n.action["result"], n.action["claim"]),
                    "account.set" if n.action["value"] == "claim" => n.id.clone(),
                    _ => n.action["value"].as_str().unwrap_or_default().into(),
                }
            })
            .collect();
        if node.kind == "judgment.set" {
            let judgment = if values.len() > 1 {
                Judgment::Conflicted
            } else {
                match values.iter().next().map(String::as_str) {
                    Some("bless") => Judgment::Bless,
                    Some("curse") => Judgment::Curse,
                    _ => Judgment::Clear,
                }
            };
            result
                .judgments
                .entry(node.action["target"].as_str().unwrap_or_default().into())
                .or_default()
                .insert(actor.clone(), judgment);
        }
        if node.kind == "trust.set" {
            result.trust.push(TrustRule {
                actor: actor.clone(),
                subject: graph.actor(node.action["subject"].as_str().unwrap_or_default()),
                scope: node.action["scope"].clone(),
                values: values.clone(),
            });
        }
        result.registers.insert(
            key.clone(),
            Register {
                actor,
                key,
                heads,
                conflicted: values.len() > 1,
                values,
            },
        );
    }
}
fn rafsi_gate(result: &mut Evaluation) {
    let missing_selection = result.reasons.contains("import_selection_unavailable")
        || result.reasons.contains("selection_publications_pending");
    let unknown_word = result.publications.values().any(|p| {
        p.kind == "definition.publish" && p.word.is_empty() && p.eligible == Eligibility::Unknown
    });
    let mut assignments: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut definition_gates: BTreeMap<String, (bool, bool)> = BTreeMap::new();
    for (id, p) in &result.publications {
        if p.kind == "definition.publish" && p.eligible != Eligibility::NotSelected {
            let (active, deprecated) = definition_gates
                .entry(p.word.clone())
                .or_insert((false, true));
            *active |= p.eligible == Eligibility::Eligible
                && p.content_available
                && p.status == Status::Active;
            *deprecated &= p.eligible == Eligibility::Eligible && p.status == Status::Deprecated;
        }
        if p.kind == "rafsi.publish" {
            if let Some(a) = &p.assignment {
                assignments.entry(a.clone()).or_default().push(id.clone());
            }
        }
    }
    for ids in assignments.values() {
        let word = &result.publications[&ids[0]].word;
        let (active_definition, deprecated) =
            definition_gates.get(word).copied().unwrap_or_default();
        let all_deprecated = deprecated && !missing_selection && !unknown_word;
        let active_claim = ids.iter().any(|id| {
            let p = &result.publications[id];
            p.content_available && p.eligible == Eligibility::Eligible && p.status == Status::Active
        });
        let all_claims_deprecated = ids.iter().all(|id| {
            let p = &result.publications[id];
            p.content_available
                && p.eligible == Eligibility::Eligible
                && p.status == Status::Deprecated
        });
        let eligibility = if active_claim && active_definition {
            Eligibility::Eligible
        } else if all_deprecated || all_claims_deprecated {
            Eligibility::Inactive
        } else {
            Eligibility::Unknown
        };
        for id in ids {
            let p = result.publications.get_mut(id).unwrap();
            if p.eligible != Eligibility::NotSelected {
                p.eligible = eligibility.clone();
            }
        }
    }
}

fn lineage(graph: &graph::Graph, node: &graph::Node) -> BTreeMap<String, String> {
    node.action["parents"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str())
        .map(|id| {
            let state = match graph.nodes.get(id) {
                None => "pending",
                Some(parent)
                    if !parent.semantic
                        || parent.kind != "definition.publish"
                        || parent.action["word"] != node.action["word"]
                        || parent.action["language"] != node.action["language"] =>
                {
                    "invalid"
                }
                Some(_) => "resolved",
            };
            (id.to_owned(), state.into())
        })
        .collect()
}
fn action_targets(graph: &graph::Graph, result: &mut Evaluation) {
    action_targets_for(graph, result, None);
}
fn action_targets_for(graph: &graph::Graph, result: &mut Evaluation, only: Option<&str>) {
    for (id, node) in &graph.nodes {
        if only.is_some_and(|only| id != only) {
            continue;
        }
        if !node.semantic {
            continue;
        }
        if matches!(
            node.kind.as_str(),
            "definition.publish"
                | "rafsi.publish"
                | "view.publish"
                | "identity.profile"
                | "account.observe"
        ) && node.body.is_none()
        {
            let r = result.receipts.get_mut(id).unwrap();
            r.interpretation = Interpretation::Unavailable;
            r.reasons.insert("body_unavailable".into());
        }
        if let Some(p) = result.publications.get(id) {
            for state in p.lineage.values() {
                if state != "resolved" {
                    result
                        .receipts
                        .get_mut(id)
                        .unwrap()
                        .reasons
                        .insert(format!("lineage_{state}"));
                }
            }
        }
        if !matches!(
            node.kind.as_str(),
            "judgment.set" | "status.set" | "import.status" | "bridge.set"
        ) {
            continue;
        }
        let target = node.action["target"].as_str().unwrap_or_default();
        let mut pending = false;
        let mut invalid = false;
        if node.kind == "judgment.set" && target.starts_with("jvr1:") {
            pending = !result
                .publications
                .values()
                .any(|p| p.assignment.as_deref() == Some(target));
        } else {
            match graph.nodes.get(target) {
                None => pending = true,
                Some(n) => {
                    invalid = !n.semantic
                        || !matches!(n.kind.as_str(), "definition.publish" | "rafsi.publish");
                    if node.kind == "status.set" {
                        invalid |= n.action["origin"] != "native"
                            || !graph.structurally_connected(&n.issuer, &node.issuer, id);
                    }
                    if node.kind == "import.status" {
                        invalid |= n.kind != "definition.publish" || n.action["origin"] != "import";
                    }
                    if node.kind == "bridge.set" {
                        invalid |= n.kind != "definition.publish"
                            || n.action["origin"] != "native"
                            || graph.actor(&n.issuer) != graph.actor(&node.issuer);
                        if !invalid && node.action["value"] == "managed" {
                            let source_id = node.action["source_definition"].as_u64();
                            let origin = node.action["origin"].as_str().unwrap_or_default();
                            let linked = result
                                .publications
                                .values()
                                .filter(|p| {
                                    p.imported
                                        && p.kind == "definition.publish"
                                        && p.source_record == source_id
                                        && p.word == n.action["word"].as_str().unwrap_or_default()
                                        && p.language.as_deref() == n.action["language"].as_str()
                                })
                                .any(|p| {
                                    p.account
                                        .as_ref()
                                        .filter(|a| a.origin == origin)
                                        .and_then(|a| result.accounts.get(&a.token()))
                                        .is_some_and(|a| {
                                            a.commands
                                                && a.controller_identity.as_deref().is_some_and(
                                                    |key| {
                                                        graph.actor(key)
                                                            == graph.actor(&node.issuer)
                                                    },
                                                )
                                        })
                                });
                            if !linked {
                                let r = result.receipts.get_mut(id).unwrap();
                                r.interpretation = Interpretation::Pending;
                                r.reasons.insert("account_binding_unavailable".into());
                            }
                        }
                    }
                }
            }
        }
        if pending || invalid {
            let r = result.receipts.get_mut(id).unwrap();
            r.interpretation = if invalid {
                Interpretation::Inert
            } else {
                Interpretation::Pending
            };
            r.reasons.insert(
                if invalid {
                    "invalid_target"
                } else {
                    "target_pending"
                }
                .into(),
            );
        }
    }
}

fn reconcile_selections(graph: &graph::Graph, result: &mut Evaluation) {
    let mut slots: BTreeMap<(String, String, u64), BTreeSet<String>> = BTreeMap::new();
    for p in result.publications.values().filter(|p| {
        p.imported && p.kind == "definition.publish" && p.eligible == Eligibility::Eligible
    }) {
        if let (Some(source), Some(record)) = (&p.source, p.source_record) {
            slots
                .entry((source.clone(), graph.actor(&p.issuer), record))
                .or_default()
                .insert(p.id.clone());
        }
    }
    for ids in slots.values().filter(|ids| ids.len() > 1) {
        for id in ids {
            let p = result.publications.get_mut(id).unwrap();
            p.eligible = Eligibility::Unknown;
            p.status = Status::Unavailable;
            p.reasons.insert("source_selection_conflict".into());
        }
    }
}
