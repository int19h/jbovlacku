//! Measure retained setup inputs from a trusted, separately pinned host checkpoint.
//! This tool reads copies only and never changes preparation policy limits.
use serde_json::{Value, json};
use std::{collections::BTreeMap, io::BufRead};
fn main() {
    let args: Vec<_> = std::env::args().collect();
    assert_eq!(
        args.len(),
        3,
        "usage: ranking_setup_size CORE_JSON NODES_NDJSON"
    );
    let mut saved: Value = serde_json::from_reader(std::fs::File::open(&args[1]).unwrap()).unwrap();
    let mut nodes = BTreeMap::new();
    for line in std::io::BufReader::new(std::fs::File::open(&args[2]).unwrap()).lines() {
        let node: Value = serde_json::from_str(&line.unwrap()).unwrap();
        nodes.insert(node["id"].as_str().unwrap().to_owned(), node);
    }
    saved["version"] = json!(jvc_state::CHECKPOINT_VERSION);
    saved["nodes"] = json!(nodes);
    drop(nodes);
    let binding = saved["binding"].as_str().unwrap().to_owned();
    let state = jvc_state::EvaluatedState::restore_host_checkpoint(
        &serde_json::to_vec(&saved).unwrap(),
        &binding,
    )
    .unwrap();
    drop(saved);
    let records = state.ranking_source_records().unwrap() as u64;
    // Count the full source independently of admission. No policy is raised.
    let (hash, source) = state.ranking_source_binding(usize::MAX).unwrap();
    let source = source as u64;
    let setup = 16 * source + 256 * records;
    let units =
        4 * source + 64 * (records + 1) * u64::from(u64::BITS - (records + 1).leading_zeros());
    let maximum = 1024u64 * 1024 * 1024;
    println!(
        "{}",
        json!({"source_bytes":source,"source_binding":hash,"structural_records":records,
        "setup_bytes":setup,"setup_units":units,"setup_default":512u64*1024*1024,"setup_ceiling":maximum,
        "source_allowance_at_ceiling":maximum.saturating_sub(256*records)/16,
        "bytes_above_ceiling":setup.saturating_sub(maximum),"minimum_setup_ceiling":setup,
        "rounded_setup_ceiling_mib":setup.div_ceil(1024*1024),"unit_ceiling":1_000_000_000u64,
        "units_above_ceiling":units.saturating_sub(1_000_000_000),"evaluation_available":state.evaluation().available,
        "calculation":state.evaluation().policy.as_ref().map(|p|&p["calculation"])})
    );
}
