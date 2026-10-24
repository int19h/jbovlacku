use jvc_rank::*;
use num_traits::{One, Zero};

pub struct Measurement {
    pub actors: usize,
    pub edges: usize,
    pub completed_work: u64,
    pub complete_stages: usize,
    pub exact: bool,
    pub peak_prefixes: usize,
    pub arithmetic_bits: u64,
    pub comparisons: usize,
    pub strict: usize,
    pub ties: usize,
    pub digest: u64,
}
// These graphs use synthetic trust assumptions. They contain no imported votes.
pub fn scenario(hostile: bool, n: usize) -> Result<Graph, RankError> {
    if n < 8 {
        return Err(RankError::InvalidParameters(
            "benchmark needs at least eight actors".into(),
        ));
    }
    let mut q = vec![Rational::zero(); n];
    let mut rows = vec![Vec::new(); n];
    if hostile {
        q.fill(Rational::one());
        for (from, row) in rows.iter_mut().enumerate() {
            for to in 0..n {
                if to != from {
                    row.push(Edge {
                        to,
                        share: rational(1, (n - 1) as i64),
                    });
                }
            }
        }
    } else {
        let root_count = (n / 32).max(1);
        for root in 0..root_count {
            q[root] = Rational::one();
            for offset in 0..3 {
                let delegate = root_count + root * 3 + offset;
                rows[root].push(Edge {
                    to: delegate,
                    share: rational(1, 3),
                });
                for author_offset in 0..3 {
                    let author = root_count * 4
                        + (root * 9 + offset * 3 + author_offset) % (n - root_count * 4);
                    rows[delegate].push(Edge {
                        to: author,
                        share: rational(1, 3),
                    });
                }
            }
        }
    }
    Graph::new((0..n).map(|i| format!("actor{i:06}")).collect(), q, rows)
}
fn hash(bytes: &[u8], value: &mut u64) {
    for &byte in bytes {
        *value ^= u64::from(byte);
        *value = value.wrapping_mul(1099511628211);
    }
}
pub fn measure(hostile: bool, n: usize, work: u64) -> Result<Measurement, RankError> {
    measure_graph(scenario(hostile, n)?, work)
}
pub fn measure_weighted(n: usize, work: u64) -> Result<Measurement, RankError> {
    let primes: [i64; 16] = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53];
    if !(8..=16).contains(&n) {
        return Err(RankError::InvalidParameters(
            "weighted probe actor count must be eight through sixteen".into(),
        ));
    }
    let mut rows = Vec::new();
    for from in 0..n {
        let sum: i64 = (0..n)
            .filter(|&to| to != from)
            .map(|to| primes[(from * 2 + to) % n])
            .sum();
        rows.push(
            (0..n)
                .filter(|&to| to != from)
                .map(|to| Edge {
                    to,
                    share: rational(primes[(from * 2 + to) % n], sum),
                })
                .collect(),
        );
    }
    let graph = Graph::new(
        (0..n).map(|i| format!("actor{i:06}")).collect(),
        vec![Rational::one(); n],
        rows,
    )?;
    measure_graph(graph, work)
}
fn measure_graph(graph: Graph, work: u64) -> Result<Measurement, RankError> {
    let n = graph.actors.len();
    let ranking = rank(
        &graph,
        &Parameters {
            work,
            ..Parameters::default()
        },
        Limits::default(),
    )?;
    let candidates: Vec<_> = (0..32)
        .map(|candidate| {
            let mut verdicts = (0..n)
                .map(|actor| {
                    if actor % 7 == 0 {
                        Verdict::Bless
                    } else {
                        Verdict::Absent
                    }
                })
                .collect::<Vec<_>>();
            verdicts[candidate % n] = Verdict::Bless;
            verdicts[(candidate * 7 + 11) % n] = Verdict::Curse;
            Candidate {
                id: format!("candidate{candidate:02}"),
                verdicts,
                eligibility: Eligibility::Eligible,
                deprecated: false,
            }
        })
        .collect();
    let mut digest = 14695981039346656037_u64;
    for w in &ranking.weights {
        hash(w.lower.to_string().as_bytes(), &mut digest);
        hash(b"/", &mut digest);
        hash(w.upper.to_string().as_bytes(), &mut digest);
        hash(b";", &mut digest);
    }
    let mut comparisons = 0;
    let mut strict = 0;
    let mut ties = 0;
    for (index, a) in candidates.iter().enumerate() {
        let score = score(a, &ranking.weights)?;
        hash(score.net.lower.to_string().as_bytes(), &mut digest);
        hash(score.net.upper.to_string().as_bytes(), &mut digest);
        for b in &candidates[index + 1..] {
            let delta = difference(a, b, &ranking.weights)?;
            comparisons += 1;
            strict += usize::from(delta.lower > Rational::zero() || delta.upper < Rational::zero());
            ties += usize::from(delta.is_exact() && delta.lower.is_zero());
        }
    }
    let layers = nondominated_layers(&candidates, &ranking.weights, &Limits::default())?;
    for layer in &layers {
        for id in layer {
            hash(id.as_bytes(), &mut digest);
        }
        hash(b"|", &mut digest);
    }
    Ok(Measurement {
        actors: n,
        edges: graph.rows.iter().map(Vec::len).sum(),
        completed_work: ranking.completed_work,
        complete_stages: ranking.complete_stages,
        exact: ranking.exact,
        peak_prefixes: ranking.peak_prefixes,
        arithmetic_bits: ranking.max_arithmetic_bits,
        comparisons,
        strict,
        ties,
        digest,
    })
}

