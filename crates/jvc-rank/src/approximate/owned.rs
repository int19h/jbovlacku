//! Owned, resumable numerical work. No session or host scheduler lives here.
use super::*;
use std::sync::Arc;

/// Structural storage counts. Accounts supply conservative byte coefficients.
/// A prefix slot covers its map node or vector slot and inline sum.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AllocationCharge {
    pub sums: usize,
    pub prefixes: usize,
    pub visited: usize,
    pub estimates: usize,
    pub graph_actors: usize,
    pub graph_edges: usize,
    pub graph_refusals: usize,
    pub string_bytes: usize,
    pub indices: usize,
}
impl AllocationCharge {
    fn add(self, other: Self) -> Result<Self> {
        macro_rules! fields { ($($field:ident),*) => { Ok(Self {
            $($field: self.$field.checked_add(other.$field).ok_or_else(|| resource("allocation counts"))?,)*
        }) }; }
        fields!(
            sums,
            prefixes,
            visited,
            estimates,
            graph_actors,
            graph_edges,
            graph_refusals,
            string_bytes,
            indices
        )
    }
}
/// Reserve before allocating. A refusal must leave the account unchanged.
/// Release must not fail or panic. Neither method can call back into a task.
pub trait AllocationAccount: Send + Sync {
    fn reserve(&self, charge: AllocationCharge) -> Result<()>;
    fn release(&self, charge: AllocationCharge);
}
struct Lease {
    account: Arc<dyn AllocationAccount>,
    charge: AllocationCharge,
}
impl Lease {
    fn new(account: Arc<dyn AllocationAccount>) -> Self {
        Self {
            account,
            charge: AllocationCharge::default(),
        }
    }
    fn empty(&self) -> Self {
        Self::new(self.account.clone())
    }
    fn grow(&mut self, charge: AllocationCharge) -> Result<()> {
        let total = self.charge.add(charge)?;
        if charge != AllocationCharge::default() {
            self.account.reserve(charge)?;
        }
        self.charge = total;
        Ok(())
    }
    fn absorb(&mut self, mut other: Self) -> Result<()> {
        let total = self.charge.add(other.charge)?;
        self.charge = total;
        other.charge = AllocationCharge::default();
        Ok(())
    }
    fn release_sums(&mut self, sums: usize) {
        assert!(self.charge.sums >= sums);
        self.charge.sums -= sums;
        if sums != 0 {
            self.account.release(AllocationCharge {
                sums,
                ..Default::default()
            });
        }
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        if self.charge != AllocationCharge::default() {
            self.account.release(self.charge);
        }
    }
}

