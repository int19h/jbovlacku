//! Exact ranking for the supported simple-route calculation profiles.
//!
//! The caller resolves identity continuity and effective scoped judgments first.
//! Missing state is an error in that layer. It must never become a zero weight.
use num_bigint::BigInt;
use num_traits::{One, Zero};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

pub type Rational = num_rational::BigRational;
pub const ALGORITHM: &str = "simple-routes-bounds-v1";
pub const SHUN_ALGORITHM: &str = "simple-routes-shun-v1";
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Profile {
    #[default]
    BoundsV1,
    ShunV1,
}
impl Profile {
    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            ALGORITHM => Some(Self::BoundsV1),
            SHUN_ALGORITHM => Some(Self::ShunV1),
            _ => None,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::BoundsV1 => ALGORITHM,
            Self::ShunV1 => SHUN_ALGORITHM,
        }
    }
}
pub fn rational(n: i64, d: i64) -> Rational {
    Rational::new(BigInt::from(n), BigInt::from(d))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RankError {
    InvalidGraph(String),
    InvalidParameters(String),
    UnavailableCandidate(String),
    ResourceLimit(&'static str),
}
impl fmt::Display for RankError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidGraph(s) | Self::InvalidParameters(s) => f.write_str(s),
            Self::UnavailableCandidate(id) => write!(f, "candidate eligibility unavailable: {id}"),
            Self::ResourceLimit(s) => write!(f, "ranking resource limit: {s}"),
        }
    }
}
impl std::error::Error for RankError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Edge {
    pub to: usize,
    pub share: Rational,
}
#[derive(Clone, Debug)]
pub struct Graph {
    pub profile: Profile,
    pub actors: Vec<String>,
    pub q: Vec<Rational>,
    pub rows: Vec<Vec<Edge>>,
    /// Each target lists the earlier actors whose effective shuns forbid entry.
    /// The old profile uses an empty relation.
    pub refusals: Vec<Vec<usize>>,
}
impl Graph {
    /// Each actor is a resolved continuity group. Rows contain unique destinations.
    pub fn new(
        actors: Vec<String>,
        q: Vec<Rational>,
        rows: Vec<Vec<Edge>>,
    ) -> Result<Self, RankError> {
        Self::with_limits(actors, q, rows, &Limits::default())
    }
    pub fn with_limits(
        actors: Vec<String>,
        q: Vec<Rational>,
        rows: Vec<Vec<Edge>>,
        limits: &Limits,
    ) -> Result<Self, RankError> {
        if actors.len() > limits.max_actors {
            return Err(RankError::ResourceLimit("actors"));
        }
        Self::with_refusals(Profile::BoundsV1, actors, q, rows, Vec::new(), limits)
    }
    pub fn with_refusals(
        profile: Profile,
        actors: Vec<String>,
        q: Vec<Rational>,
        mut rows: Vec<Vec<Edge>>,
        mut refusals: Vec<Vec<usize>>,
        limits: &Limits,
    ) -> Result<Self, RankError> {
        let n = actors.len();
        if n > limits.max_actors {
            return Err(RankError::ResourceLimit("actors"));
        }
        if rows.iter().map(Vec::len).sum::<usize>() > limits.max_edges {
            return Err(RankError::ResourceLimit("edges"));
        }
        if profile == Profile::BoundsV1 {
            refusals = Vec::new();
        }
        if profile == Profile::ShunV1
            && refusals.iter().map(Vec::len).sum::<usize>() > limits.max_refusals
        {
            return Err(RankError::ResourceLimit("refusals"));
        }
        let mut arithmetic_bits = 0;
        for value in q
            .iter()
            .chain(rows.iter().flatten().map(|edge| &edge.share))
        {
            check(value, limits, &mut arithmetic_bits)?;
        }
        if q.len() != n || rows.len() != n || (profile == Profile::ShunV1 && refusals.len() != n) {
            return Err(RankError::InvalidGraph("graph dimensions differ".into()));
        }
        if actors.iter().collect::<BTreeSet<_>>().len() != n {
            return Err(RankError::InvalidGraph("duplicate actor ID".into()));
        }
        if q.iter().any(|q| q < &Rational::zero()) {
            return Err(RankError::InvalidGraph(
                "negative starting allowance".into(),
            ));
        }
        for (target, list) in refusals.iter_mut().enumerate() {
            list.sort_unstable();
            if list.iter().any(|&actor| actor >= n || actor == target)
                || list.windows(2).any(|pair| pair[0] == pair[1])
            {
                return Err(RankError::InvalidGraph(
                    "invalid or duplicate refusal".into(),
                ));
            }
        }
        for (from, row) in rows.iter_mut().enumerate() {
            row.sort_by_key(|edge| edge.to);
            let mut sum = Rational::zero();
            let mut last = None;
            for edge in row.iter() {
                if edge.to >= n
                    || edge.to == from
                    || edge.share <= Rational::zero()
                    || last == Some(edge.to)
                {
                    return Err(RankError::InvalidGraph(
                        "invalid edge or duplicate destination".into(),
                    ));
                }
                sum += &edge.share;
                check(&sum, limits, &mut arithmetic_bits)?;
                last = Some(edge.to);
            }
            if sum > Rational::one() {
                return Err(RankError::InvalidGraph("outgoing shares exceed one".into()));
            }
        }
        Ok(Self {
            profile,
            actors,
            q,
            rows,
            refusals,
        })
    }
}

