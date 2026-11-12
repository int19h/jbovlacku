use jvc_state::{EvaluatedState, EvaluationOptions, Limits, PreparedEvaluationInput};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;

#[derive(Deserialize)]
struct Wire {
    events: Vec<String>,
    bodies: BTreeMap<String, String>,
    selected_view: String,
    import_selections: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    overlay: Option<Value>,
    #[serde(default)]
    limits: Limits,
}

fn options(wire: &Wire, limits: Limits) -> EvaluationOptions {
    EvaluationOptions {
        selected_view: wire.selected_view.clone(),
        import_selections: wire.import_selections.clone(),
        overlay: wire.overlay.clone(),
        limits,
    }
}

fn build_state(wire: &Wire, limits: Limits) -> EvaluatedState {
    let mut prepared = PreparedEvaluationInput::new(options(wire, limits));
    let mut verifier = jvc_core::EnvelopeVerifier::default();
    for raw in &wire.events {
        let event = verifier.verify(raw.as_bytes()).unwrap();
        prepared.add_record(&event, wire.bodies.get(event.id()).map(String::as_bytes));
    }
    prepared.into_state()
}

fn build_projection_session(wire: &Wire) -> jvc_runtime::EvaluationSession {
    let options = serde_json::to_vec(&options(wire, wire.limits.clone())).unwrap();
    let mut builder = jvc_runtime::EvaluationSessionBuilder::new(&options).unwrap();
    let mut verifier = jvc_core::EnvelopeVerifier::default();
    for raw in &wire.events {
        let event = verifier.verify(raw.as_bytes()).unwrap();
        let row = jvc_state::ProjectionRow::extract(
            &event,
            wire.bodies.get(event.id()).map(String::as_bytes),
        );
        builder
            .add_projection_row(&row.encode().unwrap(), Some(event.id().into()))
            .unwrap();
    }
    builder.finish()
}

fn remaining_work(state: &EvaluatedState) -> usize {
    #[derive(Deserialize)]
    struct Saved {
        remaining_work: usize,
    }
    let checkpoint = state.checkpoint("record-arena-golden").unwrap();
    serde_json::from_slice::<Saved>(&checkpoint)
        .unwrap()
        .remaining_work
}

fn write_json(path: String, value: impl Serialize) {
    let mut writer = std::io::BufWriter::new(std::fs::File::create(path).unwrap());
    serde_json::to_writer(&mut writer, &value).unwrap();
    writer.flush().unwrap();
}

fn error_json(error: jvc_core::Error) -> Value {
    json!({"code": error.code, "message": error.message})
}

#[derive(Serialize)]
struct Boundary<'a> {
    name: &'a str,
    limits: &'a Limits,
    remaining_work: usize,
    evaluation: &'a jvc_state::Evaluation,
}

fn boundary(output: &str, name: &str, state: &EvaluatedState, limits: &Limits) {
    write_json(
        format!("{output}/boundary-{name}.json"),
        Boundary {
            name,
            limits,
            remaining_work: remaining_work(state),
            evaluation: state.evaluation(),
        },
    );
}

fn descriptor_json(descriptor: &jvc_runtime::RankingPreparationDescriptor) -> Value {
    let mut value = serde_json::to_value(descriptor).unwrap();
    value.as_object_mut().unwrap().remove("owner_session");
    value
}

fn summary_json(summary: &jvc_runtime::RankingPreparationSummary) -> Value {
    let mut value = serde_json::to_value(summary).unwrap();
    let object = value.as_object_mut().unwrap();
    object.remove("owner_session");
    object.remove("preparation_id");
    object.remove("binding");
    value
}

fn preparation_boundary(session: &jvc_runtime::EvaluationSession, word: &str, units: u64) -> Value {
    let mut policy = jvc_runtime::RankingPreparationPolicy {
        core_binding: format!("sha256:{}", "a".repeat(64)),
        limits: Default::default(),
    };
    policy.limits.units = units;
    match session.ranking_descriptor_native(&policy) {
        Err(error) => json!({"descriptor": error_json(error)}),
        Ok(descriptor) => {
            let request = jvc_runtime::RankingPreparationRequest {
                owner_session: descriptor.owner_session.clone(),
                descriptor_binding: descriptor.binding.clone(),
                word: word.into(),
            };
            let descriptor = descriptor_json(&descriptor);
            match session.prepare_ranking_native(&request) {
                Ok(summary) => json!({"descriptor": descriptor, "summary": summary_json(&summary)}),
                Err(error) => json!({"descriptor": descriptor, "error": error_json(error)}),
            }
        }
    }
}

fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    if args.len() < 3 || args.len() > 4 {
        panic!(
            "usage: record_arena_golden INPUT OUTPUT [ADDITIONS | --projection | --bounds-only | --counts-only]"
        );
    }
    let projection = args.get(3).is_some_and(|arg| arg == "--projection");
    let counts_only = args.get(3).is_some_and(|arg| arg == "--counts-only");
    let bounds_only = counts_only || args.get(3).is_some_and(|arg| arg == "--bounds-only");
    let (input, output) = (&args[1], &args[2]);
    std::fs::create_dir_all(output).unwrap();
    let bytes = std::fs::read(input).unwrap();
    let wire: Wire = serde_json::from_slice(&bytes).unwrap();
    let mut session = if projection {
        build_projection_session(&wire)
    } else {
        jvc_runtime::EvaluationSession::new(&bytes).unwrap()
    };

    let state = session.state().unwrap();
    std::fs::write(format!("{output}/state.json"), &state).unwrap();
    let checkpoint = session.checkpoint("record-arena-golden").unwrap();
    std::fs::write(format!("{output}/checkpoint.json"), &checkpoint).unwrap();
    let restored =
        jvc_runtime::EvaluationSession::restore_host_checkpoint(&checkpoint, "record-arena-golden")
            .unwrap();
    std::fs::write(
        format!("{output}/restored-state.json"),
        restored.state().unwrap(),
    )
    .unwrap();

    let state_json: Value = serde_json::from_str(&state).unwrap();
    let words = state_json["publications"]
        .as_object()
        .unwrap()
        .values()
        .map(|publication| publication["word"].as_str().unwrap().to_owned())
        .collect::<BTreeSet<_>>();
    let first_word = words.first().unwrap().clone();
    if !bounds_only {
        let mut rankings = std::io::BufWriter::new(
            std::fs::File::create(format!("{output}/rankings.ndjson")).unwrap(),
        );
        for word in &words {
            let result = session.rank(word).unwrap();
            rankings.write_all(word.as_bytes()).unwrap();
            rankings.write_all(b"\t").unwrap();
            rankings.write_all(result.as_bytes()).unwrap();
            rankings.write_all(b"\n").unwrap();
        }
        rankings.flush().unwrap();
    }

    let mut hosts = std::io::BufWriter::new(
        std::fs::File::create(format!("{output}/host-records.bin")).unwrap(),
    );
    let mut host_digest = Sha256::new();
    for envelope in &wire.events {
        let id = serde_json::from_str::<Value>(envelope).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let record = jvc_runtime::extract_host_record_bytes(
            envelope.as_bytes(),
            wire.bodies.get(&id).map(String::as_bytes),
        )
        .unwrap();
        hosts
            .write_all(&(record.len() as u64).to_le_bytes())
            .unwrap();
        hosts.write_all(&record).unwrap();
        host_digest.update(&record);
    }
    hosts.flush().unwrap();
    std::fs::write(
        format!("{output}/host-records.sha256"),
        format!("{:x}", host_digest.finalize()),
    )
    .unwrap();

    if let Some(additions) = args.get(3).filter(|_| !bounds_only && !projection) {
        let additions: Vec<String> =
            serde_json::from_str(&std::fs::read_to_string(additions).unwrap()).unwrap();
        let delta_options = serde_json::to_vec(&json!({
            "selected_view": wire.selected_view,
            "import_selections": wire.import_selections,
            "overlay": wire.overlay,
            "limits": wire.limits,
        }))
        .unwrap();
        let mut deltas = std::io::BufWriter::new(
            std::fs::File::create(format!("{output}/state-deltas.ndjson")).unwrap(),
        );
        for envelope in additions {
            let mut builder = session.fork(&delta_options).unwrap();
            builder.add_record_text(&envelope, None, None).unwrap();
            session = builder.finish();
            deltas.write_all(session.state_delta().as_bytes()).unwrap();
            deltas.write_all(b"\n").unwrap();
        }
        deltas.flush().unwrap();
        std::fs::write(
            format!("{output}/added-state.json"),
            session.state().unwrap(),
        )
        .unwrap();
    }

    let bounds_state = build_state(&wire, wire.limits.clone());
    let ranking_bound = bounds_state.ranking_index_bound().unwrap();
    let source_records = bounds_state.ranking_source_records().unwrap();
    bounds_state.ensure_ranking_index().unwrap();
    let index_counts = bounds_state.ranking_index_counts().unwrap();
    let mut approximate_checkpoint: Value = serde_json::from_slice(&checkpoint).unwrap();
    approximate_checkpoint["evaluation"]["policy"]["calculation"] =
        json!(jvc_rank::approximate::ALGORITHM);
    let preparation_session = jvc_runtime::EvaluationSession::restore_host_checkpoint(
        &serde_json::to_vec(&approximate_checkpoint).unwrap(),
        "record-arena-golden",
    )
    .unwrap();
    let baseline_policy = jvc_runtime::RankingPreparationPolicy {
        core_binding: format!("sha256:{}", "a".repeat(64)),
        limits: Default::default(),
    };
    let baseline_descriptor = preparation_session
        .ranking_descriptor_native(&baseline_policy)
        .unwrap();
    let baseline_request = jvc_runtime::RankingPreparationRequest {
        owner_session: baseline_descriptor.owner_session,
        descriptor_binding: baseline_descriptor.binding,
        word: first_word.clone(),
    };
    let baseline_preparation = preparation_session
        .prepare_ranking_native(&baseline_request)
        .unwrap();
    let context_bounds = baseline_preparation
        .contexts
        .iter()
        .map(|prepared| {
            let bound = bounds_state
                .ranking_context_bound(&prepared.context)
                .unwrap();
            json!({
                "context": prepared.context,
                "bound": {
                    "actors": bound.actors,
                    "edges": bound.edges,
                    "refusals": bound.refusals,
                    "judgments": bound.judgments,
                    "targets": bound.targets,
                    "trust_rules": bound.trust_rules,
                    "public_rules": bound.public_rules,
                    "roots": bound.roots,
                    "exclusions": bound.exclusions,
                    "suspensions": bound.suspensions,
                    "overlay_entries": bound.overlay_entries,
                    "pairs_squared": bound.pairs_squared,
                }
            })
        })
        .collect::<Vec<_>>();
    let charged_units = baseline_preparation.usage.charged_units;
    assert!(charged_units > 0);
    write_json(
        format!("{output}/bounds.json"),
        json!({
            "word": first_word,
            "ranking_index_bound": ranking_bound,
            "ranking_source_records": source_records,
            "ranking_index_counts": index_counts,
            "approximate_context_bounds": context_bounds,
            "ranking_preparation_baseline": summary_json(&baseline_preparation),
            "ranking_work_accept": preparation_boundary(&preparation_session, &first_word, charged_units),
            "ranking_work_refuse": preparation_boundary(&preparation_session, &first_word, charged_units - 1),
        }),
    );
    if counts_only {
        return;
    }

    let consumed_work = wire.limits.traversal - remaining_work(&bounds_state);
    assert!(consumed_work > 0);
    let event_count = bounds_state.event_count();
    drop(bounds_state);
    let mut limits = wire.limits.clone();
    limits.events = event_count;
    let state = build_state(&wire, limits.clone());
    assert!(state.evaluation().available);
    boundary(output, "event-accept", &state, &limits);
    drop(state);
    limits.events = event_count - 1;
    let state = build_state(&wire, limits.clone());
    assert!(!state.evaluation().available);
    boundary(output, "event-refuse", &state, &limits);
    drop(state);

    let mut limits = wire.limits.clone();
    limits.traversal = consumed_work;
    let state = build_state(&wire, limits.clone());
    assert!(state.evaluation().available);
    boundary(output, "traversal-accept", &state, &limits);
    drop(state);
    limits.traversal = consumed_work - 1;
    let state = build_state(&wire, limits.clone());
    assert!(!state.evaluation().available);
    boundary(output, "traversal-refuse", &state, &limits);
}
