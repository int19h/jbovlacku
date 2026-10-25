use base64::{Engine, engine::general_purpose::STANDARD};
use curve25519_dalek::{
    constants::{ED25519_BASEPOINT_POINT, EIGHT_TORSION},
    scalar::Scalar,
};
use jvc_core::*;
use serde_json::{Value, json};
use sha2::{Digest, Sha512};

fn main() {
    let mut cases = Vec::new();
    let mut add = |name: &str, op: &str, input: &[u8], result: Value| {
        cases.push(json!({"name":name,"op":op,"input":hex::encode(input),"result":result}))
    };
    for (name, input) in [
        ("safe-max", b"9007199254740991".as_slice()),
        ("safe-min", b"-9007199254740991"),
        ("integral-exponent", b"[1e0,-0.0,100e-2,0e99999999]"),
        (
            "utf16-key-order",
            br#"{"\ue000":1,"\ud83d\ude00":2,"a":"\u000f\n/"}"#,
        ),
        ("duplicate-key", br#"{"a":1,"a":2}"#),
        ("escaped-duplicate-key", br#"{"a":1,"\u0061":2}"#),
        ("lone-high-surrogate", br#""\ud800""#),
        ("lone-low-surrogate", br#""\udfff""#),
        ("invalid-utf8", b"[\xff]"),
        ("unsafe-positive", b"9007199254740992"),
        ("unsafe-negative", b"-9007199254740992"),
        ("fraction-before-rounding", b"1.0000000000000001"),
        ("negative-fraction", b"-1.0000000000000001"),
        ("small-fraction", b"1e-9999999"),
        ("fraction", b"0.1"),
        ("leading-zero", b"01"),
        ("missing-decimal-digit", b"1."),
        ("missing-exponent-digit", b"1e+"),
        ("trailing-input", b"[]x"),
        ("nan", b"NaN"),
    ] {
        let result = canonicalize_json(input)
            .map(|b| json!(hex::encode(b)))
            .unwrap_or(Value::Null);
        add(name, "json", input, result);
    }
    for depth in [32, 33] {
        let input = format!("{}0{}", "[".repeat(depth), "]".repeat(depth));
        let result = canonicalize_json(input.as_bytes())
            .map(|b| json!(hex::encode(b)))
            .unwrap_or(Value::Null);
        add(&format!("depth-{depth}"), "json", input.as_bytes(), result);
    }
    for spelling in ["banli", "Banli", "banli\u{202e}", " banli", "e\u{301}", "é"] {
        let input = serde_json::to_vec(&json!({"language":"jbo","spelling":spelling})).unwrap();
        let result = word_id(&parse_json(&input).unwrap())
            .map(|id| json!(id))
            .unwrap_or(Value::Null);
        add(&format!("word-{spelling}"), "word", &input, result);
    }
    let make = |nonce: &str, action: Value, body: Option<&[u8]>| {
        let header = Header {
            version: 1,
            issuer: identity_from_seed(&[7; 32]),
            previous: vec![],
            nonce: nonce.repeat(16),
            action,
            content: body.map(|b| body_descriptor(b).unwrap()),
        };
        sign_header(&[7; 32], header).unwrap()
    };
    let merge = make("00", json!({"kind":"identity.merge"}), None);
    let wire = merge.canonical_envelope().unwrap();
    add("valid-merge", "record", &wire, json!(hex::encode(&wire)));
    let body = canonical_value(&json!({"name":"Synthetic fixture","bio":[],"links":[]})).unwrap();
    let profile = make("01", json!({"kind":"identity.profile"}), Some(&body));
    let profile_wire = profile.canonical_envelope().unwrap();
    add(
        "profile-body-missing",
        "body",
        &serde_json::to_vec(&json!({"envelope":hex::encode(&profile_wire),"body":null})).unwrap(),
        serde_json::to_value(inspect_body(&profile, None)).unwrap(),
    );
    add(
        "profile-body-present",
        "body",
        &serde_json::to_vec(
            &json!({"envelope":hex::encode(&profile_wire),"body":hex::encode(&body)}),
        )
        .unwrap(),
        serde_json::to_value(inspect_body(&profile, Some(&body))).unwrap(),
    );
    let malformed =
        canonical_value(&json!({"name":"Synthetic fixture","bio":[[1]],"links":[]})).unwrap();
    let malformed_event = make("02", json!({"kind":"identity.profile"}), Some(&malformed));
    let input = json!({"envelope":hex::encode(malformed_event.canonical_envelope().unwrap()),"body":hex::encode(&malformed)});
    add(
        "profile-invalid-body-keeps-header",
        "body",
        &serde_json::to_vec(&input).unwrap(),
        serde_json::to_value(inspect_body(&malformed_event, Some(&malformed))).unwrap(),
    );
    let minimal = json!({"word":{"language":"jbo","spelling":"broda"},"language":"en","text":[["Default fixture"]],"classification":{"kind":"gismu"},"license":{"expression":"CC0-1.0"}});
    let mut nested = minimal.clone();
    nested["frame"] = json!({"role":"predicate","arity":{"mode":"variadic","minimum":1},"places":[{"index":1,"type_hints":[{"alternatives":[{"abstractor":"nu"}]}]}],"tail":{"from":2}});
    nested["etymology"] = json!({"formation":{"method":"unknown","sources":[{"language":"en","word":"test"}],"weights_profile":{},"candidates":[{"form":"broda"}]}});
    let mut invalid = minimal.clone();
    invalid["notes"] = Value::Null;
    let mut duplicates = nested.clone();
    duplicates["frame"]["places"][0]["type_hints"][0]["alternatives"] =
        json!([{"tags":["entity"]},{"tags":["entity"],"abstractor":null,"relation_arity":null}]);
    for (name, value, valid) in [
        ("definition-omitted-defaults", minimal.clone(), true),
        (
            "definition-explicit-defaults",
            interpret_definition(&minimal),
            true,
        ),
        ("definition-nested-defaults", nested, true),
        ("definition-invalid-present-default", invalid, false),
        ("definition-duplicate-after-defaults", duplicates, false),
    ] {
        let bytes = canonical_value(&value).unwrap();
        let event = make(
            "05",
            json!({"kind":"definition.publish","word":word_id(&minimal["word"]).unwrap(),"language":"en","parents":[],"origin":"native"}),
            Some(&bytes),
        );
        let availability = inspect_body(&event, Some(&bytes));
        assert_eq!(
            matches!(availability, BodyAvailability::Valid { .. }),
            valid,
            "{name}"
        );
        add(name, "body", &serde_json::to_vec(&json!({"envelope":hex::encode(event.canonical_envelope().unwrap()),"body":hex::encode(bytes)})).unwrap(), serde_json::to_value(availability).unwrap());
    }
    let inert = make("03", json!({"kind":"unknown","other":null}), None);
    let inert_wire = inert.canonical_envelope().unwrap();
    add(
        "invalid-action-valid-header",
        "record",
        &inert_wire,
        json!(hex::encode(&inert_wire)),
    );
    add("invalid-action-inert", "action", &inert_wire, json!(false));
    for (tag, valid) in [
        ("xyz", true),
        ("xyz-zzzz-zz", true),
        ("en-us", true),
        ("zh-hans", true),
        ("x-private", true),
        ("i-klingon", true),
        ("", false),
        ("e", false),
        ("en-US", false),
        ("en_us", false),
        ("en--us", false),
        ("en-", false),
        ("en-x", false),
        ("x-", false),
        ("x--a", false),
        ("x-private-", false),
        ("x-123456789", false),
    ] {
        let event = make(
            "04",
            json!({"kind":"trust.set","subject":identity_from_seed(&[8;32]),"scope":{"kind":"definition","word":"*","language":tag},"value":"heed"}),
            None,
        );
        assert_eq!(validate_action(event.header()).is_ok(), valid, "{tag}");
        add(
            &format!("language-syntax-{tag}"),
            "action",
            &event.canonical_envelope().unwrap(),
            json!(valid),
        );
    }
    let original = serde_json::to_value(merge.envelope()).unwrap();
    let original_blob = STANDARD.decode(&merge.envelope().signature).unwrap();
    for (name, encoded) in [
        ("sshsig-trailing", {
            let mut b = original_blob.clone();
            b.push(0);
            STANDARD.encode(b)
        }),
        ("sshsig-version-zero", {
            let mut b = original_blob.clone();
            b[9] = 0;
            STANDARD.encode(b)
        }),
        ("sshsig-wrong-namespace", {
            let mut b = original_blob.clone();
            let at = b
                .windows(18)
                .position(|p| p == b"jbovlacku-event-v1")
                .unwrap();
            b[at] = b'x';
            STANDARD.encode(b)
        }),
        (
            "base64-missing-padding",
            merge.envelope().signature.trim_end_matches('=').to_owned(),
        ),
        (
            "base64-url-alphabet",
            merge
                .envelope()
                .signature
                .replace('+', "-")
                .replace('/', "_"),
        ),
        (
            "base64-line-break",
            format!("{}\n", merge.envelope().signature),
        ),
    ] {
        let mut v = original.clone();
        v["signature"] = json!(encoded);
        let input = serde_json::to_vec(&v).unwrap();
        let result = verify_envelope(&input)
            .map(|e| json!(hex::encode(e.canonical_envelope().unwrap())))
            .unwrap_or(Value::Null);
        add(name, "record", &input, result);
    }
    let a = Scalar::from(7u64);
    let public = (a * ED25519_BASEPOINT_POINT).compress().to_bytes();
    let r = curve25519_dalek::edwards::EdwardsPoint::default()
        .compress()
        .to_bytes();
    let message = b"disposable profile boundary";
    let mut digest = Sha512::new();
    digest.update(r);
    digest.update(public);
    digest.update(message);
    let k = Scalar::from_hash(digest);
    let mut signature = [0u8; 64];
    signature[..32].copy_from_slice(&r);
    signature[32..].copy_from_slice(&(k * a).to_bytes());
    let mut edge = |name: String, key: [u8; 32], sig: [u8; 64], expected: bool| {
        assert_eq!(
            verify_ed25519_profile(&key, message, &sig).is_ok(),
            expected,
            "{name}"
        );
        cases.push(json!({"name":name,"op":"ed25519","public":hex::encode(key),"message":hex::encode(message),"signature":hex::encode(sig),"result":expected}));
    };
    edge("valid-identity-r".into(), public, signature, true);
    edge("reject-identity-key".into(), r, signature, false);
    for (i, t) in EIGHT_TORSION.iter().enumerate().skip(1) {
        edge(
            format!("low-order-key-{i}"),
            t.compress().to_bytes(),
            signature,
            false,
        );
        edge(
            format!("mixed-order-key-{i}"),
            (a * ED25519_BASEPOINT_POINT + t).compress().to_bytes(),
            signature,
            false,
        );
        let mut sig = signature;
        sig[..32].copy_from_slice(&t.compress().to_bytes());
        edge(format!("low-order-r-{i}"), public, sig, false);
        sig[..32].copy_from_slice(&(a * ED25519_BASEPOINT_POINT + t).compress().to_bytes());
        edge(format!("mixed-order-r-{i}"), public, sig, false);
    }
    let mut noncanonical = r;
    noncanonical[31] |= 0x80;
    edge("negative-zero-key".into(), noncanonical, signature, false);
    let mut sig = signature;
    sig[..32].copy_from_slice(&noncanonical);
    edge("negative-zero-r".into(), public, sig, false);
    let l = hex::decode(format!(
        "edd3f55c1a631258d69cf7a2def9de14{}10",
        "00".repeat(15)
    ))
    .unwrap();
    sig = signature;
    sig[32..].copy_from_slice(&l);
    edge("scalar-equals-L".into(), public, sig, false);
    sig = signature;
    sig[32] ^= 1;
    edge("invalid-equation".into(), public, sig, false);
    // The decoded identity must still use its canonical point encoding.
    let ncr_key: [u8; 32] =
        hex::decode("b862409fb5c4c4123df2abf7462b88f041ad36dd6864ce872fd5472be363c5b1")
            .unwrap()
            .try_into()
            .unwrap();
    let mut ncr_sig: [u8; 64] = hex::decode("eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7ff9d7e4796c00b5f26decb3b1c85147bdd3069f9d71f38631b7705c7ee53e0b0a").unwrap().try_into().unwrap();
    for sign in [false, true] {
        if sign {
            ncr_sig[31] |= 0x80;
            // The challenge includes the encoded R bytes, including this sign bit.
            ncr_sig[32..].copy_from_slice(
                &hex::decode("ae23e3babba78b2649aadd2d9b631787fed834204ce0f141fe9dbfec7ea1af01")
                    .unwrap(),
            );
        }
        assert!(verify_ed25519_profile(&ncr_key, b"noncanonical identity R", &ncr_sig).is_err());
        cases.push(json!({"name":if sign {"noncanonical-identity-r-sign"} else {"noncanonical-identity-r"},"op":"ed25519","public":hex::encode(ncr_key),"message":hex::encode(b"noncanonical identity R"),"signature":hex::encode(ncr_sig),"result":false}));
    }
    let public =
        hex::decode("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a").unwrap();
    let signature=hex::decode("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b").unwrap();
    assert!(
        verify_ed25519_profile(
            &public.clone().try_into().unwrap(),
            b"",
            &signature.clone().try_into().unwrap()
        )
        .is_ok()
    );
    cases.push(json!({"name":"rfc8032-empty-message","op":"ed25519","public":hex::encode(public),"message":"","signature":hex::encode(signature),"result":true}));
    println!(
        "{}",
        serde_json::to_string_pretty(
            &json!({"disposable":true,"fixture_rights":"CC0-1.0","cases":cases})
        )
        .unwrap()
    );
}
