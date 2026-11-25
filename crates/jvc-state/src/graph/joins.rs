use super::{Closure, Graph, Node, Ranges};
use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
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

fn reserve(graph: &Graph, units: u128) -> Option<()> {
    graph.charge(usize::try_from(units).ok()?).then_some(())
}

fn collect_scopes(graph: &Graph, records: &[Record<'_>]) -> Option<Vec<Vec<Operand>>> {
    let linked = !Rc::ptr_eq(&graph.own, &graph.structural);
    let mut actors = HashMap::new();
    if linked {
        reserve(graph, graph.lifecycle.key_actor.len() as u128)?;
        for (key, actor) in &graph.lifecycle.key_actor {
            reserve(graph, key.len() as u128)?;
            actors.insert(key.as_str(), actor.as_str());
        }
    }

    let mut ids = HashMap::new();
    if graph.has_carry {
        reserve(graph, records.len() as u128)?;
        for (index, record) in records.iter().enumerate() {
            reserve(graph, record.node.id.len() as u128)?;
            ids.insert(record.node.id.as_str(), index);
        }
    }

    reserve(graph, records.len() as u128)?;
    let mut maxima: HashMap<MaximaKey, Vec<Operand>> = HashMap::new();
    let mut scopes = Vec::new();
    for (index, record) in records.iter().enumerate() {
        let node = record.node;
        if !node.semantic {
            continue;
        }
        let is_carry = graph.has_carry && is_carry_candidate(node);
        if !linked && !is_carry {
            continue;
        }
        // Account for the input bytes before hashing or formatting
        // scope keys. Formatting JSON strings can expand escapes.
        node.action
            .view()
            .string_bytes_metered(&mut |units| {
                reserve(graph, 6 * u128::from(units))
                    .ok_or_else(|| jvc_core::Error::new("work_budget", "issuer gap scope keys"))
            })
            .ok()?;

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

        reserve(graph, node.issuer.len() as u128)?;
        let issuer = actors
            .get(node.issuer.as_str())
            .copied()
            .unwrap_or(&node.issuer);
        reserve(graph, issuer.len() as u128)?;
        let mut add = |key, mode| {
            maxima.entry(key).or_default().push(Operand {
                record: index,
                mode,
            });
        };
        if let Some(key) = crate::register_key(node, issuer, |subject| {
            actors.get(subject).copied().unwrap_or(subject).to_owned()
        }) {
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
    Some(scopes)
}

struct Scopes<'a> {
    handles: Vec<&'a Closure>,
    memberships: Vec<Vec<usize>>,
    incidences: u128,
    unique_ranges: u128,
    repeated_ranges: u128,
}

impl<'a> Scopes<'a> {
    fn new(graph: &Graph, records: &[Record<'a>], scopes: Vec<Vec<Operand>>) -> Option<Self> {
        let mut dense = HashMap::new();
        let mut result = Self {
            handles: Vec::new(),
            memberships: Vec::new(),
            incidences: 0,
            unique_ranges: 0,
            repeated_ranges: 0,
        };
        for scope in scopes {
            reserve(graph, 2 * scope.len() as u128)?;
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
        Some(result)
    }
}

pub(super) enum JoinIndex {
    Empty,
    Direct(Vec<u32>),
    Refine {
        candidates: Vec<(u32, Cell<Option<bool>>)>,
        handles: Vec<Ranges>,
        memberships: Vec<Vec<usize>>,
        refinement_units: u128,
    },
}

impl JoinIndex {
    pub(super) fn build(graph: &Graph) -> Option<Self> {
        debug_assert!(graph.appended_rank.is_empty());
        let blocks = graph.space.block_starts().len();
        if blocks < 2 {
            return Some(Self::Empty);
        }
        reserve(graph, graph.space.len() as u128)?;
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
        let scopes = Scopes::new(graph, &records, collect_scopes(graph, &records)?)?;
        Self::mark_scopes(graph, blocks - 1, scopes)
    }

    fn mark_scopes(graph: &Graph, gaps: usize, scopes: Scopes<'_>) -> Option<Self> {
        if scopes.memberships.is_empty() {
            return Some(Self::Empty);
        }

        let direct = scopes.repeated_ranges <= 2 * (scopes.incidences + scopes.unique_ranges);
        let scan = if direct {
            scopes.incidences + 4 * scopes.repeated_ranges
        } else {
            scopes.handles.len() as u128 + 2 * scopes.unique_ranges
        };
        reserve(graph, graph.space.len() as u128 + 4 * gaps as u128 + scan)?;
        // Zero means that no issuer gap starts at this position.
        let mut gap_at = vec![0u32; graph.space.len()];
        for (index, position) in graph.space.block_starts().skip(1).enumerate() {
            gap_at[position as usize] = index as u32 + 1;
        }
        let mut sides = vec![0u8; gaps];
        let mut touched = Vec::new();
        let visit = |closure: &Closure, sides: &mut [u8], mut touched: Option<&mut Vec<usize>>| {
            for (first, last) in closure.ids.ranges() {
                #[cfg(test)]
                RANGE_VISITS.with(|visits| visits.set(visits.get() + 1));
                for (position, side) in [(first, 1), (last + 1, 2)] {
                    let Some(&gap) = gap_at.get(position as usize) else {
                        continue;
                    };
                    if gap != 0 {
                        let index = gap as usize - 1;
                        if sides[index] == 0
                            && let Some(indices) = touched.as_mut()
                        {
                            indices.push(index);
                        }
                        sides[index] |= side;
                    }
                }
            }
        };
        let mut marks = vec![false; gaps];
        if direct {
            for scope in &scopes.memberships {
                for &handle in scope {
                    visit(scopes.handles[handle], &mut sides, Some(&mut touched));
                }
                for index in touched.drain(..) {
                    marks[index] |= sides[index] == 3;
                    sides[index] = 0;
                }
            }
            return Some(Self::Direct(marked(graph, marks.into_iter()).collect()));
        }

        for closure in &scopes.handles {
            visit(closure, &mut sides, None);
        }
        let candidates: Vec<_> = marked(graph, sides.into_iter().map(|sides| sides == 3))
            .map(|position| (position, Cell::new(None)))
            .collect();
        if candidates.is_empty() {
            return Some(Self::Empty);
        }
        reserve(graph, scopes.handles.len() as u128)?;
        let refinement_units =
            scopes.incidences + 2 * (scopes.unique_ranges + scopes.handles.len() as u128);
        Some(Self::Refine {
            candidates,
            handles: scopes
                .handles
                .iter()
                .map(|closure| closure.ids.range_handle())
                .collect(),
            memberships: scopes.memberships,
            refinement_units,
        })
    }

    pub(super) fn splits(&self, graph: &Graph, position: u32) -> Option<bool> {
        match self {
            Self::Empty => Some(false),
            Self::Direct(marks) => Some(marks.binary_search(&position).is_ok()),
            Self::Refine {
                candidates,
                handles,
                memberships,
                refinement_units,
            } => {
                let Ok(index) = candidates.binary_search_by_key(&position, |&(gap, _)| gap) else {
                    return Some(false);
                };
                let answer = &candidates[index].1;
                if let Some(splits) = answer.get() {
                    return Some(splits);
                }
                reserve(graph, *refinement_units)?;
                let sides: Vec<_> = handles
                    .iter()
                    .map(|ranges| {
                        u8::from(ranges.contains(position))
                            | (u8::from(ranges.contains(position - 1)) << 1)
                    })
                    .collect();
                let splits = memberships
                    .iter()
                    .any(|scope| scope.iter().fold(0, |touch, &handle| touch | sides[handle]) == 3);
                answer.set(Some(splits));
                Some(splits)
            }
        }
    }
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

#[cfg(test)]
thread_local! {
    static RANGE_VISITS: Cell<usize> = const { Cell::new(0) };
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
            let scopes = collect_scopes(&graph, &records).unwrap();
            let counts = Scopes::new(&graph, &records, scopes.clone()).unwrap();
            let before = RANGE_VISITS.with(Cell::get);
            let index = JoinIndex::build(&graph).unwrap();
            let read = RANGE_VISITS.with(Cell::get) - before;
            if repeated {
                assert!(matches!(index, JoinIndex::Refine { .. }));
                assert_eq!(read as u128, counts.unique_ranges);
            } else {
                assert!(matches!(index, JoinIndex::Direct(_)));
                assert_eq!(read as u128, counts.repeated_ranges);
            }
            let target = graph.next_block_start("b");
            if repeated {
                // The common mask finds both sides, even for a gap
                // whose sides belong to two different claims.
                let original_fuel = graph.budget.replace(0);
                assert_eq!(index.splits(&graph, target), None);
                graph.resource.set(false);
                graph.budget.set(original_fuel);
            }
            for gap in graph.space.block_starts().chain([graph.space.len() as u32]) {
                assert_eq!(
                    index.splits(&graph, gap),
                    Some(oracle(&graph, &records, &scopes, gap))
                );
            }
            assert_eq!(index.splits(&graph, target), Some(join));
            graph.budget.set(0);
            assert_eq!(index.splits(&graph, target), Some(join));
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
        let scopes = collect_scopes(&graph, &records).unwrap();
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
        assert_eq!(
            graph.splits_layout(graph.next_block_start("a"), "a"),
            Some(true)
        );
        assert_eq!(
            graph.splits_layout(graph.next_block_start("b"), "b"),
            Some(false)
        );
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
        assert_eq!(original.splits_layout(gap, "bb"), Some(true));

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
        assert_eq!(
            graph.splits_layout(graph.next_block_start("a"), "ab"),
            Some(false)
        );
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
        let scopes = collect_scopes(&graph, &rows).unwrap();
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
