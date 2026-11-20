use super::*;
use num_bigint::BigInt;
use num_traits::{One, Zero};

const MAX_CONTEXT_REFUSALS: usize = 100_000;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Context {
    pub kind: String,
    pub word: String,
    pub language: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PositiveEdge<T = Rational> {
    pub to: usize,
    pub share: T,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContextGraph<T = Rational> {
    pub calculation: String,
    pub actors: Vec<String>,
    /// An unavailable float graph can leave all roots unset.
    pub roots: Vec<T>,
    pub rows: Vec<Vec<PositiveEdge<T>>>,
    /// Each target lists the resolved actors who effectively shun it.
    /// The old profile uses an empty relation.
    pub refusals: Vec<Vec<usize>>,
    pub blocked: BTreeSet<usize>,
    pub public_shun_blocked: BTreeSet<usize>,
    pub private_blocked: BTreeSet<usize>,
    pub judgments: BTreeMap<String, BTreeMap<String, Judgment>>,
    pub available: bool,
    pub reasons: BTreeSet<String>,
}
#[derive(Default)]
pub(crate) struct ResolvedSelections<'a> {
    pub allowance: usize,
    pub valid: BTreeMap<String, &'a Vec<String>>,
    pub invalid: BTreeSet<String>,
}

pub(crate) fn resolve_referenced_selections<'a>(
    input: &'a EvaluationOptions,
    nodes: &BTreeMap<String, graph::Node>,
) -> ResolvedSelections<'a> {
    let mut cache = BTreeMap::new();
    resolve_referenced_selections_cached(input, &input.import_selections, nodes, &mut cache)
}

pub(crate) fn resolve_referenced_selections_cached<'a>(
    input: &EvaluationOptions,
    import_selections: &'a BTreeMap<String, Vec<String>>,
    nodes: &BTreeMap<String, graph::Node>,
    cache: &mut BTreeMap<String, bool>,
) -> ResolvedSelections<'a> {
    let mut resolved = ResolvedSelections {
        allowance: 0,
        valid: BTreeMap::new(),
        invalid: BTreeSet::new(),
    };
    if input.limits.traversal.is_some() {
        return resolved;
    }
    let Some(node) = nodes.get(&input.selected_view) else {
        return resolved;
    };
    if !node.semantic || node.kind != "view.publish" {
        return resolved;
    }
    let Some(body) = node.body.as_ref() else {
        return resolved;
    };
    // The default budget without the selection term.
    let base = DEFAULT_TRAVERSAL_BASE;
    #[cfg(test)]
    let base = RESOLVER_BASE_OVERRIDE.with(|o| o.get()).unwrap_or(base);
    let base_budget = default_input_budget(base, nodes.len(), predecessor_edges(nodes));
    let mut invalid_work = 0usize;
    for entry in body
        .view()
        .index("import_sets")
        .as_array()
        .into_iter()
        .flatten()
    {
        invalid_work = invalid_work.saturating_add(1);
        if invalid_work > base_budget {
            break;
        }
        let selection_field = entry.index("selection");
        let Some(selection_id) = selection_field.as_str() else {
            continue;
        };
        if resolved.valid.contains_key(selection_id) || resolved.invalid.contains(selection_id) {
            continue;
        }
        let Some(ids) = import_selections.get(selection_id) else {
            resolved.invalid.insert(selection_id.to_owned());
            continue;
        };
        // Validity decides the budget: a valid selection adds its length
        // to the default budget, so the resolver cannot stop on a length
        // before it knows the verdict (a cached verdict would then change
        // the result). Validation reads at most one selection's 16 MiB
        // limit; an invalid selection's length counts against the base
        // budget after it, and the walk stops once that is used up.
        match valid_selection_cached(import_selections, selection_id, cache) {
            Some(valid_ids) => {
                resolved.allowance = resolved.allowance.saturating_add(valid_ids.len());
                resolved.valid.insert(selection_id.to_owned(), valid_ids);
            }
            None => {
                resolved.invalid.insert(selection_id.to_owned());
                invalid_work = invalid_work.saturating_add(ids.len());
                if invalid_work > base_budget {
                    break;
                }
            }
        }
    }
    resolved
}

pub(crate) fn select(
    graph: &graph::Graph,
    input: &EvaluationOptions,
    import_selections: &BTreeMap<String, Vec<String>>,
    resolved: &ResolvedSelections<'_>,
    cache: &mut BTreeMap<String, bool>,
    result: &mut Evaluation,
) {
    let mut todo = vec![input.selected_view.clone()];
    let mut seen = BTreeSet::new();
    while let Some(id) = todo.pop() {
        if input
            .limits
            .traversal
            .is_some_and(|limit| seen.len() >= limit)
            || !graph.charge(1)
        {
            result.available = false;
            result.reasons.insert("resource_unavailable".into());
            break;
        }
        if !seen.insert(id.clone()) {
            continue;
        }
        let Some(n) = graph.nodes.get(&id) else {
            if id == input.selected_view {
                result.available = false;
            }
            result.reasons.insert(
                if id == input.selected_view {
                    "view_unavailable"
                } else {
                    "policy_ancestry_unavailable"
                }
                .into(),
            );
            continue;
        };
        if !n.semantic || n.kind != "view.publish" || n.body.is_none() {
            if id == input.selected_view {
                result.available = false;
            }
            result.reasons.insert(
                if id == input.selected_view {
                    "view_unavailable"
                } else {
                    "policy_ancestry_unavailable"
                }
                .into(),
            );
            continue;
        }
        let body = n.body.as_ref().unwrap();
        if id == input.selected_view {
            result.policy = Some(body.clone());
        }
        result.policies.push(body.clone());
        result.policy_history.insert(id.clone(), body.clone());
        // Charge the parent count before the IDs are read.
        let parent_count = n
            .action
            .view()
            .index("parents")
            .as_array()
            .map_or(0, |parents| parents.len());
        if parent_count > 0 && !graph.charge(parent_count) {
            result.available = false;
            result.reasons.insert("resource_unavailable".into());
            break;
        }
        let parents = n
            .action
            .view()
            .index("parents")
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect::<Vec<_>>();
        todo.extend(parents);
        if id == input.selected_view {
            let mut invalid_selections = resolved.invalid.clone();
            // A selection that several entries name is read, and
            // charged, once.
            let mut charged_selections: BTreeSet<&str> = BTreeSet::new();
            for entry in body
                .view()
                .index("import_sets")
                .as_array()
                .into_iter()
                .flatten()
            {
                if input
                    .limits
                    .traversal
                    .is_some_and(|limit| seen.len() >= limit)
                    || !graph.charge(1)
                {
                    result.available = false;
                    result.reasons.insert("resource_unavailable".into());
                    return;
                }
                let selection_field = entry.index("selection");
                let Some(selection_id) = selection_field.as_str() else {
                    result.reasons.insert("import_selection_unavailable".into());
                    continue;
                };
                if let Some((selection_id, ids)) = import_selections.get_key_value(selection_id)
                    && !ids.is_empty()
                    && charged_selections.insert(selection_id.as_str())
                    && !graph.charge(ids.len())
                {
                    result.available = false;
                    result.reasons.insert("resource_unavailable".into());
                    return;
                }
                if result.selections.contains_key(selection_id) {
                    continue;
                }
                if invalid_selections.contains(selection_id) {
                    result.reasons.insert("import_selection_unavailable".into());
                    continue;
                }
                let valid_ids = resolved
                    .valid
                    .get(selection_id)
                    .copied()
                    .or_else(|| valid_selection_cached(import_selections, selection_id, cache));
                match valid_ids {
                    None => {
                        invalid_selections.insert(selection_id.to_owned());
                        result.reasons.insert("import_selection_unavailable".into());
                    }
                    Some(ids) => {
                        result
                            .selections
                            .insert(selection_id.into(), ids.iter().cloned().collect());
                        if ids.iter().any(|id| !graph.nodes.contains_key(id)) {
                            result
                                .reasons
                                .insert("selection_publications_pending".into());
                        }
                    }
                }
            }
        }
    }
}
fn rational(v: ValueView) -> Option<Rational> {
    let n = v.index("numerator").as_i64()?;
    let d = v.index("denominator").as_u64()?;
    if d == 0 {
        return None;
    }
    Some(Rational::new(BigInt::from(n), BigInt::from(d)))
}
fn overlay_rational(v: &Value) -> Option<Rational> {
    let n = v["numerator"].as_i64()?;
    let d = v["denominator"].as_u64()?;
    if d == 0 {
        return None;
    }
    Some(Rational::new(BigInt::from(n), BigInt::from(d)))
}
fn matches_parts(kind: &str, word: &str, language: &str, context: &Context) -> bool {
    (kind == "*" || kind == context.kind)
        && (word == "*" || word == context.word)
        && match &context.language {
            Some(l) => language == "*" || language == l,
            None => language == "*",
        }
}
fn matches(scope: ValueView, context: &Context) -> bool {
    matches_parts(
        scope.index("kind").as_str().unwrap_or_default(),
        scope.index("word").as_str().unwrap_or_default(),
        scope.index("language").as_str().unwrap_or_default(),
        context,
    )
}
fn overlay_matches(scope: &Value, context: &Context) -> bool {
    matches_parts(
        scope["kind"].as_str().unwrap_or_default(),
        scope["word"].as_str().unwrap_or_default(),
        scope["language"].as_str().unwrap_or_default(),
        context,
    )
}
fn dimensions(scope: ValueView) -> [String; 3] {
    let mut kind = scope.index("kind").as_str().unwrap_or_default().to_owned();
    let language = scope
        .index("language")
        .as_str()
        .unwrap_or_default()
        .to_owned();
    if kind == "*" && language != "*" {
        kind = "definition".into();
    }
    [
        kind,
        scope.index("word").as_str().unwrap_or_default().into(),
        language,
    ]
}
fn narrower(a: ValueView, b: ValueView) -> bool {
    let a = dimensions(a);
    let b = dimensions(b);
    a != b && a.iter().zip(b.iter()).all(|(a, b)| a == b || b == "*")
}
fn scoped_pairs<'a>(
    trust: impl IntoIterator<Item = &'a TrustRule>,
    context: &Context,
    issuer: Option<&str>,
) -> BTreeMap<(String, String), Vec<&'a TrustRule>> {
    let mut pairs: BTreeMap<_, Vec<_>> = BTreeMap::new();
    for rule in trust {
        if issuer.is_some_and(|actor| actor != rule.actor)
            || rule.actor == rule.subject
            || !matches(rule.scope.view(), context)
            || rule.values.iter().all(|value| value == "clear")
        {
            continue;
        }
        pairs
            .entry((rule.actor.clone(), rule.subject.clone()))
            .or_default()
            .push(rule);
    }
    pairs
}
fn retained_rules<'a>(rules: &[&'a TrustRule]) -> Vec<&'a TrustRule> {
    rules
        .iter()
        .copied()
        .filter(|rule| {
            !rules
                .iter()
                .any(|other| narrower(other.scope.view(), rule.scope.view()))
        })
        .collect()
}
// Borrow target IDs for one context. Publication state does not filter membership.
fn context_target_ids<'a>(
    publications: impl Iterator<Item = &'a Publication>,
    context: &Context,
) -> BTreeSet<&'a str> {
    let mut targets = BTreeSet::new();
    for publication in publications {
        if publication.word == context.word
            && if context.kind == "definition" {
                publication.kind == "definition.publish" && publication.language == context.language
            } else {
                publication.kind == "rafsi.publish"
            }
        {
            targets.insert(publication.id.as_str());
            if let Some(assignment) = &publication.assignment {
                targets.insert(assignment.as_str());
            }
        }
    }
    targets
}
fn judgments_for_targets<'a>(
    targets: impl Iterator<Item = &'a str>,
    judgments: &BTreeMap<String, BTreeMap<String, Judgment>>,
) -> BTreeMap<String, BTreeMap<String, Judgment>> {
    targets
        .filter_map(|target| {
            judgments
                .get(target)
                .map(|values| (target.to_owned(), values.clone()))
        })
        .collect()
}

