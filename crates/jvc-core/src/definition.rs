//! Definition defaults affect interpreted copies only, never authenticated content.
use serde_json::{Value, json};

#[derive(Clone, Copy)]
enum Mode {
    Interpret,
    Omit,
}

/// Derive the optional definition fields without changing the supplied value.
/// Authenticate and validate the original record before using this reader value.
pub fn interpret_definition(body: &Value) -> Value {
    transform(body, Mode::Interpret)
}

/// Omit optional definition defaults in a new body before signing.
/// This transformation does not validate a body or alter imported source evidence.
pub fn omit_definition_defaults(body: &Value) -> Value {
    transform(body, Mode::Omit)
}

fn defaults(v: &mut Value, values: Value, mode: Mode) {
    let Some(object) = v.as_object_mut() else {
        return;
    };
    for (key, value) in values.as_object().unwrap() {
        match mode {
            Mode::Interpret => {
                object.entry(key.clone()).or_insert_with(|| value.clone());
            }
            Mode::Omit => {
                if object.get(key) == Some(value) {
                    object.remove(key);
                }
            }
        }
    }
}
fn each(v: &mut Value, key: &str, visit: impl Fn(&mut Value)) {
    if let Some(values) = v.get_mut(key).and_then(Value::as_array_mut) {
        for value in values {
            visit(value);
        }
    }
}
fn child(v: &mut Value, key: &str, visit: impl FnOnce(&mut Value)) {
    if let Some(value) = v.get_mut(key) {
        visit(value);
    }
}
fn source(v: &mut Value, mode: Mode) {
    defaults(v, json!({"url":null,"event":null,"locator":null}), mode);
}
fn gloss(v: &mut Value, mode: Mode) {
    defaults(v, json!({"sense":null}), mode);
}
fn hints(v: &mut Value, mode: Mode) {
    each(v, "type_hints", |hint| {
        each(hint, "alternatives", |alternative| {
            defaults(
                alternative,
                json!({"tags":[],"abstractor":null,"relation_arity":null}),
                mode,
            );
        });
        defaults(hint, json!({"note":[]}), mode);
    });
}
fn frame(v: &mut Value, mode: Mode) {
    each(v, "places", |place| {
        each(place, "glosses", |v| gloss(v, mode));
        hints(place, mode);
        each(place, "defaults", |v| {
            defaults(v, json!({"condition":[],"explanation":[]}), mode)
        });
        each(place, "derivation", |v| {
            defaults(v, json!({"definition":null,"explanation":[]}), mode)
        });
        defaults(
            place,
            json!({"glosses":[],"description":[],"type_hints":[],"defaults":[],"constraints":[],"derivation":[]}),
            mode,
        );
    });
    child(v, "tail", |tail| {
        hints(tail, mode);
        defaults(tail, json!({"description":[],"type_hints":[]}), mode);
    });
    defaults(v, json!({"places":[],"constraints":[]}), mode);
    if matches!(v["arity"]["mode"].as_str(), Some("fixed" | "context")) {
        defaults(v, json!({"tail":null}), mode);
    }
}
fn etymology(v: &mut Value, mode: Mode) {
    child(v, "formation", |formation| {
        child(formation, "algorithm", |algorithm| {
            child(algorithm, "implementation", |v| source(v, mode));
            defaults(algorithm, json!({"implementation":null}), mode);
        });
        each(formation, "sources", |v| {
            defaults(
                v,
                json!({"input":null,"weight":null,"notes":[],"word_ipa":null}),
                mode,
            )
        });
        child(formation, "weights_profile", |profile| {
            child(profile, "source", |v| source(v, mode));
            defaults(profile, json!({"name":null,"source":null}), mode);
        });
        each(formation, "candidates", |v| {
            defaults(v, json!({"score":null,"rank":null}), mode)
        });
        defaults(
            formation,
            json!({"algorithm":null,"sources":[],"weights_profile":null,"generated":null,"selected_score":null,"selected_rank":null,"selection_reason":[],"candidates":[],"conflicts":[]}),
            mode,
        );
    });
    child(v, "compound", |compound| {
        each(compound, "components", |v| {
            defaults(v, json!({"definition":null}), mode)
        });
        defaults(compound, json!({"score":null,"notes":[]}), mode);
    });
    defaults(v, json!({"text":[],"formation":null,"compound":null}), mode);
}
fn transform(body: &Value, mode: Mode) -> Value {
    let mut value = body.clone();
    child(&mut value, "frame", |v| frame(v, mode));
    each(&mut value, "operands", |operand| {
        child(operand, "cardinality", |v| {
            defaults(v, json!({"maximum":null}), mode)
        });
        defaults(operand, json!({"description":[]}), mode);
    });
    each(&mut value, "glosses", |v| gloss(v, mode));
    child(&mut value, "etymology", |v| etymology(v, mode));
    each(&mut value, "examples", |v| {
        defaults(v, json!({"translation":[],"notes":[]}), mode)
    });
    child(&mut value, "classification", |v| {
        defaults(v, json!({"selmaho":[]}), mode)
    });
    each(&mut value, "sources", |v| source(v, mode));
    child(&mut value, "license", |v| {
        defaults(v, json!({"url":null,"attribution":""}), mode)
    });
    // Etymology children are omitted first, so its empty object is the writer default.
    let etymology_default = match mode {
        Mode::Interpret => json!({"text":[],"formation":null,"compound":null}),
        Mode::Omit => json!({}),
    };
    defaults(
        &mut value,
        json!({"frame":null,"operands":[],"glosses":[],"notes":[],"etymology":etymology_default,"examples":[],"labels":[],"sources":[],"legacy":null}),
        mode,
    );
    value
}
