use jvc_rank::*;
use num_traits::{One, Zero};
use std::collections::{BTreeMap, BTreeSet};

// This oracle walks individual routes. It never merges stages or relaxes walks.
fn oracle(graph: &Graph, h: &Rational, alpha: &Rational) -> Vec<Rational> {
    // Keep every route input explicit in this independent test oracle.
    #[allow(clippy::too_many_arguments)]
    fn visit(
        graph: &Graph,
        root: usize,
        actor: usize,
        path: &mut Vec<usize>,
        product: Rational,
        h: &Rational,
        alpha: &Rational,
        result: &mut [Rational],
    ) {
        for edge in &graph.rows[actor] {
            if path.contains(&edge.to)
                || (graph.profile == Profile::ShunV1
                    && graph.refusals[edge.to]
                        .iter()
                        .any(|actor| path.contains(actor)))
            {
                continue;
            }
            let product = &product * &edge.share;
            let hops = path.len();
            result[edge.to] += h * &graph.q[root] * alpha.pow((hops - 1) as i32) * &product;
            path.push(edge.to);
            visit(graph, root, edge.to, path, product, h, alpha, result);
            path.pop();
        }
    }
    let mut result = graph.q.clone();
    for root in 0..graph.actors.len() {
        visit(
            graph,
            root,
            root,
            &mut vec![root],
            Rational::one(),
            h,
            alpha,
            &mut result,
        );
    }
    result
}
fn graph(q: &[i64], rows: &[&[(usize, i64, i64)]]) -> Graph {
    Graph::new(
        (0..q.len()).map(|i| format!("actor{i}")).collect(),
        q.iter().map(|&q| rational(q, 1)).collect(),
        rows.iter()
            .map(|row| {
                row.iter()
                    .map(|&(to, n, d)| Edge {
                        to,
                        share: rational(n, d),
                    })
                    .collect()
            })
            .collect(),
    )
    .unwrap()
}
fn params(work: u64) -> Parameters {
    Parameters {
        work,
        ..Parameters::default()
    }
}
fn candidate(id: &str, verdicts: Vec<Verdict>) -> Candidate {
    Candidate {
        id: id.into(),
        verdicts,
        eligibility: Eligibility::Eligible,
        deprecated: false,
    }
}
fn exact_score(candidate: &Candidate, weights: &[Rational]) -> Rational {
    if candidate.deprecated || candidate.eligibility != Eligibility::Eligible {
        return Rational::zero();
    }
    candidate
        .verdicts
        .iter()
        .zip(weights)
        .map(|(v, w)| match v {
            Verdict::Bless => w.clone(),
            Verdict::Curse => -w,
            Verdict::Absent => Rational::zero(),
        })
        .sum()
}
#[test]
fn oracle_encloses_scores_and_certified_comparisons() {
    for seed in 1..=24_u64 {
        let n = 5;
        let mut random = seed;
        let mut rows = Vec::new();
        for from in 0..n {
            let mut destinations = Vec::new();
            for to in 0..n {
                random = random.wrapping_mul(6364136223846793005).wrapping_add(1);
                if to != from && random >> 61 > 2 {
                    destinations.push(to);
                }
            }
            let degree = destinations.len();
            rows.push(
                destinations
                    .into_iter()
                    .map(|to| Edge {
                        to,
                        share: rational(1, degree as i64),
                    })
                    .collect(),
            );
        }
        let g = Graph::new(
            (0..n).map(|i| format!("actor{i}")).collect(),
            (0..n).map(|i| rational((i % 3 == 0) as i64, 1)).collect(),
            rows,
        )
        .unwrap();
        let exact = oracle(&g, &rational(3, 1), &rational(1, 2));
        let candidates: Vec<_> = (0..8)
            .map(|c| {
                candidate(
                    &format!("candidate{c}"),
                    (0..n)
                        .map(|i| match (c * 3 + i * i + c * i) % 5 {
                            0 | 1 => Verdict::Bless,
                            2 => Verdict::Curse,
                            _ => Verdict::Absent,
                        })
                        .collect(),
                )
            })
            .collect();
        for work in [1, 2, 5, 20, 1000] {
            let result = rank(&g, &params(work), Limits::default()).unwrap();
            for (bounds, exact) in result.weights.iter().zip(&exact) {
                assert!(bounds.lower <= *exact && *exact <= bounds.upper);
            }
            if result.exact {
                assert!(result
                    .weights
                    .iter()
                    .zip(&exact)
                    .all(|(w, e)| w.lower == *e && w.upper == *e));
            }
            for a in &candidates {
                let score = score(a, &result.weights).unwrap();
                let exact_support: Rational = a
                    .verdicts
                    .iter()
                    .zip(&exact)
                    .filter(|(v, _)| **v == Verdict::Bless)
                    .map(|(_, w)| w.clone())
                    .sum();
                let exact_opposition: Rational = a
                    .verdicts
                    .iter()
                    .zip(&exact)
                    .filter(|(v, _)| **v == Verdict::Curse)
                    .map(|(_, w)| w.clone())
                    .sum();
                assert!(
                    score.support.lower <= exact_support && exact_support <= score.support.upper
                );
                assert!(
                    score.opposition.lower <= exact_opposition
                        && exact_opposition <= score.opposition.upper
                );
                let target = exact_score(a, &exact);
                assert!(score.net.lower <= target && target <= score.net.upper);
                for b in &candidates {
                    let delta = difference(a, b, &result.weights).unwrap();
                    let target = exact_score(a, &exact) - exact_score(b, &exact);
                    assert!(delta.lower <= target && target <= delta.upper);
                    if delta.lower > Rational::zero() {
                        assert!(target > Rational::zero());
                    }
                }
            }
            nondominated_layers(&candidates, &result.weights, &Limits::default()).unwrap();
        }
    }
}
#[test]
fn before_first_stage_has_no_frontier_lower_credit_and_exact_65_term_bound() {
    let g = graph(
        &[1, 0, 0],
        &[&[(1, 1, 2), (2, 1, 2)], &[(0, 1, 1)], &[(0, 1, 1)]],
    );
    let result = rank(&g, &params(1), Limits::default()).unwrap();
    assert_eq!(result.completed_work, 0);
    assert_eq!(result.complete_stages, 0);
    assert_eq!(
        result
            .weights
            .iter()
            .map(|w| w.lower.clone())
            .collect::<Vec<_>>(),
        g.q
    );
    let mut expected = g.q.clone();
    // Symmetry reduces this graph to the alternating mass of two states.
    for k in 0..65 {
        let mass = rational(3, 1) * rational(1, 2).pow(k);
        if k % 2 == 0 {
            expected[1] += &mass / rational(2, 1);
            expected[2] += &mass / rational(2, 1);
        } else {
            expected[0] += mass;
        }
    }
    let tail = rational(1, 2).pow(65) * rational(3, 1) / rational(1, 2);
    for (w, mut expected) in result.weights.iter().zip(expected) {
        expected += &tail;
        assert_eq!(w.upper, expected);
    }
}
#[test]
fn cycles_never_pay_the_source_and_repeated_edges_still_cost_work() {
    let g = graph(&[1, 0], &[&[(1, 1, 1)], &[(0, 1, 1)]]);
    let partial = rank(&g, &params(1), Limits::default()).unwrap();
    assert!(!partial.exact);
    let complete = rank(&g, &params(2), Limits::default()).unwrap();
    assert!(complete.exact);
    assert_eq!(complete.completed_work, 2);
    assert_eq!(
        complete.weights,
        vec![
            Interval::exact(rational(1, 1)),
            Interval::exact(rational(3, 1))
        ]
    );
}
#[test]
fn own_allowance_is_independent_of_outgoing_heeds() {
    let without = graph(&[1, 2, 0], &[&[], &[(0, 1, 1)], &[]]);
    let with = graph(
        &[1, 2, 0],
        &[&[(1, 1, 2), (2, 1, 2)], &[(0, 1, 1)], &[(0, 1, 1)]],
    );
    for g in [&without, &with] {
        assert_eq!(
            rank(g, &params(1000), Limits::default()).unwrap().weights[0].lower,
            rational(7, 1)
        );
    }
}
#[test]
fn zero_alpha_zero_h_and_empty_graph() {
    let g = graph(&[1, 0, 0], &[&[(1, 1, 1)], &[(2, 1, 1)], &[]]);
    let zero_alpha = Parameters {
        alpha: Rational::zero(),
        ..params(10)
    };
    let result = rank(&g, &zero_alpha, Limits::default()).unwrap();
    assert!(result.exact);
    assert_eq!(result.weights[2].lower, Rational::zero());
    let zero_h = Parameters {
        h: Rational::zero(),
        ..params(1)
    };
    let result = rank(&g, &zero_h, Limits::default()).unwrap();
    assert!(result.exact);
    assert_eq!(result.completed_work, 0);
    assert_eq!(result.weights[0].lower, Rational::one());
    assert!(
        rank(&graph(&[], &[]), &params(1), Limits::default())
            .unwrap()
            .exact
    );
}
#[test]
fn shares_are_normalized_before_blocking_without_upward_scaling() {
    let weights = BTreeMap::from([("a".into(), rational(1, 1)), ("b".into(), rational(1, 1))]);
    let row = normalize_row(&weights, &BTreeSet::from(["a".into()])).unwrap();
    assert_eq!(row["b"], rational(1, 2));
    let weights = BTreeMap::from([("b".into(), rational(1, 3))]);
    assert_eq!(
        normalize_row(&weights, &BTreeSet::new()).unwrap()["b"],
        rational(1, 3)
    );
    assert!(Graph::new(
        vec!["a".into(), "b".into()],
        vec![rational(1, 1); 2],
        vec![
            vec![
                Edge {
                    to: 1,
                    share: rational(1, 2)
                },
                Edge {
                    to: 1,
                    share: rational(1, 2)
                }
            ],
            vec![]
        ]
    )
    .is_err());
}
#[test]
fn shared_verdicts_cancel_and_opposite_verdicts_have_coefficient_two() {
    let weights = vec![
        Interval {
            lower: rational(1, 1),
            upper: rational(100, 1),
        },
        Interval::exact(rational(2, 1)),
    ];
    let a = candidate("a", vec![Verdict::Bless, Verdict::Bless]);
    let b = candidate("b", vec![Verdict::Bless, Verdict::Curse]);
    assert_eq!(
        difference(&a, &b, &weights).unwrap(),
        Interval::exact(rational(4, 1))
    );
    assert!(
        separate_difference(&score(&a, &weights).unwrap(), &score(&b, &weights).unwrap()).lower
            < Rational::zero()
    );
    assert_eq!(
        nondominated_layers(&[b, a], &weights, &Limits::default()).unwrap(),
        vec![vec!["a"], vec!["b"]]
    );
}
#[test]
fn exact_ties_and_deprecated_or_ineligible_judgments() {
    let weights = vec![Interval::exact(rational(1, 1))];
    let a = candidate("a", vec![Verdict::Bless]);
    let b = candidate("b", vec![Verdict::Bless]);
    let mut retired = candidate("retired", vec![Verdict::Bless]);
    retired.deprecated = true;
    let mut unavailable = candidate("unavailable", vec![Verdict::Bless]);
    unavailable.eligibility = Eligibility::Unavailable;
    assert_eq!(
        score(&retired, &weights).unwrap().net,
        Interval::exact(Rational::zero())
    );
    assert!(matches!(
        score(&unavailable, &weights),
        Err(RankError::UnavailableCandidate(_))
    ));
    assert_eq!(
        nondominated_layers(&[b, retired, a], &weights, &Limits::default()).unwrap(),
        vec![vec!["a", "b"], vec!["retired"]]
    );
}
#[test]
fn resume_retains_only_completed_lower_credit() {
    let g = graph(
        &[1, 0, 0, 0],
        &[
            &[(1, 1, 2), (2, 1, 2)],
            &[(2, 1, 2), (3, 1, 2)],
            &[(1, 1, 2), (3, 1, 2)],
            &[],
        ],
    );
    let mut calculation =
        Ranker::new(&g, rational(3, 1), rational(1, 2), Limits::default()).unwrap();
    calculation.advance(1).unwrap();
    assert_eq!(
        calculation.bounds().unwrap().weights[1].lower,
        Rational::zero()
    );
    calculation.advance(3).unwrap();
    calculation.advance(1000).unwrap();
    let resumed = calculation.bounds().unwrap();
    let fresh = rank(&g, &params(1000), Limits::default()).unwrap();
    assert_eq!(resumed.weights, fresh.weights);
    assert_eq!(resumed.completed_work, fresh.completed_work);
}
#[test]
fn input_permutation_preserves_intervals_work_and_layers() {
    let original = graph(
        &[1, 2, 0, 0],
        &[
            &[(1, 1, 2), (2, 1, 2)],
            &[(2, 1, 2), (3, 1, 2)],
            &[(1, 1, 2), (3, 1, 2)],
            &[(0, 1, 1)],
        ],
    );
    let permutation = [3, 1, 0, 2];
    let inverse: Vec<_> = (0..4)
        .map(|old| permutation.iter().position(|&new| new == old).unwrap())
        .collect();
    let shuffled = Graph::new(
        permutation
            .iter()
            .map(|&i| original.actors[i].clone())
            .collect(),
        permutation.iter().map(|&i| original.q[i].clone()).collect(),
        permutation
            .iter()
            .map(|&i| {
                original.rows[i]
                    .iter()
                    .rev()
                    .map(|edge| Edge {
                        to: inverse[edge.to],
                        share: edge.share.clone(),
                    })
                    .collect()
            })
            .collect(),
    )
    .unwrap();
    for budget in [1, 5, 20, 1000] {
        let a = rank(&original, &params(budget), Limits::default()).unwrap();
        let b = rank(&shuffled, &params(budget), Limits::default()).unwrap();
        assert_eq!(a.completed_work, b.completed_work);
        for (i, &old) in permutation.iter().enumerate() {
            assert_eq!(b.weights[i], a.weights[old]);
        }
        let candidates = vec![
            candidate(
                "z",
                vec![
                    Verdict::Bless,
                    Verdict::Absent,
                    Verdict::Curse,
                    Verdict::Bless,
                ],
            ),
            candidate(
                "a",
                vec![
                    Verdict::Absent,
                    Verdict::Bless,
                    Verdict::Bless,
                    Verdict::Curse,
                ],
            ),
        ];
        let reordered: Vec<_> = candidates
            .iter()
            .rev()
            .map(|c| Candidate {
                id: c.id.clone(),
                verdicts: permutation.iter().map(|&old| c.verdicts[old]).collect(),
                eligibility: Eligibility::Eligible,
                deprecated: false,
            })
            .collect();
        assert_eq!(
            nondominated_layers(&candidates, &a.weights, &Limits::default()).unwrap(),
            nondominated_layers(&reordered, &b.weights, &Limits::default()).unwrap()
        );
    }
}
#[test]
fn explicit_resource_failures_never_return_partial_scores() {
    let g = graph(
        &[1, 0, 0],
        &[&[(1, 1, 2), (2, 1, 2)], &[(0, 1, 1)], &[(0, 1, 1)]],
    );
    assert!(matches!(
        rank(
            &g,
            &params(1),
            Limits {
                max_matrix_edge_visits: 1,
                ..Limits::default()
            }
        ),
        Err(RankError::ResourceLimit("matrix edge visits"))
    ));
    assert!(matches!(
        rank(
            &g,
            &params(100),
            Limits {
                max_prefixes: 1,
                ..Limits::default()
            }
        ),
        Err(RankError::ResourceLimit("prefix states"))
    ));
    assert!(matches!(
        rank(
            &g,
            &params(1),
            Limits {
                max_rational_bits: 2,
                ..Limits::default()
            }
        ),
        Err(RankError::ResourceLimit("rational bits"))
    ));
    assert!(rank(&g, &params(0), Limits::default()).is_err());
}
#[test]
fn merged_visited_sets_reduce_complete_stage_cost() {
    let n = 4;
    let rows = (0..n)
        .map(|from| {
            (0..n)
                .filter(|&to| to != from)
                .map(|to| Edge {
                    to,
                    share: rational(1, 3),
                })
                .collect()
        })
        .collect();
    let g = Graph::new(
        (0..n).map(|i| format!("actor{i}")).collect(),
        vec![
            rational(1, 1),
            rational(0, 1),
            rational(0, 1),
            rational(0, 1),
        ],
        rows,
    )
    .unwrap();
    let result = rank(&g, &params(39), Limits::default()).unwrap();
    assert!(result.exact);
    assert_eq!(result.completed_work, 39);
    assert_eq!(
        result
            .weights
            .iter()
            .map(|w| w.lower.clone())
            .collect::<Vec<_>>(),
        oracle(&g, &rational(3, 1), &rational(1, 2))
    );
    assert!(!rank(&g, &params(38), Limits::default()).unwrap().exact);
}
#[test]
fn unavailable_cannot_outrank_a_negative_eligible_candidate() {
    let weights = vec![Interval::exact(rational(2, 1))];
    let active = candidate("negative", vec![Verdict::Curse]);
    let mut unavailable = candidate("missing", vec![Verdict::Bless]);
    unavailable.eligibility = Eligibility::Unavailable;
    assert!(matches!(
        score(&unavailable, &weights),
        Err(RankError::UnavailableCandidate(_))
    ));
    assert!(matches!(
        difference(&unavailable, &active, &weights),
        Err(RankError::UnavailableCandidate(_))
    ));
    assert!(
        nondominated_layers(&[active.clone(), unavailable], &weights, &Limits::default()).is_err()
    );
    let mut ineligible = candidate("inert", vec![Verdict::Bless]);
    ineligible.eligibility = Eligibility::Ineligible;
    assert_eq!(
        score(&ineligible, &weights).unwrap().net,
        Interval::exact(Rational::zero())
    );
    assert!(nondominated_layers(&[active, ineligible], &weights, &Limits::default()).is_err());
}
#[test]
fn prefix_resource_cap_counts_current_and_next_maps_together() {
    let g = graph(&[1, 0, 0], &[&[(1, 1, 2), (2, 1, 2)], &[], &[]]);
    let limits = Limits {
        max_prefixes: 2,
        ..Limits::default()
    };
    let mut calculation = Ranker::new(&g, rational(3, 1), rational(1, 2), limits).unwrap();
    assert!(matches!(
        calculation.advance(100),
        Err(RankError::ResourceLimit("prefix states"))
    ));
    assert_eq!(calculation.bounds().unwrap().completed_work, 0);
    assert_eq!(
        calculation.bounds().unwrap().weights[1].lower,
        Rational::zero()
    );
    let result = rank(
        &g,
        &params(100),
        Limits {
            max_prefixes: 3,
            ..Limits::default()
        },
    )
    .unwrap();
    assert_eq!(result.peak_prefixes, 3);
    assert!(result.exact);
}
#[test]
fn coprime_row_denominators_grow_exactly_or_return_a_resource_error() {
    let g = graph(
        &[1, 1, 1, 1],
        &[
            &[(1, 1, 5), (2, 4, 5)],
            &[(2, 1, 7), (3, 6, 7)],
            &[(3, 1, 11), (0, 10, 11)],
            &[(0, 1, 13), (1, 12, 13)],
        ],
    );
    let result = rank(&g, &params(1), Limits::default()).unwrap();
    assert!(result.max_arithmetic_bits > 64);
    let target = oracle(&g, &rational(3, 1), &rational(1, 2));
    assert!(result
        .weights
        .iter()
        .zip(target)
        .all(|(w, t)| w.lower <= t && t <= w.upper));
    assert!(matches!(
        rank(
            &g,
            &params(1),
            Limits {
                max_rational_bits: 64,
                ..Limits::default()
            }
        ),
        Err(RankError::ResourceLimit("rational bits"))
    ));
}

