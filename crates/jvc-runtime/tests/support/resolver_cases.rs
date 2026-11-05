use super::*;

#[test]
fn generated_signed_resolver_cases_preserve_exact_results() {
    for profile in ["simple-routes-bounds-v1", "simple-routes-shun-v1"] {
        for seed in 0..12u64 {
            let mut f = Fixture::new();
            let en = f.definition("en");
            let fr = f.definition("fr");
            let pair = jvc_core::rafsi_pair_id(&f.word, "ban").unwrap();
            for author in [8, 9] {
                f.event(author, json!({"kind":"rafsi.publish","word":f.word,"assignment":pair,"origin":"native"}),Some(json!({"word":{"language":"jbo","spelling":"banli"},"rafsi":"ban","rationale":[],"sources":[],"legacy":null})));
            }
            let broad = json!({"kind":"*","word":"*","language":"*"});
            let narrow = json!({"kind":"definition","word":f.word,"language":"en"});
            let mut random = seed + 1;
            let mut next = || {
                random = random.wrapping_mul(6364136223846793005).wrapping_add(1);
                random
            };
            for actor in 1..=5 {
                for target in [&en, &fr, &pair] {
                    let value = ["bless", "curse", "clear"][(next() % 3) as usize];
                    f.event(
                        actor,
                        json!({"kind":"judgment.set","target":target,"value":value}),
                        None,
                    );
                }
                if actor != 1 {
                    f.event(1,json!({"kind":"trust.set","subject":key(actor),"scope":broad,"value":if actor==4 {"shun"}else{"heed"}}),None);
                }
                if actor > 2 {
                    f.trust(2, actor, "heed", "*");
                }
            }
            f.view(profile, &[1, 2], 1000);
            for version in 0..=2 {
                let mut private = vec![
                    json!({"issuer":key(1),"subject":key(3),"scope":broad,"value":"heed","weight":{"numerator":seed+1,"denominator":13}}),
                    json!({"issuer":key(1),"subject":key(3),"scope":narrow,"value":"clear","weight":null}),
                    json!({"issuer":key(2),"subject":key(5),"scope":broad,"value":"heed","weight":{"numerator":2,"denominator":3}}),
                ];
                private.sort_by_key(|r| canonical_value(r).unwrap());
                f.overlay = if version == 0 {
                    None
                } else {
                    Some(local_overlay(
                        &f,
                        Some(1),
                        json!(private),
                        json!([{"identity":key(4),"scope":broad}]),
                    ))
                };
                if version == 1 {
                    let overlay = f.overlay.as_mut().unwrap();
                    overlay["version"] = json!(1);
                    overlay
                        .as_object_mut()
                        .unwrap()
                        .remove("public_shun_issuer");
                }
                let before = f.rank(&format!("generated-resolver-{profile}-{seed}-{version}"));
                f.events.reverse();
                assert_eq!(
                    f.rank(&format!(
                        "generated-resolver-reversed-{profile}-{seed}-{version}"
                    )),
                    before
                );
                f.events.reverse();
                assert!(before["unavailable_scores"].as_array().unwrap().is_empty());
                assert_eq!(before["scores"].as_array().unwrap().len(), 3);
            }
        }
    }
}
