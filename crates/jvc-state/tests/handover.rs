use jvc_core::{
    Header, body_descriptor, canonical_value, hash_id, identity_from_seed, sign_header,
    validate_action, validate_body, word_id,
};
use jvc_state::{Evaluation, EvaluationInput, Limits, Status, evaluate};
use serde_json::{Value, json};
use std::collections::BTreeMap;
const ORIGIN: &str = "https://source.example";
fn fake(prefix: &str) -> String {
    format!("{prefix}{}", "f".repeat(64))
}
fn key(n: u8) -> String {
    identity_from_seed(&[n; 32])
}
struct Fixture {
    input: EvaluationInput,
    nonce: u64,
    d: String,
    ca: String,
    cb: String,
    old: String,
    witness_heads: BTreeMap<u8, String>,
    base_view: String,
}
impl Fixture {
    fn event(
        &mut self,
        k: u8,
        previous: Vec<String>,
        action: Value,
        body: Option<Value>,
    ) -> String {
        self.nonce += 1;
        let bytes = body.as_ref().map(|b| canonical_value(b).unwrap());
        let mut previous = previous;
        previous.sort();
        previous.dedup();
        let header = Header {
            version: 1,
            issuer: key(k),
            previous,
            nonce: format!("{:032x}", self.nonce),
            action,
            content: bytes.as_ref().map(|b| body_descriptor(b).unwrap()),
        };
        if let Some(body) = &body {
            validate_body(&header, body)
                .unwrap_or_else(|e| panic!("fixture body failed: {e}: {body}"));
        }
        let e = sign_header(&[k; 32], header).unwrap();
        let id = e.id().to_owned();
        if let Some(bytes) = bytes {
            self.input.bodies.insert(id.clone(), bytes);
        }
        self.input.events.push(e);
        id
    }
    fn claim(
        &mut self,
        k: u8,
        own: Vec<String>,
        previous: Option<String>,
        mut carry: Vec<String>,
    ) -> String {
        carry.sort();
        self.event(k,own,json!({"kind":"account.set","origin":ORIGIN,"account":41,"value":"claim","previous":previous,"carry":carry}),None)
    }
    fn status(
        &mut self,
        k: u8,
        own: Vec<String>,
        claim: String,
        target: String,
        value: &str,
    ) -> String {
        self.event(
            k,
            own,
            json!({"kind":"import.status","target":target,"claim":claim,"value":value}),
            None,
        )
    }
    fn observe(&mut self, w: u8, claim: Option<String>, result: &str, branch: bool) -> String {
        let previous = if branch {
            vec![]
        } else {
            self.witness_heads.get(&w).cloned().into_iter().collect()
        };
        let markers = if result == "present" {
            claim.clone().into_iter().collect::<Vec<_>>()
        } else {
            vec![]
        };
        let id=self.event(w,previous,json!({"kind":"account.observe","origin":ORIGIN,"account":41,"claim":claim,"result":result}),Some(json!({
            "origin":ORIGIN,"account":41,"username":"author","field_hash":if result=="unreachable"{Value::Null}else{json!(fake("sha256:"))},"markers":markers,"method":"lensisku-public-profile-v1","observed_at":"2026-10-11T00:00:00Z"
        })));
        self.witness_heads.insert(w, id.clone());
        id
    }
    fn certify(&mut self, claim: String, branch: bool) {
        for w in [10, 11] {
            self.observe(w, Some(claim.clone()), "present", branch);
        }
    }
    fn publish(&mut self, record: u64) -> String {
        self.publish_after(record, vec![])
    }
    fn publish_after(&mut self, record: u64, previous: Vec<String>) -> String {
        let word = json!({"language":"jbo","spelling":"klama"});
        let word_id = word_id(&word).unwrap();
        let body = json!({"word":word,"language":"en","text":[["go"]],"frame":null,"operands":[],"glosses":[],"notes":[],"etymology":{"text":[],"formation":null,"compound":null},"examples":[],"classification":{"kind":"gismu","selmaho":[]},"labels":[],"sources":[],"license":{"expression":"CC0-1.0","url":null,"attribution":"fixture"},
            "legacy":{"source":"fixture","snapshot":fake("sha256:"),"extraction":"fixture-v1","record":{"kind":"definition","id":record},"locator":"fixture","original":{},"attribution":{"author":"author","editor":null,"author_account":{"origin":ORIGIN,"account":41,"username":"author","evidence":{"kind":"source-id","source":{"label":"source author numeric field","url":null,"event":null,"locator":"author_id"}}},"dates":{}},"conversion":{"method":"literal","tool":"fixture","version":"1","model":null,"review":"unreviewed","mappings":[],"warnings":[]},"limitations":[]}});
        self.event(9,previous,json!({"kind":"definition.publish","word":word_id,"language":"en","parents":[],"origin":"import"}),Some(body))
    }
    fn view(&mut self, ws: Vec<u8>, parents: Vec<String>) -> String {
        let mut publications: Vec<_> = self
            .input
            .events
            .iter()
            .filter(|e| e.header().action["kind"] == "definition.publish")
            .map(|e| e.id().to_owned())
            .collect();
        publications.sort();
        let selection = hash_id(
            "sha256:",
            b"",
            &canonical_value(&json!(publications)).unwrap(),
        );
        self.input
            .import_selections
            .insert(selection.clone(), publications);
        let mut witnesses: Vec<_> = ws.iter().map(|w| key(*w)).collect();
        witnesses.sort();
        let id=self.event(20,vec![],json!({"kind":"view.publish","parents":parents}),Some(json!({"name":"fixture","description":[],"roots":[],"rafsi_threshold":{"numerator":1,"denominator":1},"H":{"numerator":3,"denominator":1},"alpha":{"numerator":1,"denominator":2},"excluded":[],"calculation":"simple-routes-bounds-v1","work":1000,"import_sets":[{"source":"fixture","importer":key(9),"selection":selection}],"account_witnesses":witnesses,"account_authority":true,"notes":[]})));
        self.input.selected_view = id.clone();
        id
    }
    fn new() -> Self {
        let mut f = Self {
            input: EvaluationInput {
                events: Vec::new(),
                bodies: BTreeMap::new(),
                selected_view: String::new(),
                overlay: None,
                import_selections: BTreeMap::new(),
                limits: Limits::default(),
            },
            nonce: 0,
            d: String::new(),
            ca: String::new(),
            cb: String::new(),
            old: String::new(),
            witness_heads: BTreeMap::new(),
            base_view: String::new(),
        };
        f.d = f.publish(1);
        f.ca = f.claim(1, vec![], None, vec![]);
        f.certify(f.ca.clone(), false);
        f.base_view = f.view(vec![10, 11], vec![]);
        f
    }
    fn retirement(&mut self, value: &str) {
        self.old = self.status(
            1,
            vec![self.ca.clone()],
            self.ca.clone(),
            self.d.clone(),
            value,
        );
    }
    fn handover(&mut self, value: &str) {
        self.retirement(value);
        self.cb = self.claim(2, vec![], Some(self.ca.clone()), vec![self.old.clone()]);
        self.certify(self.cb.clone(), false);
    }
    fn remove(&mut self, id: &str) {
        self.input.events.retain(|e| e.id() != id);
    }
    fn clear(&mut self, k: u8, own: Vec<String>) -> String {
        self.event(
            k,
            own,
            json!({"kind":"account.set","origin":ORIGIN,"account":41,"value":"clear"}),
            None,
        )
    }
    fn compromise(&mut self, k: u8, own: Vec<String>, mut safe: Vec<String>) -> String {
        safe.sort();
        self.event(
            k,
            own,
            json!({"kind":"identity.compromise","safe":safe}),
            None,
        )
    }
    fn assert_invariant(&self, case: u8, expected: Status) -> Evaluation {
        let reference = evaluate_observed(&self.input);
        assert_eq!(
            reference.publications[&self.d].status,
            expected,
            "H{case:02}: {}",
            serde_json::to_string_pretty(&reference.accounts).unwrap()
        );
        // Build through several delivery orders, evaluate every prefix, then deliver duplicates.
        for order in 0..4 {
            let mut input = self.input.clone();
            input.events.clear();
            let mut events = self.input.events.clone();
            match order {
                1 => events.reverse(),
                2 => {
                    let n = events.len() / 2;
                    events.rotate_left(n);
                }
                3 => events.sort_by_key(|e| e.id().to_owned()),
                _ => {}
            }
            for e in &events {
                input.events.push(e.clone());
                let _ = evaluate(&input);
            }
            input.events.extend(events);
            assert_eq!(
                evaluate_observed(&input),
                reference,
                "H{case:02} delivery {order}"
            );
        }
        // Re-admit canonical serialized envelopes instead of retaining an evaluator cache.
        let mut rebuilt = self.input.clone();
        rebuilt.events = self
            .input
            .events
            .iter()
            .map(|e| jvc_core::verify_stored_envelope(&e.canonical_envelope().unwrap()).unwrap())
            .collect();
        assert_eq!(
            evaluate_observed(&rebuilt),
            reference,
            "H{case:02} reconstruction"
        );
        reference
    }
}
fn case(number: u8) {
    let mut f = Fixture::new();
    let mut expected = Status::Deprecated;
    match number {
        1 => f.handover("deprecated"),
        2 => {
            f.handover("active");
            expected = Status::Active;
        }
        3..=6 => {
            f.handover("deprecated");
            let restore = f.status(2, vec![f.cb.clone()], f.cb.clone(), f.d.clone(), "active");
            if number == 4 {
                f.event(
                    1,
                    vec![f.old.clone()],
                    json!({"kind":"import.status","target":f.d,"claim":f.ca,"value":"deprecated"}),
                    Some(json!({"text":[[format!("Replace {restore}")]]})),
                );
                let bad=f.event(1,vec![f.old.clone()],json!({"kind":"import.status","target":f.d,"claim":f.ca,"value":"deprecated","replaces":[restore]}),None);
                assert!(
                    validate_action(
                        f.input
                            .events
                            .iter()
                            .find(|e| e.id() == bad)
                            .unwrap()
                            .header()
                    )
                    .is_err()
                );
            } else {
                for _ in 0..if number == 5 { 8 } else { 1 } {
                    f.status(
                        1,
                        vec![f.old.clone()],
                        f.ca.clone(),
                        f.d.clone(),
                        "deprecated",
                    );
                }
            }
            if number == 6 {
                f.input.events.extend(f.input.events.clone());
            }
            expected = Status::Active;
        }
        7 => {
            f.handover("active");
            f.status(
                2,
                vec![f.cb.clone()],
                f.cb.clone(),
                f.d.clone(),
                "deprecated",
            );
            f.status(1, vec![f.old.clone()], f.ca.clone(), f.d.clone(), "active");
        }
        8 => {
            f.handover("deprecated");
            f.clear(1, vec![f.old.clone()]);
        }
        9 | 13 => {
            f.handover("deprecated");
            f.remove(&f.old.clone());
            expected = Status::Unavailable;
        }
        10 => {
            f.handover("deprecated");
            let saved = f
                .input
                .events
                .iter()
                .find(|e| e.id() == f.old)
                .unwrap()
                .clone();
            f.remove(&f.old.clone());
            assert_eq!(
                evaluate_observed(&f.input).publications[&f.d].status,
                Status::Unavailable
            );
            f.input.events.push(saved);
        }
        11 | 25 => {
            f.retirement("deprecated");
            let active = f.status(1, vec![f.ca.clone()], f.ca.clone(), f.d.clone(), "active");
            f.cb = f.claim(2, vec![], Some(f.ca.clone()), vec![f.old.clone(), active]);
            f.certify(f.cb.clone(), false);
            expected = Status::Conflicted;
        }
        12 => {
            f.handover("deprecated");
            let late = f.status(1, vec![f.old.clone()], f.ca.clone(), f.d.clone(), "active");
            let baseline = evaluate_observed(&f.input);
            assert_eq!(baseline.publications[&f.d].status, Status::Deprecated);
            assert!(baseline.receipts.contains_key(&late));
            f.status(2, vec![f.cb.clone()], f.cb.clone(), f.d.clone(), "active");
            expected = Status::Active;
        }
        14 => {
            f.handover("deprecated");
            f.status(1, vec![fake("jve1:")], f.ca.clone(), f.d.clone(), "active");
        }
        15 => f.handover("deprecated"),
        16 => {
            f.handover("deprecated");
            let ca2 = f.claim(
                1,
                vec![f.old.clone()],
                Some(f.cb.clone()),
                vec![f.cb.clone()],
            );
            f.certify(ca2.clone(), false);
            f.status(1, vec![ca2.clone()], ca2, f.d.clone(), "active");
            expected = Status::Active;
        }
        17 | 30 => {
            f.handover("deprecated");
            f.certify(f.ca.clone(), false);
        }
        18 => {
            f.retirement("deprecated");
            f.cb = f.claim(2, vec![], None, vec![]);
            f.certify(f.cb.clone(), true);
            expected = Status::Conflicted;
        }
        19 => {
            f.handover("deprecated");
            for w in [10, 11] {
                f.observe(w, None, "unreachable", false);
            }
        }
        20 | 31 | 42 => {
            if number != 42 {
                f.handover("deprecated");
            }
            f.view(vec![12, 13], vec![f.base_view.clone()]);
            expected = Status::Unavailable;
        }
        21 => {
            let wrong=f.event(3,vec![],json!({"kind":"account.set","origin":ORIGIN,"account":42,"value":"claim","previous":null,"carry":[]}),None);
            f.certify(wrong, false);
            expected = Status::Unavailable;
        }
        22 => {
            f.claim(3, vec![], None, vec![]);
            f.certify(f.ca.clone(), false);
            expected = Status::Active;
        }
        23 => {
            f.handover("deprecated");
            f.compromise(1, vec![f.old.clone()], vec![f.ca.clone()]);
        }
        24 => {
            f.handover("active");
            let dep = f.status(
                2,
                vec![f.cb.clone()],
                f.cb.clone(),
                f.d.clone(),
                "deprecated",
            );
            f.compromise(2, vec![dep], vec![]);
            expected = Status::Uncertain;
        }
        26 => {
            f.handover("deprecated");
            let revision = f.publish(2);
            f.view(vec![10, 11], vec![f.base_view.clone()]);
            let result = evaluate_observed(&f.input);
            assert_eq!(result.publications[&revision].status, Status::Active);
        }
        27 => {
            f.handover("deprecated");
            let existing = f
                .input
                .events
                .iter()
                .find(|e| e.id() == f.d)
                .unwrap()
                .clone();
            f.input.events.push(existing);
        }
        28 => {
            f.event(
                9,
                vec![f.d.clone()],
                json!({"kind":"status.set","target":f.d,"value":"deprecated"}),
                None,
            );
            f.status(
                9,
                vec![f.d.clone()],
                f.ca.clone(),
                f.d.clone(),
                "deprecated",
            );
            expected = Status::Active;
        }
        29 => {
            let observation = f.witness_heads[&11].clone();
            f.remove(&observation);
            expected = Status::Active;
        }
        32 => {
            f.handover("deprecated");
            for w in [10, 11] {
                f.observe(w, None, "absent", false);
            }
            assert_eq!(
                evaluate_observed(&f.input).publications[&f.d].status,
                Status::Deprecated
            );
            f.clear(2, vec![f.cb.clone()]);
        }
        33 => {
            let d2 = f.publish(2);
            f.retirement("deprecated");
            let ad2 = f.status(
                1,
                vec![f.old.clone()],
                f.ca.clone(),
                d2.clone(),
                "deprecated",
            );
            f.cb = f.claim(2, vec![], None, vec![]);
            let bd2 = f.status(
                2,
                vec![f.cb.clone()],
                f.cb.clone(),
                d2.clone(),
                "deprecated",
            );
            f.status(2, vec![bd2], f.cb.clone(), f.d.clone(), "active");
            f.certify(f.cb.clone(), true);
            f.view(vec![10, 11], vec![f.base_view.clone()]);
            assert!(!ad2.is_empty());
            assert_eq!(
                evaluate_observed(&f.input).publications[&d2].status,
                Status::Deprecated
            );
            expected = Status::Conflicted;
        }
        34 => {
            f.retirement("deprecated");
            let transfer = f.event(
                1,
                vec![f.old.clone()],
                json!({"kind":"identity.transfer","successor":key(2)}),
                None,
            );
            let accept = f.event(
                2,
                vec![],
                json!({"kind":"identity.accept","transfer":transfer.clone()}),
                None,
            );
            f.status(2, vec![accept], f.ca.clone(), f.d.clone(), "active");
            f.status(1, vec![transfer], f.ca.clone(), f.d.clone(), "deprecated");
            expected = Status::Active;
        }
        35 | 41 => {
            f.retirement("deprecated");
            let own = if number == 41 {
                f.ca.clone()
            } else {
                f.old.clone()
            };
            let clear = f.clear(1, vec![own]);
            if number == 35 {
                f.status(1, vec![clear], f.ca.clone(), f.d.clone(), "active");
            }
        }
        36 => {
            f.retirement("deprecated");
            f.claim(
                1,
                vec![f.old.clone()],
                Some(f.ca.clone()),
                vec![f.old.clone()],
            );
        }
        37 => {
            f.handover("deprecated");
            f.view(vec![12, 13], vec![f.base_view.clone()]);
            for w in [12, 13] {
                f.observe(w, Some(f.ca.clone()), "present", false);
            }
            expected = Status::Unavailable;
        }
        38 => {
            let safe = f.witness_heads[&10].clone();
            f.handover("deprecated");
            let last = f.witness_heads[&10].clone();
            f.compromise(10, vec![last], vec![safe]);
            expected = Status::Unavailable;
        }
        39 | 46 => {
            f.handover("deprecated");
            f.remove(&f.cb.clone());
            expected = Status::Unavailable;
        }
        40 => {
            f.cb = f.claim(2, vec![], Some(f.ca.clone()), vec![f.ca.clone()]);
            f.certify(f.cb.clone(), false);
            expected = Status::Active;
        }
        43 => {
            f.retirement("deprecated");
            let transfer = f.event(
                1,
                vec![f.old.clone()],
                json!({"kind":"identity.transfer","successor":key(2)}),
                None,
            );
            let accept = f.event(
                2,
                vec![],
                json!({"kind":"identity.accept","transfer":transfer}),
                None,
            );
            f.cb = f.claim(2, vec![accept], Some(f.ca.clone()), vec![f.old.clone()]);
            f.certify(f.cb.clone(), false);
            f.status(1, vec![fake("jve1:")], f.ca.clone(), f.d.clone(), "active");
        }
        44 => {
            for w in [10, 11] {
                let id = f.witness_heads[&w].clone();
                f.remove(&id);
                f.observe(w, None, "unreachable", false);
            }
            expected = Status::Active;
        }
        45 => {
            f.retirement("deprecated");
            let clear = f.clear(1, vec![f.old.clone()]);
            let ca2 = f.claim(1, vec![clear], Some(f.ca.clone()), vec![f.old.clone()]);
            f.certify(ca2.clone(), false);
            f.status(1, vec![ca2.clone()], ca2, f.d.clone(), "active");
            expected = Status::Active;
        }
        47 => {
            // Sign an invalid policy body without calling the fixture body validator.
            let mut p = f
                .input
                .events
                .iter()
                .find(|e| e.id() == f.base_view)
                .unwrap()
                .header()
                .clone();
            let mut b: jvc_core::Envelope = f
                .input
                .events
                .iter()
                .find(|e| e.id() == f.base_view)
                .unwrap()
                .envelope()
                .clone();
            let mut body: Value = serde_json::from_slice(&f.input.bodies[&f.base_view]).unwrap();
            body["account_witnesses"] = json!([]);
            let bytes = canonical_value(&body).unwrap();
            p.content = Some(body_descriptor(&bytes).unwrap());
            p.nonce = "000000000000000000000000ffffffff".into();
            let event = sign_header(&[20; 32], p).unwrap();
            b.id = event.id().into();
            f.input.bodies.insert(b.id.clone(), bytes);
            f.input.selected_view = b.id;
            f.input.events.push(event);
            expected = Status::Unavailable;
        }
        48 => {
            let other = f.claim(1, vec![], None, vec![]);
            f.status(
                1,
                vec![f.ca.clone(), other],
                f.ca.clone(),
                f.d.clone(),
                "deprecated",
            );
            expected = Status::Active;
        }
        _ => panic!("unknown case"),
    }
    let result = f.assert_invariant(number, expected);
    let account = result.accounts.get(&format!("{ORIGIN}#41"));
    if [18, 33].contains(&number) {
        assert!(account.unwrap().disputed);
        assert!(!account.unwrap().commands);
    }
    if [32, 35, 36, 41].contains(&number) {
        assert!(!account.unwrap().commands);
    }
    if [15, 40, 43, 45].contains(&number) {
        assert!(account.unwrap().commands);
    }
    if [9, 13, 39, 46].contains(&number) {
        assert!(
            !account.unwrap().missing.is_empty()
                || result.publications[&f.d]
                    .reasons
                    .contains("carry_or_authority_pending")
        );
    }
}
macro_rules! cases {($($name:ident:$n:literal),*)=>{$(#[test]fn $name(){case($n);})*};}
cases!(h01:1,h02:2,h03:3,h04:4,h05:5,h06:6,h07:7,h08:8,h09:9,h10:10,h11:11,h12:12,h13:13,h14:14,h15:15,h16:16,h17:17,h18:18,h19:19,h20:20,h21:21,h22:22,h23:23,h24:24,h25:25,h26:26,h27:27,h28:28,h29:29,h30:30,h31:31,h32:32,h33:33,h34:34,h35:35,h36:36,h37:37,h38:38,h39:39,h40:40,h41:41,h42:42,h43:43,h44:44,h45:45,h46:46,h47:47,h48:48);

#[test]
fn historical_witness_chain_does_not_require_selected_intermediate_key() {
    let mut f = Fixture::new();
    f.retirement("deprecated");
    let transfer = f.event(
        10,
        vec![f.witness_heads[&10].clone()],
        json!({"kind":"identity.transfer","successor":key(12)}),
        None,
    );
    let accept = f.event(
        12,
        vec![],
        json!({"kind":"identity.accept","transfer":transfer.clone()}),
        None,
    );
    let next = f.event(
        12,
        vec![accept],
        json!({"kind":"identity.transfer","successor":key(13)}),
        None,
    );
    let accept2 = f.event(
        13,
        vec![],
        json!({"kind":"identity.accept","transfer":next}),
        None,
    );
    f.witness_heads.insert(13, accept2);
    f.cb = f.claim(2, vec![], Some(f.ca.clone()), vec![f.old.clone()]);
    f.observe(13, Some(f.cb.clone()), "present", false);
    f.view(vec![10, 13], vec![f.base_view.clone()]);
    assert_eq!(
        evaluate_observed(&f.input).publications[&f.d].status,
        Status::Deprecated
    );
    let safe = f.witness_heads[&10].clone();
    f.compromise(10, vec![transfer], vec![safe]);
    let result = f.assert_invariant(49, Status::Unavailable);
    let account = &result.accounts[&format!("{ORIGIN}#41")];
    assert!(account.closed.contains(&f.ca));
    assert!(account.historical.contains(&f.cb));
}
#[test]
fn invalid_overlay_denominator_never_panics() {
    let mut f = Fixture::new();
    f.input.overlay = Some(
        json!({"version":1,"base_view":f.base_view,"root_changes":[{"identity":key(1),"q":{"numerator":1,"denominator":0}}],"trust":[],"blocked":[],"work":null}),
    );
    let result = evaluate_observed(&f.input);
    assert!(!result.available);
    assert!(result.reasons.contains("invalid_overlay"));
    let context = jvc_state::Context {
        kind: "definition".into(),
        word: jvc_core::word_id(&json!({"language":"jbo","spelling":"klama"})).unwrap(),
        language: Some("en".into()),
    };
    assert!(!jvc_state::evaluate_context(&result, &context).available);
}
#[test]
fn overlay_exact_schema_and_order_are_required() {
    let f = Fixture::new();
    let valid = json!({"version":1,"base_view":f.base_view,"root_changes":[],"trust":[],"blocked":[],"work":null});
    for field in ["unexpected", "version", "base_view", "work", "trust"] {
        let mut input = f.input.clone();
        let mut v = valid.clone();
        v[field] = match field {
            "version" => json!(2),
            "base_view" => json!(fake("jve1:")),
            "work" => json!(0),
            "trust" => {
                json!([{"issuer":key(1),"subject":key(2),"scope":{"kind":"*","word":"*","language":"*"},"value":"shun","weight":{"numerator":1,"denominator":1}}])
            }
            _ => json!(true),
        };
        input.overlay = Some(v);
        assert!(
            evaluate_observed(&input)
                .reasons
                .contains("invalid_overlay"),
            "{field}"
        );
    }
}
#[test]
fn lineage_pending_and_wrong_word_do_not_suppress_candidate() {
    let mut f = Fixture::new();
    let mut body: Value = serde_json::from_slice(&f.input.bodies[&f.d]).unwrap();
    body["legacy"] = Value::Null;
    let wrong_word = word_id(&json!({"language":"jbo","spelling":"blanu"})).unwrap();
    let mut wrong_body = body.clone();
    wrong_body["word"] = json!({"language":"jbo","spelling":"blanu"});
    let parent=f.event(3,vec![],json!({"kind":"definition.publish","word":wrong_word,"language":"en","parents":[],"origin":"native"}),Some(wrong_body));
    let child=f.event(4,vec![],json!({"kind":"definition.publish","word":word_id(&body["word"]).unwrap(),"language":"en","parents":[parent.clone(),fake("jve1:")],"origin":"native"}),Some(body));
    let result = evaluate_observed(&f.input);
    let p = &result.publications[&child];
    assert_eq!(p.eligible, jvc_state::Eligibility::Eligible);
    assert_eq!(p.lineage[&parent], "invalid");
    assert_eq!(p.lineage[&fake("jve1:")], "pending");
}
#[test]
fn unknown_judgment_target_is_pending_and_contributes_nothing() {
    let mut f = Fixture::new();
    let id = f.event(
        3,
        vec![],
        json!({"kind":"judgment.set","target":fake("jve1:"),"value":"bless"}),
        None,
    );
    let result = evaluate_observed(&f.input);
    assert_eq!(
        result.receipts[&id].interpretation,
        jvc_state::Interpretation::Pending
    );
    assert!(!result.judgments.contains_key(&fake("jve1:")));
}
#[test]
fn invalid_header_action_keeps_causal_position() {
    let mut f = Fixture::new();
    let invalid = f.event(
        3,
        vec![],
        json!({"kind":"identity.merge","extra":true}),
        None,
    );
    let judgment = f.event(
        3,
        vec![invalid.clone()],
        json!({"kind":"judgment.set","target":f.d,"value":"curse"}),
        None,
    );
    let result = evaluate_observed(&f.input);
    assert_eq!(
        result.receipts[&invalid].interpretation,
        jvc_state::Interpretation::Inert
    );
    assert_eq!(
        result.receipts[&judgment].interpretation,
        jvc_state::Interpretation::Effective
    );
    assert_eq!(result.judgments[&f.d][&key(3)], jvc_state::Judgment::Curse);
}
#[test]
fn newer_unavailable_profile_does_not_restore_old_body() {
    let mut f = Fixture::new();
    let old = f.event(
        3,
        vec![],
        json!({"kind":"identity.profile"}),
        Some(json!({"name":"old","bio":[],"links":[]})),
    );
    let new = f.event(
        3,
        vec![old],
        json!({"kind":"identity.profile"}),
        Some(json!({"name":"new","bio":[],"links":[]})),
    );
    f.input.bodies.remove(&new);
    let result = evaluate_observed(&f.input);
    let profile = result
        .registers
        .values()
        .find(|r| r.key.ends_with("|profile"))
        .unwrap();
    assert_eq!(
        profile.heads,
        std::collections::BTreeSet::from([new.clone()])
    );
    assert_eq!(
        result.receipts[&new].interpretation,
        jvc_state::Interpretation::Unavailable
    );
}
#[test]
fn incomplete_group_loses_judgments_but_keeps_publication_content() {
    let mut f = Fixture::new();
    f.event(
        3,
        vec![],
        json!({"kind":"judgment.set","target":f.d,"value":"bless"}),
        None,
    );
    f.event(
        3,
        vec![fake("jve1:")],
        json!({"kind":"identity.merge"}),
        None,
    );
    let result = evaluate_observed(&f.input);
    assert!(
        !result
            .judgments
            .get(&f.d)
            .is_some_and(|j| j.contains_key(&key(3)))
    );
}
#[test]
fn matching_transfers_with_multiple_successor_roots_do_not_inherit() {
    let mut f = Fixture::new();
    let t = f.event(
        3,
        vec![],
        json!({"kind":"identity.transfer","successor":key(4)}),
        None,
    );
    f.event(
        4,
        vec![],
        json!({"kind":"identity.accept","transfer":t}),
        None,
    );
    f.event(4, vec![], json!({"kind":"identity.merge"}), None);
    let result = evaluate_observed(&f.input);
    assert!(!result.lifecycle.successor.contains_key(&key(3)));
    assert!(result.lifecycle.retired.contains(&key(3)));
}
#[test]
fn import_artifact_hash_is_authenticated() {
    let mut f = Fixture::new();
    for ids in f.input.import_selections.values_mut() {
        ids.clear();
    }
    let result = evaluate_observed(&f.input);
    assert_eq!(
        result.publications[&f.d].eligible,
        jvc_state::Eligibility::Unknown
    );
    assert!(result.reasons.contains("import_selection_unavailable"));
}
#[test]
fn normal_2429_publication_chain_fits_default_resource_budget() {
    let mut f = Fixture::new();
    let mut previous = f.d.clone();
    for n in 2..=2429 {
        previous = f.publish_after(n, vec![previous]);
    }
    // Four certified periods share the same carried histories across every publication.
    let mut claim = f.ca.clone();
    let mut status = f.status(
        1,
        vec![claim.clone()],
        claim.clone(),
        f.d.clone(),
        "deprecated",
    );
    for k in 2..=4 {
        let next = f.claim(k, vec![], Some(claim), vec![status]);
        f.certify(next.clone(), false);
        status = f.status(
            k,
            vec![next.clone()],
            next.clone(),
            f.d.clone(),
            "deprecated",
        );
        claim = next;
    }
    f.view(vec![10, 11], vec![f.base_view.clone()]);
    let begin = std::time::Instant::now();
    let result = evaluate_observed(&f.input);
    eprintln!("2429 chained imports: {:?}", begin.elapsed());
    assert!(result.available, "{:?}", result.reasons);
    assert_eq!(result.publications.len(), 2429);
    assert!(result.publications.values().all(|p| p.status
        == if p.id == f.d {
            Status::Deprecated
        } else {
            Status::Active
        }));
}
#[test]
fn long_history_uses_explicit_global_limit_without_stack_recursion() {
    let mut f = Fixture::new();
    let mut previous = Vec::new();
    for _ in 0..5000 {
        let id = f.event(30, previous, json!({"kind":"identity.merge"}), None);
        previous = vec![id];
    }
    f.input.limits.traversal = 10_000;
    let result = evaluate_observed(&f.input);
    assert!(!result.available);
    assert!(result.reasons.contains("resource_unavailable"));
    assert!(
        result
            .publications
            .values()
            .all(|p| p.status == Status::Unavailable)
    );
    assert!(result.judgments.is_empty());
    assert!(result.registers.is_empty());
}

fn context() -> jvc_state::Context {
    jvc_state::Context {
        kind: "definition".into(),
        word: word_id(&json!({"language":"jbo","spelling":"klama"})).unwrap(),
        language: Some("en".into()),
    }
}
fn overlay(base: &str, root_changes: Value, trust: Value, blocked: Value) -> Value {
    json!({"version":1,"base_view":base,"root_changes":root_changes,"trust":trust,"blocked":blocked,"work":null})
}
fn sorted_objects(v: &mut Value) {
    v.as_array_mut()
        .unwrap()
        .sort_by_key(|v| canonical_value(v).unwrap());
}
fn root_policy(f: &mut Fixture, roots: Vec<(u8, u64)>) {
    let mut body: Value = serde_json::from_slice(&f.input.bodies[&f.base_view]).unwrap();
    let mut roots: Vec<Value> = roots
        .into_iter()
        .map(|(k, q)| json!({"identity":key(k),"q":{"numerator":q,"denominator":1}}))
        .collect();
    roots.sort_by_key(|r| r["identity"].as_str().unwrap().to_owned());
    body["roots"] = json!(roots);
    let id = f.event(
        20,
        vec![],
        json!({"kind":"view.publish","parents":[f.base_view]}),
        Some(body),
    );
    f.input.selected_view = id;
}
#[test]
fn root_overlay_changes_raw_keys_before_continuity_maximum() {
    let mut f = Fixture::new();
    let transfer = f.event(
        3,
        vec![],
        json!({"kind":"identity.transfer","successor":key(4)}),
        None,
    );
    f.event(
        4,
        vec![],
        json!({"kind":"identity.accept","transfer":transfer}),
        None,
    );
    root_policy(&mut f, vec![(3, 5), (4, 3)]);
    for (change, expected) in [
        (Value::Null, 3),
        (json!({"numerator":1,"denominator":1}), 3),
        (json!({"numerator":7,"denominator":1}), 7),
    ] {
        f.input.overlay = Some(overlay(
            &f.input.selected_view,
            json!([{"identity":key(3),"q":change}]),
            json!([]),
            json!([]),
        ));
        let graph = jvc_state::evaluate_context(&evaluate_observed(&f.input), &context());
        let i = graph.actors.iter().position(|a| a == &key(3)).unwrap();
        assert_eq!(
            graph.roots[i],
            jvc_state::Rational::from_integer(expected.into())
        );
    }
    f.input.overlay = None;
    f.event(4, vec![], json!({"kind":"identity.merge"}), None);
    let graph = jvc_state::evaluate_context(&evaluate_observed(&f.input), &context());
    for (k, q) in [(3, 5), (4, 3)] {
        let i = graph.actors.iter().position(|a| a == &key(k)).unwrap();
        assert_eq!(graph.roots[i], jvc_state::Rational::from_integer(q.into()));
    }
}
#[test]
fn continuity_group_private_weight_conflict_blocks_edge() {
    let mut f = Fixture::new();
    let transfer = f.event(
        3,
        vec![],
        json!({"kind":"identity.transfer","successor":key(4)}),
        None,
    );
    f.event(
        4,
        vec![],
        json!({"kind":"identity.accept","transfer":transfer}),
        None,
    );
    let mut trust = json!([{"issuer":key(5),"subject":key(3),"scope":{"kind":"*","word":"*","language":"*"},"value":"heed","weight":{"numerator":1,"denominator":1}},
        {"issuer":key(5),"subject":key(4),"scope":{"kind":"*","word":"*","language":"*"},"value":"heed","weight":{"numerator":1,"denominator":2}}]);
    sorted_objects(&mut trust);
    f.input.overlay = Some(overlay(&f.input.selected_view, json!([]), trust, json!([])));
    let graph = jvc_state::evaluate_context(&evaluate_observed(&f.input), &context());
    let i = graph.actors.iter().position(|a| a == &key(5)).unwrap();
    assert!(graph.rows[i].is_empty());
    assert!(graph.refusals.iter().all(Vec::is_empty));
}
#[test]
fn block_does_not_redistribute_preexisting_row_share() {
    let mut f = Fixture::new();
    let scope = json!({"kind":"*","word":"*","language":"*"});
    f.event(
        3,
        vec![],
        json!({"kind":"trust.set","subject":key(4),"scope":scope,"value":"heed"}),
        None,
    );
    f.event(
        3,
        vec![],
        json!({"kind":"trust.set","subject":key(5),"scope":scope,"value":"heed"}),
        None,
    );
    f.input.overlay = Some(overlay(
        &f.input.selected_view,
        json!([]),
        json!([]),
        json!([{"identity":key(4),"scope":scope}]),
    ));
    let graph = jvc_state::evaluate_context(&evaluate_observed(&f.input), &context());
    let i = graph.actors.iter().position(|a| a == &key(3)).unwrap();
    assert_eq!(graph.rows[i].len(), 1);
    assert_eq!(
        graph.rows[i][0].share,
        jvc_state::Rational::new(1.into(), 2.into())
    );
}
#[test]
fn narrow_clear_falls_back_and_incomparable_shun_blocks() {
    let mut f = Fixture::new();
    let broad=f.event(3,vec![],json!({"kind":"trust.set","subject":key(4),"scope":{"kind":"*","word":"*","language":"*"},"value":"heed"}),None);
    f.event(3,vec![broad],json!({"kind":"trust.set","subject":key(4),"scope":{"kind":"definition","word":"*","language":"en"},"value":"clear"}),None);
    let graph = jvc_state::evaluate_context(&evaluate_observed(&f.input), &context());
    let i = graph.actors.iter().position(|a| a == &key(3)).unwrap();
    assert_eq!(graph.rows[i].len(), 1);
    let word = context().word;
    f.event(3,vec![],json!({"kind":"trust.set","subject":key(4),"scope":{"kind":"definition","word":word,"language":"*"},"value":"heed"}),None);
    f.event(3,vec![],json!({"kind":"trust.set","subject":key(4),"scope":{"kind":"definition","word":"*","language":"en"},"value":"shun"}),None);
    let graph = jvc_state::evaluate_context(&evaluate_observed(&f.input), &context());
    assert!(graph.rows[i].is_empty());
    assert_eq!(refusal_pairs(&graph), vec![(key(3), key(4))]);
}
#[test]
fn exact_status_and_account_api_expose_committed_evidence() {
    let mut f = Fixture::new();
    f.handover("deprecated");
    let result = evaluate_observed(&f.input);
    let status = jvc_state::publication_status(&result, &f.d).unwrap();
    assert_eq!(status.claim, Some(f.cb.clone()));
    assert_eq!(status.deciding_claim, Some(f.ca.clone()));
    assert!(status.frontier.contains(&f.old));
    assert_eq!(status.authority, jvc_state::Authority::SourceAccount);
    let account = jvc_state::account_control(&result, "snapshot", ORIGIN, 41);
    assert_eq!(account.state, "controlled");
    assert!(account.chain.contains(&f.ca));
    assert!(account.certificates.iter().any(|c| c.claim == f.cb));
    assert!(
        account
            .certificates
            .iter()
            .all(|c| !c.observations.is_empty())
    );
}

fn chunk_policy(f: &mut Fixture, chunks: Vec<(u8, Vec<String>)>) {
    let mut body: Value = serde_json::from_slice(&f.input.bodies[&f.base_view]).unwrap();
    let mut entries = Vec::new();
    for (importer, mut ids) in chunks {
        ids.sort();
        ids.dedup();
        let hash = hash_id("sha256:", b"", &canonical_value(&json!(ids)).unwrap());
        f.input.import_selections.insert(hash.clone(), ids);
        entries.push(json!({"source":"fixture","importer":key(importer),"selection":hash}));
    }
    entries.sort_by_key(|e| {
        (
            e["source"].as_str().unwrap().to_owned(),
            e["importer"].as_str().unwrap().to_owned(),
            e["selection"].as_str().unwrap().to_owned(),
        )
    });
    body["import_sets"] = json!(entries);
    f.input.selected_view = f.event(
        20,
        vec![],
        json!({"kind":"view.publish","parents":[f.base_view]}),
        Some(body),
    );
}
#[test]
fn conflicting_source_revisions_across_chunks_are_unresolved() {
    let mut f = Fixture::new();
    let newer = f.publish_after(1, vec![f.d.clone()]);
    let d = f.d.clone();
    chunk_policy(&mut f, vec![(9, vec![d.clone()]), (9, vec![newer.clone()])]);
    let result = evaluate_observed(&f.input);
    assert!(result.accounts.values().all(|a| a.commands));
    for id in [d, newer] {
        let p = &result.publications[&id];
        assert_eq!(p.eligible, jvc_state::Eligibility::Unknown);
        assert_eq!(p.status, Status::Unavailable);
        let status = jvc_state::publication_status(&result, &id).unwrap();
        assert_eq!(status.state, Status::Unavailable);
        assert!(status.reasons.contains("source_selection_conflict"));
        assert!(p.reasons.contains("source_selection_conflict"));
    }
}
#[test]
fn accepted_importer_succession_keeps_one_source_slot() {
    let mut f = Fixture::new();
    let transfer = f.event(
        9,
        vec![f.d.clone()],
        json!({"kind":"identity.transfer","successor":key(8)}),
        None,
    );
    let accept = f.event(
        8,
        vec![],
        json!({"kind":"identity.accept","transfer":transfer}),
        None,
    );
    let body: Value = serde_json::from_slice(&f.input.bodies[&f.d]).unwrap();
    let newer=f.event(8,vec![accept],json!({"kind":"definition.publish","word":word_id(&body["word"]).unwrap(),"language":"en","parents":[f.d],"origin":"import"}),Some(body));
    let d = f.d.clone();
    chunk_policy(&mut f, vec![(9, vec![d.clone()]), (8, vec![newer.clone()])]);
    let result = evaluate_observed(&f.input);
    for id in [d, newer] {
        assert_eq!(
            result.publications[&id].eligible,
            jvc_state::Eligibility::Unknown
        );
    }
}
#[test]
fn repeated_publication_id_across_chunks_is_one_source_revision() {
    let mut f = Fixture::new();
    let other = f.publish(2);
    let d = f.d.clone();
    chunk_policy(
        &mut f,
        vec![(9, vec![d.clone()]), (9, vec![d.clone(), other])],
    );
    let result = evaluate_observed(&f.input);
    assert_eq!(
        result.publications[&d].eligible,
        jvc_state::Eligibility::Eligible
    );
}
fn rafsi(f: &mut Fixture, k: u8) -> (String, String) {
    let word = json!({"language":"jbo","spelling":"klama"});
    let w = word_id(&word).unwrap();
    let pair = jvc_core::rafsi_pair_id(&w, "kla").unwrap();
    let id = f.event(
        k,
        vec![],
        json!({"kind":"rafsi.publish","word":w,"assignment":pair,"origin":"native"}),
        Some(
            json!({"word":word,"rafsi":"kla","rationale":[["fixture"]],"sources":[],"legacy":null}),
        ),
    );
    (id, pair)
}
#[test]
fn rafsi_word_gate_uses_all_languages_and_restores_existing_claims() {
    let mut f = Fixture::new();
    let (claim, pair) = rafsi(&mut f, 3);
    f.event(
        4,
        vec![],
        json!({"kind":"judgment.set","target":pair,"value":"bless"}),
        None,
    );
    f.handover("deprecated");
    let result = evaluate_observed(&f.input);
    assert_eq!(
        result.publications[&claim].eligible,
        jvc_state::Eligibility::Inactive
    );
    f.status(2, vec![f.cb.clone()], f.cb.clone(), f.d.clone(), "active");
    let result = evaluate_observed(&f.input);
    assert_eq!(
        result.publications[&claim].eligible,
        jvc_state::Eligibility::Eligible
    );
    assert_eq!(result.judgments[&pair][&key(4)], jvc_state::Judgment::Bless);
}
#[test]
fn missing_selection_does_not_prove_all_definitions_deprecated() {
    let mut f = Fixture::new();
    let (claim, _) = rafsi(&mut f, 3);
    f.handover("deprecated");
    let mut body: Value = serde_json::from_slice(&f.input.bodies[&f.base_view]).unwrap();
    body["import_sets"]
        .as_array_mut()
        .unwrap()
        .push(json!({"source":"other","importer":key(8),"selection":fake("sha256:")}));
    f.input.selected_view = f.event(
        20,
        vec![],
        json!({"kind":"view.publish","parents":[]}),
        Some(body),
    );
    let result = evaluate_observed(&f.input);
    assert_eq!(
        result.publications[&claim].eligible,
        jvc_state::Eligibility::Unknown
    );
}
#[test]
fn independent_active_definition_makes_rafsi_eligible_with_other_missing_inputs() {
    let mut f = Fixture::new();
    let (claim, _) = rafsi(&mut f, 3);
    f.handover("deprecated");
    let mut body: Value = serde_json::from_slice(&f.input.bodies[&f.d]).unwrap();
    body["language"] = json!("jbo");
    body["legacy"] = Value::Null;
    f.event(4,vec![],json!({"kind":"definition.publish","word":word_id(&body["word"]).unwrap(),"language":"jbo","parents":[],"origin":"native"}),Some(body));
    let result = evaluate_observed(&f.input);
    assert_eq!(
        result.publications[&claim].eligible,
        jvc_state::Eligibility::Eligible
    );
}
#[test]
fn deprecating_one_rafsi_claim_preserves_another_claim_and_pair_judgments() {
    let mut f = Fixture::new();
    let (old, pair) = rafsi(&mut f, 3);
    let (other, _) = rafsi(&mut f, 4);
    f.event(
        5,
        vec![],
        json!({"kind":"judgment.set","target":pair,"value":"bless"}),
        None,
    );
    f.event(
        3,
        vec![old.clone()],
        json!({"kind":"status.set","target":old,"value":"deprecated"}),
        None,
    );
    let result = evaluate_observed(&f.input);
    assert_eq!(
        result.publications[&other].eligible,
        jvc_state::Eligibility::Eligible
    );
    assert_eq!(result.judgments[&pair][&key(5)], jvc_state::Judgment::Bless);
}

fn native(f: &mut Fixture, k: u8) -> String {
    let mut body: Value = serde_json::from_slice(&f.input.bodies[&f.d]).unwrap();
    body["legacy"] = Value::Null;
    f.event(k,vec![],json!({"kind":"definition.publish","word":word_id(&body["word"]).unwrap(),"language":"en","parents":[],"origin":"native"}),Some(body))
}
#[test]
fn native_post_transfer_old_key_status_is_inert() {
    let mut f = Fixture::new();
    let d = native(&mut f, 3);
    let transfer = f.event(
        3,
        vec![d.clone()],
        json!({"kind":"identity.transfer","successor":key(4)}),
        None,
    );
    let accept = f.event(
        4,
        vec![],
        json!({"kind":"identity.accept","transfer":transfer.clone()}),
        None,
    );
    f.event(
        4,
        vec![accept],
        json!({"kind":"status.set","target":d,"value":"active"}),
        None,
    );
    f.event(
        3,
        vec![transfer],
        json!({"kind":"status.set","target":d,"value":"deprecated"}),
        None,
    );
    let result = evaluate_observed(&f.input);
    assert_eq!(result.publications[&d].status, Status::Active);
}
#[test]
fn native_contested_successor_status_remains_uncertain() {
    let mut f = Fixture::new();
    let d = native(&mut f, 3);
    let transfer = f.event(
        3,
        vec![d.clone()],
        json!({"kind":"identity.transfer","successor":key(4)}),
        None,
    );
    let accept = f.event(
        4,
        vec![],
        json!({"kind":"identity.accept","transfer":transfer}),
        None,
    );
    f.event(
        4,
        vec![accept],
        json!({"kind":"status.set","target":d,"value":"deprecated"}),
        None,
    );
    f.event(
        3,
        vec![d.clone()],
        json!({"kind":"identity.transfer","successor":key(5)}),
        None,
    );
    let result = evaluate_observed(&f.input);
    assert_eq!(result.publications[&d].status, Status::Uncertain);
    assert!(
        result.publications[&d]
            .reasons
            .contains("contested_status_authority")
    );
}
#[test]
fn native_same_key_compromise_cutoff_excludes_status_value() {
    let mut f = Fixture::new();
    let d = native(&mut f, 3);
    let dep = f.event(
        3,
        vec![d.clone()],
        json!({"kind":"status.set","target":d,"value":"deprecated"}),
        None,
    );
    f.compromise(3, vec![dep], vec![d.clone()]);
    let result = evaluate_observed(&f.input);
    assert_eq!(result.publications[&d].status, Status::Active);
    assert_eq!(
        result.publications[&d].authority,
        jvc_state::Authority::None
    );
}
#[test]
fn concurrent_equal_profiles_count_once() {
    let mut f = Fixture::new();
    for _ in 0..2 {
        f.event(
            3,
            vec![],
            json!({"kind":"identity.profile"}),
            Some(json!({"name":"same","bio":[],"links":[]})),
        );
    }
    let result = evaluate_observed(&f.input);
    let r = result
        .registers
        .values()
        .find(|r| r.key.ends_with("|profile"))
        .unwrap();
    assert!(!r.conflicted);
    assert_eq!(r.heads.len(), 2);
}

#[test]
fn bridge_register_changes_target_and_requires_current_source_link() {
    let mut f = Fixture::new();
    let first = native(&mut f, 1);
    let second = native(&mut f, 1);
    let managed=f.event(1,vec![f.ca.clone(),first.clone()],json!({"kind":"bridge.set","origin":ORIGIN,"source_definition":1,"target":first,"value":"managed"}),None);
    let newer=f.event(1,vec![managed.clone(),second.clone()],json!({"kind":"bridge.set","origin":ORIGIN,"source_definition":1,"target":second,"value":"managed"}),None);
    let result = evaluate_observed(&f.input);
    let r = result
        .registers
        .values()
        .find(|r| r.key.contains("|bridge|"))
        .unwrap();
    assert_eq!(r.heads, std::collections::BTreeSet::from([newer]));
    assert!(!r.conflicted);
    f.clear(1, vec![f.ca.clone()]);
    let result = evaluate_observed(&f.input);
    assert!(
        result.receipts[&managed]
            .reasons
            .contains("account_binding_unavailable")
    );
    assert!(
        !result
            .registers
            .values()
            .any(|r| r.key.contains("|bridge|"))
    );
}

#[test]
fn disabled_account_authority_keeps_import_active_and_status_inert() {
    let mut f = Fixture::new();
    f.retirement("deprecated");
    let mut body: Value = serde_json::from_slice(&f.input.bodies[&f.base_view]).unwrap();
    body["account_authority"] = json!(false);
    f.input.selected_view = f.event(
        20,
        vec![],
        json!({"kind":"view.publish","parents":[f.base_view]}),
        Some(body),
    );
    let result = evaluate_observed(&f.input);
    assert_eq!(result.publications[&f.d].status, Status::Active);
    assert_eq!(
        result.receipts[&f.old].interpretation,
        jvc_state::Interpretation::Inert
    );
    assert!(
        result.receipts[&f.old]
            .reasons
            .contains("account_authority_disabled")
    );
}
#[test]
fn missing_selected_policy_makes_account_status_actions_unavailable() {
    let mut f = Fixture::new();
    f.retirement("deprecated");
    f.input.selected_view = fake("jve1:");
    let result = evaluate_observed(&f.input);
    assert_eq!(
        result.receipts[&f.old].interpretation,
        jvc_state::Interpretation::Unavailable
    );
    assert_eq!(result.publications[&f.d].status, Status::Unavailable);
}

fn evaluate_observed(input: &EvaluationInput) -> Evaluation {
    let result = evaluate(input);
    if let Ok(directory) = std::env::var("JVC_STATE_PARITY_DIR") {
        let events: Vec<String> = input
            .events
            .iter()
            .map(|e| String::from_utf8(e.canonical_envelope().unwrap()).unwrap())
            .collect();
        let bodies: BTreeMap<String, String> = input
            .bodies
            .iter()
            .map(|(id, b)| (id.clone(), String::from_utf8(b.clone()).unwrap()))
            .collect();
        let wire = json!({"events":events,"bodies":bodies,"selected_view":input.selected_view,"import_selections":input.import_selections,"overlay":input.overlay,"limits":input.limits});
        let mut expected = serde_json::to_value(&result).unwrap();
        expected["publication_statuses"] = json!(
                result
                    .publications
                    .keys()
                    .filter_map(
                        |id| jvc_state::publication_status(&result, id).map(|s| (id.clone(), s))
                    )
                    .collect::<BTreeMap<_, _>>()
            );
        expected["account_controls"] = json!(
            result
                .accounts
                .iter()
                .map(|(key, a)| (
                    key.clone(),
                    jvc_state::account_control(&result, "", &a.account.origin, a.account.account)
                ))
                .collect::<BTreeMap<_, _>>()
        );
        let name = std::thread::current()
            .name()
            .unwrap_or("unnamed")
            .replace("::", "-");
        let hash = hash_id("sha256:", b"", &canonical_value(&wire).unwrap());
        let file = std::path::Path::new(&directory).join(format!("{name}-{}.json", &hash[7..]));
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            file,
            serde_json::to_vec(&json!({"name":name,"input":wire,"expected":expected})).unwrap(),
        )
        .unwrap();
    }
    result
}

fn disable_status_authority(f: &mut Fixture, parents: Vec<String>) {
    let mut body: Value = serde_json::from_slice(&f.input.bodies[&f.base_view]).unwrap();
    body["account_authority"] = json!(false);
    f.input.selected_view = f.event(
        20,
        vec![],
        json!({"kind":"view.publish","parents":parents}),
        Some(body),
    );
}
fn assert_pending_observation(f: &Fixture, missing: &str) {
    let result = f.assert_invariant(49, Status::Unavailable);
    let account = result
        .accounts
        .values()
        .find(|a| a.account.origin == ORIGIN && a.account.account == 41)
        .unwrap();
    assert!(account.unavailable);
    assert!(account.controller.is_none());
    assert!(!account.commands);
    assert!(account.reasons.contains("observation_pending"));
    assert!(account.missing.contains(missing));
    assert!(result.publications[&f.d].missing.contains(missing));
}
#[test]
fn historical_guard_survives_missing_observation_body() {
    let mut f = Fixture::new();
    f.retirement("deprecated");
    let missing = f.witness_heads[&10].clone();
    f.input.bodies.remove(&missing);
    f.view(vec![12, 13], vec![f.base_view.clone()]);
    assert_pending_observation(&f, &missing);
}
#[test]
fn historical_guard_survives_missing_witness_predecessor() {
    let mut f = Fixture::new();
    let predecessor = f.witness_heads[&10].clone();
    f.observe(10, Some(f.ca.clone()), "present", false);
    f.remove(&predecessor);
    f.retirement("deprecated");
    f.view(vec![12, 13], vec![f.base_view.clone()]);
    assert_pending_observation(&f, &predecessor);
}
#[test]
fn pending_descendant_observation_body_prevents_older_controller_fallback() {
    let mut f = Fixture::new();
    f.handover("active");
    f.status(
        2,
        vec![f.cb.clone()],
        f.cb.clone(),
        f.d.clone(),
        "deprecated",
    );
    let missing = f.witness_heads[&10].clone();
    f.input.bodies.remove(&missing);
    assert_pending_observation(&f, &missing);
}
#[test]
fn pending_descendant_witness_history_prevents_older_controller_fallback() {
    let mut f = Fixture::new();
    let missing = f.observe(10, None, "absent", false);
    f.handover("deprecated");
    f.remove(&missing);
    assert_pending_observation(&f, &missing);
}
#[test]
fn pending_historical_descendant_cannot_restore_closed_period_under_new_witnesses() {
    let mut f = Fixture::new();
    f.handover("deprecated");
    let missing = f.witness_heads[&10].clone();
    f.input.bodies.remove(&missing);
    f.view(vec![12, 13], vec![f.base_view.clone()]);
    f.observe(12, Some(f.ca.clone()), "present", false);
    f.observe(13, Some(f.ca.clone()), "present", false);
    assert_pending_observation(&f, &missing);
}
#[test]
fn complete_descendant_closure_does_not_require_old_observation_body() {
    let mut f = Fixture::new();
    let missing = f.witness_heads[&10].clone();
    f.handover("deprecated");
    f.input.bodies.remove(&missing);
    let result = f.assert_invariant(49, Status::Deprecated);
    assert_eq!(
        result.publications[&f.d].claim.as_deref(),
        Some(f.cb.as_str())
    );
}
#[test]
fn known_invalid_observation_body_does_not_create_certificate_guard() {
    let mut f = Fixture::new();
    f.retirement("deprecated");
    malformed_observation_body(&mut f, 10);
    f.view(vec![12, 13], vec![f.base_view.clone()]);
    let result = f.assert_invariant(49, Status::Active);
    assert!(result.accounts.values().all(|a| a.historical.is_empty()));
}
#[test]
fn selected_import_missing_body_keeps_rafsi_gate_unknown() {
    let mut f = Fixture::new();
    let d = native(&mut f, 3);
    f.event(
        3,
        vec![d.clone()],
        json!({"kind":"status.set","target":d,"value":"deprecated"}),
        None,
    );
    let (claim, _) = rafsi(&mut f, 4);
    disable_status_authority(&mut f, vec![]);
    let complete = evaluate_observed(&f.input);
    assert_eq!(
        complete.publications[&claim].eligible,
        jvc_state::Eligibility::Eligible
    );
    f.input.bodies.remove(&f.d);
    let result = evaluate_observed(&f.input);
    assert_eq!(
        result.publications[&f.d].eligible,
        jvc_state::Eligibility::Unknown
    );
    assert!(
        result.publications[&f.d]
            .reasons
            .contains("source_attribution_pending")
    );
    assert_eq!(
        result.publications[&claim].eligible,
        jvc_state::Eligibility::Unknown
    );
}
#[test]
fn unrelated_signers_are_absent_from_sparse_context() {
    let mut f = Fixture::new();
    for k in 30..=200 {
        f.event(k, vec![], json!({"kind":"identity.merge"}), None);
    }
    let result = evaluate_observed(&f.input);
    let graph = jvc_state::evaluate_context(&result, &context());
    assert!(graph.actors.is_empty());
    assert!(graph.available);
    f.event(
        3,
        vec![],
        json!({"kind":"judgment.set","target":f.d,"value":"bless"}),
        None,
    );
    root_policy(&mut f, vec![(4, 1)]);
    f.event(5, vec![], json!({"kind":"trust.set","subject":key(6),"scope":{"kind":"definition","word":"*","language":"fr"},"value":"heed"}), None);
    let graph = jvc_state::evaluate_context(&evaluate_observed(&f.input), &context());
    let mut expected = vec![key(3), key(4)];
    expected.sort();
    assert_eq!(graph.actors, expected);
}
#[test]
fn missing_parent_view_preserves_native_ranking_and_marks_import_guard_unavailable() {
    let mut f = Fixture::new();
    let native = native(&mut f, 3);
    f.event(
        4,
        vec![],
        json!({"kind":"judgment.set","target":native,"value":"bless"}),
        None,
    );
    f.view(vec![10, 11], vec![fake("jve1:")]);
    let result = evaluate_observed(&f.input);
    assert!(result.available);
    assert_eq!(result.publications[&native].status, Status::Active);
    assert_eq!(result.publications[&f.d].status, Status::Unavailable);
    assert!(jvc_state::evaluate_context(&result, &context()).available);
    disable_status_authority(&mut f, vec![fake("jve1:")]);
    let result = evaluate_observed(&f.input);
    assert!(result.available);
    assert_eq!(result.publications[&f.d].status, Status::Active);
    assert!(jvc_state::evaluate_context(&result, &context()).available);
    assert!(result.accounts.values().all(|a| a.unavailable));
}
#[test]
fn disabled_status_authority_preserves_bridge_management_link() {
    let mut f = Fixture::new();
    f.retirement("deprecated");
    let target = native(&mut f, 1);
    let managed = f.event(1, vec![f.old.clone(), target.clone()], json!({"kind":"bridge.set","origin":ORIGIN,"source_definition":1,"target":target,"value":"managed"}), None);
    let parent = f.base_view.clone();
    disable_status_authority(&mut f, vec![parent]);
    let result = evaluate_observed(&f.input);
    assert_eq!(result.publications[&f.d].status, Status::Active);
    assert_eq!(
        result.publications[&f.d].authority,
        jvc_state::Authority::None
    );
    assert_eq!(
        result.receipts[&managed].interpretation,
        jvc_state::Interpretation::Effective
    );
    assert!(
        result
            .registers
            .values()
            .any(|r| r.key.contains("|bridge|") && r.heads.contains(&managed))
    );
    assert!(result.accounts.values().all(|a| a.commands));
}
#[test]
fn four_hundred_accounts_share_cached_policy_witness_groups() {
    let mut f = Fixture::new();
    let mut author_head = f.ca.clone();
    for account in 100..500 {
        let claim = f.event(1, vec![author_head], json!({"kind":"account.set","origin":ORIGIN,"account":account,"value":"claim","previous":null,"carry":[]}), None);
        author_head = claim.clone();
        for w in [10, 11] {
            let id = f.event(w, vec![f.witness_heads[&w].clone()], json!({"kind":"account.observe","origin":ORIGIN,"account":account,"claim":claim,"result":"present"}), Some(json!({"origin":ORIGIN,"account":account,"username":"author","field_hash":fake("sha256:"),"markers":[claim],"method":"lensisku-public-profile-v1","observed_at":"2026-10-11T00:00:00Z"})));
            f.witness_heads.insert(w, id);
        }
    }
    f.view(vec![10, 11], vec![f.base_view.clone()]);
    let begin = std::time::Instant::now();
    let result = evaluate_observed(&f.input);
    eprintln!("401 accounts with shared witnesses: {:?}", begin.elapsed());
    assert!(result.available, "{:?}", result.reasons);
    assert_eq!(result.accounts.len(), 401);
    assert!(
        result
            .accounts
            .values()
            .all(|a| a.commands && !a.unavailable)
    );
}

fn already_certified_replacement() -> Fixture {
    let mut f = Fixture::new();
    f.retirement("active");
    f.cb = f.claim(2, vec![], None, vec![]);
    f.status(
        2,
        vec![f.cb.clone()],
        f.cb.clone(),
        f.d.clone(),
        "deprecated",
    );
    f.certify(f.cb.clone(), false);
    f.certify(f.ca.clone(), false);
    let result = evaluate_observed(&f.input);
    assert_eq!(
        result.publications[&f.d].claim.as_deref(),
        Some(f.ca.as_str())
    );
    f.certify(f.cb.clone(), false);
    let complete = evaluate_observed(&f.input);
    assert_eq!(
        complete.publications[&f.d].claim.as_deref(),
        Some(f.cb.as_str())
    );
    assert_eq!(complete.publications[&f.d].status, Status::Deprecated);
    f
}
#[test]
fn missing_maximal_observation_body_cannot_choose_an_already_certified_claim() {
    let mut f = already_certified_replacement();
    let missing = f.witness_heads[&10].clone();
    f.input.bodies.remove(&missing);
    assert_pending_observation(&f, &missing);
    let result = evaluate_observed(&f.input);
    assert!(
        result.publications[&f.d]
            .controller_candidates
            .contains(&f.cb)
    );
}
#[test]
fn historical_witness_forks_do_not_merge_unrelated_successor_paths() {
    let mut f = Fixture::new();
    let t1 = f.event(
        14,
        vec![],
        json!({"kind":"identity.transfer","successor":key(12)}),
        None,
    );
    let t2 = f.event(
        14,
        vec![],
        json!({"kind":"identity.transfer","successor":key(13)}),
        None,
    );
    let a1 = f.event(
        12,
        vec![],
        json!({"kind":"identity.accept","transfer":t1}),
        None,
    );
    f.event(
        13,
        vec![],
        json!({"kind":"identity.accept","transfer":t2}),
        None,
    );
    f.witness_heads.insert(12, a1);
    f.view(vec![12, 13], vec![]);
    f.observe(12, Some(f.ca.clone()), "present", false);
    let result = evaluate_observed(&f.input);
    assert_eq!(result.publications[&f.d].status, Status::Active);
    assert!(result.accounts.values().all(|a| a.historical.is_empty()));
}

fn malformed_observation_body(f: &mut Fixture, w: u8) -> String {
    let old = f.witness_heads[&w].clone();
    let mut header = f
        .input
        .events
        .iter()
        .find(|e| e.id() == old)
        .unwrap()
        .header()
        .clone();
    let bytes = b"{}".to_vec();
    header.content = Some(body_descriptor(&bytes).unwrap());
    let event = sign_header(&[w; 32], header).unwrap();
    let id = event.id().to_owned();
    f.remove(&old);
    f.input.bodies.remove(&old);
    f.input.bodies.insert(id.clone(), bytes);
    f.input.events.push(event);
    f.witness_heads.insert(w, id.clone());
    id
}
#[test]
fn malformed_maximal_observation_body_preserves_certified_period_frontier() {
    let mut f = already_certified_replacement();
    let invalid = malformed_observation_body(&mut f, 10);
    let result = f.assert_invariant(49, Status::Unavailable);
    let account = result
        .accounts
        .values()
        .find(|a| a.account.account == 41)
        .unwrap();
    assert!(account.controller.is_none());
    assert!(account.reasons.contains("observation_body_invalid"));
    assert!(account.missing.contains(&invalid));
    assert!(account.observation_evidence[&key(10)].contains(&invalid));
    assert!(account.candidates.contains(&f.cb));
}
#[test]
fn malformed_body_cannot_certify_a_never_certified_period() {
    let mut f = Fixture::new();
    f.cb = f.claim(2, vec![], None, vec![]);
    f.certify(f.cb.clone(), false);
    let invalid = malformed_observation_body(&mut f, 10);
    let result = evaluate_observed(&f.input);
    let account = result
        .accounts
        .values()
        .find(|a| a.account.account == 41)
        .unwrap();
    assert!(!account.historical.contains(&f.cb));
    assert!(!account.candidates.contains(&f.cb));
    assert!(account.certificates.iter().all(|c| c.claim != f.cb));
    assert_eq!(account.controller.as_deref(), Some(f.ca.as_str()));
    assert_eq!(result.publications[&f.d].status, Status::Active);
    assert_eq!(
        result.receipts[&invalid].interpretation,
        jvc_state::Interpretation::Unavailable
    );
}

#[test]
fn growing_missing_predecessor_sets_stop_at_global_budget() {
    let mut f = Fixture::new();
    let mut previous = None;
    for n in 1..=600 {
        let missing = format!("jve1:{n:064x}");
        let mut heads = vec![missing];
        heads.extend(previous);
        previous = Some(f.event(30, heads, json!({"kind":"identity.merge"}), None));
    }
    f.input.limits.traversal = 20_000;
    let result = evaluate_observed(&f.input);
    assert!(!result.available);
    assert!(result.reasons.contains("resource_unavailable"));
    assert!(result.publications.is_empty());
    assert!(result.accounts.is_empty());
    assert!(result.judgments.is_empty());
    assert!(result.registers.is_empty());
    assert!(!jvc_state::evaluate_context(&result, &context()).available);
    assert_eq!(
        jvc_state::account_control(&result, "", ORIGIN, 41).state,
        "unavailable"
    );
}

#[test]
fn retirement_of_one_conflicting_source_revision_keeps_all_members_unavailable() {
    let mut f = Fixture::new();
    let newer = f.publish_after(1, vec![f.d.clone()]);
    let d = f.d.clone();
    chunk_policy(&mut f, vec![(9, vec![d.clone()]), (9, vec![newer.clone()])]);
    f.retirement("deprecated");
    let result = f.assert_invariant(49, Status::Unavailable);
    assert!(result.accounts.values().all(|a| a.commands));
    for id in [d, newer] {
        let p = &result.publications[&id];
        assert_eq!(p.status, Status::Unavailable);
        assert_eq!(p.eligible, jvc_state::Eligibility::Unknown);
        assert!(p.reasons.contains("source_selection_conflict"));
        let status = jvc_state::publication_status(&result, &id).unwrap();
        assert_eq!(status.state, Status::Unavailable);
        assert!(status.reasons.contains("source_selection_conflict"));
    }
    assert!(result.publications[&f.d].status_frontier.contains(&f.old));
}

fn refusal_pairs(graph: &jvc_state::ContextGraph) -> Vec<(String, String)> {
    graph
        .refusals
        .iter()
        .enumerate()
        .flat_map(|(target, issuers)| {
            issuers
                .iter()
                .map(move |issuer| (graph.actors[*issuer].clone(), graph.actors[target].clone()))
        })
        .collect()
}

#[test]
fn narrow_heed_overrides_broad_shun_and_narrow_clear_restores_it() {
    let mut f = Fixture::new();
    let broad = f.event(3, vec![], json!({"kind":"trust.set","subject":key(4),"scope":{"kind":"*","word":"*","language":"*"},"value":"shun"}), None);
    let narrow = f.event(3, vec![broad], json!({"kind":"trust.set","subject":key(4),"scope":{"kind":"definition","word":"*","language":"en"},"value":"heed"}), None);
    let graph = jvc_state::evaluate_context(&evaluate_observed(&f.input), &context());
    assert!(refusal_pairs(&graph).is_empty());
    assert_eq!(
        graph.rows[graph.actors.iter().position(|a| a == &key(3)).unwrap()].len(),
        1
    );
    f.event(3, vec![narrow], json!({"kind":"trust.set","subject":key(4),"scope":{"kind":"definition","word":"*","language":"en"},"value":"clear"}), None);
    let graph = jvc_state::evaluate_context(&evaluate_observed(&f.input), &context());
    assert_eq!(refusal_pairs(&graph), vec![(key(3), key(4))]);
    assert!(graph.rows.iter().all(Vec::is_empty));
}

#[test]
fn retained_conflict_refuses_only_when_it_contains_shun() {
    let mut f = Fixture::new();
    for value in ["heed", "clear"] {
        f.event(3, vec![], json!({"kind":"trust.set","subject":key(4),"scope":{"kind":"*","word":"*","language":"*"},"value":value}), None);
    }
    let graph = jvc_state::evaluate_context(&evaluate_observed(&f.input), &context());
    assert!(refusal_pairs(&graph).is_empty());
    assert!(graph.rows.iter().all(Vec::is_empty));
    f.event(3, vec![], json!({"kind":"trust.set","subject":key(4),"scope":{"kind":"*","word":"*","language":"*"},"value":"shun"}), None);
    let graph = jvc_state::evaluate_context(&evaluate_observed(&f.input), &context());
    assert_eq!(refusal_pairs(&graph), vec![(key(3), key(4))]);
}

#[test]
fn continuity_resolves_both_shun_ends_and_ignores_self_shuns() {
    let mut f = Fixture::new();
    let shun = f.event(3, vec![], json!({"kind":"trust.set","subject":key(6),"scope":{"kind":"*","word":"*","language":"*"},"value":"shun"}), None);
    let transfer = f.event(
        3,
        vec![shun],
        json!({"kind":"identity.transfer","successor":key(4)}),
        None,
    );
    f.event(
        4,
        vec![],
        json!({"kind":"identity.accept","transfer":transfer}),
        None,
    );
    let transfer = f.event(
        5,
        vec![],
        json!({"kind":"identity.transfer","successor":key(6)}),
        None,
    );
    let accept = f.event(
        6,
        vec![],
        json!({"kind":"identity.accept","transfer":transfer}),
        None,
    );
    f.event(6, vec![accept], json!({"kind":"trust.set","subject":key(5),"scope":{"kind":"*","word":"*","language":"*"},"value":"shun"}), None);
    let graph = jvc_state::evaluate_context(&evaluate_observed(&f.input), &context());
    assert_eq!(refusal_pairs(&graph), vec![(key(3), key(5))]);
    assert!(!graph.actors.contains(&key(4)));
    assert!(!graph.actors.contains(&key(6)));
}

#[test]
fn equal_positive_graphs_keep_distinct_scoped_refusals_and_profiles() {
    let mut f = Fixture::new();
    f.event(3, vec![], json!({"kind":"trust.set","subject":key(4),"scope":{"kind":"definition","word":"*","language":"en"},"value":"shun"}), None);
    root_policy(&mut f, vec![(3, 1), (4, 1)]);
    let evaluation = evaluate_observed(&f.input);
    let en = jvc_state::evaluate_context(&evaluation, &context());
    let fr = jvc_state::evaluate_context(
        &evaluation,
        &jvc_state::Context {
            language: Some("fr".into()),
            ..context()
        },
    );
    assert_eq!(en.actors, fr.actors);
    assert_eq!(en.roots, fr.roots);
    assert_eq!(en.rows, fr.rows);
    assert_ne!(en.refusals, fr.refusals);
    assert_eq!(en.calculation, "simple-routes-bounds-v1");
    let mut body: Value = serde_json::from_slice(&f.input.bodies[&f.input.selected_view]).unwrap();
    body["calculation"] = json!("simple-routes-shun-v1");
    let id = f.event(
        20,
        vec![],
        json!({"kind":"view.publish","parents":[f.input.selected_view]}),
        Some(body),
    );
    f.input.selected_view = id;
    let new = jvc_state::evaluate_context(&evaluate_observed(&f.input), &context());
    assert_eq!(new.refusals, en.refusals);
    assert_eq!(new.calculation, "simple-routes-shun-v1");
}
