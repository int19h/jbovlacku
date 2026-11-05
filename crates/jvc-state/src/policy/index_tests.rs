use super::*;
use serde_json::json;

fn lookup_publication(
    id: &str,
    kind: &str,
    word: &str,
    language: Option<&str>,
    assignment: Option<&str>,
) -> Publication {
    serde_json::from_value(json!({
            "id":id,"issuer":"author","kind":kind,"word":word,"language":language,"assignment":assignment,
            "lineage":{},"imported":false,"source":null,"source_record":null,"account":null,"authority":"native",
            "controller":null,"claim":null,"observations":[],"status_frontier":[],"deciding_claim":null,
            "controller_candidates":[],"witness_contributions":{},"missing":[],"content_available":false,
            "eligible":"not_selected","status":"unavailable","reasons":["synthetic unavailable publication"]
        })).unwrap()
}
// The independent oracle retains the original judgment-first predicate.
fn old_context_judgments(
    publications: &[Publication],
    judgments: &BTreeMap<String, BTreeMap<String, Judgment>>,
    context: &Context,
) -> BTreeMap<String, BTreeMap<String, Judgment>> {
    judgments
        .iter()
        .filter(|(target, _)| {
            publications.iter().any(|p| {
                (p.id == **target || p.assignment.as_ref() == Some(*target))
                    && p.word == context.word
                    && if context.kind == "definition" {
                        p.kind == "definition.publish" && p.language == context.language
                    } else {
                        p.kind == "rafsi.publish"
                    }
            })
        })
        .map(|(target, values)| (target.clone(), values.clone()))
        .collect()
}
fn lookup_fixture() -> (
    Vec<Publication>,
    BTreeMap<String, BTreeMap<String, Judgment>>,
) {
    let mut publications = vec![
        lookup_publication(
            "d-en",
            "definition.publish",
            "word",
            Some("en"),
            Some("definition-alias"),
        ),
        lookup_publication(
            "d-fr",
            "definition.publish",
            "word",
            Some("fr"),
            Some("shared"),
        ),
        lookup_publication("d-none", "definition.publish", "word", None, None),
        lookup_publication(
            "d-other",
            "definition.publish",
            "other",
            Some("en"),
            Some("alias-other"),
        ),
        lookup_publication("r-en", "rafsi.publish", "word", Some("en"), Some("shared")),
        lookup_publication("r-fr", "rafsi.publish", "word", Some("fr"), Some("shared")),
        lookup_publication(
            "r-missing",
            "rafsi.publish",
            "word",
            None,
            Some("missing-judgments"),
        ),
        lookup_publication(
            "unexpected",
            "identity.profile",
            "word",
            Some("en"),
            Some("unexpected-alias"),
        ),
        lookup_publication(
            "d-en",
            "definition.publish",
            "word",
            Some("en"),
            Some("empty-judgment"),
        ),
        lookup_publication(
            "d-empty-alias",
            "definition.publish",
            "word",
            Some("en"),
            Some(""),
        ),
        lookup_publication("r-repeat", "rafsi.publish", "word", None, Some("r-en")),
    ];
    publications[1].eligible = Eligibility::Eligible;
    publications[1].status = Status::Active;
    publications[1].content_available = true;
    publications[4].eligible = Eligibility::Inactive;
    publications[4].status = Status::Conflicted;
    publications[5].eligible = Eligibility::Unknown;
    publications[5].status = Status::Deprecated;
    let targets = [
        "",
        "d-en",
        "d-fr",
        "d-none",
        "d-other",
        "definition-alias",
        "shared",
        "r-en",
        "r-fr",
        "r-repeat",
        "empty-judgment",
        "alias-other",
        "unexpected",
        "unexpected-alias",
        "orphan",
        "map-key-only",
    ];
    let mut judgments: BTreeMap<_, _> = targets
        .into_iter()
        .map(|target| {
            (
                target.into(),
                BTreeMap::from([("reviewer".into(), Judgment::Bless)]),
            )
        })
        .collect();
    judgments.insert("empty-judgment".into(), BTreeMap::new());
    judgments
        .get_mut("d-en")
        .unwrap()
        .insert("clear-reviewer".into(), Judgment::Clear);
    judgments
        .get_mut("shared")
        .unwrap()
        .insert("conflicted-reviewer".into(), Judgment::Conflicted);
    (publications, judgments)
}
fn lookup_cases() -> Vec<(Context, Vec<&'static str>)> {
    vec![
        (
            Context {
                kind: "definition".into(),
                word: "word".into(),
                language: Some("en".into()),
            },
            vec!["", "d-en", "definition-alias", "empty-judgment"],
        ),
        (
            Context {
                kind: "definition".into(),
                word: "word".into(),
                language: Some("fr".into()),
            },
            vec!["d-fr", "shared"],
        ),
        (
            Context {
                kind: "definition".into(),
                word: "word".into(),
                language: None,
            },
            vec!["d-none"],
        ),
        (
            Context {
                kind: "definition".into(),
                word: "word".into(),
                language: Some("de".into()),
            },
            vec![],
        ),
        (
            Context {
                kind: "definition".into(),
                word: "other".into(),
                language: Some("en".into()),
            },
            vec!["alias-other", "d-other"],
        ),
        (
            Context {
                kind: "rafsi".into(),
                word: "word".into(),
                language: None,
            },
            vec!["r-en", "r-fr", "r-repeat", "shared"],
        ),
        (
            Context {
                kind: "rafsi".into(),
                word: "word".into(),
                language: Some("de".into()),
            },
            vec!["r-en", "r-fr", "r-repeat", "shared"],
        ),
        (
            Context {
                kind: "other-kind".into(),
                word: "word".into(),
                language: None,
            },
            vec!["r-en", "r-fr", "r-repeat", "shared"],
        ),
    ]
}
#[test]
fn context_target_lookup_matches_independent_membership_cases_and_old_predicate() {
    let (publications, judgments) = lookup_fixture();
    for (context, expected) in lookup_cases() {
        let targets = context_target_ids(publications.iter(), &context);
        let actual = judgments_for_targets(targets.into_iter(), &judgments);
        assert_eq!(
            actual.keys().map(String::as_str).collect::<Vec<_>>(),
            expected
        );
        assert_eq!(
            actual,
            old_context_judgments(&publications, &judgments, &context)
        );
    }
    let context = &lookup_cases()[0].0;
    assert!(context_target_ids(std::iter::empty(), context).is_empty());
    assert!(
        judgments_for_targets(
            context_target_ids(publications.iter(), context).into_iter(),
            &BTreeMap::new()
        )
        .is_empty()
    );
}
#[test]
fn context_target_lookup_scans_publications_once_and_only_looks_up_matching_ids() {
    use std::cell::Cell;
    let count = 1000usize;
    let mut publications: Vec<_> = (0..count)
        .map(|i| {
            lookup_publication(
                &format!("publication-{i}"),
                "definition.publish",
                "other",
                Some("en"),
                None,
            )
        })
        .collect();
    publications.last_mut().unwrap().word = "word".into();
    publications.last_mut().unwrap().assignment = Some("missing-alias".into());
    let context = Context {
        kind: "definition".into(),
        word: "word".into(),
        language: Some("en".into()),
    };
    for judged in [0, 16, 1000, 60_000] {
        let mut judgments: BTreeMap<_, _> = (0..judged)
            .map(|i| (format!("unrelated-{i}"), BTreeMap::new()))
            .collect();
        judgments.insert("publication-999".into(), BTreeMap::new());
        let scans = Cell::new(0);
        let lookups = Cell::new(0);
        let targets = context_target_ids(
            publications.iter().inspect(|_| scans.set(scans.get() + 1)),
            &context,
        );
        let actual = judgments_for_targets(
            targets
                .into_iter()
                .inspect(|_| lookups.set(lookups.get() + 1)),
            &judgments,
        );
        assert_eq!(scans.get(), count);
        assert_eq!(lookups.get(), 2);
        assert_eq!(actual.len(), 1);
        if judged == 1000 {
            let old_scans = Cell::new(0);
            let old: Vec<_> = judgments
                .keys()
                .filter(|target| {
                    publications.iter().any(|p| {
                        old_scans.set(old_scans.get() + 1);
                        (p.id == **target || p.assignment.as_ref() == Some(*target))
                            && p.word == context.word
                            && p.kind == "definition.publish"
                            && p.language == context.language
                    })
                })
                .collect();
            assert_eq!(old.len(), 1);
            assert_eq!(old_scans.get(), count * (judged + 1));
        }
    }
}

