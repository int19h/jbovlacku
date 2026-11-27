use super::{Closure, Graph, Node};
use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Mode {
    Structural,
    Accepted,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct Operand {
    record: usize,
    mode: Mode,
}

struct Record<'a> {
    node: &'a Node,
    structural: &'a Closure,
    accepted: &'a Closure,
}

impl<'a> Record<'a> {
    fn closure(&self, mode: Mode) -> &'a Closure {
        match mode {
            Mode::Structural => self.structural,
            Mode::Accepted => self.accepted,
        }
    }
}

/// Each group contains all potential operands for one maxima call.
#[derive(PartialEq, Eq, Hash)]
enum MaximaKey {
    NativeStatus(String),
    ImportedStatus(String, String),
    Register(String),
    Claims(String, Mode),
    CurrentObservations(String, String),
    HistoricalObservations(String),
}

pub(super) fn is_carry_candidate(node: &Node) -> bool {
    node.semantic
        && node.kind == "account.set"
        && node.action.view().index("value") == "claim"
        && node
            .action
            .view()
            .index("carry")
            .as_array()
            .is_some_and(|carry| carry.len() >= 3)
}

fn collect_scopes(graph: &Graph, records: &[Record<'_>]) -> Vec<Vec<Operand>> {
    let linked = !Rc::ptr_eq(&graph.own, &graph.structural);
    let mut actors = HashMap::new();
    if linked {
        for (key, actor) in &graph.lifecycle.key_actor {
            actors.insert(key.as_str(), actor.as_str());
        }
    }

    let mut ids = HashMap::new();
    if graph.has_carry {
        for (index, record) in records.iter().enumerate() {
            ids.insert(record.node.id.as_str(), index);
        }
    }

    let mut maxima: HashMap<MaximaKey, Vec<Operand>> = HashMap::new();
    let mut scopes = Vec::new();
    for (index, record) in records.iter().enumerate() {
        let node = record.node;
        if !node.semantic {
            continue;
        }
        let register = linked
            .then(|| crate::RegisterKind::for_action(&node.kind))
            .flatten();
        let is_carry = graph.has_carry && is_carry_candidate(node);
        let is_status = linked && matches!(node.kind.as_str(), "status.set" | "import.status");
        if register.is_none() && !is_carry && !is_status {
            continue;
        }
        if is_carry {
            let mut prefix: Vec<_> = node
                .action
                .view()
                .index("carry")
                .as_array()
                .unwrap()
                .filter_map(|value| ids.get(value.as_str()?).copied())
                .collect();
            // Only a present head reads the prior accumulator. Drop
            // its last occurrence before deduplicating the prefix.
            prefix.pop();
            let mut seen = HashSet::new();
            prefix.retain(|&index| seen.insert(index));
            if prefix.len() >= 2 {
                scopes.push(
                    prefix
                        .into_iter()
                        .map(|record| Operand {
                            record,
                            mode: Mode::Structural,
                        })
                        .collect(),
                );
            }
        }
        if !linked {
            continue;
        }

        let issuer = actors
            .get(node.issuer.as_str())
            .copied()
            .unwrap_or(&node.issuer);
        let mut add = |key, mode| {
            maxima.entry(key).or_default().push(Operand {
                record: index,
                mode,
            });
        };
        if let Some(kind) = register {
            let key = kind.key(node, issuer, |subject| {
                actors.get(subject).copied().unwrap_or(subject).to_owned()
            });
            add(MaximaKey::Register(key), Mode::Accepted);
        }
        let field = |name| {
            node.action
                .view()
                .index(name)
                .as_str()
                .unwrap_or_default()
                .to_owned()
        };
        match node.kind.as_str() {
            "status.set" => add(MaximaKey::NativeStatus(field("target")), Mode::Structural),
            "import.status" => add(
                MaximaKey::ImportedStatus(field("target"), field("claim")),
                Mode::Structural,
            ),
            "account.set" => {
                if let Some(account) = crate::accounts::account(node) {
                    let token = account.token();
                    for mode in [Mode::Accepted, Mode::Structural] {
                        add(MaximaKey::Claims(token.clone(), mode), mode);
                    }
                }
            }
            "account.observe" => {
                if let Some(account) = crate::accounts::account(node) {
                    let token = account.token();
                    add(
                        MaximaKey::CurrentObservations(token.clone(), issuer.to_owned()),
                        Mode::Accepted,
                    );
                    add(MaximaKey::HistoricalObservations(token), Mode::Structural);
                }
            }
            _ => {}
        }
    }
    scopes.extend(maxima.into_values().filter(|scope| scope.len() >= 3));
    scopes
}

struct Scopes<'a> {
    handles: Vec<&'a Closure>,
    memberships: Vec<Vec<usize>>,
    incidences: u128,
    unique_ranges: u128,
    repeated_ranges: u128,
}

