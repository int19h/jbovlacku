#[test]
fn malformed_overlay_is_unavailable_without_a_panic() {
    let result = jvc_runtime::evaluate_bytes(include_bytes!("invalid-overlay.json")).unwrap();
    assert_eq!(result["available"], false);
    assert!(
        result["reasons"]
            .as_array()
            .unwrap()
            .iter()
            .any(|reason| reason == "invalid_overlay")
    );
}

use jvc_core::{
    Header, body_descriptor, canonical_value, identity_from_seed, sign_header, validate_body,
    word_id,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

fn key(seed: u8) -> String {
    identity_from_seed(&[seed; 32])
}
struct Fixture {
    events: Vec<String>,
    bodies: BTreeMap<String, String>,
    word: String,
    nonce: u64,
    selected_view: String,
    overlay: Option<Value>,
}
impl Fixture {
    fn new() -> Self {
        Self {
            events: Vec::new(),
            bodies: BTreeMap::new(),
            word: word_id(&json!({"language":"jbo","spelling":"banli"})).unwrap(),
            nonce: 0,
            selected_view: String::new(),
            overlay: None,
        }
    }
    fn event(&mut self, seed: u8, action: Value, body: Option<Value>) -> String {
        self.event_after(seed, Vec::new(), action, body)
    }
    fn event_after(
        &mut self,
        seed: u8,
        mut previous: Vec<String>,
        action: Value,
        body: Option<Value>,
    ) -> String {
        self.nonce += 1;
        let bytes = body.as_ref().map(|body| canonical_value(body).unwrap());
        previous.sort();
        previous.dedup();
        let header = Header {
            version: 1,
            issuer: key(seed),
            previous,
            nonce: format!("{:032x}", self.nonce),
            action,
            content: bytes.as_ref().map(|bytes| body_descriptor(bytes).unwrap()),
        };
        if let Some(body) = &body {
            validate_body(&header, body).unwrap();
        }
        let event = sign_header(&[seed; 32], header).unwrap();
        let id = event.id().to_owned();
        self.events
            .push(String::from_utf8(event.canonical_envelope().unwrap()).unwrap());
        if let Some(bytes) = bytes {
            self.bodies
                .insert(id.clone(), String::from_utf8(bytes).unwrap());
        }
        id
    }
    fn definition(&mut self, language: &str) -> String {
        let mut body: Value = serde_json::from_str(include_str!(
            "../../jvc-core/tests/fixtures/definition.json"
        ))
        .unwrap();
        body["language"] = json!(language);
        self.event(9, json!({"kind":"definition.publish","word":self.word,"language":language,"parents":[],"origin":"native"}), Some(body))
    }
    fn trust(&mut self, from: u8, to: u8, value: &str, language: &str) {
        self.event(from, json!({"kind":"trust.set","subject":key(to),"scope":{"kind":"definition","word":"*","language":language},"value":value}), None);
    }
    fn bless(&mut self, seed: u8, target: &str) {
        self.event(
            seed,
            json!({"kind":"judgment.set","target":target,"value":"bless"}),
            None,
        );
    }
    fn view(&mut self, profile: &str, roots: &[u8], work: u64) -> String {
        self.view_with_exclusions(profile, roots, &[], work)
    }
    fn view_with_exclusions(
        &mut self,
        profile: &str,
        roots: &[u8],
        excluded: &[u8],
        work: u64,
    ) -> String {
        let mut roots: Vec<_> = roots
            .iter()
            .map(|seed| json!({"identity":key(*seed),"q":{"numerator":1,"denominator":1}}))
            .collect();
        roots.sort_by_key(|root| root["identity"].as_str().unwrap().to_owned());
        let parent = self.selected_view.clone();
        let parents: Vec<_> = if parent.is_empty() {
            Vec::new()
        } else {
            vec![parent]
        };
        let mut excluded: Vec<_> = excluded
            .iter()
            .map(|seed| json!({"identity":key(*seed),"evidence":[]}))
            .collect();
        excluded.sort_by_key(|item| item["identity"].as_str().unwrap().to_owned());
        let id = self.event(20, json!({"kind":"view.publish","parents":parents}), Some(json!({"name":"fixture","description":[],"roots":roots,"rafsi_threshold":{"numerator":1,"denominator":1},"H":{"numerator":3,"denominator":1},"alpha":{"numerator":1,"denominator":2},"excluded":excluded,"calculation":profile,"work":work,"import_sets":[],"account_witnesses":[],"account_authority":false,"notes":[]})));
        self.selected_view = id.clone();
        id
    }
    fn bytes(&self) -> Vec<u8> {
        canonical_value(&json!({"events":self.events,"bodies":self.bodies,"selected_view":self.selected_view,"import_selections":{},"overlay":self.overlay})).unwrap()
    }
    fn rank(&self, name: &str) -> Value {
        let bytes = self.bytes();
        let result = jvc_runtime::rank_word_bytes(&bytes, &self.word).unwrap();
        let session = jvc_runtime::EvaluationSession::new(&bytes).unwrap();
        let details: Value =
            serde_json::from_str(&session.rank_with_reviewers(&self.word, 16).unwrap()).unwrap();
        if let Ok(directory) = std::env::var("JVC_SHUN_PARITY_DIR") {
            std::fs::create_dir_all(&directory).unwrap();
            let path = std::path::Path::new(&directory).join(format!("{name}.json"));
            std::fs::write(path, serde_json::to_vec(&json!({"input":String::from_utf8(bytes).unwrap(),"word":self.word,"expected":result,"reviewers":details})).unwrap()).unwrap();
        }
        result
    }
    fn reviewers(&self) -> Value {
        let session = jvc_runtime::EvaluationSession::new(&self.bytes()).unwrap();
        serde_json::from_str(&session.rank_with_reviewers(&self.word, 16).unwrap()).unwrap()
    }
}
fn score<'a>(result: &'a Value, target: &str) -> &'a Value {
    result["scores"]
        .as_array()
        .unwrap()
        .iter()
        .find(|score| score["target"] == target)
        .unwrap()
}
fn exact_net(result: &Value, target: &str, n: &str, d: &str) {
    let score = score(result, target);
    assert_eq!(score["net"][0], json!({"numerator":n,"denominator":d}));
    assert_eq!(score["net"][1], score["net"][0]);
}

