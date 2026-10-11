mod support;
use std::time::Instant;
fn main() {
    let args: Vec<_> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("oracle") {
        assert!(support::tiny_oracle_suite());
        println!("oracle passed");
        return;
    }
    let hostile = args.get(1).map(String::as_str) == Some("hostile");
    let n = args.get(2).expect("actor count").parse().unwrap();
    let work = args.get(3).expect("work budget").parse().unwrap();
    let start = Instant::now();
    let result = if args.get(1).map(String::as_str) == Some("weighted") {
        support::measure_weighted(n, work)
    } else {
        support::measure(hostile, n, work)
    };
    match result {
        Ok(m) => println!("actors={} edges={} work={} stages={} exact={} peak_prefixes={} bits={} comparisons={} strict={} ties={} digest={:016x} milliseconds={:.3}", m.actors, m.edges, m.completed_work, m.complete_stages, m.exact, m.peak_prefixes, m.arithmetic_bits, m.comparisons, m.strict, m.ties, m.digest, start.elapsed().as_secs_f64()*1000.0),
        Err(error) => { eprintln!("unavailable: {error}"); std::process::exit(2); }
    }
}