fn shun_graph(mut graph: Graph, pairs: &[(usize, usize)], profile: Profile) -> Graph {
    graph.profile = profile;
    for &(issuer, target) in pairs {
        graph.refusals[target].push(issuer);
    }
    for list in &mut graph.refusals {
        list.sort_unstable();
    }
    graph
}

#[test]
fn every_earlier_actor_refuses_entry_and_onward_credit() {
    // R -> A -> B -> C -> E, with A shunning C.
    let base = graph(
        &[1, 0, 0, 0, 0],
        &[&[(1, 1, 1)], &[(2, 1, 1)], &[(3, 1, 1)], &[(4, 1, 1)], &[]],
    );
    for profile in [Profile::BoundsV1, Profile::ShunV1] {
        let g = shun_graph(base.clone(), &[(1, 3)], profile);
        let result = rank(&g, &params(1000), Limits::default()).unwrap();
        assert!(result.exact);
        assert_eq!(result.weights[1].lower, rational(3, 1));
        assert_eq!(result.weights[2].lower, rational(3, 2));
        assert_eq!(
            result.weights[3].lower,
            if profile == Profile::BoundsV1 {
                rational(3, 4)
            } else {
                Rational::zero()
            }
        );
        assert_eq!(
            result.weights[4].lower,
            if profile == Profile::BoundsV1 {
                rational(3, 8)
            } else {
                Rational::zero()
            }
        );
        assert_eq!(
            result.completed_work,
            if profile == Profile::BoundsV1 { 4 } else { 3 }
        );
    }
}