#[test]
fn signed_views_select_old_and_new_routing_without_reinterpretation() {
    let mut f = Fixture::new();
    let target = f.definition("en");
    for (from, to) in [(1, 2), (2, 3), (3, 4)] {
        f.trust(from, to, "heed", "*");
    }
    f.trust(2, 4, "shun", "*");
    f.bless(4, &target);
    let old = f.view("simple-routes-bounds-v1", &[1], 1000);
    exact_net(&f.rank("chain-old"), &target, "3", "4");
    let new = f.view("simple-routes-shun-v1", &[1], 1000);
    let result = f.rank("chain-new");
    exact_net(&result, &target, "0", "1");
    assert_eq!(result["calculation"]["algorithm"], "simple-routes-shun-v1");
    assert_eq!(result["calculation"]["exact"], true);
    let details = f.reviewers();
    let target_details = score(&details, &target);
    assert_eq!(target_details["direct_reviewers"], 1);
    assert_eq!(target_details["reviewers"][0]["identity"], key(4));
    assert_eq!(target_details["reviewers"][0]["blocked"], false);
    assert_eq!(target_details["reviewers"][0]["incoming_count"], 1);
    assert_eq!(
        target_details["reviewers"][0]["weight"][0]["numerator"],
        "0"
    );
    f.selected_view = old;
    let result = f.rank("old-view-after-new-publication");
    exact_net(&result, &target, "3", "4");
    assert_eq!(
        result["calculation"]["algorithm"],
        "simple-routes-bounds-v1"
    );
    f.selected_view = new;
    f.view("simple-routes-shun-v1", &[1], 2);
    let partial = f.rank("chain-new-partial");
    assert_eq!(partial["calculation"]["exact"], false);
    assert_eq!(score(&partial, &target)["net"][0]["numerator"], "0");
    assert_ne!(score(&partial, &target)["net"][1]["numerator"], "0");
}