/// Construct the positive graph for one exact comparison context.
/// Blocked destinations lose their original shares after row normalization.
pub fn evaluate_context(evaluation: &Evaluation, context: &Context) -> ContextGraph {
    evaluate_context_with_limit(evaluation, context, MAX_CONTEXT_REFUSALS)
}

/// Prepare float rows only. This operation does not rank the context.
/// When `available` is false, `roots` can be empty despite nonempty `actors`.
/// Consumers must require `available` before they use roots or rows for ranking.
pub fn prepare_approximate_context(
    evaluation: &Evaluation,
    context: &Context,
) -> ContextGraph<f64> {
    resolve_context::<FloatRows>(evaluation, context, MAX_CONTEXT_REFUSALS)
}

trait RowArithmetic {
    type Value: Clone;
    fn root(value: &Rational) -> Result<Self::Value, &'static str>;
    fn row(
        weights: &BTreeMap<String, Rational>,
        blocked: &BTreeSet<String>,
    ) -> Result<BTreeMap<String, Self::Value>, &'static str>;
    fn supports(calculation: &str) -> bool;
}
struct ExactRows;
impl RowArithmetic for ExactRows {
    type Value = Rational;
    fn root(value: &Rational) -> Result<Rational, &'static str> {
        Ok(value.clone())
    }
    fn row(
        weights: &BTreeMap<String, Rational>,
        blocked: &BTreeSet<String>,
    ) -> Result<BTreeMap<String, Rational>, &'static str> {
        let sum = weights.values().fold(Rational::zero(), |a, b| a + b);
        let divisor = std::cmp::max(sum, Rational::one());
        Ok(weights
            .iter()
            .filter(|(id, _)| !blocked.contains(*id))
            .map(|(id, weight)| (id.clone(), weight / &divisor))
            .collect())
    }
    fn supports(calculation: &str) -> bool {
        calculation != jvc_rank::approximate::ALGORITHM
    }
}
struct FloatRows;
impl RowArithmetic for FloatRows {
    type Value = f64;
    fn root(value: &Rational) -> Result<f64, &'static str> {
        jvc_rank::approximate::input(value, true).map_err(|_| "numeric_unavailable")
    }
    fn row(
        weights: &BTreeMap<String, Rational>,
        blocked: &BTreeSet<String>,
    ) -> Result<BTreeMap<String, f64>, &'static str> {
        jvc_rank::approximate::normalize_row(weights, blocked).map_err(|error| match error {
            jvc_rank::approximate::PreparationError::NumericUnavailable => "numeric_unavailable",
            jvc_rank::approximate::PreparationError::Graph(jvc_rank::RankError::ResourceLimit(
                _,
            )) => "resource_unavailable",
            jvc_rank::approximate::PreparationError::Graph(_) => "invalid_graph",
        })
    }
    fn supports(calculation: &str) -> bool {
        calculation == jvc_rank::approximate::ALGORITHM
    }
}
fn prepare_roots<A: RowArithmetic>(
    roots: impl IntoIterator<Item = Rational>,
) -> Result<Vec<A::Value>, &'static str> {
    roots.into_iter().map(|root| A::root(&root)).collect()
}

fn evaluate_context_with_limit(
    evaluation: &Evaluation,
    context: &Context,
    max_refusals: usize,
) -> ContextGraph {
    resolve_context::<ExactRows>(evaluation, context, max_refusals)
}
type PrivateWeights = BTreeMap<(String, String), Vec<(CompactValue, Rational)>>;
fn private_trust(evaluation: &Evaluation) -> (Vec<TrustRule>, PrivateWeights) {
    private_trust_metered(evaluation, &mut |_, _, _, _| Ok(())).unwrap()
}

