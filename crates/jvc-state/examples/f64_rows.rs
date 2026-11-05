#[path = "../tests/support/f64_rows.rs"]
mod rows;
fn main() {
    println!("{}", rows::vectors());
}