// Independent route enumeration also runs inside the WebAssembly module.
pub fn tiny_oracle_suite() -> bool {
    fn enumerate(
        graph: &Graph,
        root: usize,
        path: &mut Vec<usize>,
        product: Rational,
        target: &mut [Rational],
    ) {
        for edge in &graph.rows[*path.last().unwrap()] {
            if path.contains(&edge.to) {
                continue;
            }
            let product = &product * &edge.share;
            target[edge.to] += rational(3, 1)
                * &graph.q[root]
                * rational(1, 2).pow(path.len() as i32 - 1)
                * &product;
            path.push(edge.to);
            enumerate(graph, root, path, product, target);
            path.pop();
        }
    }
    for seed in 1..=8_u64 {
        let mut random = seed;
        let mut rows = vec![Vec::new(); 5];
        for (from, row) in rows.iter_mut().enumerate() {
            for to in 0..5 {
                random = random.wrapping_mul(6364136223846793005).wrapping_add(1);
                if to != from && random >> 62 > 0 {
                    row.push(Edge {
                        to,
                        share: Rational::one(),
                    });
                }
            }
            let divisor = rational(row.len().max(1) as i64, 1);
            for edge in row {
                edge.share /= &divisor;
            }
        }
        let graph = Graph::new(
            (0..5).map(|i| i.to_string()).collect(),
            vec![
                Rational::one(),
                Rational::zero(),
                Rational::one(),
                Rational::zero(),
                Rational::zero(),
            ],
            rows,
        )
        .unwrap();
        let mut exact = graph.q.clone();
        for root in 0..5 {
            enumerate(&graph, root, &mut vec![root], Rational::one(), &mut exact);
        }
        for work in [1, 5, 1000] {
            let ranking = rank(
                &graph,
                &Parameters {
                    work,
                    ..Parameters::default()
                },
                Limits::default(),
            )
            .unwrap();
            if ranking
                .weights
                .iter()
                .zip(&exact)
                .any(|(w, exact)| w.lower > *exact || w.upper < *exact)
            {
                return false;
            }
            let a = Candidate {
                id: "a".into(),
                verdicts: vec![
                    Verdict::Bless,
                    Verdict::Curse,
                    Verdict::Bless,
                    Verdict::Absent,
                    Verdict::Bless,
                ],
                eligibility: Eligibility::Eligible,
                deprecated: false,
            };
            let b = Candidate {
                id: "b".into(),
                verdicts: vec![
                    Verdict::Bless,
                    Verdict::Bless,
                    Verdict::Curse,
                    Verdict::Absent,
                    Verdict::Bless,
                ],
                eligibility: Eligibility::Eligible,
                deprecated: false,
            };
            let exact_delta = rational(2, 1) * (&exact[2] - &exact[1]);
            let bounds = difference(&a, &b, &ranking.weights).unwrap();
            if bounds.lower > exact_delta || bounds.upper < exact_delta {
                return false;
            }
        }
    }
    true
}