fn private_trust_metered(
    evaluation: &Evaluation,
    meter: &mut SetupMeter<'_>,
) -> jvc_core::Result<(Vec<TrustRule>, PrivateWeights)> {
    let resolve = |meter: &mut SetupMeter<'_>, key: &str| -> jvc_core::Result<String> {
        charge_lookup(meter, evaluation.lifecycle.key_actor.len(), key)?;
        let resolved = evaluation
            .lifecycle
            .key_actor
            .get(key)
            .map_or(key, String::as_str);
        meter(resolved.len() as u64, 0, 0, 0)?;
        Ok(resolved.to_owned())
    };
    // Charge the capacity allocation before it runs: the vector
    // holds one `TrustRule` per restored rule.
    meter(
        (evaluation.trust.len() as u64).saturating_mul(std::mem::size_of::<TrustRule>() as u64),
        0,
        0,
        0,
    )?;
    let mut trust = Vec::with_capacity(evaluation.trust.len());
    for rule in &evaluation.trust {
        meter(16 + (rule.actor.len() + rule.subject.len()) as u64, 0, 0, 0)?;
        let mut iter = rule.values.iter();
        loop {
            meter(4, 0, 0, 0)?;
            let Some(value) = iter.next() else { break };
            meter(value.len() as u64, 0, 0, 0)?;
        }
        trust.push(rule.clone());
    }
    let mut private_weights_by_pair: PrivateWeights = BTreeMap::new();
    charge_lookup(meter, evaluation.reasons.len(), "invalid_overlay")?;
    if !evaluation.reasons.contains("invalid_overlay") {
        if let Some(overlay) = &evaluation.overlay {
            charge_lookup(meter, overlay.as_object().map_or(0, |o| o.len()), "trust")?;
            let mut private: BTreeMap<(String, String, String), (CompactValue, BTreeSet<String>)> =
                BTreeMap::new();
            let mut scope_arena = None;
            for rule in overlay["trust"].as_array().into_iter().flatten() {
                let obj_len = rule.as_object().map_or(0, |o| o.len());
                charge_lookup(meter, obj_len, "issuer")?;
                let issuer = resolve(meter, rule["issuer"].as_str().unwrap())?;
                charge_lookup(meter, obj_len, "subject")?;
                let subject = resolve(meter, rule["subject"].as_str().unwrap())?;
                charge_lookup(meter, obj_len, "scope")?;
                let scope_value = &rule["scope"];
                let (raw, scope_bytes) = scope_measure(scope_value, meter)?;
                // Pack and intern repeat this walk; charge their bound
                // from the counts just measured, before packing.
                meter(4 * (raw + scope_bytes), 0, 0, 0)?;
                let scope = CompactValue::from_arena(
                    scope_arena
                        .get_or_insert_with(|| {
                            std::rc::Rc::new(std::cell::RefCell::new(arena::RecordArena::default()))
                        })
                        .clone(),
                    scope_value,
                );
                charge_lookup(meter, obj_len, "value")?;
                let value = rule["value"].as_str().unwrap();
                if value == "heed" {
                    charge_lookup(meter, obj_len, "weight")?;
                    let weight = &rule["weight"];
                    let weight_len = weight.as_object().map_or(0, |o| o.len());
                    charge_lookup(meter, weight_len, "numerator")?;
                    charge_lookup(meter, weight_len, "denominator")?;
                    meter(
                        super::arena::lookup_work(
                            private_weights_by_pair.len() as u64,
                            (issuer.len() + subject.len()) as u64,
                        ),
                        0,
                        0,
                        0,
                    )?;
                    private_weights_by_pair
                        .entry((issuer.clone(), subject.clone()))
                        .or_default()
                        .push((
                            scope.clone(),
                            overlay_rational(weight).unwrap_or_else(Rational::one),
                        ));
                }
                meter(json_text_bound(raw, scope_bytes), 0, 0, 0)?;
                let scope_text = scope_value.to_string();
                meter(
                    super::arena::lookup_work(
                        private.len() as u64,
                        (issuer.len() + subject.len() + scope_text.len()) as u64,
                    ),
                    0,
                    0,
                    0,
                )?;
                let entry = private
                    .entry((issuer, subject, scope_text))
                    .or_insert_with(|| (scope, BTreeSet::new()));
                meter(
                    super::arena::lookup_work(entry.1.len() as u64, value.len() as u64),
                    0,
                    0,
                    0,
                )?;
                entry.1.insert(value.into());
            }
            // Remove replaced public registers once before adding private registers.
            let retained = std::mem::take(&mut trust);
            for rule in retained {
                let mut raw = 0u64;
                let scope_bytes = rule.scope.view().string_bytes_metered(&mut |steps| {
                    raw += steps;
                    meter(4 * steps, 0, 0, 0)
                })?;
                meter(json_text_bound(raw, scope_bytes), 0, 0, 0)?;
                let scope_text = rule.scope.to_string();
                meter(
                    super::arena::lookup_work(
                        private.len() as u64,
                        (rule.actor.len() + rule.subject.len() + scope_text.len()) as u64,
                    ),
                    0,
                    0,
                    0,
                )?;
                if !private.contains_key(&(rule.actor.clone(), rule.subject.clone(), scope_text)) {
                    trust.push(rule);
                }
            }
            for ((issuer, subject, _), (scope, values)) in private {
                meter(
                    super::arena::lookup_work(values.len() as u64, "clear".len() as u64),
                    0,
                    0,
                    0,
                )?;
                if values.len() != 1 || !values.contains("clear") {
                    trust.push(TrustRule {
                        actor: issuer,
                        subject,
                        scope,
                        values,
                    });
                }
            }
        }
    }
    Ok((trust, private_weights_by_pair))
}

type ScopeKey = (String, String, String);
#[derive(Clone, Default)]
struct RuleBucket {
    ids: Vec<usize>,
    pairs_squared: u64,
}
#[derive(Clone, Default)]
struct ScopedRuleIndex(BTreeMap<ScopeKey, RuleBucket>);
fn count_overflow() -> jvc_core::Error {
    jvc_core::Error::new("resource_unavailable", "preparation count overflow")
}
impl ScopedRuleIndex {
    fn new_metered(
        trust: &[TrustRule],
        weights: Option<&PrivateWeights>,
        meter: &mut SetupMeter<'_>,
    ) -> jvc_core::Result<Self> {
        let mut result = Self::default();
        for (id, rule) in trust.iter().enumerate() {
            let view = rule.scope.view();
            let mut key = (String::new(), String::new(), String::new());
            for (slot, field) in [
                (&mut key.0, "kind"),
                (&mut key.1, "word"),
                (&mut key.2, "language"),
            ] {
                let value = view.get_metered(field, &mut |w| meter(w, 0, 0, 0))?;
                if let Some(text) = value.as_ref().and_then(|v| v.as_str()) {
                    meter(text.len() as u64, 0, 0, 0)?;
                    *slot = text.to_owned();
                }
            }
            meter(
                super::arena::lookup_work(
                    result.0.len() as u64,
                    (key.0.len() + key.1.len() + key.2.len()) as u64,
                ),
                0,
                0,
                0,
            )?;
            result.0.entry(key).or_default().ids.push(id);
        }
        for bucket in result.0.values_mut() {
            let mut pairs: BTreeMap<(&str, &str), u64> = BTreeMap::new();
            for id in &bucket.ids {
                let rule = &trust[*id];
                meter(
                    super::arena::lookup_work(
                        pairs.len() as u64,
                        (rule.actor.len() + rule.subject.len()) as u64,
                    ),
                    0,
                    0,
                    0,
                )?;
                *pairs.entry((&rule.actor, &rule.subject)).or_default() += 1;
            }
            for ((actor, subject), count) in pairs {
                // The resolver checks every private weight for a matching pair.
                if let Some(w) = &weights {
                    meter(
                        super::arena::lookup_work(
                            w.len() as u64,
                            (actor.len() + subject.len()) as u64,
                        ),
                        0,
                        0,
                        0,
                    )?;
                }
                let private = weights
                    .and_then(|w| w.get(&(actor.into(), subject.into())))
                    .map_or(0, Vec::len) as u64;
                let count = count.checked_add(private).ok_or_else(count_overflow)?;
                bucket.pairs_squared = bucket
                    .pairs_squared
                    .checked_add(count.checked_mul(count).ok_or_else(count_overflow)?)
                    .ok_or_else(count_overflow)?;
            }
        }
        Ok(result)
    }
    fn matching(&self, context: &Context) -> Vec<&RuleBucket> {
        let mut keys = BTreeSet::new();
        for kind in ["*", &context.kind] {
            for word in ["*", &context.word] {
                for language in ["*", context.language.as_deref().unwrap_or("*")] {
                    keys.insert((kind.into(), word.into(), language.into()));
                }
            }
        }
        keys.into_iter()
            .filter_map(|key| self.0.get(&key))
            .collect()
    }
    fn counts(&self, context: &Context) -> jvc_core::Result<(u64, u64)> {
        let buckets = self.matching(context);
        let count = buckets.iter().map(|b| b.ids.len() as u64).sum();
        let squares = buckets.iter().try_fold(0u64, |a, b| {
            a.checked_add(b.pairs_squared).ok_or_else(count_overflow)
        })?;
        // At most eight scope buckets match. Cauchy's inequality bounds each
        // combined pair square by the bucket count times the sum of squares.
        Ok((
            count,
            squares
                .checked_mul(buckets.len() as u64)
                .ok_or_else(count_overflow)?,
        ))
    }
    fn rules<'a>(&self, trust: &'a [TrustRule], context: &Context) -> Vec<&'a TrustRule> {
        let mut ids: Vec<_> = self
            .matching(context)
            .iter()
            .flat_map(|b| b.ids.iter().copied())
            .collect();
        ids.sort_unstable();
        ids.into_iter().map(|id| &trust[id]).collect()
    }
}

