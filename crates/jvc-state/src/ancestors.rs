//! Exact ancestry as intervals over a topological layout.
//!
//! Every record gets one layout position. Records of one issuer occupy a
//! contiguous block, and a record always follows its same-issuer
//! predecessors inside that block. A closure is then a sorted list of
//! disjoint position ranges: a plain chain history is one range, and a
//! closure that reaches another issuer through an acceptance is two.
//! Storage grows with the number of ranges, not with the square of the
//! record count.

use super::graph::Node;
use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Range {
    first: u32,
    last: u32,
}

/// Hard cap on ancestry range metadata, counted cumulatively over every
/// range vector a union copies or allocates, including discarded
/// temporaries. The same value applies in native and Wasm builds. The
/// real dictionary plus synthetic data uses an estimated 10 to 20 MB by
/// this count; adversarial layouts reach the cap and refuse instead of
/// exhausting memory.
pub(crate) const MAX_ANCESTOR_BYTES: usize = 64 * 1024 * 1024;

/// Per-state cap accounting. Each evaluated state owns one budget.
/// Cloning a state copies the counters by value, so work in one fork
/// or sibling never consumes another state's cap or sets its failure.
#[derive(Clone, Default)]
pub(crate) struct AncestryBudget {
    bytes: Cell<usize>,
    failed: Cell<bool>,
}

impl AncestryBudget {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn charge(&self, bytes: usize) -> bool {
        if self.failed.get() || bytes > MAX_ANCESTOR_BYTES.saturating_sub(self.bytes.get()) {
            self.failed.set(true);
            false
        } else {
            self.bytes.set(self.bytes.get() + bytes);
            true
        }
    }

    pub fn failed(&self) -> bool {
        self.failed.get()
    }

    #[cfg(test)]
    pub fn bytes(&self) -> usize {
        self.bytes.get()
    }
}

/// Sorted disjoint ranges. One range is stored inline; more share an `Rc`.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Ranges {
    Empty,
    One(Range),
    Many(Rc<Vec<Range>>),
}

impl Ranges {
    fn as_slice(&self) -> &[Range] {
        match self {
            Ranges::Empty => &[],
            Ranges::One(range) => std::slice::from_ref(range),
            Ranges::Many(ranges) => ranges,
        }
    }

    fn from_sorted(sorted: Vec<Range>) -> Self {
        match sorted.len() {
            0 => Ranges::Empty,
            1 => Ranges::One(sorted[0]),
            _ => Ranges::Many(Rc::new(sorted)),
        }
    }

    /// Merge two sorted range lists and one optional extra position.
    /// Callers charge the ancestry byte cap before calling this.
    fn combine(left: &Ranges, right: &Ranges, extra: Option<u32>) -> Ranges {
        let (a, b) = (left.as_slice(), right.as_slice());
        if a.is_empty() && b.is_empty() {
            return match extra {
                Some(position) => Ranges::One(Range {
                    first: position,
                    last: position,
                }),
                None => Ranges::Empty,
            };
        }
        let mut merged: Vec<Range> = Vec::with_capacity(a.len() + b.len() + 1);
        let (mut i, mut j) = (0, 0);
        let mut pending = extra.map(|position| Range {
            first: position,
            last: position,
        });
        let push = |range: Range, merged: &mut Vec<Range>| {
            if let Some(last) = merged.last_mut() {
                if range.first <= last.last.saturating_add(1) {
                    last.last = last.last.max(range.last);
                    return;
                }
            }
            merged.push(range);
        };
        loop {
            let next = match (a.get(i), b.get(j), pending) {
                (Some(x), Some(y), _) if x.first <= y.first => {
                    i += 1;
                    Some(*x)
                }
                (_, Some(y), _) => {
                    j += 1;
                    Some(*y)
                }
                (Some(x), None, _) => {
                    i += 1;
                    Some(*x)
                }
                (None, None, Some(range)) => {
                    pending = None;
                    Some(range)
                }
                (None, None, None) => None,
            };
            // The extra position must enter in sorted order, not last.
            let next = match (next, pending) {
                (Some(range), Some(single)) if single.first < range.first => {
                    // Requeue the range by stepping back is complex; handle by
                    // inserting the single first and processing range next.
                    // Instead, merge the single now and keep the range.
                    push(single, &mut merged);
                    pending = None;
                    Some(range)
                }
                (value, _) => value,
            };
            match next {
                Some(range) => push(range, &mut merged),
                None => break,
            }
        }
        Ranges::from_sorted(merged)
    }

    fn contains(&self, position: u32) -> bool {
        let ranges = self.as_slice();
        let index = ranges.partition_point(|range| range.first <= position);
        index > 0 && position <= ranges[index - 1].last
    }
}

/// Immutable layout shared by every closure in one graph. It is built
/// once per graph construction and never changes afterwards. Records
/// appended to a state live in that state's own extension (the `extra`
/// set on each closure), never in this shared layout, so a sibling
/// fork's appends are invisible here.
pub(crate) struct Space {
    index: BTreeMap<String, u32>,
    ids: Vec<String>,
}