impl<'a> Scopes<'a> {
    fn new(records: &[Record<'a>], scopes: Vec<Vec<Operand>>) -> Self {
        let mut dense = HashMap::new();
        let mut result = Self {
            handles: Vec::new(),
            memberships: Vec::new(),
            incidences: 0,
            unique_ranges: 0,
            repeated_ranges: 0,
        };
        for scope in scopes {
            let issuer = &records[scope[0].record].node.issuer;
            if scope.iter().all(|operand| {
                let record = &records[operand.record];
                record.node.issuer == *issuer && !record.closure(operand.mode).mixed
            }) {
                continue;
            }
            result.incidences += scope.len() as u128;
            result.memberships.push(
                scope
                    .into_iter()
                    .map(|operand| {
                        let closure = records[operand.record].closure(operand.mode);
                        let ranges = closure.ids.range_count() as u128;
                        result.repeated_ranges += ranges;
                        *dense.entry(operand).or_insert_with(|| {
                            result.unique_ranges += ranges;
                            let handle = result.handles.len();
                            result.handles.push(closure);
                            handle
                        })
                    })
                    .collect(),
            );
        }
        result
    }
}

/// Marks for the issuer gaps where one scope has a range that ends
/// just before the gap and another range that starts at it.
///
/// The index is input handling. It is not charged to the work meter
/// or to the fast-path eligibility fuel. Its construction is linear
/// work. It makes a table of the records. With a carry candidate, one
/// pass indexes the record IDs, and another groups the records into
/// scopes. Then it takes either the direct scan, which visits at most
/// `2(H + U)` ranges, or at most three reads of each distinct stored
/// range list. `H` counts scope incidences and `U` counts distinct
/// stored ranges. A graph
/// builds it at most once, before its first
/// eligible append. A later append on the same layout reuses it. A
/// rebuilt graph builds a new one, and that rebuild already does
/// linear work over the same records. So the guard adds at most a
/// constant factor to the work of each graph build, and it never
/// rescans retained records per append. The stored mixed-closure
/// charge `C + 2R + 2B` stays part of the canonical work.
pub(super) enum JoinIndex {
    Empty,
    Direct(Vec<u32>),
    /// Common endpoint hits that still need the scope test. Each
    /// candidate lists the handles that touch it, and each handle
    /// lists its scopes. A query reads only the lists for its gap.
    Refine {
        candidates: Vec<(u32, Cell<Option<bool>>)>,
        /// Offsets into `touches`, one per candidate plus an end.
        touch_starts: Vec<usize>,
        /// A handle and its side: 1 starts at the gap, 2 ends before it.
        touches: Vec<(u32, u8)>,
        /// Offsets into `scopes`, one per handle plus an end.
        scope_starts: Vec<usize>,
        scopes: Vec<u32>,
    },
}

impl JoinIndex {
    pub(super) fn build(graph: &Graph) -> Self {
        debug_assert!(graph.appended_rank.is_empty());
        #[cfg(test)]
        BUILDS.with(|builds| builds.set(builds.get() + 1));
        let blocks = graph.space.block_starts().len();
        if blocks < 2 {
            return Self::Empty;
        }
        let records: Vec<_> = graph
            .nodes
            .values()
            .zip(graph.structural.values())
            .zip(graph.accepted.values())
            .map(|((node, structural), accepted)| Record {
                node,
                structural,
                accepted,
            })
            .collect();
        let scopes = Scopes::new(&records, collect_scopes(graph, &records));
        Self::mark_scopes(graph, blocks - 1, scopes)
    }

