//! Preparation attached to the existing authenticated evaluation session.
//! There are no numerical jobs, word results, or result caches in this module.
use super::*;
use jvc_rank::approximate as a;
use std::{collections::BTreeSet, sync::Arc};

pub const PREPARATION_CONTRACT: &str = "jvc-session-ranking-preparation-v5";
/// Fixed part of the default setup-unit budget.
pub const SETUP_UNITS_FIXED_ALLOWANCE: u64 = 100_000_000;
/// Default setup-unit allowance per index entry. It covers the widest
/// charge per entry: `16 * 64 + 16` at bit length 64.
pub const SETUP_UNITS_PER_ENTRY: u64 = 1040;
/// Default setup-unit allowance per copied key byte. It covers the
/// charge per key byte: 2 from the index term plus 4 from the walk term.
pub const SETUP_UNITS_PER_KEY_BYTE: u64 = 6;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct RankingPreparationLimits {
    pub records: Option<usize>,
    pub setup_bytes: Option<usize>,
    pub units: u64,
    pub setup_units: Option<u64>,
    pub source_bytes: Option<usize>,
    pub source_millis: u64,
    pub word_publications: usize,
    pub targets: usize,
    pub contexts: usize,
    pub graph_bytes: usize,
    pub metadata_bytes: usize,
}
impl Default for RankingPreparationLimits {
    fn default() -> Self {
        Self {
            records: None,
            setup_bytes: None,
            units: 100_000_000,
            setup_units: None,
            source_bytes: None,
            source_millis: 30_000,
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
    /// A preflight envelope from index inputs, without index allocation.
    pub fn setup_estimate(&self, c: &jvc_state::RankingIndexCounts) -> Result<(u64, u64)> {
        self.validate()?;
        let terms = [
            (c.words, 256),
            (c.word_publications, 64),
            (c.target_groups, 256),
            (c.targets, 96),
            (c.judgment_groups, 192),
            (c.trust_rules, 1024),
            (c.scope_buckets, 256),
            (c.scope_rules, 16),
            (c.private_pairs, 192),
            (c.private_weights, 512),
            (c.private_rules, 1536),
        ];
        let mut bytes = c.key_bytes;
        let mut entries = 0;
        for (count, coefficient) in terms {
            bytes = add(bytes, mul(count, coefficient)?)?;
            entries = add(entries, count)?;
        }
        // Root allocations are not amortized for small maps and sets.
        // Empty B-trees allocate nothing. One scratch pair map is live at a time.
        let nonempty = |n| u64::from(n != 0);
        let mut maps = 0;
        for n in [
            c.words,
            c.target_groups,
            c.judgment_groups,
            c.private_pairs,
            c.private_rules,
        ] {
            maps = add(maps, nonempty(n))?;
        }
        maps = add(maps, mul(nonempty(c.scope_buckets), 3)?)?;
        let sets = add(c.target_groups, c.private_rules)?;
        let fixed = add(mul(maps, 1536)?, mul(sets, 384)?)?;
        // Measured roots and first split nodes fit these base allowances.
        // The outer factor also covers allocator overhead and transient maps.
        let bytes = mul(add(bytes, fixed)?, 2)?;
        let log = bit_length(entries);
        let base = mul(add(mul(mul(entries, 8)?, log)?, c.key_bytes)?, 2)?;
        // The record-count walk and the index-count walk scan these entries
        // and key bytes. Charge them in the same total, before index build.
        let walk = add(mul(entries, 16)?, mul(c.key_bytes, 4)?)?;
        // Index construction compares keys that can share long prefixes:
        // each key byte can be read in at most eleven comparisons per
        // tree level, over at most `log` levels.
        let comparison = mul(mul(11, c.key_bytes)?, log)?;
        let units = add(add(base, walk)?, comparison)?;
        if self
            .limits
            .setup_bytes
            .is_some_and(|limit| bytes > limit as u64)
            || units > self.effective_setup_units(entries, c.key_bytes)?
        {
            return Err(resource("ranking setup envelope limit"));
        }
        Ok((bytes, units))
    }
    /// The explicit setup-unit quota, or the scaled default for these counts.
    pub fn effective_setup_units(&self, entries: u64, key_bytes: u64) -> Result<u64> {
        if let Some(limit) = self.limits.setup_units {
            return Ok(limit);
        }
        add(
            add(
                SETUP_UNITS_FIXED_ALLOWANCE,
                mul(entries, SETUP_UNITS_PER_ENTRY)?,
            )?,
            mul(
                key_bytes,
                add(SETUP_UNITS_PER_KEY_BYTE, mul(11, bit_length(entries))?)?,
            )?,
        )
    }
    /// A meter that charges setup work before it runs. Entry and key
    /// totals only grow during a walk, so the scaled default computed
    /// from them is a lower bound on the final default budget.
    fn setup_meter(&self, entries: u64, key_bytes: u64) -> SetupMeter {
        SetupMeter {
            explicit: self.limits.setup_units,
            spent: 0,
            entries,
            key_bytes,
            credited: 0,
        }
    }
    fn validate(&self) -> Result<()> {
        let l = &self.limits;
        if !jvc_core::valid_id(&self.core_binding, "sha256:")
            || l.records == Some(0)
            || l.setup_bytes == Some(0)
            || l.units == 0
            || l.units > 1_000_000_000
            || l.setup_units == Some(0)
            || l.source_bytes == Some(0)
            || l.source_millis == 0
            || l.source_millis > 120_000
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
    pub source_bytes: u64,
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
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = performance, js_name = now)]
    fn setup_now() -> f64;
}
fn source_binding(
    state: &jvc_state::EvaluatedState,
    limits: &RankingPreparationLimits,
) -> Result<(String, usize)> {
    #[cfg(not(target_arch = "wasm32"))]
    let start = std::time::Instant::now();
    #[cfg(target_arch = "wasm32")]
    let start = setup_now();
    state.ranking_source_binding_checked(limits.source_bytes.unwrap_or(usize::MAX), || {
        #[cfg(not(target_arch = "wasm32"))]
        {
            start.elapsed().as_secs_f64() * 1000.0 <= limits.source_millis as f64
        }
        #[cfg(target_arch = "wasm32")]
        {
            let elapsed = setup_now() - start;
            elapsed.is_finite() && elapsed >= 0.0 && elapsed <= limits.source_millis as f64
        }
    })
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
fn parameter(value: jvc_state::ValueView, meter: &mut SetupMeter) -> Result<FloatParameter> {
    let n = value
        .get_metered("numerator", &mut |w| meter.charge(w, 0, 0, 0))?
        .and_then(|v| v.as_i64())
        .ok_or_else(|| Error::new("ranking", "signed numerator is unavailable"))?;
    let d = value
        .get_metered("denominator", &mut |w| meter.charge(w, 0, 0, 0))?
        .and_then(|v| v.as_u64())
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
fn parameters(e: &jvc_state::Evaluation, meter: &mut SetupMeter) -> Result<PreparationParameters> {
    let p = e
        .policy
        .as_ref()
        .ok_or_else(|| Error::new("policy_unavailable", "selected policy is unavailable"))?;
    let mut work = None;
    if let Some(overlay) = &e.overlay {
        meter.charge(
            jvc_state::lookup_work(
                overlay.as_object().map_or(0, |o| o.len()) as u64,
                "work".len() as u64,
            ),
            0,
            0,
            0,
        )?;
        work = overlay["work"].as_u64();
    }
    let view = p.view();
    let work = match work {
        Some(w) => Some(w),
        None => view
            .get_metered("work", &mut |w| meter.charge(w, 0, 0, 0))?
            .and_then(|v| v.as_u64()),
    }
    .filter(|w| (1..=10_000_000).contains(w))
    .ok_or_else(|| Error::new("ranking", "signed work budget is unavailable"))?;
    let field = |key: &str, meter: &mut SetupMeter| -> Result<jvc_state::ValueView> {
        view.get_metered(key, &mut |w| meter.charge(w, 0, 0, 0))?
            .ok_or_else(|| Error::new("ranking", "signed parameter is unavailable"))
    };
    Ok(PreparationParameters {
        h: parameter(field("H", meter)?, meter)?,
        alpha: parameter(field("alpha", meter)?, meter)?,
        threshold: parameter(field("rafsi_threshold", meter)?, meter)?,
        work,
    })
}
fn bit_length(entries: u64) -> u64 {
    u64::from(64 - entries.saturating_add(1).leading_zeros())
}

/// Charges setup work before it runs, against an explicit quota or the
/// scaled default for the entries and key bytes charged so far.
struct SetupMeter {
    explicit: Option<u64>,
    spent: u64,
    entries: u64,
    key_bytes: u64,
    credited: u64,
}
impl SetupMeter {
    fn charge(&mut self, work: u64, entries: u64, key_bytes: u64, credited: u64) -> Result<()> {
        self.spent = add(self.spent, work)?;
        self.entries = add(self.entries, entries)?;
        self.key_bytes = add(self.key_bytes, key_bytes)?;
        self.credited = add(self.credited, credited)?;
        let budget = match self.explicit {
            Some(limit) => limit,
            None => self.default_budget()?,
        };
        if self.spent > budget {
            return Err(resource("ranking setup envelope limit"));
        }
        Ok(())
    }
    /// The scaled default for the totals charged so far, including the
    /// comparison-byte term and one entry allowance per credited item.
    fn default_budget(&self) -> Result<u64> {
        add(
            add(
                add(
                    SETUP_UNITS_FIXED_ALLOWANCE,
                    mul(self.entries, SETUP_UNITS_PER_ENTRY)?,
                )?,
                mul(
                    self.key_bytes,
                    add(SETUP_UNITS_PER_KEY_BYTE, mul(11, bit_length(self.entries))?)?,
                )?,
            )?,
            mul(self.credited, SETUP_UNITS_PER_ENTRY)?,
        )
    }
    /// The final default plus one entry allowance per credited item.
    fn final_budget(&self, policy: &RankingPreparationPolicy) -> Result<u64> {
        add(
            policy.effective_setup_units(self.entries, self.key_bytes)?,
            mul(self.credited, SETUP_UNITS_PER_ENTRY)?,
        )
    }
}
impl SessionPreparation {
    fn new(session: &EvaluationSession, policy: &RankingPreparationPolicy) -> Result<Self> {
        policy.validate()?;
        let limits = &policy.limits;
        let e = session.state.evaluation();
        // The meter exists before anything is read or copied from the
        // evaluation. Every lookup, clone, and copy below is charged
        // through it before it runs. After a charged read refuses, no
        // further work over restored data happens: the session is
        // classified only from what the reads before the refusal
        // already learned, and anything else returns the refusal.
        let mut meter = policy.setup_meter(0, 0);
        let mut reasons = BTreeSet::new();
        // The selected view identifier is cloned into the descriptor.
        // A refusal here has learned nothing, so it returns at once.
        meter.charge(add(e.selected_view.len() as u64, 16)?, 0, 0, 0)?;
        // Build the reason set through the meter: each entry is charged
        // for its set insertion comparisons and its string copy before
        // either happens. A refusal here also returns at once.
        for reason in &e.reasons {
            let work = add(
                add(
                    jvc_state::lookup_work(e.reasons.len() as u64, reason.len() as u64),
                    reason.len() as u64,
                )?,
                16,
            )?;
            meter.charge(work, 0, 0, 0)?;
            reasons.insert(reason.clone());
        }
        // Read the calculation field borrowed, charge its length, and
        // only then copy it. A refusal in either charge returns at
        // once: without the copied name the descriptor cannot name
        // the profile.
        let calculation = match e.policy.as_ref() {
            Some(policy) => policy
                .view()
                .get_metered("calculation", &mut |w| meter.charge(w, 0, 0, 0))?,
            None => None,
        };
        let algorithm: Option<String> = match calculation.as_ref().and_then(|v| v.as_str()) {
            Some(name) => {
                meter.charge(name.len() as u64, 0, 0, 0)?;
                Some(name.to_owned())
            }
            None => None,
        };
        let unsupported = algorithm.as_deref().is_some_and(|a| a != a::ALGORITHM);
        // Parameters are read charged. A charged refusal returns at
        // once, on every profile: no source hash, serialization, or
        // descriptor work over restored data follows it. A diagnostic
        // descriptor is returned only when no charged read refused.
        let parameters = match parameters(e, &mut meter) {
            Ok(p) => Some(p),
            Err(error) if error.code == "resource_unavailable" => return Err(error),
            Err(error) => {
                reasons.insert(error.code);
                None
            }
        };
        if unsupported {
            reasons.insert("unsupported_calculation".into());
        }
        let available =
            e.available && algorithm.as_deref() == Some(a::ALGORITHM) && parameters.is_some();
        // Unsupported profiles need no ranking input identity or dictionary walk.
        let (input_binding, records, setup_bytes, setup_units, source_bytes) = if unsupported {
            (
                digest(
                    b"jvc-ranking-unsupported-v1\n",
                    &(&e.selected_view, &algorithm),
                    limits.metadata_bytes,
                )?,
                0,
                0,
                0,
                0,
            )
        } else {
            // Every setup walk is charged to the setup-unit budget before
            // it runs. The meter starts from zero: each walk item charges
            // its exact entry and key-byte contribution, so the meter
            // totals never exceed the final counts. Unavailable sessions
            // skip the walks entirely and report zero setup counts.
            let records = if available {
                session
                    .state
                    .ranking_source_records_metered(&mut |w, en, k, c| meter.charge(w, en, k, c))?
            } else {
                0
            };
            if limits.records.is_some_and(|limit| records > limit) {
                return Err(resource("ranking setup record limit"));
            }
            let (setup_bytes, setup_units) = if available {
                let counts = session
                    .state
                    .ranking_index_bound_metered(&mut |w, en, k, c| meter.charge(w, en, k, c))?;
                // Safeguard: total spent work must also fit the final
                // default for the true counts, not only each provisional
                // budget seen during the walk.
                if meter.spent > meter.final_budget(policy)? {
                    return Err(resource("ranking setup envelope limit"));
                }
                policy.setup_estimate(&counts)?
            } else {
                (0, 0)
            };
            let (binding, bytes) = source_binding(&session.state, limits)?;
            if available {
                session
                    .state
                    .ensure_ranking_index_metered(&mut |w, en, k, c| meter.charge(w, en, k, c))?;
                // Construction work must also fit the final budget for
                // the true counts, plus credited walk items.
                if meter.spent > meter.final_budget(policy)? {
                    return Err(resource("ranking setup envelope limit"));
                }
            }
            (binding, records, setup_bytes, setup_units, bytes as u64)
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
            source_bytes,
            charged_units: 0,
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
        smaller.limits.records = Some(1);
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
    #[test]
    fn measured_dictionary_shape_has_memory_and_work_headroom() {
        let c = jvc_state::RankingIndexCounts {
            words: 89687,
            word_publications: 89687,
            target_groups: 89687,
            targets: 93806,
            judgment_groups: 89687,
            key_bytes: 33432924,
            ..Default::default()
        };
        let mut p = RankingPreparationPolicy {
            core_binding: format!("sha256:{}", "a".repeat(64)),
            limits: Default::default(),
        };
        assert_eq!(p.limits.records, None);
        assert_eq!(p.limits.setup_bytes, None);
        assert_eq!(p.limits.setup_units, None);
        assert_eq!(p.limits.source_bytes, None);
        let (bytes, units) = p.setup_estimate(&c).unwrap();
        assert_eq!((bytes, units), (291_524_664, 7_332_895_940));
        assert!(units + 50_000_000 < p.effective_setup_units(452_554, 33_432_924).unwrap());
        assert_eq!(p.limits.units, 100_000_000);
        let mut grown = serde_json::to_value(&c).unwrap();
        for count in grown.as_object_mut().unwrap().values_mut() {
            *count = json!(count.as_u64().unwrap() * 3 / 2);
        }
        let grown: jvc_state::RankingIndexCounts = serde_json::from_value(grown).unwrap();
        p.setup_estimate(&grown).unwrap();
        p.limits.setup_bytes = Some(bytes as usize);
        p.limits.setup_units = Some(units);
        assert_eq!(p.setup_estimate(&c).unwrap(), (bytes, units));
        p.limits.setup_bytes = Some(bytes as usize - 1);
        assert_eq!(
            p.setup_estimate(&c).unwrap_err().code,
            "resource_unavailable"
        );
        p.limits.setup_bytes = Some(bytes as usize);
        p.limits.setup_units = Some(units - 1);
        assert_eq!(
            p.setup_estimate(&c).unwrap_err().code,
            "resource_unavailable"
        );
        // Eight times the measured shape passes at the scaled default and
        // under quotas above the old whole-dictionary ceilings.
        p.limits.setup_bytes = Some(1024 * 1024 * 1024 * 4);
        p.limits.setup_units = Some(4_000_000_000);
        let mut large = c.clone();
        large.words *= 8;
        large.word_publications *= 8;
        large.target_groups *= 8;
        large.targets *= 8;
        large.judgment_groups *= 8;
        large.key_bytes *= 8;
        p.limits.setup_bytes = None;
        p.limits.setup_units = None;
        p.setup_estimate(&large).unwrap();
        large.words = u64::MAX;
        assert_eq!(
            p.setup_estimate(&large).unwrap_err().code,
            "resource_unavailable"
        );
    }
    fn restored_with(
        mut session: EvaluationSession,
        edit: impl FnOnce(&mut Value),
    ) -> EvaluationSession {
        let mut saved: Value =
            serde_json::from_slice(&session.checkpoint("synthetic").unwrap()).unwrap();
        edit(&mut saved);
        session.state = jvc_state::EvaluatedState::restore_host_checkpoint(
            &serde_json::to_vec(&saved).unwrap(),
            "synthetic",
        )
        .unwrap();
        session.word_results.borrow_mut().take();
        *session.preparation.borrow_mut() = None;
        session
    }
    fn restored_with_judgments(session: EvaluationSession, judgments: Value) -> EvaluationSession {
        restored_with(session, |saved| {
            saved["evaluation"]["judgments"] = judgments;
        })
    }
    #[test]
    fn setup_above_a_million_records_without_a_quota_completes() {
        let (session, word) = session();
        let inner: serde_json::Map<String, Value> = (0..=1_000_000u32)
            .map(|n| (format!("k{n}"), json!("bless")))
            .collect();
        let session = restored_with_judgments(
            session,
            json!({ format!("jve1:{}", "0".repeat(64)): inner }),
        );
        let policy = RankingPreparationPolicy {
            core_binding: format!("sha256:{}", "a".repeat(64)),
            limits: Default::default(),
        };
        let descriptor = session.ranking_descriptor_native(&policy).unwrap();
        assert!(descriptor.available, "{:?}", descriptor.reasons);
        assert!(descriptor.setup.setup_records > 1_000_000);
        let summary = session
            .prepare_ranking_native(&RankingPreparationRequest {
                owner_session: descriptor.owner_session.clone(),
                descriptor_binding: descriptor.binding.clone(),
                word: word.clone(),
            })
            .unwrap();
        assert_eq!(summary.usage.setup_records, descriptor.setup.setup_records);
        // A configured record quota keeps the old refusal and message.
        let mut quota = policy.clone();
        quota.limits.records = Some(descriptor.setup.setup_records - 1);
        let error = session.ranking_descriptor_native(&quota).unwrap_err();
        assert_eq!(error.code, "resource_unavailable");
        assert_eq!(error.message, "ranking setup record limit");
        // A configured envelope quota keeps the old refusal and message.
        let mut quota = policy.clone();
        quota.limits.setup_bytes = Some(descriptor.setup.setup_bytes as usize - 1);
        let error = session.ranking_descriptor_native(&quota).unwrap_err();
        assert_eq!(error.code, "resource_unavailable");
        assert_eq!(error.message, "ranking setup envelope limit");
        // A configured setup-unit quota below the advance charge also refuses.
        let mut quota = policy;
        quota.limits.setup_units = Some(1);
        let error = session.ranking_descriptor_native(&quota).unwrap_err();
        assert_eq!(error.code, "resource_unavailable");
        assert_eq!(error.message, "ranking setup envelope limit");
    }
    #[test]
    fn source_above_256_mib_without_a_quota_completes() {
        let (session, _word) = session();
        let inner: serde_json::Map<String, Value> = (0..9u32)
            .map(|n| (format!("k{n}-{}", "x".repeat(30_000_000)), json!("bless")))
            .collect();
        let session = restored_with_judgments(
            session,
            json!({ format!("jve1:{}", "0".repeat(64)): inner }),
        );
        let mut policy = RankingPreparationPolicy {
            core_binding: format!("sha256:{}", "a".repeat(64)),
            limits: Default::default(),
        };
        // This test checks the byte quota, not the clock. Give the large
        // synthetic walk the widest time limit so parallel test load
        // cannot trip it.
        policy.limits.source_millis = 120_000;
        let descriptor = session.ranking_descriptor_native(&policy).unwrap();
        assert!(descriptor.available, "{:?}", descriptor.reasons);
        assert!(descriptor.setup.source_bytes > 256 * 1024 * 1024);
        // A configured source quota keeps the old refusal.
        let mut quota = policy;
        quota.limits.source_bytes = Some(descriptor.setup.source_bytes as usize - 1);
        assert_eq!(
            session.ranking_descriptor_native(&quota).unwrap_err().code,
            "resource_unavailable"
        );
    }
    #[test]
    fn mid_range_quota_refuses_before_the_count_walk() {
        let (first, _word) = session();
        let mut policy = RankingPreparationPolicy {
            core_binding: format!("sha256:{}", "a".repeat(64)),
            limits: Default::default(),
        };
        policy.limits.setup_units = Some(65);
        let error = first.ranking_descriptor_native(&policy).unwrap_err();
        assert_eq!(error.code, "resource_unavailable");
        assert_eq!(error.message, "ranking setup envelope limit");
        // A malformed private overlay makes a completed count walk return
        // `invalid_overlay`. The same quota must still refuse first.
        let (second, _word) = session();
        let session = restored_with(second, |saved| {
            let overlay = json!({"trust":[{"issuer":1}]});
            saved["evaluation"]["overlay"] = overlay.clone();
            saved["options"]["overlay"] = overlay;
        });
        let error = session.ranking_descriptor_native(&policy).unwrap_err();
        assert_eq!(error.code, "resource_unavailable");
        assert_eq!(error.message, "ranking setup envelope limit");
    }
    #[test]
    fn count_walk_charges_trust_rules_and_scope_trees_first() {
        // Many trust rules: the meter must stop inside the trust walk,
        // before the malformed private overlay at its end can error.
        let (first, _word) = session();
        let actor = format!("ed25519:{}", "a".repeat(64));
        let rule = format!(
            "{{\"actor\":\"{actor}\",\"subject\":\"{actor}\",\"scope\":{{\"kind\":\"definition\",\"word\":\"*\",\"language\":\"en\"}},\"values\":[\"heed\"]}}"
        );
        let trust: Value =
            serde_json::from_str(&format!("[{}]", vec![rule; 1_000_000].join(","))).unwrap();
        let restored = restored_with(first, |saved| {
            saved["evaluation"]["trust"] = trust;
            let overlay = json!({"trust":[{"issuer":1}]});
            saved["evaluation"]["overlay"] = overlay.clone();
            saved["options"]["overlay"] = overlay;
        });
        let mut policy = RankingPreparationPolicy {
            core_binding: format!("sha256:{}", "a".repeat(64)),
            limits: Default::default(),
        };
        policy.limits.setup_units = Some(1_000_000);
        let error = restored.ranking_descriptor_native(&policy).unwrap_err();
        assert_eq!(error.code, "resource_unavailable");
        assert_eq!(error.message, "ranking setup envelope limit");
        // One trust rule with a wide scope tree of numbers: the scope walk
        // is charged per node, before the descriptor can succeed.
        let (second, _word) = session();
        let wide = json!({"kind":"definition","word":"*","language":"en","extra":vec![0; 100_000]});
        let restored = restored_with(second, |saved| {
            saved["evaluation"]["trust"] = json!([{
                "actor": actor,
                "subject": actor,
                "scope": wide,
                "values": ["heed"],
            }]);
        });
        policy.limits.setup_units = Some(10_000);
        let error = restored.ranking_descriptor_native(&policy).unwrap_err();
        assert_eq!(error.code, "resource_unavailable");
        assert_eq!(error.message, "ranking setup envelope limit");
    }
    #[test]
    fn count_walk_charges_public_values_before_visiting_them() {
        let (first, _word) = session();
        let actor = format!("ed25519:{}", "a".repeat(64));
        let values: Vec<String> = (0..1_000_000u32).map(|n| format!("v{n:06}")).collect();
        let restored = restored_with(first, |saved| {
            saved["evaluation"]["trust"] = json!([{
                "actor": actor,
                "subject": actor,
                "scope": {"kind": "definition", "word": "*", "language": "en"},
                "values": values,
            }]);
            let overlay = json!({"trust":[{"issuer":1}]});
            saved["evaluation"]["overlay"] = overlay.clone();
            saved["options"]["overlay"] = overlay;
        });
        let mut policy = RankingPreparationPolicy {
            core_binding: format!("sha256:{}", "a".repeat(64)),
            limits: Default::default(),
        };
        // Enough for the post-walk charge of the old code, which then ran
        // into the malformed overlay; the per-value charge must stop first.
        policy.limits.setup_units = Some(8_000_000);
        let error = restored.ranking_descriptor_native(&policy).unwrap_err();
        assert_eq!(error.code, "resource_unavailable");
        assert_eq!(error.message, "ranking setup envelope limit");
    }
    fn final_entries(c: &jvc_state::RankingIndexCounts) -> u64 {
        c.words
            + c.word_publications
            + c.target_groups
            + c.targets
            + c.judgment_groups
            + c.trust_rules
            + c.scope_buckets
            + c.scope_rules
            + c.private_pairs
            + c.private_weights
            + c.private_rules
    }
    #[test]
    fn meter_totals_equal_the_final_counts_for_each_rule_kind() {
        let policy = RankingPreparationPolicy {
            core_binding: format!("sha256:{}", "a".repeat(64)),
            limits: Default::default(),
        };
        let actor = format!("ed25519:{}", "a".repeat(64));
        let mut scenarios: Vec<EvaluationSession> = Vec::new();
        let (base, _word) = session();
        scenarios.push(base);
        let (with_public, _word) = session();
        scenarios.push(restored_with(with_public, |saved| {
            saved["evaluation"]["trust"] = json!([{
                "actor": actor,
                "subject": actor,
                "scope": {"kind": "definition", "word": "*", "language": "en"},
                "values": ["heed"],
            }]);
        }));
        for value in ["heed", "shun"] {
            let (with_private, _word) = session();
            scenarios.push(restored_with(with_private, |saved| {
                let overlay = json!({"trust":[{
                    "issuer": actor,
                    "subject": actor,
                    "value": value,
                    "scope": {"kind": "definition", "word": "*", "language": "en"},
                }]});
                saved["evaluation"]["overlay"] = overlay.clone();
                saved["options"]["overlay"] = overlay;
            }));
        }
        for scenario in &scenarios {
            let mut meter = policy.setup_meter(0, 0);
            let counts = scenario
                .state
                .ranking_index_bound_metered(&mut |w, e, k, c| meter.charge(w, e, k, c))
                .unwrap();
            assert_eq!(meter.entries, final_entries(&counts));
            assert_eq!(meter.key_bytes, counts.key_bytes);
            assert!(
                meter.spent
                    <= policy
                        .effective_setup_units(meter.entries, meter.key_bytes)
                        .unwrap()
            );
        }
    }
    #[test]
    fn wide_scope_with_many_publications_refuses_at_the_default() {
        let (first, _word) = session();
        let actor = format!("ed25519:{}", "a".repeat(64));
        let restored = restored_with(first, |saved| {
            let publications = saved["evaluation"]["publications"].as_object().unwrap();
            let definition = publications
                .values()
                .find(|p| p["kind"] == "definition.publish")
                .unwrap()
                .clone();
            let publications = saved["evaluation"]["publications"].as_object_mut().unwrap();
            for n in 0..100u32 {
                let id = format!("jve1:{n:064x}");
                let mut publication = definition.clone();
                publication["id"] = json!(id);
                publications.insert(id, publication);
            }
            saved["evaluation"]["trust"] = json!([{
                "actor": actor,
                "subject": actor,
                "scope": {
                    "kind": "definition",
                    "word": "*",
                    "language": "en",
                    "extra": vec![0; 30_000_000],
                },
                "values": ["heed"],
            }]);
        });
        let policy = RankingPreparationPolicy {
            core_binding: format!("sha256:{}", "a".repeat(64)),
            limits: Default::default(),
        };
        let error = restored.ranking_descriptor_native(&policy).unwrap_err();
        assert_eq!(error.code, "resource_unavailable");
        assert_eq!(error.message, "ranking setup envelope limit");
    }
    #[test]
    fn private_lookup_charges_long_shared_prefix_keys() {
        let (first, _word) = session();
        let prefix = "a".repeat(99_990);
        let actor = format!("ed25519:{}", "b".repeat(64));
        let key_actor: serde_json::Map<String, Value> = (0..1000u32)
            .map(|n| (format!("{prefix}:{n:04}"), json!(actor)))
            .collect();
        let long_key = format!("{prefix}:0999");
        let restored = restored_with(first, |saved| {
            saved["evaluation"]["lifecycle"]["key_actor"] = Value::Object(key_actor);
            let overlay = json!({"trust":[{
                "issuer": long_key,
                "subject": long_key,
                "value": "shun",
                "scope": {"kind": "definition", "word": "*", "language": "en"},
            }]});
            saved["evaluation"]["overlay"] = overlay.clone();
            saved["options"]["overlay"] = overlay;
        });
        let mut policy = RankingPreparationPolicy {
            core_binding: format!("sha256:{}", "a".repeat(64)),
            limits: Default::default(),
        };
        policy.limits.setup_units = Some(20_000);
        let error = restored.ranking_descriptor_native(&policy).unwrap_err();
        assert_eq!(error.code, "resource_unavailable");
        assert_eq!(error.message, "ranking setup envelope limit");
    }
    #[test]
    fn setup_lookups_are_all_charged_through_the_helper() {
        let (first, _word) = session();
        let actor = format!("ed25519:{}", "a".repeat(64));
        let session = restored_with(first, |saved| {
            let overlay = json!({"trust":[{
                "issuer": actor,
                "subject": actor,
                "value": "heed",
                "scope": {"kind": "definition", "word": "*", "language": "en"},
            }]});
            saved["evaluation"]["overlay"] = overlay.clone();
            saved["options"]["overlay"] = overlay;
        });
        let policy = RankingPreparationPolicy {
            core_binding: format!("sha256:{}", "a".repeat(64)),
            limits: Default::default(),
        };
        let mut meter = policy.setup_meter(0, 0);
        jvc_state::reset_setup_lookup_calls();
        session
            .state
            .ranking_source_records_metered(&mut |w, e, k, c| meter.charge(w, e, k, c))
            .unwrap();
        session
            .state
            .ranking_index_bound_metered(&mut |w, e, k, c| meter.charge(w, e, k, c))
            .unwrap();
        // Records walk: 3 overlay field reads. Count walk: 1 reasons
        // read, 1 overlay trust read, 7 rule validation reads, and 6
        // bound reads (value, issuer, subject, scope, 2 key_actor).
        assert_eq!(jvc_state::setup_lookup_calls(), 18);
    }
    #[test]
    fn long_stored_key_overlay_and_rule_lookups_are_charged() {
        let (first, _word) = session();
        let actor = format!("ed25519:{}", "a".repeat(64));
        let prefix = "a".repeat(99_990);
        let mut rule = json!({
            "issuer": actor,
            "subject": actor,
            "value": "shun",
            "scope": {"kind": "definition", "word": "*", "language": "en"},
        });
        for n in 0..1000u32 {
            rule[format!("{prefix}:{n:04}")] = json!(n);
        }
        let mut overlay = json!({"trust": [rule]});
        for n in 0..1000u32 {
            overlay[format!("{prefix}:{n:04}")] = json!(n);
        }
        let session = restored_with(first, |saved| {
            saved["evaluation"]["overlay"] = overlay.clone();
            saved["options"]["overlay"] = overlay;
        });
        let mut policy = RankingPreparationPolicy {
            core_binding: format!("sha256:{}", "a".repeat(64)),
            limits: Default::default(),
        };
        policy.limits.setup_units = Some(13_500);
        let error = session.ranking_descriptor_native(&policy).unwrap_err();
        assert_eq!(error.code, "resource_unavailable");
        assert_eq!(error.message, "ranking setup envelope limit");
    }
    #[test]
    fn policy_field_lookups_are_charged_before_the_walks() {
        let (first, _word) = session();
        let session = restored_with(first, |saved| {
            let policy = saved["evaluation"]["policy"].as_object_mut().unwrap();
            for n in 0..1000u32 {
                policy.insert(format!("x{n}"), json!(n));
            }
        });
        let mut policy = RankingPreparationPolicy {
            core_binding: format!("sha256:{}", "a".repeat(64)),
            limits: Default::default(),
        };
        policy.limits.setup_units = Some(5_000);
        let error = session.ranking_descriptor_native(&policy).unwrap_err();
        assert_eq!(error.code, "resource_unavailable");
        assert_eq!(error.message, "ranking setup envelope limit");
    }
    #[test]
    fn reasons_lookup_is_charged_by_depth() {
        let (first, _word) = session();
        let prefix = "a".repeat(1000);
        let reasons: Vec<String> = (0..1000u32).map(|n| format!("{prefix}:{n:04}")).collect();
        let session = restored_with(first, |saved| {
            saved["evaluation"]["reasons"] = json!(reasons);
        });
        let mut policy = RankingPreparationPolicy {
            core_binding: format!("sha256:{}", "a".repeat(64)),
            limits: Default::default(),
        };
        policy.limits.setup_units = Some(1_000);
        let mut meter = policy.setup_meter(0, 0);
        let error = session
            .state
            .ranking_index_bound_metered(&mut |w, e, k, c| meter.charge(w, e, k, c))
            .unwrap_err();
        assert_eq!(error.code, "resource_unavailable");
        assert_eq!(error.message, "ranking setup envelope limit");
    }
    fn with_long_policy(session: EvaluationSession) -> EvaluationSession {
        restored_with(session, |saved| {
            let policy = saved["evaluation"]["policy"].as_object_mut().unwrap();
            for n in 0..1000u32 {
                policy.insert(format!("x{n}"), json!(n));
            }
        })
    }
    #[test]
    fn long_policy_classifies_available_unavailable_and_exact() {
        let mut quota = RankingPreparationPolicy {
            core_binding: format!("sha256:{}", "a".repeat(64)),
            limits: Default::default(),
        };
        quota.limits.setup_units = Some(1);
        // Available float at a one-unit quota refuses, and the refusal
        // is the last work done: no classification reads follow it.
        let (available_session, _word) = session();
        let available_session = with_long_policy(available_session);
        jvc_state::reset_setup_lookup_calls();
        let error = available_session
            .ranking_descriptor_native(&quota)
            .unwrap_err();
        assert_eq!(error.code, "resource_unavailable");
        assert_eq!(jvc_state::setup_lookup_calls(), 0);
        // Unavailable float returns its diagnostic descriptor at the
        // default and at an ordinary quota.
        let (unavailable_session, _word) = session();
        let unavailable_session = restored_with(unavailable_session, |saved| {
            saved["evaluation"]["available"] = json!(false);
            saved["evaluation"]["reasons"] = json!(["resource_unavailable"]);
            let policy = saved["evaluation"]["policy"].as_object_mut().unwrap();
            for n in 0..1000u32 {
                policy.insert(format!("x{n}"), json!(n));
            }
        });
        for policy in [
            RankingPreparationPolicy {
                core_binding: format!("sha256:{}", "a".repeat(64)),
                limits: Default::default(),
            },
            RankingPreparationPolicy {
                core_binding: format!("sha256:{}", "a".repeat(64)),
                limits: RankingPreparationLimits {
                    setup_units: Some(1_000_000),
                    ..Default::default()
                },
            },
        ] {
            let descriptor = unavailable_session
                .ranking_descriptor_native(&policy)
                .unwrap();
            assert!(!descriptor.available);
            assert_eq!(descriptor.setup.setup_records, 0);
        }
        // Exact profile returns its diagnostic descriptor at the
        // default and at an ordinary quota.
        let (exact_session, _word) = session();
        let exact_session = restored_with(exact_session, |saved| {
            saved["evaluation"]["policy"]["calculation"] = json!("simple-routes-bounds-v1");
            let policy = saved["evaluation"]["policy"].as_object_mut().unwrap();
            for n in 0..1000u32 {
                policy.insert(format!("x{n}"), json!(n));
            }
        });
        for policy in [
            RankingPreparationPolicy {
                core_binding: format!("sha256:{}", "a".repeat(64)),
                limits: Default::default(),
            },
            RankingPreparationPolicy {
                core_binding: format!("sha256:{}", "a".repeat(64)),
                limits: RankingPreparationLimits {
                    setup_units: Some(1_000_000),
                    ..Default::default()
                },
            },
        ] {
            let descriptor = exact_session.ranking_descriptor_native(&policy).unwrap();
            assert!(!descriptor.available);
            assert!(descriptor.reasons.contains("unsupported_calculation"));
            assert_eq!(descriptor.setup.setup_records, 0);
        }
    }
    #[test]
    fn long_reasons_clone_is_charged_before_cloning() {
        let (first, _word) = session();
        let prefix = "a".repeat(99_990);
        let reasons: Vec<String> = (0..1000u32).map(|n| format!("{prefix}:{n:04}")).collect();
        let session = restored_with(first, |saved| {
            saved["evaluation"]["reasons"] = json!(reasons);
        });
        let mut policy = RankingPreparationPolicy {
            core_binding: format!("sha256:{}", "a".repeat(64)),
            limits: Default::default(),
        };
        policy.limits.setup_units = Some(1);
        jvc_state::reset_setup_lookup_calls();
        let error = session.ranking_descriptor_native(&policy).unwrap_err();
        assert_eq!(error.code, "resource_unavailable");
        // The first charge refuses, so no lookup or clone follows it.
        assert_eq!(jvc_state::setup_lookup_calls(), 0);
    }
    #[test]
    fn long_calculation_is_charged_before_it_is_copied() {
        let (first, _word) = session();
        let session = restored_with(first, |saved| {
            saved["evaluation"]["policy"]["calculation"] = json!("a".repeat(100_000_000));
        });
        let mut policy = RankingPreparationPolicy {
            core_binding: format!("sha256:{}", "a".repeat(64)),
            limits: Default::default(),
        };
        policy.limits.setup_units = Some(1_000);
        jvc_state::reset_setup_lookup_calls();
        let error = session.ranking_descriptor_native(&policy).unwrap_err();
        assert_eq!(error.code, "resource_unavailable");
        // Only the charged calculation lookup ran. A copy before its
        // charge, or any classification reread, would add lookups.
        assert_eq!(jvc_state::setup_lookup_calls(), 1);
    }
    #[test]
    fn unavailable_parameter_refusal_reads_no_source_bytes() {
        let (first, _word) = session();
        let session = restored_with(first, |saved| {
            saved["evaluation"]["available"] = json!(false);
            saved["evaluation"]["reasons"] = json!([]);
            let policy = saved["evaluation"]["policy"].as_object_mut().unwrap();
            for n in 0..1000u32 {
                policy.insert(format!("x{n}"), json!(n));
            }
        });
        let mut policy = RankingPreparationPolicy {
            core_binding: format!("sha256:{}", "a".repeat(64)),
            limits: Default::default(),
        };
        // The view, clone, and work lookups spend just over this quota
        // during the parameter reads, before any source hash may run.
        policy.limits.setup_units = Some(1_500);
        let error = session.ranking_descriptor_native(&policy).unwrap_err();
        assert_eq!(error.code, "resource_unavailable");
        assert_eq!(error.message, "ranking setup envelope limit");
    }
    #[test]
    fn arena_strings_are_not_revalidated_during_setup() {
        let mut quota = RankingPreparationPolicy {
            core_binding: format!("sha256:{}", "a".repeat(64)),
            limits: Default::default(),
        };
        // A long calculation: its length charge refuses, and no arena
        // string bytes are validated on the way.
        let (first, _word) = session();
        let restored = restored_with(first, |saved| {
            saved["evaluation"]["policy"]["calculation"] = json!("a".repeat(10_000_000));
        });
        quota.limits.setup_units = Some(1_000);
        jvc_state::reset_validated_string_bytes();
        assert_eq!(
            restored.ranking_descriptor_native(&quota).unwrap_err().code,
            "resource_unavailable"
        );
        assert_eq!(jvc_state::validated_string_bytes(), 0);
        // Long policy keys: the calculation lookup's candidate keys are
        // borrowed without validation before the next lookup refuses.
        let (second, _word) = session();
        let restored = restored_with(second, |saved| {
            let policy = saved["evaluation"]["policy"].as_object_mut().unwrap();
            for n in 0..1000u32 {
                policy.insert(format!("{}-{n}", "a".repeat(10_000)), json!(n));
            }
        });
        quota.limits.setup_units = Some(1_500);
        jvc_state::reset_validated_string_bytes();
        assert_eq!(
            restored.ranking_descriptor_native(&quota).unwrap_err().code,
            "resource_unavailable"
        );
        assert_eq!(jvc_state::validated_string_bytes(), 0);
    }
    #[test]
    fn index_comparison_bytes_are_in_the_model_and_default() {
        let (first, _word) = session();
        let session = restored_with(first, |saved| {
            let publications = saved["evaluation"]["publications"].as_object().unwrap();
            let definition = publications
                .values()
                .find(|p| p["kind"] == "definition.publish")
                .unwrap()
                .clone();
            let publications = saved["evaluation"]["publications"].as_object_mut().unwrap();
            for n in 0..10_000u32 {
                let id = format!("jve1:{n:064x}");
                let mut publication = definition.clone();
                publication["id"] = json!(id);
                publication["word"] = json!(format!("{}:{n:06}", "x".repeat(4096)));
                publications.insert(id, publication);
            }
        });
        let policy = RankingPreparationPolicy {
            core_binding: format!("sha256:{}", "a".repeat(64)),
            limits: Default::default(),
        };
        let descriptor = session.ranking_descriptor_native(&policy).unwrap();
        assert!(descriptor.available, "{:?}", descriptor.reasons);
        // The word map alone reads at least 1,281,368,064 comparison
        // bytes for this shape; the modelled charge must cover it.
        assert!(descriptor.setup.setup_units > 1_281_368_064);
        let mut quota = policy;
        quota.limits.setup_units = Some(1_000_000_000);
        assert_eq!(
            session.ranking_descriptor_native(&quota).unwrap_err().code,
            "resource_unavailable"
        );
    }
    #[test]
    fn descriptor_with_12_5m_judgment_groups_passes_at_the_default() {
        let (first, _word) = session();
        let session = restored_with(first, |saved| {
            let mut text = String::with_capacity(160_000_000);
            text.push('{');
            for n in 0..12_500_001u32 {
                if n > 0 {
                    text.push(',');
                }
                text.push_str(&format!("\"k{n}\":{{}}"));
            }
            text.push('}');
            saved["evaluation"]["judgments"] = serde_json::from_str(&text).unwrap();
        });
        let mut policy = RankingPreparationPolicy {
            core_binding: format!("sha256:{}", "a".repeat(64)),
            limits: Default::default(),
        };
        // This test checks the unit budget, not the clock.
        policy.limits.source_millis = 120_000;
        let descriptor = session.ranking_descriptor_native(&policy).unwrap();
        assert!(descriptor.available, "{:?}", descriptor.reasons);
        assert!(descriptor.setup.setup_records >= 12_500_001);
    }
    #[test]
    fn private_scope_pack_and_serialize_are_charged_before_they_run() {
        let (first, _word) = session();
        let actor = format!("ed25519:{}", "a".repeat(64));
        let session = restored_with(first, |saved| {
            let overlay = json!({"trust":[{
                "issuer": actor,
                "subject": actor,
                "value": "heed",
                "weight": {"numerator": 1, "denominator": 1},
                "scope": {
                    "kind": "definition",
                    "word": "*",
                    "language": "en",
                    "extra": vec![0; 100_000],
                },
            }]});
            saved["evaluation"]["overlay"] = overlay.clone();
            saved["options"]["overlay"] = overlay;
        });
        let mut policy = RankingPreparationPolicy {
            core_binding: format!("sha256:{}", "a".repeat(64)),
            limits: Default::default(),
        };
        policy.limits.setup_units = Some(500_000);
        jvc_state::reset_packed_value_nodes();
        jvc_state::reset_serialized_value_bytes();
        let error = session.ranking_descriptor_native(&policy).unwrap_err();
        assert_eq!(error.code, "resource_unavailable");
        // The refusal lands on the pack charge, so construction never
        // packed the scope into an arena or serialized it.
        assert_eq!(jvc_state::packed_value_nodes(), 0);
        assert_eq!(jvc_state::serialized_value_bytes(), 0);
    }
    #[test]
    fn long_stored_key_rule_completes_at_an_ordinary_quota() {
        let (first, _word) = session();
        let actor = format!("ed25519:{}", "a".repeat(64));
        let prefix = "a".repeat(99_990);
        let mut rule = json!({
            "issuer": actor,
            "subject": actor,
            "value": "shun",
            "scope": {"kind": "definition", "word": "*", "language": "en"},
        });
        for n in 0..1000u32 {
            rule[format!("{prefix}:{n:04}")] = json!(n);
        }
        let mut overlay = json!({"trust": [rule]});
        for n in 0..1000u32 {
            overlay[format!("{prefix}:{n:04}")] = json!(n);
        }
        let session = restored_with(first, |saved| {
            saved["evaluation"]["overlay"] = overlay.clone();
            saved["options"]["overlay"] = overlay;
        });
        let mut policy = RankingPreparationPolicy {
            core_binding: format!("sha256:{}", "a".repeat(64)),
            limits: Default::default(),
        };
        policy.limits.setup_units = Some(200_000);
        let descriptor = session.ranking_descriptor_native(&policy).unwrap();
        assert!(descriptor.available, "{:?}", descriptor.reasons);
    }
    /// Every map or set read in the metered setup functions must be
    /// preceded, within twelve lines, by a charge for the same key.
    /// Reads that cannot take that form are listed here with a reason.
    #[test]
    fn setup_source_has_no_unmetered_map_reads() {
        let allow: &[(&str, &str)] = &[
            // overlay_rational is charged at its setup call sites
            // (weight, numerator, and denominator reads in
            // private_trust_metered); its other callers are per-word
            // context reads under the per-word charges.
            ("let n = v[\"numerator\"]", "charged at setup call sites"),
            ("let d = v[\"denominator\"]", "charged at setup call sites"),
        ];
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let files: Vec<(std::path::PathBuf, &[&str])> = vec![
            (
                root.join("../jvc-state/src/policy.rs"),
                &[
                    "fn charge_lookup",
                    "fn scope_measure",
                    "fn value_strings_metered",
                    "fn overlay_rational",
                    "fn private_trust_metered",
                    "fn new_metered",
                    "fn index_private_rules_metered",
                    "fn ranking_index_bound_metered",
                ],
            ),
            (
                root.join("../jvc-state/src/incremental.rs"),
                &[
                    "fn ranking_source_records_metered",
                    "fn ranking_index_bound_metered",
                    "fn ensure_ranking_index_metered",
                ],
            ),
            (
                root.join("src/ranking_preparation.rs"),
                &["fn parameter(", "fn parameters(", "fn new(session"],
            ),
        ];
        let read_key = |line: &str| -> Option<String> {
            for open in ["[\"", ".get(\"", ".contains(\"", ".index(\""] {
                if let Some(at) = line.find(open) {
                    let rest = &line[at + open.len()..];
                    return rest.find('"').map(|end| rest[..end].to_string());
                }
            }
            for open in [".get(", ".contains("] {
                if let Some(at) = line.find(open) {
                    let rest = &line[at + open.len()..];
                    let ident: String = rest
                        .chars()
                        .take_while(|c| c.is_alphanumeric() || *c == '_')
                        .collect();
                    if !ident.is_empty() {
                        return Some(ident);
                    }
                }
            }
            None
        };
        let mut failures = Vec::new();
        for (path, functions) in &files {
            let text = std::fs::read_to_string(path).unwrap();
            for name in *functions {
                let mut regions = Vec::new();
                let mut rest = text.as_str();
                // "fn new_metered" names two construction functions;
                // every other name names one.
                let limit = if *name == "fn new_metered" { 2 } else { 1 };
                while regions.len() < limit {
                    let Some(region) = extract_fn(rest, name) else {
                        break;
                    };
                    let offset = rest.find(name).unwrap() + region.len();
                    regions.push(region);
                    rest = &rest[offset.min(rest.len())..];
                }
                if regions.is_empty() {
                    failures.push(format!("{}: missing function {name}", path.display()));
                    continue;
                }
                for region in regions {
                    let lines: Vec<&str> = region.lines().collect();
                    for (index, line) in lines.iter().enumerate() {
                        let trimmed = line.trim();
                        if trimmed.starts_with("//") {
                            continue;
                        }
                        let is_read = !trimmed.contains("in [\"")
                            && (trimmed.contains("[\"")
                                || trimmed.contains(".get(")
                                || trimmed.contains(".contains(")
                                || trimmed.contains(".index("));
                        if !is_read || trimmed.contains("get_metered") {
                            continue;
                        }
                        if allow.iter().any(|(part, _)| trimmed.contains(part)) {
                            continue;
                        }
                        let Some(key) = read_key(trimmed) else {
                            continue;
                        };
                        let charged = lines[index.saturating_sub(12)..index].iter().any(|prior| {
                            (prior.contains("charge_lookup")
                                || prior.contains("lookup_work")
                                || prior.contains("get_metered"))
                                && prior.contains(&key)
                        });
                        if !charged {
                            failures.push(format!("{} in {name}: {trimmed}", path.display()));
                        }
                    }
                }
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }
    fn extract_fn<'a>(text: &'a str, name: &str) -> Option<&'a str> {
        let start = text.find(name)?;
        let body = start + text[start..].find('{')?;
        let mut depth = 0i32;
        for (offset, ch) in text[body..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(&text[start..body + offset + 1]);
                    }
                }
                _ => {}
            }
        }
        None
    }
    #[test]
    fn unavailable_float_skips_the_records_walk() {
        let (first, _word) = session();
        let groups: serde_json::Map<String, Value> = (0..100u32)
            .map(|n| (format!("jve1:{n:064x}"), json!({"a": "bless"})))
            .collect();
        let session = restored_with(first, |saved| {
            saved["evaluation"]["judgments"] = Value::Object(groups);
            saved["evaluation"]["available"] = json!(false);
            saved["evaluation"]["reasons"] = json!(["resource_unavailable"]);
        });
        // No setup walk runs on this path: the descriptor reports zero
        // setup counts.
        let policy = RankingPreparationPolicy {
            core_binding: format!("sha256:{}", "a".repeat(64)),
            limits: Default::default(),
        };
        let descriptor = session.ranking_descriptor_native(&policy).unwrap();
        assert!(!descriptor.available);
        assert_eq!(descriptor.setup.setup_records, 0);
        assert_eq!(descriptor.setup.setup_units, 0);
        assert_eq!(descriptor.setup.setup_bytes, 0);
    }
    #[test]
    fn scaled_default_covers_uniform_growth_and_widest_bit_length() {
        let base = jvc_state::RankingIndexCounts {
            words: 89687,
            word_publications: 89687,
            target_groups: 89687,
            targets: 93806,
            judgment_groups: 89687,
            key_bytes: 33432924,
            ..Default::default()
        };
        let p = RankingPreparationPolicy {
            core_binding: format!("sha256:{}", "a".repeat(64)),
            limits: Default::default(),
        };
        for scale in [64u64, 1024] {
            let mut c = base.clone();
            c.words *= scale;
            c.word_publications *= scale;
            c.target_groups *= scale;
            c.targets *= scale;
            c.judgment_groups *= scale;
            c.key_bytes *= scale;
            let (bytes, units) = p.setup_estimate(&c).unwrap();
            let _ = bytes;
            let entries = 452_554 * scale;
            let budget = p
                .effective_setup_units(entries, base.key_bytes * scale)
                .unwrap();
            assert!(budget - units >= SETUP_UNITS_FIXED_ALLOWANCE, "{scale}");
        }
        // At bit length 64 the charge per entry is 16 * 64 + 16 = 1040 and
        // per key byte 6, exactly the default allowances, so the margin is
        // the fixed allowance at any key-byte count. Counts that wide
        // overflow the checked u64 arithmetic in `setup_estimate` itself,
        // so this part checks the formula in u128.
        for (entries, key_bytes) in [(1u128 << 62, 0u128), (1u128 << 62, 1u128 << 60)] {
            let budget = SETUP_UNITS_FIXED_ALLOWANCE as u128 + 1040 * entries + 6 * key_bytes;
            let charge = 1040 * entries + 6 * key_bytes;
            assert_eq!(budget - charge, SETUP_UNITS_FIXED_ALLOWANCE as u128);
        }
        // A representable wide shape through the real estimate.
        let wide = jvc_state::RankingIndexCounts {
            words: 1 << 40,
            key_bytes: 1 << 40,
            ..Default::default()
        };
        let (_, units) = p.setup_estimate(&wide).unwrap();
        assert!(
            p.effective_setup_units(1 << 40, 1 << 40).unwrap() - units
                >= SETUP_UNITS_FIXED_ALLOWANCE
        );
    }
    #[test]
    fn source_budgets_have_independent_hard_ceilings() {
        let mut p = RankingPreparationPolicy {
            core_binding: format!("sha256:{}", "a".repeat(64)),
            limits: Default::default(),
        };
        p.limits.source_bytes = Some(1024 * 1024 * 1024 * 4);
        p.limits.source_millis = 120_000;
        p.validate().unwrap();
        p.limits.source_millis += 1;
        assert_eq!(p.validate().unwrap_err().code, "ranking_policy");
        p.limits.source_millis = 0;
        assert_eq!(p.validate().unwrap_err().code, "ranking_policy");
        p.limits.source_millis = 1;
        p.limits.source_bytes = Some(0);
        assert_eq!(p.validate().unwrap_err().code, "ranking_policy");
    }
    #[test]
    fn fixed_roots_cover_the_one_rafsi_shape_and_skip_empty_indexes() {
        let p = RankingPreparationPolicy {
            core_binding: format!("sha256:{}", "a".repeat(64)),
            limits: Default::default(),
        };
        assert_eq!(p.setup_estimate(&Default::default()).unwrap(), (0, 0));
        let c = jvc_state::RankingIndexCounts {
            words: 1,
            word_publications: 1,
            target_groups: 1,
            targets: 2,
            judgment_groups: 1,
            key_bytes: 434,
            ..Default::default()
        };
        assert_eq!(p.setup_estimate(&c).unwrap(), (12_772, 17_310));
    }
    #[test]
    fn setup_units_do_not_spend_the_context_allowance() {
        let (session, word) = session();
        let mut policy = RankingPreparationPolicy {
            core_binding: format!("sha256:{}", "a".repeat(64)),
            limits: Default::default(),
        };
        let descriptor = session.ranking_descriptor_native(&policy).unwrap();
        assert!(descriptor.setup.setup_units > 0);
        assert_eq!(descriptor.setup.charged_units, 0);
        let request = RankingPreparationRequest {
            owner_session: descriptor.owner_session,
            descriptor_binding: descriptor.binding,
            word,
        };
        let summary = session.prepare_ranking_native(&request).unwrap();
        assert!(summary.usage.charged_units > 0);
        assert_eq!(summary.usage.setup_units, descriptor.setup.setup_units);
        policy.limits.units = summary.usage.charged_units;
        let d = session.ranking_descriptor_native(&policy).unwrap();
        let mut request = request;
        request.descriptor_binding = d.binding;
        assert!(session.prepare_ranking_native(&request).is_ok());
        policy.limits.units -= 1;
        request.descriptor_binding = session.ranking_descriptor_native(&policy).unwrap().binding;
        assert_eq!(
            session.prepare_ranking_native(&request).unwrap_err().code,
            "resource_unavailable"
        );
        policy.limits.setup_units = Some(0);
        assert_eq!(policy.validate().unwrap_err().code, "ranking_policy");
        policy.limits.setup_units = Some(4_000_000_001);
        policy.validate().unwrap();
    }
}
