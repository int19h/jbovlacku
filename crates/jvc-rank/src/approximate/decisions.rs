//! Non-certified decisions from complete estimates. No host execution lives here.
use super::{input, Estimate, Graph, Parameters, PreparationError, Ranking, Sum};
use crate::{Candidate, Eligibility, Limits, RankError, Rational, Verdict};
use std::collections::BTreeSet;

type Result<T> = std::result::Result<T, PreparationError>;
pub const DECISION_CONTRACT: &str = "jvc-f64-decisions-v1";
pub const FLUSH_UNIT: f64 = f64::from_bits(5u64 << 52); // 2^-1018
fn invalid(s: &str) -> PreparationError {
    PreparationError::Graph(RankError::InvalidGraph(s.into()))
}
fn resource(s: &'static str) -> PreparationError {
    PreparationError::Graph(RankError::ResourceLimit(s))
}
fn finite(x: f64) -> Result<f64> {
    if x.is_finite() {
        Ok(x)
    } else {
        Err(PreparationError::NumericUnavailable)
    }
}
fn sum(xs: impl IntoIterator<Item = f64>) -> Result<f64> {
    let mut s = Sum::default();
    for x in xs {
        s.add(x)?;
    }
    s.finish()
}
fn interval(x: Estimate, nonnegative: bool) -> Result<()> {
    finite(x.lower)?;
    finite(x.upper)?;
    if x.lower > x.upper
        || (nonnegative && (x.lower < 0.0 || x.lower.is_subnormal() || x.upper.is_subnormal()))
    {
        return Err(invalid("invalid decision estimate"));
    }
    Ok(())
}
fn net(s: Estimate, o: Estimate) -> Result<Estimate> {
    Ok(Estimate {
        lower: sum([s.lower, -o.upper])?,
        upper: sum([s.upper, -o.lower])?,
    })
}
fn coefficient(v: Verdict) -> i32 {
    match v {
        Verdict::Bless => 1,
        Verdict::Curse => -1,
        Verdict::Absent => 0,
    }
}
fn effective(c: &Candidate, i: usize) -> Verdict {
    if c.eligibility == Eligibility::Eligible && !c.deprecated {
        c.verdicts[i]
    } else {
        Verdict::Absent
    }
}

