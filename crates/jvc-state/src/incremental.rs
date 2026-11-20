use super::*;
use graph::{Graph, Node};

pub const CHECKPOINT_VERSION: &str = "jvc-evaluation-checkpoint-v10";
const RESULTS_CHECKPOINT_VERSION: &str = "jvc-evaluation-results-v10";
pub const MAX_INCREMENTAL_RECORDS: usize = 64;
const APPENDS_BEFORE_REBASE: usize = MAX_INCREMENTAL_RECORDS;

#[cfg(test)]
thread_local! {
    static DIGEST_REJECTIONS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
thread_local! {
    /// Selection IDs that empty-advance comparisons read.
    static SELECTION_IDS_COMPARED: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
fn reset_digest_rejections() {
    DIGEST_REJECTIONS.with(|count| count.set(0));
}

#[cfg(test)]
fn digest_rejections() -> usize {
    DIGEST_REJECTIONS.with(std::cell::Cell::get)
}

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

#[derive(Serialize)]
struct SavedOptions<'a> {
    selected_view: &'a str,
    import_selections: &'a BTreeMap<String, Vec<String>>,
    overlay: &'a Option<std::rc::Rc<Value>>,
    limits: &'a Limits,
}

/// Retained authenticated input and its evaluated state.
/// A fork owns its result and shares the record projection and immutable ancestor payloads.
pub struct EvaluatedState {
    prepared: PreparedEvaluationInput,
    evaluation: Evaluation,
    graph: Option<Graph>,
    unresolved: std::rc::Rc<BTreeSet<String>>,
    rafsi_words: std::rc::Rc<BTreeSet<String>>,
    /// The rafsi-pair assignments of the evaluated publications, for
    /// the fast path's `jvr1:` judgment target lookup.
    rafsi_assignments: std::rc::Rc<BTreeSet<String>>,
    selection_allowance: usize,
    /// `previous` IDs over the retained records, for the default budget.
    predecessor_edges: usize,
    remaining_work: usize,
    /// Ancestry bytes counted for the closures the graph of this
    /// state keeps, saved across a checkpoint. A restored state has
    /// no graph, so the first advance seeds the rebuilt graph's cap
    /// counter with this total. Evaluation keeps no closures of its
    /// own, so for a checkpoint that this build wrote the total
    /// equals what the rebuilt graph counts. `None` forces a rebuild
    /// on the first advance instead.
    saved_ancestry_bytes: Option<usize>,
    checkpoint_restored: bool,
    statistics: UpdateStatistics,
    /// Shared, so that a clone copies one pointer.
    judgment_changes: Option<std::rc::Rc<JudgmentChanges>>,
    ranking_index: std::cell::RefCell<Option<policy::ApproximateContextIndex>>,
}

pub struct RankingContextBound {
    pub actors: u64,
    pub edges: u64,
    pub refusals: u64,
    pub judgments: u64,
    pub targets: u64,
    pub trust_rules: u64,
    pub public_rules: u64,
    pub roots: u64,
    pub exclusions: u64,
    pub suspensions: u64,
    pub overlay_entries: u64,
    pub pairs_squared: u64,
}
impl Clone for EvaluatedState {
    fn clone(&self) -> Self {
        Self {
            prepared: self.prepared.clone(),
            evaluation: self.evaluation.clone(),
            graph: self.graph.clone(),
            unresolved: self.unresolved.clone(),
            rafsi_words: self.rafsi_words.clone(),
            rafsi_assignments: self.rafsi_assignments.clone(),
            selection_allowance: self.selection_allowance,
            predecessor_edges: self.predecessor_edges,
            remaining_work: self.remaining_work,
            saved_ancestry_bytes: self.saved_ancestry_bytes,
            checkpoint_restored: self.checkpoint_restored,
            statistics: self.statistics.clone(),
            judgment_changes: self.judgment_changes.clone(),
            ranking_index: Default::default(),
        }
    }
}

impl EvaluatedState {
    pub fn from_input(input: &EvaluationInput) -> Self {
        let mut prepared = PreparedEvaluationInput::new(EvaluationOptions {
            selected_view: input.selected_view.clone(),
            import_selections: input.import_selections.clone(),
            overlay: input.overlay.clone().map(std::rc::Rc::new),
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
            unresolved: Default::default(),
            rafsi_words: Default::default(),
            rafsi_assignments: Default::default(),
            selection_allowance: 0,
            predecessor_edges: 0,
            remaining_work: 0,
            saved_ancestry_bytes: None,
            checkpoint_restored: false,
            statistics: UpdateStatistics::default(),
            judgment_changes: None,
            ranking_index: Default::default(),
        };
        state.prepared.arena.borrow_mut().finish_load();
        state.rebuild();
        state
    }

    pub fn evaluation(&self) -> &Evaluation {
        &self.evaluation
    }

    pub fn import_selections(&self) -> &BTreeMap<String, Vec<String>> {
        &self.prepared.import_selections
    }

    pub(crate) fn shared_import_selections(&self) -> &std::rc::Rc<BTreeMap<String, Vec<String>>> {
        &self.prepared.import_selections
    }

    pub(crate) fn shared_validated_selections(
        &self,
    ) -> &std::rc::Rc<std::cell::RefCell<BTreeMap<String, bool>>> {
        &self.prepared.validated_selections
    }

    fn saved_options(&self) -> SavedOptions<'_> {
        SavedOptions {
            selected_view: &self.prepared.options.selected_view,
            import_selections: &self.prepared.import_selections,
            overlay: &self.prepared.options.overlay,
            limits: &self.prepared.options.limits,
        }
    }

    #[doc(hidden)]
    pub fn allocation_stages(mut self, mut observe: impl FnMut(&str)) {
        observe("state_loaded");
        self.evaluation.publications.clear();
        observe("publications_cleared");
        self.evaluation.receipts.clear();
        observe("receipts_cleared");
        self.evaluation.lifecycle.key_actor.clear();
        self.evaluation.lifecycle.groups.clear();
        self.evaluation.lifecycle.successor.clear();
        self.evaluation.lifecycle.suspended.clear();
        self.evaluation.lifecycle.retired.clear();
        self.evaluation.lifecycle.compromised.clear();
        observe("lineage_cleared");
        self.evaluation.accounts.clear();
        observe("accounts_cleared");
        self.evaluation.registers.clear();
        observe("registers_cleared");
        self.evaluation.judgments.clear();
        observe("judgments_cleared");
        self.evaluation.policy = None;
        self.evaluation.policies.clear();
        self.evaluation.policy_history.clear();
        observe("policies_cleared");
        self.evaluation.trust.clear();
        self.evaluation.selections.clear();
        self.evaluation.overlay = None;
        observe("other_evaluation_cleared");
        self.graph = None;
        observe("graph_cleared");
        self.unresolved = Default::default();
        self.rafsi_words = Default::default();
        self.rafsi_assignments = Default::default();
        observe("unresolved_cleared");
    }

    pub fn with_overlay(&self, overlay: Option<Value>) -> Self {
        self.with_overlay_and_rebuild(overlay, |state| state.rebuild())
    }

    fn with_overlay_and_rebuild(
        &self,
        overlay: Option<Value>,
        rebuild: impl FnOnce(&mut Self),
    ) -> Self {
        let overlay = overlay.map(std::rc::Rc::new);
        let mut state = self.clone();
        state.prepared.options.overlay = overlay.clone();
        // A full evaluation charges the overlay's entries before it
        // validates them (`overlay_units`). The state already paid for
        // its old overlay; swap that charge for the new one before the
        // new overlay is read, and rebuild when the budget cannot cover it.
        let old_units = overlay_units(self.prepared.options.overlay.as_deref());
        let new_units = overlay_units(overlay.as_deref());
        let available = self.remaining_work.saturating_add(old_units);
        if self.evaluation.reasons.contains("resource_unavailable") || new_units > available {
            rebuild(&mut state);
        } else {
            state.remaining_work = available - new_units;
            state.evaluation = self.evaluation.with_overlay(overlay, |issuer| {
                let lifecycle = &self.evaluation.lifecycle;
                let actor = lifecycle
                    .key_actor
                    .get(issuer)
                    .cloned()
                    .unwrap_or_else(|| issuer.into());
                lifecycle.suspended.contains_key(&actor)
            });
        }
        state.statistics = self.statistics.clone();
        state.judgment_changes = None;
        state.ranking_index = Default::default();
        state
    }

    pub fn event_count(&self) -> usize {
        self.prepared.nodes.len()
    }

    pub fn traversal_budget(&self) -> usize {
        self.prepared
            .options
            .limits
            .traversal_budget_with_selections(
                self.prepared.nodes.len(),
                self.predecessor_edges,
                self.selection_allowance,
            )
    }

    pub fn consumed_work(&self) -> usize {
        self.traversal_budget().saturating_sub(self.remaining_work)
    }

    pub fn statistics(&self) -> &UpdateStatistics {
        &self.statistics
    }

    pub fn judgment_changes(&self) -> Option<&JudgmentChanges> {
        self.judgment_changes.as_deref()
    }

    /// Hash retained authenticated projections without another input buffer.
    /// Value maps must retain serde_json's sorted-key encoding. A test pins this assumption.
    pub fn ranking_source_binding(&self, max_bytes: usize) -> jvc_core::Result<(String, usize)> {
        self.ranking_source_binding_checked(max_bytes, || true)
    }
    /// The host supplies a monotonic deadline check. Check at most 256 KiB apart.
    pub fn ranking_source_binding_checked(
        &self,
        max_bytes: usize,
        mut within_deadline: impl FnMut() -> bool,
    ) -> jvc_core::Result<(String, usize)> {
        struct BudgetWriter<'a> {
            hash: jvc_core::HashWriter,
            check: &'a mut dyn FnMut() -> bool,
            remaining: usize,
        }
        impl std::io::Write for BudgetWriter<'_> {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                for chunk in bytes.chunks(256 * 1024) {
                    if chunk.len() >= self.remaining {
                        if !(self.check)() {
                            return Err(std::io::Error::other("ranking source time limit"));
                        }
                        self.remaining = 256 * 1024;
                    }
                    self.hash.write_all(chunk)?;
                    self.remaining -= chunk.len();
                }
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        if !within_deadline() {
            return Err(jvc_core::Error::new(
                "resource_unavailable",
                "ranking source time limit",
            ));
        }
        let mut writer = BudgetWriter {
            hash: jvc_core::HashWriter::new(b"jvc-ranking-state-v1\n", max_bytes),
            check: &mut within_deadline,
            remaining: 256 * 1024,
        };
        let saved_options = self.saved_options();
        serde_json::to_writer(
            &mut writer,
            &(
                &saved_options,
                self.prepared.nodes.as_ref(),
                self.prepared.event_limit_exceeded,
                &self.evaluation,
            ),
        )
        .map_err(|e| jvc_core::Error::new("resource_unavailable", e.to_string()))?;
        if !(writer.check)() {
            return Err(jvc_core::Error::new(
                "resource_unavailable",
                "ranking source time limit",
            ));
        }
        Ok(writer.hash.finish("sha256:"))
    }
    /// Count index inputs without cloning them. Policy checks precede index allocation.
    pub fn ranking_source_records(&self) -> jvc_core::Result<usize> {
        self.ranking_source_records_metered(&mut |_, _, _, _| Ok(()))
    }
    /// Like `ranking_source_records`, but each judgment group and overlay
    /// field is charged to the meter before it is visited.
    pub fn ranking_source_records_metered(
        &self,
        meter: &mut policy::SetupMeter<'_>,
    ) -> jvc_core::Result<usize> {
        let e = &self.evaluation;
        meter(16, 0, 0, 0)?;
        let mut count = self.prepared.nodes.len();
        for n in [
            e.publications.len(),
            e.receipts.len(),
            e.registers.len(),
            e.trust.len(),
            e.judgments.len(),
            e.lifecycle.key_actor.len(),
            e.accounts.len(),
        ] {
            count = count.checked_add(n).ok_or_else(|| {
                jvc_core::Error::new("resource_unavailable", "ranking record count overflow")
            })?;
        }
        for judgments in e.judgments.values() {
            // Each group credits its own allowance before its charge,
            // so this walk never exhausts a budget its input would raise.
            meter(0, 0, 0, 1)?;
            meter(8, 0, 0, 0)?;
            count = count.checked_add(judgments.len()).ok_or_else(|| {
                jvc_core::Error::new("resource_unavailable", "ranking record count overflow")
            })?;
        }
        if let Some(overlay) = &e.overlay {
            let obj_len = overlay.as_object().map_or(0, |o| o.len());
            for key in ["trust", "blocked", "root_changes"] {
                meter(0, 0, 0, 1)?;
                meter(
                    super::arena::lookup_work(obj_len as u64, key.len() as u64),
                    0,
                    0,
                    0,
                )?;
                let n = overlay[key].as_array().map_or(0, Vec::len);
                count = count.checked_add(n).ok_or_else(|| {
                    jvc_core::Error::new("resource_unavailable", "ranking record count overflow")
                })?;
            }
        }
        Ok(count)
    }
    pub fn ranking_index_bound(&self) -> jvc_core::Result<policy::RankingIndexCounts> {
        policy::ranking_index_bound(&self.evaluation)
    }
    /// Like `ranking_index_bound`, with every walk step charged first.
    pub fn ranking_index_bound_metered(
        &self,
        meter: &mut policy::SetupMeter<'_>,
    ) -> jvc_core::Result<policy::RankingIndexCounts> {
        policy::ranking_index_bound_metered(&self.evaluation, meter)
    }
    /// Diagnostic counts after index construction. This does not build an index.
    pub fn ranking_index_counts(&self) -> jvc_core::Result<Option<policy::RankingIndexCounts>> {
        self.ranking_index
            .borrow()
            .as_ref()
            .map(|i| i.counts(&self.evaluation))
            .transpose()
    }
    pub fn ensure_ranking_index(&self) -> jvc_core::Result<()> {
        self.ensure_ranking_index_metered(&mut |_, _, _, _| Ok(()))
    }
    /// Like `ensure_ranking_index`, with every construction lookup,
    /// insertion, and comparison charged to the meter before it runs.
    pub fn ensure_ranking_index_metered(
        &self,
        meter: &mut policy::SetupMeter<'_>,
    ) -> jvc_core::Result<()> {
        if self.ranking_index.borrow().is_none() {
            let index = policy::ApproximateContextIndex::new_metered(&self.evaluation, meter)?;
            *self.ranking_index.borrow_mut() = Some(index);
        }
        Ok(())
    }
    #[cfg(any(test, feature = "test-support"))]
    #[doc(hidden)]
    pub fn replace_evaluation_for_test(&mut self, evaluation: Evaluation, overlay: Option<Value>) {
        self.prepared.options.overlay = overlay.map(std::rc::Rc::new);
        self.evaluation = evaluation;
        *self.ranking_index.borrow_mut() = None;
    }
    /// Borrow publications from this state, using its own bounded derived index.
    pub fn ranking_publications(
        &self,
        word: &str,
        limit: usize,
    ) -> jvc_core::Result<Vec<&Publication>> {
        let index = self.ranking_index.borrow();
        let index = index.as_ref().ok_or_else(|| {
            jvc_core::Error::new("ranking_preparation", "ranking index is not initialized")
        })?;
        let Some(ids) = index.words.get(word) else {
            return Ok(Vec::new());
        };
        if ids.len() > limit {
            return Err(jvc_core::Error::new(
                "resource_unavailable",
                "word publication limit",
            ));
        }
        Ok(ids
            .iter()
            .map(|id| &self.evaluation.publications[id])
            .collect())
    }
    pub fn ranking_context_bound(
        &self,
        context: &Context,
    ) -> jvc_core::Result<RankingContextBound> {
        let index = self.ranking_index.borrow();
        index
            .as_ref()
            .ok_or_else(|| {
                jvc_core::Error::new("ranking_preparation", "ranking index is not initialized")
            })?
            .bound(&self.evaluation, context)
    }
    pub fn prepare_indexed_approximate_context(
        &self,
        context: &Context,
    ) -> jvc_core::Result<ContextGraph<f64>> {
        let index = self.ranking_index.borrow();
        let index = index.as_ref().ok_or_else(|| {
            jvc_core::Error::new("ranking_preparation", "ranking index is not initialized")
        })?;
        Ok(index.context(&self.evaluation, context))
    }

    fn rebuild(&mut self) {
        self.judgment_changes = None;
        // Discard this state's old ancestry before any early exit or replacement.
        self.saved_ancestry_bytes = None;
        self.checkpoint_restored = false;
        self.graph = None;
        self.predecessor_edges = predecessor_edges(&self.prepared.nodes);
        if self.prepared.arena_error().is_some() {
            self.selection_allowance = 0;
            self.evaluation = empty_evaluation(&self.prepared.options);
            resource_unavailable(&mut self.evaluation);
            self.remaining_work = self.traversal_budget();
            self.unresolved = Default::default();
            self.rafsi_words = Default::default();
            self.rafsi_assignments = Default::default();
            return;
        }
        if self.prepared.event_limit_exceeded {
            self.selection_allowance = 0;
            self.evaluation = event_limit_evaluation(&self.prepared.options);
            self.remaining_work = self.traversal_budget();
            self.unresolved = Default::default();
            self.rafsi_words = Default::default();
            self.rafsi_assignments = Default::default();
            return;
        }
        let mut selection_cache = self.prepared.validated_selections.borrow_mut();
        let resolved = policy::resolve_referenced_selections_cached(
            &self.prepared.options,
            &self.prepared.import_selections,
            &self.prepared.nodes,
            &mut selection_cache,
        );
        self.selection_allowance = resolved.allowance;
        let budget = self.traversal_budget();
        let graph = Graph::new_with_budget(self.prepared.nodes.clone(), budget);
        self.evaluation = evaluate_graph_with_selections_cached(
            &self.prepared.options,
            &self.prepared.import_selections,
            &graph,
            &resolved,
            &mut selection_cache,
        );
        drop(selection_cache);
        self.remaining_work = graph.budget.get();
        self.graph = Some(graph);
        self.unresolved = unresolved(&self.prepared, &self.evaluation);
        self.rafsi_words = rafsi_words(&self.evaluation);
        self.rafsi_assignments = rafsi_assignments(&self.evaluation);
    }

    /// Advance from original records that already passed record preparation.
    /// Existing record replacements and removals always rebuild the state.
    pub fn advance(mut self, delta: PreparedEvaluationInput, removed: &[String]) -> Self {
        self.ranking_index = Default::default();
        let mut rebuild_reason =
            (!self.same_options(&delta.options)).then(|| "configuration_changed".to_owned());
        let arena_error = delta.arena_error();
        self.prepared.options = delta.options;
        if let Some(error) = arena_error {
            self.prepared.arena_error = Some(error);
            rebuild_reason = Some("resource_unavailable".into());
        }
        let mut added = BTreeMap::new();
        for id in removed {
            if self.prepared.nodes.contains_key(id) {
                self.graph = None;
                std::rc::Rc::make_mut(&mut self.prepared.nodes).remove(id);
                rebuild_reason = Some("record_removed".into());
            }
        }
        for (id, node) in std::rc::Rc::unwrap_or_clone(delta.nodes) {
            match self.prepared.nodes.get(&id) {
                Some(previous) if previous == &node => {}
                Some(_) => {
                    self.graph = None;
                    std::rc::Rc::make_mut(&mut self.prepared.nodes).insert(id, node);
                    rebuild_reason = Some("record_replaced".into());
                }
                None => {
                    added.insert(id, node);
                }
            }
        }
        self.prepared.event_limit_exceeded =
            delta.event_limit_exceeded
                || self.prepared.options.limits.events.is_some_and(|limit| {
                    self.prepared.nodes.len().saturating_add(added.len()) > limit
                });
        if !std::rc::Rc::ptr_eq(&self.prepared.import_selections, &delta.import_selections) {
            // A zero budget refuses whatever the selections hold, and an
            // event-limit state rebuilds anyway.
            if !self.prepared.event_limit_exceeded
                && self.prepared.options.limits.traversal != Some(0)
            {
                let view_node = added.get(&self.prepared.options.selected_view).or_else(|| {
                    self.prepared
                        .nodes
                        .get(&self.prepared.options.selected_view)
                });
                if let Some(body) = view_node
                    .filter(|n| n.semantic && n.kind == "view.publish")
                    .and_then(|n| n.body.as_ref())
                {
                    let prev_selections = &self.prepared.import_selections;
                    let next_selections = &delta.import_selections;
                    let prev_cache = self.prepared.validated_selections.borrow();
                    let mut next_cache = delta.validated_selections.borrow_mut();
                    // Each distinct selection is compared once, however
                    // many import sets name it, so the comparison reads
                    // each supplied ID at most once.
                    let mut compared: BTreeSet<String> = BTreeSet::new();
                    // Each comparison reads the supplied IDs: it runs only
                    // while the remaining work covers them, and otherwise
                    // the advance rebuilds, which charges the selection.
                    let mut compare_budget = self.remaining_work;
                    for entry in body
                        .view()
                        .index("import_sets")
                        .as_array()
                        .into_iter()
                        .flatten()
                    {
                        let sel_field = entry.index("selection");
                        let Some(sel_id) = sel_field.as_str() else {
                            continue;
                        };
                        if !compared.insert(sel_id.to_owned()) {
                            continue;
                        }
                        let prev = prev_selections.get(sel_id);
                        let next = next_selections.get(sel_id);
                        if prev.map(Vec::len) != next.map(Vec::len) {
                            if rebuild_reason.is_none() {
                                rebuild_reason = Some("configuration_changed".into());
                            }
                            continue;
                        }
                        let Some((prev_ids, next_ids)) = prev.zip(next) else {
                            continue;
                        };
                        // A refused state keeps no evidence of how far its
                        // evaluation read the selections (the refusal is
                        // built from nothing it computed), so it compares
                        // like any state. A budget refusal has no work
                        // left, so a changed vector rebuilds below; a cap
                        // or arena refusal compares within the work it
                        // kept, and a changed vector rebuilds too.
                        if next_ids.len() > compare_budget {
                            if rebuild_reason.is_none() {
                                rebuild_reason = Some("configuration_changed".into());
                            }
                            continue;
                        }
                        compare_budget -= next_ids.len();
                        #[cfg(test)]
                        SELECTION_IDS_COMPARED
                            .with(|count| count.set(count.get() + prev_ids.len()));
                        if prev_ids != next_ids {
                            if rebuild_reason.is_none() {
                                rebuild_reason = Some("configuration_changed".into());
                            }
                        } else if !next_cache.contains_key(sel_id)
                            && let Some(&valid) = prev_cache.get(sel_id)
                        {
                            next_cache.insert(sel_id.to_owned(), valid);
                        }
                    }
                }
            }
            self.prepared.import_selections = delta.import_selections;
            self.prepared.validated_selections = delta.validated_selections;
        }
        self.statistics = UpdateStatistics::default();
        self.judgment_changes = Some(Default::default());
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
            // An old checkpoint without the byte total cannot be priced
            // exactly; rebuild so the first advance runs a full
            // evaluation, as it would have originally. Check before
            // building a graph the rebuild would discard.
            if self.checkpoint_restored && self.saved_ancestry_bytes.is_none() {
                rebuild_reason = Some("checkpoint_ancestry_unknown".into());
            } else {
                let graph =
                    Graph::new_with_budget(self.prepared.nodes.clone(), self.traversal_budget());
                if let Some(bytes) = self.saved_ancestry_bytes.take() {
                    graph.ancestry.restore_bytes(bytes);
                }
                if graph.resource.get() || graph.ancestry.failed() {
                    rebuild_reason = Some("history_resource_unavailable".into());
                } else {
                    graph.budget.set(self.remaining_work);
                    self.graph = Some(graph);
                }
            }
        }
        // A judgment-only advance that rebuilds only because the
        // fast path declined on layout grounds can still report the
        // keys it changed, but only a complete set (see
        // `judgment_diff`). A partial patch is never reported:
        // consumers would apply it and keep stale state. Resource
        // and lifecycle rebuilds report none, as before.
        let judgment_only = removed.is_empty()
            && !added.is_empty()
            && added.values().all(|node| node.kind == "judgment.set");
        let mut appended_any = false;
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
                    appended_any = true;
                    let appended = self.append(node, work);
                    self.statistics.incremental_records += 1;
                    // A resource failure inside the append also stops
                    // the register update, so it is reported first.
                    if self.graph.as_ref().is_some_and(|g| g.resource.get()) {
                        rebuild_reason = Some("history_resource_unavailable".into());
                        break;
                    }
                    if !appended {
                        rebuild_reason = Some("register_members".into());
                        break;
                    }
                }
                Err(reason) => rebuild_reason = Some(reason.into()),
            }
        }
        if let Some(reason) = rebuild_reason {
            let layout_rebuild = reason == "layout_split";
            // The base evaluation is only intact when no append of
            // this batch has run yet. Later refusals report no patch.
            // Move the base evaluation out instead of copying it:
            // `rebuild` overwrites it without reading the old value,
            // so a copy would hold one extra evaluation at the peak.
            let base_evaluation = (judgment_only && layout_rebuild && !appended_any).then(|| {
                std::mem::replace(
                    &mut self.evaluation,
                    empty_evaluation(&self.prepared.options),
                )
            });
            self.graph = None;
            if !added.is_empty() {
                std::rc::Rc::make_mut(&mut self.prepared.nodes).extend(added);
            }
            self.rebuild();
            self.statistics.rebuilt = true;
            self.statistics.reason = Some(reason);
            self.statistics.incremental_records = 0;
            if let Some(base) = base_evaluation {
                self.judgment_changes =
                    judgment_diff(&base, &self.evaluation).map(std::rc::Rc::new);
            }
        }
        self
    }

    /// Whether `next` equals the retained options. A newly supplied
    /// overlay that is not the retained value is compared only when the
    /// remaining work covers its entries (`overlay_units`); otherwise it
    /// counts as changed and the rebuild charges it. The view name is
    /// compared by length first, so its bytes are read at most up to the
    /// retained name's length.
    fn same_options(&self, next: &EvaluationOptions) -> bool {
        let EvaluationOptions {
            selected_view,
            import_selections,
            overlay,
            limits,
        } = next;
        let retained = &self.prepared.options;
        retained.selected_view == *selected_view
            && retained.import_selections == *import_selections
            && retained.limits == *limits
            && match (&retained.overlay, overlay) {
                (None, None) => true,
                (Some(old), Some(new)) => {
                    std::rc::Rc::ptr_eq(old, new)
                        || (overlay_units(Some(new)) <= self.remaining_work && old == new)
                }
                _ => false,
            }
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
        let record_allowance = if self.prepared.options.limits.traversal.is_none() {
            record_allowance(node)
        } else {
            0
        };
        let available_work = self.remaining_work.saturating_add(record_allowance);
        graph.budget.set(available_work);
        if node.kind == "judgment.set" {
            let target = node.action.view().index("target");
            let target = target.as_str().unwrap_or_default();
            // `append` tests every current head of the register against
            // the new closure. Check that count against the budget before
            // the test runs, as the coverage sweep below is checked.
            let heads = self
                .evaluation
                .registers
                .get(&format!("{}|judgment|{target}", node.issuer))
                .map_or(0, |register| register.heads.len());
            if !graph.charge(heads) {
                return Err("work_budget");
            }
            let known = if target.starts_with("jvr1:") {
                self.rafsi_assignments.contains(target)
            } else {
                graph.nodes.get(target).is_some_and(|n| {
                    n.semantic && matches!(n.kind.as_str(), "definition.publish" | "rafsi.publish")
                })
            };
            if !known {
                return Err("target_unresolved");
            }
        } else if node.kind == "definition.publish" {
            let word_field = node.action.view().index("word");
            let word = word_field.as_str().unwrap_or_default();
            if self.rafsi_words.contains(word) || (word.is_empty() && !self.rafsi_words.is_empty())
            {
                return Err("rafsi_eligibility");
            }
        }
        // The fast-path invariant: the new record goes last in its
        // issuer block in a fresh layout. Then every existing closure
        // is unchanged, the new closures are exactly what a fresh
        // build computes, and the price below (the full build's own
        // charge formula for one record) makes the totals equal a
        // full evaluation exactly.
        //
        // Last in block is shown by coverage: the parents' combined
        // own-closure holds every record of the issuer, positioned
        // and appended alike. Own-mode dependencies are only the
        // same-issuer predecessor edges, and the layout orders each
        // block by those same edges, so every covered block record
        // is a same-issuer ancestor of the new record and the layout
        // emits it first, whatever the new record's ID. (A parent in
        // or below a cycle is invalid, so its closure is never
        // complete and the checks above already declined.) The test
        // reads range bounds and borrowed layout IDs only; it clones
        // no ID. On the real 63,245-record chain the parent is the
        // chain tip, so coverage reads one stored range.
        //
        // The boundary crossing count also matters: a closure holding
        // the block's last record and the next block's first would
        // split when the new record inserts between them. The count
        // is kept as closures are built and extended, so reading it
        // here is one charged unit and a logarithmic prefix sum.
        let parents: Vec<&graph::Closure> = node.previous.iter().map(|id| &graph.own[id]).collect();
        if let Some((first, last)) = graph.issuer_block(&node.issuer) {
            let sweep_bound: usize = parents
                .iter()
                .map(|closure| closure.ids.range_count())
                .sum::<usize>()
                .saturating_mul(node.previous.len().max(1));
            if !graph.charge(sweep_bound) {
                return Err("work_budget");
            }
            let parent_sets: Vec<&graph::IdSet> =
                parents.iter().map(|closure| &closure.ids).collect();
            if !graph::IdSet::union_covers(&parent_sets, first, last) {
                return Err("layout_split");
            }
            for id in graph
                .appended_ids
                .iter()
                .filter(|id| graph.nodes[id.as_str()].issuer == node.issuer)
            {
                if !parents.iter().any(|closure| closure.ids.contains(id)) {
                    return Err("layout_split");
                }
            }
            if !graph.charge(1) {
                return Err("work_budget");
            }
            if graph.boundary_crossing(last + 1) > 0 {
                return Err("layout_split");
            }
        } else {
            // No positioned records for this issuer: any appended ones
            // must still all be ancestors of the new record.
            for id in graph
                .appended_ids
                .iter()
                .filter(|id| graph.nodes[id.as_str()].issuer == node.issuer)
            {
                if !parents.iter().any(|closure| closure.ids.contains(id)) {
                    return Err("layout_split");
                }
            }
            if !graph.charge(1) {
                return Err("work_budget");
            }
            if graph.boundary_crossing(graph.next_block_start(&node.issuer)) > 0 {
                return Err("layout_split");
            }
        }
        // The full build's charge for one more record, per cache:
        // setup (one per record and predecessor) plus construction
        // (one, plus one per predecessor for its missing set and its
        // fresh-layout range count). Three caches are charged when
        // they share storage, as in a full build. The layout pass
        // charges one per record and predecessor.
        let per_cache = |cache: &BTreeMap<String, graph::Closure>| {
            (1 + node.previous.len())
                + (1 + node
                    .previous
                    .iter()
                    .map(|id| 1 + cache[id].missing.len() + graph.fresh_range_count(&cache[id].ids))
                    .sum::<usize>())
        };
        let shared = std::rc::Rc::ptr_eq(&graph.own, &graph.structural)
            && std::rc::Rc::ptr_eq(&graph.own, &graph.accepted);
        let construction = if shared {
            3 * per_cache(&graph.own)
        } else {
            per_cache(&graph.own) + per_cache(&graph.structural) + per_cache(&graph.accepted)
        };
        let copy_work = self.append_copy_units(node, graph, shared, available_work)?;
        // The last two units are the lifecycle record and the account
        // history scan. A full evaluation skips the scan when no
        // policy is selected, so the append charges it only then too.
        let work = (1 + node.previous.len())
            .saturating_add(construction)
            .saturating_add(1)
            .saturating_add(usize::from(self.evaluation.policy.is_some()))
            .saturating_add(copy_work);
        let lineage_work = if node.kind == "definition.publish" {
            node.action
                .view()
                .index("parents")
                .as_array()
                .map_or(0, |parents| parents.len())
                .saturating_sub(1)
        } else {
            0
        };
        if work.saturating_add(lineage_work) > available_work {
            return Err("work_budget");
        }
        Ok(work)
    }

    /// Units for the copies an append makes of structures that another
    /// state (a fork, an overlay sibling, or a retained prepared input)
    /// still shares. `Rc::make_mut` copies a shared structure on its
    /// first write, so each structure the append writes is tested for
    /// sharing on its own and its full size is charged, nested members
    /// included. An unshared structure is written in place and costs
    /// nothing extra. Returns `work_budget` as soon as the count passes
    /// `available_work`, before any nested walk past that point.
    fn append_copy_units(
        &self,
        node: &Node,
        graph: &Graph,
        closures_shared: bool,
        available_work: usize,
    ) -> std::result::Result<usize, &'static str> {
        use std::rc::Rc;
        let mut units = CopyUnits {
            total: 0,
            limit: available_work,
        };
        // The node map: the graph and the prepared input hold it.
        if Rc::strong_count(&graph.nodes) > 2 {
            units.add(graph.nodes.len())?;
            for n in graph.nodes.values() {
                units.add(n.previous.len())?;
            }
        }
        // Closure maps. Each closure shares its missing IDs and range
        // list; its appended-record set holds at most
        // `MAX_INCREMENTAL_RECORDS` IDs, a fixed cap per entry.
        if closures_shared {
            // Three references when the modes share one map.
            if Rc::strong_count(&graph.own) > 3 {
                units.add(graph.own.len())?;
            }
        } else {
            for cache in [&graph.own, &graph.structural, &graph.accepted] {
                if Rc::strong_count(cache) > 1 {
                    units.add(cache.len())?;
                }
            }
        }
        // Graph indexes that the append writes (`Graph::append_ordinary`).
        let new_issuer = !graph.lifecycle.key_actor.contains_key(&node.issuer)
            || !graph
                .lifecycle
                .groups
                .get(&node.issuer)
                .is_some_and(|group| group.contains(&node.issuer));
        if new_issuer && graph.lifecycle.is_shared() {
            lifecycle_copy_units(&graph.lifecycle, &mut units)?;
        }
        if !node.previous.is_empty() && graph.boundary.is_shared() {
            units.add(graph.boundary.len())?;
        }
        // Evaluation results: every append adds a receipt.
        if Rc::strong_count(&self.evaluation.results) > 1 {
            results_copy_units(&self.evaluation.results, &mut units)?;
        }
        if Rc::strong_count(&self.unresolved) > 1
            && node_has_new_unresolved_references(node, &self.prepared.nodes, &self.unresolved)
        {
            units.add(self.unresolved.len())?;
        }
        Ok(units.total)
    }

    /// Applies an append that `fast_work` priced. Returns `false` when
    /// the record turns out to need the register member walk; the
    /// caller then rebuilds, which discards the partial update.
    fn append(&mut self, node: Node, work: usize) -> bool {
        let graph = self.graph.as_mut().unwrap();
        let prepared_nodes = std::mem::take(&mut self.prepared.nodes);
        debug_assert!(std::rc::Rc::ptr_eq(&graph.nodes, &prepared_nodes));
        drop(prepared_nodes);
        graph.append_ordinary(node.clone());
        self.prepared.nodes = graph.nodes.clone();
        // `work` already holds the graph-construction and history-scan
        // charges. The scoped evaluation updates below run the same
        // code a full evaluation runs for this record, and their own
        // charges (closure unions for the new record) come out of the
        // same budget, so the total equals a full evaluation.
        self.predecessor_edges += node.previous.len();
        if self.prepared.options.limits.traversal.is_none() {
            self.remaining_work = self.remaining_work.saturating_add(record_allowance(&node));
        }
        self.remaining_work -= work;
        graph.budget.set(self.remaining_work);
        if !self
            .evaluation
            .lifecycle
            .key_actor
            .contains_key(&node.issuer)
        {
            self.evaluation
                .lifecycle
                .key_actor
                .insert(node.issuer.clone(), node.issuer.clone());
        }
        if !self
            .evaluation
            .lifecycle
            .groups
            .get(&node.issuer)
            .is_some_and(|group| group.contains(&node.issuer))
        {
            self.evaluation
                .lifecycle
                .groups
                .entry(node.issuer.clone())
                .or_default()
                .insert(node.issuer.clone());
        }
        self.evaluation.receipts.insert(
            node.id.clone(),
            Receipt {
                interpretation: Interpretation::Effective,
                body: node.body_label.clone(),
                reasons: BTreeSet::new(),
            },
        );
        if node.kind == "judgment.set" {
            let target = node.action.view().index("target");
            let target = target.as_str().unwrap();
            let key = format!("{}|judgment|{target}", node.issuer);
            if let Some(changes) = self.judgment_changes.as_mut().map(std::rc::Rc::make_mut) {
                changes.receipts.insert(node.id.clone());
                changes.registers.insert(key.clone());
                changes.actors.insert(node.issuer.clone());
                changes
                    .judgments
                    .entry(target.into())
                    .or_default()
                    .insert(node.issuer.clone());
            }
            // Price the register from its stored charge: the base
            // evaluation already paid for the previous member set,
            // so refund exactly that and keep the new charge. No
            // merges are replayed to recover the old charge. The
            // maxima merges build only temporary sets, so they charge
            // work and no ancestry bytes.
            let (previous_work, previous_member_work) = self
                .evaluation
                .registers
                .get(&key)
                .map(|register| (register.maxima_work, register.maxima_member_work))
                .unwrap_or((0, 0));
            graph.budget.set(graph.budget.get() + previous_work);
            // Closed form, when it applies: the fast path's parents
            // cover the issuer's whole block, so every same-issuer
            // member is an ancestor of the new record. If every
            // current head also lies in the new record's closure,
            // no other member can be a head (a non-head member sits
            // inside some head's closure, which sits inside the new
            // record's), the new record is the only head, and a full
            // evaluation's maxima work for the register is one merge
            // of its closure into an empty accumulator. A register with a head
            // outside the new closure (for example a member from
            // another issuer whose actor is this issuer) keeps the
            // general member-set path below.
            let new_closure = &graph.accepted[&node.id];
            let new_member_work =
                previous_member_work + new_closure.ids.fresh_ranges.saturating_sub(1);
            let sole_head = self
                .evaluation
                .registers
                .get(&key)
                .map(|register| {
                    register
                        .heads
                        .iter()
                        .all(|head| new_closure.ids.contains(head))
                })
                .unwrap_or(true);
            let (heads, new_work) = if sole_head && new_closure.ids.fresh_ranges == 1 {
                if new_member_work > 0 {
                    let _ = graph.charge(new_member_work);
                }
                (BTreeSet::from([node.id.clone()]), new_member_work)
            } else {
                // Otherwise a full evaluation's maxima runs over every
                // member of the register, and finding the members walks
                // every record. That walk is not part of this append's
                // price, so the advance rebuilds instead, which charges it.
                return false;
            };
            let values: BTreeSet<String> = heads
                .iter()
                .map(|id| {
                    graph.nodes[id]
                        .action
                        .view()
                        .index("value")
                        .as_str()
                        .unwrap()
                        .into()
                })
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
                    maxima_work: new_work,
                    maxima_member_work: new_member_work,
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
        }
        self.remaining_work = graph.budget.get();
        add_unresolved_node_references_cow(&node, &self.prepared.nodes, &mut self.unresolved);
        true
    }

    pub fn checkpoint(&self, binding: &str) -> jvc_core::Result<Vec<u8>> {
        self.save_checkpoint(binding, false)
    }
    /// Persistent checkpoints contain results. Private records remain in their own store.
    pub fn result_checkpoint(&self, binding: &str) -> jvc_core::Result<Vec<u8>> {
        self.save_checkpoint(binding, true)
    }
    fn save_checkpoint(&self, binding: &str, results_only: bool) -> jvc_core::Result<Vec<u8>> {
        if let Some(error) = self.prepared.arena_error() {
            return Err(jvc_core::Error::new("checkpoint", error.to_string()));
        }
        #[derive(Serialize)]
        struct SavedFull<'a> {
            version: &'static str,
            binding: &'a str,
            options: SavedOptions<'a>,
            nodes: &'a BTreeMap<String, Node>,
            evaluation: CheckpointEvaluation<'a>,
            event_limit_exceeded: bool,
            consumed_work: usize,
            remaining_work: usize,
            ancestry_bytes: Option<usize>,
            register_maxima_work: Vec<usize>,
            register_maxima_member_work: Vec<usize>,
        }
        #[derive(Serialize)]
        struct SavedResults<'a> {
            version: &'static str,
            binding: &'a str,
            options: SavedOptions<'a>,
            evaluation: CheckpointEvaluation<'a>,
            event_limit_exceeded: bool,
            consumed_work: usize,
            remaining_work: usize,
            ancestry_bytes: Option<usize>,
            register_maxima_work: Vec<usize>,
            register_maxima_member_work: Vec<usize>,
        }
        let consumed_work = self.consumed_work();
        let ancestry_bytes = self
            .graph
            .as_ref()
            .map(|graph| graph.ancestry.bytes())
            .or(self.saved_ancestry_bytes);
        let register_maxima_work: Vec<usize> = self
            .evaluation
            .registers
            .values()
            .map(|register| register.maxima_work)
            .collect();
        let register_maxima_member_work: Vec<usize> = self
            .evaluation
            .registers
            .values()
            .map(|register| register.maxima_member_work)
            .collect();
        let saved_options = self.saved_options();
        let mut bytes = if results_only {
            serde_json::to_vec(&SavedResults {
                version: RESULTS_CHECKPOINT_VERSION,
                binding,
                options: saved_options,
                evaluation: CheckpointEvaluation(&self.evaluation),
                event_limit_exceeded: self.prepared.event_limit_exceeded,
                consumed_work,
                remaining_work: self.remaining_work,
                ancestry_bytes,
                register_maxima_work,
                register_maxima_member_work,
            })
        } else {
            serde_json::to_vec(&SavedFull {
                version: CHECKPOINT_VERSION,
                binding,
                options: saved_options,
                nodes: &self.prepared.nodes,
                evaluation: CheckpointEvaluation(&self.evaluation),
                event_limit_exceeded: self.prepared.event_limit_exceeded,
                consumed_work,
                remaining_work: self.remaining_work,
                ancestry_bytes,
                register_maxima_work,
                register_maxima_member_work,
            })
        }
        .map_err(|e| jvc_core::Error::new("checkpoint", e.to_string()))?;
        let digest = jvc_core::hash_id("sha256:", b"", &bytes);
        bytes.pop();
        bytes.extend_from_slice(b",\"digest\":\"");
        bytes.extend_from_slice(digest.as_bytes());
        bytes.extend_from_slice(b"\"}");
        Ok(bytes)
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
        if !verify_checkpoint_digest(bytes) {
            return Err(jvc_core::Error::new(
                "checkpoint",
                "checkpoint version or binding does not match",
            ));
        }
        let (saved, expected_version, nodes) = match records {
            Some(records) => {
                let saved: SavedResultsCheckpoint = serde_json::from_slice(bytes)
                    .map_err(|e| jvc_core::Error::new("checkpoint", e.to_string()))?;
                let nodes = records
                    .into_iter()
                    .map(|r| (r.node.id.clone(), r.node))
                    .collect();
                (saved, RESULTS_CHECKPOINT_VERSION, nodes)
            }
            None => {
                let full: SavedFullCheckpoint = serde_json::from_slice(bytes)
                    .map_err(|e| jvc_core::Error::new("checkpoint", e.to_string()))?;
                let nodes = full.nodes;
                let saved = SavedResultsCheckpoint {
                    version: full.version,
                    binding: full.binding,
                    options: full.options,
                    evaluation: full.evaluation,
                    event_limit_exceeded: full.event_limit_exceeded,
                    consumed_work: full.consumed_work,
                    remaining_work: full.remaining_work,
                    ancestry_bytes: full.ancestry_bytes,
                    register_maxima_work: full.register_maxima_work,
                    register_maxima_member_work: full.register_maxima_member_work,
                    digest: full.digest,
                };
                (saved, CHECKPOINT_VERSION, nodes)
            }
        };
        let mut saved = saved;
        let mut validated_selections = BTreeMap::new();
        let resolved = if saved.event_limit_exceeded {
            policy::ResolvedSelections::default()
        } else {
            policy::resolve_referenced_selections_cached(
                &saved.options,
                &saved.options.import_selections,
                &nodes,
                &mut validated_selections,
            )
        };
        let selection_allowance = resolved.allowance;
        // `repack` below keeps every record's `previous`, so this count
        // also holds for the restored state.
        let predecessor_edges = predecessor_edges(&nodes);
        let expected_budget = saved.options.limits.traversal_budget_with_selections(
            nodes.len(),
            predecessor_edges,
            selection_allowance,
        );
        if saved.version != expected_version
            || saved.binding != binding
            || saved.evaluation.selected_view != saved.options.selected_view
            || saved.evaluation.overlay != saved.options.overlay
            || saved.consumed_work.checked_add(saved.remaining_work) != Some(expected_budget)
            || !valid_saved_state(&saved, &nodes, &resolved, &mut validated_selections)
        {
            return Err(jvc_core::Error::new(
                "checkpoint",
                "checkpoint version or binding does not match",
            ));
        }
        drop(resolved);
        let arena = std::rc::Rc::new(std::cell::RefCell::new(arena::RecordArena::default()));
        let nodes = nodes
            .into_iter()
            .map(|(id, node)| (id, node.repack(&arena)))
            .collect();
        arena.borrow_mut().finish_load();
        if let Some(error) = arena.borrow().error() {
            return Err(jvc_core::Error::new("checkpoint", error.to_string()));
        }
        let import_selections =
            std::rc::Rc::new(std::mem::take(&mut saved.options.import_selections));
        let prepared = PreparedEvaluationInput {
            options: saved.options,
            import_selections,
            nodes: std::rc::Rc::new(nodes),
            arena,
            arena_error: None,
            event_limit_exceeded: saved.event_limit_exceeded,
            validated_selections: std::rc::Rc::new(std::cell::RefCell::new(validated_selections)),
        };
        // The registers' charge fields are not serialized with
        // them; the checkpoint's array restores them in register
        // order.
        let mut evaluation = saved.evaluation;
        if evaluation.registers.len() != saved.register_maxima_work.len()
            || evaluation.registers.len() != saved.register_maxima_member_work.len()
        {
            return Err(jvc_core::Error::new(
                "checkpoint",
                "checkpoint version or binding does not match",
            ));
        }
        for ((register, work), member_work) in evaluation
            .registers
            .values_mut()
            .zip(saved.register_maxima_work.iter())
            .zip(saved.register_maxima_member_work.iter())
        {
            register.maxima_work = *work;
            register.maxima_member_work = *member_work;
        }
        restore_account_contributions(&mut evaluation);
        let rafsi_words = rafsi_words(&evaluation);
        let rafsi_assignments = rafsi_assignments(&evaluation);
        Ok(Self {
            unresolved: unresolved(&prepared, &evaluation),
            rafsi_words,
            rafsi_assignments,
            prepared,
            evaluation,
            graph: None,
            selection_allowance,
            predecessor_edges,
            remaining_work: saved.remaining_work,
            saved_ancestry_bytes: saved.ancestry_bytes,
            checkpoint_restored: true,
            statistics: UpdateStatistics::default(),
            judgment_changes: None,
            ranking_index: Default::default(),
        })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SavedFullCheckpoint {
    version: String,
    binding: String,
    options: EvaluationOptions,
    nodes: BTreeMap<String, Node>,
    evaluation: Evaluation,
    event_limit_exceeded: bool,
    consumed_work: usize,
    remaining_work: usize,
    #[serde(deserialize_with = "Option::deserialize")]
    ancestry_bytes: Option<usize>,
    register_maxima_work: Vec<usize>,
    register_maxima_member_work: Vec<usize>,
    #[allow(dead_code)]
    digest: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SavedResultsCheckpoint {
    version: String,
    binding: String,
    options: EvaluationOptions,
    evaluation: Evaluation,
    event_limit_exceeded: bool,
    consumed_work: usize,
    remaining_work: usize,
    #[serde(deserialize_with = "Option::deserialize")]
    ancestry_bytes: Option<usize>,
    register_maxima_work: Vec<usize>,
    register_maxima_member_work: Vec<usize>,
    #[allow(dead_code)]
    digest: String,
}

fn verify_checkpoint_digest(bytes: &[u8]) -> bool {
    const PREFIX: &[u8] = b",\"digest\":\"";
    const SCHEME: &[u8] = b"sha256:";
    const SUFFIX: &[u8] = b"\"}";
    const DIGEST_VAL_LEN: usize = SCHEME.len() + 64;
    const DIGEST_FIELD_LEN: usize = PREFIX.len() + DIGEST_VAL_LEN + SUFFIX.len();

    let reject = || {
        #[cfg(test)]
        DIGEST_REJECTIONS.with(|count| count.set(count.get() + 1));
        false
    };

    if bytes.len() <= DIGEST_FIELD_LEN + 1 || bytes.first() != Some(&b'{') {
        return reject();
    }
    let split = bytes.len() - DIGEST_FIELD_LEN;
    if &bytes[split..split + PREFIX.len()] != PREFIX
        || &bytes[bytes.len() - SUFFIX.len()..] != SUFFIX
    {
        return reject();
    }
    let stored = &bytes[split + PREFIX.len()..bytes.len() - SUFFIX.len()];
    if !stored.starts_with(SCHEME)
        || !stored[SCHEME.len()..]
            .iter()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    {
        return reject();
    }
    let mut writer = jvc_core::HashWriter::new(b"", usize::MAX);
    use std::io::Write;
    let _ = writer.write_all(&bytes[..split]);
    let _ = writer.write_all(b"}");
    let (actual, _) = writer.finish("sha256:");
    if actual.as_bytes() != stored {
        return reject();
    }
    true
}

fn valid_node_state(node: &Node) -> Result<(), &'static str> {
    if node.kind
        != node
            .action
            .view()
            .index("kind")
            .as_str()
            .unwrap_or_default()
    {
        return Err("node_kind");
    }
    let body_consistent = match node.body_label.as_str() {
        "absent" => node.body_hash.is_none() && node.body.is_none(),
        "missing" => node.body_hash.is_some() && node.body.is_none(),
        "valid" => node.body_hash.is_some() && node.body.is_some(),
        label if label.starts_with("invalid:") => {
            node.body.is_none()
                && (label == "invalid:header has no content descriptor" || node.body_hash.is_some())
        }
        _ => false,
    };
    if !body_consistent {
        return Err("node_body_consistent");
    }
    let Ok(action) = serde_json::to_value(&node.action) else {
        return Err("node_action_to_value");
    };
    let header = jvc_core::Header {
        version: 1,
        issuer: node.issuer.clone(),
        previous: node.previous.clone(),
        nonce: "00".repeat(16),
        action,
        content: node
            .body_hash
            .as_ref()
            .map(|hash| jvc_core::ContentDescriptor {
                hash: hash.clone(),
                bytes: 1,
            }),
    };
    if (jvc_core::validate_action(&header).is_ok()) != node.semantic {
        return Err("node_semantic");
    }
    if node.body_label == "valid" {
        let Some(body) = &node.body else {
            return Err("node_no_body");
        };
        let Ok(body_val) = serde_json::to_value(body) else {
            return Err("node_body_to_value");
        };
        if matches!(node.kind.as_str(), "definition.publish" | "rafsi.publish") {
            let Some(obj) = body_val.as_object() else {
                return Err("node_pub_not_obj");
            };
            match node.action.view().index("origin").as_str() {
                Some("native") => {
                    if !(obj.is_empty()
                        || (obj.len() == 1 && obj.get("legacy") == Some(&Value::Null)))
                    {
                        return Err("node_pub_native_legacy");
                    }
                }
                Some("import") => {
                    if obj.len() != 1 || !obj.contains_key("legacy") {
                        return Err("node_pub_no_legacy");
                    }
                    let legacy = &obj["legacy"];
                    let Some(leg_obj) = legacy.as_object() else {
                        return Err("node_pub_import_not_obj");
                    };
                    if leg_obj.len() != 3
                        || !leg_obj
                            .get("source")
                            .and_then(Value::as_str)
                            .is_some_and(|s| !s.is_empty())
                    {
                        return Err("node_pub_import_source");
                    }
                    let Some(rec_obj) = leg_obj.get("record").and_then(Value::as_object) else {
                        return Err("node_pub_import_record_not_obj");
                    };
                    if rec_obj.len() != 1 || rec_obj.get("id").and_then(Value::as_u64).is_none() {
                        return Err("node_pub_import_record_id");
                    }
                    let Some(attr_obj) = leg_obj.get("attribution").and_then(Value::as_object)
                    else {
                        return Err("node_pub_import_attr_not_obj");
                    };
                    if attr_obj.len() != 1 || !attr_obj.contains_key("author_account") {
                        return Err("node_pub_import_attr_fields");
                    }
                    let author_acc = &attr_obj["author_account"];
                    if !author_acc.is_null() {
                        let Some(acc_obj) = author_acc.as_object() else {
                            return Err("node_pub_import_acc_not_obj");
                        };
                        if acc_obj.len() != 3
                            || !acc_obj
                                .get("origin")
                                .and_then(Value::as_str)
                                .is_some_and(|s| !s.is_empty())
                            || acc_obj.get("account").and_then(Value::as_u64).is_none()
                        {
                            return Err("node_pub_import_acc_fields");
                        }
                        let Some(ev_obj) = acc_obj.get("evidence").and_then(Value::as_object)
                        else {
                            return Err("node_pub_import_ev_not_obj");
                        };
                        if ev_obj.len() != 1
                            || !ev_obj
                                .get("kind")
                                .and_then(Value::as_str)
                                .is_some_and(|s| !s.is_empty())
                        {
                            return Err("node_pub_import_ev_fields");
                        }
                    }
                }
                _ => {
                    if !obj.is_empty()
                        && !(obj.len() == 1
                            && obj
                                .get("legacy")
                                .is_some_and(|l| l.is_null() || l.is_object()))
                    {
                        return Err("node_pub_other_legacy");
                    }
                }
            }
        } else {
            let Ok(canonical) = jvc_core::canonical_value(&body_val) else {
                return Err("node_other_canonical");
            };
            if Some(jvc_core::hash_id("sha256:", b"", &canonical)) != node.body_hash {
                return Err("node_other_hash");
            }
            if node.semantic && jvc_core::validate_body(&header, &body_val).is_err() {
                return Err("node_other_validate_body");
            }
        }
    }
    Ok(())
}

fn optional_policy_matches(actual: Option<&CompactValue>, expected: Option<&CompactValue>) -> bool {
    match (actual, expected) {
        (None, None) => true,
        (Some(a), Some(e)) => {
            if a == e {
                return true;
            }
            let (Ok(Value::Object(a_obj)), Ok(Value::Object(mut e_obj))) =
                (serde_json::to_value(a), serde_json::to_value(e))
            else {
                return false;
            };
            e_obj.insert(
                "calculation".to_owned(),
                Value::String(jvc_rank::approximate::ALGORITHM.to_owned()),
            );
            a_obj == e_obj
        }
        _ => false,
    }
}

fn compact_value_digest(value: &CompactValue) -> Result<String, &'static str> {
    let mut writer = jvc_core::HashWriter::new(b"", usize::MAX);
    serde_json::to_writer(&mut writer, value).map_err(|_| "policy_digest")?;
    Ok(writer.finish("sha256:").0)
}

fn register_key_for_node(node: &Node, lifecycle: &Lifecycle) -> Option<String> {
    if !node.semantic {
        return None;
    }
    let actor = lifecycle
        .key_actor
        .get(&node.issuer)
        .map(String::as_str)
        .unwrap_or(node.issuer.as_str());
    let a = node.action.view();
    let suffix = match node.kind.as_str() {
        "judgment.set" => format!(
            "judgment|{}",
            a.index("target").as_str().unwrap_or_default()
        ),
        "trust.set" => {
            let subj_view = a.index("subject");
            let subj = subj_view.as_str().unwrap_or_default();
            let subj_actor = lifecycle
                .key_actor
                .get(subj)
                .map(String::as_str)
                .unwrap_or(subj);
            format!("trust|{subj_actor}|{}", a.index("scope"))
        }
        "identity.profile" => "profile".into(),
        "report.set" => format!("report|{}|{}", a.index("subject"), a.index("category")),
        "bridge.set" => format!(
            "bridge|{}|{}",
            a.index("origin"),
            a.index("source_definition")
        ),
        "account.set" => format!("account|{}|{}", a.index("origin"), a.index("account")),
        "account.observe" => format!("observe|{}|{}", a.index("origin"), a.index("account")),
        _ => return None,
    };
    Some(format!("{actor}|{suffix}"))
}

fn register_value_for_node(node: &Node) -> String {
    let a = node.action.view();
    match node.kind.as_str() {
        "identity.profile" => node.body_hash.clone().unwrap_or_default(),
        "bridge.set" if a.index("value") == "managed" => {
            format!("managed|{}", a.index("target"))
        }
        "account.observe" => format!("{}|{}", a.index("result"), a.index("claim")),
        "account.set" if a.index("value") == "claim" => node.id.clone(),
        _ => a.index("value").as_str().unwrap_or_default().into(),
    }
}

fn valid_saved_state(
    saved: &SavedResultsCheckpoint,
    nodes: &BTreeMap<String, Node>,
    resolved: &policy::ResolvedSelections<'_>,
    validated_selections: &mut BTreeMap<String, bool>,
) -> bool {
    check_saved_state(saved, nodes, resolved, validated_selections).is_ok()
}

fn check_saved_state(
    saved: &SavedResultsCheckpoint,
    nodes: &BTreeMap<String, Node>,
    resolved: &policy::ResolvedSelections<'_>,
    validated_selections: &mut BTreeMap<String, bool>,
) -> Result<(), &'static str> {
    if saved.evaluation.registers.len() != saved.register_maxima_work.len()
        || saved.evaluation.registers.len() != saved.register_maxima_member_work.len()
    {
        return Err("register_counter_lens");
    }
    for (id, node) in nodes {
        if id != &node.id {
            return Err("node_id");
        }
        valid_node_state(node)?;
    }

    let expected_event_limit_exceeded = saved
        .options
        .limits
        .events
        .is_some_and(|limit| nodes.len() > limit);
    if saved.event_limit_exceeded != expected_event_limit_exceeded {
        return Err("event_limit_exceeded");
    }

    let resource_refused =
        saved.event_limit_exceeded || saved.evaluation.reasons.contains("resource_unavailable");
    let has_blocking_reason = resource_refused
        || saved.evaluation.reasons.contains("view_unavailable")
        || saved.evaluation.reasons.contains("invalid_overlay")
        || saved
            .evaluation
            .reasons
            .contains("public_shun_issuer_unavailable");
    if saved.evaluation.available == has_blocking_reason {
        return Err("available_reasons");
    }
    for reason in &saved.evaluation.reasons {
        if !matches!(
            reason.as_str(),
            "resource_unavailable"
                | "view_unavailable"
                | "policy_ancestry_unavailable"
                | "import_selection_unavailable"
                | "selection_publications_pending"
                | "conditional_on_suspension"
                | "invalid_overlay"
                | "public_shun_issuer_unavailable"
        ) {
            return Err("evaluation_reason");
        }
    }
    if !resource_refused
        && saved
            .evaluation
            .reasons
            .contains("conditional_on_suspension")
            != !saved.evaluation.lifecycle.suspended.is_empty()
    {
        return Err("conditional_on_suspension");
    }
    if saved.event_limit_exceeded
        && (!saved.evaluation.reasons.contains("resource_unavailable")
            || saved.consumed_work != 0
            || saved.ancestry_bytes.is_some()
            || !saved.evaluation.receipts.is_empty()
            || !saved.evaluation.lifecycle.key_actor.is_empty()
            || !saved.evaluation.publications.is_empty()
            || !saved.evaluation.accounts.is_empty()
            || saved.evaluation.policy.is_some()
            || !saved.evaluation.policies.is_empty()
            || !saved.evaluation.policy_history.is_empty()
            || !saved.evaluation.selections.is_empty())
    {
        return Err("event_limit_state");
    }
    // Every refusal is the empty shape that `resource_unavailable`
    // builds: the selected view, the overlay and one reason.
    if resource_refused {
        let e = &saved.evaluation;
        if e.reasons.len() != 1
            || !e.receipts.is_empty()
            || !e.publications.is_empty()
            || !e.accounts.is_empty()
            || !e.registers.is_empty()
            || !e.judgments.is_empty()
            || !e.trust.is_empty()
            || e.policy.is_some()
            || !e.policies.is_empty()
            || !e.policy_history.is_empty()
            || !e.selections.is_empty()
            || !e.lifecycle.key_actor.is_empty()
            || !e.lifecycle.groups.is_empty()
            || !e.lifecycle.successor.is_empty()
            || !e.lifecycle.suspended.is_empty()
            || !e.lifecycle.retired.is_empty()
            || !e.lifecycle.compromised.is_empty()
        {
            return Err("resource_refused_state");
        }
    }
    if nodes.is_empty()
        && !saved.evaluation.available
        && !resource_refused
        && saved.evaluation.reasons.contains("view_unavailable")
    {
        return Ok(());
    }

    // Receipts must match nodes.
    if !resource_refused && saved.evaluation.receipts.len() != nodes.len() {
        return Err("receipts_len");
    }
    for (id, receipt) in &saved.evaluation.receipts {
        let Some(node) = nodes.get(id) else {
            return Err("receipt_missing");
        };
        if receipt.body != node.body_label {
            return Err("receipt_body");
        }
        for reason in &receipt.reasons {
            if !matches!(
                reason.as_str(),
                "resource_unavailable"
                    | "invalid_action"
                    | "own_history_pending"
                    | "outside_retained_history"
                    | "cutoff_pending"
                    | "incomplete_group"
                    | "body_unavailable"
                    | "invalid_target"
                    | "target_pending"
                    | "unauthorized_import_status"
                    | "account_binding_unavailable"
                    | "view_unavailable"
                    | "account_authority_disabled"
                    | "lineage_pending"
                    | "lineage_invalid"
            ) {
                return Err("receipt_reason");
            }
        }
        if !resource_refused && receipt.reasons.contains("invalid_action") != !node.semantic {
            return Err("receipt_invalid_action");
        }
        if !resource_refused
            && node.semantic
            && matches!(
                node.kind.as_str(),
                "judgment.set" | "status.set" | "import.status" | "bridge.set"
            )
        {
            let target_view = node.action.view().index("target");
            let target = target_view.as_str().unwrap_or_default();
            if !target.starts_with("jvr1:")
                && !nodes.contains_key(target)
                && (!receipt.reasons.contains("target_pending")
                    || receipt.interpretation != Interpretation::Pending)
            {
                return Err("receipt_direct_target_pending");
            }
        }
    }

    // Policy, policy_history, policies, and selections must match nodes and options.
    let expected_policy = nodes
        .get(&saved.options.selected_view)
        .filter(|n| n.semantic && n.kind == "view.publish")
        .and_then(|n| n.body.as_ref());
    if !resource_refused {
        if !optional_policy_matches(saved.evaluation.policy.as_ref(), expected_policy) {
            return Err("expected_policy");
        }
        if expected_policy.is_some()
            && saved
                .evaluation
                .policy_history
                .get(&saved.options.selected_view)
                != expected_policy
        {
            return Err("policy_history_selected");
        }
    } else if let Some(pol) = &saved.evaluation.policy
        && !optional_policy_matches(Some(pol), expected_policy)
    {
        return Err("expected_policy");
    }
    if saved.evaluation.policies.len() != saved.evaluation.policy_history.len() {
        return Err("policies_len");
    }
    let mut history_digests: BTreeMap<String, usize> = BTreeMap::new();
    let mut missing_policy_parent = false;
    for (vid, pol) in &saved.evaluation.policy_history {
        let Some(view_node) = nodes
            .get(vid)
            .filter(|n| n.semantic && n.kind == "view.publish")
        else {
            return Err("policy_history_entry");
        };
        if view_node.body.as_ref() != Some(pol) {
            return Err("policy_history_entry");
        }
        for parent_view in view_node
            .action
            .view()
            .index("parents")
            .as_array()
            .into_iter()
            .flatten()
        {
            let Some(parent_id) = parent_view.as_str() else {
                missing_policy_parent = true;
                continue;
            };
            if !saved.evaluation.policy_history.contains_key(parent_id) {
                missing_policy_parent = true;
            }
        }
        let digest = compact_value_digest(pol)?;
        *history_digests.entry(digest).or_insert(0) += 1;
    }
    if !resource_refused
        && saved.evaluation.policy.is_some()
        && saved
            .evaluation
            .reasons
            .contains("policy_ancestry_unavailable")
            != missing_policy_parent
    {
        return Err("policy_parent_missing");
    }
    for pol in &saved.evaluation.policies {
        let digest = compact_value_digest(pol)?;
        let Some(count) = history_digests.get_mut(&digest) else {
            return Err("policies_entry");
        };
        if *count == 0 {
            return Err("policies_entry");
        }
        *count -= 1;
    }
    if history_digests.values().any(|&count| count != 0) {
        return Err("policies_entry");
    }
    if !resource_refused {
        if let Some(pol) = &saved.evaluation.policy {
            let mut seen_valid = BTreeSet::new();
            let mut invalid_selections = resolved.invalid.clone();
            let mut missing_selection = false;
            for entry in pol
                .view()
                .index("import_sets")
                .as_array()
                .into_iter()
                .flatten()
            {
                let sel_view = entry.index("selection");
                let Some(sel_id) = sel_view.as_str() else {
                    missing_selection = true;
                    continue;
                };
                if seen_valid.contains(sel_id) {
                    continue;
                }
                if invalid_selections.contains(sel_id) {
                    missing_selection = true;
                    continue;
                }
                let valid_ids = resolved.valid.get(sel_id).copied().or_else(|| {
                    policy::valid_selection_cached(
                        &saved.options.import_selections,
                        sel_id,
                        validated_selections,
                    )
                });
                match valid_ids {
                    Some(ids) => {
                        let Some(saved_set) = saved.evaluation.selections.get(sel_id) else {
                            return Err("selections");
                        };
                        if saved_set.len() != ids.len() || !saved_set.iter().eq(ids.iter()) {
                            return Err("selections");
                        }
                        seen_valid.insert(sel_id.to_owned());
                    }
                    None => {
                        invalid_selections.insert(sel_id.to_owned());
                        missing_selection = true;
                    }
                }
            }
            if saved.evaluation.selections.len() != seen_valid.len()
                || saved
                    .evaluation
                    .reasons
                    .contains("import_selection_unavailable")
                    != missing_selection
            {
                return Err("selections");
            }
        } else if !saved.evaluation.selections.is_empty() {
            return Err("selections_no_policy");
        }
    }

    // Lifecycle cross-checks.
    let mut transfer_issuers = BTreeSet::new();
    let mut compromise_issuers = BTreeSet::new();
    let mut transfer_edges: BTreeMap<(String, String), Vec<String>> = BTreeMap::new();
    let mut accept_edges: BTreeSet<(String, String)> = BTreeSet::new();
    let mut register_node_counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut observed_claims_by_account: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut all_nodes_root_no_accept = true;
    for node in nodes.values() {
        if !node.previous.is_empty() || (node.semantic && node.kind == "identity.accept") {
            all_nodes_root_no_accept = false;
        }
        if node.semantic {
            match node.kind.as_str() {
                "identity.transfer" => {
                    transfer_issuers.insert(node.issuer.as_str());
                    let succ_view = node.action.view().index("successor");
                    if let Some(succ) = succ_view.as_str() {
                        transfer_edges
                            .entry((node.issuer.clone(), succ.to_owned()))
                            .or_default()
                            .push(node.id.clone());
                    }
                }
                "identity.compromise" => {
                    compromise_issuers.insert(node.issuer.as_str());
                }
                "identity.accept" if node.previous.is_empty() => {
                    let tid_view = node.action.view().index("transfer");
                    if let Some(tid) = tid_view.as_str() {
                        accept_edges.insert((node.issuer.clone(), tid.to_owned()));
                    }
                }
                "account.observe" => {
                    let a = node.action.view();
                    if a.index("result") == "present"
                        && let (Some(origin), Some(account), Some(claim)) = (
                            a.index("origin").as_str(),
                            a.index("account").as_u64(),
                            a.index("claim").as_str(),
                        )
                    {
                        observed_claims_by_account
                            .entry(format!("{origin}#{account}"))
                            .or_default()
                            .insert(claim.to_owned());
                    }
                }
                _ => {}
            }
            if let Some(rkey) = register_key_for_node(node, &saved.evaluation.lifecycle) {
                *register_node_counts.entry(rkey).or_insert(0) += 1;
            }
        }
    }
    if !resource_refused || !saved.evaluation.lifecycle.key_actor.is_empty() {
        for node in nodes.values() {
            if !saved
                .evaluation
                .lifecycle
                .key_actor
                .contains_key(&node.issuer)
            {
                return Err("lifecycle_issuer_actor");
            }
            if node.previous.iter().any(|p| !nodes.contains_key(p)) {
                let Some(actor) = saved.evaluation.lifecycle.key_actor.get(&node.issuer) else {
                    return Err("lifecycle_suspended_actor");
                };
                if !saved
                    .evaluation
                    .lifecycle
                    .suspended
                    .get(actor)
                    .is_some_and(|set| set.contains(&node.id))
                {
                    return Err("lifecycle_suspended_missing");
                }
            }
        }
    }
    for key in &saved.evaluation.lifecycle.retired {
        if !transfer_issuers.contains(key.as_str()) {
            return Err("lifecycle_retired");
        }
    }
    for key in &saved.evaluation.lifecycle.compromised {
        if !compromise_issuers.contains(key.as_str()) {
            return Err("lifecycle_compromised");
        }
    }
    for (key, actor) in &saved.evaluation.lifecycle.key_actor {
        if !saved
            .evaluation
            .lifecycle
            .groups
            .get(actor)
            .is_some_and(|g| g.contains(key))
        {
            return Err("lifecycle_key_in_group");
        }
    }
    let mut group_member_total = 0usize;
    let mut expected_successor_edges = 0usize;
    for (actor, group) in &saved.evaluation.lifecycle.groups {
        if group.is_empty() || !group.contains(actor) {
            return Err("lifecycle_group_contains_actor");
        }
        group_member_total += group.len();
        expected_successor_edges += group.len().saturating_sub(1);
        for member in group {
            if saved.evaluation.lifecycle.key_actor.get(member) != Some(actor) {
                return Err("lifecycle_group_member_actor");
            }
        }
    }
    if group_member_total != saved.evaluation.lifecycle.key_actor.len()
        || saved.evaluation.lifecycle.successor.len() != expected_successor_edges
    {
        return Err("lifecycle_group_totals");
    }
    for (old_key, new_key) in &saved.evaluation.lifecycle.successor {
        if saved.evaluation.lifecycle.key_actor.get(old_key)
            != saved.evaluation.lifecycle.key_actor.get(new_key)
            || !saved.evaluation.lifecycle.retired.contains(old_key)
            || saved.evaluation.lifecycle.compromised.contains(old_key)
            || !transfer_edges
                .get(&(old_key.clone(), new_key.clone()))
                .is_some_and(|tids| {
                    tids.iter()
                        .any(|tid| accept_edges.contains(&(new_key.clone(), tid.clone())))
                })
        {
            return Err("lifecycle_successor_actor");
        }
    }
    for (actor, missing) in &saved.evaluation.lifecycle.suspended {
        if missing.is_empty() || !saved.evaluation.lifecycle.groups.contains_key(actor) {
            return Err("lifecycle_suspended_entry");
        }
        for sid in missing {
            let Some(snode) = nodes.get(sid) else {
                return Err("lifecycle_suspended_node");
            };
            if saved.evaluation.lifecycle.key_actor.get(&snode.issuer) != Some(actor) {
                return Err("lifecycle_suspended_actor_match");
            }
        }
    }

    // Publications cross-checks.
    let expected_pub_count = nodes
        .values()
        .filter(|n| n.semantic && matches!(n.kind.as_str(), "definition.publish" | "rafsi.publish"))
        .count();
    if !resource_refused && saved.evaluation.publications.len() != expected_pub_count {
        return Err("publications_len");
    }
    for (id, p) in &saved.evaluation.publications {
        // Checkpoints leave the contributions out, and restore sets
        // them from the account.
        if !p.witness_contributions.is_empty() {
            return Err("publication_checkpoint_contributions");
        }
        let Some(node) = nodes.get(id).filter(|n| {
            n.semantic && matches!(n.kind.as_str(), "definition.publish" | "rafsi.publish")
        }) else {
            return Err("publication_node");
        };
        let a = node.action.view();
        if p.id != *id
            || p.issuer != node.issuer
            || p.kind != node.kind
            || p.word != a.index("word").as_str().unwrap_or_default()
            || p.language.as_deref() != a.index("language").as_str()
            || p.assignment.as_deref() != a.index("assignment").as_str()
            || p.imported != (a.index("origin").as_str() == Some("import"))
            || p.content_available != node.body.is_some()
        {
            return Err("publication_fields");
        }
        for reason in &p.reasons {
            if !matches!(
                reason.as_str(),
                "resource_unavailable"
                    | "view_unavailable"
                    | "body_unavailable"
                    | "own_history_pending"
                    | "cutoff_pending"
                    | "outside_retained_history"
                    | "incomplete_group"
                    | "source_attribution_pending"
                    | "source_attribution_unavailable"
                    | "import_selection_unavailable"
                    | "source_selection_conflict"
                    | "claim_pending"
                    | "binding_unavailable"
                    | "observation_pending"
                    | "observation_body_invalid"
                    | "historical_guard"
                    | "policy_history_unavailable"
                    | "witness_history_incomplete"
                    | "policy_ancestry_unavailable"
                    | "controller_dispute"
                    | "current_authority_lost"
                    | "carry_history_pending"
                    | "carry_or_authority_pending"
                    | "controller_authority_uncertain"
                    | "contested_status_authority"
            ) {
                return Err("publication_reason");
            }
        }
        for fid in &p.status_frontier {
            let Some(fnode) = nodes.get(fid) else {
                return Err("publication_frontier_node");
            };
            if !fnode.semantic || fnode.action.view().index("target").as_str() != Some(id.as_str())
            {
                return Err("publication_frontier_target");
            }
        }
        if !resource_refused {
            let expected_parents: BTreeSet<String> = a
                .index("parents")
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect();
            if p.lineage.keys().cloned().collect::<BTreeSet<_>>() != expected_parents {
                return Err("publication_lineage");
            }
            for (parent_id, state) in &p.lineage {
                let expected_state = match nodes.get(parent_id) {
                    None => "pending",
                    Some(parent)
                        if !parent.semantic
                            || parent.kind != "definition.publish"
                            || parent.action.view().index("word") != a.index("word")
                            || parent.action.view().index("language") != a.index("language") =>
                    {
                        "invalid"
                    }
                    Some(_) => "resolved",
                };
                if state != expected_state {
                    return Err("publication_lineage_state");
                }
            }
        }
        if !p.imported {
            if p.source.is_some()
                || p.source_record.is_some()
                || p.account.is_some()
                || !p.witness_contributions.is_empty()
            {
                return Err("publication_native_import_fields");
            }
            let expected_native_controller = if p.authority == Authority::Native {
                saved
                    .evaluation
                    .lifecycle
                    .key_actor
                    .get(&p.issuer)
                    .map(String::as_str)
            } else {
                None
            };
            if p.controller.as_deref() != expected_native_controller {
                return Err("publication_native_controller");
            }
        } else if node.body.is_none() {
            // A fresh evaluation reads the source and the account from
            // the body, so an import without one has neither. Restore
            // attaches account evidence by this field, so it must not
            // trust a saved one.
            if p.source.is_some() || p.source_record.is_some() || p.account.is_some() {
                return Err("publication_import_without_body");
            }
        } else if let Some(body) = &node.body {
            let legacy = body.view().index("legacy");
            let expected_source = legacy.index("source").as_str().map(str::to_owned);
            let expected_record = legacy.index("record").index("id").as_u64();
            let acc_view = legacy.index("attribution").index("author_account");
            let expected_acc = if acc_view.index("evidence").index("kind") == "source-id"
                && let (Some(origin), Some(account)) = (
                    acc_view.index("origin").as_str().map(str::to_owned),
                    acc_view.index("account").as_u64(),
                ) {
                Some(AccountKey { origin, account })
            } else {
                None
            };
            if p.source != expected_source
                || p.source_record != expected_record
                || p.account != expected_acc
            {
                return Err("publication_import_legacy");
            }
            if !resource_refused
                && let Some(acc) = &p.account
                && let Some(pol) = &saved.evaluation.policy
            {
                let Some(state) = saved.evaluation.accounts.get(&acc.token()) else {
                    return Err("publication_account_missing");
                };
                let status_authority =
                    pol.view().index("account_authority").as_bool() == Some(true);
                if status_authority && p.kind == "definition.publish" {
                    if p.claim != state.controller
                        || p.controller != state.controller_identity
                        || p.controller_candidates != state.candidates
                        || p.observations != state.current_observations
                    {
                        return Err("publication_account_fields");
                    }
                    let expected_deciding = if p.controller_candidates.len() == 1 {
                        p.status_frontier
                            .iter()
                            .next()
                            .and_then(|fid| nodes.get(fid))
                            .and_then(|n| {
                                n.action.view().index("claim").as_str().map(str::to_owned)
                            })
                    } else {
                        None
                    };
                    if p.deciding_claim != expected_deciding {
                        return Err("publication_deciding_claim");
                    }
                }
            }
        }
    }

    // Accounts cross-checks.
    let expected_witness_actors: BTreeSet<String> = saved
        .evaluation
        .policy
        .as_ref()
        .into_iter()
        .flat_map(|pol| {
            pol.view()
                .index("account_witnesses")
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .map(|k| {
                    saved
                        .evaluation
                        .lifecycle
                        .key_actor
                        .get(&k)
                        .cloned()
                        .unwrap_or(k)
                })
                .collect::<Vec<_>>()
        })
        .collect();
    for (token, state) in &saved.evaluation.accounts {
        if state.account.token() != *token
            || state.contributions.keys().cloned().collect::<BTreeSet<_>>()
                != expected_witness_actors
            || state
                .observation_evidence
                .keys()
                .cloned()
                .collect::<BTreeSet<_>>()
                != expected_witness_actors
        {
            return Err("account_witness_keys");
        }
        let mut union_candidates = BTreeSet::new();
        for (actor, obs_ids) in &state.observation_evidence {
            let expected_claims: BTreeSet<String> = obs_ids
                .iter()
                .filter_map(|oid| nodes.get(oid))
                .filter_map(|n| n.action.view().index("claim").as_str().map(str::to_owned))
                .collect();
            if state.contributions.get(actor) != Some(&expected_claims) {
                return Err("account_contributions_claims");
            }
            union_candidates.extend(expected_claims);
        }
        if state.candidates != union_candidates {
            return Err("account_candidates");
        }
        if state.disputed != (state.candidates.len() > 1) {
            return Err("account_disputed");
        }
        if state.unavailable && (state.controller.is_some() || state.reasons.is_empty()) {
            return Err("account_unavailable");
        }
        let max_chains = state
            .candidates
            .len()
            .saturating_add(state.certificates.len())
            .max(1);
        if state.chain.len() > saved.options.limits.claim_depth.saturating_mul(max_chains)
            || ((!state.candidates.is_empty() || !state.certificates.is_empty())
                && saved.options.limits.claim_depth == 0
                && !state.reasons.contains("resource_unavailable"))
        {
            return Err("account_claim_depth");
        }
        for cid in &state.chain {
            let Some(cnode) = nodes.get(cid) else {
                return Err("account_chain_missing_node");
            };
            let ca = cnode.action.view();
            if !cnode.semantic
                || cnode.kind != "account.set"
                || ca.index("value") != "claim"
                || ca.index("origin").as_str() != Some(state.account.origin.as_str())
                || ca.index("account").as_u64() != Some(state.account.account)
            {
                return Err("account_claim_node");
            }
        }
        for cid in &state.closed {
            if !state.chain.contains(cid) {
                return Err("account_closed_in_chain");
            }
        }
        for cid in &state.historical {
            if !observed_claims_by_account
                .get(token)
                .is_some_and(|set| set.contains(cid))
            {
                return Err("account_historical_observed");
            }
        }
        if let Some(ctrl) = &state.controller
            && !state.chain.contains(ctrl)
        {
            return Err("account_controller_in_chain");
        }
        for cert in &state.certificates {
            if !saved.evaluation.policy_history.contains_key(&cert.policy)
                || !state.historical.contains(&cert.claim)
                || cert.observations.is_empty()
            {
                return Err("account_certificate");
            }
            for oid in &cert.observations {
                let Some(onode) = nodes.get(oid) else {
                    return Err("account_certificate_obs");
                };
                let oa = onode.action.view();
                if !onode.semantic
                    || onode.kind != "account.observe"
                    || oa.index("origin").as_str() != Some(state.account.origin.as_str())
                    || oa.index("account").as_u64() != Some(state.account.account)
                    || oa.index("claim").as_str() != Some(cert.claim.as_str())
                {
                    return Err("account_certificate_obs");
                }
            }
        }
        let expected_controller = if !state.unavailable
            && state.candidates.len() == 1
            && !state.contributions.is_empty()
            && state.contributions.values().all(|c| c.len() == 1)
        {
            state.candidates.iter().next().cloned()
        } else {
            None
        };
        if state.controller != expected_controller {
            return Err("account_controller");
        }
        if state.commands && state.controller.is_none() {
            return Err("account_commands_without_controller");
        }
        let expected_identity = if state.commands {
            state
                .controller
                .as_ref()
                .and_then(|cid| nodes.get(cid))
                .map(|n| n.issuer.clone())
        } else {
            None
        };
        if state.controller_identity != expected_identity {
            return Err("account_controller_identity");
        }
    }

    // Registers, judgments, trust, and register counter cross-checks.
    let mut judgment_registers = 0usize;
    let mut trust_registers = 0usize;
    let mut total_maxima_work = 0usize;
    for ((key, reg), (&work, &member_work)) in saved.evaluation.registers.iter().zip(
        saved
            .register_maxima_work
            .iter()
            .zip(&saved.register_maxima_member_work),
    ) {
        if reg.key != *key
            || reg.heads.is_empty()
            || reg.values.is_empty()
            || reg.conflicted != (reg.values.len() > 1)
        {
            return Err("register_fields");
        }
        let Some((prefix_actor, _)) = key.split_once('|') else {
            return Err("register_key");
        };
        if prefix_actor != reg.actor {
            return Err("register_actor");
        }
        let mut expected_values = BTreeSet::new();
        for head_id in &reg.heads {
            let Some(hn) = nodes.get(head_id) else {
                return Err("register_head_missing");
            };
            if register_key_for_node(hn, &saved.evaluation.lifecycle).as_deref()
                != Some(key.as_str())
            {
                return Err("register_head_key");
            }
            expected_values.insert(register_value_for_node(hn));
        }
        if reg.values != expected_values {
            return Err("register_values");
        }
        if member_work > work {
            return Err("register_counter_bounds");
        }
        // One member: its closure is merged into an empty
        // accumulator once, so the maxima work is twice the member
        // work.
        if register_node_counts.get(key).copied() == Some(1)
            && Some(work) != member_work.checked_mul(2)
        {
            return Err("register_single_member_counters");
        }
        if all_nodes_root_no_accept && member_work != 0 {
            return Err("register_root_member_work");
        }
        total_maxima_work = total_maxima_work
            .checked_add(work)
            .ok_or("register_work_overflow")?;

        if let Some((_, target)) = key.split_once("|judgment|") {
            judgment_registers += 1;
            let expected_judgment = if reg.values.len() > 1 {
                Judgment::Conflicted
            } else {
                match reg.values.iter().next().map(String::as_str) {
                    Some("bless") => Judgment::Bless,
                    Some("curse") => Judgment::Curse,
                    _ => Judgment::Clear,
                }
            };
            if saved
                .evaluation
                .judgments
                .get(target)
                .and_then(|m| m.get(&reg.actor))
                != Some(&expected_judgment)
            {
                return Err("register_judgment_entry");
            }
        } else if key.contains("|trust|") {
            trust_registers += 1;
        }
    }
    let ancestry_cap = super::ancestors::ancestry_cap(nodes.len());
    if !resource_refused
        && total_maxima_work
            .checked_add(nodes.len().saturating_mul(2))
            .is_none_or(|min_work| min_work > saved.consumed_work)
    {
        return Err("register_work_exceeds_consumed");
    }
    if let Some(bytes) = saved.ancestry_bytes {
        if bytes > ancestry_cap || bytes % 8 != 0 {
            return Err("ancestry_bytes_invalid");
        }
    }
    if saved.evaluation.judgments.values().any(BTreeMap::is_empty)
        || saved
            .evaluation
            .judgments
            .values()
            .map(BTreeMap::len)
            .sum::<usize>()
            != judgment_registers
        || saved.evaluation.trust.len() != trust_registers
    {
        return Err("registers_totals");
    }
    for rule in &saved.evaluation.trust {
        let Ok(scope) = serde_json::to_value(&rule.scope) else {
            return Err("trust_scope_json");
        };
        if rule.values.is_empty() || jvc_core::validate_scope(&scope).is_err() {
            return Err("trust_rule");
        }
        let trust_key = format!(
            "{}|trust|{}|{}",
            rule.actor,
            rule.subject,
            rule.scope.view()
        );
        let Some(reg) = saved.evaluation.registers.get(&trust_key) else {
            return Err("trust_register_missing");
        };
        if reg.values != rule.values {
            return Err("trust_register_values");
        }
    }

    Ok(())
}

/// The complete set of keys a state patch may name, between the base
/// and rebuilt evaluations of a judgment-only advance. The patch can
/// only set entries of receipts, registers, judgments, and the
/// lifecycle key-actor and group maps, taken from the new evaluation.
/// Anything else that differs, and any removed entry, makes the
/// patch unsafe: return `None` and let the consumer refresh fully.
fn judgment_diff(before: &Evaluation, after: &Evaluation) -> Option<JudgmentChanges> {
    if !after.available
        || before.selected_view != after.selected_view
        || before.reasons != after.reasons
        || before.publications != after.publications
        || before.accounts != after.accounts
        || before.policy != after.policy
        || before.overlay != after.overlay
        || before.policies != after.policies
        || before.policy_history != after.policy_history
        || before.selections != after.selections
        || before.trust != after.trust
        || before.lifecycle.successor != after.lifecycle.successor
        || before.lifecycle.suspended != after.lifecycle.suspended
        || before.lifecycle.retired != after.lifecycle.retired
        || before.lifecycle.compromised != after.lifecycle.compromised
    {
        return None;
    }
    let mut changes = JudgmentChanges::default();
    for (id, receipt) in &after.receipts {
        if before.receipts.get(id) != Some(receipt) {
            changes.receipts.insert(id.clone());
        }
    }
    if before
        .receipts
        .keys()
        .any(|id| !after.receipts.contains_key(id))
    {
        return None;
    }
    for (key, register) in &after.registers {
        if before.registers.get(key) != Some(register) {
            changes.registers.insert(key.clone());
        }
    }
    if before
        .registers
        .keys()
        .any(|key| !after.registers.contains_key(key))
    {
        return None;
    }
    for (target, actors) in &after.judgments {
        for (actor, judgment) in actors {
            if before
                .judgments
                .get(target)
                .and_then(|prior| prior.get(actor))
                != Some(judgment)
            {
                changes
                    .judgments
                    .entry(target.clone())
                    .or_default()
                    .insert(actor.clone());
            }
        }
    }
    if before.judgments.iter().any(|(target, actors)| {
        actors.keys().any(|actor| {
            !after
                .judgments
                .get(target)
                .is_some_and(|next| next.contains_key(actor))
        })
    }) {
        return None;
    }
    for (key, actor) in &after.lifecycle.key_actor {
        if before.lifecycle.key_actor.get(key) != Some(actor) {
            changes.actors.insert(key.clone());
        }
    }
    for (key, group) in &after.lifecycle.groups {
        if before.lifecycle.groups.get(key) != Some(group) {
            changes.actors.insert(key.clone());
        }
    }
    if before
        .lifecycle
        .key_actor
        .keys()
        .any(|key| !after.lifecycle.key_actor.contains_key(key))
        || before
            .lifecycle
            .groups
            .keys()
            .any(|key| !after.lifecycle.groups.contains_key(key))
    {
        return None;
    }
    Some(changes)
}

/// Sets the contributions that a checkpoint leaves out. As in
/// `accounts::evaluate`, each imported definition credited to an account
/// shares the account's map when the view gives accounts status
/// authority. Every other publication keeps an empty map.
fn restore_account_contributions(evaluation: &mut Evaluation) {
    if evaluation.accounts.is_empty()
        || evaluation.reasons.contains("resource_unavailable")
        || !evaluation
            .policy
            .as_ref()
            .is_some_and(|policy| policy.view().index("account_authority").as_bool() == Some(true))
    {
        return;
    }
    let results = std::rc::Rc::make_mut(&mut evaluation.results);
    for p in results.publications.values_mut() {
        if !p.imported || p.kind != "definition.publish" {
            continue;
        }
        if let Some(state) = p
            .account
            .as_ref()
            .and_then(|a| results.accounts.get(&a.token()))
        {
            p.witness_contributions = state.contributions.clone();
        }
    }
}

/// The default budget's growth for one more record.
fn record_allowance(node: &Node) -> usize {
    DEFAULT_TRAVERSAL_PER_RECORD.saturating_add(
        node.previous
            .len()
            .saturating_mul(DEFAULT_TRAVERSAL_PER_PREDECESSOR),
    )
}

fn supports_local_update(node: &Node) -> bool {
    node.semantic
        && (node.kind == "judgment.set"
            || node.kind == "definition.publish" && node.action.view().index("origin") == "native")
}

fn next_ready_id(added: &BTreeMap<String, Node>) -> Option<String> {
    added
        .iter()
        .find(|(_, node)| {
            node.previous.iter().all(|id| !added.contains_key(id))
                && node
                    .action
                    .view()
                    .index("target")
                    .as_str()
                    .is_none_or(|id| !added.contains_key(id))
                && node
                    .action
                    .view()
                    .index("parents")
                    .as_array()
                    .into_iter()
                    .flatten()
                    .all(|id| id.as_str().is_none_or(|id| !added.contains_key(id)))
        })
        .map(|(id, _)| id.clone())
}

/// Counts copy units against a limit. A caller adds the counts it can
/// read in constant time first, and walks nested collections only
/// after their outer counts fit, so every walk is bounded by units
/// already counted.
struct CopyUnits {
    total: usize,
    limit: usize,
}
impl CopyUnits {
    fn add(&mut self, units: usize) -> std::result::Result<(), &'static str> {
        self.total = self.total.saturating_add(units);
        if self.total > self.limit {
            Err("work_budget")
        } else {
            Ok(())
        }
    }
}

/// Units to deep-copy evaluation results that another state shares:
/// one per entry of every collection and one per member of every
/// nested collection, at every depth.
fn results_copy_units(
    r: &EvaluationResults,
    units: &mut CopyUnits,
) -> std::result::Result<(), &'static str> {
    lifecycle_copy_units(&r.lifecycle, units)?;
    for len in [
        r.receipts.len(),
        r.publications.len(),
        r.accounts.len(),
        r.registers.len(),
        r.judgments.len(),
        r.policies.len(),
        r.policy_history.len(),
        r.selections.len(),
        r.trust.len(),
    ] {
        units.add(len)?;
    }
    // Second level: walks bounded by the entry counts above.
    for receipt in r.receipts.values() {
        units.add(receipt.reasons.len())?;
    }
    for p in r.publications.values() {
        units.add(
            p.lineage.len()
                + p.observations.len()
                + p.status_frontier.len()
                + p.controller_candidates.len()
                + p.witness_contributions.len()
                + p.missing.len()
                + p.reasons.len(),
        )?;
    }
    for a in r.accounts.values() {
        units.add(
            a.candidates.len()
                + a.contributions.len()
                + a.observation_evidence.len()
                + a.certificates.len()
                + a.chain.len()
                + a.current_observations.len()
                + a.historical.len()
                + a.closed.len()
                + a.reasons.len()
                + a.missing.len(),
        )?;
    }
    for register in r.registers.values() {
        units.add(register.heads.len() + register.values.len())?;
    }
    for judgments in r.judgments.values() {
        units.add(judgments.len())?;
    }
    for ids in r.selections.values() {
        units.add(ids.len())?;
    }
    for rule in &r.trust {
        units.add(rule.values.len())?;
    }
    // Third level: walks bounded by the nested counts above.
    for p in r.publications.values() {
        for members in p.witness_contributions.values() {
            units.add(members.len())?;
        }
    }
    for a in r.accounts.values() {
        for members in a
            .contributions
            .values()
            .chain(a.observation_evidence.values())
        {
            units.add(members.len())?;
        }
        for certificate in &a.certificates {
            units.add(certificate.observations.len())?;
        }
    }
    Ok(())
}

/// Units to deep-copy a lifecycle that another state shares.
fn lifecycle_copy_units(
    lifecycle: &Lifecycle,
    units: &mut CopyUnits,
) -> std::result::Result<(), &'static str> {
    units.add(
        lifecycle.key_actor.len()
            + lifecycle.groups.len()
            + lifecycle.successor.len()
            + lifecycle.suspended.len()
            + lifecycle.retired.len()
            + lifecycle.compromised.len(),
    )?;
    for members in lifecycle
        .groups
        .values()
        .chain(lifecycle.suspended.values())
    {
        units.add(members.len())?;
    }
    Ok(())
}

fn value_has_new_unresolved_references(
    value: ValueView,
    nodes: &BTreeMap<String, Node>,
    existing: &BTreeSet<String>,
) -> bool {
    if let Some(id) = value.as_str().filter(|id| jvc_core::valid_id(id, "jve1:")) {
        !nodes.contains_key(id) && !existing.contains(id)
    } else {
        let mut found = false;
        value.for_each_child(|child| {
            if !found {
                found = value_has_new_unresolved_references(child, nodes, existing);
            }
        });
        found
    }
}

fn node_has_new_unresolved_references(
    node: &Node,
    nodes: &BTreeMap<String, Node>,
    existing: &BTreeSet<String>,
) -> bool {
    node.previous
        .iter()
        .any(|id| !nodes.contains_key(id) && !existing.contains(id))
        || value_has_new_unresolved_references(node.action.view(), nodes, existing)
        || node
            .body
            .as_ref()
            .is_some_and(|body| value_has_new_unresolved_references(body.view(), nodes, existing))
}

fn unresolved_references(
    value: ValueView,
    nodes: &BTreeMap<String, Node>,
    result: &mut BTreeSet<String>,
) {
    if let Some(id) = value.as_str().filter(|id| jvc_core::valid_id(id, "jve1:")) {
        if !nodes.contains_key(id) {
            result.insert(id.into());
        }
    } else {
        value.for_each_child(|child| unresolved_references(child, nodes, result));
    }
}

fn add_unresolved_node_references(
    node: &Node,
    nodes: &BTreeMap<String, Node>,
    result: &mut BTreeSet<String>,
) {
    for id in &node.previous {
        if !nodes.contains_key(id) {
            result.insert(id.clone());
        }
    }
    unresolved_references(node.action.view(), nodes, result);
    if let Some(body) = &node.body {
        unresolved_references(body.view(), nodes, result);
    }
}

fn add_unresolved_node_references_cow(
    node: &Node,
    nodes: &BTreeMap<String, Node>,
    result: &mut std::rc::Rc<BTreeSet<String>>,
) {
    if node_has_new_unresolved_references(node, nodes, result) {
        add_unresolved_node_references(node, nodes, std::rc::Rc::make_mut(result));
    }
}

fn unresolved(
    prepared: &PreparedEvaluationInput,
    evaluation: &Evaluation,
) -> std::rc::Rc<BTreeSet<String>> {
    if evaluation.reasons.contains("resource_unavailable") {
        return Default::default();
    }
    let mut result = BTreeSet::new();
    if !prepared.nodes.contains_key(&prepared.options.selected_view) {
        result.insert(prepared.options.selected_view.clone());
    }
    if evaluation
        .reasons
        .contains("selection_publications_pending")
    {
        for ids in evaluation.selections.values() {
            for id in ids {
                if !prepared.nodes.contains_key(id) {
                    result.insert(id.clone());
                }
            }
        }
    }
    for node in prepared.nodes.values() {
        add_unresolved_node_references(node, &prepared.nodes, &mut result);
    }
    std::rc::Rc::new(result)
}

fn rafsi_assignments(evaluation: &Evaluation) -> std::rc::Rc<BTreeSet<String>> {
    if evaluation.reasons.contains("resource_unavailable") {
        return Default::default();
    }
    let assignments: BTreeSet<String> = evaluation
        .publications
        .values()
        .filter_map(|p| p.assignment.clone())
        .collect();
    if assignments.is_empty() {
        return Default::default();
    }
    std::rc::Rc::new(assignments)
}

fn rafsi_words(evaluation: &Evaluation) -> std::rc::Rc<BTreeSet<String>> {
    if evaluation.reasons.contains("resource_unavailable") {
        return Default::default();
    }
    let mut words = BTreeSet::new();
    for p in evaluation.publications.values() {
        if p.kind == "rafsi.publish" {
            words.insert(p.word.clone());
        }
    }
    if words.is_empty() {
        return Default::default();
    }
    std::rc::Rc::new(words)
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
                complete.options.overlay = Some(json!({}).into());
            } else {
                complete.options.limits.traversal = Some(1);
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
        let used = complete.clone().into_state().consumed_work();
        complete.options.limits.traversal = Some(used);
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
    fn signed(
        seed: u8,
        nonce: u32,
        previous: Vec<String>,
        action: Value,
    ) -> (VerifiedEnvelope, Option<Vec<u8>>) {
        let mut previous = previous;
        previous.sort();
        previous.dedup();
        let signed = sign_header(
            &[seed; 32],
            Header {
                version: 1,
                issuer: identity_from_seed(&[seed; 32]),
                previous,
                nonce: format!("{nonce:032x}"),
                action,
                content: None,
            },
        )
        .unwrap();
        (
            verify_envelope(&signed.canonical_envelope().unwrap()).unwrap(),
            None,
        )
    }

    /// Interleaved chains plus a resolved acceptance, sized so the three
    /// ancestry caches together sit just below the byte cap.
    fn cap_boundary_prepared() -> (PreparedEvaluationInput, String, Vec<String>) {
        let mut input = base();
        let (publication, body) = publication();
        let publication_id = publication.id().to_string();
        input.add_record(&publication, body.as_deref());
        // Interleaved chains plus a resolved acceptance, sized so the
        // three ancestry caches sit just below the byte cap (the same
        // shape as the graph-level cap tests, built here through host
        // records so no signing is needed for the chain records).
        let chain_issuer = identity_from_seed(&[7u8; 32]);
        let host = |input: &mut PreparedEvaluationInput,
                    id: String,
                    issuer: &str,
                    previous: Vec<String>,
                    action: Value| {
            let header = Header {
                version: 1,
                issuer: issuer.to_string(),
                previous,
                nonce: "00".repeat(16),
                action,
                content: None,
            };
            let (record, _) =
                HostVerifiedRecord::extract_with(&id, &header, BodyAvailability::Absent, |_| ());
            input.add_host_verified_record(record);
        };
        let mut ids: Vec<String> = Vec::new();
        for i in 0..3_425usize {
            let id = format!("jve1:{i:064x}");
            let previous = (i >= 2)
                .then(|| format!("jve1:{:064x}", i - 2))
                .into_iter()
                .collect();
            host(
                &mut input,
                id.clone(),
                &chain_issuer,
                previous,
                json!({"kind":"identity.merge"}),
            );
            ids.push(id);
        }
        let transfer_id = format!("jve1:{:064x}", 900_001usize);
        host(
            &mut input,
            transfer_id.clone(),
            &chain_issuer,
            vec![],
            json!({"kind":"identity.transfer","successor":identity_from_seed(&[2u8;32])}),
        );
        let accept_id = format!("jve1:{:064x}", 900_002usize);
        host(
            &mut input,
            accept_id,
            &identity_from_seed(&[2u8; 32]),
            vec![],
            json!({"kind":"identity.accept","transfer":transfer_id}),
        );
        (input, publication_id, ids)
    }

    fn host(id: String, issuer: &str, previous: Vec<String>, action: Value) -> HostVerifiedRecord {
        let header = Header {
            version: 1,
            issuer: issuer.into(),
            previous,
            nonce: "00".repeat(16),
            action,
            content: None,
        };
        HostVerifiedRecord::extract_with(&id, &header, jvc_core::BodyAvailability::Absent, |_| ()).0
    }

    /// A copy of `prepared` with its own node map. A state built from a
    /// plain clone shares the map with `prepared`, so its first append
    /// copies and charges the map; a state built from this copy appends
    /// in place, as a full evaluation of the same records would price it.
    fn unshared(prepared: &PreparedEvaluationInput) -> PreparedEvaluationInput {
        let mut copy = prepared.clone();
        copy.nodes = std::rc::Rc::new(BTreeMap::clone(&prepared.nodes));
        copy
    }

    fn remaining_work(state: &EvaluatedState) -> usize {
        let bytes = state.checkpoint("property").unwrap();
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        value["remaining_work"].as_u64().unwrap() as usize
    }

    fn cap_bytes(state: &EvaluatedState) -> usize {
        state.graph.as_ref().unwrap().ancestry.bytes()
    }

    fn assert_shared_projection(state: &EvaluatedState) {
        let graph = state.graph.as_ref().unwrap();
        assert!(std::rc::Rc::ptr_eq(&state.prepared.nodes, &graph.nodes));
        assert_eq!(state.prepared.nodes, graph.nodes);
    }

    fn assert_matches_full(state: &EvaluatedState, prepared: &PreparedEvaluationInput) {
        let full = prepared.clone().into_state();
        assert_shared_projection(state);
        assert_shared_projection(&full);
        assert_eq!(state.evaluation(), full.evaluation());
        assert_eq!(remaining_work(state), remaining_work(&full));
        assert_eq!(cap_bytes(state), cap_bytes(&full));
        assert_eq!(
            state.checkpoint("property").unwrap(),
            full.checkpoint("property").unwrap()
        );
        assert_state_roundtrips_and_appends(state, prepared, 999);
    }

    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x >> 12;
            x ^= x << 25;
            x ^= x >> 27;
            self.0 = x;
            x.wrapping_mul(0x2545_F491_4F6C_DD1D)
        }
        fn below(&mut self, bound: u64) -> u64 {
            self.next() % bound
        }
    }

    /// Randomized append/fork/sibling sequences over generic histories
    /// (chains, transfers, acceptances, account records, cross-issuer
    /// predecessors, mid-chain appends). After every step the state
    /// must equal a fresh full evaluation of the same records exactly:
    /// evaluation, remaining logical units, and cap bytes.
    #[test]
    fn property_appends_forks_and_siblings_match_full_evaluation() {
        let mut issuers: Vec<String> = [7u8, 8, 9]
            .iter()
            .map(|seed| identity_from_seed(&[*seed; 32]))
            .collect();
        let mut fast_appends = 0usize;
        let mut fast_publication_appends = 0usize;
        let mut fast_rafsi_judgments = 0usize;
        let mut comparisons = 0usize;
        for seed in 0..120u64 {
            let mut rng = Rng(seed ^ 0x9E37_79B9_7F4A_7C15);
            let mut prepared = base();
            let (publication, body) = publication();
            let publication_id = publication.id().to_string();
            prepared.add_record(&publication, body.as_deref());
            let fixture_issuer = identity_from_seed(&[1u8; 32]);
            let word = jvc_core::word_id(&json!({"language":"jbo","spelling":"banli"})).unwrap();
            let rafsi_assignment = format!("jvr1:{:064x}", 10usize);
            let rafsi_pub_id = format!("jve1:{:064x}", 500_000usize);
            prepared.add_host_verified_record(host_missing_body(
                rafsi_pub_id,
                &fixture_issuer,
                vec![],
                json!({"kind":"rafsi.publish","word":word,"assignment":rafsi_assignment,"origin":"native"}),
            ));
            if seed % 2 == 0 {
                prepared.add_host_verified_record(host(
                    format!("jve1:{:064x}", 500_001usize),
                    &fixture_issuer,
                    vec![],
                    json!({"kind":"bridge.set","origin":"https://source.example","source_definition":1,"target":publication_id,"value":"managed"}),
                ));
            }
            if seed % 3 == 1 {
                prepared.add_host_verified_record(host(
                    format!("jve1:{:064x}", 500_002usize),
                    &fixture_issuer,
                    vec![],
                    json!({"kind":"judgment.set","target":format!("jvr1:{:064x}", 99usize),"value":"bless"}),
                ));
            }
            let mut counter = 1_000u64;
            let mut rev_counter = u64::MAX / 2;
            let fresh_id = |counter: &mut u64| {
                *counter += 1;
                format!("jve1:{counter:064x}")
            };
            let mut tips: std::collections::BTreeMap<String, String> =
                std::collections::BTreeMap::new();
            let mut firsts: std::collections::BTreeMap<String, String> =
                std::collections::BTreeMap::new();
            for issuer in &issuers {
                let length = rng.below(9);
                let mut previous: Vec<String> = Vec::new();
                for _ in 0..length {
                    let id = fresh_id(&mut counter);
                    if previous.is_empty() {
                        firsts.insert(issuer.clone(), id.clone());
                    }
                    prepared.add_host_verified_record(host(
                        id.clone(),
                        issuer,
                        previous.clone(),
                        json!({"kind":"identity.merge"}),
                    ));
                    tips.insert(issuer.clone(), id.clone());
                    previous = vec![id];
                }
            }
            if seed % 3 == 0 {
                if let (Some(tip), Some(second)) = (tips.get(&issuers[0]).cloned(), issuers.get(1))
                {
                    let transfer_id = fresh_id(&mut counter);
                    prepared.add_host_verified_record(host(
                        transfer_id.clone(),
                        &issuers[0],
                        vec![tip],
                        json!({"kind":"identity.transfer","successor":second}),
                    ));
                    let accept_id = fresh_id(&mut counter);
                    prepared.add_host_verified_record(host(
                        accept_id.clone(),
                        second,
                        vec![],
                        json!({"kind":"identity.accept","transfer":transfer_id}),
                    ));
                    tips.insert(second.clone(), accept_id);
                }
            }
            // Account records here cover layout and causality only:
            // the base view has no account witnesses, so these claims
            // are not certified and carry evaluation is covered by
            // the restored-state and carry-split tests instead.
            if seed % 4 == 0 {
                if let Some(tip) = tips.get(&issuers[0]).cloned() {
                    let claim_id = fresh_id(&mut counter);
                    prepared.add_host_verified_record(host(
                        claim_id.clone(),
                        &issuers[0],
                        vec![tip],
                        json!({"kind":"account.set","origin":"https://source.example","account":41,"value":"claim","previous":null,"carry":[]}),
                    ));
                    let status_id = fresh_id(&mut counter);
                    prepared.add_host_verified_record(host(
                        status_id.clone(),
                        &issuers[0],
                        vec![claim_id.clone()],
                        json!({"kind":"account.set","origin":"https://source.example","account":41,"value":"claim","previous":claim_id,"carry":[claim_id]}),
                    ));
                    let carried_id = fresh_id(&mut counter);
                    prepared.add_host_verified_record(host(
                        carried_id.clone(),
                        &issuers[0],
                        vec![status_id.clone()],
                        json!({"kind":"account.set","origin":"https://source.example","account":41,"value":"claim","previous":status_id,"carry":[status_id]}),
                    ));
                    assert!(
                        [&claim_id, &status_id, &carried_id]
                            .iter()
                            .all(|id| prepared.nodes[*id].semantic),
                        "account fixture records must be semantically valid"
                    );
                    tips.insert(issuers[0].clone(), carried_id);
                }
            }
            if seed % 5 == 0 {
                // A boundary-crossing pair: one issuer's chain runs
                // through an acceptance to a transfer that is the
                // first record of the next issuer, so its structural
                // closure crosses the block boundary. Judgments on
                // that tip must rebuild.
                let fixture_issuer = identity_from_seed(&[1u8; 32]);
                let mut identities: Vec<String> = (21u8..60)
                    .map(|seed| identity_from_seed(&[seed; 32]))
                    .collect();
                identities.push(fixture_issuer.clone());
                identities.extend(issuers.iter().cloned());
                identities.sort();
                let (cross_issuer, next_issuer) = identities
                    .windows(2)
                    .find(|pair| {
                        pair[0] != fixture_issuer
                            && pair[1] != fixture_issuer
                            && !issuers.contains(&pair[0])
                            && !issuers.contains(&pair[1])
                    })
                    .map(|pair| (pair[0].clone(), pair[1].clone()))
                    .unwrap();
                let cross_root = fresh_id(&mut counter);
                prepared.add_host_verified_record(host(
                    cross_root.clone(),
                    &cross_issuer,
                    vec![],
                    json!({"kind":"identity.merge"}),
                ));
                let cross_transfer = fresh_id(&mut counter);
                let cross_accept = fresh_id(&mut counter);
                prepared.add_host_verified_record(host(
                    cross_accept.clone(),
                    &cross_issuer,
                    vec![cross_root.clone()],
                    json!({"kind":"identity.accept","transfer":cross_transfer}),
                ));
                let cross_tip = fresh_id(&mut counter);
                prepared.add_host_verified_record(host(
                    cross_tip.clone(),
                    &cross_issuer,
                    vec![cross_accept],
                    json!({"kind":"identity.merge"}),
                ));
                prepared.add_host_verified_record(host(
                    cross_transfer,
                    &next_issuer,
                    vec![],
                    json!({"kind":"identity.transfer","successor":cross_issuer}),
                ));
                firsts.insert(cross_issuer.clone(), cross_root);
                tips.insert(cross_issuer.clone(), cross_tip);
                issuers.push(cross_issuer);
            }
            let base_tips = tips.clone();
            let mut extras: std::collections::BTreeMap<String, Vec<String>> =
                std::collections::BTreeMap::new();
            let mut state = prepared.clone().into_state();
            for step in 0..6u64 {
                let kind = rng.below(13);
                if kind == 7 {
                    // Fork: both siblings advance differently; each
                    // must match its own full evaluation.
                    let issuer = &issuers[rng.below(issuers.len() as u64) as usize];
                    let Some(tip) = tips.get(issuer).cloned() else {
                        continue;
                    };
                    let record = host(
                        fresh_id(&mut counter),
                        issuer,
                        vec![tip],
                        json!({"kind":"judgment.set","target":publication_id,"value":"bless"}),
                    );
                    let mut delta = PreparedEvaluationInput::new(prepared.options.clone());
                    delta.add_host_verified_record(record.clone());
                    let fork = state.clone().advance(delta, &[]);
                    let mut fork_prepared = prepared.clone();
                    fork_prepared.add_host_verified_record(record);
                    if fork.statistics().rebuilt {
                        assert_matches_full(&fork, &fork_prepared);
                    } else {
                        let full = fork_prepared.into_state();
                        assert_shared_projection(&fork);
                        assert_eq!(fork.evaluation(), full.evaluation());
                        assert_eq!(cap_bytes(&fork), cap_bytes(&full));
                        assert!(fork.consumed_work() > full.consumed_work());
                        let cp = fork.checkpoint("property").unwrap();
                        let restored =
                            EvaluatedState::restore_host_checkpoint(&cp, "property").unwrap();
                        assert_eq!(restored.evaluation(), full.evaluation());
                    }
                    comparisons += 1;
                    continue;
                }
                let issuer = &issuers[rng.below(issuers.len() as u64) as usize].clone();
                let record = match kind {
                    0..=1 => {
                        let Some(tip) = tips.get(issuer) else {
                            continue;
                        };
                        host(
                            fresh_id(&mut counter),
                            issuer,
                            vec![tip.clone()],
                            json!({"kind":"judgment.set","target":publication_id,"value":if step % 2 == 0 {"bless"} else {"curse"}}),
                        )
                    }
                    2..=3 => {
                        let Some(tip) = tips.get(issuer) else {
                            continue;
                        };
                        host(
                            fresh_id(&mut counter),
                            issuer,
                            vec![tip.clone()],
                            json!({"kind":"judgment.set","target":rafsi_assignment,"value":if step % 2 == 0 {"bless"} else {"curse"}}),
                        )
                    }
                    4..=5 => {
                        let Some(first) = firsts.get(issuer) else {
                            continue;
                        };
                        host(
                            {
                                rev_counter -= 1;
                                format!("jve1:{rev_counter:064x}")
                            },
                            issuer,
                            vec![first.clone()],
                            json!({"kind":"judgment.set","target":publication_id,"value":"bless"}),
                        )
                    }
                    6 => host(
                        {
                            rev_counter -= 1;
                            format!("jve1:{rev_counter:064x}")
                        },
                        issuer,
                        vec![],
                        json!({"kind":"judgment.set","target":publication_id,"value":"bless"}),
                    ),
                    8 => {
                        let other = &issuers[(rng.below(2) + 1) as usize % issuers.len()];
                        let Some(tip) = tips.get(other) else {
                            continue;
                        };
                        host(
                            fresh_id(&mut counter),
                            issuer,
                            vec![tip.clone()],
                            json!({"kind":"judgment.set","target":publication_id,"value":"bless"}),
                        )
                    }
                    9 => {
                        // Append to an earlier appended record, not
                        // the current tip, in either ID order.
                        let Some(list) = extras.get(issuer) else {
                            continue;
                        };
                        if list.is_empty() {
                            continue;
                        }
                        let parent = list[rng.below(list.len() as u64) as usize].clone();
                        let id = if step % 2 == 0 {
                            fresh_id(&mut counter)
                        } else {
                            rev_counter -= 1;
                            format!("jve1:{rev_counter:064x}")
                        };
                        host(
                            id,
                            issuer,
                            vec![parent],
                            json!({"kind":"judgment.set","target":publication_id,"value":"bless"}),
                        )
                    }
                    10 => {
                        // Append to the base chain tip after appended
                        // records exist: the parents leave the extras
                        // out, so this rebuilds.
                        let Some(tip) = base_tips.get(issuer) else {
                            continue;
                        };
                        host(
                            fresh_id(&mut counter),
                            issuer,
                            vec![tip.clone()],
                            json!({"kind":"judgment.set","target":publication_id,"value":"bless"}),
                        )
                    }
                    11 => {
                        // An account record carrying an appended head.
                        let Some(tip) = tips.get(issuer) else {
                            continue;
                        };
                        let carry = extras
                            .get(issuer)
                            .and_then(|list| list.last().cloned())
                            .unwrap_or_else(|| tip.clone());
                        host(
                            fresh_id(&mut counter),
                            issuer,
                            vec![tip.clone()],
                            json!({"kind":"account.set","origin":"https://source.example","account":41,"value":"claim","previous":tip,"carry":[carry]}),
                        )
                    }
                    _ => {
                        let word = jvc_core::word_id(
                            &json!({"language":"jbo","spelling":format!("sel{seed}x{step}")}),
                        )
                        .unwrap();
                        let previous = tips.get(issuer).cloned().into_iter().collect();
                        let id = if step % 2 == 0 {
                            fresh_id(&mut counter)
                        } else {
                            rev_counter -= 1;
                            format!("jve1:{rev_counter:064x}")
                        };
                        host_missing_body(
                            id,
                            issuer,
                            previous,
                            json!({"kind":"definition.publish","word":word,"language":"en","parents":[],"origin":"native"}),
                        )
                    }
                };
                if record.node.kind == "account.set" || record.node.kind == "definition.publish" {
                    assert!(
                        record.node.semantic,
                        "generated {} record is not semantically valid",
                        record.node.kind
                    );
                }
                let is_publication = record.node.kind == "definition.publish";
                let is_rafsi_judgment = record.node.kind == "judgment.set"
                    && record.node.action.view().index("target").as_str()
                        == Some(rafsi_assignment.as_str());
                let record_id = record.node.id.clone();
                extras
                    .entry(issuer.clone())
                    .or_default()
                    .push(record_id.clone());
                tips.insert(issuer.clone(), record_id);
                prepared.add_host_verified_record(record.clone());
                let mut delta = PreparedEvaluationInput::new(prepared.options.clone());
                delta.add_host_verified_record(record);
                state = state.advance(delta, &[]);
                if !state.statistics().rebuilt {
                    fast_appends += 1;
                    if is_publication {
                        fast_publication_appends += 1;
                    }
                    if is_rafsi_judgment {
                        fast_rafsi_judgments += 1;
                    }
                }
                assert_matches_full(&state, &prepared);
                comparisons += 1;
            }
        }
        assert!(comparisons > 400, "only {comparisons} comparisons ran");
        assert!(fast_appends > 50, "only {fast_appends} fast appends ran");
        assert!(
            fast_publication_appends > 10,
            "only {fast_publication_appends} fast publication appends ran"
        );
        assert!(
            fast_rafsi_judgments > 10,
            "only {fast_rafsi_judgments} fast rafsi judgments ran"
        );
    }

    fn projection_fixture() -> (PreparedEvaluationInput, String, String) {
        let mut prepared = base();
        let view = prepared.options.selected_view.clone();
        let (publication, body) = publication();
        let target = publication.id().to_string();
        prepared.add_record(&publication, body.as_deref());
        (prepared, view, target)
    }

    fn projection_judgment(id: u64, previous: Vec<String>, target: &str) -> HostVerifiedRecord {
        host(
            format!("jve1:{id:064x}"),
            &identity_from_seed(&[1u8; 32]),
            previous,
            json!({"kind":"judgment.set","target":target,"value":"bless"}),
        )
    }

    #[test]
    fn arena_overflow_forces_rebuild_without_poisoning_a_fork() {
        let (prepared, view, target) = projection_fixture();
        let parent = prepared.into_state();
        let parent_checkpoint = parent.checkpoint("projection").unwrap();
        let record = projection_judgment(800_000, vec![view, target], "damaged-target");
        let mut delta = PreparedEvaluationInput::new(parent.prepared.options.clone());
        delta.arena.borrow_mut().set_test_limit(8);
        delta.add_host_verified_record(record);
        assert_eq!(
            delta.arena_error().unwrap().code,
            "resource_unavailable",
            "the fixture did not reach arena overflow"
        );

        let child = parent.clone().advance(delta, &[]);
        assert!(child.statistics().rebuilt);
        assert_eq!(
            child.statistics().reason.as_deref(),
            Some("resource_unavailable")
        );
        assert!(!child.evaluation().available);
        assert!(child.evaluation().reasons.contains("resource_unavailable"));
        assert!(parent.evaluation().available);
        assert!(parent.prepared.arena_error().is_none());
        assert_eq!(parent.checkpoint("projection").unwrap(), parent_checkpoint);
    }

    #[test]
    fn review_shared_arena_overflow_preserves_parent_checkpoint() {
        let (prepared, view, target) = projection_fixture();
        let intact_input = prepared.clone();
        let mut delta = prepared.clone();
        let parent = prepared.into_state();
        let before = parent.checkpoint("projection").unwrap();
        let limit = parent.prepared.record_arena_bytes();
        delta.arena.borrow_mut().set_test_limit(limit);
        delta.add_host_verified_record(projection_judgment(
            800_000,
            vec![view, target],
            &"x".repeat(limit + 1),
        ));
        assert!(delta.arena_error().is_some());
        let child = parent.clone().advance(delta, &[]);
        assert!(!child.evaluation().available);
        assert!(child.evaluation().reasons.contains("resource_unavailable"));
        assert!(child.checkpoint("projection").is_err());
        assert!(parent.evaluation().available);
        assert_eq!(parent.checkpoint("projection").unwrap(), before);
        assert_eq!(&intact_input.evaluate(), parent.evaluation());
    }

    #[test]
    fn review_shared_arena_overflow_preserves_parent_rebuild() {
        let (prepared, view, target) = projection_fixture();
        let mut delta = prepared.clone();
        let parent = prepared.into_state();
        let mut clean = PreparedEvaluationInput::new(parent.prepared.options.clone());
        clean.options.limits.traversal = Some(
            parent
                .prepared
                .options
                .limits
                .traversal_budget(parent.event_count(), parent.predecessor_edges)
                + 1,
        );
        let expected = parent.clone().advance(clean.clone(), &[]);
        assert!(expected.evaluation().available);
        let expected_checkpoint = expected.checkpoint("projection").unwrap();
        let limit = parent.prepared.record_arena_bytes();
        delta.arena.borrow_mut().set_test_limit(limit);
        delta.add_host_verified_record(projection_judgment(
            800_000,
            vec![view, target],
            &"x".repeat(limit + 1),
        ));
        assert!(delta.arena_error().is_some());
        drop(delta);
        let rebuilt = parent.advance(clean, &[]);
        assert!(rebuilt.evaluation().available);
        assert_eq!(rebuilt.evaluation(), expected.evaluation());
        assert_eq!(
            rebuilt.checkpoint("projection").unwrap(),
            expected_checkpoint
        );
    }

    #[test]
    fn retained_trust_scopes_share_one_arena() {
        let mut prepared = base();
        for (seed, nonce) in [(2, 20), (3, 21)] {
            let (trust, body) = event(
                seed,
                nonce,
                json!({"kind":"trust.set","subject":identity_from_seed(&[seed + 10;32]),"scope":{"kind":"*","word":"*","language":"*"},"value":"heed"}),
                None,
            );
            prepared.add_record(&trust, body.as_deref());
        }
        let state = prepared.into_state();
        assert_eq!(state.evaluation().trust.len(), 2);
        assert_eq!(
            state.evaluation().trust[0].scope.arena_id(),
            state.evaluation().trust[1].scope.arena_id()
        );
    }

    #[test]
    fn unique_appends_reuse_projection_through_checkpoint_restore() {
        let (prepared, view, target) = projection_fixture();
        let options = prepared.options.clone();
        let first = projection_judgment(800_001, vec![view.clone(), target.clone()], &target);
        let second = projection_judgment(
            800_002,
            vec![view, target.clone(), first.id().to_string()],
            &target,
        );
        let state = prepared.into_state();
        let original = std::rc::Rc::as_ptr(&state.prepared.nodes);
        assert_shared_projection(&state);
        assert_eq!(std::rc::Rc::strong_count(&state.prepared.nodes), 2);

        let mut delta = PreparedEvaluationInput::new(options.clone());
        delta.add_host_verified_record(first.clone());
        let direct = state.advance(delta, &[]);
        assert!(!direct.statistics().rebuilt);
        assert_eq!(std::rc::Rc::as_ptr(&direct.prepared.nodes), original);
        assert_shared_projection(&direct);
        assert_eq!(std::rc::Rc::strong_count(&direct.prepared.nodes), 2);

        let restored = EvaluatedState::restore_host_checkpoint(
            &direct.checkpoint("projection").unwrap(),
            "projection",
        )
        .unwrap();
        let append_second = |state: EvaluatedState| {
            let mut delta = PreparedEvaluationInput::new(options.clone());
            delta.add_host_verified_record(second.clone());
            state.advance(delta, &[])
        };
        let direct = append_second(direct);
        let restored = append_second(restored);
        assert!(!direct.statistics().rebuilt);
        assert!(!restored.statistics().rebuilt);
        assert_eq!(std::rc::Rc::as_ptr(&direct.prepared.nodes), original);
        assert_shared_projection(&direct);
        assert_shared_projection(&restored);
        assert_eq!(direct.evaluation(), restored.evaluation());
        assert_eq!(
            direct.checkpoint("projection").unwrap(),
            restored.checkpoint("projection").unwrap()
        );

        let (mut full, _, _) = projection_fixture();
        full.add_host_verified_record(first);
        full.add_host_verified_record(second);
        let full = full.into_state();
        assert_eq!(
            direct.checkpoint("projection").unwrap(),
            full.checkpoint("projection").unwrap()
        );
    }

    #[test]
    fn fork_shares_projection_until_its_first_append() {
        let (prepared, view, target) = projection_fixture();
        let options = prepared.options.clone();
        let parent = prepared.into_state();
        let parent_checkpoint = parent.checkpoint("projection").unwrap();
        let original = std::rc::Rc::as_ptr(&parent.prepared.nodes);
        let fork = parent.clone();
        assert_eq!(std::rc::Rc::as_ptr(&fork.prepared.nodes), original);
        assert_eq!(std::rc::Rc::strong_count(&parent.prepared.nodes), 4);

        let record = projection_judgment(800_003, vec![view, target.clone()], &target);
        let mut delta = PreparedEvaluationInput::new(options);
        delta.add_host_verified_record(record.clone());
        let child = fork.advance(delta, &[]);
        assert!(!child.statistics().rebuilt);
        assert_ne!(std::rc::Rc::as_ptr(&child.prepared.nodes), original);
        assert_eq!(std::rc::Rc::as_ptr(&parent.prepared.nodes), original);
        assert_shared_projection(&parent);
        assert_shared_projection(&child);
        assert!(!parent.prepared.nodes.contains_key(record.id()));
        assert!(child.prepared.nodes.contains_key(record.id()));
        assert_eq!(parent.checkpoint("projection").unwrap(), parent_checkpoint);

        let (mut full, _, _) = projection_fixture();
        full.add_host_verified_record(record);
        let full_state = full.into_state();
        assert_eq!(child.evaluation(), full_state.evaluation());
        assert!(child.consumed_work() > full_state.consumed_work());
        let child_cp = child.checkpoint("projection").unwrap();
        let restored_child =
            EvaluatedState::restore_host_checkpoint(&child_cp, "projection").unwrap();
        assert_eq!(restored_child.evaluation(), full_state.evaluation());
    }

    #[test]
    fn overlay_change_on_a_refused_state_rebuilds_instead_of_applying_the_overlay() {
        let prepared = base();
        let mut graph = Graph::new(prepared.nodes.clone(), &Limits::default());
        let issuer = identity_from_seed(&[1; 32]);
        graph
            .lifecycle
            .suspended
            .insert(issuer.clone(), BTreeSet::new());
        let mut state = prepared.into_state();
        state.prepared.options.limits.traversal = Some(0);
        state.evaluation = evaluate_graph(&state.prepared.options, &graph);
        state.graph = Some(graph);
        assert!(state.evaluation.reasons.contains("resource_unavailable"));
        assert!(state.evaluation.publications.is_empty());
        // The refusal keeps nothing the evaluation computed.
        assert!(state.evaluation.lifecycle.suspended.is_empty());
        let suspended = json!({
            "version":2,
            "base_view":state.prepared.options.selected_view,
            "public_shun_issuer":issuer,
            "root_changes":[],
            "trust":[],
            "blocked":[],
            "work":null
        });
        for overlay in [json!({"invalid":true}), suspended] {
            let actual = state.with_overlay_and_rebuild(Some(overlay.clone()), |next| {
                next.evaluation =
                    evaluate_graph(&next.prepared.options, next.graph.as_ref().unwrap());
            });
            let mut options = state.prepared.options.clone();
            options.overlay = Some(overlay.into());
            let expected = evaluate_graph(&options, state.graph.as_ref().unwrap());
            assert_eq!(actual.evaluation(), &expected);
            assert!(!actual.evaluation.reasons.contains("invalid_overlay"));
            assert!(
                !actual
                    .evaluation
                    .reasons
                    .contains("public_shun_issuer_unavailable")
            );
        }
    }

    #[test]
    fn configuration_only_fork_rebuild_shares_projection() {
        let (prepared, _, _) = projection_fixture();
        let options = prepared.options.clone();
        let parent = prepared.into_state();
        let parent_checkpoint = parent.checkpoint("projection").unwrap();
        let original = std::rc::Rc::as_ptr(&parent.prepared.nodes);
        let overlay = json!({
            "version":2,
            "trust":[],
            "blocked":[],
            "root_changes":[],
            "public_shun_issuer":null
        });
        let mut delta = PreparedEvaluationInput::new(options);
        delta.options.overlay = Some(overlay.clone().into());
        let child = parent.clone().advance(delta, &[]);
        assert!(child.statistics().rebuilt);
        assert_eq!(
            child.statistics().reason.as_deref(),
            Some("configuration_changed")
        );
        assert!(std::rc::Rc::ptr_eq(
            &parent.prepared.nodes,
            &child.prepared.nodes
        ));
        assert_eq!(std::rc::Rc::as_ptr(&child.prepared.nodes), original);
        assert_shared_projection(&parent);
        assert_shared_projection(&child);
        assert_eq!(parent.checkpoint("projection").unwrap(), parent_checkpoint);

        let (mut full, _, _) = projection_fixture();
        full.options.overlay = Some(overlay.into());
        assert_matches_full(&child, &full);
    }

    #[test]
    fn unique_removal_rebuild_reuses_projection() {
        let (prepared, _, target) = projection_fixture();
        let options = prepared.options.clone();
        let state = prepared.into_state();
        let original = std::rc::Rc::as_ptr(&state.prepared.nodes);
        let delta = PreparedEvaluationInput::new(options);
        let state = state.advance(delta, std::slice::from_ref(&target));
        assert!(state.statistics().rebuilt);
        assert_eq!(state.statistics().reason.as_deref(), Some("record_removed"));
        assert_eq!(std::rc::Rc::as_ptr(&state.prepared.nodes), original);
        assert!(!state.prepared.nodes.contains_key(&target));
        assert_shared_projection(&state);
        assert_matches_full(&state, &base());
    }

    #[test]
    fn fork_removal_leaves_parent_projection_unchanged() {
        let (prepared, _, target) = projection_fixture();
        let options = prepared.options.clone();
        let parent = prepared.into_state();
        let parent_checkpoint = parent.checkpoint("projection").unwrap();
        let original = std::rc::Rc::as_ptr(&parent.prepared.nodes);
        let delta = PreparedEvaluationInput::new(options);
        let child = parent.clone().advance(delta, std::slice::from_ref(&target));
        assert!(child.statistics().rebuilt);
        assert_eq!(child.statistics().reason.as_deref(), Some("record_removed"));
        assert_ne!(std::rc::Rc::as_ptr(&child.prepared.nodes), original);
        assert!(parent.prepared.nodes.contains_key(&target));
        assert!(!child.prepared.nodes.contains_key(&target));
        assert_shared_projection(&parent);
        assert_shared_projection(&child);
        assert_eq!(parent.checkpoint("projection").unwrap(), parent_checkpoint);
        assert_matches_full(&child, &base());
    }

    #[test]
    fn fork_replacement_leaves_parent_projection_unchanged() {
        let (prepared, _, target) = projection_fixture();
        let options = prepared.options.clone();
        let parent = prepared.into_state();
        let parent_checkpoint = parent.checkpoint("projection").unwrap();
        let original = std::rc::Rc::as_ptr(&parent.prepared.nodes);
        let replacement = host(
            target.clone(),
            &identity_from_seed(&[1u8; 32]),
            vec![],
            json!({"kind":"identity.merge"}),
        );
        let mut delta = PreparedEvaluationInput::new(options);
        delta.add_host_verified_record(replacement.clone());
        let child = parent.clone().advance(delta, &[]);
        assert!(child.statistics().rebuilt);
        assert_eq!(
            child.statistics().reason.as_deref(),
            Some("record_replaced")
        );
        assert_ne!(std::rc::Rc::as_ptr(&child.prepared.nodes), original);
        assert_ne!(
            parent.prepared.nodes[&target],
            child.prepared.nodes[&target]
        );
        assert_shared_projection(&parent);
        assert_shared_projection(&child);
        assert_eq!(parent.checkpoint("projection").unwrap(), parent_checkpoint);

        let (mut full, _, _) = projection_fixture();
        std::rc::Rc::make_mut(&mut full.nodes).insert(target, replacement.node);
        assert_matches_full(&child, &full);
    }

    /// Boundary-crossing probe: the structural closure of an issuer's tip
    /// reaches through an acceptance to a transfer that is the first
    /// record of the next issuer, so one stored range crosses the
    /// block boundary. A judgment on the tip would land between them
    /// and split that range. It must rebuild, at the exact budget and
    /// one below.
    #[test]
    fn boundary_crossing_append_rebuilds_and_matches_full() {
        let mut prepared = base();
        let (publication, body) = publication();
        let publication_id = publication.id().to_string();
        prepared.add_record(&publication, body.as_deref());
        // The two issuers must be adjacent in layout order, with no
        // other issuer of this fixture between them.
        let fixture_issuer = identity_from_seed(&[1u8; 32]);
        let mut identities: Vec<String> = (2u8..40)
            .map(|seed| identity_from_seed(&[seed; 32]))
            .collect();
        identities.push(fixture_issuer.clone());
        identities.sort();
        let (issuer, next_issuer) = identities
            .windows(2)
            .find(|pair| pair[0] != fixture_issuer && pair[1] != fixture_issuer)
            .map(|pair| (pair[0].clone(), pair[1].clone()))
            .unwrap();
        let root_id = format!("jve1:{:064x}", 10usize);
        let accept_id = format!("jve1:{:064x}", 11usize);
        let tip_id = format!("jve1:{:064x}", 12usize);
        let transfer_id = format!("jve1:{:064x}", 20usize);
        prepared.add_host_verified_record(host(
            root_id.clone(),
            &issuer,
            vec![],
            json!({"kind":"identity.merge"}),
        ));
        prepared.add_host_verified_record(host(
            accept_id.clone(),
            &issuer,
            vec![root_id],
            json!({"kind":"identity.accept","transfer":transfer_id}),
        ));
        prepared.add_host_verified_record(host(
            tip_id.clone(),
            &issuer,
            vec![accept_id.clone()],
            json!({"kind":"identity.merge"}),
        ));
        // The transfer is the first record of the next issuer. The
        // acceptance is not the successor's only root, so no lifecycle
        // link forms and the fast path stays open on that front.
        prepared.add_host_verified_record(host(
            transfer_id.clone(),
            &next_issuer,
            vec![],
            json!({"kind":"identity.transfer","successor":issuer}),
        ));
        let judgment = host(
            format!("jve1:{:064x}", 30usize),
            &issuer,
            vec![tip_id],
            json!({"kind":"judgment.set","target":publication_id,"value":"bless"}),
        );
        let mut full = prepared.clone();
        full.add_host_verified_record(judgment.clone());
        assert_tight_budgets_match(&prepared, &judgment, &full);
        let mut delta = PreparedEvaluationInput::new(prepared.options.clone());
        delta.add_host_verified_record(judgment.clone());
        let state = prepared.clone().into_state().advance(delta, &[]);
        assert!(state.statistics().rebuilt);
        assert_eq!(state.statistics().reason.as_deref(), Some("layout_split"));
    }

    /// Appended-extra probe: three judgments on a two-record chain.
    /// The first covers the chain and appends. The second has the
    /// same parent but leaves out the first appended record, so it
    /// rebuilds. The third builds on the first appended record, whose
    /// closure still leaves out the second, so it rebuilds too. Every
    /// step matches a fresh full evaluation exactly.
    #[test]
    fn appended_extra_left_out_of_parents_rebuilds() {
        let mut prepared = base();
        let (publication, body) = publication();
        let publication_id = publication.id().to_string();
        prepared.add_record(&publication, body.as_deref());
        let issuer = identity_from_seed(&[7u8; 32]);
        let first_chain = format!("jve1:{:064x}", 1000usize);
        let tip = format!("jve1:{:064x}", 1001usize);
        prepared.add_host_verified_record(host(
            first_chain.clone(),
            &issuer,
            vec![],
            json!({"kind":"identity.merge"}),
        ));
        prepared.add_host_verified_record(host(
            tip.clone(),
            &issuer,
            vec![first_chain],
            json!({"kind":"identity.merge"}),
        ));
        let append = |prepared: &PreparedEvaluationInput,
                      state: EvaluatedState,
                      id: usize,
                      previous: Vec<String>| {
            let record = host(
                format!("jve1:{id:064x}"),
                &issuer,
                previous,
                json!({"kind":"judgment.set","target":publication_id,"value":"bless"}),
            );
            let mut full = prepared.clone();
            full.add_host_verified_record(record.clone());
            let mut delta = PreparedEvaluationInput::new(prepared.options.clone());
            delta.add_host_verified_record(record);
            let state = state.advance(delta, &[]);
            assert_matches_full(&state, &full);
            (full, state)
        };
        let state = unshared(&prepared).into_state();
        let (prepared, state) = append(&prepared, state, 2000, vec![tip.clone()]);
        assert!(!state.statistics().rebuilt);
        let (prepared, state) = append(&prepared, state, 1500, vec![tip.clone()]);
        assert!(state.statistics().rebuilt);
        let (prepared, state) = append(
            &prepared,
            state,
            2500,
            vec![format!("jve1:{:064x}", 2000usize)],
        );
        assert!(state.statistics().rebuilt);
        let _ = prepared;
    }

    /// Two sibling forks appending on the same chain tip keep
    /// independent layouts: each matches its own full evaluation in
    /// evaluation, remaining units, and cap bytes.
    #[test]
    fn sibling_order_appends_match_their_full_evaluations() {
        let mut prepared = base();
        let (publication, body) = publication();
        let publication_id = publication.id().to_string();
        prepared.add_record(&publication, body.as_deref());
        let issuer = identity_from_seed(&[7u8; 32]);
        let mut previous: Vec<String> = Vec::new();
        for i in 0..30usize {
            let id = format!("jve1:{:064x}", 5_000 + i);
            prepared.add_host_verified_record(host(
                id.clone(),
                &issuer,
                previous.clone(),
                json!({"kind":"identity.merge"}),
            ));
            previous = vec![id];
        }
        let tip = previous[0].clone();
        let state = prepared.clone().into_state();
        for value in ["bless", "curse"] {
            let record = host(
                format!("jve1:{:064x}", if value == "bless" { 6_001 } else { 6_002 }),
                &issuer,
                vec![tip.clone()],
                json!({"kind":"judgment.set","target":publication_id,"value":value}),
            );
            let mut delta = PreparedEvaluationInput::new(prepared.options.clone());
            delta.add_host_verified_record(record.clone());
            let fork = state.clone().advance(delta, &[]);
            assert!(!fork.statistics().rebuilt);
            let mut full = prepared.clone();
            full.add_host_verified_record(record);
            let full_state = full.into_state();
            assert_shared_projection(&fork);
            assert_eq!(fork.evaluation(), full_state.evaluation());
            assert_eq!(cap_bytes(&fork), cap_bytes(&full_state));
            assert!(fork.consumed_work() > full_state.consumed_work());
            let cp = fork.checkpoint("property").unwrap();
            let restored = EvaluatedState::restore_host_checkpoint(&cp, "property").unwrap();
            assert_eq!(restored.evaluation(), full_state.evaluation());
        }
    }

    /// Advance `record` onto `base_prepared` at the exact full cost
    /// and at one unit below it. Both must match a fresh full
    /// evaluation of the same records, and availability must flip at
    /// the boundary.
    fn assert_tight_budgets_match(
        base_prepared: &PreparedEvaluationInput,
        record: &HostVerifiedRecord,
        full_prepared: &PreparedEvaluationInput,
    ) {
        let consumed = full_prepared.clone().into_state().consumed_work();
        for budget in [consumed, consumed - 1] {
            let mut base_p = base_prepared.clone();
            base_p.options.limits.traversal = Some(budget);
            let mut full_p = full_prepared.clone();
            full_p.options.limits.traversal = Some(budget);
            assert!(base_p.clone().into_state().evaluation().available);
            let mut delta = PreparedEvaluationInput::new(base_p.options.clone());
            delta.add_host_verified_record(record.clone());
            let state = base_p.into_state().advance(delta, &[]);
            assert_matches_full(&state, &full_p);
            if budget == consumed {
                assert!(state.evaluation().available);
            } else {
                assert!(!state.evaluation().available);
                // A budget rebuild reports no incremental records.
                assert_eq!(state.statistics().incremental_records, 0);
            }
        }
    }

    /// A judgment-only batch that rebuilds on layout grounds must
    /// never report a partial patch. When a later judgment in the
    /// batch would suspend its issuer (a missing parent), the rebuilt
    /// evaluation differs outside the patchable keys, so the report
    /// is absent and the consumer refreshes fully. Both ID orders.
    #[test]
    fn layout_rebuild_batch_with_a_suspension_reports_no_patch() {
        for swap in [false, true] {
            let mut prepared = base();
            let (publication, body) = publication();
            let publication_id = publication.id().to_string();
            prepared.add_record(&publication, body.as_deref());
            let a = identity_from_seed(&[7u8; 32]);
            let b = identity_from_seed(&[8u8; 32]);
            let a0 = format!("jve1:{:064x}", 500usize);
            let a1 = format!("jve1:{:064x}", 501usize);
            prepared.add_host_verified_record(host(
                a0.clone(),
                &a,
                vec![],
                json!({"kind":"identity.merge"}),
            ));
            prepared.add_host_verified_record(host(
                a1,
                &a,
                vec![a0],
                json!({"kind":"identity.merge"}),
            ));
            prepared.add_host_verified_record(host(
                format!("jve1:{:064x}", 600usize),
                &b,
                vec![],
                json!({"kind":"judgment.set","target":publication_id,"value":"bless"}),
            ));
            let state = prepared.clone().into_state();
            let (low, high) = if swap {
                (2usize, 1usize)
            } else {
                (1usize, 2usize)
            };
            let j1 = host(
                format!("jve1:{:064x}", low),
                &a,
                vec![],
                json!({"kind":"judgment.set","target":publication_id,"value":"curse"}),
            );
            let j2 = host(
                format!("jve1:f{:063x}", high),
                &b,
                vec![format!("jve1:e{:063x}", 3usize)],
                json!({"kind":"judgment.set","target":publication_id,"value":"curse"}),
            );
            let mut delta = PreparedEvaluationInput::new(prepared.options.clone());
            delta.add_host_verified_record(j1.clone());
            delta.add_host_verified_record(j2.clone());
            let advanced = state.clone().advance(delta, &[]);
            let mut full = prepared.clone();
            full.add_host_verified_record(j1);
            full.add_host_verified_record(j2);
            let full = full.into_state();
            assert_eq!(advanced.evaluation(), full.evaluation());
            assert!(advanced.statistics().rebuilt);
            assert!(
                advanced.judgment_changes().is_none(),
                "swap={swap}: a partial patch would omit the suspension"
            );
        }
    }

    /// Registers are keyed by actor, not issuer. In a batch whose
    /// first judgment refuses on layout grounds and whose second is
    /// by a successor key, the complete patch names the original
    /// issuer's register key, read from the rebuilt evaluation.
    #[test]
    fn layout_rebuild_patch_names_the_actor_register_key() {
        let mut prepared = base();
        let (publication, body) = publication();
        let publication_id = publication.id().to_string();
        prepared.add_record(&publication, body.as_deref());
        let a = identity_from_seed(&[7u8; 32]);
        let b = identity_from_seed(&[8u8; 32]);
        let c = identity_from_seed(&[9u8; 32]);
        let a0 = format!("jve1:{:064x}", 500usize);
        prepared.add_host_verified_record(host(
            a0.clone(),
            &a,
            vec![],
            json!({"kind":"identity.merge"}),
        ));
        prepared.add_host_verified_record(host(
            format!("jve1:{:064x}", 501usize),
            &a,
            vec![a0],
            json!({"kind":"identity.merge"}),
        ));
        let b_root = format!("jve1:{:064x}", 600usize);
        let transfer_id = format!("jve1:{:064x}", 601usize);
        prepared.add_host_verified_record(host(
            b_root.clone(),
            &b,
            vec![],
            json!({"kind":"identity.merge"}),
        ));
        prepared.add_host_verified_record(host(
            transfer_id.clone(),
            &b,
            vec![b_root],
            json!({"kind":"identity.transfer","successor":c}),
        ));
        let accept_id = format!("jve1:{:064x}", 602usize);
        prepared.add_host_verified_record(host(
            accept_id.clone(),
            &c,
            vec![],
            json!({"kind":"identity.accept","transfer":transfer_id}),
        ));
        prepared.add_host_verified_record(host(
            format!("jve1:{:064x}", 603usize),
            &c,
            vec![accept_id],
            json!({"kind":"judgment.set","target":publication_id,"value":"bless"}),
        ));
        let state = prepared.clone().into_state();
        let actor_key = format!("{b}|judgment|{publication_id}");
        assert!(state.evaluation().registers.contains_key(&actor_key));
        // The first judgment (lowest ID) refuses on layout grounds;
        // the second is by the successor key.
        let j1 = host(
            format!("jve1:{:064x}", 1usize),
            &a,
            vec![],
            json!({"kind":"judgment.set","target":publication_id,"value":"curse"}),
        );
        let j2 = host(
            format!("jve1:{:064x}", 604usize),
            &c,
            vec![format!("jve1:{:064x}", 603usize)],
            json!({"kind":"judgment.set","target":publication_id,"value":"curse"}),
        );
        let mut full = prepared.clone();
        full.add_host_verified_record(j1.clone());
        full.add_host_verified_record(j2.clone());
        let mut delta = PreparedEvaluationInput::new(prepared.options.clone());
        delta.add_host_verified_record(j1);
        delta.add_host_verified_record(j2.clone());
        let advanced = state.clone().advance(delta, &[]);
        assert!(advanced.statistics().rebuilt);
        assert_eq!(
            advanced.statistics().reason.as_deref(),
            Some("layout_split")
        );
        assert_matches_full(&advanced, &full);
        let changes = advanced
            .judgment_changes()
            .expect("a complete patch is reported");
        assert!(changes.registers.contains(&actor_key));
        assert!(changes.receipts.contains(j2.node.id.as_str()));
    }

    /// A restored state counts ancestry bytes exactly as a full
    /// evaluation does. The fixture carries a certified account
    /// claim, so account evaluation really runs the carry unions;
    /// they build temporary sets and add no ancestry bytes.
    #[test]
    fn restored_state_keeps_full_ancestry_bytes() {
        let (view, view_body) = event(
            1,
            77,
            json!({"kind":"view.publish","parents":[]}),
            Some(
                json!({"name":"fixture","description":[],"roots":[{"identity":identity_from_seed(&[1;32]),"q":{"numerator":1,"denominator":1}}],"rafsi_threshold":{"numerator":1,"denominator":1},"H":{"numerator":3,"denominator":1},"alpha":{"numerator":1,"denominator":2},"excluded":[],"calculation":"simple-routes-bounds-v1","work":1000,"import_sets":[],"account_witnesses":[identity_from_seed(&[10;32]),identity_from_seed(&[11;32])],"account_authority":true,"notes":[]}),
            ),
        );
        let mut prepared = PreparedEvaluationInput::new(EvaluationOptions {
            selected_view: view.id().into(),
            import_selections: BTreeMap::new(),
            overlay: None,
            limits: Limits::default(),
        });
        prepared.add_record(&view, view_body.as_deref());
        let (publication, body) = publication();
        let publication_id = publication.id().to_string();
        prepared.add_record(&publication, body.as_deref());
        // A root from another issuer, carried by the claim below.
        let (carried, _) = event(8, 1, json!({"kind":"identity.merge"}), None);
        let carried_id = carried.id().to_string();
        prepared.add_record(&carried, None);
        // A certified replacement claim with a non-empty carry: the
        // first claim is initial (empty carry), the second carries
        // the first.
        let first_claim_id = format!("jve1:{:064x}", 700_010usize);
        let claim_id = format!("jve1:{:064x}", 700_020usize);
        prepared.add_host_verified_record(host(
            first_claim_id.clone(),
            &identity_from_seed(&[1u8; 32]),
            vec![],
            json!({"kind":"account.set","origin":"https://source.example","account":41,"value":"claim","previous":null,"carry":[]}),
        ));
        prepared.add_host_verified_record(host(
            claim_id.clone(),
            &identity_from_seed(&[1u8; 32]),
            vec![first_claim_id.clone()],
            json!({"kind":"account.set","origin":"https://source.example","account":41,"value":"claim","previous":first_claim_id,"carry":[first_claim_id]}),
        ));
        for (seed, nonce) in [(10u8, 1u8), (11, 1)] {
            let (observation, observation_body) = event(
                seed,
                nonce,
                json!({"kind":"account.observe","origin":"https://source.example","account":41,"claim":claim_id,"result":"present"}),
                Some(
                    json!({"origin":"https://source.example","account":41,"username":"author","field_hash":"sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","markers":[claim_id],"method":"lensisku-public-profile-v1","observed_at":"2026-10-11T00:00:00Z"}),
                ),
            );
            prepared.add_record(&observation, observation_body.as_deref());
        }
        assert!(
            prepared
                .nodes
                .values()
                .filter(|node| node.kind == "account.set")
                .all(|node| node.semantic),
            "restored-state account records must be semantically valid"
        );
        let base_state = prepared.clone().into_state();
        assert!(base_state.evaluation().available);
        // The carry unions run during evaluation and build only
        // temporary sets, so the evaluated byte total equals the
        // graph-construction total: the graph that a restored state
        // builds measures the same total again.
        let construction_bytes =
            graph::Graph::new(prepared.nodes.clone(), &prepared.options.limits)
                .ancestry
                .bytes();
        assert_eq!(cap_bytes(&base_state), construction_bytes);
        let saved = base_state.checkpoint("host-checked").unwrap();
        let saved_value: Value = serde_json::from_slice(&saved).unwrap();
        assert_eq!(
            saved_value["ancestry_bytes"].as_u64().unwrap() as usize,
            cap_bytes(&base_state)
        );
        let restored = EvaluatedState::restore_host_checkpoint(&saved, "host-checked").unwrap();
        let judgment = host(
            format!("jve1:{:064x}", 700_040usize),
            &identity_from_seed(&[8u8; 32]),
            vec![carried_id],
            json!({"kind":"judgment.set","target":publication_id,"value":"bless"}),
        );
        let mut delta = PreparedEvaluationInput::new(prepared.options.clone());
        delta.add_host_verified_record(judgment.clone());
        let advanced = restored.advance(delta.clone(), &[]);
        let direct = base_state.clone().advance(delta, &[]);
        let mut full = prepared.clone();
        full.add_host_verified_record(judgment);
        let full_state = full.into_state();
        assert_eq!(advanced.evaluation(), full_state.evaluation());
        assert_eq!(cap_bytes(&direct), cap_bytes(&full_state), "direct");
        assert_eq!(cap_bytes(&advanced), cap_bytes(&full_state), "restored");
    }

    fn witnessed_view() -> PreparedEvaluationInput {
        let (view, view_body) = event(
            1,
            77,
            json!({"kind":"view.publish","parents":[]}),
            Some(
                json!({"name":"fixture","description":[],"roots":[{"identity":identity_from_seed(&[1;32]),"q":{"numerator":1,"denominator":1}}],"rafsi_threshold":{"numerator":1,"denominator":1},"H":{"numerator":3,"denominator":1},"alpha":{"numerator":1,"denominator":2},"excluded":[],"calculation":"simple-routes-bounds-v1","work":1000,"import_sets":[],"account_witnesses":[identity_from_seed(&[10;32]),identity_from_seed(&[11;32])],"account_authority":true,"notes":[]}),
            ),
        );
        let mut prepared = PreparedEvaluationInput::new(EvaluationOptions {
            selected_view: view.id().into(),
            import_selections: BTreeMap::new(),
            overlay: None,
            limits: Limits::default(),
        });
        prepared.add_record(&view, view_body.as_deref());
        prepared
    }

    fn observe(prepared: &mut PreparedEvaluationInput, seed: u8, nonce: u8, claim_id: &str) {
        let (observation, observation_body) = event(
            seed,
            nonce,
            json!({"kind":"account.observe","origin":"https://source.example","account":41,"claim":claim_id,"result":"present"}),
            Some(
                json!({"origin":"https://source.example","account":41,"username":"author","field_hash":"sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","markers":[claim_id],"method":"lensisku-public-profile-v1","observed_at":"2026-10-11T00:00:00Z"}),
            ),
        );
        prepared.add_record(&observation, observation_body.as_deref());
    }

    /// Certified claims whose issuer history is incomplete enter the
    /// missing-history lookup once per claim. The per-issuer index
    /// must keep the audited work within a constant times the
    /// charged units at two sizes.
    #[test]
    fn account_claims_with_missing_history_scale_linearly() {
        for claims in [120usize, 240] {
            let mut prepared = witnessed_view();
            let issuer = identity_from_seed(&[1u8; 32]);
            let mut previous = format!("jve1:{:064x}", 900_000usize);
            let mut action_previous: Option<String> = None;
            for i in 0..claims {
                let claim_id = format!("jve1:{:064x}", 900_100 + i);
                prepared.add_host_verified_record(host(
                    claim_id.clone(),
                    &issuer,
                    vec![previous],
                    json!({"kind":"account.set","origin":"https://source.example","account":41,"value":"claim","previous":action_previous,"carry":[]}),
                ));
                observe(&mut prepared, 10, (i % 256) as u8, &claim_id);
                observe(&mut prepared, 11, (i % 256) as u8, &claim_id);
                previous = claim_id.clone();
                action_previous = Some(claim_id);
            }
            graph::reset_audit_work();
            let state = prepared.into_state();
            assert!(state.evaluation().available);
            let used = state.consumed_work();
            let work = graph::audit_work();
            assert!(
                work <= 16 * used,
                "{work} audited work for {used} charged units at {claims} claims"
            );
        }
    }

    /// One imported publication and a chain of `import.status`
    /// records naming one claim: authorization must read the
    /// account index, not walk a growing closure per record.
    #[test]
    fn import_status_authorization_scales_linearly() {
        let mut prepared = witnessed_view();
        // The action word must match the body fixture's word
        // ("banli"), or the body does not bind and no account is
        // attached to the publication.
        let word = jvc_core::word_id(&json!({"language":"jbo","spelling":"banli"})).unwrap();
        let mut body: Value = serde_json::from_str(include_str!(
            "../../jvc-core/tests/fixtures/definition.json"
        ))
        .unwrap();
        body["legacy"] = json!({"source":"fixture","snapshot":"sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","extraction":"fixture-v1","record":{"kind":"definition","id":1},"locator":"fixture","original":{},"attribution":{"author":"author","editor":null,"author_account":{"origin":"https://source.example","account":41,"username":"author","evidence":{"kind":"source-id","source":{"label":"source author numeric field","url":null,"event":null,"locator":"author_id"}}},"dates":{}},"conversion":{"method":"literal","tool":"fixture","version":"1","model":null,"review":"unreviewed","mappings":[],"warnings":[]},"limitations":[]});
        let (publication, publication_body) = event(
            9,
            3,
            json!({"kind":"definition.publish","word":word,"language":"en","parents":[],"origin":"import"}),
            Some(body),
        );
        let publication_id = publication.id().to_string();
        prepared.add_record(&publication, publication_body.as_deref());
        let issuer = identity_from_seed(&[1u8; 32]);
        let claim_id = format!("jve1:{:064x}", 910_000usize);
        prepared.add_host_verified_record(host(
            claim_id.clone(),
            &issuer,
            vec![],
            json!({"kind":"account.set","origin":"https://source.example","account":41,"value":"claim","previous":null,"carry":[]}),
        ));
        // Many further claims for the same account, and many status
        // records whose history is only the original claim: the
        // authorization walk must take the smaller side (the
        // two-member history), as on main, not every claim.
        let mut previous = claim_id.clone();
        for i in 0..240usize {
            let extra_id = format!("jve1:{:064x}", 910_100 + i);
            prepared.add_host_verified_record(host(
                extra_id.clone(),
                &issuer,
                vec![previous.clone()],
                json!({"kind":"account.set","origin":"https://source.example","account":41,"value":"claim","previous":previous,"carry":[previous]}),
            ));
            previous = extra_id;
        }
        let mut status_ids = Vec::new();
        for i in 0..240usize {
            let status_id = format!("jve1:{:064x}", 911_100 + i);
            status_ids.push(status_id.clone());
            prepared.add_host_verified_record(host(
                status_id,
                &issuer,
                vec![claim_id.clone()],
                json!({"kind":"import.status","target":publication_id,"claim":claim_id,"value":"active"}),
            ));
        }
        graph::reset_audit_work();
        let state = prepared.into_state();
        assert!(state.evaluation().available);
        // Every status record really reaches authorization and is
        // authorized: without the account binding above they would
        // end inert instead, and this test would count no work.
        for id in &status_ids {
            assert_eq!(
                state.evaluation().receipts[id].interpretation,
                Interpretation::Effective,
                "status {id} did not reach authorization"
            );
        }
        let used = state.consumed_work();
        let work = graph::audit_work();
        assert!(
            work <= 16 * used,
            "{work} audited work for {used} charged units"
        );
    }

    /// Whole-evaluator guard: across the shapes the audit touched,
    /// the counted inner-loop work stays within a fixed multiple of
    /// the charged logical units.
    #[test]
    fn evaluator_audit_work_stays_within_charged_units() {
        // Flat root judgments on one target (register maxima).
        let mut flat = base();
        let (publication, body) = publication();
        let publication_id = publication.id().to_string();
        flat.add_record(&publication, body.as_deref());
        let judge = identity_from_seed(&[8u8; 32]);
        for i in 0..1_500usize {
            flat.add_host_verified_record(host(
                format!("jve1:{:064x}", 920_000 + i),
                &judge,
                vec![],
                json!({"kind":"judgment.set","target":publication_id,"value":"bless"}),
            ));
        }
        // Independent transfers to an absent successor.
        let mut transfers = base();
        for i in 0..1_500usize {
            transfers.add_host_verified_record(host(
                format!("jve1:{:064x}", 930_000 + i),
                &format!("ed25519:{i:064x}"),
                vec![],
                json!({"kind":"identity.transfer","successor":"ed25519:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"}),
            ));
        }
        for (name, prepared) in [("flat judgments", flat), ("transfers", transfers)] {
            graph::reset_audit_work();
            let state = prepared.into_state();
            assert!(state.evaluation().available, "{name}");
            let used = state.consumed_work();
            let work = graph::audit_work();
            assert!(
                work <= 16 * used,
                "{name}: {work} audited work for {used} charged units"
            );
        }
    }

    /// Two consecutive judgments from an issuer absent from the
    /// original layout: its records live only in appended `extra`
    /// sets, whose fresh-layout range counts must charge exactly
    /// as in a full evaluation, by direct append and by checkpoint
    /// restore before any rebuild.
    #[test]
    fn new_issuer_judgments_match_full_bytes_directly_and_restored() {
        let mut prepared = base();
        let (publication, body) = publication();
        let publication_id = publication.id().to_string();
        prepared.add_record(&publication, body.as_deref());
        let issuer = identity_from_seed(&[8u8; 32]);
        let first = host(
            format!("jve1:{:064x}", 950_001usize),
            &issuer,
            vec![],
            json!({"kind":"judgment.set","target":publication_id,"value":"bless"}),
        );
        let second = host(
            format!("jve1:{:064x}", 950_002usize),
            &issuer,
            vec![first.node.id.clone()],
            json!({"kind":"judgment.set","target":publication_id,"value":"curse"}),
        );
        let mut state = prepared.clone().into_state();
        for record in [first, second] {
            let restored = EvaluatedState::restore_host_checkpoint(
                &state.checkpoint("host-checked").unwrap(),
                "host-checked",
            )
            .unwrap();
            prepared.add_host_verified_record(record.clone());
            let mut delta = PreparedEvaluationInput::new(prepared.options.clone());
            delta.add_host_verified_record(record.clone());
            let direct = state.advance(delta.clone(), &[]);
            let restored = restored.advance(delta, &[]);
            assert_matches_full(&direct, &prepared);
            assert_matches_full(&restored, &prepared);
            state = direct;
        }
    }

    /// A non-semantic judgment in the register group must not enter
    /// the incremental member set: `registers` skips it, so the
    /// append's charged work and refund match a full evaluation
    /// even with fragmented (interleaved-chain) closures.
    #[test]
    fn nonsemantic_judgment_stays_out_of_the_register_member_set() {
        let mut prepared = base();
        let (publication, body) = publication();
        let publication_id = publication.id().to_string();
        prepared.add_record(&publication, body.as_deref());
        let issuer = identity_from_seed(&[8u8; 32]);
        let add = |prepared: &mut PreparedEvaluationInput,
                   id: usize,
                   previous: Vec<String>,
                   action: Value| {
            prepared.add_host_verified_record(host(
                format!("jve1:{id:064x}"),
                &issuer,
                previous,
                action,
            ));
        };
        // Two interleaved chains of one issuer.
        add(
            &mut prepared,
            970_001,
            vec![],
            json!({"kind":"identity.merge"}),
        );
        add(
            &mut prepared,
            970_002,
            vec![],
            json!({"kind":"identity.merge"}),
        );
        add(
            &mut prepared,
            970_003,
            vec![format!("jve1:{:064x}", 970_001usize)],
            json!({"kind":"identity.merge"}),
        );
        add(
            &mut prepared,
            970_004,
            vec![format!("jve1:{:064x}", 970_002usize)],
            json!({"kind":"identity.merge"}),
        );
        add(
            &mut prepared,
            970_005,
            vec![format!("jve1:{:064x}", 970_003usize)],
            json!({"kind":"judgment.set","target":publication_id,"value":"bless"}),
        );
        add(
            &mut prepared,
            970_006,
            vec![format!("jve1:{:064x}", 970_004usize)],
            json!({"kind":"judgment.set","target":publication_id,"value":5}),
        );
        add(
            &mut prepared,
            970_007,
            vec![
                format!("jve1:{:064x}", 970_005usize),
                format!("jve1:{:064x}", 970_006usize),
            ],
            json!({"kind":"identity.merge"}),
        );
        assert!(
            !prepared.nodes[&format!("jve1:{:064x}", 970_006usize)].semantic,
            "the invalid judgment must be non-semantic"
        );
        let state = prepared.clone().into_state();
        let judgment = host(
            format!("jve1:{:064x}", 970_008usize),
            &issuer,
            vec![format!("jve1:{:064x}", 970_007usize)],
            json!({"kind":"judgment.set","target":publication_id,"value":"bless"}),
        );
        prepared.add_host_verified_record(judgment.clone());
        let mut delta = PreparedEvaluationInput::new(prepared.options.clone());
        delta.add_host_verified_record(judgment);
        let advanced = state.advance(delta, &[]);
        assert!(!advanced.statistics().rebuilt);
        assert_matches_full(&advanced, &prepared);
    }

    /// Register pricing on append must not replay the old register's
    /// unions: with N unrelated old judgments interleaved with other
    /// records and a covering parent, the maxima range visits of one
    /// append stay linear in N (main's formula is 2N+1 predecessor
    /// tests), not N(N+1)/2.
    #[test]
    fn register_pricing_on_append_does_not_replay_old_unions() {
        let mut prepared = base();
        let (publication, body) = publication();
        let publication_id = publication.id().to_string();
        prepared.add_record(&publication, body.as_deref());
        let issuer = identity_from_seed(&[8u8; 32]);
        let count = 60usize;
        let mut all: Vec<String> = Vec::new();
        for i in 0..count {
            let judgment_id = format!("jve1:{:064x}", 960_000 + 2 * i);
            let merge_id = format!("jve1:{:064x}", 960_001 + 2 * i);
            prepared.add_host_verified_record(host(
                judgment_id.clone(),
                &issuer,
                vec![],
                json!({"kind":"judgment.set","target":publication_id,"value":"bless"}),
            ));
            prepared.add_host_verified_record(host(
                merge_id.clone(),
                &issuer,
                vec![],
                json!({"kind":"identity.merge"}),
            ));
            all.push(judgment_id);
            all.push(merge_id);
        }
        let tip = format!("jve1:{:064x}", 961_000usize);
        prepared.add_host_verified_record(host(
            tip.clone(),
            &issuer,
            all,
            json!({"kind":"identity.merge"}),
        ));
        let state = prepared.clone().into_state();
        // The new judgment sorts first and follows the covering tip.
        let judgment = host(
            format!("jve1:{:064x}", 1usize),
            &issuer,
            vec![tip],
            json!({"kind":"judgment.set","target":publication_id,"value":"curse"}),
        );
        prepared.add_host_verified_record(judgment.clone());
        let mut delta = PreparedEvaluationInput::new(prepared.options.clone());
        delta.add_host_verified_record(judgment);
        graph::reset_maxima_range_visits();
        let advanced = state.advance(delta, &[]);
        assert!(!advanced.statistics().rebuilt);
        assert_matches_full(&advanced, &prepared);
        let visits = graph::maxima_range_visits();
        assert!(
            visits <= 16 * count,
            "{visits} maxima range visits for {count} old judgments"
        );
    }

    /// Checkpoints written before the register charges were stored
    /// carry the old version and are rejected; the caller rebuilds
    /// from the records, and the rebuilt state matches a full
    /// evaluation.
    #[test]
    fn old_version_checkpoint_is_rejected_and_rebuild_matches() {
        let mut prepared = base();
        let (publication, body) = publication();
        let publication_id = publication.id().to_string();
        prepared.add_record(&publication, body.as_deref());
        let issuer = identity_from_seed(&[8u8; 32]);
        let root = format!("jve1:{:064x}", 980_000usize);
        prepared.add_host_verified_record(host(
            root.clone(),
            &issuer,
            vec![],
            json!({"kind":"identity.merge"}),
        ));
        let state = prepared.clone().into_state();
        let saved = state.checkpoint("host-checked").unwrap();
        let mut value: Value = serde_json::from_slice(&saved).unwrap();
        value["version"] = "jvc-evaluation-checkpoint-v2".into();
        let old = serde_json::to_vec(&value).unwrap();
        assert!(EvaluatedState::restore_host_checkpoint(&old, "host-checked").is_err());
        // Rebuild from the records and append: the result matches a
        // full evaluation.
        let judgment = host(
            format!("jve1:{:064x}", 980_001usize),
            &issuer,
            vec![root],
            json!({"kind":"judgment.set","target":publication_id,"value":"bless"}),
        );
        prepared.add_host_verified_record(judgment.clone());
        let mut delta = PreparedEvaluationInput::new(prepared.options.clone());
        delta.add_host_verified_record(judgment);
        let rebuilt = state.advance(delta, &[]);
        assert_matches_full(&rebuilt, &prepared);
    }

    /// After 63 earlier appends on one chain, the 64th append's
    /// register pricing must not rebuild the appended-rank index
    /// per member: the counted rank-index and range work stays
    /// linear in the record count.
    #[test]
    fn register_pricing_after_64_chained_appends_stays_linear() {
        let mut prepared = base();
        let (publication, body) = publication();
        let publication_id = publication.id().to_string();
        prepared.add_record(&publication, body.as_deref());
        let issuer = identity_from_seed(&[8u8; 32]);
        let base_count = 500usize;
        let mut tip = String::new();
        for i in 0..base_count {
            let id = format!("jve1:{:064x}", 990_000 + i);
            prepared.add_host_verified_record(host(
                id.clone(),
                &issuer,
                if tip.is_empty() { vec![] } else { vec![tip] },
                json!({"kind":"judgment.set","target":publication_id,"value":"bless"}),
            ));
            tip = id;
        }
        let mut state = prepared.clone().into_state();
        for step in 0..64usize {
            let id = format!("jve1:{:064x}", 991_000 + step);
            let record = host(
                id.clone(),
                &issuer,
                vec![tip.clone()],
                json!({"kind":"judgment.set","target":publication_id,"value":"bless"}),
            );
            prepared.add_host_verified_record(record.clone());
            let mut delta = PreparedEvaluationInput::new(prepared.options.clone());
            delta.add_host_verified_record(record);
            if step == 63 {
                graph::reset_audit_work();
                graph::reset_maxima_range_visits();
            }
            state = state.advance(delta, &[]);
            tip = id;
            if step == 63 {
                assert!(!state.statistics().rebuilt);
                let work = graph::audit_work();
                assert!(
                    work <= 32 * (base_count + 64),
                    "{work} audited work on the 64th append"
                );
            }
        }
        assert_matches_full(&state, &prepared);
    }

    /// A current-version checkpoint whose register charge array is
    /// missing, short, or long is rejected, never restored with
    /// zero charges; the caller rebuilds, and the rebuild matches a
    /// full evaluation.
    #[test]
    fn malformed_charge_array_checkpoint_is_rejected_and_rebuild_matches() {
        let mut prepared = base();
        let (publication, body) = publication();
        let publication_id = publication.id().to_string();
        prepared.add_record(&publication, body.as_deref());
        let issuer = identity_from_seed(&[8u8; 32]);
        let root = format!("jve1:{:064x}", 975_000usize);
        prepared.add_host_verified_record(host(
            root.clone(),
            &issuer,
            vec![],
            json!({"kind":"identity.merge"}),
        ));
        let judgment = host(
            format!("jve1:{:064x}", 975_001usize),
            &issuer,
            vec![root.clone()],
            json!({"kind":"judgment.set","target":publication_id,"value":"bless"}),
        );
        prepared.add_host_verified_record(judgment.clone());
        let state = prepared.clone().into_state();
        assert!(!state.evaluation().registers.is_empty());
        let saved = state.checkpoint("host-checked").unwrap();
        for mutate in ["missing", "short", "long"] {
            let mut value: Value = serde_json::from_slice(&saved).unwrap();
            match mutate {
                "missing" => {
                    value
                        .as_object_mut()
                        .unwrap()
                        .remove("register_maxima_work");
                }
                "short" => {
                    let array = value["register_maxima_work"].as_array_mut().unwrap();
                    array.pop();
                }
                _ => {
                    value["register_maxima_work"]
                        .as_array_mut()
                        .unwrap()
                        .push(0.into());
                }
            }
            let broken = serde_json::to_vec(&value).unwrap();
            assert!(
                EvaluatedState::restore_host_checkpoint(&broken, "host-checked").is_err(),
                "{mutate} charge array must be rejected"
            );
        }
        // Rebuild from the records and append: the result matches a
        // full evaluation.
        let rebuilt = unshared(&prepared).into_state();
        let next = host(
            format!("jve1:{:064x}", 975_002usize),
            &issuer,
            vec![judgment.node.id.clone()],
            json!({"kind":"judgment.set","target":publication_id,"value":"curse"}),
        );
        prepared.add_host_verified_record(next.clone());
        let mut delta = PreparedEvaluationInput::new(prepared.options.clone());
        delta.add_host_verified_record(next);
        let advanced = rebuilt.advance(delta, &[]);
        assert_matches_full(&advanced, &prepared);
    }

    /// An empty advance with a new copy of a selection compares it once,
    /// however many import sets of the view name it.
    #[test]
    fn empty_advance_compares_a_repeated_selection_once() {
        let ids: Vec<String> = (0..2048).map(|i| format!("jve1:{i:064x}")).collect();
        let digest = jvc_core::hash_id("sha256:", b"", &canonical_value(&json!(ids)).unwrap());
        let importer = identity_from_seed(&[3; 32]);
        let import_sets: Vec<Value> = (0..64)
            .map(|i| json!({"source": format!("source-{i:02}"), "importer": importer, "selection": digest}))
            .collect();
        let (view, view_body) = event(
            3,
            1,
            json!({"kind":"view.publish","parents":[]}),
            Some(json!({
                "name":"repeated","description":[],"roots":[],
                "rafsi_threshold":{"numerator":1,"denominator":1},
                "H":{"numerator":3,"denominator":1},"alpha":{"numerator":1,"denominator":2},
                "excluded":[],"calculation":"simple-routes-bounds-v1","work":1000,
                "import_sets":import_sets,"account_witnesses":[],"account_authority":false,"notes":[]
            })),
        );
        let options = EvaluationOptions {
            selected_view: view.id().into(),
            overlay: None,
            import_selections: BTreeMap::from([(digest.clone(), ids.clone())]),
            limits: Limits::default(),
        };
        let mut prepared = PreparedEvaluationInput::new(options.clone());
        prepared.add_record(&view, view_body.as_deref());
        let state = prepared.into_state();
        assert!(state.evaluation().selections.contains_key(&digest));
        let before = SELECTION_IDS_COMPARED.with(std::cell::Cell::get);
        let next = state.advance(PreparedEvaluationInput::new(options), &[]);
        let compared = SELECTION_IDS_COMPARED.with(std::cell::Cell::get) - before;
        assert!(!next.statistics().rebuilt);
        assert_eq!(compared, ids.len());
    }

    /// An invalid prefix of selections followed by a valid one gives the
    /// same default budget and result fresh, under the equal explicit
    /// limit, in a fork that inherits the selections (cached validity),
    /// and after both restore formats.
    #[test]
    fn invalid_selection_prefix_then_valid_list_gives_one_budget_in_every_mode() {
        // Ten invalid lists of 98 empty strings and their entries nearly
        // use up a resolver bound of 1,000 base units plus one record;
        // the valid list comes last.
        assert_invalid_selection_prefix_gives_one_budget(98, 0);
    }

    /// The same with records that name absent predecessors. The ten
    /// invalid lists of 270 empty strings pass the base and record
    /// terms (1,000 + 256 * 3) but not the predecessor term
    /// (16 * 128), so the resolver must count predecessors to reach
    /// the valid list, as the default budget does.
    #[test]
    fn invalid_selection_prefix_with_predecessors_gives_one_budget_in_every_mode() {
        assert_invalid_selection_prefix_gives_one_budget(270, 2);
    }

    /// `merges` records each name 64 absent predecessors.
    fn assert_invalid_selection_prefix_gives_one_budget(invalid_len: usize, merges: usize) {
        let base = 1_000usize;
        let valid: Vec<String> = (0..512).map(|i| format!("jve1:{i:064x}")).collect();
        let valid_digest =
            jvc_core::hash_id("sha256:", b"", &canonical_value(&json!(valid)).unwrap());
        let mut selections: BTreeMap<String, Vec<String>> = (0..10)
            .map(|i| {
                (
                    format!("sha256:{:064x}", i + 1),
                    vec![String::new(); invalid_len],
                )
            })
            .collect();
        selections.insert(valid_digest.clone(), valid);
        let importer = identity_from_seed(&[3; 32]);
        let mut import_sets: Vec<Value> = (0..10)
            .map(|i| json!({"source": format!("{i:03}"), "importer": importer, "selection": format!("sha256:{:064x}", i + 1)}))
            .collect();
        import_sets.push(json!({"source": "010", "importer": importer, "selection": valid_digest}));
        let (view, view_body) = event(
            3,
            1,
            json!({"kind":"view.publish","parents":[]}),
            Some(json!({
                "name":"prefix","description":[],"roots":[],
                "rafsi_threshold":{"numerator":1,"denominator":1},
                "H":{"numerator":3,"denominator":1},"alpha":{"numerator":1,"denominator":2},
                "excluded":[],"calculation":"simple-routes-bounds-v1","work":1000,
                "import_sets":import_sets,"account_witnesses":[],"account_authority":false,"notes":[]
            })),
        );
        let options = |traversal: Option<usize>| EvaluationOptions {
            selected_view: view.id().into(),
            overlay: None,
            import_selections: selections.clone(),
            limits: Limits {
                traversal,
                ..Limits::default()
            },
        };
        let merger = identity_from_seed(&[4; 32]);
        let absent: Vec<String> = (0..64)
            .map(|i| format!("jve1:{:064x}", 0xA000 + i))
            .collect();
        let build = |options: EvaluationOptions| {
            let mut prepared = PreparedEvaluationInput::new(options);
            prepared.add_record(&view, view_body.as_deref());
            for i in 0..merges {
                prepared.add_host_verified_record(host(
                    format!("jve1:{:064x}", 0xB000 + i),
                    &merger,
                    absent.clone(),
                    json!({"kind":"identity.merge"}),
                ));
            }
            prepared.into_state()
        };
        policy::RESOLVER_BASE_OVERRIDE.with(|o| o.set(Some(base)));
        let fresh = build(options(None));
        let expected_budget =
            Limits::default().traversal_budget_with_selections(1 + merges, 64 * merges, 512);
        let explicit = build(options(Some(expected_budget)));
        let fork_delta = {
            let mut delta = PreparedEvaluationInput::new(options(None));
            delta.inherit_import_selections(&explicit);
            delta
        };
        let fork = explicit.clone().advance(fork_delta, &[]);
        let full = EvaluatedState::restore_host_checkpoint(&fork.checkpoint("r18").unwrap(), "r18");
        let records: Vec<HostVerifiedRecord> = fork
            .prepared
            .nodes
            .values()
            .map(|n| HostVerifiedRecord { node: n.clone() })
            .collect();
        let results = EvaluatedState::restore_host_result_checkpoint(
            &fork.result_checkpoint("r18").unwrap(),
            "r18",
            records,
        );
        policy::RESOLVER_BASE_OVERRIDE.with(|o| o.set(None));
        // Collect every mode's outcome before asserting, so a failure
        // names all modes that disagree.
        let mut wrong = Vec::new();
        let admitted =
            |state: &EvaluatedState| state.evaluation().selections.contains_key(&valid_digest);
        for (mode, state) in [
            ("fresh", Some(&fresh)),
            ("explicit", Some(&explicit)),
            ("fork", Some(&fork)),
            ("full restore", full.as_ref().ok()),
            ("results restore", results.as_ref().ok()),
        ] {
            match state {
                None => wrong.push(format!("{mode}: checkpoint refused")),
                Some(state) => {
                    if state.traversal_budget() != expected_budget {
                        wrong.push(format!("{mode}: budget {}", state.traversal_budget()));
                    }
                    if !admitted(state) {
                        wrong.push(format!("{mode}: valid list not admitted"));
                    }
                    if state.evaluation() != explicit.evaluation() {
                        wrong.push(format!("{mode}: evaluation differs from explicit"));
                    }
                }
            }
        }
        assert!(wrong.is_empty(), "{wrong:?}");
    }

    /// When a register head lies outside the new judgment's closure, a
    /// full evaluation finds the register members by walking every
    /// record. The append does not price that walk, so it rebuilds
    /// instead of walking. The fast path's own checks admit no such
    /// head from signed input (its parents cover the issuer's whole
    /// block, and a single-key actor has no other member), so the test
    /// places one in the stored register.
    #[test]
    fn register_head_outside_new_closure_rebuilds_instead_of_walking_records() {
        let mut prepared = base();
        let (publication, body) = publication();
        let publication_id = publication.id().to_string();
        prepared.add_record(&publication, body.as_deref());
        let issuer = identity_from_seed(&[8u8; 32]);
        let first = format!("jve1:{:064x}", 977_000usize);
        prepared.add_host_verified_record(host(
            first.clone(),
            &issuer,
            vec![],
            json!({"kind":"judgment.set","target":publication_id,"value":"bless"}),
        ));
        for i in 0..64usize {
            prepared.add_host_verified_record(host(
                format!("jve1:{:064x}", 978_000 + i),
                &identity_from_seed(&[9u8; 32]),
                vec![],
                json!({"kind":"identity.merge"}),
            ));
        }
        let mut state = unshared(&prepared).into_state();
        let key = format!("{issuer}|judgment|{publication_id}");
        assert_eq!(
            state.evaluation.registers[&key].heads,
            BTreeSet::from([first.clone()])
        );
        // A stored head outside every closure of the issuer.
        state
            .evaluation
            .registers
            .get_mut(&key)
            .unwrap()
            .heads
            .insert(publication_id.clone());
        let next = host(
            format!("jve1:{:064x}", 977_001usize),
            &issuer,
            vec![first],
            json!({"kind":"judgment.set","target":publication_id,"value":"curse"}),
        );
        prepared.add_host_verified_record(next.clone());
        let mut delta = PreparedEvaluationInput::new(prepared.options.clone());
        delta.add_host_verified_record(next);
        let advanced = state.advance(delta, &[]);
        assert!(advanced.statistics().rebuilt);
        assert_eq!(
            advanced.statistics().reason.as_deref(),
            Some("register_members")
        );
        assert_matches_full(&advanced, &prepared);
    }

    /// A register head from another issuer whose actor is this
    /// issuer (a judgment by the successor key) is not an ancestor
    /// of the new record, so the append keeps the general
    /// member-set path and both heads survive.
    #[test]
    fn other_issuer_head_rebuilds_and_matches_full() {
        let mut prepared = base();
        let (publication, body) = publication();
        let publication_id = publication.id().to_string();
        prepared.add_record(&publication, body.as_deref());
        let a = identity_from_seed(&[8u8; 32]);
        let c = identity_from_seed(&[9u8; 32]);
        // A: root, a judgment, then a transfer to C.
        let a_root = format!("jve1:{:064x}", 976_000usize);
        let a_judgment = format!("jve1:{:064x}", 976_001usize);
        let a_transfer = format!("jve1:{:064x}", 976_002usize);
        prepared.add_host_verified_record(host(
            a_root.clone(),
            &a,
            vec![],
            json!({"kind":"identity.merge"}),
        ));
        prepared.add_host_verified_record(host(
            a_judgment.clone(),
            &a,
            vec![a_root],
            json!({"kind":"judgment.set","target":publication_id,"value":"curse"}),
        ));
        prepared.add_host_verified_record(host(
            a_transfer.clone(),
            &a,
            vec![a_judgment.clone()],
            json!({"kind":"identity.transfer","successor":c}),
        ));
        // An unrelated issuer whose block sits between A's and C's,
        // so C's accepted history does not span A's block boundary.
        prepared.add_host_verified_record(host(
            format!("jve1:{:064x}", 976_006usize),
            &identity_from_seed(&[20u8; 32]),
            vec![],
            json!({"kind":"identity.merge"}),
        ));
        // C: the acceptance is its only root; then its own judgment,
        // which registers under A, its actor.
        let c_accept = format!("jve1:{:064x}", 976_003usize);
        let c_judgment = format!("jve1:{:064x}", 976_004usize);
        prepared.add_host_verified_record(host(
            c_accept.clone(),
            &c,
            vec![],
            json!({"kind":"identity.accept","transfer":a_transfer}),
        ));
        prepared.add_host_verified_record(host(
            c_judgment.clone(),
            &c,
            vec![c_accept],
            json!({"kind":"judgment.set","target":publication_id,"value":"bless"}),
        ));
        let state = prepared.clone().into_state();
        let key = format!("{a}|judgment|{publication_id}");
        // Before the append the only head is C's judgment: A's own
        // judgment sits inside its accepted history through the
        // transfer link.
        assert_eq!(state.evaluation().registers[&key].heads.len(), 1);
        let judgment = host(
            format!("jve1:{:064x}", 976_005usize),
            &a,
            vec![a_transfer],
            json!({"kind":"judgment.set","target":publication_id,"value":"bless"}),
        );
        prepared.add_host_verified_record(judgment.clone());
        let mut delta = PreparedEvaluationInput::new(prepared.options.clone());
        delta.add_host_verified_record(judgment);
        let advanced = state.advance(delta, &[]);
        // The actor's lifecycle group has two keys, so the fast
        // path declines on lifecycle grounds and the state rebuilds:
        // the closed form is never asked to price this shape. The
        // general member-set path remains in `append` for any head
        // outside the new record's closure.
        assert!(advanced.statistics().rebuilt);
        assert_eq!(
            advanced.statistics().reason.as_deref(),
            Some("issuer_lifecycle")
        );
        // The old key's post-transfer judgment is not retained, so
        // the register keeps only the successor's head.
        assert_eq!(advanced.evaluation().registers[&key].heads.len(), 1);
        assert_matches_full(&advanced, &prepared);
    }

    /// A checkpoint written before the byte total was saved has no
    /// total to seed. Its first advance rebuilds instead of guessing,
    /// and still matches a full evaluation.
    #[test]
    fn restored_checkpoint_without_ancestry_bytes_rebuilds() {
        let mut prepared = base();
        let (publication, body) = publication();
        let publication_id = publication.id().to_string();
        prepared.add_record(&publication, body.as_deref());
        let issuer = identity_from_seed(&[8u8; 32]);
        let root = format!("jve1:{:064x}", 800_001usize);
        prepared.add_host_verified_record(host(
            root.clone(),
            &issuer,
            vec![],
            json!({"kind":"identity.merge"}),
        ));
        let base_state = prepared.clone().into_state();
        let saved = base_state.checkpoint("host-checked").unwrap();
        let mut missing_key_value: serde_json::Value = serde_json::from_slice(&saved).unwrap();
        missing_key_value
            .as_object_mut()
            .unwrap()
            .remove("ancestry_bytes");
        let missing_key_bytes = serde_json::to_vec(&missing_key_value).unwrap();
        assert!(
            EvaluatedState::restore_host_checkpoint(&missing_key_bytes, "host-checked").is_err()
        );

        let mut value: serde_json::Value = serde_json::from_slice(&saved).unwrap();
        value["ancestry_bytes"] = serde_json::Value::Null;
        let unsealed = serde_json::to_vec(&value).unwrap();
        assert!(
            EvaluatedState::restore_host_checkpoint(&unsealed, "host-checked").is_err(),
            "mutated checkpoint without recomputed digest must be rejected"
        );
        value.as_object_mut().unwrap().remove("digest");
        let mut stripped = serde_json::to_vec(&value).unwrap();
        let digest = jvc_core::hash_id("sha256:", b"", &stripped);
        stripped.pop();
        stripped.extend_from_slice(format!(",\"digest\":\"{digest}\"}}").as_bytes());
        let restored = EvaluatedState::restore_host_checkpoint(&stripped, "host-checked").unwrap();
        let judgment = host(
            format!("jve1:{:064x}", 800_002usize),
            &issuer,
            vec![root],
            json!({"kind":"judgment.set","target":publication_id,"value":"bless"}),
        );
        let mut delta = PreparedEvaluationInput::new(prepared.options.clone());
        delta.add_host_verified_record(judgment.clone());
        let advanced = restored.advance(delta, &[]);
        assert!(advanced.statistics().rebuilt);
        assert_eq!(
            advanced.statistics().reason.as_deref(),
            Some("checkpoint_ancestry_unknown")
        );
        let mut full = prepared.clone();
        full.add_host_verified_record(judgment);
        assert_matches_full(&advanced, &full);
    }

    /// A root judgment whose issuer already has records is not
    /// covered by its parents, so it rebuilds. The advance still
    /// reports the judgment keys it changed, read from the rebuilt
    /// evaluation, so state patches keep working.
    #[test]
    fn root_judgment_rebuild_still_reports_judgment_changes() {
        let mut prepared = base();
        let (publication, body) = publication();
        let publication_id = publication.id().to_string();
        prepared.add_record(&publication, body.as_deref());
        let issuer = identity_from_seed(&[8u8; 32]);
        prepared.add_host_verified_record(host(
            format!("jve1:{:064x}", 800_001usize),
            &issuer,
            vec![],
            json!({"kind":"identity.merge"}),
        ));
        let judgment = host(
            format!("jve1:{:064x}", 800_002usize),
            &issuer,
            vec![],
            json!({"kind":"judgment.set","target":publication_id,"value":"bless"}),
        );
        let mut full = prepared.clone();
        full.add_host_verified_record(judgment.clone());
        let mut delta = PreparedEvaluationInput::new(prepared.options.clone());
        delta.add_host_verified_record(judgment.clone());
        let state = prepared.clone().into_state().advance(delta, &[]);
        assert!(state.statistics().rebuilt);
        assert_eq!(state.statistics().reason.as_deref(), Some("layout_split"));
        assert_eq!(state.statistics().incremental_records, 0);
        let changes = state.judgment_changes().expect("judgment changes");
        assert!(changes.receipts.contains(judgment.node.id.as_str()));
        assert!(
            changes
                .judgments
                .get(&publication_id)
                .is_some_and(|actors| actors.contains(&issuer))
        );
        assert_matches_full(&state, &full);
    }

    /// Interleaved-transfer probe: an interleaved chain transferred to a
    /// successor whose lifecycle link is blocked by a second root. The
    /// structural cache of the acceptance holds many more ranges than
    /// its own closure. A judgment on the acceptance must cost exactly
    /// what a full evaluation costs, at the exact budget and one below.
    #[test]
    fn transfer_append_matches_full_at_tight_budgets() {
        let mut prepared = base();
        let (publication, body) = publication();
        let publication_id = publication.id().to_string();
        prepared.add_record(&publication, body.as_deref());
        let chain_issuer = identity_from_seed(&[7u8; 32]);
        let successor = identity_from_seed(&[2u8; 32]);
        let mut tips: Vec<String> = Vec::new();
        for i in 0..80usize {
            let id = format!("jve1:{i:064x}");
            let previous = (i >= 2)
                .then(|| format!("jve1:{:064x}", i - 2))
                .into_iter()
                .collect();
            prepared.add_host_verified_record(host(
                id.clone(),
                &chain_issuer,
                previous,
                json!({"kind":"identity.merge"}),
            ));
            tips.push(id);
        }
        let transfer_id = format!("jve1:{:064x}", 900_001usize);
        prepared.add_host_verified_record(host(
            transfer_id.clone(),
            &chain_issuer,
            tips[tips.len() - 2..].to_vec(),
            json!({"kind":"identity.transfer","successor":successor}),
        ));
        // A second root on the successor blocks the lifecycle link.
        prepared.add_host_verified_record(host(
            format!("jve1:{:064x}", 900_003usize),
            &successor,
            vec![],
            json!({"kind":"identity.merge"}),
        ));
        let accept_id = format!("jve1:{:064x}", 900_002usize);
        prepared.add_host_verified_record(host(
            accept_id.clone(),
            &successor,
            vec![],
            json!({"kind":"identity.accept","transfer":transfer_id}),
        ));
        let judgment = host(
            format!("jve1:{:064x}", 900_004usize),
            &successor,
            vec![accept_id],
            json!({"kind":"judgment.set","target":publication_id,"value":"bless"}),
        );
        let mut full = prepared.clone();
        full.add_host_verified_record(judgment.clone());
        assert_tight_budgets_match(&prepared, &judgment, &full);
    }

    /// Carry-split probe: a judgment inserted between an account
    /// claim and its successor claim splits the carried closure that
    /// a later account record carries. The append must match a full
    /// evaluation at the exact budget and one below.
    #[test]
    fn carry_split_append_matches_full_at_tight_budgets() {
        let mut prepared = witnessed_view();
        let (publication, body) = publication();
        let publication_id = publication.id().to_string();
        prepared.add_record(&publication, body.as_deref());
        let issuer = identity_from_seed(&[8u8; 32]);
        let claim_id = format!("jve1:{:064x}", 700_010usize);
        let status_id = format!("jve1:{:064x}", 700_020usize);
        let third_id = format!("jve1:{:064x}", 700_030usize);
        prepared.add_host_verified_record(host(
            claim_id.clone(),
            &issuer,
            vec![],
            json!({"kind":"account.set","origin":"https://source.example","account":41,"value":"claim","previous":null,"carry":[]}),
        ));
        prepared.add_host_verified_record(host(
            status_id.clone(),
            &issuer,
            vec![claim_id.clone()],
            json!({"kind":"account.set","origin":"https://source.example","account":41,"value":"claim","previous":claim_id,"carry":[claim_id]}),
        ));
        prepared.add_host_verified_record(host(
            third_id.clone(),
            &issuer,
            vec![status_id.clone()],
            json!({"kind":"account.set","origin":"https://source.example","account":41,"value":"claim","previous":status_id,"carry":[status_id]}),
        ));
        // Certify the chain head, so account evaluation really
        // constructs the carries this test is about.
        observe(&mut prepared, 10, 5, &third_id);
        observe(&mut prepared, 11, 5, &third_id);
        assert!(
            prepared
                .nodes
                .values()
                .filter(|node| node.kind == "account.set")
                .all(|node| node.semantic),
            "carry-split account records must be semantically valid"
        );
        let construction_bytes =
            graph::Graph::new(prepared.nodes.clone(), &prepared.options.limits)
                .ancestry
                .bytes();
        assert_eq!(
            cap_bytes(&prepared.clone().into_state()),
            construction_bytes,
            "carries are temporary sets and add no ancestry bytes"
        );
        // The ID sorts between the two claims, so a fresh layout
        // splits the carried closure.
        let judgment = host(
            format!("jve1:{:064x}", 700_015usize),
            &issuer,
            vec![claim_id],
            json!({"kind":"judgment.set","target":publication_id,"value":"bless"}),
        );
        let mut full = prepared.clone();
        full.add_host_verified_record(judgment.clone());
        assert_tight_budgets_match(&prepared, &judgment, &full);
    }

    #[test]
    fn sibling_forks_near_the_cap_each_match_their_full_evaluation() {
        let (prepared, publication_id, ids) = cap_boundary_prepared();
        let state = prepared.clone().into_state();
        assert!(state.evaluation().available);
        let options = EvaluationOptions {
            selected_view: state.evaluation().selected_view.clone(),
            import_selections: BTreeMap::new(),
            overlay: None,
            limits: Limits::default(),
        };
        // Fork A appends on a heavy chain tip and crosses the cap.
        // It must rebuild and return the full (unavailable) result.
        let (judgment_a, _) = signed(
            7,
            9500,
            vec![ids[3_423].clone()],
            json!({"kind":"judgment.set","target":publication_id,"value":"bless"}),
        );
        let mut delta = PreparedEvaluationInput::new(options.clone());
        delta.add_record(&judgment_a, None);
        let fork_a = state.clone().advance(delta, &[]);
        assert!(fork_a.statistics().rebuilt);
        let mut full = prepared.clone();
        full.add_record(&judgment_a, None);
        assert_eq!(fork_a.evaluation(), &full.evaluate());
        assert!(!fork_a.evaluation().available);
        // Fork B, cloned from the same parent, is unaffected by fork
        // A's cap failure and matches its own full evaluation.
        let (judgment_b, _) = signed(
            7,
            9501,
            vec![],
            json!({"kind":"judgment.set","target":publication_id,"value":"curse"}),
        );
        let mut delta = PreparedEvaluationInput::new(options);
        delta.add_record(&judgment_b, None);
        let fork_b = state.clone().advance(delta, &[]);
        let mut full = prepared.clone();
        full.add_record(&judgment_b, None);
        assert_eq!(fork_b.evaluation(), &full.evaluate());
        assert!(fork_b.evaluation().available);
        assert!(state.evaluation().available);
    }

    #[test]
    fn ranking_indexes_are_once_per_state_and_never_enter_checkpoints_or_forks() {
        let mut prepared = base();
        let (record, body) = publication();
        prepared.add_record(&record, body.as_deref());
        let mut state = prepared.into_state();
        let mut policy = serde_json::to_value(state.evaluation.policy.as_ref().unwrap()).unwrap();
        policy["calculation"] = json!(jvc_rank::approximate::ALGORITHM);
        state.evaluation.policy = Some(CompactValue::from(&policy));
        let before = state.checkpoint("index-test").unwrap();
        assert!(state.ranking_index.borrow().is_none());
        state.ensure_ranking_index().unwrap();
        let pointer = state.ranking_index.borrow().as_ref().unwrap() as *const _;
        state.ensure_ranking_index().unwrap();
        assert_eq!(
            state.ranking_index.borrow().as_ref().unwrap() as *const _,
            pointer
        );
        let word = jvc_core::word_id(&json!({"language":"jbo","spelling":"banli"})).unwrap();
        for (kind, language) in [
            ("definition", Some("en".into())),
            ("definition", Some("fr".into())),
            ("rafsi", None),
            ("other", Some("ignored".into())),
        ] {
            let context = policy::Context {
                kind: kind.into(),
                word: word.clone(),
                language,
            };
            let indexed = state.prepare_indexed_approximate_context(&context).unwrap();
            let direct = policy::prepare_approximate_context(state.evaluation(), &context);
            assert_eq!(
                serde_json::to_value(&indexed).unwrap(),
                serde_json::to_value(&direct).unwrap()
            );
        }
        assert_eq!(state.checkpoint("index-test").unwrap(), before);
        assert!(state.clone().ranking_index.borrow().is_none());
        let restored = EvaluatedState::restore_host_checkpoint(&before, "index-test").unwrap();
        assert!(restored.ranking_index.borrow().is_none());
        let delta = PreparedEvaluationInput::new(state.prepared.options.clone());
        let advanced = state.advance(delta, &[]);
        assert!(advanced.ranking_index.borrow().is_none());
    }
    #[test]
    fn source_stream_pins_sorted_value_maps_and_matches_previous_bytes() {
        // Do not enable serde_json/preserve_order without changing the binding contract.
        let value: Value = serde_json::from_str(r#"{"z":0,"é":{"z":1,"a":2},"a":3}"#).unwrap();
        assert_eq!(
            serde_json::to_string(&value).unwrap(),
            r#"{"a":3,"z":0,"é":{"a":2,"z":1}}"#
        );
        let state = base().into_state();
        let bytes = serde_json::to_vec(&(
            &state.prepared.options,
            state.prepared.nodes.as_ref(),
            state.prepared.event_limit_exceeded,
            &state.evaluation,
        ))
        .unwrap();
        let (binding, count) = state.ranking_source_binding(bytes.len()).unwrap();
        assert_eq!(count, bytes.len());
        assert_eq!(
            binding,
            jvc_core::hash_id("sha256:", b"jvc-ranking-state-v1\n", &bytes)
        );
        assert_eq!(
            state
                .ranking_source_binding(bytes.len() - 1)
                .unwrap_err()
                .code,
            "resource_unavailable"
        );
    }
    #[test]
    fn source_deadline_stops_streaming_without_a_partial_binding() {
        let mut state = base().into_state();
        let (binding, bytes) = state.ranking_source_binding(1_000_000).unwrap();
        assert_eq!(
            state
                .ranking_source_binding_checked(bytes, || true)
                .unwrap(),
            (binding, bytes)
        );
        assert_eq!(
            state
                .ranking_source_binding_checked(bytes, || false)
                .unwrap_err()
                .code,
            "resource_unavailable"
        );
        // Add a large unrelated field. The callback expires during the walk.
        state.evaluation.policy = Some(json!({"padding":"x".repeat(1_000_000)}).into());
        let mut calls = 0;
        let failed = state.ranking_source_binding_checked(2_000_000, || {
            calls += 1;
            calls < 3
        });
        assert_eq!(failed.unwrap_err().code, "resource_unavailable");
        assert_eq!(calls, 3);
        assert!(state.ranking_index_counts().unwrap().is_none());
    }
    #[test]
    fn malformed_overlay_bound_errors_and_invalid_overlay_counts_are_ignored() {
        let mut state = base().into_state();
        state.evaluation.overlay = Some(json!({"trust":[{"issuer":1}]}).into());
        state.evaluation.reasons.remove("invalid_overlay");
        assert_eq!(
            state.ranking_index_bound().unwrap_err().code,
            "invalid_overlay"
        );
        assert_eq!(
            state.ensure_ranking_index().unwrap_err().code,
            "invalid_overlay"
        );
        state.evaluation.reasons.insert("invalid_overlay".into());
        assert_eq!(state.ranking_index_bound().unwrap().private_rules, 0);
        state.ensure_ranking_index().unwrap();
        assert_eq!(
            state.ranking_index_counts().unwrap().unwrap().private_rules,
            0
        );
        state.evaluation.reasons.remove("invalid_overlay");
        assert_eq!(
            state.ranking_index_counts().unwrap_err().code,
            "invalid_overlay"
        );
    }

    fn host_missing_body(
        id: String,
        issuer: &str,
        previous: Vec<String>,
        action: Value,
    ) -> HostVerifiedRecord {
        let header = Header {
            version: 1,
            issuer: issuer.into(),
            previous,
            nonce: "00".repeat(16),
            action,
            content: Some(jvc_core::ContentDescriptor {
                hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
                    .into(),
                bytes: 1,
            }),
        };
        HostVerifiedRecord::extract_with(&id, &header, jvc_core::BodyAvailability::Missing, |_| ())
            .0
    }

    fn assert_whole_evaluation_refusal(evaluation: &Evaluation) {
        assert!(!evaluation.available);
        assert!(evaluation.reasons.contains("resource_unavailable"));
        assert!(evaluation.registers.is_empty());
        assert!(evaluation.judgments.is_empty());
        assert!(evaluation.trust.is_empty());
        assert!(evaluation.publications.values().all(|p| {
            p.status == Status::Unavailable
                && p.eligible == Eligibility::Unknown
                && p.reasons.contains("resource_unavailable")
        }));
        assert!(evaluation.accounts.values().all(|a| {
            a.unavailable
                && !a.commands
                && a.controller.is_none()
                && a.controller_identity.is_none()
                && a.reasons.contains("resource_unavailable")
        }));
        assert!(evaluation.receipts.values().all(|r| {
            r.interpretation == Interpretation::Inert
                || (r.interpretation == Interpretation::Unavailable
                    && r.reasons.contains("resource_unavailable"))
        }));
    }

    fn assert_probe_refuses_under_budget_and_passes_default(
        mut prepared: PreparedEvaluationInput,
        budget: usize,
    ) {
        let mut bounded = prepared.clone();
        bounded.options.limits.traversal = Some(budget);
        let bounded_eval = bounded.clone().evaluate();
        assert_whole_evaluation_refusal(&bounded_eval);
        let bounded_state = bounded.into_state();
        assert_whole_evaluation_refusal(bounded_state.evaluation());
        assert_eq!(bounded_state.evaluation(), &bounded_eval);

        prepared.options.limits = Limits::default();
        graph::reset_audit_work();
        let state = prepared.into_state();
        assert!(state.evaluation().available);
        let used = state.consumed_work();
        assert!(
            used > budget,
            "consumed {used} units must exceed refusal budget {budget}"
        );
        let work = graph::audit_work();
        assert!(
            work <= 16 * used,
            "{work} audited work for {used} charged units"
        );
    }

    fn seed_identity(tag: u64, step: usize) -> String {
        let mut seed = [0u8; 32];
        seed[0..8].copy_from_slice(&tag.to_le_bytes());
        seed[8..16].copy_from_slice(&(step as u64).to_le_bytes());
        identity_from_seed(&seed)
    }

    #[test]
    fn downstream_successor_walks_across_publications_and_claims_stop_at_work_budget() {
        let mut prepared = witnessed_view();
        let word = jvc_core::word_id(&json!({"language":"jbo","spelling":"banli"})).unwrap();
        let mut current = identity_from_seed(&[1u8; 32]);
        let mut current_prev: Vec<String> = Vec::new();
        for step in 0..300usize {
            let next = seed_identity(10, step);
            let transfer_id = format!("jve1:{:064x}", 1_100_000 + step);
            let accept_id = format!("jve1:{:064x}", 1_200_000 + step);
            prepared.add_host_verified_record(host(
                transfer_id.clone(),
                &current,
                current_prev,
                json!({"kind":"identity.transfer","successor":next}),
            ));
            prepared.add_host_verified_record(host(
                accept_id.clone(),
                &next,
                vec![],
                json!({"kind":"identity.accept","transfer":transfer_id}),
            ));
            current = next;
            current_prev = vec![accept_id];
        }
        let origin_issuer = identity_from_seed(&[1u8; 32]);
        for i in 0..800usize {
            prepared.add_host_verified_record(host_missing_body(
                format!("jve1:{:064x}", 1_300_000 + i),
                &origin_issuer,
                vec![],
                json!({"kind":"definition.publish","word":word,"language":"en","parents":[],"origin":"native"}),
            ));
            prepared.add_host_verified_record(host(
                format!("jve1:{:064x}", 1_400_000 + i),
                &origin_issuer,
                vec![],
                json!({"kind":"account.set","origin":"https://source.example","account":41,"value":"claim","previous":null,"carry":[]}),
            ));
        }
        assert_probe_refuses_under_budget_and_passes_default(prepared, 120_000);
    }

    #[test]
    fn fragmented_closure_maxima_subset_and_signature_scans_stop_at_work_budget() {
        let mut prepared = base();
        let (publication, body) = publication();
        let publication_id = publication.id().to_string();
        prepared.add_record(&publication, body.as_deref());
        let judge = identity_from_seed(&[7u8; 32]);
        for i in 0..600usize {
            let id = format!("jve1:{:064x}", 2_100_000 + i);
            let previous = (i >= 2)
                .then(|| format!("jve1:{:064x}", 2_100_000 + i - 2))
                .into_iter()
                .collect();
            prepared.add_host_verified_record(host(
                id,
                &judge,
                previous,
                json!({"kind":"identity.merge"}),
            ));
        }
        let tip = format!("jve1:{:064x}", 2_100_000 + 598);
        for i in 0..600usize {
            prepared.add_host_verified_record(host(
                format!("jve1:{:064x}", 2_200_000 + i),
                &judge,
                vec![tip.clone()],
                json!({"kind":"judgment.set","target":publication_id,"value":"bless"}),
            ));
        }
        assert_probe_refuses_under_budget_and_passes_default(prepared, 900_000);
    }

    #[test]
    fn import_status_candidate_claim_scans_stop_at_work_budget() {
        let mut prepared = witnessed_view();
        let word = jvc_core::word_id(&json!({"language":"jbo","spelling":"banli"})).unwrap();
        let mut body: Value = serde_json::from_str(include_str!(
            "../../jvc-core/tests/fixtures/definition.json"
        ))
        .unwrap();
        body["legacy"] = json!({"source":"fixture","snapshot":"sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","extraction":"fixture-v1","record":{"kind":"definition","id":1},"locator":"fixture","original":{},"attribution":{"author":"author","editor":null,"author_account":{"origin":"https://source.example","account":41,"username":"author","evidence":{"kind":"source-id","source":{"label":"source author numeric field","url":null,"event":null,"locator":"author_id"}}},"dates":{}},"conversion":{"method":"literal","tool":"fixture","version":"1","model":null,"review":"unreviewed","mappings":[],"warnings":[]},"limitations":[]});
        let (publication, publication_body) = event(
            9,
            3,
            json!({"kind":"definition.publish","word":word,"language":"en","parents":[],"origin":"import"}),
            Some(body),
        );
        let publication_id = publication.id().to_string();
        prepared.add_record(&publication, publication_body.as_deref());
        let claim_issuer = identity_from_seed(&[1u8; 32]);
        for i in 0..800usize {
            let id = format!("jve1:{:064x}", 3_100_000 + i);
            let previous = (i >= 2)
                .then(|| format!("jve1:{:064x}", 3_100_000 + i - 2))
                .into_iter()
                .collect();
            prepared.add_host_verified_record(host(
                id,
                &claim_issuer,
                previous,
                json!({"kind":"identity.merge"}),
            ));
        }
        let tip = format!("jve1:{:064x}", 3_100_000 + 798);
        let mut first_claim = String::new();
        for i in 0..300usize {
            let claim_id = format!("jve1:{:064x}", 3_200_000 + i);
            if i == 0 {
                first_claim = claim_id.clone();
            }
            prepared.add_host_verified_record(host(
                claim_id,
                &claim_issuer,
                vec![],
                json!({"kind":"account.set","origin":"https://source.example","account":41,"value":"claim","previous":null,"carry":[]}),
            ));
        }
        for i in 0..500usize {
            prepared.add_host_verified_record(host(
                format!("jve1:{:064x}", 3_300_000 + i),
                &claim_issuer,
                vec![tip.clone(), first_claim.clone()],
                json!({"kind":"import.status","target":publication_id,"claim":first_claim,"value":"active"}),
            ));
        }
        assert_probe_refuses_under_budget_and_passes_default(prepared, 1_200_000);
    }

    #[test]
    fn witness_group_rescans_in_account_certificates_stop_at_work_budget() {
        let mut prepared = witnessed_view();
        let mut current = identity_from_seed(&[10u8; 32]);
        let mut current_prev: Vec<String> = Vec::new();
        for step in 0..200usize {
            let next = seed_identity(40, step);
            let transfer_id = format!("jve1:{:064x}", 4_100_000 + step);
            let accept_id = format!("jve1:{:064x}", 4_200_000 + step);
            prepared.add_host_verified_record(host(
                transfer_id.clone(),
                &current,
                current_prev,
                json!({"kind":"identity.transfer","successor":next}),
            ));
            prepared.add_host_verified_record(host(
                accept_id.clone(),
                &next,
                vec![],
                json!({"kind":"identity.accept","transfer":transfer_id}),
            ));
            current = next;
            current_prev = vec![accept_id];
        }
        let issuer = identity_from_seed(&[1u8; 32]);
        for i in 0..500usize {
            let claim_id = format!("jve1:{:064x}", 4_300_000 + i);
            prepared.add_host_verified_record(host(
                claim_id.clone(),
                &issuer,
                vec![],
                json!({"kind":"account.set","origin":"https://source.example","account":41,"value":"claim","previous":null,"carry":[]}),
            ));
            observe(&mut prepared, 10, (i % 256) as u8, &claim_id);
            observe(&mut prepared, 11, (i % 256) as u8, &claim_id);
        }
        assert_probe_refuses_under_budget_and_passes_default(prepared, 80_000);
    }

    #[test]
    fn accounts_across_policy_history_views_stop_at_work_budget() {
        let mut prepared = witnessed_view();
        let mut parent = prepared.options.selected_view.clone();
        for i in 0..200usize {
            let (view, view_body) = event(
                1,
                i as u8,
                json!({"kind":"view.publish","parents":[parent]}),
                Some(
                    json!({"name":"fixture","description":[],"roots":[{"identity":identity_from_seed(&[1;32]),"q":{"numerator":1,"denominator":1}}],"rafsi_threshold":{"numerator":1,"denominator":1},"H":{"numerator":3,"denominator":1},"alpha":{"numerator":1,"denominator":2},"excluded":[],"calculation":"simple-routes-bounds-v1","work":1000,"import_sets":[],"account_witnesses":[identity_from_seed(&[10;32]),identity_from_seed(&[11;32])],"account_authority":true,"notes":[]}),
                ),
            );
            parent = view.id().to_string();
            prepared.add_record(&view, view_body.as_deref());
        }
        prepared.options.selected_view = parent;
        let issuer = identity_from_seed(&[1u8; 32]);
        for account in 1..=300u64 {
            let claim_id = format!("jve1:{:064x}", 5_100_000 + account as usize);
            prepared.add_host_verified_record(host(
                claim_id,
                &issuer,
                vec![],
                json!({"kind":"account.set","origin":"https://source.example","account":account,"value":"claim","previous":null,"carry":[]}),
            ));
        }
        assert_probe_refuses_under_budget_and_passes_default(prepared, 30_000);
    }

    #[test]
    fn competing_transfers_and_cutoffs_in_retention_stop_at_work_budget() {
        let mut prepared = base();
        let word = jvc_core::word_id(&json!({"language":"jbo","spelling":"banli"})).unwrap();
        let issuer = identity_from_seed(&[5u8; 32]);
        let absent_successor = identity_from_seed(&[250u8; 32]);
        let mut prev: Vec<String> = Vec::new();
        for i in 0..200usize {
            let pub_id = format!("jve1:{:064x}", 6_300_000 + i);
            prepared.add_host_verified_record(host_missing_body(
                pub_id.clone(),
                &issuer,
                prev,
                json!({"kind":"definition.publish","word":word,"language":"en","parents":[],"origin":"native"}),
            ));
            prev = vec![pub_id];
        }
        let safe_id = format!("jve1:{:064x}", 6_000_000usize);
        prepared.add_host_verified_record(host(
            safe_id.clone(),
            &issuer,
            prev,
            json!({"kind":"identity.merge"}),
        ));
        for i in 0..500usize {
            prepared.add_host_verified_record(host(
                format!("jve1:{:064x}", 6_100_000 + i),
                &issuer,
                vec![safe_id.clone()],
                json!({"kind":"identity.transfer","successor":absent_successor}),
            ));
            prepared.add_host_verified_record(host(
                format!("jve1:{:064x}", 6_200_000 + i),
                &issuer,
                vec![safe_id.clone()],
                json!({"kind":"identity.compromise","safe":[safe_id]}),
            ));
        }
        assert_probe_refuses_under_budget_and_passes_default(prepared, 300_000);
    }

    /// `jvr1:` judgments and managed bridges look up their
    /// publication in an index, so this shape costs units linear in
    /// its size. A scan of the publication map per record cost
    /// definitions times records: 320,000 units at 400 of each.
    #[test]
    fn rafsi_pair_judgment_and_managed_bridge_lookups_cost_linear_work() {
        let shape = |size: usize| {
            let mut prepared = base();
            let word = jvc_core::word_id(&json!({"language":"jbo","spelling":"banli"})).unwrap();
            let rafsi_target = format!("jvr1:{:064x}", 1usize);
            let issuer = identity_from_seed(&[5u8; 32]);
            let first_pub = format!("jve1:{:064x}", 7_100_000usize);
            for i in 0..size {
                prepared.add_host_verified_record(host_missing_body(
                    format!("jve1:{:064x}", 7_100_000 + i),
                    &issuer,
                    vec![],
                    json!({"kind":"definition.publish","word":word,"language":"en","parents":[],"origin":"native"}),
                ));
            }
            for i in 0..size {
                prepared.add_host_verified_record(host(
                    format!("jve1:{:064x}", 7_200_000 + i),
                    &issuer,
                    vec![],
                    json!({"kind":"judgment.set","target":rafsi_target,"value":"bless"}),
                ));
                prepared.add_host_verified_record(host(
                    format!("jve1:{:064x}", 7_300_000 + i),
                    &issuer,
                    vec![],
                    json!({"kind":"bridge.set","origin":"https://source.example","source_definition":i + 1,"target":first_pub,"value":"managed"}),
                ));
            }
            prepared.options.limits.traversal = Some(40_000);
            graph::reset_audit_work();
            let state = prepared.into_state();
            assert!(state.evaluation().available);
            let used = state.consumed_work();
            let work = graph::audit_work();
            assert!(
                work <= 16 * used,
                "{work} audited work for {used} charged units"
            );
            used
        };
        let half = shape(200);
        let full = shape(400);
        assert!(full <= 2 * half + 100, "{full} units at 400, {half} at 200");
    }

    #[test]
    fn issuer_missing_and_command_authority_scans_stop_at_work_budget() {
        let mut prepared = witnessed_view();
        let issuer = identity_from_seed(&[1u8; 32]);
        let missing_parents: Vec<String> = (0..200usize)
            .map(|i| format!("jve1:{:064x}", 8_000_000 + i))
            .collect();
        let root_with_missing = format!("jve1:{:064x}", 8_050_000usize);
        prepared.add_host_verified_record(host(
            root_with_missing,
            &issuer,
            missing_parents,
            json!({"kind":"identity.merge"}),
        ));
        let mut previous: Vec<String> = Vec::new();
        let mut action_previous: Option<String> = None;
        for i in 0..400usize {
            let claim_id = format!("jve1:{:064x}", 8_100_000 + i);
            prepared.add_host_verified_record(host(
                claim_id.clone(),
                &issuer,
                previous,
                json!({"kind":"account.set","origin":"https://source.example","account":41,"value":"claim","previous":action_previous,"carry":[]}),
            ));
            observe(&mut prepared, 10, (i % 256) as u8, &claim_id);
            observe(&mut prepared, 11, (i % 256) as u8, &claim_id);
            previous = vec![claim_id.clone()];
            action_previous = Some(claim_id);
        }
        assert_probe_refuses_under_budget_and_passes_default(prepared, 40_000);
    }

    #[test]
    fn default_limits_grow_linearly_and_have_no_event_cap_until_configured() {
        let defaults = Limits::default();
        assert_eq!(defaults.events, None);
        assert_eq!(defaults.traversal, None);
        assert_eq!(
            defaults.traversal_budget(250_000, 0),
            DEFAULT_TRAVERSAL_BASE + 250_000 * DEFAULT_TRAVERSAL_PER_RECORD
        );
        let mut prepared = base();
        let issuer = identity_from_seed(&[9u8; 32]);
        let mut previous = Vec::new();
        for i in 0..200_005usize {
            let id = format!("jve1:{:064x}", 9_000_000 + i);
            prepared.add_host_verified_record(host(
                id.clone(),
                &issuer,
                previous,
                json!({"kind":"identity.merge"}),
            ));
            previous = vec![id];
        }
        assert!(prepared.nodes.len() > 200_000);
        let state = prepared.clone().into_state();
        assert!(state.evaluation().available);

        let mut capped = prepared;
        capped.options.limits.events = Some(200_000);
        capped.event_limit_exceeded = true;
        let capped_state = capped.into_state();
        assert_whole_evaluation_refusal(capped_state.evaluation());
    }

    fn compare_fast_and_full(
        prepared: &PreparedEvaluationInput,
        record: &HostVerifiedRecord,
    ) -> (EvaluatedState, EvaluatedState, PreparedEvaluationInput) {
        let state = unshared(prepared).into_state();
        let mut delta = PreparedEvaluationInput::new(prepared.options.clone());
        delta.add_host_verified_record(record.clone());
        let fast = state.advance(delta, &[]);
        let mut full_prepared = prepared.clone();
        full_prepared.add_host_verified_record(record.clone());
        let full = full_prepared.clone().into_state();
        assert_eq!(fast.consumed_work(), full.consumed_work());
        assert_eq!(
            serde_json::to_value(fast.evaluation()).unwrap(),
            serde_json::to_value(full.evaluation()).unwrap()
        );
        assert_eq!(fast.evaluation().available, full.evaluation().available);
        assert_eq!(
            fast.evaluation().reasons.contains("resource_unavailable"),
            full.evaluation().reasons.contains("resource_unavailable")
        );
        assert_matches_full(&fast, &full_prepared);
        (fast, full, full_prepared)
    }

    #[test]
    fn fast_append_native_publication_with_unresolved_rafsi_judgments_matches_full() {
        let word = jvc_core::word_id(&json!({"language":"jbo","spelling":"banli"})).unwrap();
        let new_issuer = identity_from_seed(&[9u8; 32]);

        // Control: ordinary jve1: judgments.
        let mut control = base();
        let (pub_ev, pub_body) = publication();
        let pub_id = pub_ev.id().to_string();
        control.add_record(&pub_ev, pub_body.as_deref());
        let control_judge = identity_from_seed(&[8u8; 32]);
        for i in 0..20usize {
            control.add_host_verified_record(host(
                format!("jve1:{:064x}", 10_000 + i),
                &control_judge,
                vec![],
                json!({"kind":"judgment.set","target":pub_id,"value":"bless"}),
            ));
        }
        let control_pub = host_missing_body(
            format!("jve1:{:064x}", 20_000usize),
            &new_issuer,
            vec![],
            json!({"kind":"definition.publish","word":word,"language":"en","parents":[],"origin":"native"}),
        );
        let (control_fast, _, control_full) = compare_fast_and_full(&control, &control_pub);
        assert!(!control_fast.statistics().rebuilt);
        assert_tight_budgets_match(&control, &control_pub, &control_full);

        // Unresolved `jvr1:` judgments, then a native `definition.publish`
        // added on the fast path.
        let mut prepared = base();
        prepared.add_record(&pub_ev, pub_body.as_deref());
        let rafsi_target = format!("jvr1:{:064x}", 1usize);
        let judge = identity_from_seed(&[5u8; 32]);
        for i in 0..10usize {
            prepared.add_host_verified_record(host(
                format!("jve1:{:064x}", 30_000 + i),
                &judge,
                vec![],
                json!({"kind":"judgment.set","target":rafsi_target,"value":"bless"}),
            ));
        }
        let new_pub = host_missing_body(
            format!("jve1:{:064x}", 40_000usize),
            &new_issuer,
            vec![],
            json!({"kind":"definition.publish","word":word,"language":"en","parents":[],"origin":"native"}),
        );
        let (fast, _, full_prepared) = compare_fast_and_full(&prepared, &new_pub);
        assert!(!fast.statistics().rebuilt);
        assert_tight_budgets_match(&prepared, &new_pub, &full_prepared);
    }

    /// On an unshared state (the helper builds the base from its own
    /// copy of the records, so the append copies nothing), a native
    /// publication appended after unresolved `jvr1:` judgments costs
    /// what it costs without them: no judgment looks at the
    /// publication map again.
    #[test]
    fn fast_append_native_publication_cost_does_not_grow_with_rafsi_judgments() {
        let word = jvc_core::word_id(&json!({"language":"jbo","spelling":"banli"})).unwrap();
        let new_issuer = identity_from_seed(&[9u8; 32]);
        let new_pub = host_missing_body(
            format!("jve1:{:064x}", 40_000usize),
            &new_issuer,
            vec![],
            json!({"kind":"definition.publish","word":word,"language":"en","parents":[],"origin":"native"}),
        );
        let rafsi_target = format!("jvr1:{:064x}", 1usize);
        let judge = identity_from_seed(&[5u8; 32]);
        let append_cost = |judgments: usize| {
            let mut prepared = base();
            let (pub_ev, pub_body) = publication();
            prepared.add_record(&pub_ev, pub_body.as_deref());
            for i in 0..judgments {
                prepared.add_host_verified_record(host(
                    format!("jve1:{:064x}", 30_000 + i),
                    &judge,
                    vec![],
                    json!({"kind":"judgment.set","target":rafsi_target,"value":"bless"}),
                ));
            }
            let base_work = prepared.clone().into_state().consumed_work();
            let (fast, full, full_prepared) = compare_fast_and_full(&prepared, &new_pub);
            assert!(!fast.statistics().rebuilt);
            assert!(full.evaluation().available);
            assert_tight_budgets_match(&prepared, &new_pub, &full_prepared);
            full.consumed_work() - base_work
        };
        assert_eq!(append_cost(20), append_cost(0));
    }

    #[test]
    fn fast_append_native_publication_on_rafsi_judgment_chain_matches_full() {
        let mut prepared = base();
        let (pub_ev, pub_body) = publication();
        prepared.add_record(&pub_ev, pub_body.as_deref());
        let rafsi_target = format!("jvr1:{:064x}", 1usize);
        let issuer = identity_from_seed(&[5u8; 32]);
        let mut prev = Vec::new();
        for i in 0..20usize {
            let id = format!("jve1:{:064x}", 50_000 + i);
            prepared.add_host_verified_record(host(
                id.clone(),
                &issuer,
                prev,
                json!({"kind":"judgment.set","target":rafsi_target,"value":"bless"}),
            ));
            prev = vec![id];
        }
        let word = jvc_core::word_id(&json!({"language":"jbo","spelling":"banli"})).unwrap();
        let new_pub = host_missing_body(
            format!("jve1:{:064x}", 60_000usize),
            &issuer,
            prev,
            json!({"kind":"definition.publish","word":word,"language":"en","parents":[],"origin":"native"}),
        );
        let (fast, _, full_prepared) = compare_fast_and_full(&prepared, &new_pub);
        assert!(!fast.statistics().rebuilt);
        assert_tight_budgets_match(&prepared, &new_pub, &full_prepared);
    }

    #[test]
    fn fast_append_native_publication_with_managed_bridges_matches_full() {
        let mut prepared = base();
        let (pub_ev, pub_body) = publication();
        let pub_id = pub_ev.id().to_string();
        prepared.add_record(&pub_ev, pub_body.as_deref());
        let issuer = identity_from_seed(&[1u8; 32]);
        for i in 0..20usize {
            prepared.add_host_verified_record(host(
                format!("jve1:{:064x}", 70_000 + i),
                &issuer,
                vec![],
                json!({"kind":"bridge.set","origin":"https://source.example","source_definition":i + 1,"target":pub_id,"value":"managed"}),
            ));
        }
        let word = jvc_core::word_id(&json!({"language":"jbo","spelling":"banli"})).unwrap();
        let new_issuer = identity_from_seed(&[9u8; 32]);
        let new_pub = host_missing_body(
            format!("jve1:{:064x}", 80_000usize),
            &new_issuer,
            vec![],
            json!({"kind":"definition.publish","word":word,"language":"en","parents":[],"origin":"native"}),
        );
        let (fast, _, full_prepared) = compare_fast_and_full(&prepared, &new_pub);
        assert!(!fast.statistics().rebuilt);
        assert_tight_budgets_match(&prepared, &new_pub, &full_prepared);
    }

    /// The lookup indexes pick the publication that the old scan in
    /// ID order stopped at, including when several publications match.
    #[test]
    fn lookup_indexes_pick_the_first_matching_publication_in_id_order() {
        let mut prepared = witnessed_view();
        let word = jvc_core::word_id(&json!({"language":"jbo","spelling":"banli"})).unwrap();
        let rafsi_word = jvc_core::word_id(&json!({"language":"jbo","spelling":"klama"})).unwrap();
        let issuer = identity_from_seed(&[1u8; 32]);
        // Three claims of one pair and one of another.
        let pairs = [
            format!("jvr1:{:064x}", 7usize),
            format!("jvr1:{:064x}", 8usize),
        ];
        for (i, pair) in [&pairs[0], &pairs[1], &pairs[0], &pairs[0]]
            .into_iter()
            .enumerate()
        {
            prepared.add_host_verified_record(host_missing_body(
                format!("jve1:{:064x}", 500_009 - i),
                &issuer,
                vec![],
                json!({"kind":"rafsi.publish","word":rafsi_word,"assignment":pair,"origin":"native"}),
            ));
        }
        let claim_id = format!("jve1:{:064x}", 110_000usize);
        prepared.add_host_verified_record(host(
            claim_id.clone(),
            &issuer,
            vec![],
            json!({"kind":"account.set","origin":"https://source.example","account":41,"value":"claim","previous":null,"carry":[]}),
        ));
        observe(&mut prepared, 10, 1, &claim_id);
        observe(&mut prepared, 11, 1, &claim_id);
        // Imported definitions credited to the account: three share
        // source record 1, one has record 2, and one is in another
        // language.
        for (seed, record, language) in [
            (9u8, 1u64, "en"),
            (12, 1, "en"),
            (13, 1, "en"),
            (14, 2, "en"),
            (15, 1, "fr"),
        ] {
            let mut body: Value = serde_json::from_str(include_str!(
                "../../jvc-core/tests/fixtures/definition.json"
            ))
            .unwrap();
            body["language"] = json!(language);
            body["legacy"] = json!({"source":"fixture","snapshot":"sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","extraction":"fixture-v1","record":{"kind":"definition","id":record},"locator":"fixture","original":{},"attribution":{"author":"author","editor":null,"author_account":{"origin":"https://source.example","account":41,"username":"author","evidence":{"kind":"source-id","source":{"label":"source author numeric field","url":null,"event":null,"locator":"author_id"}}},"dates":{}},"conversion":{"method":"literal","tool":"fixture","version":"1","model":null,"review":"unreviewed","mappings":[],"warnings":[]},"limitations":[]});
            let (imported, bytes) = event(
                seed,
                9,
                json!({"kind":"definition.publish","word":word,"language":language,"parents":[],"origin":"import"}),
                Some(body),
            );
            prepared.add_record(&imported, bytes.as_deref());
        }
        let state = prepared.into_state();
        assert!(state.evaluation().available);
        let graph = state.graph.as_ref().unwrap();
        let result = state.evaluation();

        // The scans as they were, stopping at the first match.
        let assignment_scan = |target: &str| {
            result
                .publications
                .values()
                .find(|p| p.assignment.as_deref() == Some(target))
                .map(|p| p.id.clone())
        };
        let bridge_scan = |key: &crate::BridgeKey| {
            result
                .publications
                .values()
                .find(|p| {
                    p.imported
                        && p.kind == "definition.publish"
                        && p.source_record == key.source_record
                        && p.word == key.word
                        && p.language == key.language
                        && p.account
                            .as_ref()
                            .filter(|a| a.origin == key.origin)
                            .and_then(|a| result.accounts.get(&a.token()))
                            .is_some_and(|a| {
                                a.commands
                                    && a.controller_identity
                                        .as_deref()
                                        .is_some_and(|k| graph.actor(k) == key.actor)
                            })
                })
                .map(|p| p.id.clone())
        };

        let assignments = crate::assignment_index(&result.publications);
        assert_eq!(assignments.len(), 2);
        for pair in pairs.iter().chain([&format!("jvr1:{:064x}", 9usize)]) {
            assert_eq!(assignments.get(pair).cloned(), assignment_scan(pair));
        }
        assert_eq!(
            assignments[&pairs[0]],
            format!("jve1:{:064x}", 500_006usize)
        );

        let bridges = crate::bridge_source_index(graph, result);
        // Records 1 and 2 in English, and record 1 in French.
        assert_eq!(bridges.len(), 3);
        let mut ties = 0;
        for (key, id) in &bridges {
            assert_eq!(Some(id.clone()), bridge_scan(key));
            let matches = result
                .publications
                .values()
                .filter(|p| {
                    p.imported && p.source_record == key.source_record && p.language == key.language
                })
                .count();
            if matches > 1 {
                ties += 1;
            }
        }
        assert_eq!(ties, 1);
        // Keys that no publication has: another actor, origin, record,
        // word or language.
        let (key, _) = bridges.iter().next().unwrap();
        let other = |change: &dyn Fn(&mut crate::BridgeKey)| {
            let mut key = crate::BridgeKey {
                source_record: key.source_record,
                word: key.word.clone(),
                language: key.language.clone(),
                origin: key.origin.clone(),
                actor: key.actor.clone(),
            };
            change(&mut key);
            key
        };
        for missing in [
            other(&|k| k.actor = identity_from_seed(&[2u8; 32])),
            other(&|k| k.origin = "https://other.example".into()),
            other(&|k| k.source_record = Some(3)),
            other(&|k| k.source_record = None),
            other(&|k| k.word = String::new()),
            other(&|k| k.language = None),
        ] {
            assert_eq!(bridges.get(&missing), None);
            assert_eq!(bridge_scan(&missing), None);
        }
    }

    #[test]
    fn fast_append_native_publication_around_matched_rafsi_and_bridge_targets_matches_full() {
        let mut prepared = witnessed_view();
        let word = jvc_core::word_id(&json!({"language":"jbo","spelling":"banli"})).unwrap();
        let rafsi_word = jvc_core::word_id(&json!({"language":"jbo","spelling":"klama"})).unwrap();
        let rafsi_target = format!("jvr1:{:064x}", 7usize);
        let issuer = identity_from_seed(&[1u8; 32]);
        let rafsi_pub_id = format!("jve1:{:064x}", 500_000usize);
        prepared.add_host_verified_record(host_missing_body(
            rafsi_pub_id,
            &issuer,
            vec![],
            json!({"kind":"rafsi.publish","word":rafsi_word,"assignment":rafsi_target,"origin":"native"}),
        ));
        let native_target_id = format!("jve1:{:064x}", 100_000usize);
        prepared.add_host_verified_record(host_missing_body(
            native_target_id.clone(),
            &issuer,
            vec![],
            json!({"kind":"definition.publish","word":word,"language":"en","parents":[],"origin":"native"}),
        ));
        let claim_id = format!("jve1:{:064x}", 110_000usize);
        prepared.add_host_verified_record(host(
            claim_id.clone(),
            &issuer,
            vec![],
            json!({"kind":"account.set","origin":"https://source.example","account":41,"value":"claim","previous":null,"carry":[]}),
        ));
        observe(&mut prepared, 10, 1, &claim_id);
        observe(&mut prepared, 11, 1, &claim_id);
        let mut import_body: Value = serde_json::from_str(include_str!(
            "../../jvc-core/tests/fixtures/definition.json"
        ))
        .unwrap();
        import_body["legacy"] = json!({"source":"fixture","snapshot":"sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","extraction":"fixture-v1","record":{"kind":"definition","id":1},"locator":"fixture","original":{},"attribution":{"author":"author","editor":null,"author_account":{"origin":"https://source.example","account":41,"username":"author","evidence":{"kind":"source-id","source":{"label":"source author numeric field","url":null,"event":null,"locator":"author_id"}}},"dates":{}},"conversion":{"method":"literal","tool":"fixture","version":"1","model":null,"review":"unreviewed","mappings":[],"warnings":[]},"limitations":[]});
        let (imported_pub, imported_bytes) = event(
            9,
            9,
            json!({"kind":"definition.publish","word":word,"language":"en","parents":[],"origin":"import"}),
            Some(import_body),
        );
        prepared.add_record(&imported_pub, imported_bytes.as_deref());
        for i in 0..8usize {
            prepared.add_host_verified_record(host(
                format!("jve1:{:064x}", 120_000 + i),
                &issuer,
                vec![],
                json!({"kind":"bridge.set","origin":"https://source.example","source_definition":1,"target":native_target_id,"value":"managed"}),
            ));
        }
        let judge = identity_from_seed(&[5u8; 32]);
        let mut judge_prev = Vec::new();
        for i in 0..8usize {
            let id = format!("jve1:{:064x}", 130_000 + i);
            prepared.add_host_verified_record(host(
                id.clone(),
                &judge,
                judge_prev,
                json!({"kind":"judgment.set","target":rafsi_target,"value":"bless"}),
            ));
            judge_prev = vec![id];
        }

        // Append one more `jvr1:` judgment on the fast path, then append native
        // publications with IDs sorting before and after the matched publications,
        // both directly and after checkpoint restoration.
        let appended_judgment = host(
            format!("jve1:{:064x}", 130_100usize),
            &judge,
            judge_prev,
            json!({"kind":"judgment.set","target":rafsi_target,"value":"curse"}),
        );
        let (mut after_judgment, _, mut after_judgment_prepared) =
            compare_fast_and_full(&prepared, &appended_judgment);
        assert!(!after_judgment.statistics().rebuilt);

        for (pub_id, new_seed) in [
            (format!("jve1:{:064x}", 1usize), 21u8),
            (format!("jve1:{:064x}", 400_000usize), 22u8),
            (format!("jve1:f{:063x}", 1usize), 23u8),
        ] {
            let new_issuer = identity_from_seed(&[new_seed; 32]);
            let new_pub = host_missing_body(
                pub_id,
                &new_issuer,
                vec![],
                json!({"kind":"definition.publish","word":word,"language":"en","parents":[native_target_id.clone(), imported_pub.id()],"origin":"native"}),
            );
            let mut delta = PreparedEvaluationInput::new(after_judgment_prepared.options.clone());
            delta.add_host_verified_record(new_pub.clone());
            let saved = after_judgment.checkpoint("host-checked").unwrap();
            let direct = after_judgment.advance(delta.clone(), &[]);
            assert!(!direct.statistics().rebuilt);

            let restored = EvaluatedState::restore_host_checkpoint(&saved, "host-checked").unwrap();
            let from_restored = restored.advance(delta, &[]);
            assert!(!from_restored.statistics().rebuilt);

            let mut expected = after_judgment_prepared.clone();
            expected.add_host_verified_record(new_pub.clone());
            assert_matches_full(&direct, &expected);
            assert_matches_full(&from_restored, &expected);
            assert_tight_budgets_match(&after_judgment_prepared, &new_pub, &expected);
            after_judgment = direct;
            after_judgment_prepared = expected;
        }
    }

    #[test]
    fn checkpoint_requires_every_field_and_refuses_removed_publication_scan_fields() {
        let prepared = base();
        let mut records = Vec::new();
        for node in prepared.nodes.values() {
            records.push(HostVerifiedRecord { node: node.clone() });
        }
        let state = prepared.into_state();
        let full_bytes = state.checkpoint("host-checked").unwrap();
        let result_bytes = state.result_checkpoint("host-checked").unwrap();

        let full_json: Value = serde_json::from_slice(&full_bytes).unwrap();
        let result_json: Value = serde_json::from_slice(&result_bytes).unwrap();
        assert_eq!(full_json["version"], json!("jvc-evaluation-checkpoint-v10"));
        assert_eq!(result_json["version"], json!("jvc-evaluation-results-v10"));
        assert!(result_json.get("nodes").is_none());
        // The v8 publication scan counts are gone. A checkpoint that
        // still carries them, or names the v8 version, is refused.
        for (json, is_results) in [(&full_json, false), (&result_json, true)] {
            assert!(json.get("unmatched_publication_scans").is_none());
            assert!(json.get("matched_publication_scans").is_none());
            let mut with_counts = json.clone();
            with_counts["unmatched_publication_scans"] = json!(0);
            with_counts["matched_publication_scans"] = json!({});
            let mut old_version = json.clone();
            old_version["version"] = json!(if is_results {
                "jvc-evaluation-results-v8"
            } else {
                "jvc-evaluation-checkpoint-v8"
            });
            // Each case is sealed with a fresh digest, so only the
            // case itself can make the restore fail.
            for (case, mutated) in [
                ("unchanged", json.clone()),
                ("with_counts", with_counts),
                ("old_version", old_version),
            ] {
                let mut mutated = mutated;
                mutated.as_object_mut().unwrap().remove("digest");
                let mut bytes = serde_json::to_vec(&mutated).unwrap();
                let digest = jvc_core::hash_id("sha256:", b"", &bytes);
                bytes.pop();
                bytes.extend_from_slice(format!(",\"digest\":\"{digest}\"}}").as_bytes());
                let restored = if is_results {
                    EvaluatedState::restore_host_result_checkpoint(
                        &bytes,
                        "host-checked",
                        records.clone(),
                    )
                } else {
                    EvaluatedState::restore_host_checkpoint(&bytes, "host-checked")
                };
                assert_eq!(
                    restored.is_ok(),
                    case == "unchanged",
                    "case={case} is_results={is_results}"
                );
            }
        }

        for field in [
            "options.selected_view",
            "options.import_selections",
            "options.overlay",
            "options.limits",
        ] {
            let mut mutated = full_json.clone();
            if let Some(sub) = field.strip_prefix("options.") {
                mutated["options"].as_object_mut().unwrap().remove(sub);
            } else {
                mutated.as_object_mut().unwrap().remove(field);
            }
            let bytes = serde_json::to_vec(&mutated).unwrap();
            assert!(
                EvaluatedState::restore_host_checkpoint(&bytes, "host-checked").is_err(),
                "missing {field} in full checkpoint must be rejected"
            );

            let mut mutated_res = result_json.clone();
            if let Some(sub) = field.strip_prefix("options.") {
                mutated_res["options"].as_object_mut().unwrap().remove(sub);
            } else {
                mutated_res.as_object_mut().unwrap().remove(field);
            }
            let res_bytes = serde_json::to_vec(&mutated_res).unwrap();
            assert!(
                EvaluatedState::restore_host_result_checkpoint(
                    &res_bytes,
                    "host-checked",
                    records.clone()
                )
                .is_err(),
                "missing {field} in result checkpoint must be rejected"
            );
        }
    }

    #[test]
    fn checkpoint_without_evaluation_policy_is_rejected_and_tight_budget_refuses() {
        let word = jvc_core::word_id(&json!({"language":"jbo","spelling":"banli"})).unwrap();
        let new_issuer = identity_from_seed(&[9u8; 32]);
        let new_pub = host_missing_body(
            format!("jve1:{:064x}", 40_000usize),
            &new_issuer,
            vec![],
            json!({"kind":"definition.publish","word":word,"language":"en","parents":[],"origin":"native"}),
        );

        // Case A: 20 `jve1:` judgments at tight budget 266 (base consumes 247, full consumes 267 -> refuses at 266).
        let mut jve_prepared = base();
        let pub_id = format!("jve1:{:064x}", 10_000usize);
        let pub_issuer = identity_from_seed(&[1u8; 32]);
        jve_prepared.add_host_verified_record(host_missing_body(
            pub_id.clone(),
            &pub_issuer,
            vec![],
            json!({"kind":"definition.publish","word":word,"language":"en","parents":[],"origin":"native"}),
        ));
        let judge = identity_from_seed(&[5u8; 32]);
        for i in 0..20usize {
            jve_prepared.add_host_verified_record(host(
                format!("jve1:{:064x}", 30_000 + i),
                &judge,
                vec![],
                json!({"kind":"judgment.set","target":pub_id,"value":"bless"}),
            ));
        }
        jve_prepared.options.limits.traversal = Some(266);

        // Case B: 20 unresolved `jvr1:` judgments at tight budget 198 (base consumes 190, full consumes 199 -> refuses at 198).
        let mut jvr_prepared = base();
        let rafsi_target = format!("jvr1:{:064x}", 1usize);
        for i in 0..20usize {
            jvr_prepared.add_host_verified_record(host(
                format!("jve1:{:064x}", 30_000 + i),
                &judge,
                vec![],
                json!({"kind":"judgment.set","target":rafsi_target,"value":"bless"}),
            ));
        }
        jvr_prepared.options.limits.traversal = Some(198);

        let mut failures = Vec::new();
        for (label, prepared, expected_base_work, expected_tight_work) in [
            ("jve1_judgments_266", jve_prepared, 258usize, 266usize),
            ("jvr1_judgments_198", jvr_prepared, 190usize, 198usize),
        ] {
            let records: Vec<HostVerifiedRecord> = prepared
                .nodes
                .values()
                .map(|node| HostVerifiedRecord { node: node.clone() })
                .collect();
            let state = prepared.clone().into_state();
            assert!(state.evaluation().available);
            assert_eq!(state.consumed_work(), expected_base_work);

            let mut full_prepared = prepared.clone();
            full_prepared.add_host_verified_record(new_pub.clone());
            let full = full_prepared.into_state();
            assert!(!full.evaluation().available);
            assert_eq!(full.consumed_work(), expected_tight_work);
            assert_whole_evaluation_refusal(full.evaluation());

            let mut delta = PreparedEvaluationInput::new(prepared.options.clone());
            delta.add_host_verified_record(new_pub.clone());

            let saved_full = state.checkpoint("host-checked").unwrap();
            let saved_results = state.result_checkpoint("host-checked").unwrap();
            for mutation in ["delete_policy", "null_policy"] {
                for (is_results, raw) in [(false, &saved_full), (true, &saved_results)] {
                    let mut value: Value = serde_json::from_slice(raw).unwrap();
                    if mutation == "delete_policy" {
                        value["evaluation"]
                            .as_object_mut()
                            .unwrap()
                            .remove("policy");
                    } else {
                        value["evaluation"]["policy"] = Value::Null;
                    }
                    let bytes = serde_json::to_vec(&value).unwrap();
                    let restored = if is_results {
                        EvaluatedState::restore_host_result_checkpoint(
                            &bytes,
                            "host-checked",
                            records.clone(),
                        )
                    } else {
                        EvaluatedState::restore_host_checkpoint(&bytes, "host-checked")
                    };
                    let err_flag = restored.is_err();
                    let base_or_rebuilt =
                        restored.unwrap_or_else(|_| prepared.clone().into_state());
                    let fast = base_or_rebuilt.advance(delta.clone(), &[]);
                    if !err_flag
                        || fast.evaluation().available
                        || fast.consumed_work() != full.consumed_work()
                    {
                        failures.push(format!(
                            "{label} mutation={mutation} is_results={is_results}: restore_err={err_flag} fast_available={} fast_work={} full_work={}",
                            fast.evaluation().available,
                            fast.consumed_work(),
                            full.consumed_work()
                        ));
                    }
                }
            }
        }
        assert!(
            failures.is_empty(),
            "policy regression failures ({}):\n{}",
            failures.len(),
            failures.join("\n")
        );
    }

    #[test]
    fn checkpoint_without_limits_traversal_is_rejected_on_restore_and_options_parse() {
        let word = jvc_core::word_id(&json!({"language":"jbo","spelling":"banli"})).unwrap();
        let new_issuer = identity_from_seed(&[9u8; 32]);
        let new_pub = host_missing_body(
            format!("jve1:{:064x}", 40_000usize),
            &new_issuer,
            vec![],
            json!({"kind":"definition.publish","word":word,"language":"en","parents":[],"origin":"native"}),
        );

        let mut prepared = base();
        let rafsi_target = format!("jvr1:{:064x}", 1usize);
        let judge = identity_from_seed(&[5u8; 32]);
        for i in 0..20usize {
            prepared.add_host_verified_record(host(
                format!("jve1:{:064x}", 30_000 + i),
                &judge,
                vec![],
                json!({"kind":"judgment.set","target":rafsi_target,"value":"bless"}),
            ));
        }
        prepared.options.limits = Limits {
            events: Some(500),
            traversal: Some(198),
            claim_depth: 64,
        };
        let records: Vec<HostVerifiedRecord> = prepared
            .nodes
            .values()
            .map(|node| HostVerifiedRecord { node: node.clone() })
            .collect();
        let state = prepared.clone().into_state();
        assert!(state.evaluation().available);
        assert_eq!(state.consumed_work(), 190);

        let mut full_prepared = prepared.clone();
        full_prepared.add_host_verified_record(new_pub.clone());
        let full = full_prepared.into_state();
        assert!(!full.evaluation().available);
        assert_eq!(full.consumed_work(), 198);

        let saved_full = state.checkpoint("host-checked").unwrap();
        let saved_results = state.result_checkpoint("host-checked").unwrap();
        let mut failures = Vec::new();
        for mutation in [
            "delete_traversal",
            "delete_events",
            "delete_claim_depth",
            "null_traversal",
        ] {
            for (is_results, raw) in [(false, &saved_full), (true, &saved_results)] {
                let mut value: Value = serde_json::from_slice(raw).unwrap();
                match mutation {
                    "delete_traversal" => {
                        value["options"]["limits"]
                            .as_object_mut()
                            .unwrap()
                            .remove("traversal");
                    }
                    "delete_events" => {
                        value["options"]["limits"]
                            .as_object_mut()
                            .unwrap()
                            .remove("events");
                    }
                    "delete_claim_depth" => {
                        value["options"]["limits"]
                            .as_object_mut()
                            .unwrap()
                            .remove("claim_depth");
                    }
                    "null_traversal" => {
                        value["options"]["limits"]["traversal"] = Value::Null;
                    }
                    _ => unreachable!(),
                }
                if mutation.starts_with("delete_") {
                    let parsed_opts =
                        serde_json::from_value::<EvaluationOptions>(value["options"].clone());
                    if parsed_opts.is_ok() {
                        failures.push(format!(
                            "EvaluationOptions::deserialize accepted {mutation} (is_results={is_results})"
                        ));
                    }
                }
                let bytes = serde_json::to_vec(&value).unwrap();
                let restored = if is_results {
                    EvaluatedState::restore_host_result_checkpoint(
                        &bytes,
                        "host-checked",
                        records.clone(),
                    )
                } else {
                    EvaluatedState::restore_host_checkpoint(&bytes, "host-checked")
                };
                match restored {
                    Err(_) => {}
                    Ok(restored_state) => {
                        let mut delta =
                            PreparedEvaluationInput::new(restored_state.prepared.options.clone());
                        delta.add_host_verified_record(new_pub.clone());
                        let advanced = restored_state.advance(delta, &[]);
                        failures.push(format!(
                            "restore accepted {mutation} (is_results={is_results}): advanced available={} consumed_work={} remaining_work={}",
                            advanced.evaluation().available,
                            advanced.consumed_work(),
                            advanced.remaining_work
                        ));
                    }
                }
            }
        }
        assert!(
            failures.is_empty(),
            "limits regression failures ({}):\n{}",
            failures.len(),
            failures.join("\n")
        );
    }

    #[derive(Clone, Debug)]
    enum JsonStep {
        Key(String),
        Index(usize),
    }

    fn format_json_path(path: &[JsonStep]) -> String {
        let mut out = String::new();
        for step in path {
            match step {
                JsonStep::Key(k) => {
                    if !out.is_empty() {
                        out.push('.');
                    }
                    out.push_str(k);
                }
                JsonStep::Index(i) => {
                    out.push_str(&format!("[{i}]"));
                }
            }
        }
        out
    }

    fn collect_json_paths(
        value: &Value,
        prefix: &mut Vec<JsonStep>,
        key_paths: &mut Vec<Vec<JsonStep>>,
        non_null_paths: &mut Vec<Vec<JsonStep>>,
    ) {
        match value {
            Value::Object(map) => {
                for (k, v) in map {
                    prefix.push(JsonStep::Key(k.clone()));
                    key_paths.push(prefix.clone());
                    if !v.is_null() {
                        non_null_paths.push(prefix.clone());
                    }
                    collect_json_paths(v, prefix, key_paths, non_null_paths);
                    prefix.pop();
                }
            }
            Value::Array(items) => {
                for (i, item) in items.iter().enumerate() {
                    prefix.push(JsonStep::Index(i));
                    collect_json_paths(item, prefix, key_paths, non_null_paths);
                    prefix.pop();
                }
            }
            _ => {}
        }
    }

    fn remove_at_json_path(root: &mut Value, path: &[JsonStep]) {
        let (last, parents) = path.split_last().unwrap();
        let mut cursor = root;
        for step in parents {
            cursor = match step {
                JsonStep::Key(k) => cursor.get_mut(k).unwrap(),
                JsonStep::Index(i) => cursor.get_mut(*i).unwrap(),
            };
        }
        if let JsonStep::Key(k) = last {
            cursor.as_object_mut().unwrap().remove(k);
        }
    }

    fn null_at_json_path(root: &mut Value, path: &[JsonStep]) {
        let mut cursor = root;
        for step in path {
            cursor = match step {
                JsonStep::Key(k) => cursor.get_mut(k).unwrap(),
                JsonStep::Index(i) => cursor.get_mut(*i).unwrap(),
            };
        }
        *cursor = Value::Null;
    }

    fn rich_checkpoint_fixture() -> (PreparedEvaluationInput, HostVerifiedRecord) {
        let word = jvc_core::word_id(&json!({"language":"jbo","spelling":"banli"})).unwrap();
        let mut import_body: Value = serde_json::from_str(include_str!(
            "../../jvc-core/tests/fixtures/definition.json"
        ))
        .unwrap();
        import_body["legacy"] = json!({
            "source":"fixture",
            "snapshot":"sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            "extraction":"fixture-v1",
            "record":{"kind":"definition","id":1},
            "locator":"fixture",
            "original":{},
            "attribution":{
                "author":"author",
                "editor":null,
                "author_account":{
                    "origin":"https://source.example",
                    "account":41,
                    "username":"author",
                    "evidence":{
                        "kind":"source-id",
                        "source":{"label":"source author numeric field","url":null,"event":null,"locator":"author_id"}
                    }
                },
                "dates":{}
            },
            "conversion":{"method":"literal","tool":"fixture","version":"1","model":null,"review":"unreviewed","mappings":[],"warnings":[]},
            "limitations":[]
        });
        let (imported_pub, imported_bytes) = event(
            9,
            9,
            json!({"kind":"definition.publish","word":word,"language":"en","parents":[],"origin":"import"}),
            Some(import_body),
        );
        let sel_ids = vec![imported_pub.id().to_string()];
        let sel_bytes = jvc_core::canonical_value(&json!(sel_ids)).unwrap();
        let sel_hash = jvc_core::hash_id("sha256:", b"", &sel_bytes);

        let (view, view_body) = event(
            1,
            77,
            json!({"kind":"view.publish","parents":[]}),
            Some(json!({
                "name":"fixture",
                "description":[],
                "roots":[{"identity":identity_from_seed(&[1;32]),"q":{"numerator":1,"denominator":1}}],
                "rafsi_threshold":{"numerator":1,"denominator":1},
                "H":{"numerator":3,"denominator":1},
                "alpha":{"numerator":1,"denominator":2},
                "excluded":[{"identity":identity_from_seed(&[4;32]),"evidence":[imported_pub.id()]}],
                "calculation":"simple-routes-bounds-v1",
                "work":1000,
                "import_sets":[{"source":"fixture","importer":identity_from_seed(&[9;32]),"selection":sel_hash}],
                "account_witnesses":[identity_from_seed(&[10;32]),identity_from_seed(&[11;32])],
                "account_authority":true,
                "notes":[]
            })),
        );
        let overlay = json!({
            "version":2,
            "base_view":view.id(),
            "public_shun_issuer":identity_from_seed(&[1;32]),
            "root_changes":[{"identity":identity_from_seed(&[2;32]),"q":{"numerator":1,"denominator":2}}],
            "trust":[{"issuer":identity_from_seed(&[1;32]),"subject":identity_from_seed(&[2;32]),"scope":{"kind":"*","word":"*","language":"*"},"value":"heed","weight":{"numerator":1,"denominator":1}}],
            "blocked":[{"identity":identity_from_seed(&[3;32]),"scope":{"kind":"*","word":"*","language":"*"}}],
            "work":500
        });
        let mut prepared = PreparedEvaluationInput::new(EvaluationOptions {
            selected_view: view.id().into(),
            import_selections: BTreeMap::from([(sel_hash, sel_ids)]),
            overlay: Some(overlay.into()),
            limits: Limits {
                events: Some(500),
                traversal: Some(10_000),
                claim_depth: 64,
            },
        });
        prepared.add_record(&view, view_body.as_deref());

        let native_def: Value = serde_json::from_str(include_str!(
            "../../jvc-core/tests/fixtures/definition.json"
        ))
        .unwrap();
        let (native_pub, native_pub_body) = event(
            1,
            2,
            json!({"kind":"definition.publish","word":word,"language":"en","parents":[],"origin":"native"}),
            Some(jvc_core::omit_definition_defaults(&native_def)),
        );
        let native_pub_id = native_pub.id().to_string();
        prepared.add_record(&native_pub, native_pub_body.as_deref());
        prepared.add_record(&imported_pub, imported_bytes.as_deref());

        let issuer = identity_from_seed(&[1u8; 32]);
        let native_missing_id = format!("jve1:{:064x}", 10_001usize);
        prepared.add_host_verified_record(host_missing_body(
            native_missing_id,
            &issuer,
            vec![],
            json!({"kind":"definition.publish","word":word,"language":"en","parents":[native_pub_id.clone()],"origin":"native"}),
        ));

        let rafsi_word = jvc_core::word_id(&json!({"language":"jbo","spelling":"klama"})).unwrap();
        let rafsi_target = format!("jvr1:{:064x}", 7usize);
        let rafsi_pub_id = format!("jve1:{:064x}", 10_002usize);
        prepared.add_host_verified_record(host_missing_body(
            rafsi_pub_id,
            &issuer,
            vec![],
            json!({"kind":"rafsi.publish","word":rafsi_word,"assignment":rafsi_target,"origin":"native"}),
        ));

        let claim_id = format!("jve1:{:064x}", 10_010usize);
        prepared.add_host_verified_record(host(
            claim_id.clone(),
            &issuer,
            vec![],
            json!({"kind":"account.set","origin":"https://source.example","account":41,"value":"claim","previous":null,"carry":[]}),
        ));
        observe(&mut prepared, 10, 1, &claim_id);
        observe(&mut prepared, 11, 1, &claim_id);

        let import_status_id = format!("jve1:{:064x}", 10_011usize);
        prepared.add_host_verified_record(host(
            import_status_id,
            &issuer,
            vec![claim_id.clone()],
            json!({"kind":"import.status","target":imported_pub.id(),"claim":claim_id,"value":"active"}),
        ));

        let judge = identity_from_seed(&[5u8; 32]);
        prepared.add_host_verified_record(host(
            format!("jve1:{:064x}", 10_020usize),
            &judge,
            vec![],
            json!({"kind":"judgment.set","target":native_pub_id,"value":"bless"}),
        ));
        prepared.add_host_verified_record(host(
            format!("jve1:{:064x}", 10_021usize),
            &judge,
            vec![],
            json!({"kind":"judgment.set","target":rafsi_target,"value":"bless"}),
        ));
        let unmatched_rafsi = format!("jvr1:{:064x}", 99usize);
        prepared.add_host_verified_record(host(
            format!("jve1:{:064x}", 10_022usize),
            &judge,
            vec![],
            json!({"kind":"judgment.set","target":unmatched_rafsi,"value":"curse"}),
        ));

        let (trust_ev, trust_body) = event(
            2,
            20,
            json!({"kind":"trust.set","subject":identity_from_seed(&[12;32]),"scope":{"kind":"*","word":"*","language":"*"},"value":"heed"}),
            None,
        );
        prepared.add_record(&trust_ev, trust_body.as_deref());

        let old_actor = identity_from_seed(&[14u8; 32]);
        let new_actor = identity_from_seed(&[15u8; 32]);
        let transfer_id = format!("jve1:{:064x}", 10_030usize);
        let accept_id = format!("jve1:{:064x}", 10_031usize);
        prepared.add_host_verified_record(host(
            transfer_id.clone(),
            &old_actor,
            vec![],
            json!({"kind":"identity.transfer","successor":new_actor}),
        ));
        prepared.add_host_verified_record(host(
            accept_id,
            &new_actor,
            vec![],
            json!({"kind":"identity.accept","transfer":transfer_id}),
        ));

        let suspended_actor = identity_from_seed(&[16u8; 32]);
        prepared.add_host_verified_record(host(
            format!("jve1:{:064x}", 10_040usize),
            &suspended_actor,
            vec![format!("jve1:{:064x}", 999_999usize)],
            json!({"kind":"identity.merge"}),
        ));

        let appended_issuer = identity_from_seed(&[25u8; 32]);
        let appended_pub = host_missing_body(
            format!("jve1:{:064x}", 5usize),
            &appended_issuer,
            vec![],
            json!({"kind":"definition.publish","word":word,"language":"en","parents":[],"origin":"native"}),
        );
        (prepared, appended_pub)
    }

    #[test]
    fn checkpoint_key_deletion_and_null_mutation_reject_or_rebuild_matching_full() {
        let (mut prepared_open, appended_pub) = rich_checkpoint_fixture();
        let state_open = prepared_open.clone().into_state();
        assert!(state_open.evaluation().available);
        assert!(state_open.evaluation().policy.is_some());
        assert!(state_open.evaluation().overlay.is_some());
        assert!(!state_open.evaluation().registers.is_empty());
        assert!(!state_open.rafsi_assignments.is_empty());
        assert!(!state_open.evaluation().accounts.is_empty());
        assert!(!state_open.evaluation().publications.is_empty());
        assert!(!state_open.evaluation().trust.is_empty());
        assert!(!state_open.evaluation().selections.is_empty());

        let mut full_open_prepared = prepared_open.clone();
        full_open_prepared.add_host_verified_record(appended_pub.clone());
        let full_open = full_open_prepared.into_state();
        assert!(full_open.evaluation().available);
        let exact_limit = full_open.consumed_work();
        let tight_limit = exact_limit - 1;

        let mut prepared_exact = prepared_open.clone();
        prepared_exact.options.limits.traversal = Some(exact_limit);
        let state_exact = prepared_exact.clone().into_state();
        assert!(state_exact.evaluation().available);
        let mut full_exact_prepared = prepared_exact.clone();
        full_exact_prepared.add_host_verified_record(appended_pub.clone());
        let full_exact = full_exact_prepared.into_state();
        assert!(full_exact.evaluation().available);
        let full_exact_json = serde_json::to_value(full_exact.evaluation()).unwrap();

        prepared_open.options.limits.traversal = Some(tight_limit);
        let prepared_tight = prepared_open;
        let state_tight = prepared_tight.clone().into_state();
        assert!(state_tight.evaluation().available);

        let mut full_tight_prepared = prepared_tight.clone();
        full_tight_prepared.add_host_verified_record(appended_pub.clone());
        let full_tight = full_tight_prepared.into_state();
        assert!(!full_tight.evaluation().available);
        assert_whole_evaluation_refusal(full_tight.evaluation());
        let full_tight_json = serde_json::to_value(full_tight.evaluation()).unwrap();

        let records: Vec<HostVerifiedRecord> = prepared_tight
            .nodes
            .values()
            .map(|node| HostVerifiedRecord { node: node.clone() })
            .collect();

        let saved_exact_full = state_exact.checkpoint("host-checked").unwrap();
        let saved_exact_results = state_exact.result_checkpoint("host-checked").unwrap();
        let saved_tight_full = state_tight.checkpoint("host-checked").unwrap();
        let saved_tight_results = state_tight.result_checkpoint("host-checked").unwrap();

        assert!(EvaluatedState::restore_host_checkpoint(&saved_exact_full, "host-checked").is_ok());
        assert!(
            EvaluatedState::restore_host_result_checkpoint(
                &saved_exact_results,
                "host-checked",
                records.clone(),
            )
            .is_ok()
        );
        assert!(EvaluatedState::restore_host_checkpoint(&saved_tight_full, "host-checked").is_ok());
        assert!(
            EvaluatedState::restore_host_result_checkpoint(
                &saved_tight_results,
                "host-checked",
                records.clone(),
            )
            .is_ok()
        );

        let mut deleted_paths_checked = 0usize;
        let mut deleted_rejected = 0usize;
        let mut deleted_rebuilt = 0usize;
        let mut nulled_paths_checked = 0usize;
        let mut nulled_rejected = 0usize;
        let mut nulled_rebuilt = 0usize;
        let mut failures = Vec::new();
        reset_digest_rejections();

        for (is_results, raw_exact, raw_tight) in [
            (false, &saved_exact_full, &saved_tight_full),
            (true, &saved_exact_results, &saved_tight_results),
        ] {
            let root_exact: Value = serde_json::from_slice(raw_exact).unwrap();
            let root_tight: Value = serde_json::from_slice(raw_tight).unwrap();
            let mut key_paths = Vec::new();
            let mut non_null_paths = Vec::new();
            collect_json_paths(
                &root_tight,
                &mut Vec::new(),
                &mut key_paths,
                &mut non_null_paths,
            );

            for path in &key_paths {
                deleted_paths_checked += 1;
                let mut mutated_exact = root_exact.clone();
                remove_at_json_path(&mut mutated_exact, path);
                let bytes_exact = serde_json::to_vec(&mutated_exact).unwrap();
                let restored_exact = if is_results {
                    EvaluatedState::restore_host_result_checkpoint(
                        &bytes_exact,
                        "host-checked",
                        records.clone(),
                    )
                } else {
                    EvaluatedState::restore_host_checkpoint(&bytes_exact, "host-checked")
                };

                let mut mutated_tight = root_tight.clone();
                remove_at_json_path(&mut mutated_tight, path);
                let bytes_tight = serde_json::to_vec(&mutated_tight).unwrap();
                let restored_tight = if is_results {
                    EvaluatedState::restore_host_result_checkpoint(
                        &bytes_tight,
                        "host-checked",
                        records.clone(),
                    )
                } else {
                    EvaluatedState::restore_host_checkpoint(&bytes_tight, "host-checked")
                };

                match (restored_exact, restored_tight) {
                    (Err(_), Err(_)) => {
                        deleted_rejected += 1;
                    }
                    (Ok(state_e), Ok(state_t)) => {
                        let outcome =
                            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                let mut delta_e = PreparedEvaluationInput::new(
                                    prepared_exact.options_with_selections(),
                                );
                                delta_e.add_host_verified_record(appended_pub.clone());
                                let adv_e = state_e.advance(delta_e, &[]);

                                let mut delta_t = PreparedEvaluationInput::new(
                                    prepared_tight.options_with_selections(),
                                );
                                delta_t.add_host_verified_record(appended_pub.clone());
                                let adv_t = state_t.advance(delta_t, &[]);

                                (adv_e, adv_t)
                            }));
                        match outcome {
                            Err(_) => {
                                failures.push(format!(
                                    "DELETE is_results={is_results} path={}: advance panicked",
                                    format_json_path(path),
                                ));
                            }
                            Ok((adv_e, adv_t)) => {
                                let ok_exact = adv_e.statistics().rebuilt
                                    && adv_e.evaluation().available
                                    && adv_e.consumed_work() == full_exact.consumed_work()
                                    && adv_e.remaining_work == full_exact.remaining_work
                                    && serde_json::to_value(adv_e.evaluation()).unwrap()
                                        == full_exact_json;
                                let ok_tight = adv_t.statistics().rebuilt
                                    && !adv_t.evaluation().available
                                    && adv_t.consumed_work() == full_tight.consumed_work()
                                    && adv_t.remaining_work == full_tight.remaining_work
                                    && serde_json::to_value(adv_t.evaluation()).unwrap()
                                        == full_tight_json;
                                if ok_exact && ok_tight {
                                    deleted_rebuilt += 1;
                                } else {
                                    failures.push(format!(
                                        "DELETE is_results={is_results} path={}: exact_rebuilt={} exact_ok={ok_exact} tight_rebuilt={} tight_avail={} tight_work={} vs {}",
                                        format_json_path(path),
                                        adv_e.statistics().rebuilt,
                                        adv_t.statistics().rebuilt,
                                        adv_t.evaluation().available,
                                        adv_t.consumed_work(),
                                        full_tight.consumed_work(),
                                    ));
                                }
                            }
                        }
                    }
                    (r_e, r_t) => {
                        failures.push(format!(
                            "DELETE is_results={is_results} path={}: inconsistent restore exact_err={} tight_err={}",
                            format_json_path(path),
                            r_e.is_err(),
                            r_t.is_err(),
                        ));
                    }
                }
            }

            for path in &non_null_paths {
                nulled_paths_checked += 1;
                let mut mutated_exact = root_exact.clone();
                null_at_json_path(&mut mutated_exact, path);
                let bytes_exact = serde_json::to_vec(&mutated_exact).unwrap();
                let restored_exact = if is_results {
                    EvaluatedState::restore_host_result_checkpoint(
                        &bytes_exact,
                        "host-checked",
                        records.clone(),
                    )
                } else {
                    EvaluatedState::restore_host_checkpoint(&bytes_exact, "host-checked")
                };

                let mut mutated_tight = root_tight.clone();
                null_at_json_path(&mut mutated_tight, path);
                let bytes_tight = serde_json::to_vec(&mutated_tight).unwrap();
                let restored_tight = if is_results {
                    EvaluatedState::restore_host_result_checkpoint(
                        &bytes_tight,
                        "host-checked",
                        records.clone(),
                    )
                } else {
                    EvaluatedState::restore_host_checkpoint(&bytes_tight, "host-checked")
                };

                match (restored_exact, restored_tight) {
                    (Err(_), Err(_)) => {
                        nulled_rejected += 1;
                    }
                    (Ok(state_e), Ok(state_t)) => {
                        let outcome =
                            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                let mut delta_e = PreparedEvaluationInput::new(
                                    prepared_exact.options_with_selections(),
                                );
                                delta_e.add_host_verified_record(appended_pub.clone());
                                let adv_e = state_e.advance(delta_e, &[]);

                                let mut delta_t = PreparedEvaluationInput::new(
                                    prepared_tight.options_with_selections(),
                                );
                                delta_t.add_host_verified_record(appended_pub.clone());
                                let adv_t = state_t.advance(delta_t, &[]);

                                (adv_e, adv_t)
                            }));
                        match outcome {
                            Err(_) => {
                                failures.push(format!(
                                    "NULL is_results={is_results} path={}: advance panicked",
                                    format_json_path(path),
                                ));
                            }
                            Ok((adv_e, adv_t)) => {
                                let ok_exact = adv_e.statistics().rebuilt
                                    && adv_e.evaluation().available
                                    && adv_e.consumed_work() == full_exact.consumed_work()
                                    && adv_e.remaining_work == full_exact.remaining_work
                                    && serde_json::to_value(adv_e.evaluation()).unwrap()
                                        == full_exact_json;
                                let ok_tight = adv_t.statistics().rebuilt
                                    && !adv_t.evaluation().available
                                    && adv_t.consumed_work() == full_tight.consumed_work()
                                    && adv_t.remaining_work == full_tight.remaining_work
                                    && serde_json::to_value(adv_t.evaluation()).unwrap()
                                        == full_tight_json;
                                if ok_exact && ok_tight {
                                    nulled_rebuilt += 1;
                                } else {
                                    failures.push(format!(
                                        "NULL is_results={is_results} path={}: exact_rebuilt={} exact_ok={ok_exact} tight_rebuilt={} tight_avail={} tight_work={} vs {}",
                                        format_json_path(path),
                                        adv_e.statistics().rebuilt,
                                        adv_t.statistics().rebuilt,
                                        adv_t.evaluation().available,
                                        adv_t.consumed_work(),
                                        full_tight.consumed_work(),
                                    ));
                                }
                            }
                        }
                    }
                    (r_e, r_t) => {
                        failures.push(format!(
                            "NULL is_results={is_results} path={}: inconsistent restore exact_err={} tight_err={}",
                            format_json_path(path),
                            r_e.is_err(),
                            r_t.is_err(),
                        ));
                    }
                }
            }
        }

        let digest_rejected = digest_rejections();
        eprintln!(
            "checkpoint_schema_audit: deleted_checked={deleted_paths_checked} (rejected={deleted_rejected}, rebuilt={deleted_rebuilt}), nulled_checked={nulled_paths_checked} (rejected={nulled_rejected}, rebuilt={nulled_rebuilt}), digest_rejected={digest_rejected}, failures={}",
            failures.len()
        );
        assert!(
            failures.is_empty()
                && deleted_rejected == deleted_paths_checked
                && nulled_rejected == nulled_paths_checked
                && digest_rejected == (deleted_paths_checked + nulled_paths_checked) * 2,
            "checkpoint schema audit must reject every key deletion and null mutation at digest check (deleted_rebuilt={deleted_rebuilt}, nulled_rebuilt={nulled_rebuilt}, digest_rejected={digest_rejected}, failures={}):\n{}",
            failures.len(),
            failures.join("\n")
        );
    }

    #[test]
    fn overlay_switch_keeps_fast_path_pricing_and_zero_view_restores() {
        let word = jvc_core::word_id(&json!({"language":"jbo","spelling":"banli"})).unwrap();
        let rafsi_target = format!("jvr1:{:064x}", 1usize);
        let judge = identity_from_seed(&[5u8; 32]);
        let new_issuer = identity_from_seed(&[8u8; 32]);
        let delta_pub = host_missing_body(
            format!("jve1:{:064x}", 0xD001usize),
            &new_issuer,
            vec![],
            json!({"kind":"definition.publish","word":word,"language":"en","parents":[],"origin":"native"}),
        );

        let build_with_overlay = |overlay: Option<Value>, traversal: Option<usize>| {
            let mut prepared = base();
            prepared.options.overlay = overlay.map(Into::into);
            prepared.options.limits.traversal = traversal;
            for i in 0..20usize {
                prepared.add_host_verified_record(host(
                    format!("jve1:{:064x}", 0xB100 + i),
                    &judge,
                    vec![],
                    json!({"kind":"judgment.set","target":rafsi_target,"value":"bless"}),
                ));
            }
            prepared
        };

        // 1. Default budget: invalid overlay -> with_overlay(None) -> fast append.
        let invalid_overlay = Some(json!({"version": 3}));
        let first_open = build_with_overlay(invalid_overlay.clone(), None).into_state();
        assert!(!first_open.evaluation().available);
        assert!(first_open.evaluation().reasons.contains("invalid_overlay"));
        let invalid_overlay_records: Vec<HostVerifiedRecord> = first_open
            .prepared
            .nodes
            .values()
            .map(|n| HostVerifiedRecord { node: n.clone() })
            .collect();
        let invalid_full = first_open.checkpoint("bad-overlay").unwrap();
        let invalid_results = first_open.result_checkpoint("bad-overlay").unwrap();

        let switched_open = first_open.with_overlay(None);
        drop(first_open);
        assert!(switched_open.evaluation().available);
        assert!(switched_open.evaluation().reasons.is_empty());

        let mut delta_open = PreparedEvaluationInput::new(switched_open.prepared.options.clone());
        delta_open.add_host_verified_record(delta_pub.clone());
        let fast_open = switched_open.advance(delta_open, &[]);

        let mut full_open_input = build_with_overlay(None, None);
        full_open_input.add_host_verified_record(delta_pub.clone());
        let full_open = full_open_input.into_state();
        assert!(!fast_open.statistics().rebuilt);
        assert_eq!(fast_open.consumed_work(), full_open.consumed_work());
        assert_eq!(fast_open.evaluation(), full_open.evaluation());

        // 2. Tight budget (full cost - 1): fast path after with_overlay(None) must refuse like full.
        let tight_budget = full_open.consumed_work() - 1;
        let first_tight =
            build_with_overlay(invalid_overlay.clone(), Some(tight_budget)).into_state();
        let switched_tight = first_tight.with_overlay(None);
        drop(first_tight);
        assert!(switched_tight.evaluation().available);

        let mut delta_tight = PreparedEvaluationInput::new(switched_tight.prepared.options.clone());
        delta_tight.add_host_verified_record(delta_pub.clone());
        let fast_tight = switched_tight.advance(delta_tight, &[]);

        let mut full_tight_input = build_with_overlay(None, Some(tight_budget));
        full_tight_input.add_host_verified_record(delta_pub);
        let full_tight = full_tight_input.into_state();
        assert!(!full_tight.evaluation().available);
        assert!(
            full_tight
                .evaluation()
                .reasons
                .contains("resource_unavailable")
        );
        assert!(!fast_tight.evaluation().available);
        assert_eq!(fast_tight.consumed_work(), full_tight.consumed_work());
        assert_eq!(fast_tight.evaluation(), full_tight.evaluation());

        // 3. Zero view (service default) and invalid-overlay states with jvr1 judgment must restore both checkpoints.
        let zero_view = format!("jve1:{}", "0".repeat(64));
        let jvr_rec = host(
            format!("jve1:{:064x}", 0xB100usize),
            &judge,
            vec![],
            json!({"kind":"judgment.set","target":rafsi_target,"value":"bless"}),
        );
        let mut zero_prepared = PreparedEvaluationInput::new(EvaluationOptions {
            selected_view: zero_view,
            import_selections: BTreeMap::new(),
            overlay: None,
            limits: Limits::default(),
        });
        zero_prepared.add_host_verified_record(jvr_rec.clone());
        let zero_state = zero_prepared.into_state();
        assert!(!zero_state.evaluation().available);
        assert!(zero_state.evaluation().reasons.contains("view_unavailable"));

        let zero_full = zero_state.checkpoint("zero-view").unwrap();
        let zero_results = zero_state.result_checkpoint("zero-view").unwrap();
        let restored_zero_full =
            EvaluatedState::restore_host_checkpoint(&zero_full, "zero-view").unwrap();
        let restored_zero_results = EvaluatedState::restore_host_result_checkpoint(
            &zero_results,
            "zero-view",
            vec![jvr_rec],
        )
        .unwrap();
        assert_eq!(restored_zero_full.evaluation(), zero_state.evaluation());
        assert_eq!(restored_zero_results.evaluation(), zero_state.evaluation());

        assert!(EvaluatedState::restore_host_checkpoint(&invalid_full, "bad-overlay").is_ok());
        assert!(
            EvaluatedState::restore_host_result_checkpoint(
                &invalid_results,
                "bad-overlay",
                invalid_overlay_records,
            )
            .is_ok()
        );
    }

    #[test]
    fn chained_distinct_views_restore_linearly() {
        let measure_views = |count: usize| -> (std::time::Duration, std::time::Duration) {
            let mut prepared = PreparedEvaluationInput::new(EvaluationOptions {
                selected_view: String::new(),
                import_selections: BTreeMap::new(),
                overlay: None,
                limits: Limits::default(),
            });
            let mut records = Vec::with_capacity(count);
            let mut parent_id: Option<String> = None;
            let issuer = identity_from_seed(&[1u8; 32]);
            for i in 0..count {
                let parents = parent_id.into_iter().collect::<Vec<_>>();
                let id = format!("jve1:{:064x}", i + 1);
                let body = json!({
                    "name":format!("view-{i:06}"),
                    "description":[],
                    "roots":[],
                    "rafsi_threshold":{"numerator":1,"denominator":1},
                    "H":{"numerator":3,"denominator":1},
                    "alpha":{"numerator":1,"denominator":2},
                    "excluded":[],
                    "calculation":"simple-routes-bounds-v1",
                    "work":1000,
                    "import_sets":[],
                    "account_witnesses":[],
                    "account_authority":false,
                    "notes":[]
                });
                let bytes = jvc_core::canonical_value(&body).unwrap();
                let header = Header {
                    version: 1,
                    issuer: issuer.clone(),
                    previous: vec![],
                    nonce: format!("{:032x}", i + 1),
                    action: json!({"kind":"view.publish","parents":parents}),
                    content: Some(jvc_core::body_descriptor(&bytes).unwrap()),
                };
                let (record, _) = HostVerifiedRecord::extract_with(
                    &id,
                    &header,
                    BodyAvailability::Valid { body },
                    |_| (),
                );
                parent_id = Some(id);
                prepared.add_host_verified_record(record);
            }
            prepared.options.selected_view = parent_id.unwrap();
            for node in prepared.nodes.values() {
                records.push(HostVerifiedRecord { node: node.clone() });
            }
            let state = prepared.into_state();
            assert!(state.evaluation().available);
            assert_eq!(state.evaluation().policies.len(), count);
            assert_eq!(state.evaluation().policy_history.len(), count);
            let full_bytes = state.checkpoint("chained-views").unwrap();
            let result_bytes = state.result_checkpoint("chained-views").unwrap();

            let start_full = std::time::Instant::now();
            let restored_full =
                EvaluatedState::restore_host_checkpoint(&full_bytes, "chained-views").unwrap();
            let full_elapsed = start_full.elapsed();

            let start_result = std::time::Instant::now();
            let restored_result = EvaluatedState::restore_host_result_checkpoint(
                &result_bytes,
                "chained-views",
                records,
            )
            .unwrap();
            let result_elapsed = start_result.elapsed();

            assert_eq!(restored_full.evaluation(), state.evaluation());
            assert_eq!(restored_result.evaluation(), state.evaluation());
            (full_elapsed, result_elapsed)
        };

        let (small_full, small_res) = measure_views(200);
        let (large_full, large_res) = measure_views(1_000);
        eprintln!(
            "chained_distinct_views_restore_linearly: 200=({small_full:?}, {small_res:?}), 1000=({large_full:?}, {large_res:?})"
        );
        assert!(
            large_full < small_full * 8
                && large_res < small_res * 8
                && large_full < std::time::Duration::from_secs(1)
                && large_res < std::time::Duration::from_secs(1),
            "1000 chained views restore grew super-linearly: 200=({small_full:?}, {small_res:?}), 1000=({large_full:?}, {large_res:?})"
        );
    }

    #[test]
    fn remainder_heuristic_removed_and_consumed_work_protects_budget() {
        let rafsi_target = format!("jvr1:{:064x}", 1usize);
        let judge = identity_from_seed(&[5u8; 32]);

        // 1. wide_remainder (20 judgments, limit 6_000_190) and over_1024_nodes (1025 judgments, limit 9_735):
        // Nulling options.limits.traversal must be rejected on restore.
        for (label, count, limit) in [
            ("wide_remainder", 20usize, 6_000_190usize),
            ("over_1024_nodes", 1_025usize, 9_735usize),
        ] {
            let mut prepared = base();
            prepared.options.limits.traversal = Some(limit);
            for i in 0..count {
                prepared.add_host_verified_record(host(
                    format!("jve1:{:064x}", 0x10_000 + i),
                    &judge,
                    vec![],
                    json!({"kind":"judgment.set","target":rafsi_target,"value":"bless"}),
                ));
            }
            let records: Vec<HostVerifiedRecord> = prepared
                .nodes
                .values()
                .map(|n| HostVerifiedRecord { node: n.clone() })
                .collect();
            let state = prepared.into_state();
            assert!(state.evaluation().available);
            let full_cp = state.checkpoint(label).unwrap();
            let res_cp = state.result_checkpoint(label).unwrap();
            assert!(EvaluatedState::restore_host_checkpoint(&full_cp, label).is_ok());
            assert!(
                EvaluatedState::restore_host_result_checkpoint(&res_cp, label, records.clone())
                    .is_ok()
            );

            for (is_results, raw) in [(false, &full_cp), (true, &res_cp)] {
                let mut mutated: Value = serde_json::from_slice(raw).unwrap();
                mutated["options"]["limits"]["traversal"] = Value::Null;
                let bytes = serde_json::to_vec(&mutated).unwrap();
                let restored = if is_results {
                    EvaluatedState::restore_host_result_checkpoint(&bytes, label, records.clone())
                } else {
                    EvaluatedState::restore_host_checkpoint(&bytes, label)
                };
                assert!(
                    restored.is_err(),
                    "{label} (is_results={is_results}) accepted nulled traversal"
                );
            }
        }

        // 2. 60-entry and 64-entry x 100,000 IDs selection under default budget (traversal: None):
        // the selection is charged once, and both checkpoints restore cleanly.
        let ids: Vec<String> = (0..100_000usize)
            .map(|i| format!("jve1:{:064x}", 0x100_0000 + i))
            .collect();
        let sel_bytes = jvc_core::canonical_value(&json!(ids)).unwrap();
        let sel_hash = jvc_core::hash_id("sha256:", b"", &sel_bytes);
        let importer = identity_from_seed(&[7u8; 32]);

        for entries in [60usize, 64usize] {
            let import_sets: Vec<Value> = (0..entries)
                .map(|i| {
                    json!({
                        "source": format!("source-{i:04}"),
                        "importer": importer,
                        "selection": sel_hash,
                    })
                })
                .collect();
            let (view, body) = event(
                1,
                entries as u8,
                json!({"kind":"view.publish","parents":[]}),
                Some(json!({
                    "name":"selection-default",
                    "description":[],
                    "roots":[{"identity":identity_from_seed(&[1;32]),"q":{"numerator":1,"denominator":1}}],
                    "rafsi_threshold":{"numerator":1,"denominator":1},
                    "H":{"numerator":3,"denominator":1},
                    "alpha":{"numerator":1,"denominator":2},
                    "excluded":[],
                    "calculation":"simple-routes-bounds-v1",
                    "work":1000,
                    "import_sets":import_sets,
                    "account_witnesses":[],
                    "account_authority":false,
                    "notes":[]
                })),
            );
            let mut prepared = PreparedEvaluationInput::new(EvaluationOptions {
                selected_view: view.id().into(),
                import_selections: BTreeMap::from([(sel_hash.clone(), ids.clone())]),
                overlay: None,
                limits: Limits::default(),
            });
            prepared.add_record(&view, body.as_deref());
            let records: Vec<HostVerifiedRecord> = prepared
                .nodes
                .values()
                .map(|n| HostVerifiedRecord { node: n.clone() })
                .collect();
            let state = prepared.into_state();
            assert!(state.evaluation().available);
            assert!(state.consumed_work() > 100_000 && state.consumed_work() < 101_000);

            let full_cp = state.checkpoint("selection-default").unwrap();
            let res_cp = state.result_checkpoint("selection-default").unwrap();
            let restored_full =
                EvaluatedState::restore_host_checkpoint(&full_cp, "selection-default")
                    .unwrap_or_else(|e| panic!("entries={entries} full restore failed: {e}"));
            let restored_res = EvaluatedState::restore_host_result_checkpoint(
                &res_cp,
                "selection-default",
                records,
            )
            .unwrap_or_else(|e| panic!("entries={entries} result restore failed: {e}"));
            assert_eq!(restored_full.consumed_work(), state.consumed_work());
            assert_eq!(restored_res.consumed_work(), state.consumed_work());
            assert_eq!(restored_full.evaluation(), state.evaluation());
            assert_eq!(restored_res.evaluation(), state.evaluation());
        }
    }

    #[test]
    fn source_selection_conflict_with_deciding_claim_restores_both_checkpoints() {
        let word = jvc_core::word_id(&json!({"language":"jbo","spelling":"banli"})).unwrap();
        let make_import_body = || {
            let mut body: Value = serde_json::from_str(include_str!(
                "../../jvc-core/tests/fixtures/definition.json"
            ))
            .unwrap();
            body["legacy"] = json!({
                "source":"fixture",
                "snapshot":"sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
                "extraction":"fixture-v1",
                "record":{"kind":"definition","id":1},
                "locator":"fixture",
                "original":{},
                "attribution":{
                    "author":"author",
                    "editor":null,
                    "author_account":{
                        "origin":"https://source.example",
                        "account":41,
                        "username":"author",
                        "evidence":{
                            "kind":"source-id",
                            "source":{"label":"source author numeric field","url":null,"event":null,"locator":"author_id"}
                        }
                    },
                    "dates":{}
                },
                "conversion":{"method":"literal","tool":"fixture","version":"1","model":null,"review":"unreviewed","mappings":[],"warnings":[]},
                "limitations":[]
            });
            body
        };

        let (pub1, pub1_bytes) = event(
            9,
            1,
            json!({"kind":"definition.publish","word":word,"language":"en","parents":[],"origin":"import"}),
            Some(make_import_body()),
        );
        let (pub2, pub2_bytes) = event(
            9,
            2,
            json!({"kind":"definition.publish","word":word,"language":"en","parents":[],"origin":"import"}),
            Some(make_import_body()),
        );
        let sel1_ids = vec![pub1.id().to_string()];
        let sel1_hash = jvc_core::hash_id(
            "sha256:",
            b"",
            &jvc_core::canonical_value(&json!(sel1_ids)).unwrap(),
        );
        let sel2_ids = vec![pub2.id().to_string()];
        let sel2_hash = jvc_core::hash_id(
            "sha256:",
            b"",
            &jvc_core::canonical_value(&json!(sel2_ids)).unwrap(),
        );
        let mut import_sets = vec![
            json!({"source":"fixture","importer":identity_from_seed(&[9;32]),"selection":sel1_hash}),
            json!({"source":"fixture","importer":identity_from_seed(&[9;32]),"selection":sel2_hash}),
        ];
        import_sets.sort_by(|a, b| {
            jvc_core::canonical_value(a)
                .unwrap()
                .cmp(&jvc_core::canonical_value(b).unwrap())
        });

        let mut witnesses = vec![identity_from_seed(&[10; 32]), identity_from_seed(&[11; 32])];
        witnesses.sort();
        let (view, view_bytes) = event(
            20,
            1,
            json!({"kind":"view.publish","parents":[]}),
            Some(json!({
                "name":"fixture",
                "description":[],
                "roots":[],
                "rafsi_threshold":{"numerator":1,"denominator":1},
                "H":{"numerator":3,"denominator":1},
                "alpha":{"numerator":1,"denominator":2},
                "excluded":[],
                "calculation":"simple-routes-bounds-v1",
                "work":1000,
                "import_sets":import_sets,
                "account_witnesses":witnesses,
                "account_authority":true,
                "notes":[]
            })),
        );

        let mut prepared = PreparedEvaluationInput::new(EvaluationOptions {
            selected_view: view.id().into(),
            import_selections: BTreeMap::from([(sel1_hash, sel1_ids), (sel2_hash, sel2_ids)]),
            overlay: None,
            limits: Limits::default(),
        });
        prepared.add_record(&view, view_bytes.as_deref());
        prepared.add_record(&pub1, pub1_bytes.as_deref());
        prepared.add_record(&pub2, pub2_bytes.as_deref());

        let author = identity_from_seed(&[1u8; 32]);
        let claim_id = format!("jve1:{:064x}", 10_010usize);
        prepared.add_host_verified_record(host(
            claim_id.clone(),
            &author,
            vec![],
            json!({"kind":"account.set","origin":"https://source.example","account":41,"value":"claim","previous":null,"carry":[]}),
        ));
        observe(&mut prepared, 10, 1, &claim_id);
        observe(&mut prepared, 11, 1, &claim_id);
        prepared.add_host_verified_record(host(
            format!("jve1:{:064x}", 10_011usize),
            &author,
            vec![claim_id.clone()],
            json!({"kind":"import.status","target":pub1.id(),"claim":claim_id,"value":"deprecated"}),
        ));

        let records: Vec<HostVerifiedRecord> = prepared
            .nodes
            .values()
            .map(|n| HostVerifiedRecord { node: n.clone() })
            .collect();
        let state = prepared.clone().into_state();
        assert!(state.evaluation().available);
        let p1 = &state.evaluation().publications[pub1.id()];
        assert_eq!(p1.status, Status::Unavailable);
        assert!(p1.reasons.contains("source_selection_conflict"));
        assert_eq!(p1.deciding_claim.as_deref(), Some(claim_id.as_str()));

        let full_cp = state.checkpoint("source-conflict").unwrap();
        let res_cp = state.result_checkpoint("source-conflict").unwrap();
        let restored_full =
            EvaluatedState::restore_host_checkpoint(&full_cp, "source-conflict").unwrap();
        let restored_res =
            EvaluatedState::restore_host_result_checkpoint(&res_cp, "source-conflict", records)
                .unwrap();
        assert_eq!(restored_full.evaluation(), state.evaluation());
        assert_eq!(restored_res.evaluation(), state.evaluation());

        let appended = host_missing_body(
            format!("jve1:{:064x}", 50_000usize),
            &identity_from_seed(&[30u8; 32]),
            vec![],
            json!({"kind":"definition.publish","word":word,"language":"en","parents":[],"origin":"native"}),
        );
        let mut full_after_input = prepared.clone();
        full_after_input.add_host_verified_record(appended.clone());
        let full_after = full_after_input.into_state();

        let mut delta = PreparedEvaluationInput::new(prepared.options_with_selections());
        delta.add_host_verified_record(appended);
        let adv_full = restored_full.advance(delta.clone(), &[]);
        let adv_res = restored_res.advance(delta, &[]);
        assert_eq!(adv_full.consumed_work(), full_after.consumed_work());
        assert_eq!(adv_res.consumed_work(), full_after.consumed_work());
        assert_eq!(adv_full.evaluation(), full_after.evaluation());
        assert_eq!(adv_res.evaluation(), full_after.evaluation());
    }

    #[test]
    fn resource_unavailable_reason_with_available_true_is_rejected() {
        let rafsi_target = format!("jvr1:{:064x}", 1usize);
        let judge = identity_from_seed(&[5u8; 32]);
        let mut prepared = base();
        prepared.options.limits.traversal = Some(218);
        for i in 0..20usize {
            prepared.add_host_verified_record(host(
                format!("jve1:{:064x}", 0xB100 + i),
                &judge,
                vec![],
                json!({"kind":"judgment.set","target":rafsi_target,"value":"bless"}),
            ));
        }
        let records: Vec<HostVerifiedRecord> = prepared
            .nodes
            .values()
            .map(|n| HostVerifiedRecord { node: n.clone() })
            .collect();
        let state = prepared.into_state();
        assert!(state.evaluation().available);
        assert_eq!(state.consumed_work(), 190);

        let full_cp = state.checkpoint("reason-bypass").unwrap();
        let res_cp = state.result_checkpoint("reason-bypass").unwrap();

        for mutation in [
            "reason_null_policy",
            "reason_only_available_true",
            "reason_planted_available_false",
        ] {
            for (is_results, raw) in [(false, &full_cp), (true, &res_cp)] {
                let mut value: Value = serde_json::from_slice(raw).unwrap();
                value["evaluation"]["reasons"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!("resource_unavailable"));
                match mutation {
                    "reason_null_policy" => {
                        value["evaluation"]["policy"] = Value::Null;
                    }
                    "reason_only_available_true" => {}
                    "reason_planted_available_false" => {
                        value["evaluation"]["available"] = json!(false);
                    }
                    _ => unreachable!(),
                }
                let bytes = serde_json::to_vec(&value).unwrap();
                let restored = if is_results {
                    EvaluatedState::restore_host_result_checkpoint(
                        &bytes,
                        "reason-bypass",
                        records.clone(),
                    )
                } else {
                    EvaluatedState::restore_host_checkpoint(&bytes, "reason-bypass")
                };
                assert!(
                    restored.is_err(),
                    "mutation={mutation} is_results={is_results} should be rejected on restore"
                );
            }
        }
    }

    #[test]
    fn selection_scan_default_budget_passes_distinct_selections_and_a_reused_selection() {
        let importer = identity_from_seed(&[7u8; 32]);

        // 1. One 100,000-ID selection named by 160 entries is charged once and passes under the default budget.
        let shared_ids: Vec<String> = (0..100_000usize)
            .map(|i| format!("jve1:{:064x}", 0x100_0000 + i))
            .collect();
        let shared_bytes = jvc_core::canonical_value(&json!(shared_ids)).unwrap();
        let shared_hash = jvc_core::hash_id("sha256:", b"", &shared_bytes);
        let reused_sets: Vec<Value> = (0..160usize)
            .map(|i| {
                json!({
                    "source": format!("source-{i:04}"),
                    "importer": importer,
                    "selection": shared_hash,
                })
            })
            .collect();
        let (reused_view, reused_body) = event(
            1,
            200,
            json!({"kind":"view.publish","parents":[]}),
            Some(json!({
                "name":"reused-selection",
                "description":[],
                "roots":[{"identity":identity_from_seed(&[1;32]),"q":{"numerator":1,"denominator":1}}],
                "rafsi_threshold":{"numerator":1,"denominator":1},
                "H":{"numerator":3,"denominator":1},
                "alpha":{"numerator":1,"denominator":2},
                "excluded":[],
                "calculation":"simple-routes-bounds-v1",
                "work":1000,
                "import_sets":reused_sets,
                "account_witnesses":[],
                "account_authority":false,
                "notes":[]
            })),
        );
        let mut reused_input = PreparedEvaluationInput::new(EvaluationOptions {
            selected_view: reused_view.id().into(),
            import_selections: BTreeMap::from([(shared_hash, shared_ids.clone())]),
            overlay: None,
            limits: Limits::default(),
        });
        reused_input.add_record(&reused_view, reused_body.as_deref());
        let reused_records: Vec<HostVerifiedRecord> = reused_input
            .nodes
            .values()
            .map(|n| HostVerifiedRecord { node: n.clone() })
            .collect();
        let reused_state = reused_input.into_state();
        assert!(reused_state.evaluation().available);
        assert!(reused_state.consumed_work() < 101_000);
        let reused_full_cp = reused_state.checkpoint("reused-sel").unwrap();
        let reused_res_cp = reused_state.result_checkpoint("reused-sel").unwrap();
        assert!(EvaluatedState::restore_host_checkpoint(&reused_full_cp, "reused-sel").is_ok());
        assert!(
            EvaluatedState::restore_host_result_checkpoint(
                &reused_res_cp,
                "reused-sel",
                reused_records,
            )
            .is_ok()
        );

        // 2. 105 entries each naming its own distinct 100,000-ID selection (10,500,000 IDs total)
        // is linear in the input and passes under the default budget.
        let mut distinct_selections = BTreeMap::new();
        let mut distinct_sets = Vec::with_capacity(105);
        let mut template_ids = shared_ids;
        let mut template_bytes = shared_bytes;
        for i in 0..105usize {
            let first_id = format!("jve1:{:064x}", i + 1);
            template_ids[0] = first_id.clone();
            template_bytes[2..71].copy_from_slice(first_id.as_bytes());
            let sel_hash = jvc_core::hash_id("sha256:", b"", &template_bytes);
            distinct_selections.insert(sel_hash.clone(), template_ids.clone());
            distinct_sets.push(json!({
                "source": format!("source-{i:04}"),
                "importer": importer,
                "selection": sel_hash,
            }));
        }
        let (distinct_view, distinct_body) = event(
            1,
            201,
            json!({"kind":"view.publish","parents":[]}),
            Some(json!({
                "name":"distinct-selections",
                "description":[],
                "roots":[{"identity":identity_from_seed(&[1;32]),"q":{"numerator":1,"denominator":1}}],
                "rafsi_threshold":{"numerator":1,"denominator":1},
                "H":{"numerator":3,"denominator":1},
                "alpha":{"numerator":1,"denominator":2},
                "excluded":[],
                "calculation":"simple-routes-bounds-v1",
                "work":1000,
                "import_sets":distinct_sets,
                "account_witnesses":[],
                "account_authority":false,
                "notes":[]
            })),
        );
        let two_selections: BTreeMap<String, Vec<String>> = distinct_sets[..2]
            .iter()
            .map(|entry| {
                let h = entry["selection"].as_str().unwrap().to_owned();
                let ids = distinct_selections[&h].clone();
                (h, ids)
            })
            .collect();
        let mut distinct_input = PreparedEvaluationInput::new(EvaluationOptions {
            selected_view: distinct_view.id().into(),
            import_selections: distinct_selections,
            overlay: None,
            limits: Limits::default(),
        });
        distinct_input.add_record(&distinct_view, distinct_body.as_deref());
        let distinct_state = distinct_input.into_state();
        assert!(
            distinct_state.evaluation().available,
            "distinct selections must pass default budget; reasons={:?}",
            distinct_state.evaluation().reasons
        );
        assert!(distinct_state.consumed_work() > 10_000_256);

        let (two_view, two_body) = event(
            1,
            205,
            json!({"kind":"view.publish","parents":[]}),
            Some(json!({
                "name":"two-distinct-selections",
                "description":[],
                "roots":[{"identity":identity_from_seed(&[1;32]),"q":{"numerator":1,"denominator":1}}],
                "rafsi_threshold":{"numerator":1,"denominator":1},
                "H":{"numerator":3,"denominator":1},
                "alpha":{"numerator":1,"denominator":2},
                "excluded":[],
                "calculation":"simple-routes-bounds-v1",
                "work":1000,
                "import_sets":&distinct_sets[..2],
                "account_witnesses":[],
                "account_authority":false,
                "notes":[]
            })),
        );
        let mut two_input = PreparedEvaluationInput::new(EvaluationOptions {
            selected_view: two_view.id().into(),
            import_selections: two_selections,
            overlay: None,
            limits: Limits::default(),
        });
        two_input.add_record(&two_view, two_body.as_deref());
        let two_records: Vec<HostVerifiedRecord> = two_input
            .nodes
            .values()
            .map(|n| HostVerifiedRecord { node: n.clone() })
            .collect();
        let two_state = two_input.into_state();
        assert!(two_state.evaluation().available);
        assert_eq!(two_state.traversal_budget(), 10_200_256);
        let distinct_full_cp = two_state.checkpoint("distinct-sel").unwrap();
        let distinct_res_cp = two_state.result_checkpoint("distinct-sel").unwrap();
        let restored_distinct_full =
            EvaluatedState::restore_host_checkpoint(&distinct_full_cp, "distinct-sel").unwrap();
        let restored_distinct_res = EvaluatedState::restore_host_result_checkpoint(
            &distinct_res_cp,
            "distinct-sel",
            two_records,
        )
        .unwrap();
        assert_eq!(
            restored_distinct_full.consumed_work(),
            two_state.consumed_work()
        );
        assert_eq!(
            restored_distinct_res.consumed_work(),
            two_state.consumed_work()
        );
        assert_eq!(restored_distinct_full.traversal_budget(), 10_200_256);
        assert_eq!(restored_distinct_res.traversal_budget(), 10_200_256);
    }

    #[test]
    fn unused_invalid_selection_padding_does_not_expand_the_default_budget() {
        let importer = identity_from_seed(&[7u8; 32]);
        let shared_ids: Vec<String> = (0..100_000usize)
            .map(|i| format!("jve1:{:064x}", 0x100_0000 + i))
            .collect();
        let shared_bytes = jvc_core::canonical_value(&json!(shared_ids)).unwrap();
        let shared_hash = jvc_core::hash_id("sha256:", b"", &shared_bytes);
        let reused_sets: Vec<Value> = (0..160usize)
            .map(|i| {
                json!({
                    "source": format!("source-{i:04}"),
                    "importer": importer,
                    "selection": shared_hash,
                })
            })
            .collect();
        let (reused_view, reused_body) = event(
            1,
            202,
            json!({"kind":"view.publish","parents":[]}),
            Some(json!({
                "name":"reused-selection-invalid-padded",
                "description":[],
                "roots":[{"identity":identity_from_seed(&[1;32]),"q":{"numerator":1,"denominator":1}}],
                "rafsi_threshold":{"numerator":1,"denominator":1},
                "H":{"numerator":3,"denominator":1},
                "alpha":{"numerator":1,"denominator":2},
                "excluded":[],
                "calculation":"simple-routes-bounds-v1",
                "work":1000,
                "import_sets":reused_sets,
                "account_witnesses":[],
                "account_authority":false,
                "notes":[]
            })),
        );
        let mut padded_input = PreparedEvaluationInput::new(EvaluationOptions {
            selected_view: reused_view.id().into(),
            import_selections: BTreeMap::from([
                (shared_hash, shared_ids),
                ("sha256:unused".to_owned(), vec![String::new(); 6_000_000]),
            ]),
            overlay: None,
            limits: Limits::default(),
        });
        padded_input.add_record(&reused_view, reused_body.as_deref());
        let padded_records: Vec<HostVerifiedRecord> = padded_input
            .nodes
            .values()
            .map(|n| HostVerifiedRecord { node: n.clone() })
            .collect();
        let padded_state = padded_input.into_state();
        assert!(padded_state.evaluation().available);
        // The base, one record and the one referenced valid selection.
        assert_eq!(
            padded_state.traversal_budget(),
            10_100_256,
            "unused invalid selection padding must not expand default budget"
        );
        let consumed = padded_state.consumed_work();
        let full_cp = padded_state.checkpoint("invalid-pad").unwrap();
        let res_cp = padded_state.result_checkpoint("invalid-pad").unwrap();
        let restored_full =
            EvaluatedState::restore_host_checkpoint(&full_cp, "invalid-pad").unwrap();
        let restored_res =
            EvaluatedState::restore_host_result_checkpoint(&res_cp, "invalid-pad", padded_records)
                .unwrap();
        assert_eq!(restored_full.evaluation(), padded_state.evaluation());
        assert_eq!(restored_res.evaluation(), padded_state.evaluation());
        assert_eq!(restored_full.consumed_work(), consumed);
        assert_eq!(restored_res.consumed_work(), consumed);
    }

    #[test]
    fn unused_valid_selection_padding_and_referenced_invalid_selection_do_not_expand_the_default_budget()
     {
        let importer = identity_from_seed(&[7u8; 32]);
        let shared_ids: Vec<String> = (0..100_000usize)
            .map(|i| format!("jve1:{:064x}", 0x100_0000 + i))
            .collect();
        let shared_bytes = jvc_core::canonical_value(&json!(shared_ids)).unwrap();
        let shared_hash = jvc_core::hash_id("sha256:", b"", &shared_bytes);
        let reused_sets: Vec<Value> = (0..160usize)
            .map(|i| {
                json!({
                    "source": format!("source-{i:04}"),
                    "importer": importer,
                    "selection": shared_hash,
                })
            })
            .collect();
        let (reused_view, reused_body) = event(
            1,
            203,
            json!({"kind":"view.publish","parents":[]}),
            Some(json!({
                "name":"reused-selection-valid-padded",
                "description":[],
                "roots":[{"identity":identity_from_seed(&[1;32]),"q":{"numerator":1,"denominator":1}}],
                "rafsi_threshold":{"numerator":1,"denominator":1},
                "H":{"numerator":3,"denominator":1},
                "alpha":{"numerator":1,"denominator":2},
                "excluded":[],
                "calculation":"simple-routes-bounds-v1",
                "work":1000,
                "import_sets":reused_sets,
                "account_witnesses":[],
                "account_authority":false,
                "notes":[]
            })),
        );

        // 1. Add 60 unused valid 100,000-ID selections (6,000,000 valid IDs not referenced by the selected view).
        let mut selections = BTreeMap::from([(shared_hash.clone(), shared_ids.clone())]);
        let mut template_ids = shared_ids.clone();
        let mut template_bytes = shared_bytes.clone();
        for i in 0..60usize {
            let first_id = format!("jve1:{:064x}", i + 1);
            template_ids[0] = first_id.clone();
            template_bytes[2..71].copy_from_slice(first_id.as_bytes());
            let unused_valid_hash = jvc_core::hash_id("sha256:", b"", &template_bytes);
            selections.insert(unused_valid_hash, template_ids.clone());
        }
        let mut valid_padded_input = PreparedEvaluationInput::new(EvaluationOptions {
            selected_view: reused_view.id().into(),
            import_selections: selections,
            overlay: None,
            limits: Limits::default(),
        });
        valid_padded_input.add_record(&reused_view, reused_body.as_deref());
        let valid_padded_records: Vec<HostVerifiedRecord> = valid_padded_input
            .nodes
            .values()
            .map(|n| HostVerifiedRecord { node: n.clone() })
            .collect();
        let valid_padded_state = valid_padded_input.into_state();
        assert!(valid_padded_state.evaluation().available);
        assert_eq!(
            valid_padded_state.traversal_budget(),
            10_100_256,
            "unused valid selection padding must not expand default budget"
        );
        let consumed = valid_padded_state.consumed_work();
        let full_cp = valid_padded_state.checkpoint("valid-pad").unwrap();
        let res_cp = valid_padded_state.result_checkpoint("valid-pad").unwrap();
        let restored_full = EvaluatedState::restore_host_checkpoint(&full_cp, "valid-pad").unwrap();
        let restored_res = EvaluatedState::restore_host_result_checkpoint(
            &res_cp,
            "valid-pad",
            valid_padded_records,
        )
        .unwrap();
        assert_eq!(restored_full.evaluation(), valid_padded_state.evaluation());
        assert_eq!(restored_res.evaluation(), valid_padded_state.evaluation());
        assert_eq!(restored_full.consumed_work(), consumed);
        assert_eq!(restored_res.consumed_work(), consumed);

        // 2. A referenced invalid selection (wrong hash for 100,000 sorted jve1 IDs) adds 0 allowance.
        let bad_hash = format!("sha256:{}", "f".repeat(64));
        let mut mixed_sets = Vec::with_capacity(160);
        for i in 0..160usize {
            let sel = if i < 100 { &shared_hash } else { &bad_hash };
            mixed_sets.push(json!({
                "source": format!("source-{i:04}"),
                "importer": importer,
                "selection": sel,
            }));
        }
        let (mixed_view, mixed_body) = event(
            1,
            204,
            json!({"kind":"view.publish","parents":[]}),
            Some(json!({
                "name":"referenced-invalid-selection",
                "description":[],
                "roots":[{"identity":identity_from_seed(&[1;32]),"q":{"numerator":1,"denominator":1}}],
                "rafsi_threshold":{"numerator":1,"denominator":1},
                "H":{"numerator":3,"denominator":1},
                "alpha":{"numerator":1,"denominator":2},
                "excluded":[],
                "calculation":"simple-routes-bounds-v1",
                "work":1000,
                "import_sets":mixed_sets,
                "account_witnesses":[],
                "account_authority":false,
                "notes":[]
            })),
        );
        let mut mixed_input = PreparedEvaluationInput::new(EvaluationOptions {
            selected_view: mixed_view.id().into(),
            import_selections: BTreeMap::from([
                (shared_hash, shared_ids.clone()),
                (bad_hash, shared_ids),
            ]),
            overlay: None,
            limits: Limits::default(),
        });
        mixed_input.add_record(&mixed_view, mixed_body.as_deref());
        let mixed_records: Vec<HostVerifiedRecord> = mixed_input
            .nodes
            .values()
            .map(|n| HostVerifiedRecord { node: n.clone() })
            .collect();
        let mixed_state = mixed_input.into_state();
        assert!(mixed_state.evaluation().available);
        assert_eq!(mixed_state.traversal_budget(), 10_100_256);
        let mixed_full_cp = mixed_state.checkpoint("mixed-invalid").unwrap();
        let mixed_res_cp = mixed_state.result_checkpoint("mixed-invalid").unwrap();
        assert!(EvaluatedState::restore_host_checkpoint(&mixed_full_cp, "mixed-invalid").is_ok());
        assert!(
            EvaluatedState::restore_host_result_checkpoint(
                &mixed_res_cp,
                "mixed-invalid",
                mixed_records,
            )
            .is_ok()
        );
    }

    fn assert_state_roundtrips_and_appends(
        state: &EvaluatedState,
        prepared: &PreparedEvaluationInput,
        append_nonce: u64,
    ) {
        let full_cp = state
            .checkpoint("roundtrip")
            .expect("full checkpoint must serialize");
        let res_cp = state
            .result_checkpoint("roundtrip")
            .expect("result checkpoint must serialize");
        let records: Vec<HostVerifiedRecord> = prepared
            .nodes
            .values()
            .map(|n| HostVerifiedRecord { node: n.clone() })
            .collect();
        let restored_full = EvaluatedState::restore_host_checkpoint(&full_cp, "roundtrip")
            .expect("valid evaluator full checkpoint must restore");
        let restored_res =
            EvaluatedState::restore_host_result_checkpoint(&res_cp, "roundtrip", records)
                .expect("valid evaluator result checkpoint must restore");
        assert_eq!(restored_full.evaluation(), state.evaluation());
        assert_eq!(restored_res.evaluation(), state.evaluation());
        assert_eq!(restored_full.consumed_work(), state.consumed_work());
        assert_eq!(restored_res.consumed_work(), state.consumed_work());

        let append_issuer = identity_from_seed(&[251u8; 32]);
        let append_word =
            jvc_core::word_id(&json!({"language":"jbo","spelling":"appendcheck"})).unwrap();
        let append_record = host_missing_body(
            format!("jve1:ff{:062x}", append_nonce),
            &append_issuer,
            vec![],
            json!({"kind":"definition.publish","word":append_word,"language":"en","parents":[],"origin":"native"}),
        );
        let mut delta_full = PreparedEvaluationInput::new(prepared.options_with_selections());
        delta_full.add_host_verified_record(append_record.clone());
        let mut delta_res = PreparedEvaluationInput::new(prepared.options_with_selections());
        delta_res.add_host_verified_record(append_record.clone());
        let mut expected_prepared = prepared.clone();
        expected_prepared.add_host_verified_record(append_record);

        let after_full = restored_full.advance(delta_full, &[]);
        let after_res = restored_res.advance(delta_res, &[]);
        let expected_state = expected_prepared.into_state();
        assert_eq!(after_full.evaluation(), expected_state.evaluation());
        assert_eq!(after_res.evaluation(), expected_state.evaluation());
        assert_eq!(after_full.consumed_work(), expected_state.consumed_work());
        assert_eq!(after_res.consumed_work(), expected_state.consumed_work());
    }

    /// Fast-path appends by keys whose blocks sit between existing
    /// blocks, mixed with appends that merge across the insertion
    /// points of those keys. Key `A` transfers to key `C`, and `C`
    /// has two roots (so no succession forms), one of them accepting
    /// the transfer: the structural closure of a record that covers
    /// `C`'s block holds `A`'s transfer, and over the shared layout
    /// that range fuses with `C`'s block. A key that sorts between `A`
    /// and `C` and appends first splits that range in a fresh layout.
    /// After every step the live state, a restored full checkpoint
    /// and a restored result checkpoint, each advanced by the step's
    /// record, must equal a full evaluation: evaluation, kept bytes
    /// and work.
    #[test]
    fn appends_across_inserted_blocks_match_full_evaluation_in_every_path() {
        let mut keys: Vec<String> = (0..8u8)
            .map(|i| identity_from_seed(&[90 + i; 32]))
            .collect();
        keys.sort();
        let (a, c) = (keys[1].clone(), keys[4].clone());
        let inserted = [&keys[0], &keys[2], &keys[3], &keys[5], &keys[6], &keys[7]];
        let mut base_input = base();
        let (publication, body) = publication();
        let publication_id = publication.id().to_string();
        base_input.add_record(&publication, body.as_deref());
        let transfer = format!("jve1:{:064x}", 0xa1usize);
        base_input.add_host_verified_record(host(
            transfer.clone(),
            &a,
            vec![],
            json!({"kind":"identity.transfer","successor":c}),
        ));
        let c_merge = format!("jve1:{:064x}", 0xc1usize);
        let c_accept = format!("jve1:{:064x}", 0xc2usize);
        base_input.add_host_verified_record(host(
            c_merge.clone(),
            &c,
            vec![],
            json!({"kind":"identity.merge"}),
        ));
        base_input.add_host_verified_record(host(
            c_accept.clone(),
            &c,
            vec![],
            json!({"kind":"identity.accept","transfer":transfer}),
        ));
        // The first sequence is the minimal case: a key between `A`
        // and `C` appends a root, then `C` merges its two roots.
        let mut sequences: Vec<Vec<usize>> = vec![vec![1, 6, 6, 2, 6]];
        let mut rng = Rng(0x5EED_1234);
        for _ in 0..12 {
            sequences.push((0..8).map(|_| rng.below(7) as usize).collect());
        }
        let mut compared = 0usize;
        let mut fast = 0usize;
        for (sequence_index, sequence) in sequences.iter().enumerate() {
            let mut prepared = base_input.clone();
            let mut heads: BTreeMap<String, Vec<String>> = BTreeMap::new();
            heads.insert(c.clone(), vec![c_merge.clone(), c_accept.clone()]);
            let mut live = unshared(&prepared).into_state();
            assert!(live.evaluation().available);
            for (step, &pick) in sequence.iter().enumerate() {
                // Picks 0 to 5 are the inserted keys, 6 is `C`.
                let issuer = if pick < 6 {
                    inserted[pick].clone()
                } else {
                    c.clone()
                };
                let id = format!("jve1:{:064x}", 0x1_0000 + 0x100 * sequence_index + step);
                let previous = heads.get(&issuer).cloned().unwrap_or_default();
                let value = if step % 2 == 0 { "bless" } else { "curse" };
                let record = host(
                    id.clone(),
                    &issuer,
                    previous,
                    json!({"kind":"judgment.set","target":publication_id,"value":value}),
                );
                heads.insert(issuer.clone(), vec![id]);
                let options = prepared.options.clone();
                let delta = || {
                    let mut delta = PreparedEvaluationInput::new(options.clone());
                    delta.add_host_verified_record(record.clone());
                    delta
                };
                let full_checkpoint = live.checkpoint("inserted").unwrap();
                let result_checkpoint = live.result_checkpoint("inserted").unwrap();
                let records: Vec<HostVerifiedRecord> = prepared
                    .nodes
                    .values()
                    .map(|n| HostVerifiedRecord { node: n.clone() })
                    .collect();
                prepared.add_host_verified_record(record.clone());
                live = live.advance(delta(), &[]);
                if !live.statistics().rebuilt {
                    fast += 1;
                }
                let restored_full =
                    EvaluatedState::restore_host_checkpoint(&full_checkpoint, "inserted")
                        .unwrap()
                        .advance(delta(), &[]);
                let restored_results = EvaluatedState::restore_host_result_checkpoint(
                    &result_checkpoint,
                    "inserted",
                    records,
                )
                .unwrap()
                .advance(delta(), &[]);
                let full = prepared.clone().into_state();
                for (path, state) in [
                    ("live", &live),
                    ("restored full checkpoint", &restored_full),
                    ("restored result checkpoint", &restored_results),
                ] {
                    let at = format!("sequence {sequence_index}, step {step}, {path}");
                    assert_eq!(state.evaluation(), full.evaluation(), "{at}");
                    assert_eq!(cap_bytes(state), cap_bytes(&full), "{at}");
                    assert_eq!(state.consumed_work(), full.consumed_work(), "{at}");
                }
                compared += 1;
            }
        }
        assert_eq!(compared, 5 + 12 * 8);
        assert!(
            fast > compared / 2,
            "{fast} of {compared} appends took the fast path"
        );
    }

    /// A history near the cap for `appended_near_the_cap_refuses_in_every_path_where_full_refuses`.
    /// One key accepts transfers from `sources` other keys, so the
    /// structural closure of a record that covers its block keeps one
    /// range per source block. The key has one root per acceptance,
    /// so no transfer becomes a lifecycle succession, and the own and
    /// accepted closures of such a record keep one range each. Each
    /// source block starts with a record that no closure contains, so
    /// source blocks never fuse with each other, and no closure
    /// crosses the end of the accepting key's block, where an append
    /// inserts. A source block just before the accepting key's block
    /// fuses with it, so 190 sources give 190 ranges. Two interleaved
    /// chains of a filler key bring the kept storage near the cap, and
    /// `tune` root records each raise the cap by one allowance without
    /// kept storage.
    fn near_cap_accepting_history(
        sources: usize,
        filler: usize,
        weight: usize,
        tune: usize,
    ) -> (PreparedEvaluationInput, HostVerifiedRecord) {
        let mut prepared = base();
        let (publication, body) = publication();
        let publication_id = publication.id().to_string();
        prepared.add_record(&publication, body.as_deref());
        let successor = identity_from_seed(&[60u8; 32]);
        let merge = json!({"kind":"identity.merge"});
        let mut accepts: Vec<String> = Vec::new();
        for j in 0..sources {
            let mut seed = [61u8; 32];
            seed[..8].copy_from_slice(&(j as u64).to_le_bytes());
            let source = identity_from_seed(&seed);
            let transfer = format!("jve1:{:064x}", 610_000 + 4 * j + 1);
            prepared.add_host_verified_record(host(
                transfer.clone(),
                &source,
                vec![],
                json!({"kind":"identity.transfer","successor":successor}),
            ));
            prepared.add_host_verified_record(host(
                format!("jve1:{:064x}", 610_000 + 4 * j),
                &source,
                vec![],
                merge.clone(),
            ));
            let accept = format!("jve1:{:064x}", 620_000 + j);
            prepared.add_host_verified_record(host(
                accept.clone(),
                &successor,
                vec![],
                json!({"kind":"identity.accept","transfer":transfer}),
            ));
            accepts.push(accept);
        }
        // Merge the accepts, at most 64 predecessors per record.
        let mut head: Option<String> = None;
        for (i, group) in accepts.chunks(63).enumerate() {
            let mut previous: Vec<String> = group.to_vec();
            previous.extend(head.clone());
            let id = format!("jve1:{:064x}", 630_000 + i);
            prepared.add_host_verified_record(host(
                id.clone(),
                &successor,
                previous,
                merge.clone(),
            ));
            head = Some(id);
        }
        let filler_key = identity_from_seed(&[62u8; 32]);
        for i in 0..filler {
            prepared.add_host_verified_record(host(
                format!("jve1:{:064x}", 800_000 + i),
                &filler_key,
                (i >= 2)
                    .then(|| format!("jve1:{:064x}", 800_000 + i - 2))
                    .into_iter()
                    .collect(),
                merge.clone(),
            ));
        }
        // One record that names filler record `weight` keeps a closure
        // of about `weight / 2` ranges. It sorts last in the filler
        // block, so it splits no other closure.
        prepared.add_host_verified_record(host(
            format!("jve1:{:064x}", 850_000usize),
            &filler_key,
            vec![format!("jve1:{:064x}", 800_000 + weight)],
            merge.clone(),
        ));
        let tune_key = identity_from_seed(&[63u8; 32]);
        for i in 0..tune {
            prepared.add_host_verified_record(host(
                format!("jve1:{:064x}", 900_000 + i),
                &tune_key,
                vec![],
                merge.clone(),
            ));
        }
        let appended = host(
            format!("jve1:{:064x}", 999_999usize),
            &successor,
            head.into_iter().collect(),
            json!({"kind":"judgment.set","target":publication_id,"value":"bless"}),
        );
        (prepared, appended)
    }

    /// An append whose kept closures cross the cap refuses in every
    /// path exactly where full evaluation refuses: the live state, a
    /// restored full checkpoint and a restored result checkpoint.
    /// The appended record keeps a structural closure of 190 ranges
    /// (16 + 8 * 190 = 1,536 bytes), and its own and accepted closures
    /// of one range count nothing. With no tuning record the history
    /// has 1,280 bytes of room after the append, and every path refuses.
    /// With one tuning record more it has 2,304 bytes, every path
    /// accepts, the live append takes the fast path, and all paths
    /// count the same bytes, also after a checkpoint of the live
    /// state is restored.
    #[test]
    fn appended_near_the_cap_refuses_in_every_path_where_full_refuses() {
        for (tune, room, available) in [(0usize, 1_280i64, false), (1, 2_304, true)] {
            let (prepared, appended) = near_cap_accepting_history(190, 3_440, 262, tune);
            let state = prepared.clone().into_state();
            assert!(state.evaluation().available, "tune {tune}");
            let records = prepared.nodes.len();
            assert_eq!(
                crate::ancestors::ancestry_cap(records + 1) as i64 - cap_bytes(&state) as i64,
                room
            );
            let mut full = prepared.clone();
            full.add_host_verified_record(appended.clone());
            let full_state = full.clone().into_state();
            assert_eq!(full_state.evaluation().available, available, "tune {tune}");
            let delta = || {
                let mut delta = PreparedEvaluationInput::new(prepared.options.clone());
                delta.add_host_verified_record(appended.clone());
                delta
            };
            let live = state.clone().advance(delta(), &[]);
            let full_checkpoint = state.checkpoint("near-cap").unwrap();
            let restored_full =
                EvaluatedState::restore_host_checkpoint(&full_checkpoint, "near-cap")
                    .unwrap()
                    .advance(delta(), &[]);
            let records_list: Vec<HostVerifiedRecord> = prepared
                .nodes
                .values()
                .map(|n| HostVerifiedRecord { node: n.clone() })
                .collect();
            let result_checkpoint = state.result_checkpoint("near-cap").unwrap();
            let restored_results = EvaluatedState::restore_host_result_checkpoint(
                &result_checkpoint,
                "near-cap",
                records_list,
            )
            .unwrap()
            .advance(delta(), &[]);
            for (path, advanced) in [
                ("live", &live),
                ("restored full checkpoint", &restored_full),
                ("restored result checkpoint", &restored_results),
            ] {
                assert_eq!(
                    advanced.evaluation(),
                    full_state.evaluation(),
                    "tune {tune}, {path}"
                );
            }
            if available {
                assert!(!live.statistics().rebuilt, "the append takes the fast path");
                assert_eq!(cap_bytes(&live), cap_bytes(&full_state));
                assert_eq!(cap_bytes(&restored_full), cap_bytes(&full_state));
                assert_eq!(cap_bytes(&restored_results), cap_bytes(&full_state));
                // A checkpoint of the live state restores the same
                // count that a full evaluation keeps.
                let saved = live.checkpoint("near-cap").unwrap();
                let restored = EvaluatedState::restore_host_checkpoint(&saved, "near-cap")
                    .unwrap()
                    .advance(PreparedEvaluationInput::new(prepared.options.clone()), &[]);
                assert_eq!(restored.evaluation(), full_state.evaluation());
                assert_eq!(cap_bytes(&restored), cap_bytes(&full_state));
            }
        }
    }

    /// A history whose ancestry bytes pass the fixed base of the cap,
    /// but not the cap for its record count, evaluates. Both of its
    /// checkpoints restore, and an append after the restore matches a
    /// full evaluation.
    #[test]
    fn a_history_past_the_cap_base_evaluates_and_restores() {
        use crate::ancestors::{ANCESTRY_CAP_BASE, ancestry_cap};
        let mut prepared = base();
        prepared.options.limits.traversal = Some(1_000_000_000);
        let issuer = identity_from_seed(&[8u8; 32]);
        // Two interleaved chains of one issuer: each closure holds
        // many ranges, so the bytes pass the base with few records.
        for i in 0..5_900usize {
            prepared.add_host_verified_record(host(
                format!("jve1:{:064x}", 800_000 + i),
                &issuer,
                (i >= 2)
                    .then(|| format!("jve1:{:064x}", 800_000 + i - 2))
                    .into_iter()
                    .collect(),
                json!({"kind":"identity.merge"}),
            ));
        }
        let state = prepared.clone().into_state();
        assert!(state.evaluation().available);
        let bytes = cap_bytes(&state);
        assert!(bytes > ANCESTRY_CAP_BASE, "{bytes} bytes");
        assert!(bytes <= ancestry_cap(prepared.nodes.len()));
        assert_state_roundtrips_and_appends(&state, &prepared, 7);
    }

    #[test]
    fn incremental_fixtures_roundtrip_both_checkpoints_and_append() {
        let mut count = 0usize;
        let base_p = base();
        let base_s = base_p.clone().into_state();
        assert_state_roundtrips_and_appends(&base_s, &base_p, 1);
        count += 1;

        let (proj_p, _, _) = projection_fixture();
        let proj_s = proj_p.clone().into_state();
        assert_state_roundtrips_and_appends(&proj_s, &proj_p, 2);
        count += 1;

        let (chain_p, _, _) = cap_boundary_prepared();
        let chain_s = chain_p.clone().into_state();
        assert_state_roundtrips_and_appends(&chain_s, &chain_p, 3);
        count += 1;

        let (rich_p, _) = rich_checkpoint_fixture();
        let rich_s = rich_p.clone().into_state();
        assert_state_roundtrips_and_appends(&rich_s, &rich_p, 4);
        count += 1;

        // Zero-view unavailable state with publications and unresolved jvr1/bridge targets.
        let mut zero_p = PreparedEvaluationInput::new(EvaluationOptions {
            selected_view: "jve1:0000000000000000000000000000000000000000000000000000000000000000"
                .into(),
            import_selections: BTreeMap::new(),
            overlay: None,
            limits: Limits::default(),
        });
        let (pub_ev, pub_body) = publication();
        zero_p.add_record(&pub_ev, pub_body.as_deref());
        let (j_ev, _) = event(
            2,
            1,
            json!({"kind":"judgment.set","target":format!("jvr1:{:064x}", 123usize),"value":"bless"}),
            None,
        );
        zero_p.add_record(&j_ev, None);
        let zero_s = zero_p.clone().into_state();
        assert_state_roundtrips_and_appends(&zero_s, &zero_p, 5);
        count += 1;

        eprintln!("incremental_fixtures_roundtrip_both_checkpoints_and_append: {count} fixtures");
        assert_eq!(count, 5);
    }

    fn collect_scalar_leaf_mutations(
        value: &Value,
        prefix: &mut Vec<JsonStep>,
        out: &mut Vec<(Vec<JsonStep>, &'static str, Value)>,
    ) {
        match value {
            Value::Object(map) => {
                for (k, v) in map {
                    prefix.push(JsonStep::Key(k.clone()));
                    collect_scalar_leaf_mutations(v, prefix, out);
                    prefix.pop();
                }
            }
            Value::Array(items) => {
                for (i, item) in items.iter().enumerate() {
                    prefix.push(JsonStep::Index(i));
                    collect_scalar_leaf_mutations(item, prefix, out);
                    prefix.pop();
                }
            }
            Value::Number(n) => {
                if let Some(u) = n.as_u64() {
                    if u != 0 {
                        out.push((prefix.clone(), "zero", json!(0u64)));
                    }
                    out.push((prefix.clone(), "plus_one", json!(u.saturating_add(1))));
                    if u > 0 {
                        out.push((prefix.clone(), "minus_one", json!(u - 1)));
                    }
                    let large = 100_000_000u64;
                    if u != large {
                        out.push((prefix.clone(), "large", json!(large)));
                    }
                }
            }
            Value::Bool(b) => {
                out.push((prefix.clone(), "flip_bool", json!(!b)));
            }
            Value::String(s) => {
                let mutated = if let Some(stripped) = s.strip_suffix('0') {
                    format!("{stripped}1")
                } else if !s.is_empty() {
                    let mut chars: Vec<char> = s.chars().collect();
                    *chars.last_mut().unwrap() = '0';
                    chars.into_iter().collect()
                } else {
                    "0".to_owned()
                };
                out.push((prefix.clone(), "change_str", json!(mutated)));
            }
            Value::Null => {}
        }
    }

    fn set_at_json_path(root: &mut Value, path: &[JsonStep], new_value: Value) {
        let mut cursor = root;
        for step in path {
            cursor = match step {
                JsonStep::Key(k) => cursor.get_mut(k).unwrap(),
                JsonStep::Index(i) => cursor.get_mut(*i).unwrap(),
            };
        }
        *cursor = new_value;
    }

    #[test]
    fn refund_above_consumed_work_and_event_quota_below_node_count_are_rejected() {
        let word = jvc_core::word_id(&json!({"language":"jbo","spelling":"banli"})).unwrap();
        let (view, view_body) = event(
            3,
            1,
            json!({"kind":"view.publish","parents":[]}),
            Some(json!({
                "name":"mutation",
                "description":[],
                "roots":[],
                "rafsi_threshold":{"numerator":1,"denominator":1},
                "H":{"numerator":3,"denominator":1},
                "alpha":{"numerator":1,"denominator":2},
                "excluded":[],
                "calculation":"simple-routes-bounds-v1",
                "work":1000,
                "import_sets":[],
                "account_witnesses":[],
                "account_authority":false,
                "notes":[]
            })),
        );
        let def_body: Value = serde_json::from_str(include_str!(
            "../../jvc-core/tests/fixtures/definition.json"
        ))
        .unwrap();
        let (pubn, pubn_body) = event(
            2,
            2,
            json!({"kind":"definition.publish","word":word,"language":"en","parents":[],"origin":"native"}),
            Some(def_body),
        );
        let (judgment, _) = event(
            1,
            3,
            json!({"kind":"judgment.set","target":pubn.id(),"value":"bless"}),
            None,
        );
        let options = EvaluationOptions {
            selected_view: view.id().into(),
            limits: Limits::default(),
            overlay: None,
            import_selections: BTreeMap::new(),
        };
        let mut prepared = PreparedEvaluationInput::new(options);
        prepared.add_record(&view, view_body.as_deref());
        prepared.add_record(&pubn, pubn_body.as_deref());
        prepared.add_record(&judgment, None);
        let records: Vec<HostVerifiedRecord> = prepared
            .nodes
            .values()
            .map(|n| HostVerifiedRecord { node: n.clone() })
            .collect();
        let state = prepared.into_state();
        assert!(state.evaluation().available);
        assert_eq!(state.consumed_work(), 28);

        let full_cp = state.checkpoint("mutation").unwrap();
        let res_cp = state.result_checkpoint("mutation").unwrap();
        let mut failures = Vec::new();

        for (is_results, raw) in [(false, &full_cp), (true, &res_cp)] {
            for (name, field_value) in [
                ("refund_over_consumed", json!(128u64)),
                ("refund_plus_one", json!(1u64)),
            ] {
                let mut cp: Value = serde_json::from_slice(raw).unwrap();
                cp["register_maxima_work"][0] = field_value;
                let bytes = serde_json::to_vec(&cp).unwrap();
                let restored = if is_results {
                    EvaluatedState::restore_host_result_checkpoint(
                        &bytes,
                        "mutation",
                        records.clone(),
                    )
                } else {
                    EvaluatedState::restore_host_checkpoint(&bytes, "mutation")
                };
                if restored.is_ok() {
                    failures.push(format!(
                        "{name} (is_results={is_results}) was accepted on restore"
                    ));
                }
            }

            for (name, quota) in [("events_zero", 0u64), ("events_two", 2u64)] {
                let mut cp: Value = serde_json::from_slice(raw).unwrap();
                cp["options"]["limits"]["events"] = json!(quota);
                let bytes = serde_json::to_vec(&cp).unwrap();
                let restored = if is_results {
                    EvaluatedState::restore_host_result_checkpoint(
                        &bytes,
                        "mutation",
                        records.clone(),
                    )
                } else {
                    EvaluatedState::restore_host_checkpoint(&bytes, "mutation")
                };
                if restored.is_ok() {
                    failures.push(format!(
                        "{name} (is_results={is_results}) was accepted on restore"
                    ));
                }
            }
        }
        assert!(
            failures.is_empty(),
            "refund/event-quota failures ({}):\n{}",
            failures.len(),
            failures.join("\n")
        );
    }

    #[test]
    fn checkpoint_scalar_leaf_mutations_reject_or_are_harmless() {
        let (prepared_open, appended_pub) = rich_checkpoint_fixture();
        let judge = identity_from_seed(&[5u8; 32]);
        let native_pub_id = prepared_open
            .nodes
            .values()
            .find(|n| {
                n.kind == "definition.publish"
                    && n.action.view().index("origin") == "native"
                    && n.body.is_some()
            })
            .unwrap()
            .id
            .clone();
        let appended_judgment = host(
            format!("jve1:{:064x}", 10_029usize),
            &judge,
            vec![
                format!("jve1:{:064x}", 10_020usize),
                format!("jve1:{:064x}", 10_021usize),
                format!("jve1:{:064x}", 10_022usize),
            ],
            json!({"kind":"judgment.set","target":native_pub_id,"value":"curse"}),
        );

        let state_open = prepared_open.clone().into_state();
        assert!(state_open.evaluation().available);
        let records: Vec<HostVerifiedRecord> = prepared_open
            .nodes
            .values()
            .map(|n| HostVerifiedRecord { node: n.clone() })
            .collect();
        let mut after_records = records.clone();
        after_records.push(appended_pub.clone());
        after_records.push(appended_judgment.clone());
        after_records.sort_by(|a, b| a.id().cmp(b.id()));

        // Confirm the unmutated fast path works for both appended_pub and appended_judgment.
        let mut control_delta =
            PreparedEvaluationInput::new(prepared_open.options_with_selections());
        control_delta.add_host_verified_record(appended_pub.clone());
        control_delta.add_host_verified_record(appended_judgment.clone());
        let control_after = state_open.clone().advance(control_delta, &[]);
        assert!(!control_after.statistics().rebuilt);
        assert_eq!(control_after.statistics().incremental_records, 2);

        let saved_full = state_open.checkpoint("scalar-audit").unwrap();
        let saved_results = state_open.result_checkpoint("scalar-audit").unwrap();

        let mut total_checked = 0usize;
        let mut rejected_count = 0usize;
        let mut harmless_count = 0usize;
        let mut harmless_fields = Vec::new();
        let mut failures = Vec::new();
        reset_digest_rejections();

        for (is_results, raw) in [(false, &saved_full), (true, &saved_results)] {
            let root: Value = serde_json::from_slice(raw).unwrap();
            let mut mutations = Vec::new();
            collect_scalar_leaf_mutations(&root, &mut Vec::new(), &mut mutations);

            for (path, label, new_value) in mutations {
                total_checked += 1;
                let path_str = format_json_path(&path);
                let mut mutated = root.clone();
                set_at_json_path(&mut mutated, &path, new_value.clone());
                let bytes = serde_json::to_vec(&mutated).unwrap();
                let restored = if is_results {
                    EvaluatedState::restore_host_result_checkpoint(
                        &bytes,
                        "scalar-audit",
                        records.clone(),
                    )
                } else {
                    EvaluatedState::restore_host_checkpoint(&bytes, "scalar-audit")
                };

                match restored {
                    Err(_) => {
                        rejected_count += 1;
                    }
                    Ok(state) => {
                        let Ok(restored_opts) =
                            serde_json::from_value::<EvaluationOptions>(mutated["options"].clone())
                        else {
                            failures.push(format!(
                                "is_results={is_results} path={path_str} ({label} -> {new_value}): restored with unparseable options"
                            ));
                            continue;
                        };
                        let mut full_before_prep = prepared_open.clone();
                        let mut stripped_opts = restored_opts.clone();
                        full_before_prep.import_selections =
                            std::rc::Rc::new(std::mem::take(&mut stripped_opts.import_selections));
                        full_before_prep.validated_selections =
                            std::rc::Rc::new(std::cell::RefCell::new(BTreeMap::new()));
                        full_before_prep.options = stripped_opts;
                        full_before_prep.event_limit_exceeded = restored_opts
                            .limits
                            .events
                            .is_some_and(|limit| full_before_prep.nodes.len() > limit);
                        let full_before = full_before_prep.clone().into_state();

                        let mut full_after_prep = full_before_prep;
                        full_after_prep.add_host_verified_record(appended_pub.clone());
                        full_after_prep.add_host_verified_record(appended_judgment.clone());
                        let full_after = full_after_prep.into_state();

                        let before_ok = state.evaluation().available
                            == full_before.evaluation().available
                            && state.consumed_work() == full_before.consumed_work()
                            && state.remaining_work == full_before.remaining_work
                            && state.evaluation() == full_before.evaluation();

                        let outcome =
                            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                let mut delta = PreparedEvaluationInput::new(restored_opts);
                                delta.add_host_verified_record(appended_pub.clone());
                                delta.add_host_verified_record(appended_judgment.clone());
                                state.advance(delta, &[])
                            }));

                        match outcome {
                            Err(_) => {
                                failures.push(format!(
                                    "is_results={is_results} path={path_str} ({label} -> {new_value}): advance panicked"
                                ));
                            }
                            Ok(after) => {
                                let after_ok = after.evaluation().available
                                    == full_after.evaluation().available
                                    && after.consumed_work() == full_after.consumed_work()
                                    && after.remaining_work == full_after.remaining_work
                                    && serde_json::to_value(after.evaluation()).unwrap()
                                        == serde_json::to_value(full_after.evaluation()).unwrap();
                                let next_cp_ok =
                                    after.checkpoint("after").ok().is_some_and(|cp| {
                                        EvaluatedState::restore_host_checkpoint(&cp, "after")
                                            .is_ok()
                                    }) && after.result_checkpoint("after").ok().is_some_and(|cp| {
                                        EvaluatedState::restore_host_result_checkpoint(
                                            &cp,
                                            "after",
                                            after_records.clone(),
                                        )
                                        .is_ok()
                                    });
                                if before_ok && after_ok && next_cp_ok {
                                    harmless_count += 1;
                                    harmless_fields.push(format!(
                                        "is_results={is_results} path={path_str} ({label} -> {new_value})"
                                    ));
                                } else {
                                    failures.push(format!(
                                        "is_results={is_results} path={path_str} ({label} -> {new_value}): before_ok={before_ok} after_ok={after_ok} (after_work={} vs full={}) next_cp_ok={next_cp_ok}",
                                        after.consumed_work(),
                                        full_after.consumed_work(),
                                    ));
                                }
                            }
                        }
                    }
                }
            }
        }

        let digest_rejected = digest_rejections();
        eprintln!(
            "checkpoint_scalar_leaf_audit: total_checked={total_checked}, rejected={rejected_count}, digest_rejected={digest_rejected}, harmless={harmless_count}, failures={}",
            failures.len()
        );
        for h in &harmless_fields {
            eprintln!("  HARMLESS: {h}");
        }
        assert!(
            failures.is_empty()
                && rejected_count == total_checked
                && digest_rejected == total_checked
                && harmless_count == 0,
            "checkpoint scalar leaf audit must reject every scalar mutation at digest check (rejected={rejected_count}/{total_checked}, digest_rejected={digest_rejected}, harmless={harmless_count}, failures={}):\n{}",
            failures.len(),
            failures.join("\n")
        );
    }

    #[test]
    fn r8_conflicted_register_reference_and_command_mutations_are_rejected() {
        let word = jvc_core::word_id(&json!({"language":"jbo","spelling":"banli"})).unwrap();
        let def_body: Value = serde_json::from_str(include_str!(
            "../../jvc-core/tests/fixtures/definition.json"
        ))
        .unwrap();

        // 1. Conflicted 2-sibling judgment register counter mutations.
        let (view, view_body) = event(
            3,
            1,
            json!({"kind":"view.publish","parents":[]}),
            Some(json!({
                "name":"fork-counters",
                "description":[],
                "roots":[],
                "rafsi_threshold":{"numerator":1,"denominator":1},
                "H":{"numerator":3,"denominator":1},
                "alpha":{"numerator":1,"denominator":2},
                "excluded":[],
                "calculation":"simple-routes-bounds-v1",
                "work":1000,
                "import_sets":[],
                "account_witnesses":[],
                "account_authority":false,
                "notes":[]
            })),
        );
        let (pubn, pubn_body) = event(
            2,
            2,
            json!({"kind":"definition.publish","word":word,"language":"en","parents":[],"origin":"native"}),
            Some(def_body.clone()),
        );
        let (j_bless, _) = event(
            1,
            3,
            json!({"kind":"judgment.set","target":pubn.id(),"value":"bless"}),
            None,
        );
        let (j_curse, _) = event(
            1,
            5,
            json!({"kind":"judgment.set","target":pubn.id(),"value":"curse"}),
            None,
        );
        let fork_opts = EvaluationOptions {
            selected_view: view.id().into(),
            limits: Limits::default(),
            overlay: None,
            import_selections: BTreeMap::new(),
        };
        let mut fork_prep = PreparedEvaluationInput::new(fork_opts);
        fork_prep.add_record(&view, view_body.as_deref());
        fork_prep.add_record(&pubn, pubn_body.as_deref());
        fork_prep.add_record(&j_bless, None);
        fork_prep.add_record(&j_curse, None);
        let fork_records: Vec<HostVerifiedRecord> = fork_prep
            .nodes
            .values()
            .map(|n| HostVerifiedRecord { node: n.clone() })
            .collect();
        let fork_state = fork_prep.into_state();
        assert_eq!(fork_state.consumed_work(), 42);
        let fork_full = fork_state.checkpoint("fork").unwrap();
        let fork_res = fork_state.result_checkpoint("fork").unwrap();

        let reseal = |mut cp: Value| -> Vec<u8> {
            cp.as_object_mut().unwrap().remove("digest");
            let mut bytes = serde_json::to_vec(&cp).unwrap();
            let digest = jvc_core::hash_id("sha256:", b"", &bytes);
            bytes.pop();
            bytes.extend_from_slice(format!(",\"digest\":\"{digest}\"}}").as_bytes());
            bytes
        };

        let mut failures = Vec::new();
        let mut expected_digest_rejections = 0usize;
        reset_digest_rejections();
        for (is_results, raw) in [(false, &fork_full), (true, &fork_res)] {
            for mode in [
                "work_plus_one",
                "work_minus_one",
                "member_plus_one",
                "ancestry_plus_eight",
            ] {
                let mut cp: Value = serde_json::from_slice(raw).unwrap();
                match mode {
                    "work_plus_one" => {
                        cp["register_maxima_work"][0] =
                            json!(cp["register_maxima_work"][0].as_u64().unwrap() + 1);
                    }
                    "work_minus_one" => {
                        cp["register_maxima_work"][0] =
                            json!(cp["register_maxima_work"][0].as_u64().unwrap() - 1);
                    }
                    "member_plus_one" => {
                        cp["register_maxima_member_work"][0] =
                            json!(cp["register_maxima_member_work"][0].as_u64().unwrap() + 1);
                    }
                    "ancestry_plus_eight" => {
                        cp["ancestry_bytes"] = json!(cp["ancestry_bytes"].as_u64().unwrap() + 8);
                    }
                    _ => unreachable!(),
                }
                expected_digest_rejections += 1;
                let bytes = serde_json::to_vec(&cp).unwrap();
                let restored = if is_results {
                    EvaluatedState::restore_host_result_checkpoint(
                        &bytes,
                        "fork",
                        fork_records.clone(),
                    )
                } else {
                    EvaluatedState::restore_host_checkpoint(&bytes, "fork")
                };
                if restored.is_ok() {
                    failures.push(format!(
                        "fork counter mutation {mode} (is_results={is_results}) was accepted at digest check"
                    ));
                }
                if mode == "member_plus_one" {
                    let resealed = reseal(cp);
                    let restored_resealed = if is_results {
                        EvaluatedState::restore_host_result_checkpoint(
                            &resealed,
                            "fork",
                            fork_records.clone(),
                        )
                    } else {
                        EvaluatedState::restore_host_checkpoint(&resealed, "fork")
                    };
                    if restored_resealed.is_ok() {
                        failures.push(format!(
                            "fork counter mutation {mode} (is_results={is_results}) was accepted at cross-check"
                        ));
                    }
                }
            }
        }

        // 2. Missing policy parent, missing judgment target (suspended issuer), missing status target (compromised cutoff), and commands without controller.
        let (parent_view, parent_view_body) = event(
            3,
            10,
            json!({"kind":"view.publish","parents":[]}),
            Some(json!({
                "name":"parent-view",
                "description":[],
                "roots":[],
                "rafsi_threshold":{"numerator":1,"denominator":1},
                "H":{"numerator":3,"denominator":1},
                "alpha":{"numerator":1,"denominator":2},
                "excluded":[],
                "calculation":"simple-routes-bounds-v1",
                "work":1000,
                "import_sets":[],
                "account_witnesses":[identity_from_seed(&[10;32]),identity_from_seed(&[11;32])],
                "account_authority":true,
                "notes":[]
            })),
        );
        let (child_view, child_view_body) = event(
            3,
            11,
            json!({"kind":"view.publish","parents":[parent_view.id()]}),
            Some(json!({
                "name":"child-view",
                "description":[],
                "roots":[],
                "rafsi_threshold":{"numerator":1,"denominator":1},
                "H":{"numerator":3,"denominator":1},
                "alpha":{"numerator":1,"denominator":2},
                "excluded":[],
                "calculation":"simple-routes-shun-v1",
                "work":1000,
                "import_sets":[],
                "account_witnesses":[identity_from_seed(&[10;32]),identity_from_seed(&[11;32])],
                "account_authority":true,
                "notes":[]
            })),
        );
        let mut ref_prep = PreparedEvaluationInput::new(EvaluationOptions {
            selected_view: child_view.id().into(),
            limits: Limits::default(),
            overlay: None,
            import_selections: BTreeMap::new(),
        });
        ref_prep.add_record(&parent_view, parent_view_body.as_deref());
        ref_prep.add_record(&child_view, child_view_body.as_deref());
        ref_prep.add_record(&pubn, pubn_body.as_deref());

        let (imported_pub, imported_bytes) = publication();
        ref_prep.add_record(&imported_pub, imported_bytes.as_deref());

        // Suspended issuer judgment on pubn.
        let susp_issuer = identity_from_seed(&[16u8; 32]);
        let susp_merge_id = format!("jve1:{:064x}", 20_001usize);
        let susp_j_id = format!("jve1:{:064x}", 20_002usize);
        ref_prep.add_host_verified_record(host(
            susp_merge_id,
            &susp_issuer,
            vec![format!("jve1:{:064x}", 999_999usize)],
            json!({"kind":"identity.merge"}),
        ));
        ref_prep.add_host_verified_record(host(
            susp_j_id.clone(),
            &susp_issuer,
            vec![],
            json!({"kind":"judgment.set","target":pubn.id(),"value":"bless"}),
        ));

        // Compromised issuer status on pubn.
        let pub_issuer = identity_from_seed(&[2u8; 32]);
        let status_id = format!("jve1:{:064x}", 20_003usize);
        let comp_id = format!("jve1:{:064x}", 20_004usize);
        ref_prep.add_host_verified_record(host(
            status_id.clone(),
            &pub_issuer,
            vec![pubn.id().to_owned()],
            json!({"kind":"status.set","target":pubn.id(),"value":"deprecated"}),
        ));
        ref_prep.add_host_verified_record(host(
            comp_id,
            &pub_issuer,
            vec![status_id.clone()],
            json!({"kind":"identity.compromise","safe":[pubn.id()]}),
        ));
        ref_prep.add_host_verified_record(host(
            format!("jve1:{:064x}", 20_005usize),
            &pub_issuer,
            vec![],
            json!({"kind":"account.set","origin":"https://source.example","account":41,"value":"claim","previous":null,"carry":[]}),
        ));

        let ref_records: Vec<HostVerifiedRecord> = ref_prep
            .nodes
            .values()
            .map(|n| HostVerifiedRecord { node: n.clone() })
            .collect();
        let ref_state = ref_prep.into_state();
        assert!(ref_state.evaluation().available);
        assert!(
            ref_state.evaluation().accounts["https://source.example#41"]
                .controller
                .is_none()
        );
        assert!(!ref_state.evaluation().accounts["https://source.example#41"].commands);

        let ref_full = ref_state.checkpoint("refs").unwrap();
        let ref_res = ref_state.result_checkpoint("refs").unwrap();
        let absent_id = "jve1:d35592ad38db5065c8ab84f7a684d87f12276160c24dce75301f7a235adfa0b0";

        for (name, path_kind) in [
            ("missing_policy_parent", 0u8),
            ("missing_judgment_target", 1u8),
            ("missing_status_target", 2u8),
        ] {
            let mut cp: Value = serde_json::from_slice(&ref_full).unwrap();
            match path_kind {
                0 => {
                    cp["nodes"][child_view.id()]["action"]["parents"][0] = json!(absent_id);
                }
                1 => {
                    cp["nodes"][&susp_j_id]["action"]["target"] = json!(absent_id);
                }
                _ => {
                    cp["nodes"][&status_id]["action"]["target"] = json!(absent_id);
                }
            }
            expected_digest_rejections += 1;
            let bytes = serde_json::to_vec(&cp).unwrap();
            if EvaluatedState::restore_host_checkpoint(&bytes, "refs").is_ok() {
                failures.push(format!(
                    "{name} (full checkpoint) was accepted at digest check"
                ));
            }
            let resealed = reseal(cp);
            if EvaluatedState::restore_host_checkpoint(&resealed, "refs").is_ok() {
                failures.push(format!(
                    "{name} (full checkpoint) was accepted at cross-check"
                ));
            }
        }

        for (is_results, raw) in [(false, &ref_full), (true, &ref_res)] {
            let mut cp: Value = serde_json::from_slice(raw).unwrap();
            cp["evaluation"]["accounts"]["https://source.example#41"]["commands"] = json!(true);
            expected_digest_rejections += 1;
            let bytes = serde_json::to_vec(&cp).unwrap();
            let restored = if is_results {
                EvaluatedState::restore_host_result_checkpoint(&bytes, "refs", ref_records.clone())
            } else {
                EvaluatedState::restore_host_checkpoint(&bytes, "refs")
            };
            if restored.is_ok() {
                failures.push(format!(
                    "commands_without_controller (is_results={is_results}) was accepted at digest check"
                ));
            }
            let resealed = reseal(cp);
            let restored_resealed = if is_results {
                EvaluatedState::restore_host_result_checkpoint(
                    &resealed,
                    "refs",
                    ref_records.clone(),
                )
            } else {
                EvaluatedState::restore_host_checkpoint(&resealed, "refs")
            };
            if restored_resealed.is_ok() {
                failures.push(format!(
                    "commands_without_controller (is_results={is_results}) was accepted at cross-check"
                ));
            }
        }

        let actual_digest_rejections = digest_rejections();
        assert_eq!(actual_digest_rejections, expected_digest_rejections);
        assert!(
            failures.is_empty(),
            "r8 mutation failures ({}):\n{}",
            failures.len(),
            failures.join("\n")
        );
    }

    #[test]
    fn quota_crossing_and_seeded_random_checkpoint_sequences_restore_and_match_full() {
        let word = jvc_core::word_id(&json!({"language":"jbo","spelling":"banli"})).unwrap();
        let def_body: Value = serde_json::from_str(include_str!(
            "../../jvc-core/tests/fixtures/definition.json"
        ))
        .unwrap();
        let (view, view_body) = event(
            3,
            1,
            json!({"kind":"view.publish","parents":[]}),
            Some(json!({
                "name":"quota-transition",
                "description":[],
                "roots":[],
                "rafsi_threshold":{"numerator":1,"denominator":1},
                "H":{"numerator":3,"denominator":1},
                "alpha":{"numerator":1,"denominator":2},
                "excluded":[],
                "calculation":"simple-routes-bounds-v1",
                "work":1000,
                "import_sets":[],
                "account_witnesses":[],
                "account_authority":false,
                "notes":[]
            })),
        );
        let (pubn, pubn_body) = event(
            2,
            2,
            json!({"kind":"definition.publish","word":word,"language":"en","parents":[],"origin":"native"}),
            Some(def_body.clone()),
        );
        let (other_pubn, other_pubn_body) = event(
            5,
            7,
            json!({"kind":"definition.publish","word":word,"language":"en","parents":[],"origin":"native"}),
            Some(def_body),
        );
        let (judgment, _) = event(
            1,
            3,
            json!({"kind":"judgment.set","target":pubn.id(),"value":"bless"}),
            None,
        );
        let judge_issuer = identity_from_seed(&[1u8; 32]);
        let next_judgment = host(
            format!("jve1:{:064x}", 30_004usize),
            &judge_issuer,
            vec![judgment.id().to_owned()],
            json!({"kind":"judgment.set","target":pubn.id(),"value":"curse"}),
        );

        let base_opts = EvaluationOptions {
            selected_view: view.id().into(),
            limits: Limits::default(),
            overlay: None,
            import_selections: BTreeMap::new(),
        };
        let mut base_prep = PreparedEvaluationInput::new(base_opts.clone());
        base_prep.add_record(&view, view_body.as_deref());
        base_prep.add_record(&pubn, pubn_body.as_deref());
        base_prep.add_record(&judgment, None);
        let base_records: Vec<HostVerifiedRecord> = base_prep
            .nodes
            .values()
            .map(|n| HostVerifiedRecord { node: n.clone() })
            .collect();

        let build_quota_state = |opts: EvaluationOptions, append: bool| -> EvaluatedState {
            let mut p = PreparedEvaluationInput::new(opts);
            for r in &base_records {
                p.add_host_verified_record(r.clone());
            }
            if append {
                p.add_host_verified_record(next_judgment.clone());
            }
            p.into_state()
        };

        let mut failures = Vec::new();
        let mut fixed_checks = 0usize;

        // Part 1: Fixed quota-crossing cases (quota = 0, 2, 3 across direct, full restore, results restore, and recovery back to open quota).
        for quota in [0usize, 2, 3] {
            let mut opts = base_opts.clone();
            if quota == 3 {
                opts.limits.events = Some(3);
            }
            let base = build_quota_state(opts.clone(), false);
            let fc = base.checkpoint("quota").unwrap();
            let rc = base.result_checkpoint("quota").unwrap();
            let restored_full = EvaluatedState::restore_host_checkpoint(&fc, "quota").unwrap();
            let restored_res =
                EvaluatedState::restore_host_result_checkpoint(&rc, "quota", base_records.clone())
                    .unwrap();

            for (label, state) in [
                ("direct", base),
                ("full", restored_full),
                ("results", restored_res),
            ] {
                fixed_checks += 1;
                let mut next_opts = opts.clone();
                next_opts.limits.events = Some(quota);
                let mut delta = PreparedEvaluationInput::new(next_opts.clone());
                delta.add_host_verified_record(next_judgment.clone());
                let after = state.advance(delta, &[]);
                let full = build_quota_state(next_opts.clone(), true);

                let mut after_records = base_records.clone();
                after_records.push(next_judgment.clone());
                after_records.sort_by(|a, b| a.id().cmp(b.id()));

                let cp = after.checkpoint("after").unwrap();
                let rp = after.result_checkpoint("after").unwrap();
                let rf = EvaluatedState::restore_host_checkpoint(&cp, "after");
                let rr = EvaluatedState::restore_host_result_checkpoint(
                    &rp,
                    "after",
                    after_records.clone(),
                );
                if after.evaluation() != full.evaluation()
                    || after.consumed_work() != full.consumed_work()
                    || after.remaining_work != full.remaining_work
                    || rf.is_err()
                    || rr.is_err()
                {
                    failures.push(format!(
                        "fixed quota={quota} path={label}: eval_eq={} work={}/{} full_restore={:?} res_restore={:?}",
                        after.evaluation() == full.evaluation(),
                        after.consumed_work(),
                        full.consumed_work(),
                        rf.as_ref().map(|_| ()).map_err(|e| e.to_string()),
                        rr.as_ref().map(|_| ()).map_err(|e| e.to_string()),
                    ));
                } else if let (Ok(rf_state), Ok(rr_state)) = (rf, rr) {
                    // Recover from over-quota back to open quota and verify restore again.
                    for (rec_label, over_state) in [("rf", rf_state), ("rr", rr_state)] {
                        fixed_checks += 1;
                        let mut open_opts = next_opts.clone();
                        open_opts.limits.events = Some(10);
                        let recovered = over_state
                            .advance(PreparedEvaluationInput::new(open_opts.clone()), &[]);
                        let expected_rec = build_quota_state(open_opts, true);
                        let rec_cp = recovered.checkpoint("rec").unwrap();
                        let rec_rp = recovered.result_checkpoint("rec").unwrap();
                        if recovered.evaluation() != expected_rec.evaluation()
                            || recovered.consumed_work() != expected_rec.consumed_work()
                            || EvaluatedState::restore_host_checkpoint(&rec_cp, "rec").is_err()
                            || EvaluatedState::restore_host_result_checkpoint(
                                &rec_rp,
                                "rec",
                                after_records.clone(),
                            )
                            .is_err()
                        {
                            failures.push(format!(
                                "fixed recovery quota={quota} path={label}/{rec_label} failed"
                            ));
                        }
                    }
                }
            }
        }

        // Part 1b: Fixed all-root regression cases (pending/invalid/excluded register-keyed records and root compromises).
        let absent_root_id =
            "jve1:00000000000000000000000000000000000000000000000000000000000000aa";
        let (b_valid, _) = event(
            2,
            10,
            json!({"kind":"bridge.set","origin":"https://example.org","source_definition":1,"target":pubn.id(),"value":"clear"}),
            None,
        );
        let (b_pending, _) = event(
            2,
            11,
            json!({"kind":"bridge.set","origin":"https://example.org","source_definition":1,"target":absent_root_id,"value":"clear"}),
            None,
        );
        let (b_invalid, _) = event(
            2,
            12,
            json!({"kind":"bridge.set","origin":"https://example.org","source_definition":1,"target":other_pubn.id(),"value":"clear"}),
            None,
        );
        let (b_managed_unlinked, _) = event(
            2,
            13,
            json!({"kind":"bridge.set","origin":"https://example.org","source_definition":1,"target":pubn.id(),"value":"managed"}),
            None,
        );
        let (c_absent, _) = event(
            4,
            21,
            json!({"kind":"identity.compromise","safe":[absent_root_id]}),
            None,
        );

        let build_root_prep = |recs: &[(&VerifiedEnvelope, Option<&[u8]>)]| {
            let mut p = PreparedEvaluationInput::new(base_opts.clone());
            for (env, body) in recs {
                p.add_record(env, *body);
            }
            p
        };
        let root_a2_prep = build_root_prep(&[
            (&view, view_body.as_deref()),
            (&pubn, pubn_body.as_deref()),
            (&b_valid, None),
            (&b_pending, None),
        ]);
        let root_a4_prep = build_root_prep(&[
            (&view, view_body.as_deref()),
            (&pubn, pubn_body.as_deref()),
            (&other_pubn, other_pubn_body.as_deref()),
            (&b_valid, None),
            (&b_invalid, None),
        ]);
        let root_b2_prep = build_root_prep(&[
            (&view, view_body.as_deref()),
            (&pubn, pubn_body.as_deref()),
            (&c_absent, None),
        ]);
        let root_a5_prep = build_root_prep(&[
            (&view, view_body.as_deref()),
            (&pubn, pubn_body.as_deref()),
            (&b_valid, None),
            (&b_managed_unlinked, None),
        ]);

        for (case_name, prep) in [
            ("A2_two_root_bridges_one_pending", &root_a2_prep),
            ("A4_two_root_bridges_one_invalid", &root_a4_prep),
            ("A5_two_root_bridges_one_binding_unavailable", &root_a5_prep),
            ("B2_root_compromise_absent_safe", &root_b2_prep),
        ] {
            fixed_checks += 1;
            let state = prep.clone().into_state();
            let recs: Vec<HostVerifiedRecord> = prep
                .nodes
                .values()
                .map(|n| HostVerifiedRecord { node: n.clone() })
                .collect();
            let fc = state.checkpoint(case_name).unwrap();
            let rc = state.result_checkpoint(case_name).unwrap();
            let rf = EvaluatedState::restore_host_checkpoint(&fc, case_name);
            let rr = EvaluatedState::restore_host_result_checkpoint(&rc, case_name, recs);
            if rf.is_err() || rr.is_err() {
                failures.push(format!(
                    "fixed {case_name}: full_restore={:?} res_restore={:?}",
                    rf.as_ref().map(|_| ()).map_err(|e| e.to_string()),
                    rr.as_ref().map(|_| ()).map_err(|e| e.to_string()),
                ));
            }
        }

        // Part 2: Seeded random sequences over handover and incremental fixtures (including all-root fixtures).
        let (proj_prep, _, _) = projection_fixture();
        let (rich_prep, _) = rich_checkpoint_fixture();
        let all_root_start = build_root_prep(&[
            (&view, view_body.as_deref()),
            (&pubn, pubn_body.as_deref()),
            (&other_pubn, other_pubn_body.as_deref()),
        ]);
        let fixtures: Vec<(&str, PreparedEvaluationInput)> = vec![
            ("base", base()),
            ("projection", proj_prep),
            ("rich_handover", rich_prep),
            ("quota_base", base_prep),
            ("all_root", all_root_start),
        ];

        let mut rng_state = 0x9E37_79B9_7F4A_7C15u64;
        let mut next_u64 = || -> u64 {
            rng_state ^= rng_state << 13;
            rng_state ^= rng_state >> 7;
            rng_state ^= rng_state << 17;
            rng_state
        };

        let mut sequences_run = 0usize;
        let mut steps_run = 0usize;
        let mut checkpoints_verified = 0usize;

        for seq in 0..100usize {
            let (fixture_name, start_prep) = &fixtures[seq % fixtures.len()];
            let mut current_options = start_prep.options_with_selections();
            let mut current_records: BTreeMap<String, HostVerifiedRecord> = start_prep
                .nodes
                .iter()
                .map(|(id, n)| (id.clone(), HostVerifiedRecord { node: n.clone() }))
                .collect();
            let base_open = unshared(start_prep).into_state();
            let base_cost = base_open.consumed_work().max(20);
            let mut state = base_open;
            let mut append_seq = 0usize;
            sequences_run += 1;

            for step in 0..12usize {
                steps_run += 1;
                let op = (next_u64() % 6) as usize;
                let binding = format!("seq-{seq}-step-{step}");
                match op {
                    0 => {
                        // Save and restore full checkpoint.
                        let cp = state.checkpoint(&binding).unwrap();
                        match EvaluatedState::restore_host_checkpoint(&cp, &binding) {
                            Ok(restored) => {
                                checkpoints_verified += 1;
                                state = restored;
                            }
                            Err(e) => {
                                failures.push(format!(
                                    "seq={seq} ({fixture_name}) step={step} op=restore_full failed: {e}"
                                ));
                                break;
                            }
                        }
                    }
                    1 => {
                        // Save and restore results checkpoint.
                        let rp = state.result_checkpoint(&binding).unwrap();
                        let recs: Vec<HostVerifiedRecord> =
                            current_records.values().cloned().collect();
                        match EvaluatedState::restore_host_result_checkpoint(&rp, &binding, recs) {
                            Ok(restored) => {
                                checkpoints_verified += 1;
                                state = restored;
                            }
                            Err(e) => {
                                failures.push(format!(
                                    "seq={seq} ({fixture_name}) step={step} op=restore_results failed: {e}"
                                ));
                                break;
                            }
                        }
                    }
                    2 => {
                        // Append a fast-path record or an all-root shape (pending/invalid/excluded keyed record or root compromise).
                        append_seq += 1;
                        let mut delta = PreparedEvaluationInput::new(current_options.clone());
                        if *fixture_name == "all_root" || (append_seq % 4 == 0) {
                            match append_seq % 4 {
                                0 => {
                                    // Two root bridges sharing a register key: one valid, one target_pending.
                                    let issuer = identity_from_seed(&[2u8; 32]);
                                    let src_def = (seq * 100 + step * 10 + append_seq) as u64;
                                    let r1 = host(
                                        format!(
                                            "jve1:fa{:030x}{:032x}",
                                            seq,
                                            step * 100 + append_seq
                                        ),
                                        &issuer,
                                        vec![],
                                        json!({"kind":"bridge.set","origin":"https://example.org","source_definition":src_def,"target":pubn.id(),"value":"clear"}),
                                    );
                                    let r2 = host(
                                        format!(
                                            "jve1:fb{:030x}{:032x}",
                                            seq,
                                            step * 100 + append_seq
                                        ),
                                        &issuer,
                                        vec![],
                                        json!({"kind":"bridge.set","origin":"https://example.org","source_definition":src_def,"target":absent_root_id,"value":"clear"}),
                                    );
                                    for r in [r1, r2] {
                                        current_records.insert(r.id().to_owned(), r.clone());
                                        delta.add_host_verified_record(r);
                                    }
                                }
                                1 => {
                                    // Two root bridges sharing a register key: one valid, one invalid_target.
                                    let issuer = identity_from_seed(&[2u8; 32]);
                                    let src_def = (seq * 100 + step * 10 + append_seq) as u64;
                                    let r1 = host(
                                        format!(
                                            "jve1:f8{:030x}{:032x}",
                                            seq,
                                            step * 100 + append_seq
                                        ),
                                        &issuer,
                                        vec![],
                                        json!({"kind":"bridge.set","origin":"https://example.org","source_definition":src_def,"target":pubn.id(),"value":"clear"}),
                                    );
                                    let r2 = host(
                                        format!(
                                            "jve1:f9{:030x}{:032x}",
                                            seq,
                                            step * 100 + append_seq
                                        ),
                                        &issuer,
                                        vec![],
                                        json!({"kind":"bridge.set","origin":"https://example.org","source_definition":src_def,"target":other_pubn.id(),"value":"clear"}),
                                    );
                                    for r in [r1, r2] {
                                        current_records.insert(r.id().to_owned(), r.clone());
                                        delta.add_host_verified_record(r);
                                    }
                                }
                                2 => {
                                    // Root compromise with an absent safe ID.
                                    let comp_seed = (90 + (append_seq % 30)) as u8;
                                    let issuer = identity_from_seed(&[comp_seed; 32]);
                                    let r = host(
                                        format!(
                                            "jve1:f7{:030x}{:032x}",
                                            seq,
                                            step * 100 + append_seq
                                        ),
                                        &issuer,
                                        vec![],
                                        json!({"kind":"identity.compromise","safe":[absent_root_id]}),
                                    );
                                    current_records.insert(r.id().to_owned(), r.clone());
                                    delta.add_host_verified_record(r);
                                }
                                _ => {
                                    // Two root bridges sharing a register key: one valid (clear), one managed without account binding (account_binding_unavailable).
                                    let issuer = identity_from_seed(&[2u8; 32]);
                                    let src_def = (seq * 100 + step * 10 + append_seq) as u64;
                                    let r1 = host(
                                        format!(
                                            "jve1:f4{:030x}{:032x}",
                                            seq,
                                            step * 100 + append_seq
                                        ),
                                        &issuer,
                                        vec![],
                                        json!({"kind":"bridge.set","origin":"https://example.org","source_definition":src_def,"target":pubn.id(),"value":"clear"}),
                                    );
                                    let r2 = host(
                                        format!(
                                            "jve1:f5{:030x}{:032x}",
                                            seq,
                                            step * 100 + append_seq
                                        ),
                                        &issuer,
                                        vec![],
                                        json!({"kind":"bridge.set","origin":"https://example.org","source_definition":src_def,"target":pubn.id(),"value":"managed"}),
                                    );
                                    for r in [r1, r2] {
                                        current_records.insert(r.id().to_owned(), r.clone());
                                        delta.add_host_verified_record(r);
                                    }
                                }
                            }
                        } else {
                            let rec = if append_seq % 2 == 0 {
                                let issuer_seed = (200 + (append_seq % 40)) as u8;
                                let issuer = identity_from_seed(&[issuer_seed; 32]);
                                let prev: Vec<String> = current_records
                                    .values()
                                    .filter(|r| r.node.issuer == issuer)
                                    .map(|r| r.node.id.clone())
                                    .collect();
                                host_missing_body(
                                    format!("jve1:fe{:030x}{:032x}", seq, step * 100 + append_seq),
                                    &issuer,
                                    prev,
                                    json!({"kind":"definition.publish","word":word,"language":"en","parents":[],"origin":"native"}),
                                )
                            } else {
                                let issuer_seed = (150 + (append_seq % 40)) as u8;
                                let issuer = identity_from_seed(&[issuer_seed; 32]);
                                let prev: Vec<String> = current_records
                                    .values()
                                    .filter(|r| r.node.issuer == issuer)
                                    .map(|r| r.node.id.clone())
                                    .collect();
                                let target = current_records
                                    .values()
                                    .find(|r| r.node.kind == "definition.publish")
                                    .map(|r| r.node.id.clone())
                                    .unwrap_or_else(|| pubn.id().to_owned());
                                let val = if (next_u64() & 1) == 0 {
                                    "bless"
                                } else {
                                    "curse"
                                };
                                host(
                                    format!("jve1:fd{:030x}{:032x}", seq, step * 100 + append_seq),
                                    &issuer,
                                    prev,
                                    json!({"kind":"judgment.set","target":target,"value":val}),
                                )
                            };
                            current_records.insert(rec.id().to_owned(), rec.clone());
                            delta.add_host_verified_record(rec);
                        }
                        state = state.advance(delta, &[]);
                    }
                    3 => {
                        // Change the event quota.
                        let n = current_records.len();
                        current_options.limits.events = match next_u64() % 5 {
                            0 => None,
                            1 => Some(0),
                            2 => Some(n.saturating_sub(1)),
                            3 => Some(n),
                            _ => Some(n + 2),
                        };
                        state = state
                            .advance(PreparedEvaluationInput::new(current_options.clone()), &[]);
                    }
                    4 => {
                        // Change the overlay.
                        let new_overlay = match next_u64() % 4 {
                            0 => None,
                            1 => Some(json!({
                                "version": 1,
                                "base_view": current_options.selected_view,
                                "root_changes": [],
                                "trust": [],
                                "blocked": [],
                                "work": null
                            })),
                            2 => Some(json!({
                                "version": 2,
                                "root_changes": [],
                                "trust": [],
                                "blocked": [],
                                "public_shun_issuer": null
                            })),
                            _ => Some(json!({"version": 3})),
                        };
                        current_options.overlay = new_overlay.clone().map(Into::into);
                        if (next_u64() & 1) == 0 {
                            state = state.with_overlay(new_overlay);
                        } else {
                            state = state.advance(
                                PreparedEvaluationInput::new(current_options.clone()),
                                &[],
                            );
                        }
                    }
                    _ => {
                        // Change the traversal budget.
                        current_options.limits.traversal = match next_u64() % 5 {
                            0 => None,
                            1 => Some(0),
                            2 => Some(base_cost.saturating_sub(1)),
                            3 => Some(base_cost),
                            _ => Some(base_cost + 500),
                        };
                        state = state
                            .advance(PreparedEvaluationInput::new(current_options.clone()), &[]);
                    }
                }

                // Verify against a fresh full evaluation and verify that both checkpoints restore.
                let mut full_prep = PreparedEvaluationInput::new(current_options.clone());
                for r in current_records.values() {
                    full_prep.add_host_verified_record(r.clone());
                }
                let full_state = full_prep.into_state();
                if state.evaluation().available != full_state.evaluation().available
                    || state.consumed_work() != full_state.consumed_work()
                    || state.remaining_work != full_state.remaining_work
                    || serde_json::to_value(state.evaluation()).unwrap()
                        != serde_json::to_value(full_state.evaluation()).unwrap()
                {
                    failures.push(format!(
                        "seq={seq} ({fixture_name}) step={step} op={op}: state mismatch work={}/{} avail={}/{}",
                        state.consumed_work(),
                        full_state.consumed_work(),
                        state.evaluation().available,
                        full_state.evaluation().available,
                    ));
                    break;
                }

                let cp_full = state.checkpoint(&binding).unwrap();
                let cp_res = state.result_checkpoint(&binding).unwrap();
                let recs: Vec<HostVerifiedRecord> = current_records.values().cloned().collect();
                match (
                    EvaluatedState::restore_host_checkpoint(&cp_full, &binding),
                    EvaluatedState::restore_host_result_checkpoint(&cp_res, &binding, recs),
                ) {
                    (Ok(rf), Ok(rr)) => {
                        checkpoints_verified += 2;
                        if (step + seq) % 2 == 0 {
                            state = rf;
                        } else {
                            state = rr;
                        }
                    }
                    (rf, rr) => {
                        failures.push(format!(
                            "seq={seq} ({fixture_name}) step={step} op={op}: checkpoint restore failed full={:?} res={:?}",
                            rf.as_ref().map(|_| ()).map_err(|e| e.to_string()),
                            rr.as_ref().map(|_| ()).map_err(|e| e.to_string()),
                        ));
                        break;
                    }
                }
            }
        }

        eprintln!(
            "checkpoint_random_sequences: fixed_checks={fixed_checks}, sequences={sequences_run}, steps={steps_run}, checkpoints_verified={checkpoints_verified}, failures={}",
            failures.len()
        );
        assert!(
            failures.is_empty(),
            "checkpoint sequence failures ({}):\n{}",
            failures.len(),
            failures.join("\n")
        );
    }

    #[test]
    fn unused_or_refused_selections_are_not_indexed_in_session_unresolved() {
        let (view, view_body) = event(
            1,
            1,
            json!({"kind":"view.publish","parents":[]}),
            Some(json!({
                "name":"fixture",
                "description":[],
                "roots":[{"identity":identity_from_seed(&[1;32]),"q":{"numerator":1,"denominator":1}}],
                "rafsi_threshold":{"numerator":1,"denominator":1},
                "H":{"numerator":3,"denominator":1},
                "alpha":{"numerator":1,"denominator":2},
                "excluded":[],
                "calculation":"simple-routes-bounds-v1",
                "work":1000,
                "import_sets":[],
                "account_witnesses":[],
                "account_authority":false,
                "notes":[]
            })),
        );
        let unused_ids: Vec<String> = (0..4_096usize)
            .map(|i| format!("jve1:{:064x}", i + 1))
            .collect();
        let mut available_input = PreparedEvaluationInput::new(EvaluationOptions {
            selected_view: view.id().into(),
            import_selections: BTreeMap::from([("unused".into(), unused_ids.clone())]),
            overlay: None,
            limits: Limits::default(),
        });
        available_input.add_record(&view, view_body.as_deref());
        let available_state = available_input.into_state();
        assert!(available_state.evaluation().available);
        assert!(
            available_state.unresolved.is_empty(),
            "unused selection IDs must not be copied into unresolved on an available session (got {} IDs)",
            available_state.unresolved.len()
        );

        // Also test a zero-traversal refused session with both unused and referenced selections.
        let referenced_digest = jvc_core::hash_id(
            "sha256:",
            b"",
            &canonical_value(&json!(unused_ids)).unwrap(),
        );
        let (ref_view, ref_view_body) = event(
            1,
            2,
            json!({"kind":"view.publish","parents":[]}),
            Some(json!({
                "name":"fixture",
                "description":[],
                "roots":[{"identity":identity_from_seed(&[1;32]),"q":{"numerator":1,"denominator":1}}],
                "rafsi_threshold":{"numerator":1,"denominator":1},
                "H":{"numerator":3,"denominator":1},
                "alpha":{"numerator":1,"denominator":2},
                "excluded":[],
                "calculation":"simple-routes-bounds-v1",
                "work":1000,
                "import_sets":[{"source":"https://example.org","importer":identity_from_seed(&[1;32]),"selection":referenced_digest}],
                "account_witnesses":[],
                "account_authority":false,
                "notes":[]
            })),
        );
        let mut refused_input = PreparedEvaluationInput::new(EvaluationOptions {
            selected_view: ref_view.id().into(),
            import_selections: BTreeMap::from([
                ("unused".into(), unused_ids.clone()),
                (referenced_digest, unused_ids),
            ]),
            overlay: None,
            limits: Limits {
                traversal: Some(0),
                ..Limits::default()
            },
        });
        refused_input.add_record(&ref_view, ref_view_body.as_deref());
        let refused_state = refused_input.into_state();
        assert!(!refused_state.evaluation().available);
        assert_eq!(refused_state.consumed_work(), 0);
        assert!(
            refused_state.unresolved.is_empty(),
            "refused session must not populate unresolved (got {} IDs)",
            refused_state.unresolved.len()
        );
        let cp = refused_state.checkpoint("refused-unused").unwrap();
        let restored = EvaluatedState::restore_host_checkpoint(&cp, "refused-unused").unwrap();
        assert!(
            restored.unresolved.is_empty(),
            "restored refused session must not populate unresolved (got {} IDs)",
            restored.unresolved.len()
        );
    }

    #[test]
    fn pending_historical_claim_at_zero_claim_depth_restores_both_checkpoints() {
        let origin = "https://source.example";
        let word = jvc_core::word_id(&json!({"language":"jbo","spelling":"klama"})).unwrap();
        let mut def_body: Value = serde_json::from_str(include_str!(
            "../../jvc-core/tests/fixtures/definition.json"
        ))
        .unwrap();
        def_body["word"] = json!({"language":"jbo","spelling":"klama"});
        def_body["legacy"] = json!({
            "source":"fixture",
            "snapshot":format!("sha256:{}", "f".repeat(64)),
            "extraction":"fixture-v1",
            "record":{"kind":"definition","id":1},
            "locator":"fixture",
            "original":{},
            "attribution":{
                "author":"author",
                "editor":null,
                "author_account":{
                    "origin":origin,
                    "account":41,
                    "username":"author",
                    "evidence":{"kind":"source-id","source":{"label":"source author numeric field","url":null,"event":null,"locator":"author_id"}}
                },
                "dates":{}
            },
            "conversion":{"method":"literal","tool":"fixture","version":"1","model":null,"review":"unreviewed","mappings":[],"warnings":[]},
            "limitations":[]
        });
        let (pubn, pubn_body) = event(
            9,
            1,
            json!({"kind":"definition.publish","word":word,"language":"en","parents":[],"origin":"import"}),
            Some(def_body),
        );
        let (claim, _) = event(
            1,
            2,
            json!({"kind":"account.set","origin":origin,"account":41,"value":"claim","previous":null,"carry":[]}),
            None,
        );
        let (status, _) = event(
            1,
            3,
            json!({"kind":"import.status","target":pubn.id(),"claim":claim.id(),"value":"deprecated"}),
            None,
        );
        let obs_body = json!({
            "origin":origin,
            "account":41,
            "username":"author",
            "field_hash":format!("sha256:{}", "f".repeat(64)),
            "markers":[claim.id()],
            "method":"lensisku-public-profile-v1",
            "observed_at":"2026-10-11T00:00:00Z"
        });
        let (obs10, _) = event(
            10,
            4,
            json!({"kind":"account.observe","origin":origin,"account":41,"claim":claim.id(),"result":"present"}),
            Some(obs_body.clone()),
        );
        let (obs11, obs11_body) = event(
            11,
            5,
            json!({"kind":"account.observe","origin":origin,"account":41,"claim":claim.id(),"result":"present"}),
            Some(obs_body.clone()),
        );
        let absent_pred = format!("jve1:{}", "e".repeat(64));
        let obs10_with_missing_pred = {
            let bytes = canonical_value(&obs_body).unwrap();
            let signed = sign_header(
                &[10; 32],
                Header {
                    version: 1,
                    issuer: identity_from_seed(&[10; 32]),
                    previous: vec![absent_pred],
                    nonce: format!("{:032x}", 6u8),
                    action: json!({"kind":"account.observe","origin":origin,"account":41,"claim":claim.id(),"result":"present"}),
                    content: Some(body_descriptor(&bytes).unwrap()),
                },
            )
            .unwrap();
            (
                verify_envelope(&signed.canonical_envelope().unwrap()).unwrap(),
                bytes,
            )
        };
        let sel_ids = vec![pubn.id().to_owned()];
        let sel_digest =
            jvc_core::hash_id("sha256:", b"", &canonical_value(&json!(sel_ids)).unwrap());
        let mut w10_11 = vec![identity_from_seed(&[10; 32]), identity_from_seed(&[11; 32])];
        w10_11.sort();
        let (base_view, base_view_body) = event(
            20,
            7,
            json!({"kind":"view.publish","parents":[]}),
            Some(json!({
                "name":"fixture",
                "description":[],
                "roots":[],
                "rafsi_threshold":{"numerator":1,"denominator":1},
                "H":{"numerator":3,"denominator":1},
                "alpha":{"numerator":1,"denominator":2},
                "excluded":[],
                "calculation":"simple-routes-bounds-v1",
                "work":1000,
                "import_sets":[{"source":"fixture","importer":identity_from_seed(&[9;32]),"selection":sel_digest}],
                "account_witnesses":w10_11,
                "account_authority":true,
                "notes":[]
            })),
        );
        let mut w12_13 = vec![identity_from_seed(&[12; 32]), identity_from_seed(&[13; 32])];
        w12_13.sort();
        let (next_view, next_view_body) = event(
            20,
            8,
            json!({"kind":"view.publish","parents":[base_view.id()]}),
            Some(json!({
                "name":"fixture",
                "description":[],
                "roots":[],
                "rafsi_threshold":{"numerator":1,"denominator":1},
                "H":{"numerator":3,"denominator":1},
                "alpha":{"numerator":1,"denominator":2},
                "excluded":[],
                "calculation":"simple-routes-bounds-v1",
                "work":1000,
                "import_sets":[{"source":"fixture","importer":identity_from_seed(&[9;32]),"selection":sel_digest}],
                "account_witnesses":w12_13,
                "account_authority":true,
                "notes":[]
            })),
        );

        for (case_name, missing_body_case) in [
            ("missing_observation_body", true),
            ("missing_witness_predecessor", false),
        ] {
            let mut prepared = PreparedEvaluationInput::new(EvaluationOptions {
                selected_view: next_view.id().into(),
                import_selections: BTreeMap::from([(sel_digest.clone(), sel_ids.clone())]),
                overlay: None,
                limits: Limits {
                    claim_depth: 0,
                    ..Limits::default()
                },
            });
            prepared.add_record(&pubn, pubn_body.as_deref());
            prepared.add_record(&claim, None);
            prepared.add_record(&status, None);
            if missing_body_case {
                prepared.add_record(&obs10, None);
            } else {
                prepared.add_record(
                    &obs10_with_missing_pred.0,
                    Some(obs10_with_missing_pred.1.as_slice()),
                );
            }
            prepared.add_record(&obs11, obs11_body.as_deref());
            prepared.add_record(&base_view, base_view_body.as_deref());
            prepared.add_record(&next_view, next_view_body.as_deref());

            let state = prepared.clone().into_state();
            assert!(state.evaluation().available);
            let account = &state.evaluation().accounts["https://source.example#41"];
            assert!(account.candidates.is_empty());
            assert!(account.certificates.is_empty());
            assert_eq!(account.historical, BTreeSet::from([claim.id().to_owned()]));
            assert!(account.reasons.contains("observation_pending"));
            assert!(!account.reasons.contains("resource_unavailable"));

            let records: Vec<HostVerifiedRecord> = prepared
                .nodes
                .values()
                .map(|node| HostVerifiedRecord { node: node.clone() })
                .collect();
            let full_cp = state.checkpoint(case_name).unwrap();
            let res_cp = state.result_checkpoint(case_name).unwrap();
            let restored_full = EvaluatedState::restore_host_checkpoint(&full_cp, case_name)
                .unwrap_or_else(|e| panic!("{case_name} full checkpoint restore failed: {e}"));
            let restored_res =
                EvaluatedState::restore_host_result_checkpoint(&res_cp, case_name, records)
                    .unwrap_or_else(|e| {
                        panic!("{case_name} result checkpoint restore failed: {e}")
                    });
            assert_eq!(restored_full.evaluation(), state.evaluation());
            assert_eq!(restored_res.evaluation(), state.evaluation());
        }
    }

    #[test]
    fn fast_append_updates_only_appended_issuer_lifecycle_entries() {
        let mut prepared = base();
        let (pubn, pubn_body) = publication();
        let pub_id = pubn.id().to_owned();
        prepared.add_record(&pubn, pubn_body.as_deref());
        let mut background_issuers = Vec::new();
        for i in 0..128usize {
            let mut seed = [0u8; 32];
            seed[0] = 3;
            seed[1..9].copy_from_slice(&(i as u64).to_le_bytes());
            let issuer = identity_from_seed(&seed);
            prepared.add_host_verified_record(host(
                format!("jve1:{:064x}", i + 10),
                &issuer,
                vec![],
                json!({"kind":"identity.merge"}),
            ));
            background_issuers.push(issuer);
        }
        let state = prepared.clone().into_state();
        let before_actor_ptrs: Vec<*const u8> = background_issuers
            .iter()
            .map(|issuer| state.evaluation().lifecycle.key_actor[issuer].as_ptr())
            .collect();
        let before_group_ptrs: Vec<*const u8> = background_issuers
            .iter()
            .map(|issuer| {
                state.evaluation().lifecycle.groups[issuer]
                    .iter()
                    .next()
                    .unwrap()
                    .as_ptr()
            })
            .collect();

        let judge = identity_from_seed(&[250; 32]);
        let mut delta = PreparedEvaluationInput::new(prepared.options.clone());
        delta.add_host_verified_record(host(
            format!("jve1:{:064x}", 1_000_000usize),
            &judge,
            vec![],
            json!({"kind":"judgment.set","target":pub_id,"value":"bless"}),
        ));
        let advanced = state.advance(delta, &[]);
        assert_eq!(advanced.statistics().incremental_records, 1);
        assert!(!advanced.statistics().rebuilt);
        assert_eq!(
            advanced.evaluation().lifecycle.key_actor.get(&judge),
            Some(&judge)
        );
        assert_eq!(
            advanced.evaluation().lifecycle.groups.get(&judge),
            Some(&BTreeSet::from([judge.clone()]))
        );

        let after_actor_ptrs: Vec<*const u8> = background_issuers
            .iter()
            .map(|issuer| advanced.evaluation().lifecycle.key_actor[issuer].as_ptr())
            .collect();
        let after_group_ptrs: Vec<*const u8> = background_issuers
            .iter()
            .map(|issuer| {
                advanced.evaluation().lifecycle.groups[issuer]
                    .iter()
                    .next()
                    .unwrap()
                    .as_ptr()
            })
            .collect();
        assert_eq!(
            before_actor_ptrs, after_actor_ptrs,
            "fast append must not clone unrelated issuers in lifecycle.key_actor"
        );
        assert_eq!(
            before_group_ptrs, after_group_ptrs,
            "fast append must not clone unrelated issuer sets in lifecycle.groups"
        );
    }

    #[test]
    fn event_quota_and_refused_rebuilds_reuse_selection_validity_until_selections_are_resupplied() {
        let ids: Vec<String> = (0..4_096usize)
            .map(|i| format!("jve1:{:064x}", i + 1))
            .collect();
        let digest = jvc_core::hash_id("sha256:", b"", &canonical_value(&json!(ids)).unwrap());
        let (view, view_body) = event(
            1,
            1,
            json!({"kind":"view.publish","parents":[]}),
            Some(json!({
                "name":"fixture",
                "description":[],
                "roots":[{"identity":identity_from_seed(&[1;32]),"q":{"numerator":1,"denominator":1}}],
                "rafsi_threshold":{"numerator":1,"denominator":1},
                "H":{"numerator":3,"denominator":1},
                "alpha":{"numerator":1,"denominator":2},
                "excluded":[],
                "calculation":"simple-routes-bounds-v1",
                "work":1000,
                "import_sets":[{"source":"https://example.org","importer":identity_from_seed(&[1;32]),"selection":digest}],
                "account_witnesses":[],
                "account_authority":false,
                "notes":[]
            })),
        );

        // 1. Known event-quota refusal (events: Some(0)) must check the quota before hashing selections.
        let mut quota_input = PreparedEvaluationInput::new(EvaluationOptions {
            selected_view: view.id().into(),
            import_selections: BTreeMap::from([(digest.clone(), ids.clone())]),
            overlay: None,
            limits: Limits {
                events: Some(0),
                ..Limits::default()
            },
        });
        quota_input.add_record(&view, view_body.as_deref());
        policy::reset_selection_hash_validations();
        let quota_state = quota_input.into_state();
        assert!(!quota_state.evaluation().available);
        assert_eq!(quota_state.consumed_work(), 0);
        assert_eq!(
            policy::selection_hash_validations(),
            0,
            "event-quota refusal must not hash referenced selections before checking the event limit"
        );
        let cp = quota_state.checkpoint("quota-sel").unwrap();
        let restored_quota = EvaluatedState::restore_host_checkpoint(&cp, "quota-sel").unwrap();
        assert!(!restored_quota.evaluation().available);
        assert_eq!(
            policy::selection_hash_validations(),
            0,
            "restoring an event-quota refused checkpoint must not hash referenced selections"
        );

        // 2. When event quota is not exceeded, the allowance rule holds and a refused evaluation does not re-hash the selection on rebuild.
        let mut open_input = PreparedEvaluationInput::new(EvaluationOptions {
            selected_view: view.id().into(),
            import_selections: BTreeMap::from([(digest.clone(), ids.clone())]),
            overlay: None,
            limits: Limits::default(),
        });
        open_input.add_record(&view, view_body.as_deref());
        policy::reset_selection_hash_validations();
        let open_state = open_input.into_state();
        assert!(open_state.evaluation().available);
        assert_eq!(open_state.traversal_budget(), 10_000_256 + 4_096);
        assert_eq!(policy::selection_hash_validations(), 1);

        // Refused evaluation (tight explicit traversal budget that runs policy::select and then refuses):
        // subsequent with_overlay / advance rebuilds must reuse the cached validity and count.
        let mut tight_opts = EvaluationOptions {
            selected_view: view.id().into(),
            import_selections: BTreeMap::from([(digest, ids)]),
            overlay: None,
            limits: Limits {
                traversal: Some(4_114),
                ..Limits::default()
            },
        };
        let (pubn, pubn_body) = publication();
        let mut tight_input = PreparedEvaluationInput::new(tight_opts.clone());
        tight_input.add_record(&view, view_body.as_deref());
        tight_input.add_record(&pubn, pubn_body.as_deref());
        policy::reset_selection_hash_validations();
        let tight_state = tight_input.into_state();
        assert!(!tight_state.evaluation().available);
        assert!(
            tight_state
                .evaluation()
                .reasons
                .contains("resource_unavailable")
        );
        assert_eq!(policy::selection_hash_validations(), 1);

        let overlaid = tight_state.with_overlay(None);
        assert!(!overlaid.evaluation().available);
        assert_eq!(
            policy::selection_hash_validations(),
            1,
            "with_overlay on a refused state must not validate the prepared selection again"
        );
        tight_opts.limits.traversal = None;
        let recovered = overlaid.advance(PreparedEvaluationInput::new(tight_opts), &[]);
        assert!(recovered.evaluation().available);
        assert_eq!(recovered.traversal_budget(), 10_000_512 + 4_096);
        // The refused state has no work left to compare the newly supplied
        // IDs, so it does not read them and copies no verdict into the new
        // cache; the rebuild validates the resupplied selection once.
        assert_eq!(policy::selection_hash_validations(), 2);
    }

    #[test]
    fn overlay_recovery_restores_pending_selection_and_target_references() {
        let (pubn, pubn_body) = publication();
        let pub_id = pubn.id().to_owned();

        // 1. Pending selection publication: view references a valid selection containing absent `pub_id`.
        let sel_ids = vec![pub_id.clone()];
        let sel_digest =
            jvc_core::hash_id("sha256:", b"", &canonical_value(&json!(sel_ids)).unwrap());
        let issuer = identity_from_seed(&[3; 32]);
        let (sel_view, sel_view_body) = event(
            3,
            1,
            json!({"kind":"view.publish","parents":[]}),
            Some(json!({
                "name":"selection-overlay",
                "description":[],
                "roots":[],
                "rafsi_threshold":{"numerator":1,"denominator":1},
                "H":{"numerator":3,"denominator":1},
                "alpha":{"numerator":1,"denominator":2},
                "excluded":[],
                "calculation":"simple-routes-bounds-v1",
                "work":1000,
                "import_sets":[{"source":"fixture","importer":issuer,"selection":sel_digest}],
                "account_witnesses":[],
                "account_authority":false,
                "notes":[]
            })),
        );
        let sel_opts = EvaluationOptions {
            selected_view: sel_view.id().into(),
            overlay: Some(json!({}).into()),
            import_selections: BTreeMap::from([(sel_digest, sel_ids)]),
            limits: Limits::default(),
        };
        for mode in 0..3usize {
            let mut input = PreparedEvaluationInput::new(sel_opts.clone());
            input.add_record(&sel_view, sel_view_body.as_deref());
            let mut base = input.into_state();
            if mode == 1 {
                base = EvaluatedState::restore_host_checkpoint(
                    &base.checkpoint("sel").unwrap(),
                    "sel",
                )
                .unwrap();
            } else if mode == 2 {
                let rec = HostVerifiedRecord::extract_with(
                    sel_view.id(),
                    sel_view.header(),
                    jvc_core::inspect_body(&sel_view, sel_view_body.as_deref()),
                    |_| (),
                )
                .0;
                base = EvaluatedState::restore_host_result_checkpoint(
                    &base.result_checkpoint("sel").unwrap(),
                    "sel",
                    vec![rec],
                )
                .unwrap();
            }
            assert!(!base.evaluation().available);
            assert!(base.evaluation().reasons.contains("invalid_overlay"));

            let repaired = base.with_overlay(None);
            assert!(repaired.evaluation().available);
            assert!(
                repaired
                    .evaluation()
                    .reasons
                    .contains("selection_publications_pending")
            );

            let mut open = sel_opts.clone();
            open.overlay = None;
            let mut delta = PreparedEvaluationInput::new(open.clone());
            delta.add_record(&pubn, pubn_body.as_deref());
            let next = repaired.advance(delta, &[]);

            let mut full_input = PreparedEvaluationInput::new(open);
            full_input.add_record(&sel_view, sel_view_body.as_deref());
            full_input.add_record(&pubn, pubn_body.as_deref());
            let full = full_input.into_state();

            assert_eq!(
                next.statistics().reason.as_deref(),
                Some("reference_completed"),
                "mode={mode}: expected reference_completed rebuild when pending selection publication arrives"
            );
            assert_eq!(next.statistics().incremental_records, 0);
            assert!(
                !next
                    .evaluation()
                    .reasons
                    .contains("selection_publications_pending"),
                "mode={mode}: selection_publications_pending must clear when publication arrives"
            );
            assert_eq!(next.consumed_work(), full.consumed_work());
            assert_eq!(next.evaluation(), full.evaluation());
        }

        // 2. Pending judgment target and status target after removing an invalid overlay.
        let (no_import_view, no_import_view_body) = event(
            3,
            2,
            json!({"kind":"view.publish","parents":[]}),
            Some(json!({
                "name":"no-imports",
                "description":[],
                "roots":[],
                "rafsi_threshold":{"numerator":1,"denominator":1},
                "H":{"numerator":3,"denominator":1},
                "alpha":{"numerator":1,"denominator":2},
                "excluded":[],
                "calculation":"simple-routes-bounds-v1",
                "work":1000,
                "import_sets":[],
                "account_witnesses":[],
                "account_authority":false,
                "notes":[]
            })),
        );
        for mode in 0..3usize {
            for kind in ["judgment", "status"] {
                let (pending, _) = if kind == "judgment" {
                    event(
                        11,
                        17,
                        json!({"kind":"judgment.set","target":pub_id,"value":"bless"}),
                        None,
                    )
                } else {
                    event(
                        1,
                        17,
                        json!({"kind":"status.set","target":pub_id,"value":"deprecated"}),
                        None,
                    )
                };
                let opts = EvaluationOptions {
                    selected_view: no_import_view.id().into(),
                    overlay: Some(json!({}).into()),
                    import_selections: BTreeMap::new(),
                    limits: Limits::default(),
                };
                let mut input = PreparedEvaluationInput::new(opts.clone());
                input.add_record(&no_import_view, no_import_view_body.as_deref());
                input.add_record(&pending, None);
                let mut base = input.into_state();
                if mode == 1 {
                    base = EvaluatedState::restore_host_checkpoint(
                        &base.checkpoint("host").unwrap(),
                        "host",
                    )
                    .unwrap();
                } else if mode == 2 {
                    let recs = [
                        (&no_import_view, no_import_view_body.as_deref()),
                        (&pending, None),
                    ]
                    .into_iter()
                    .map(|(e, b)| {
                        HostVerifiedRecord::extract_with(
                            e.id(),
                            e.header(),
                            jvc_core::inspect_body(e, b),
                            |_| (),
                        )
                        .0
                    })
                    .collect();
                    base = EvaluatedState::restore_host_result_checkpoint(
                        &base.result_checkpoint("host").unwrap(),
                        "host",
                        recs,
                    )
                    .unwrap();
                }
                assert!(base.evaluation().reasons.contains("invalid_overlay"));
                let repaired = base.with_overlay(None);
                assert!(repaired.evaluation().available);

                let mut open = opts;
                open.overlay = None;
                let mut full_input = PreparedEvaluationInput::new(open.clone());
                full_input.add_record(&no_import_view, no_import_view_body.as_deref());
                full_input.add_record(&pending, None);
                full_input.add_record(&pubn, pubn_body.as_deref());
                let full = full_input.into_state();

                let mut delta = PreparedEvaluationInput::new(open);
                delta.add_record(&pubn, pubn_body.as_deref());
                let next = repaired.advance(delta, &[]);

                assert_eq!(
                    next.evaluation().receipts[pending.id()].interpretation,
                    Interpretation::Effective,
                    "mode={mode} kind={kind}: pending record must become Effective when target arrives"
                );
                assert_eq!(next.consumed_work(), full.consumed_work());
                assert_eq!(next.evaluation(), full.evaluation());
            }
        }
    }

    #[test]
    fn with_overlay_and_empty_advance_share_selections_without_copying_or_scanning_unused_ids() {
        let (view, view_body) = event(
            3,
            1,
            json!({"kind":"view.publish","parents":[]}),
            Some(json!({
                "name":"no-imports",
                "description":[],
                "roots":[],
                "rafsi_threshold":{"numerator":1,"denominator":1},
                "H":{"numerator":3,"denominator":1},
                "alpha":{"numerator":1,"denominator":2},
                "excluded":[],
                "calculation":"simple-routes-bounds-v1",
                "work":1000,
                "import_sets":[],
                "account_witnesses":[],
                "account_authority":false,
                "notes":[]
            })),
        );
        let ids: Vec<String> = (0..4_096usize).map(|n| format!("jve1:{n:064x}")).collect();
        let digest = jvc_core::hash_id("sha256:", b"", &canonical_value(&json!(ids)).unwrap());

        for limit in [None, Some(0)] {
            let options = EvaluationOptions {
                selected_view: view.id().into(),
                overlay: None,
                limits: Limits {
                    traversal: limit,
                    ..Limits::default()
                },
                import_selections: BTreeMap::from([(digest.clone(), ids.clone())]),
            };
            let mut input = PreparedEvaluationInput::new(options.clone());
            input.add_record(&view, view_body.as_deref());
            let base = input.into_state();
            let before_map_ptr = base.import_selections() as *const BTreeMap<String, Vec<String>>;
            let before_first_str_ptr = base.import_selections()[&digest][0].as_ptr();

            let overlaid = base.with_overlay(None);
            let after_map_ptr =
                overlaid.import_selections() as *const BTreeMap<String, Vec<String>>;
            let after_first_str_ptr = overlaid.import_selections()[&digest][0].as_ptr();
            assert_eq!(
                before_map_ptr, after_map_ptr,
                "with_overlay must share immutable import_selections storage (limit={limit:?})"
            );
            assert_eq!(
                before_first_str_ptr, after_first_str_ptr,
                "with_overlay must not clone selection strings (limit={limit:?})"
            );

            // Empty advance with modified last ID in an unreferenced selection must not scan or trigger configuration_changed.
            let old_work = overlaid.consumed_work();
            let mut modified_options = options;
            *modified_options
                .import_selections
                .get_mut(&digest)
                .unwrap()
                .last_mut()
                .unwrap() = format!("jve1:{:064x}", 4_096usize);
            let delta = PreparedEvaluationInput::new(modified_options);
            let advanced = overlaid.advance(delta, &[]);
            assert_eq!(advanced.consumed_work(), old_work);
            assert!(
                advanced.statistics().reason.is_none(),
                "changing an unused selection in an empty advance must not trigger configuration_changed (limit={limit:?}, got {:?})",
                advanced.statistics().reason
            );
            assert!(!advanced.statistics().rebuilt);
        }
    }

    #[test]
    fn fast_append_preserves_shared_ancestry_closure_map_without_cloning_old_entries() {
        let mut prepared = base();
        let (pubn, pubn_body) = publication();
        let pub_id = pubn.id().to_owned();
        prepared.add_record(&pubn, pubn_body.as_deref());
        let filler_issuer = identity_from_seed(&[9; 32]);
        for i in 0..128usize {
            prepared.add_host_verified_record(host(
                format!("jve1:{:064x}", i + 10),
                &filler_issuer,
                vec![],
                json!({"kind":"identity.merge"}),
            ));
        }
        let state = prepared.clone().into_state();
        assert!(state.evaluation().available);
        let before_graph = state.graph.as_ref().unwrap();
        assert!(std::rc::Rc::ptr_eq(
            &before_graph.own,
            &before_graph.structural
        ));
        assert!(std::rc::Rc::ptr_eq(
            &before_graph.own,
            &before_graph.accepted
        ));
        let before_own_ptr = std::rc::Rc::as_ptr(&before_graph.own);

        let judge = identity_from_seed(&[11; 32]);
        let mut delta = PreparedEvaluationInput::new(prepared.options.clone());
        delta.add_host_verified_record(host(
            format!("jve1:{:064x}", 1_000_000usize),
            &judge,
            vec![],
            json!({"kind":"judgment.set","target":pub_id,"value":"bless"}),
        ));
        let next = state.advance(delta, &[]);
        assert!(next.evaluation().available);
        assert!(!next.statistics().rebuilt);
        assert_eq!(next.statistics().incremental_records, 1);

        let after_graph = next.graph.as_ref().unwrap();
        assert!(std::rc::Rc::ptr_eq(
            &after_graph.own,
            &after_graph.structural
        ));
        assert!(std::rc::Rc::ptr_eq(&after_graph.own, &after_graph.accepted));
        let after_own_ptr = std::rc::Rc::as_ptr(&after_graph.own);
        assert_eq!(
            before_own_ptr, after_own_ptr,
            "fast judgment append on a live session must mutate the shared closure map in place without cloning old entries"
        );
    }

    #[test]
    fn fast_append_native_definition_does_not_run_rafsi_gate_across_unrelated_words() {
        let mut prepared = base();
        let abc = b"bdfgjklmnprstvxz";
        let word_value = |i: usize| {
            json!({
                "language": "jbo",
                "spelling": format!("ba{}a{}a", abc[i / 16] as char, abc[i % 16] as char)
            })
        };
        let def_template: Value = serde_json::from_str(include_str!(
            "../../jvc-core/tests/fixtures/definition.json"
        ))
        .unwrap();
        let w0 = word_value(0);
        let w0_id = jvc_core::word_id(&w0).unwrap();
        let rafsi_pair = jvc_core::rafsi_pair_id(&w0_id, "bab").unwrap();
        let (rafsi_claim, rafsi_body) = event(
            13,
            1,
            json!({"kind":"rafsi.publish","word":w0_id,"assignment":rafsi_pair,"origin":"native"}),
            Some(json!({
                "word": w0,
                "rafsi": "bab",
                "rationale": [["fixture"]],
                "sources": [],
                "legacy": null
            })),
        );
        prepared.add_record(&rafsi_claim, rafsi_body.as_deref());

        for i in 0..128usize {
            let w = word_value(i);
            let wid = jvc_core::word_id(&w).unwrap();
            let mut body = def_template.clone();
            body["word"] = w;
            let (def_ev, def_bytes) = event(
                14,
                (i % 250) as u8 + 2,
                json!({"kind":"definition.publish","word":wid,"language":"en","parents":[],"origin":"native"}),
                Some(body),
            );
            prepared.add_record(&def_ev, def_bytes.as_deref());
        }
        let state = prepared.clone().into_state();
        assert!(state.evaluation().available);

        // 1. Appending a native definition for an unrelated word (no rafsi claim on that word) must do 0 rafsi_gate publication visits.
        let w_unrelated = json!({"language":"jbo","spelling":"banli"});
        let wid_unrelated = jvc_core::word_id(&w_unrelated).unwrap();
        let (unrelated_def, unrelated_bytes) = event(
            15,
            1,
            json!({"kind":"definition.publish","word":wid_unrelated,"language":"en","parents":[],"origin":"native"}),
            Some(def_template.clone()),
        );
        let mut delta_unrelated = PreparedEvaluationInput::new(prepared.options.clone());
        delta_unrelated.add_record(&unrelated_def, unrelated_bytes.as_deref());
        reset_rafsi_gate_publication_visits();
        let next_unrelated = state.clone().advance(delta_unrelated, &[]);
        assert!(next_unrelated.evaluation().available);
        assert!(!next_unrelated.statistics().rebuilt);
        assert_eq!(next_unrelated.statistics().incremental_records, 1);
        assert_eq!(
            rafsi_gate_publication_visits(),
            0,
            "fast definition append for a word without rafsi claims must not run rafsi_gate"
        );

        // 2. Appending a native definition for word(0) (which has a rafsi claim) routes to full evaluation.
        let mut w0_body = def_template;
        w0_body["word"] = w0;
        let (same_word_def, same_word_bytes) = event(
            16,
            1,
            json!({"kind":"definition.publish","word":w0_id,"language":"en","parents":[],"origin":"native"}),
            Some(w0_body),
        );
        let mut delta_same = PreparedEvaluationInput::new(prepared.options.clone());
        delta_same.add_record(&same_word_def, same_word_bytes.as_deref());
        let next_same = state.advance(delta_same, &[]);
        assert!(next_same.evaluation().available);
        assert!(next_same.statistics().rebuilt);
        assert_eq!(
            next_same.statistics().reason.as_deref(),
            Some("rafsi_eligibility")
        );
        assert_eq!(next_same.statistics().incremental_records, 0);
        let mut full_same = prepared;
        full_same.add_record(&same_word_def, same_word_bytes.as_deref());
        assert_eq!(next_same.evaluation(), &full_same.evaluate());
    }

    #[test]
    fn cross_word_rafsi_assignment_orders_rebuild_and_match_full_across_checkpoints() {
        let abc = b"bdfgjklmnprstvxz";
        let word_value = |i: usize| {
            json!({
                "language": "jbo",
                "spelling": format!("ba{}a{}a", abc[i / 16] as char, abc[i % 16] as char)
            })
        };
        let def_template: Value = serde_json::from_str(include_str!(
            "../../jvc-core/tests/fixtures/definition.json"
        ))
        .unwrap();
        let (view, view_body) = event(
            3,
            1,
            json!({"kind":"view.publish","parents":[]}),
            Some(json!({
                "name":"no imports",
                "description":[],
                "roots":[],
                "rafsi_threshold":{"numerator":1,"denominator":1},
                "H":{"numerator":3,"denominator":1},
                "alpha":{"numerator":1,"denominator":2},
                "excluded":[],
                "calculation":"simple-routes-bounds-v1",
                "work":1000,
                "import_sets":[],
                "account_witnesses":[],
                "account_authority":false,
                "notes":[]
            })),
        );
        let options = EvaluationOptions {
            selected_view: view.id().into(),
            overlay: None,
            import_selections: BTreeMap::new(),
            limits: Limits::default(),
        };
        let wa = word_value(0);
        let wb = word_value(1);
        let aid = jvc_core::word_id(&wa).unwrap();
        let bid = jvc_core::word_id(&wb).unwrap();
        let pair_a = jvc_core::rafsi_pair_id(&aid, "bab").unwrap();
        let pair_b = jvc_core::rafsi_pair_id(&bid, "bab").unwrap();
        let body_a =
            json!({"word":wa,"rafsi":"bab","rationale":[["fixture"]],"sources":[],"legacy":null});
        let body_b =
            json!({"word":wb,"rafsi":"bab","rationale":[["fixture"]],"sources":[],"legacy":null});
        let (a_ev, a_bytes) = event(
            13,
            1,
            json!({"kind":"rafsi.publish","word":aid,"assignment":pair_a,"origin":"native"}),
            Some(body_a),
        );
        let mut d_body = def_template;
        d_body["word"] = wa;
        let (d_ev, d_bytes) = event(
            15,
            100,
            json!({"kind":"definition.publish","word":aid,"language":"en","parents":[],"origin":"native"}),
            Some(d_body),
        );

        for a_before_b in [true, false] {
            for same_assignment in [false, true] {
                let target_pair = if same_assignment { &pair_a } else { &pair_b };
                let (b_ev, _) = (1u8..=250)
                    .map(|n| {
                        event(
                            14,
                            n,
                            json!({"kind":"rafsi.publish","word":bid,"assignment":target_pair,"origin":"native"}),
                            Some(body_b.clone()),
                        )
                    })
                    .find(|(b, _)| {
                        if a_before_b {
                            a_ev.id() < b.id()
                        } else {
                            a_ev.id() > b.id()
                        }
                    })
                    .unwrap();

                for mode in 0..3usize {
                    let mut hist = PreparedEvaluationInput::new(options.clone());
                    let rows_input = [
                        (&view, view_body.as_deref()),
                        (&a_ev, a_bytes.as_deref()),
                        (&b_ev, None),
                    ];
                    for (ev, body) in rows_input {
                        hist.add_record(ev, body);
                    }
                    let mut state = hist.clone().into_state();
                    if mode == 1 {
                        state = EvaluatedState::restore_host_checkpoint(
                            &state.checkpoint("pairs").unwrap(),
                            "pairs",
                        )
                        .unwrap();
                    } else if mode == 2 {
                        let rows = rows_input
                            .iter()
                            .map(|(ev, body)| {
                                HostVerifiedRecord::extract_with(
                                    ev.id(),
                                    ev.header(),
                                    jvc_core::inspect_body(ev, *body),
                                    |_| (),
                                )
                                .0
                            })
                            .collect();
                        state = EvaluatedState::restore_host_result_checkpoint(
                            &state.result_checkpoint("pairs").unwrap(),
                            "pairs",
                            rows,
                        )
                        .unwrap();
                    }
                    let mut delta = PreparedEvaluationInput::new(options.clone());
                    delta.add_record(&d_ev, d_bytes.as_deref());
                    hist.add_record(&d_ev, d_bytes.as_deref());
                    let full = hist.into_state();
                    let next = state.advance(delta, &[]);
                    assert_eq!(
                        next.evaluation(),
                        full.evaluation(),
                        "a_before_b={a_before_b} same_assignment={same_assignment} mode={mode}: evaluation mismatch (next_a={:?} full_a={:?} next_b={:?} full_b={:?})",
                        next.evaluation().publications[a_ev.id()].eligible,
                        full.evaluation().publications[a_ev.id()].eligible,
                        next.evaluation().publications[b_ev.id()].eligible,
                        full.evaluation().publications[b_ev.id()].eligible,
                    );
                    assert_eq!(
                        next.consumed_work(),
                        full.consumed_work(),
                        "a_before_b={a_before_b} same_assignment={same_assignment} mode={mode}: consumed_work mismatch"
                    );
                }
            }
        }
    }

    #[test]
    fn fast_append_on_shared_fork_charges_copied_state_and_refuses_tight_budget() {
        let build_fixture = |count: usize, traversal: Option<usize>| {
            let mut prepared = base();
            prepared.options.limits.traversal = traversal;
            let (pubn, pubn_body) = publication();
            let pub_id = pubn.id().to_owned();
            prepared.add_record(&pubn, pubn_body.as_deref());
            let filler_issuer = identity_from_seed(&[9; 32]);
            for i in 0..count {
                prepared.add_host_verified_record(host(
                    format!("jve1:{:064x}", i + 10),
                    &filler_issuer,
                    vec![],
                    json!({"kind":"identity.merge"}),
                ));
            }
            (prepared, pub_id)
        };

        let judge = identity_from_seed(&[11; 32]);
        for count in [128usize, 512usize] {
            let (prepared, pub_id) = build_fixture(count, None);
            let judgment = host(
                format!("jve1:{:064x}", 1_000_000 + count),
                &judge,
                vec![],
                json!({"kind":"judgment.set","target":pub_id,"value":"bless"}),
            );

            // 1. Single-owner fast append (no live fork) charges only the 9-unit incremental delta.
            let unshared_state = unshared(&prepared).into_state();
            let before = unshared_state.consumed_work();
            let mut delta_unshared = PreparedEvaluationInput::new(prepared.options.clone());
            delta_unshared.add_host_verified_record(judgment.clone());
            let unshared_next = unshared_state.advance(delta_unshared, &[]);
            assert!(!unshared_next.statistics().rebuilt);
            assert_eq!(unshared_next.statistics().incremental_records, 1);
            assert_eq!(unshared_next.consumed_work() - before, 9);

            // 2. Forked fast append (base state held by `holder`) must charge the copy of nodes, closures, and evaluation results.
            let forked_base = prepared.clone().into_state();
            let cp = forked_base.checkpoint("branch").unwrap();
            let rcp = forked_base.result_checkpoint("branch").unwrap();
            let holder = forked_base.clone();
            let mut delta_forked = PreparedEvaluationInput::new(prepared.options.clone());
            delta_forked.add_host_verified_record(judgment.clone());
            let forked_next = forked_base.advance(delta_forked, &[]);
            assert!(!forked_next.statistics().rebuilt);
            assert_eq!(forked_next.statistics().incremental_records, 1);
            let forked_extra = forked_next.consumed_work() - before;
            let total_nodes = count + 2;
            assert!(
                forked_extra >= 9 + 3 * total_nodes,
                "count={count}: forked fast append must charge proportional to copied nodes, closures, and receipts (got extra_units={forked_extra}, expected >= {})",
                9 + 3 * total_nodes
            );
            assert_eq!(forked_next.evaluation(), unshared_next.evaluation());
            assert_eq!(holder.checkpoint("branch").unwrap(), cp);
            assert_eq!(holder.result_checkpoint("branch").unwrap(), rcp);
            assert!(
                EvaluatedState::restore_host_checkpoint(
                    &forked_next.checkpoint("branch").unwrap(),
                    "branch"
                )
                .is_ok()
            );

            // 3. At a tight budget `before + 9` (enough for single-owner fast append, too small for forked copy + rebuild),
            // a forked advance must not complete on the fast path without paying for the copy.
            let (tight_prepared, _) = build_fixture(count, Some(before + 9));
            let tight_base = tight_prepared.clone().into_state();
            assert!(tight_base.evaluation().available);
            let _tight_holder = tight_base.clone();
            let mut delta_tight = PreparedEvaluationInput::new(tight_prepared.options.clone());
            delta_tight.add_host_verified_record(judgment);
            let tight_forked = tight_base.advance(delta_tight, &[]);
            assert!(
                tight_forked.statistics().rebuilt,
                "count={count}: forked advance at tight budget (before + 9) must decline the fast copy and route to rebuild"
            );
        }
    }

    #[test]
    fn definition_append_with_rafsi_claim_rebuilds_and_fast_path_never_walks_word_definitions() {
        let mut prepared = base();
        let abc = b"bdfgjklmnprstvxz";
        let word = json!({
            "language": "jbo",
            "spelling": format!("ba{}a{}a", abc[0] as char, abc[0] as char)
        });
        let wid = jvc_core::word_id(&word).unwrap();
        let rafsi_pair = jvc_core::rafsi_pair_id(&wid, "bab").unwrap();
        let (rafsi_claim, rafsi_body) = event(
            13,
            1,
            json!({"kind":"rafsi.publish","word":wid,"assignment":rafsi_pair,"origin":"native"}),
            Some(json!({
                "word": word,
                "rafsi": "bab",
                "rationale": [["fixture"]],
                "sources": [],
                "legacy": null
            })),
        );
        prepared.add_record(&rafsi_claim, rafsi_body.as_deref());

        let mut def_body: Value = serde_json::from_str(include_str!(
            "../../jvc-core/tests/fixtures/definition.json"
        ))
        .unwrap();
        def_body["word"] = word;
        for i in 0..128usize {
            let (def_ev, def_bytes) = event(
                14,
                (i % 250) as u8 + 2,
                json!({"kind":"definition.publish","word":wid,"language":"en","parents":[],"origin":"native"}),
                Some(def_body.clone()),
            );
            prepared.add_record(&def_ev, def_bytes.as_deref());
        }
        let state = prepared.clone().into_state();
        assert!(state.evaluation().available);

        let (appended_def, appended_bytes) = event(
            15,
            1,
            json!({"kind":"definition.publish","word":wid,"language":"en","parents":[],"origin":"native"}),
            Some(def_body),
        );
        let mut delta = PreparedEvaluationInput::new(prepared.options.clone());
        delta.add_record(&appended_def, appended_bytes.as_deref());
        let next = state.advance(delta, &[]);
        assert!(
            next.statistics().rebuilt,
            "appending a native definition for a word with a rafsi claim must route to full evaluation"
        );
        assert_eq!(
            next.statistics().reason.as_deref(),
            Some("rafsi_eligibility")
        );
        assert_eq!(next.statistics().incremental_records, 0);

        prepared.add_record(&appended_def, appended_bytes.as_deref());
        let full = prepared.into_state();
        assert_eq!(next.evaluation(), full.evaluation());
        assert_eq!(next.consumed_work(), full.consumed_work());
    }

    #[test]
    fn empty_advance_on_budget_exhausted_state_rebuilds_on_a_changed_selection() {
        let ids: Vec<String> = (0..4_096usize).map(|i| format!("jve1:{i:064x}")).collect();
        let sel_bytes = jvc_core::canonical_value(&json!(ids)).unwrap();
        let digest = jvc_core::hash_id("sha256:", b"", &sel_bytes);
        let issuer = identity_from_seed(&[3; 32]);
        let (view, view_body) = event(
            3,
            1,
            json!({"kind":"view.publish","parents":[]}),
            Some(json!({
                "name":"quota",
                "description":[],
                "roots":[],
                "rafsi_threshold":{"numerator":1,"denominator":1},
                "H":{"numerator":3,"denominator":1},
                "alpha":{"numerator":1,"denominator":2},
                "excluded":[],
                "calculation":"simple-routes-bounds-v1",
                "work":1000,
                "import_sets":[{"source":"fixture","importer":issuer,"selection":digest}],
                "account_witnesses":[],
                "account_authority":false,
                "notes":[]
            })),
        );

        for limit in [0usize, 1usize, 15usize] {
            let options = EvaluationOptions {
                selected_view: view.id().into(),
                overlay: None,
                import_selections: BTreeMap::from([(digest.clone(), ids.clone())]),
                limits: Limits {
                    traversal: Some(limit),
                    ..Limits::default()
                },
            };
            let mut prepared = PreparedEvaluationInput::new(options.clone());
            prepared.add_record(&view, view_body.as_deref());
            let state = prepared.into_state();
            assert!(!state.evaluation().available);
            assert!(state.evaluation().reasons.contains("resource_unavailable"));
            assert_eq!(state.consumed_work(), limit);

            let mut modified_options = options;
            *modified_options
                .import_selections
                .get_mut(&digest)
                .unwrap()
                .last_mut()
                .unwrap() = format!("jve1:{:064x}", 4_096usize);
            let delta = PreparedEvaluationInput::new(modified_options);
            let advanced = state.advance(delta, &[]);
            // A zero budget refuses whatever the selection holds, so it
            // skips the comparison. Otherwise the exhausted state has no
            // work left to compare the 4,096 IDs, so it rebuilds, which
            // is charged, instead of reading them.
            let expected = (limit > 0).then_some("configuration_changed");
            assert_eq!(
                advanced.statistics().reason.as_deref(),
                expected,
                "limit={limit}"
            );
            assert_eq!(advanced.consumed_work(), limit);
            assert!(!advanced.evaluation().available);
        }
    }

    #[test]
    fn overlay_change_and_recovery_share_unresolved_index_without_cloning_pending_ids() {
        let ids: Vec<String> = (0..4_096usize).map(|i| format!("jve1:{i:064x}")).collect();
        let sel_bytes = jvc_core::canonical_value(&json!(ids)).unwrap();
        let digest = jvc_core::hash_id("sha256:", b"", &sel_bytes);
        let issuer = identity_from_seed(&[3; 32]);
        let (view, view_body) = event(
            3,
            1,
            json!({"kind":"view.publish","parents":[]}),
            Some(json!({
                "name":"pending-overlay",
                "description":[],
                "roots":[],
                "rafsi_threshold":{"numerator":1,"denominator":1},
                "H":{"numerator":3,"denominator":1},
                "alpha":{"numerator":1,"denominator":2},
                "excluded":[],
                "calculation":"simple-routes-bounds-v1",
                "work":1000,
                "import_sets":[{"source":"fixture","importer":issuer,"selection":digest}],
                "account_witnesses":[],
                "account_authority":false,
                "notes":[]
            })),
        );

        // 1. Valid base -> invalid overlay shares `unresolved` in O(1) without cloning the 4,096 pending IDs.
        let mut valid_input = PreparedEvaluationInput::new(EvaluationOptions {
            selected_view: view.id().into(),
            import_selections: BTreeMap::from([(digest.clone(), ids.clone())]),
            overlay: None,
            limits: Limits::default(),
        });
        valid_input.add_record(&view, view_body.as_deref());
        let base_valid = valid_input.into_state();
        assert!(base_valid.evaluation().available);
        assert_eq!(base_valid.unresolved.len(), 4_096);
        let valid_first_id_ptr = base_valid.unresolved.iter().next().unwrap().as_ptr();

        let overlaid_invalid = base_valid.with_overlay(Some(json!({})));
        assert!(!overlaid_invalid.evaluation().available);
        assert_eq!(overlaid_invalid.unresolved.len(), 4_096);
        let invalid_first_id_ptr = overlaid_invalid.unresolved.iter().next().unwrap().as_ptr();
        assert_eq!(
            valid_first_id_ptr, invalid_first_id_ptr,
            "with_overlay(Some({{}})) must share unresolved index without cloning 4,096 pending selection IDs"
        );

        // 2. Invalid-overlay base -> with_overlay(None) recovery shares `unresolved` in O(1) without rebuilding the 4,096 pending IDs.
        let mut invalid_input = PreparedEvaluationInput::new(EvaluationOptions {
            selected_view: view.id().into(),
            import_selections: BTreeMap::from([(digest, ids)]),
            overlay: Some(json!({}).into()),
            limits: Limits::default(),
        });
        invalid_input.add_record(&view, view_body.as_deref());
        let base_invalid = invalid_input.into_state();
        assert!(!base_invalid.evaluation().available);
        assert_eq!(
            base_invalid.unresolved.len(),
            4_096,
            "invalid-overlay base that evaluated selections must retain unresolved index so recovery shares it in O(1)"
        );
        let base_invalid_first_ptr = base_invalid.unresolved.iter().next().unwrap().as_ptr();

        let recovered = base_invalid.with_overlay(None);
        assert!(recovered.evaluation().available);
        assert_eq!(recovered.unresolved.len(), 4_096);
        let recovered_first_ptr = recovered.unresolved.iter().next().unwrap().as_ptr();
        assert_eq!(
            base_invalid_first_ptr, recovered_first_ptr,
            "with_overlay(None) recovery must share unresolved index without rebuilding 4,096 pending selection IDs"
        );
    }
}