/// Normalize resolved positive weights before removing blocked destinations.
/// The caller removes self destinations and resolves duplicate opinions first.
pub fn normalize_row(
    weights: &BTreeMap<String, Rational>,
    blocked: &BTreeSet<String>,
) -> Result<BTreeMap<String, Rational>, RankError> {
    let limits = Limits::default();
    if weights.len() > limits.max_edges {
        return Err(RankError::ResourceLimit("edges"));
    }
    let mut arithmetic_bits = 0;
    for value in weights.values() {
        check(value, &limits, &mut arithmetic_bits)?;
    }
    if weights.values().any(|w| w <= &Rational::zero()) {
        return Err(RankError::InvalidGraph(
            "row weights must be positive".into(),
        ));
    }
    let mut sum = Rational::zero();
    for value in weights.values() {
        sum += value;
        check(&sum, &limits, &mut arithmetic_bits)?;
    }
    let divisor = sum.max(Rational::one());
    Ok(weights
        .iter()
        .filter(|(id, _)| !blocked.contains(*id))
        .map(|(id, weight)| (id.clone(), weight / &divisor))
        .collect())
}

#[derive(Clone, Debug)]
pub struct Parameters {
    pub h: Rational,
    pub alpha: Rational,
    pub work: u64,
}
impl Default for Parameters {
    fn default() -> Self {
        Self {
            h: rational(3, 1),
            alpha: rational(1, 2),
            work: 1_000_000,
        }
    }
}
#[derive(Clone, Debug)]
pub struct Limits {
    pub max_actors: usize,
    pub max_edges: usize,
    pub max_refusals: usize,
    pub max_refusal_tests: u64,
    pub max_prefixes: usize,
    pub max_visited_actor_entries: usize,
    pub max_rational_bits: u64,
    pub max_matrix_edge_visits: u64,
    pub max_candidate_pairs: usize,
    pub max_candidate_actor_terms: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            max_actors: 10_000,
            max_edges: 100_000,
            max_refusals: 100_000,
            max_refusal_tests: 10_000_000,
            max_prefixes: 250_000,
            max_visited_actor_entries: 4_000_000,
            max_rational_bits: 16_384,
            max_matrix_edge_visits: 10_000_000,
            max_candidate_pairs: 1_000_000,
            max_candidate_actor_terms: 10_000_000,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Interval {
    pub lower: Rational,
    pub upper: Rational,
}
impl Interval {
    pub fn exact(value: Rational) -> Self {
        Self {
            lower: value.clone(),
            upper: value,
        }
    }
    pub fn is_exact(&self) -> bool {
        self.lower == self.upper
    }
}
#[derive(Clone, Debug)]
pub struct Ranking {
    pub weights: Vec<Interval>,
    pub completed_work: u64,
    pub complete_stages: usize,
    pub exact: bool,
    pub peak_prefixes: usize,
    pub max_arithmetic_bits: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Prefix {
    visited: Vec<usize>,
    endpoint: usize,
}

/// Retain complete stages for a later calculation with a larger total budget.
/// Upper contributions never enter the retained lower totals.
pub struct Ranker<'a> {
    graph: &'a Graph,
    h: Rational,
    alpha: Rational,
    limits: Limits,
    lower: Vec<Rational>,
    prefixes: BTreeMap<Prefix, Rational>,
    completed_work: u64,
    refusal_tests: u64,
    stages: usize,
    peak_prefixes: usize,
    max_bits: u64,
}
fn bits(value: &Rational) -> u64 {
    value.numer().bits().max(value.denom().bits())
}
fn check(value: &Rational, limits: &Limits, max_bits: &mut u64) -> Result<(), RankError> {
    let size = bits(value);
    *max_bits = (*max_bits).max(size);
    if size > limits.max_rational_bits {
        return Err(RankError::ResourceLimit("rational bits"));
    }
    Ok(())
}
fn refused(
    visited: &[usize],
    shunners: &[usize],
    tests: &mut u64,
    limit: u64,
) -> Result<bool, RankError> {
    let (shorter, longer) = if visited.len() < shunners.len() {
        (visited, shunners)
    } else {
        (shunners, visited)
    };
    for actor in shorter {
        if *tests >= limit {
            return Err(RankError::ResourceLimit("refusal tests"));
        }
        *tests += 1;
        if longer.binary_search(actor).is_ok() {
            return Ok(true);
        }
    }
    Ok(false)
}
impl<'a> Ranker<'a> {
    pub fn new(
        graph: &'a Graph,
        h: Rational,
        alpha: Rational,
        limits: Limits,
    ) -> Result<Self, RankError> {
        // Public graph fields support inspection. Revalidate them before calculation.
        if h < Rational::zero()
            || h > rational(100, 1)
            || alpha < Rational::zero()
            || alpha > rational(9, 10)
        {
            return Err(RankError::InvalidParameters(
                "H or alpha is outside the profile range".into(),
            ));
        }
        if graph.actors.len() > limits.max_actors {
            return Err(RankError::ResourceLimit("actors"));
        }
        if graph.rows.iter().map(Vec::len).sum::<usize>() > limits.max_edges {
            return Err(RankError::ResourceLimit("edges"));
        }
        if graph.profile == Profile::ShunV1
            && graph.refusals.iter().map(Vec::len).sum::<usize>() > limits.max_refusals
        {
            return Err(RankError::ResourceLimit("refusals"));
        }
        let mut max_bits = 0;
        for value in graph
            .q
            .iter()
            .chain(graph.rows.iter().flatten().map(|edge| &edge.share))
            .chain([&h, &alpha])
        {
            check(value, &limits, &mut max_bits)?;
        }
        let validated = Graph::with_refusals(
            graph.profile,
            graph.actors.clone(),
            graph.q.clone(),
            graph.rows.clone(),
            if graph.profile == Profile::ShunV1 {
                graph.refusals.clone()
            } else {
                Vec::new()
            },
            &limits,
        )?;
        if graph.profile == Profile::ShunV1 && graph.refusals != validated.refusals {
            return Err(RankError::InvalidGraph(
                "refusal lists must be sorted".into(),
            ));
        }
        let mut prefixes = BTreeMap::new();
        for (actor, q) in graph.q.iter().enumerate() {
            let mass = &h * q;
            check(&mass, &limits, &mut max_bits)?;
            if !mass.is_zero() {
                prefixes.insert(
                    Prefix {
                        visited: vec![actor],
                        endpoint: actor,
                    },
                    mass,
                );
            }
        }
        if prefixes.len() > limits.max_visited_actor_entries {
            return Err(RankError::ResourceLimit("visited actor entries"));
        }
        if prefixes.len() > limits.max_prefixes {
            return Err(RankError::ResourceLimit("prefix states"));
        }
        let peak_prefixes = prefixes.len();
        Ok(Self {
            graph,
            h,
            alpha,
            limits,
            lower: graph.q.clone(),
            prefixes,
            completed_work: 0,
            refusal_tests: 0,
            stages: 0,
            peak_prefixes,
            max_bits,
        })
    }

