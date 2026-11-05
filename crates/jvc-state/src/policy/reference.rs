// Frozen resolver from main 30cf428. Keep its judgment-first and repeated private scans.
use super::*;

pub(super) fn evaluate_context_with_limit(
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
