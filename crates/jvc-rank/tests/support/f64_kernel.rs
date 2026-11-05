use jvc_rank::approximate as a;
use jvc_rank::{rational, Limits, Rational};
use num_traits::{One, ToPrimitive, Zero};
use std::collections::{BTreeMap, BTreeSet};

fn graph(
    n: usize,
    edges: &[(usize, usize, f64)],
    q: Vec<f64>,
    refusals: &[(usize, usize)],
) -> a::Graph {
    let mut rows = vec![vec![]; n];
    let mut blocked = vec![vec![]; n];
    for &(from, to, share) in edges {
        rows[from].push(a::Edge { to, share });
    }
    for &(from, to) in refusals {
        blocked[to].push(from);
    }
    a::Graph::new(
        (0..n).map(|i| format!("actor-{i:05}")).collect(),
        q,
        rows,
        blocked,
        &Limits::default(),
    )
    .unwrap()
}
fn ratio(value: f64) -> Rational {
    Rational::from_float(value).unwrap()
}
fn close(actual: f64, expected: &Rational) {
    let expected = expected.to_f64().unwrap();
    assert!(
        (actual - expected).abs() <= 2e-11 * expected.abs().max(f64::MIN_POSITIVE),
        "{actual:e} != {expected:e}"
    );
}
#[derive(Clone)]
struct Route {
    path: Vec<usize>,
    mass: Rational,
}
struct Reference {
    lower: Vec<Rational>,
    upper: Vec<Rational>,
    work: u64,
    stages: usize,
    complete: bool,
}
// The oracle retains individual ordered paths. Only stage costing deduplicates sets.
// Its rational matrix pass does not call either production ranking implementation.
fn reference(g: &a::Graph, h: f64, alpha: f64, budget: u64) -> Reference {
    let alpha = ratio(alpha);
    let mut lower: Vec<_> = g.q.iter().map(|&q| ratio(q)).collect();
    let mut frontier: Vec<_> =
        g.q.iter()
            .enumerate()
            .filter_map(|(i, &q)| {
                let mass = ratio(q) * ratio(h);
                (!mass.is_zero()).then_some(Route {
                    path: vec![i],
                    mass,
                })
            })
            .collect();
    let mut work = 0;
    let mut stages = 0;
    while !frontier.is_empty() {
        let keys: BTreeSet<_> = frontier
            .iter()
            .map(|r| {
                let mut set = r.path.clone();
                set.sort_unstable();
                (set, *r.path.last().unwrap())
            })
            .collect();
        let cost = keys
            .iter()
            .map(|(_, at)| g.rows[*at].len() as u64)
            .sum::<u64>();
        if cost > budget - work {
            break;
        }
        let mut next = Vec::new();
        for route in &frontier {
            for edge in &g.rows[*route.path.last().unwrap()] {
                if route.path.contains(&edge.to)
                    || g.refusals[edge.to].iter().any(|x| route.path.contains(x))
                {
                    continue;
                }
                let credit = &route.mass * ratio(edge.share);
                lower[edge.to] += &credit;
                let mass = credit * &alpha;
                if !mass.is_zero() {
                    let mut path = route.path.clone();
                    path.push(edge.to);
                    next.push(Route { path, mass });
                }
            }
        }
        frontier = next;
        work += cost;
        stages += 1;
    }
    let mut upper = lower.clone();
    if !frontier.is_empty() {
        let mut b = vec![Rational::zero(); g.q.len()];
        for route in &frontier {
            b[*route.path.last().unwrap()] += &route.mass;
        }
        let matrix = |input: &[Rational], factor: &Rational| {
            let mut out = vec![Rational::zero(); g.q.len()];
            for (from, row) in g.rows.iter().enumerate() {
                for edge in row {
                    out[edge.to] += &input[from] * ratio(edge.share) * factor;
                }
            }
            out
        };
        let mut term = matrix(&b, &Rational::one());
        let initial: Rational = term.iter().cloned().sum();
        for k in 0..65 {
            for (u, t) in upper.iter_mut().zip(&term) {
                *u += t;
            }
            if k < 64 {
                term = matrix(&term, &alpha);
            }
        }
        let tail = alpha.pow(65) * initial / (Rational::one() - &alpha);
        for u in &mut upper {
            *u += &tail;
        }
    }
    Reference {
        lower,
        upper,
        work,
        stages,
        complete: frontier.is_empty(),
    }
}
fn check(g: &a::Graph, h: f64, alpha: f64, budget: u64) -> a::Ranking {
    let expected = reference(g, h, alpha, budget);
    let got = a::rank(
        g,
        &a::Parameters {
            h,
            alpha,
            work: budget,
        },
        Limits::default(),
    )
    .unwrap();
    assert!(got.numerically_approximate);
    assert_eq!(got.progress.completed_work, expected.work);
    assert_eq!(got.progress.complete_stages, expected.stages);
    assert_eq!(got.progress.exploration_complete, expected.complete);
    assert!(got.progress.upper.as_ref().unwrap().complete);
    for ((estimate, lower), upper) in got.weights.iter().zip(&expected.lower).zip(&expected.upper) {
        close(estimate.lower, lower);
        close(estimate.upper, upper);
    }
    got
}
fn encode(value: &a::Ranking) -> Vec<u64> {
    let p = &value.progress;
    let mut out = vec![
        u64::from(value.numerically_approximate),
        u64::from(p.initialization_complete),
        p.completed_work,
        p.complete_stages as u64,
        p.depth as u64,
        p.frontier_prefixes as u64,
        p.next_stage_work,
        u64::from(p.exploration_complete),
        p.peak_prefixes as u64,
    ];
    let w = &p.work;
    out.extend([
        w.numerical_operations,
        w.initialization_operations,
        w.route_operations,
        w.estimate_operations,
        w.edge_attempts,
        w.refusal_tests,
        w.matrix_edge_visits,
        w.flushed_terms,
    ]);
    let e = p.upper.as_ref().unwrap();
    out.extend([
        e.operations,
        e.matrix_edge_visits,
        e.complete_vectors as u64,
        u64::from(e.complete),
        u64::from(e.failed),
    ]);
    for e in &value.weights {
        out.extend([e.lower.to_bits(), e.upper.to_bits()]);
    }
    out
}
fn output(rows: &mut BTreeMap<String, Vec<u64>>, name: &str, value: &a::Ranking) {
    rows.insert(name.into(), encode(value));
}

