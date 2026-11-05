#[path = "../tests/support/f64_kernel.rs"]
mod support;
use std::sync::Mutex;
static OUTPUT: Mutex<Vec<u8>> = Mutex::new(Vec::new());
#[no_mangle]
pub extern "C" fn run_suite() -> usize {
    let mut output = OUTPUT.lock().unwrap();
    *output = support::encoded_suite().into_bytes();
    output.len()
}
#[no_mangle]
pub extern "C" fn output_pointer() -> *const u8 {
    OUTPUT.lock().unwrap().as_ptr()
}