fn evaluation(profile: &str) -> Evaluation {
    let mut e = evaluate(&EvaluationInput {
        events: Vec::new(),
        bodies: BTreeMap::new(),
        selected_view: String::new(),
        overlay: None,
        import_selections: BTreeMap::new(),
        limits: Limits::default(),
    });
    e.available = true;
    e.reasons.clear();
    e.policy = Some(
        json!({"calculation":profile,"roots":[{"identity":"a0","q":{"numerator":1,"denominator":1}}],"excluded":[]}),
    );
    e
}
fn trust(actor: &str, subject: &str, scope: Value, values: &[&str]) -> TrustRule {
    TrustRule {
        actor: actor.into(),
        subject: subject.into(),
        scope,
        values: values.iter().map(|v| (*v).into()).collect(),
    }
}
fn shares(e: &Evaluation, context: &Context) -> Vec<(String, Rational)> {
    let graph = evaluate_context(e, context);
    let issuer = graph.actors.iter().position(|a| a == "a0").unwrap();
    graph.rows[issuer]
        .iter()
        .map(|edge| (graph.actors[edge.to].clone(), edge.share.clone()))
        .collect()
}
#[test]
fn private_weights_use_retained_scopes_and_clear_fallback() {
    for profile in ["simple-routes-bounds-v1", "simple-routes-shun-v1"] {
        let mut e = evaluation(profile);
        let broad = json!({"kind":"*","word":"*","language":"*"});
        let en = json!({"kind":"definition","word":"word","language":"en"});
        let fr = json!({"kind":"definition","word":"word","language":"fr"});
        e.trust = (1..=3)
            .map(|i| trust("a0", &format!("a{i}"), broad.clone(), &["heed"]))
            .collect();
        e.trust.push(trust("a0", "a1", en.clone(), &["heed"]));
        e.overlay = Some(json!({"version":1,"root_changes":[],"blocked":[],"trust":[
            {"issuer":"a0","subject":"a1","scope":broad,"value":"heed","weight":{"numerator":1,"denominator":2}},
            {"issuer":"a0","subject":"a1","scope":fr,"value":"heed","weight":{"numerator":3,"denominator":4}},
            {"issuer":"a0","subject":"a1","scope":{"kind":"definition","word":"other","language":"en"},"value":"heed","weight":{"numerator":2,"denominator":3}},
            {"issuer":"a0","subject":"a2","scope":broad,"value":"heed","weight":{"numerator":2,"denominator":3}}
        ]}));
        let mut context = Context {
            kind: "definition".into(),
            word: "word".into(),
            language: Some("en".into()),
        };
        let expected = |ns: [i64; 3], d| {
            ns.into_iter()
                .enumerate()
                .map(|(i, n)| (format!("a{}", i + 1), jvc_rank::rational(n, d)))
                .collect::<Vec<_>>()
        };
        assert_eq!(shares(&e, &context), expected([3, 2, 3], 8));
        context.language = Some("fr".into());
        assert_eq!(shares(&e, &context), expected([9, 8, 12], 29));
        context.language = Some("en".into());
        e.overlay.as_mut().unwrap()["trust"]
            .as_array_mut()
            .unwrap()
            .push(json!({"issuer":"a0","subject":"a1","scope":en,"value":"clear","weight":null}));
        assert_eq!(shares(&e, &context), expected([3, 4, 6], 13));
    }
}

