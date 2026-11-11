use super::*;
use std::cell::Cell;
use std::rc::Rc;

#[cfg(test)]
thread_local! {
    static CONSTRUCTIONS: Cell<usize> = const { Cell::new(0) };
}
#[cfg(test)]
pub(super) fn construction_count() -> usize {
    CONSTRUCTIONS.with(Cell::get)
}
#[cfg(test)]
thread_local! {
    /// Records visited by lifecycle root indexing and successor
    /// root lookups. A per-transfer scan of all records would make
    /// this grow with the square of the record count.
    static LIFECYCLE_VISITS: Cell<usize> = const { Cell::new(0) };
}
#[cfg(test)]
pub(super) fn lifecycle_visits() -> usize {
    LIFECYCLE_VISITS.with(Cell::get)
}
#[cfg(test)]
thread_local! {
    /// Ranges examined by `Graph::maxima` while merging closures.
    static MAXIMA_RANGE_VISITS: Cell<usize> = const { Cell::new(0) };
}
#[cfg(test)]
pub(super) fn maxima_range_visits() -> usize {
    MAXIMA_RANGE_VISITS.with(Cell::get)
}
#[cfg(test)]
pub(super) fn reset_maxima_range_visits() {
    MAXIMA_RANGE_VISITS.with(|count| count.set(0));
}
#[cfg(test)]
thread_local! {
    /// Work done by the inner loops the resource audit touched
    /// (lifecycle indexing and walks, maxima merges, account index
    /// lookups). The guard test compares it with charged units.
    static AUDIT_WORK: Cell<usize> = const { Cell::new(0) };
}
#[cfg(test)]
pub(crate) fn count_work(amount: usize) {
    AUDIT_WORK.with(|count| count.set(count.get() + amount));
}
#[cfg(test)]
pub(crate) fn audit_work() -> usize {
    AUDIT_WORK.with(Cell::get)
}
#[cfg(test)]
pub(crate) fn reset_audit_work() {
    AUDIT_WORK.with(|count| count.set(0));
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Node {
    pub id: String,
    pub issuer: String,
    pub previous: Vec<String>,
    pub action: CompactValue,
    pub kind: String,
    pub semantic: bool,
    pub body_hash: Option<String>,
    pub body: Option<CompactValue>,
    pub body_label: String,
}
impl Node {
    pub fn new_with_in<T>(
        arena: arena::SharedArena,
        event: &VerifiedEnvelope,
        bytes: Option<&[u8]>,
        inspect: impl FnOnce(&BodyAvailability) -> T,
    ) -> (Self, T) {
        Self::from_parts_in(
            arena,
            event.id(),
            event.header(),
            inspect_body(event, bytes),
            inspect,
        )
    }
    pub(super) fn from_parts<T>(
        id: &str,
        header: &jvc_core::Header,
        availability: BodyAvailability,
        inspect: impl FnOnce(&BodyAvailability) -> T,
    ) -> (Self, T) {
        Self::from_parts_in(
            std::rc::Rc::new(std::cell::RefCell::new(arena::RecordArena::default())),
            id,
            header,
            availability,
            inspect,
        )
    }
    fn from_parts_in<T>(
        arena: arena::SharedArena,
        id: &str,
        header: &jvc_core::Header,
        availability: BodyAvailability,
        inspect: impl FnOnce(&BodyAvailability) -> T,
    ) -> (Self, T) {
        let kind = header.action["kind"].as_str().unwrap_or_default();
        let content = inspect(&availability);
        let (body, body_label) = match availability {
            BodyAvailability::Absent => (None, "absent".into()),
            BodyAvailability::Missing => (None, "missing".into()),
            BodyAvailability::Valid { mut body } => {
                if matches!(kind, "definition.publish" | "rafsi.publish") {
                    // Content validation uses the complete body above. State needs
                    // only import provenance and the fact that content is valid.
                    let legacy = body.get_mut("legacy").map(Value::take);
                    body = Value::Object(Default::default());
                    if let Some(mut legacy) = legacy {
                        if let Some(fields) = legacy.as_object_mut() {
                            fields.retain(|key, _| {
                                matches!(key.as_str(), "source" | "record" | "attribution")
                            });
                            if let Some(record) =
                                fields.get_mut("record").and_then(Value::as_object_mut)
                            {
                                record.retain(|key, _| key == "id");
                            }
                            if let Some(attribution) =
                                fields.get_mut("attribution").and_then(Value::as_object_mut)
                            {
                                attribution.retain(|key, _| key == "author_account");
                                if let Some(account) = attribution
                                    .get_mut("author_account")
                                    .and_then(Value::as_object_mut)
                                {
                                    account.retain(|key, _| {
                                        matches!(key.as_str(), "origin" | "account" | "evidence")
                                    });
                                    if let Some(evidence) =
                                        account.get_mut("evidence").and_then(Value::as_object_mut)
                                    {
                                        evidence.retain(|key, _| key == "kind");
                                    }
                                }
                            }
                        }
                        body["legacy"] = legacy;
                    }
                }
                (Some(body), "valid".into())
            }
            BodyAvailability::Invalid { reason } => (None, format!("invalid:{reason}")),
        };
        (
            Self {
                id: id.into(),
                issuer: header.issuer.clone(),
                previous: header.previous.clone(),
                action: CompactValue::from_arena(arena.clone(), &header.action),
                kind: kind.into(),
                semantic: validate_action(header).is_ok(),
                body_hash: header.content.as_ref().map(|c| c.hash.clone()),
                body: body.map(|body| CompactValue::from_arena(arena, &body)),
                body_label,
            },
            content,
        )
    }
    pub(crate) fn repack(mut self, arena: &arena::SharedArena) -> Self {
        self.action = self.action.repack(arena);
        self.body = self.body.take().map(|body| body.repack(arena));
        self
    }
}
pub(crate) use super::ancestors::IdSet;

#[derive(Clone)]
pub(crate) struct Closure {
    pub ids: IdSet,
    pub missing: BTreeSet<String>,
    pub invalid: bool,
    pub resource: bool,
}
impl Closure {
    pub fn complete(&self) -> bool {
        self.missing.is_empty() && !self.invalid && !self.resource
    }
}
/// Count of stored closures whose ranges cross each layout boundary,
/// kept as a difference array over insertion coordinates. A closure
/// crosses the boundary at coordinate `p` when one of its ranges
/// holds members on both sides (`first < p <= last`). The fast path
/// reads one count per append: a crossing at its block boundary
/// means its insertion would split that range, so it rebuilds.
/// Building and extending cost one update per stored range; a query
/// is a prefix sum, logarithmic in the layout size.
#[derive(Clone, Default)]
pub(crate) struct BoundaryCrossings {
    tree: Vec<i64>,
}

impl BoundaryCrossings {
    fn with_len(len: usize) -> Self {
        Self {
            tree: vec![0; len + 2],
        }
    }

    fn add(&mut self, coordinate: u32, delta: i64) {
        let mut index = coordinate as usize + 1;
        while index < self.tree.len() {
            self.tree[index] += delta;
            index += index & index.wrapping_neg();
        }
    }

    fn extend_range(&mut self, first: u32, last: u32) {
        self.add(first + 1, 1);
        self.add(last + 1, -1);
    }

    fn crossing(&self, coordinate: u32) -> i64 {
        let mut index = coordinate as usize + 1;
        let mut total = 0;
        while index > 0 {
            total += self.tree.get(index).copied().unwrap_or(0);
            index -= index & index.wrapping_neg();
        }
        total
    }
}

/// The appended-rank index cached on a graph: the appended-record
/// count it was built for, appended records by full rank, and the
/// last appended record at each insertion position.
type RankIndex = (
    usize,
    BTreeMap<(u32, String, u32), String>,
    BTreeMap<u32, String>,
);

#[derive(Clone)]
pub(crate) struct Graph {
    pub nodes: Rc<BTreeMap<String, Node>>,
    pub own: Rc<BTreeMap<String, Closure>>,
    pub structural: Rc<BTreeMap<String, Closure>>,
    pub accepted: Rc<BTreeMap<String, Closure>>,
    pub lifecycle: Lifecycle,
    pub cutoffs: BTreeMap<String, Vec<Closure>>,
    pub transfers: BTreeMap<String, Vec<String>>,
    pub pending_cutoffs: BTreeSet<String>,
    pub space: Rc<super::ancestors::Space>,
    pub ancestry: super::ancestors::AncestryBudget,
    pub boundary: BoundaryCrossings,
    /// Whether every record of an issuer is complete for
    /// `local_complete`, computed in one pass at lifecycle build and
    /// kept current by appends.
    pub issuer_complete: BTreeMap<String, bool>,
    /// Appended-rank index for fresh range counts, built once per
    /// appended-record count and reused. Rebuilding it per maxima
    /// merge made one append after many earlier appends rebuild it
    /// once per register member.
    pub rank_index: std::cell::RefCell<Option<RankIndex>>,
    /// Semantic `account.set` record IDs by account token
    /// (`origin#account`), in record order. Account evaluation reads
    /// this index instead of scanning all records per claim.
    pub account_sets: BTreeMap<String, Vec<String>>,
    /// Per issuer, the union of missing IDs over its retained
    /// records, for account evaluation's missing-history lookup.
    pub issuer_missing: BTreeMap<String, BTreeSet<String>>,
    /// Records appended to this state, in append order. Per state: a
    /// sibling's appends never appear here.
    pub appended_ids: Vec<String>,
    /// Fresh-layout rank of each appended record: the layout position
    /// it is inserted before (always the end of its issuer block, the
    /// only place the fast path appends), and its order among appended
    /// records inserted at that same position.
    pub appended_rank: BTreeMap<String, (u32, u32)>,
    pub budget: Cell<usize>,
    pub resource: Cell<bool>,
    pub appended: usize,
}
impl Graph {
    pub fn new(nodes: impl Into<Rc<BTreeMap<String, Node>>>, limits: &Limits) -> Self {
        let nodes = nodes.into();
        #[cfg(test)]
        CONSTRUCTIONS.with(|count| count.set(count.get() + 1));
        // The layout scan costs one unit per record and per predecessor
        // edge. Charge it before the scan runs, so a tiny budget refuses
        // before any layout allocation.
        let layout_work = nodes.len() + nodes.values().map(|n| n.previous.len()).sum::<usize>();
        let mut graph = Self {
            nodes,
            space: super::ancestors::Space::empty(),
            ancestry: super::ancestors::AncestryBudget::new(),
            boundary: BoundaryCrossings::default(),
            issuer_complete: BTreeMap::new(),
            rank_index: std::cell::RefCell::new(None),
            account_sets: BTreeMap::new(),
            issuer_missing: BTreeMap::new(),
            appended_ids: Vec::new(),
            appended_rank: BTreeMap::new(),
            own: Rc::default(),
            structural: Rc::default(),
            accepted: Rc::default(),
            lifecycle: Lifecycle {
                key_actor: BTreeMap::new(),
                groups: BTreeMap::new(),
                successor: BTreeMap::new(),
                suspended: BTreeMap::new(),
                retired: BTreeSet::new(),
                compromised: BTreeSet::new(),
            },
            cutoffs: BTreeMap::new(),
            transfers: BTreeMap::new(),
            pending_cutoffs: BTreeSet::new(),
            budget: Cell::new(limits.traversal),
            resource: Cell::new(false),
            appended: 0,
        };
        if !graph.charge(layout_work) {
            return graph;
        }
        graph.space = super::ancestors::Space::new(&graph.nodes);
        let before = graph.budget.get();
        graph.own = Rc::new(graph.build_cache(0));
        if graph.resource.get() || graph.ancestry.failed() {
            graph.resource.set(true);
            return graph;
        }
        let own_work = before - graph.budget.get();
        let same_links = !graph
            .nodes
            .values()
            .any(|n| n.semantic && n.kind == "identity.accept");
        if same_links {
            // The three link modes are identical without acceptance events.
            // Charge the original work even when their storage is shared.
            if graph.charge(own_work) {
                graph.structural = graph.own.clone();
            }
        } else {
            graph.structural = Rc::new(graph.build_cache(1));
        }
        if graph.resource.get() {
            return graph;
        }
        if graph.ancestry.failed() {
            graph.resource.set(true);
            return graph;
        }
        graph.build_lifecycle();
        if graph.resource.get() || graph.ancestry.failed() {
            graph.resource.set(true);
            return graph;
        }
        if same_links {
            if graph.charge(own_work) {
                graph.accepted = graph.own.clone();
            }
        } else {
            graph.accepted = Rc::new(graph.build_cache(2));
        }
        if graph.ancestry.failed() {
            graph.resource.set(true);
        }
        graph.boundary = BoundaryCrossings::with_len(graph.space.len());
        let mut seen: Vec<usize> = Vec::new();
        for cache in [&graph.own, &graph.structural, &graph.accepted] {
            let pointer = Rc::as_ptr(cache) as usize;
            if seen.contains(&pointer) {
                continue;
            }
            seen.push(pointer);
            for closure in cache.values() {
                for (first, last) in closure.ids.ranges() {
                    graph.boundary.extend_range(first, last);
                }
            }
        }
        graph
    }

    /// Stored closures whose ranges cross the given insertion
    /// coordinate, across every distinct cache.
    pub fn boundary_crossing(&self, coordinate: u32) -> i64 {
        self.boundary.crossing(coordinate)
    }
    fn empty_closure(&self) -> Closure {
        Closure {
            ids: IdSet::empty(self.space.clone()),
            missing: BTreeSet::new(),
            invalid: false,
            resource: false,
        }
    }
    pub(crate) fn charge(&self, amount: usize) -> bool {
        if amount > self.budget.get() {
            self.resource.set(true);
            self.budget.set(0);
            false
        } else {
            self.budget.set(self.budget.get() - amount);
            true
        }
    }
    fn dependencies(&self, node: &Node, mode: u8) -> (Vec<String>, BTreeSet<String>, bool) {
        let mut ids = Vec::new();
        let mut missing = BTreeSet::new();
        let mut invalid = false;
        for id in &node.previous {
            match self.nodes.get(id) {
                None => {
                    missing.insert(id.clone());
                }
                Some(p) if p.issuer != node.issuer => invalid = true,
                Some(_) => ids.push(id.clone()),
            }
        }
        if mode > 0 && node.semantic && node.kind == "identity.accept" {
            let transfer = node.action.view().index("transfer");
            let transfer = transfer.as_str().unwrap_or_default();
            match self.nodes.get(transfer) {
                None => {
                    missing.insert(transfer.into());
                }
                Some(t)
                    if t.semantic
                        && t.kind == "identity.transfer"
                        && t.action.view().index("successor").as_str() == Some(&node.issuer) =>
                {
                    if mode == 1 || self.lifecycle.successor.get(&t.issuer) == Some(&node.issuer) {
                        ids.push(transfer.into());
                    }
                }
                _ => invalid = true,
            }
        }
        (ids, missing, invalid)
    }
    /// Topological range unions keep ordinary linear histories compact.
    /// Charges are logical: one unit per record, per dependency edge, and
    /// per missing ID propagated, in every representation.
    fn build_cache(&self, mode: u8) -> BTreeMap<String, Closure> {
        let mut dependencies = BTreeMap::new();
        let mut children: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let mut waiting = BTreeMap::new();
        let mut ready = BTreeSet::new();
        for (id, node) in self.nodes.as_ref() {
            let (deps, missing, invalid) = self.dependencies(node, mode);
            if !self.charge(1 + deps.len() + missing.len()) {
                return BTreeMap::new();
            }
            for dep in &deps {
                children.entry(dep.clone()).or_default().push(id.clone());
            }
            waiting.insert(id.clone(), deps.len());
            if deps.is_empty() {
                ready.insert(id.clone());
            }
            dependencies.insert(id.clone(), (deps, missing, invalid));
        }
        let mut cache: BTreeMap<String, Closure> = BTreeMap::new();
        while let Some(id) = ready.pop_first() {
            let (deps, missing, invalid) = &dependencies[&id];
            let mut work = 1 + missing.len();
            for dep in deps {
                work += 1 + cache[dep].missing.len() + cache[dep].ids.range_count();
            }
            if !self.charge(work) {
                return cache;
            }
            let sets: Vec<&IdSet> = deps.iter().map(|dep| &cache[dep].ids).collect();
            let mut c = Closure {
                ids: IdSet::combined(self.space.clone(), &self.ancestry, &sets, Some(&id)),
                missing: missing.clone(),
                invalid: *invalid,
                resource: false,
            };
            for dep in deps {
                let p = &cache[dep];
                c.missing.extend(p.missing.iter().cloned());
                c.invalid |= p.invalid;
                c.resource |= p.resource;
            }
            if self.ancestry.failed() {
                c.resource = true;
            }
            cache.insert(id.clone(), c);
            for child in children.get(&id).into_iter().flatten() {
                let count = waiting.get_mut(child).unwrap();
                *count -= 1;
                if *count == 0 {
                    ready.insert(child.clone());
                }
            }
        }
        // Remaining nodes reach a cycle. No recursive traversal is required.
        for id in self
            .nodes
            .keys()
            .filter(|id| !cache.contains_key(*id))
            .cloned()
            .collect::<Vec<_>>()
        {
            let mut c = self.empty_closure();
            if !self.charge(1) {
                return cache;
            }
            c.ids.insert(&self.ancestry, &id);
            c.invalid = true;
            if self.ancestry.failed() {
                c.resource = true;
            }
            cache.insert(id, c);
        }
        cache
    }
    /// Carry traverses immutable signed links through the same structural cache.
    pub fn closure(&self, heads: &[String], mode: u8) -> Closure {
        let cache = match mode {
            0 => &self.own,
            1 => &self.structural,
            _ => &self.accepted,
        };
        let mut result = self.empty_closure();
        for id in heads {
            let Some(c) = cache.get(id) else {
                if !self.charge(1) {
                    result.resource = true;
                    break;
                }
                result.missing.insert(id.clone());
                continue;
            };
            if !self.charge(1 + c.missing.len() + c.ids.fresh_ranges) {
                result.resource = true;
                break;
            }
            result.ids.union(&self.ancestry, &c.ids);
            result.ids.fresh_ranges = self.fresh_range_count(&result.ids);
            if self.ancestry.failed() {
                result.resource = true;
                self.resource.set(true);
                break;
            }
            result.missing.extend(c.missing.iter().cloned());
            result.invalid |= c.invalid;
            result.resource |= c.resource;
        }
        result
    }
    fn build_lifecycle(&mut self) {
        // One charged pass over every record: semantic processing,
        // plus an index of each issuer's root records. The transfer
        // loop below looks a successor's roots up in this index
        // instead of scanning all records for every transfer.
        let mut roots: BTreeMap<&str, Vec<&Node>> = BTreeMap::new();
        for node in self.nodes.values() {
            if !self.charge(1) {
                return;
            }
            #[cfg(test)]
            LIFECYCLE_VISITS.with(|count| count.set(count.get() + 1));
            if node.previous.is_empty() {
                roots.entry(node.issuer.as_str()).or_default().push(node);
            }
            if !node.semantic {
                continue;
            }
            if node.kind == "identity.transfer" && self.own_complete(&node.id) {
                self.transfers
                    .entry(node.issuer.clone())
                    .or_default()
                    .push(node.id.clone());
            }
            if node.kind == "identity.compromise" {
                let mut cutoff = self.empty_closure();
                let safe: Vec<_> = node
                    .action
                    .view()
                    .index("safe")
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect();
                let mut invalid = false;
                for id in &safe {
                    match self.nodes.get(id) {
                        Some(n) if n.issuer != node.issuer => invalid = true,
                        Some(_) if !self.own[&node.id].ids.contains(id) || id == &node.id => {
                            invalid = true
                        }
                        _ => {}
                    }
                }
                if invalid {
                    continue;
                }
                for id in safe {
                    let c = self.closure(&[id], 0);
                    if c.resource || !self.charge(1 + c.missing.len()) {
                        return;
                    }
                    if !self.charge(1 + c.ids.fresh_ranges) {
                        return;
                    }
                    cutoff.ids.extend(&self.ancestry, c.ids);
                    cutoff.ids.fresh_ranges = self.fresh_range_count(&cutoff.ids);
                    if self.ancestry.failed() {
                        cutoff.resource = true;
                    }
                    cutoff.missing.extend(c.missing);
                    cutoff.invalid |= c.invalid;
                    cutoff.resource |= c.resource;
                }
                if !self.own_complete(&node.id) {
                    if !self.charge(self.own[&node.id].missing.len()) {
                        return;
                    }
                    cutoff
                        .missing
                        .extend(self.own[&node.id].missing.iter().cloned());
                    cutoff.invalid |= self.own[&node.id].invalid;
                }
                self.lifecycle.compromised.insert(node.issuer.clone());
                if !cutoff.complete() {
                    self.pending_cutoffs.insert(node.issuer.clone());
                }
                self.cutoffs
                    .entry(node.issuer.clone())
                    .or_default()
                    .push(cutoff);
            }
        }
        self.lifecycle
            .retired
            .extend(self.transfers.keys().cloned());
        for (key, transfers) in &self.transfers {
            if !self.charge(1) {
                return;
            }
            if transfers.len() != 1 || self.lifecycle.compromised.contains(key) {
                continue;
            }
            let transfer = &self.nodes[&transfers[0]];
            let successor = transfer.action.view().index("successor");
            let successor = successor.as_str().unwrap_or_default();
            #[cfg(test)]
            LIFECYCLE_VISITS.with(|count| count.set(count.get() + 1));
            let first: &[&Node] = roots.get(successor).map(Vec::as_slice).unwrap_or_default();
            if first.len() != 1 {
                continue;
            }
            let acceptance = first[0];
            if acceptance.semantic
                && acceptance.kind == "identity.accept"
                && acceptance.action.view().index("transfer").as_str() == Some(&transfer.id)
                && self.own_complete(&acceptance.id)
                && key != successor
            {
                self.lifecycle
                    .successor
                    .insert(key.clone(), successor.into());
            }
        }
        // Remove every cycle and any path that enters one. Each
        // record's verdict (its path enters a cycle or not) is
        // computed once and reused, so the walks stay linear in the
        // number of successor links.
        let edges = self.lifecycle.successor.clone();
        let mut enters_cycle: BTreeMap<&str, bool> = BTreeMap::new();
        for key in edges.keys() {
            let mut path: Vec<&str> = Vec::new();
            let mut on_path: BTreeSet<&str> = BTreeSet::new();
            let mut at = key.as_str();
            let result = loop {
                if let Some(&known) = enters_cycle.get(at) {
                    break known;
                }
                if on_path.contains(at) {
                    break true;
                }
                let Some(next) = edges.get(at) else {
                    break false;
                };
                path.push(at);
                on_path.insert(at);
                #[cfg(test)]
                count_work(1);
                at = next.as_str();
            };
            for item in path {
                enters_cycle.insert(item, result);
                if result {
                    self.lifecycle.successor.remove(item);
                }
            }
        }
        let keys: BTreeSet<_> = self.nodes.values().map(|n| n.issuer.clone()).collect();
        // The predecessor of a key is the smallest issuer whose
        // successor it is (map order, as a scan would find first).
        // Resolved actors are memoized, so resolving every key stays
        // linear in the number of successor links.
        let mut predecessor: BTreeMap<&str, &str> = BTreeMap::new();
        for (key, successor) in &self.lifecycle.successor {
            predecessor
                .entry(successor.as_str())
                .or_insert(key.as_str());
        }
        let mut resolved: BTreeMap<&str, &str> = BTreeMap::new();
        for key in &keys {
            let mut path: Vec<&str> = Vec::new();
            let mut on_path: BTreeSet<&str> = BTreeSet::new();
            let mut at = key.as_str();
            let actor = loop {
                if let Some(&done) = resolved.get(at) {
                    break done;
                }
                if on_path.contains(at) {
                    break at;
                }
                match predecessor.get(at) {
                    Some(parent) => {
                        path.push(at);
                        on_path.insert(at);
                        #[cfg(test)]
                        count_work(1);
                        at = parent;
                    }
                    None => break at,
                }
            };
            for item in path {
                resolved.insert(item, actor);
            }
            resolved.insert(key.as_str(), actor);
            self.lifecycle
                .key_actor
                .insert(key.clone(), actor.to_string());
            self.lifecycle
                .groups
                .entry(actor.to_string())
                .or_default()
                .insert(key.clone());
        }
        // Per-issuer completeness for `local_complete`, in one pass
        // over the records instead of one scan per claim.
        for (id, node) in self.nodes.as_ref() {
            let complete =
                if self.lifecycle.successor.contains_key(&node.issuer) && !self.retained(id) {
                    true
                } else {
                    self.own_complete(id)
                };
            *self
                .issuer_complete
                .entry(node.issuer.clone())
                .or_insert(true) &= complete;
            if node.semantic && node.kind == "account.set" {
                if let (Some(origin), Some(account)) = (
                    node.action.view().index("origin").as_str(),
                    node.action.view().index("account").as_u64(),
                ) {
                    self.account_sets
                        .entry(format!("{origin}#{account}"))
                        .or_default()
                        .push(id.clone());
                }
            }
            if !self.lifecycle.successor.contains_key(&node.issuer) || self.retained(id) {
                self.issuer_missing
                    .entry(node.issuer.clone())
                    .or_default()
                    .extend(self.own[id].missing.iter().cloned());
            }
        }
        for (id, node) in self.nodes.as_ref() {
            if !self.own_complete(id) || self.pending_cutoffs.contains(&node.issuer) {
                self.lifecycle
                    .suspended
                    .entry(self.actor(&node.issuer))
                    .or_default()
                    .insert(id.clone());
            }
        }
    }
    /// Range count of a set in a fresh layout. Positioned records keep
    /// their relative order, and appended records sit at their
    /// block-end ranks in append order, which is a fresh build's order
    /// for the appends the fast path admits. The count is the stored range count, minus one for each
    /// stored range whose first member's fresh predecessor is an
    /// appended member of the set, plus one for each appended member
    /// whose fresh predecessor is not itself a member.
    pub fn fresh_range_count(&self, set: &IdSet) -> usize {
        if set.extra.is_empty() {
            return set.range_count();
        }
        // Index appended records by rank once per state: by full
        // rank for predecessor lookups, and the last one at each
        // insertion position. The index is rebuilt only when the
        // appended-record count changes, not per merge.
        let mut cache = self.rank_index.borrow_mut();
        if cache.as_ref().map(|(len, _, _)| *len) != Some(self.appended_rank.len()) {
            #[cfg(test)]
            count_work(self.appended_rank.len());
            let mut by_rank: BTreeMap<(u32, String, u32), String> = BTreeMap::new();
            let mut last_at: BTreeMap<u32, String> = BTreeMap::new();
            for (id, &(position, sub)) in &self.appended_rank {
                let issuer = self.nodes[id].issuer.clone();
                by_rank.insert((position, issuer.clone(), sub), id.clone());
                let replace = match last_at.get(&position) {
                    None => true,
                    Some(current) => {
                        let current_issuer = &self.nodes[current.as_str()].issuer;
                        (issuer.as_str(), sub)
                            > (current_issuer.as_str(), self.appended_rank[current].1)
                    }
                };
                if replace {
                    last_at.insert(position, id.clone());
                }
            }
            *cache = Some((self.appended_rank.len(), by_rank, last_at));
        }
        let (_, by_rank, last_at) = cache.as_ref().unwrap();
        #[cfg(test)]
        count_work(set.range_count() + set.extra.len());
        Self::fresh_count(
            &self.space,
            &self.appended_rank,
            by_rank,
            last_at,
            &self.nodes,
            set,
        )
    }

    fn fresh_count(
        space: &super::ancestors::Space,
        appended_rank: &BTreeMap<String, (u32, u32)>,
        by_rank: &BTreeMap<(u32, String, u32), String>,
        last_at: &BTreeMap<u32, String>,
        nodes: &BTreeMap<String, Node>,
        set: &IdSet,
    ) -> usize {
        let mut count = set.range_count();
        // A stored range does not start a fresh run when the appended
        // record inserted right before its first member is a member.
        for start in set.range_starts() {
            if start == 0 {
                continue;
            }
            if let Some(id) = last_at.get(&start) {
                if set.contains(id) {
                    count -= 1;
                }
            }
        }
        for id in &set.extra {
            let Some(&(position, sub)) = appended_rank.get(id) else {
                count += 1;
                continue;
            };
            let issuer = &nodes[id].issuer;
            let predecessor: Option<String> = if sub > 0 {
                by_rank
                    .get(&(position, issuer.clone(), sub - 1))
                    .map(|prior| (*prior).clone())
            } else {
                by_rank
                    .range(..(position, issuer.clone(), 0))
                    .next_back()
                    .filter(|((at, _, _), _)| *at == position)
                    .map(|(_, prior)| (*prior).clone())
                    .or_else(|| (position > 0).then(|| space.id_at(position - 1)))
            };
            if predecessor.is_none_or(|prior| !set.contains(&prior)) {
                count += 1;
            }
        }
        count
    }

    /// Position bounds of one issuer's block in the layout, if any of
    /// its records are positioned.
    pub fn issuer_block(&self, issuer: &str) -> Option<(u32, u32)> {
        self.space.block(issuer)
    }

    /// First layout position of any issuer block after the given one.
    pub fn next_block_start(&self, issuer: &str) -> u32 {
        self.space.next_block_start(issuer)
    }

    pub fn actor(&self, key: &str) -> String {
        self.lifecycle
            .key_actor
            .get(key)
            .cloned()
            .unwrap_or_else(|| key.into())
    }
    /// Append a complete ordinary event without changing any existing links.
    /// Appended IDs never enter the shared layout. They get a rank at
    /// the end of their issuer block in this state's own rank map.
    pub fn append_ordinary(&mut self, node: Node) {
        // Unions first, then the record itself: the same combine order
        // a full build uses for this record, so cap charges match.
        let closure = |cache: &BTreeMap<String, Closure>| {
            let mut result = self.empty_closure();
            for previous in &node.previous {
                let prior = &cache[previous];
                result.ids.union(&self.ancestry, &prior.ids);
                result.ids.fresh_ranges = self.fresh_range_count(&result.ids);
                result.missing.extend(prior.missing.iter().cloned());
                result.invalid |= prior.invalid;
                result.resource |= prior.resource;
            }
            result.ids.insert(&self.ancestry, &node.id);
            if self.ancestry.failed() {
                result.resource = true;
            }
            result
        };
        let own = closure(&self.own);
        let own_missing = own.missing.clone();
        let shared =
            Rc::ptr_eq(&self.own, &self.structural) && Rc::ptr_eq(&self.own, &self.accepted);
        let mut own = own;
        let mut others: Vec<Closure> = Vec::new();
        if !shared {
            others.push(closure(&self.structural));
            others.push(closure(&self.accepted));
        }
        self.lifecycle
            .key_actor
            .entry(node.issuer.clone())
            .or_insert_with(|| node.issuer.clone());
        self.lifecycle
            .groups
            .entry(node.issuer.clone())
            .or_default()
            .insert(node.issuer.clone());
        if self.ancestry.failed() {
            self.resource.set(true);
            // No closure stored for this record may read as complete.
            own.resource = true;
            for closure in &mut others {
                closure.resource = true;
            }
        }
        // Register the record before counting fresh-layout ranges.
        // Appends only happen at the end of the issuer block (the
        // fast path requires the parents to cover the whole block),
        // so the rank is that block-end position and the count of
        // this issuer's records already appended there.
        let position = match self.issuer_block(&node.issuer) {
            Some((_, last)) => last + 1,
            None => self.next_block_start(&node.issuer),
        };
        let sub = self
            .appended_rank
            .iter()
            .filter(|(id, rank)| {
                rank.0 == position && self.nodes[id.as_str()].issuer == node.issuer
            })
            .count() as u32;
        self.appended_rank.insert(node.id.clone(), (position, sub));
        self.appended_ids.push(node.id.clone());
        Rc::make_mut(&mut self.nodes).insert(node.id.clone(), node.clone());
        own.ids.fresh_ranges = self.fresh_range_count(&own.ids);
        for closure in &mut others {
            closure.ids.fresh_ranges = self.fresh_range_count(&closure.ids);
        }
        // Insert without splitting a shared cache afterwards: mutating
        // a cache that its siblings still point at would copy it and
        // silently unshare the three modes.
        let mut new_ranges: Vec<(u32, u32)> = own.ids.ranges().collect();
        for closure in &others {
            new_ranges.extend(closure.ids.ranges());
        }
        Rc::make_mut(&mut self.own).insert(node.id.clone(), own);
        if shared {
            self.structural = self.own.clone();
            self.accepted = self.own.clone();
        } else {
            let mut others = others.into_iter();
            Rc::make_mut(&mut self.structural).insert(node.id.clone(), others.next().unwrap());
            Rc::make_mut(&mut self.accepted).insert(node.id.clone(), others.next().unwrap());
        }
        for (first, last) in new_ranges {
            self.boundary.extend_range(first, last);
        }
        let complete =
            if self.lifecycle.successor.contains_key(&node.issuer) && !self.retained(&node.id) {
                true
            } else {
                self.own_complete(&node.id)
            };
        *self
            .issuer_complete
            .entry(node.issuer.clone())
            .or_insert(true) &= complete;
        if node.semantic && node.kind == "account.set" {
            if let (Some(origin), Some(account)) = (
                node.action.view().index("origin").as_str(),
                node.action.view().index("account").as_u64(),
            ) {
                self.account_sets
                    .entry(format!("{origin}#{account}"))
                    .or_default()
                    .push(node.id.clone());
            }
        }
        if !self.lifecycle.successor.contains_key(&node.issuer) || self.retained(&node.id) {
            self.issuer_missing
                .entry(node.issuer.clone())
                .or_default()
                .extend(own_missing.iter().cloned());
        }
        self.appended += 1;
    }
    pub fn own_complete(&self, id: &str) -> bool {
        self.own.get(id).is_some_and(Closure::complete)
    }
    pub fn suspended(&self, key: &str) -> bool {
        self.lifecycle.suspended.contains_key(&self.actor(key))
    }
    pub fn excluded_by_resolved(&self, id: &str) -> bool {
        let Some(node) = self.nodes.get(id) else {
            return false;
        };
        self.transfers.get(&node.issuer).is_some_and(|transfers| {
            transfers.iter().any(|transfer| {
                let history = &self.own[transfer];
                history.complete() && (transfer == id || !history.ids.contains(id))
            })
        }) || self.cutoffs.get(&node.issuer).is_some_and(|cutoffs| {
            cutoffs
                .iter()
                .any(|cutoff| cutoff.complete() && !cutoff.ids.contains(id))
        })
    }
    pub fn retained(&self, id: &str) -> bool {
        let Some(node) = self.nodes.get(id) else {
            return false;
        };
        if self.pending_cutoffs.contains(&node.issuer) {
            return false;
        }
        if let Some(transfers) = self.transfers.get(&node.issuer) {
            if transfers
                .iter()
                .any(|t| t == id || !self.own[t].ids.contains(id))
            {
                return false;
            }
        }
        if let Some(cutoffs) = self.cutoffs.get(&node.issuer) {
            if cutoffs.iter().any(|c| !c.complete() || !c.ids.contains(id)) {
                return false;
            }
        }
        true
    }
    pub fn follows(&self, later: &str, earlier: &str, structural: bool) -> bool {
        later != earlier
            && if structural {
                self.structural.get(later)
            } else {
                self.accepted.get(later)
            }
            .is_some_and(|c| c.ids.contains(earlier))
    }
    /// The members of `ids` that no other member follows. A member
    /// is not a maximum exactly when another member's closure
    /// contains it. Members are grouped by closure size: a member
    /// contained in another of the same size has an identical
    /// closure (closures are transitive), so same-size elimination
    /// is an identical-closure test, and larger closures are merged
    /// into one accumulated union that smaller members are tested
    /// against. The work is linear in the stored ranges examined,
    /// not in the square of the member count.
    pub fn maxima(&self, ids: BTreeSet<String>, structural: bool) -> BTreeSet<String> {
        let result = self.maxima_with(&ids, structural, &self.ancestry);
        if self.ancestry.failed() {
            self.resource.set(true);
        }
        result
    }

    fn maxima_with(
        &self,
        ids: &BTreeSet<String>,
        structural: bool,
        budget: &super::ancestors::AncestryBudget,
    ) -> BTreeSet<String> {
        let cache = if structural {
            &self.structural
        } else {
            &self.accepted
        };
        let mut unknown: BTreeSet<String> = BTreeSet::new();
        let mut groups: BTreeMap<usize, Vec<(&String, &Closure)>> = BTreeMap::new();
        for id in ids {
            match cache.get(id) {
                Some(closure) => groups
                    .entry(closure.ids.member_count())
                    .or_default()
                    .push((id, closure)),
                None => {
                    unknown.insert(id.clone());
                }
            }
        }
        let mut result = unknown;
        let mut larger = IdSet::empty(self.space.clone());
        for (_, members) in groups.iter().rev() {
            // Same-size members eliminate each other only through
            // identical closures, which eliminate every member that
            // shares them.
            type Signature<'a> = (Vec<(u32, u32)>, &'a BTreeSet<String>);
            let mut signatures: BTreeMap<Signature<'_>, usize> = BTreeMap::new();
            for (_, closure) in members {
                *signatures
                    .entry((closure.ids.ranges().collect(), &closure.ids.extra))
                    .or_insert(0) += 1;
            }
            for (id, closure) in members {
                let signature = (
                    closure.ids.ranges().collect::<Vec<(u32, u32)>>(),
                    &closure.ids.extra,
                );
                if signatures[&signature] < 2 && !larger.contains(id) {
                    result.insert((*id).clone());
                }
            }
            for (_, closure) in members {
                #[cfg(test)]
                {
                    let examined = larger.range_count() + closure.ids.range_count();
                    MAXIMA_RANGE_VISITS.with(|count| count.set(count.get() + examined));
                    count_work(examined);
                }
                // A member already inside the accumulator changes
                // nothing: skip its merge (and its charge) instead
                // of recounting an unchanged accumulator.
                if closure.ids.subset_of(&larger) {
                    continue;
                }
                larger.union(budget, &closure.ids);
                // The accumulator's charge for the next merge must
                // use fresh-layout range counts, as in
                // `append_ordinary` and `closure`: appended members
                // live in `extra` with no stored ranges, but a fresh
                // layout gives them ranges.
                larger.fresh_ranges = self.fresh_range_count(&larger);
            }
        }
        result
    }
    pub fn structurally_connected(&self, root: &str, issuer: &str, event: &str) -> bool {
        if root == issuer {
            return true;
        }
        // The root issuer's records occupy one contiguous block, so
        // the closure is connected to it exactly when a stored range
        // overlaps that block or an appended member belongs to it.
        self.structural.get(event).is_some_and(|c| {
            self.space
                .block(root)
                .is_some_and(|(first, last)| c.ids.intersects_positions(first, last))
                || c.ids
                    .extra
                    .iter()
                    .any(|id| self.nodes[id.as_str()].issuer == root)
        })
    }
    pub fn downstream(&self, root: &str) -> BTreeSet<String> {
        // One temporary set per call, as on main. A retained memo
        // would hold one suffix per issuer (quadratic memory on a
        // successor chain), which this PR must not add.
        let mut keys = BTreeSet::new();
        let mut at = root;
        while keys.insert(at.into()) {
            match self.lifecycle.successor.get(at) {
                Some(next) => at = next,
                None => break,
            }
        }
        #[cfg(test)]
        count_work(keys.len());
        keys
    }
    pub fn local_complete(&self, root: &str, _claim: &str) -> bool {
        let keys = self.downstream(root);
        !keys.iter().any(|key| self.pending_cutoffs.contains(key))
            && keys
                .iter()
                .all(|key| self.issuer_complete.get(key).copied().unwrap_or(true))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn node(id: &str, issuer: &str, previous: &[&str], kind: &str) -> Node {
        Node {
            id: id.into(),
            issuer: issuer.into(),
            previous: previous.iter().map(|s| s.to_string()).collect(),
            action: CompactValue::from(&json!({"kind": kind})),
            kind: kind.into(),
            semantic: true,
            body_hash: None,
            body: None,
            body_label: "absent".into(),
        }
    }

    fn nodes(count: usize, linear: bool) -> BTreeMap<String, Node> {
        (0..count)
            .map(|i| {
                let id = format!("jve1:{i:064x}");
                (
                    id.clone(),
                    Node {
                        id,
                        issuer: "issuer".into(),
                        previous: if linear && i > 0 {
                            vec![format!("jve1:{:064x}", i - 1)]
                        } else {
                            Vec::new()
                        },
                        action: CompactValue::from(&json!({"kind":"identity.merge"})),
                        kind: "identity.merge".into(),
                        semantic: true,
                        body_hash: None,
                        body: None,
                        body_label: "absent".into(),
                    },
                )
            })
            .collect()
    }

    /// Many independent transfers to an absent successor: the
    /// lifecycle pass indexes each issuer's roots once, so the
    /// records it visits grow linearly, not with the square of the
    /// record count. A per-transfer scan of all records would visit
    /// about `count * count` records here.
    #[test]
    fn many_independent_transfers_use_indexed_successor_lookup() {
        let count = 2_000usize;
        let nodes: BTreeMap<String, Node> = (0..count)
            .map(|i| {
                let id = format!("jve1:{i:064x}");
                (
                    id.clone(),
                    Node {
                        id,
                        issuer: format!("issuer{i:05}"),
                        previous: Vec::new(),
                        action: CompactValue::from(
                            &json!({"kind":"identity.transfer","successor":"ed25519:absent"}),
                        ),
                        kind: "identity.transfer".into(),
                        semantic: true,
                        body_hash: None,
                        body: None,
                        body_label: "absent".into(),
                    },
                )
            })
            .collect();
        let before = lifecycle_visits();
        let graph = Graph::new(nodes, &Limits::default());
        assert!(!graph.resource.get());
        assert!(graph.lifecycle.successor.is_empty());
        let visits = lifecycle_visits() - before;
        assert!(
            visits <= 3 * count,
            "{visits} lifecycle visits for {count} records"
        );
    }

    /// Many root judgments by one issuer on one target form one
    /// register group of unrelated heads. Maxima must stay linear
    /// in the stored ranges examined, not quadratic in the group.
    #[test]
    fn flat_register_maxima_examine_linear_ranges() {
        let count = 4_000usize;
        let mut nodes = nodes(count, false);
        for node in nodes.values_mut() {
            node.action = CompactValue::from(
                &json!({"kind":"judgment.set","target":"jve1:target","value":"bless"}),
            );
            node.kind = "judgment.set".into();
        }
        let graph = Graph::new(nodes, &Limits::default());
        assert!(!graph.resource.get());
        reset_maxima_range_visits();
        let ids: BTreeSet<String> = graph.nodes.keys().cloned().collect();
        let heads = graph.maxima(ids, false);
        assert_eq!(heads.len(), count);
        let visits = maxima_range_visits();
        assert!(
            visits <= 4 * count,
            "{visits} range visits for {count} flat heads"
        );
    }

    /// A successor chain in ascending key order: each issuer
    /// transfers to the next, whose only root accepts. Lifecycle
    /// indexing and walks must visit a linear number of records and
    /// links, in both walk directions.
    #[test]
    fn successor_chain_lifecycle_visits_stay_linear() {
        for links in [500usize, 1_000] {
            let mut nodes: BTreeMap<String, Node> = BTreeMap::new();
            let insert = |nodes: &mut BTreeMap<String, Node>,
                          i: usize,
                          issuer: &str,
                          previous: Vec<String>,
                          action: Value,
                          kind: &str| {
                let id = format!("jve1:{i:064x}");
                nodes.insert(
                    id.clone(),
                    Node {
                        id,
                        issuer: issuer.into(),
                        previous,
                        action: action.into(),
                        kind: kind.into(),
                        semantic: true,
                        body_hash: None,
                        body: None,
                        body_label: "absent".into(),
                    },
                );
            };
            for i in 0..links {
                let issuer = format!("ed25519:{i:064x}");
                let next = format!("ed25519:{:064x}", i + 1);
                if i == 0 {
                    insert(
                        &mut nodes,
                        2 * i,
                        &issuer,
                        vec![],
                        json!({"kind":"identity.transfer","successor":next}),
                        "identity.transfer",
                    );
                } else {
                    let accept_id = format!("jve1:{:064x}", 2 * i - 1);
                    insert(
                        &mut nodes,
                        2 * i,
                        &issuer,
                        vec![accept_id],
                        json!({"kind":"identity.transfer","successor":next}),
                        "identity.transfer",
                    );
                }
                let accept_at = 2 * i + 1;
                insert(
                    &mut nodes,
                    accept_at,
                    &next,
                    vec![],
                    json!({"kind":"identity.accept","transfer":format!("jve1:{:064x}", 2 * i)}),
                    "identity.accept",
                );
            }
            let records = nodes.len();
            let before_visits = lifecycle_visits();
            let before_work = audit_work();
            let graph = Graph::new(nodes, &Limits::default());
            assert!(!graph.resource.get());
            assert_eq!(graph.lifecycle.successor.len(), links);
            let visits = lifecycle_visits() - before_visits + (audit_work() - before_work);
            assert!(
                visits <= 8 * records,
                "{visits} lifecycle visits for {records} records"
            );
        }
    }

    /// Downstream sets are built per call and retained nowhere:
    /// calling it for every issuer of a successor chain does
    /// exactly the work main does (the sum of the suffix lengths)
    /// and keeps no cache behind.
    #[test]
    fn downstream_work_matches_main_without_retention() {
        let links = 200usize;
        let mut nodes: BTreeMap<String, Node> = BTreeMap::new();
        let insert = |nodes: &mut BTreeMap<String, Node>,
                      i: usize,
                      issuer: &str,
                      previous: Vec<String>,
                      action: Value,
                      kind: &str| {
            let id = format!("jve1:{i:064x}");
            nodes.insert(
                id.clone(),
                Node {
                    id,
                    issuer: issuer.into(),
                    previous,
                    action: action.into(),
                    kind: kind.into(),
                    semantic: true,
                    body_hash: None,
                    body: None,
                    body_label: "absent".into(),
                },
            );
        };
        for i in 0..links {
            let issuer = format!("ed25519:{i:064x}");
            let next = format!("ed25519:{:064x}", i + 1);
            if i == 0 {
                insert(
                    &mut nodes,
                    0,
                    &issuer,
                    vec![],
                    json!({"kind":"identity.transfer","successor":next}),
                    "identity.transfer",
                );
            } else {
                insert(
                    &mut nodes,
                    2 * i,
                    &issuer,
                    vec![format!("jve1:{:064x}", 2 * i - 1)],
                    json!({"kind":"identity.transfer","successor":next}),
                    "identity.transfer",
                );
            }
            insert(
                &mut nodes,
                2 * i + 1,
                &next,
                vec![],
                json!({"kind":"identity.accept","transfer":format!("jve1:{:064x}", 2 * i)}),
                "identity.accept",
            );
        }
        let graph = Graph::new(nodes, &Limits::default());
        assert!(!graph.resource.get());
        reset_audit_work();
        let mut expected = 0usize;
        for i in 0..links {
            let issuer = format!("ed25519:{i:064x}");
            let keys = graph.downstream(&issuer);
            assert_eq!(keys.len(), links + 1 - i);
            expected += keys.len();
        }
        // Exactly main's per-call work: every suffix built once,
        // nothing retained between calls.
        assert_eq!(audit_work(), expected);
        assert_eq!(expected, (links + 1) * (links + 2) / 2 - 1);
    }

    /// The unions `maxima` merges are charged to the same ancestry
    /// cap as every other range allocation: the counted bytes never
    /// pass the cap, and a shape whose merges would pass it fails
    /// as a resource failure instead.
    #[test]
    fn maxima_unions_charge_the_ancestry_cap() {
        let build = |count: usize| {
            let nodes: BTreeMap<String, Node> = (0..count)
                .map(|i| {
                    let id = format!("jve1:{i:064x}");
                    (
                        id.clone(),
                        Node {
                            id,
                            issuer: "issuer".into(),
                            previous: Vec::new(),
                            action: CompactValue::from(&json!({"kind":"identity.merge"})),
                            kind: "identity.merge".into(),
                            semantic: true,
                            body_hash: None,
                            body: None,
                            body_label: "absent".into(),
                        },
                    )
                })
                .collect();
            Graph::new(nodes, &Limits::default())
        };
        // Every second record: the accumulated union fragments into
        // thousands of ranges, and each merge is charged.
        let graph = build(6_000);
        let before = graph.ancestry.bytes();
        let ids: BTreeSet<String> = graph.nodes.keys().step_by(2).cloned().collect();
        let heads = graph.maxima(ids, false);
        assert_eq!(heads.len(), 3_000);
        assert!(graph.ancestry.bytes() > before);
        assert!(graph.ancestry.bytes() <= super::ancestors::MAX_ANCESTOR_BYTES);
        // Ten thousand such members would merge past the cap.
        let graph = build(20_000);
        let ids: BTreeSet<String> = graph.nodes.keys().step_by(2).cloned().collect();
        graph.maxima(ids, false);
        assert!(graph.ancestry.failed());
        assert!(graph.resource.get());
        assert!(graph.ancestry.bytes() <= super::ancestors::MAX_ANCESTOR_BYTES);
    }

    #[test]
    fn flat_histories_share_caches_and_keep_the_logical_work_charge() {
        let count: usize = 4096;
        // Layout N, plus per cache setup N + construction N. Three
        // caches are charged (storage is shared), plus one lifecycle
        // unit per record: 8N in total.
        let work = 8 * count;
        let limits = Limits {
            traversal: work,
            ..Limits::default()
        };
        let graph = Graph::new(nodes(count, false), &limits);
        assert!(!graph.resource.get());
        assert_eq!(graph.budget.get(), 0);
        assert!(Rc::ptr_eq(&graph.own, &graph.structural));
        assert!(Rc::ptr_eq(&graph.own, &graph.accepted));
        assert!(graph.own.values().all(|c| c.ids.range_count() == 1));
        let limits = Limits {
            traversal: work - 1,
            ..limits
        };
        assert!(Graph::new(nodes(count, false), &limits).resource.get());
    }

    #[test]
    fn linear_histories_keep_the_logical_work_charge() {
        let count: usize = 4096;
        // Layout (2N-1). Per cache: setup (2N-1) + construction
        // (1 + 3 per chained record, including one copied range per
        // parent). Three caches charged, plus one lifecycle unit per
        // record: 18N - 10 in total.
        let work = 18 * count - 10;
        let limits = Limits {
            traversal: work,
            ..Limits::default()
        };
        let graph = Graph::new(nodes(count, true), &limits);
        assert!(!graph.resource.get());
        assert_eq!(graph.budget.get(), 0);
        let limits = Limits {
            traversal: work - 1,
            ..limits
        };
        assert!(Graph::new(nodes(count, true), &limits).resource.get());
    }

    #[test]
    fn linear_histories_use_one_range_past_the_old_dense_threshold() {
        let count = 70_000;
        let limits = Limits {
            traversal: 100_000_000,
            ..Limits::default()
        };
        let graph = Graph::new(nodes(count, true), &limits);
        assert!(!graph.resource.get());
        let last = graph.own.last_key_value().unwrap().1;
        assert_eq!(last.ids.range_count(), 1);
        assert_eq!(last.ids.iter().len(), count);
        assert!(graph.nodes.keys().all(|id| last.ids.contains(id)));
    }

    /// Naive ancestor oracle: plain set transitive closure over the same
    /// dependency rules, with no ranges involved.
    fn naive(
        nodes: &BTreeMap<String, Node>,
        graph: &Graph,
        mode: u8,
    ) -> BTreeMap<String, (BTreeSet<String>, BTreeSet<String>, bool)> {
        // Dependency edges exactly as the graph defines them.
        let deps = |node: &Node| graph.dependencies(node, mode);
        // Topologically processable records, as in construction.
        let mut done: BTreeMap<String, (BTreeSet<String>, BTreeSet<String>, bool)> =
            BTreeMap::new();
        loop {
            let mut progressed = false;
            for (id, node) in nodes {
                if done.contains_key(id) {
                    continue;
                }
                let (edges, missing, invalid) = deps(node);
                if edges.iter().all(|dep| done.contains_key(dep)) {
                    let mut ids = BTreeSet::from([id.clone()]);
                    let mut all_missing = missing;
                    let mut all_invalid = invalid;
                    for dep in &edges {
                        let (pids, pmissing, pinvalid) = &done[dep];
                        ids.extend(pids.iter().cloned());
                        all_missing.extend(pmissing.iter().cloned());
                        all_invalid |= *pinvalid;
                    }
                    done.insert(id.clone(), (ids, all_missing, all_invalid));
                    progressed = true;
                }
            }
            if !progressed {
                break;
            }
        }
        for id in nodes.keys() {
            done.entry(id.clone())
                .or_insert_with(|| (BTreeSet::from([id.clone()]), BTreeSet::new(), true));
        }
        done
    }

    fn assert_graph_matches_oracle(nodes: BTreeMap<String, Node>) {
        let limits = Limits {
            traversal: 100_000_000,
            ..Limits::default()
        };
        let graph = Graph::new(nodes.clone(), &limits);
        assert!(!graph.resource.get());
        for (mode, cache) in [
            (0u8, &graph.own),
            (1, &graph.structural),
            (2, &graph.accepted),
        ] {
            let expected = naive(&nodes, &graph, mode);
            assert_eq!(cache.len(), expected.len(), "mode {mode}");
            for (id, closure) in cache.iter() {
                let (ids, missing, invalid) = &expected[id];
                assert_eq!(
                    closure.ids.iter(),
                    ids.iter().cloned().collect::<Vec<_>>(),
                    "ids in lexical order, mode {mode} record {id}"
                );
                assert_eq!(
                    closure.ids.iter_unordered().collect::<BTreeSet<_>>(),
                    *ids,
                    "unordered ids mode {mode} record {id}"
                );
                assert_eq!(&closure.missing, missing, "missing mode {mode} record {id}");
                assert_eq!(closure.invalid, *invalid, "invalid mode {mode} record {id}");
                for member in ids {
                    assert!(closure.ids.contains(member));
                }
                assert!(!closure.ids.contains("jve1:absent"));
            }
        }
    }

    #[test]
    fn oracle_chains_branches_and_merges() {
        let mut map = BTreeMap::new();
        for n in [
            node("jve1:a", "one", &[], "identity.merge"),
            node("jve1:b", "one", &["jve1:a"], "identity.merge"),
            node("jve1:c", "one", &["jve1:a"], "identity.merge"),
            node("jve1:d", "one", &["jve1:b", "jve1:c"], "identity.merge"),
            node("jve1:e", "two", &[], "identity.merge"),
            node("jve1:f", "two", &["jve1:e"], "identity.merge"),
        ] {
            map.insert(n.id.clone(), n);
        }
        assert_graph_matches_oracle(map);
    }

    #[test]
    fn oracle_missing_and_cross_issuer_predecessors() {
        let mut map = BTreeMap::new();
        for n in [
            node("jve1:a", "one", &["jve1:gone"], "identity.merge"),
            node("jve1:b", "one", &["jve1:a"], "identity.merge"),
            node("jve1:c", "two", &["jve1:b"], "identity.merge"),
            node("jve1:d", "two", &["jve1:c"], "identity.merge"),
        ] {
            map.insert(n.id.clone(), n);
        }
        assert_graph_matches_oracle(map);
    }

    #[test]
    fn oracle_cycles() {
        let mut map = BTreeMap::new();
        for n in [
            node("jve1:a", "one", &["jve1:b"], "identity.merge"),
            node("jve1:b", "one", &["jve1:a"], "identity.merge"),
            node("jve1:c", "one", &["jve1:a"], "identity.merge"),
            node("jve1:d", "one", &[], "identity.merge"),
        ] {
            map.insert(n.id.clone(), n);
        }
        assert_graph_matches_oracle(map);
    }

    #[test]
    fn oracle_transfer_and_acceptance() {
        let mut transfer = node("jve1:t", "one", &["jve1:a"], "identity.transfer");
        transfer.action =
            CompactValue::from(&json!({"kind":"identity.transfer","successor":"two"}));
        let mut accept = node("jve1:x", "two", &[], "identity.accept");
        accept.action = CompactValue::from(&json!({"kind":"identity.accept","transfer":"jve1:t"}));
        let mut map = BTreeMap::new();
        for n in [
            node("jve1:a", "one", &[], "identity.merge"),
            transfer,
            accept,
            node("jve1:y", "two", &["jve1:x"], "identity.merge"),
        ] {
            map.insert(n.id.clone(), n);
        }
        assert_graph_matches_oracle(map);
    }

    #[test]
    fn oracle_compromise_cutoffs_are_complete_or_pending_as_before() {
        let mut compromise = node("jve1:k", "one", &["jve1:b"], "identity.compromise");
        compromise.action =
            CompactValue::from(&json!({"kind":"identity.compromise","safe":["jve1:a"]}));
        let mut map = BTreeMap::new();
        for n in [
            node("jve1:a", "one", &[], "definition.publish"),
            node("jve1:b", "one", &["jve1:a"], "definition.publish"),
            compromise,
        ] {
            map.insert(n.id.clone(), n);
        }
        assert_graph_matches_oracle(map.clone());
        let limits = Limits {
            traversal: 100_000_000,
            ..Limits::default()
        };
        let graph = Graph::new(map, &limits);
        assert!(graph.lifecycle.compromised.contains("one"));
        assert_eq!(graph.cutoffs["one"].len(), 1);
        assert!(graph.cutoffs["one"][0].ids.contains("jve1:a"));
        assert!(!graph.cutoffs["one"][0].ids.contains("jve1:b"));
    }

    #[test]
    fn oracle_layout_that_is_not_lexical_still_iterates_lexically() {
        // Issuer "alpha" holds the lexically last IDs and issuer "zeta"
        // the first, so layout order and lexical order differ.
        let mut map = BTreeMap::new();
        for n in [
            node("jve1:z1", "alpha", &[], "identity.merge"),
            node("jve1:z2", "alpha", &["jve1:z1"], "identity.merge"),
            node("jve1:a1", "zeta", &[], "identity.merge"),
            node("jve1:a2", "zeta", &["jve1:a1"], "identity.merge"),
            node("jve1:a3", "zeta", &["jve1:a2"], "identity.merge"),
        ] {
            map.insert(n.id.clone(), n);
        }
        assert_graph_matches_oracle(map);
    }

    #[test]
    fn appends_match_oracle_including_an_old_branch() {
        let mut map = BTreeMap::new();
        for n in [
            node("jve1:a", "one", &[], "identity.merge"),
            node("jve1:b", "one", &["jve1:a"], "identity.merge"),
            node("jve1:c", "one", &["jve1:a"], "identity.merge"),
            node("jve1:d", "one", &["jve1:b", "jve1:c"], "identity.merge"),
        ] {
            map.insert(n.id.clone(), n);
        }
        let limits = Limits {
            traversal: 100_000_000,
            ..Limits::default()
        };
        let mut graph = Graph::new(map.clone(), &limits);
        // Append to an old branch (jve1:b already has a child), not a tip.
        graph.append_ordinary(node("jve1:e", "one", &["jve1:b"], "identity.merge"));
        let closure = &graph.own["jve1:e"];
        assert_eq!(
            closure.ids.iter(),
            vec![
                "jve1:a".to_string(),
                "jve1:b".to_string(),
                "jve1:e".to_string()
            ]
        );
        assert!(closure.complete());
        // Append a chain tip on top of the branch append.
        graph.append_ordinary(node("jve1:f", "one", &["jve1:e"], "identity.merge"));
        let closure = &graph.own["jve1:f"];
        assert_eq!(
            closure.ids.iter(),
            vec![
                "jve1:a".to_string(),
                "jve1:b".to_string(),
                "jve1:e".to_string(),
                "jve1:f".to_string()
            ]
        );
        // A fresh full build of the same records agrees exactly.
        for n in [
            node("jve1:e", "one", &["jve1:b"], "identity.merge"),
            node("jve1:f", "one", &["jve1:e"], "identity.merge"),
        ] {
            map.insert(n.id.clone(), n);
        }
        let rebuilt = Graph::new(map, &limits);
        for (id, closure) in graph.own.iter() {
            let fresh = &rebuilt.own[id];
            assert_eq!(closure.ids.iter(), fresh.ids.iter(), "append {id}");
            assert_eq!(closure.missing, fresh.missing, "append missing {id}");
            assert_eq!(closure.invalid, fresh.invalid, "append invalid {id}");
        }
    }

    fn two_interleaved_chains(count: usize) -> BTreeMap<String, Node> {
        (0..count)
            .map(|i| {
                let id = format!("jve1:{i:064x}");
                let previous = (i >= 2).then(|| format!("jve1:{:064x}", i - 2));
                (
                    id.clone(),
                    Node {
                        id,
                        issuer: "issuer".into(),
                        previous: previous.into_iter().collect(),
                        action: CompactValue::from(&json!({"kind":"identity.merge"})),
                        kind: "identity.merge".into(),
                        semantic: true,
                        body_hash: None,
                        body: None,
                        body_label: "absent".into(),
                    },
                )
            })
            .collect()
    }

    fn spine_and_leaves(spine: usize) -> BTreeMap<String, Node> {
        (0..spine)
            .flat_map(|i| {
                let s = format!("jve1:s{i:05}");
                let g = format!("jve1:g{i:05}");
                let spine_node = Node {
                    id: s.clone(),
                    issuer: "issuer".into(),
                    previous: (i > 0)
                        .then(|| format!("jve1:s{:05}", i - 1))
                        .into_iter()
                        .collect(),
                    action: CompactValue::from(&json!({"kind":"identity.merge"})),
                    kind: "identity.merge".into(),
                    semantic: true,
                    body_hash: None,
                    body: None,
                    body_label: "absent".into(),
                };
                let leaf_node = Node {
                    id: g.clone(),
                    issuer: "issuer".into(),
                    previous: vec![s.clone()],
                    action: CompactValue::from(&json!({"kind":"identity.merge"})),
                    kind: "identity.merge".into(),
                    semantic: true,
                    body_hash: None,
                    body: None,
                    body_label: "absent".into(),
                };
                [(s, spine_node), (g, leaf_node)]
            })
            .collect()
    }

    #[test]
    fn two_interleaved_chains_refuse_deterministically() {
        // Each tip closure holds about count/2 singleton ranges, so
        // retained range storage would grow with the square of the
        // record count. Both the logical budget (default) and the hard
        // ancestry byte cap (any budget) must refuse.
        let nodes = two_interleaved_chains(8_000);
        let graph = Graph::new(nodes.clone(), &Limits::default());
        assert!(graph.resource.get());
        let limits = Limits {
            traversal: 1_000_000_000,
            ..Limits::default()
        };
        let graph = Graph::new(nodes, &limits);
        assert!(graph.resource.get());
        assert!(graph.ancestry.failed());
        assert!(graph.ancestry.bytes() <= crate::ancestors::MAX_ANCESTOR_BYTES);
    }

    #[test]
    fn spine_with_a_leaf_per_step_refuses_deterministically() {
        // Leaves sort between spine records, so spine closures gain one
        // range per step. Same requirement as the interleaved chains.
        let nodes = spine_and_leaves(6_000);
        assert_eq!(nodes.len(), 12_000);
        let graph = Graph::new(nodes.clone(), &Limits::default());
        assert!(graph.resource.get());
        let limits = Limits {
            traversal: 1_000_000_000,
            ..Limits::default()
        };
        let graph = Graph::new(nodes, &limits);
        assert!(graph.resource.get());
        assert!(graph.ancestry.failed());
        assert!(graph.ancestry.bytes() <= crate::ancestors::MAX_ANCESTOR_BYTES);
    }

    fn interleaved_with_acceptance(count: usize) -> BTreeMap<String, Node> {
        let mut map = two_interleaved_chains(count);
        let mut transfer = node("jve1:transfer", "one", &[], "identity.transfer");
        transfer.action =
            CompactValue::from(&json!({"kind":"identity.transfer","successor":"two"}));
        let mut accept = node("jve1:accept", "two", &[], "identity.accept");
        accept.action =
            CompactValue::from(&json!({"kind":"identity.accept","transfer":"jve1:transfer"}));
        map.insert(transfer.id.clone(), transfer);
        map.insert(accept.id.clone(), accept);
        map
    }

    #[test]
    fn cap_failure_in_the_accepted_cache_is_a_resource_failure() {
        // Three real caches (an acceptance exists) multiply range
        // copies. At this size the accepted cache crosses the byte cap;
        // the graph must report resource exhaustion, and no accepted
        // closure built after the failed charge may be complete.
        let limits = Limits {
            traversal: 1_000_000_000,
            ..Limits::default()
        };
        let graph = Graph::new(interleaved_with_acceptance(2_880), &limits);
        assert!(graph.ancestry.failed());
        assert!(graph.resource.get());
        let graph = Graph::new(interleaved_with_acceptance(1_500), &limits);
        assert!(!graph.ancestry.failed());
        assert!(!graph.resource.get());
    }

    #[test]
    fn append_past_the_cap_marks_the_graph_and_closure_unavailable() {
        let limits = Limits {
            traversal: 1_000_000_000,
            ..Limits::default()
        };
        let mut graph = Graph::new(interleaved_with_acceptance(2_348), &limits);
        assert!(!graph.resource.get());
        // The two chain tips carry about 1,174 ranges each. Appending a
        // record on both crosses the remaining cap headroom.
        let tip_a = format!("jve1:{:064x}", 2_346usize);
        let tip_b = format!("jve1:{:064x}", 2_347usize);
        graph.append_ordinary(node(
            "jve1:appended",
            "issuer",
            &[&tip_a, &tip_b],
            "judgment.set",
        ));
        assert!(graph.ancestry.failed());
        assert!(graph.resource.get());
        assert!(!graph.own["jve1:appended"].complete());
    }

    #[test]
    fn sibling_clones_have_independent_cap_accounting() {
        let limits = Limits {
            traversal: 1_000_000_000,
            ..Limits::default()
        };
        let graph = Graph::new(interleaved_with_acceptance(2_348), &limits);
        assert!(!graph.resource.get());
        let mut fork_a = graph.clone();
        let fork_b = graph.clone();
        let tip_a = format!("jve1:{:064x}", 2_346usize);
        let tip_b = format!("jve1:{:064x}", 2_347usize);
        fork_a.append_ordinary(node(
            "jve1:appended",
            "issuer",
            &[&tip_a, &tip_b],
            "judgment.set",
        ));
        assert!(fork_a.resource.get());
        // The sibling and the parent keep their own accounting and
        // their closures stay correct.
        assert!(!fork_b.resource.get());
        assert!(!fork_b.ancestry.failed());
        assert!(!graph.ancestry.failed());
        let last = format!("jve1:{:064x}", 2_347usize);
        let first = format!("jve1:{:064x}", 1usize);
        assert!(fork_b.own[&last].ids.contains(&first));
        assert!(fork_b.own[&last].complete());
    }

    #[test]
    fn zero_budget_refuses_before_layout() {
        let limits = Limits {
            traversal: 0,
            ..Limits::default()
        };
        let graph = Graph::new(nodes(64, true), &limits);
        assert!(graph.resource.get());
        assert!(graph.own.is_empty());
    }
}
