//! Regenerate current fixtures from retained disposable originals.
use jvc_core::{Header, body_descriptor, canonical_value, identity_from_seed, sign_header};
use serde_json::{Value, json};
use std::{fs, path::PathBuf};
fn main() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let fixtures = root.join("crates/jvc-runtime/tests/fixtures");
    let mut host: Vec<Value> =
        serde_json::from_slice(&fs::read(fixtures.join("host-record-inputs-v7.json")).unwrap())
            .unwrap();
    let mut semantic: Vec<Value> =
        serde_json::from_slice(&fs::read(fixtures.join("semantic-record-inputs-v4.json")).unwrap())
            .unwrap();
    let mut corpus: Value = serde_json::from_slice(
        &fs::read(root.join("crates/jvc-core/tests/fixtures/corpus.json")).unwrap(),
    )
    .unwrap();
    corpus["cases"]
        .as_array_mut()
        .unwrap()
        .retain(|case| !case["name"].as_str().unwrap().starts_with("f64-contract-"));
    for (index, profile, valid) in [
        (0, "simple-routes-shun-f64-v1", true),
        (1, "simple-routes-shun-f64-v2", false),
    ] {
        let body = json!({"name":"Float contract fixture","description":[],"roots":[],"rafsi_threshold":{"numerator":1,"denominator":1},"H":{"numerator":3,"denominator":1},"alpha":{"numerator":1,"denominator":2},"excluded":[],"calculation":profile,"work":1000,"import_sets":[],"account_witnesses":[],"account_authority":false,"notes":[]});
        let bytes = canonical_value(&body).unwrap();
        let event = sign_header(
            &[77; 32],
            Header {
                version: 1,
                issuer: identity_from_seed(&[77; 32]),
                previous: vec![],
                nonce: format!("{index:032x}"),
                action: json!({"kind":"view.publish","parents":[]}),
                content: Some(body_descriptor(&bytes).unwrap()),
            },
        )
        .unwrap();
        assert_eq!(
            jvc_core::validate_body(event.header(), &body).is_ok(),
            valid
        );
        let envelope = String::from_utf8(event.canonical_envelope().unwrap()).unwrap();
        let name = format!("f64-contract-{index}");
        let input = json!({"name":name,"envelope":envelope,"body":String::from_utf8(bytes.clone()).unwrap()});
        let compact =
            jvc_runtime::extract_host_record_bytes(envelope.as_bytes(), Some(&bytes)).unwrap();
        let compact: Value = serde_json::from_slice(&compact).unwrap();
        assert_eq!(
            compact["body_status"],
            if valid { "present" } else { "invalid" }
        );
        host.push(input.clone());
        semantic.push(input);
        let input =
            canonical_value(&json!({"envelope":hex(envelope.as_bytes()),"body":hex(&bytes)}))
                .unwrap();
        corpus["cases"].as_array_mut().unwrap().push(json!({"name":name,"op":"body","input":hex(&input),"result":jvc_core::inspect_body(&event,Some(&bytes))}));
    }
    for (inputs, prefix, version, extract) in [
        (
            &host,
            "host-record",
            jvc_runtime::HOST_RECORD_VERSION,
            jvc_runtime::extract_host_record_bytes
                as fn(&[u8], Option<&[u8]>) -> jvc_core::Result<Vec<u8>>,
        ),
        (
            &semantic,
            "semantic-record",
            jvc_runtime::SEMANTIC_PROJECTION_VERSION,
            jvc_runtime::extract_host_semantic_record_bytes,
        ),
    ] {
        let mut bytes = Vec::new();
        for input in inputs {
            bytes.extend_from_slice(input["name"].as_str().unwrap().as_bytes());
            bytes.push(b'\n');
            bytes.extend(
                extract(
                    input["envelope"].as_str().unwrap().as_bytes(),
                    input["body"].as_str().map(str::as_bytes),
                )
                .unwrap(),
            );
            bytes.push(b'\n');
        }
        fs::write(
            fixtures.join(format!("{prefix}-inputs-v{version}.json")),
            serde_json::to_string_pretty(inputs).unwrap() + "\n",
        )
        .unwrap();
        fs::write(
            fixtures.join(format!("{prefix}-v{version}.sha256")),
            jvc_core::hash_id("sha256:", b"", &bytes) + "\n",
        )
        .unwrap();
    }
    fs::write(
        root.join("crates/jvc-core/tests/fixtures/corpus.json"),
        serde_json::to_string_pretty(&corpus).unwrap() + "\n",
    )
    .unwrap();
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