#[test]
fn continuity_aliases_keep_weight_conflicts_and_both_block_sources() {
    for profile in ["simple-routes-bounds-v1", "simple-routes-shun-v1"] {
        let mut e = evaluation(profile);
        e.lifecycle.key_actor.insert("old-root".into(), "a0".into());
        e.lifecycle
            .key_actor
            .insert("old-subject".into(), "a1".into());
        let broad = json!({"kind":"*","word":"*","language":"*"});
        e.trust = vec![
            trust("a0", "a1", broad.clone(), &["shun"]),
            trust("a0", "a2", broad.clone(), &["heed"]),
        ];
        e.overlay = Some(
            json!({"version":2,"public_shun_issuer":"old-root","root_changes":[],"blocked":[{"identity":"old-subject","scope":broad}],"trust":[
                {"issuer":"old-root","subject":"old-subject","scope":broad,"value":"heed","weight":{"numerator":1,"denominator":2}},
                {"issuer":"a0","subject":"a1","scope":broad,"value":"heed","weight":{"numerator":2,"denominator":3}}
            ]}),
        );
        let context = Context {
            kind: "definition".into(),
            word: "word".into(),
            language: Some("en".into()),
        };
        let graph = evaluate_context(&e, &context);
        let a1 = graph.actors.iter().position(|a| a == "a1").unwrap();
        assert!(graph.public_shun_blocked.contains(&a1));
        assert!(graph.private_blocked.contains(&a1));
        assert!(graph.rows.iter().flatten().all(|edge| edge.to != a1));
        // Removing both blocks leaves the conflicting private weights in effect.
        e.trust[0].values = BTreeSet::from(["heed".into()]);
        e.overlay.as_mut().unwrap()["blocked"] = json!([]);
        assert_eq!(
            shares(&e, &context),
            vec![("a2".into(), jvc_rank::rational(1, 1))]
        );
        // Agreeing alias weights count once and normalize before a private block.
        e.overlay.as_mut().unwrap()["trust"][1]["weight"] = json!({"numerator":1,"denominator":2});
        e.overlay.as_mut().unwrap()["blocked"] = json!([{"identity":"old-subject","scope":broad}]);
        assert_eq!(
            shares(&e, &context),
            vec![("a2".into(), jvc_rank::rational(2, 3))]
        );
    }
}

