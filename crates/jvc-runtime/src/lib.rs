//! Portable service entry points. Every envelope crosses signature validation.
use jvc_core::{Error, Result, canonical_value, inspect_body, parse_json, verify_envelope};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use wasm_bindgen::prelude::*;

fn output(value: impl Serialize) -> std::result::Result<String, JsValue> {
    serde_json::to_string(&value).map_err(|e| JsValue::from_str(&e.to_string()))
}
fn fail(e: Error) -> JsValue {
    JsValue::from_str(&serde_json::to_string(&e).unwrap())
}
fn text(bytes: Vec<u8>) -> String {
    String::from_utf8(bytes).unwrap()
}
#[wasm_bindgen]
pub fn runtime_canonicalize(bytes: &[u8]) -> std::result::Result<String, JsValue> {
    jvc_core::canonicalize_json(bytes).map(text).map_err(fail)
}
#[wasm_bindgen]
pub fn runtime_verify_record(bytes: &[u8]) -> std::result::Result<String, JsValue> {
    let event = verify_envelope(bytes).map_err(fail)?;
    output(
        json!({"envelope":event.envelope(),"canonical":text(event.canonical_envelope().map_err(fail)?),"signature_bytes":event.signature_bytes(),"action_valid":jvc_core::validate_action(event.header()).is_ok()}),
    )
}
#[wasm_bindgen]
pub fn canonicalize_storage_wrapper(bytes: &[u8]) -> std::result::Result<String, JsValue> {
    let value = jvc_core::parse_transport_json(bytes).map_err(fail)?;
    serde_json_canonicalizer::to_vec(&value)
        .map(text)
        .map_err(|e| fail(Error::new("json", e.to_string())))
}
#[wasm_bindgen]
pub fn prepare_admission(bytes: &[u8]) -> std::result::Result<String, JsValue> {
    prepare(bytes)
        .and_then(|v| canonical_value(&v))
        .map(text)
        .map_err(fail)
}
fn prepare(bytes: &[u8]) -> Result<Value> {
    let value = jvc_core::parse_transport_json(bytes)?;
    let o = value
        .as_object()
        .ok_or_else(|| Error::new("transport", "request must be an object"))?;
    if o.len() != 2 || !o.contains_key("envelope") || !o.contains_key("body") {
        return Err(Error::new(
            "transport",
            "request must contain exactly envelope and body",
        ));
    }
    let e = canonical_value(&o["envelope"])?;
    let event = verify_envelope(&e)?;
    let body = if o["body"].is_null() {
        None
    } else {
        Some(canonical_value(&o["body"])?)
    };
    if let Some(bytes) = &body {
        let descriptor = event
            .header()
            .content
            .as_ref()
            .ok_or_else(|| Error::new("body", "header has no content descriptor"))?;
        if bytes.len() > jvc_core::MAX_BODY_BYTES || bytes.len() as u64 != descriptor.bytes {
            return Err(Error::new(
                "body_length",
                "body length does not match the descriptor",
            ));
        }
        if jvc_core::hash_id("sha256:", b"", bytes) != descriptor.hash {
            return Err(Error::new(
                "body_hash",
                "body hash does not match the descriptor",
            ));
        }
    }
    let availability = inspect_body(&event, body.as_deref());
    Ok(
        json!({"id":event.id(),"envelope":text(e.clone()),"envelope_hash":jvc_core::hash_id("sha256:",b"",&e),"header":event.header(),"signature_bytes":event.signature_bytes(),"body":body.map(text),"body_status":match availability{jvc_core::BodyAvailability::Absent=>"none",jvc_core::BodyAvailability::Missing=>"missing",jvc_core::BodyAvailability::Invalid{..}=>"invalid",_=>"present"},"action_valid":jvc_core::validate_action(event.header()).is_ok()}),
    )
}
#[wasm_bindgen]
pub fn content_hash(bytes: &[u8]) -> String {
    jvc_core::hash_id("sha256:", b"", bytes)
}
#[wasm_bindgen]
pub fn prepare_selection(bytes: &[u8]) -> std::result::Result<String, JsValue> {
    if bytes.len() > 16 * 1024 * 1024 {
        return Err(fail(Error::new(
            "selection_size",
            "import selection exceeds 16 MiB",
        )));
    }
    let value = parse_json(bytes).map_err(fail)?;
    let ids: Vec<String> = serde_json::from_value(value.clone()).map_err(|_| {
        fail(Error::new(
            "selection",
            "selection must be an identifier array",
        ))
    })?;
    jvc_core::sorted_ids(&ids, "jve1:", 200_000).map_err(fail)?;
    let canonical = canonical_value(&value).map_err(fail)?;
    output(
        json!({"hash":content_hash(&canonical),"bytes":canonical.len(),"count":ids.len(),"canonical":text(canonical),"ids":ids}),
    )
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EvaluationWire {
    events: Vec<String>,
    bodies: BTreeMap<String, String>,
    selected_view: String,
    import_selections: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    overlay: Option<Value>,
    #[serde(default)]
    limits: jvc_state::Limits,
}
fn evaluation_input(bytes: &[u8]) -> Result<jvc_state::EvaluationInput> {
    let wire: EvaluationWire = serde_json::from_value(parse_json(bytes)?)
        .map_err(|e| Error::new("evaluation", e.to_string()))?;
    let events = wire
        .events
        .iter()
        .map(|s| verify_envelope(s.as_bytes()))
        .collect::<Result<Vec<_>>>()?;
    Ok(jvc_state::EvaluationInput {
        events,
        bodies: wire
            .bodies
            .into_iter()
            .map(|(k, v)| (k, v.into_bytes()))
            .collect(),
        selected_view: wire.selected_view,
        import_selections: wire.import_selections,
        overlay: wire.overlay,
        limits: wire.limits,
    })
}
pub fn evaluate_bytes(bytes: &[u8]) -> Result<Value> {
    let evaluation = jvc_state::evaluate(&evaluation_input(bytes)?);
    let mut value = serde_json::to_value(&evaluation).unwrap();
    let statuses = evaluation
        .publications
        .keys()
        .filter_map(|id| {
            jvc_state::publication_status(&evaluation, id)
                .map(|status| (id.clone(), serde_json::to_value(status).unwrap()))
        })
        .collect::<serde_json::Map<String, Value>>();
    let controls = evaluation
        .accounts
        .iter()
        .map(|(key, account)| {
            (
                key.clone(),
                serde_json::to_value(jvc_state::account_control(
                    &evaluation,
                    "",
                    &account.account.origin,
                    account.account.account,
                ))
                .unwrap(),
            )
        })
        .collect::<serde_json::Map<String, Value>>();
    value["publication_statuses"] = Value::Object(statuses);
    value["account_controls"] = Value::Object(controls);
    Ok(value)
}
#[wasm_bindgen]
pub fn evaluate_records(bytes: &[u8]) -> std::result::Result<String, JsValue> {
    output(evaluate_bytes(bytes).map_err(fail)?)
}
#[wasm_bindgen]
pub fn sign_record(seed: &[u8], bytes: &[u8]) -> std::result::Result<String, JsValue> {
    prepare_signing(bytes)?;
    let seed: &[u8; 32] = seed
        .try_into()
        .map_err(|_| fail(Error::new("key", "seed must contain 32 bytes")))?;
    let header = serde_json::from_value(parse_json(bytes).map_err(fail)?)
        .map_err(|e| fail(Error::new("header", e.to_string())))?;
    let event = jvc_core::sign_header(seed, header).map_err(fail)?;
    output(event.envelope())
}
#[wasm_bindgen]
pub fn identity(seed: &[u8]) -> std::result::Result<String, JsValue> {
    let seed: &[u8; 32] = seed
        .try_into()
        .map_err(|_| fail(Error::new("key", "seed must contain 32 bytes")))?;
    Ok(jvc_core::identity_from_seed(seed))
}
#[wasm_bindgen]
pub fn runtime_word_identifier(bytes: &[u8]) -> std::result::Result<String, JsValue> {
    jvc_core::word_id(&parse_json(bytes).map_err(fail)?).map_err(fail)
}

#[wasm_bindgen]
pub fn prepare_signing(bytes: &[u8]) -> std::result::Result<Vec<u8>, JsValue> {
    let value = parse_json(bytes).map_err(fail)?;
    let object = value
        .as_object()
        .ok_or_else(|| fail(Error::new("header", "header must be an object")))?;
    if object.len() != 6
        || ![
            "version", "issuer", "previous", "nonce", "action", "content",
        ]
        .iter()
        .all(|key| object.contains_key(*key))
    {
        return Err(fail(Error::new(
            "header",
            "header must contain exactly version, issuer, previous, nonce, action, content",
        )));
    }
    let header =
        serde_json::from_value(value).map_err(|e| fail(Error::new("header", e.to_string())))?;
    jvc_core::sshsig_signing_bytes(&header).map_err(fail)
}
#[wasm_bindgen]
pub fn finish_signing(bytes: &[u8], signature: &[u8]) -> std::result::Result<String, JsValue> {
    // The same strict header validation runs before the external signature is accepted.
    prepare_signing(bytes)?;
    let header = serde_json::from_value(parse_json(bytes).map_err(fail)?)
        .map_err(|e| fail(Error::new("header", e.to_string())))?;
    let signature: &[u8; 64] = signature.try_into().map_err(|_| {
        fail(Error::new(
            "signature",
            "Ed25519 signature must contain 64 bytes",
        ))
    })?;
    let event = jvc_core::envelope_from_signature(header, signature).map_err(fail)?;
    output(event.envelope())
}

fn ratio_value(value: &jvc_rank::Rational) -> Value {
    json!({"numerator":value.numer().to_string(),"denominator":value.denom().to_string()})
}
/// Bounded incoming-edge explanations listed with each reviewer.
const REVIEWER_INCOMING_LIMIT: usize = 16;
/// Reviewer details for one target: every actor with an effective verdict,
/// its influence interval, and a bounded list of potential incoming sources.
/// The list does not measure the credit that any route supplies.
/// At most `limit` entries are materialized, in actor order. The second
/// value says whether the list holds every reviewer.
fn reviewer_details(
    graph: &jvc_state::ContextGraph,
    ranking: &jvc_rank::Ranking,
    verdicts: &[jvc_rank::Verdict],
    limit: usize,
) -> (Vec<Value>, bool) {
    let zero = jvc_rank::rational(0, 1);
    let mut incoming: Vec<Vec<usize>> = vec![Vec::new(); graph.actors.len()];
    for (from, row) in graph.rows.iter().enumerate() {
        for edge in row {
            if edge.to < incoming.len() {
                incoming[edge.to].push(from);
            }
        }
    }
    let total = verdicts
        .iter()
        .filter(|verdict| **verdict != jvc_rank::Verdict::Absent)
        .count();
    let listed = verdicts
        .iter()
        .enumerate()
        .filter(|(_, verdict)| **verdict != jvc_rank::Verdict::Absent)
        .take(limit)
        .map(|(index, verdict)| {
            let root = graph.roots.get(index).filter(|q| **q > zero);
            let sources = &incoming[index];
            let listed = sources
                .iter()
                .take(REVIEWER_INCOMING_LIMIT)
                .map(|from| json!(graph.actors[*from]))
                .collect::<Vec<_>>();
            let route_count = sources.len() + usize::from(root.is_some());
            json!({
                "identity": graph.actors[index],
                "verdict": match verdict { jvc_rank::Verdict::Bless => "bless", jvc_rank::Verdict::Curse => "curse", jvc_rank::Verdict::Absent => "absent" },
                "weight": ranking.weights.get(index).map(interval_value).unwrap_or(Value::Null),
                "root": root.map(ratio_value),
                "blocked": graph.blocked.contains(&index),
                "incoming": listed,
                "incoming_count": sources.len(),
                "incoming_complete": sources.len() <= REVIEWER_INCOMING_LIMIT,
                "multiple_routes": route_count > 1,
            })
        })
        .collect();
    (listed, total <= limit)
}
fn interval_value(interval: &jvc_rank::Interval) -> Value {
    json!([ratio_value(&interval.lower), ratio_value(&interval.upper)])
}
fn configuration_ratio(value: &Value) -> Result<jvc_rank::Rational> {
    let n = value["numerator"]
        .as_i64()
        .ok_or_else(|| Error::new("ranking", "configuration numerator unavailable"))?;
    let d = value["denominator"]
        .as_i64()
        .filter(|n| *n > 0)
        .ok_or_else(|| Error::new("ranking", "configuration denominator unavailable"))?;
    Ok(jvc_rank::rational(n, d))
}
pub fn rank_word_bytes(bytes: &[u8], word: &str) -> Result<Value> {
    if !jvc_core::valid_id(word, "jvw1:") {
        return Err(Error::new("word", "word identifier is invalid"));
    }
    let input = evaluation_input(bytes)?;
    let evaluation = jvc_state::evaluate(&input);
    rank_word_state(&input, &evaluation, word, None)
}
/// Ranks one word. `reviewers_limit` asks for bounded reviewer details per
/// score. Without it, the aggregate lookup does no reviewer-detail work and
/// the scores carry no `reviewers` field.
fn rank_word_state(
    input: &jvc_state::EvaluationInput,
    evaluation: &jvc_state::Evaluation,
    word: &str,
    reviewers_limit: Option<usize>,
) -> Result<Value> {
    let mut targets: BTreeMap<String, (jvc_state::Context, bool, String, bool)> = BTreeMap::new();
    for publication in evaluation
        .publications
        .values()
        .filter(|p| p.word == word && p.eligible != jvc_state::Eligibility::NotSelected)
    {
        if publication.kind == "definition.publish" {
            let eligible = publication.eligible == jvc_state::Eligibility::Eligible
                && publication.content_available
                && matches!(
                    publication.status,
                    jvc_state::Status::Active | jvc_state::Status::Deprecated
                );
            targets.insert(
                publication.id.clone(),
                (
                    jvc_state::Context {
                        kind: "definition".into(),
                        word: word.into(),
                        language: publication.language.clone(),
                    },
                    eligible,
                    serde_json::to_value(&publication.status)
                        .unwrap()
                        .as_str()
                        .unwrap()
                        .into(),
                    true,
                ),
            );
        } else if let Some(assignment) = &publication.assignment {
            let status = assignment_status(
                targets.get(assignment).map(|t| t.2.as_str()),
                &publication.eligible,
            );
            let active = status == "active";
            targets.insert(
                assignment.clone(),
                (
                    jvc_state::Context {
                        kind: "rafsi".into(),
                        word: word.into(),
                        language: None,
                    },
                    active,
                    status.into(),
                    false,
                ),
            );
        }
    }
    let policy = evaluation.policy.as_ref();
    let profile = policy
        .map(|policy| {
            jvc_rank::Profile::from_name(policy["calculation"].as_str().unwrap_or_default())
                .ok_or_else(|| {
                    Error::new(
                        "unsupported_calculation",
                        "view calculation profile is unsupported",
                    )
                })
        })
        .transpose()?;
    let params = policy
        .map(|p| {
            Ok(jvc_rank::Parameters {
                h: configuration_ratio(&p["H"])?,
                alpha: configuration_ratio(&p["alpha"])?,
                work: input
                    .overlay
                    .as_ref()
                    .and_then(|v| v["work"].as_u64())
                    .unwrap_or_else(|| p["work"].as_u64().unwrap_or(0)),
            })
        })
        .transpose()?;
    let limits = jvc_rank::Limits::default();
    let mut graphs: BTreeMap<String, jvc_rank::Ranking> = BTreeMap::new();
    let mut unavailable = Vec::new();
    let mut scores = Vec::new();
    let mut scored: BTreeMap<String, (jvc_rank::Candidate, jvc_rank::Score, String, bool)> =
        BTreeMap::new();
    let mut exact = true;
    for (id, (context, eligible, status, definition)) in &targets {
        if status == "inactive" {
            continue;
        }
        if !eligible {
            unavailable.push(id.clone());
            continue;
        }
        let contextual = jvc_state::evaluate_context(evaluation, context);
        if !contextual.available || params.is_none() {
            unavailable.push(id.clone());
            exact = false;
            continue;
        }
        // Reuse weights only when the profile and the complete resolved graph match.
        let mut graph_description = json!({"calculation":contextual.calculation,"actors":contextual.actors,"roots":contextual.roots,"rows":contextual.rows});
        if profile == Some(jvc_rank::Profile::ShunV1) {
            graph_description["refusals"] = json!(contextual.refusals);
        }
        let graph_key = serde_json::to_string(&graph_description).unwrap();
        if !graphs.contains_key(&graph_key) {
            let graph = jvc_rank::Graph::with_refusals(
                profile.unwrap(),
                contextual.actors.clone(),
                contextual.roots.clone(),
                contextual
                    .rows
                    .iter()
                    .map(|row| {
                        row.iter()
                            .map(|e| jvc_rank::Edge {
                                to: e.to,
                                share: e.share.clone(),
                            })
                            .collect()
                    })
                    .collect(),
                contextual.refusals.clone(),
                &limits,
            );
            let ranking =
                graph.and_then(|g| jvc_rank::rank(&g, params.as_ref().unwrap(), limits.clone()));
            match ranking {
                Ok(ranking) => {
                    exact &= ranking.exact;
                    graphs.insert(graph_key.clone(), ranking);
                }
                Err(_) => {
                    unavailable.push(id.clone());
                    exact = false;
                    continue;
                }
            }
        }
        let ranking = &graphs[&graph_key];
        let verdicts = contextual
            .actors
            .iter()
            .map(|actor| {
                match contextual
                    .judgments
                    .get(id)
                    .and_then(|judgments| judgments.get(actor))
                {
                    Some(jvc_state::Judgment::Bless) => jvc_rank::Verdict::Bless,
                    Some(jvc_state::Judgment::Curse) => jvc_rank::Verdict::Curse,
                    _ => jvc_rank::Verdict::Absent,
                }
            })
            .collect::<Vec<_>>();
        let candidate = jvc_rank::Candidate {
            id: id.clone(),
            verdicts,
            eligibility: jvc_rank::Eligibility::Eligible,
            deprecated: status == "deprecated",
        };
        match jvc_rank::score_with_limits(&candidate, &ranking.weights, &limits) {
            Ok(score) => {
                let reviewers = candidate
                    .verdicts
                    .iter()
                    .filter(|v| **v != jvc_rank::Verdict::Absent)
                    .count();
                let mut entry = json!({"target":id,"support":interval_value(&score.support),"opposition":interval_value(&score.opposition),"net":interval_value(&score.net),"direct_reviewers":reviewers,"status":status});
                if let Some(limit) = reviewers_limit {
                    let (details, complete) =
                        reviewer_details(&contextual, ranking, &candidate.verdicts, limit);
                    entry["reviewers"] = Value::Array(details);
                    entry["reviewers_complete"] = Value::Bool(complete);
                }
                scores.push(entry);
                scored.insert(id.clone(), (candidate, score, graph_key, *definition));
            }
            Err(_) => {
                unavailable.push(id.clone());
                exact = false;
            }
        }
    }
    let ids = scored
        .iter()
        .filter(|(_, value)| value.3)
        .map(|(id, _)| id.clone())
        .collect::<Vec<_>>();
    if ids.len().saturating_mul(ids.len().saturating_sub(1)) / 2 > limits.max_candidate_pairs {
        return Err(Error::new(
            "resource_unavailable",
            "candidate pair limit exceeded",
        ));
    }
    let mut higher: BTreeMap<String, std::collections::BTreeSet<String>> = ids
        .iter()
        .map(|id| (id.clone(), Default::default()))
        .collect();
    let mut comparison_terms = 0usize;
    for (position, a) in ids.iter().enumerate() {
        for b in &ids[position + 1..] {
            let (ca, sa, ga, _) = &scored[a];
            let (cb, sb, gb, _) = &scored[b];
            if ca.deprecated != cb.deprecated {
                if ca.deprecated {
                    higher.get_mut(a).unwrap().insert(b.clone());
                } else {
                    higher.get_mut(b).unwrap().insert(a.clone());
                }
                continue;
            }
            if ga == gb {
                comparison_terms = comparison_terms
                    .checked_add(graphs[ga].weights.len())
                    .ok_or_else(|| {
                        Error::new("resource_unavailable", "candidate actor terms overflow")
                    })?;
                if comparison_terms > limits.max_candidate_actor_terms {
                    return Err(Error::new(
                        "resource_unavailable",
                        "candidate actor term limit exceeded",
                    ));
                }
            }
            let difference = if ga == gb {
                jvc_rank::difference_with_limits(ca, cb, &graphs[ga].weights, &limits)
                    .map_err(|e| Error::new("resource_unavailable", e.to_string()))?
            } else {
                jvc_rank::separate_difference(sa, sb)
            };
            let zero = jvc_rank::rational(0, 1);
            if difference.lower > zero {
                higher.get_mut(b).unwrap().insert(a.clone());
            }
            if difference.upper < zero {
                higher.get_mut(a).unwrap().insert(b.clone());
            }
        }
    }
    let mut layers = Vec::<Vec<String>>::new();
    while !higher.is_empty() {
        let layer = higher
            .iter()
            .filter(|(_, higher)| higher.is_empty())
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        if layer.is_empty() {
            return Err(Error::new(
                "ranking",
                "certified preference relation has a cycle",
            ));
        }
        for id in &layer {
            higher.remove(id);
        }
        for h in higher.values_mut() {
            for id in &layer {
                h.remove(id);
            }
        }
        layers.push(layer);
    }
    let calculation = if graphs.is_empty() {
        Value::Null
    } else {
        let default_overlay = json!({"version":1,"base_view":input.selected_view,"root_changes":[],"trust":[],"blocked":[],"work":null});
        let overlay = input.overlay.as_ref().unwrap_or(&default_overlay);
        let suspensions=evaluation.lifecycle.suspended.iter().flat_map(|(identity,causes)|causes.iter().map(move|cause|json!({"identity":identity,"cause":cause,"reason":"incomplete_history"}))).collect::<Vec<_>>();
        json!({"algorithm":profile.unwrap().name(),"budget":params.as_ref().unwrap().work,"completed":graphs.values().map(|r|r.completed_work).sum::<u64>(),"exact":exact,"overlay":jvc_core::hash_id("sha256:",b"",&canonical_value(overlay)?),"incomplete_identities":evaluation.lifecycle.suspended.keys().collect::<Vec<_>>(),"suspensions":suspensions})
    };
    Ok(
        json!({"calculation":calculation,"scores":scores,"layers":layers,"unavailable_scores":unavailable}),
    )
}
#[wasm_bindgen]
pub fn rank_word(bytes: &[u8], word: &str) -> std::result::Result<String, JsValue> {
    output(rank_word_bytes(bytes, word).map_err(fail)?)
}

#[wasm_bindgen]
pub struct EvaluationSession {
    input: jvc_state::EvaluationInput,
    evaluation: jvc_state::Evaluation,
}
#[wasm_bindgen]
impl EvaluationSession {
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8]) -> std::result::Result<EvaluationSession, JsValue> {
        let input = evaluation_input(bytes).map_err(fail)?;
        let evaluation = jvc_state::evaluate(&input);
        Ok(Self { input, evaluation })
    }
    pub fn state(&self) -> std::result::Result<String, JsValue> {
        let mut value = serde_json::to_value(&self.evaluation).unwrap();
        value["publication_statuses"] = json!(
            self.evaluation
                .publications
                .keys()
                .filter_map(|id| jvc_state::publication_status(&self.evaluation, id)
                    .map(|status| (id.clone(), status)))
                .collect::<BTreeMap<_, _>>()
        );
        value["account_controls"] = json!(
            self.evaluation
                .accounts
                .iter()
                .map(|(key, account)| (
                    key.clone(),
                    jvc_state::account_control(
                        &self.evaluation,
                        "",
                        &account.account.origin,
                        account.account.account
                    )
                ))
                .collect::<BTreeMap<_, _>>()
        );
        output(value)
    }
    pub fn rank(&self, word: &str) -> std::result::Result<String, JsValue> {
        output(rank_word_state(&self.input, &self.evaluation, word, None).map_err(fail)?)
    }
    /// Ranks one word with at most `reviewers` reviewer details per score.
    pub fn rank_with_reviewers(
        &self,
        word: &str,
        reviewers: usize,
    ) -> std::result::Result<String, JsValue> {
        output(rank_word_state(&self.input, &self.evaluation, word, Some(reviewers)).map_err(fail)?)
    }
}

