#![cfg(not(target_arch = "wasm32"))]

use jvc_runtime::{EvaluationSession, EvaluationSessionBuilder};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Deserialize)]
struct Input {
    events: Vec<String>,
    bodies: BTreeMap<String, String>,
    selected_view: String,
    import_selections: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    limits: jvc_state::Limits,
}
#[derive(Serialize)]
struct RequestRef<'a> {
    events: &'a [String],
    bodies: &'a BTreeMap<String, String>,
    selected_view: &'a str,
    import_selections: &'a BTreeMap<String, Vec<String>>,
    overlay: Option<&'a Value>,
    limits: &'a jvc_state::Limits,
}
fn request(input: &Input, overlay: Option<&Value>) -> Vec<u8> {
    serde_json::to_vec(&RequestRef {
        events: &input.events,
        bodies: &input.bodies,
        selected_view: &input.selected_view,
        import_selections: &input.import_selections,
        overlay,
        limits: &input.limits,
    })
    .unwrap()
}
fn ranking_hash(session: &EvaluationSession, words: &BTreeSet<String>) -> String {
    let mut hash = Sha256::new();
    for word in words {
        let ranking = session.rank(word).unwrap();
        hash.update((ranking.len() as u64).to_le_bytes());
        hash.update(ranking.as_bytes());
    }
    hex::encode(hash.finalize())
}
fn overlay(input: &Input, issuer: Option<String>) -> Value {
    serde_json::json!({
        "version": 2,
        "public_shun_issuer": issuer,
        "base_view": input.selected_view,
        "root_changes": [],
        "trust": [],
        "blocked": [],
        "work": null,
    })
}
fn assert_overlay_parity(base: &EvaluationSession, input: &Input, overlay: Option<Value>) {
    let actual = base
        .with_overlay(
            overlay
                .as_ref()
                .map(|value| serde_json::to_vec(value).unwrap()),
        )
        .unwrap();
    let expected = EvaluationSession::new(&request(input, overlay.as_ref())).unwrap();
    assert_eq!(actual.state().unwrap(), expected.state().unwrap());
    assert_eq!(actual.actors().unwrap(), expected.actors().unwrap());
}

#[test]
#[ignore = "requires JVC_STREAMED_LOAD_INPUT and a release build for practical ranking time"]
fn full_data_streamed_load_and_overlay_match_whole_input() {
    let path = std::env::var("JVC_STREAMED_LOAD_INPUT")
        .expect("set JVC_STREAMED_LOAD_INPUT to the authorized full-data JSON input");
    let bytes = std::fs::read(path).unwrap();
    let whole = EvaluationSession::new(&bytes).unwrap();
    let input: Input = serde_json::from_slice(&bytes).unwrap();
    drop(bytes);

    let mut records = Vec::with_capacity(input.events.len());
    let mut words = BTreeSet::new();
    for envelope in &input.events {
        let value: Value = serde_json::from_str(envelope).unwrap();
        let id = value["id"].as_str().unwrap().to_owned();
        let word = value["header"]["action"]["word"]
            .as_str()
            .map(str::to_owned);
        if let Some(word) = &word {
            words.insert(word.clone());
        }
        records.push((id, envelope, word));
    }
    records.sort_by(|left, right| left.0.cmp(&right.0));
    let options = serde_json::to_vec(&serde_json::json!({
        "selected_view": input.selected_view,
        "import_selections": input.import_selections,
        "limits": input.limits,
    }))
    .unwrap();
    let mut builder = EvaluationSessionBuilder::new(&options).unwrap();
    let mut projected_builder = EvaluationSessionBuilder::new(&options).unwrap();
    let mut projection_verifier = jvc_core::EnvelopeVerifier::default();
    for (id, envelope, _) in &records {
        builder
            .add_record_text(envelope, input.bodies.get(id).cloned(), None)
            .unwrap();
        let event = projection_verifier.verify(envelope.as_bytes()).unwrap();
        let row =
            jvc_state::ProjectionRow::extract(&event, input.bodies.get(id).map(String::as_bytes));
        let encoded = row.encode().unwrap();
        let decoded = jvc_state::ProjectionRow::decode(&encoded).unwrap();
        assert_eq!(decoded, row, "projection changed record {id}");
        projected_builder
            .add_projection_row(&encoded, Some(id.clone()), None)
            .unwrap();
    }
    let streamed = builder.finish();
    let projected = projected_builder.finish();
    let whole_state = whole.state().unwrap();
    assert_eq!(streamed.state().unwrap(), whole_state);
    assert_eq!(streamed.actors().unwrap(), whole.actors().unwrap());
    assert_eq!(projected.state().unwrap(), whole_state);
    assert_eq!(projected.actors().unwrap(), whole.actors().unwrap());

    let streamed_rankings = if std::env::var_os("JVC_STREAMED_LOAD_OVERLAY_ONLY").is_some() {
        None
    } else {
        let streamed_rankings = ranking_hash(&streamed, &words);
        let projected_rankings = ranking_hash(&projected, &words);
        let whole_rankings = ranking_hash(&whole, &words);
        assert_eq!(streamed_rankings, whole_rankings);
        assert_eq!(projected_rankings, whole_rankings);
        Some(streamed_rankings)
    };

    assert_overlay_parity(&streamed, &input, None);
    assert_overlay_parity(&streamed, &input, Some(overlay(&input, None)));
    assert_overlay_parity(
        &streamed,
        &input,
        Some(serde_json::json!({"invalid": true})),
    );
    let state: Value = serde_json::from_str(&whole_state).unwrap();
    let suspended: BTreeSet<&str> = state["lifecycle"]["suspended"]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    if let Some(issuer) = state["lifecycle"]["key_actor"]
        .as_object()
        .unwrap()
        .iter()
        .find(|(_, actor)| suspended.contains(actor.as_str().unwrap()))
        .map(|(key, _)| key.clone())
    {
        assert_overlay_parity(&streamed, &input, Some(overlay(&input, Some(issuer))));
    } else {
        println!(
            "the full-data fixture has no suspended issuer; the small fixture covers that case"
        );
    }
    println!(
        "streamed load parity: {} records, {} words, ranking SHA-256 {}",
        input.events.len(),
        words.len(),
        streamed_rankings.as_deref().unwrap_or("not rerun")
    );
}
