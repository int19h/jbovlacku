use super::*;
use graph::{Graph, Node};

pub const CHECKPOINT_VERSION: &str = "jvc-evaluation-checkpoint-v6";
const RESULTS_CHECKPOINT_VERSION: &str = "jvc-evaluation-results-v6";
pub const MAX_INCREMENTAL_RECORDS: usize = 64;
const APPENDS_BEFORE_REBASE: usize = MAX_INCREMENTAL_RECORDS;

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
/// A fork owns its result and shares the record projection and immutable ancestor payloads.
pub struct EvaluatedState {
    prepared: PreparedEvaluationInput,
    evaluation: Evaluation,
    graph: Option<Graph>,
    unresolved: BTreeSet<String>,
    remaining_work: usize,
    unmatched_publication_scans: usize,
    matched_publication_scans: BTreeMap<String, usize>,
    /// Ancestry bytes spent by the evaluation this state carries,
    /// saved across a checkpoint. A restored state has no graph, so
    /// the first advance seeds the rebuilt graph's cap counter with
    /// this total; without it the counter would miss the
    /// evaluation-time unions and could pass the cap where a full
    /// evaluation fails it. `None` on an old checkpoint forces a
    /// rebuild on the first advance instead.
    saved_ancestry_bytes: Option<usize>,
    checkpoint_restored: bool,
    statistics: UpdateStatistics,
    judgment_changes: Option<JudgmentChanges>,
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
            remaining_work: self.remaining_work,
            unmatched_publication_scans: self.unmatched_publication_scans,
            matched_publication_scans: self.matched_publication_scans.clone(),
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
            unmatched_publication_scans: 0,
            matched_publication_scans: BTreeMap::new(),
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
        &self.prepared.options.import_selections
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
        self.unresolved.clear();
        self.matched_publication_scans.clear();
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
        let mut state = self.clone();
        state.prepared.options.overlay = overlay.clone();
        if self.evaluation.reasons.contains("resource_unavailable") {
            rebuild(&mut state);
        } else {
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

    pub fn consumed_work(&self) -> usize {
        self.prepared
            .options
            .limits
            .traversal_budget(self.prepared.nodes.len())
            .saturating_sub(self.remaining_work)
    }

    pub fn statistics(&self) -> &UpdateStatistics {
        &self.statistics
    }

    pub fn judgment_changes(&self) -> Option<&JudgmentChanges> {
        self.judgment_changes.as_ref()
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
        serde_json::to_writer(
            &mut writer,
            &(
                &self.prepared.options,
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
        let e = &self.evaluation;
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
        for n in e
            .judgments
            .values()
            .map(BTreeMap::len)
            .chain(e.overlay.iter().flat_map(|v| {
                ["trust", "blocked", "root_changes"]
                    .into_iter()
                    .map(move |k| v[k].as_array().map_or(0, Vec::len))
            }))
        {
            count = count.checked_add(n).ok_or_else(|| {
                jvc_core::Error::new("resource_unavailable", "ranking record count overflow")
            })?;
        }
        Ok(count)
    }
    pub fn ranking_index_bound(&self) -> jvc_core::Result<policy::RankingIndexCounts> {
        policy::ranking_index_bound(&self.evaluation)
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
        if self.ranking_index.borrow().is_none() {
            let index = policy::ApproximateContextIndex::new(&self.evaluation)?;
            *self.ranking_index.borrow_mut() = Some(index);
        }
        Ok(())
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
        if self.prepared.arena_error().is_some() {
            self.evaluation = empty_evaluation(&self.prepared.options);
            resource_unavailable(&mut self.evaluation);
            self.graph = None;
            self.remaining_work = self
                .prepared
                .options
                .limits
                .traversal_budget(self.prepared.nodes.len());
            self.unresolved.clear();
            self.unmatched_publication_scans = 0;
            self.matched_publication_scans.clear();
            return;
        }
        if self.prepared.event_limit_exceeded {
            self.evaluation = event_limit_evaluation(&self.prepared.options);
            self.graph = None;
            self.remaining_work = self
                .prepared
                .options
                .limits
                .traversal_budget(self.prepared.nodes.len());
            self.unresolved.clear();
            self.unmatched_publication_scans = 0;
            self.matched_publication_scans.clear();
            return;
        }
        // Discard this state's old ancestry before allocating its replacement.
        self.saved_ancestry_bytes = None;
        self.graph = None;
        let graph = Graph::new(self.prepared.nodes.clone(), &self.prepared.options.limits);
        self.evaluation = evaluate_graph(&self.prepared.options, &graph);
        self.remaining_work = graph.budget.get();
        if self.evaluation.available {
            self.unmatched_publication_scans = graph.unmatched_publication_scans.get();
            self.matched_publication_scans = graph.matched_publication_scans.borrow().clone();
        } else {
            self.unmatched_publication_scans = 0;
            self.matched_publication_scans.clear();
        }
        self.graph = Some(graph);
        self.unresolved = unresolved(&self.prepared);
    }

    /// Advance from original records that already passed record preparation.
    /// Existing record replacements and removals always rebuild the state.
    pub fn advance(mut self, delta: PreparedEvaluationInput, removed: &[String]) -> Self {
        self.ranking_index = Default::default();
        let mut rebuild_reason =
            (self.prepared.options != delta.options).then(|| "configuration_changed".to_owned());
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
            // An old checkpoint without the byte total cannot be priced
            // exactly; rebuild so the first advance runs a full
            // evaluation, as it would have originally. Check before
            // building a graph the rebuild would discard.
            if self.checkpoint_restored && self.saved_ancestry_bytes.is_none() {
                rebuild_reason = Some("checkpoint_ancestry_unknown".into());
            } else {
                let graph = Graph::new(self.prepared.nodes.clone(), &self.prepared.options.limits);
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
                    self.append(node, work);
                    self.statistics.incremental_records += 1;
                    if self.graph.as_ref().is_some_and(|g| g.resource.get()) {
                        rebuild_reason = Some("history_resource_unavailable".into());
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
                self.judgment_changes = judgment_diff(&base, &self.evaluation);
            }
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
        let record_allowance = if self.prepared.options.limits.traversal.is_none() {
            DEFAULT_TRAVERSAL_PER_RECORD
        } else {
            0
        };
        let available_work = self.remaining_work.saturating_add(record_allowance);
        graph.budget.set(available_work);
        let mut target_work = 0usize;
        if node.kind == "judgment.set" {
            let target = node.action.view().index("target");
            let target = target.as_str().unwrap_or_default();
            let known = if target.starts_with("jvr1:") {
                let mut found = false;
                for p in self.evaluation.publications.values() {
                    target_work += 1;
                    if p.assignment.as_deref() == Some(target) {
                        found = true;
                        break;
                    }
                    if target_work > available_work {
                        break;
                    }
                }
                found
            } else {
                graph.nodes.get(target).is_some_and(|n| {
                    n.semantic && matches!(n.kind.as_str(), "definition.publish" | "rafsi.publish")
                })
            };
            if !known {
                return Err(if target_work > available_work {
                    "work_budget"
                } else {
                    "target_unresolved"
                });
            }
            if target_work > available_work {
                return Err("work_budget");
            }
        } else if node.kind == "definition.publish" {
            // A new native publication enters `evaluation.publications`
            // at its record ID. Every existing publication scan that
            // walks past that ID (all unmatched `jvr1:` judgments and
            // unlinked valid managed `bridge.set` records, plus matched
            // scans whose stop publication ID sorts after `node.id`)
            // visits the new publication once in a full evaluation.
            target_work = self.unmatched_publication_scans;
            if target_work > available_work {
                return Err("work_budget");
            }
            for (_, count) in self.matched_publication_scans.range((
                std::ops::Bound::Excluded(node.id.clone()),
                std::ops::Bound::Unbounded,
            )) {
                target_work = target_work.saturating_add(*count);
                if target_work > available_work {
                    return Err("work_budget");
                }
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
        // The last two units are the lifecycle record and the account
        // history scan. A full evaluation skips the scan when no
        // policy is selected, so the append charges it only then too.
        let work = (1 + node.previous.len())
            + construction
            + 1
            + usize::from(self.evaluation.policy.is_some())
            + target_work;
        let lineage_work = if node.kind == "definition.publish" {
            node.action
                .view()
                .index("parents")
                .as_array()
                .into_iter()
                .flatten()
                .filter(|v| v.as_str().is_some())
                .count()
                .saturating_sub(1)
        } else {
            0
        };
        if work.saturating_add(lineage_work) > available_work {
            return Err("work_budget");
        }
        Ok(work)
    }

    fn append(&mut self, node: Node, work: usize) {
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
        if self.prepared.options.limits.traversal.is_none() {
            self.remaining_work = self
                .remaining_work
                .saturating_add(DEFAULT_TRAVERSAL_PER_RECORD);
        }
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
            let target = node.action.view().index("target");
            let target = target.as_str().unwrap();
            if target.starts_with("jvr1:") {
                if let Some(publication) = self
                    .evaluation
                    .publications
                    .values()
                    .find(|p| p.assignment.as_deref() == Some(target))
                {
                    *self
                        .matched_publication_scans
                        .entry(publication.id.clone())
                        .or_insert(0) += 1;
                }
            }
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
            // Price the register from its stored charge: the base
            // evaluation already paid for the previous member set,
            // so refund exactly that and keep the new charge. No
            // unions are replayed to recover the old charge.
            let (previous_charge, previous_work, previous_member_work) = self
                .evaluation
                .registers
                .get(&key)
                .map(|register| {
                    (
                        register.maxima_charge,
                        register.maxima_work,
                        register.maxima_member_work,
                    )
                })
                .unwrap_or((0, 0, 0));
            graph.ancestry.refund(previous_charge);
            graph.budget.set(graph.budget.get() + previous_work);
            // Closed form, when it applies: the fast path's parents
            // cover the issuer's whole block, so every same-issuer
            // member is an ancestor of the new record. If every
            // current head also lies in the new record's closure,
            // no other member can be a head (a non-head member sits
            // inside some head's closure, which sits inside the new
            // record's), the new record is the only head, and a full
            // evaluation's maxima charge for the register is one
            // merge of its closure into an empty accumulator:
            // fresh ranges times 8, plus 64. A register with a head
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
            let (heads, new_charge, new_work) = if sole_head && new_closure.ids.fresh_ranges == 1 {
                let amount = new_closure.ids.fresh_ranges * 8 + 64;
                if !graph.ancestry.charge(amount) {
                    graph.resource.set(true);
                }
                if new_member_work > 0 {
                    let _ = graph.charge(new_member_work);
                }
                (BTreeSet::from([node.id.clone()]), amount, new_member_work)
            } else {
                // General path: run maxima over the same member set
                // a full evaluation uses for this register, so its
                // (now cap-charged) union work and the resulting
                // heads match a full build exactly.
                let members: BTreeSet<String> = graph
                    .nodes
                    .values()
                    .filter(|n| {
                        n.semantic
                            && n.kind == "judgment.set"
                            && graph.actor(&n.issuer) == node.issuer
                            && n.action.view().index("target").as_str() == Some(target)
                            && graph.retained(&n.id)
                            && !graph.suspended(&n.issuer)
                            && graph.own_complete(&n.id)
                            && !self.evaluation.receipts[&n.id]
                                .reasons
                                .contains("invalid_target")
                            && !self.evaluation.receipts[&n.id]
                                .reasons
                                .contains("target_pending")
                            && !self.evaluation.receipts[&n.id]
                                .reasons
                                .contains("account_binding_unavailable")
                    })
                    .map(|n| n.id.clone())
                    .collect();
                let charge_before = graph.ancestry.bytes();
                let work_before = graph.budget.get();
                let heads = graph.maxima(members, false);
                (
                    heads,
                    graph.ancestry.bytes() - charge_before,
                    work_before - graph.budget.get(),
                )
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
                    maxima_charge: new_charge,
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
                // Recomputing existing rafsi publications charges the
                // same in a full evaluation as in the base, so it is
                // not part of this record's marginal charge. Run it
                // with an unbounded budget cell and restore afterwards;
                // the ancestry cap still applies.
                let saved_budget = graph.budget.get();
                graph.budget.set(usize::MAX);
                let mut raw = empty_evaluation(&self.prepared.options);
                raw.policy = self.evaluation.policy.clone();
                raw.selections = self.evaluation.selections.clone();
                publications_for(graph, &mut raw, Some(&claims));
                for (id, publication) in std::rc::Rc::unwrap_or_clone(raw.results).publications {
                    self.evaluation.publications.get_mut(&id).unwrap().eligible =
                        publication.eligible;
                }
                rafsi_gate(&mut self.evaluation);
                graph.budget.set(saved_budget);
            }
        }
        self.remaining_work = graph.budget.get();
        add_node_references(&node, &mut self.unresolved);
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
        if let Some(error) = self.prepared.arena_error() {
            return Err(jvc_core::Error::new("checkpoint", error.to_string()));
        }
        #[derive(Serialize)]
        struct SavedFull<'a> {
            version: &'static str,
            binding: &'a str,
            options: &'a EvaluationOptions,
            nodes: &'a BTreeMap<String, Node>,
            evaluation: &'a Evaluation,
            event_limit_exceeded: bool,
            remaining_work: usize,
            ancestry_bytes: Option<usize>,
            register_maxima_charges: Vec<usize>,
            register_maxima_work: Vec<usize>,
            register_maxima_member_work: Vec<usize>,
            unmatched_publication_scans: usize,
            matched_publication_scans: &'a BTreeMap<String, usize>,
        }
        #[derive(Serialize)]
        struct SavedResults<'a> {
            version: &'static str,
            binding: &'a str,
            options: &'a EvaluationOptions,
            evaluation: &'a Evaluation,
            event_limit_exceeded: bool,
            remaining_work: usize,
            ancestry_bytes: Option<usize>,
            register_maxima_charges: Vec<usize>,
            register_maxima_work: Vec<usize>,
            register_maxima_member_work: Vec<usize>,
            unmatched_publication_scans: usize,
            matched_publication_scans: &'a BTreeMap<String, usize>,
        }
        let ancestry_bytes = self
            .graph
            .as_ref()
            .map(|graph| graph.ancestry.bytes())
            .or(self.saved_ancestry_bytes);
        let register_maxima_charges: Vec<usize> = self
            .evaluation
            .registers
            .values()
            .map(|register| register.maxima_charge)
            .collect();
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
        if results_only {
            serde_json::to_vec(&SavedResults {
                version: RESULTS_CHECKPOINT_VERSION,
                binding,
                options: &self.prepared.options,
                evaluation: &self.evaluation,
                event_limit_exceeded: self.prepared.event_limit_exceeded,
                remaining_work: self.remaining_work,
                ancestry_bytes,
                register_maxima_charges,
                register_maxima_work,
                register_maxima_member_work,
                unmatched_publication_scans: self.unmatched_publication_scans,
                matched_publication_scans: &self.matched_publication_scans,
            })
        } else {
            serde_json::to_vec(&SavedFull {
                version: CHECKPOINT_VERSION,
                binding,
                options: &self.prepared.options,
                nodes: &self.prepared.nodes,
                evaluation: &self.evaluation,
                event_limit_exceeded: self.prepared.event_limit_exceeded,
                remaining_work: self.remaining_work,
                ancestry_bytes,
                register_maxima_charges,
                register_maxima_work,
                register_maxima_member_work,
                unmatched_publication_scans: self.unmatched_publication_scans,
                matched_publication_scans: &self.matched_publication_scans,
            })
        }
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
                    remaining_work: full.remaining_work,
                    ancestry_bytes: full.ancestry_bytes,
                    register_maxima_charges: full.register_maxima_charges,
                    register_maxima_work: full.register_maxima_work,
                    register_maxima_member_work: full.register_maxima_member_work,
                    unmatched_publication_scans: full.unmatched_publication_scans,
                    matched_publication_scans: full.matched_publication_scans,
                };
                (saved, CHECKPOINT_VERSION, nodes)
            }
        };
        if saved.version != expected_version
            || saved.binding != binding
            || saved.evaluation.selected_view != saved.options.selected_view
            || saved.evaluation.overlay != saved.options.overlay
            || saved.remaining_work > saved.options.limits.traversal_budget(nodes.len())
            || !valid_saved_state(&saved, &nodes)
        {
            return Err(jvc_core::Error::new(
                "checkpoint",
                "checkpoint version or binding does not match",
            ));
        }
        let arena = std::rc::Rc::new(std::cell::RefCell::new(arena::RecordArena::default()));
        let nodes = nodes
            .into_iter()
            .map(|(id, node)| (id, node.repack(&arena)))
            .collect();
        if let Some(error) = arena.borrow().error() {
            return Err(jvc_core::Error::new("checkpoint", error.to_string()));
        }
        arena.borrow_mut().finish_load();
        let prepared = PreparedEvaluationInput {
            options: saved.options,
            nodes: std::rc::Rc::new(nodes),
            arena,
            arena_error: None,
            event_limit_exceeded: saved.event_limit_exceeded,
        };
        // The registers' charge fields are not serialized with
        // them; the checkpoint's array restores them in register
        // order.
        let mut evaluation = saved.evaluation;
        if evaluation.registers.len() != saved.register_maxima_charges.len()
            || evaluation.registers.len() != saved.register_maxima_work.len()
            || evaluation.registers.len() != saved.register_maxima_member_work.len()
        {
            return Err(jvc_core::Error::new(
                "checkpoint",
                "checkpoint version or binding does not match",
            ));
        }
        for (((register, charge), work), member_work) in evaluation
            .registers
            .values_mut()
            .zip(saved.register_maxima_charges.iter())
            .zip(saved.register_maxima_work.iter())
            .zip(saved.register_maxima_member_work.iter())
        {
            register.maxima_charge = *charge;
            register.maxima_work = *work;
            register.maxima_member_work = *member_work;
        }
        Ok(Self {
            unresolved: unresolved(&prepared),
            prepared,
            evaluation,
            graph: None,
            remaining_work: saved.remaining_work,
            unmatched_publication_scans: saved.unmatched_publication_scans,
            matched_publication_scans: saved.matched_publication_scans,
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
    remaining_work: usize,
    #[serde(deserialize_with = "Option::deserialize")]
    ancestry_bytes: Option<usize>,
    register_maxima_charges: Vec<usize>,
    register_maxima_work: Vec<usize>,
    register_maxima_member_work: Vec<usize>,
    unmatched_publication_scans: usize,
    matched_publication_scans: BTreeMap<String, usize>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SavedResultsCheckpoint {
    version: String,
    binding: String,
    options: EvaluationOptions,
    evaluation: Evaluation,
    event_limit_exceeded: bool,
    remaining_work: usize,
    #[serde(deserialize_with = "Option::deserialize")]
    ancestry_bytes: Option<usize>,
    register_maxima_charges: Vec<usize>,
    register_maxima_work: Vec<usize>,
    register_maxima_member_work: Vec<usize>,
    unmatched_publication_scans: usize,
    matched_publication_scans: BTreeMap<String, usize>,
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

fn valid_saved_state(saved: &SavedResultsCheckpoint, nodes: &BTreeMap<String, Node>) -> bool {
    check_saved_state(saved, nodes).is_ok()
}

fn check_saved_state(
    saved: &SavedResultsCheckpoint,
    nodes: &BTreeMap<String, Node>,
) -> Result<(), &'static str> {
    for (id, node) in nodes {
        if id != &node.id {
            return Err("node_id");
        }
        valid_node_state(node)?;
    }
    if saved.options.limits.traversal.is_none()
        && !saved.event_limit_exceeded
        && !saved.evaluation.reasons.contains("resource_unavailable")
        && nodes.len() <= 1024
        && saved.remaining_work < DEFAULT_TRAVERSAL_BASE / 2
    {
        return Err("default_traversal_remainder");
    }
    if saved.event_limit_exceeded
        || saved.evaluation.reasons.contains("resource_unavailable")
        || (nodes.is_empty()
            && !saved.evaluation.available
            && saved.evaluation.reasons.contains("view_unavailable"))
    {
        return Ok(());
    }

    // Receipts must match nodes 1-to-1.
    if saved.evaluation.receipts.len() != nodes.len() {
        return Err("receipts_len");
    }
    for (id, node) in nodes {
        let Some(receipt) = saved.evaluation.receipts.get(id) else {
            return Err("receipt_missing");
        };
        if receipt.body != node.body_label {
            return Err("receipt_body");
        }
    }

    // Policy, policy_history, policies, and selections must match nodes and options.
    let expected_policy = nodes
        .get(&saved.options.selected_view)
        .filter(|n| n.semantic && n.kind == "view.publish")
        .and_then(|n| n.body.as_ref());
    if !optional_policy_matches(saved.evaluation.policy.as_ref(), expected_policy) {
        return Err("expected_policy");
    }
    if saved.evaluation.policies.len() != saved.evaluation.policy_history.len() {
        return Err("policies_len");
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
    for (vid, pol) in &saved.evaluation.policy_history {
        let view_body = nodes
            .get(vid)
            .filter(|n| n.semantic && n.kind == "view.publish")
            .and_then(|n| n.body.as_ref());
        if view_body != Some(pol) || !saved.evaluation.policies.contains(pol) {
            return Err("policy_history_entry");
        }
    }
    for pol in &saved.evaluation.policies {
        if !saved.evaluation.policy_history.values().any(|p| p == pol) {
            return Err("policies_entry");
        }
    }
    if let Some(pol) = &saved.evaluation.policy {
        let mut expected_selections = BTreeMap::new();
        let mut missing_selection = false;
        for entry in pol
            .view()
            .index("import_sets")
            .as_array()
            .into_iter()
            .flatten()
        {
            let Some(sel_id) = entry.index("selection").as_str().map(str::to_owned) else {
                missing_selection = true;
                continue;
            };
            match policy::valid_selection(&saved.options, &sel_id) {
                Some(ids) => {
                    expected_selections
                        .insert(sel_id, ids.iter().cloned().collect::<BTreeSet<_>>());
                }
                None => {
                    missing_selection = true;
                }
            }
        }
        if saved.evaluation.selections != expected_selections
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

    // Lifecycle cross-checks.
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
            if !saved.evaluation.lifecycle.suspended.contains_key(actor) {
                return Err("lifecycle_suspended_missing");
            }
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
        {
            return Err("lifecycle_successor_actor");
        }
    }
    for (actor, missing) in &saved.evaluation.lifecycle.suspended {
        if missing.is_empty() || !saved.evaluation.lifecycle.groups.contains_key(actor) {
            return Err("lifecycle_suspended_entry");
        }
    }

    // Publications cross-checks.
    let expected_pub_count = nodes
        .values()
        .filter(|n| n.semantic && matches!(n.kind.as_str(), "definition.publish" | "rafsi.publish"))
        .count();
    if saved.evaluation.publications.len() != expected_pub_count {
        return Err("publications_len");
    }
    for (id, p) in &saved.evaluation.publications {
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
            if let Some(acc) = &p.account
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
                        || p.witness_contributions != state.contributions
                        || p.observations != state.current_observations
                    {
                        return Err("publication_account_fields");
                    }
                    let expected_deciding =
                        if p.controller_candidates.len() == 1 && p.status != Status::Unavailable {
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
        if !state.unavailable
            && !state.disputed
            && state.candidates.len() == 1
            && state.controller != state.candidates.iter().next().cloned()
        {
            return Err("account_controller");
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

    // Registers, judgments, and trust cross-checks.
    let mut judgment_registers = 0usize;
    let mut trust_registers = 0usize;
    for (key, reg) in &saved.evaluation.registers {
        if reg.key != *key || reg.heads.is_empty() || reg.values.is_empty() {
            return Err("register_fields");
        }
        if let Some((actor, target)) = key.split_once("|judgment|") {
            if actor != reg.actor {
                return Err("register_judgment_actor");
            }
            judgment_registers += 1;
            if saved
                .evaluation
                .judgments
                .get(target)
                .and_then(|m| m.get(&reg.actor))
                .is_none()
            {
                return Err("register_judgment_entry");
            }
        } else if let Some((actor, _)) = key.split_once("|trust|") {
            if actor != reg.actor {
                return Err("register_trust_actor");
            }
            trust_registers += 1;
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
        || saved.evaluation.trust.len() < trust_registers
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
    }

    // Publication scan count cross-checks.
    for (pub_id, &count) in &saved.matched_publication_scans {
        if count == 0 || !saved.evaluation.publications.contains_key(pub_id) {
            return Err("matched_publication_scans_entry");
        }
    }
    let expected_scans = nodes
        .values()
        .filter(|node| {
            if !node.semantic {
                return false;
            }
            let a = node.action.view();
            match node.kind.as_str() {
                "judgment.set" => a
                    .index("target")
                    .as_str()
                    .unwrap_or_default()
                    .starts_with("jvr1:"),
                "bridge.set" => {
                    let target_view = a.index("target");
                    let target = target_view.as_str().unwrap_or_default();
                    a.index("value") == "managed"
                        && nodes.get(target).is_some_and(|n| {
                            n.semantic
                                && n.kind == "definition.publish"
                                && n.action.view().index("origin") == "native"
                                && saved.evaluation.lifecycle.key_actor.get(&n.issuer)
                                    == saved.evaluation.lifecycle.key_actor.get(&node.issuer)
                        })
                }
                _ => false,
            }
        })
        .count();
    let recorded_scans =
        saved.unmatched_publication_scans + saved.matched_publication_scans.values().sum::<usize>();
    if recorded_scans != expected_scans {
        return Err("publication_scans_total");
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

fn references(value: ValueView, result: &mut BTreeSet<String>) {
    if let Some(id) = value.as_str().filter(|id| jvc_core::valid_id(id, "jve1:")) {
        result.insert(id.into());
    } else {
        value.for_each_child(|child| references(child, result));
    }
}

fn add_node_references(node: &Node, result: &mut BTreeSet<String>) {
    result.extend(node.previous.iter().cloned());
    references(node.action.view(), result);
    if let Some(body) = &node.body {
        references(body.view(), result);
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
        for i in 0..2_348usize {
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
                    assert_matches_full(&fork, &fork_prepared);
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
                .traversal_budget(parent.event_count())
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
        assert_eq!(
            child.checkpoint("projection").unwrap(),
            full.into_state().checkpoint("projection").unwrap()
        );
    }

    #[test]
    fn overlay_resource_rebuild_matches_policy_early_return_with_suspension() {
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
        assert!(state.evaluation.lifecycle.suspended.contains_key(&issuer));
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
            options.overlay = Some(overlay);
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
        delta.options.overlay = Some(overlay.clone());
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
        full.options.overlay = Some(overlay);
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
        let state = prepared.clone().into_state();
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
            assert_matches_full(&fork, &full);
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
    /// evaluation does, including the evaluation-time account carry
    /// unions: the checkpoint saves the byte total and the first
    /// advance seeds the rebuilt graph with it. The fixture carries
    /// a certified account claim, so account evaluation really runs
    /// the carry unions this test covers.
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
        // The carry unions run during evaluation, so the evaluated
        // byte total exceeds the graph-construction total. Without
        // this gap the checkpoint assertions below could not catch a
        // missing restoration seed.
        let construction_bytes =
            graph::Graph::new(prepared.nodes.clone(), &prepared.options.limits)
                .ancestry
                .bytes();
        assert!(
            cap_bytes(&base_state) > construction_bytes,
            "evaluated {} bytes, construction {construction_bytes}",
            cap_bytes(&base_state)
        );
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
            let direct = state.clone().advance(delta.clone(), &[]);
            let restored = restored.advance(delta, &[]);
            assert_matches_full(&direct, &prepared);
            assert_matches_full(&restored, &prepared);
            state = direct;
        }
    }

    /// A non-semantic judgment in the register group must not enter
    /// the incremental member set: `registers` skips it, so the
    /// append's charged unions and refund match a full evaluation
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
                        .remove("register_maxima_charges");
                }
                "short" => {
                    let array = value["register_maxima_charges"].as_array_mut().unwrap();
                    array.pop();
                }
                _ => {
                    value["register_maxima_charges"]
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
        let rebuilt = prepared.clone().into_state();
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
        let stripped = serde_json::to_vec(&value).unwrap();
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
        assert!(
            cap_bytes(&prepared.clone().into_state()) > construction_bytes,
            "carry evaluation must add ancestry bytes beyond construction"
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
        // Fork A appends on both heavy chain tips and crosses the cap.
        // It must rebuild and return the full (unavailable) result.
        let (judgment_a, _) = signed(
            7,
            9500,
            vec![ids[2_346].clone(), ids[2_347].clone()],
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
        state.evaluation.overlay = Some(json!({"trust":[{"issuer":1}]}));
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

    #[test]
    fn rafsi_pair_judgment_and_managed_bridge_publication_scans_stop_at_work_budget() {
        let mut prepared = base();
        let word = jvc_core::word_id(&json!({"language":"jbo","spelling":"banli"})).unwrap();
        let rafsi_target = format!("jvr1:{:064x}", 1usize);
        let issuer = identity_from_seed(&[5u8; 32]);
        let mut first_pub = String::new();
        for i in 0..400usize {
            let pub_id = format!("jve1:{:064x}", 7_100_000 + i);
            if i == 0 {
                first_pub = pub_id.clone();
            }
            prepared.add_host_verified_record(host_missing_body(
                pub_id,
                &issuer,
                vec![],
                json!({"kind":"definition.publish","word":word,"language":"en","parents":[],"origin":"native"}),
            ));
        }
        for i in 0..400usize {
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
        assert_probe_refuses_under_budget_and_passes_default(prepared, 40_000);
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
            defaults.traversal_budget(250_000),
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
        let state = prepared.clone().into_state();
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

        // Control: ordinary jve1: judgments do not scan `evaluation.publications`.
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

        // Unresolved `jvr1:` judgments scan every publication in `evaluation.publications`,
        // including a native `definition.publish` added on the fast path.
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

    #[test]
    fn fast_append_native_publication_with_unresolved_rafsi_judgments_refuses_at_tight_budget() {
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
        prepared.options.limits.traversal = Some(218);
        let state = prepared.clone().into_state();
        assert!(state.evaluation().available);

        let word = jvc_core::word_id(&json!({"language":"jbo","spelling":"banli"})).unwrap();
        let new_issuer = identity_from_seed(&[9u8; 32]);
        let new_pub = host_missing_body(
            format!("jve1:{:064x}", 40_000usize),
            &new_issuer,
            vec![],
            json!({"kind":"definition.publish","word":word,"language":"en","parents":[],"origin":"native"}),
        );
        let (fast, full, _) = compare_fast_and_full(&prepared, &new_pub);
        assert!(!fast.evaluation().available);
        assert!(!full.evaluation().available);
        assert_whole_evaluation_refusal(fast.evaluation());
        assert_whole_evaluation_refusal(full.evaluation());
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

    #[test]
    fn fast_append_native_publication_before_matched_rafsi_or_bridge_scan_charges_visit() {
        let mut prepared = witnessed_view();
        let word = jvc_core::word_id(&json!({"language":"jbo","spelling":"banli"})).unwrap();
        let rafsi_target = format!("jvr1:{:064x}", 7usize);
        let issuer = identity_from_seed(&[1u8; 32]);
        let rafsi_pub_id = format!("jve1:{:064x}", 500_000usize);
        prepared.add_host_verified_record(host_missing_body(
            rafsi_pub_id,
            &issuer,
            vec![],
            json!({"kind":"rafsi.publish","word":word,"assignment":rafsi_target,"origin":"native"}),
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
            let direct = after_judgment.clone().advance(delta.clone(), &[]);
            assert!(!direct.statistics().rebuilt);

            let saved = after_judgment.checkpoint("host-checked").unwrap();
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
    fn checkpoint_without_publication_scan_fields_or_with_v4_version_refuses_at_tight_budget() {
        let word = jvc_core::word_id(&json!({"language":"jbo","spelling":"banli"})).unwrap();
        let new_issuer = identity_from_seed(&[9u8; 32]);
        let new_pub = host_missing_body(
            format!("jve1:{:064x}", 40_000usize),
            &new_issuer,
            vec![],
            json!({"kind":"definition.publish","word":word,"language":"en","parents":[],"origin":"native"}),
        );

        // 1. Unmatched `jvr1:` scans at tight budget (218).
        let mut prepared = base();
        let mut records = Vec::new();
        for node in prepared.nodes.values() {
            records.push(HostVerifiedRecord { node: node.clone() });
        }
        let rafsi_target = format!("jvr1:{:064x}", 1usize);
        let judge = identity_from_seed(&[5u8; 32]);
        for i in 0..20usize {
            let record = host(
                format!("jve1:{:064x}", 30_000 + i),
                &judge,
                vec![],
                json!({"kind":"judgment.set","target":rafsi_target,"value":"bless"}),
            );
            records.push(record.clone());
            prepared.add_host_verified_record(record);
        }
        prepared.options.limits.traversal = Some(218);
        let state = prepared.clone().into_state();
        assert!(state.evaluation().available);
        assert_eq!(state.consumed_work(), 190);

        let mut full_prepared = prepared.clone();
        full_prepared.add_host_verified_record(new_pub.clone());
        let full = full_prepared.into_state();
        assert!(!full.evaluation().available);
        assert_eq!(full.consumed_work(), 218);
        assert_whole_evaluation_refusal(full.evaluation());

        let mut delta = PreparedEvaluationInput::new(prepared.options.clone());
        delta.add_host_verified_record(new_pub.clone());

        let saved_full = state.checkpoint("host-checked").unwrap();
        let saved_results = state.result_checkpoint("host-checked").unwrap();
        for case in [
            "strip_unmatched",
            "strip_matched",
            "strip_both",
            "v4_version",
        ] {
            for (is_results, raw) in [(false, &saved_full), (true, &saved_results)] {
                let mut value: Value = serde_json::from_slice(raw).unwrap();
                match case {
                    "strip_unmatched" => {
                        value
                            .as_object_mut()
                            .unwrap()
                            .remove("unmatched_publication_scans");
                    }
                    "strip_matched" => {
                        value
                            .as_object_mut()
                            .unwrap()
                            .remove("matched_publication_scans");
                    }
                    "strip_both" => {
                        let obj = value.as_object_mut().unwrap();
                        obj.remove("unmatched_publication_scans");
                        obj.remove("matched_publication_scans");
                    }
                    "v4_version" => {
                        value["version"] = json!(if is_results {
                            "jvc-evaluation-results-v4"
                        } else {
                            "jvc-evaluation-checkpoint-v4"
                        });
                    }
                    _ => unreachable!(),
                }
                let mutated = serde_json::to_vec(&value).unwrap();
                let restored = if is_results {
                    EvaluatedState::restore_host_result_checkpoint(
                        &mutated,
                        "host-checked",
                        records.clone(),
                    )
                } else {
                    EvaluatedState::restore_host_checkpoint(&mutated, "host-checked")
                };
                let err_flag = restored.is_err();
                let base_or_rebuilt = restored.unwrap_or_else(|_| prepared.clone().into_state());
                let fast = base_or_rebuilt.advance(delta.clone(), &[]);
                assert!(
                    !fast.evaluation().available,
                    "case={case} is_results={is_results}: expected refusal, got available=true with consumed_work={}",
                    fast.consumed_work()
                );
                assert_eq!(fast.consumed_work(), full.consumed_work());
                assert_whole_evaluation_refusal(fast.evaluation());
                assert_eq!(
                    serde_json::to_value(fast.evaluation()).unwrap(),
                    serde_json::to_value(full.evaluation()).unwrap()
                );
                assert!(
                    err_flag,
                    "case={case} is_results={is_results} must be rejected"
                );
            }
        }

        // 2. Matched `jvr1:` scans at tight budget (`full_work - 1`).
        let mut matched_prepared = base();
        let mut matched_records = Vec::new();
        for node in matched_prepared.nodes.values() {
            matched_records.push(HostVerifiedRecord { node: node.clone() });
        }
        let rafsi_pub = host_missing_body(
            format!("jve1:{:064x}", 0xf000usize),
            &identity_from_seed(&[1u8; 32]),
            vec![],
            json!({"kind":"rafsi.publish","word":word,"assignment":rafsi_target,"origin":"native"}),
        );
        matched_records.push(rafsi_pub.clone());
        matched_prepared.add_host_verified_record(rafsi_pub);
        for i in 0..20usize {
            let record = host(
                format!("jve1:{:064x}", 30_000 + i),
                &judge,
                vec![],
                json!({"kind":"judgment.set","target":rafsi_target,"value":"bless"}),
            );
            matched_records.push(record.clone());
            matched_prepared.add_host_verified_record(record);
        }
        let before_rafsi_pub = host_missing_body(
            format!("jve1:{:064x}", 0xd001usize),
            &new_issuer,
            vec![],
            json!({"kind":"definition.publish","word":word,"language":"en","parents":[],"origin":"native"}),
        );
        let base_work = matched_prepared.clone().into_state().consumed_work();
        let mut matched_full_open = matched_prepared.clone();
        matched_full_open.add_host_verified_record(before_rafsi_pub.clone());
        let full_work = matched_full_open.into_state().consumed_work();
        assert_eq!(full_work - base_work, 29);
        let tight_limit = full_work - 1;

        matched_prepared.options.limits.traversal = Some(tight_limit);
        let matched_state = matched_prepared.clone().into_state();
        assert!(matched_state.evaluation().available);
        assert_eq!(matched_state.consumed_work(), base_work);

        let mut matched_full_prepared = matched_prepared.clone();
        matched_full_prepared.add_host_verified_record(before_rafsi_pub.clone());
        let matched_full = matched_full_prepared.into_state();
        assert!(!matched_full.evaluation().available);
        assert_eq!(matched_full.consumed_work(), tight_limit);
        assert_whole_evaluation_refusal(matched_full.evaluation());

        let mut matched_delta = PreparedEvaluationInput::new(matched_prepared.options.clone());
        matched_delta.add_host_verified_record(before_rafsi_pub);

        let saved_matched = matched_state.checkpoint("host-checked").unwrap();
        let saved_matched_results = matched_state.result_checkpoint("host-checked").unwrap();
        for case in ["strip_matched", "v4_version"] {
            for (is_results, raw) in [(false, &saved_matched), (true, &saved_matched_results)] {
                let mut value: Value = serde_json::from_slice(raw).unwrap();
                match case {
                    "strip_matched" => {
                        value
                            .as_object_mut()
                            .unwrap()
                            .remove("matched_publication_scans");
                    }
                    "v4_version" => {
                        value["version"] = json!(if is_results {
                            "jvc-evaluation-results-v4"
                        } else {
                            "jvc-evaluation-checkpoint-v4"
                        });
                    }
                    _ => unreachable!(),
                }
                let mutated = serde_json::to_vec(&value).unwrap();
                let restored = if is_results {
                    EvaluatedState::restore_host_result_checkpoint(
                        &mutated,
                        "host-checked",
                        matched_records.clone(),
                    )
                } else {
                    EvaluatedState::restore_host_checkpoint(&mutated, "host-checked")
                };
                let err_flag = restored.is_err();
                let base_or_rebuilt =
                    restored.unwrap_or_else(|_| matched_prepared.clone().into_state());
                let fast = base_or_rebuilt.advance(matched_delta.clone(), &[]);
                assert!(
                    !fast.evaluation().available,
                    "matched case={case} is_results={is_results}: expected refusal, got available=true with consumed_work={}",
                    fast.consumed_work()
                );
                assert_eq!(fast.consumed_work(), matched_full.consumed_work());
                assert_whole_evaluation_refusal(fast.evaluation());
                assert!(
                    err_flag,
                    "matched case={case} is_results={is_results} must be rejected"
                );
            }
        }
    }

    #[test]
    fn checkpoint_always_serializes_publication_scan_fields_even_when_zero_or_empty() {
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
        assert_eq!(full_json["version"], json!("jvc-evaluation-checkpoint-v6"));
        assert_eq!(result_json["version"], json!("jvc-evaluation-results-v6"));
        assert!(result_json.get("nodes").is_none());
        for json in [&full_json, &result_json] {
            assert_eq!(json.get("unmatched_publication_scans"), Some(&json!(0)));
            assert_eq!(json.get("matched_publication_scans"), Some(&json!({})));
        }

        for field in [
            "unmatched_publication_scans",
            "matched_publication_scans",
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

        // Case B: 20 unresolved `jvr1:` judgments at tight budget 218 (base consumes 190, full consumes 219 -> refuses at 218).
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
        jvr_prepared.options.limits.traversal = Some(218);

        let mut failures = Vec::new();
        for (label, prepared, expected_base_work, expected_tight_work) in [
            ("jve1_judgments_266", jve_prepared, 258usize, 266usize),
            ("jvr1_judgments_218", jvr_prepared, 190usize, 218usize),
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
            traversal: Some(218),
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
        assert_eq!(full.consumed_work(), 218);

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
            overlay: Some(overlay),
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

        let rafsi_target = format!("jvr1:{:064x}", 7usize);
        let rafsi_pub_id = format!("jve1:{:064x}", 10_002usize);
        prepared.add_host_verified_record(host_missing_body(
            rafsi_pub_id,
            &issuer,
            vec![],
            json!({"kind":"rafsi.publish","word":word,"assignment":rafsi_target,"origin":"native"}),
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
        assert!(state_open.unmatched_publication_scans > 0);
        assert!(!state_open.matched_publication_scans.is_empty());
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
                                let mut delta_e =
                                    PreparedEvaluationInput::new(prepared_exact.options.clone());
                                delta_e.add_host_verified_record(appended_pub.clone());
                                let adv_e = state_e.advance(delta_e, &[]);

                                let mut delta_t =
                                    PreparedEvaluationInput::new(prepared_tight.options.clone());
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
                                let mut delta_e =
                                    PreparedEvaluationInput::new(prepared_exact.options.clone());
                                delta_e.add_host_verified_record(appended_pub.clone());
                                let adv_e = state_e.advance(delta_e, &[]);

                                let mut delta_t =
                                    PreparedEvaluationInput::new(prepared_tight.options.clone());
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

        eprintln!(
            "checkpoint_schema_audit: deleted_checked={deleted_paths_checked} (rejected={deleted_rejected}, rebuilt={deleted_rebuilt}), nulled_checked={nulled_paths_checked} (rejected={nulled_rejected}, rebuilt={nulled_rebuilt}), failures={}",
            failures.len()
        );
        assert!(
            failures.is_empty(),
            "checkpoint schema audit failures ({}):\n{}",
            failures.len(),
            failures.join("\n")
        );
    }
}
