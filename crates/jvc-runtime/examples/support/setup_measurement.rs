use jvc_state::{EvaluatedState, EvaluationInput, HostVerifiedRecord};
use serde_json::{Value, json};
use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    collections::BTreeMap,
    fs::File,
    io::{BufRead, BufReader},
    time::Instant,
};
#[derive(Clone, Copy, Default)]
struct AllocationWindow {
    live: isize,
    peak: usize,
    largest: usize,
    nodes: [usize; 4],
}
thread_local! {
    // A test harness can allocate on another thread during a measurement.
    static WINDOW: Cell<Option<AllocationWindow>> = const { Cell::new(None) };
}
fn update_window(change: impl FnOnce(&mut AllocationWindow)) {
    let _ = WINDOW.try_with(|w| {
        if let Some(mut current) = w.get() {
            change(&mut current);
            w.set(Some(current));
        }
    });
}
fn acquired(n: usize) {
    update_window(|w| {
        w.live += n as isize;
        w.peak = w.peak.max(w.live.max(0) as usize);
        w.largest = w.largest.max(n);
        for (i, size) in [280, 376, 1424, 1520].into_iter().enumerate() {
            if n == size {
                w.nodes[i] += 1;
            }
        }
    });
}
fn released(n: usize) {
    update_window(|w| w.live -= n as isize);
}
fn begin_window() {
    WINDOW.with(|w| {
        assert!(w.get().is_none());
        w.set(Some(AllocationWindow::default()));
    });
}
fn end_window() -> AllocationWindow {
    let result = WINDOW.with(|w| w.replace(None).unwrap());
    assert!(result.live >= 0);
    result
}
struct Counting;
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(l) };
        if !p.is_null() {
            acquired(l.size());
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        released(l.size());
        unsafe { System.dealloc(p, l) }
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        let q = unsafe { System.realloc(p, l, n) };
        if !q.is_null() {
            released(l.size());
            acquired(n);
        }
        q
    }
}
#[global_allocator]
static ALLOCATOR: Counting = Counting;
fn cpu() -> f64 {
    let mut r = std::mem::MaybeUninit::<libc::rusage>::uninit();
    assert_eq!(
        unsafe { libc::getrusage(libc::RUSAGE_SELF, r.as_mut_ptr()) },
        0
    );
    let r = unsafe { r.assume_init() };
    r.ru_utime.tv_sec as f64
        + r.ru_stime.tv_sec as f64
        + (r.ru_utime.tv_usec + r.ru_stime.tv_usec) as f64 / 1e6
}
fn measure(name: &str, state: EvaluatedState) -> [usize; 4] {
    let bound_start = Instant::now();
    let bound_cpu_start = cpu();
    let bound = state.ranking_index_bound().unwrap();
    let bound_cpu = cpu() - bound_cpu_start;
    let bound_seconds = bound_start.elapsed().as_secs_f64();
    begin_window();
    let start = Instant::now();
    let c = cpu();
    state.ensure_ranking_index().unwrap();
    let index_cpu = cpu() - c;
    let index_seconds = start.elapsed().as_secs_f64();
    let allocations = end_window();
    let retained = allocations.live as usize;
    let peak = allocations.peak;
    let largest = allocations.largest;
    let entries = state.ranking_index_counts().unwrap();
    let actual_json = serde_json::to_value(&entries).unwrap();
    let bound_json = serde_json::to_value(&bound).unwrap();
    for (key, value) in actual_json.as_object().unwrap() {
        assert!(
            value.as_u64().unwrap() <= bound_json[key].as_u64().unwrap(),
            "{key}"
        );
    }
    let policy = jvc_runtime::RankingPreparationPolicy {
        core_binding: format!("sha256:{}", "a".repeat(64)),
        limits: Default::default(),
    };
    let (modeled_bytes, modeled_units) = policy.setup_estimate(&bound).unwrap();
    assert!(
        modeled_bytes >= peak as u64,
        "{name}: peak={peak}, charge={modeled_bytes}"
    );
    assert!(modeled_units + 1_000_000 < policy.limits.units);

    begin_window();
    let start = Instant::now();
    let c = cpu();
    let (binding, bytes) = state.ranking_source_binding(1024 * 1024 * 1024).unwrap();
    let hash_cpu = cpu() - c;
    let hash_seconds = start.elapsed().as_secs_f64();
    let hash_peak = end_window().peak;
    println!(
        "{}",
        json!({"name":name,"largest_index_allocation":largest,"tree_nodes_280_376_1424_1520":allocations.nodes,"count_cpu_seconds":bound_cpu,"count_seconds":bound_seconds,"modeled_bytes":modeled_bytes,"modeled_units":modeled_units,"retained_heap_bytes":retained,"peak_heap_bytes":peak,
        "index_cpu_seconds":index_cpu,"index_seconds":index_seconds,"entries":entries,"bound":bound,
        "source_bytes":bytes,"source_binding":binding,"hash_cpu_seconds":hash_cpu,"hash_seconds":hash_seconds,
        "hash_peak_heap_bytes":hash_peak,"records":state.ranking_source_records().unwrap()})
    );
    allocations.nodes
}
fn synthetic(prototype: &Value, n: usize, grouped: bool, rules: bool) -> EvaluatedState {
    let input = EvaluationInput {
        events: vec![],
        bodies: BTreeMap::new(),
        selected_view: "synthetic".into(),
        import_selections: BTreeMap::new(),
        overlay: None,
        limits: Default::default(),
    };
    let state = EvaluatedState::from_input(&input);
    let mut saved: Value = serde_json::from_slice(&state.checkpoint("synthetic").unwrap()).unwrap();
    let mut publications = serde_json::Map::new();
    let mut trust = Vec::new();
    let mut overlay = Vec::new();
    let mut judgments = serde_json::Map::new();
    for i in 0..n {
        let id = format!("jve1:{i:064x}");
        let word = format!("jvw1:{:064x}", if grouped { i % 8 } else { i });
        let mut p = prototype.clone();
        p["id"] = json!(id);
        p["word"] = json!(word);
        if grouped {
            p["kind"] = json!("rafsi.publish");
            p["language"] = Value::Null;
            p["assignment"] = json!(format!("jva1:{:064x}", i % 16));
        }
        publications.insert(id.clone(), p);
        judgments.insert(id, json!({"actor":"bless"}));
        if rules {
            let actor = format!("jvi1:{i:064x}");
            let subject = format!("jvi1:{:064x}", i + 1);
            let scope = json!({"kind":"definition","word":if grouped { "*" } else { &word },"language":"en"});
            trust.push(json!({"actor":actor,"subject":subject,"scope":scope,"values":["heed"]}));
            overlay.push(json!({"issuer":actor,"subject":subject,"scope":scope,"value":"heed","weight":{"numerator":1,"denominator":10}}));
        }
    }
    saved["evaluation"]["publications"] = Value::Object(publications);
    // These trusted synthetic verdicts measure index lookup counts.
    saved["evaluation"]["judgments"] = Value::Object(judgments);
    saved["evaluation"]["trust"] = json!(trust);
    if rules {
        let o = json!({"version":2,"trust":overlay,"blocked":[],"root_changes":[],"public_shun_issuer":null});
        saved["evaluation"]["overlay"] = o.clone();
        saved["options"]["overlay"] = o;
    }
    EvaluatedState::restore_host_checkpoint(&serde_json::to_vec(&saved).unwrap(), "synthetic")
        .unwrap()
}
#[derive(Default)]
pub struct AllocationCoverage {
    pub cases: usize,
    pub tree_nodes: [usize; 4],
}
pub fn small_shapes() -> AllocationCoverage {
    let mut coverage = AllocationCoverage::default();
    let prototype = json!({
        "id":"jve1:0000000000000000000000000000000000000000000000000000000000000000",
        "issuer":"issuer", "kind":"definition.publish", "word":"word", "language":"en", "assignment":null,
        "lineage":{}, "imported":false, "source":null, "source_record":null, "account":null,
        "authority":"native", "controller":null, "claim":null, "observations":[], "status_frontier":[],
        "deciding_claim":null, "controller_candidates":[], "witness_contributions":{}, "missing":[],
        "content_available":true, "eligible":"eligible", "status":"active", "reasons":[]
    });
    for n in [
        0, 1, 2, 5, 6, 7, 10, 11, 12, 13, 17, 23, 24, 63, 64, 65, 80, 81, 82, 87, 88, 89, 90, 95,
        96, 97, 127, 128, 129, 143, 144, 145, 255, 256, 257,
    ] {
        for shape in [
            "definition-unique",
            "rafsi-unique",
            "rafsi-shared",
            "rafsi-shared-assignment",
            "word-only",
            "public-unique",
            "public-shared",
            "private-unique",
            "private-shared-pair",
            "private-clear",
            "private-conflict",
            "mixed",
        ] {
            let state = small_state(&prototype, n, shape);
            let nodes = measure(&format!("small-{shape}-{n}"), state);
            coverage.cases += 1;
            for (total, count) in coverage.tree_nodes.iter_mut().zip(nodes) {
                *total += count;
            }
        }
    }
    coverage
}
fn small_state(prototype: &Value, n: usize, shape: &str) -> EvaluatedState {
    let state = synthetic(prototype, 0, false, false);
    let mut saved: Value = serde_json::from_slice(&state.checkpoint("synthetic").unwrap()).unwrap();
    let mut publications = serde_json::Map::new();
    let mut trust = Vec::new();
    let mut private = Vec::new();
    for i in 0..n {
        let id = format!("jve1:{i:064x}");
        let word = format!(
            "jvw1:{:064x}",
            if shape.starts_with("rafsi-shared") {
                0
            } else {
                i
            }
        );
        if shape.starts_with("definition")
            || shape.starts_with("rafsi")
            || shape == "word-only"
            || shape == "mixed"
        {
            let mut p = prototype.clone();
            p["id"] = json!(id);
            p["word"] = json!(word);
            if shape.starts_with("rafsi") || shape == "mixed" && i % 2 == 0 {
                p["kind"] = json!("rafsi.publish");
                p["language"] = Value::Null;
                p["assignment"] = json!(format!(
                    "jva1:{:064x}",
                    if shape == "rafsi-shared-assignment" {
                        0
                    } else {
                        i
                    }
                ));
            }
            if shape == "word-only" {
                p["kind"] = json!("word.declare");
            }
            publications.insert(id, p);
        }
        if shape.starts_with("public") || shape.starts_with("private") || shape == "mixed" {
            let pair = if shape == "private-shared-pair" || shape == "private-conflict" {
                0
            } else {
                i
            };
            let actor = format!("jvi1:{pair:064x}");
            let subject = format!("jvi1:{:064x}", pair + 1);
            let scope = json!({"kind":"definition","word":if shape=="public-shared" || shape=="private-conflict" {"*"} else {&word},"language":"en"});
            if shape.starts_with("public") || shape == "private-clear" || shape == "mixed" {
                trust
                    .push(json!({"actor":actor,"subject":subject,"scope":scope,"values":["heed"]}));
            }
            if shape.starts_with("private") || shape == "mixed" {
                let value = if shape == "private-clear" {
                    "clear"
                } else if shape == "private-conflict" {
                    ["heed", "shun", "clear"][i % 3]
                } else {
                    "heed"
                };
                private.push(json!({"issuer":actor,"subject":subject,"scope":scope,"value":value,"weight":{"numerator":1,"denominator":10}}));
            }
        }
    }
    saved["evaluation"]["publications"] = json!(publications);
    saved["evaluation"]["trust"] = json!(trust);
    let overlay = json!({"version":2,"trust":private,"blocked":[],"root_changes":[],"public_shun_issuer":null});
    saved["evaluation"]["overlay"] = overlay.clone();
    saved["options"]["overlay"] = overlay;
    EvaluatedState::restore_host_checkpoint(&serde_json::to_vec(&saved).unwrap(), "synthetic")
        .unwrap()
}