/// Index entries and copied string bytes. Bounds need no index allocation.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct RankingIndexCounts {
    pub words: u64,
    pub word_publications: u64,
    pub target_groups: u64,
    pub targets: u64,
    pub judgment_groups: u64,
    pub trust_rules: u64,
    pub scope_buckets: u64,
    pub scope_rules: u64,
    pub private_pairs: u64,
    pub private_weights: u64,
    pub private_rules: u64,
    pub key_bytes: u64,
}
/// A setup-work meter. Each call charges, before the work it covers:
/// work steps, the index entries that work builds toward, and the copied
/// key bytes it reads. Entry and key totals only grow during a walk, so a
/// budget derived from them is a lower bound on the final budget.
/// A setup-work meter. Each call charges, before the work it covers:
/// work steps, the index entries that work builds toward, the copied
/// key bytes it reads, and walk items that credit their own allowance
/// without being index entries.
pub type SetupMeter<'a> = dyn FnMut(u64, u64, u64, u64) -> jvc_core::Result<()> + 'a;

/// Walk a serde scope once, charging four units per meter step before
/// each node is visited, and return the raw step total and the string
/// byte total. A later pack, intern, or serialization of the same
/// scope is bounded by these counts.
fn scope_measure(value: &Value, meter: &mut SetupMeter<'_>) -> jvc_core::Result<(u64, u64)> {
    let mut raw = 0u64;
    let bytes = value_strings_metered(value, &mut |steps, _, _, _| {
        raw += steps;
        meter(4 * steps, 0, 0, 0)
    })?;
    Ok((raw, bytes))
}

/// An upper bound on a scope's JSON text length: at most six bytes
/// per string byte (worst-case escapes) plus 25 bytes per walked
/// node (at most 24 bytes for a value such as a long float, plus
/// one separator byte).
fn json_text_bound(raw_steps: u64, string_bytes: u64) -> u64 {
    raw_steps
        .saturating_mul(25)
        .saturating_add(string_bytes.saturating_mul(6))
}

/// Charge one map or set lookup to the meter before it runs, using the
/// bound from `lookup_work` for the collection size and lookup key.
fn charge_lookup(
    meter: &mut SetupMeter<'_>,
    collection_len: usize,
    key: &str,
) -> jvc_core::Result<()> {
    meter(
        super::arena::lookup_work(collection_len as u64, key.len() as u64),
        0,
        0,
        0,
    )
}

fn value_strings_metered(value: &Value, meter: &mut SetupMeter<'_>) -> jvc_core::Result<u64> {
    match value {
        Value::String(s) => {
            meter(1 + s.len() as u64, 0, 0, 0)?;
            Ok(s.len() as u64)
        }
        Value::Array(a) => {
            meter(1, 0, 0, 0)?;
            let mut total = 0u64;
            for item in a {
                total += value_strings_metered(item, meter)?;
            }
            Ok(total)
        }
        Value::Object(o) => {
            meter(1, 0, 0, 0)?;
            let mut total = 0u64;
            for (k, v) in o {
                meter(k.len() as u64, 0, 0, 0)?;
                total += k.len() as u64 + value_strings_metered(v, meter)?;
            }
            Ok(total)
        }
        _ => {
            meter(1, 0, 0, 0)?;
            Ok(0)
        }
    }
}
fn invalid_index_overlay() -> jvc_core::Error {
    jvc_core::Error::new(
        "invalid_overlay",
        "ranking setup overlay fields are malformed",
    )
}
fn index_private_rules(e: &Evaluation) -> jvc_core::Result<&[Value]> {
    index_private_rules_metered(e, &mut |_, _, _, _| Ok(()))
}

fn index_private_rules_metered<'e>(
    e: &'e Evaluation,
    meter: &mut SetupMeter<'_>,
) -> jvc_core::Result<&'e [Value]> {
    charge_lookup(meter, e.reasons.len(), "invalid_overlay")?;
    if e.reasons.contains("invalid_overlay") {
        return Ok(&[]);
    }
    let Some(overlay) = &e.overlay else {
        return Ok(&[]);
    };
    charge_lookup(meter, overlay.as_object().map_or(0, |o| o.len()), "trust")?;
    let rules = overlay
        .get("trust")
        .and_then(Value::as_array)
        .ok_or_else(invalid_index_overlay)?;
    for rule in rules {
        // Credit this rule's entries before its validation charges, so
        // the walk raises its own allowance as it goes. A private rule
        // contributes four entries, plus two more for a heed rule.
        meter(0, 4, 0, 0)?;
        let obj_len = rule.as_object().map_or(0, |o| o.len());
        charge_lookup(meter, obj_len, "issuer")?;
        let issuer_ok = rule.get("issuer").and_then(Value::as_str).is_some();
        charge_lookup(meter, obj_len, "subject")?;
        let subject_ok = rule.get("subject").and_then(Value::as_str).is_some();
        charge_lookup(meter, obj_len, "value")?;
        let value = rule.get("value").and_then(Value::as_str);
        let value_ok = value.is_some_and(|v| matches!(v, "heed" | "shun" | "clear"));
        charge_lookup(meter, obj_len, "scope")?;
        let mut scope_ok = false;
        if let Some(scope) = rule.get("scope") {
            scope_ok = true;
            let scope_len = scope.as_object().map_or(0, |o| o.len());
            for key in ["kind", "word", "language"] {
                charge_lookup(meter, scope_len, key)?;
                if scope.get(key).and_then(Value::as_str).is_none() {
                    scope_ok = false;
                    break;
                }
            }
        }
        if !(issuer_ok && subject_ok && value_ok && scope_ok) {
            return Err(invalid_index_overlay());
        }
        if value == Some("heed") {
            meter(0, 2, 0, 0)?;
        }
    }
    Ok(rules)
}
/// Upper bounds permit one bucket per input, including duplicate keys.
pub(crate) fn ranking_index_bound(e: &Evaluation) -> jvc_core::Result<RankingIndexCounts> {
    ranking_index_bound_metered(e, &mut |_, _, _, _| Ok(()))
}

/// Like `ranking_index_bound`, but every publication, trust rule, scope
/// tree, private rule, and `key_actor` lookup is charged to the meter
/// before it is processed.
pub(crate) fn ranking_index_bound_metered(
    e: &Evaluation,
    meter: &mut SetupMeter<'_>,
) -> jvc_core::Result<RankingIndexCounts> {
    let mut c = RankingIndexCounts::default();
    let mut bytes = 0u64;
    let mut add_bytes = |n: u64| -> jvc_core::Result<()> {
        bytes = bytes.checked_add(n).ok_or_else(count_overflow)?;
        Ok(())
    };
    for p in e.publications.values() {
        let entry_delta = 2
            + if matches!(p.kind.as_str(), "definition.publish" | "rafsi.publish") {
                3 + u64::from(p.assignment.is_some())
            } else {
                0
            };
        let key_delta = (p.word.len() + p.id.len()) as u64
            + if matches!(p.kind.as_str(), "definition.publish" | "rafsi.publish") {
                (2 * (10 + p.word.len() + p.language.as_ref().map_or(0, String::len))
                    + p.id.len()
                    + p.assignment.as_ref().map_or(0, String::len)) as u64
            } else {
                0
            };
        meter(24 + key_delta, entry_delta, key_delta, 0)?;
        c.words += 1;
        c.word_publications += 1;
        add_bytes((p.word.len() + p.id.len()) as u64)?;
        if matches!(p.kind.as_str(), "definition.publish" | "rafsi.publish") {
            c.target_groups += 1;
            c.judgment_groups += 1;
            c.targets += 1 + u64::from(p.assignment.is_some());
            add_bytes(
                (2 * (10 + p.word.len() + p.language.as_ref().map_or(0, String::len))
                    + p.id.len()
                    + p.assignment.as_ref().map_or(0, String::len)) as u64,
            )?;
        }
    }
    let public = e.trust.len() as u64;
    for r in &e.trust {
        // A public rule contributes exactly five entries: one trust rule,
        // two scope rules, and two scope buckets.
        let fixed = (r.actor.len() + r.subject.len()) as u64;
        meter(24 + fixed, 5, 8 * fixed, 0)?;
        // Charge each value before the set walk visits it.
        let mut values = 0u64;
        let mut iter = r.values.iter();
        loop {
            meter(4, 0, 0, 0)?;
            let Some(value) = iter.next() else { break };
            meter(value.len() as u64, 0, 8 * value.len() as u64, 0)?;
            values += value.len() as u64;
        }
        let plain = fixed + values;
        let scope_bytes = r
            .scope
            .view()
            .string_bytes_metered(&mut |steps| meter(4 * steps, 0, 0, 0))?;
        meter(0, 0, 8 * scope_bytes, 0)?;
        add_bytes(8 * (plain + scope_bytes))?;
    }
    for r in index_private_rules_metered(e, meter)? {
        meter(16, 0, 0, 0)?;
        let obj_len = r.as_object().map_or(0, |o| o.len());
        charge_lookup(meter, obj_len, "value")?;
        let heed = r["value"] == "heed";
        c.private_rules += 1;
        c.private_weights += u64::from(heed);
        // Continuity IDs can be longer than the issuer keys in the
        // overlay. Each field read and each `key_actor` lookup is
        // charged through `charge_lookup` before it runs.
        charge_lookup(meter, obj_len, "issuer")?;
        let issuer_key = r["issuer"].as_str().ok_or_else(invalid_index_overlay)?;
        charge_lookup(meter, e.lifecycle.key_actor.len(), issuer_key)?;
        let issuer = e
            .lifecycle
            .key_actor
            .get(issuer_key)
            .map_or(issuer_key.len(), String::len) as u64;
        charge_lookup(meter, obj_len, "subject")?;
        let subject_key = r["subject"].as_str().ok_or_else(invalid_index_overlay)?;
        charge_lookup(meter, e.lifecycle.key_actor.len(), subject_key)?;
        let subject = e
            .lifecycle
            .key_actor
            .get(subject_key)
            .map_or(subject_key.len(), String::len) as u64;
        charge_lookup(meter, obj_len, "scope")?;
        let scope_bytes =
            value_strings_metered(&r["scope"], &mut |steps, _, _, _| meter(4 * steps, 0, 0, 0))?;
        meter(0, 0, 8 * (issuer + subject + scope_bytes + 16), 0)?;
        add_bytes(8 * (issuer + subject + scope_bytes + 16))?;
    }
    c.private_pairs = c.private_weights;
    c.trust_rules = public
        .checked_add(c.private_rules)
        .ok_or_else(count_overflow)?;
    c.scope_rules = public
        .checked_add(c.trust_rules)
        .ok_or_else(count_overflow)?;
    c.scope_buckets = c.scope_rules;
    c.key_bytes = bytes;
    Ok(c)
}

