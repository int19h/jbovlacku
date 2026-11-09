use super::*;
use graph::{Graph, Node};

pub const CHECKPOINT_VERSION: &str = "jvc-evaluation-checkpoint-v2";
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
            let graph = Graph::new(self.prepared.nodes.clone(), &self.prepared.options.limits);
            if graph.resource.get() {
                rebuild_reason = Some("history_resource_unavailable".into());
            } else {
                graph.budget.set(self.remaining_work);
                self.graph = Some(graph);
            }
        }
        // A judgment-only advance that rebuilds only because the
        // fast path declined on layout grounds still reports the keys
        // it changed, read from the rebuilt evaluation below. State
        // patches are built from those keys. Resource and lifecycle
        // rebuilds report none, as before.
        let added_judgments: Vec<(String, String, String)> = if removed.is_empty() {
            added
                .values()
                .filter(|node| node.kind == "judgment.set")
                .map(|node| {
                    (
                        node.id.clone(),
                        node.issuer.clone(),
                        node.action["target"]
                            .as_str()
                            .unwrap_or_default()
                            .to_string(),
                    )
                })
                .collect()
        } else {
            Vec::new()
        };
        let judgment_only = !added_judgments.is_empty() && added_judgments.len() == added.len();
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
            self.prepared.nodes.extend(added);
            self.rebuild();
            self.statistics.rebuilt = true;
            self.statistics.reason = Some(reason);
            self.statistics.incremental_records = 0;
            if judgment_only && layout_rebuild && self.evaluation.available {
                let mut changes = JudgmentChanges::default();
                for (id, issuer, target) in &added_judgments {
                    if self.evaluation.receipts.contains_key(id) {
                        changes.receipts.insert(id.clone());
                    }
                    let key = format!("{issuer}|judgment|{target}");
                    if self.evaluation.registers.contains_key(&key) {
                        changes.registers.insert(key);
                    }
                    if self
                        .evaluation
                        .judgments
                        .get(target)
                        .is_some_and(|actors| actors.contains_key(issuer))
                    {
                        changes
                            .judgments
                            .entry(target.clone())
                            .or_default()
                            .insert(issuer.clone());
                    }
                    if self.evaluation.lifecycle.key_actor.contains_key(issuer)
                        && self.evaluation.lifecycle.groups.contains_key(issuer)
                    {
                        changes.actors.insert(issuer.clone());
                    }
                }
                self.judgment_changes = Some(changes);
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
        // and appended alike. Every block record is then an ancestor
        // of the new record, so the layout emits it before the new
        // record, whatever the new record's ID. The one case coverage
        // does not settle is an ancestor that reaches a parent only
        // through another issuer: it can sit after the latest parent
        // in the block and still emit after the new record unless the
        // new ID sorts after it, because the layout emits ready
        // records in lexical order. The scan below rebuilds unless
        // the new ID is last among those records. No check here
        // clones an ID: coverage reads range bounds, and the scan
        // compares borrowed layout IDs. On the real 63,245-record
        // chain the parent is the chain tip, so coverage reads one
        // stored range and the scan reads none.
        //
        // The boundary span scan stays: a closure holding the block's
        // last record and the next block's first would split when the
        // new record inserts between them.
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
            let latest_parent = node
                .previous
                .iter()
                .filter_map(|id| graph.space.position(id))
                .max();
            if let Some(latest) = latest_parent {
                for position in latest + 1..=last {
                    if !graph.charge(1) {
                        return Err("work_budget");
                    }
                    if node.id.as_str() < graph.space.id_ref(position) {
                        return Err("layout_split");
                    }
                }
            }
            spanning_check(graph, last + 1)?;
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
            spanning_check(graph, graph.next_block_start(&node.issuer))?;
        }
        // The full build's charge for one more record, per cache:
        // setup (one per record and predecessor) plus construction
        // (one, plus one per predecessor for its missing set and its
        // fresh-layout range count). Three caches are charged when
        // they share storage, as in a full build. The layout pass
        // charges one per record and predecessor; lifecycle charges
        // one for this semantic record; account evaluation charges one
        // per record for its history scan.
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
        let work = (1 + node.previous.len()) + construction + 1 + 1;
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
        }
        serde_json::to_vec(&Saved {
            version: if results_only {
                "jvc-evaluation-results-v2"
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
            "jvc-evaluation-results-v2"
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
            ranking_index: Default::default(),
        })
    }
}