impl Space {
    pub fn new(nodes: &BTreeMap<String, Node>) -> Rc<Self> {
        let mut by_issuer: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
        for node in nodes.values() {
            by_issuer
                .entry(node.issuer.as_str())
                .or_default()
                .push(node.id.as_str());
        }
        let mut index: BTreeMap<String, u32> = BTreeMap::new();
        let mut ids: Vec<String> = Vec::with_capacity(nodes.len());
        for (_, members) in by_issuer {
            let member_set: BTreeSet<&str> = members.iter().copied().collect();
            let mut children: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
            let mut waiting: BTreeMap<&str, usize> = BTreeMap::new();
            let mut ready: BTreeSet<&str> = BTreeSet::new();
            for &id in &members {
                let node = &nodes[id];
                let mut count = 0;
                for previous in &node.previous {
                    if member_set.contains(previous.as_str()) && nodes.contains_key(previous) {
                        children.entry(previous.as_str()).or_default().push(id);
                        count += 1;
                    }
                }
                waiting.insert(id, count);
                if count == 0 {
                    ready.insert(id);
                }
            }
            let mut ordered: Vec<&str> = Vec::with_capacity(members.len());
            while let Some(id) = ready.pop_first() {
                ordered.push(id);
                for child in children.get(id).into_iter().flatten() {
                    let count = waiting.get_mut(child).unwrap();
                    *count -= 1;
                    if *count == 0 {
                        ready.insert(child);
                    }
                }
            }
            // Records in or below a cycle keep lexical order at the block end.
            let placed: BTreeSet<&str> = ordered.iter().copied().collect();
            for &id in &members {
                if !placed.contains(id) {
                    ordered.push(id);
                }
            }
            for id in ordered {
                index.insert(id.to_string(), ids.len() as u32);
                ids.push(id.to_string());
            }
        }
        Rc::new(Self { index, ids })
    }

    pub fn empty() -> Rc<Self> {
        Rc::new(Self {
            index: BTreeMap::new(),
            ids: Vec::new(),
        })
    }

    pub(crate) fn position(&self, id: &str) -> Option<u32> {
        self.index.get(id).copied()
    }

    pub fn len(&self) -> usize {
        self.ids.len()
    }

    pub(crate) fn id_at(&self, position: u32) -> String {
        self.ids[position as usize].clone()
    }
}

/// A set of record IDs stored as layout ranges, plus an `extra` set
/// for records appended to this state (they have no shared-layout
/// position). `fresh_ranges` is the range count this set's members
/// would have in a fresh layout; the graph maintains it after every
/// construction so cap charges match a full build exactly.
#[derive(Clone)]
pub(crate) struct IdSet {
    space: Rc<Space>,
    ranges: Ranges,
    pub extra: BTreeSet<String>,
    pub fresh_ranges: usize,
}

impl IdSet {
    pub fn empty(space: Rc<Space>) -> Self {
        Self {
            space,
            ranges: Ranges::Empty,
            extra: BTreeSet::new(),
            fresh_ranges: 0,
        }
    }

    /// Union of the given sets plus one optional record, in one merge.
    /// A record with no layout position joins the `extra` set instead.
    pub fn combined(
        space: Rc<Space>,
        budget: &AncestryBudget,
        sets: &[&IdSet],
        own: Option<&str>,
    ) -> Self {
        let mut result = Self::empty(space);
        for set in sets {
            result.union(budget, set);
        }
        if let Some(id) = own {
            result.insert(budget, id);
        }
        result
    }

    pub fn contains(&self, id: &str) -> bool {
        self.extra.contains(id)
            || self
                .space
                .position(id)
                .is_some_and(|position| self.ranges.contains(position))
    }

    /// Charge for one combine over these inputs, at fresh-layout
    /// range counts, plus one allocation overhead.
    fn combine_charge(fresh_left: usize, fresh_right: usize, own: bool) -> usize {
        (fresh_left + fresh_right + usize::from(own)) * std::mem::size_of::<Range>() + 64
    }

    pub fn insert(&mut self, budget: &AncestryBudget, id: &str) {
        if budget.failed() || !budget.charge(Self::combine_charge(self.fresh_ranges, 0, true)) {
            self.ranges = Ranges::Empty;
            self.fresh_ranges = 0;
            return;
        }
        match self.space.position(id) {
            Some(position) => {
                self.ranges = Ranges::combine(&self.ranges, &Ranges::Empty, Some(position));
            }
            None => {
                self.extra.insert(id.to_string());
            }
        }
        self.fresh_ranges = self.range_count();
    }

    pub fn union(&mut self, budget: &AncestryBudget, other: &IdSet) {
        if budget.failed()
            || !budget.charge(Self::combine_charge(
                self.fresh_ranges,
                other.fresh_ranges,
                false,
            ))
        {
            self.ranges = Ranges::Empty;
            self.fresh_ranges = 0;
            self.extra.extend(other.extra.iter().cloned());
            return;
        }
        self.ranges = Ranges::combine(&self.ranges, &other.ranges, None);
        self.extra.extend(other.extra.iter().cloned());
        self.fresh_ranges = self.range_count();
    }