#[derive(Clone)]
pub(crate) struct ApproximateContextIndex {
    pub(crate) words: BTreeMap<String, Vec<String>>,
    targets: BTreeMap<(String, String, Option<String>), BTreeSet<String>>,
    judgments: BTreeMap<(String, String, Option<String>), u64>,
    trust: Vec<TrustRule>,
    private_weights: PrivateWeights,
    merged_rules: ScopedRuleIndex,
    public_rules: ScopedRuleIndex,
}
impl ApproximateContextIndex {
    pub(crate) fn new_metered(
        evaluation: &Evaluation,
        meter: &mut SetupMeter<'_>,
    ) -> jvc_core::Result<Self> {
        // Validation work is charged, but its entry credits belong to
        // the count walk, so this pass drops entry and key deltas.
        index_private_rules_metered(evaluation, &mut |w, _, _, _| meter(w, 0, 0, 0))?;
        let (trust, private_weights) = private_trust_metered(evaluation, meter)?;
        let merged_rules = ScopedRuleIndex::new_metered(&trust, Some(&private_weights), meter)?;
        let public_rules = ScopedRuleIndex::new_metered(&evaluation.trust, None, meter)?;
        let mut index = Self {
            words: BTreeMap::new(),
            targets: BTreeMap::new(),
            judgments: BTreeMap::new(),
            trust,
            private_weights,
            merged_rules,
            public_rules,
        };
        for p in evaluation.publications.values() {
            meter(
                super::arena::lookup_work(index.words.len() as u64, p.word.len() as u64)
                    + p.id.len() as u64,
                0,
                0,
                0,
            )?;
            index
                .words
                .entry(p.word.clone())
                .or_default()
                .push(p.id.clone());
            if !matches!(p.kind.as_str(), "definition.publish" | "rafsi.publish") {
                continue;
            }
            let kind = if p.kind == "definition.publish" {
                "definition"
            } else {
                "rafsi"
            };
            let language_len = if kind == "definition" {
                p.language.as_ref().map_or(0, String::len)
            } else {
                0
            };
            meter(
                super::arena::lookup_work(
                    index.targets.len() as u64,
                    (kind.len() + p.word.len() + language_len) as u64,
                ),
                0,
                0,
                0,
            )?;
            let language = if kind == "definition" {
                p.language.clone()
            } else {
                None
            };
            let targets = index
                .targets
                .entry((kind.into(), p.word.clone(), language))
                .or_default();
            meter(
                super::arena::lookup_work(targets.len() as u64, p.id.len() as u64),
                0,
                0,
                0,
            )?;
            targets.insert(p.id.clone());
            if let Some(assignment) = &p.assignment {
                meter(
                    super::arena::lookup_work(targets.len() as u64, assignment.len() as u64),
                    0,
                    0,
                    0,
                )?;
                targets.insert(assignment.clone());
            }
        }
        for (key, targets) in &index.targets {
            let mut count = 0u64;
            for id in targets {
                meter(
                    super::arena::lookup_work(evaluation.judgments.len() as u64, id.len() as u64),
                    0,
                    0,
                    0,
                )?;
                if let Some(judgments) = evaluation.judgments.get(id) {
                    count += judgments.len() as u64;
                }
            }
            meter(
                super::arena::lookup_work(
                    index.judgments.len() as u64,
                    (key.0.len() + key.1.len() + key.2.as_ref().map_or(0, String::len)) as u64,
                ),
                0,
                0,
                0,
            )?;
            index.judgments.insert(key.clone(), count);
        }
        Ok(index)
    }
    pub(crate) fn counts(&self, e: &Evaluation) -> jvc_core::Result<RankingIndexCounts> {
        let scopes = [&self.merged_rules, &self.public_rules];
        let mut c = RankingIndexCounts {
            words: self.words.len() as u64,
            word_publications: self.words.values().map(|v| v.len() as u64).sum(),
            target_groups: self.targets.len() as u64,
            targets: self.targets.values().map(|v| v.len() as u64).sum(),
            judgment_groups: self.judgments.len() as u64,
            trust_rules: self.trust.len() as u64,
            scope_buckets: scopes.iter().map(|i| i.0.len() as u64).sum(),
            scope_rules: scopes
                .iter()
                .flat_map(|i| i.0.values())
                .map(|b| b.ids.len() as u64)
                .sum(),
            private_pairs: self.private_weights.len() as u64,
            private_weights: self.private_weights.values().map(|v| v.len() as u64).sum(),
            private_rules: index_private_rules(e)?.len() as u64,
            key_bytes: 0,
        };
        let target_bytes = |k: &(String, String, Option<String>)| {
            (k.0.len() + k.1.len() + k.2.as_ref().map_or(0, String::len)) as u64
        };
        c.key_bytes = self
            .words
            .iter()
            .map(|(k, v)| k.len() as u64 + v.iter().map(|s| s.len() as u64).sum::<u64>())
            .sum::<u64>()
            + self
                .targets
                .iter()
                .map(|(k, v)| target_bytes(k) + v.iter().map(|s| s.len() as u64).sum::<u64>())
                .sum::<u64>()
            + self.judgments.keys().map(target_bytes).sum::<u64>()
            + self
                .trust
                .iter()
                .map(|r| {
                    (r.actor.len() + r.subject.len()) as u64
                        + r.scope.view().string_bytes()
                        + r.values.iter().map(|s| s.len() as u64).sum::<u64>()
                })
                .sum::<u64>()
            + scopes
                .iter()
                .flat_map(|i| i.0.keys())
                .map(|k| (k.0.len() + k.1.len() + k.2.len()) as u64)
                .sum::<u64>()
            + self
                .private_weights
                .iter()
                .map(|((a, b), v)| {
                    (a.len() + b.len()) as u64
                        + v.iter()
                            .map(|(scope, _)| scope.view().string_bytes())
                            .sum::<u64>()
                })
                .sum::<u64>();
        Ok(c)
    }
    fn target_key(context: &Context) -> (String, String, Option<String>) {
        (
            if context.kind == "definition" {
                "definition".into()
            } else {
                "rafsi".into()
            },
            context.word.clone(),
            if context.kind == "definition" {
                context.language.clone()
            } else {
                None
            },
        )
    }
    pub(crate) fn bound(
        &self,
        evaluation: &Evaluation,
        context: &Context,
    ) -> jvc_core::Result<super::incremental::RankingContextBound> {
        let key = Self::target_key(context);
        let targets = self.targets.get(&key).map_or(0, BTreeSet::len) as u64;
        let judgments = self.judgments.get(&key).copied().unwrap_or(0);
        let (rules, merged_squares) = self.merged_rules.counts(context)?;
        let shun = evaluation
            .overlay
            .as_ref()
            .is_some_and(|o| o["version"] == 2 && o["public_shun_issuer"].is_string());
        let (public_rules, public_squares) = if shun {
            self.public_rules.counts(context)?
        } else {
            (0, 0)
        };
        let array_len = |value: Option<&CompactValue>, field: &str| {
            value
                .and_then(|v| v.view().index(field).as_array())
                .map_or(0, |v| v.len()) as u64
        };
        let roots = array_len(evaluation.policy.as_ref(), "roots");
        let overlay_len = |field: &str| {
            evaluation
                .overlay
                .as_ref()
                .and_then(|v| v[field].as_array())
                .map_or(0, Vec::len) as u64
        };
        let changes = overlay_len("root_changes");
        Ok(super::incremental::RankingContextBound {
            actors: judgments + roots + changes + 2 * rules,
            edges: rules,
            refusals: rules,
            judgments,
            targets,
            trust_rules: rules,
            public_rules,
            roots,
            exclusions: array_len(evaluation.policy.as_ref(), "excluded"),
            suspensions: evaluation.lifecycle.suspended.len() as u64,
            overlay_entries: changes + overlay_len("blocked") + u64::from(shun),
            pairs_squared: merged_squares
                .checked_add(public_squares)
                .ok_or_else(count_overflow)?,
        })
    }
    pub(crate) fn context(&self, evaluation: &Evaluation, context: &Context) -> ContextGraph<f64> {
        resolve_context_indexed::<FloatRows>(evaluation, context, MAX_CONTEXT_REFUSALS, Some(self))
    }
}