    pub fn advance(&mut self, total_budget: u64) -> Result<(), RankError> {
        if !(1..=10_000_000).contains(&total_budget) || total_budget < self.completed_work {
            return Err(RankError::InvalidParameters(
                "work budget is outside the profile range or below completed work".into(),
            ));
        }
        while !self.prefixes.is_empty() {
            let cost = self
                .prefixes
                .keys()
                .try_fold(0_u64, |cost, prefix| {
                    cost.checked_add(self.graph.rows[prefix.endpoint].len() as u64)
                })
                .ok_or(RankError::ResourceLimit("stage cost"))?;
            if cost > total_budget - self.completed_work {
                break;
            }
            // Commit the whole stage only after all resource checks succeed.
            let mut lower = self.lower.clone();
            let mut next: BTreeMap<Prefix, Rational> = BTreeMap::new();
            let mut stage_bits = self.max_bits;
            let mut refusal_tests = self.refusal_tests;
            let mut visited_entries: usize = self.prefixes.keys().map(|p| p.visited.len()).sum();
            for (prefix, mass) in &self.prefixes {
                for edge in &self.graph.rows[prefix.endpoint] {
                    if prefix.visited.binary_search(&edge.to).is_ok() {
                        continue;
                    }
                    if self.graph.profile == Profile::ShunV1
                        && refused(
                            &prefix.visited,
                            &self.graph.refusals[edge.to],
                            &mut refusal_tests,
                            self.limits.max_refusal_tests,
                        )?
                    {
                        continue;
                    }
                    let credit = mass * &edge.share;
                    check(&credit, &self.limits, &mut stage_bits)?;
                    lower[edge.to] += &credit;
                    check(&lower[edge.to], &self.limits, &mut stage_bits)?;
                    let onward = credit * &self.alpha;
                    check(&onward, &self.limits, &mut stage_bits)?;
                    if onward.is_zero() {
                        continue;
                    }
                    let mut visited = prefix.visited.clone();
                    let insert_at = visited.binary_search(&edge.to).unwrap_err();
                    visited.insert(insert_at, edge.to);
                    let key = Prefix {
                        visited,
                        endpoint: edge.to,
                    };
                    if !next.contains_key(&key)
                        && self.prefixes.len() + next.len() >= self.limits.max_prefixes
                    {
                        return Err(RankError::ResourceLimit("prefix states"));
                    }
                    if !next.contains_key(&key) {
                        visited_entries = visited_entries
                            .checked_add(key.visited.len())
                            .ok_or(RankError::ResourceLimit("visited actor entries"))?;
                        if visited_entries > self.limits.max_visited_actor_entries {
                            return Err(RankError::ResourceLimit("visited actor entries"));
                        }
                    }
                    let value = next.entry(key).or_default();
                    *value += onward;
                    check(value, &self.limits, &mut stage_bits)?;
                }
            }
            self.peak_prefixes = self.peak_prefixes.max(self.prefixes.len() + next.len());
            self.lower = lower;
            self.prefixes = next;
            self.completed_work += cost;
            self.stages += 1;
            self.max_bits = stage_bits;
            self.refusal_tests = refusal_tests;
        }
        Ok(())
    }

