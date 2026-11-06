//! Measure trusted host checkpoints and synthetic index shapes. No signing or writes.
#[cfg(unix)]
#[path = "support/setup_measurement.rs"]
mod measurement;
fn main() {
    #[cfg(unix)]
    measurement::run();
}