pub fn oracle_vectors() -> BTreeMap<String, Vec<u64>> {
    let mut result = BTreeMap::new();
    for seed in 1..=12u64 {
        let mut state = seed;
        let mut edges = Vec::new();
        let mut refusals = Vec::new();
        for from in 0..5 {
            for to in 0..5 {
                state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
                if from != to && state >> 61 > 3 {
                    edges.push((from, to, 0.25));
                }
                if from != to && state & 31 == 1 {
                    refusals.push((from, to));
                }
            }
        }
        let g = graph(5, &edges, vec![1.0, 0.0, 0.5, 0.0, 0.0], &refusals);
        for alpha in [0.0, 0.5, 0.9] {
            for budget in [1, 7, 50, 100_000] {
                let ranking = check(&g, 3.0, alpha, budget);
                output(
                    &mut result,
                    &format!("oracle-{seed}-{}-{budget}", alpha.to_bits()),
                    &ranking,
                );
            }
        }
    }
    result
}
pub fn sum_vectors() -> BTreeMap<String, Vec<u64>> {
    let mut result = BTreeMap::new();
    let mut sum = a::Sum::default();
    let mut naive = 0.0f64;
    for _ in 0..10 {
        sum.add(0.1).unwrap();
        naive += 0.1;
    }
    assert_eq!(sum.finish().unwrap(), 1.0);
    assert_ne!(naive, 1.0);
    result.insert(
        "ten-tenths-sum".into(),
        vec![sum.finish().unwrap().to_bits(), naive.to_bits()],
    );
    let mut sum = a::Sum::default();
    for value in [1e16, 1.0, -1e16] {
        sum.add(value).unwrap();
    }
    assert_eq!(sum.finish().unwrap(), 1.0);
    let before = sum;
    assert!(sum.add(f64::INFINITY).is_err());
    assert_eq!(sum, before);
    result.insert(
        "small-term-recovered".into(),
        vec![sum.finish().unwrap().to_bits()],
    );
    let minimum = f64::MIN_POSITIVE;
    let next = f64::from_bits(minimum.to_bits() + 1);
    let mut sum = a::Sum::new(next).unwrap();
    sum.add(minimum).unwrap();
    let mut difference = a::Sum::new(next).unwrap();
    difference.add(-minimum).unwrap();
    assert_eq!(difference.finish().unwrap(), f64::from_bits(1));
    assert_eq!(sum.finish().unwrap(), 2.0 * minimum);
    assert!(a::input(&ratio(difference.finish().unwrap()), true).is_err());
    result.insert(
        "subnormal-correction-and-difference".into(),
        vec![
            sum.finish().unwrap().to_bits(),
            difference.finish().unwrap().to_bits(),
        ],
    );
    result
}
pub fn semantic_vectors() -> BTreeMap<String, Vec<u64>> {
    let mut result = BTreeMap::new();
    let g = graph(
        4,
        &[(0, 1, 0.5), (1, 2, 1.0), (2, 0, 1.0), (3, 2, 1.0)],
        vec![1.0, 0.0, 0.0, 1.0],
        &[(0, 2)],
    );
    let ranking = check(&g, 3.0, 0.5, 1000);
    assert_eq!(ranking.weights[0].lower, 2.5); // the independent root can reach this actor
    assert_eq!(ranking.weights[1].lower, 1.875);
    assert_eq!(ranking.weights[2].lower, 3.0); // the independent root survives
    assert!(ranking.progress.work.refusal_tests > 0);
    output(&mut result, "shun-and-independent-route", &ranking);
    let n = g.q.len();
    let reversed = a::Graph::new(
        g.actors.iter().rev().cloned().collect(),
        g.q.iter().rev().copied().collect(),
        (0..n)
            .rev()
            .map(|old| {
                g.rows[old]
                    .iter()
                    .rev()
                    .map(|e| a::Edge {
                        to: n - 1 - e.to,
                        share: e.share,
                    })
                    .collect()
            })
            .collect(),
        (0..n)
            .rev()
            .map(|old| {
                g.refusals[old]
                    .iter()
                    .rev()
                    .map(|actor| n - 1 - actor)
                    .collect()
            })
            .collect(),
        &Limits::default(),
    )
    .unwrap();
    assert_eq!(g, reversed);
    assert_eq!(
        encode(&ranking),
        encode(
            &a::rank(
                &reversed,
                &a::Parameters {
                    work: 1000,
                    ..a::Parameters::default()
                },
                Limits::default()
            )
            .unwrap()
        )
    );

    let cycle = graph(
        3,
        &[(0, 1, 0.5), (1, 2, 1.0), (2, 0, 1.0)],
        vec![1.0, 0.0, 0.0],
        &[],
    );
    let ranking = check(&cycle, 3.0, 0.5, 1000);
    assert_eq!(ranking.weights[0].lower, 1.0);
    assert_eq!(ranking.weights[1].lower, 1.5);
    assert_eq!(ranking.weights[2].lower, 0.75);
    output(&mut result, "proxy-cycle-no-own-return", &ranking);
    let g = graph(3, &[(0, 1, 0.5), (0, 2, 0.5)], vec![1.0, 0.0, 0.0], &[]);
    let stopped = check(&g, 3.0, 0.5, 1);
    assert_eq!(stopped.progress.completed_work, 0);
    assert!(!stopped.progress.exploration_complete);
    assert_eq!(
        stopped.progress.upper.as_ref().unwrap().complete_vectors,
        65
    );
    output(&mut result, "zero-expansion-complete-upper", &stopped);
    for (h, alpha) in [(0.0, 0.5), (3.0, 0.0), (3.0, 0.9)] {
        output(
            &mut result,
            &format!("parameters-{h}-{alpha}"),
            &check(&g, h, alpha, 1000),
        );
    }
    // Threshold acceptance is a later step. This tests the propagated value at one.
    let mut q = vec![1.0; 11];
    q[10] = 0.0;
    let edges: Vec<_> = (0..10).map(|from| (from, 10, 0.1)).collect();
    let g = graph(11, &edges, q, &[]);
    let threshold = check(&g, 1.0, 0.0, 1000);
    assert_eq!(threshold.weights[10].lower, 1.0);
    assert!(threshold.weights[10].lower >= 1.0);
    let exact = reference(&g, 1.0, 0.0, 1000);
    // The binary64 shares differ from signed 1/10, so keep that rational reference too.
    assert_eq!(rational(1, 10) * rational(10, 1), Rational::one());
    close(threshold.weights[10].lower, &exact.lower[10]);
    output(&mut result, "ten-tenths-threshold-value", &threshold);
    // Reversed delivery uses the same canonical numerical order.
    let n = g.q.len();
    let rows: Vec<_> = (0..n)
        .rev()
        .map(|old| {
            g.rows[old]
                .iter()
                .rev()
                .map(|e| a::Edge {
                    to: n - 1 - e.to,
                    share: e.share,
                })
                .collect()
        })
        .collect();
    let reversed = a::Graph::new(
        g.actors.iter().rev().cloned().collect(),
        g.q.iter().rev().copied().collect(),
        rows,
        vec![vec![]; n],
        &Limits::default(),
    )
    .unwrap();
    assert_eq!(g, reversed);
    assert_eq!(
        encode(&threshold),
        encode(
            &a::rank(
                &reversed,
                &a::Parameters {
                    h: 1.0,
                    alpha: 0.0,
                    work: 1000
                },
                Limits::default()
            )
            .unwrap()
        )
    );
    result
}

