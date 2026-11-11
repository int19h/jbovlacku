//! Rebuild editorial state from authenticated records and explicitly selected policy.
//! Missing inputs remain visible. Record delivery order does not select a winner.
mod accounts;
mod ancestors;
mod api;
mod arena;
mod graph;
mod incremental;
mod policy;
pub use api::{
    AccountControl, Authority, Certificate, PublicationStatus, account_control, publication_status,
};
pub use arena::{ArrayValues, CompactValue, ValueView};
pub use incremental::{
    CHECKPOINT_VERSION, EvaluatedState, JudgmentChanges, RankingContextBound, UpdateStatistics,
};

use jvc_core::{BodyAvailability, VerifiedEnvelope, inspect_body, validate_action};
pub use policy::{
    Context, ContextGraph, PositiveEdge, RankingIndexCounts, evaluate_context,
    prepare_approximate_context,
};
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
/// An opaque projection held only in the trusted host's private storage.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct HostVerifiedRecord {
    node: graph::Node,
}
impl HostVerifiedRecord {
    /// The host guarantees that admission already checked these original bytes.
    pub fn extract_with<T>(
        id: &str,
        header: &jvc_core::Header,
        availability: BodyAvailability,
        inspect: impl FnOnce(&BodyAvailability) -> T,
    ) -> (Self, T) {
        let (node, content) = graph::Node::from_parts(id, header, availability, inspect);
        (Self { node }, content)
    }
    pub fn id(&self) -> &str {
        &self.node.id
    }
}