#[test]
fn independent_routes_prior_credit_and_own_allocation_survive() {
    // R -> A -> B -> C and R -> X -> C. A shuns C.
    let base = graph(
        &[1, 0, 0, 0, 0],
        &[
            &[(1, 1, 2), (4, 1, 2)],
            &[(2, 1, 1)],
            &[(3, 1, 1)],
            &[],
            &[(3, 1, 1)],
        ],
    );
    for (profile, expected) in [
        (Profile::BoundsV1, rational(9, 8)),
        (Profile::ShunV1, rational(3, 4)),
    ] {
        let g = shun_graph(base.clone(), &[(1, 3)], profile);
        assert_eq!(
            rank(&g, &params(1000), Limits::default()).unwrap().weights[3].lower,
            expected
        );
    }
    // R shuns C. A second root X supplies C, which also retains its own q.
    let base = graph(
        &[1, 0, 0, 1, 1, 0],
        &[
            &[(1, 1, 1)],
            &[(2, 1, 1)],
            &[(3, 1, 1)],
            &[(5, 1, 1)],
            &[(3, 1, 1)],
            &[],
        ],
    );
    let g = shun_graph(base, &[(0, 3)], Profile::ShunV1);
    let result = rank(&g, &params(1000), Limits::default()).unwrap();
    assert_eq!(result.weights[3].lower, rational(4, 1));
    assert_eq!(result.weights[5].lower, rational(9, 2));
}