pub fn resource_vectors() -> BTreeMap<String, Vec<u64>> {
    let mut result = BTreeMap::new();
    let g = graph(3, &[(0, 1, 1.0), (1, 2, 1.0)], vec![1.0, 0.0, 0.0], &[]);
    let mut ranker = a::Ranker::new(&g, 3.0, 0.5, Limits::default()).unwrap();
    let before = ranker.progress();
    assert!(ranker.advance_with_operation_limit(1000, 0).is_err());
    assert_eq!(ranker.progress(), before);
    let failed = ranker.advance_with_operation_limit(1000, 1).unwrap_err();
    assert_eq!(failed.progress.completed_work, 0);
    assert_eq!(failed.progress.work.edge_attempts, 1);
    assert_eq!(failed.progress.work.route_operations, 1);
    let retained = ranker.estimates().unwrap();
    assert_eq!(retained.weights[1].lower, 0.0);
    output(
        &mut result,
        "stage-operation-refusal-retains-lower",
        &retained,
    );
    ranker.advance(1000).unwrap();
    let resumed = ranker.estimates().unwrap();
    close(resumed.weights[2].lower, &rational(3, 2));
    assert!(resumed.progress.work.edge_attempts > resumed.progress.completed_work);
    output(&mut result, "fresh-stage-after-refusal", &resumed);
    let branching = graph(3, &[(0, 1, 0.5), (0, 2, 0.5)], vec![1.0, 0.0, 0.0], &[]);
    let mut r = a::Ranker::new(
        &branching,
        3.0,
        0.5,
        Limits {
            max_prefixes: 2,
            ..Limits::default()
        },
    )
    .unwrap();
    let failed = r.advance(1000).unwrap_err();
    assert_eq!(
        failed.cause,
        a::PreparationError::Graph(jvc_rank::RankError::ResourceLimit("prefix states"))
    );
    assert_eq!(failed.progress.completed_work, 0);
    assert_eq!(failed.progress.work.edge_attempts, 2);
    assert_eq!(failed.progress.peak_prefixes, 2);
    result.insert(
        "failed-stage-retains-actual-prefix-peak".into(),
        vec![
            failed.progress.peak_prefixes as u64,
            failed.progress.work.edge_attempts,
        ],
    );

    for (name, limits) in [
        (
            "prefix",
            Limits {
                max_prefixes: 1,
                ..Limits::default()
            },
        ),
        (
            "visited",
            Limits {
                max_visited_actor_entries: 2,
                ..Limits::default()
            },
        ),
    ] {
        let mut r = a::Ranker::new(&g, 3.0, 0.5, limits).unwrap();
        let failure = r.advance(1000).unwrap_err();
        assert_eq!(failure.progress.completed_work, 0);
        assert_eq!(failure.progress.work.edge_attempts, 1);
        let lower = r.estimates().unwrap();
        assert_eq!(lower.weights[1].lower, 0.0);
        output(
            &mut result,
            &format!("{name}-failure-retains-stage"),
            &lower,
        );
    }
    let limits = Limits {
        max_prefixes: 2,
        max_visited_actor_entries: 3,
        ..Limits::default()
    };
    let mut r = a::Ranker::new(&g, 3.0, 0.5, limits).unwrap();
    r.advance(1).unwrap();
    assert_eq!(r.progress().completed_work, 1);
    output(
        &mut result,
        "inclusive-stage-resources",
        &r.estimates().unwrap(),
    );
    let g = graph(
        3,
        &[(0, 1, 1.0), (1, 2, 1.0)],
        vec![1.0, 0.0, 0.0],
        &[(2, 1)],
    );
    let mut r = a::Ranker::new(
        &g,
        3.0,
        0.5,
        Limits {
            max_refusal_tests: 0,
            ..Limits::default()
        },
    )
    .unwrap();
    let f = r.advance(1).unwrap_err();
    assert_eq!(f.progress.work.edge_attempts, 1);
    assert_eq!(f.progress.work.refusal_tests, 0);
    result.insert(
        "refusal-search-limit".into(),
        vec![
            f.progress.work.numerical_operations,
            f.progress.work.edge_attempts,
        ],
    );
    // No result escapes from any stopped upper phase, even after vector 65.
    let g = graph(3, &[(0, 1, 0.5), (0, 2, 0.5)], vec![1.0, 0.0, 0.0], &[]);
    let mut r = a::Ranker::new(&g, 3.0, 0.5, Limits::default()).unwrap();
    let ready = r.estimates().unwrap();
    let full = ready.progress.upper.as_ref().unwrap().operations;
    for limit in [1, 10, 50, full - 1] {
        let mut r = a::Ranker::new(&g, 3.0, 0.5, Limits::default()).unwrap();
        let failure = r.estimates_with_operation_limit(limit).unwrap_err();
        let upper = failure.progress.upper.as_ref().unwrap();
        assert!(!upper.complete && upper.failed);
        assert_eq!(upper.operations, limit);
        result.insert(
            format!("incomplete-upper-{limit}"),
            vec![
                upper.operations,
                upper.complete_vectors as u64,
                upper.matrix_edge_visits,
            ],
        );
    }
    let mut r = a::Ranker::new(&g, 3.0, 0.5, Limits::default()).unwrap();
    let ready = r.estimates_with_operation_limit(full).unwrap();
    assert!(ready.progress.upper.as_ref().unwrap().complete);
    output(&mut result, "inclusive-upper-operation-limit", &ready);
    let mut r = a::Ranker::new(
        &g,
        3.0,
        0.5,
        Limits {
            max_matrix_edge_visits: 3,
            ..Limits::default()
        },
    )
    .unwrap();
    let failure = r.estimates().unwrap_err();
    assert_eq!(
        failure.progress.upper.as_ref().unwrap().matrix_edge_visits,
        3
    );
    assert_eq!(failure.progress.upper.as_ref().unwrap().complete_vectors, 1);
    result.insert(
        "incomplete-matrix-upper".into(),
        vec![failure.progress.work.matrix_edge_visits],
    );
    let mut bad = g.clone();
    bad.q[0] = f64::from_bits(1);
    assert!(a::Ranker::new(&bad, 3.0, 0.5, Limits::default()).is_err());
    assert!(a::Ranker::new(&g, f64::from_bits(1), 0.5, Limits::default()).is_err());
    assert!(a::Ranker::new(&g, 3.0, f64::from_bits(1), Limits::default()).is_err());
    let g = graph(1, &[], vec![f64::MAX], &[]);
    let failure = a::Ranker::new(&g, 2.0, 0.5, Limits::default()).unwrap_err();
    assert_eq!(failure.cause, a::PreparationError::NumericUnavailable);
    assert_eq!(failure.progress.work.initialization_operations, 1);
    assert!(!failure.progress.initialization_complete);
    assert!(!failure.progress.exploration_complete);
    result.insert(
        "overflow-preserves-work".into(),
        vec![failure.progress.work.numerical_operations],
    );
    result
}

