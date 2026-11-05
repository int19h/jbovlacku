#[path = "../tests/support/f64_kernel.rs"]
mod support;
fn main() {
    print!("{}", support::encoded_suite());
}
