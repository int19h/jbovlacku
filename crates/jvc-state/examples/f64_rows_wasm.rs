#[path = "../tests/support/f64_rows.rs"]
mod rows;
use std::sync::Mutex;
static RESULT: Mutex<Vec<u8>> = Mutex::new(Vec::new());
#[unsafe(no_mangle)]
pub extern "C" fn prepare_rows() -> usize {
    let mut result = RESULT.lock().unwrap();
    *result = serde_json::to_vec(&rows::vectors()).unwrap();
    result.len()
}
#[unsafe(no_mangle)]
pub extern "C" fn result_pointer() -> *const u8 {
    RESULT.lock().unwrap().as_ptr()
}
