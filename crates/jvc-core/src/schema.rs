use crate::{
    Error, Header, MAX_SAFE_INTEGER, Result, canonical_value, rafsi_pair_id, sorted_ids, valid_id,
    validate_spelling, word_id,
};
use num_bigint::BigUint;
use num_integer::Integer;
use serde_json::{Map, Value};
use std::collections::BTreeSet;

fn bad(message: impl Into<String>) -> Error {
    Error::new("schema", message)
}
pub(crate) fn fields<'a>(v: &'a Value, names: &[&str]) -> Result<&'a Map<String, Value>> {
    let o = v
        .as_object()
        .ok_or_else(|| bad("value must be an object"))?;
    if o.len() != names.len() || names.iter().any(|k| !o.contains_key(*k)) {
        return Err(bad(format!(
            "object requires exactly these fields: {}",
            names.join(", ")
        )));
    }
    Ok(o)
}
fn string(v: &Value) -> Result<&str> {
    v.as_str().ok_or_else(|| bad("value must be a string"))
}
fn nonempty(v: &Value) -> Result<&str> {
    let s = string(v)?;
    if s.is_empty() {
        return Err(bad("string must be nonempty"));
    }
    Ok(s)
}
fn array(v: &Value, max: usize) -> Result<&Vec<Value>> {
    let a = v.as_array().ok_or_else(|| bad("value must be an array"))?;
    if a.len() > max {
        return Err(bad("array exceeds its limit"));
    }
    Ok(a)
}
fn integer(v: &Value, low: u64, high: u64) -> Result<u64> {
    let n = v
        .as_u64()
        .ok_or_else(|| bad("value must be a nonnegative integer"))?;
    if !(low..=high).contains(&n) {
        return Err(bad("integer is outside its permitted range"));
    }
    Ok(n)
}
fn oneof<'a>(v: &'a Value, choices: &[&str]) -> Result<&'a str> {
    let s = string(v)?;
    if !choices.contains(&s) {
        return Err(bad("unknown union value"));
    }
    Ok(s)
}
fn nullable(v: &Value, f: impl FnOnce(&Value) -> Result<()>) -> Result<()> {
    if v.is_null() { Ok(()) } else { f(v) }
}
fn id(v: &Value, prefix: &str) -> Result<()> {
    if !valid_id(string(v)?, prefix) {
        return Err(bad("identifier has an invalid form"));
    }
    Ok(())
}
fn ids(v: &Value, prefix: &str, max: usize) -> Result<()> {
    let a = array(v, max)?
        .iter()
        .map(|v| string(v).map(str::to_owned))
        .collect::<Result<Vec<_>>>()?;
    sorted_ids(&a, prefix, max)
}
fn identity(v: &Value) -> Result<()> {
    id(v, "ed25519:")?;
    crate::signature::validate_public_key(
        &hex::decode(&string(v)?[8..]).unwrap().try_into().unwrap(),
    )
}
fn language(v: &Value) -> Result<()> {
    let s = string(v)?;
    if s.len() > 63
        || !s.is_ascii()
        || s.to_ascii_lowercase() != s
        // The library skips subtag length checks for private-use-only tags.
        || s.split('-').any(|part| part.is_empty() || part.len() > 8)
        || language_tags::LanguageTag::parse(s).is_err()
    {
        return Err(bad(
            "language must have well-formed lowercase BCP 47 syntax",
        ));
    }
    Ok(())
}
fn https(v: &Value) -> Result<()> {
    let s = string(v)?;
    let u = url::Url::parse(s).map_err(|_| bad("URL must be an absolute HTTPS URL"))?;
    if u.scheme() != "https" || u.host_str().is_none() {
        return Err(bad("URL must use HTTPS"));
    }
    Ok(())
}
fn origin(v: &Value) -> Result<()> {
    https(v)?;
    let s = string(v)?;
    let u = url::Url::parse(s).unwrap();
    if !u.username().is_empty() || u.password().is_some() || u.origin().ascii_serialization() != s {
        return Err(bad("origin must be a canonical HTTPS origin"));
    }
    Ok(())
}
fn bounded_string(v: &Value, max: usize) -> Result<()> {
    if string(v)?.chars().count() > max {
        return Err(bad("string exceeds its scalar-value limit"));
    }
    Ok(())
}
pub(crate) fn validate_word(v: &Value) -> Result<()> {
    fields(v, &["language", "spelling"])?;
    oneof(&v["language"], &["jbo"])?;
    validate_spelling(string(&v["spelling"])?, 256)
}
pub fn validate_scope(v: &Value) -> Result<()> {
    fields(v, &["kind", "word", "language"])?;
    oneof(&v["kind"], &["definition", "rafsi", "*"])?;
    if v["word"] != "*" {
        id(&v["word"], "jvw1:")?;
    }
    if v["language"] != "*" {
        language(&v["language"])?;
    }
    Ok(())
}
fn reference_count(v: &Value) -> usize {
    fn count(v: &Value, key: &str) -> usize {
        match v {
            Value::String(s)
                if [
                    "transfer",
                    "target",
                    "claim",
                    "parents",
                    "safe",
                    "previous",
                    "carry",
                    "event",
                    "definition",
                    "evidence",
                    "markers",
                ]
                .contains(&key)
                    && valid_id(s, "jve1:") =>
            {
                1
            }
            Value::Array(a) => a.iter().map(|v| count(v, key)).sum(),
            Value::Object(o) => o
                .iter()
                .filter(|(k, _)| k.as_str() != "original")
                .map(|(k, v)| count(v, k))
                .sum(),
            _ => 0,
        }
    }
    count(v, "")
}
pub fn validate_action(h: &Header) -> Result<()> {
    let a = &h.action;
    let kind = string(&a["kind"])?;
    let names: &[&str] = match kind {
        "identity.merge" | "identity.profile" => &["kind"],
        "identity.transfer" => &["kind", "successor"],
        "identity.accept" => &["kind", "transfer"],
        "identity.compromise" => &["kind", "safe"],
        "definition.publish" => &["kind", "word", "language", "parents", "origin"],
        "rafsi.publish" => &["kind", "word", "assignment", "origin"],
        "judgment.set" | "status.set" => &["kind", "target", "value"],
        "trust.set" => &["kind", "subject", "scope", "value"],
        "import.status" => &["kind", "target", "claim", "value"],
        "report.set" => &["kind", "subject", "category", "value"],
        "account.set" if a["value"] == "claim" => {
            &["kind", "origin", "account", "value", "previous", "carry"]
        }
        "account.set" => &["kind", "origin", "account", "value"],
        "account.observe" => &["kind", "origin", "account", "claim", "result"],
        "bridge.set" => &["kind", "origin", "source_definition", "target", "value"],
        "view.publish" => &["kind", "parents"],
        _ => return Err(bad("unknown action kind")),
    };
    fields(a, names)?;
    if reference_count(a) > 256 {
        return Err(bad("action exceeds 256 other event references"));
    }
    match kind {
        "identity.merge" | "identity.profile" => {}
        "identity.transfer" => identity(&a["successor"])?,
        "identity.accept" => id(&a["transfer"], "jve1:")?,
        "identity.compromise" => ids(&a["safe"], "jve1:", 64)?,
        "definition.publish" => {
            id(&a["word"], "jvw1:")?;
            language(&a["language"])?;
            for parent in array(&a["parents"], 16)? {
                id(parent, "jve1:")?;
            }
            oneof(&a["origin"], &["native", "import"])?;
        }
        "rafsi.publish" => {
            id(&a["word"], "jvw1:")?;
            id(&a["assignment"], "jvr1:")?;
            oneof(&a["origin"], &["native", "import"])?;
        }
        "judgment.set" => {
            let target = string(&a["target"])?;
            if !valid_id(target, "jve1:") && !valid_id(target, "jvr1:") {
                return Err(bad("judgment target must be a publication or rafsi pair"));
            }
            oneof(&a["value"], &["bless", "curse", "clear"])?;
        }
        "trust.set" => {
            identity(&a["subject"])?;
            validate_scope(&a["scope"])?;
            oneof(&a["value"], &["heed", "shun", "clear"])?;
        }
        "status.set" => {
            id(&a["target"], "jve1:")?;
            oneof(&a["value"], &["active", "deprecated"])?;
        }
        "import.status" => {
            id(&a["target"], "jve1:")?;
            id(&a["claim"], "jve1:")?;
            oneof(&a["value"], &["active", "deprecated"])?;
        }
        "report.set" => {
            identity(&a["subject"])?;
            oneof(
                &a["category"],
                &[
                    "key-compromise",
                    "fabricated-identities",
                    "spam-flooding",
                    "impersonation",
                ],
            )?;
            oneof(&a["value"], &["report", "clear"])?;
        }
        "account.set" => {
            origin(&a["origin"])?;
            integer(&a["account"], 1, MAX_SAFE_INTEGER)?;
            if oneof(&a["value"], &["claim", "clear"])? == "claim" {
                nullable(&a["previous"], |v| id(v, "jve1:"))?;
                ids(&a["carry"], "jve1:", 64)?;
                let empty = a["carry"].as_array().unwrap().is_empty();
                if a["previous"].is_null() != empty {
                    return Err(bad(
                        "initial claim requires empty carry and replacement claim requires a nonempty carry",
                    ));
                }
            }
        }
        "account.observe" => {
            origin(&a["origin"])?;
            integer(&a["account"], 1, MAX_SAFE_INTEGER)?;
            let r = oneof(
                &a["result"],
                &["present", "absent", "conflict", "unreachable"],
            )?;
            if r == "present" {
                id(&a["claim"], "jve1:")?;
            } else if !a["claim"].is_null() {
                return Err(bad("non-present observation requires null claim"));
            }
        }
        "bridge.set" => {
            origin(&a["origin"])?;
            integer(&a["source_definition"], 1, MAX_SAFE_INTEGER)?;
            id(&a["target"], "jve1:")?;
            oneof(&a["value"], &["managed", "clear"])?;
        }
        "view.publish" => {
            for parent in array(&a["parents"], 256)? {
                id(parent, "jve1:")?;
            }
        }
        _ => unreachable!(),
    }
    let required = matches!(
        kind,
        "identity.profile"
            | "definition.publish"
            | "rafsi.publish"
            | "account.observe"
            | "view.publish"
    ) || (kind == "report.set" && a["value"] == "report");
    let forbidden = matches!(
        kind,
        "identity.merge" | "identity.transfer" | "identity.accept" | "identity.compromise"
    );
    if (required && h.content.is_none()) || (forbidden && h.content.is_some()) {
        return Err(bad("content presence does not match the action kind"));
    }
    Ok(())
}

