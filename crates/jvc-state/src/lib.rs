//! Rebuild editorial state from authenticated records and explicitly selected policy.
//! Missing inputs remain visible. Record delivery order does not select a winner.
mod accounts;
mod ancestors;
mod api;
mod arena;
mod graph;
mod incremental;
mod policy;
mod projection;
pub use ancestors::{ANCESTRY_CAP_BASE, ANCESTRY_CAP_PER_RECORD, ancestry_cap};
pub use api::{
    AccountControl, Authority, Certificate, PublicationStatus, PublicationStatusRef,
    account_control, publication_status, publication_status_ref,
};
pub use arena::{
    ArrayValues, CompactValue, ValueView, lookup_work, packed_value_nodes,
    reset_packed_value_nodes, reset_serialized_value_bytes, reset_setup_lookup_calls,
    reset_validated_string_bytes, serialized_value_bytes, setup_lookup_calls,
    validated_string_bytes,
};
pub use incremental::{
    CHECKPOINT_VERSION, EvaluatedState, JudgmentChanges, MAX_INCREMENTAL_RECORDS,
    RankingContextBound, UpdateStatistics,
};
pub use projection::{PROJECTION_ROW_VERSION, ProjectionRow};

use jvc_core::{BodyAvailability, VerifiedEnvelope, inspect_body, validate_action};
pub use policy::{
    Context, ContextGraph, PositiveEdge, RankingIndexCounts, SetupMeter, evaluate_context,
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
    /// Shared, so that cloning options or a state copies one pointer.
    #[serde(deserialize_with = "Option::deserialize")]
    pub overlay: Option<std::rc::Rc<Value>>,
    pub limits: Limits,
}
/// The default budget before selections: `base` plus the record and
/// predecessor terms. The selection resolver stops on the same value,
/// so the two cannot disagree on it.
pub(crate) fn default_input_budget(base: usize, records: usize, predecessors: usize) -> usize {
    base.saturating_add(records.saturating_mul(DEFAULT_TRAVERSAL_PER_RECORD))
        .saturating_add(predecessors.saturating_mul(DEFAULT_TRAVERSAL_PER_PREDECESSOR))
}
/// The number of `previous` IDs over all records, for the default budget.
pub(crate) fn predecessor_edges(nodes: &BTreeMap<String, graph::Node>) -> usize {
    nodes.values().map(|node| node.previous.len()).sum()
}
impl EvaluationOptions {
    pub(crate) fn traversal_budget_for_nodes(
        &self,
        nodes: &BTreeMap<String, graph::Node>,
    ) -> usize {
        let resolved = policy::resolve_referenced_selections(self, nodes);
        self.limits.traversal_budget_with_selections(
            nodes.len(),
            predecessor_edges(nodes),
            resolved.allowance,
        )
    }
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
    import_selections: std::rc::Rc<BTreeMap<String, Vec<String>>>,
    nodes: std::rc::Rc<BTreeMap<String, graph::Node>>,
    arena: arena::SharedArena,
    arena_error: Option<jvc_core::Error>,
    event_limit_exceeded: bool,
    validated_selections: std::rc::Rc<std::cell::RefCell<BTreeMap<String, bool>>>,
}
impl PreparedEvaluationInput {
    pub fn new(mut options: EvaluationOptions) -> Self {
        let import_selections = std::rc::Rc::new(std::mem::take(&mut options.import_selections));
        Self {
            options,
            import_selections,
            nodes: std::rc::Rc::new(BTreeMap::new()),
            arena: std::rc::Rc::new(std::cell::RefCell::new(arena::RecordArena::default())),
            arena_error: None,
            event_limit_exceeded: false,
            validated_selections: Default::default(),
        }
    }
    #[cfg(test)]
    pub(crate) fn options_with_selections(&self) -> EvaluationOptions {
        let mut options = self.options.clone();
        options.import_selections = (*self.import_selections).clone();
        options
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
        let error = self.arena.borrow_mut().take_error();
        if error.is_some() {
            self.arena_error = error;
        }
        if self
            .options
            .limits
            .events
            .is_some_and(|limit| self.nodes.len() >= limit)
        {
            self.event_limit_exceeded = true;
        }
        std::rc::Rc::make_mut(&mut self.nodes).insert(event.id().into(), node);
        content
    }
    fn add_projection_node(&mut self, node: graph::Node) {
        let node = node.repack(&self.arena);
        let id = node.id.clone();
        let error = self.arena.borrow_mut().take_error();
        if error.is_some() {
            self.arena_error = error;
        }
        if self
            .options
            .limits
            .events
            .is_some_and(|limit| self.nodes.len() >= limit)
        {
            self.event_limit_exceeded = true;
        }
        std::rc::Rc::make_mut(&mut self.nodes).insert(id, node);
    }
    /// Only a trusted host can supply records from its private admission store.
    pub fn add_host_verified_record(&mut self, record: HostVerifiedRecord) {
        if self.nodes.contains_key(record.id()) {
            return;
        }
        self.add_projection_node(record.node);
    }
    /// The browser authenticates this row at sync or during a complete rebuild.
    pub fn add_projection_row(&mut self, row: ProjectionRow) {
        if self.nodes.contains_key(row.id()) {
            return;
        }
        self.add_projection_node(row.node);
    }
    pub fn clear_import_selections(&mut self) {
        self.import_selections = Default::default();
        self.validated_selections = Default::default();
    }
    pub fn insert_import_selection(&mut self, hash: String, ids: Vec<String>) {
        std::rc::Rc::make_mut(&mut self.validated_selections)
            .get_mut()
            .remove(&hash);
        std::rc::Rc::make_mut(&mut self.import_selections).insert(hash, ids);
    }
    pub fn inherit_import_selections(&mut self, base: &EvaluatedState) {
        self.import_selections = base.shared_import_selections().clone();
        self.validated_selections = base.shared_validated_selections().clone();
    }
    pub(crate) fn arena_error(&self) -> Option<jvc_core::Error> {
        self.arena_error.clone()
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
pub const DEFAULT_TRAVERSAL_BASE: usize = 10_000_000;
pub const DEFAULT_TRAVERSAL_PER_RECORD: usize = 256;
/// Default budget units per `previous` ID that a record names, present
/// or absent. Each one is part of the input, and graph construction
/// charges for it in the layout and in each of the three link modes.
pub const DEFAULT_TRAVERSAL_PER_PREDECESSOR: usize = 16;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Limits {
    #[serde(deserialize_with = "Option::deserialize")]
    pub events: Option<usize>,
    #[serde(deserialize_with = "Option::deserialize")]
    pub traversal: Option<usize>,
    pub claim_depth: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            events: None,
            traversal: None,
            claim_depth: 1024,
        }
    }
}
impl Limits {
    /// `predecessors` counts every `previous` ID of every record.
    pub fn traversal_budget(&self, records: usize, predecessors: usize) -> usize {
        self.traversal_budget_with_selections(records, predecessors, 0)
    }
    pub fn traversal_budget_with_selections(
        &self,
        records: usize,
        predecessors: usize,
        selection_ids: usize,
    ) -> usize {
        self.traversal.unwrap_or_else(|| {
            default_input_budget(DEFAULT_TRAVERSAL_BASE, records, predecessors)
                .saturating_add(selection_ids)
        })
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
#[serde(deny_unknown_fields)]
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
#[serde(deny_unknown_fields)]
pub struct AccountKey {
    pub origin: String,
    pub account: u64,
}
impl AccountKey {
    pub(crate) fn token(&self) -> String {
        format!("{}#{}", self.origin, self.account)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Publication {
    pub id: String,
    pub issuer: String,
    pub kind: String,
    pub word: String,
    #[serde(deserialize_with = "Option::deserialize")]
    pub language: Option<String>,
    #[serde(deserialize_with = "Option::deserialize")]
    pub assignment: Option<String>,
    pub lineage: BTreeMap<String, String>,
    pub imported: bool,
    #[serde(deserialize_with = "Option::deserialize")]
    pub source: Option<String>,
    #[serde(deserialize_with = "Option::deserialize")]
    pub source_record: Option<u64>,
    #[serde(deserialize_with = "Option::deserialize")]
    pub account: Option<AccountKey>,
    pub authority: Authority,
    #[serde(deserialize_with = "Option::deserialize")]
    pub controller: Option<String>,
    #[serde(deserialize_with = "Option::deserialize")]
    pub claim: Option<String>,
    pub observations: BTreeSet<String>,
    pub status_frontier: BTreeSet<String>,
    #[serde(deserialize_with = "Option::deserialize")]
    pub deciding_claim: Option<String>,
    pub controller_candidates: BTreeSet<String>,
    /// The account's contributions, shared with `AccountState`.
    /// Checkpoints leave it out (`CheckpointEvaluation`), and restore
    /// sets it from the account again, so a missing field reads as
    /// empty. A checkpoint reader refuses the field when it is present
    /// (`take_explicit_contributions`), even as an empty map.
    #[serde(default, deserialize_with = "deserialize_witness_contributions")]
    pub witness_contributions: Contributions,
    pub missing: BTreeSet<String>,
    pub content_available: bool,
    pub eligible: Eligibility,
    pub status: Status,
    pub reasons: BTreeSet<String>,
}
thread_local! {
    /// Set when a publication's input names `witness_contributions`.
    static EXPLICIT_CONTRIBUTIONS: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}
/// Serde calls this only when the field is present, so it records the
/// presence that `#[serde(default)]` alone would hide.
fn deserialize_witness_contributions<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Contributions, D::Error> {
    EXPLICIT_CONTRIBUTIONS.with(|seen| seen.set(true));
    Contributions::deserialize(deserializer)
}
/// Whether a publication decoded on this thread since the last call
/// named `witness_contributions`. Checkpoint readers call it before
/// and after decoding.
pub(crate) fn take_explicit_contributions() -> bool {
    EXPLICIT_CONTRIBUTIONS.with(|seen| seen.replace(false))
}
/// Witness keys to the claims they observed. Every publication credited
/// to an account shares the account's map, so a publication costs one
/// reference, not a copy of the evidence. Serialized as the plain map.
pub type Contributions = std::rc::Rc<BTreeMap<String, BTreeSet<String>>>;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AccountState {
    pub account: AccountKey,
    #[serde(deserialize_with = "Option::deserialize")]
    pub controller: Option<String>,
    pub candidates: BTreeSet<String>,
    pub contributions: Contributions,
    pub observation_evidence: BTreeMap<String, BTreeSet<String>>,
    pub certificates: Vec<Certificate>,
    pub chain: BTreeSet<String>,
    #[serde(deserialize_with = "Option::deserialize")]
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
#[serde(deny_unknown_fields)]
pub struct Register {
    pub actor: String,
    pub key: String,
    pub heads: BTreeSet<String>,
    pub values: BTreeSet<String>,
    pub conflicted: bool,
    /// Work the register's maxima merges charged in this evaluation.
    /// The incremental update prices its register from this stored
    /// charge instead of replaying the merges. Skipped in
    /// serialization; checkpoints carry the counters as arrays in
    /// register order.
    #[serde(skip)]
    pub(crate) maxima_work: usize,
    #[serde(skip)]
    pub(crate) maxima_member_work: usize,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
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
    /// Shared with the options it came from, so that cloning a state
    /// copies one pointer.
    pub overlay: Option<std::rc::Rc<Value>>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct EvaluationResults {
    pub receipts: BTreeMap<String, Receipt>,
    pub lifecycle: Lifecycle,
    pub publications: BTreeMap<String, Publication>,
    pub accounts: BTreeMap<String, AccountState>,
    pub registers: BTreeMap<String, Register>,
    pub judgments: BTreeMap<String, BTreeMap<String, Judgment>>,
    #[serde(deserialize_with = "Option::deserialize")]
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
        self.serialize_as(serializer, false)
    }
}
/// The evaluation as a checkpoint stores it: every publication without
/// its `witness_contributions`. Each credited publication shares its
/// account's map, and the account is stored once, so restore sets the
/// publications' maps from it instead of reading one copy for each.
pub(crate) struct CheckpointEvaluation<'a>(pub &'a Evaluation);
impl Serialize for CheckpointEvaluation<'_> {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        self.0.serialize_as(serializer, true)
    }
}
struct CheckpointPublications<'a>(&'a BTreeMap<String, Publication>);
impl Serialize for CheckpointPublications<'_> {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        serializer.collect_map(
            self.0
                .iter()
                .map(|(id, p)| (id, CheckpointPublication::from(p))),
        )
    }
}
/// A publication's fields in their serialized order, without
/// `witness_contributions`.
#[derive(Serialize)]
struct CheckpointPublication<'a> {
    id: &'a String,
    issuer: &'a String,
    kind: &'a String,
    word: &'a String,
    language: &'a Option<String>,
    assignment: &'a Option<String>,
    lineage: &'a BTreeMap<String, String>,
    imported: &'a bool,
    source: &'a Option<String>,
    source_record: &'a Option<u64>,
    account: &'a Option<AccountKey>,
    authority: &'a Authority,
    controller: &'a Option<String>,
    claim: &'a Option<String>,
    observations: &'a BTreeSet<String>,
    status_frontier: &'a BTreeSet<String>,
    deciding_claim: &'a Option<String>,
    controller_candidates: &'a BTreeSet<String>,
    missing: &'a BTreeSet<String>,
    content_available: &'a bool,
    eligible: &'a Eligibility,
    status: &'a Status,
    reasons: &'a BTreeSet<String>,
}
impl<'a> From<&'a Publication> for CheckpointPublication<'a> {
    fn from(p: &'a Publication) -> Self {
        // Every field is named, so a new publication field does not
        // compile until it is added here too.
        let Publication {
            id,
            issuer,
            kind,
            word,
            language,
            assignment,
            lineage,
            imported,
            source,
            source_record,
            account,
            authority,
            controller,
            claim,
            observations,
            status_frontier,
            deciding_claim,
            controller_candidates,
            witness_contributions: _,
            missing,
            content_available,
            eligible,
            status,
            reasons,
        } = p;
        Self {
            id,
            issuer,
            kind,
            word,
            language,
            assignment,
            lineage,
            imported,
            source,
            source_record,
            account,
            authority,
            controller,
            claim,
            observations,
            status_frontier,
            deciding_claim,
            controller_candidates,
            missing,
            content_available,
            eligible,
            status,
            reasons,
        }
    }
}
impl Evaluation {
    fn serialize_as<S: serde::Serializer>(
        &self,
        serializer: S,
        checkpoint: bool,
    ) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(Some(15))?;
        map.serialize_entry("selected_view", &self.selected_view)?;
        map.serialize_entry("available", &self.available)?;
        map.serialize_entry("reasons", &self.reasons)?;
        map.serialize_entry("receipts", &self.receipts)?;
        map.serialize_entry("lifecycle", &self.lifecycle)?;
        if checkpoint {
            map.serialize_entry("publications", &CheckpointPublications(&self.publications))?;
        } else {
            map.serialize_entry("publications", &self.publications)?;
        }
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
        #[serde(deny_unknown_fields)]
        struct Wire {
            selected_view: String,
            available: bool,
            reasons: BTreeSet<String>,
            receipts: BTreeMap<String, Receipt>,
            lifecycle: Lifecycle,
            publications: BTreeMap<String, Publication>,
            accounts: BTreeMap<String, AccountState>,
            registers: BTreeMap<String, Register>,
            judgments: BTreeMap<String, BTreeMap<String, Judgment>>,
            #[serde(deserialize_with = "Option::deserialize")]
            policy: Option<CompactValue>,
            #[serde(deserialize_with = "Option::deserialize")]
            overlay: Option<std::rc::Rc<Value>>,
            policies: Vec<CompactValue>,
            policy_history: BTreeMap<String, CompactValue>,
            selections: BTreeMap<String, BTreeSet<String>>,
            trust: Vec<TrustRule>,
        }
        let wire = Wire::deserialize(deserializer)?;
        Ok(Self {
            selected_view: wire.selected_view,
            available: wire.available,
            reasons: wire.reasons,
            results: std::rc::Rc::new(EvaluationResults {
                receipts: wire.receipts,
                lifecycle: wire.lifecycle,
                publications: wire.publications,
                accounts: wire.accounts,
                registers: wire.registers,
                judgments: wire.judgments,
                policy: wire.policy,
                policies: wire.policies,
                policy_history: wire.policy_history,
                selections: wire.selections,
                trust: wire.trust,
            }),
            overlay: wire.overlay,
        })
    }
}
impl Evaluation {
    pub fn with_overlay(
        &self,
        overlay: Option<std::rc::Rc<Value>>,
        suspended: impl Fn(&str) -> bool,
    ) -> Self {
        // A resource refusal stays the clean refusal, and only its
        // overlay changes. Without the records this method cannot
        // rebuild. `EvaluatedState::with_overlay` rebuilds a refused
        // state instead, and that rebuild can succeed.
        if self.reasons.contains("resource_unavailable") {
            let mut result = self.clone();
            result.overlay = overlay;
            return result;
        }
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
/// Work units to validate or compare an overlay: one for the value and
/// one per entry of its three lists. Each count is read without a walk.
pub(crate) fn overlay_units(overlay: Option<&Value>) -> usize {
    overlay.map_or(0, |overlay| {
        ["root_changes", "trust", "blocked"]
            .iter()
            .map(|name| overlay[*name].as_array().map_or(0, Vec::len))
            .fold(1usize, usize::saturating_add)
    })
}
fn apply_overlay(result: &mut Evaluation, suspended: &impl Fn(&str) -> bool) {
    if let Some(reason) =
        policy::overlay_refusal(result.overlay.as_deref(), &result.selected_view, suspended)
    {
        result.available = false;
        result.reasons.insert(reason.into());
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
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
        overlay: input.overlay.clone().map(std::rc::Rc::new),
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
        import_selections,
        nodes,
        arena,
        validated_selections,
        ..
    } = prepared;
    let mut cache = validated_selections.borrow_mut();
    let resolved = policy::resolve_referenced_selections_cached(
        &input,
        &import_selections,
        &nodes,
        &mut cache,
    );
    let budget = input.limits.traversal_budget_with_selections(
        nodes.len(),
        predecessor_edges(&nodes),
        resolved.allowance,
    );
    let graph = graph::Graph::new_with_budget(nodes, budget);
    let result = evaluate_graph_with_selections_cached(
        &input,
        &import_selections,
        &graph,
        &resolved,
        &mut cache,
    );
    drop(cache);
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
    resource_unavailable(&mut result);
    result
}
#[cfg(test)]
fn evaluate_graph(input: &EvaluationOptions, graph: &graph::Graph) -> Evaluation {
    let mut cache = BTreeMap::new();
    let resolved = policy::resolve_referenced_selections_cached(
        input,
        &input.import_selections,
        &graph.nodes,
        &mut cache,
    );
    evaluate_graph_with_selections_cached(
        input,
        &input.import_selections,
        graph,
        &resolved,
        &mut cache,
    )
}
fn evaluate_graph_with_selections_cached(
    input: &EvaluationOptions,
    import_selections: &BTreeMap<String, Vec<String>>,
    graph: &graph::Graph,
    resolved: &policy::ResolvedSelections<'_>,
    cache: &mut BTreeMap<String, bool>,
) -> Evaluation {
    let mut result = empty_evaluation(input);
    if graph.resource.get() {
        resource_unavailable(&mut result);
        return result;
    }
    result.lifecycle = Lifecycle::clone(&graph.lifecycle);
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
    policy::select(
        graph,
        input,
        import_selections,
        resolved,
        cache,
        &mut result,
    );
    if graph.resource.get() || result.reasons.contains("resource_unavailable") {
        resource_unavailable(&mut result);
        return result;
    }
    // Overlay validation reads every entry: charge them first.
    if !graph.charge(overlay_units(result.overlay.as_deref())) {
        resource_unavailable(&mut result);
        return result;
    }
    apply_overlay(&mut result, &|issuer| graph.suspended(issuer));
    publications(graph, &mut result);
    reconcile_selections(graph, &mut result);
    accounts::evaluate(graph, input, &mut result);
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
/// Replace `result` with the whole-evaluation refusal. Every charged
/// helper (`Graph::retained`, `maxima`, `downstream`, `lineage` and the
/// rest) returns an ordinary-looking value once the budget runs out, and
/// the exhaustion flag is sticky. Because every refusal is built here
/// from nothing the evaluation computed (only the selected view, the
/// overlay and the refusal reason), a caller that does not read the flag
/// cannot leak a value decided by a failed charge.
fn resource_unavailable(result: &mut Evaluation) {
    *result = Evaluation {
        selected_view: std::mem::take(&mut result.selected_view),
        available: false,
        reasons: BTreeSet::from(["resource_unavailable".to_owned()]),
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
        overlay: result.overlay.take(),
    };
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
    // The publications are inserted after the loop, so that the loop
    // and the import index can read the evaluation's policy and
    // selections.
    let mut built = Vec::new();
    let mut imports: Option<ImportEntries<'_>> = None;
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
        let index = if imported {
            result.policy.as_ref().and_then(|policy| {
                let index =
                    imports.get_or_insert_with(|| ImportEntries::new(policy, &result.selections));
                // Charge one lookup plus each selection that contains this publication.
                let work = index
                    .entries
                    .min(1 + index.containing.get(id.as_str()).map_or(0, Vec::len));
                (work == 0 || graph.charge(work)).then_some(&*index)
            })
        } else {
            None
        };
        let (eligible, mut reasons) =
            publication_eligibility(node, imported, source.as_deref(), index);
        #[cfg(test)]
        if imported
            && let Some(policy) = &result.policy
            && !graph.resource.get()
        {
            let (selected, unknown, pending) = import_scan(
                policy,
                &result.selections,
                &node.issuer,
                id,
                source.as_deref(),
            );
            assert_eq!(eligible == Eligibility::Eligible, selected);
            assert_eq!(
                reasons.contains("import_selection_unavailable"),
                !selected && unknown
            );
            assert_eq!(reasons.contains("source_attribution_pending"), pending);
        }
        let lineage = lineage(graph, node);
        built.push((
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
                lineage,
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
                witness_contributions: Contributions::default(),
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
        ));
    }
    drop(imports);
    for (id, publication) in built {
        result.publications.insert(id, publication);
    }
}

fn publication_eligibility(
    node: &graph::Node,
    imported: bool,
    source: Option<&str>,
    imports: Option<&ImportEntries<'_>>,
) -> (Eligibility, BTreeSet<String>) {
    let mut reasons = BTreeSet::new();
    let mut eligibility = if node.body.is_some() {
        Eligibility::Eligible
    } else {
        reasons.insert("body_unavailable".into());
        Eligibility::Unknown
    };
    if imported {
        let (mut selected, mut unknown) = (false, imports.is_none());
        if let Some(index) = imports {
            let group = match source {
                Some(source) => index
                    .by_source
                    .get(&node.issuer)
                    .and_then(|sources| sources.get(source)),
                None => index.by_importer.get(&node.issuer),
            };
            if let Some(group) = group {
                unknown = group.missing;
                for selection in index.containing.get(node.id.as_str()).into_iter().flatten() {
                    if !group.selections.contains(selection) {
                        continue;
                    }
                    if source.is_some() {
                        selected = true;
                    } else {
                        unknown = true;
                        reasons.insert("source_attribution_pending".into());
                    }
                }
            }
        }
        if !selected {
            eligibility = if unknown {
                reasons.insert("import_selection_unavailable".into());
                Eligibility::Unknown
            } else {
                Eligibility::NotSelected
            };
        }
    }
    (eligibility, reasons)
}

/// The entry scan that `ImportEntries` replaces: every entry, in order.
#[cfg(test)]
fn import_scan(
    policy: &CompactValue,
    selections: &BTreeMap<String, BTreeSet<String>>,
    issuer: &str,
    id: &str,
    source: Option<&str>,
) -> (bool, bool, bool) {
    let (mut selected, mut unknown, mut pending) = (false, false, false);
    for entry in policy
        .view()
        .index("import_sets")
        .as_array()
        .into_iter()
        .flatten()
    {
        if entry.index("importer").as_str() != Some(issuer)
            || source.is_some_and(|s| Some(s) != entry.index("source").as_str())
        {
            continue;
        }
        match entry
            .index("selection")
            .as_str()
            .and_then(|s| selections.get(s))
        {
            Some(ids) => {
                if ids.contains(id) {
                    if source.is_some() {
                        selected = true;
                    } else {
                        unknown = true;
                        pending = true;
                    }
                }
            }
            None => unknown = true,
        }
    }
    (selected, unknown, pending)
}

/// The selected view's import entries, indexed for the publication
/// pass. A publication with a source matches the entries of its
/// importer for that source. A publication without a source matches
/// every entry of its importer.
struct ImportEntries<'a> {
    entries: usize,
    by_source: BTreeMap<String, BTreeMap<String, ImportGroup<'a>>>,
    by_importer: BTreeMap<String, ImportGroup<'a>>,
    /// For each ID in a resolved selection, the selections that hold it.
    containing: BTreeMap<&'a str, Vec<&'a str>>,
}
#[derive(Default)]
struct ImportGroup<'a> {
    /// Some entry's selection is not a string or is not resolved.
    missing: bool,
    /// The resolved selections that the entries name.
    selections: BTreeSet<&'a str>,
}
impl<'a> ImportEntries<'a> {
    /// One pass over the entries and one over the resolved selections.
    /// `policy::select` already charged both.
    fn new(policy: &'a CompactValue, selections: &'a BTreeMap<String, BTreeSet<String>>) -> Self {
        let mut index = ImportEntries {
            entries: 0,
            by_source: BTreeMap::new(),
            by_importer: BTreeMap::new(),
            containing: BTreeMap::new(),
        };
        for entry in policy
            .view()
            .index("import_sets")
            .as_array()
            .into_iter()
            .flatten()
        {
            index.entries += 1;
            let Some(importer) = entry.index("importer").as_str().map(str::to_owned) else {
                continue;
            };
            let selection = entry
                .index("selection")
                .as_str()
                .and_then(|s| selections.get_key_value(s))
                .map(|(s, _)| s.as_str());
            let add = |group: &mut ImportGroup<'a>| match selection {
                Some(selection) => {
                    group.selections.insert(selection);
                }
                None => group.missing = true,
            };
            if let Some(source) = entry.index("source").as_str() {
                add(index
                    .by_source
                    .entry(importer.clone())
                    .or_default()
                    .entry(source.to_owned())
                    .or_default());
            }
            add(index.by_importer.entry(importer).or_default());
        }
        for (selection, ids) in selections {
            for id in ids {
                index
                    .containing
                    .entry(id.as_str())
                    .or_default()
                    .push(selection.as_str());
            }
        }
        index
    }
}
fn native_status(graph: &graph::Graph, result: &mut Evaluation) {
    native_status_for(graph, result, None);
}
fn native_status_for(graph: &graph::Graph, result: &mut Evaluation, only: Option<&str>) {
    if let Some(only_id) = only {
        let Some(publication) = result.publications.get_mut(only_id).filter(|p| !p.imported) else {
            return;
        };
        let actor = graph.actor(&publication.issuer);
        let keys = graph.downstream(&publication.issuer);
        if graph.resource.get() {
            return;
        }
        if keys.len() > 1 && !graph.charge(keys.len() - 1) {
            return;
        }
        if !graph.suspended(&publication.issuer)
            && keys.iter().any(|k| {
                !graph.lifecycle.retired.contains(k) && !graph.lifecycle.compromised.contains(k)
            })
        {
            publication.authority = Authority::Native;
            publication.controller = Some(actor);
        }
        if graph.suspended(&publication.issuer) {
            publication.authority = Authority::Uncertain;
            publication.controller = None;
            publication.status = Status::Uncertain;
            publication.reasons.insert("incomplete_group".into());
            return;
        }
        let frontier = graph.maxima(BTreeSet::new(), true);
        if graph.resource.get() {
            return;
        }
        publication.status_frontier = frontier;
        publication.status = Status::Active;
        return;
    }
    let mut status_records: BTreeMap<String, Vec<&graph::Node>> = BTreeMap::new();
    for node in graph
        .nodes
        .values()
        .filter(|n| n.semantic && n.kind == "status.set")
    {
        let target = node.action.view().index("target");
        if let Some(target) = target.as_str() {
            if only.is_none_or(|id| id == target) {
                status_records.entry(target.into()).or_default().push(node);
            }
        }
    }
    for publication in result
        .publications
        .values_mut()
        .filter(|p| !p.imported && only.is_none_or(|id| p.id == id))
    {
        let actor = graph.actor(&publication.issuer);
        let keys = graph.downstream(&publication.issuer);
        if graph.resource.get() {
            return;
        }
        if keys.len() > 1 && !graph.charge(keys.len() - 1) {
            return;
        }
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
        let candidates = status_records
            .get(publication.id.as_str())
            .map(Vec::as_slice)
            .unwrap_or_default();
        if !candidates.is_empty() && !graph.charge(candidates.len()) {
            return;
        }
        let records: Vec<_> = candidates
            .iter()
            .copied()
            .filter(|n| {
                graph.structurally_connected(&publication.issuer, &n.issuer, &n.id)
                    && graph.transfers.get(&n.issuer).is_none_or(|ts| {
                        graph.charge(ts.len().max(1))
                            && ts
                                .iter()
                                .all(|t| t != &n.id && graph.own[t].ids.contains(&n.id))
                    })
                    && (graph.retained(&n.id) || graph.actor(&n.issuer) != actor)
            })
            .collect();
        if graph.resource.get() {
            return;
        }
        let frontier = graph.maxima(records.iter().map(|n| n.id.clone()).collect(), true);
        if graph.resource.get() {
            return;
        }
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
        let retained = graph.retained(id);
        if graph.resource.get() {
            return;
        }
        if !n.semantic
            || !retained
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
        let maxima_member_work: usize = ids
            .iter()
            .filter_map(|id| graph.accepted.get(id))
            .map(|c| c.ids.fresh_ranges.saturating_sub(1))
            .sum();
        let work_before = graph.budget.get();
        let heads = graph.maxima(ids.into_iter().collect(), false);
        if graph.resource.get() || graph.ancestry.failed() {
            return;
        }
        let maxima_work = work_before - graph.budget.get();
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
                maxima_work,
                maxima_member_work,
            },
        );
    }
}
#[cfg(test)]
thread_local! {
    static RAFSI_GATE_PUBLICATION_VISITS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
pub(crate) fn reset_rafsi_gate_publication_visits() {
    RAFSI_GATE_PUBLICATION_VISITS.with(|count| count.set(0));
}

#[cfg(test)]
pub(crate) fn rafsi_gate_publication_visits() -> usize {
    RAFSI_GATE_PUBLICATION_VISITS.with(std::cell::Cell::get)
}

fn rafsi_gate(result: &mut Evaluation) {
    for (id, eligibility) in rafsi_eligibilities(result, |p| &p.eligible) {
        result.publications.get_mut(&id).unwrap().eligible = eligibility;
    }
}

fn rafsi_eligibilities<'a>(
    result: &'a Evaluation,
    eligibility_of: impl Fn(&'a Publication) -> &'a Eligibility,
) -> Vec<(String, Eligibility)> {
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
            && *eligibility_of(p) == Eligibility::Unknown
    });
    let mut assignments: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut definition_gates: BTreeMap<String, (bool, bool)> = BTreeMap::new();
    let mut uncertain_words = BTreeSet::new();
    let mut updates = Vec::new();
    for (id, p) in &result.publications {
        #[cfg(test)]
        RAFSI_GATE_PUBLICATION_VISITS.with(|count| count.set(count.get() + 1));
        if p.kind == "definition.publish" && *eligibility_of(p) != Eligibility::NotSelected {
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
            *active |= *eligibility_of(p) == Eligibility::Eligible
                && p.content_available
                && p.status == Status::Active;
            *deprecated &=
                *eligibility_of(p) == Eligibility::Eligible && p.status == Status::Deprecated;
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
                && *eligibility_of(p) == Eligibility::Eligible
                && p.status == Status::Active
        });
        let all_claims_deprecated = !retained_claims.is_empty()
            && retained_claims.iter().all(|id| {
                let p = &result.publications[id.as_str()];
                effective(id)
                    && p.content_available
                    && *eligibility_of(p) == Eligibility::Eligible
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
            if *eligibility_of(&result.publications[id]) != Eligibility::NotSelected {
                updates.push((id.clone(), eligibility.clone()));
            }
        }
    }
    updates
}