#[test]
fn equal_positive_graphs_different_language_refusals_do_not_reuse_weights() {
    let mut f = Fixture::new();
    let en = f.definition("en");
    let fr = f.definition("fr");
    for (from, to) in [(1, 2), (2, 3), (3, 4)] {
        f.trust(from, to, "heed", "*");
    }
    f.trust(2, 4, "shun", "en");
    f.bless(4, &en);
    f.bless(4, &fr);
    f.view("simple-routes-shun-v1", &[1], 1000);
    let result = f.rank("scoped-refusals");
    exact_net(&result, &en, "0", "1");
    exact_net(&result, &fr, "3", "4");
    assert_eq!(result["calculation"]["completed"], 6);
    f.view("simple-routes-bounds-v1", &[1], 1000);
    let result = f.rank("scoped-refusals-old");
    exact_net(&result, &en, "3", "4");
    exact_net(&result, &fr, "3", "4");
    assert_eq!(result["calculation"]["completed"], 3);
}

#[test]
fn diamond_continuation_and_independent_root_have_nonzero_scores() {
    let mut f = Fixture::new();
    let target = f.definition("en");
    for (from, to) in [(1, 2), (1, 6), (2, 3), (3, 4), (6, 4), (4, 5)] {
        f.trust(from, to, "heed", "*");
    }
    f.trust(2, 4, "shun", "*");
    f.bless(5, &target);
    for (profile, n, d) in [
        ("simple-routes-bounds-v1", "9", "16"),
        ("simple-routes-shun-v1", "3", "8"),
    ] {
        f.view(profile, &[1], 1000);
        exact_net(&f.rank(&format!("diamond-{profile}")), &target, n, d);
    }
    // X's own starting route supplies C independently of A's refused route.
    f.view("simple-routes-shun-v1", &[1, 6], 1000);
    exact_net(&f.rank("independent-root"), &target, "15", "8");
}

#[test]
fn shared_weights_keep_each_contexts_own_judgments() {
    let mut f = Fixture::new();
    let en = f.definition("en");
    let fr = f.definition("fr");
    f.trust(1, 2, "heed", "*");
    f.bless(2, &en);
    f.bless(2, &fr);
    for profile in ["simple-routes-bounds-v1", "simple-routes-shun-v1"] {
        f.view(profile, &[1], 1000);
        let result = f.rank(&format!("shared-weights-{profile}"));
        exact_net(&result, &en, "3", "1");
        exact_net(&result, &fr, "3", "1");
        assert_eq!(result["calculation"]["completed"], 1);
    }
}

#[test]
fn unknown_view_profile_never_falls_back_to_invented_scores() {
    let mut f = Fixture::new();
    let target = f.definition("en");
    f.bless(1, &target);
    f.view("simple-routes-bounds-v1", &[1], 1000);
    let mut body: Value = serde_json::from_str(&f.bodies[&f.selected_view]).unwrap();
    body["calculation"] = json!("unsupported-profile");
    let bytes = canonical_value(&body).unwrap();
    let header = Header {
        version: 1,
        issuer: key(20),
        previous: vec![],
        nonce: "ff".repeat(16),
        action: json!({"kind":"view.publish","parents":[]}),
        content: Some(body_descriptor(&bytes).unwrap()),
    };
    assert!(validate_body(&header, &body).is_err());
    let event = sign_header(&[20; 32], header).unwrap();
    f.selected_view = event.id().to_owned();
    f.events
        .push(String::from_utf8(event.canonical_envelope().unwrap()).unwrap());
    f.bodies
        .insert(f.selected_view.clone(), String::from_utf8(bytes).unwrap());
    let result = f.rank("unsupported-profile");
    assert!(result["calculation"].is_null());
    assert!(result["scores"].as_array().unwrap().is_empty());
    assert_eq!(result["unavailable_scores"], json!([target]));
}

