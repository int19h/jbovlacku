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

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Node {
    pub id: String,
    pub issuer: String,
    pub previous: Vec<String>,
    pub action: Value,
    pub kind: String,
    pub semantic: bool,
    pub body_hash: Option<String>,
    pub body: Option<Value>,
    pub body_label: String,
}
impl Node {
    pub fn new_with<T>(
        event: &VerifiedEnvelope,
        bytes: Option<&[u8]>,
        inspect: impl FnOnce(&BodyAvailability) -> T,
    ) -> (Self, T) {
        Self::from_parts(
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
                action: header.action.clone(),
                kind: kind.into(),
                semantic: validate_action(header).is_ok(),
                body_hash: header.content.as_ref().map(|c| c.hash.clone()),
                body,
                body_label,
            },
            content,
        )
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

#[derive(Clone)]
pub(crate) struct Graph {
    pub nodes: BTreeMap<String, Node>,
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
    pub fn new(nodes: BTreeMap<String, Node>, limits: &Limits) -> Self {
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
            let transfer = node.action["transfer"].as_str().unwrap_or_default();
            match self.nodes.get(transfer) {
                None => {
                    missing.insert(transfer.into());
                }
                Some(t)
                    if t.semantic
                        && t.kind == "identity.transfer"
                        && t.action["successor"].as_str() == Some(&node.issuer) =>
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
        for (id, node) in &self.nodes {
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
        for node in self.nodes.values().filter(|n| n.semantic) {
            if !self.charge(1) {
                return;
            }
            if node.kind == "identity.transfer" && self.own_complete(&node.id) {
                self.transfers
                    .entry(node.issuer.clone())
                    .or_default()
                    .push(node.id.clone());
            }
            if node.kind == "identity.compromise" {
                let mut cutoff = self.empty_closure();
                let safe: Vec<_> = node.action["safe"]
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
                    cutoff.ids.fresh_ranges = Self::fresh_count(
                        &self.space,
                        &self.appended_rank,
                        &self.nodes,
                        &cutoff.ids,
                    );
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
            let successor = transfer.action["successor"].as_str().unwrap_or_default();
            let first: Vec<_> = self
                .nodes
                .values()
                .filter(|n| n.issuer == successor && n.previous.is_empty())
                .collect();
            if first.len() != 1 {
                continue;
            }
            let acceptance = first[0];
            if acceptance.semantic
                && acceptance.kind == "identity.accept"
                && acceptance.action["transfer"].as_str() == Some(&transfer.id)
                && self.own_complete(&acceptance.id)
                && key != successor
            {
                self.lifecycle
                    .successor
                    .insert(key.clone(), successor.into());
            }
        }
        // Remove every cycle and any path that enters one.
        let edges = self.lifecycle.successor.clone();
        for key in edges.keys() {
            let mut seen = BTreeSet::new();
            let mut at = key;
            while let Some(next) = edges.get(at) {
                if !seen.insert(at.clone()) {
                    for item in seen {
                        self.lifecycle.successor.remove(&item);
                    }
                    break;
                }
                at = next;
            }
        }
        let keys: BTreeSet<_> = self.nodes.values().map(|n| n.issuer.clone()).collect();
        for key in &keys {
            let mut actor = key.clone();
            let mut seen = BTreeSet::new();
            while let Some((parent, _)) =
                self.lifecycle.successor.iter().find(|(_, v)| *v == &actor)
            {
                if !seen.insert(actor.clone()) {
                    break;
                }
                actor = parent.clone();
            }
            self.lifecycle.key_actor.insert(key.clone(), actor.clone());
            self.lifecycle
                .groups
                .entry(actor)
                .or_default()
                .insert(key.clone());
        }
        for (id, node) in &self.nodes {
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
        Self::fresh_count(&self.space, &self.appended_rank, &self.nodes, set)
    }

    fn fresh_count(
        space: &super::ancestors::Space,
        appended_rank: &BTreeMap<String, (u32, u32)>,
        nodes: &BTreeMap<String, Node>,
        set: &IdSet,
    ) -> usize {
        let mut count = set.range_count();
        if set.extra.is_empty() {
            return count;
        }
        // Index appended records by rank: by full rank for predecessor
        // lookups, and the last one at each insertion position.
        let mut by_rank: BTreeMap<(u32, String, u32), &String> = BTreeMap::new();
        let mut last_at: BTreeMap<u32, &String> = BTreeMap::new();
        for (id, &(position, sub)) in appended_rank {
            let issuer = &nodes[id].issuer;
            by_rank.insert((position, issuer.clone(), sub), id);
            let replace = match last_at.get(&position) {
                None => true,
                Some(current) => {
                    let current_issuer = &nodes[*current].issuer;
                    (issuer.as_str(), sub) > (current_issuer.as_str(), appended_rank[*current].1)
                }
            };
            if replace {
                last_at.insert(position, id);
            }
        }
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
        let mut bounds: Option<(u32, u32)> = None;
        for node in self.nodes.values().filter(|n| n.issuer == issuer) {
            if let Some(position) = self.space.position(&node.id) {
                bounds = Some(match bounds {
                    None => (position, position),
                    Some((first, last)) => (first.min(position), last.max(position)),
                });
            }
        }
        bounds
    }

    /// First layout position of any issuer block after the given one.
    pub fn next_block_start(&self, issuer: &str) -> u32 {
        self.nodes
            .values()
            .filter(|n| n.issuer.as_str() > issuer)
            .filter_map(|n| self.space.position(&n.id))
            .min()
            .unwrap_or_else(|| self.space.len() as u32)
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
        self.nodes.insert(node.id.clone(), node.clone());
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
    pub fn maxima(&self, ids: BTreeSet<String>, structural: bool) -> BTreeSet<String> {
        ids.iter()
            .filter(|id| !ids.iter().any(|later| self.follows(later, id, structural)))
            .cloned()
            .collect()
    }
    pub fn structurally_connected(&self, root: &str, issuer: &str, event: &str) -> bool {
        if root == issuer {
            return true;
        }
        self.structural.get(event).is_some_and(|c| {
            c.ids
                .iter_unordered()
                .any(|id| self.nodes[id.as_str()].issuer == root)
        })
    }
    pub fn downstream(&self, root: &str) -> BTreeSet<String> {
        let mut keys = BTreeSet::new();
        let mut at = root;
        while keys.insert(at.into()) {
            match self.lifecycle.successor.get(at) {
                Some(next) => at = next,
                None => break,
            }
        }
        keys
    }
    pub fn local_complete(&self, root: &str, _claim: &str) -> bool {
        let keys = self.downstream(root);
        !keys.iter().any(|key| self.pending_cutoffs.contains(key))
            && self
                .nodes
                .values()
                .filter(|n| keys.contains(&n.issuer))
                .all(|n| {
                    // An old-key branch outside an accepted transfer has no imported authority.
                    if self.lifecycle.successor.contains_key(&n.issuer) && !self.retained(&n.id) {
                        return true;
                    }
                    self.own_complete(&n.id)
                })
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
            action: json!({"kind": kind}),
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
                        action: json!({"kind":"identity.merge"}),
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
        transfer.action = json!({"kind":"identity.transfer","successor":"two"});
        let mut accept = node("jve1:x", "two", &[], "identity.accept");
        accept.action = json!({"kind":"identity.accept","transfer":"jve1:t"});
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
        compromise.action = json!({"kind":"identity.compromise","safe":["jve1:a"]});
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
                        action: json!({"kind":"identity.merge"}),
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
                    action: json!({"kind":"identity.merge"}),
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
                    action: json!({"kind":"identity.merge"}),
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
        transfer.action = json!({"kind":"identity.transfer","successor":"two"});
        let mut accept = node("jve1:accept", "two", &[], "identity.accept");
        accept.action = json!({"kind":"identity.accept","transfer":"jve1:transfer"});
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
