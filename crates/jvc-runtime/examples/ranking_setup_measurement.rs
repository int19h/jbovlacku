//! Measure trusted host checkpoints and synthetic index shapes. No signing or writes.
#[cfg(unix)]
mod measurement {
    use jvc_state::{EvaluatedState, EvaluationInput, HostVerifiedRecord};
    use serde_json::{Value, json};
    use std::{
        alloc::{GlobalAlloc, Layout, System},
        collections::BTreeMap,
        fs::File,
        io::{BufRead, BufReader},
        sync::atomic::{AtomicUsize, Ordering::Relaxed},
        time::Instant,
    };
    struct Counting;
    static LIVE: AtomicUsize = AtomicUsize::new(0);
    static PEAK: AtomicUsize = AtomicUsize::new(0);
    fn acquired(n: usize) {
        let live = LIVE.fetch_add(n, Relaxed) + n;
        PEAK.fetch_max(live, Relaxed);
    }
    unsafe impl GlobalAlloc for Counting {
        unsafe fn alloc(&self, l: Layout) -> *mut u8 {
            let p = unsafe { System.alloc(l) };
            if !p.is_null() {
                acquired(l.size());
            }
            p
        }
        unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
            LIVE.fetch_sub(l.size(), Relaxed);
            unsafe { System.dealloc(p, l) }
        }
        unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
            let q = unsafe { System.realloc(p, l, n) };
            if !q.is_null() {
                LIVE.fetch_sub(l.size(), Relaxed);
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
    fn measure(name: &str, state: EvaluatedState) {
        let bound_start = Instant::now();
        let bound_cpu_start = cpu();
        let bound = state.ranking_index_bound().unwrap();
        let bound_cpu = cpu() - bound_cpu_start;
        let bound_seconds = bound_start.elapsed().as_secs_f64();
        let base = LIVE.load(Relaxed);
        PEAK.store(base, Relaxed);
        let start = Instant::now();
        let c = cpu();
        state.ensure_ranking_index().unwrap();
        let index_cpu = cpu() - c;
        let index_seconds = start.elapsed().as_secs_f64();
        let retained = LIVE.load(Relaxed) - base;
        let peak = PEAK.load(Relaxed) - base;
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
        assert!(modeled_bytes >= peak as u64);
        assert!(modeled_units + 1_000_000 < policy.limits.units);

        let base_hash = LIVE.load(Relaxed);
        PEAK.store(base_hash, Relaxed);
        let start = Instant::now();
        let c = cpu();
        let (binding, bytes) = state.ranking_source_binding(1024 * 1024 * 1024).unwrap();
        let hash_cpu = cpu() - c;
        let hash_seconds = start.elapsed().as_secs_f64();
        let hash_peak = PEAK.load(Relaxed) - base_hash;
        println!(
            "{}",
            json!({"name":name,"count_cpu_seconds":bound_cpu,"count_seconds":bound_seconds,"modeled_bytes":modeled_bytes,"modeled_units":modeled_units,"retained_heap_bytes":retained,"peak_heap_bytes":peak,
            "index_cpu_seconds":index_cpu,"index_seconds":index_seconds,"entries":entries,"bound":bound,
            "source_bytes":bytes,"source_binding":binding,"hash_cpu_seconds":hash_cpu,"hash_seconds":hash_seconds,
            "hash_peak_heap_bytes":hash_peak,"records":state.ranking_source_records().unwrap()})
        );
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
        let mut saved: Value =
            serde_json::from_slice(&state.checkpoint("synthetic").unwrap()).unwrap();
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
                trust
                    .push(json!({"actor":actor,"subject":subject,"scope":scope,"values":["heed"]}));
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
    pub fn run() {
        let args: Vec<_> = std::env::args().collect();
        assert_eq!(
            args.len(),
            3,
            "usage: ranking_setup_measurement trusted-core.json trusted-nodes.ndjson"
        );
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
        let state =
            EvaluatedState::restore_host_result_checkpoint(&bytes, &binding, records).unwrap();
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
}
fn main() {
    #[cfg(unix)]
    measurement::run();
}