#[test]
fn old_profile_keeps_shared_weight_grouping_work_and_correlated_comparisons() {
    let mut f = Fixture::new();
    let en = f.definition("en");
    let fr = f.definition("fr");
    for (from, to) in [(1, 2), (1, 4), (2, 3), (3, 4)] {
        f.trust(from, to, "heed", "*");
    }
    f.bless(1, &en);
    f.bless(4, &en);
    f.bless(4, &fr);
    f.view("simple-routes-bounds-v1", &[1], 1);
    let baseline = f.rank("legacy-partial-before-refusal");
    assert_eq!(baseline["calculation"]["completed"], 0);
    assert_eq!(baseline["calculation"]["exact"], false);
    assert_eq!(baseline["layers"], json!([[en], [fr]]));
    let a = score(&baseline, &en);
    let b = score(&baseline, &fr);
    // Separate score intervals overlap. Shared actor uncertainty must cancel.
    assert_eq!(a["net"][0]["numerator"], "1");
    assert!(
        b["net"][1]["numerator"]
            .as_str()
            .unwrap()
            .parse::<u128>()
            .unwrap()
            > b["net"][1]["denominator"]
                .as_str()
                .unwrap()
                .parse::<u128>()
                .unwrap()
    );
    f.trust(2, 4, "shun", "en");
    let old = f.rank("legacy-partial-with-refusal");
    assert_eq!(old, baseline);
    let details = f.reviewers();
    assert_eq!(score(&details, &en)["direct_reviewers"], 2);
    assert_eq!(score(&details, &fr)["direct_reviewers"], 1);
    f.view("simple-routes-shun-v1", &[1], 1);
    let new = f.rank("new-partial-distinct-refusals");
    let mut unresolved = vec![en, fr];
    unresolved.sort();
    assert_eq!(new["layers"], json!([unresolved]));
}

fn local_overlay(f: &Fixture, issuer: Option<u8>, trust: Value, mut blocked: Value) -> Value {
    blocked
        .as_array_mut()
        .unwrap()
        .sort_by_key(|entry| canonical_value(entry).unwrap());
    json!({"version":2,"base_view":f.selected_view,"root_changes":[],"trust":trust,"blocked":blocked,"work":null,"public_shun_issuer":issuer.map(key)})
}
fn reviewer<'a>(result: &'a Value, target: &str, identity: &str) -> &'a Value {
    score(result, target)["reviewers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|reviewer| reviewer["identity"] == identity)
        .unwrap()
}
fn reasons(result: &Value, target: &str, identity: &str, public: bool, private: bool) {
    let reviewer = reviewer(result, target, identity);
    for (field, expected) in [("public_shun_block", public), ("private_block", private)] {
        if expected {
            assert_eq!(reviewer[field], true);
        } else {
            assert!(!reviewer.as_object().unwrap().contains_key(field));
        }
    }
}

