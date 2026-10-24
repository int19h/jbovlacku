//! Portable service entry points with separate wire and trusted host ports.
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
#[derive(Serialize)]
struct StateOutput<'a> {
    #[serde(flatten)]
    evaluation: &'a jvc_state::Evaluation,
    publication_statuses: PublicationStatuses<'a>,
    account_controls: AccountControls<'a>,
}
impl<'a> StateOutput<'a> {
    fn new(evaluation: &'a jvc_state::Evaluation) -> Self {
        Self {
            evaluation,
            publication_statuses: PublicationStatuses(evaluation),
            account_controls: AccountControls(evaluation),
        }
    }
}
struct PublicationStatuses<'a>(&'a jvc_state::Evaluation);
impl Serialize for PublicationStatuses<'_> {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(Some(self.0.publications.len()))?;
        for id in self.0.publications.keys() {
            if let Some(status) = jvc_state::publication_status(self.0, id) {
                map.serialize_entry(id, &status)?;
            }
        }
        map.end()
    }
}
struct AccountControls<'a>(&'a jvc_state::Evaluation);
impl Serialize for AccountControls<'_> {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(Some(self.0.accounts.len()))?;
        for (key, account) in &self.0.accounts {
            map.serialize_entry(
                key,
                &jvc_state::account_control(
                    self.0,
                    "",
                    &account.account.origin,
                    account.account.account,
                ),
            )?;
        }
        map.end()
    }
}