struct Rich {
    places: BTreeSet<u64>,
    operands: BTreeSet<String>,
    nodes: usize,
}
impl Rich {
    fn new() -> Self {
        Self {
            places: BTreeSet::new(),
            operands: BTreeSet::new(),
            nodes: 0,
        }
    }
    fn text(&mut self, v: &Value, local: bool) -> Result<()> {
        for paragraph in array(v, 8192)? {
            let nodes = array(paragraph, 8192)?;
            if nodes.is_empty() {
                return Err(bad("rich text paragraph must contain a node"));
            }
            for node in nodes {
                self.nodes += 1;
                if self.nodes > 8192 {
                    return Err(bad("body exceeds 8192 rich text nodes"));
                }
                match node {
                    Value::String(s) if !s.is_empty() => {}
                    Value::Number(_) => {
                        let n = integer(node, 1, 65535)?;
                        if !local || !self.places.contains(&n) {
                            return Err(bad("place node requires a declared local place"));
                        }
                    }
                    Value::Object(o) => {
                        if o.contains_key("operand") {
                            fields(node, &["operand"])?;
                            if !local || !self.operands.contains(string(&node["operand"])?) {
                                return Err(bad("operand node requires a declared local operand"));
                            }
                        } else if o.contains_key("code") {
                            fields(node, &["code"])?;
                            string(&node["code"])?;
                        } else if o.contains_key("word") {
                            fields(node, &["word", "label"])?;
                            validate_word(&node["word"])?;
                            string(&node["label"])?;
                        } else if o.contains_key("url") {
                            fields(node, &["url", "label"])?;
                            https(&node["url"])?;
                            string(&node["label"])?;
                        } else {
                            return Err(bad("unknown rich text node"));
                        }
                    }
                    _ => return Err(bad("invalid rich text node")),
                }
            }
        }
        Ok(())
    }
    fn constraints(&mut self, v: &Value) -> Result<()> {
        for t in array(v, usize::MAX)? {
            self.text(t, true)?;
        }
        Ok(())
    }
}
fn gloss(v: &Value) -> Result<()> {
    fields(v, &["language", "text", "sense"])?;
    language(&v["language"])?;
    string(&v["text"])?;
    nullable(&v["sense"], |v| string(v).map(|_| ()))
}
fn source(v: &Value) -> Result<()> {
    fields(v, &["label", "url", "event", "locator"])?;
    string(&v["label"])?;
    nullable(&v["url"], https)?;
    nullable(&v["event"], |v| id(v, "jve1:"))?;
    nullable(&v["locator"], |v| string(v).map(|_| ()))
}
fn sources(v: &Value) -> Result<()> {
    for s in array(v, usize::MAX)? {
        source(s)?;
    }
    Ok(())
}
fn arity(v: &Value, max: u64) -> Result<&str> {
    let mode = oneof(&v["mode"], &["fixed", "variadic", "context"])?;
    match mode {
        "fixed" => {
            fields(v, &["mode", "count"])?;
            integer(&v["count"], 0, max)?;
        }
        "variadic" => {
            fields(v, &["mode", "minimum"])?;
            integer(&v["minimum"], 0, max)?;
        }
        _ => {
            fields(v, &["mode"])?;
        }
    }
    Ok(mode)
}
fn type_hints(v: &Value, r: &mut Rich) -> Result<()> {
    for hint in array(v, 1)? {
        fields(hint, &["alternatives", "note"])?;
        let alternatives = array(&hint["alternatives"], 32)?;
        if alternatives.is_empty() {
            return Err(bad("type hint requires an alternative"));
        }
        let mut seen = BTreeSet::new();
        for a in alternatives {
            fields(a, &["tags", "abstractor", "relation_arity"])?;
            if !seen.insert(canonical_value(a)?) {
                return Err(bad("type alternatives must be distinct"));
            }
            let mut last = None;
            for tag in array(&a["tags"], 32)? {
                let t = string(tag)?;
                if last.is_some_and(|s| s >= t) {
                    return Err(bad("type tags must be sorted and unique"));
                }
                last = Some(t);
                // Tag meanings are reading rules, never validation aliases.
                // entity means referent. tuple means sequence.
                // mass is an opaque legacy annotation outside the current tag tree
                // and has no current alias.
                // See docs/format.md, "Glosses, types, and defaults".
                if ![
                    "referent",
                    "agent",
                    "event",
                    "state",
                    "process",
                    "relation",
                    "proposition",
                    "number",
                    "text",
                    "set",
                    "sequence",
                    "entity",
                    "mass",
                    "tuple",
                ]
                .contains(&t)
                {
                    https(tag)?;
                }
            }
            nullable(&a["abstractor"], |v| {
                oneof(
                    v,
                    &[
                        "nu", "du'u", "ka", "ni", "jei", "li'i", "si'o", "su'u", "mu'e", "pu'u",
                        "za'i", "zu'o",
                    ],
                )
                .map(|_| ())
            })?;
            nullable(&a["relation_arity"], |v| arity(v, 65535).map(|_| ()))?;
            if a["tags"].as_array().unwrap().is_empty()
                && a["abstractor"].is_null()
                && a["relation_arity"].is_null()
            {
                return Err(bad("type alternative supplies no information"));
            }
        }
        r.text(&hint["note"], true)?;
    }
    Ok(())
}
fn frame(v: &Value, r: &mut Rich) -> Result<()> {
    if v.is_null() {
        return Ok(());
    }
    fields(v, &["role", "arity", "places", "tail", "constraints"])?;
    oneof(&v["role"], &["predicate", "constructed-predicate"])?;
    let mode = arity(&v["arity"], 256)?;
    let places = array(&v["places"], 256)?;
    let mut last = 0;
    for p in places {
        fields(
            p,
            &[
                "index",
                "glosses",
                "description",
                "type_hints",
                "defaults",
                "constraints",
                "derivation",
            ],
        )?;
        let n = integer(&p["index"], 1, 65535)?;
        if n <= last {
            return Err(bad("places must have sorted unique indices"));
        }
        last = n;
        r.places.insert(n);
    }
    if mode != "context"
        && places
            .iter()
            .enumerate()
            .any(|(i, p)| p["index"].as_u64() != Some(i as u64 + 1))
    {
        return Err(bad("frame places must form a contiguous prefix"));
    }
    if mode == "fixed" && v["arity"]["count"].as_u64() != Some(places.len() as u64) {
        return Err(bad("fixed frame count does not match its places"));
    }
    if mode == "variadic" {
        if (places.len() as u64) < integer(&v["arity"]["minimum"], 0, 256)? {
            return Err(bad("variadic prefix is shorter than its minimum"));
        }
        fields(&v["tail"], &["from", "description", "type_hints"])?;
        if v["tail"]["from"].as_u64() != Some(places.len() as u64 + 1) {
            return Err(bad("tail begins after the declared prefix"));
        }
        r.text(&v["tail"]["description"], true)?;
        type_hints(&v["tail"]["type_hints"], r)?;
    } else if !v["tail"].is_null() {
        return Err(bad("fixed and context frames require null tail"));
    }
    for p in places {
        for g in array(&p["glosses"], 8192)? {
            gloss(g)?;
        }
        r.text(&p["description"], true)?;
        type_hints(&p["type_hints"], r)?;
        r.constraints(&p["constraints"])?;
        for d in array(&p["defaults"], 8192)? {
            fields(d, &["kind", "value", "condition", "explanation"])?;
            oneof(&d["kind"], &["conventional", "suggested"])?;
            let value = &d["value"];
            if oneof(&value["format"], &["lojban", "prose"])? == "prose" {
                fields(value, &["format", "text", "language"])?;
                language(&value["language"])?;
            } else {
                fields(value, &["format", "text"])?;
            }
            string(&value["text"])?;
            r.text(&d["condition"], true)?;
            r.text(&d["explanation"], true)?;
        }
        for d in array(&p["derivation"], usize::MAX)? {
            fields(d, &["word", "definition", "place", "explanation"])?;
            validate_word(&d["word"])?;
            nullable(&d["definition"], |v| id(v, "jve1:"))?;
            integer(&d["place"], 1, 65535)?;
            r.text(&d["explanation"], false)?;
        }
    }
    r.constraints(&v["constraints"])
}
fn rational(v: &Value) -> Result<(u64, u64)> {
    fields(v, &["numerator", "denominator"])?;
    let n = integer(&v["numerator"], 0, 1_000_000_000)?;
    let d = integer(&v["denominator"], 1, 1_000_000_000)?;
    if n.gcd(&d) != 1 {
        return Err(bad("rational must use lowest terms"));
    }
    Ok((n, d))
}
fn calculated(v: &Value) -> Result<()> {
    fields(v, &["numerator", "denominator"])?;
    let parse = |v: &Value| -> Result<BigUint> {
        let s = string(v)?;
        if s.is_empty()
            || s.len() > 4096
            || !s.bytes().all(|b| b.is_ascii_digit())
            || (s.len() > 1 && s.starts_with('0'))
        {
            return Err(bad(
                "calculated rational requires canonical decimal strings",
            ));
        }
        BigUint::parse_bytes(s.as_bytes(), 10).ok_or_else(|| bad("decimal string is invalid"))
    };
    let n = parse(&v["numerator"])?;
    let d = parse(&v["denominator"])?;
    if d == BigUint::from(0u8) || n.gcd(&d) != BigUint::from(1u8) {
        return Err(bad(
            "calculated rational must have a positive denominator and use lowest terms",
        ));
    }
    Ok(())
}
fn formation(v: &Value, r: &mut Rich) -> Result<()> {
    if v.is_null() {
        return Ok(());
    }
    fields(
        v,
        &[
            "method",
            "algorithm",
            "sources",
            "weights_profile",
            "generated",
            "selected_score",
            "selected_rank",
            "selection_reason",
            "candidates",
            "conflicts",
        ],
    )?;
    let method = oneof(&v["method"], &["algorithmic", "non-algorithmic", "unknown"])?;
    if method == "non-algorithmic" && !v["algorithm"].is_null() {
        return Err(bad("non-algorithmic formation requires null algorithm"));
    }
    nullable(&v["algorithm"], |a| {
        fields(a, &["id", "version", "implementation", "parameters"])?;
        https(&a["id"])?;
        nonempty(&a["version"])?;
        nullable(&a["implementation"], source)?;
        fields(
            &a["parameters"],
            &[
                "weighting",
                "matching",
                "transliteration",
                "candidates",
                "aggregation",
            ],
        )?;
        for p in a["parameters"].as_object().unwrap().values() {
            nonempty(p)?;
        }
        Ok(())
    })?;
    for s in array(&v["sources"], 64)? {
        let mut names = vec!["language", "word", "input", "weight", "notes"];
        for name in ["word_ipa", "stem", "ipa"] {
            if let Some(value) = s.get(name) {
                names.push(name);
                nullable(value, |v| nonempty(v).map(|_| ()))?;
            }
        }
        fields(s, &names)?;
        language(&s["language"])?;
        string(&s["word"])?;
        nullable(&s["input"], |i| {
            fields(i, &["format", "text"])?;
            oneof(&i["format"], &["lojbanized", "ipa"])?;
            nonempty(&i["text"])?;
            Ok(())
        })?;
        nullable(&s["weight"], |v| rational(v).map(|_| ()))?;
        r.text(&s["notes"], false)?;
    }
    nullable(&v["weights_profile"], |p| {
        fields(p, &["name", "source"])?;
        nullable(&p["name"], |v| nonempty(v).map(|_| ()))?;
        nullable(&p["source"], source)
    })?;
    nullable(&v["generated"], |v| string(v).map(|_| ()))?;
    nullable(&v["selected_score"], calculated)?;
    nullable(&v["selected_rank"], |v| {
        integer(v, 1, MAX_SAFE_INTEGER).map(|_| ())
    })?;
    r.text(&v["selection_reason"], false)?;
    for c in array(&v["candidates"], 32)? {
        fields(c, &["form", "score", "rank"])?;
        string(&c["form"])?;
        nullable(&c["score"], calculated)?;
        nullable(&c["rank"], |v| integer(v, 1, MAX_SAFE_INTEGER).map(|_| ()))?;
    }
    for c in array(&v["conflicts"], usize::MAX)? {
        fields(c, &["word", "rule", "snapshot"])?;
        id(&c["word"], "jvw1:")?;
        oneof(
            &c["rule"],
            &["identical", "final-vowel", "similar-consonant"],
        )?;
        id(&c["snapshot"], "sha256:")?;
    }
    Ok(())
}
fn etymology(v: &Value, r: &mut Rich) -> Result<()> {
    fields(v, &["text", "formation", "compound"])?;
    r.text(&v["text"], false)?;
    formation(&v["formation"], r)?;
    nullable(&v["compound"], |c| {
        fields(
            c,
            &["components", "morphology", "scoring", "score", "notes"],
        )?;
        let components = array(&c["components"], 64)?;
        if components.len() < 2 {
            return Err(bad("compound requires at least two components"));
        }
        for p in components {
            fields(p, &["word", "definition", "rafsi"])?;
            validate_word(&p["word"])?;
            nullable(&p["definition"], |v| id(v, "jve1:"))?;
            nonempty(&p["rafsi"])?;
        }
        for key in ["morphology", "scoring"] {
            fields(&c[key], &["id", "version"])?;
            https(&c[key]["id"])?;
            nonempty(&c[key]["version"])?;
        }
        nullable(&c["score"], |v| {
            if v.as_i64()
                .is_some_and(|n| n.unsigned_abs() <= MAX_SAFE_INTEGER)
            {
                Ok(())
            } else {
                Err(bad("compound score requires a safe integer"))
            }
        })?;
        r.text(&c["notes"], false)
    })
}
fn legacy(v: &Value) -> Result<()> {
    fields(
        v,
        &[
            "source",
            "snapshot",
            "extraction",
            "record",
            "locator",
            "original",
            "attribution",
            "conversion",
            "limitations",
        ],
    )?;
    nonempty(&v["source"])?;
    id(&v["snapshot"], "sha256:")?;
    let extraction = nonempty(&v["extraction"])?;
    if !extraction.is_ascii() || extraction.len() > 80 {
        return Err(bad("extraction version exceeds 80 ASCII characters"));
    }
    fields(&v["record"], &["kind", "id"])?;
    oneof(&v["record"]["kind"], &["definition", "word"])?;
    integer(&v["record"]["id"], 1, MAX_SAFE_INTEGER)?;
    string(&v["locator"])?;
    if !v["original"].is_object() {
        return Err(bad("legacy original must be a source object"));
    }
    source_original(&v["original"])?;
    fields(
        &v["attribution"],
        &["author", "editor", "author_account", "dates"],
    )?;
    let a = &v["attribution"];
    for k in ["author", "editor"] {
        nullable(&a[k], |v| string(v).map(|_| ()))?;
    }
    let dates = a["dates"]
        .as_object()
        .ok_or_else(|| bad("legacy dates must be an object"))?;
    for d in dates.values() {
        string(d)?;
    }
    nullable(&a["author_account"], |a| {
        fields(a, &["origin", "account", "username", "evidence"])?;
        origin(&a["origin"])?;
        integer(&a["account"], 1, MAX_SAFE_INTEGER)?;
        nullable(&a["username"], |v| string(v).map(|_| ()))?;
        fields(&a["evidence"], &["kind", "source"])?;
        oneof(&a["evidence"]["kind"], &["source-id", "username-lookup"])?;
        source(&a["evidence"]["source"])
    })?;
    let c = &v["conversion"];
    fields(
        c,
        &[
            "method", "tool", "version", "model", "review", "mappings", "warnings",
        ],
    )?;
    let method = oneof(&c["method"], &["literal", "heuristic", "model-assisted"])?;
    string(&c["tool"])?;
    string(&c["version"])?;
    nullable(&c["model"], |m| {
        fields(m, &["provider", "model", "revision"])?;
        string(&m["provider"])?;
        string(&m["model"])?;
        nullable(&m["revision"], |v| string(v).map(|_| ()))
    })?;
    oneof(&c["review"], &["unreviewed", "reviewed"])?;
    let mappings = array(&c["mappings"], usize::MAX)?;
    if method == "literal" && !mappings.is_empty() {
        return Err(bad("literal conversion cannot have mappings"));
    }
    for m in mappings {
        fields(m, &["field", "start", "end", "place"])?;
        let pointer = string(&m["field"])?;
        if !pointer.starts_with('/')
            || v["original"]
                .pointer(pointer)
                .and_then(Value::as_str)
                .is_none()
        {
            return Err(bad(
                "conversion field must point to an original source string",
            ));
        }
        let start = integer(&m["start"], 0, MAX_SAFE_INTEGER)?;
        let end = integer(&m["end"], start + 1, MAX_SAFE_INTEGER)?;
        if end
            > v["original"]
                .pointer(pointer)
                .unwrap()
                .as_str()
                .unwrap()
                .chars()
                .count() as u64
        {
            return Err(bad("conversion mapping exceeds the source text"));
        }
        integer(&m["place"], 1, 65535)?;
    }
    for w in array(&c["warnings"], usize::MAX)? {
        string(w)?;
    }
    for l in array(&v["limitations"], usize::MAX)? {
        string(l)?;
    }
    Ok(())
}
fn publication_legacy(h: &Header, b: &Value) -> Result<()> {
    if h.action["origin"] == "native" {
        if !b["legacy"].is_null() {
            return Err(bad("native publication requires null legacy"));
        }
    } else {
        legacy(&b["legacy"])?;
    }
    Ok(())
}
fn definition(h: &Header, b: &Value, r: &mut Rich) -> Result<()> {
    fields(
        b,
        &[
            "word",
            "language",
            "text",
            "frame",
            "operands",
            "glosses",
            "notes",
            "etymology",
            "examples",
            "classification",
            "labels",
            "sources",
            "license",
            "legacy",
        ],
    )?;
    if word_id(&b["word"])? != h.action["word"] {
        return Err(bad("definition word differs from its action"));
    }
    language(&b["language"])?;
    if b["language"] != h.action["language"] {
        return Err(bad("definition language differs from its action"));
    }
    for operand in array(&b["operands"], usize::MAX)? {
        fields(operand, &["id", "category", "description", "cardinality"])?;
        let s = string(&operand["id"])?;
        if s.is_empty()
            || s.len() > 32
            || !s.bytes().next().unwrap().is_ascii_lowercase()
            || !s
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
            || !r.operands.insert(s.to_owned())
        {
            return Err(bad("operand ID is invalid or duplicate"));
        }
        string(&operand["category"])?;
        fields(&operand["cardinality"], &["minimum", "maximum"])?;
        let minimum = integer(&operand["cardinality"]["minimum"], 0, 65535)?;
        nullable(&operand["cardinality"]["maximum"], |v| {
            integer(v, minimum, 65535).map(|_| ())
        })?;
    }
    frame(&b["frame"], r)?;
    for operand in b["operands"].as_array().unwrap() {
        r.text(&operand["description"], true)?;
    }
    r.text(&b["text"], true)?;
    r.text(&b["notes"], true)?;
    for g in array(&b["glosses"], 8192)? {
        gloss(g)?;
    }
    etymology(&b["etymology"], r)?;
    for e in array(&b["examples"], 8192)? {
        fields(e, &["language", "text", "translation", "notes"])?;
        language(&e["language"])?;
        string(&e["text"])?;
        r.text(&e["translation"], false)?;
        r.text(&e["notes"], false)?;
    }
    fields(&b["classification"], &["kind", "selmaho"])?;
    oneof(
        &b["classification"]["kind"],
        &[
            "gismu", "cmavo", "lujvo", "fuivla", "cmevla", "compound", "letteral", "other",
        ],
    )?;
    for s in array(&b["classification"]["selmaho"], usize::MAX)? {
        string(s)?;
    }
    for l in array(&b["labels"], 32)? {
        bounded_string(l, 80)?;
    }
    sources(&b["sources"])?;
    fields(&b["license"], &["expression", "url", "attribution"])?;
    string(&b["license"]["expression"])?;
    nullable(&b["license"]["url"], https)?;
    string(&b["license"]["attribution"])?;
    publication_legacy(h, b)
}
fn view(b: &Value, r: &mut Rich) -> Result<()> {
    fields(
        b,
        &[
            "name",
            "description",
            "roots",
            "rafsi_threshold",
            "H",
            "alpha",
            "excluded",
            "calculation",
            "work",
            "import_sets",
            "account_witnesses",
            "account_authority",
            "notes",
        ],
    )?;
    bounded_string(&b["name"], 80)?;
    r.text(&b["description"], false)?;
    r.text(&b["notes"], false)?;
    let sorted_identity_objects = |v: &Value, names: &[&str], max: usize| -> Result<()> {
        let mut last = None;
        for e in array(v, max)? {
            fields(e, names)?;
            identity(&e["identity"])?;
            let s = string(&e["identity"])?;
            if last.is_some_and(|l| l >= s) {
                return Err(bad("identity objects must be sorted and unique"));
            }
            last = Some(s);
        }
        Ok(())
    };
    sorted_identity_objects(&b["roots"], &["identity", "q"], 10000)?;
    for root in b["roots"].as_array().unwrap() {
        rational(&root["q"])?;
    }
    sorted_identity_objects(&b["excluded"], &["identity", "evidence"], 10000)?;
    for e in b["excluded"].as_array().unwrap() {
        ids(&e["evidence"], "jve1:", 256)?;
    }
    let (n, _) = rational(&b["rafsi_threshold"])?;
    if n == 0 {
        return Err(bad("rafsi threshold must be positive"));
    }
    let (n, d) = rational(&b["H"])?;
    if n > 100 * d {
        return Err(bad("H exceeds 100"));
    }
    let (n, d) = rational(&b["alpha"])?;
    if 10 * n > 9 * d {
        return Err(bad("alpha exceeds 9/10"));
    }
    oneof(
        &b["calculation"],
        &["simple-routes-bounds-v1", "simple-routes-shun-v1"],
    )?;
    integer(&b["work"], 1, 10_000_000)?;
    ids(&b["account_witnesses"], "ed25519:", 64)?;
    for i in b["account_witnesses"].as_array().unwrap() {
        identity(i)?;
    }
    let authority = b["account_authority"]
        .as_bool()
        .ok_or_else(|| bad("account authority must be a boolean"))?;
    if authority && b["account_witnesses"].as_array().unwrap().is_empty() {
        return Err(bad("account authority requires a witness"));
    }
    let mut last: Option<(String, String, String)> = None;
    for entry in array(&b["import_sets"], 8192)? {
        fields(entry, &["source", "importer", "selection"])?;
        nonempty(&entry["source"])?;
        identity(&entry["importer"])?;
        id(&entry["selection"], "sha256:")?;
        let tuple = (
            string(&entry["source"])?.to_owned(),
            string(&entry["importer"])?.to_owned(),
            string(&entry["selection"])?.to_owned(),
        );
        if last.as_ref().is_some_and(|p| p >= &tuple) {
            return Err(bad("import sets must be sorted and unique"));
        }
        last = Some(tuple);
    }
    Ok(())
}
fn timestamp(v: &Value) -> Result<()> {
    let s = string(v)?;
    let bytes = s.as_bytes();
    if bytes.len() != 20
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
        || bytes[19] != b'Z'
    {
        return Err(bad("timestamp requires UTC seconds"));
    }
    for (i, b) in bytes.iter().enumerate() {
        if ![4, 7, 10, 13, 16, 19].contains(&i) && !b.is_ascii_digit() {
            return Err(bad("timestamp digit is invalid"));
        }
    }
    let number = |range: std::ops::Range<usize>| s[range].parse::<u32>().unwrap();
    let y = number(0..4);
    let m = number(5..7);
    let d = number(8..10);
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let days = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => 0,
    };
    if y == 0
        || d == 0
        || d > days
        || number(11..13) > 23
        || number(14..16) > 59
        || number(17..19) > 59
    {
        return Err(bad("timestamp is not a valid Gregorian date"));
    }
    Ok(())
}
fn observation(h: &Header, b: &Value) -> Result<()> {
    fields(
        b,
        &[
            "origin",
            "account",
            "username",
            "field_hash",
            "markers",
            "method",
            "observed_at",
        ],
    )?;
    if b["origin"] != h.action["origin"] || b["account"] != h.action["account"] {
        return Err(bad("observation account differs from its action"));
    }
    nullable(&b["username"], |v| string(v).map(|_| ()))?;
    ids(&b["markers"], "jve1:", 256)?;
    oneof(&b["method"], &["lensisku-public-profile-v1"])?;
    timestamp(&b["observed_at"])?;
    if h.action["result"] == "unreachable" {
        if !b["field_hash"].is_null() || !b["markers"].as_array().unwrap().is_empty() {
            return Err(bad(
                "unreachable observation requires null hash and empty markers",
            ));
        }
    } else {
        id(&b["field_hash"], "sha256:")?;
    }
    if h.action["result"] == "present" && b["markers"] != serde_json::json!([h.action["claim"]]) {
        return Err(bad("present observation markers must equal its claim"));
    }
    if h.action["result"] == "absent" && !b["markers"].as_array().unwrap().is_empty() {
        return Err(bad("absent observation requires empty markers"));
    }
    Ok(())
}
pub fn validate_body(h: &Header, b: &Value) -> Result<()> {
    validate_action(h)?;
    canonical_value(b)?;
    if reference_count(&h.action) + reference_count(b) > 256 {
        return Err(bad("record exceeds 256 other event references"));
    }
    let mut r = Rich::new();
    match string(&h.action["kind"])? {
        "identity.profile" => {
            fields(b, &["name", "bio", "links"])?;
            bounded_string(&b["name"], 80)?;
            r.text(&b["bio"], false)?;
            for link in array(&b["links"], 8)? {
                https(link)?;
            }
        }
        "definition.publish" => definition(h, b, &mut r)?,
        "rafsi.publish" => {
            fields(b, &["word", "rafsi", "rationale", "sources", "legacy"])?;
            let word = word_id(&b["word"])?;
            if word != h.action["word"] {
                return Err(bad("rafsi word differs from its action"));
            }
            if rafsi_pair_id(&word, string(&b["rafsi"])?)? != h.action["assignment"] {
                return Err(bad("rafsi assignment differs from its pair identifier"));
            }
            r.text(&b["rationale"], false)?;
            sources(&b["sources"])?;
            publication_legacy(h, b)?;
        }
        "view.publish" => view(b, &mut r)?,
        "account.observe" => observation(h, b)?,
        "account.set" => {
            fields(b, &["username", "note"])?;
            nullable(&b["username"], |v| string(v).map(|_| ()))?;
            r.text(&b["note"], false)?;
        }
        "judgment.set" | "trust.set" | "status.set" | "import.status" | "report.set"
        | "bridge.set" => {
            fields(b, &["text"])?;
            r.text(&b["text"], false)?;
        }
        _ => return Err(bad("action does not permit a body")),
    }
    Ok(())
}