    pub fn extend(&mut self, budget: &AncestryBudget, other: IdSet) {
        self.union(budget, &other);
    }

    /// True when the union of the given sets covers every position in
    /// `[first, last]`. No allocation; callers charge a bound first.
    pub fn union_covers(sets: &[&IdSet], first: u32, last: u32) -> bool {
        let mut current = first;
        loop {
            let mut advanced = false;
            for set in sets {
                for range in set.ranges.as_slice() {
                    if range.first <= current && range.last >= current {
                        current = range.last.saturating_add(1);
                        advanced = true;
                    }
                }
            }
            if current > last {
                return true;
            }
            if !advanced {
                return false;
            }
        }
    }

    /// First position of each stored range, in layout order.
    pub fn range_starts(&self) -> impl Iterator<Item = u32> + '_ {
        self.ranges.as_slice().iter().map(|range| range.first)
    }

    /// True when a range strictly spans the insertion point: it holds
    /// members on both sides, so inserting there would split it.
    pub fn spans(&self, point: u32) -> bool {
        self.ranges
            .as_slice()
            .iter()
            .any(|range| range.first < point && range.last >= point)
    }

    /// Members in lexical order.
    #[cfg(test)]
    pub fn iter(&self) -> Vec<String> {
        let mut members: Vec<String> = Vec::new();
        for range in self.ranges.as_slice() {
            for position in range.first..=range.last {
                members.push(self.space.id_at(position));
            }
        }
        members.extend(self.extra.iter().cloned());
        members.sort_unstable();
        members
    }

    pub fn range_count(&self) -> usize {
        self.ranges.as_slice().len()
    }

    /// Members in layout order, produced one at a time. Callers that
    /// only test membership or stop at a match pay for what they scan.
    pub fn iter_unordered(&self) -> impl Iterator<Item = String> + '_ {
        self.ranges
            .as_slice()
            .iter()
            .flat_map(|range| range.first..=range.last)
            .map(|position| self.space.id_at(position))
            .chain(self.extra.iter().cloned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn space_for(ids: &[&str]) -> Rc<Space> {
        // All records share one issuer, so the layout order is the
        // lexical order of the given (sorted) ids.
        let nodes: BTreeMap<String, Node> = ids
            .iter()
            .map(|id| {
                (
                    id.to_string(),
                    Node {
                        id: id.to_string(),
                        issuer: "issuer".into(),
                        previous: Vec::new(),
                        action: serde_json::json!({"kind":"identity.merge"}),
                        kind: "identity.merge".into(),
                        semantic: true,
                        body_hash: None,
                        body: None,
                        body_label: "absent".into(),
                    },
                )
            })
            .collect();
        Space::new(&nodes)
    }

    fn set(space: &Rc<Space>, ids: &[&str]) -> IdSet {
        let budget = AncestryBudget::new();
        let mut result = IdSet::empty(space.clone());
        for id in ids {
            result.insert(&budget, id);
        }
        result
    }

    #[test]
    fn ranges_merge_and_report_membership() {
        let names: Vec<String> = (0..64).map(|i| format!("id{i:03}")).collect();
        let refs: Vec<&str> = names.iter().map(String::as_str).collect();
        let space = space_for(&refs);
        let cases: Vec<Vec<&str>> = vec![
            vec![],
            vec!["id000"],
            vec!["id000", "id001", "id002", "id010", "id063"],
            refs.clone(),
        ];
        for left in &cases {
            for right in &cases {
                let budget = AncestryBudget::new();
                let mut combined = set(&space, left);
                combined.union(&budget, &set(&space, right));
                let expected: BTreeSet<&str> = left.iter().chain(right).copied().collect();
                assert_eq!(
                    combined.iter(),
                    expected.iter().map(|s| s.to_string()).collect::<Vec<_>>()
                );
                for name in &names {
                    assert_eq!(combined.contains(name), expected.contains(name.as_str()));
                }
                assert!(!combined.contains("absent"));
            }
        }
    }

    #[test]
    fn ancestry_budget_boundary_is_exact() {
        let budget = AncestryBudget::new();
        assert!(budget.charge(MAX_ANCESTOR_BYTES - 1));
        assert!(!budget.failed());
        assert!(budget.charge(1));
        assert_eq!(budget.bytes(), MAX_ANCESTOR_BYTES);
        assert!(!budget.failed());
        assert!(!budget.charge(1));
        assert!(budget.failed());
        // A combine past the cap allocates nothing and yields no ranges.
        let space = Space::empty();
        let mut set = IdSet::empty(space.clone());
        set.insert(&budget, "jve1:a");
        assert_eq!(set.range_count(), 0);
        assert!(!set.contains("jve1:a"));
    }

    #[test]
    fn a_chain_closure_is_one_range() {
        let names: Vec<String> = (0..100).map(|i| format!("id{i:03}")).collect();
        let refs: Vec<&str> = names.iter().map(String::as_str).collect();
        let space = space_for(&refs);
        let all = set(&space, &refs);
        assert_eq!(all.range_count(), 1);
        assert_eq!(all.iter().len(), 100);
    }
}
