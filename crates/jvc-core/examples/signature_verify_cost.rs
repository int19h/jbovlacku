#[path = "support/signature_verify_cost.rs"]
mod support;

fn main() {
    let mut args = std::env::args().skip(1);
    let source = std::fs::read(args.next().expect("provide an events JSON array")).unwrap();
    let cached = match args.next().as_deref() {
        Some("cached") => true,
        Some("fresh") => false,
        _ => panic!("provide cached or fresh"),
    };
    let events: Vec<String> = serde_json::from_slice(&source).unwrap();
    let started = std::time::Instant::now();
    let digest = support::verify(&events, cached).unwrap();
    println!(
        "{}",
        serde_json::json!({"records":events.len(),"cached":cached,
            "milliseconds":started.elapsed().as_secs_f64()*1000.0,"sha256":digest})
    );
}
