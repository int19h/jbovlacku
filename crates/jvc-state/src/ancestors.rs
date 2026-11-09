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
use std::cell::{Cell, RefCell};
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
    /// The caller charges the logical budget; this charges the ancestry
    /// byte cap before allocating, and yields no ranges past the cap.
    fn combine(space: &Space, left: &Ranges, right: &Ranges, extra: Option<u32>) -> Ranges {
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
        let inputs = a.len() + b.len() + usize::from(extra.is_some());
        if !space.charge_ancestor_bytes(inputs * std::mem::size_of::<Range>() + 64) {
            return Ranges::Empty;
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

/// Shared layout for every closure in one graph. Appended records register
/// at the end, after all of their predecessors, until the next rebuild.
pub(crate) struct Space {
    index: RefCell<BTreeMap<String, u32>>,
    ids: RefCell<Vec<String>>,
    ancestor_bytes: Cell<usize>,
    ancestor_failed: Cell<bool>,
    /// Layout positions present at construction. Appended records take
    /// later positions as one extra segment.
    base_len: u32,
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
        let base_len = ids.len() as u32;
        Rc::new(Self {
            index: RefCell::new(index),
            ids: RefCell::new(ids),
            ancestor_bytes: Cell::new(0),
            ancestor_failed: Cell::new(false),
            base_len,
        })
    }

    pub fn empty() -> Rc<Self> {
        Rc::new(Self {
            index: RefCell::new(BTreeMap::new()),
            ids: RefCell::new(Vec::new()),
            ancestor_bytes: Cell::new(0),
            ancestor_failed: Cell::new(false),
            base_len: 0,
        })
    }

    fn charge_ancestor_bytes(&self, bytes: usize) -> bool {
        if self.ancestor_failed.get()
            || bytes > MAX_ANCESTOR_BYTES.saturating_sub(self.ancestor_bytes.get())
        {
            self.ancestor_failed.set(true);
            false
        } else {
            self.ancestor_bytes.set(self.ancestor_bytes.get() + bytes);
            true
        }
    }

    pub fn ancestor_failed(&self) -> bool {
        self.ancestor_failed.get()
    }

    #[cfg(test)]
    pub fn ancestor_bytes(&self) -> usize {
        self.ancestor_bytes.get()
    }

    fn position(&self, id: &str) -> Option<u32> {
        self.index.borrow().get(id).copied()
    }

    fn register(&self, id: &str) -> u32 {
        if let Some(position) = self.position(id) {
            return position;
        }
        let mut index = self.index.borrow_mut();
        let mut ids = self.ids.borrow_mut();
        let position = ids.len() as u32;
        index.insert(id.to_string(), position);
        ids.push(id.to_string());
        position
    }

    fn id_at(&self, position: u32) -> String {
        self.ids.borrow()[position as usize].clone()
    }
}

/// A set of record IDs stored as layout ranges.
#[derive(Clone)]
pub(crate) struct IdSet {
    space: Rc<Space>,
    ranges: Ranges,
}

impl IdSet {
    pub fn empty(space: Rc<Space>) -> Self {
        Self {
            space,
            ranges: Ranges::Empty,
        }
    }

    /// Union of the given sets plus one optional record, in one merge.
    pub fn combined(space: Rc<Space>, sets: &[&IdSet], own: Option<&str>) -> Self {
        let mut ranges = Ranges::Empty;
        for set in sets {
            ranges = Ranges::combine(&space, &ranges, &set.ranges, None);
        }
        let extra = own.map(|id| space.register(id));
        ranges = Ranges::combine(&space, &ranges, &Ranges::Empty, extra);
        Self { space, ranges }
    }

    pub fn contains(&self, id: &str) -> bool {
        self.space
            .position(id)
            .is_some_and(|position| self.ranges.contains(position))
    }

    pub fn insert(&mut self, id: &str) {
        let position = self.space.register(id);
        self.ranges = Ranges::combine(&self.space, &self.ranges, &Ranges::Empty, Some(position));
    }

    pub fn union(&mut self, other: &IdSet) {
        self.ranges = Ranges::combine(&self.space, &self.ranges, &other.ranges, None);
    }

    pub fn extend(&mut self, other: IdSet) {
        self.union(&other);
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
        members.sort_unstable();
        members
    }

    pub fn range_count(&self) -> usize {
        self.ranges.as_slice().len()
    }

    /// Range count this set would have in a fresh layout. Appended
    /// records form one extra segment at the end, which a fresh layout
    /// merges into their issuer block, so it is not counted.
    pub fn fresh_range_count(&self) -> usize {
        let ranges = self.ranges.as_slice();
        if ranges.len() >= 2
            && ranges
                .last()
                .is_some_and(|last| last.first >= self.space.base_len)
        {
            ranges.len() - 1
        } else {
            ranges.len()
        }
    }

    /// Members in layout order, produced one at a time. Callers that
    /// only test membership or stop at a match pay for what they scan.
    pub fn iter_unordered(&self) -> impl Iterator<Item = String> {
        let ranges: Vec<Range> = self.ranges.as_slice().to_vec();
        let space = self.space.clone();
        ranges
            .into_iter()
            .flat_map(|range| range.first..=range.last)
            .map(move |position| space.id_at(position))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn space_for(ids: &[&str]) -> Rc<Space> {
        // Build a layout directly from positions in the given order.
        let space = Space::empty();
        for id in ids {
            space.register(id);
        }
        space
    }

    fn set(space: &Rc<Space>, ids: &[&str]) -> IdSet {
        let mut result = IdSet::empty(space.clone());
        for id in ids {
            result.insert(id);
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
                let mut combined = set(&space, left);
                combined.union(&set(&space, right));
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
    fn a_chain_closure_is_one_range() {
        let names: Vec<String> = (0..100).map(|i| format!("id{i:03}")).collect();
        let refs: Vec<&str> = names.iter().map(String::as_str).collect();
        let space = space_for(&refs);
        let all = set(&space, &refs);
        assert_eq!(all.range_count(), 1);
        assert_eq!(all.iter().len(), 100);
    }
}