fn ranking_bytes(graph: &ContextGraph, work: u64) -> Vec<u8> {
    use jvc_rank::{Candidate, Edge, Eligibility, Graph, Parameters, Verdict};
    let resolved = Graph::with_refusals(
        jvc_rank::Profile::from_name(&graph.calculation).unwrap(),
        graph.actors.clone(),
        graph.roots.clone(),
        graph
            .rows
            .iter()
            .map(|row| {
                row.iter()
                    .map(|e| Edge {
                        to: e.to,
                        share: e.share.clone(),
                    })
                    .collect()
            })
            .collect(),
        graph.refusals.clone(),
        &Default::default(),
    )
    .unwrap();
    let rank = jvc_rank::rank(
        &resolved,
        &Parameters {
            work,
            ..Default::default()
        },
        Default::default(),
    )
    .unwrap();
    let candidates: Vec<_> = graph
        .judgments
        .iter()
        .map(|(id, judgments)| Candidate {
            id: id.clone(),
            eligibility: Eligibility::Eligible,
            deprecated: false,
            verdicts: graph
                .actors
                .iter()
                .map(|actor| match judgments.get(actor) {
                    Some(Judgment::Bless) => Verdict::Bless,
                    Some(Judgment::Curse) => Verdict::Curse,
                    _ => Verdict::Absent,
                })
                .collect(),
        })
        .collect();
    let scores:Vec<_> = candidates.iter().map(|c| {let s=jvc_rank::score(c,&rank.weights).unwrap();json!({"target":c.id,"support":[s.support.lower,s.support.upper],"opposition":[s.opposition.lower,s.opposition.upper],"net":[s.net.lower,s.net.upper]})}).collect();
    let differences: Vec<_> = candidates
        .iter()
        .enumerate()
        .flat_map(|(i, a)| {
            candidates[i + 1..].iter().map(|b| {
                let d = jvc_rank::difference(a, b, &rank.weights).unwrap();
                json!([a.id, b.id, d.lower, d.upper])
            })
        })
        .collect();
    let layers =
        jvc_rank::nondominated_layers(&candidates, &rank.weights, &Default::default()).unwrap();
    serde_json::to_vec(&json!({"weights":rank.weights.iter().map(|w|json!([w.lower,w.upper])).collect::<Vec<_>>(),"completed":rank.completed_work,"stages":rank.complete_stages,"exact":rank.exact,"scores":scores,"differences":differences,"layers":layers})).unwrap()
}

