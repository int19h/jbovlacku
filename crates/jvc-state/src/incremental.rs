use super::*;
use graph::{Graph, Node};

pub const CHECKPOINT_VERSION: &str = "jvc-evaluation-checkpoint-v3";
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
pub struct EvaluatedState {
    prepared: PreparedEvaluationInput,
    evaluation: Evaluation,
    graph: Option<Graph>,
    unresolved: BTreeSet<String>,
    remaining_work: usize,
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
            saved_ancestry_bytes: None,
            checkpoint_restored: false,
            statistics: UpdateStatistics::default(),
            judgment_changes: None,
            ranking_index: Default::default(),
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
                &self.prepared.nodes,
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
        if self.prepared.event_limit_exceeded {
            self.evaluation = event_limit_evaluation(&self.prepared.options);
            self.graph = None;
            self.remaining_work = self.prepared.options.limits.traversal;
            self.unresolved.clear();
            return;
        }
        // Discard this state's old ancestry before allocating its replacement.
        self.saved_ancestry_bytes = None;
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
        self.ranking_index = Default::default();
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
            self.prepared.nodes.extend(added);
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
            + usize::from(self.evaluation.policy.is_some());
        if work > self.remaining_work {
            return Err("work_budget");
        }
        Ok(work)
    }

    fn append(&mut self, node: Node, work: usize) {
        let graph = self.graph.as_mut().unwrap();
        graph.append_ordinary(node.clone());
        // `work` already holds the graph-construction and history-scan
        // charges. The scoped evaluation updates below run the same
        // code a full evaluation runs for this record, and their own
        // charges (closure unions for the new record) come out of the
        // same budget, so the total equals a full evaluation.
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
            // Price the register from its stored charge: the base
            // evaluation already paid for the previous member set,
            // so refund exactly that and keep the new charge. No
            // unions are replayed to recover the old charge.
            let previous_charge = self
                .evaluation
                .registers
                .get(&key)
                .map(|register| register.maxima_charge)
                .unwrap_or(0);
            graph.ancestry.refund(previous_charge);
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
            let (heads, new_charge) = if sole_head {
                let amount = new_closure.ids.fresh_ranges * 8 + 64;
                if !graph.ancestry.charge(amount) {
                    graph.resource.set(true);
                }
                (BTreeSet::from([node.id.clone()]), amount)
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
                            && n.action["target"].as_str() == Some(target)
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
                let heads = graph.maxima(members, false);
                (heads, graph.ancestry.bytes() - charge_before)
            };
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
                    maxima_charge: new_charge,
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
                for (id, publication) in raw.publications {
                    self.evaluation.publications.get_mut(&id).unwrap().eligible =
                        publication.eligible;
                }
                rafsi_gate(&mut self.evaluation);
                graph.budget.set(saved_budget);
            }
        }
        self.remaining_work = graph.budget.get();
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
            #[serde(skip_serializing_if = "Option::is_none")]
            ancestry_bytes: Option<usize>,
            /// Maxima charge per register, in `evaluation.registers`
            /// order at save time.
            register_maxima_charges: Vec<usize>,
        }
        serde_json::to_vec(&Saved {
            version: if results_only {
                "jvc-evaluation-results-v3"
            } else {
                CHECKPOINT_VERSION
            },
            binding,
            options: &self.prepared.options,
            nodes: (!results_only).then_some(&self.prepared.nodes),
            evaluation: &self.evaluation,
            event_limit_exceeded: self.prepared.event_limit_exceeded,
            remaining_work: self.remaining_work,
            ancestry_bytes: self
                .graph
                .as_ref()
                .map(|graph| graph.ancestry.bytes())
                .or(self.saved_ancestry_bytes),
            register_maxima_charges: self
                .evaluation
                .registers
                .values()
                .map(|register| register.maxima_charge)
                .collect(),
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
            #[serde(default)]
            ancestry_bytes: Option<usize>,
            register_maxima_charges: Vec<usize>,
        }
        let saved: Saved = serde_json::from_slice(bytes)
            .map_err(|e| jvc_core::Error::new("checkpoint", e.to_string()))?;
        let expected_version = if records.is_some() {
            "jvc-evaluation-results-v3"
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
        // The registers' charge fields are not serialized with
        // them; the checkpoint's array restores them in register
        // order.
        let mut evaluation = saved.evaluation;
        if evaluation.registers.len() != saved.register_maxima_charges.len() {
            return Err(jvc_core::Error::new(
                "checkpoint",
                "checkpoint version or binding does not match",
            ));
        }
        for (register, charge) in evaluation
            .registers
            .values_mut()
            .zip(saved.register_maxima_charges.iter())
        {
            register.maxima_charge = *charge;
        }
        Ok(Self {
            unresolved: unresolved(&prepared),
            prepared,
            evaluation,
            graph: None,
            remaining_work: saved.remaining_work,
            saved_ancestry_bytes: saved.ancestry_bytes,
            checkpoint_restored: true,
            statistics: UpdateStatistics::default(),
            judgment_changes: None,
            ranking_index: Default::default(),
        })
    }
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

    fn assert_matches_full(state: &EvaluatedState, prepared: &PreparedEvaluationInput) {
        let full = prepared.clone().into_state();
        assert_eq!(state.evaluation(), full.evaluation());
        assert_eq!(remaining_work(state), remaining_work(&full));
        assert_eq!(cap_bytes(state), cap_bytes(&full));
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
        let mut comparisons = 0usize;
        for seed in 0..120u64 {
            let mut rng = Rng(seed ^ 0x9E37_79B9_7F4A_7C15);
            let mut prepared = base();
            let (publication, body) = publication();
            let publication_id = publication.id().to_string();
            prepared.add_record(&publication, body.as_deref());
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
                    0..=3 => {
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
                        host(
                            fresh_id(&mut counter),
                            issuer,
                            vec![],
                            json!({"kind":"definition.publish","word":word,"language":"en","parents":[],"origin":"native"}),
                        )
                    }
                };
                if record.node.kind == "account.set" {
                    assert!(
                        record.node.semantic,
                        "generated account record is not semantically valid"
                    );
                }
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
                }
                assert_matches_full(&state, &prepared);
                comparisons += 1;
            }
        }
        assert!(comparisons > 400, "only {comparisons} comparisons ran");
        assert!(fast_appends > 50, "only {fast_appends} fast appends ran");
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
        let consumed = 10_000_000 - remaining_work(&full_prepared.clone().into_state());
        for budget in [consumed, consumed - 1] {
            let mut base_p = base_prepared.clone();
            base_p.options.limits.traversal = budget;
            let mut full_p = full_prepared.clone();
            full_p.options.limits.traversal = budget;
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
            let used = 10_000_000 - remaining_work(&state);
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
        let used = 10_000_000 - remaining_work(&state);
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
            let used = 10_000_000 - remaining_work(&state);
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
        let mut add = |prepared: &mut PreparedEvaluationInput,
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
        let mut value: serde_json::Value = serde_json::from_slice(&saved).unwrap();
        value.as_object_mut().unwrap().remove("ancestry_bytes");
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
        state.evaluation.policy.as_mut().unwrap()["calculation"] =
            json!(jvc_rank::approximate::ALGORITHM);
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
            &state.prepared.nodes,
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
        state.evaluation.policy = Some(json!({"padding":"x".repeat(1_000_000)}));
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
}