#[test]
fn personal_shun_blocks_follow_public_scopes_for_languages_and_rafsi_in_both_profiles() {
    for profile in ["simple-routes-bounds-v1", "simple-routes-shun-v1"] {
        let mut f = Fixture::new();
        let en = f.definition("en");
        let fr = f.definition("fr");
        let pair = jvc_core::rafsi_pair_id(&f.word, "ban").unwrap();
        f.event(9,json!({"kind":"rafsi.publish","word":f.word,"assignment":pair,"origin":"native"}),Some(json!({"word":{"language":"jbo","spelling":"banli"},"rafsi":"ban","rationale":[],"sources":[],"legacy":null})));
        for target in [&en, &fr, &pair] {
            f.bless(4, target);
        }
        let broad = f.event(1,json!({"kind":"trust.set","subject":key(4),"scope":{"kind":"*","word":"*","language":"*"},"value":"shun"}),None);
        f.event_after(1,vec![broad],json!({"kind":"trust.set","subject":key(4),"scope":{"kind":"definition","word":"*","language":"en"},"value":"heed"}),None);
        f.event(6,json!({"kind":"trust.set","subject":key(4),"scope":{"kind":"*","word":"*","language":"*"},"value":"heed"}),None);
        f.view(profile, &[1, 6], 1000);
        f.overlay = Some(local_overlay(&f, Some(1), json!([]), json!([])));
        let result = f.rank(&format!("personal-scope-{profile}"));
        exact_net(&result, &en, "6", "1");
        exact_net(&result, &fr, "0", "1");
        exact_net(&result, &pair, "0", "1");
        let details = f.reviewers();
        reasons(&details, &en, &key(4), false, false);
        reasons(&details, &fr, &key(4), true, false);
        reasons(&details, &pair, &key(4), true, false);
        assert_eq!(reviewer(&details, &fr, &key(4))["blocked"], true);
        assert_eq!(result["calculation"]["algorithm"], profile);
        f.overlay = Some(local_overlay(
            &f,
            None,
            json!([]),
            json!([{"identity":key(4),"scope":{"kind":"rafsi","word":f.word,"language":"*"}}]),
        ));
        let result = f.rank(&format!("personal-private-rafsi-{profile}"));
        exact_net(&result, &en, "6", "1");
        exact_net(&result, &fr, "3", "1");
        exact_net(&result, &pair, "0", "1");
        let details = f.reviewers();
        reasons(&details, &en, &key(4), false, false);
        reasons(&details, &fr, &key(4), false, false);
        reasons(&details, &pair, &key(4), false, true);
    }
}

#[test]
fn personal_shun_conflicts_private_replacement_and_explicit_blocks_remain_distinct() {
    for (index, values) in [vec!["heed", "shun"], vec!["heed", "clear"]]
        .iter()
        .enumerate()
    {
        let mut f = Fixture::new();
        let target = f.definition("en");
        f.bless(4, &target);
        for value in values {
            f.trust(1, 4, value, "*");
        }
        f.trust(6, 4, "heed", "*");
        f.view("simple-routes-bounds-v1", &[1, 6], 1000);
        f.overlay = Some(local_overlay(&f, Some(1), json!([]), json!([])));
        let result = f.rank(&format!("personal-conflict-{index}"));
        exact_net(
            &result,
            &target,
            if values.contains(&"shun") { "0" } else { "3" },
            "1",
        );
        reasons(
            &f.reviewers(),
            &target,
            &key(4),
            values.contains(&"shun"),
            false,
        );
    }
    let mut f = Fixture::new();
    let target = f.definition("en");
    f.bless(4, &target);
    f.trust(1, 4, "shun", "*");
    f.trust(6, 4, "heed", "*");
    f.view("simple-routes-shun-v1", &[1, 6], 1000);
    let scope = json!({"kind":"definition","word":"*","language":"*"});
    for value in ["heed", "clear", "shun"] {
        f.overlay = Some(local_overlay(
            &f,
            Some(1),
            json!([{"issuer":key(1),"subject":key(4),"scope":scope,"value":value,"weight":null}]),
            json!([]),
        ));
        let result = f.rank(&format!("personal-private-{value}"));
        exact_net(&result, &target, "0", "1");
        reasons(&f.reviewers(), &target, &key(4), true, false);
    }
    f.overlay = Some(local_overlay(
        &f,
        Some(1),
        json!([]),
        json!([{"identity":key(4),"scope":scope}]),
    ));
    exact_net(&f.rank("personal-both-reasons"), &target, "0", "1");
    reasons(&f.reviewers(), &target, &key(4), true, true);
}