fn resolve_context<A: RowArithmetic>(
    evaluation: &Evaluation,
    context: &Context,
    max_refusals: usize,
) -> ContextGraph<A::Value> {
    resolve_context_indexed::<A>(evaluation, context, max_refusals, None)
}
fn resolve_context_indexed<A: RowArithmetic>(
    evaluation: &Evaluation,
    context: &Context,
    max_refusals: usize,
    index: Option<&ApproximateContextIndex>,
) -> ContextGraph<A::Value> {
    let calculation = evaluation
        .policy
        .as_ref()
        .and_then(|policy| {
            policy
                .view()
                .index("calculation")
                .as_str()
                .map(str::to_owned)
        })
        .unwrap_or_default();
    if evaluation.reasons.contains("invalid_overlay") {
        return ContextGraph {
            calculation,
            actors: Vec::new(),
            roots: Vec::new(),
            rows: Vec::new(),
            refusals: Vec::new(),
            blocked: BTreeSet::new(),
            public_shun_blocked: BTreeSet::new(),
            private_blocked: BTreeSet::new(),
            judgments: BTreeMap::new(),
            available: false,
            reasons: evaluation.reasons.clone(),
        };
    }
    let mut actors = BTreeSet::new();
    let targets = match index {
        Some(index) => index
            .targets
            .get(&(
                if context.kind == "definition" {
                    "definition".into()
                } else {
                    "rafsi".into()
                },
                context.word.clone(),
                if context.kind == "definition" {
                    context.language.clone()
                } else {
                    None
                },
            ))
            .map(|ids| ids.iter().map(String::as_str).collect())
            .unwrap_or_default(),
        None => context_target_ids(evaluation.publications.values(), context),
    };
    let judgments = judgments_for_targets(targets.into_iter(), &evaluation.judgments);
    for values in judgments.values() {
        actors.extend(values.keys().cloned());
    }
    let resolve = |key: &str| {
        evaluation
            .lifecycle
            .key_actor
            .get(key)
            .cloned()
            .unwrap_or_else(|| key.into())
    };
    let mut raw_roots: BTreeMap<String, Rational> = BTreeMap::new();
    let mut blocked: BTreeSet<String> = evaluation.lifecycle.suspended.keys().cloned().collect();
    let mut public_shun_blocked = BTreeSet::new();
    let mut private_blocked = BTreeSet::new();
    if let Some(policy) = &evaluation.policy {
        for root in policy
            .view()
            .index("roots")
            .as_array()
            .into_iter()
            .flatten()
        {
            if let (Some(key), Some(q)) =
                (root.index("identity").as_str(), rational(root.index("q")))
            {
                raw_roots.insert(key.into(), q);
            }
        }
        for item in policy
            .view()
            .index("excluded")
            .as_array()
            .into_iter()
            .flatten()
        {
            if let Some(key) = item.index("identity").as_str() {
                let actor = resolve(key);
                blocked.insert(actor);
            }
        }
    }
    let prepared;
    let (trust, private_weights_by_pair) = match index {
        Some(index) => (
            index.merged_rules.rules(&index.trust, context),
            &index.private_weights,
        ),
        None => {
            prepared = private_trust(evaluation);
            (prepared.0.iter().collect::<Vec<_>>(), &prepared.1)
        }
    };
    if let Some(overlay) = &evaluation.overlay {
        if overlay["version"] == 2 {
            if let Some(key) = overlay["public_shun_issuer"].as_str() {
                let issuer = resolve(key);
                // Public personal blocks use public rules before private replacement.
                let public = match index {
                    Some(index) => index.public_rules.rules(&evaluation.trust, context),
                    None => evaluation.trust.iter().collect(),
                };
                for ((_, subject), rules) in scoped_pairs(public, context, Some(&issuer)) {
                    if retained_rules(&rules)
                        .iter()
                        .any(|rule| rule.values.contains("shun"))
                    {
                        public_shun_blocked.insert(subject);
                    }
                }
                blocked.extend(public_shun_blocked.iter().cloned());
            }
        }
        for root in overlay["root_changes"].as_array().into_iter().flatten() {
            if let Some(key) = root["identity"].as_str() {
                if root["q"].is_null() {
                    raw_roots.remove(key);
                } else if let Some(q) = overlay_rational(&root["q"]) {
                    raw_roots.insert(key.into(), q);
                }
            }
        }
        for item in overlay["blocked"].as_array().into_iter().flatten() {
            if overlay_matches(&item["scope"], context) {
                if let Some(key) = item["identity"].as_str() {
                    let actor = resolve(key);
                    if overlay["version"] == 2 {
                        private_blocked.insert(actor.clone());
                    }
                    blocked.insert(actor);
                }
            }
        }
    }
    let mut root_weights: BTreeMap<String, Rational> = BTreeMap::new();
    for (key, q) in raw_roots {
        let actor = resolve(&key);
        actors.insert(actor.clone());
        let current = root_weights.entry(actor).or_insert_with(Rational::zero);
        *current = std::cmp::max(current.clone(), q);
    }

    for rule in &trust {
        if matches(rule.scope.view(), context) && !rule.values.iter().all(|v| v == "clear") {
            actors.insert(rule.actor.clone());
            actors.insert(rule.subject.clone());
        }
    }
    let pairs = scoped_pairs(trust, context, None);
    let actors: Vec<_> = actors.into_iter().collect();
    let indices: BTreeMap<_, _> = actors
        .iter()
        .enumerate()
        .map(|(i, a)| (a.clone(), i))
        .collect();
    let mut rows = vec![Vec::new(); actors.len()];
    let route_refusals =
        calculation == "simple-routes-shun-v1" || calculation == jvc_rank::approximate::ALGORITHM;
    let mut refusals = if route_refusals {
        vec![Vec::new(); actors.len()]
    } else {
        Vec::new()
    };
    let mut refusal_count = 0;
    let mut reasons = evaluation.reasons.clone();
    let mut available = evaluation.available && evaluation.policy.is_some();
    if !A::supports(&calculation) {
        available = false;
        reasons.insert("unsupported_calculation".into());
    }
    let mut weights: BTreeMap<String, BTreeMap<String, Rational>> = BTreeMap::new();
    for ((issuer, subject), rules) in pairs {
        let retained = retained_rules(&rules);
        if route_refusals && retained.iter().any(|rule| rule.values.contains("shun")) {
            if refusal_count == max_refusals {
                reasons.insert("resource_unavailable".into());
                available = false;
                break;
            }
            refusals[indices[&subject]].push(indices[&issuer]);
            refusal_count += 1;
        }
        if retained.is_empty()
            || retained
                .iter()
                .any(|r| r.values.len() != 1 || !r.values.contains("heed"))
        {
            continue;
        }
        let mut private_weights = BTreeSet::new();
        if let Some(entries) = private_weights_by_pair.get(&(issuer.clone(), subject.clone())) {
            for (scope, weight) in entries {
                if retained.iter().any(|rule| rule.scope == *scope) {
                    private_weights.insert(weight.clone());
                }
            }
        }
        if private_weights.len() > 1 {
            continue;
        }
        let weight = private_weights
            .into_iter()
            .next()
            .unwrap_or_else(Rational::one);
        weights.entry(issuer).or_default().insert(subject, weight);
    }
    for (issuer, destinations) in weights {
        if blocked.contains(&issuer) {
            continue;
        }
        if !A::supports(&calculation) {
            continue;
        }
        match A::row(&destinations, &blocked) {
            Ok(shares) => {
                for (subject, share) in shares {
                    rows[indices[&issuer]].push(PositiveEdge {
                        to: indices[&subject],
                        share,
                    });
                }
            }
            Err(reason) => {
                available = false;
                reasons.insert(reason.into());
            }
        }
    }
    let root_inputs = actors.iter().map(|a| {
        if blocked.contains(a) {
            Rational::zero()
        } else {
            root_weights.get(a).cloned().unwrap_or_else(Rational::zero)
        }
    });
    let roots = match prepare_roots::<A>(root_inputs) {
        Ok(roots) => roots,
        Err(reason) => {
            available = false;
            reasons.insert(reason.into());
            Vec::new()
        }
    };
    let blocked = blocked
        .iter()
        .filter_map(|a| indices.get(a).copied())
        .collect();
    let public_shun_blocked = public_shun_blocked
        .iter()
        .filter_map(|actor| indices.get(actor).copied())
        .collect();
    let private_blocked = private_blocked
        .iter()
        .filter_map(|actor| indices.get(actor).copied())
        .collect();
    for list in &mut refusals {
        list.sort_unstable();
    }
    ContextGraph {
        calculation,
        actors,
        roots,
        rows,
        refusals,
        blocked,
        public_shun_blocked,
        private_blocked,
        judgments,
        available,
        reasons,
    }
}

