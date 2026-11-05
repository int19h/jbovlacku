use jvc_rank::{Rational, approximate, rational};
use jvc_state::{Context, EvaluationInput, Limits, evaluate, prepare_approximate_context};
use num_bigint::BigInt;
use num_traits::One;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

fn power(exponent: i32) -> Rational {
    if exponent >= 0 {
        Rational::from_integer(BigInt::one() << exponent as usize)
    } else {
        Rational::new(BigInt::one(), BigInt::one() << (-exponent) as usize)
    }
}
fn bits(value: f64) -> String {
    format!("{:016x}", value.to_bits())
}
fn prepared(weights: &[Rational], blocked: &[usize]) -> Value {
    let weights: BTreeMap<_, _> = weights
        .iter()
        .enumerate()
        .map(|(i, w)| (format!("actor-{i:04}"), w.clone()))
        .collect();
    let blocked = blocked.iter().map(|i| format!("actor-{i:04}")).collect();
    match approximate::normalize_row(&weights, &blocked) {
        Ok(row) => json!(
            row.into_iter()
                .map(|(id, value)| (id, bits(value)))
                .collect::<BTreeMap<_, _>>()
        ),
        Err(error) => json!({"error": error.to_string()}),
    }
}

pub fn vectors() -> Value {
    let mut cases = BTreeMap::new();
    for (name, weights, blocked) in [
        ("empty", vec![], vec![]),
        ("equal", vec![rational(1, 1), rational(1, 1)], vec![]),
        (
            "below-one",
            vec![rational(1, 10), rational(1, 5), rational(3, 10)],
            vec![],
        ),
        ("exact-one", vec![rational(1, 3), rational(2, 3)], vec![]),
        (
            "just-below-one",
            vec![
                rational(1, 2),
                rational(9_007_199_254_740_991, 18_014_398_509_481_984),
            ],
            vec![],
        ),
        ("blocked", vec![rational(2, 3), rational(1, 3)], vec![0]),
        (
            "all-blocked",
            vec![rational(1, 1), rational(1, 1)],
            vec![0, 1],
        ),
        ("huge-normal-ratios", vec![power(1100), power(1000)], vec![]),
        ("huge-tiny-ratio", vec![power(2000), rational(1, 1)], vec![]),
        (
            "subnormal-ratio",
            vec![rational(1, 1), power(-1023)],
            vec![],
        ),
        ("zero-ratio", vec![rational(1, 1), power(-2000)], vec![]),
        ("subnormal-raw", vec![power(-1023), power(-1024)], vec![]),
        ("zero-raw", vec![power(-2000), power(-2001)], vec![]),
        ("minimum-normal-raw", vec![power(-1022)], vec![]),
        ("nonpositive", vec![rational(0, 1)], vec![]),
        ("negative", vec![rational(-1, 1)], vec![]),
        ("rational-limit", vec![power(16384)], vec![]),
        (
            "private-denominators",
            [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53]
                .map(|d| rational(1, d))
                .to_vec(),
            vec![],
        ),
    ] {
        let result = prepared(&weights, &blocked);
        if matches!(
            name,
            "huge-tiny-ratio" | "subnormal-ratio" | "zero-ratio" | "subnormal-raw" | "zero-raw"
        ) {
            assert_eq!(result["error"], "numeric_unavailable");
        }
        if name == "below-one" {
            for (i, w) in weights.iter().enumerate() {
                assert_eq!(
                    result[format!("actor-{i:04}")],
                    bits(approximate::input(w, false).unwrap())
                );
            }
        }
        if name == "huge-normal-ratios" {
            assert!(result.get("error").is_none());
        }
        if name == "blocked" {
            assert_eq!(result["actor-0001"], bits(1.0 / 3.0));
        }
        let reversed: BTreeMap<_, _> = weights
            .iter()
            .enumerate()
            .rev()
            .map(|(i, w)| (format!("actor-{i:04}"), w.clone()))
            .collect();
        let blocked_set = blocked.iter().map(|i| format!("actor-{i:04}")).collect();
        let again = approximate::normalize_row(&reversed, &blocked_set);
        assert_eq!(
            again
                .as_ref()
                .map(|row| json!(
                    row.iter()
                        .map(|(k, v)| (k.clone(), bits(*v)))
                        .collect::<BTreeMap<_, _>>()
                ))
                .unwrap_or_else(|e| json!({"error":e.to_string()})),
            result
        );
        cases.insert(name.to_owned(), result);
    }
    for (name, value, allow_zero) in [
        ("zero-allowed", rational(0, 1), true),
        ("zero-forbidden", rational(0, 1), false),
        ("normal-input", rational(1, 10), false),
        ("negative-normal-input", rational(-1, 2), false),
        ("subnormal-input", power(-1074), true),
        ("underflow-input", power(-2000), true),
        ("overflow-input", power(2000), true),
    ] {
        cases.insert(
            name.into(),
            match approximate::input(&value, allow_zero) {
                Ok(v) => json!(bits(v)),
                Err(e) => json!({"error":e.to_string()}),
            },
        );
    }
    let p = (BigInt::one() << 16300usize) - 1;
    let q = (BigInt::one() << 16299usize) - 1;
    let wide = vec![
        Rational::new(&p - 1, &p + BigInt::from(0)),
        Rational::new(&q - 1, &q + BigInt::from(0)),
    ];
    let wide_map = BTreeMap::from([
        ("actor-0000".into(), wide[0].clone()),
        ("actor-0001".into(), wide[1].clone()),
    ]);
    assert!(jvc_rank::normalize_row(&wide_map, &BTreeSet::new()).is_err());
    let wide_result = prepared(&wide, &[]);
    assert!(wide_result.get("error").is_none());
    cases.insert("no-exact-denominator-sum".into(), wide_result);
    let ceiling = approximate::ROW_SUM_CEILING;
    for (name, value, accepted) in [
        (
            "row-below-ceiling",
            f64::from_bits(ceiling.to_bits() - 1),
            true,
        ),
        ("row-at-ceiling", ceiling, true),
        (
            "row-above-ceiling",
            f64::from_bits(ceiling.to_bits() + 1),
            false,
        ),
    ] {
        // These are input totals. Normalization scales all three rows toward one.
        let weights = [rational(1, 2), Rational::from_float(value - 0.5).unwrap()];
        let normalized = prepared(&weights, &[]);
        assert!(normalized.get("error").is_none());
        assert_eq!(
            normalized,
            json!({
                "actor-0000": bits(0.5 / value),
                "actor-0001": bits((value - 0.5) / value),
            })
        );
        cases.insert(format!("normalize-input-{name}"), normalized);
        let result = approximate::validate_row([0.5, value - 0.5]);
        assert_eq!(result.is_ok(), accepted);
        cases.insert(
            name.into(),
            json!({"sum_bits":bits(value),"accepted":result.is_ok()}),
        );
    }
    for (name, row) in [
        ("row-nan", vec![f64::NAN]),
        ("row-infinity", vec![f64::INFINITY]),
        ("row-subnormal", vec![f64::from_bits(1)]),
        ("row-zero", vec![0.0]),
        ("row-negative", vec![-0.5]),
    ] {
        assert!(approximate::validate_row(row).is_err());
        cases.insert(name.into(), json!(false));
    }
    let a = f64::from_bits(f64::MIN_POSITIVE.to_bits() + 1);
    assert!(approximate::validate_row([a, f64::MIN_POSITIVE]).is_ok());
    cases.insert("subnormal-correction-allowed".into(), json!(true));

    let key = |seed| jvc_core::identity_from_seed(&[seed; 32]);
    let mut input = EvaluationInput {
        events: vec![],
        bodies: BTreeMap::new(),
        selected_view: String::new(),
        overlay: None,
        import_selections: BTreeMap::new(),
        limits: Limits::default(),
    };
    let scope = json!({"kind":"*","word":"*","language":"*"});
    for (issuer, subject, value) in [
        (1, 2, "heed"),
        (1, 3, "heed"),
        (1, 4, "heed"),
        (2, 3, "shun"),
    ] {
        let event=jvc_core::sign_header(&[issuer;32], jvc_core::Header {
            version:1, issuer:key(issuer), previous:vec![], nonce:format!("{subject:032x}"),
            action:json!({"kind":"trust.set","subject":key(subject),"scope":scope,"value":value}),content:None,
        }).unwrap();
        input.events.push(event);
    }
    let policy = json!({"name":"Rows","description":[],"calculation":approximate::ALGORITHM,
        "roots":[{"identity":key(1),"q":{"numerator":1,"denominator":1}}],"excluded":[],
        "rafsi_threshold":{"numerator":1,"denominator":1},"H":{"numerator":3,"denominator":1},
        "alpha":{"numerator":1,"denominator":2},"work":1000,"import_sets":[],
        "account_witnesses":[],"account_authority":false,"notes":[]});
    let bytes = jvc_core::canonical_value(&policy).unwrap();
    let view = jvc_core::sign_header(
        &[1; 32],
        jvc_core::Header {
            version: 1,
            issuer: key(1),
            previous: vec![],
            nonce: format!("{:032x}", 99),
            action: json!({"kind":"view.publish","parents":[]}),
            content: Some(jvc_core::body_descriptor(&bytes).unwrap()),
        },
    )
    .unwrap();
    input.selected_view = view.id().to_owned();
    input.bodies.insert(view.id().to_owned(), bytes);
    input.events.push(view);
    let evaluation = evaluate(&input);
    assert!(evaluation.available);
    let context = Context {
        kind: "definition".into(),
        word: "word".into(),
        language: Some("en".into()),
    };
    for (label, a, b, c) in [
        ("scaled", rational(1, 3), rational(2, 7), rational(1, 1)),
        ("below", rational(1, 10), rational(1, 5), rational(1, 4)),
        ("one", rational(1, 3), rational(1, 3), rational(1, 3)),
    ] {
        for block in [false, true] {
            let mut trust = vec![
                json!({"issuer":key(1),"subject":key(2),"scope":scope,"value":"heed","weight":{"numerator":a.numer().to_string().parse::<u64>().unwrap(),"denominator":a.denom().to_string().parse::<u64>().unwrap()}}),
                json!({"issuer":key(1),"subject":key(3),"scope":scope,"value":"heed","weight":{"numerator":b.numer().to_string().parse::<u64>().unwrap(),"denominator":b.denom().to_string().parse::<u64>().unwrap()}}),
                json!({"issuer":key(1),"subject":key(4),"scope":scope,"value":"heed","weight":{"numerator":c.numer().to_string().parse::<u64>().unwrap(),"denominator":c.denom().to_string().parse::<u64>().unwrap()}}),
            ];
            trust.sort_by_key(|rule| jvc_core::canonical_value(rule).unwrap());
            input.overlay = Some(
                json!({"version":2,"base_view":input.selected_view,"work":null,
            "public_shun_issuer":key(2),"root_changes":[],"trust":trust,
            "blocked":if block {json!([{"identity":key(4),"scope":scope}])}else{json!([])}}),
            );
            let evaluation = evaluate(&input);
            assert!(evaluation.available);
            assert!(!evaluation.reasons.contains("invalid_overlay"));
            let graph = prepare_approximate_context(&evaluation, &context);
            assert!(graph.available);
            let weights = BTreeMap::from([
                (key(2), a.clone()),
                (key(3), b.clone()),
                (key(4), c.clone()),
            ]);
            let mut blocked = BTreeSet::from([key(3)]);
            if block {
                blocked.insert(key(4));
            }
            let expected = approximate::normalize_row(&weights, &blocked).unwrap();
            let issuer = graph.actors.iter().position(|a| a == &key(1)).unwrap();
            let got: BTreeMap<_, _> = graph.rows[issuer]
                .iter()
                .map(|e| (graph.actors[e.to].clone(), e.share.to_bits()))
                .collect();
            assert_eq!(
                got,
                expected
                    .into_iter()
                    .map(|(k, v)| (k, v.to_bits()))
                    .collect()
            );
            assert_eq!(graph.public_shun_blocked.len(), 1);
            assert_eq!(graph.private_blocked.len(), usize::from(block));
            assert_eq!(graph.refusals.iter().map(Vec::len).sum::<usize>(), 1);
            let rows = graph
                .rows
                .iter()
                .map(|r| {
                    r.iter()
                        .map(|e| json!({"to":e.to,"bits":bits(e.share)}))
                        .collect::<Vec<_>>()
                })
                .collect::<Vec<_>>();
            cases.insert(format!("state-helper-{label}-block-{block}"),json!({"actors":graph.actors,"roots":graph.roots.into_iter().map(bits).collect::<Vec<_>>(),"rows":rows,"refusals":graph.refusals,"blocked":graph.blocked,"public_shun_blocked":graph.public_shun_blocked,"private_blocked":graph.private_blocked}));
        }
    }
    json!({"contract":approximate::ROW_CONTRACT,"profile":approximate::ALGORITHM,"ceiling_bits":bits(ceiling),"cases":cases})
}