    pub fn bounds(&self) -> Result<Ranking, RankError> {
        let mut max_bits = self.max_bits;
        let mut upper = self.lower.clone();
        if !self.prefixes.is_empty() {
            let edge_count = self.graph.rows.iter().map(Vec::len).sum::<usize>() as u64;
            if edge_count
                .checked_mul(65)
                .ok_or(RankError::ResourceLimit("matrix edge visits"))?
                > self.limits.max_matrix_edge_visits
            {
                return Err(RankError::ResourceLimit("matrix edge visits"));
            }
            let mut b = vec![Rational::zero(); self.lower.len()];
            for (prefix, mass) in &self.prefixes {
                b[prefix.endpoint] += mass;
                check(&b[prefix.endpoint], &self.limits, &mut max_bits)?;
            }
            let mut term = self.multiply_transpose(&b, &Rational::one(), &mut max_bits)?;
            let f_sum: Rational = term.iter().cloned().sum();
            check(&f_sum, &self.limits, &mut max_bits)?;
            // Add exactly 65 vectors: f through alpha^64 * P^T^64 * f.
            for k in 0..65 {
                for (u, t) in upper.iter_mut().zip(&term) {
                    *u += t;
                    check(u, &self.limits, &mut max_bits)?;
                }
                if k < 64 {
                    term = self.multiply_transpose(&term, &self.alpha, &mut max_bits)?;
                }
            }
            let tail = self.alpha.pow(65) * f_sum / (Rational::one() - &self.alpha);
            check(&tail, &self.limits, &mut max_bits)?;
            for u in &mut upper {
                *u += &tail;
                check(u, &self.limits, &mut max_bits)?;
            }
        }
        Ok(Ranking {
            weights: self
                .lower
                .iter()
                .cloned()
                .zip(upper)
                .map(|(lower, upper)| Interval { lower, upper })
                .collect(),
            completed_work: self.completed_work,
            complete_stages: self.stages,
            exact: self.prefixes.is_empty(),
            peak_prefixes: self.peak_prefixes,
            max_arithmetic_bits: max_bits,
        })
    }
    fn multiply_transpose(
        &self,
        vector: &[Rational],
        factor: &Rational,
        max_bits: &mut u64,
    ) -> Result<Vec<Rational>, RankError> {
        let mut output = vec![Rational::zero(); vector.len()];
        for (from, row) in self.graph.rows.iter().enumerate() {
            if vector[from].is_zero() {
                continue;
            }
            for edge in row {
                let credit = &vector[from] * &edge.share * factor;
                check(&credit, &self.limits, max_bits)?;
                output[edge.to] += credit;
                check(&output[edge.to], &self.limits, max_bits)?;
            }
        }
        Ok(output)
    }
    pub fn h(&self) -> &Rational {
        &self.h
    }
}

pub fn rank(graph: &Graph, parameters: &Parameters, limits: Limits) -> Result<Ranking, RankError> {
    let mut calculation = Ranker::new(
        graph,
        parameters.h.clone(),
        parameters.alpha.clone(),
        limits,
    )?;
    calculation.advance(parameters.work)?;
    calculation.bounds()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Bless,
    Curse,
    Absent,
}
impl Verdict {
    fn coefficient(self) -> i64 {
        match self {
            Self::Bless => 1,
            Self::Curse => -1,
            Self::Absent => 0,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Eligibility {
    Eligible,
    Ineligible,
    Unavailable,
}
#[derive(Clone, Debug)]
pub struct Candidate {
    pub id: String,
    pub verdicts: Vec<Verdict>,
    pub eligibility: Eligibility,
    pub deprecated: bool,
}
impl Candidate {
    fn effective(&self, actor: usize) -> Verdict {
        if self.eligibility == Eligibility::Eligible && !self.deprecated {
            self.verdicts[actor]
        } else {
            Verdict::Absent
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Score {
    pub support: Interval,
    pub opposition: Interval,
    pub net: Interval,
}
fn dimensions(candidate: &Candidate, weights: &[Interval]) -> Result<(), RankError> {
    if candidate.eligibility == Eligibility::Unavailable {
        return Err(RankError::UnavailableCandidate(candidate.id.clone()));
    }
    if candidate.verdicts.len() != weights.len() {
        return Err(RankError::InvalidGraph(
            "candidate dimensions differ".into(),
        ));
    }
    if weights
        .iter()
        .any(|w| w.lower < Rational::zero() || w.upper < w.lower)
    {
        return Err(RankError::InvalidGraph("invalid weight interval".into()));
    }
    Ok(())
}
pub fn score(candidate: &Candidate, weights: &[Interval]) -> Result<Score, RankError> {
    score_with_limits(candidate, weights, &Limits::default())
}
pub fn score_with_limits(
    candidate: &Candidate,
    weights: &[Interval],
    limits: &Limits,
) -> Result<Score, RankError> {
    dimensions(candidate, weights)?;
    if weights.len() > limits.max_actors {
        return Err(RankError::ResourceLimit("actors"));
    }
    let mut arithmetic_bits = 0;
    let mut support = Interval::exact(Rational::zero());
    let mut opposition = support.clone();
    for (actor, w) in weights.iter().enumerate() {
        let target = match candidate.effective(actor) {
            Verdict::Bless => &mut support,
            Verdict::Curse => &mut opposition,
            Verdict::Absent => continue,
        };
        target.lower += &w.lower;
        target.upper += &w.upper;
        check(&target.lower, limits, &mut arithmetic_bits)?;
        check(&target.upper, limits, &mut arithmetic_bits)?;
    }
    let net = Interval {
        lower: &support.lower - &opposition.upper,
        upper: &support.upper - &opposition.lower,
    };
    check(&net.lower, limits, &mut arithmetic_bits)?;
    check(&net.upper, limits, &mut arithmetic_bits)?;
    Ok(Score {
        support,
        opposition,
        net,
    })
}
/// Compare two candidates from the same graph. Shared verdicts cancel exactly.
pub fn difference(
    a: &Candidate,
    b: &Candidate,
    weights: &[Interval],
) -> Result<Interval, RankError> {
    difference_with_limits(a, b, weights, &Limits::default())
}
pub fn difference_with_limits(
    a: &Candidate,
    b: &Candidate,
    weights: &[Interval],
    limits: &Limits,
) -> Result<Interval, RankError> {
    dimensions(a, weights)?;
    dimensions(b, weights)?;
    if weights.len() > limits.max_actors {
        return Err(RankError::ResourceLimit("actors"));
    }
    let mut arithmetic_bits = 0;
    let mut result = Interval::exact(Rational::zero());
    for (actor, weight) in weights.iter().enumerate() {
        let coefficient = a.effective(actor).coefficient() - b.effective(actor).coefficient();
        if coefficient == 0 {
            continue;
        }
        let coefficient = rational(coefficient, 1);
        let (lower, upper) = if coefficient > Rational::zero() {
            (&weight.lower, &weight.upper)
        } else {
            (&weight.upper, &weight.lower)
        };
        result.lower += lower * &coefficient;
        result.upper += upper * coefficient;
        check(&result.lower, limits, &mut arithmetic_bits)?;
        check(&result.upper, limits, &mut arithmetic_bits)?;
    }
    Ok(result)
}
/// Compare scores from different context graphs without shared cancellation.
pub fn separate_difference(a: &Score, b: &Score) -> Interval {
    Interval {
        lower: &a.net.lower - &b.net.upper,
        upper: &a.net.upper - &b.net.lower,
    }
}
/// Return successive nondominated layers. IDs order presentation within each layer.
/// Unavailable candidates need a separate caller status and must not enter this list.
pub fn nondominated_layers(
    candidates: &[Candidate],
    weights: &[Interval],
    limits: &Limits,
) -> Result<Vec<Vec<String>>, RankError> {
    if candidates
        .iter()
        .map(|c| &c.id)
        .collect::<BTreeSet<_>>()
        .len()
        != candidates.len()
    {
        return Err(RankError::InvalidGraph("duplicate candidate ID".into()));
    }
    for candidate in candidates {
        dimensions(candidate, weights)?;
        if candidate.eligibility != Eligibility::Eligible {
            return Err(RankError::InvalidGraph(
                "candidate is not eligible for ranking layers".into(),
            ));
        }
    }
    let count = candidates.len();
    if count
        .checked_mul(count.saturating_sub(1))
        .and_then(|n| n.checked_div(2))
        .ok_or(RankError::ResourceLimit("candidate pairs"))?
        > limits.max_candidate_pairs
    {
        return Err(RankError::ResourceLimit("candidate pairs"));
    }
    let pairs = count.saturating_mul(count.saturating_sub(1)) / 2;
    if pairs
        .checked_mul(weights.len())
        .ok_or(RankError::ResourceLimit("candidate actor terms"))?
        > limits.max_candidate_actor_terms
    {
        return Err(RankError::ResourceLimit("candidate actor terms"));
    }
    let mut higher = vec![BTreeSet::new(); count];
    for a in 0..count {
        for b in a + 1..count {
            let ca = &candidates[a];
            let cb = &candidates[b];
            // Active definitions precede deprecated definitions regardless of score.
            if ca.deprecated != cb.deprecated {
                if ca.deprecated {
                    higher[a].insert(b);
                } else {
                    higher[b].insert(a);
                }
                continue;
            }
            let delta = difference_with_limits(ca, cb, weights, limits)?;
            if delta.lower > Rational::zero() {
                higher[b].insert(a);
            }
            if delta.upper < Rational::zero() {
                higher[a].insert(b);
            }
        }
    }
    let mut remaining: BTreeSet<usize> = (0..count).collect();
    let mut layers = Vec::new();
    while !remaining.is_empty() {
        let layer: Vec<usize> = remaining
            .iter()
            .copied()
            .filter(|i| higher[*i].is_disjoint(&remaining))
            .collect();
        if layer.is_empty() {
            return Err(RankError::InvalidGraph("cyclic certified order".into()));
        }
        let mut ids: Vec<String> = layer.iter().map(|i| candidates[*i].id.clone()).collect();
        ids.sort();
        layers.push(ids);
        for i in layer {
            remaining.remove(&i);
        }
    }
    Ok(layers)
}