#[test]
fn personal_shun_reason_metadata_stays_fresh_when_old_profile_weights_are_reused() {
    let mut f = Fixture::new();
    let en = f.definition("en");
    let fr = f.definition("fr");
    let de = f.definition("de");
    for target in [&en, &fr, &de] {
        f.bless(4, target);
    }
    f.trust(1, 4, "shun", "en");
    f.trust(6, 4, "heed", "*");
    f.trust(6, 8, "heed", "*");
    f.view_with_exclusions("simple-routes-bounds-v1", &[1, 6], &[4], 1000);
    f.overlay = Some(local_overlay(
        &f,
        Some(1),
        json!([]),
        json!([{"identity":key(4),"scope":{"kind":"definition","word":"*","language":"fr"}}]),
    ));
    let result = f.rank("personal-reason-cache");
    assert_eq!(result["calculation"]["completed"], 1);
    let details = f.reviewers();
    reasons(&details, &en, &key(4), true, false);
    reasons(&details, &fr, &key(4), false, true);
    reasons(&details, &de, &key(4), false, false);
    for target in [&en, &fr, &de] {
        assert_eq!(reviewer(&details, target, &key(4))["blocked"], true);
    }
}

#[test]
fn personal_shun_versions_null_issuer_and_identity_digests_keep_response_contracts() {
    let mut f = Fixture::new();
    let target = f.definition("en");
    f.bless(4, &target);
    f.trust(1, 4, "shun", "*");
    f.trust(6, 4, "heed", "*");
    f.view("simple-routes-shun-v1", &[1, 6], 1000);
    let site = f.rank("personal-null-site");
    exact_net(&site, &target, "3", "1");
    let site_details = f.reviewers();
    reasons(&site_details, &target, &key(4), false, false);
    let version2 = local_overlay(&f, None, json!([]), json!([]));
    let mut version1 = version2.clone();
    version1["version"] = json!(1);
    version1
        .as_object_mut()
        .unwrap()
        .remove("public_shun_issuer");
    f.overlay = Some(version1.clone());
    let old = f.rank("personal-overlay-v1");
    exact_net(&old, &target, "3", "1");
    assert_eq!(f.reviewers()["scores"], site_details["scores"]);
    f.overlay = Some(version2);
    let anonymous = f.rank("personal-overlay-v2-null");
    exact_net(&anonymous, &target, "3", "1");
    reasons(&f.reviewers(), &target, &key(4), false, false);
    assert_ne!(
        anonymous["calculation"]["overlay"],
        old["calculation"]["overlay"]
    );
    f.overlay = Some(local_overlay(&f, Some(1), json!([]), json!([])));
    let first = f.rank("personal-issuer-one");
    exact_net(&first, &target, "0", "1");
    assert_eq!(
        first["calculation"]["overlay"],
        jvc_core::hash_id(
            "sha256:",
            b"",
            &canonical_value(f.overlay.as_ref().unwrap()).unwrap()
        )
    );
    f.overlay = Some(local_overlay(&f, Some(6), json!([]), json!([])));
    let second = f.rank("personal-issuer-six");
    exact_net(&second, &target, "3", "1");
    assert_ne!(
        first["calculation"]["overlay"],
        second["calculation"]["overlay"]
    );
    let mut private = local_overlay(
        &f,
        None,
        json!([]),
        json!([{"identity":key(4),"scope":{"kind":"*","word":"*","language":"*"}}]),
    );
    f.overlay = Some(private.clone());
    f.rank("personal-null-private-block");
    reasons(&f.reviewers(), &target, &key(4), false, true);
    private["version"] = json!(1);
    private
        .as_object_mut()
        .unwrap()
        .remove("public_shun_issuer");
    f.overlay = Some(private);
    f.rank("personal-v1-private-block");
    reasons(&f.reviewers(), &target, &key(4), false, false);
}

