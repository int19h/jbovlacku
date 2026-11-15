use serde::Deserialize;
use serde_json::{Value, json};
use std::alloc::{GlobalAlloc, Layout, System};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};

static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

struct Counting;

fn acquired(size: usize) {
    let live = LIVE.fetch_add(size, Ordering::Relaxed) + size;
    PEAK.fetch_max(live, Ordering::Relaxed);
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() {
            acquired(layout.size());
        }
        pointer
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc_zeroed(layout) };
        if !pointer.is_null() {
            acquired(layout.size());
        }
        pointer
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
        unsafe { System.dealloc(pointer, layout) }
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        let pointer = unsafe { System.realloc(pointer, layout, size) };
        if !pointer.is_null() {
            LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
            acquired(size);
        }
        pointer
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

#[derive(Deserialize)]
#[serde(default, deny_unknown_fields)]
struct LimitsWire {
    #[serde(default)]
    events: Option<usize>,
    #[serde(default)]
    traversal: Option<usize>,
    claim_depth: usize,
}

impl Default for LimitsWire {
    fn default() -> Self {
        let defaults = jvc_state::Limits::default();
        Self {
            events: defaults.events,
            traversal: defaults.traversal,
            claim_depth: defaults.claim_depth,
        }
    }
}

impl From<LimitsWire> for jvc_state::Limits {
    fn from(wire: LimitsWire) -> Self {
        Self {
            events: wire.events,
            traversal: wire.traversal,
            claim_depth: wire.claim_depth,
        }
    }
}

#[derive(Deserialize)]
struct Wire {
    events: Vec<String>,
    bodies: BTreeMap<String, String>,
    selected_view: String,
    import_selections: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    overlay: Option<Value>,
    #[serde(default)]
    limits: LimitsWire,
}

fn live() -> usize {
    LIVE.load(Ordering::Relaxed)
}

fn stage(name: &str, records: usize) {
    println!(
        "{}",
        json!({
            "stage": name,
            "records": records,
            "live_requested": live(),
            "peak_requested": PEAK.load(Ordering::Relaxed),
        })
    );
}

fn main() {
    let input = std::env::args()
        .nth(1)
        .expect("usage: record_arena_memory INPUT");
    let bytes = std::fs::read(input).unwrap();
    let Wire {
        events,
        mut bodies,
        selected_view,
        import_selections,
        overlay,
        limits,
    } = serde_json::from_slice(&bytes).unwrap();
    drop(bytes);
    let options = jvc_state::EvaluationOptions {
        selected_view,
        import_selections,
        overlay,
        limits: limits.into(),
    };
    let mut prepared = jvc_state::PreparedEvaluationInput::new(options);
    let records = events.len();
    let mut verifier = jvc_core::EnvelopeVerifier::default();
    for raw in events {
        let event = verifier.verify(raw.as_bytes()).unwrap();
        let body = bodies.remove(event.id());
        prepared.add_record(&event, body.as_ref().map(String::as_bytes));
    }
    drop(bodies);
    drop(verifier);
    prepared.finish_load();
    stage("prepared", records);
    println!(
        "{}",
        json!({
            "record_arena_bytes": prepared.record_arena_bytes(),
            "record_node_string_bytes": prepared.record_node_string_bytes(),
        })
    );
    prepared
        .into_state()
        .allocation_stages(|name| stage(name, records));
}