    fn mark_scopes(graph: &Graph, gaps: usize, scopes: Scopes<'_>) -> Self {
        if scopes.memberships.is_empty() {
            return Self::Empty;
        }

        // The direct path visits each scope's ranges. Repeated wide
        // handles can make that sum large. The common path instead
        // reads each distinct handle's ranges once to find candidate
        // gaps, and twice more to place the touches if any candidate
        // exists. So it visits at most three times the distinct ranges.
        let direct = scopes.repeated_ranges <= 2 * (scopes.incidences + scopes.unique_ranges);
        // Zero means that no issuer gap starts at this position.
        let mut gap_at = vec![0u32; graph.space.len()];
        for (index, position) in graph.space.block_starts().skip(1).enumerate() {
            gap_at[position as usize] = index as u32 + 1;
        }
        let gap_of = |position: u32| match gap_at.get(position as usize) {
            Some(&gap) if gap != 0 => Some(gap as usize - 1),
            _ => None,
        };
        let mut sides = vec![0u8; gaps];
        let mut marks = vec![false; gaps];
        if direct {
            let mut touched = Vec::new();
            for scope in &scopes.memberships {
                for &handle in scope {
                    for (position, side) in endpoints(scopes.handles[handle]) {
                        if let Some(index) = gap_of(position) {
                            if sides[index] == 0 {
                                touched.push(index);
                            }
                            sides[index] |= side;
                        }
                    }
                }
                for index in touched.drain(..) {
                    marks[index] |= sides[index] == 3;
                    sides[index] = 0;
                }
            }
            return Self::Direct(marked(graph, marks.into_iter()).collect());
        }

        for closure in &scopes.handles {
            for (position, side) in endpoints(closure) {
                if let Some(index) = gap_of(position) {
                    sides[index] |= side;
                }
            }
        }
        // Dense candidate numbers by gap. Zero means no candidate.
        let mut candidate_at = vec![0u32; gaps];
        let mut candidates = Vec::new();
        for ((index, side), position) in sides
            .iter()
            .enumerate()
            .zip(graph.space.block_starts().skip(1))
        {
            if *side == 3 {
                candidates.push((position, Cell::new(None)));
                candidate_at[index] = candidates.len() as u32;
            }
        }
        if candidates.is_empty() {
            return Self::Empty;
        }
        drop(sides);

        // Count, then place, the touches at candidate gaps. Each pass
        // reads every distinct handle's ranges once.
        let mut touch_starts = vec![0usize; candidates.len() + 1];
        let candidate_of = |position: u32| {
            gap_of(position)
                .map(|index| candidate_at[index])
                .filter(|&candidate| candidate != 0)
                .map(|candidate| candidate as usize - 1)
        };
        for closure in &scopes.handles {
            for (position, _) in endpoints(closure) {
                if let Some(candidate) = candidate_of(position) {
                    touch_starts[candidate + 1] += 1;
                }
            }
        }
        for index in 1..touch_starts.len() {
            touch_starts[index] += touch_starts[index - 1];
        }
        let mut next = touch_starts.clone();
        let mut touches = vec![(0u32, 0u8); touch_starts[candidates.len()]];
        for (handle, closure) in scopes.handles.iter().enumerate() {
            for (position, side) in endpoints(closure) {
                if let Some(candidate) = candidate_of(position) {
                    touches[next[candidate]] = (handle as u32, side);
                    next[candidate] += 1;
                }
            }
        }

        // Invert the scope memberships into one scope list per handle.
        let mut scope_starts = vec![0usize; scopes.handles.len() + 1];
        for scope in &scopes.memberships {
            for &handle in scope {
                scope_starts[handle + 1] += 1;
            }
        }
        for index in 1..scope_starts.len() {
            scope_starts[index] += scope_starts[index - 1];
        }
        let mut next = scope_starts.clone();
        let mut members = vec![0u32; scope_starts[scopes.handles.len()]];
        for (scope, handles) in scopes.memberships.iter().enumerate() {
            for &handle in handles {
                members[next[handle]] = scope as u32;
                next[handle] += 1;
            }
        }
        Self::Refine {
            candidates,
            touch_starts,
            touches,
            scope_starts,
            scopes: members,
        }
    }

