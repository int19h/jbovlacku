//! Compare the TypeScript port with the Rust implementation at 62340e6.
//! Copy this file into that revision's morphology examples directory.
use jvc_morphology::{Profile, analyze_word, build_lujvo, generate_gismu};
use serde_json::{Value, json};
use std::io::{self, BufRead, Write};

fn call(input: &Value) -> Value {
    let profile = || serde_json::from_value::<Profile>(input["profile"].clone()).unwrap();
    match input["op"].as_str().unwrap() {
        "analyze" => json!({"ok": analyze_word(profile(), input["word"].as_str().unwrap())}),
        "build" => match build_lujvo(&serde_json::from_value(input["request"].clone()).unwrap()) {
            Ok(result) => json!({"ok": result}),
            Err(error) => json!({"error": error}),
        },
        "generate" => match generate_gismu(&serde_json::from_value(input["request"].clone()).unwrap()) {
            Ok(result) => json!({"ok": result}),
            Err(error) => json!({"error": error}),
        },
        "score" => match jvc_morphology::lujvo::score(&serde_json::from_value::<Vec<String>>(input["tokens"].clone()).unwrap()) {
            Ok(result) => json!({"ok": result}),
            Err(error) => json!({"error": error}),
        },
        "segment" => match jvc_morphology::lujvo::segment_cll(input["word"].as_str().unwrap()) {
            Ok(result) => json!({"ok": result}),
            Err(error) => json!({"error": error}),
        },
        "presets" => json!({"ok": jvc_morphology::builder_presets()}),
        _ => panic!("Unknown comparison operation"),
    }
}

fn main() {
    let mut out = io::BufWriter::new(io::stdout().lock());
    for line in io::stdin().lock().lines() {
        let input: Value = serde_json::from_str(&line.unwrap()).unwrap();
        serde_json::to_writer(&mut out, &call(&input)).unwrap();
        writeln!(out).unwrap();
        out.flush().unwrap();
    }
}
