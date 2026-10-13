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
}
impl Fixture {
    fn new() -> Self {
        Self {
            events: Vec::new(),
            bodies: BTreeMap::new(),
            word: word_id(&json!({"language":"jbo","spelling":"banli"})).unwrap(),
            nonce: 0,
            selected_view: String::new(),
        }
    }
    fn event(&mut self, seed: u8, action: Value, body: Option<Value>) -> String {
        self.nonce += 1;
        let bytes = body.as_ref().map(|body| canonical_value(body).unwrap());
        let header = Header {
            version: 1,
            issuer: key(seed),
            previous: Vec::new(),
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
        let id = self.event(20, json!({"kind":"view.publish","parents":parents}), Some(json!({"name":"fixture","description":[],"roots":roots,"rafsi_threshold":{"numerator":1,"denominator":1},"H":{"numerator":3,"denominator":1},"alpha":{"numerator":1,"denominator":2},"excluded":[],"calculation":profile,"work":work,"import_sets":[],"account_witnesses":[],"account_authority":false,"notes":[]})));
        self.selected_view = id.clone();
        id
    }
    fn bytes(&self) -> Vec<u8> {
        canonical_value(&json!({"events":self.events,"bodies":self.bodies,"selected_view":self.selected_view,"import_selections":{},"overlay":null})).unwrap()
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