/// True when no existing closure has a range spanning the insertion
/// point. A spanning closure contains both records adjacent to the
/// point. Only an acceptance crosses issuer blocks, so the candidates
/// are the acceptance records themselves and the records of the next
/// issuer block that follow an acceptance in that block (plus that
/// block's appended records). Each tested closure is charged against
/// the graph budget and restored on success; the charge is never part
/// of the append price.
fn spanning_check(graph: &Graph, point: u32) -> std::result::Result<(), &'static str> {
    if point == 0 || point as usize >= graph.space.len() {
        return Ok(());
    }
    let tip = graph.space.id_at(point - 1);
    let next = graph.space.id_at(point);
    let next_issuer = graph.nodes[next.as_str()].issuer.clone();
    let first_accept = graph
        .nodes
        .values()
        .filter(|record| record.issuer == next_issuer && record.kind == "identity.accept")
        .filter_map(|record| graph.space.position(&record.id))
        .min();
    let saved = graph.budget.get();
    let mut seen: Vec<usize> = Vec::new();
    for cache in [&graph.own, &graph.structural, &graph.accepted] {
        let pointer = std::rc::Rc::as_ptr(cache) as usize;
        if seen.contains(&pointer) {
            continue;
        }
        seen.push(pointer);
        let test = |record_id: &str| -> std::result::Result<bool, &'static str> {
            if !graph.charge(1) {
                return Err("work_budget");
            }
            Ok(cache
                .get(record_id)
                .is_some_and(|closure| closure.ids.contains(&tip) && closure.ids.contains(&next)))
        };
        for record in graph
            .nodes
            .values()
            .filter(|record| record.kind == "identity.accept")
        {
            if test(&record.id)? {
                graph.budget.set(saved);
                return Err("layout_split");
            }
        }
        for record in graph
            .nodes
            .values()
            .filter(|record| record.issuer == next_issuer)
        {
            let appended = graph.space.position(&record.id).is_none();
            if !appended {
                let position = graph.space.position(&record.id).unwrap();
                if record.id != next && first_accept.is_none_or(|first| position <= first) {
                    continue;
                }
            }
            if test(&record.id)? {
                graph.budget.set(saved);
                return Err("layout_split");
            }
        }
    }
    graph.budget.set(saved);
    Ok(())
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
        let issuers: Vec<String> = [7u8, 8, 9]
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
                        json!({"kind":"account.set","origin":"https://source.example","account":41,"value":"active","previous":claim_id,"carry":[claim_id]}),
                    ));
                    let carried_id = fresh_id(&mut counter);
                    prepared.add_host_verified_record(host(
                        carried_id.clone(),
                        &issuers[0],
                        vec![status_id.clone()],
                        json!({"kind":"account.set","origin":"https://source.example","account":41,"value":"active","previous":status_id,"carry":[status_id]}),
                    ));
                    tips.insert(issuers[0].clone(), carried_id);
                }
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
                    let issuer = &issuers[rng.below(3) as usize];
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
                let issuer = &issuers[rng.below(3) as usize].clone();
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
                        let other = &issuers[(rng.below(2) + 1) as usize % 3];
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
                            json!({"kind":"account.set","origin":"https://source.example","account":41,"value":"active","previous":tip,"carry":[carry]}),
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

    /// Kimi round 4 probe: three judgments on a two-record chain.
    /// The first covers the chain and appends. The second has the
    /// same parent but leaves out the first appended record, so it
    /// rebuilds. The third builds on the first appended record, whose
    /// closure still leaves out the second, so it rebuilds too. Every
    /// step matches a fresh full evaluation exactly.
    #[test]
    fn kimi_appended_extra_left_out_of_parents_rebuilds() {
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
    fn kimi_sibling_order_appends_match_their_full_evaluations() {
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

    /// Grok round 3 probe: an interleaved chain transferred to a
    /// successor whose lifecycle link is blocked by a second root. The
    /// structural cache of the acceptance holds many more ranges than
    /// its own closure. A judgment on the acceptance must cost exactly
    /// what a full evaluation costs, at the exact budget and one below.
    #[test]
    fn grok_transfer_append_matches_full_at_tight_budgets() {
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

    /// Kimi round 3 probe: a judgment inserted between an account
    /// claim and its status record splits the status closure that a
    /// later account record carries. The append must match a full
    /// evaluation at the exact budget and one below.
    #[test]
    fn kimi_carry_split_append_matches_full_at_tight_budgets() {
        let mut prepared = base();
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
            json!({"kind":"account.set","origin":"https://source.example","account":41,"value":"active","previous":claim_id,"carry":[claim_id]}),
        ));
        prepared.add_host_verified_record(host(
            third_id,
            &issuer,
            vec![status_id.clone()],
            json!({"kind":"account.set","origin":"https://source.example","account":41,"value":"active","previous":status_id,"carry":[status_id]}),
        ));
        // The ID sorts between the claim and the status record, so a
        // fresh layout splits the carried status closure.
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