/// Output storage stays charged until this value drops. It retains no graph.
pub struct OwnedRanking {
    ranking: Ranking,
    _lease: Lease,
}
impl OwnedRanking {
    pub fn ranking(&self) -> &Ranking {
        &self.ranking
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskPhase {
    Initialization,
    Routes,
    Upper,
    Ready,
    Failed,
    Cancelled,
    Taken,
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PendingProgress {
    pub operations: u64,
    pub edge_attempts: u64,
    pub refusal_tests: u64,
    pub prefixes: usize,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OwnedProgress {
    pub phase: TaskPhase,
    pub progress: Progress,
    pub pending_stage: Option<PendingProgress>,
}
/// Actual work in the last valid slice, including an operation that fails.
/// Invalid calls and cancellation preserve this observation.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SliceUsage {
    pub numerical_operations: u64,
    pub initialization_operations: u64,
    pub route_operations: u64,
    pub estimate_operations: u64,
    pub refusal_tests: u64,
}
struct Pending {
    lower: Vec<Sum>,
    next: BTreeMap<Prefix, Sum>,
    cursor: usize,
    edge: usize,
    visited: usize,
    next_cost: u64,
    depth: usize,
    refusal_tests: u64,
    operations: u64,
    attempts: u64,
    lease: Lease,
}
#[derive(Clone, Copy)]
enum UpperPhase {
    Aggregate,
    Multiply,
    Add,
    Tail,
    Divide,
    AddTail,
    Done,
}
struct Upper {
    values: Vec<Sum>,
    vector: Vec<Sum>,
    output: Vec<Sum>,
    initial: Sum,
    tail: f64,
    phase: UpperPhase,
    cursor: usize,
    from: usize,
    edge: usize,
    vectors: usize,
    powers: usize,
    progress: EstimateProgress,
    lease: Lease,
}
struct Engine {
    graph: Arc<Graph>,
    parameters: Parameters,
    limits: Limits,
    lower: Vec<Sum>,
    frontier: Vec<(Prefix, Sum)>,
    frontier_lease: Lease,
    base_lease: Lease,
    init: usize,
    initialized: bool,
    pending: Option<Pending>,
    upper: Option<Upper>,
    completed: u64,
    stages: usize,
    depth: usize,
    cost: u64,
    peak: usize,
    work: Work,
}
fn graph_charge(graph: &Graph) -> Result<AllocationCharge> {
    fn sum(mut values: impl Iterator<Item = usize>) -> Result<usize> {
        values.try_fold(0usize, |a, b| {
            a.checked_add(b)
                .ok_or_else(|| resource("allocation counts"))
        })
    }
    Ok(AllocationCharge {
        graph_actors: graph
            .actors
            .capacity()
            .max(graph.q.capacity())
            .max(graph.rows.capacity())
            .max(graph.refusals.capacity()),
        graph_edges: sum(graph.rows.iter().map(Vec::capacity))?,
        graph_refusals: sum(graph.refusals.iter().map(Vec::capacity))?,
        string_bytes: sum(graph.actors.iter().map(String::capacity))?,
        ..Default::default()
    })
}

impl Engine {
    fn new(
        graph: Arc<Graph>,
        parameters: &Parameters,
        limits: Limits,
        account: Arc<dyn AllocationAccount>,
    ) -> Result<Self> {
        if !(1..=10_000_000).contains(&parameters.work) {
            return Err(parameter("invalid work budget"));
        }
        normal_input(parameters.h, true)?;
        normal_input(parameters.alpha, true)?;
        if parameters.h > 100.0 || parameters.alpha > 0.9 {
            return Err(parameter("H or alpha is outside the profile range"));
        }
        sizes(
            &graph.actors,
            &graph.q,
            &graph.rows,
            &graph.refusals,
            &limits,
        )?;
        let mut base = Lease::new(account);
        let charge = graph_charge(&graph)?;
        base.grow(charge)?;
        // Reserve the validation copies and canonicalization indexes before cloning.
        let mut validation = base.empty();
        validation.grow(
            charge.add(charge)?.add(AllocationCharge {
                graph_edges: charge.graph_edges,
                indices: graph
                    .actors
                    .len()
                    .checked_mul(4)
                    .ok_or_else(|| resource("allocation counts"))?,
                ..Default::default()
            })?,
        )?;
        let canonical = Graph::new(
            graph.actors.clone(),
            graph.q.clone(),
            graph.rows.clone(),
            graph.refusals.clone(),
            &limits,
        )?;
        if *graph != canonical {
            return Err(invalid("graph must use canonical actor and edge order"));
        }
        drop(canonical);
        drop(validation);
        base.grow(AllocationCharge {
            sums: graph.q.len(),
            ..Default::default()
        })?;
        let lower = graph
            .q
            .iter()
            .map(|&q| Sum::new(q))
            .collect::<Result<Vec<_>>>()?;
        Ok(Self {
            frontier_lease: base.empty(),
            graph,
            parameters: parameters.clone(),
            limits,
            lower,
            frontier: Vec::new(),
            base_lease: base,
            init: 0,
            initialized: false,
            pending: None,
            upper: None,
            completed: 0,
            stages: 0,
            depth: 0,
            cost: 0,
            peak: 0,
            work: Work::default(),
        })
    }
    fn progress(&self) -> Progress {
        Progress {
            initialization_complete: self.initialized,
            completed_work: self.completed,
            complete_stages: self.stages,
            depth: self.depth,
            frontier_prefixes: self.frontier.len(),
            next_stage_work: self.cost,
            exploration_complete: self.initialized && self.frontier.is_empty(),
            peak_prefixes: self.peak,
            work: self.work.clone(),
            upper: self.upper.as_ref().map(|u| u.progress.clone()),
        }
    }
    fn snapshot(&self, phase: TaskPhase) -> OwnedProgress {
        OwnedProgress {
            phase,
            progress: self.progress(),
            pending_stage: self.pending.as_ref().map(|p| PendingProgress {
                operations: p.operations,
                edge_attempts: p.attempts,
                refusal_tests: p.refusal_tests - self.work.refusal_tests,
                prefixes: p.next.len(),
            }),
        }
    }
    fn tick(&mut self, phase: Phase, usage: &mut SliceUsage) -> Result<()> {
        tick(&mut self.work, 0, u64::MAX, phase)?;
        increment(&mut usage.numerical_operations, "slice operations")?;
        increment(
            match phase {
                Phase::Initialization => &mut usage.initialization_operations,
                Phase::Route => &mut usage.route_operations,
                Phase::Estimate => &mut usage.estimate_operations,
            },
            "slice operations",
        )
    }
    fn initialize(&mut self, usage: &mut SliceUsage) -> Result<()> {
        self.tick(Phase::Initialization, usage)?;
        let actor = self.init;
        let mass = multiply(
            self.parameters.h,
            self.graph.q[actor],
            &mut self.work.flushed_terms,
        )?;
        if mass != 0.0 {
            if self.frontier.len() >= self.limits.max_prefixes {
                return Err(resource("prefix states"));
            }
            if self.frontier.len() >= self.limits.max_visited_actor_entries {
                return Err(resource("visited actor entries"));
            }
            self.frontier_lease.grow(AllocationCharge {
                prefixes: 1,
                visited: 1,
                ..Default::default()
            })?;
            self.frontier
                .try_reserve_exact(1)
                .map_err(|_| resource("allocation"))?;
            self.cost = self
                .cost
                .checked_add(self.graph.rows[actor].len() as u64)
                .ok_or_else(|| resource("stage cost"))?;
            self.frontier.push((
                Prefix {
                    visited: vec![actor],
                    endpoint: actor,
                },
                Sum::new(mass)?,
            ));
            self.peak = self.frontier.len();
        }
        self.init += 1;
        self.initialized = self.init == self.graph.actors.len();
        Ok(())
    }
    fn start_stage(&mut self) -> Result<()> {
        let mut lease = self.base_lease.empty();
        lease.grow(AllocationCharge {
            sums: self.lower.len(),
            ..Default::default()
        })?;
        self.pending = Some(Pending {
            lower: self.lower.clone(),
            next: BTreeMap::new(),
            cursor: 0,
            edge: 0,
            visited: self.frontier_lease.charge.visited,
            next_cost: 0,
            depth: self.depth,
            refusal_tests: self.work.refusal_tests,
            operations: 0,
            attempts: 0,
            lease,
        });
        Ok(())
    }
    fn route(&mut self, usage: &mut SliceUsage) -> Result<()> {
        self.tick(Phase::Route, usage)?;
        let p = self.pending.as_mut().expect("pending route stage");
        increment(&mut p.operations, "stage operations")?;
        let (prefix, mass) = &self.frontier[p.cursor];
        let row = &self.graph.rows[prefix.endpoint];
        if p.edge == row.len() {
            p.cursor += 1;
            p.edge = 0;
        } else {
            let edge = &row[p.edge];
            p.edge += 1;
            increment(&mut p.attempts, "stage attempts")?;
            increment(&mut self.work.edge_attempts, "edge attempts")?;
            if prefix.visited.binary_search(&edge.to).is_err() {
                let before = p.refusal_tests;
                let refused = crate::refused(
                    &prefix.visited,
                    &self.graph.refusals[edge.to],
                    &mut p.refusal_tests,
                    self.limits.max_refusal_tests,
                )
                .map_err(PreparationError::Graph);
                usage.refusal_tests = usage
                    .refusal_tests
                    .checked_add(p.refusal_tests - before)
                    .ok_or_else(|| resource("refusal tests"))?;
                if !refused? {
                    let credit =
                        multiply(mass.finish()?, edge.share, &mut self.work.flushed_terms)?;
                    if credit != 0.0 {
                        p.lower[edge.to].add(credit)?;
                        p.depth = p.depth.max(prefix.visited.len());
                        let onward =
                            multiply(credit, self.parameters.alpha, &mut self.work.flushed_terms)?;
                        if onward != 0.0 {
                            let count = prefix
                                .visited
                                .len()
                                .checked_add(1)
                                .ok_or_else(|| resource("visited actor entries"))?;
                            let mut temporary = p.lease.empty();
                            temporary.grow(AllocationCharge {
                                prefixes: 1,
                                visited: count,
                                ..Default::default()
                            })?;
                            let mut visited = Vec::new();
                            visited
                                .try_reserve_exact(count)
                                .map_err(|_| resource("allocation"))?;
                            visited.extend_from_slice(&prefix.visited);
                            let at = visited.binary_search(&edge.to).unwrap_err();
                            visited.insert(at, edge.to);
                            let key = Prefix {
                                visited,
                                endpoint: edge.to,
                            };
                            if !p.next.contains_key(&key) {
                                if self.frontier.len() + p.next.len() >= self.limits.max_prefixes {
                                    return Err(resource("prefix states"));
                                }
                                let visited = p
                                    .visited
                                    .checked_add(count)
                                    .ok_or_else(|| resource("visited actor entries"))?;
                                if visited > self.limits.max_visited_actor_entries {
                                    return Err(resource("visited actor entries"));
                                }
                                p.next_cost = p
                                    .next_cost
                                    .checked_add(self.graph.rows[edge.to].len() as u64)
                                    .ok_or_else(|| resource("stage cost"))?;
                                p.visited = visited;
                                self.peak = self.peak.max(self.frontier.len() + p.next.len() + 1);
                                p.lease.absorb(temporary)?;
                            }
                            p.next.entry(key).or_default().add(onward)?;
                        }
                    }
                }
            }
        }
        if p.cursor == self.frontier.len() {
            self.commit_stage()?;
        }
        Ok(())
    }
    fn commit_stage(&mut self) -> Result<()> {
        let p = self.pending.as_ref().unwrap();
        debug_assert_eq!(p.attempts, self.cost);
        let completed = self
            .completed
            .checked_add(p.attempts)
            .ok_or_else(|| resource("completed work"))?;
        let stages = self
            .stages
            .checked_add(1)
            .ok_or_else(|| resource("complete stages"))?;
        let mut transfer = self.base_lease.empty();
        transfer.grow(AllocationCharge {
            prefixes: p.next.len(),
            ..Default::default()
        })?;
        let mut frontier = Vec::new();
        frontier
            .try_reserve_exact(p.next.len())
            .map_err(|_| resource("allocation"))?;
        let mut p = self.pending.take().unwrap();
        frontier.extend(p.next);
        self.lower = p.lower;
        p.lease.release_sums(self.lower.len());
        self.frontier = frontier;
        self.frontier_lease = p.lease;
        self.cost = p.next_cost;
        self.depth = p.depth;
        self.completed = completed;
        self.stages = stages;
        self.work.refusal_tests = p.refusal_tests;
        Ok(())
    }
    fn start_upper(&mut self) -> Result<()> {
        let n = self.lower.len();
        let mut lease = self.base_lease.empty();
        lease.grow(AllocationCharge {
            sums: n
                .checked_mul(3)
                .ok_or_else(|| resource("allocation counts"))?,
            ..Default::default()
        })?;
        self.upper = Some(Upper {
            values: self.lower.clone(),
            vector: vec![Sum::default(); n],
            output: vec![Sum::default(); n],
            initial: Sum::default(),
            tail: 0.0,
            phase: if self.frontier.is_empty() {
                UpperPhase::Done
            } else {
                UpperPhase::Aggregate
            },
            cursor: 0,
            from: 0,
            edge: 0,
            vectors: 0,
            powers: 0,
            progress: EstimateProgress::default(),
            lease,
        });
        Ok(())
    }
    fn upper(&mut self, usage: &mut SliceUsage) -> Result<()> {
        self.tick(Phase::Estimate, usage)?;
        let u = self.upper.as_mut().unwrap();
        increment(&mut u.progress.operations, "estimate operations")?;
        match u.phase {
            UpperPhase::Aggregate => {
                let (prefix, mass) = &self.frontier[u.cursor];
                u.vector[prefix.endpoint].add(mass.finish()?)?;
                u.cursor += 1;
                if u.cursor == self.frontier.len() {
                    u.phase = UpperPhase::Multiply;
                }
            }
            UpperPhase::Multiply => {
                let row = &self.graph.rows[u.from];
                if u.edge == row.len() {
                    u.from += 1;
                    u.edge = 0;
                    if u.from == self.graph.rows.len() {
                        std::mem::swap(&mut u.vector, &mut u.output);
                        u.output.fill(Sum::default());
                        u.phase = UpperPhase::Add;
                        u.cursor = 0;
                    }
                } else {
                    if u.progress.matrix_edge_visits >= self.limits.max_matrix_edge_visits {
                        return Err(resource("matrix edge visits"));
                    }
                    increment(&mut u.progress.matrix_edge_visits, "matrix edge visits")?;
                    increment(&mut self.work.matrix_edge_visits, "matrix edge visits")?;
                    let edge = &row[u.edge];
                    u.edge += 1;
                    let credit = if u.vectors > 0 && self.parameters.alpha == 0.0 {
                        0.0
                    } else {
                        let credit = multiply(
                            u.vector[u.from].finish()?,
                            edge.share,
                            &mut self.work.flushed_terms,
                        )?;
                        multiply(
                            credit,
                            if u.vectors == 0 {
                                1.0
                            } else {
                                self.parameters.alpha
                            },
                            &mut self.work.flushed_terms,
                        )?
                    };
                    u.output[edge.to].add(credit)?;
                }
            }
            UpperPhase::Add => {
                let value = u.vector[u.cursor].finish()?;
                if u.vectors == 0 {
                    u.initial.add(value)?;
                }
                u.values[u.cursor].add(value)?;
                u.cursor += 1;
                if u.cursor == self.lower.len() {
                    u.vectors += 1;
                    u.progress.complete_vectors = u.vectors;
                    if u.vectors == 65 {
                        u.tail = u.initial.finish()?;
                        u.phase = UpperPhase::Tail;
                    } else {
                        u.phase = UpperPhase::Multiply;
                        u.from = 0;
                        u.edge = 0;
                    }
                }
            }
            UpperPhase::Tail => {
                u.tail = multiply(u.tail, self.parameters.alpha, &mut self.work.flushed_terms)?;
                u.powers += 1;
                if u.powers == 65 {
                    u.phase = UpperPhase::Divide;
                }
            }
            UpperPhase::Divide => {
                u.tail /= 1.0 - self.parameters.alpha;
                if !u.tail.is_finite() {
                    return Err(PreparationError::NumericUnavailable);
                }
                u.cursor = 0;
                u.phase = UpperPhase::AddTail;
            }
            UpperPhase::AddTail => {
                u.values[u.cursor].add(u.tail)?;
                u.cursor += 1;
                if u.cursor == self.lower.len() {
                    u.phase = UpperPhase::Done;
                }
            }
            UpperPhase::Done => unreachable!("complete upper has no numerical operation"),
        }
        Ok(())
    }
    fn finish(&mut self) -> Result<OwnedRanking> {
        let upper = self.upper.as_mut().unwrap();
        let mut lease = upper.lease.empty();
        lease.grow(AllocationCharge {
            estimates: self.lower.len(),
            ..Default::default()
        })?;
        let mut weights = Vec::new();
        weights
            .try_reserve_exact(self.lower.len())
            .map_err(|_| resource("allocation"))?;
        for (l, u) in self.lower.iter().zip(&upper.values) {
            let lower = l.finish()?;
            let upper = u.finish()?;
            if lower < 0.0 || upper < lower || lower.is_subnormal() || upper.is_subnormal() {
                return Err(PreparationError::NumericUnavailable);
            }
            weights.push(Estimate { lower, upper });
        }
        upper.progress.complete = true;
        Ok(OwnedRanking {
            ranking: Ranking {
                weights,
                numerically_approximate: true,
                progress: self.progress(),
            },
            _lease: lease,
        })
    }
}

/// One immutable graph and one fixed expansion budget.
/// `step` bounds inner work. A host's external `yield_quantum` is separate.
/// Structural validation, vector setup, and readout have graph-size bounds.
pub struct OwnedTask {
    engine: Option<Engine>,
    result: Option<OwnedRanking>,
    snapshot: OwnedProgress,
    last_slice: SliceUsage,
}
impl OwnedTask {
    pub fn new(
        graph: Arc<Graph>,
        parameters: &Parameters,
        limits: Limits,
        account: Arc<dyn AllocationAccount>,
    ) -> std::result::Result<Self, Failure> {
        let engine = Engine::new(graph, parameters, limits, account).map_err(|cause| Failure {
            cause,
            progress: Box::default(),
        })?;
        let snapshot = engine.snapshot(TaskPhase::Initialization);
        Ok(Self {
            engine: Some(engine),
            result: None,
            snapshot,
            last_slice: SliceUsage::default(),
        })
    }
    pub fn progress(&self) -> OwnedProgress {
        self.snapshot.clone()
    }
    pub fn last_slice_usage(&self) -> &SliceUsage {
        &self.last_slice
    }
    pub fn result(&self) -> Option<&OwnedRanking> {
        self.result.as_ref()
    }
    /// Reject before mutation. Transfer the same output buffer and its lease once.
    pub fn take_result(&mut self) -> std::result::Result<OwnedRanking, Failure> {
        if self.snapshot.phase != TaskPhase::Ready || self.result.is_none() {
            return Err(self.failure(parameter("owned result is not ready")));
        }
        let result = self.result.take().unwrap();
        self.snapshot.phase = TaskPhase::Taken;
        Ok(result)
    }
    pub fn cancel(&mut self) {
        if self.engine.is_some() || self.result.is_some() {
            self.engine = None;
            self.result = None;
            self.snapshot.phase = TaskPhase::Cancelled;
        }
    }
    fn failure(&self, cause: PreparationError) -> Failure {
        Failure {
            cause,
            progress: Box::new(self.snapshot.progress.clone()),
        }
    }
    /// A zero bound fails before phase, counters, reservations, or storage change.
    pub fn step(&mut self, max_operations: u64) -> std::result::Result<bool, Failure> {
        if max_operations == 0 {
            return Err(self.failure(parameter("slice size must be positive")));
        }
        if self.snapshot.phase == TaskPhase::Ready {
            self.last_slice = SliceUsage::default();
            return Ok(true);
        }
        if self.engine.is_none() {
            return Err(self.failure(parameter("owned task is terminal")));
        }
        let mut usage = SliceUsage::default();
        let result = self.step_inner(max_operations, &mut usage);
        self.last_slice = usage;
        match result {
            Ok(done) => Ok(done),
            Err(cause) => {
                let engine = self.engine.as_mut().unwrap();
                if let Some(upper) = engine.upper.as_mut() {
                    upper.progress.failed = true;
                }
                self.snapshot = engine.snapshot(TaskPhase::Failed);
                let mut failure = self.failure(cause);
                if let Some(pending) = self.engine.as_ref().unwrap().pending.as_ref() {
                    failure.progress.work.refusal_tests = pending.refusal_tests;
                }
                self.engine = None;
                Err(failure)
            }
        }
    }
    fn step_inner(&mut self, bound: u64, usage: &mut SliceUsage) -> Result<bool> {
        loop {
            let e = self.engine.as_mut().unwrap();
            if !e.initialized && e.init == e.graph.actors.len() {
                e.initialized = true;
            }
            let phase = if !e.initialized {
                TaskPhase::Initialization
            } else if e.upper.is_some() {
                TaskPhase::Upper
            } else if !e.frontier.is_empty() && e.cost <= e.parameters.work - e.completed {
                TaskPhase::Routes
            } else {
                e.start_upper()?;
                TaskPhase::Upper
            };
            if phase == TaskPhase::Routes && e.pending.is_none() {
                e.start_stage()?;
            }
            if e.upper
                .as_ref()
                .is_some_and(|u| matches!(u.phase, UpperPhase::Done))
            {
                let result = e.finish()?;
                self.snapshot = e.snapshot(TaskPhase::Ready);
                self.result = Some(result);
                self.engine = None;
                return Ok(true);
            }
            if usage.numerical_operations == bound {
                self.snapshot = e.snapshot(phase);
                return Ok(false);
            }
            match phase {
                TaskPhase::Initialization => e.initialize(usage)?,
                TaskPhase::Routes => e.route(usage)?,
                TaskPhase::Upper => e.upper(usage)?,
                _ => unreachable!(),
            }
            self.snapshot = e.snapshot(phase);
        }
    }
}

#[cfg(test)]
#[path = "owned_tests.rs"]
mod tests;