pub fn run() {
    let args: Vec<_> = std::env::args().collect();
    if args.len() == 2 && args[1] == "--small" {
        small_shapes();
        return;
    }
    assert_eq!(
        args.len(),
        3,
        "usage: ranking_setup_measurement --small | trusted-core.json trusted-nodes.ndjson"
    );
    small_shapes();
    let bytes = std::fs::read(&args[1]).unwrap();
    let saved: Value = serde_json::from_slice(&bytes).unwrap();
    let binding = saved["binding"].as_str().unwrap().to_owned();
    let prototype = saved["evaluation"]["publications"]
        .as_object()
        .unwrap()
        .values()
        .next()
        .unwrap()
        .clone();
    drop(saved);
    let records: Vec<HostVerifiedRecord> = BufReader::new(File::open(&args[2]).unwrap())
        .lines()
        .map(|l| serde_json::from_str(&format!("{{\"node\":{}}}", l.unwrap())).unwrap())
        .collect();
    let state = EvaluatedState::restore_host_result_checkpoint(&bytes, &binding, records).unwrap();
    drop(bytes);
    measure("dictionary", state);
    for (name, n, grouped, rules) in [
        ("unique-publications", 20_000, false, false),
        ("shared-rafsi-private", 20_000, true, true),
        ("unique-scopes-private", 10_000, false, true),
    ] {
        measure(name, synthetic(&prototype, n, grouped, rules));
    }
}