#[test]
fn rejected_share_is_not_redistributed() {
    let g = shun_graph(
        graph(
            &[1, 0, 0, 0],
            &[&[(1, 1, 1)], &[(2, 1, 2), (3, 1, 2)], &[], &[]],
        ),
        &[(0, 2)],
        Profile::ShunV1,
    );
    let result = rank(&g, &params(1000), Limits::default()).unwrap();
    assert_eq!(result.weights[2].lower, Rational::zero());
    assert_eq!(result.weights[3].lower, rational(3, 4));
    assert_eq!(result.completed_work, 3);
}

#[test]
fn oracle_checks_both_profiles_bounds_comparisons_and_monotonic_refusals() {
    for seed in 0..32_u64 {
        let mut random = seed + 1;
        let n = 5;
        let mut rows = vec![Vec::new(); n];
        let mut refusals = Vec::new();
        for (from, row) in rows.iter_mut().enumerate() {
            for to in 0..n {
                random = random.wrapping_mul(6364136223846793005).wrapping_add(1);
                if from == to {
                    continue;
                }
                if random >> 61 >= 3 {
                    row.push(Edge {
                        to,
                        share: rational(1 + (random % 3) as i64, 12),
                    });
                }
                if random & 3 == 0 {
                    refusals.push((from, to));
                }
            }
        }
        let base = Graph::new(
            (0..n).map(|i| format!("actor{i}")).collect(),
            vec![
                rational(1, 1),
                Rational::zero(),
                rational(1, 1),
                Rational::zero(),
                Rational::zero(),
            ],
            rows,
        )
        .unwrap();
        let a = candidate(
            "a",
            vec![
                Verdict::Bless,
                Verdict::Curse,
                Verdict::Bless,
                Verdict::Absent,
                Verdict::Curse,
            ],
        );
        let b = candidate(
            "b",
            vec![
                Verdict::Curse,
                Verdict::Bless,
                Verdict::Bless,
                Verdict::Bless,
                Verdict::Absent,
            ],
        );
        let fewer = shun_graph(
            base.clone(),
            &refusals[..refusals.len() / 2],
            Profile::ShunV1,
        );
        let fewer_exact = oracle(&fewer, &rational(3, 1), &rational(1, 2));
        for profile in [Profile::BoundsV1, Profile::ShunV1] {
            let g = shun_graph(base.clone(), &refusals, profile);
            let exact = oracle(&g, &rational(3, 1), &rational(1, 2));
            if profile == Profile::ShunV1 {
                assert!(exact
                    .iter()
                    .zip(&fewer_exact)
                    .all(|(more, fewer)| more <= fewer));
            }
            for budget in [1, 2, 5, 20, 1000] {
                let result = rank(&g, &params(budget), Limits::default()).unwrap();
                assert!(result
                    .weights
                    .iter()
                    .zip(&exact)
                    .all(|(w, e)| w.lower <= *e && *e <= w.upper));
                if result.exact {
                    assert!(result
                        .weights
                        .iter()
                        .zip(&exact)
                        .all(|(w, e)| w.lower == *e && w.upper == *e));
                }
                let score_a = score(&a, &result.weights).unwrap();
                let exact_a = exact_score(&a, &exact);
                assert!(score_a.net.lower <= exact_a && exact_a <= score_a.net.upper);
                let delta = difference(&a, &b, &result.weights).unwrap();
                let exact_delta = exact_a - exact_score(&b, &exact);
                assert!(delta.lower <= exact_delta && exact_delta <= delta.upper);
            }
            assert!(rank(&g, &params(1000), Limits::default()).unwrap().exact);
        }
    }
}