fn lineage(graph: &graph::Graph, node: &graph::Node) -> BTreeMap<String, String> {
    // Charge the parent count before the IDs are read. A semantic
    // record's parents are all strings (schema), so the array length is
    // the count that the charge has always used.
    let count = node
        .action
        .view()
        .index("parents")
        .as_array()
        .map_or(0, |parents| parents.len());
    if count > 1 && !graph.charge(count - 1) {
        return BTreeMap::new();
    }
    let parents: Vec<_> = node
        .action
        .view()
        .index("parents")
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect();
    parents
        .into_iter()
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
/// The match key of a managed `bridge.set` and of the imported
/// definition it links to. A bridge links to a publication exactly
/// when both have the same key.
#[derive(PartialEq, Eq, PartialOrd, Ord)]
struct BridgeKey {
    source_record: Option<u64>,
    word: String,
    language: Option<String>,
    origin: String,
    actor: String,
}

/// Each rafsi-pair assignment, mapped to the first publication in ID
/// order that has it.
fn assignment_index(publications: &BTreeMap<String, Publication>) -> BTreeMap<String, String> {
    let mut index = BTreeMap::new();
    for p in publications.values() {
        if let Some(assignment) = &p.assignment {
            index
                .entry(assignment.clone())
                .or_insert_with(|| p.id.clone());
        }
    }
    index
}

/// Each managed-bridge key that an imported definition satisfies,
/// mapped to the first such publication in ID order. A publication
/// has a key only when its source account is known and commands with
/// a controller identity; the key's actor is that identity's actor.
fn bridge_source_index(
    result: &Evaluation,
    actor_of: impl Fn(&str) -> String,
) -> BTreeMap<BridgeKey, String> {
    let mut index = BTreeMap::new();
    for p in result.publications.values() {
        if !p.imported || p.kind != "definition.publish" {
            continue;
        }
        let Some(account) = &p.account else {
            continue;
        };
        let Some(controller) = result
            .accounts
            .get(&account.token())
            .filter(|a| a.commands)
            .and_then(|a| a.controller_identity.as_deref())
        else {
            continue;
        };
        index
            .entry(BridgeKey {
                source_record: p.source_record,
                word: p.word.clone(),
                language: p.language.clone(),
                origin: account.origin.clone(),
                actor: actor_of(controller),
            })
            .or_insert_with(|| p.id.clone());
    }
    index
}

fn action_targets(graph: &graph::Graph, result: &mut Evaluation) {
    action_targets_for(graph, result, None);
}
fn action_targets_for(graph: &graph::Graph, result: &mut Evaluation, only: Option<&str>) {
    let restricted: Vec<(&String, &graph::Node)> = match only {
        Some(id) => graph.nodes.get_key_value(id).into_iter().collect(),
        None => graph.nodes.iter().collect(),
    };
    // Lookup indexes for `jvr1:` judgments and managed bridges, each
    // built on its first use from one pass over the publications.
    let mut assignments: Option<BTreeMap<String, String>> = None;
    let mut bridge_sources: Option<BTreeMap<BridgeKey, String>> = None;
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
            let matched = assignments
                .get_or_insert_with(|| assignment_index(&result.publications))
                .get(target);
            pending = matched.is_none();
        } else {
            match graph.nodes.get(target) {
                None => pending = true,
                Some(n) => {
                    invalid = !n.semantic
                        || !matches!(n.kind.as_str(), "definition.publish" | "rafsi.publish");
                    if node.kind == "status.set" {
                        invalid |= n.action.view().index("origin") != "native"
                            || !graph.structurally_connected(&n.issuer, &node.issuer, id);
                        if graph.resource.get() {
                            return;
                        }
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
                            // The managed source this bridge names: the
                            // imported definition with this source record,
                            // the target's word and language, and an account
                            // at this origin that commands for this actor.
                            let key = BridgeKey {
                                source_record: node
                                    .action
                                    .view()
                                    .index("source_definition")
                                    .as_u64(),
                                word: n
                                    .action
                                    .view()
                                    .index("word")
                                    .as_str()
                                    .unwrap_or_default()
                                    .into(),
                                language: n
                                    .action
                                    .view()
                                    .index("language")
                                    .as_str()
                                    .map(str::to_owned),
                                origin: node
                                    .action
                                    .view()
                                    .index("origin")
                                    .as_str()
                                    .unwrap_or_default()
                                    .into(),
                                actor: graph.actor(&node.issuer),
                            };
                            let linked = bridge_sources
                                .get_or_insert_with(|| {
                                    bridge_source_index(result, |issuer| graph.actor(issuer))
                                })
                                .get(&key);
                            if linked.is_none() {
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
    let conflicts: Vec<_> =
        conflicting_selections(result, |p| &p.eligible, |issuer| graph.actor(issuer)).collect();
    for id in conflicts {
        let p = result.publications.get_mut(&id).unwrap();
        p.eligible = Eligibility::Unknown;
        p.status = Status::Unavailable;
        p.reasons.insert("source_selection_conflict".into());
    }
}

fn conflicting_selections<'a>(
    result: &'a Evaluation,
    eligibility_of: impl Fn(&'a Publication) -> &'a Eligibility,
    actor_of: impl Fn(&str) -> String,
) -> impl Iterator<Item = String> {
    let mut slots: BTreeMap<(&str, String, u64), Vec<String>> = BTreeMap::new();
    for p in result.publications.values().filter(|p| {
        p.imported && p.kind == "definition.publish" && *eligibility_of(p) == Eligibility::Eligible
    }) {
        if let (Some(source), Some(record)) = (&p.source, p.source_record) {
            slots
                .entry((source, actor_of(&p.issuer), record))
                .or_default()
                .push(p.id.clone());
        }
    }
    slots.into_values().filter(|ids| ids.len() > 1).flatten()
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
            events: Some(limit),
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
