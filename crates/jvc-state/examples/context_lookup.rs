// Measure the actual shared resolver. Fixture construction stays outside the timer.
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::time::Instant;

fn main() {
    let args: Vec<_> = std::env::args().collect();
    let cases = if args.len() == 3 {
        vec![(
            args[1].parse::<usize>().unwrap(),
            args[2].parse::<usize>().unwrap(),
        )]
    } else {
        vec![
            (1_000, 1_000),
            (5_000, 5_000),
            (20_000, 20_000),
            (60_000, 60_000),
            (60_000, 1_000),
            (60_000, 5_000),
        ]
    };
    let input = jvc_state::EvaluationInput {
        events: Vec::new(),
        bodies: BTreeMap::new(),
        selected_view: String::new(),
        overlay: None,
        import_selections: BTreeMap::new(),
        limits: Default::default(),
    };
    for (n, judged) in cases {
        assert!(judged <= n);
        let mut evaluation = jvc_state::evaluate(&input);
        evaluation.available = true;
        evaluation.reasons.clear();
        evaluation.policy =
            Some(json!({"calculation":"simple-routes-shun-v1","roots":[],"excluded":[]}));
        for i in 0..n {
            let id = format!("jve1:{i:064x}");
            let publication: jvc_state::Publication = serde_json::from_value(json!({
                "id":id,"issuer":"ed25519:00","kind":"definition.publish",
                "word":if i==0 {"target".to_owned()} else {format!("w{i}")},
                "language":"en","assignment":null,"lineage":{},"imported":false,
                "source":null,"source_record":null,"account":null,"authority":"native",
                "controller":null,"claim":null,"observations":[],"status_frontier":[],
                "deciding_claim":null,"controller_candidates":[],"witness_contributions":{},
                "missing":[],"content_available":true,"eligible":"eligible","status":"active","reasons":[]
            })).unwrap();
            evaluation.publications.insert(id.clone(), publication);
            if i < judged {
                evaluation.judgments.insert(
                    id,
                    BTreeMap::from([("ed25519:01".into(), jvc_state::Judgment::Bless)]),
                );
            }
        }
        let context = jvc_state::Context {
            kind: "definition".into(),
            word: "target".into(),
            language: Some("en".into()),
        };
        let start = Instant::now();
        let exact = jvc_state::evaluate_context(&evaluation, &context);
        let exact_ms = start.elapsed().as_secs_f64() * 1000.0;
        assert!(exact.available);
        assert_eq!(exact.judgments.len(), usize::from(judged > 0));
        let output = serde_json::to_vec(&exact).unwrap();
        let digest = hex::encode(Sha256::digest(output));
        println!(
            "{}",
            json!({"publications":n,"judged_targets":judged,"exact_context_ms":exact_ms,
"judged_in_context":usize::from(judged>0),"output_sha256":digest})
        );
    }
}