#[test]
fn refusal_limits_leave_the_last_complete_stage_unchanged() {
    let base = graph(
        &[1, 0, 0, 0, 0],
        &[
            &[(1, 1, 1)],
            &[(2, 1, 3), (3, 1, 3), (4, 1, 3)],
            &[],
            &[],
            &[],
        ],
    );
    let g = shun_graph(base, &[(0, 3), (0, 4)], Profile::ShunV1);
    assert!(matches!(
        rank(
            &g,
            &params(1000),
            Limits {
                max_refusals: 1,
                ..Limits::default()
            }
        ),
        Err(RankError::ResourceLimit("refusals"))
    ));
    let mut calculation = Ranker::new(
        &g,
        rational(3, 1),
        rational(1, 2),
        Limits {
            max_refusal_tests: 1,
            ..Limits::default()
        },
    )
    .unwrap();
    calculation.advance(1).unwrap();
    let before = calculation.bounds().unwrap();
    assert!(matches!(
        calculation.advance(1000),
        Err(RankError::ResourceLimit("refusal tests"))
    ));
    let after = calculation.bounds().unwrap();
    // The failed stage credited actor 2 before its later membership failure.
    assert_eq!(after.weights[2].lower, Rational::zero());
    assert_eq!(before.weights, after.weights);
    assert_eq!(before.completed_work, after.completed_work);
    assert_eq!(before.complete_stages, after.complete_stages);
    assert_eq!(before.peak_prefixes, after.peak_prefixes);
    assert_eq!(before.max_arithmetic_bits, after.max_arithmetic_bits);
    assert!(matches!(
        calculation.advance(1000),
        Err(RankError::ResourceLimit("refusal tests"))
    ));
    let old = shun_graph(g.clone(), &[], Profile::BoundsV1);
    assert!(
        rank(
            &old,
            &params(1000),
            Limits {
                max_refusal_tests: 0,
                ..Limits::default()
            }
        )
        .unwrap()
        .exact
    );
    let empty = shun_graph(graph(&[1, 0], &[&[(1, 1, 1)], &[]]), &[], Profile::ShunV1);
    assert!(
        rank(
            &empty,
            &params(1000),
            Limits {
                max_refusal_tests: 0,
                ..Limits::default()
            }
        )
        .unwrap()
        .exact
    );
}