#[cfg(test)]
thread_local! {
    static SELECTION_HASH_VALIDATIONS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
pub(crate) fn reset_selection_hash_validations() {
    SELECTION_HASH_VALIDATIONS.with(|count| count.set(0));
}

#[cfg(test)]
thread_local! {
    /// Test override of the base that the resolver's bound starts
    /// from. The record and predecessor terms still apply.
    pub(crate) static RESOLVER_BASE_OVERRIDE: std::cell::Cell<Option<usize>> =
        const { std::cell::Cell::new(None) };
}
#[cfg(test)]
pub(crate) fn selection_hash_validations() -> usize {
    SELECTION_HASH_VALIDATIONS.with(std::cell::Cell::get)
}

pub(crate) fn valid_selection_cached<'a>(
    import_selections: &'a BTreeMap<String, Vec<String>>,
    id: &str,
    cache: &mut BTreeMap<String, bool>,
) -> Option<&'a Vec<String>> {
    let ids = import_selections.get(id)?;
    if let Some(&is_valid) = cache.get(id) {
        return is_valid.then_some(ids);
    }
    let valid = valid_selection_map(import_selections, id);
    cache.insert(id.to_owned(), valid.is_some());
    valid
}

pub(crate) fn valid_selection_map<'a>(
    import_selections: &'a BTreeMap<String, Vec<String>>,
    id: &str,
) -> Option<&'a Vec<String>> {
    use std::io::Write;
    let ids = import_selections.get(id)?;
    #[cfg(test)]
    SELECTION_HASH_VALIDATIONS.with(|count| count.set(count.get() + 1));
    let mut writer = jvc_core::HashWriter::new(b"", 16 * 1024 * 1024);
    writer.write_all(b"[").ok()?;
    let mut previous: Option<&str> = None;
    for (index, item) in ids.iter().enumerate() {
        if !jvc_core::valid_id(item, "jve1:") || previous.is_some_and(|prev| prev >= item.as_str())
        {
            return None;
        }
        previous = Some(item.as_str());
        if index > 0 {
            writer.write_all(b",").ok()?;
        }
        writer.write_all(b"\"").ok()?;
        writer.write_all(item.as_bytes()).ok()?;
        writer.write_all(b"\"").ok()?;
    }
    writer.write_all(b"]").ok()?;
    if writer.finish("sha256:").0 != id {
        return None;
    }
    Some(ids)
}

