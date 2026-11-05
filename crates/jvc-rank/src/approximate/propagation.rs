//! Synchronous complete stages and relaxed estimates. No host scheduler lives here.
use super::{validate_row, PreparationError, Sum};
use crate::{Limits, RankError};
use std::collections::BTreeMap;

type Result<T> = std::result::Result<T, PreparationError>;
fn resource(name: &'static str) -> PreparationError {
    PreparationError::Graph(RankError::ResourceLimit(name))
}
fn invalid(message: &str) -> PreparationError {
    PreparationError::Graph(RankError::InvalidGraph(message.into()))
}
fn parameter(message: &str) -> PreparationError {
    PreparationError::Graph(RankError::InvalidParameters(message.into()))
}
fn increment(value: &mut u64, name: &'static str) -> Result<()> {
    *value = value.checked_add(1).ok_or_else(|| resource(name))?;
    Ok(())
}
fn normal_input(value: f64, zero: bool) -> Result<()> {
    if !value.is_finite() || value.is_subnormal() {
        return Err(PreparationError::NumericUnavailable);
    }
    if value < 0.0 || (!zero && value == 0.0) {
        return Err(invalid("invalid nonnegative input"));
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq)]
pub struct Edge {
    pub to: usize,
    pub share: f64,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Graph {
    pub actors: Vec<String>,
    pub q: Vec<f64>,
    pub rows: Vec<Vec<Edge>>,
    pub refusals: Vec<Vec<usize>>,
}
fn sizes(
    actors: &[String],
    q: &[f64],
    rows: &[Vec<Edge>],
    refusals: &[Vec<usize>],
    limits: &Limits,
) -> Result<()> {
    let n = actors.len();
    if n > limits.max_actors {
        return Err(resource("actors"));
    }
    if q.len() != n || rows.len() != n || refusals.len() != n {
        return Err(invalid("graph dimensions differ"));
    }
    for (count, limit, name) in [
        (
            rows.iter().try_fold(0usize, |n, r| n.checked_add(r.len())),
            limits.max_edges,
            "edges",
        ),
        (
            refusals
                .iter()
                .try_fold(0usize, |n, r| n.checked_add(r.len())),
            limits.max_refusals,
            "refusals",
        ),
    ] {
        if count.is_none_or(|n| n > limit) {
            return Err(resource(name));
        }
    }
    Ok(())
}
impl Graph {
    /// Canonicalize actor, edge, and refusal order before numerical accumulation.
    pub fn new(
        actors: Vec<String>,
        q: Vec<f64>,
        rows: Vec<Vec<Edge>>,
        refusals: Vec<Vec<usize>>,
        limits: &Limits,
    ) -> Result<Self> {
        sizes(&actors, &q, &rows, &refusals, limits)?;
        let n = actors.len();
        let mut order: Vec<_> = (0..n).collect();
        order.sort_by(|&a, &b| actors[a].cmp(&actors[b]));
        if order.windows(2).any(|p| actors[p[0]] == actors[p[1]]) {
            return Err(invalid("duplicate actor ID"));
        }
        let mut indices = vec![0; n];
        for (new, &old) in order.iter().enumerate() {
            indices[old] = new;
        }
        let mut out = Self {
            actors: Vec::with_capacity(n),
            q: Vec::with_capacity(n),
            rows: Vec::with_capacity(n),
            refusals: Vec::with_capacity(n),
        };
        for &old in &order {
            normal_input(q[old], true)?;
            let mut row = Vec::with_capacity(rows[old].len());
            for edge in &rows[old] {
                if edge.to >= n || edge.to == old {
                    return Err(invalid("invalid edge"));
                }
                row.push(Edge {
                    to: indices[edge.to],
                    share: edge.share,
                });
            }
            row.sort_by_key(|e| e.to);
            if row.windows(2).any(|p| p[0].to == p[1].to) {
                return Err(invalid("duplicate destination"));
            }
            validate_row(row.iter().map(|e| e.share))?;
            let mut refusal = Vec::with_capacity(refusals[old].len());
            for &actor in &refusals[old] {
                if actor >= n || actor == old {
                    return Err(invalid("invalid refusal"));
                }
                refusal.push(indices[actor]);
            }
            refusal.sort_unstable();
            if refusal.windows(2).any(|p| p[0] == p[1]) {
                return Err(invalid("duplicate refusal"));
            }
            out.actors.push(actors[old].clone());
            out.q.push(q[old]);
            out.rows.push(row);
            out.refusals.push(refusal);
        }
        Ok(out)
    }
}

#[derive(Clone, Debug)]
pub struct Parameters {
    pub h: f64,
    pub alpha: f64,
    pub work: u64,
}
impl Default for Parameters {
    fn default() -> Self {
        Self {
            h: 3.0,
            alpha: 0.5,
            work: 1_000_000,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Estimate {
    pub lower: f64,
    pub upper: f64,
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Work {
    pub numerical_operations: u64,
    pub initialization_operations: u64,
    pub route_operations: u64,
    pub estimate_operations: u64,
    pub edge_attempts: u64,
    pub refusal_tests: u64,
    pub matrix_edge_visits: u64,
    pub flushed_terms: u64,
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EstimateProgress {
    pub operations: u64,
    pub matrix_edge_visits: u64,
    pub complete_vectors: usize,
    pub complete: bool,
    pub failed: bool,
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Progress {
    pub initialization_complete: bool,
    pub completed_work: u64,
    pub complete_stages: usize,
    pub depth: usize,
    pub frontier_prefixes: usize,
    pub next_stage_work: u64,
    pub exploration_complete: bool,
    pub peak_prefixes: usize,
    pub work: Work,
    pub upper: Option<EstimateProgress>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Ranking {
    pub weights: Vec<Estimate>,
    pub numerically_approximate: bool,
    pub progress: Progress,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Failure {
    pub cause: PreparationError,
    pub progress: Box<Progress>,
}
impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.cause.fmt(f)
    }
}
impl std::error::Error for Failure {}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Prefix {
    visited: Vec<usize>,
    endpoint: usize,
}
#[derive(Clone, Copy)]
enum Phase {
    Initialization,
    Route,
    Estimate,
}
fn tick(work: &mut Work, before: u64, limit: u64, phase: Phase) -> Result<()> {
    if work.numerical_operations - before >= limit {
        return Err(resource("numerical operations"));
    }
    increment(&mut work.numerical_operations, "operation counter")?;
    increment(
        match phase {
            Phase::Initialization => &mut work.initialization_operations,
            Phase::Route => &mut work.route_operations,
            Phase::Estimate => &mut work.estimate_operations,
        },
        "operation counter",
    )
}

/// Test the exact product's exponent before hardware rounding can hide underflow.
fn multiply(a: f64, b: f64, work: &mut Work) -> Result<f64> {
    if a == 0.0 || b == 0.0 {
        return Ok(0.0);
    }
    if !a.is_normal() || !b.is_normal() || a < 0.0 || b < 0.0 {
        return Err(PreparationError::NumericUnavailable);
    }
    let parts = |value: f64| {
        let bits = value.to_bits();
        (
            u128::from((bits & ((1u64 << 52) - 1)) | (1u64 << 52)),
            ((bits >> 52) & 0x7ff) as i32 - 1075,
        )
    };
    let (ma, ea) = parts(a);
    let (mb, eb) = parts(b);
    let product = ma * mb;
    let exponent = (127 - product.leading_zeros()) as i32 + ea + eb;
    if exponent < -1022 {
        increment(&mut work.flushed_terms, "flushed terms")?;
        return Ok(0.0);
    }
    let result = a * b;
    if !result.is_normal() {
        return Err(PreparationError::NumericUnavailable);
    }
    Ok(result)
}

/// Retain complete synchronous stages. A failed stage discards all its workspace.
/// Work counters include failed operations, but no pending stage survives a call.
#[derive(Debug)]
pub struct Ranker<'a> {
    graph: &'a Graph,
    initialization_complete: bool,
    alpha: f64,
    limits: Limits,
    lower: Vec<Sum>,
    prefixes: BTreeMap<Prefix, Sum>,
    completed_work: u64,
    stages: usize,
    depth: usize,
    stage_cost: u64,
    peak_prefixes: usize,
    work: Work,
    upper: Option<EstimateProgress>,
}
impl<'a> Ranker<'a> {
    pub fn new(
        graph: &'a Graph,
        h: f64,
        alpha: f64,
        limits: Limits,
    ) -> std::result::Result<Self, Failure> {
        let validate = || -> Result<()> {
            normal_input(h, true)?;
            normal_input(alpha, true)?;
            if h > 100.0 || alpha > 0.9 {
                return Err(parameter("H or alpha is outside the profile range"));
            }
            sizes(
                &graph.actors,
                &graph.q,
                &graph.rows,
                &graph.refusals,
                &limits,
            )?;
            let validated = Graph::new(
                graph.actors.clone(),
                graph.q.clone(),
                graph.rows.clone(),
                graph.refusals.clone(),
                &limits,
            )?;
            if *graph != validated {
                return Err(invalid("graph must use canonical actor and edge order"));
            }
            Ok(())
        };
        validate().map_err(|cause| Failure {
            cause,
            progress: Box::default(),
        })?;
        let mut ranker = Self {
            graph,
            initialization_complete: false,
            alpha,
            limits,
            lower: graph
                .q
                .iter()
                .map(|&q| Sum::new(q).expect("validated root"))
                .collect(),
            prefixes: BTreeMap::new(),
            completed_work: 0,
            stages: 0,
            depth: 0,
            stage_cost: 0,
            peak_prefixes: 0,
            work: Work::default(),
            upper: None,
        };
        let initialize = |this: &mut Self| -> Result<()> {
            for (actor, &q) in graph.q.iter().enumerate() {
                tick(&mut this.work, 0, u64::MAX, Phase::Initialization)?;
                let mass = multiply(h, q, &mut this.work)?;
                if mass == 0.0 {
                    continue;
                }
                if this.prefixes.len() >= this.limits.max_prefixes {
                    return Err(resource("prefix states"));
                }
                if this.prefixes.len() >= this.limits.max_visited_actor_entries {
                    return Err(resource("visited actor entries"));
                }
                this.stage_cost = this
                    .stage_cost
                    .checked_add(graph.rows[actor].len() as u64)
                    .ok_or_else(|| resource("stage cost"))?;
                this.prefixes.insert(
                    Prefix {
                        visited: vec![actor],
                        endpoint: actor,
                    },
                    Sum::new(mass)?,
                );
                this.peak_prefixes = this.prefixes.len();
            }
            Ok(())
        };
        initialize(&mut ranker).map_err(|cause| ranker.failure(cause))?;
        ranker.initialization_complete = true;
        Ok(ranker)
    }
    pub fn progress(&self) -> Progress {
        Progress {
            initialization_complete: self.initialization_complete,
            completed_work: self.completed_work,
            complete_stages: self.stages,
            depth: self.depth,
            frontier_prefixes: self.prefixes.len(),
            next_stage_work: self.stage_cost,
            exploration_complete: self.initialization_complete && self.prefixes.is_empty(),
            peak_prefixes: self.peak_prefixes,
            work: self.work.clone(),
            upper: self.upper.clone(),
        }
    }
    fn failure(&self, cause: PreparationError) -> Failure {
        Failure {
            cause,
            progress: Box::new(self.progress()),
        }
    }
    pub fn advance(&mut self, total_budget: u64) -> std::result::Result<(), Failure> {
        self.advance_with_operation_limit(total_budget, u64::MAX)
    }
    pub fn advance_with_operation_limit(
        &mut self,
        total_budget: u64,
        max_operations: u64,
    ) -> std::result::Result<(), Failure> {
        if !(1..=10_000_000).contains(&total_budget)
            || total_budget < self.completed_work
            || max_operations == 0
        {
            return Err(self.failure(parameter("invalid work budget or operation limit")));
        }
        let result = self.advance_inner(total_budget, max_operations);
        result.map_err(|cause| self.failure(cause))
    }
    fn advance_inner(&mut self, total_budget: u64, max_operations: u64) -> Result<()> {
        let before = self.work.numerical_operations;
        while !self.prefixes.is_empty() && self.stage_cost <= total_budget - self.completed_work {
            let cost = self.stage_cost;
            let mut lower = self.lower.clone();
            let mut next: BTreeMap<Prefix, Sum> = BTreeMap::new();
            let mut visited_entries = self.prefixes.keys().map(|p| p.visited.len()).sum::<usize>();
            let mut next_cost = 0u64;
            let mut depth = self.depth;
            for (prefix, mass) in &self.prefixes {
                for edge in &self.graph.rows[prefix.endpoint] {
                    tick(&mut self.work, before, max_operations, Phase::Route)?;
                    increment(&mut self.work.edge_attempts, "edge attempts")?;
                    if prefix.visited.binary_search(&edge.to).is_ok() {
                        continue;
                    }
                    crate::refused(
                        &prefix.visited,
                        &self.graph.refusals[edge.to],
                        &mut self.work.refusal_tests,
                        self.limits.max_refusal_tests,
                    )
                    .map_err(PreparationError::Graph)
                    .and_then(|refused| {
                        if refused {
                            return Ok(());
                        }
                        let credit = multiply(mass.finish()?, edge.share, &mut self.work)?;
                        if credit == 0.0 {
                            return Ok(());
                        }
                        lower[edge.to].add(credit)?;
                        depth = depth.max(prefix.visited.len());
                        let onward = multiply(credit, self.alpha, &mut self.work)?;
                        if onward == 0.0 {
                            return Ok(());
                        }
                        let mut visited = prefix.visited.clone();
                        let at = visited.binary_search(&edge.to).unwrap_err();
                        visited.insert(at, edge.to);
                        let key = Prefix {
                            visited,
                            endpoint: edge.to,
                        };
                        if !next.contains_key(&key) {
                            if self.prefixes.len() + next.len() >= self.limits.max_prefixes {
                                return Err(resource("prefix states"));
                            }
                            visited_entries = visited_entries
                                .checked_add(key.visited.len())
                                .ok_or_else(|| resource("visited actor entries"))?;
                            if visited_entries > self.limits.max_visited_actor_entries {
                                return Err(resource("visited actor entries"));
                            }
                            next_cost = next_cost
                                .checked_add(self.graph.rows[edge.to].len() as u64)
                                .ok_or_else(|| resource("stage cost"))?;
                        }
                        next.entry(key).or_default().add(onward)
                    })?;
                }
                tick(&mut self.work, before, max_operations, Phase::Route)?;
            }
            self.peak_prefixes = self.peak_prefixes.max(self.prefixes.len() + next.len());
            self.lower = lower;
            self.prefixes = next;
            self.stage_cost = next_cost;
            self.depth = depth;
            // The precomputed cost includes repeats and refused edges.
            self.completed_work = self
                .completed_work
                .checked_add(cost)
                .ok_or_else(|| resource("completed work"))?;
            self.stages += 1;
            self.upper = None;
        }
        Ok(())
    }
    pub fn estimates(&mut self) -> std::result::Result<Ranking, Failure> {
        self.estimates_with_operation_limit(u64::MAX)
    }
    pub fn estimates_with_operation_limit(
        &mut self,
        max_operations: u64,
    ) -> std::result::Result<Ranking, Failure> {
        if max_operations == 0 {
            return Err(self.failure(parameter("operation limit must be positive")));
        }
        let before = self.work.numerical_operations;
        let before_matrix = self.work.matrix_edge_visits;
        let mut progress = EstimateProgress::default();
        let result = self.estimate_inner(before, max_operations, &mut progress);
        progress.operations = self.work.numerical_operations - before;
        progress.matrix_edge_visits = self.work.matrix_edge_visits - before_matrix;
        progress.complete = result.is_ok();
        progress.failed = result.is_err();
        self.upper = Some(progress);
        match result {
            Ok(weights) => Ok(Ranking {
                weights,
                numerically_approximate: true,
                progress: self.progress(),
            }),
            Err(cause) => Err(self.failure(cause)),
        }
    }
    fn estimate_inner(
        &mut self,
        before: u64,
        max_operations: u64,
        progress: &mut EstimateProgress,
    ) -> Result<Vec<Estimate>> {
        let mut upper = self.lower.clone();
        if !self.prefixes.is_empty() {
            let n = self.lower.len();
            let mut vector = vec![Sum::default(); n];
            for (prefix, mass) in &self.prefixes {
                tick(&mut self.work, before, max_operations, Phase::Estimate)?;
                vector[prefix.endpoint].add(mass.finish()?)?;
            }
            let mut initial = Sum::default();
            let mut matrix_visits = 0u64;
            for k in 0..65 {
                let mut output = vec![Sum::default(); n];
                for (from, row) in self.graph.rows.iter().enumerate() {
                    for edge in row {
                        tick(&mut self.work, before, max_operations, Phase::Estimate)?;
                        if matrix_visits >= self.limits.max_matrix_edge_visits {
                            return Err(resource("matrix edge visits"));
                        }
                        matrix_visits += 1;
                        increment(&mut self.work.matrix_edge_visits, "matrix edge visits")?;
                        let credit = multiply(vector[from].finish()?, edge.share, &mut self.work)?;
                        let credit = multiply(
                            credit,
                            if k == 0 { 1.0 } else { self.alpha },
                            &mut self.work,
                        )?;
                        output[edge.to].add(credit)?;
                    }
                    tick(&mut self.work, before, max_operations, Phase::Estimate)?;
                }
                vector = output;
                for (u, value) in upper.iter_mut().zip(&vector) {
                    tick(&mut self.work, before, max_operations, Phase::Estimate)?;
                    let value = value.finish()?;
                    if k == 0 {
                        initial.add(value)?;
                    }
                    u.add(value)?;
                }
                progress.complete_vectors += 1;
            }
            // Carry mass through the power. A standalone tiny coefficient can underflow
            // even when its product with a large initial mass remains normal.
            let mut tail = initial.finish()?;
            for _ in 0..65 {
                tick(&mut self.work, before, max_operations, Phase::Estimate)?;
                tail = multiply(tail, self.alpha, &mut self.work)?;
            }
            tick(&mut self.work, before, max_operations, Phase::Estimate)?;
            tail /= 1.0 - self.alpha;
            if !tail.is_finite() {
                return Err(PreparationError::NumericUnavailable);
            }
            for value in &mut upper {
                tick(&mut self.work, before, max_operations, Phase::Estimate)?;
                value.add(tail)?;
            }
        }
        self.lower
            .iter()
            .zip(upper)
            .map(|(l, u)| {
                let lower = l.finish()?;
                let upper = u.finish()?;
                if lower < 0.0 || upper < lower || lower.is_subnormal() || upper.is_subnormal() {
                    return Err(PreparationError::NumericUnavailable);
                }
                Ok(Estimate { lower, upper })
            })
            .collect()
    }
}
pub fn rank(
    graph: &Graph,
    parameters: &Parameters,
    limits: Limits,
) -> std::result::Result<Ranking, Failure> {
    let mut ranker = Ranker::new(graph, parameters.h, parameters.alpha, limits)?;
    ranker.advance(parameters.work)?;
    ranker.estimates()
}