#[test]
fn personal_shun_handovers_resolve_both_ends_without_self_blocks() {
    let mut f = Fixture::new();
    let target = f.definition("en");
    let shun=f.event(1,json!({"kind":"trust.set","subject":key(5),"scope":{"kind":"*","word":"*","language":"*"},"value":"shun"}),None);
    let transfer = f.event_after(
        1,
        vec![shun],
        json!({"kind":"identity.transfer","successor":key(2)}),
        None,
    );
    let accept = f.event(
        2,
        json!({"kind":"identity.accept","transfer":transfer}),
        None,
    );
    f.event_after(2,vec![accept],json!({"kind":"trust.set","subject":key(1),"scope":{"kind":"*","word":"*","language":"*"},"value":"shun"}),None);
    let transfer = f.event(
        4,
        json!({"kind":"identity.transfer","successor":key(5)}),
        None,
    );
    let accept = f.event(
        5,
        json!({"kind":"identity.accept","transfer":transfer}),
        None,
    );
    f.event_after(
        5,
        vec![accept],
        json!({"kind":"judgment.set","target":target,"value":"bless"}),
        None,
    );
    f.trust(6, 5, "heed", "*");
    f.view("simple-routes-bounds-v1", &[2, 6], 1000);
    f.overlay = Some(local_overlay(
        &f,
        Some(2),
        json!([]),
        json!([{"identity":key(5),"scope":{"kind":"*","word":"*","language":"*"}}]),
    ));
    exact_net(&f.rank("personal-handovers"), &target, "0", "1");
    let details = f.reviewers();
    reasons(&details, &target, &key(4), true, true);
    assert_eq!(details["calculation"]["incomplete_identities"], json!([]));
}

#[test]
fn personal_shun_unavailable_or_invalid_input_never_produces_fallback_scores() {
    let mut f = Fixture::new();
    let target = f.definition("en");
    f.bless(4, &target);
    f.trust(6, 4, "heed", "*");
    f.view("simple-routes-bounds-v1", &[1, 6], 1000);
    let mut invalid = local_overlay(&f, Some(1), json!([]), json!([]));
    invalid
        .as_object_mut()
        .unwrap()
        .remove("public_shun_issuer");
    f.overlay = Some(invalid);
    let result = f.rank("personal-invalid-v2");
    assert!(result["scores"].as_array().unwrap().is_empty());
    assert_eq!(result["unavailable_scores"], json!([target]));
    f.event_after(1,vec![format!("jve1:{}","f".repeat(64))],json!({"kind":"trust.set","subject":key(4),"scope":{"kind":"*","word":"*","language":"*"},"value":"shun"}),None);
    f.overlay = Some(local_overlay(&f, Some(1), json!([]), json!([])));
    let result = f.rank("personal-unavailable-issuer");
    assert!(result["scores"].as_array().unwrap().is_empty());
    assert_eq!(result["unavailable_scores"], json!([target]));
    let state = jvc_runtime::evaluate_bytes(&f.bytes()).unwrap();
    assert_eq!(state["available"], false);
    assert!(
        state["reasons"]
            .as_array()
            .unwrap()
            .iter()
            .any(|reason| reason == "public_shun_issuer_unavailable")
    );
}