    pub(super) fn splits(&self, position: u32) -> bool {
        match self {
            Self::Empty => false,
            Self::Direct(marks) => marks.binary_search(&position).is_ok(),
            Self::Refine {
                candidates,
                touch_starts,
                touches,
                scope_starts,
                scopes,
            } => {
                let Ok(index) = candidates.binary_search_by_key(&position, |&(gap, _)| gap) else {
                    return false;
                };
                let answer = &candidates[index].1;
                if let Some(splits) = answer.get() {
                    return splits;
                }
                // Only the handles with an endpoint at this gap take
                // part. Each one appears at most once per side, so this
                // reads at most the scope lists of those handles.
                let touches = &touches[touch_starts[index]..touch_starts[index + 1]];
                let scopes_of = |handle: u32| {
                    #[cfg(test)]
                    REFINE_READS.with(|reads| reads.set(reads.get() + 1));
                    let handle = handle as usize;
                    &scopes[scope_starts[handle]..scope_starts[handle + 1]]
                };
                let left: HashSet<u32> = touches
                    .iter()
                    .filter(|&&(_, side)| side == 2)
                    .flat_map(|&(handle, _)| scopes_of(handle).iter().copied())
                    .collect();
                let splits = touches
                    .iter()
                    .filter(|&&(_, side)| side == 1)
                    .any(|&(handle, _)| scopes_of(handle).iter().any(|scope| left.contains(scope)));
                answer.set(Some(splits));
                splits
            }
        }
    }
}

/// Range endpoints with their side: 1 starts a range, and 2 is the
/// position after its end.
fn endpoints(closure: &Closure) -> impl Iterator<Item = (u32, u8)> + '_ {
    closure.ids.ranges().flat_map(|(first, last)| {
        #[cfg(test)]
        RANGE_VISITS.with(|visits| visits.set(visits.get() + 1));
        [(first, 1u8), (last + 1, 2u8)]
    })
}

fn marked<'a>(
    graph: &'a Graph,
    marks: impl Iterator<Item = bool> + 'a,
) -> impl Iterator<Item = u32> + 'a {
    graph
        .space
        .block_starts()
        .skip(1)
        .zip(marks)
        .filter_map(|(gap, mark)| mark.then_some(gap))
}

/// Asserts that every recorded priced union either stays inside one
/// issuer block or lies inside one collected scope of the same mode.
/// Mode 0 is own ancestry, 1 is structural and 2 is accepted.
#[cfg(test)]
pub(crate) fn assert_priced_unions_in_scopes(
    graph: &Graph,
    unions: &[(u8, std::collections::BTreeSet<String>)],
) -> usize {
    let records: Vec<_> = graph
        .nodes
        .values()
        .map(|node| Record {
            node,
            structural: &graph.structural[&node.id],
            accepted: &graph.accepted[&node.id],
        })
        .collect();
    let scopes: Vec<(Mode, HashSet<&str>)> = collect_scopes(graph, &records)
        .into_iter()
        .filter_map(|scope| {
            let mode = scope.first()?.mode;
            assert!(scope.iter().all(|operand| operand.mode == mode));
            Some((
                mode,
                scope
                    .iter()
                    .map(|operand| records[operand.record].node.id.as_str())
                    .collect(),
            ))
        })
        .collect();
    let mut scoped = 0;
    for (mode, operands) in unions {
        let cache = match mode {
            0 => &graph.own,
            1 => &graph.structural,
            _ => &graph.accepted,
        };
        let issuer = &graph.nodes[operands.first().unwrap()].issuer;
        if operands
            .iter()
            .all(|id| graph.nodes[id].issuer == *issuer && !cache[id].mixed)
        {
            continue;
        }
        let mode = match mode {
            1 => Mode::Structural,
            2 => Mode::Accepted,
            _ => panic!("own-mode union crosses an issuer block: {operands:?}"),
        };
        assert!(
            scopes.iter().any(|(scope_mode, members)| {
                // Without acceptance events the caches are shared, and
                // both modes read the same closures.
                (*scope_mode == mode || Rc::ptr_eq(&graph.structural, &graph.accepted))
                    && operands.iter().all(|id| members.contains(id.as_str()))
            }),
            "priced {mode:?} union outside every scope: {operands:?}"
        );
        scoped += 1;
    }
    scoped
}