#[test]
fn shorter_refusal_list_bounds_membership_work_and_resume_matches_fresh() {
    let g = shun_graph(
        graph(
            &[1, 0, 0, 0, 0],
            &[&[(1, 1, 1)], &[(2, 1, 1)], &[], &[], &[]],
        ),
        &[(2, 1), (3, 1), (4, 1), (0, 2)],
        Profile::ShunV1,
    );
    // First entry searches one visited actor. The second searches one shunner.
    let mut calculation = Ranker::new(
        &g,
        rational(3, 1),
        rational(1, 2),
        Limits {
            max_refusal_tests: 2,
            ..Limits::default()
        },
    )
    .unwrap();
    calculation.advance(1).unwrap();
    calculation.advance(1000).unwrap();
    let fresh = rank(
        &g,
        &params(1000),
        Limits {
            max_refusal_tests: 2,
            ..Limits::default()
        },
    )
    .unwrap();
    assert_eq!(calculation.bounds().unwrap().weights, fresh.weights);
    assert_eq!(fresh.weights[1].lower, rational(3, 1));
    assert_eq!(fresh.weights[2].lower, Rational::zero());
    assert!(matches!(
        rank(
            &g,
            &params(1000),
            Limits {
                max_refusal_tests: 1,
                ..Limits::default()
            }
        ),
        Err(RankError::ResourceLimit("refusal tests"))
    ));
}

