mod support;
use std::sync::Mutex;
static RESULT: Mutex<[u64; 12]> = Mutex::new([0; 12]);
#[no_mangle]
pub extern "C" fn run_oracle_suite() -> u32 {
    u32::from(support::tiny_oracle_suite())
}
#[no_mangle]
pub extern "C" fn benchmark(hostile: u32, n: u32, work: u32) -> u32 {
    let result = if hostile == 2 {
        support::measure_weighted(n as usize, u64::from(work))
    } else {
        support::measure(hostile != 0, n as usize, u64::from(work))
    };
    match result {
        Ok(m) => {
            *RESULT.lock().unwrap() = [
                m.actors as u64,
                m.edges as u64,
                m.completed_work,
                m.complete_stages as u64,
                u64::from(m.exact),
                m.peak_prefixes as u64,
                m.arithmetic_bits,
                m.comparisons as u64,
                m.strict as u64,
                m.ties as u64,
                m.digest,
                0,
            ];
            1
        }
        Err(_) => 0,
    }
}
#[no_mangle]
pub extern "C" fn metric(index: u32) -> u64 {
    RESULT
        .lock()
        .unwrap()
        .get(index as usize)
        .copied()
        .unwrap_or(0)
}