fn exact(v: &Value, names: &[&str]) -> bool {
    v.as_object()
        .is_some_and(|o| o.len() == names.len() && names.iter().all(|n| o.contains_key(*n)))
}
fn valid_rational(v: &Value, positive: bool) -> bool {
    if !exact(v, &["numerator", "denominator"]) {
        return false;
    }
    let (Some(n), Some(d)) = (v["numerator"].as_u64(), v["denominator"].as_u64()) else {
        return false;
    };
    if d == 0 || d > 1_000_000_000 || n > 1_000_000_000 || (positive && n == 0) {
        return false;
    }
    let r = Rational::new(BigInt::from(n), BigInt::from(d));
    r.numer() == &BigInt::from(n) && r.denom() == &BigInt::from(d)
}
pub(crate) fn valid_overlay(v: &Value, base: &str) -> bool {
    let fields: &[&str] = match v["version"].as_u64() {
        Some(1) => &[
            "version",
            "base_view",
            "root_changes",
            "trust",
            "blocked",
            "work",
        ],
        Some(2) => &[
            "version",
            "base_view",
            "root_changes",
            "trust",
            "blocked",
            "work",
            "public_shun_issuer",
        ],
        _ => return false,
    };
    if !exact(v, fields) || v["base_view"].as_str() != Some(base) {
        return false;
    }
    if v["version"] == 2
        && !v["public_shun_issuer"].is_null()
        && !v["public_shun_issuer"]
            .as_str()
            .is_some_and(|key| jvc_core::valid_id(key, "ed25519:"))
    {
        return false;
    }
    if !v["work"].is_null()
        && !v["work"]
            .as_u64()
            .is_some_and(|w| (1..=10_000_000).contains(&w))
    {
        return false;
    }
    for name in ["root_changes", "trust", "blocked"] {
        let Some(array) = v[name].as_array() else {
            return false;
        };
        if array.len() > 10_000 {
            return false;
        }
        let mut previous: Option<Vec<u8>> = None;
        let mut keys = BTreeSet::new();
        for item in array {
            let Ok(bytes) = jvc_core::canonical_value(item) else {
                return false;
            };
            if previous.as_ref().is_some_and(|p| p >= &bytes) {
                return false;
            }
            previous = Some(bytes);
            let identity = |name: &str| {
                item[name]
                    .as_str()
                    .is_some_and(|s| jvc_core::valid_id(s, "ed25519:"))
            };
            let key = match name {
                "root_changes" => {
                    if !exact(item, &["identity", "q"])
                        || !identity("identity")
                        || (!item["q"].is_null() && !valid_rational(&item["q"], false))
                    {
                        return false;
                    }
                    item["identity"].to_string()
                }
                "trust" => {
                    if !exact(item, &["issuer", "subject", "scope", "value", "weight"])
                        || !identity("issuer")
                        || !identity("subject")
                        || jvc_core::validate_scope(&item["scope"]).is_err()
                    {
                        return false;
                    }
                    if !matches!(item["value"].as_str(), Some("heed" | "shun" | "clear")) {
                        return false;
                    }
                    if !item["weight"].is_null()
                        && (item["value"] != "heed" || !valid_rational(&item["weight"], true))
                    {
                        return false;
                    }
                    format!("{}|{}|{}", item["issuer"], item["subject"], item["scope"])
                }
                _ => {
                    if !exact(item, &["identity", "scope"])
                        || !identity("identity")
                        || jvc_core::validate_scope(&item["scope"]).is_err()
                    {
                        return false;
                    }
                    format!("{}|{}", item["identity"], item["scope"])
                }
            };
            if !keys.insert(key) {
                return false;
            }
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn dispatch_evaluation(calculation: &str) -> Evaluation {
        let mut evaluation = evaluate(&EvaluationInput {
            events: Vec::new(),
            bodies: BTreeMap::new(),
            selected_view: String::new(),
            overlay: None,
            import_selections: BTreeMap::new(),
            limits: Limits::default(),
        });
        evaluation.available = true;
        evaluation.reasons.clear();
        evaluation.policy =
            Some(json!({"calculation":calculation,"roots":[],"excluded":[]}).into());
        evaluation.trust = vec![TrustRule {
            actor: "a".into(),
            subject: "b".into(),
            scope: json!({"kind":"*","word":"*","language":"*"}).into(),
            values: BTreeSet::from(["heed".into()]),
        }];
        evaluation
    }

    fn dispatch_context() -> Context {
        Context {
            kind: "definition".into(),
            word: "word".into(),
            language: Some("en".into()),
        }
    }

    #[test]
    fn exact_rows_reject_the_float_profile_at_the_state_boundary() {
        let evaluation = dispatch_evaluation(jvc_rank::approximate::ALGORITHM);
        let context = dispatch_context();
        assert!(prepare_approximate_context(&evaluation, &context).available);
        let graph = evaluate_context(&evaluation, &context);
        assert!(!graph.available);
        assert!(graph.reasons.contains("unsupported_calculation"));
        assert!(!graph.actors.is_empty());
        assert!(graph.rows.iter().all(Vec::is_empty));
    }

    #[test]
    fn float_rows_reject_both_exact_profiles_at_the_state_boundary() {
        for profile in ["simple-routes-bounds-v1", "simple-routes-shun-v1"] {
            let evaluation = dispatch_evaluation(profile);
            let context = dispatch_context();
            assert!(evaluate_context(&evaluation, &context).available);
            let graph = prepare_approximate_context(&evaluation, &context);
            assert!(!graph.available);
            assert!(graph.reasons.contains("unsupported_calculation"));
            assert!(!graph.actors.is_empty());
            assert!(graph.rows.iter().all(Vec::is_empty));
        }
    }

    #[test]
    fn float_preparation_preserves_failure_classes() {
        let blocked = BTreeSet::new();
        let weights = |value| BTreeMap::from([("actor".into(), value)]);
        assert_eq!(
            FloatRows::row(&weights(Rational::zero()), &blocked),
            Err("invalid_graph")
        );
        assert_eq!(
            FloatRows::row(
                &weights(Rational::from_integer(BigInt::one() << 16384)),
                &blocked
            ),
            Err("resource_unavailable")
        );
        assert_eq!(
            FloatRows::row(
                &weights(Rational::new(BigInt::one(), BigInt::one() << 1023)),
                &blocked
            ),
            Err("numeric_unavailable")
        );
    }

    #[test]
    fn failed_float_roots_do_not_return_successful_allocations() {
        for invalid in [
            Rational::new(BigInt::one(), BigInt::one() << 1023),
            Rational::from_integer(BigInt::one() << 2000),
        ] {
            assert_eq!(
                prepare_roots::<FloatRows>([Rational::one(), invalid]),
                Err("numeric_unavailable")
            );
        }
        assert_eq!(
            prepare_roots::<FloatRows>([Rational::zero(), Rational::one()]),
            Ok(vec![0.0, 1.0])
        );
    }

    #[test]
    fn private_trust_capacity_is_charged_before_the_allocation() {
        // Charge-order test: the first charge the meter sees must be
        // the capacity charge for the trust vector, before any rule
        // is read. Allocation counting is not needed to pin the order.
        let mut evaluation = dispatch_evaluation("simple-routes-shun-f64-v1");
        let rule = evaluation.trust[0].clone();
        evaluation.trust = vec![rule.clone(), rule.clone(), rule];
        let charges = std::cell::RefCell::new(Vec::new());
        let mut meter = |work: u64, _: u64, _: u64, _: u64| -> jvc_core::Result<()> {
            charges.borrow_mut().push(work);
            Ok(())
        };
        private_trust_metered(&evaluation, &mut meter).unwrap();
        let expected = (evaluation.trust.len() * std::mem::size_of::<TrustRule>()) as u64;
        assert_eq!(charges.borrow().first().copied(), Some(expected));
    }

    #[test]
    fn json_text_bound_covers_long_float_arrays() {
        let value = Value::Array(
            (0..2_000)
                .map(|_| json!(-1.2345678901234567e-100))
                .collect(),
        );
        let mut raw = 0u64;
        let string_bytes = value_strings_metered(&value, &mut |steps, _, _, _| {
            raw += steps;
            Ok(())
        })
        .unwrap();
        let serialized = value.to_string().len() as u64;
        assert_eq!(serialized, 50_001);
        assert!(json_text_bound(raw, string_bytes) >= serialized);
        assert_eq!(
            json_text_bound(raw, string_bytes),
            25 * raw + 6 * string_bytes
        );
    }

    #[test]
    fn refusal_pair_limit_matches_ranker_default() {
        assert_eq!(
            MAX_CONTEXT_REFUSALS,
            jvc_rank::Limits::default().max_refusals
        );
    }

    #[test]
    fn old_profile_personal_blocks_do_not_build_or_charge_a_refusal_relation() {
        let input = EvaluationInput {
            events: Vec::new(),
            bodies: BTreeMap::new(),
            selected_view: String::new(),
            overlay: None,
            import_selections: BTreeMap::new(),
            limits: Limits::default(),
        };
        let mut evaluation = evaluate(&input);
        evaluation.available = true;
        evaluation.reasons.clear();
        let issuer = jvc_core::identity_from_seed(&[1; 32]);
        evaluation.policy =
            Some(json!({"calculation":"simple-routes-bounds-v1","roots":[],"excluded":[]}).into());
        evaluation.overlay = Some(
            json!({"version":2,"public_shun_issuer":issuer,"root_changes":[],"trust":[],"blocked":[]})
                .into(),
        );
        evaluation.trust = [2, 3]
            .into_iter()
            .map(|seed| TrustRule {
                actor: issuer.clone(),
                subject: jvc_core::identity_from_seed(&[seed; 32]),
                scope: json!({"kind":"*","word":"*","language":"*"}).into(),
                values: BTreeSet::from(["shun".into()]),
            })
            .collect();
        let context = Context {
            kind: "definition".into(),
            word: "word".into(),
            language: Some("en".into()),
        };
        let graph = evaluate_context_with_limit(&evaluation, &context, 0);
        assert!(graph.available);
        assert_eq!(graph.public_shun_blocked.len(), 2);
        assert!(graph.refusals.is_empty());
        assert_eq!(graph.refusals.capacity(), 0);
        evaluation.policy =
            Some(json!({"calculation":"simple-routes-shun-v1","roots":[],"excluded":[]}).into());
        assert!(!evaluate_context_with_limit(&evaluation, &context, 0).available);
    }

    #[test]
    fn refusal_construction_is_bounded_and_reports_unavailable() {
        let input = EvaluationInput {
            events: Vec::new(),
            bodies: BTreeMap::new(),
            selected_view: String::new(),
            overlay: None,
            import_selections: BTreeMap::new(),
            limits: Limits::default(),
        };
        let mut evaluation = evaluate(&input);
        evaluation.available = true;
        evaluation.reasons.clear();
        evaluation.policy =
            Some(json!({"calculation":"simple-routes-shun-v1","roots":[],"excluded":[]}).into());
        evaluation.trust = ["b", "c"]
            .into_iter()
            .map(|subject| TrustRule {
                actor: "a".into(),
                subject: subject.into(),
                scope: json!({"kind":"*","word":"*","language":"*"}).into(),
                values: BTreeSet::from(["shun".into()]),
            })
            .collect();
        let context = Context {
            kind: "definition".into(),
            word: "word".into(),
            language: Some("en".into()),
        };
        let accepted = evaluate_context_with_limit(&evaluation, &context, 2);
        assert!(accepted.available);
        assert_eq!(accepted.refusals.iter().map(Vec::len).sum::<usize>(), 2);
        let refused = evaluate_context_with_limit(&evaluation, &context, 1);
        assert!(!refused.available);
        assert!(refused.reasons.contains("resource_unavailable"));
        assert_eq!(refused.refusals.iter().map(Vec::len).sum::<usize>(), 1);
        evaluation.policy =
            Some(json!({"calculation":"simple-routes-bounds-v1","roots":[],"excluded":[]}).into());
        let old = evaluate_context_with_limit(&evaluation, &context, 0);
        assert!(old.available);
        assert!(old.refusals.is_empty());
        assert_eq!(old.refusals.capacity(), 0);
        assert!(old.rows.iter().all(Vec::is_empty));
        assert!(!old.reasons.contains("resource_unavailable"));
        assert_eq!(MAX_CONTEXT_REFUSALS, 100_000);
    }
}

#[cfg(test)]
mod index_tests;
#[cfg(test)]
mod reference;