/// Authenticated records with only the content that state evaluation needs.
/// Fields stay private so callers cannot supply an unvalidated projection.
#[derive(Clone)]
pub struct PreparedEvaluationInput {
    options: EvaluationOptions,
    nodes: std::rc::Rc<BTreeMap<String, graph::Node>>,
    arena: arena::SharedArena,
    arena_error: Option<jvc_core::Error>,
    event_limit_exceeded: bool,
}
impl PreparedEvaluationInput {
    pub fn new(options: EvaluationOptions) -> Self {
        Self {
            options,
            nodes: std::rc::Rc::new(BTreeMap::new()),
            arena: std::rc::Rc::new(std::cell::RefCell::new(arena::RecordArena::default())),
            arena_error: None,
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
        if self.nodes.contains_key(event.id()) {
            return inspect(&inspect_body(event, body));
        }
        let (node, content) = graph::Node::new_with_in(self.arena.clone(), event, body, inspect);
        self.arena_error = self.arena.borrow().error();
        if self.nodes.len() >= self.options.limits.events {
            self.event_limit_exceeded = true;
        }
        std::rc::Rc::make_mut(&mut self.nodes).insert(event.id().into(), node);
        content
    }
    /// Only a trusted host can supply records from its private admission store.
    pub fn add_host_verified_record(&mut self, record: HostVerifiedRecord) {
        if self.nodes.contains_key(record.id()) {
            return;
        }
        let node = record.node.repack(&self.arena);
        let id = node.id.clone();
        self.arena_error = self.arena.borrow().error();
        if self.nodes.len() >= self.options.limits.events {
            self.event_limit_exceeded = true;
        }
        std::rc::Rc::make_mut(&mut self.nodes).insert(id, node);
    }
    pub(crate) fn arena_error(&self) -> Option<jvc_core::Error> {
        self.arena_error
            .clone()
            .or_else(|| self.arena.borrow().error())
    }
    #[doc(hidden)]
    pub fn record_arena_bytes(&self) -> usize {
        let mut arenas = BTreeMap::new();
        for node in self.nodes.values() {
            for value in std::iter::once(&node.action).chain(node.body.iter()) {
                arenas
                    .entry(value.arena_id())
                    .or_insert_with(|| value.allocated_bytes());
            }
        }
        arenas.values().sum()
    }
    #[doc(hidden)]
    pub fn record_node_string_bytes(&self) -> usize {
        self.nodes
            .iter()
            .map(|(key, node)| {
                key.capacity()
                    + node.id.capacity()
                    + node.issuer.capacity()
                    + node.previous.capacity() * size_of::<String>()
                    + node.previous.iter().map(|id| id.capacity()).sum::<usize>()
                    + node.kind.capacity()
                    + node.body_hash.as_ref().map_or(0, String::capacity)
                    + node.body_label.capacity()
            })
            .sum()
    }
    #[doc(hidden)]
    pub fn finish_load(&self) {
        self.arena.borrow_mut().finish_load();
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
            traversal: 10_000_000,
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
    /// Ancestry bytes the register's maxima merges charged in this
    /// evaluation. The incremental update prices its register from
    /// this stored charge instead of replaying the unions. Skipped
    /// in serialization; checkpoints carry the charges as one array
    /// in register order.
    #[serde(skip)]
    pub(crate) maxima_charge: usize,
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
#[derive(Clone, Debug, PartialEq)]
pub struct Evaluation {
    pub selected_view: String,
    pub available: bool,
    pub reasons: BTreeSet<String>,
    results: std::rc::Rc<EvaluationResults>,
    pub overlay: Option<Value>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct EvaluationResults {
    pub receipts: BTreeMap<String, Receipt>,
    pub lifecycle: Lifecycle,
    pub publications: BTreeMap<String, Publication>,
    pub accounts: BTreeMap<String, AccountState>,
    pub registers: BTreeMap<String, Register>,
    pub judgments: BTreeMap<String, BTreeMap<String, Judgment>>,
    pub policy: Option<CompactValue>,
    pub(crate) policies: Vec<CompactValue>,
    pub(crate) policy_history: BTreeMap<String, CompactValue>,
    pub(crate) selections: BTreeMap<String, BTreeSet<String>>,
    pub(crate) trust: Vec<TrustRule>,
}
impl std::ops::Deref for Evaluation {
    type Target = EvaluationResults;
    fn deref(&self) -> &Self::Target {
        &self.results
    }
}
impl std::ops::DerefMut for Evaluation {
    fn deref_mut(&mut self) -> &mut Self::Target {
        std::rc::Rc::make_mut(&mut self.results)
    }
}
impl Serialize for Evaluation {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(Some(15))?;
        map.serialize_entry("selected_view", &self.selected_view)?;
        map.serialize_entry("available", &self.available)?;
        map.serialize_entry("reasons", &self.reasons)?;
        map.serialize_entry("receipts", &self.receipts)?;
        map.serialize_entry("lifecycle", &self.lifecycle)?;
        map.serialize_entry("publications", &self.publications)?;
        map.serialize_entry("accounts", &self.accounts)?;
        map.serialize_entry("registers", &self.registers)?;
        map.serialize_entry("judgments", &self.judgments)?;
        map.serialize_entry("policy", &self.policy)?;
        map.serialize_entry("overlay", &self.overlay)?;
        map.serialize_entry("policies", &self.policies)?;
        map.serialize_entry("policy_history", &self.policy_history)?;
        map.serialize_entry("selections", &self.selections)?;
        map.serialize_entry("trust", &self.trust)?;
        map.end()
    }
}
impl<'de> Deserialize<'de> for Evaluation {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct Wire {
            selected_view: String,
            available: bool,
            reasons: BTreeSet<String>,
            #[serde(flatten)]
            results: EvaluationResults,
            overlay: Option<Value>,
        }
        let wire = Wire::deserialize(deserializer)?;
        Ok(Self {
            selected_view: wire.selected_view,
            available: wire.available,
            reasons: wire.reasons,
            results: std::rc::Rc::new(wire.results),
            overlay: wire.overlay,
        })
    }
}
impl Evaluation {
    pub fn with_overlay(&self, overlay: Option<Value>, suspended: impl Fn(&str) -> bool) -> Self {
        let overlay_reason = self.reasons.contains("invalid_overlay")
            || self.reasons.contains("public_shun_issuer_unavailable");
        let mut result = Self {
            selected_view: self.selected_view.clone(),
            available: if overlay_reason {
                !self.reasons.contains("resource_unavailable")
                    && !self.reasons.contains("view_unavailable")
            } else {
                self.available
            },
            reasons: self.reasons.clone(),
            results: self.results.clone(),
            overlay,
        };
        result.reasons.remove("invalid_overlay");
        result.reasons.remove("public_shun_issuer_unavailable");
        apply_overlay(&mut result, &suspended);
        result
    }
}
fn apply_overlay(result: &mut Evaluation, suspended: &impl Fn(&str) -> bool) {
    if result
        .overlay
        .as_ref()
        .is_some_and(|overlay| !policy::valid_overlay(overlay, &result.selected_view))
    {
        result.available = false;
        result.reasons.insert("invalid_overlay".into());
    } else if result
        .overlay
        .as_ref()
        .and_then(|overlay| overlay["public_shun_issuer"].as_str())
        .is_some_and(suspended)
    {
        result.available = false;
        result
            .reasons
            .insert("public_shun_issuer_unavailable".into());
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub(crate) struct TrustRule {
    pub actor: String,
    pub subject: String,
    pub scope: CompactValue,
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
    if prepared.arena_error().is_some() {
        let mut result = empty_evaluation(&prepared.options);
        resource_unavailable(&mut result);
        return result;
    }
    if prepared.event_limit_exceeded {
        return event_limit_evaluation(&prepared.options);
    }
    let PreparedEvaluationInput {
        options: input,
        nodes,
        arena,
        ..
    } = prepared;
    let graph = graph::Graph::new(nodes, &input.limits);
    let result = evaluate_graph(&input, &graph);
    arena.borrow_mut().finish_load();
    result
}
fn empty_evaluation(input: &EvaluationOptions) -> Evaluation {
    Evaluation {
        selected_view: input.selected_view.clone(),
        available: true,
        reasons: BTreeSet::new(),
        results: std::rc::Rc::new(EvaluationResults {
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
            policies: Vec::new(),
            policy_history: BTreeMap::new(),
            selections: BTreeMap::new(),
            trust: Vec::new(),
        }),
        overlay: input.overlay.clone(),
    }
}
fn event_limit_evaluation(input: &EvaluationOptions) -> Evaluation {
    let mut result = empty_evaluation(input);
    result.available = false;
    result.reasons.insert("resource_unavailable".into());
    result
}
fn evaluate_graph(input: &EvaluationOptions, graph: &graph::Graph) -> Evaluation {
    let mut result = empty_evaluation(input);
    if graph.resource.get() {
        resource_unavailable(&mut result);
        return result;
    }
    result.lifecycle = graph.lifecycle.clone();
    if !result.lifecycle.suspended.is_empty() {
        result.reasons.insert("conditional_on_suspension".into());
    }
    for (id, node) in graph.nodes.as_ref() {
        let mut reasons = BTreeSet::new();
        let interpretation = if !node.semantic {
            reasons.insert("invalid_action".into());
            Interpretation::Inert
        } else if !graph.own_complete(id) {
            reasons.insert("own_history_pending".into());
            Interpretation::Pending
        } else if matches!(node.kind.as_str(), "definition.publish" | "rafsi.publish")
            && graph.excluded_by_resolved(id)
        {
            reasons.insert("outside_retained_history".into());
            Interpretation::Inert
        } else if graph.pending_cutoffs.contains(&node.issuer)
            && matches!(node.kind.as_str(), "definition.publish" | "rafsi.publish")
        {
            reasons.insert("cutoff_pending".into());
            Interpretation::Suspended
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
    apply_overlay(&mut result, &|issuer| graph.suspended(issuer));
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
    if graph.resource.get() || graph.ancestry.failed() {
        resource_unavailable(&mut result);
        return result;
    }
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
    // With a restricted set, visit only those records instead of
    // scanning every record per append.
    let restricted: Vec<(&String, &graph::Node)> = match only {
        Some(ids) => ids
            .iter()
            .filter_map(|id| graph.nodes.get_key_value(id))
            .collect(),
        None => graph.nodes.iter().collect(),
    };
    for (id, node) in restricted {
        if !node.semantic || !matches!(node.kind.as_str(), "definition.publish" | "rafsi.publish") {
            continue;
        }
        let imported = node.action.view().index("origin") == "import";
        let body = node.body.as_ref().map(|body| body.view());
        let legacy = body.as_ref().and_then(|body| body.get("legacy"));
        let source = legacy
            .as_ref()
            .and_then(|legacy| legacy.index("source").as_str().map(str::to_owned));
        let source_record = legacy
            .as_ref()
            .and_then(|legacy| legacy.index("record").index("id").as_u64());
        let account = legacy.as_ref().and_then(|legacy| {
            let a = legacy.index("attribution").index("author_account");
            if a.index("evidence").index("kind") != "source-id" {
                return None;
            }
            Some(AccountKey {
                origin: a.index("origin").as_str()?.into(),
                account: a.index("account").as_u64()?,
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
                for entry in policy
                    .view()
                    .index("import_sets")
                    .as_array()
                    .into_iter()
                    .flatten()
                {
                    if entry.index("importer").as_str() != Some(&node.issuer)
                        || source
                            .as_deref()
                            .is_some_and(|s| Some(s) != entry.index("source").as_str())
                    {
                        continue;
                    }
                    match entry
                        .index("selection")
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
                word: node
                    .action
                    .view()
                    .index("word")
                    .as_str()
                    .unwrap_or_default()
                    .into(),
                language: node
                    .action
                    .view()
                    .index("language")
                    .as_str()
                    .map(str::to_owned),
                assignment: node
                    .action
                    .view()
                    .index("assignment")
                    .as_str()
                    .map(str::to_owned),
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
    let mut status_records: BTreeMap<String, Vec<&graph::Node>> = BTreeMap::new();
    for node in graph
        .nodes
        .values()
        .filter(|n| n.semantic && n.kind == "status.set")
    {
        let target = node.action.view().index("target");
        if let Some(target) = target.as_str().map(str::to_owned) {
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
        let values: BTreeSet<String> = frontier
            .iter()
            .map(|id| {
                graph.nodes[id]
                    .action
                    .view()
                    .index("value")
                    .as_str()
                    .unwrap_or_default()
                    .into()
            })
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
    for (id, n) in graph.nodes.as_ref() {
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
                n.action.view().index("target").as_str().unwrap_or_default()
            ),
            "trust.set" => format!(
                "trust|{}|{}",
                graph.actor(
                    n.action
                        .view()
                        .index("subject")
                        .as_str()
                        .unwrap_or_default()
                ),
                n.action.view().index("scope")
            ),
            "identity.profile" => "profile".into(),
            "report.set" => format!(
                "report|{}|{}",
                n.action.view().index("subject"),
                n.action.view().index("category")
            ),
            "bridge.set" => format!(
                "bridge|{}|{}",
                n.action.view().index("origin"),
                n.action.view().index("source_definition")
            ),
            "account.set" => format!(
                "account|{}|{}",
                n.action.view().index("origin"),
                n.action.view().index("account")
            ),
            "account.observe" => format!(
                "observe|{}|{}",
                n.action.view().index("origin"),
                n.action.view().index("account")
            ),
            _ => continue,
        };
        groups
            .entry(format!("{actor}|{key}"))
            .or_default()
            .push(id.clone());
    }
    let mut scope_arena = None;
    for (key, ids) in groups {
        let charge_before = graph.ancestry.bytes();
        let heads = graph.maxima(ids.into_iter().collect(), false);
        let maxima_charge = graph.ancestry.bytes() - charge_before;
        let node = &graph.nodes[heads.iter().next().unwrap()];
        let actor = graph.actor(&node.issuer);
        let values: BTreeSet<String> = heads
            .iter()
            .map(|id| {
                let n = &graph.nodes[id];
                match n.kind.as_str() {
                    "identity.profile" => n.body_hash.clone().unwrap_or_default(),
                    "bridge.set" if n.action.view().index("value") == "managed" => {
                        format!("managed|{}", n.action.view().index("target"))
                    }
                    "account.observe" => format!(
                        "{}|{}",
                        n.action.view().index("result"),
                        n.action.view().index("claim")
                    ),
                    "account.set" if n.action.view().index("value") == "claim" => n.id.clone(),
                    _ => n
                        .action
                        .view()
                        .index("value")
                        .as_str()
                        .unwrap_or_default()
                        .into(),
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
                .entry(
                    node.action
                        .view()
                        .index("target")
                        .as_str()
                        .unwrap_or_default()
                        .into(),
                )
                .or_default()
                .insert(actor.clone(), judgment);
        }
        if node.kind == "trust.set" {
            result.trust.push(TrustRule {
                actor: actor.clone(),
                subject: graph.actor(
                    node.action
                        .view()
                        .index("subject")
                        .as_str()
                        .unwrap_or_default(),
                ),
                scope: CompactValue::from_view_in(
                    scope_arena
                        .get_or_insert_with(|| {
                            std::rc::Rc::new(std::cell::RefCell::new(arena::RecordArena::default()))
                        })
                        .clone(),
                    node.action.view().index("scope"),
                ),
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
                maxima_charge,
            },
        );
    }
}
fn rafsi_gate(result: &mut Evaluation) {
    let receipts = &result.receipts;
    let effective = |id: &str| {
        receipts
            .get(id)
            .is_some_and(|r| r.interpretation == Interpretation::Effective)
    };
    let excluded = |id: &str| {
        receipts.get(id).is_some_and(|r| {
            r.interpretation == Interpretation::Inert
                || r.reasons.contains("outside_retained_history")
        })
    };
    let missing_selection = result.reasons.contains("import_selection_unavailable")
        || result.reasons.contains("selection_publications_pending");
    let unknown_word = result.publications.values().any(|p| {
        p.kind == "definition.publish"
            && !excluded(&p.id)
            && p.word.is_empty()
            && p.eligible == Eligibility::Unknown
    });
    let mut assignments: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut definition_gates: BTreeMap<String, (bool, bool)> = BTreeMap::new();
    let mut uncertain_words = BTreeSet::new();
    let mut updates = Vec::new();
    for (id, p) in &result.publications {
        if p.kind == "definition.publish" && p.eligible != Eligibility::NotSelected {
            if !effective(id) {
                // Missing evidence blocks an all-deprecated result. Excluded history does not.
                if !excluded(id) {
                    uncertain_words.insert(p.word.clone());
                }
                continue;
            }
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
        let all_deprecated =
            deprecated && !uncertain_words.contains(word) && !missing_selection && !unknown_word;
        let retained_claims: Vec<_> = ids.iter().filter(|id| !excluded(id)).collect();
        let active_claim = retained_claims.iter().any(|id| {
            let p = &result.publications[id.as_str()];
            effective(id)
                && p.content_available
                && p.eligible == Eligibility::Eligible
                && p.status == Status::Active
        });
        let all_claims_deprecated = !retained_claims.is_empty()
            && retained_claims.iter().all(|id| {
                let p = &result.publications[id.as_str()];
                effective(id)
                    && p.content_available
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
            if result.publications[id].eligible != Eligibility::NotSelected {
                updates.push((id.clone(), eligibility.clone()));
            }
        }
    }
    for (id, eligibility) in updates {
        result.publications.get_mut(&id).unwrap().eligible = eligibility;
    }
}

fn lineage(graph: &graph::Graph, node: &graph::Node) -> BTreeMap<String, String> {
    node.action
        .view()
        .index("parents")
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .map(|id| {
            let state = match graph.nodes.get(&id) {
                None => "pending",
                Some(parent)
                    if !parent.semantic
                        || parent.kind != "definition.publish"
                        || parent.action.view().index("word")
                            != node.action.view().index("word")
                        || parent.action.view().index("language")
                            != node.action.view().index("language") =>
                {
                    "invalid"
                }
                Some(_) => "resolved",
            };
            (id, state.into())
        })
        .collect()
}
fn action_targets(graph: &graph::Graph, result: &mut Evaluation) {
    action_targets_for(graph, result, None);
}
fn action_targets_for(graph: &graph::Graph, result: &mut Evaluation, only: Option<&str>) {
    let restricted: Vec<(&String, &graph::Node)> = match only {
        Some(id) => graph.nodes.get_key_value(id).into_iter().collect(),
        None => graph.nodes.iter().collect(),
    };
    for (id, node) in restricted {
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
        let lineage_states: Vec<String> = result
            .publications
            .get(id)
            .into_iter()
            .flat_map(|p| p.lineage.values())
            .filter(|state| *state != "resolved")
            .cloned()
            .collect();
        for state in lineage_states {
            result
                .receipts
                .get_mut(id)
                .unwrap()
                .reasons
                .insert(format!("lineage_{state}"));
        }
        if !matches!(
            node.kind.as_str(),
            "judgment.set" | "status.set" | "import.status" | "bridge.set"
        ) {
            continue;
        }
        let target = node.action.view().index("target");
        let target = target.as_str().unwrap_or_default();
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
                        invalid |= n.action.view().index("origin") != "native"
                            || !graph.structurally_connected(&n.issuer, &node.issuer, id);
                    }
                    if node.kind == "import.status" {
                        invalid |= n.kind != "definition.publish"
                            || n.action.view().index("origin") != "import";
                    }
                    if node.kind == "bridge.set" {
                        invalid |= n.kind != "definition.publish"
                            || n.action.view().index("origin") != "native"
                            || graph.actor(&n.issuer) != graph.actor(&node.issuer);
                        if !invalid && node.action.view().index("value") == "managed" {
                            let source_id = node.action.view().index("source_definition").as_u64();
                            let origin = node.action.view().index("origin");
                            let origin = origin.as_str().unwrap_or_default();
                            let linked = result
                                .publications
                                .values()
                                .filter(|p| {
                                    p.imported
                                        && p.kind == "definition.publish"
                                        && p.source_record == source_id
                                        && p.word
                                            == n.action
                                                .view()
                                                .index("word")
                                                .as_str()
                                                .unwrap_or_default()
                                        && p.language.as_deref()
                                            == n.action.view().index("language").as_str()
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

#[cfg(test)]
mod event_limit_tests {
    use super::*;
    use jvc_core::{Header, identity_from_seed, sign_header, verify_envelope};
    use serde_json::json;

    fn records() -> Vec<VerifiedEnvelope> {
        let issuer = identity_from_seed(&[1; 32]);
        let subject = identity_from_seed(&[2; 32]);
        let mut records: Vec<VerifiedEnvelope> = Vec::new();
        for nonce in 0..3 {
            let signed = sign_header(&[1; 32], Header {
                version: 1,
                issuer: issuer.clone(),
                previous: records.last().map(|e| vec![e.id().into()]).unwrap_or_default(),
                nonce: format!("{nonce:032x}"),
                action: json!({"kind":"trust.set","subject":subject,"scope":{"kind":"*","word":"*","language":"*"},"value":"heed"}),
                content: None,
            }).unwrap();
            records.push(verify_envelope(&signed.canonical_envelope().unwrap()).unwrap());
        }
        records
    }

    fn prepared(records: &[VerifiedEnvelope], limit: usize) -> PreparedEvaluationInput {
        let limits = Limits {
            events: limit,
            ..Limits::default()
        };
        let mut prepared = PreparedEvaluationInput::new(EvaluationOptions {
            selected_view: format!("jve1:{}", "0".repeat(64)),
            import_selections: BTreeMap::new(),
            overlay: None,
            limits,
        });
        for record in records {
            prepared.add_record(record, None);
        }
        prepared
    }

    #[test]
    fn duplicate_records_do_not_grow_the_arena_and_still_run_inspect() {
        let records = records();
        let mut prepared = prepared(&records, records.len());
        let before = prepared.record_arena_bytes();
        let mut inspected = 0;
        for record in &records {
            let absent = prepared.add_record_with(record, None, |availability| {
                inspected += 1;
                matches!(availability, BodyAvailability::Absent)
            });
            assert!(absent);
        }
        assert_eq!(inspected, records.len());
        assert_eq!(prepared.record_arena_bytes(), before);

        for record in &records {
            let (host, ()) = HostVerifiedRecord::extract_with(
                record.id(),
                record.header(),
                BodyAvailability::Absent,
                |_| (),
            );
            prepared.add_host_verified_record(host);
        }
        assert_eq!(prepared.nodes.len(), records.len());
        assert_eq!(prepared.record_arena_bytes(), before);
    }

    #[test]
    fn arena_bytes_include_a_body_arena_separate_from_the_action() {
        let records = records();
        let mut prepared = prepared(&records, records.len());
        let action_bytes = prepared.record_arena_bytes();
        let body = CompactValue::from(json!({"retained": "body"}));
        let body_bytes = body.allocated_bytes();
        std::rc::Rc::make_mut(&mut prepared.nodes)
            .get_mut(records[0].id())
            .unwrap()
            .body = Some(body);
        assert_eq!(prepared.record_arena_bytes(), action_bytes + body_bytes);
    }

    #[test]
    fn prepared_event_limit_stops_before_graph_construction() {
        let prepared = prepared(&records(), 1);
        let before = graph::construction_count();
        let result = prepared.evaluate();
        assert!(!result.available);
        assert_eq!(
            result.reasons,
            BTreeSet::from(["resource_unavailable".into()])
        );
        assert_eq!(
            graph::construction_count(),
            before,
            "over-limit preparation constructed a graph"
        );
    }

    #[test]
    fn retained_event_limit_stops_before_graph_and_recovers_every_authenticated_node() {
        let records = records();
        let before = graph::construction_count();
        let mut state = prepared(&records, 1).into_state();
        assert!(!state.evaluation().available);
        assert_eq!(
            graph::construction_count(),
            before,
            "over-limit state constructed a graph"
        );
        let options = prepared(&[], 1).options;
        state = state.advance(PreparedEvaluationInput::new(options), &[]);
        assert_eq!(
            graph::construction_count(),
            before,
            "over-limit advance constructed a graph"
        );
        let expected = prepared(&records, records.len());
        state = state.advance(PreparedEvaluationInput::new(expected.options.clone()), &[]);
        assert_eq!(graph::construction_count(), before + 1);
        assert_eq!(state.evaluation().receipts.len(), records.len());
        assert!(!state.evaluation().reasons.contains("resource_unavailable"));
        assert_eq!(state.evaluation(), &expected.evaluate());
    }
}