const STATE_DELTA_LIMIT: usize = 1024 * 1024;
struct LimitedOutput(Vec<u8>);
impl std::io::Write for LimitedOutput {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > STATE_DELTA_LIMIT.saturating_sub(self.0.len()) {
            return Err(std::io::Error::other("state delta exceeds size limit"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn bounded_delta(value: impl Serialize) -> String {
    let mut writer = LimitedOutput(Vec::new());
    if serde_json::to_writer(&mut writer, &value).is_err() {
        return "null".into();
    }
    String::from_utf8(writer.0).unwrap()
}
thread_local! {
    static NEXT_SESSION: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}
fn session_identity() -> String {
    NEXT_SESSION.with(|next| {
        let value = next
            .get()
            .checked_add(1)
            .expect("session identity exhausted");
        next.set(value);
        format!("session-{value}")
    })
}

pub fn evaluate_bytes(bytes: &[u8]) -> Result<Value> {
    let evaluation = jvc_state::evaluate(&evaluation_input(bytes)?);
    Ok(serde_json::to_value(StateOutput::new(&evaluation)).unwrap())
}
#[wasm_bindgen]
pub fn evaluate_records(bytes: &[u8]) -> std::result::Result<String, JsValue> {
    let evaluation = jvc_state::evaluate(&evaluation_input(bytes).map_err(fail)?);
    output(StateOutput::new(&evaluation))
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
    block_reasons: bool,
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
            let mut detail = json!({
                "identity": graph.actors[index],
                "verdict": match verdict { jvc_rank::Verdict::Bless => "bless", jvc_rank::Verdict::Curse => "curse", jvc_rank::Verdict::Absent => "absent" },
                "weight": ranking.weights.get(index).map(interval_value).unwrap_or(Value::Null),
                "root": root.map(ratio_value),
                "blocked": graph.blocked.contains(&index),
                "incoming": listed,
                "incoming_count": sources.len(),
                "incoming_complete": sources.len() <= REVIEWER_INCOMING_LIMIT,
                "multiple_routes": route_count > 1,
            });
            if block_reasons && graph.public_shun_blocked.contains(&index) {
                detail["public_shun_block"] = json!(true);
            }
            if block_reasons && graph.private_blocked.contains(&index) {
                detail["private_block"] = json!(true);
            }
            detail
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
    let evaluation = jvc_state::evaluate(&evaluation_input(bytes)?);
    rank_word_state(&evaluation, word, None)
}
/// Ranks one word. `reviewers_limit` asks for bounded reviewer details per
/// score. Without it, the aggregate lookup does no reviewer-detail work and
/// the scores carry no `reviewers` field.
fn rank_word_state(
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
                work: evaluation
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
                    let (details, complete) = reviewer_details(
                        &contextual,
                        ranking,
                        &candidate.verdicts,
                        limit,
                        evaluation
                            .overlay
                            .as_ref()
                            .is_some_and(|overlay| overlay["version"] == 2),
                    );
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
        let default_overlay = json!({"version":1,"base_view":evaluation.selected_view,"root_changes":[],"trust":[],"blocked":[],"work":null});
        let overlay = evaluation.overlay.as_ref().unwrap_or(&default_overlay);
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
    state: jvc_state::EvaluatedState,
    identity: String,
    base_identity: Option<String>,
}
/// Build a session from original records without one combined request.
#[wasm_bindgen]
pub struct EvaluationSessionBuilder {
    prepared: jvc_state::PreparedEvaluationInput,
    verifier: jvc_core::EnvelopeVerifier,
    base: Option<jvc_state::EvaluatedState>,
    removed: Vec<String>,
    base_identity: Option<String>,
}
#[wasm_bindgen]
pub fn evaluation_checkpoint_version() -> String {
    jvc_state::CHECKPOINT_VERSION.into()
}
fn search_projection(
    id: &str,
    header: &jvc_core::Header,
    availability: &jvc_core::BodyAvailability,
) -> Value {
    let kind = header.action["kind"].as_str().unwrap_or_default();
    if !matches!(kind, "definition.publish" | "rafsi.publish") {
        return Value::Null;
    }
    let body = if let jvc_core::BodyAvailability::Valid { body } = availability {
        let selected = if kind == "definition.publish" {
            &[
                "word",
                "language",
                "text",
                "glosses",
                "classification",
                "notes",
            ][..]
        } else {
            &["rafsi"][..]
        };
        let mut fields: serde_json::Map<String, Value> = body
            .as_object()
            .unwrap()
            .iter()
            .filter(|(key, _)| selected.contains(&key.as_str()))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        if kind == "definition.publish" {
            if let Some(legacy) = body.get("legacy") {
                let legacy = if let Some(legacy) = legacy.as_object() {
                    let mut result = serde_json::Map::new();
                    if let Some(source) = legacy.get("source") {
                        result.insert("source".into(), source.clone());
                    }
                    if let Some(attribution) = legacy.get("attribution") {
                        let attribution = if let Some(fields) = attribution.as_object() {
                            Value::Object(
                                fields
                                    .iter()
                                    .filter(|(key, _)| {
                                        matches!(
                                            key.as_str(),
                                            "author" | "author_account" | "dates"
                                        )
                                    })
                                    .map(|(key, value)| (key.clone(), value.clone()))
                                    .collect(),
                            )
                        } else {
                            attribution.clone()
                        };
                        result.insert("attribution".into(), attribution);
                    }
                    Value::Object(result)
                } else {
                    legacy.clone()
                };
                fields.insert("legacy".into(), legacy);
            }
        }
        Value::Object(fields)
    } else {
        Value::Null
    };
    json!({"id":id,"issuer":header.issuer,"kind":kind,"word":header.action["word"],"body_hash":header.content.as_ref().map(|c| &c.hash),"body":body})
}
// Versioned golden files in tests/fixtures are immutable. A projection change needs a new version.
pub const HOST_RECORD_VERSION: u32 = 1;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct HostRecord {
    version: u32,
    id: String,
    state: jvc_state::HostVerifiedRecord,
    package: Value,
    body_status: String,
    action_valid: bool,
}
/// Only private host storage can supply the admitted original bytes.
pub fn extract_host_record_bytes(envelope: &[u8], body: Option<&[u8]>) -> Result<Vec<u8>> {
    let event: jvc_core::Envelope =
        serde_json::from_slice(envelope).map_err(|e| Error::new("host_record", e.to_string()))?;
    let availability = jvc_core::inspect_host_stored_body(&event.header, body);
    let body_status = match &availability {
        jvc_core::BodyAvailability::Absent => "none",
        jvc_core::BodyAvailability::Missing => "missing",
        jvc_core::BodyAvailability::Valid { .. } => "present",
        jvc_core::BodyAvailability::Invalid { .. } => "invalid",
    }
    .into();
    let (state, package) = jvc_state::HostVerifiedRecord::extract_with(
        &event.id,
        &event.header,
        availability,
        |availability| search_projection(&event.id, &event.header, availability),
    );
    serde_json::to_vec(&HostRecord {
        version: HOST_RECORD_VERSION,
        id: event.id,
        state,
        package,
        body_status,
        action_valid: jvc_core::validate_action(&event.header).is_ok(),
    })
    .map_err(|e| Error::new("host_record", e.to_string()))
}
#[wasm_bindgen]
pub fn host_record_version() -> u32 {
    HOST_RECORD_VERSION
}
#[wasm_bindgen]
pub fn extract_host_verified_record(
    envelope: &[u8],
    body: Option<Vec<u8>>,
) -> std::result::Result<Vec<u8>, JsValue> {
    extract_host_record_bytes(envelope, body.as_deref()).map_err(fail)
}
#[wasm_bindgen]
pub fn inspect_host_stored_body(
    header: &[u8],
    body: Option<Vec<u8>>,
) -> std::result::Result<String, JsValue> {
    let header = serde_json::from_slice(header)
        .map_err(|e| fail(Error::new("host_record", e.to_string())))?;
    output(jvc_core::inspect_host_stored_body(&header, body.as_deref()))
}
/// Check a stored projection's extraction schema without authenticating it again.
#[wasm_bindgen]
pub fn check_host_verified_record(bytes: &[u8]) -> std::result::Result<String, JsValue> {
    decode_host_record(bytes)
        .map(|record| record.id)
        .map_err(fail)
}
fn decode_host_record(bytes: &[u8]) -> Result<HostRecord> {
    let record: HostRecord =
        serde_json::from_slice(bytes).map_err(|e| Error::new("host_record", e.to_string()))?;
    if record.version != HOST_RECORD_VERSION || record.id != record.state.id() {
        return Err(Error::new(
            "host_record",
            "extraction version or event ID does not match",
        ));
    }
    Ok(record)
}

#[wasm_bindgen]
impl EvaluationSessionBuilder {
    #[wasm_bindgen(constructor)]
    pub fn new(options: &[u8]) -> std::result::Result<Self, JsValue> {
        let options = serde_json::from_value(parse_json(options).map_err(fail)?)
            .map_err(|e| fail(Error::new("evaluation", e.to_string())))?;
        Ok(Self {
            prepared: jvc_state::PreparedEvaluationInput::new(options),
            verifier: jvc_core::EnvelopeVerifier::default(),
            base: None,
            removed: Vec::new(),
            base_identity: None,
        })
    }
    pub fn add_record(
        &mut self,
        envelope: &[u8],
        body: Option<Vec<u8>>,
    ) -> std::result::Result<String, JsValue> {
        let event = self.verifier.verify(envelope).map_err(fail)?;
        let content = self
            .prepared
            .add_record_with(&event, body.as_deref(), |availability| {
                search_projection(event.id(), event.header(), availability)
            });
        output(content)
    }
    /// The host must obtain this record from its private admission store.
    pub fn add_host_verified_record(
        &mut self,
        bytes: &[u8],
    ) -> std::result::Result<String, JsValue> {
        let record = decode_host_record(bytes).map_err(fail)?;
        self.prepared.add_host_verified_record(record.state);
        output(record.package)
    }
    pub fn finish(self) -> EvaluationSession {
        EvaluationSession {
            identity: session_identity(),
            base_identity: self.base_identity,
            state: match self.base {
                Some(base) => base.advance(self.prepared, &self.removed),
                None => self.prepared.into_state(),
            },
        }
    }
    pub fn remove_record(&mut self, id: &str) {
        self.removed.push(id.into());
    }
}
#[wasm_bindgen]
impl EvaluationSession {
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8]) -> std::result::Result<EvaluationSession, JsValue> {
        let state = jvc_state::EvaluatedState::from_input(&evaluation_input(bytes).map_err(fail)?);
        Ok(Self {
            state,
            identity: session_identity(),
            base_identity: None,
        })
    }
    pub fn fork(&self, options: &[u8]) -> std::result::Result<EvaluationSessionBuilder, JsValue> {
        let mut builder = EvaluationSessionBuilder::new(options)?;
        builder.base = Some(self.state.clone());
        builder.base_identity = Some(self.identity.clone());
        Ok(builder)
    }
    pub fn checkpoint(&self, binding: &str) -> std::result::Result<Vec<u8>, JsValue> {
        self.state.checkpoint(binding).map_err(fail)
    }
    pub fn result_checkpoint(&self, binding: &str) -> std::result::Result<Vec<u8>, JsValue> {
        self.state.result_checkpoint(binding).map_err(fail)
    }
    /// Records come from private storage, independently of the result checkpoint.
    pub fn restore_host_result_checkpoint(
        bytes: &[u8],
        binding: &str,
        records: &[u8],
    ) -> std::result::Result<EvaluationSession, JsValue> {
        let records: Vec<HostRecord> = serde_json::from_slice(records)
            .map_err(|e| fail(Error::new("host_record", e.to_string())))?;
        if records
            .iter()
            .any(|r| r.version != HOST_RECORD_VERSION || r.id != r.state.id())
        {
            return Err(fail(Error::new(
                "host_record",
                "extraction version or event ID does not match",
            )));
        }
        Ok(Self {
            identity: session_identity(),
            base_identity: None,
            state: jvc_state::EvaluatedState::restore_host_result_checkpoint(
                bytes,
                binding,
                records.into_iter().map(|r| r.state).collect(),
            )
            .map_err(fail)?,
        })
    }
    /// The host must check an independent trusted digest and exact binding first.
    pub fn restore_host_checkpoint(
        bytes: &[u8],
        binding: &str,
    ) -> std::result::Result<EvaluationSession, JsValue> {
        Ok(Self {
            identity: session_identity(),
            base_identity: None,
            state: jvc_state::EvaluatedState::restore_host_checkpoint(bytes, binding)
                .map_err(fail)?,
        })
    }
    pub fn update_statistics(&self) -> std::result::Result<String, JsValue> {
        output(self.state.statistics())
    }
    pub fn state_identity(&self) -> String {
        self.identity.clone()
    }
    /// A bounded patch for the exact parent session, or JSON null.
    pub fn state_delta(&self) -> String {
        let (Some(base), Some(changes)) = (&self.base_identity, self.state.judgment_changes())
        else {
            return "null".into();
        };
        let e = self.state.evaluation();
        let receipts: BTreeMap<_, _> = changes
            .receipts
            .iter()
            .map(|k| (k, &e.receipts[k]))
            .collect();
        let registers: BTreeMap<_, _> = changes
            .registers
            .iter()
            .map(|k| (k, &e.registers[k]))
            .collect();
        let judgments: BTreeMap<_, BTreeMap<_, _>> = changes
            .judgments
            .iter()
            .map(|(target, actors)| {
                (
                    target,
                    actors
                        .iter()
                        .map(|actor| (actor, &e.judgments[target][actor]))
                        .collect(),
                )
            })
            .collect();
        let key_actor: BTreeMap<_, _> = changes
            .actors
            .iter()
            .map(|k| (k, &e.lifecycle.key_actor[k]))
            .collect();
        let groups: BTreeMap<_, _> = changes
            .actors
            .iter()
            .map(|k| (k, &e.lifecycle.groups[k]))
            .collect();
        #[derive(Serialize)]
        struct Delta<'a, R: Serialize, G: Serialize, J: Serialize, L: Serialize> {
            version: u8,
            base_session: &'a str,
            receipts: R,
            registers: G,
            judgments: J,
            lifecycle: L,
        }
        #[derive(Serialize)]
        struct Lifecycle<K: Serialize, G: Serialize> {
            key_actor: K,
            groups: G,
        }
        bounded_delta(Delta {
            version: 1,
            base_session: base,
            receipts,
            registers,
            judgments,
            lifecycle: Lifecycle { key_actor, groups },
        })
    }
    pub fn state(&self) -> std::result::Result<String, JsValue> {
        output(StateOutput::new(self.state.evaluation()))
    }
    pub fn rank(&self, word: &str) -> std::result::Result<String, JsValue> {
        output(rank_word_state(self.state.evaluation(), word, None).map_err(fail)?)
    }
    /// Ranks one word with at most `reviewers` reviewer details per score.
    pub fn rank_with_reviewers(
        &self,
        word: &str,
        reviewers: usize,
    ) -> std::result::Result<String, JsValue> {
        output(rank_word_state(self.state.evaluation(), word, Some(reviewers)).map_err(fail)?)
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
        "extended-v2" => jvc_morphology::Profile::ExtendedV2,
        _ => {
            return Err(builder_fail(jvc_morphology::BuilderError::Invalid {
                message: "The profile is cll, extended, or extended-v2.".into(),
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

#[cfg(test)]
mod state_output_tests {
    use super::*;

    #[test]
    fn state_delta_writer_accepts_the_limit_and_falls_back_above_it() {
        let at_limit = "x".repeat(STATE_DELTA_LIMIT - 2);
        assert_eq!(bounded_delta(&at_limit).len(), STATE_DELTA_LIMIT);
        assert_eq!(bounded_delta(format!("{at_limit}x")), "null");
    }

    #[test]
    fn borrowed_state_output_matches_the_previous_value_shape() {
        let evaluation = jvc_state::evaluate(
            &evaluation_input(include_bytes!("../tests/invalid-overlay.json")).unwrap(),
        );
        let mut previous = serde_json::to_value(&evaluation).unwrap();
        previous["publication_statuses"] = json!(
            evaluation
                .publications
                .keys()
                .filter_map(
                    |id| jvc_state::publication_status(&evaluation, id).map(|status| (id, status))
                )
                .collect::<BTreeMap<_, _>>()
        );
        previous["account_controls"] = json!(
            evaluation
                .accounts
                .iter()
                .map(|(key, account)| (
                    key,
                    jvc_state::account_control(
                        &evaluation,
                        "",
                        &account.account.origin,
                        account.account.account
                    )
                ))
                .collect::<BTreeMap<_, _>>()
        );
        assert_eq!(
            serde_json::to_value(StateOutput::new(&evaluation)).unwrap(),
            previous
        );
    }
}
