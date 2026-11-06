//! Preparation attached to the existing authenticated evaluation session.
//! There are no numerical jobs, word results, or result caches in this module.
use super::*;
use jvc_rank::approximate as a;
use std::{collections::BTreeSet, sync::Arc};

pub const PREPARATION_CONTRACT: &str = "jvc-session-ranking-preparation-v2";
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct RankingPreparationLimits {
    pub records: usize,
    pub setup_bytes: usize,
    pub units: u64,
    pub word_publications: usize,
    pub targets: usize,
    pub contexts: usize,
    pub graph_bytes: usize,
    pub metadata_bytes: usize,
}
impl Default for RankingPreparationLimits {
    fn default() -> Self {
        Self {
            records: 1_000_000,
            setup_bytes: 512 * 1024 * 1024,
            units: 100_000_000,
            word_publications: 8192,
            targets: 4096,
            contexts: 128,
            graph_bytes: 64 * 1024 * 1024,
            metadata_bytes: 16 * 1024 * 1024,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RankingPreparationPolicy {
    /// The caller supplies the verified identity of the delivered core build.
    pub core_binding: String,
    #[serde(default)]
    pub limits: RankingPreparationLimits,
}
impl RankingPreparationPolicy {
    fn validate(&self) -> Result<()> {
        let l = &self.limits;
        if !jvc_core::valid_id(&self.core_binding, "sha256:")
            || l.records == 0
            || l.records > 1_000_000
            || l.setup_bytes == 0
            || l.setup_bytes > 1024 * 1024 * 1024
            || l.units == 0
            || l.units > 1_000_000_000
            || l.word_publications == 0
            || l.word_publications > 200_000
            || l.targets == 0
            || l.targets > 10_000
            || l.contexts == 0
            || l.contexts > 256
            || l.graph_bytes == 0
            || l.graph_bytes > 256 * 1024 * 1024
            || l.metadata_bytes == 0
            || l.metadata_bytes > 32 * 1024 * 1024
        {
            return Err(Error::new(
                "ranking_policy",
                "ranking preparation policy is invalid",
            ));
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
pub struct PreparationUsage {
    pub setup_records: usize,
    pub setup_bytes: u64,
    pub setup_units: u64,
    pub visited_publications: usize,
    pub charged_units: u64,
    pub context_calls: usize,
    pub graph_bytes: u64,
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct FloatParameter {
    pub numerator: String,
    pub denominator: String,
    pub bits: String,
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct PreparationParameters {
    pub h: FloatParameter,
    pub alpha: FloatParameter,
    pub threshold: FloatParameter,
    pub work: u64,
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct RankingPreparationDescriptor {
    pub version: u8,
    pub owner_session: String,
    pub binding: String,
    pub input_binding: String,
    pub contract_binding: String,
    pub policy_binding: String,
    pub core_binding: String,
    pub selected_view: String,
    pub mode: String,
    pub algorithm: Option<String>,
    pub available: bool,
    pub reasons: BTreeSet<String>,
    pub parameters: Option<PreparationParameters>,
    pub setup: PreparationUsage,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RankingPreparationRequest {
    pub owner_session: String,
    pub descriptor_binding: String,
    pub word: String,
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct PreparationTarget {
    pub id: String,
    pub context: Option<usize>,
    pub status: String,
    pub definition: bool,
    pub eligible: bool,
    pub reasons: BTreeSet<String>,
}
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct PreparationContext {
    pub context: jvc_state::Context,
    pub available: bool,
    pub reasons: BTreeSet<String>,
    pub actors: usize,
    pub edges: usize,
    pub refusals: usize,
    pub execution_binding: Option<String>,
    pub context_binding: Option<String>,
}
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct RankingPreparationSummary {
    pub owner_session: String,
    pub preparation_id: String,
    pub descriptor_binding: String,
    pub word: String,
    pub binding: String,
    pub targets: Vec<PreparationTarget>,
    pub contexts: Vec<PreparationContext>,
    pub usage: PreparationUsage,
}
#[derive(Serialize)]
struct PreparationMetadata<'a> {
    descriptor_binding: &'a str,
    usage: &'a PreparationUsage,
    prepared: Option<&'a RankingPreparationSummary>,
    retained_graphs: usize,
}
pub(crate) struct PreparedContext {
    pub(crate) graph: Option<Arc<a::Graph>>,
    pub(crate) judgments: BTreeMap<String, BTreeMap<String, jvc_state::Judgment>>,
    pub(crate) blocked: BTreeSet<usize>,
    pub(crate) public_shun_blocked: BTreeSet<usize>,
    pub(crate) private_blocked: BTreeSet<usize>,
}
pub(crate) struct PreparedRanking {
    pub(crate) contexts: Vec<PreparedContext>,
    pub(crate) summary: RankingPreparationSummary,
}
pub(crate) struct SessionPreparation {
    policy: RankingPreparationPolicy,
    pub(crate) descriptor: RankingPreparationDescriptor,
    usage: PreparationUsage,
    pub(crate) prepared: Option<PreparedRanking>,
}
fn resource(detail: &str) -> Error {
    Error::new("resource_unavailable", detail)
}
fn add(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b)
        .ok_or_else(|| resource("preparation count overflow"))
}
fn mul(a: u64, b: u64) -> Result<u64> {
    a.checked_mul(b)
        .ok_or_else(|| resource("preparation count overflow"))
}
fn bits(value: f64) -> String {
    format!("{:016x}", value.to_bits())
}
struct Capped(Vec<u8>, usize);
impl std::io::Write for Capped {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > self.1.saturating_sub(self.0.len()) {
            return Err(std::io::Error::other("ranking metadata limit"));
        }
        if self.0.len() + bytes.len() > self.0.capacity() {
            let capacity = (self.0.len() + bytes.len())
                .max(self.0.capacity().saturating_mul(2))
                .min(self.1);
            self.0
                .try_reserve_exact(capacity - self.0.len())
                .map_err(std::io::Error::other)?;
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
pub(crate) fn encoded(value: &impl Serialize, max: usize) -> Result<Vec<u8>> {
    let mut output = Capped(Vec::new(), max);
    serde_json::to_writer(&mut output, value).map_err(|e| resource(&e.to_string()))?;
    Ok(output.0)
}
fn digest(domain: &[u8], value: &impl Serialize, max: usize) -> Result<String> {
    Ok(jvc_core::hash_id("sha256:", domain, &encoded(value, max)?))
}
fn parameter(value: &Value) -> Result<FloatParameter> {
    let n = value["numerator"]
        .as_i64()
        .ok_or_else(|| Error::new("ranking", "signed numerator is unavailable"))?;
    let d = value["denominator"]
        .as_u64()
        .filter(|d| *d > 0)
        .ok_or_else(|| Error::new("ranking", "signed denominator is unavailable"))?;
    let exact = jvc_rank::Rational::new(n.into(), d.into());
    let converted = a::input(&exact, true).map_err(|_| {
        Error::new(
            "numeric_unavailable",
            "signed parameter cannot become normal binary64",
        )
    })?;
    Ok(FloatParameter {
        numerator: exact.numer().to_string(),
        denominator: exact.denom().to_string(),
        bits: bits(converted),
    })
}
fn parameters(e: &jvc_state::Evaluation) -> Result<PreparationParameters> {
    let p = e
        .policy
        .as_ref()
        .ok_or_else(|| Error::new("policy_unavailable", "selected policy is unavailable"))?;
    let work = e
        .overlay
        .as_ref()
        .and_then(|o| o["work"].as_u64())
        .or_else(|| p["work"].as_u64())
        .filter(|w| (1..=10_000_000).contains(w))
        .ok_or_else(|| Error::new("ranking", "signed work budget is unavailable"))?;
    Ok(PreparationParameters {
        h: parameter(&p["H"])?,
        alpha: parameter(&p["alpha"])?,
        threshold: parameter(&p["rafsi_threshold"])?,
        work,
    })
}
impl SessionPreparation {
    fn new(session: &EvaluationSession, policy: &RankingPreparationPolicy) -> Result<Self> {
        policy.validate()?;
        let limits = &policy.limits;
        let e = session.state.evaluation();
        let algorithm = e
            .policy
            .as_ref()
            .and_then(|p| p["calculation"].as_str())
            .map(str::to_owned);
        let mut reasons = e.reasons.clone();
        let unsupported = algorithm.as_deref().is_some_and(|a| a != a::ALGORITHM);
        if unsupported {
            reasons.insert("unsupported_calculation".into());
        }
        let parameters = match parameters(e) {
            Ok(p) => Some(p),
            Err(error) => {
                reasons.insert(error.code);
                None
            }
        };
        let available =
            e.available && algorithm.as_deref() == Some(a::ALGORITHM) && parameters.is_some();
        // Unsupported profiles need no ranking input identity or dictionary walk.
        let (input_binding, records, setup_bytes, setup_units) = if unsupported {
            (
                digest(
                    b"jvc-ranking-unsupported-v1\n",
                    &(&e.selected_view, &algorithm),
                    limits.metadata_bytes,
                )?,
                0,
                0,
                0,
            )
        } else {
            let records = session.state.ranking_source_records()?;
            if records > limits.records {
                return Err(resource("ranking setup record limit"));
            }
            let fixed_bytes = mul(records as u64, 256)?;
            let source_limit = (limits.setup_bytes as u64)
                .checked_sub(fixed_bytes)
                .ok_or_else(|| resource("ranking setup envelope limit"))?
                / 16;
            let (binding, bytes) = session
                .state
                .ranking_source_binding(source_limit as usize)?;
            let setup_bytes = add(mul(bytes as u64, 16)?, fixed_bytes)?;
            let setup_units = add(
                mul(bytes as u64, 4)?,
                mul(
                    mul(records as u64 + 1, 64)?,
                    u64::from(usize::BITS - (records + 1).leading_zeros()),
                )?,
            )?;
            if setup_units > limits.units {
                return Err(resource("ranking setup envelope limit"));
            }
            if available {
                session.state.ensure_ranking_index()?;
            }
            (binding, records, setup_bytes, setup_units)
        };
        let contract_binding = digest(
            b"jvc-ranking-preparation-contract-v1\n",
            &(
                PREPARATION_CONTRACT,
                a::ALGORITHM,
                a::ROW_CONTRACT,
                HOST_RECORD_VERSION,
                SEMANTIC_PROJECTION_VERSION,
                jvc_state::CHECKPOINT_VERSION,
                jvc_core::hash_id("sha256:", b"", include_bytes!("../../../docs/format.md")),
            ),
            limits.metadata_bytes,
        )?;
        let policy_binding = digest(
            b"jvc-ranking-preparation-policy-v1\n",
            policy,
            limits.metadata_bytes,
        )?;
        let binding = digest(
            b"jvc-ranking-descriptor-v1\n",
            &(
                &input_binding,
                &contract_binding,
                &policy_binding,
                &algorithm,
                &parameters,
                available,
                &reasons,
            ),
            limits.metadata_bytes,
        )?;
        let setup = PreparationUsage {
            setup_records: records,
            setup_bytes,
            setup_units,
            charged_units: setup_units,
            ..Default::default()
        };
        let descriptor = RankingPreparationDescriptor {
            version: 1,
            owner_session: session.identity.clone(),
            binding,
            input_binding,
            contract_binding,
            policy_binding,
            core_binding: policy.core_binding.clone(),
            selected_view: e.selected_view.clone(),
            mode: if e.overlay.is_some() {
                "personal"
            } else {
                "site"
            }
            .into(),
            algorithm,
            available,
            reasons,
            parameters,
            setup: setup.clone(),
        };
        encoded(&descriptor, limits.metadata_bytes)?;
        Ok(Self {
            policy: policy.clone(),
            descriptor,
            usage: setup,
            prepared: None,
        })
    }
    fn charge(&mut self, units: u64) -> Result<()> {
        if units
            > self
                .policy
                .limits
                .units
                .saturating_sub(self.usage.charged_units)
        {
            return Err(resource("ranking preparation unit limit"));
        }
        self.usage.charged_units = add(self.usage.charged_units, units)?;
        Ok(())
    }
    fn prepare(
        &mut self,
        session: &EvaluationSession,
        request: &RankingPreparationRequest,
    ) -> Result<RankingPreparationSummary> {
        if request.owner_session != session.identity
            || request.descriptor_binding != self.descriptor.binding
        {
            return Err(Error::new(
                "stale_binding",
                "preparation bindings do not match this session",
            ));
        }
        if !jvc_core::valid_id(&request.word, "jvw1:") {
            return Err(Error::new("word", "word identifier is invalid"));
        }
        if !self.descriptor.available {
            return Err(Error::new(
                if self.descriptor.reasons.contains("unsupported_calculation") {
                    "unsupported_calculation"
                } else {
                    "ranking_unavailable"
                },
                format!(
                    "session is unavailable for float preparation: {}",
                    self.descriptor
                        .reasons
                        .iter()
                        .cloned()
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            ));
        }
        let generation = session
            .preparation_generation
            .get()
            .checked_add(1)
            .ok_or_else(|| resource("preparation generation overflow"))?;
        // A valid replacement drops old graphs before allocating their successors.
        session.word_results.borrow_mut().take();
        self.prepared = None;
        session.preparation_generation.set(generation);
        self.usage = self.descriptor.setup.clone();
        let publications = session
            .state
            .ranking_publications(&request.word, self.policy.limits.word_publications)?;
        self.usage.visited_publications = publications.len();
        self.charge(add(1, mul(publications.len() as u64, 8)?)?)?;
        let e = session.state.evaluation();
        let mut targets: BTreeMap<
            String,
            (jvc_state::Context, String, bool, bool, BTreeSet<String>),
        > = BTreeMap::new();
        for p in publications {
            if p.eligible == jvc_state::Eligibility::NotSelected {
                continue;
            }
            let (id, context, status, definition, eligible) = if p.kind == "definition.publish" {
                if !e
                    .receipts
                    .get(&p.id)
                    .is_some_and(|r| r.interpretation == jvc_state::Interpretation::Effective)
                {
                    continue;
                }
                (
                    p.id.clone(),
                    jvc_state::Context {
                        kind: "definition".into(),
                        word: request.word.clone(),
                        language: p.language.clone(),
                    },
                    serde_json::to_value(&p.status)
                        .unwrap()
                        .as_str()
                        .unwrap()
                        .into(),
                    true,
                    p.eligible == jvc_state::Eligibility::Eligible
                        && p.content_available
                        && matches!(
                            p.status,
                            jvc_state::Status::Active | jvc_state::Status::Deprecated
                        ),
                )
            } else if let Some(assignment) = &p.assignment {
                let status =
                    assignment_status(targets.get(assignment).map(|t| t.1.as_str()), &p.eligible);
                (
                    assignment.clone(),
                    jvc_state::Context {
                        kind: "rafsi".into(),
                        word: request.word.clone(),
                        language: None,
                    },
                    status.into(),
                    false,
                    status == "active",
                )
            } else {
                continue;
            };
            if !targets.contains_key(&id) && targets.len() >= self.policy.limits.targets {
                return Err(resource("ranking target limit"));
            }
            targets.insert(
                id,
                (context, status, definition, eligible, p.reasons.clone()),
            );
        }
        let mut contexts: BTreeMap<(String, Option<String>), usize> = BTreeMap::new();
        for (c, _, _, eligible, _) in targets.values() {
            if *eligible && !contexts.contains_key(&(c.kind.clone(), c.language.clone())) {
                if contexts.len() >= self.policy.limits.contexts {
                    return Err(resource("ranking context limit"));
                }
                contexts.insert((c.kind.clone(), c.language.clone()), 0);
            }
        }
        for (i, index) in contexts.values_mut().enumerate() {
            *index = i;
        }
        let mut prepared = Vec::new();
        let mut summaries = Vec::new();
        for (kind, language) in contexts.keys() {
            let context = jvc_state::Context {
                kind: kind.clone(),
                word: request.word.clone(),
                language: language.clone(),
            };
            let bound = session.state.ranking_context_bound(&context)?;
            let cost = add(
                add(
                    mul(add(bound.targets, bound.judgments)?, 4)?,
                    mul(add(bound.trust_rules, bound.public_rules)?, 24)?,
                )?,
                add(
                    add(
                        mul(
                            add(add(bound.roots, bound.exclusions)?, bound.suspensions)?,
                            8,
                        )?,
                        mul(bound.overlay_entries, 32)?,
                    )?,
                    mul(bound.pairs_squared, 8)?,
                )?,
            )?;
            self.charge(add(1, cost)?)?;
            let limits = jvc_rank::Limits::default();
            let graph_bytes = add(
                mul(bound.actors, 1024)?,
                add(
                    mul(bound.edges, 128)?,
                    add(mul(bound.refusals, 64)?, mul(bound.judgments, 512)?)?,
                )?,
            )?;
            if graph_bytes
                > (self.policy.limits.graph_bytes as u64).saturating_sub(self.usage.graph_bytes)
            {
                return Err(resource("ranking context envelope limit"));
            }
            self.usage.graph_bytes = add(self.usage.graph_bytes, graph_bytes)?;
            self.usage.context_calls += 1;
            let contextual = session
                .state
                .prepare_indexed_approximate_context(&context)?;
            let actors = contextual.actors.len();
            let edges = contextual.rows.iter().map(Vec::len).sum();
            let refusals = contextual.refusals.iter().map(Vec::len).sum();
            let mut reasons = contextual.reasons.clone();
            let graph = if contextual.available {
                match a::Graph::new(
                    contextual.actors,
                    contextual.roots,
                    contextual
                        .rows
                        .into_iter()
                        .map(|row| {
                            row.into_iter()
                                .map(|edge| a::Edge {
                                    to: edge.to,
                                    share: edge.share,
                                })
                                .collect()
                        })
                        .collect(),
                    contextual.refusals,
                    &limits,
                ) {
                    Ok(g) => {
                        let graph = Arc::new(g);
                        #[cfg(test)]
                        CREATED_GRAPHS
                            .with(|graphs| graphs.borrow_mut().push(Arc::downgrade(&graph)));
                        Some(graph)
                    }
                    Err(error) => {
                        reasons.insert(
                            match error {
                                a::PreparationError::NumericUnavailable => "numeric_unavailable",
                                a::PreparationError::Graph(jvc_rank::RankError::ResourceLimit(
                                    _,
                                )) => "resource_unavailable",
                                _ => "invalid_graph",
                            }
                            .into(),
                        );
                        None
                    }
                }
            } else {
                None
            };
            let p = PreparedContext {
                graph,
                judgments: contextual.judgments,
                blocked: contextual.blocked,
                public_shun_blocked: contextual.public_shun_blocked,
                private_blocked: contextual.private_blocked,
            };
            let execution_binding = if let Some(g) = &p.graph {
                let graph_binding = digest(
                    b"jvc-ranking-graph-v1\n",
                    &json!({"actors":g.actors,"q":g.q.iter().map(|v|bits(*v)).collect::<Vec<_>>(),"rows":g.rows.iter().map(|row|row.iter().map(|e|(&e.to,bits(e.share))).collect::<Vec<_>>()).collect::<Vec<_>>(),"refusals":g.refusals}),
                    self.policy.limits.metadata_bytes,
                )?;
                Some(digest(
                    b"jvc-ranking-execution-v1\n",
                    &(
                        &self.descriptor.binding,
                        graph_binding,
                        &self.descriptor.parameters,
                    ),
                    self.policy.limits.metadata_bytes,
                )?)
            } else {
                None
            };
            let context_binding = if execution_binding.is_some() {
                Some(digest(
                    b"jvc-ranking-context-v1\n",
                    &(
                        &context,
                        &execution_binding,
                        &p.judgments,
                        &p.blocked,
                        &p.public_shun_blocked,
                        &p.private_blocked,
                    ),
                    self.policy.limits.metadata_bytes,
                )?)
            } else {
                None
            };
            summaries.push(PreparationContext {
                context,
                available: p.graph.is_some(),
                reasons,
                actors,
                edges,
                refusals,
                execution_binding,
                context_binding,
            });
            prepared.push(p);
        }
        let targets = targets
            .into_iter()
            .map(
                |(id, (c, status, definition, eligible, reasons))| PreparationTarget {
                    id,
                    context: contexts.get(&(c.kind, c.language)).copied(),
                    status,
                    definition,
                    eligible,
                    reasons,
                },
            )
            .collect();
        let binding = digest(
            b"jvc-ranking-prepared-word-v1\n",
            &(
                &self.descriptor.binding,
                &request.word,
                &targets,
                &summaries,
            ),
            self.policy.limits.metadata_bytes,
        )?;
        let summary = RankingPreparationSummary {
            owner_session: session.identity.clone(),
            preparation_id: format!("{}/preparation-{generation}", session.identity),
            descriptor_binding: self.descriptor.binding.clone(),
            word: request.word.clone(),
            binding,
            targets,
            contexts: summaries,
            usage: self.usage.clone(),
        };
        encoded(
            &Some(PreparationMetadata {
                descriptor_binding: &self.descriptor.binding,
                usage: &self.usage,
                prepared: Some(&summary),
                retained_graphs: prepared.iter().filter(|c| c.graph.is_some()).count(),
            }),
            self.policy.limits.metadata_bytes,
        )?;
        self.prepared = Some(PreparedRanking {
            contexts: prepared,
            summary: summary.clone(),
        });
        Ok(summary)
    }
}
impl EvaluationSession {
    pub fn ranking_descriptor_native(
        &self,
        policy: &RankingPreparationPolicy,
    ) -> Result<RankingPreparationDescriptor> {
        policy.validate()?;
        if self
            .preparation
            .borrow()
            .as_ref()
            .is_some_and(|p| p.policy == *policy)
        {
            return Ok(self
                .preparation
                .borrow()
                .as_ref()
                .unwrap()
                .descriptor
                .clone());
        }
        // Shape-invalid policies leave the controller intact. A different valid
        // policy releases it before setup admission, even when admission refuses.
        self.word_results.borrow_mut().take();
        self.preparation.borrow_mut().take();
        let preparation = SessionPreparation::new(self, policy)?;
        let descriptor = preparation.descriptor.clone();
        *self.preparation.borrow_mut() = Some(preparation);
        Ok(descriptor)
    }
    pub fn prepare_ranking_native(
        &self,
        request: &RankingPreparationRequest,
    ) -> Result<RankingPreparationSummary> {
        let mut preparation = self.preparation.borrow_mut();
        preparation
            .as_mut()
            .ok_or_else(|| {
                Error::new(
                    "ranking_preparation",
                    "ranking descriptor is not initialized",
                )
            })?
            .prepare(self, request)
    }
}
#[wasm_bindgen]
impl EvaluationSession {
    pub fn ranking_descriptor(&self, policy: &[u8]) -> std::result::Result<String, JsValue> {
        if policy.len() > 65536 {
            return Err(fail(Error::new(
                "ranking_policy",
                "ranking policy exceeds 65536 bytes",
            )));
        }
        let policy = serde_json::from_value(parse_json(policy).map_err(fail)?)
            .map_err(|e| fail(Error::new("ranking_policy", e.to_string())))?;
        output(self.ranking_descriptor_native(&policy).map_err(fail)?)
    }
    pub fn prepare_ranking(&self, request: &[u8]) -> std::result::Result<String, JsValue> {
        if request.len() > 4096 {
            return Err(fail(Error::new(
                "ranking_preparation",
                "ranking request exceeds 4096 bytes",
            )));
        }
        let request = serde_json::from_value(parse_json(request).map_err(fail)?)
            .map_err(|e| fail(Error::new("ranking_preparation", e.to_string())))?;
        output(self.prepare_ranking_native(&request).map_err(fail)?)
    }
    pub fn ranking_preparation(&self) -> std::result::Result<String, JsValue> {
        let p = self.preparation.borrow();
        let metadata = p.as_ref().map(|p| PreparationMetadata {
            descriptor_binding: &p.descriptor.binding,
            usage: &p.usage,
            prepared: p.prepared.as_ref().map(|p| &p.summary),
            retained_graphs: p.prepared.as_ref().map_or(0, |p| {
                p.contexts.iter().filter(|c| c.graph.is_some()).count()
            }),
        });
        let max = p.as_ref().map_or(1024, |p| p.policy.limits.metadata_bytes);
        encoded(&metadata, max)
            .map(|bytes| String::from_utf8(bytes).unwrap())
            .map_err(fail)
    }
    pub fn clear_ranking_preparation(&self) {
        self.word_results.borrow_mut().take();
        if let Some(p) = self.preparation.borrow_mut().as_mut() {
            p.prepared = None;
        }
    }
}

#[cfg(test)]
thread_local! {
    static CREATED_GRAPHS: std::cell::RefCell<Vec<std::sync::Weak<a::Graph>>> = const { std::cell::RefCell::new(Vec::new()) };
}
#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> (EvaluationSession, String) {
        let rows: Value =
            serde_json::from_str(include_str!("../tests/fixtures/host-record-inputs-v8.json"))
                .unwrap();
        let row = rows
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["name"] == "f64-contract-0")
            .unwrap();
        let mut view_body: Value = serde_json::from_str(row["body"].as_str().unwrap()).unwrap();
        view_body["roots"] = json!([{"identity":jvc_core::identity_from_seed(&[9;32]),"q":{"numerator":1,"denominator":1}}]);
        let view_body = canonical_value(&view_body).unwrap();
        let view_record = jvc_core::sign_header(
            &[20; 32],
            jvc_core::Header {
                version: 1,
                issuer: jvc_core::identity_from_seed(&[20; 32]),
                previous: vec![],
                nonce: "3".repeat(32),
                action: json!({"kind":"view.publish","parents":[]}),
                content: Some(jvc_core::body_descriptor(&view_body).unwrap()),
            },
        )
        .unwrap();
        let envelope = String::from_utf8(view_record.canonical_envelope().unwrap()).unwrap();
        let view: Value = serde_json::from_str(&envelope).unwrap();
        let word = jvc_core::word_id(&json!({"language":"jbo","spelling":"banli"})).unwrap();
        let body = canonical_value(
            &serde_json::from_str::<Value>(include_str!(
                "../../jvc-core/tests/fixtures/definition.json"
            ))
            .unwrap(),
        )
        .unwrap();
        let signed = jvc_core::sign_header(&[9;32], jvc_core::Header {
            version: 1, issuer: jvc_core::identity_from_seed(&[9;32]), previous: vec![], nonce: "1".repeat(32),
            action: json!({"kind":"definition.publish","word":word,"language":"en","parents":[],"origin":"native"}), content: Some(jvc_core::body_descriptor(&body).unwrap()),
        }).unwrap();
        let id = signed.id();
        let mut bodies = BTreeMap::new();
        bodies.insert(
            view["id"].as_str().unwrap().to_owned(),
            String::from_utf8(view_body).unwrap(),
        );
        bodies.insert(id.to_owned(), String::from_utf8(body).unwrap());
        let input = json!({"events":[envelope,String::from_utf8(signed.canonical_envelope().unwrap()).unwrap()],"bodies":bodies,"selected_view":view["id"],"import_selections":{}});
        (
            EvaluationSession::new(&serde_json::to_vec(&input).unwrap()).unwrap(),
            word,
        )
    }
    fn graph(session: &EvaluationSession) -> std::sync::Weak<a::Graph> {
        let p = session.preparation.borrow();
        Arc::downgrade(
            p.as_ref().unwrap().prepared.as_ref().unwrap().contexts[0]
                .graph
                .as_ref()
                .unwrap(),
        )
    }
    #[test]
    fn graphs_release_on_replacement_clear_policy_change_and_session_drop() {
        let (session, word) = session();
        let mut policy = RankingPreparationPolicy {
            core_binding: format!("sha256:{}", "a".repeat(64)),
            limits: Default::default(),
        };
        let descriptor = session.ranking_descriptor_native(&policy).unwrap();
        let mut request = RankingPreparationRequest {
            owner_session: descriptor.owner_session,
            descriptor_binding: descriptor.binding,
            word,
        };
        session.prepare_ranking_native(&request).unwrap();
        let first = graph(&session);
        request.owner_session.push('x');
        assert_eq!(
            session.prepare_ranking_native(&request).unwrap_err().code,
            "stale_binding"
        );
        assert!(first.upgrade().is_some());
        request.owner_session.pop();
        session.prepare_ranking_native(&request).unwrap();
        assert!(first.upgrade().is_none());
        let second = graph(&session);
        session.clear_ranking_preparation();
        session.clear_ranking_preparation();
        assert!(second.upgrade().is_none());
        session.prepare_ranking_native(&request).unwrap();
        let third = graph(&session);
        policy.core_binding = format!("sha256:{}", "b".repeat(64));
        let descriptor = session.ranking_descriptor_native(&policy).unwrap();
        assert!(third.upgrade().is_none());
        request.descriptor_binding = descriptor.binding;
        session.prepare_ranking_native(&request).unwrap();
        let refused = graph(&session);
        let mut smaller = policy.clone();
        smaller.limits.records = 1;
        assert_eq!(
            session
                .ranking_descriptor_native(&smaller)
                .unwrap_err()
                .code,
            "resource_unavailable"
        );
        assert!(refused.upgrade().is_none());
        assert!(session.preparation.borrow().is_none());
        request.descriptor_binding = session.ranking_descriptor_native(&policy).unwrap().binding;
        session.prepare_ranking_native(&request).unwrap();
        let last = graph(&session);
        drop(session);
        assert!(last.upgrade().is_none());
    }
    fn with_second_context(session: EvaluationSession, word: &str) -> EvaluationSession {
        let e = session.state.evaluation();
        let options =
            serde_json::to_vec(&json!({"selected_view":e.selected_view,"import_selections":{}}))
                .unwrap();
        let mut builder = session.fork(&options).unwrap();
        let mut body: Value = serde_json::from_str(include_str!(
            "../../jvc-core/tests/fixtures/definition.json"
        ))
        .unwrap();
        body["language"] = json!("fr");
        let body = canonical_value(&body).unwrap();
        let record = jvc_core::sign_header(&[8;32], jvc_core::Header {
            version:1, issuer:jvc_core::identity_from_seed(&[8;32]), previous:vec![], nonce:"2".repeat(32),
            action:json!({"kind":"definition.publish","word":word,"language":"fr","parents":[],"origin":"native"}),
            content:Some(jvc_core::body_descriptor(&body).unwrap()),
        }).unwrap();
        builder
            .add_record(&record.canonical_envelope().unwrap(), Some(body))
            .unwrap();
        builder.finish()
    }
    #[test]
    fn later_context_refusal_releases_the_earlier_temporary_graph() {
        let (session, word) = session();
        let session = with_second_context(session, &word);
        let mut policy = RankingPreparationPolicy {
            core_binding: format!("sha256:{}", "a".repeat(64)),
            limits: Default::default(),
        };
        let descriptor = session.ranking_descriptor_native(&policy).unwrap();
        let mut request = RankingPreparationRequest {
            owner_session: descriptor.owner_session,
            descriptor_binding: descriptor.binding,
            word,
        };
        let summary = session.prepare_ranking_native(&request).unwrap();
        let previous = graph(&session);
        assert_eq!(summary.contexts.len(), 2);
        let bound = session
            .state
            .ranking_context_bound(&summary.contexts[0].context)
            .unwrap();
        let first_bytes =
            bound.actors * 1024 + bound.edges * 128 + bound.refusals * 64 + bound.judgments * 512;
        policy.limits.graph_bytes = first_bytes as usize;
        request.descriptor_binding = session.ranking_descriptor_native(&policy).unwrap().binding;
        assert!(previous.upgrade().is_none());
        CREATED_GRAPHS.with(|graphs| graphs.borrow_mut().clear());
        assert_eq!(
            session.prepare_ranking_native(&request).unwrap_err().code,
            "resource_unavailable"
        );
        CREATED_GRAPHS.with(|graphs| {
            let graphs = graphs.borrow();
            assert_eq!(graphs.len(), 1);
            assert!(graphs[0].upgrade().is_none());
        });
        let p = session.preparation.borrow();
        assert!(p.as_ref().unwrap().prepared.is_none());
        assert_eq!(p.as_ref().unwrap().usage.context_calls, 1);
    }
    #[test]
    fn repeated_actor_bound_does_not_replace_actual_kernel_count_limits() {
        let (mut session, word) = session();
        // This trusted synthetic snapshot isolates the preparation count model.
        let mut saved: Value =
            serde_json::from_slice(&session.checkpoint("synthetic").unwrap()).unwrap();
        let actors: Vec<_> = (0u64..1000)
            .map(|n| {
                let mut seed = [0; 32];
                seed[..8].copy_from_slice(&n.to_le_bytes());
                jvc_core::identity_from_seed(&seed)
            })
            .collect();
        let mut trust = Vec::new();
        for i in 0..1000 {
            for hop in 1..=6 {
                trust.push(json!({"actor":actors[i],"subject":actors[(i+hop)%1000],"scope":{"kind":"definition","word":"*","language":"en"},"values":["heed"]}));
            }
        }
        saved["evaluation"]["trust"] = json!(trust);
        session.state = jvc_state::EvaluatedState::restore_host_checkpoint(
            &serde_json::to_vec(&saved).unwrap(),
            "synthetic",
        )
        .unwrap();
        let policy = RankingPreparationPolicy {
            core_binding: format!("sha256:{}", "a".repeat(64)),
            limits: Default::default(),
        };
        let descriptor = session.ranking_descriptor_native(&policy).unwrap();
        let context = jvc_state::Context {
            kind: "definition".into(),
            word: word.clone(),
            language: Some("en".into()),
        };
        let bound = session.state.ranking_context_bound(&context).unwrap();
        assert!(bound.actors > jvc_rank::Limits::default().max_actors as u64);
        let summary = session
            .prepare_ranking_native(&RankingPreparationRequest {
                owner_session: descriptor.owner_session,
                descriptor_binding: descriptor.binding,
                word,
            })
            .unwrap();
        assert!(summary.contexts[0].available);
        assert_eq!(summary.contexts[0].actors, 1001);
        assert_eq!(summary.contexts[0].edges, 6000);
    }
}