/// Word-form tools. Requests and results cross as JSON. A builder error is a
/// JSON object with `kind` of `invalid` or `resource-limit`.
fn builder_fail(e: jvc_morphology::BuilderError) -> JsValue {
    JsValue::from_str(&serde_json::to_string(&e).unwrap())
}
/// The serialized byte ceiling of one builder request.
///
/// A search package holds at most 200,000 entries. An inventory built from
/// such a package lists each gismu with its word ID and each rafsi claim
/// with its pair ID, about 150 bytes per row, so a full inventory needs
/// about 30 MiB. The ceiling leaves room above that. Bytes beyond it are
/// refused before any allocation, including bytes in fields the request
/// shape ignores. The typed limits of the morphology crate apply after
/// parsing.
pub const BUILDER_INPUT_LIMIT: usize = 64 * 1024 * 1024;
fn builder_input_checked<T: serde::de::DeserializeOwned>(
    bytes: &[u8],
) -> std::result::Result<T, jvc_morphology::BuilderError> {
    if bytes.len() > BUILDER_INPUT_LIMIT {
        return Err(jvc_morphology::BuilderError::ResourceLimit {
            measure: "request bytes".into(),
            value: bytes.len() as u64,
            limit: BUILDER_INPUT_LIMIT as u64,
        });
    }
    serde_json::from_slice(bytes).map_err(|e| jvc_morphology::BuilderError::Invalid {
        message: format!("The request is malformed: {e}"),
    })
}
fn builder_input<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> std::result::Result<T, JsValue> {
    builder_input_checked(bytes).map_err(builder_fail)
}
#[wasm_bindgen]
pub fn builder_presets() -> std::result::Result<String, JsValue> {
    output(jvc_morphology::builder_presets())
}
#[wasm_bindgen]
pub fn analyze_word(profile: &str, spelling: &str) -> std::result::Result<String, JsValue> {
    let profile = match profile {
        "cll" => jvc_morphology::Profile::Cll,
        "extended" => jvc_morphology::Profile::Extended,
        _ => {
            return Err(builder_fail(jvc_morphology::BuilderError::Invalid {
                message: "The profile is cll or extended.".into(),
            }));
        }
    };
    output(jvc_morphology::analyze_word(profile, spelling))
}
#[wasm_bindgen]
pub fn build_lujvo(bytes: &[u8]) -> std::result::Result<String, JsValue> {
    let request: jvc_morphology::LujvoRequest = builder_input(bytes)?;
    output(jvc_morphology::build_lujvo(&request).map_err(builder_fail)?)
}
#[wasm_bindgen]
pub fn generate_gismu(bytes: &[u8]) -> std::result::Result<String, JsValue> {
    let request: jvc_morphology::GismuRequest = builder_input(bytes)?;
    output(jvc_morphology::generate_gismu(&request).map_err(builder_fail)?)
}
fn assignment_status(current: Option<&str>, eligibility: &jvc_state::Eligibility) -> &'static str {
    if current == Some("active") || *eligibility == jvc_state::Eligibility::Eligible {
        "active"
    } else if current == Some("unavailable") || *eligibility != jvc_state::Eligibility::Inactive {
        "unavailable"
    } else {
        "inactive"
    }
}
#[cfg(test)]
mod builder_input_tests {
    use super::{BUILDER_INPUT_LIMIT, builder_input_checked};
    use jvc_morphology::{BuilderError, LujvoRequest};
    #[test]
    fn a_request_over_the_byte_ceiling_is_refused_before_parsing() {
        // An ignored field carries the bulk. Nothing is parsed or allocated for it.
        let mut bytes = br#"{"profile":"cll","components":[],"ignored":""#.to_vec();
        bytes.resize(BUILDER_INPUT_LIMIT + 1, b'x');
        let result: Result<LujvoRequest, BuilderError> = builder_input_checked(&bytes);
        match result {
            Err(BuilderError::ResourceLimit {
                measure,
                value,
                limit,
            }) => {
                assert_eq!(measure, "request bytes");
                assert_eq!(value, (BUILDER_INPUT_LIMIT + 1) as u64);
                assert_eq!(limit, BUILDER_INPUT_LIMIT as u64);
            }
            other => panic!("expected a resource limit, got {other:?}"),
        }
    }
    #[test]
    fn a_request_at_the_ceiling_is_parsed() {
        let mut bytes = br#"{"profile":"cll","components":[],"ignored":""#.to_vec();
        bytes.resize(BUILDER_INPUT_LIMIT - 2, b'x');
        bytes.extend_from_slice(br#""}"#);
        assert_eq!(bytes.len(), BUILDER_INPUT_LIMIT);
        let result: Result<LujvoRequest, BuilderError> = builder_input_checked(&bytes);
        assert!(result.is_ok(), "{result:?}");
    }
    #[test]
    fn a_malformed_request_under_the_ceiling_is_invalid() {
        let result: Result<LujvoRequest, BuilderError> = builder_input_checked(b"{");
        assert!(matches!(result, Err(BuilderError::Invalid { .. })));
    }
}
#[cfg(test)]
mod aggregation_tests {
    use super::assignment_status;
    use jvc_state::Eligibility;
    #[test]
    fn unavailable_assignment_claim_survives_both_identifier_orders() {
        for claims in [
            [Eligibility::Inactive, Eligibility::Unknown],
            [Eligibility::Unknown, Eligibility::Inactive],
        ] {
            let mut status = None;
            for claim in claims {
                status = Some(assignment_status(status, &claim));
            }
            assert_eq!(status, Some("unavailable"));
            assert_eq!(assignment_status(status, &Eligibility::Eligible), "active");
        }
    }
}
