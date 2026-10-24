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
pub struct PositiveEdge {
    pub to: usize,
    pub share: Rational,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContextGraph {
    pub calculation: String,
    pub actors: Vec<String>,
    pub roots: Vec<Rational>,
    pub rows: Vec<Vec<PositiveEdge>>,
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
pub(crate) fn select(graph: &graph::Graph, input: &EvaluationOptions, result: &mut Evaluation) {
    let mut todo = vec![input.selected_view.clone()];
    let mut seen = BTreeSet::new();
    while let Some(id) = todo.pop() {
        if seen.len() >= input.limits.traversal {
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
        todo.extend(
            n.action["parents"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|v| v.as_str().map(str::to_owned)),
        );
        for entry in body["import_sets"].as_array().into_iter().flatten() {
            if id == input.selected_view {
                match entry["selection"]
                    .as_str()
                    .and_then(|id| valid_selection(input, id))
                {
                    None => {
                        result.reasons.insert("import_selection_unavailable".into());
                    }
                    Some(ids) => {
                        result.selections.insert(
                            entry["selection"].as_str().unwrap().into(),
                            ids.iter().cloned().collect(),
                        );
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
fn rational(v: &Value) -> Option<Rational> {
    let n = v["numerator"].as_i64()?;
    let d = v["denominator"].as_u64()?;
    if d == 0 {
        return None;
    }
    Some(Rational::new(BigInt::from(n), BigInt::from(d)))
}
fn matches(scope: &Value, context: &Context) -> bool {
    let kind = scope["kind"].as_str().unwrap_or_default();
    let word = scope["word"].as_str().unwrap_or_default();
    let language = scope["language"].as_str().unwrap_or_default();
    (kind == "*" || kind == context.kind)
        && (word == "*" || word == context.word)
        && match &context.language {
            Some(l) => language == "*" || language == l,
            None => language == "*",
        }
}
fn dimensions(scope: &Value) -> [String; 3] {
    let mut kind = scope["kind"].as_str().unwrap_or_default().to_owned();
    let language = scope["language"].as_str().unwrap_or_default().to_owned();
    if kind == "*" && language != "*" {
        kind = "definition".into();
    }
    [
        kind,
        scope["word"].as_str().unwrap_or_default().into(),
        language,
    ]
}
fn narrower(a: &Value, b: &Value) -> bool {
    let a = dimensions(a);
    let b = dimensions(b);
    a != b && a.iter().zip(b.iter()).all(|(a, b)| a == b || b == "*")
}
fn scoped_pairs<'a>(
    trust: &'a [TrustRule],
    context: &Context,
    issuer: Option<&str>,
) -> BTreeMap<(String, String), Vec<&'a TrustRule>> {
    let mut pairs: BTreeMap<_, Vec<_>> = BTreeMap::new();
    for rule in trust {
        if issuer.is_some_and(|actor| actor != rule.actor)
            || rule.actor == rule.subject
            || !matches(&rule.scope, context)
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
                .any(|other| narrower(&other.scope, &rule.scope))
        })
        .collect()
}
/// Construct the positive graph for one exact comparison context.
/// Blocked destinations lose their original shares after row normalization.
pub fn evaluate_context(evaluation: &Evaluation, context: &Context) -> ContextGraph {
    evaluate_context_with_limit(evaluation, context, MAX_CONTEXT_REFUSALS)
}
fn evaluate_context_with_limit(
    evaluation: &Evaluation,
    context: &Context,
    max_refusals: usize,
) -> ContextGraph {
    let calculation = evaluation
        .policy
        .as_ref()
        .and_then(|policy| policy["calculation"].as_str())
        .unwrap_or_default()
        .to_owned();
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
    let judgments: BTreeMap<_, _> = evaluation
        .judgments
        .iter()
        .filter(|(target, _)| {
            evaluation.publications.values().any(|p| {
                (p.id == **target || p.assignment.as_ref() == Some(*target))
                    && p.word == context.word
                    && if context.kind == "definition" {
                        p.kind == "definition.publish" && p.language == context.language
                    } else {
                        p.kind == "rafsi.publish"
                    }
            })
        })
        .map(|(target, values)| (target.clone(), values.clone()))
        .collect();
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
        for root in policy["roots"].as_array().into_iter().flatten() {
            if let (Some(key), Some(q)) = (root["identity"].as_str(), rational(&root["q"])) {
                raw_roots.insert(key.into(), q);
            }
        }
        for item in policy["excluded"].as_array().into_iter().flatten() {
            if let Some(key) = item["identity"].as_str() {
                let actor = resolve(key);
                blocked.insert(actor);
            }
        }
    }
    let mut trust = evaluation.trust.clone();
    if let Some(overlay) = &evaluation.overlay {
        if overlay["version"] == 2 {
            if let Some(key) = overlay["public_shun_issuer"].as_str() {
                let issuer = resolve(key);
                // Public personal blocks use public rules before private replacement.
                for ((_, subject), rules) in scoped_pairs(&evaluation.trust, context, Some(&issuer))
                {
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
                } else if let Some(q) = rational(&root["q"]) {
                    raw_roots.insert(key.into(), q);
                }
            }
        }
        for item in overlay["blocked"].as_array().into_iter().flatten() {
            if matches(&item["scope"], context) {
                if let Some(key) = item["identity"].as_str() {
                    let actor = resolve(key);
                    if overlay["version"] == 2 {
                        private_blocked.insert(actor.clone());
                    }
                    blocked.insert(actor);
                }
            }
        }
        let mut private: BTreeMap<(String, String, String), (Value, BTreeSet<String>)> =
            BTreeMap::new();
        for rule in overlay["trust"].as_array().into_iter().flatten() {
            let issuer = resolve(rule["issuer"].as_str().unwrap());
            let subject = resolve(rule["subject"].as_str().unwrap());
            let entry = private
                .entry((issuer, subject, rule["scope"].to_string()))
                .or_insert_with(|| (rule["scope"].clone(), BTreeSet::new()));
            entry.1.insert(rule["value"].as_str().unwrap().into());
        }
        for ((issuer, subject, _), (scope, values)) in private {
            trust.retain(|r| r.actor != issuer || r.subject != subject || r.scope != scope);
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
    let mut root_weights: BTreeMap<String, Rational> = BTreeMap::new();
    for (key, q) in raw_roots {
        let actor = resolve(&key);
        actors.insert(actor.clone());
        let current = root_weights.entry(actor).or_insert_with(Rational::zero);
        *current = std::cmp::max(current.clone(), q);
    }

    for rule in &trust {
        if matches(&rule.scope, context) && !rule.values.iter().all(|v| v == "clear") {
            actors.insert(rule.actor.clone());
            actors.insert(rule.subject.clone());
        }
    }
    let pairs = scoped_pairs(&trust, context, None);
    let actors: Vec<_> = actors.into_iter().collect();
    let indices: BTreeMap<_, _> = actors
        .iter()
        .enumerate()
        .map(|(i, a)| (a.clone(), i))
        .collect();
    let mut rows = vec![Vec::new(); actors.len()];
    let route_refusals = calculation == "simple-routes-shun-v1";
    let mut refusals = if route_refusals {
        vec![Vec::new(); actors.len()]
    } else {
        Vec::new()
    };
    let mut refusal_count = 0;
    let mut reasons = evaluation.reasons.clone();
    let mut available = evaluation.available && evaluation.policy.is_some();
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
        if let Some(overlay) = &evaluation.overlay {
            for r in overlay["trust"].as_array().into_iter().flatten() {
                if r["issuer"].as_str().is_some_and(|a| resolve(a) == issuer)
                    && r["subject"].as_str().is_some_and(|a| resolve(a) == subject)
                    && retained.iter().any(|rule| rule.scope == r["scope"])
                    && r["value"] == "heed"
                {
                    private_weights.insert(rational(&r["weight"]).unwrap_or_else(Rational::one));
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
        let sum = destinations.values().fold(Rational::zero(), |a, b| a + b);
        let divisor = std::cmp::max(sum, Rational::one());
        if blocked.contains(&issuer) {
            continue;
        }
        for (subject, weight) in destinations {
            if !blocked.contains(&subject) {
                rows[indices[&issuer]].push(PositiveEdge {
                    to: indices[&subject],
                    share: weight / &divisor,
                });
            }
        }
    }
    let roots = actors
        .iter()
        .map(|a| {
            if blocked.contains(a) {
                Rational::zero()
            } else {
                root_weights.get(a).cloned().unwrap_or_else(Rational::zero)
            }
        })
        .collect();
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

pub(crate) fn valid_selection<'a>(
    input: &'a EvaluationOptions,
    id: &str,
) -> Option<&'a Vec<String>> {
    let ids = input.import_selections.get(id)?;
    jvc_core::sorted_ids(ids, "jve1:", 200_000).ok()?;
    let bytes = jvc_core::canonical_value(&serde_json::json!(ids)).ok()?;
    if bytes.len() > 16 * 1024 * 1024 || jvc_core::hash_id("sha256:", b"", &bytes) != id {
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
            Some(json!({"calculation":"simple-routes-bounds-v1","roots":[],"excluded":[]}));
        evaluation.overlay = Some(
            json!({"version":2,"public_shun_issuer":issuer,"root_changes":[],"trust":[],"blocked":[]}),
        );
        evaluation.trust = [2, 3]
            .into_iter()
            .map(|seed| TrustRule {
                actor: issuer.clone(),
                subject: jvc_core::identity_from_seed(&[seed; 32]),
                scope: json!({"kind":"*","word":"*","language":"*"}),
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
        evaluation.policy.as_mut().unwrap()["calculation"] = json!("simple-routes-shun-v1");
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
            Some(json!({"calculation":"simple-routes-shun-v1","roots":[],"excluded":[]}));
        evaluation.trust = ["b", "c"]
            .into_iter()
            .map(|subject| TrustRule {
                actor: "a".into(),
                subject: subject.into(),
                scope: json!({"kind":"*","word":"*","language":"*"}),
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
        evaluation.policy.as_mut().unwrap()["calculation"] = json!("simple-routes-bounds-v1");
        let old = evaluate_context_with_limit(&evaluation, &context, 0);
        assert!(old.available);
        assert!(old.refusals.is_empty());
        assert_eq!(old.refusals.capacity(), 0);
        assert!(old.rows.iter().all(Vec::is_empty));
        assert!(!old.reasons.contains("resource_unavailable"));
        assert_eq!(MAX_CONTEXT_REFUSALS, 100_000);
    }
}