/// The caller binds these complete estimates to this resolved graph and parameters.
#[derive(Debug)]
pub struct DecisionContext<'a> {
    graph: &'a Graph,
    ranking: &'a Ranking,
    h: f64,
    alpha: f64,
}
impl<'a> DecisionContext<'a> {
    pub fn new(
        graph: &'a Graph,
        parameters: &Parameters,
        ranking: &'a Ranking,
        limits: &Limits,
    ) -> Result<Self> {
        let n = graph.actors.len();
        if n > limits.max_actors {
            return Err(resource("actors"));
        }
        if graph.q.len() != n || graph.rows.len() != n || graph.refusals.len() != n {
            return Err(invalid("decision graph dimensions differ"));
        }
        if graph
            .rows
            .iter()
            .try_fold(0usize, |n, r| n.checked_add(r.len()))
            .is_none_or(|n| n > limits.max_edges)
        {
            return Err(resource("edges"));
        }
        if graph
            .refusals
            .iter()
            .try_fold(0usize, |n, r| n.checked_add(r.len()))
            .is_none_or(|n| n > limits.max_refusals)
        {
            return Err(resource("refusals"));
        }
        let canonical = Graph::new(
            graph.actors.clone(),
            graph.q.clone(),
            graph.rows.clone(),
            graph.refusals.clone(),
            limits,
        )?;
        if *graph != canonical {
            return Err(invalid("noncanonical decision graph"));
        }
        for v in [parameters.h, parameters.alpha] {
            if !v.is_finite() || v.is_subnormal() {
                return Err(PreparationError::NumericUnavailable);
            }
        }
        if parameters.h < 0.0
            || parameters.h > 100.0
            || parameters.alpha < 0.0
            || parameters.alpha > 0.9
        {
            return Err(invalid("invalid decision parameters"));
        }
        let p = &ranking.progress;
        if !ranking.numerically_approximate
            || !p.initialization_complete
            || !p.upper.as_ref().is_some_and(|u| {
                u.complete && !u.failed && (p.exploration_complete || u.complete_vectors == 65)
            })
        {
            return Err(resource("incomplete upper estimates"));
        }
        if ranking.weights.len() != graph.actors.len()
            || p.depth > graph.actors.len().saturating_sub(1)
        {
            return Err(invalid("decision dimensions or depth differ"));
        }
        for &w in &ranking.weights {
            interval(w, true)?;
        }
        Ok(Self {
            graph,
            ranking,
            h: parameters.h,
            alpha: parameters.alpha,
        })
    }
    fn details(&self) -> GraphMargin {
        let p = &self.ranking.progress;
        GraphMargin {
            depth: p.depth,
            factor: relative_factor(p.depth),
            flushed_terms: p.work.flushed_terms,
            flush_margin: p.work.flushed_terms as f64 * FLUSH_UNIT,
        }
    }
    fn same_graph(&self, other: &Self) -> bool {
        std::ptr::eq(self.graph, other.graph)
            && self.h.to_bits() == other.h.to_bits()
            && self.alpha.to_bits() == other.alpha.to_bits()
    }
    fn same(&self, other: &Self) -> bool {
        self.same_graph(other) && std::ptr::eq(self.ranking, other.ranking)
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct GraphMargin {
    pub depth: usize,
    pub factor: f64,
    pub flushed_terms: u64,
    pub flush_margin: f64,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Margin {
    pub contract: &'static str,
    pub depth: usize,
    pub factor: f64,
    pub contribution_mass: f64,
    pub graphs: Vec<GraphMargin>,
    pub absolute: f64,
    pub value: f64,
}
pub fn relative_factor(depth: usize) -> f64 {
    1e-12f64.max((2.0 * depth as f64 + 140.0) * f64::EPSILON)
}
fn margin(mass: f64, contexts: &[&DecisionContext<'_>]) -> Result<Margin> {
    if !mass.is_finite() || mass < 0.0 {
        return Err(PreparationError::NumericUnavailable);
    }
    let mut unique: Vec<(&DecisionContext<'_>, GraphMargin)> = Vec::new();
    for &c in contexts {
        let details = c.details();
        if let Some((_, retained)) = unique.iter_mut().find(|(u, _)| u.same_graph(c)) {
            retained.depth = retained.depth.max(details.depth);
            retained.factor = relative_factor(retained.depth);
            retained.flushed_terms = retained.flushed_terms.max(details.flushed_terms);
            retained.flush_margin = retained.flushed_terms as f64 * FLUSH_UNIT;
        } else {
            unique.push((c, details));
        }
    }
    let mut graphs: Vec<_> = unique.into_iter().map(|(_, details)| details).collect();
    graphs.sort_by_key(|g| (g.depth, g.flushed_terms));
    let depth = graphs.iter().map(|g| g.depth).max().unwrap_or(0);
    let factor = relative_factor(depth);
    let absolute = sum(graphs.iter().map(|g| g.flush_margin))?;
    let value = sum([finite(factor * mass)?, absolute])?;
    Ok(Margin {
        contract: DECISION_CONTRACT,
        depth,
        factor,
        contribution_mass: mass,
        graphs,
        absolute,
        value,
    })
}
fn dimensions(c: &Candidate, context: &DecisionContext<'_>, limits: &Limits) -> Result<()> {
    if c.verdicts.len() != context.ranking.weights.len() {
        return Err(invalid("candidate dimensions differ"));
    }
    if c.verdicts.len() > limits.max_candidate_actor_terms {
        return Err(resource("candidate actor terms"));
    }
    Ok(())
}

/// Search signs and permitted simple routes without numerical products or scores.
fn structural_zero(
    context: &DecisionContext<'_>,
    verdicts: &[Verdict],
    limits: &Limits,
) -> Result<bool> {
    if !verdicts.contains(&Verdict::Bless) {
        return Ok(true);
    }
    let g = context.graph;
    let mut stack = Vec::new();
    for (i, &q) in g.q.iter().enumerate() {
        if q > 0.0 {
            if verdicts[i] == Verdict::Bless {
                return Ok(false);
            }
            if context.h > 0.0 {
                if stack.len() >= limits.max_prefixes
                    || stack.len() >= limits.max_visited_actor_entries
                {
                    return Err(resource("structural prefixes"));
                }
                stack.push((i, vec![i]));
            }
        }
    }
    let mut entries = stack.len();
    let mut attempts = 0usize;
    let mut tests = 0;
    if stack.len() > limits.max_prefixes || entries > limits.max_visited_actor_entries {
        return Err(resource("structural prefixes"));
    }
    while let Some((from, path)) = stack.pop() {
        entries -= path.len();
        for edge in &g.rows[from] {
            attempts = attempts
                .checked_add(1)
                .ok_or_else(|| resource("structural edge attempts"))?;
            if attempts > limits.max_candidate_actor_terms {
                return Err(resource("structural edge attempts"));
            }
            if path.binary_search(&edge.to).is_ok()
                || crate::refused(
                    &path,
                    &g.refusals[edge.to],
                    &mut tests,
                    limits.max_refusal_tests,
                )
                .map_err(PreparationError::Graph)?
            {
                continue;
            }
            if verdicts[edge.to] == Verdict::Bless {
                return Ok(false);
            }
            if context.alpha > 0.0 && !g.rows[edge.to].is_empty() {
                if stack.len() >= limits.max_prefixes {
                    return Err(resource("structural prefixes"));
                }
                entries = entries
                    .checked_add(path.len() + 1)
                    .ok_or_else(|| resource("structural visited entries"))?;
                if entries > limits.max_visited_actor_entries {
                    return Err(resource("structural visited entries"));
                }
                let mut next = path.clone();
                let at = next.binary_search(&edge.to).unwrap_err();
                next.insert(at, edge.to);
                stack.push((edge.to, next));
            }
        }
    }
    Ok(true)
}
#[derive(Clone, Debug)]
pub struct Score<'a> {
    pub support: Estimate,
    pub opposition: Estimate,
    pub net: Estimate,
    structural_known_zero: bool,
    direct_reviewers: usize,
    context: &'a DecisionContext<'a>,
}
impl Score<'_> {
    pub fn structural_known_zero(&self) -> bool {
        self.structural_known_zero
    }
    pub fn direct_reviewers(&self) -> usize {
        self.direct_reviewers
    }
}
fn valid_score(s: &Score<'_>) -> Result<()> {
    interval(s.support, true)?;
    interval(s.opposition, true)?;
    interval(s.net, false)?;
    if s.net != net(s.support, s.opposition)? {
        return Err(invalid("inconsistent score"));
    }
    Ok(())
}
fn raw_score<'a>(
    context: &'a DecisionContext<'a>,
    verdicts: &[Verdict],
    limits: &Limits,
) -> Result<Score<'a>> {
    if verdicts.len() != context.ranking.weights.len() {
        return Err(invalid("candidate dimensions differ"));
    }
    if verdicts.len() > limits.max_candidate_actor_terms {
        return Err(resource("candidate actor terms"));
    }
    let mut sl = Sum::default();
    let mut su = Sum::default();
    let mut ol = Sum::default();
    let mut ou = Sum::default();
    for (v, w) in verdicts.iter().zip(&context.ranking.weights) {
        let (l, u) = match v {
            Verdict::Bless => (&mut sl, &mut su),
            Verdict::Curse => (&mut ol, &mut ou),
            Verdict::Absent => continue,
        };
        l.add(w.lower)?;
        u.add(w.upper)?;
    }
    let support = Estimate {
        lower: sl.finish()?,
        upper: su.finish()?,
    };
    let opposition = Estimate {
        lower: ol.finish()?,
        upper: ou.finish()?,
    };
    Ok(Score {
        support,
        opposition,
        net: net(support, opposition)?,
        structural_known_zero: structural_zero(context, verdicts, limits)?,
        direct_reviewers: verdicts.iter().filter(|&&v| v != Verdict::Absent).count(),
        context,
    })
}
pub fn score<'a>(
    context: &'a DecisionContext<'a>,
    candidate: &Candidate,
    limits: &Limits,
) -> Result<Score<'a>> {
    dimensions(candidate, context, limits)?;
    if candidate.eligibility == Eligibility::Unavailable {
        return Err(PreparationError::Graph(RankError::UnavailableCandidate(
            candidate.id.clone(),
        )));
    }
    let verdicts: Vec<_> = (0..candidate.verdicts.len())
        .map(|i| effective(candidate, i))
        .collect();
    let mut result = raw_score(context, &verdicts, limits)?;
    // A zero-influence reviewer is still a direct reviewer.
    result.direct_reviewers = candidate
        .verdicts
        .iter()
        .filter(|&&v| v != Verdict::Absent)
        .count();
    Ok(result)
}
#[derive(Clone, Debug, PartialEq)]
pub struct Comparison {
    pub difference: Estimate,
    pub margin: Margin,
}
impl Comparison {
    pub fn a_leads(&self) -> bool {
        self.margin.contribution_mass > 0.0 && self.difference.lower > self.margin.value
    }
    pub fn b_leads(&self) -> bool {
        self.margin.contribution_mass > 0.0 && self.difference.upper < -self.margin.value
    }
}
pub fn difference(
    a: &Candidate,
    b: &Candidate,
    context: &DecisionContext<'_>,
    limits: &Limits,
) -> Result<Comparison> {
    dimensions(a, context, limits)?;
    dimensions(b, context, limits)?;
    if a.eligibility == Eligibility::Unavailable || b.eligibility == Eligibility::Unavailable {
        return Err(invalid("unavailable comparison candidate"));
    }
    let mut pl = Sum::default();
    let mut pu = Sum::default();
    let mut nl = Sum::default();
    let mut nu = Sum::default();
    let mut mass = Sum::default();
    for (i, w) in context.ranking.weights.iter().enumerate() {
        let c = coefficient(effective(a, i)) - coefficient(effective(b, i));
        if c == 0 {
            continue;
        }
        let c_abs = f64::from(c.abs());
        mass.add(finite(c_abs * w.upper)?)?;
        let (l, u) = if c > 0 {
            (&mut pl, &mut pu)
        } else {
            (&mut nl, &mut nu)
        };
        l.add(finite(c_abs * w.lower)?)?;
        u.add(finite(c_abs * w.upper)?)?;
    }
    Ok(Comparison {
        difference: net(
            Estimate {
                lower: pl.finish()?,
                upper: pu.finish()?,
            },
            Estimate {
                lower: nl.finish()?,
                upper: nu.finish()?,
            },
        )?,
        margin: margin(mass.finish()?, &[context])?,
    })
}
pub fn separate_difference(a: &Score<'_>, b: &Score<'_>) -> Result<Comparison> {
    interval(a.support, true)?;
    interval(a.opposition, true)?;
    interval(b.support, true)?;
    interval(b.opposition, true)?;
    if a.net != net(a.support, a.opposition)? || b.net != net(b.support, b.opposition)? {
        return Err(invalid("inconsistent score"));
    }
    let support = Estimate {
        lower: sum([a.support.lower, b.opposition.lower])?,
        upper: sum([a.support.upper, b.opposition.upper])?,
    };
    let opposition = Estimate {
        lower: sum([a.opposition.lower, b.support.lower])?,
        upper: sum([a.opposition.upper, b.support.upper])?,
    };
    Ok(Comparison {
        difference: net(support, opposition)?,
        margin: margin(
            sum([
                a.support.upper,
                a.opposition.upper,
                b.support.upper,
                b.opposition.upper,
            ])?,
            &[a.context, b.context],
        )?,
    })
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActualSupport {
    Positive,
    NotEstablished,
    Unavailable,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Potential {
    Nonpositive,
    Possible,
    Unavailable,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Threshold {
    Accepted,
    NotEstablished,
    Unavailable,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Decision<T> {
    pub status: T,
    pub margin: Option<Margin>,
}
pub fn actual_positive_support(score: Option<&Score<'_>>) -> Result<Decision<ActualSupport>> {
    let Some(s) = score else {
        return Ok(Decision {
            status: ActualSupport::Unavailable,
            margin: None,
        });
    };
    valid_score(s)?;
    let m = margin(sum([s.support.upper, s.opposition.upper])?, &[s.context])?;
    Ok(Decision {
        status: if s.net.lower > m.value {
            ActualSupport::Positive
        } else {
            ActualSupport::NotEstablished
        },
        margin: Some(m),
    })
}
pub fn eligible_competitor_potential(score: Option<&Score<'_>>) -> Result<Decision<Potential>> {
    let Some(s) = score else {
        return Ok(Decision {
            status: Potential::Unavailable,
            margin: None,
        });
    };
    valid_score(s)?;
    let m = margin(sum([s.support.upper, s.opposition.upper])?, &[s.context])?;
    Ok(Decision {
        status: if s.structural_known_zero || s.net.upper < -m.value {
            Potential::Nonpositive
        } else {
            Potential::Possible
        },
        margin: Some(m),
    })
}
pub fn unresolved_pair_potential(
    context: Option<&DecisionContext<'_>>,
    verdicts: Option<&[Verdict]>,
    limits: &Limits,
) -> Result<Decision<Potential>> {
    match (context, verdicts) {
        (Some(c), Some(v)) => eligible_competitor_potential(Some(&raw_score(c, v, limits)?)),
        _ => eligible_competitor_potential(None),
    }
}
pub fn meets_threshold(
    score: Option<&Score<'_>>,
    threshold: &Rational,
) -> Result<Decision<Threshold>> {
    let t = input(threshold, true)?;
    let Some(s) = score else {
        return Ok(Decision {
            status: Threshold::Unavailable,
            margin: None,
        });
    };
    valid_score(s)?;
    let m = margin(
        sum([s.support.upper, s.opposition.upper, t.abs()])?,
        &[s.context],
    )?;
    let distance = sum([s.net.lower, -t])?;
    Ok(Decision {
        status: if distance >= -m.value {
            Threshold::Accepted
        } else {
            Threshold::NotEstablished
        },
        margin: Some(m),
    })
}

#[derive(Clone, Copy, Debug)]
pub struct LayerCandidate<'a> {
    pub candidate: &'a Candidate,
    pub context: Option<&'a DecisionContext<'a>>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Layers {
    pub layers: Vec<Vec<String>>,
    pub comparison_cycle: bool,
    pub incomplete: bool,
    pub unavailable: Vec<String>,
}
fn pair_limit(n: usize, actors: usize, limits: &Limits) -> Result<usize> {
    let pairs = n
        .checked_mul(n.saturating_sub(1))
        .map(|n| n / 2)
        .ok_or_else(|| resource("candidate pairs"))?;
    if pairs > limits.max_candidate_pairs {
        return Err(resource("candidate pairs"));
    }
    if pairs
        .checked_mul(actors)
        .is_none_or(|n| n > limits.max_candidate_actor_terms)
    {
        return Err(resource("candidate actor terms"));
    }
    Ok(pairs)
}
fn actors_per_pair(entries: &[LayerCandidate<'_>]) -> Result<usize> {
    let max = entries
        .iter()
        .filter_map(|e| e.context.map(|c| c.ranking.weights.len()))
        .max()
        .unwrap_or(0);
    let first = entries.iter().find_map(|e| e.context);
    let mixed = first.is_some_and(|first| {
        entries
            .iter()
            .filter_map(|e| e.context)
            .any(|c| !first.same(c))
    });
    max.checked_mul(if mixed { 2 } else { 1 })
        .ok_or_else(|| resource("candidate actor terms"))
}
fn compare_entries(
    a: &LayerCandidate<'_>,
    b: &LayerCandidate<'_>,
    a_score: &Score<'_>,
    b_score: &Score<'_>,
    limits: &Limits,
) -> Result<Comparison> {
    let (Some(ac), Some(bc)) = (a.context, b.context) else {
        return Err(invalid("unavailable comparison context"));
    };
    if ac.same(bc) {
        difference(a.candidate, b.candidate, ac, limits)
    } else {
        separate_difference(a_score, b_score)
    }
}
pub fn nondominated_layers(entries: &[LayerCandidate<'_>], limits: &Limits) -> Result<Layers> {
    pair_limit(entries.len(), actors_per_pair(entries)?, limits)?;
    if entries
        .iter()
        .map(|e| &e.candidate.id)
        .collect::<BTreeSet<_>>()
        .len()
        != entries.len()
    {
        return Err(invalid("duplicate candidate ID"));
    }
    let mut active = Vec::new();
    let mut scores = Vec::new();
    let mut unavailable = Vec::new();
    for e in entries {
        match (e.candidate.eligibility, e.context) {
            (Eligibility::Unavailable, _) | (Eligibility::Eligible, None) => {
                unavailable.push(e.candidate.id.clone())
            }
            (Eligibility::Eligible, Some(c)) => {
                dimensions(e.candidate, c, limits)?;
                scores.push(score(c, e.candidate, limits)?);
                active.push(*e);
            }
            _ => (),
        }
    }
    let mut comparisons = Vec::new();
    for i in 0..active.len() {
        for j in i + 1..active.len() {
            if active[i].candidate.deprecated != active[j].candidate.deprecated {
                comparisons.push((i, j, None));
            } else {
                comparisons.push((
                    i,
                    j,
                    Some(compare_entries(
                        &active[i], &active[j], &scores[i], &scores[j], limits,
                    )?),
                ));
            }
        }
    }
    let mut edges = vec![Vec::new(); active.len()];
    for (i, j, c) in comparisons {
        if let Some(c) = c {
            if c.a_leads() {
                edges[i].push(j);
            } else if c.b_leads() {
                edges[j].push(i);
            }
        } else if active[i].candidate.deprecated {
            edges[j].push(i);
        } else {
            edges[i].push(j);
        }
    }
    let mut result = layers_from_edges(
        active.iter().map(|e| e.candidate.id.clone()).collect(),
        edges,
    )?;
    unavailable.sort();
    result.incomplete = !unavailable.is_empty();
    result.unavailable = unavailable;
    Ok(result)
}
/// Complete external pair decisions can include different context graphs.
pub fn layers_from_comparisons(
    ids: Vec<String>,
    comparisons: &[(usize, usize, Comparison)],
    limits: &Limits,
) -> Result<Layers> {
    let pairs = pair_limit(ids.len(), 0, limits)?;
    if comparisons.len() != pairs {
        return Err(invalid("comparison set is incomplete"));
    }
    let mut seen = BTreeSet::new();
    let mut edges = vec![Vec::new(); ids.len()];
    for (a, b, c) in comparisons {
        if *a >= ids.len() || *b >= ids.len() || a == b || !seen.insert((a.min(b), a.max(b))) {
            return Err(invalid("invalid comparison pair"));
        }
        interval(c.difference, false)?;
        let m = &c.margin;
        if m.graphs.is_empty()
            || m.graphs.len() > 2
            || m.contract != DECISION_CONTRACT
            || !m.contribution_mass.is_finite()
            || m.contribution_mass < 0.0
        {
            return Err(invalid("invalid comparison margin"));
        }
        let depth = m.graphs.iter().map(|g| g.depth).max().unwrap();
        let absolute = sum(m.graphs.iter().map(|g| g.flush_margin))?;
        if m.graphs.iter().any(|g| {
            g.depth > limits.max_actors.saturating_sub(1)
                || g.factor != relative_factor(g.depth)
                || g.flush_margin != g.flushed_terms as f64 * FLUSH_UNIT
        }) || m.depth != depth
            || m.factor != relative_factor(depth)
            || m.absolute != absolute
            || m.value != sum([finite(m.factor * m.contribution_mass)?, absolute])?
        {
            return Err(invalid("invalid comparison margin"));
        }
        if c.a_leads() {
            edges[*a].push(*b);
        } else if c.b_leads() {
            edges[*b].push(*a);
        }
    }
    layers_from_edges(ids, edges)
}

fn layers_from_edges(ids: Vec<String>, edges: Vec<Vec<usize>>) -> Result<Layers> {
    let n = ids.len();
    if ids.iter().collect::<BTreeSet<_>>().len() != n {
        return Err(invalid("duplicate candidate ID"));
    }
    // Iterative Kosaraju traversal avoids an actor-count dependent call stack.
    let mut reverse = vec![Vec::new(); n];
    for (from, row) in edges.iter().enumerate() {
        for &to in row {
            reverse[to].push(from);
        }
    }
    let mut seen = vec![false; n];
    let mut finish = Vec::new();
    for start in 0..n {
        if seen[start] {
            continue;
        }
        seen[start] = true;
        let mut stack = vec![(start, 0)];
        while let Some((actor, next)) = stack.last_mut() {
            if *next < edges[*actor].len() {
                let to = edges[*actor][*next];
                *next += 1;
                if !seen[to] {
                    seen[to] = true;
                    stack.push((to, 0));
                }
            } else {
                let (actor, _) = stack.pop().unwrap();
                finish.push(actor);
            }
        }
    }
    let mut component = vec![usize::MAX; n];
    let mut groups: Vec<Vec<usize>> = Vec::new();
    for start in finish.into_iter().rev() {
        if component[start] != usize::MAX {
            continue;
        }
        let group = groups.len();
        let mut members = Vec::new();
        let mut stack = vec![start];
        component[start] = group;
        while let Some(actor) = stack.pop() {
            members.push(actor);
            for &to in &reverse[actor] {
                if component[to] == usize::MAX {
                    component[to] = group;
                    stack.push(to);
                }
            }
        }
        groups.push(members);
    }
    let comparison_cycle = groups.iter().any(|group| group.len() > 1);
    let mut outgoing = vec![BTreeSet::new(); groups.len()];
    let mut incoming = vec![0usize; groups.len()];
    for (from, row) in edges.iter().enumerate() {
        for &to in row {
            let (a, b) = (component[from], component[to]);
            if a != b && outgoing[a].insert(b) {
                incoming[b] += 1;
            }
        }
    }
    let mut remaining: BTreeSet<_> = (0..groups.len()).collect();
    let mut layers = Vec::new();
    while !remaining.is_empty() {
        let layer: Vec<_> = remaining
            .iter()
            .copied()
            .filter(|&i| incoming[i] == 0)
            .collect();
        let mut names = Vec::new();
        for &group in &layer {
            for &actor in &groups[group] {
                names.push(ids[actor].clone());
            }
            remaining.remove(&group);
        }
        for group in layer {
            for &to in &outgoing[group] {
                incoming[to] -= 1;
            }
        }
        names.sort();
        layers.push(names);
    }
    Ok(Layers {
        layers,
        comparison_cycle,
        incomplete: false,
        unavailable: Vec::new(),
    })
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum StartingKind {
    NativeReviewed,
    Imported,
    VirtualUnreviewed,
}
#[derive(Clone, Debug)]
pub struct Presentation {
    pub id: String,
    direct_reviewers: Option<usize>,
    structural_known_zero: bool,
    pub kind: StartingKind,
}
impl Presentation {
    pub fn from_score(id: String, score: Option<&Score<'_>>, kind: StartingKind) -> Self {
        Self {
            id,
            direct_reviewers: score.map(|s| s.direct_reviewers),
            structural_known_zero: score.is_some_and(|s| s.structural_known_zero),
            kind,
        }
    }
}
/// Reorder only known unjudged structural-zero slots inside each complete layer.
pub fn order_unjudged(layers: &mut Layers, presentation: &[Presentation]) -> Result<()> {
    if layers.incomplete {
        return Err(resource("incomplete layers"));
    }
    let mut data = std::collections::BTreeMap::new();
    for item in presentation {
        if data.insert(&item.id, item).is_some() {
            return Err(invalid("duplicate presentation ID"));
        }
    }
    let mut next = layers.layers.clone();
    for layer in &mut next {
        let slots: Vec<_> = layer
            .iter()
            .enumerate()
            .filter_map(|(i, id)| {
                data.get(id)
                    .filter(|p| p.direct_reviewers == Some(0) && p.structural_known_zero)
                    .map(|_| i)
            })
            .collect();
        let mut ids: Vec<_> = slots.iter().map(|&i| layer[i].clone()).collect();
        ids.sort_by_key(|id| (data[id].kind, id.clone()));
        for (i, id) in slots.into_iter().zip(ids) {
            layer[i] = id;
        }
    }
    layers.layers = next;
    Ok(())
}
#[derive(Clone, Debug, PartialEq)]
pub struct CandidateDecisions {
    pub id: String,
    pub actual: Decision<ActualSupport>,
    pub eligible_potential: Decision<Potential>,
    pub threshold: Decision<Threshold>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Selection {
    pub selected: Option<String>,
    pub candidates: Vec<CandidateDecisions>,
    pub unresolved: Vec<Decision<Potential>>,
    pub conditional_on_identified_inventory: bool,
}
/// All entries and unresolved potentials belong to one known same-spelling inventory.
pub fn automatic_selection(
    entries: &[LayerCandidate<'_>],
    unresolved: &[Decision<Potential>],
    threshold: &Rational,
    limits: &Limits,
) -> Result<Selection> {
    if threshold <= &crate::rational(0, 1) {
        return Err(invalid("rafsi threshold must be positive"));
    }
    pair_limit(entries.len(), actors_per_pair(entries)?, limits)?;
    if entries
        .iter()
        .map(|e| &e.candidate.id)
        .collect::<BTreeSet<_>>()
        .len()
        != entries.len()
    {
        return Err(invalid("duplicate candidate ID"));
    }
    let mut candidates = Vec::new();
    let mut scores = Vec::new();
    for e in entries {
        let s = if e.candidate.eligibility == Eligibility::Eligible {
            e.context
                .map(|c| score(c, e.candidate, limits))
                .transpose()?
        } else {
            None
        };
        candidates.push(CandidateDecisions {
            id: e.candidate.id.clone(),
            actual: actual_positive_support(s.as_ref())?,
            eligible_potential: eligible_competitor_potential(s.as_ref())?,
            threshold: meets_threshold(s.as_ref(), threshold)?,
        });
        scores.push(s);
    }
    let mut selected = Vec::new();
    if unresolved
        .iter()
        .all(|d| d.status == Potential::Nonpositive)
    {
        for (i, e) in entries.iter().enumerate() {
            let d = &candidates[i];
            if e.candidate.eligibility != Eligibility::Eligible
                || e.candidate.deprecated
                || d.actual.status != ActualSupport::Positive
                || d.threshold.status != Threshold::Accepted
            {
                continue;
            }
            let mut wins = true;
            for (j, other) in entries.iter().enumerate() {
                if i == j
                    || other.candidate.eligibility == Eligibility::Ineligible
                    || other.candidate.deprecated
                {
                    continue;
                }
                match candidates[j].eligible_potential.status {
                    Potential::Nonpositive => (),
                    Potential::Unavailable => {
                        wins = false;
                        break;
                    }
                    Potential::Possible => {
                        let (Some(a_score), Some(b_score)) = (&scores[i], &scores[j]) else {
                            return Err(invalid("missing comparison score"));
                        };
                        if !compare_entries(e, other, a_score, b_score, limits)?.a_leads() {
                            wins = false;
                            break;
                        }
                    }
                }
            }
            if wins {
                selected.push(e.candidate.id.clone());
            }
        }
    }
    candidates.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(Selection {
        selected: if selected.len() == 1 {
            selected.pop()
        } else {
            None
        },
        candidates,
        unresolved: unresolved.to_vec(),
        conditional_on_identified_inventory: true,
    })
}