#[test]
fn generated_exact_contexts_and_rankings_match_main_bytes() {
    let (publications, _) = lookup_fixture();
    let scopes = [
        json!({"kind":"*","word":"*","language":"*"}),
        json!({"kind":"definition","word":"word","language":"en"}),
        json!({"kind":"definition","word":"*","language":"fr"}),
        json!({"kind":"rafsi","word":"word","language":"*"}),
    ];
    let mut cases = 0;
    for profile in ["simple-routes-bounds-v1", "simple-routes-shun-v1"] {
        for seed in 0..24u64 {
            let mut random = seed + 1;
            let mut next = || {
                random = random.wrapping_mul(6364136223846793005).wrapping_add(1);
                random
            };
            let mut e = evaluation(profile);
            e.publications = publications
                .iter()
                .enumerate()
                .map(|(i, p)| (format!("map-key-{i}"), p.clone()))
                .collect();
            for p in &publications {
                for target in std::iter::once(&p.id).chain(p.assignment.iter()) {
                    let judgments = e.judgments.entry(target.clone()).or_default();
                    for i in 0..5 {
                        let verdict = match next() % 5 {
                            0 => Judgment::Bless,
                            1 => Judgment::Curse,
                            2 => Judgment::Clear,
                            3 => Judgment::Conflicted,
                            _ => continue,
                        };
                        judgments.insert(format!("a{i}"), verdict);
                    }
                }
            }
            let mut private = vec![];
            for i in 0..5 {
                e.lifecycle
                    .key_actor
                    .insert(format!("old-a{i}"), format!("a{i}"));
                for j in 0..5 {
                    if i == j {
                        continue;
                    }
                    let scope = scopes[(next() % 4) as usize].clone();
                    let value = match next() % 4 {
                        0 => "shun",
                        1 => "clear",
                        _ => "heed",
                    };
                    e.trust.push(trust(
                        &format!("a{i}"),
                        &format!("a{j}"),
                        scope.clone(),
                        &[value],
                    ));
                    if next().is_multiple_of(2) {
                        private.push(json!({"issuer":format!("old-a{i}"),"subject":format!("old-a{j}"),"scope":scope,"value":value,"weight":if value=="heed" {json!({"numerator":next()%3+1,"denominator":5})}else{Value::Null}}));
                    }
                }
            }
            for version in 0..=2 {
                e.overlay = if version == 0 {
                    None
                } else {
                    Some(
                        json!({"version":version,"public_shun_issuer":"old-a0","root_changes":[],"trust":private,"blocked":[{"identity":"old-a1","scope":scopes[0]}]}),
                    )
                };
                // Version 1 has no selected public issuer.
                if version == 1 {
                    e.overlay
                        .as_mut()
                        .unwrap()
                        .as_object_mut()
                        .unwrap()
                        .remove("public_shun_issuer");
                }
                let state = serde_json::to_vec(&e).unwrap();
                for (kind, language) in [
                    ("definition", Some("en")),
                    ("definition", Some("fr")),
                    ("rafsi", None),
                ] {
                    let context = Context {
                        kind: kind.into(),
                        word: "word".into(),
                        language: language.map(str::to_owned),
                    };
                    let expected = super::reference::evaluate_context_with_limit(
                        &e,
                        &context,
                        MAX_CONTEXT_REFUSALS,
                    );
                    let actual = evaluate_context(&e, &context);
                    assert_eq!(
                        serde_json::to_vec(&actual).unwrap(),
                        serde_json::to_vec(&expected).unwrap(),
                        "seed={seed} version={version} context={context:?}"
                    );
                    for work in [1, 7, 1000] {
                        assert_eq!(ranking_bytes(&actual, work), ranking_bytes(&expected, work));
                    }
                    assert_eq!(serde_json::to_vec(&e).unwrap(), state);
                    cases += 1;
                }
            }
        }
    }
    assert_eq!(cases, 432);
}