#[test]
fn graph_refusal_validation_rejects_invalid_dimensions_ids_and_duplicates() {
    let base = graph(&[1, 0], &[&[(1, 1, 1)], &[]]);
    for refusals in [
        vec![],
        vec![vec![0], vec![]],
        vec![vec![], vec![2]],
        vec![vec![], vec![0, 0]],
    ] {
        assert!(Graph::with_refusals(
            Profile::ShunV1,
            base.actors.clone(),
            base.q.clone(),
            base.rows.clone(),
            refusals,
            &Limits::default()
        )
        .is_err());
    }
    let mut mutated = graph(&[1, 0, 0], &[&[(1, 1, 1)], &[], &[]]);
    mutated.refusals[2] = vec![1, 0];
    assert!(Ranker::new(&mutated, rational(3, 1), rational(1, 2), Limits::default()).is_err());
    assert_eq!(Profile::from_name("unsupported"), None);
    for profile in [Profile::BoundsV1, Profile::ShunV1] {
        assert_eq!(Profile::from_name(profile.name()), Some(profile));
    }
}

#[test]
fn default_refusal_pair_ceiling_is_inclusive() {
    let n = 350;
    let mut refusals = vec![Vec::new(); n];
    for (target, list) in refusals.iter_mut().enumerate() {
        list.extend((0..n).filter(|&issuer| issuer != target));
    }
    let mut remaining = Limits::default().max_refusals;
    for list in &mut refusals {
        let retained = remaining.min(list.len());
        list.truncate(retained);
        remaining -= retained;
    }
    assert_eq!(refusals.iter().map(Vec::len).sum::<usize>(), 100_000);
    let accepted = Graph::with_refusals(
        Profile::ShunV1,
        (0..n).map(|i| format!("actor{i}")).collect(),
        vec![Rational::zero(); n],
        vec![Vec::new(); n],
        refusals,
        &Limits::default(),
    )
    .unwrap();
    let mut oversized = accepted;
    oversized.refusals[n - 1].push(0);
    assert!(matches!(
        Ranker::new(
            &oversized,
            rational(3, 1),
            rational(1, 2),
            Limits::default()
        ),
        Err(RankError::ResourceLimit("refusals"))
    ));
    assert!(matches!(
        Graph::with_refusals(
            oversized.profile,
            oversized.actors,
            oversized.q,
            oversized.rows,
            oversized.refusals,
            &Limits::default()
        ),
        Err(RankError::ResourceLimit("refusals"))
    ));
}
