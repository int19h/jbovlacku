use jvc_core::*;
use serde_json::{Value, json};
fn main() {
    let source = std::fs::read(std::env::args().nth(1).expect("provide the corpus path")).unwrap();
    let corpus = parse_json(&source).unwrap();
    let mut results = Vec::new();
    for case in corpus["cases"].as_array().unwrap() {
        let input = case["input"]
            .as_str()
            .map(|s| hex::decode(s).unwrap())
            .unwrap_or_default();
        let result = match case["op"].as_str().unwrap() {
            "json" => canonicalize_json(&input)
                .map(|b| json!(hex::encode(b)))
                .unwrap_or(Value::Null),
            "word" => parse_json(&input)
                .and_then(|v| word_id(&v))
                .map(|s| json!(s))
                .unwrap_or(Value::Null),
            "record" => verify_envelope(&input)
                .map(|e| json!(hex::encode(e.canonical_envelope().unwrap())))
                .unwrap_or(Value::Null),
            "action" => json!(
                verify_envelope(&input)
                    .and_then(|e| validate_action(e.header()))
                    .is_ok()
            ),
            "body" => {
                let v = parse_json(&input).unwrap();
                let event = verify_envelope(&hex::decode(v["envelope"].as_str().unwrap()).unwrap())
                    .unwrap();
                let body = v["body"].as_str().map(|s| hex::decode(s).unwrap());
                serde_json::to_value(inspect_body(&event, body.as_deref())).unwrap()
            }
            "ed25519" => {
                let key = hex::decode(case["public"].as_str().unwrap()).unwrap();
                let sig = hex::decode(case["signature"].as_str().unwrap()).unwrap();
                let message = hex::decode(case["message"].as_str().unwrap()).unwrap();
                json!(
                    verify_ed25519_profile(
                        &key.try_into().unwrap(),
                        &message,
                        &sig.try_into().unwrap()
                    )
                    .is_ok()
                )
            }
            _ => panic!("unknown corpus operation"),
        };
        assert_eq!(result, case["result"], "{}", case["name"]);
        results.push(json!({"name":case["name"],"result":result}));
    }
    println!("{}", serde_json::to_string(&results).unwrap());
}
