use base64::{Engine, engine::general_purpose::STANDARD};
use curve25519_dalek::{
    constants::{ED25519_BASEPOINT_POINT, EIGHT_TORSION},
    scalar::Scalar,
};
use jvc_core::*;
use serde_json::{Value, json};
use sha2::{Digest, Sha512};

fn header(action: Value, content: Option<ContentDescriptor>) -> Header {
    Header {
        version: 1,
        issuer: identity_from_seed(&[7; 32]),
        previous: vec![],
        nonce: "00".repeat(16),
        action,
        content,
    }
}
fn signed(action: Value) -> VerifiedEnvelope {
    sign_header(&[7; 32], header(action, None)).unwrap()
}

#[test]
fn strict_json_and_exact_decimal_numbers() {
    for source in [
        br#"{"a":1,"a":2}"#.as_slice(),
        br#"{"a":1,"\u0061":2}"#,
        br#""\ud800""#,
        br#""\udfff""#,
        b"[9007199254740992]",
        b"[1.0000000000000001]",
        b"[0.1]",
        b"[1e-100]",
        b"[01]",
        b"[1.]",
        b"[--1]",
        b"[1e+]",
        b"[NaN]",
        b"[1] garbage",
        b"[\xff]",
    ] {
        assert!(
            parse_json(source).is_err(),
            "{}",
            String::from_utf8_lossy(source)
        );
    }
    assert_eq!(
        canonicalize_json(br#"{"z":1e0,"a":-0.0,"n":9007199254740991.0}"#).unwrap(),
        br#"{"a":0,"n":9007199254740991,"z":1}"#
    );
    assert_eq!(
        canonicalize_json(br#"{"\ue000":1,"\ud83d\ude00":2,"a":"\u000f\n/"}"#).unwrap(),
        "{\"a\":\"\\u000f\\n/\",\"😀\":2,\"\u{e000}\":1}".as_bytes()
    );
    assert!(parse_stored_json(b"{ \"a\":1}").is_err());
    assert!(parse_stored_json(b"[1e0]").is_err());
    assert!(parse_json(format!("{}0{}", "[".repeat(32), "]".repeat(32)).as_bytes()).is_ok());
    assert!(parse_json(format!("{}0{}", "[".repeat(33), "]".repeat(33)).as_bytes()).is_err());
}

#[test]
fn cached_issuer_checks_still_validate_every_signature() {
    let event = signed(json!({"kind":"identity.merge"}));
    let mut verifier = EnvelopeVerifier::default();
    let valid = event.canonical_envelope().unwrap();
    for _ in 0..3 {
        assert_eq!(verifier.verify(&valid).unwrap().id(), event.id());
    }
    let signature = STANDARD.decode(&event.envelope().signature).unwrap();
    for change in 0..5 {
        let mut envelope = event.envelope().clone();
        let mut bytes = signature.clone();
        let end = bytes.len();
        match change {
            0 => bytes[end - 64..end - 32].fill(0),
            1 => bytes[end - 32..].fill(0xff),
            2 => bytes[end - 32] ^= 1,
            3 => {
                envelope.header.issuer = identity_from_seed(&[8; 32]);
                envelope.id = hash_id(
                    "jve1:",
                    EVENT_DOMAIN,
                    &canonical_value(&serde_json::to_value(&envelope.header).unwrap()).unwrap(),
                );
            }
            _ => {
                envelope.header.issuer = format!("ed25519:{}", "00".repeat(32));
                envelope.id = hash_id(
                    "jve1:",
                    EVENT_DOMAIN,
                    &canonical_value(&serde_json::to_value(&envelope.header).unwrap()).unwrap(),
                );
            }
        }
        envelope.signature = STANDARD.encode(bytes);
        let invalid = canonical_value(&serde_json::to_value(envelope).unwrap()).unwrap();
        let expected = verify_envelope(&invalid).unwrap_err();
        assert_eq!(verifier.verify(&invalid).unwrap_err(), expected);
        assert_eq!(verifier.verify(&valid).unwrap().id(), event.id());
    }
}

#[test]
fn original_body_validation_rejects_invalid_stored_bytes() {
    let valid = br#"{"bio":[],"links":[],"name":"Test"}"#.to_vec();
    let mut cases = vec![
        (valid.clone(), true),
        (
            br#"{"bio":[],"links":[],"name":"Test","name":"Test"}"#.to_vec(),
            false,
        ),
        (
            br#"{"bio":[],"links":[],"name":"Test", "extra":0}"#.to_vec(),
            false,
        ),
        (br#"{"bio":[],"links":[],"name":"\ud800"}"#.to_vec(), false),
        (
            br#"{"bio":[[1.0000000000000001]],"links":[],"name":"Test"}"#.to_vec(),
            false,
        ),
        (
            br#"{"bio":[[9007199254740992]],"links":[],"name":"Test"}"#.to_vec(),
            false,
        ),
        (br#"{ "bio":[],"links":[],"name":"Test"}"#.to_vec(), false),
        (
            br#"{"bio":[[1e0]],"links":[],"name":"Test"}"#.to_vec(),
            false,
        ),
        (b"{\xff}".to_vec(), false),
    ];
    cases.push((
        format!("{}0{}", "[".repeat(33), "]".repeat(33)).into_bytes(),
        false,
    ));
    for (bytes, expected) in cases {
        let descriptor = ContentDescriptor {
            hash: hash_id("sha256:", b"", &bytes),
            bytes: bytes.len() as u64,
        };
        let event = sign_header(
            &[7; 32],
            header(json!({"kind":"identity.profile"}), Some(descriptor)),
        )
        .unwrap();
        assert_eq!(
            matches!(
                inspect_body(&event, Some(&bytes)),
                BodyAvailability::Valid { .. }
            ),
            expected,
            "{}",
            String::from_utf8_lossy(&bytes)
        );
    }
    let event = sign_header(
        &[7; 32],
        header(
            json!({"kind":"identity.profile"}),
            Some(body_descriptor(&valid).unwrap()),
        ),
    )
    .unwrap();
    let changed = br#"{"bio":[],"links":[],"name":"Best"}"#;
    assert!(
        matches!(inspect_body(&event, Some(changed)), BodyAvailability::Invalid { reason } if reason.starts_with("body_hash:"))
    );
    assert!(
        matches!(inspect_body(&event, Some(&valid[..valid.len()-1])), BodyAvailability::Invalid { reason } if reason.starts_with("body_length:"))
    );
}

#[test]
fn identifiers_preserve_spelling_and_require_nfc() {
    let word = json!({"language":"jbo","spelling":"banli"});
    assert_eq!(
        word_id(&word).unwrap(),
        hash_id(
            "jvw1:",
            b"jbovlacku-word-v1\n",
            br#"{"language":"jbo","spelling":"banli"}"#
        )
    );
    assert_ne!(
        word_id(&word).unwrap(),
        word_id(&json!({"language":"jbo","spelling":"Banli"})).unwrap()
    );
    for s in ["", " banli", "banli ", "a\n", "e\u{301}"] {
        assert!(word_id(&json!({"language":"jbo","spelling":s})).is_err());
    }
    assert!(word_id(&json!({"language":"jbo","spelling":"a  b"})).is_ok());
    assert!(word_id(&json!({"language":"jbo","spelling":"banli","extra":null})).is_err());
}

#[test]
fn acute_stress_changes_display_without_changing_word_or_pair_identity() {
    for (marked, plain) in [
        ("dján", "djan"),
        ("ĺénan", "lenan"),
        ("ḿa'an", "ma'an"),
        ("b\u{301}an", "ban"),
        ("DŹÁN", "DZAN"),
        ("dján zei blanu", "djan zei blanu"),
    ] {
        let word = json!({"language":"jbo","spelling":marked});
        let id = word_id(&word).unwrap();
        assert_eq!(
            id,
            word_id(&json!({"language":"jbo","spelling":plain})).unwrap()
        );
        assert_eq!(
            rafsi_pair_id(&id, "dja").unwrap(),
            rafsi_pair_id(
                &word_id(&json!({"language":"jbo","spelling":plain})).unwrap(),
                "dja"
            )
            .unwrap()
        );
        assert_eq!(word["spelling"], marked);
    }
    assert_ne!(
        word_id(&json!({"language":"jbo","spelling":"djän"})).unwrap(),
        word_id(&json!({"language":"jbo","spelling":"djan"})).unwrap()
    );
    for marked in [
        "\u{301}djan",
        ".\u{301}djan",
        "dja'\u{301}an",
        "dja1\u{301}n",
        "dja\u{301}\u{301}n",
    ] {
        assert!(
            word_id(&json!({"language":"jbo","spelling":marked})).is_err(),
            "{marked}"
        );
    }
}

#[test]
fn definition_acutes_belong_to_names_and_name_components_of_zei() {
    for (spelling, kind, valid) in [
        ("dján", "cmevla", true),
        ("ĺénan", "cmevla", true),
        ("ḿa'an", "cmevla", true),
        ("blánu", "gismu", false),
        ("dján", "other", false),
        ("dján zei blanu", "lujvo", true),
        ("djan zei blánu", "lujvo", false),
    ] {
        let body = json!({"word":{"language":"jbo","spelling":spelling},"language":"en","text":[["A synthetic name."]],"classification":{"kind":kind},"license":{"expression":"CC0-1.0"}});
        let mut h = header(
            json!({"kind":"definition.publish","word":word_id(&body["word"]).unwrap(),"language":"en","parents":[],"origin":"native"}),
            None,
        );
        h.content = Some(body_descriptor(&canonical_value(&body).unwrap()).unwrap());
        assert_eq!(
            validate_body(&h, &body).is_ok(),
            valid,
            "{spelling}: {kind}"
        );
    }
}

#[test]
fn signed_header_survives_semantic_failure_and_missing_body() {
    let h = header(json!({"kind":"not.a.real.action"}), None);
    let event = sign_header(&[7; 32], h).unwrap();
    assert!(verify_envelope(&event.canonical_envelope().unwrap()).is_ok());
    assert!(validate_action(event.header()).is_err());
    let body = canonical_value(&json!({"name":"Test","bio":[],"links":[]})).unwrap();
    let event = sign_header(
        &[7; 32],
        header(
            json!({"kind":"identity.profile"}),
            Some(body_descriptor(&body).unwrap()),
        ),
    )
    .unwrap();
    assert_eq!(inspect_body(&event, None), BodyAvailability::Missing);
    assert!(matches!(
        inspect_body(&event, Some(&body)),
        BodyAvailability::Valid { .. }
    ));
    assert!(matches!(
        inspect_body(&event, Some(b"{}")),
        BodyAvailability::Invalid { .. }
    ));
    let invalid = canonical_value(&json!({"name":"Test","bio":[[1]],"links":[]})).unwrap();
    let event = sign_header(
        &[7; 32],
        header(
            json!({"kind":"identity.profile"}),
            Some(body_descriptor(&invalid).unwrap()),
        ),
    )
    .unwrap();
    assert!(verify_envelope(&event.canonical_envelope().unwrap()).is_ok());
    assert!(matches!(
        inspect_body(&event, Some(&invalid)),
        BodyAvailability::Invalid { .. }
    ));
}

#[test]
fn strict_header_and_envelope_fields() {
    let event = signed(json!({"kind":"identity.merge"}));
    let original = serde_json::to_value(event.envelope()).unwrap();
    for mutation in [
        "missing_content",
        "extra_header",
        "extra_envelope",
        "wrong_id",
        "wrong_nonce",
        "wrong_signature",
    ] {
        let mut v = original.clone();
        match mutation {
            "missing_content" => {
                v["header"].as_object_mut().unwrap().remove("content");
            }
            "extra_header" => v["header"]["extra"] = Value::Null,
            "extra_envelope" => v["extra"] = Value::Null,
            "wrong_id" => v["id"] = json!(format!("jve1:{}", "00".repeat(32))),
            "wrong_nonce" => v["header"]["nonce"] = json!("FF".repeat(16)),
            _ => v["signature"] = json!("AAAA"),
        }
        assert!(
            verify_envelope(&serde_json::to_vec(&v).unwrap()).is_err(),
            "{mutation}"
        );
    }
    let pretty = serde_json::to_vec_pretty(event.envelope()).unwrap();
    assert!(verify_envelope(&pretty).is_ok());
    assert!(verify_stored_envelope(&pretty).is_err());
}

#[test]
fn sshsig_rejects_profile_substitution_and_base64_variants() {
    let event = signed(json!({"kind":"identity.merge"}));
    let original = serde_json::to_value(event.envelope()).unwrap();
    let blob = STANDARD.decode(&event.envelope().signature).unwrap();
    for mutation in [
        "trailing",
        "version",
        "namespace",
        "reserved",
        "hash",
        "key",
        "padding",
        "url",
    ] {
        let mut bytes = blob.clone();
        let encoded = match mutation {
            "padding" => event.envelope().signature.trim_end_matches('=').to_owned(),
            "url" => event
                .envelope()
                .signature
                .replace('+', "-")
                .replace('/', "_"),
            _ => {
                match mutation {
                    "trailing" => bytes.push(0),
                    "version" => bytes[9] = 0,
                    "namespace" => {
                        let at = bytes
                            .windows(18)
                            .position(|b| b == b"jbovlacku-event-v1")
                            .unwrap();
                        bytes[at] = b'x';
                    }
                    "reserved" => {
                        let at = bytes
                            .windows(18)
                            .position(|b| b == b"jbovlacku-event-v1")
                            .unwrap()
                            + 18;
                        bytes[at + 3] = 1;
                        bytes.insert(at + 4, 0);
                    }
                    "hash" => {
                        let at = bytes.windows(6).position(|b| b == b"sha512").unwrap();
                        bytes[at + 3] = b'2';
                        bytes[at + 4] = b'5';
                        bytes[at + 5] = b'6';
                    }
                    "key" => bytes[40] ^= 1,
                    _ => {}
                }
                STANDARD.encode(bytes)
            }
        };
        if encoded == event.envelope().signature {
            continue;
        }
        let mut v = original.clone();
        v["signature"] = json!(encoded);
        assert!(
            verify_envelope(&serde_json::to_vec(&v).unwrap()).is_err(),
            "{mutation}"
        );
    }
    assert_eq!(
        sshsig_from_armor(&sshsig_armor(&event.envelope().signature).unwrap()).unwrap(),
        event.envelope().signature
    );
}

#[test]
fn ed25519_boundary_profile_includes_identity_r() {
    let message = b"disposable profile boundary";
    let a = Scalar::from(7u64);
    let public = (a * ED25519_BASEPOINT_POINT).compress().to_bytes();
    let r = curve25519_dalek::edwards::EdwardsPoint::default()
        .compress()
        .to_bytes();
    let mut digest = Sha512::new();
    digest.update(r);
    digest.update(public);
    digest.update(message);
    let k = Scalar::from_hash(digest);
    let mut signature = [0u8; 64];
    signature[..32].copy_from_slice(&r);
    signature[32..].copy_from_slice(&(k * a).to_bytes());
    assert!(verify_ed25519_profile(&public, message, &signature).is_ok());
    let vk = ed25519_dalek::VerifyingKey::from_bytes(&public).unwrap();
    assert!(
        vk.verify_strict(message, &ed25519_dalek::Signature::from_bytes(&signature))
            .is_err()
    );
    assert!(verify_ed25519_profile(&r, message, &signature).is_err());
    for t in EIGHT_TORSION.iter().skip(1) {
        assert!(verify_ed25519_profile(&t.compress().to_bytes(), message, &signature).is_err());
        let mixed = (a * ED25519_BASEPOINT_POINT + t).compress().to_bytes();
        assert!(verify_ed25519_profile(&mixed, message, &signature).is_err());
        let mut sig = signature;
        sig[..32].copy_from_slice(&t.compress().to_bytes());
        assert!(verify_ed25519_profile(&public, message, &sig).is_err());
        let mixed_r = (a * ED25519_BASEPOINT_POINT + t).compress().to_bytes();
        sig[..32].copy_from_slice(&mixed_r);
        assert!(verify_ed25519_profile(&public, message, &sig).is_err());
    }
    let mut noncanonical = r;
    noncanonical[31] |= 0x80;
    assert!(verify_ed25519_profile(&noncanonical, message, &signature).is_err());
    let mut sig = signature;
    sig[..32].copy_from_slice(&noncanonical);
    assert!(verify_ed25519_profile(&public, message, &sig).is_err());
    let l = hex::decode(format!(
        "edd3f55c1a631258d69cf7a2def9de14{}10",
        "00".repeat(15)
    ))
    .unwrap();
    sig = signature;
    sig[32..].copy_from_slice(&l);
    assert!(verify_ed25519_profile(&public, message, &sig).is_err());
    let mut wrong = signature;
    wrong[32] ^= 1;
    assert!(verify_ed25519_profile(&public, message, &wrong).is_err());
}

#[test]
fn jsonl_set_union_keeps_signatures_and_missing_bodies() {
    let a = signed(json!({"kind":"identity.merge"}));
    let mut h = header(
        json!({"kind":"identity.profile"}),
        Some(ContentDescriptor {
            hash: format!("sha256:{}", "00".repeat(32)),
            bytes: 2,
        }),
    );
    h.nonce = "01".repeat(16);
    let b = sign_header(&[7; 32], h).unwrap();
    let carrier = export_jsonl(&[b.clone(), a.clone(), a.clone()]).unwrap();
    let records = import_jsonl(&carrier).unwrap();
    assert_eq!(records.len(), 2);
    assert_eq!(export_jsonl(&records).unwrap(), carrier);
    assert_eq!(inspect_body(&b, None), BodyAvailability::Missing);
    assert!(import_jsonl(b"\n").is_err());
    assert!(import_jsonl(b"{}\n").is_err());
}

#[test]
fn schemas_reject_extra_fields_and_unbound_references() {
    let mut h = header(json!({"kind":"identity.merge","extra":null}), None);
    assert!(validate_action(&h).is_err());
    h.action = json!({"kind":"account.set","origin":"https://example.org","account":1,"value":"claim","previous":null,"carry":[]});
    assert!(validate_action(&h).is_ok());
    h.action["carry"] = json!([format!("jve1:{}", "00".repeat(32))]);
    assert!(validate_action(&h).is_err());
    h.action = json!({"kind":"trust.set","subject":identity_from_seed(&[8;32]),"scope":{"kind":"rafsi","word":"*","language":"en"},"value":"heed"});
    assert!(validate_action(&h).is_ok());
    h.action = json!({"kind":"identity.profile"});
    h.content = Some(ContentDescriptor {
        hash: format!("sha256:{}", "00".repeat(32)),
        bytes: 2,
    });
    assert!(
        validate_body(
            &h,
            &json!({"name":"p","bio":[[{"operand":"x"}]],"links":[]})
        )
        .is_err()
    );
}

#[test]
fn openssh_signing_interoperability() {
    use std::process::Command;
    let temp = tempfile::Builder::new()
        .prefix("jvc-openssh-")
        .tempdir()
        .unwrap();
    let dir = temp.path();
    let key = ssh_key::PrivateKey::new(
        ssh_key::private::KeypairData::Ed25519(ssh_key::private::Ed25519Keypair::from_seed(
            &[7; 32],
        )),
        "disposable test",
    )
    .unwrap();
    let key_path = dir.join("id_ed25519");
    std::fs::write(
        &key_path,
        key.to_openssh(ssh_key::LineEnding::LF).unwrap().as_bytes(),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    let h = header(json!({"kind":"identity.merge"}), None);
    let message = event_message(&h).unwrap();
    let message_path = dir.join("message");
    std::fs::write(&message_path, &message).unwrap();
    let output = Command::new("ssh-keygen")
        .args(["-Y", "sign", "-f"])
        .arg(&key_path)
        .args(["-n", "jbovlacku-event-v1", "-O", "hashalg=sha512"])
        .arg(&message_path)
        .output()
        .expect("OpenSSH ssh-keygen is required for signing interoperability");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let sig =
        sshsig_from_armor(&std::fs::read_to_string(dir.join("message.sig")).unwrap()).unwrap();
    let envelope = Envelope {
        id: event_id(&h).unwrap(),
        header: h,
        signature: sig,
    };
    assert!(verify_envelope(&serde_json::to_vec(&envelope).unwrap()).is_ok());
    let our = signed(json!({"kind":"identity.merge"}));
    let allowed = format!("fixture {}\n", key.public_key().to_openssh().unwrap());
    std::fs::write(dir.join("allowed_signers"), allowed).unwrap();
    std::fs::write(
        dir.join("ours.sig"),
        sshsig_armor(&our.envelope().signature).unwrap(),
    )
    .unwrap();
    let mut child = Command::new("ssh-keygen")
        .args(["-Y", "verify", "-f"])
        .arg(dir.join("allowed_signers"))
        .args(["-I", "fixture", "-n", "jbovlacku-event-v1", "-s"])
        .arg(dir.join("ours.sig"))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    use std::io::Write;
    child.stdin.take().unwrap().write_all(&message).unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    drop(temp);
}

#[test]
fn standard_type_tags_accept_current_and_retired_version_one_names() {
    let mut body = parse_stored_json(include_bytes!("fixtures/definition.json")).unwrap();
    let make = |body: &Value| {
        header(
            json!({"kind":"definition.publish","word":word_id(&body["word"]).unwrap(),"language":"en","parents":[],"origin":"native"}),
            Some(body_descriptor(&canonical_value(body).unwrap()).unwrap()),
        )
    };
    body["frame"]["arity"] = json!({"mode":"variadic","minimum":2});
    let hint = |tags: Value| json!([{"alternatives":[{"tags":tags,"abstractor":null,"relation_arity":null}],"note":[]}]);
    for tags in [
        json!(["referent"]),
        json!(["event", "relation"]),
        json!(["sequence"]),
        json!(["entity"]),
        json!(["mass"]),
        json!(["tuple"]),
        json!(["https://example.org/tag"]),
    ] {
        body["frame"]["tail"] = json!({"from":4,"description":[],"type_hints":hint(tags.clone())});
        assert!(validate_body(&make(&body), &body).is_ok(), "{tags}");
    }
    for tag in ["generic", "thing"] {
        body["frame"]["tail"] = json!({"from":4,"description":[],"type_hints":hint(json!([tag]))});
        assert!(validate_body(&make(&body), &body).is_err(), "{tag}");
    }
}

#[test]
fn signed_bodies_with_retired_tags_keep_their_original_bytes() {
    for tag in ["entity", "mass", "tuple"] {
        let mut body = parse_stored_json(include_bytes!("fixtures/definition.json")).unwrap();
        body["frame"]["places"][0]["type_hints"] = json!([{
            "alternatives":[{"tags":[tag],"abstractor":null,"relation_arity":null}],
            "note":[["Retained annotation."]]
        }]);
        let bytes = canonical_value(&body).unwrap();
        let envelope = sign_header(&[7; 32], header(
            json!({"kind":"definition.publish","word":word_id(&body["word"]).unwrap(),"language":"en","parents":[],"origin":"native"}),
            Some(body_descriptor(&bytes).unwrap()),
        )).unwrap();
        assert!(
            matches!(
                inspect_body(&envelope, Some(&bytes)),
                BodyAvailability::Valid { .. }
            ),
            "{tag}"
        );
        assert_eq!(canonical_value(&body).unwrap(), bytes, "{tag}");
        assert_eq!(
            body["frame"]["places"][0]["type_hints"][0]["alternatives"][0]["tags"][0],
            json!(tag)
        );
    }
}

#[test]
fn type_hint_uniqueness_compares_signed_tags_without_alias_substitution() {
    let mut body = parse_stored_json(include_bytes!("fixtures/definition.json")).unwrap();
    let alternative = |tags: Value| json!({"tags":tags,"abstractor":null,"relation_arity":null});
    let make = |body: &Value| {
        header(
            json!({"kind":"definition.publish","word":word_id(&body["word"]).unwrap(),"language":"en","parents":[],"origin":"native"}),
            Some(body_descriptor(&canonical_value(body).unwrap()).unwrap()),
        )
    };
    for alternatives in [
        json!([alternative(json!(["sequence", "tuple"]))]),
        json!([alternative(json!(["entity", "referent"]))]),
        json!([
            alternative(json!(["sequence"])),
            alternative(json!(["tuple"]))
        ]),
        json!([
            alternative(json!(["entity"])),
            alternative(json!(["referent"]))
        ]),
    ] {
        body["frame"]["places"][0]["type_hints"] = json!([{"alternatives":alternatives,"note":[]}]);
        let bytes = canonical_value(&body).unwrap();
        let envelope = sign_header(&[7; 32], make(&body)).unwrap();
        assert!(
            matches!(
                inspect_body(&envelope, Some(&bytes)),
                BodyAvailability::Valid { .. }
            ),
            "{alternatives}"
        );
        assert_eq!(canonical_value(&body).unwrap(), bytes);
    }
    for alternatives in [
        json!([alternative(json!(["referent", "entity"]))]),
        json!([alternative(json!(["sequence", "sequence"]))]),
        json!([alternative(json!(["tuple"])), alternative(json!(["tuple"]))]),
    ] {
        body["frame"]["places"][0]["type_hints"] = json!([{"alternatives":alternatives,"note":[]}]);
        assert!(
            validate_body(&make(&body), &body).is_err(),
            "{alternatives}"
        );
    }
}

#[test]
fn formation_source_word_pronunciation_is_optional_and_preserves_original_bytes() {
    let mut body = parse_stored_json(include_bytes!("fixtures/definition.json")).unwrap();
    body["etymology"]["formation"] = json!({
        "method":"unknown", "algorithm":null,
        "sources":[{"language":"en", "word":"running", "input":{"format":"lojbanized","text":"ran"}, "weight":null, "notes":[]}],
        "weights_profile":null, "generated":null, "selected_score":null,
        "selected_rank":null, "selection_reason":[], "candidates":[], "conflicts":[]
    });
    let make = |body: &Value| {
        header(
            json!({"kind":"definition.publish","word":word_id(&body["word"]).unwrap(),"language":"en","parents":[],"origin":"native"}),
            Some(body_descriptor(&canonical_value(body).unwrap()).unwrap()),
        )
    };
    let older = canonical_value(&body).unwrap();
    assert!(validate_body(&make(&body), &body).is_ok());
    assert_eq!(canonical_value(&body).unwrap(), older);
    body["etymology"]["formation"]["sources"][0]["word_ipa"] = json!("ˈrʌnɪŋ");
    let with_pronunciation = canonical_value(&body).unwrap();
    let envelope = sign_header(&[7; 32], make(&body)).unwrap();
    assert!(matches!(
        inspect_body(&envelope, Some(&with_pronunciation)),
        BodyAvailability::Valid { .. }
    ));
    assert_eq!(canonical_value(&body).unwrap(), with_pronunciation);
    assert_ne!(
        body_descriptor(&older).unwrap().hash,
        body_descriptor(&with_pronunciation).unwrap().hash
    );
    // Full pronunciation does not require a scoring input or private stem evidence.
    body["etymology"]["formation"]["sources"][0]["input"] = Value::Null;
    assert!(validate_body(&make(&body), &body).is_ok());
    body["etymology"]["formation"]["sources"][0]["input"] = json!({"format":"ipa", "text":"rʌn"});
    assert!(validate_body(&make(&body), &body).is_ok());
    for invalid in [json!(""), json!(false), json!(1), json!([]), json!({})] {
        body["etymology"]["formation"]["sources"][0]["word_ipa"] = invalid;
        assert!(validate_body(&make(&body), &body).is_err());
    }
    body["etymology"]["formation"]["sources"][0]["word_ipa"] = Value::Null;
    assert!(validate_body(&make(&body), &body).is_ok());

    for field in ["stem", "ipa", "pronunciation"] {
        for value in [
            json!("run"),
            Value::Null,
            json!(""),
            json!(false),
            json!(1),
            json!([]),
            json!({}),
        ] {
            let mut forbidden = body.clone();
            forbidden["etymology"]["formation"]["sources"][0][field] = value.clone();
            assert!(
                validate_body(&make(&forbidden), &forbidden).is_err(),
                "{field}: {value}"
            );
            let bytes = canonical_value(&forbidden).unwrap();
            let envelope = sign_header(&[7; 32], make(&forbidden)).unwrap();
            assert!(matches!(
                inspect_body(&envelope, Some(&bytes)),
                BodyAvailability::Invalid { .. }
            ));
        }
    }
}

#[test]
fn structured_definition_variants_and_schema_boundaries() {
    let mut body = parse_stored_json(include_bytes!("fixtures/definition.json")).unwrap();
    let make = |body: &Value| {
        header(
            json!({"kind":"definition.publish","word":word_id(&body["word"]).unwrap(),"language":"en","parents":[],"origin":"native"}),
            Some(body_descriptor(&canonical_value(body).unwrap()).unwrap()),
        )
    };
    assert!(validate_body(&make(&body), &body).is_ok());
    body["text"] = json!([[3, " and ", 1, " then ", 2, " and ", 1, "."]]);
    assert!(validate_body(&make(&body), &body).is_ok());
    body["frame"]["arity"] = json!({"mode":"variadic","minimum":2});
    body["frame"]["tail"] = json!({"from":4,"description":[],"type_hints":[]});
    assert!(validate_body(&make(&body), &body).is_ok());
    let mut invalid = body.clone();
    invalid["frame"]["tail"]["from"] = json!(5);
    assert!(validate_body(&make(&invalid), &invalid).is_err());
    invalid = body.clone();
    invalid["text"] = json!([[4]]);
    assert!(validate_body(&make(&invalid), &invalid).is_err());
    body["frame"] = Value::Null;
    body["text"] = json!([[{"operand":"bridi"}," with literal ②"]]);
    body["notes"] = json!([]);
    body["operands"] = json!([{"id":"bridi","category":"bridi","description":[],"cardinality":{"minimum":1,"maximum":null}}]);
    assert!(validate_body(&make(&body), &body).is_ok());
    invalid = body.clone();
    invalid["etymology"]["text"] = json!([[{"operand":"bridi"}]]);
    assert!(validate_body(&make(&invalid), &invalid).is_err());
    body["etymology"]["formation"] = json!({"method":"unknown","algorithm":null,"sources":[],"weights_profile":null,"generated":null,"selected_score":{"numerator":"3","denominator":"7"},"selected_rank":null,"selection_reason":[],"candidates":[],"conflicts":[]});
    assert!(validate_body(&make(&body), &body).is_ok());
    invalid = body.clone();
    invalid["etymology"]["formation"]["selected_score"] =
        json!({"numerator":"6","denominator":"14"});
    assert!(validate_body(&make(&invalid), &invalid).is_err());
    invalid = body.clone();
    invalid["etymology"]["formation"]["method"] = json!("non-algorithmic");
    invalid["etymology"]["formation"]["algorithm"] = json!({"id":"https://example.org/a","version":"1","implementation":null,"parameters":{"weighting":"v1","matching":"v1","transliteration":"v1","candidates":"v1","aggregation":"v1"}});
    assert!(validate_body(&make(&invalid), &invalid).is_err());
    invalid = body.clone();
    invalid["license"]["extra"] = Value::Null;
    assert!(validate_body(&make(&invalid), &invalid).is_err());
    let many_sources = json!({"label":"","url":null,"event":null,"locator":null});
    body["sources"] = json!(vec![many_sources; 300]);
    assert!(validate_body(&make(&body), &body).is_ok());
}

#[test]
fn account_observation_schema_checks_date_and_claim() {
    let claim = format!("jve1:{}", "11".repeat(32));
    let mut h = header(
        json!({"kind":"account.observe","origin":"https://example.org","account":1,"claim":claim,"result":"present"}),
        Some(ContentDescriptor {
            hash: format!("sha256:{}", "00".repeat(32)),
            bytes: 2,
        }),
    );
    let mut body = json!({"origin":"https://example.org","account":1,"username":null,"field_hash":format!("sha256:{}","00".repeat(32)),"markers":[claim],"method":"lensisku-public-profile-v1","observed_at":"2024-02-29T23:59:59Z"});
    assert!(validate_body(&h, &body).is_ok());
    for date in [
        "2023-02-29T00:00:00Z",
        "2024-02-29T23:59:60Z",
        "2024-13-01T00:00:00Z",
        "2024-01-01T24:00:00Z",
        "2024-01-01T00:00:00+00:00",
    ] {
        let mut b = body.clone();
        b["observed_at"] = json!(date);
        assert!(validate_body(&h, &b).is_err());
    }
    body["markers"] = json!([]);
    assert!(validate_body(&h, &body).is_err());
    h.action["result"] = json!("unreachable");
    h.action["claim"] = Value::Null;
    body["field_hash"] = Value::Null;
    assert!(validate_body(&h, &body).is_ok());
    body["field_hash"] = json!(format!("sha256:{}", "00".repeat(32)));
    assert!(validate_body(&h, &body).is_err());
}

#[test]
fn parents_do_not_invent_an_order_constraint() {
    let mut h = header(
        json!({"kind":"definition.publish","word":word_id(&json!({"language":"jbo","spelling":"banli"})).unwrap(),"language":"en","parents":[format!("jve1:{}","ff".repeat(32)),format!("jve1:{}","00".repeat(32))],"origin":"native"}),
        Some(ContentDescriptor {
            hash: format!("sha256:{}", "00".repeat(32)),
            bytes: 2,
        }),
    );
    assert!(validate_action(&h).is_ok());
    h.action["parents"] = json!(vec![format!("jve1:{}", "00".repeat(32)); 17]);
    assert!(validate_action(&h).is_err());
}

#[test]
fn external_signer_receives_the_sshsig_frame() {
    use ed25519_dalek::Signer;
    let h = header(json!({"kind":"identity.merge"}), None);
    let input = sshsig_signing_bytes(&h).unwrap();
    assert!(input.starts_with(b"SSHSIG"));
    let key = ed25519_dalek::SigningKey::from_bytes(&[7; 32]);
    let raw = key.sign(&input).to_bytes();
    let event = envelope_from_signature(h.clone(), &raw).unwrap();
    assert_eq!(
        event.canonical_envelope().unwrap(),
        sign_header(&[7; 32], h.clone())
            .unwrap()
            .canonical_envelope()
            .unwrap()
    );
    let wrong = key.sign(&event_message(&h).unwrap()).to_bytes();
    assert!(envelope_from_signature(h, &wrong).is_err());
}

#[test]
fn nonexportable_webcrypto_signer_matches_core_and_openssh_signature() {
    let h = header(json!({"kind":"identity.merge"}), None);
    let input = sshsig_signing_bytes(&h).unwrap();
    let output = std::process::Command::new("node")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/webcrypto-signer.mjs"
        ))
        .args([hex::encode([7; 32]), hex::encode(input)])
        .output()
        .expect("Node.js is required for the WebCrypto signing test");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let signature: [u8; 64] = hex::decode(String::from_utf8(output.stdout).unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    let external = envelope_from_signature(h.clone(), &signature).unwrap();
    assert_eq!(
        external.canonical_envelope().unwrap(),
        sign_header(&[7; 32], h)
            .unwrap()
            .canonical_envelope()
            .unwrap()
    );
}

#[test]
fn transport_wrapper_allows_body_boundary_without_weakening_body_limit() {
    let body32 = format!("{}null{}", r#"{"x":"#.repeat(32), "}".repeat(32));
    let body33 = format!("{}null{}", r#"{"x":"#.repeat(33), "}".repeat(33));
    assert!(parse_json(body32.as_bytes()).is_ok());
    assert!(parse_json(body33.as_bytes()).is_err());
    let event = sign_header(
        &[7; 32],
        header(
            json!({"kind":"unknown"}),
            Some(body_descriptor(body32.as_bytes()).unwrap()),
        ),
    )
    .unwrap();
    let wrapped = format!(
        r#"{{"envelope":{},"body":{}}}"#,
        String::from_utf8(event.canonical_envelope().unwrap()).unwrap(),
        body32
    );
    assert!(parse_json(wrapped.as_bytes()).is_err());
    let outer = parse_transport_json(wrapped.as_bytes()).unwrap();
    let checked = verify_envelope(&canonical_value(&outer["envelope"]).unwrap()).unwrap();
    assert!(canonical_value(&outer["body"]).is_ok());
    assert!(matches!(
        inspect_body(&checked, Some(body32.as_bytes())),
        BodyAvailability::Invalid { .. }
    ));
    let wrapped33 = format!(
        r#"{{"envelope":{},"body":{}}}"#,
        String::from_utf8(event.canonical_envelope().unwrap()).unwrap(),
        body33
    );
    let outer = parse_transport_json(wrapped33.as_bytes()).unwrap();
    assert!(canonical_value(&outer["body"]).is_err());
    assert!(parse_transport_json(br#"{"envelope":{},"body":{},"body":{}}"#).is_err());
    assert!(parse_transport_json(br#"{"body":9007199254740992}"#).is_err());
    assert!(
        parse_transport_json(format!("{}null{}", "[".repeat(35), "]".repeat(35)).as_bytes())
            .is_err()
    );
}

#[test]
fn review_schema_conformance_accepts_spec_strings_and_selmaho() {
    let mut body = parse_stored_json(include_bytes!("fixtures/definition.json")).unwrap();
    body["classification"]["selmaho"] = json!(vec!["A"; 8193]);
    body["notes"] = json!([[{"code":""}]]);
    body["etymology"]["formation"] = json!({"method":"unknown","algorithm":null,"sources":[],"weights_profile":null,"generated":" leading candidate ","selected_score":null,"selected_rank":null,"selection_reason":[],"candidates":[{"form":"","score":null,"rank":null},{"form":"e\u{301}","score":null,"rank":null}],"conflicts":[]});
    let bytes = canonical_value(&body).unwrap();
    assert!(bytes.len() < MAX_BODY_BYTES);
    let h = header(
        json!({"kind":"definition.publish","word":word_id(&body["word"]).unwrap(),"language":"en","parents":[],"origin":"native"}),
        Some(body_descriptor(&bytes).unwrap()),
    );
    assert!(validate_body(&h, &body).is_ok());
    body["notes"] = json!([[""]]);
    assert!(validate_body(&h, &body).is_err());
    body["notes"] = json!([[{"code":false}]]);
    assert!(validate_body(&h, &body).is_err());
}

#[test]
fn language_tags_use_syntax_without_registry_membership() {
    let scope = |tag: &str| json!({"kind":"definition","word":"*","language":tag});
    for tag in [
        "jbo",
        "en",
        "en-us",
        "zh-hans",
        "xyz",
        "xyz-zzzz-zz",
        "x-private",
        "i-klingon",
    ] {
        assert!(validate_scope(&scope(tag)).is_ok(), "{tag}");
        let mut body = parse_stored_json(include_bytes!("fixtures/definition.json")).unwrap();
        body["language"] = json!(tag);
        let h = header(
            json!({"kind":"definition.publish","word":word_id(&body["word"]).unwrap(),"language":tag,"parents":[],"origin":"native"}),
            Some(body_descriptor(&canonical_value(&body).unwrap()).unwrap()),
        );
        assert!(validate_action(&h).is_ok(), "{tag}");
        assert!(validate_body(&h, &body).is_ok(), "{tag}");
    }
    for tag in [
        "",
        "e",
        "en-US",
        "zh-Hans",
        "en_us",
        "en--us",
        "en-",
        "1",
        "en-123456789",
        "en-x",
        "x-",
        "x--a",
        "x-private-",
        "x-123456789",
        "é",
    ] {
        assert!(validate_scope(&scope(tag)).is_err(), "{tag}");
    }
    let limit = format!("x-{}-abcdefg", ["abcdefgh"; 6].join("-"));
    assert_eq!(limit.len(), 63);
    assert!(validate_scope(&scope(&limit)).is_ok());
    assert!(validate_scope(&scope(&(limit + "h"))).is_err());
}

#[test]
fn current_repository_contract_binding_matches_sources_and_fixtures() {
    let binding = parse_json(include_bytes!("fixtures/contract-binding.json")).unwrap();
    for (name, bytes) in [
        (
            "docs/format.md",
            include_bytes!("../../../docs/format.md").as_slice(),
        ),
        (
            "tests/fixtures/provenance.json",
            include_bytes!("fixtures/provenance.json").as_slice(),
        ),
        (
            "tests/fixtures/corpus.json",
            include_bytes!("fixtures/corpus.json").as_slice(),
        ),
        (
            "tests/fixtures/definition.json",
            include_bytes!("fixtures/definition.json").as_slice(),
        ),
    ] {
        assert_eq!(
            binding["sha256"][name],
            json!(hash_id("sha256:", b"", bytes)),
            "{name}"
        );
    }
}

#[test]
fn noncanonical_identity_r_vectors_satisfy_the_decoded_point_equation() {
    use curve25519_dalek::edwards::CompressedEdwardsY;
    let corpus = parse_json(include_bytes!("fixtures/corpus.json")).unwrap();
    let mut scalars = Vec::new();
    for name in ["noncanonical-identity-r", "noncanonical-identity-r-sign"] {
        let case = corpus["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == name)
            .unwrap();
        let public: [u8; 32] = hex::decode(case["public"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        let signature: [u8; 64] = hex::decode(case["signature"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        let message = hex::decode(case["message"].as_str().unwrap()).unwrap();
        let encoded_r: [u8; 32] = signature[..32].try_into().unwrap();
        let decoded_r = CompressedEdwardsY(encoded_r).decompress().unwrap();
        let decoded_a = CompressedEdwardsY(public).decompress().unwrap();
        let scalar = Scalar::from_canonical_bytes(signature[32..].try_into().unwrap()).unwrap();
        let mut digest = Sha512::new();
        digest.update(encoded_r);
        digest.update(public);
        digest.update(&message);
        let challenge = Scalar::from_hash(digest);
        // Rejection must come from the encoding, while the decoded equation holds.
        assert_eq!(
            scalar * ED25519_BASEPOINT_POINT - challenge * decoded_a,
            decoded_r,
            "{name}"
        );
        assert_ne!(encoded_r, decoded_r.compress().to_bytes(), "{name}");
        assert!(verify_ed25519_profile(&public, &message, &signature).is_err());
        scalars.push(scalar);
    }
    assert_ne!(scalars[0], scalars[1]);
}

#[test]
fn view_schema_accepts_both_explicit_route_profiles_and_rejects_unknown_names() {
    let mut body = json!({"name":"fixture","description":[],"roots":[],"rafsi_threshold":{"numerator":1,"denominator":1},"H":{"numerator":3,"denominator":1},"alpha":{"numerator":1,"denominator":2},"excluded":[],"calculation":"simple-routes-bounds-v1","work":1000,"import_sets":[],"account_witnesses":[],"account_authority":false,"notes":[]});
    let mut header = header(json!({"kind":"view.publish","parents":[]}), None);
    for profile in ["simple-routes-bounds-v1", "simple-routes-shun-v1"] {
        body["calculation"] = json!(profile);
        header.content = Some(body_descriptor(&canonical_value(&body).unwrap()).unwrap());
        validate_body(&header, &body).unwrap();
    }
    body["calculation"] = json!("unsupported-profile");
    assert!(validate_body(&header, &body).is_err());
}

#[test]
fn lexical_kind_uses_fuhivla_without_a_legacy_alias() {
    let mut body = parse_stored_json(include_bytes!("fixtures/definition.json")).unwrap();
    body["word"]["spelling"] = json!("leksiko");
    for (kind, valid) in [("fuhivla", true), ("fuivla", false), ("fu'ivla", false)] {
        body["classification"]["kind"] = json!(kind);
        let action = header(
            json!({"kind":"definition.publish","word":word_id(&body["word"]).unwrap(),"language":"en","parents":[],"origin":"native"}),
            Some(body_descriptor(&canonical_value(&body).unwrap()).unwrap()),
        );
        assert_eq!(validate_body(&action, &body).is_ok(), valid, "{kind}");
    }
}

#[test]
fn r2_grok_1_comma_zei_accepts_accented_names_like_plain_names() {
    for spelling in [
        "dján zei, blanu",
        "dján zei,blanu",
        "dján z,e,i blanu",
        "dján, zei blanu",
    ] {
        let body = json!({"word":{"language":"jbo","spelling":spelling},"language":"en","text":[["Synthetic."]],"classification":{"kind":"lujvo"},"license":{"expression":"CC0-1.0"}});
        let h = header(
            json!({"kind":"definition.publish","word":word_id(&body["word"]).unwrap(),"language":"en","parents":[],"origin":"native"}),
            Some(body_descriptor(&canonical_value(&body).unwrap()).unwrap()),
        );
        let result = validate_body(&h, &body);
        assert!(result.is_ok(), "{spelling}: {result:?}");
    }
}

#[test]
fn r2_grok_1_comma_zei_does_not_admit_an_accented_root() {
    for spelling in ["djan zei, blánu", "djan zei,blánu"] {
        let body = json!({"word":{"language":"jbo","spelling":spelling},"language":"en","text":[["Synthetic."]],"classification":{"kind":"lujvo"},"license":{"expression":"CC0-1.0"}});
        let h = header(
            json!({"kind":"definition.publish","word":word_id(&body["word"]).unwrap(),"language":"en","parents":[],"origin":"native"}),
            Some(body_descriptor(&canonical_value(&body).unwrap()).unwrap()),
        );
        let result = validate_body(&h, &body);
        assert!(result.is_err(), "{spelling}");
    }
}

#[test]
fn r2_opus_f7_rafsi_claims_require_plain_word_and_rafsi_spellings() {
    for (spelling, rafsi, valid) in [
        ("djan", "dja", true),
        ("dján", "dja", false),
        ("brodá", "bro", false),
        ("djan", "djá", false),
    ] {
        let body = json!({"word":{"language":"jbo","spelling":spelling},"rafsi":rafsi,"rationale":[],"sources":[],"legacy":null});
        let word = word_id(&body["word"]).unwrap();
        let h = header(
            json!({"kind":"rafsi.publish","word":word,"assignment":rafsi_pair_id(&word, rafsi).unwrap(),"origin":"native"}),
            Some(body_descriptor(&canonical_value(&body).unwrap()).unwrap()),
        );
        let result = validate_body(&h, &body);
        assert_eq!(result.is_ok(), valid, "{spelling}: {rafsi}: {result:?}");
    }
}

#[test]
fn r2_opus_f2_specification_states_the_prelaunch_accent_break() {
    let spec = include_str!("../../../docs/format.md");
    assert!(spec.contains(
        "Former accented word IDs and the signed records that use them are not preserved."
    ));
    assert!(spec.contains("No migration is required."));
}