pub fn flushing_vectors() -> BTreeMap<String, Vec<u64>> {
    let mut result = BTreeMap::new();
    let m = f64::MIN_POSITIVE;
    for (name, q, h, expected_flushes) in [
        (
            "below-rounded-up",
            f64::from_bits((2.0 * m).to_bits() - 1),
            0.5,
            1,
        ),
        ("at", 2.0 * m, 0.5, 0),
        ("above", f64::from_bits((2.0 * m).to_bits() + 1), 0.5, 0),
        ("underflow-zero", m, m, 1),
    ] {
        let g = graph(1, &[], vec![q], &[]);
        let ranking = a::rank(
            &g,
            &a::Parameters {
                h,
                alpha: 0.5,
                work: 1,
            },
            Limits::default(),
        )
        .unwrap();
        assert_eq!(ranking.progress.work.flushed_terms, expected_flushes);
        assert_eq!(ranking.weights[0].lower, q);
        output(&mut result, &format!("initial-flush-{name}"), &ranking);
    }
    let g = graph(3, &[(0, 1, 0.5), (1, 2, 1.0)], vec![m, 0.0, 1.0], &[]);
    let ranking = a::rank(
        &g,
        &a::Parameters {
            h: 1.0,
            alpha: 0.5,
            work: 1000,
        },
        Limits::default(),
    )
    .unwrap();
    assert_eq!(ranking.weights[1].lower, 0.0);
    assert_eq!(ranking.weights[2].lower, 1.0);
    assert_eq!(ranking.progress.work.flushed_terms, 1);
    output(&mut result, "route-flush-keeps-ordinary-root", &ranking);
    let mut r = a::Ranker::new(&g, 1.0, 0.5, Limits::default()).unwrap();
    let ranking = r.estimates().unwrap();
    assert_eq!(ranking.progress.work.flushed_terms, 1);
    output(&mut result, "relaxed-flush", &ranking);
    let g = graph(3, &[(0, 1, 1.0)], vec![m, 0.0, 1.0], &[]);
    let ranking = a::rank(
        &g,
        &a::Parameters {
            h: 1.0,
            alpha: 0.5,
            work: 1000,
        },
        Limits::default(),
    )
    .unwrap();
    assert_eq!(ranking.weights[1].lower, m);
    assert_eq!(ranking.weights[2].lower, 1.0);
    assert_eq!(ranking.progress.work.flushed_terms, 1);
    output(
        &mut result,
        "onward-flush-retains-received-credit",
        &ranking,
    );
    let mut r = a::Ranker::new(&g, 1.0, 0.5, Limits::default()).unwrap();
    let ranking = r.estimates().unwrap();
    assert_eq!(ranking.progress.work.flushed_terms, 1);
    assert_eq!(ranking.weights[1].upper, m);
    output(&mut result, "tail-flush", &ranking);
    let g = graph(4, &[(0, 2, 0.5), (1, 3, 1.0)], vec![m, 1.0, 0.0, 0.0], &[]);
    let mut r = a::Ranker::new(&g, 1.0, 0.5, Limits::default()).unwrap();
    let failed = r.advance_with_operation_limit(1000, 1).unwrap_err();
    assert_eq!(failed.progress.completed_work, 0);
    assert_eq!(failed.progress.work.flushed_terms, 1);
    result.insert(
        "discarded-stage-keeps-flush-count".into(),
        vec![
            failed.progress.work.flushed_terms,
            failed.progress.work.edge_attempts,
        ],
    );

    let g = graph(3, &[(0, 1, 1.0)], vec![1e300, 0.0, 0.0], &[]);
    let mut r = a::Ranker::new(&g, 1.0, 1e-5, Limits::default()).unwrap();
    let ranking = r.estimates().unwrap();
    assert!(
        ranking.weights[0].upper > ranking.weights[0].lower || ranking.weights[0].lower == 1e300
    );
    // The scalar alpha^65 underflows, but this tail remains normal.
    let expected = ratio(1e-5).pow(65) * ratio(1e300) / (Rational::one() - ratio(1e-5));
    assert!(expected.to_f64().unwrap().is_normal());
    assert!(ranking.weights[2].upper.is_normal());
    close(ranking.weights[2].upper, &expected);
    assert_eq!(ranking.progress.work.flushed_terms, 0);
    output(&mut result, "tail-keeps-mass-before-power", &ranking);
    let n = 1101;
    let edges: Vec<_> = (0..n - 1).map(|i| (i, i + 1, 1.0)).collect();
    let mut q = vec![0.0; n];
    q[0] = 1.0;
    q[n - 1] = 1.0;
    let g = graph(n, &edges, q, &[]);
    let ranking = a::rank(&g, &a::Parameters::default(), Limits::default()).unwrap();
    assert_eq!(ranking.progress.work.flushed_terms, 1);
    assert!(ranking.progress.exploration_complete);
    assert_eq!(ranking.weights[1].lower, 3.0);
    assert_eq!(ranking.weights[n - 1].lower, 1.0);
    output(&mut result, "1100-hop-halving-chain", &ranking);
    // A long normal chain exercises products without any ranking decision rule.
    let length = 4402;
    let n = 2 * (length + 1);
    let mut edges = Vec::new();
    let mut q = vec![0.0; n];
    q[0] = 1.0;
    q[length + 1] = 1.0;
    for chain in 0..2 {
        for hop in 0..length {
            let from = chain * (length + 1) + hop;
            let share = if (hop + chain) % 2 == 0 {
                0.999_999
            } else {
                0.999_998
            };
            edges.push((from, from + 1, share));
        }
    }
    let g = graph(n, &edges, q, &[]);
    let ranking = a::rank(
        &g,
        &a::Parameters {
            h: 3.0,
            alpha: 0.9,
            work: 100_000,
        },
        Limits::default(),
    )
    .unwrap();
    assert_eq!(ranking.progress.work.flushed_terms, 0);
    assert_eq!(ranking.progress.depth, length);
    let expected = ratio(3.0)
        * ratio(0.9).pow((length - 1) as i32)
        * (ratio(0.999_999) * ratio(0.999_998)).pow((length / 2) as i32);
    close(ranking.weights[length].lower, &expected);
    close(ranking.weights[n - 1].lower, &expected);
    output(&mut result, "long-equal-normal-chains", &ranking);
    result
}

#[allow(dead_code)]
pub fn all_vectors() -> BTreeMap<String, Vec<u64>> {
    let mut out = oracle_vectors();
    out.extend(sum_vectors());
    out.extend(semantic_vectors());
    out.extend(resource_vectors());
    out.extend(flushing_vectors());
    out
}
#[allow(dead_code)]
pub fn encoded_suite() -> String {
    all_vectors()
        .into_iter()
        .map(|(name, values)| {
            format!(
                "{name}|{}\n",
                values
                    .into_iter()
                    .map(|n| format!("{n:016x}"))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        })
        .collect()
}