#[test]
fn personal_shun_reviewer_reasons_keep_existing_response_bounds() {
    let mut f = Fixture::new();
    let target = f.definition("en");
    for seed in 30..48 {
        f.bless(seed, &target);
    }
    f.trust(1, 30, "shun", "*");
    f.trust(1, 49, "shun", "*");
    f.view("simple-routes-bounds-v1", &[1], 1000);
    f.overlay = Some(local_overlay(&f, Some(1), json!([]), json!([])));
    f.rank("personal-reviewer-bound");
    let details = f.reviewers();
    assert_eq!(score(&details, &target)["direct_reviewers"], 18);
    assert_eq!(
        score(&details, &target)["reviewers"]
            .as_array()
            .unwrap()
            .len(),
        16
    );
    assert_eq!(score(&details, &target)["reviewers_complete"], false);
    assert!(
        !score(&details, &target)["reviewers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|reviewer| reviewer["identity"] == key(49))
    );
}

#[test]
fn personal_shun_public_clears_and_incomparable_scopes_keep_their_context_rules() {
    for profile in ["simple-routes-bounds-v1", "simple-routes-shun-v1"] {
        let mut f = Fixture::new();
        let target = f.definition("en");
        f.bless(4, &target);
        f.trust(6, 4, "heed", "*");
        let broad=f.event(1,json!({"kind":"trust.set","subject":key(4),"scope":{"kind":"*","word":"*","language":"*"},"value":"shun"}),None);
        let narrow=f.event_after(1,vec![broad],json!({"kind":"trust.set","subject":key(4),"scope":{"kind":"definition","word":"*","language":"en"},"value":"clear"}),None);
        f.view(profile, &[1, 6], 1000);
        f.overlay = Some(local_overlay(&f, Some(1), json!([]), json!([])));
        exact_net(
            &f.rank(&format!("personal-clear-fallback-{profile}")),
            &target,
            "0",
            "1",
        );
        reasons(&f.reviewers(), &target, &key(4), true, false);
        let cleared=f.event_after(1,vec![narrow],json!({"kind":"trust.set","subject":key(4),"scope":{"kind":"*","word":"*","language":"*"},"value":"clear"}),None);
        f.overlay = Some(local_overlay(
            &f,
            Some(1),
            json!([]),
            json!([{"identity":key(4),"scope":{"kind":"*","word":"*","language":"*"}}]),
        ));
        exact_net(
            &f.rank(&format!("personal-clear-private-survives-{profile}")),
            &target,
            "0",
            "1",
        );
        reasons(&f.reviewers(), &target, &key(4), false, true);
        let heed=f.event_after(1,vec![cleared],json!({"kind":"trust.set","subject":key(4),"scope":{"kind":"definition","word":f.word,"language":"*"},"value":"heed"}),None);
        f.event_after(1,vec![heed],json!({"kind":"trust.set","subject":key(4),"scope":{"kind":"definition","word":"*","language":"en"},"value":"shun"}),None);
        f.overlay = Some(local_overlay(&f, Some(1), json!([]), json!([])));
        exact_net(
            &f.rank(&format!("personal-incomparable-{profile}")),
            &target,
            "0",
            "1",
        );
        reasons(&f.reviewers(), &target, &key(4), true, false);
    }
}

#[test]
fn personal_shun_unaccepted_handover_does_not_borrow_the_old_keys_shuns() {
    let mut f = Fixture::new();
    let target = f.definition("en");
    f.bless(4, &target);
    f.trust(6, 4, "heed", "*");
    let shun=f.event(1,json!({"kind":"trust.set","subject":key(4),"scope":{"kind":"*","word":"*","language":"*"},"value":"shun"}),None);
    f.event_after(
        1,
        vec![shun],
        json!({"kind":"identity.transfer","successor":key(2)}),
        None,
    );
    f.view("simple-routes-bounds-v1", &[2, 6], 1000);
    f.overlay = Some(local_overlay(&f, Some(2), json!([]), json!([])));
    exact_net(&f.rank("personal-unaccepted-handover"), &target, "3", "1");
    reasons(&f.reviewers(), &target, &key(4), false, false);
}

#[test]
fn personal_shun_blocks_remove_own_and_onward_credit_without_redistribution() {
    let mut f = Fixture::new();
    let target = f.definition("en");
    for seed in [4, 7, 8] {
        f.bless(seed, &target);
    }
    f.trust(1, 4, "shun", "*");
    f.trust(6, 4, "heed", "*");
    f.trust(6, 8, "heed", "*");
    f.trust(4, 7, "heed", "*");
    f.view("simple-routes-bounds-v1", &[1, 4, 6], 1000);
    exact_net(
        &f.rank("personal-block-site-normalization"),
        &target,
        "31",
        "4",
    );
    f.overlay = Some(local_overlay(&f, Some(1), json!([]), json!([])));
    exact_net(&f.rank("personal-block-normalization"), &target, "3", "2");
    let details = f.reviewers();
    for seed in [4, 7] {
        assert_eq!(
            reviewer(&details, &target, &key(seed))["weight"][0]["numerator"],
            "0"
        );
    }
    assert_eq!(
        reviewer(&details, &target, &key(8))["weight"][0],
        json!({"numerator":"3","denominator":"2"})
    );
    reasons(&details, &target, &key(4), true, false);
    reasons(&details, &target, &key(7), false, false);
}
