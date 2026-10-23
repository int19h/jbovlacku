use super::*;
use std::cell::Cell;
use std::rc::Rc;

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
        let header = event.header();
        let kind = header.action["kind"].as_str().unwrap_or_default();
        let availability = inspect_body(event, bytes);
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
                id: event.id().into(),
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
#[derive(Clone)]
pub(crate) struct IdSet {
    names: Rc<Vec<String>>,
    index: Rc<BTreeMap<String, usize>>,
    entries: IdEntries,
    extra: BTreeSet<String>,
}
#[derive(Clone)]
enum IdEntries {
    Sparse(Rc<Vec<usize>>),
    Dense(Rc<Vec<u64>>),
}
impl IdSet {
    fn new(names: Rc<Vec<String>>, index: Rc<BTreeMap<String, usize>>) -> Self {
        Self {
            entries: IdEntries::Sparse(Rc::default()),
            extra: BTreeSet::new(),
            names,
            index,
        }
    }
    pub fn contains(&self, id: &str) -> bool {
        self.extra.contains(id)
            || self.index.get(id).is_some_and(|i| match &self.entries {
                IdEntries::Sparse(ids) => ids.binary_search(i).is_ok(),
                IdEntries::Dense(bits) => bits[i / 64] & (1u64 << (i % 64)) != 0,
            })
    }
    fn insert(&mut self, id: &str) {
        if let Some(i) = self.index.get(id) {
            match &mut self.entries {
                IdEntries::Sparse(ids) => {
                    if let Err(at) = ids.binary_search(i) {
                        Rc::make_mut(ids).insert(at, *i);
                    }
                }
                IdEntries::Dense(bits) => Rc::make_mut(bits)[i / 64] |= 1u64 << (i % 64),
            }
            self.make_dense_if_needed();
        } else {
            self.extra.insert(id.into());
        }
    }
    pub fn iter(&self) -> impl Iterator<Item = &String> {
        let (sparse, dense) = match &self.entries {
            IdEntries::Sparse(ids) => (ids.as_slice(), [].as_slice()),
            IdEntries::Dense(bits) => ([].as_slice(), bits.as_slice()),
        };
        let mut ordinary = sparse
            .iter()
            .map(|i| &self.names[*i])
            .chain(dense.iter().enumerate().flat_map(move |(word, bits)| {
                let mut remaining = *bits;
                std::iter::from_fn(move || {
                    if remaining == 0 {
                        return None;
                    }
                    let bit = remaining.trailing_zeros() as usize;
                    remaining &= remaining - 1;
                    self.names.get(word * 64 + bit)
                })
            }))
            .peekable();
        let mut extra = self.extra.iter().peekable();
        std::iter::from_fn(move || match (ordinary.peek(), extra.peek()) {
            (Some(a), Some(b)) if a < b => ordinary.next(),
            (Some(_), Some(_)) => extra.next(),
            (Some(_), None) => ordinary.next(),
            (None, Some(_)) => extra.next(),
            (None, None) => None,
        })
    }
    pub fn extend(&mut self, other: IdSet) {
        self.union(&other);
    }
    fn union(&mut self, other: &IdSet) {
        self.extra.extend(other.extra.iter().cloned());
        if let IdEntries::Dense(_) = &other.entries {
            self.make_dense();
        }
        match (&mut self.entries, &other.entries) {
            (IdEntries::Dense(a), IdEntries::Dense(b)) => {
                for (a, b) in Rc::make_mut(a).iter_mut().zip(b.iter()) {
                    *a |= b;
                }
            }
            (IdEntries::Dense(bits), IdEntries::Sparse(ids)) => {
                let bits = Rc::make_mut(bits);
                for i in ids.iter() {
                    bits[i / 64] |= 1u64 << (i % 64);
                }
            }
            (IdEntries::Sparse(a), IdEntries::Sparse(b)) => {
                let mut merged = Vec::with_capacity(a.len() + b.len());
                let (mut left, mut right) = (0, 0);
                while left < a.len() && right < b.len() {
                    if a[left] < b[right] {
                        merged.push(a[left]);
                        left += 1;
                    } else {
                        merged.push(b[right]);
                        if a[left] == b[right] {
                            left += 1;
                        }
                        right += 1;
                    }
                }
                merged.extend_from_slice(&a[left..]);
                merged.extend_from_slice(&b[right..]);
                *a = Rc::new(merged);
            }
            (IdEntries::Sparse(_), IdEntries::Dense(_)) => unreachable!(),
        }
        self.make_dense_if_needed();
    }
    fn make_dense_if_needed(&mut self) {
        if matches!(&self.entries, IdEntries::Sparse(ids) if ids.len() * std::mem::size_of::<usize>() > self.names.len().div_ceil(64) * std::mem::size_of::<u64>())
        {
            self.make_dense();
        }
    }
    fn make_dense(&mut self) {
        if let IdEntries::Sparse(ids) = &self.entries {
            let mut bits = vec![0; self.names.len().div_ceil(64)];
            for i in ids.iter() {
                bits[i / 64] |= 1u64 << (i % 64);
            }
            self.entries = IdEntries::Dense(Rc::new(bits));
        }
    }
}
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
    pub names: Rc<Vec<String>>,
    pub index: Rc<BTreeMap<String, usize>>,
    pub budget: Cell<usize>,
    pub resource: Cell<bool>,
    pub appended: usize,
}
impl Graph {
    pub fn new(nodes: BTreeMap<String, Node>, limits: &Limits) -> Self {
        let names = Rc::new(nodes.keys().cloned().collect::<Vec<_>>());
        let index = Rc::new(
            names
                .iter()
                .enumerate()
                .map(|(i, id)| (id.clone(), i))
                .collect(),
        );
        let mut graph = Self {
            nodes,
            names,
            index,
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
        let before = graph.budget.get();
        graph.own = Rc::new(graph.build_cache(0));
        if graph.resource.get() {
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
        graph.build_lifecycle();
        if graph.resource.get() {
            return graph;
        }
        if same_links {
            if graph.charge(own_work) {
                graph.accepted = graph.own.clone();
            }
        } else {
            graph.accepted = Rc::new(graph.build_cache(2));
        }
        graph
    }
    fn empty_closure(&self) -> Closure {
        Closure {
            ids: IdSet::new(self.names.clone(), self.index.clone()),
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
    /// Topological bitset unions keep ordinary linear histories compact.
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
            let mut c = self.empty_closure();
            if !self.charge(self.names.len().div_ceil(64) + missing.len()) {
                return cache;
            }
            c.missing = missing.clone();
            c.invalid = *invalid;
            c.ids.insert(&id);
            for dep in deps {
                let p = &cache[dep];
                if !self.charge(self.names.len().div_ceil(64) + p.missing.len()) {
                    return cache;
                }
                c.ids.union(&p.ids);
                c.missing.extend(p.missing.iter().cloned());
                c.invalid |= p.invalid;
                c.resource |= p.resource;
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
            if !self.charge(self.names.len().div_ceil(64)) {
                return cache;
            }
            c.ids.insert(&id);
            c.invalid = true;
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
            if !self.charge(self.names.len().div_ceil(64) + c.missing.len()) {
                result.resource = true;
                break;
            }
            result.ids.union(&c.ids);
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
                    if c.resource || !self.charge(self.names.len().div_ceil(64) + c.missing.len()) {
                        return;
                    }
                    cutoff.ids.extend(c.ids);
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
    pub fn actor(&self, key: &str) -> String {
        self.lifecycle
            .key_actor
            .get(key)
            .cloned()
            .unwrap_or_else(|| key.into())
    }
    /// Append a complete ordinary event without changing any existing links.
    /// New IDs stay outside the fixed bitset universe until the next rebuild.
    pub fn append_ordinary(&mut self, node: Node) {
        let closure = |cache: &BTreeMap<String, Closure>| {
            let mut result = self.empty_closure();
            result.ids.insert(&node.id);
            for previous in &node.previous {
                let prior = &cache[previous];
                result.ids.union(&prior.ids);
                result.missing.extend(prior.missing.iter().cloned());
                result.invalid |= prior.invalid;
                result.resource |= prior.resource;
            }
            result
        };
        let own = closure(&self.own);
        let shared =
            Rc::ptr_eq(&self.own, &self.structural) && Rc::ptr_eq(&self.own, &self.accepted);
        if shared {
            Rc::make_mut(&mut self.own).insert(node.id.clone(), own);
            self.structural = self.own.clone();
            self.accepted = self.own.clone();
        } else {
            let structural = closure(&self.structural);
            let accepted = closure(&self.accepted);
            Rc::make_mut(&mut self.own).insert(node.id.clone(), own);
            Rc::make_mut(&mut self.structural).insert(node.id.clone(), structural);
            Rc::make_mut(&mut self.accepted).insert(node.id.clone(), accepted);
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
        self.nodes.insert(node.id.clone(), node);
        self.appended += 1;
    }
    pub fn own_complete(&self, id: &str) -> bool {
        self.own.get(id).is_some_and(Closure::complete)
    }
    pub fn suspended(&self, key: &str) -> bool {
        self.lifecycle.suspended.contains_key(&self.actor(key))
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
        self.structural
            .get(event)
            .is_some_and(|c| c.ids.iter().any(|id| self.nodes[id].issuer == root))
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

    fn set(names: Rc<Vec<String>>, values: &[usize]) -> IdSet {
        let index = Rc::new(
            names
                .iter()
                .enumerate()
                .map(|(i, id)| (id.clone(), i))
                .collect(),
        );
        let mut result = IdSet::new(names.clone(), index);
        for i in values {
            result.insert(&names[*i]);
        }
        result
    }

    #[test]
    fn sparse_and_dense_unions_match_ordered_sets() {
        let names = Rc::new((0..4096).map(|i| format!("{i:04}")).collect::<Vec<_>>());
        let cases = [
            Vec::new(),
            vec![0, 63, 64, 4095],
            (0..4096).step_by(3).collect(),
            (0..4096).collect(),
        ];
        for left in &cases {
            for right in &cases {
                let mut combined = set(names.clone(), left);
                let other = set(names.clone(), right);
                combined.union(&other);
                let expected: BTreeSet<_> = left.iter().chain(right).map(|i| &names[*i]).collect();
                assert_eq!(
                    combined.iter().collect::<Vec<_>>(),
                    expected.iter().copied().collect::<Vec<_>>()
                );
                for name in names.iter() {
                    assert_eq!(combined.contains(name), expected.contains(name));
                }
                assert!(!combined.contains("absent"));
            }
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
    fn flat_histories_share_compact_caches_and_keep_the_original_work_charge() {
        let count: usize = 4096;
        let work = count * (3 * (1 + count.div_ceil(64)) + 1);
        let limits = Limits {
            traversal: work,
            ..Limits::default()
        };
        let graph = Graph::new(nodes(count, false), &limits);
        assert!(!graph.resource.get());
        assert_eq!(graph.budget.get(), 0);
        assert!(Rc::ptr_eq(&graph.own, &graph.structural));
        assert!(Rc::ptr_eq(&graph.own, &graph.accepted));
        assert!(
            graph
                .own
                .values()
                .all(|c| matches!(&c.ids.entries, IdEntries::Sparse(ids) if ids.len() == 1))
        );
        let limits = Limits {
            traversal: work - 1,
            ..limits
        };
        assert!(Graph::new(nodes(count, false), &limits).resource.get());
    }

    #[test]
    fn linear_histories_keep_dense_ancestry_when_it_uses_less_storage() {
        let count = 1024;
        let graph = Graph::new(nodes(count, true), &Limits::default());
        assert!(!graph.resource.get());
        let last = graph.own.last_key_value().unwrap().1;
        assert!(matches!(&last.ids.entries, IdEntries::Dense(_)));
        assert_eq!(last.ids.iter().count(), count);
        assert!(graph.nodes.keys().all(|id| last.ids.contains(id)));
    }
}