#[cfg(test)]
thread_local! {
    static RANGE_VISITS: Cell<usize> = const { Cell::new(0) };
    static REFINE_READS: Cell<usize> = const { Cell::new(0) };
    static BUILDS: Cell<usize> = const { Cell::new(0) };
}

#[cfg(test)]
pub(crate) fn builds() -> usize {
    BUILDS.with(Cell::get)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CompactValue, Limits};
    use serde_json::{Value, json};
    use std::collections::BTreeMap;

    fn node(id: &str, issuer: &str, parents: &[&str], action: Value) -> Node {
        Node {
            id: id.into(),
            issuer: issuer.into(),
            previous: parents.iter().map(|id| (*id).into()).collect(),
            kind: action["kind"].as_str().unwrap().into(),
            action: CompactValue::from(&action),
            semantic: true,
            body_hash: None,
            body: None,
            body_label: "absent".into(),
        }
    }

    fn records(graph: &Graph) -> Vec<Record<'_>> {
        graph
            .nodes
            .values()
            .map(|node| Record {
                node,
                structural: &graph.structural[&node.id],
                accepted: &graph.accepted[&node.id],
            })
            .collect()
    }

    fn oracle(graph: &Graph, records: &[Record<'_>], scopes: &[Vec<Operand>], gap: u32) -> bool {
        // Insert one nonmember into the full layout, then count each
        // union from scratch. This oracle needs no range endpoints.
        let positioned: Vec<_> = (0..graph.space.len() as u32)
            .map(|position| Some(graph.space.id_at_ref(position)))
            .collect();
        let mut fresh = positioned.clone();
        fresh.insert(gap as usize, None);
        scopes.iter().any(|scope| {
            let count = |layout: &[Option<&str>]| {
                let mut previous = false;
                let mut runs = 0;
                for id in layout {
                    let included = id.is_some_and(|id| {
                        scope.iter().any(|operand| {
                            records[operand.record]
                                .closure(operand.mode)
                                .ids
                                .contains(id)
                        })
                    });
                    runs += usize::from(included && !previous);
                    previous = included;
                }
                runs
            };
            count(&fresh) > count(&positioned)
        })
    }

    fn repeated_carries(join: bool, repeated: bool) -> Graph {
        let mut nodes = BTreeMap::new();
        let mut add = |record: Node| {
            nodes.insert(record.id.clone(), record);
        };
        for i in 0..256 {
            let id = format!("n-{i:03}");
            let parent = (i >= 2).then(|| format!("n-{:03}", i - 2));
            let parents: Vec<_> = parent.as_deref().into_iter().collect();
            add(node(&id, "a", &parents, json!({"kind":"identity.merge"})));
        }
        for (id, issuer) in [("root-b", "b"), ("root-c", "c"), ("zz", "z")] {
            add(node(id, issuer, &[], json!({"kind":"identity.merge"})));
        }
        // Every carry has a present final head. The first two heads
        // live in one scope, even when two claims repeat a wide head.
        for i in 0..if repeated { 8 } else { 2 } {
            let head = if i % 2 == 0 { "root-b" } else { "root-c" };
            add(node(
                &format!("claim-{i}"),
                "z",
                &[],
                json!({
                    "kind":"account.set","origin":"https://fixture.example","account":i+1,
                    "value":"claim","previous":"initial","carry":["n-254",head,"zz"]
                }),
            ));
        }
        if join {
            add(node(
                "claim-join",
                "z",
                &[],
                json!({
                    "kind":"account.set","origin":"https://fixture.example","account":100,
                    "value":"claim","previous":"initial","carry":["root-b","root-c","zz"]
                }),
            ));
        }
        Graph::new(nodes, &Limits::default())
    }

    #[test]
    fn every_gap_matches_the_neighbor_oracle_with_direct_and_common_marks() {
        for (repeated, join) in [(false, false), (false, true), (true, false), (true, true)] {
            let graph = repeated_carries(join, repeated);
            assert!(!graph.resource.get());
            // This graph has no accepted links. The carry trigger
            // alone must still make the temporary index available.
            assert!(Rc::ptr_eq(&graph.own, &graph.accepted));
            assert!(graph.join_index.as_ref().unwrap().get().is_none());
            let records = records(&graph);
            let scopes = collect_scopes(&graph, &records);
            let counts = Scopes::new(&records, scopes.clone());
            // The build reads no fuel. An empty budget gives the same
            // index and leaves the budget untouched.
            let fuel = graph.budget.replace(0);
            let before = RANGE_VISITS.with(Cell::get);
            let index = JoinIndex::build(&graph);
            let read = RANGE_VISITS.with(Cell::get) - before;
            assert_eq!(graph.budget.get(), 0);
            assert!(!graph.resource.get());
            graph.budget.set(fuel);
            if repeated {
                assert!(matches!(index, JoinIndex::Refine { .. }));
                // One pass finds the common hits, and two more place
                // the touches at candidate gaps. None repeats a handle
                // per scope.
                assert!(read as u128 <= 3 * counts.unique_ranges);
                assert!(counts.repeated_ranges > 3 * counts.unique_ranges);
            } else {
                assert!(matches!(index, JoinIndex::Direct(_)));
                assert_eq!(read as u128, counts.repeated_ranges);
            }
            let target = graph.next_block_start("b");
            for gap in graph.space.block_starts().chain([graph.space.len() as u32]) {
                assert_eq!(
                    index.splits(gap) || graph.boundary.crosses(gap),
                    oracle(&graph, &records, &scopes, gap),
                    "gap {gap}"
                );
            }
            if repeated {
                // A memoized answer reads no scope lists again.
                let reads = REFINE_READS.with(Cell::get);
                assert_eq!(index.splits(target), join);
                assert_eq!(REFINE_READS.with(Cell::get), reads);
            }
            assert_eq!(index.splits(target), join);
        }
    }

    #[test]
    fn carry_scope_uses_present_prefix_before_deduplicating() {
        let history = [
            ("c-two", json!(["known-a", "known-b"])),
            ("c-absent-last", json!(["known-a", "known-b", "missing"])),
            ("c-unread-join", json!(["known-a", "known-a", "known-b"])),
            ("c-duplicate-last", json!(["known-a", "known-b", "known-b"])),
            (
                "c-missing-inside",
                json!(["known-a", "missing", "known-b", "known-c"]),
            ),
        ];
        let mut nodes = BTreeMap::new();
        for (id, issuer) in [("known-a", "a"), ("known-b", "b"), ("known-c", "c")] {
            nodes.insert(
                id.into(),
                node(id, issuer, &[], json!({"kind":"identity.merge"})),
            );
        }
        for (id, carry) in history {
            nodes.insert(
                id.into(),
                node(
                    id,
                    "d",
                    &[],
                    json!({
                        "kind":"account.set","origin":"https://fixture.example","account":1,
                        "value":"claim","previous":"initial","carry":carry,
                    }),
                ),
            );
        }
        let graph = Graph::new(nodes, &Limits::default());
        let records = records(&graph);
        let scopes = collect_scopes(&graph, &records);
        assert_eq!(scopes.len(), 2);
        for scope in scopes {
            assert_eq!(scope.len(), 2);
            assert!(scope.iter().all(|head| head.mode == Mode::Structural));
            let ids: Vec<_> = scope
                .iter()
                .map(|head| records[head.record].node.id.as_str())
                .collect();
            assert_eq!(ids, ["known-a", "known-b"]);
        }
        assert!(graph.splits_layout(graph.next_block_start("a"), "a"));
        assert!(!graph.splits_layout(graph.next_block_start("b"), "b"));
    }

    #[test]
    fn dominated_status_still_prices_a_subset_after_a_join() {
        let status = json!({"kind":"status.set","target":"publication","value":"deprecated"});
        let history = [
            node("1-old", "a", &[], status.clone()),
            node(
                "transfer",
                "a",
                &["1-old"],
                json!({"kind":"identity.transfer","successor":"b"}),
            ),
            node(
                "accept",
                "b",
                &[],
                json!({"kind":"identity.accept","transfer":"transfer"}),
            ),
            node("new", "b", &["accept"], status.clone()),
            node("0-other", "c", &[], status),
        ];
        let mut history: BTreeMap<_, _> = history.into_iter().map(|n| (n.id.clone(), n)).collect();
        let original = Graph::new(history.clone(), &Limits::default());
        let gap = original.next_block_start("b");
        assert!(!original.boundary.crosses(gap));
        assert!(original.splits_layout(gap, "bb"));

        let inserted = node("inserted", "bb", &[], json!({"kind":"identity.merge"}));
        history.insert(inserted.id.clone(), inserted);
        let fresh = Graph::new(history, &Limits::default());
        let price = |graph: &Graph| {
            let before = graph.budget.get();
            let heads = graph.maxima(
                ["0-other", "1-old", "new"]
                    .into_iter()
                    .map(str::to_owned)
                    .collect(),
                true,
            );
            assert_eq!(
                heads,
                ["0-other".into(), "new".into()].into_iter().collect()
            );
            before - graph.budget.get()
        };
        assert_eq!(price(&fresh), price(&original) + 1);
    }

    #[test]
    fn a_foreign_safe_head_does_not_supply_a_priced_cutoff() {
        let history = [
            node("local", "a", &[], json!({"kind":"identity.merge"})),
            node("foreign", "b", &[], json!({"kind":"identity.merge"})),
            node(
                "cutoff",
                "a",
                &["local"],
                json!({"kind":"identity.compromise","safe":["foreign"]}),
            ),
        ];
        let history: BTreeMap<_, _> = history.into_iter().map(|n| (n.id.clone(), n)).collect();
        let graph = Graph::new(history, &Limits::default());
        assert!(!graph.resource.get());
        assert!(graph.cutoffs.is_empty());
        assert!(graph.join_index.is_none());
        assert!(!graph.splits_layout(graph.next_block_start("a"), "ab"));
    }

    #[test]
    fn groups_cover_all_maxima_callers_and_keep_import_periods_apart() {
        let mut nodes = BTreeMap::new();
        let mut add = |record: Node| {
            nodes.insert(record.id.clone(), record);
        };
        add(node(
            "accept",
            "a",
            &[],
            json!({"kind":"identity.accept","transfer":"missing"}),
        ));
        for (i, issuer) in ["a", "b", "c"].into_iter().enumerate() {
            add(node(
                &format!("native-{i}"),
                issuer,
                &[],
                json!({
                    "kind":"status.set","target":"native","value":"deprecated"
                }),
            ));
            add(node(
                &format!("import-{i}"),
                issuer,
                &[],
                json!({
                    "kind":"import.status","target":"import","claim":"period-1","value":"deprecated"
                }),
            ));
            add(node(
                &format!("claim-{i}"),
                issuer,
                &[],
                json!({
                    "kind":"account.set","origin":"https://fixture.example","account":1,"value":"clear"
                }),
            ));
            add(node(
                &format!("observe-{i}"),
                issuer,
                &[],
                json!({
                    "kind":"account.observe","origin":"https://fixture.example","account":1,
                    "claim":format!("claim-{i}"),"result":"present"
                }),
            ));
            add(node(
                &format!("judgment-{i}"),
                issuer,
                &[],
                json!({
                    "kind":"judgment.set","target":"native","value":"bless"
                }),
            ));
        }
        for i in 0..2 {
            add(node(
                &format!("other-{i}"),
                "c",
                &[],
                json!({
                    "kind":"import.status","target":"import","claim":"period-2","value":"deprecated"
                }),
            ));
        }
        let mut graph = Graph::new(nodes, &Limits::default());
        // Set one actor across keys to test actual actor grouping.
        for issuer in ["a", "b", "c"] {
            graph.lifecycle.key_actor.insert(issuer.into(), "a".into());
        }
        let rows = records(&graph);
        let scopes = collect_scopes(&graph, &rows);
        assert_eq!(scopes.len(), 9);
        for (prefix, accepted, structural) in [
            ("native-", 0, 1),
            ("import-", 0, 1),
            ("claim-", 2, 1),
            ("observe-", 2, 1),
            ("judgment-", 1, 0),
            ("other-", 0, 0),
        ] {
            let count = |mode| {
                scopes
                    .iter()
                    .filter(|scope| {
                        scope.len() == 3
                            && scope.iter().all(|operand| {
                                operand.mode == mode
                                    && rows[operand.record].node.id.starts_with(prefix)
                            })
                    })
                    .count()
            };
            assert_eq!(count(Mode::Accepted), accepted, "{prefix}");
            assert_eq!(count(Mode::Structural), structural, "{prefix}");
        }
    }
}