fn source_original(v: &Value) -> Result<()> {
    match v {
        Value::Number(_) => return Err(bad("legacy source numbers require tagged numeric tokens")),
        Value::Array(a) => {
            for v in a {
                source_original(v)?;
            }
        }
        Value::Object(o) => {
            if o.contains_key("$source_number") {
                fields(v, &["$source_number"])?;
                let s = string(&v["$source_number"])?;
                if !source_number(s) {
                    return Err(bad("legacy numeric token is invalid"));
                }
            } else if o.contains_key("$source_object") {
                fields(v, &["$source_object"])?;
                for pair in array(&v["$source_object"], usize::MAX)? {
                    let pair = array(pair, 2)?;
                    if pair.len() != 2 {
                        return Err(bad("escaped source object requires key-value pairs"));
                    }
                    string(&pair[0])?;
                    source_original(&pair[1])?;
                }
            } else {
                for v in o.values() {
                    source_original(v)?;
                }
            }
        }
        _ => {}
    }
    Ok(())
}
fn source_number(s: &str) -> bool {
    let b = s.as_bytes();
    let mut at = 0;
    if b.get(at) == Some(&b'-') {
        at += 1;
    }
    if b.get(at) == Some(&b'0') {
        at += 1;
    } else {
        if !b.get(at).is_some_and(|b| (b'1'..=b'9').contains(b)) {
            return false;
        }
        while b.get(at).is_some_and(u8::is_ascii_digit) {
            at += 1;
        }
    }
    if b.get(at) == Some(&b'.') {
        at += 1;
        let first = at;
        while b.get(at).is_some_and(u8::is_ascii_digit) {
            at += 1;
        }
        if first == at {
            return false;
        }
    }
    if matches!(b.get(at), Some(b'e' | b'E')) {
        at += 1;
        if matches!(b.get(at), Some(b'+' | b'-')) {
            at += 1;
        }
        let first = at;
        while b.get(at).is_some_and(u8::is_ascii_digit) {
            at += 1;
        }
        if first == at {
            return false;
        }
    }
    at == b.len()
}
