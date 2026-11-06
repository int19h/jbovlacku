//! Bounded native word attempts. Scheduling and delivery live outside Wasm.
use super::*;
use crate::ranking_preparation::{PreparedRanking, encoded};
use a::decisions as d;
use jvc_rank::{Candidate, Eligibility, Limits, Verdict, approximate as a};
use std::sync::{Arc, Mutex};

pub const WORD_RESULT_CONTRACT: &str = "jvc-f64-word-results-v1";
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct WordResultPolicy {
    pub numerical_operations: u64,
    pub memory_bytes: usize,
    pub output_bytes: usize,
    pub targets: usize,
    pub comparisons: usize,
    pub actor_terms: usize,
    pub reviewers: Option<usize>,
    pub reviewer_terms: usize,
}
impl Default for WordResultPolicy {
    fn default() -> Self {
        Self {
            numerical_operations: 10_000_000,
            memory_bytes: 64 << 20,
            output_bytes: 4 << 20,
            targets: 128,
            comparisons: 8192,
            actor_terms: 1_000_000,
            reviewers: None,
            reviewer_terms: 4096,
        }
    }
}
impl WordResultPolicy {
    fn validate(&self) -> Result<()> {
        if self.numerical_operations == 0
            || self.numerical_operations > 100_000_000
            || self.memory_bytes == 0
            || self.memory_bytes > 256 << 20
            || self.output_bytes == 0
            || self.output_bytes > 4 << 20
            || self.targets == 0
            || self.targets > 4096
            || self.comparisons > 1_000_000
            || self.actor_terms > 10_000_000
            || self.reviewers.is_some_and(|n| n > 128)
            || self.reviewer_terms > 16384
        {
            return Err(Error::new("ranking_policy", "invalid word result policy"));
        }
        Ok(())
    }
}
/// Bind the normalized unsigned result policy before cache admission.
pub fn word_result_policy_binding_native(policy: &WordResultPolicy) -> Result<String> {
    policy.validate()?;
    Ok(jvc_core::hash_id(
        "sha256:",
        b"jvc-word-policy-v1\n",
        &encoded(&(policy, WORD_RESULT_CONTRACT, d::DECISION_CONTRACT), 8192)?,
    ))
}
#[wasm_bindgen]
pub fn word_result_policy_binding(bytes: &[u8]) -> std::result::Result<String, JsValue> {
    if bytes.len() > 8192 {
        return Err(fail(Error::new(
            "ranking_policy",
            "word policy exceeds 8192 bytes",
        )));
    }
    let policy = serde_json::from_value(parse_json(bytes).map_err(fail)?)
        .map_err(|e| fail(Error::new("ranking_policy", e.to_string())))?;
    word_result_policy_binding_native(&policy).map_err(fail)
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WordResultRequest {
    pub owner_session: String,
    pub descriptor_binding: String,
    pub preparation_id: String,
    #[serde(default)]
    pub policy: WordResultPolicy,
}
fn resource(s: &str) -> Error {
    Error::new("resource_unavailable", s)
}
fn checked(a: usize, b: usize) -> Result<usize> {
    a.checked_mul(b)
        .ok_or_else(|| resource("word count overflow"))
}
fn total(a: usize, b: usize) -> Result<usize> {
    a.checked_add(b)
        .ok_or_else(|| resource("word count overflow"))
}
fn numeric(e: a::PreparationError) -> Error {
    Error::new(
        if e == a::PreparationError::NumericUnavailable {
            "numeric_unavailable"
        } else {
            "resource_unavailable"
        },
        e.to_string(),
    )
}
fn interval(e: a::Estimate) -> Value {
    json!([e.lower, e.upper])
}
fn margin(m: &d::Margin) -> Value {
    json!({"contract":m.contract,"depth":m.depth,"factor":m.factor,"contribution_mass":m.contribution_mass,
        "absolute":m.absolute,"value":m.value,"graphs":m.graphs.iter().map(|g|json!({"depth":g.depth,"factor":g.factor,"flushed_terms":g.flushed_terms,"flush_margin":g.flush_margin})).collect::<Vec<_>>()})
}
fn progress(p: &a::Progress) -> Value {
    json!({"initialization_complete":p.initialization_complete,"completed":p.completed_work,
        "complete_stages":p.complete_stages,"depth":p.depth,"exploration_complete":p.exploration_complete,
        "numerical_operations":p.work.numerical_operations,"edge_attempts":p.work.edge_attempts,
        "refusal_tests":p.work.refusal_tests,"flushed_terms":p.work.flushed_terms,
        "upper_complete":p.upper.as_ref().is_some_and(|u|u.complete && !u.failed)})
}
struct Memory {
    limit: usize,
    live: Mutex<usize>,
    peak: Mutex<usize>,
}
impl Memory {
    fn bytes(c: a::AllocationCharge) -> Option<usize> {
        [
            (c.sums, 32),
            (c.prefixes, 128),
            (c.visited, 8),
            (c.estimates, 32),
            (c.graph_actors, 256),
            (c.graph_edges, 32),
            (c.graph_refusals, 16),
            (c.string_bytes, 1),
            (c.indices, 16),
        ]
        .iter()
        .try_fold(0usize, |a, (n, k)| a.checked_add(n.checked_mul(*k)?))
    }
}
impl a::AllocationAccount for Memory {
    fn reserve(&self, c: a::AllocationCharge) -> std::result::Result<(), a::PreparationError> {
        let bytes = Self::bytes(c).ok_or(a::PreparationError::Graph(
            jvc_rank::RankError::ResourceLimit("word memory"),
        ))?;
        let mut live = self.live.lock().unwrap();
        if bytes > self.limit.saturating_sub(*live) {
            return Err(a::PreparationError::Graph(
                jvc_rank::RankError::ResourceLimit("word memory"),
            ));
        }
        *live += bytes;
        let mut peak = self.peak.lock().unwrap();
        *peak = (*peak).max(*live);
        Ok(())
    }
    fn release(&self, c: a::AllocationCharge) {
        *self.live.lock().unwrap() -= Self::bytes(c).unwrap();
    }
}
pub(crate) struct WordAttempt {
    token: String,
    binding: String,
    policy_binding: String,
    policy: WordResultPolicy,
    parameters: a::Parameters,
    threshold: jvc_rank::Rational,
    prepared: Option<PreparedRanking>,
    groups: Vec<usize>,
    mapping: Vec<Option<usize>>,
    rankings: Vec<Option<a::OwnedRanking>>,
    causes: Vec<Option<String>>,
    observations: Vec<Value>,
    cursor: usize,
    executions: usize,
    active: Option<a::OwnedTask>,
    memory: Arc<Memory>,
    base_bytes: usize,
    proof_terms: usize,
    imported: std::collections::BTreeSet<String>,
    operations: u64,
    flushed: u64,
    completed: u64,
    phase: &'static str,
    error: Option<Error>,
    ready: Option<Vec<u8>>,
}
impl WordAttempt {
    fn new(
        mut prepared: PreparedRanking,
        parameters: &PreparationParameters,
        policy: WordResultPolicy,
        imported: std::collections::BTreeSet<String>,
    ) -> Result<Self> {
        let policy_binding = word_result_policy_binding_native(&policy)?;
        let token = prepared.summary.preparation_id.clone();
        let mut groups = Vec::new();
        let mut mapping = Vec::new();
        let mut keys = BTreeMap::new();
        for (i, c) in prepared.summary.contexts.iter().enumerate() {
            let group = c.execution_binding.as_ref().map(|key| {
                *keys
                    .entry(format!("{key}:{policy_binding}"))
                    .or_insert_with(|| {
                        groups.push(i);
                        groups.len() - 1
                    })
            });
            if group.is_some_and(|g| groups[g] != i) {
                prepared.contexts[i].graph.take();
            }
            mapping.push(group);
        }
        let n = prepared.summary.targets.len();
        let pairs = checked(n, n.saturating_sub(1))? / 2;
        let actors = prepared
            .summary
            .contexts
            .iter()
            .map(|c| c.actors)
            .max()
            .unwrap_or(0);
        let edges = prepared
            .summary
            .contexts
            .iter()
            .map(|c| c.edges)
            .max()
            .unwrap_or(0);
        let reviewers = checked(n, policy.reviewers.unwrap_or(0).min(actors))?;
        let mut visits = 0;
        let mut graph_bytes = 0;
        for i in &groups {
            let graph = prepared.contexts[*i].graph.as_ref().unwrap();
            let e = graph.rows.iter().map(Vec::len).sum::<usize>();
            let r = graph.refusals.iter().map(Vec::len).sum::<usize>();
            visits = total(visits, total(graph.actors.len(), total(e, r)?)?)?;
            graph_bytes = total(
                graph_bytes,
                total(
                    checked(graph.actors.len(), 1024)?,
                    total(checked(e, 128)?, checked(r, 64)?)?,
                )?,
            )?;
        }
        let terms = total(
            total(checked(n, actors)?, checked(checked(pairs, actors)?, 6)?)?,
            total(checked(visits, 4)?, checked(reviewers, edges)?)?,
        )?;
        let proof_terms = if actors == 0 {
            0
        } else {
            (policy.actor_terms.saturating_sub(terms) / checked(n.max(1), 4)?)
                .min(policy.memory_bytes / 2048)
        };
        let output_model = total(
            1024,
            total(
                checked(n, 2048)?,
                total(checked(pairs, 1024)?, checked(reviewers, 2048)?)?,
            )?,
        )?;
        let base_bytes = total(
            graph_bytes,
            total(
                total(
                    checked(checked(n, actors)?, 32)?,
                    checked(proof_terms, 320)?,
                )?,
                checked(output_model, 2)?,
            )?,
        )?;
        if n > policy.targets
            || pairs > policy.comparisons
            || terms > policy.actor_terms
            || proof_terms < actors
            || reviewers > policy.reviewer_terms
            || output_model > policy.output_bytes
            || base_bytes > policy.memory_bytes
        {
            return Err(resource("word structural or output envelope"));
        }
        let from_bits = |p: &FloatParameter| {
            u64::from_str_radix(&p.bits, 16)
                .map(f64::from_bits)
                .map_err(|_| Error::new("ranking", "invalid prepared parameter bits"))
        };
        let params = a::Parameters {
            h: from_bits(&parameters.h)?,
            alpha: from_bits(&parameters.alpha)?,
            work: parameters.work,
        };
        let threshold = jvc_rank::Rational::new(
            parameters
                .threshold
                .numerator
                .parse()
                .map_err(|_| resource("threshold"))?,
            parameters
                .threshold
                .denominator
                .parse()
                .map_err(|_| resource("threshold"))?,
        );
        let binding = jvc_core::hash_id(
            "sha256:",
            b"jvc-word-result-v1\n",
            &encoded(
                &(
                    &prepared.summary.binding,
                    &policy,
                    WORD_RESULT_CONTRACT,
                    d::DECISION_CONTRACT,
                ),
                65536,
            )?,
        );
        let count = groups.len();
        Ok(Self {
            token,
            binding,
            policy_binding,
            parameters: params,
            threshold,
            prepared: Some(prepared),
            groups,
            mapping,
            rankings: (0..count).map(|_| None).collect(),
            causes: vec![None; count],
            observations: vec![Value::Null; count],
            cursor: 0,
            executions: 0,
            active: None,
            memory: Arc::new(Memory {
                limit: policy.memory_bytes - base_bytes,
                live: Mutex::new(0),
                peak: Mutex::new(0),
            }),
            base_bytes,
            proof_terms,
            imported,
            policy,
            operations: 0,
            flushed: 0,
            completed: 0,
            phase: "running",
            error: None,
            ready: None,
        })
    }
    fn drop_work(&mut self) {
        self.active = None;
        self.rankings.clear();
        self.prepared = None;
    }
    fn snapshot(&self) -> Value {
        let active = self.active.as_ref().map(a::OwnedTask::progress);
        let flushed = self.flushed + active.as_ref().map_or(0, |p| p.progress.work.flushed_terms);
        let completed = self.completed + active.as_ref().map_or(0, |p| p.progress.completed_work);
        json!({"token":self.token,"binding":self.binding,"policy_binding":self.policy_binding,"phase":self.phase,"numerical_operations":self.operations,
            "flushed_terms":flushed,"completed":completed,"graphs_computed":self.executions,
            "in_call_reuse":self.mapping.iter().flatten().count().saturating_sub(self.groups.len()),
            "graphs":self.observations,"error":self.error,"memory_peak":self.base_bytes+*self.memory.peak.lock().unwrap()})
    }
    fn step(&mut self, operations: u64) -> Result<Value> {
        if operations == 0 || operations > 65536 {
            return Err(Error::new(
                "ranking_step",
                "word slice must contain 1 to 65536 operations",
            ));
        }
        if self.phase != "running" {
            return Ok(self.snapshot());
        }
        let mut remaining = operations;
        while remaining > 0 && self.cursor < self.groups.len() {
            let g = self.cursor;
            if self.operations >= self.policy.numerical_operations {
                if let Some(task) = self.active.take() {
                    let p = task.progress();
                    self.flushed += p.progress.work.flushed_terms;
                    self.completed += p.progress.completed_work;
                }
                self.causes[g] = Some("numerical_operations".into());
                self.cursor += 1;
                continue;
            }
            if self.active.is_none() {
                self.executions += 1;
                let graph = self.prepared.as_ref().unwrap().contexts[self.groups[g]]
                    .graph
                    .as_ref()
                    .unwrap()
                    .clone();
                match a::OwnedTask::new(
                    graph,
                    &self.parameters,
                    Limits::default(),
                    self.memory.clone(),
                ) {
                    Ok(task) => self.active = Some(task),
                    Err(e) => {
                        self.observations[g] = progress(&e.progress);
                        self.causes[g] = Some(e.cause.to_string());
                        self.cursor += 1;
                        continue;
                    }
                }
            }
            let take = remaining.min(self.policy.numerical_operations - self.operations);
            let task = self.active.as_mut().unwrap();
            let outcome = task.step(take);
            let used = task.last_slice_usage().numerical_operations;
            self.operations += used;
            remaining -= used;
            let p = task.progress();
            self.observations[g] = progress(&p.progress);
            if let Some(pending) = p.pending_stage {
                self.observations[g]["pending_stage"] = json!({"operations":pending.operations,"edge_attempts":pending.edge_attempts,"refusal_tests":pending.refusal_tests,"prefixes":pending.prefixes});
            }
            match outcome {
                Ok(false) => (),
                done => {
                    self.flushed += p.progress.work.flushed_terms;
                    self.completed += p.progress.completed_work;
                    match done {
                        Ok(true) => {
                            self.rankings[g] =
                                Some(task.take_result().map_err(|e| numeric(e.cause))?)
                        }
                        Err(e) => self.causes[g] = Some(e.cause.to_string()),
                        _ => unreachable!(),
                    }
                    self.active = None;
                    self.cursor += 1;
                }
            }
        }
        if self.cursor == self.groups.len() {
            self.phase = "ready";
            match self
                .finish()
                .and_then(|v| encoded(&v, self.policy.output_bytes))
            {
                Ok(bytes) => {
                    self.ready = Some(bytes);
                    self.phase = "ready";
                }
                Err(e) => {
                    self.error = Some(e);
                    self.phase = "failed";
                }
            }
            self.drop_work();
        }
        Ok(self.snapshot())
    }
    fn finish(&self) -> Result<Value> {
        let p = self.prepared.as_ref().unwrap();
        let limits = Limits {
            max_candidate_pairs: self.policy.comparisons,
            max_candidate_actor_terms: self.policy.actor_terms,
            ..Limits::default()
        };
        let mut score_limits = limits.clone();
        score_limits.max_candidate_actor_terms = self.proof_terms;
        score_limits.max_prefixes = score_limits.max_prefixes.min(self.proof_terms);
        score_limits.max_visited_actor_entries =
            score_limits.max_visited_actor_entries.min(self.proof_terms);
        score_limits.max_refusal_tests =
            score_limits.max_refusal_tests.min(self.proof_terms as u64);
        let contexts: Vec<_> = self
            .groups
            .iter()
            .enumerate()
            .map(|(g, c)| match &self.rankings[g] {
                Some(r) => d::DecisionContext::new(
                    p.contexts[*c].graph.as_ref().unwrap(),
                    &self.parameters,
                    r.ranking(),
                    &limits,
                )
                .map(Some)
                .map_err(numeric),
                None => Ok(None),
            })
            .collect::<Result<_>>()?;
        let candidates: Vec<_> = p
            .summary
            .targets
            .iter()
            .map(|t| {
                let g = t.context.and_then(|c| self.mapping[c]);
                let verdicts = g
                    .map(|g| {
                        p.contexts[self.groups[g]]
                            .graph
                            .as_ref()
                            .unwrap()
                            .actors
                            .iter()
                            .map(|actor| {
                                match p.contexts[t.context.unwrap()]
                                    .judgments
                                    .get(&t.id)
                                    .and_then(|j| j.get(actor))
                                {
                                    Some(jvc_state::Judgment::Bless) => Verdict::Bless,
                                    Some(jvc_state::Judgment::Curse) => Verdict::Curse,
                                    _ => Verdict::Absent,
                                }
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                Candidate {
                    id: t.id.clone(),
                    verdicts,
                    eligibility: if t.eligible && g.is_some_and(|i| contexts[i].is_some()) {
                        Eligibility::Eligible
                    } else if t.status == "inactive" {
                        Eligibility::Ineligible
                    } else {
                        Eligibility::Unavailable
                    },
                    deprecated: t.status == "deprecated",
                }
            })
            .collect();
        let entries: Vec<_> = candidates
            .iter()
            .zip(&p.summary.targets)
            .map(|(candidate, t)| d::LayerCandidate {
                candidate,
                context: t
                    .context
                    .and_then(|i| self.mapping[i])
                    .and_then(|i| contexts[i].as_ref()),
            })
            .collect();
        let scores: Vec<_> = entries
            .iter()
            .map(|e| {
                match e
                    .context
                    .filter(|_| e.candidate.eligibility == Eligibility::Eligible)
                {
                    Some(c) => d::score(c, e.candidate, &score_limits)
                        .map(Some)
                        .map_err(numeric),
                    None => Ok(None),
                }
            })
            .collect::<Result<_>>()?;
        let mut output = Vec::new();
        let mut unavailable = Vec::new();
        let mut inactive = Vec::new();
        for (i, (t, s)) in p.summary.targets.iter().zip(&scores).enumerate() {
            let Some(s) = s else {
                if candidates[i].eligibility == Eligibility::Ineligible {
                    inactive.push(json!({"target":t.id,"status":t.status}));
                    continue;
                }
                let mut reasons: std::collections::BTreeSet<String> = t.reasons.clone();
                if let Some(c) = t.context {
                    reasons.extend(p.summary.contexts[c].reasons.iter().cloned());
                    if let Some(cause) = self.mapping[c].and_then(|g| self.causes[g].clone()) {
                        reasons.insert(cause);
                    }
                }
                if reasons.is_empty() {
                    reasons.insert("context_unavailable".into());
                }
                unavailable.push(json!({"target":t.id,"reasons":reasons}));
                continue;
            };
            let actual = d::actual_positive_support(Some(s)).map_err(numeric)?;
            let potential = d::eligible_competitor_potential(Some(s)).map_err(numeric)?;
            let threshold = d::meets_threshold(Some(s), &self.threshold).map_err(numeric)?;
            let mut value = json!({"target":t.id,"status":t.status,"support":interval(s.support),"opposition":interval(s.opposition),"net":interval(s.net),
                "direct_reviewers":s.direct_reviewers(),"structural_known_zero":s.structural_known_zero(),
                "actual_positive_support":match actual.status { d::ActualSupport::Positive=>"positive",d::ActualSupport::NotEstablished=>"not_established",d::ActualSupport::Unavailable=>"unavailable" },"eligible_potential":match potential.status { d::Potential::Nonpositive=>"nonpositive",d::Potential::Possible=>"possible",d::Potential::Unavailable=>"unavailable" },"threshold":match threshold.status { d::Threshold::Accepted=>"accepted",d::Threshold::NotEstablished=>"not_established",d::Threshold::Unavailable=>"unavailable" },"actual_positive_margin":actual.margin.as_ref().map(margin),"eligible_potential_margin":potential.margin.as_ref().map(margin),"threshold_margin":threshold.margin.as_ref().map(margin)});
            if let Some(max) = self.policy.reviewers {
                let c = t.context.unwrap();
                let g = self.mapping[c].unwrap();
                let graph = p.contexts[self.groups[g]].graph.as_ref().unwrap();
                let r = self.rankings[g].as_ref().unwrap().ranking();
                let mut details = Vec::new();
                for (actor, verdict) in candidates[i]
                    .verdicts
                    .iter()
                    .enumerate()
                    .filter(|(_, v)| **v != Verdict::Absent)
                    .take(max)
                {
                    let mut incoming = Vec::new();
                    let mut count = 0;
                    for (from, row) in graph.rows.iter().enumerate() {
                        for edge in row {
                            if edge.to == actor {
                                count += 1;
                                if incoming.len() < 16 {
                                    incoming.push(&graph.actors[from]);
                                }
                            }
                        }
                    }
                    details.push(json!({"identity":graph.actors[actor],"verdict":match verdict { Verdict::Bless=>"bless",Verdict::Curse=>"curse",Verdict::Absent=>"absent" },"weight":interval(r.weights[actor]),"root":graph.q[actor],
                        "blocked":p.contexts[c].blocked.contains(&actor),"public_shun_block":p.contexts[c].public_shun_blocked.contains(&actor),"private_block":p.contexts[c].private_blocked.contains(&actor),
                        "incoming":incoming,"incoming_count":count,"incoming_complete":count<=16}));
                }
                value["reviewers_complete"] = json!(details.len() == s.direct_reviewers());
                value["reviewers"] = json!(details);
            }
            output.push(value);
        }
        let definitions: Vec<_> = entries
            .iter()
            .zip(&p.summary.targets)
            .filter(|(_, t)| t.definition)
            .map(|(e, _)| *e)
            .collect();
        let mut layers = d::nondominated_layers(&definitions, &limits).map_err(numeric)?;
        let presentation: Vec<_> = p
            .summary
            .targets
            .iter()
            .zip(&scores)
            .filter(|(t, _)| t.definition)
            .map(|(t, s)| {
                d::Presentation::from_score(
                    t.id.clone(),
                    s.as_ref(),
                    if self.imported.contains(&t.id) {
                        d::StartingKind::Imported
                    } else {
                        d::StartingKind::NativeReviewed
                    },
                )
            })
            .collect();
        if !layers.incomplete {
            d::order_unjudged(&mut layers, &presentation).map_err(numeric)?;
        }
        let mut comparisons = Vec::new();
        for i in 0..entries.len() {
            for j in i + 1..entries.len() {
                if !p.summary.targets[i].definition || !p.summary.targets[j].definition {
                    continue;
                }
                let (Some(a), Some(b)) = (&scores[i], &scores[j]) else {
                    continue;
                };
                let same = p.summary.targets[i].context.and_then(|c| self.mapping[c])
                    == p.summary.targets[j].context.and_then(|c| self.mapping[c]);
                let c = if same {
                    d::difference(
                        &candidates[i],
                        &candidates[j],
                        entries[i].context.unwrap(),
                        &limits,
                    )
                } else {
                    d::separate_difference(a, b)
                }
                .map_err(numeric)?;
                comparisons.push(json!({"a":candidates[i].id,"b":candidates[j].id,"difference":interval(c.difference),"margin":margin(&c.margin),"a_leads":c.a_leads(),"b_leads":c.b_leads()}));
            }
        }
        let unresolved = p
            .summary
            .targets
            .iter()
            .enumerate()
            .filter(|(_, t)| !t.definition && t.status == "unavailable")
            .map(|(i, _)| {
                d::unresolved_pair_potential(
                    entries[i].context,
                    Some(&candidates[i].verdicts),
                    &score_limits,
                )
                .map_err(numeric)
            })
            .collect::<Result<Vec<_>>>()?;
        let unresolved_wire:Vec<_>=p.summary.targets.iter().filter(|t|!t.definition && t.status=="unavailable").zip(&unresolved)
            .map(|(t,d)|json!({"target":t.id,"potential":match d.status { d::Potential::Possible=>"possible",d::Potential::Nonpositive=>"nonpositive",d::Potential::Unavailable=>"unavailable" },"margin":d.margin.as_ref().map(margin)})).collect();
        Ok(
            json!({"version":1,"contract":WORD_RESULT_CONTRACT,"binding":self.binding,"preparation_binding":p.summary.binding,"result_policy_binding":self.policy_binding,
            "word":p.summary.word,"algorithm":a::ALGORITHM,"numerically_approximate":true,"certified":false,
            "scores":output,"comparisons":comparisons,"layers":layers.layers,"layers_complete":!layers.incomplete,
            "comparison_cycle":layers.comparison_cycle,"inactive_targets":inactive,"unavailable_scores":unavailable,"partial":!unavailable.is_empty(),
            "rafsi_scope":"requested_word","unresolved_rafsi":unresolved_wire,"progress":self.snapshot()}),
        )
    }
}
impl EvaluationSession {
    pub fn start_word_results_native(&self, request: &WordResultRequest) -> Result<Value> {
        request.policy.validate()?;
        if self.word_results.borrow().is_some() {
            return Err(Error::new(
                "ranking_busy",
                "a native word attempt is already retained",
            ));
        }
        let mut state = self.preparation.borrow_mut();
        let state = state
            .as_mut()
            .ok_or_else(|| Error::new("ranking_preparation", "preparation is unavailable"))?;
        if request.owner_session != self.identity
            || request.descriptor_binding != state.descriptor.binding
            || state
                .prepared
                .as_ref()
                .is_none_or(|p| p.summary.preparation_id != request.preparation_id)
        {
            return Err(Error::new(
                "stale_binding",
                "word preparation does not match",
            ));
        }
        let parameters = state.descriptor.parameters.as_ref().unwrap();
        let imported = state
            .prepared
            .as_ref()
            .unwrap()
            .summary
            .targets
            .iter()
            .filter(|t| {
                self.state
                    .evaluation()
                    .publications
                    .get(&t.id)
                    .is_some_and(|p| p.imported)
            })
            .map(|t| t.id.clone())
            .collect();
        let attempt = WordAttempt::new(
            state.prepared.take().unwrap(),
            parameters,
            request.policy.clone(),
            imported,
        )?;
        let snapshot = attempt.snapshot();
        *self.word_results.borrow_mut() = Some(attempt);
        Ok(snapshot)
    }
    pub fn step_word_results_native(&self, token: &str, operations: u64) -> Result<Value> {
        let mut slot = self.word_results.borrow_mut();
        let attempt = slot
            .as_mut()
            .ok_or_else(|| Error::new("ranking_result", "no native word attempt"))?;
        if token != attempt.token {
            return Err(Error::new("stale_binding", "word attempt does not match"));
        }
        attempt.step(operations)
    }
    pub fn cancel_word_results_native(&self, token: &str) -> Result<Value> {
        let mut slot = self.word_results.borrow_mut();
        if slot.as_ref().is_some_and(|a| a.token != token) {
            return Err(Error::new("stale_binding", "word attempt does not match"));
        }
        Ok(slot.take().map_or(Value::Null, |a| {
            let mut value = a.snapshot();
            value["phase"] = json!("cancelled");
            value
        }))
    }
    pub fn take_word_result_native(&self, token: &str) -> Result<Vec<u8>> {
        let mut slot = self.word_results.borrow_mut();
        let a = slot
            .as_mut()
            .ok_or_else(|| Error::new("ranking_result", "no native word attempt"))?;
        if token != a.token || a.phase != "ready" {
            return Err(Error::new("ranking_result", "word result is not ready"));
        }
        let result = a.ready.take().unwrap();
        slot.take();
        Ok(result)
    }
}
#[wasm_bindgen]
impl EvaluationSession {
    pub fn start_word_results(&self, request: &[u8]) -> std::result::Result<String, JsValue> {
        if request.len() > 8192 {
            return Err(fail(Error::new(
                "ranking_policy",
                "word request exceeds 8192 bytes",
            )));
        }
        let request = serde_json::from_value(parse_json(request).map_err(fail)?)
            .map_err(|e| fail(Error::new("ranking_policy", format!("{e}"))))?;
        output(self.start_word_results_native(&request).map_err(fail)?)
    }
    pub fn step_word_results(
        &self,
        token: &str,
        operations: u32,
    ) -> std::result::Result<String, JsValue> {
        output(
            self.step_word_results_native(token, operations.into())
                .map_err(fail)?,
        )
    }
    pub fn word_result_progress(&self) -> std::result::Result<String, JsValue> {
        output(
            self.word_results
                .borrow()
                .as_ref()
                .map(WordAttempt::snapshot),
        )
    }
    pub fn take_word_result(&self, token: &str) -> std::result::Result<Vec<u8>, JsValue> {
        self.take_word_result_native(token).map_err(fail)
    }
    pub fn cancel_word_results(&self, token: &str) -> std::result::Result<String, JsValue> {
        output(self.cancel_word_results_native(token).map_err(fail)?)
    }
}

#[cfg(test)]
mod release_tests {
    use super::*;
    use std::collections::BTreeSet;
    fn attempt() -> (WordAttempt, std::sync::Weak<a::Graph>) {
        let graph = Arc::new(
            a::Graph::new(
                vec!["actor".into()],
                vec![1.0],
                vec![vec![]],
                vec![vec![]],
                &Limits::default(),
            )
            .unwrap(),
        );
        let weak = Arc::downgrade(&graph);
        let context = crate::ranking_preparation::PreparedContext {
            graph: Some(graph),
            judgments: BTreeMap::new(),
            blocked: BTreeSet::new(),
            public_shun_blocked: BTreeSet::new(),
            private_blocked: BTreeSet::new(),
        };
        let prepared = PreparedRanking {
            contexts: vec![context],
            summary: RankingPreparationSummary {
                owner_session: "owner".into(),
                preparation_id: "owner/preparation-1".into(),
                descriptor_binding: "descriptor".into(),
                word: "word".into(),
                binding: "binding".into(),
                targets: vec![PreparationTarget {
                    id: "target".into(),
                    context: Some(0),
                    status: "active".into(),
                    definition: true,
                    eligible: true,
                    reasons: BTreeSet::new(),
                }],
                contexts: vec![PreparationContext {
                    context: jvc_state::Context {
                        kind: "definition".into(),
                        word: "word".into(),
                        language: Some("en".into()),
                    },
                    available: true,
                    reasons: BTreeSet::new(),
                    actors: 1,
                    edges: 0,
                    refusals: 0,
                    execution_binding: Some("graph".into()),
                    context_binding: Some("context".into()),
                }],
                usage: Default::default(),
            },
        };
        let parameter = |numerator: &str, denominator: &str, v: f64| FloatParameter {
            numerator: numerator.into(),
            denominator: denominator.into(),
            bits: format!("{:016x}", v.to_bits()),
        };
        let parameters = PreparationParameters {
            h: parameter("3", "1", 3.0),
            alpha: parameter("1", "2", 0.5),
            threshold: parameter("1", "1", 1.0),
            work: 1000,
        };
        (
            WordAttempt::new(
                prepared,
                &parameters,
                WordResultPolicy::default(),
                BTreeSet::new(),
            )
            .unwrap(),
            weak,
        )
    }
    #[test]
    fn ready_fault_cancel_and_disposal_release_all_native_graphs_and_leases() {
        for mode in ["ready", "allocation", "serialization", "cancel"] {
            let (mut attempt, weak) = attempt();
            if mode == "allocation" {
                Arc::get_mut(&mut attempt.memory).unwrap().limit = 0;
            }
            if mode == "serialization" {
                attempt.policy.output_bytes = 1;
            }
            let memory = attempt.memory.clone();
            if mode == "cancel" {
                attempt.step(1).unwrap();
                drop(attempt);
            } else {
                while attempt.phase == "running" {
                    attempt.step(4096).unwrap();
                }
                assert!(attempt.prepared.is_none());
                assert!(attempt.active.is_none());
                assert!(attempt.rankings.is_empty());
                if mode == "serialization" {
                    assert_eq!(attempt.phase, "failed");
                    assert!(attempt.ready.is_none());
                }
                drop(attempt);
            }
            assert!(weak.upgrade().is_none(), "{mode}");
            assert_eq!(*memory.live.lock().unwrap(), 0, "{mode}");
        }
    }
}
