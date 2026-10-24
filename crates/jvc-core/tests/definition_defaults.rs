use jvc_core::*;
use serde_json::{Value, json};

fn minimal() -> Value {
    json!({"word":{"language":"jbo","spelling":"broda"},"language":"en","text":[["test"]],"classification":{"kind":"gismu"},"license":{"expression":"CC0-1.0"}})
}
fn header(body: &Value, imported: bool) -> Header {
    let bytes = canonical_value(body).unwrap();
    Header {
        version: 1,
        issuer: identity_from_seed(&[34; 32]),
        previous: vec![],
        nonce: "00".repeat(16),
        action: json!({"kind":"definition.publish","word":word_id(&body["word"]).unwrap(),"language":"en","parents":[],"origin":if imported {"import"} else {"native"}}),
        content: Some(ContentDescriptor {
            hash: hash_id("sha256:", b"", &bytes),
            bytes: bytes.len() as u64,
        }),
    }
}
fn valid(body: &Value) -> bool {
    validate_body(&header(body, false), body).is_ok()
}

#[test]
fn minimal_defaults_keep_signed_bytes_and_distinct_publications() {
    let body = minimal();
    let interpreted = interpret_definition(&body);
    assert!(valid(&body));
    assert!(valid(&interpreted));
    assert_eq!(omit_definition_defaults(&interpreted), body);
    assert_eq!(interpret_definition(&interpreted), interpreted);
    let mut ids = vec![];
    for raw in [&body, &interpreted] {
        let bytes = canonical_value(raw).unwrap();
        let event = sign_header(&[34; 32], header(raw, false)).unwrap();
        let BodyAvailability::Valid { body: retained } = inspect_body(&event, Some(&bytes)) else {
            panic!()
        };
        assert_eq!(&retained, raw);
        assert_eq!(canonical_value(&retained).unwrap(), bytes);
        ids.push(event.id().to_owned());
    }
    assert_ne!(ids[0], ids[1]);
    assert_eq!(body.as_object().unwrap().len(), 5);
}

#[test]
fn nested_defaults_preserve_required_claims() {
    let mut body = minimal();
    body["frame"] = json!({"role":"predicate","arity":{"mode":"variadic","minimum":1},"places":[{"index":1,"type_hints":[{"alternatives":[{"abstractor":"nu"}]}],"defaults":[{"kind":"suggested","value":{"format":"lojban","text":"zo'e"}}],"derivation":[{"word":{"language":"jbo","spelling":"brode"},"place":1}],"glosses":[{"language":"en","text":"one"}]}],"tail":{"from":2}});
    body["operands"] = json!([{"id":"subject","category":"term","cardinality":{"minimum":0}}]);
    body["examples"] = json!([{"language":"jbo","text":"broda"}]);
    body["sources"] = json!([{"label":"source"}]);
    body["etymology"] = json!({"formation":{"method":"algorithmic","algorithm":{"id":"https://example.test/algorithm","version":"1","parameters":{"weighting":"w","matching":"m","transliteration":"t","candidates":"c","aggregation":"a"}},"sources":[{"language":"en","word":"test"}],"weights_profile":{},"candidates":[{"form":"broda"}]},"compound":{"components":[{"word":{"language":"jbo","spelling":"brode"},"rafsi":"rod"},{"word":{"language":"jbo","spelling":"brodi"},"rafsi":"brodi"}],"morphology":{"id":"https://example.test/morphology","version":"1"},"scoring":{"id":"https://example.test/scoring","version":"1"}}});
    assert!(valid(&body));
    let full = interpret_definition(&body);
    assert!(valid(&full));
    assert_eq!(omit_definition_defaults(&full), body);
    assert_eq!(full["frame"]["tail"]["description"], json!([]));
    assert_eq!(full["operands"][0]["cardinality"]["maximum"], Value::Null);
    for pointer in [
        "/frame/tail",
        "/frame/places/0/index",
        "/frame/places/0/defaults/0/kind",
        "/operands/0/cardinality/minimum",
        "/etymology/formation/method",
        "/etymology/formation/algorithm/parameters",
        "/etymology/compound/components/0/rafsi",
    ] {
        let mut bad = body.clone();
        let (parent, key) = pointer.rsplit_once('/').unwrap();
        bad.pointer_mut(parent)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove(key);
        assert!(!valid(&bad), "{pointer}");
    }
}

#[test]
fn invalid_present_fields_unknown_fields_and_interpreted_duplicates_fail() {
    for (field, value) in [
        ("frame", json!({})),
        ("notes", Value::Null),
        ("etymology", Value::Null),
        ("operands", Value::Null),
        ("glosses", json!({})),
        ("legacy", json!({})),
        ("unknown", json!([])),
    ] {
        let mut body = minimal();
        body[field] = value;
        assert!(!valid(&body), "{field}");
    }
    let mut body = minimal();
    body["frame"] = json!({"role":"predicate","arity":{"mode":"context"},"places":[{"index":1,"type_hints":[{"alternatives":[{"tags":["entity"]},{"tags":["entity"],"abstractor":null,"relation_arity":null}]}]}]});
    assert!(!valid(&body));
    body["frame"]["places"][0]["type_hints"][0]["alternatives"] = json!([{}]);
    assert!(!valid(&body));
    body["frame"] = json!({"role":"predicate","arity":{"mode":"fixed","count":1}});
    assert!(!valid(&body));
    body["frame"] = json!({"role":"predicate","arity":{"mode":"fixed","count":0}});
    assert!(valid(&body));
    body["text"] = json!([[1]]);
    assert!(!valid(&body));
    assert!(!validate_body(&header(&minimal(), true), &minimal()).is_ok());
}

#[test]
fn legacy_and_nondefinition_sources_do_not_gain_defaults() {
    let mut body = minimal();
    body["legacy"] = json!({"source":"https://example.test/source","snapshot":format!("sha256:{}", "a".repeat(64)),"extraction":"fixture-v1","record":{"kind":"definition","id":1},"locator":"record/1","original":{"notes":null},"attribution":{"author":null,"editor":null,"author_account":{"origin":"https://example.test","account":1,"username":null,"evidence":{"kind":"source-id","source":{"label":"fixture","url":null,"event":null,"locator":null}}},"dates":{}},"conversion":{"method":"literal","tool":"fixture","version":"1","model":null,"review":"unreviewed","mappings":[],"warnings":[]},"limitations":[]});
    assert!(validate_body(&header(&body, true), &body).is_ok());
    let original = body["legacy"].clone();
    assert_eq!(interpret_definition(&body)["legacy"], original);
    assert_eq!(omit_definition_defaults(&body)["legacy"], original);
    body["legacy"]["attribution"]["author_account"]["evidence"]["source"]
        .as_object_mut()
        .unwrap()
        .remove("url");
    assert!(validate_body(&header(&body, true), &body).is_err());
    let mut rafsi = json!({"word":minimal()["word"],"rafsi":"rod","rationale":[],"sources":[{"label":"source"}],"legacy":null});
    let mut h = header(&minimal(), false);
    h.action = json!({"kind":"rafsi.publish","word":word_id(&rafsi["word"]).unwrap(),"rafsi":"rod","assignment":rafsi_pair_id(&word_id(&rafsi["word"]).unwrap(),"rod").unwrap(),"origin":"native"});
    h.action.as_object_mut().unwrap().remove("rafsi");
    assert!(validate_body(&h, &rafsi).is_err());
    rafsi["sources"] = json!([]);
    assert!(validate_body(&h, &rafsi).is_ok());
    rafsi.as_object_mut().unwrap().remove("legacy");
    assert!(validate_body(&h, &rafsi).is_err());
}
