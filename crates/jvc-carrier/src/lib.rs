//! Canonical Git carriers for authenticated Jbovlacku records.
mod native;
mod snapshot;
pub use jvc_core::{Error, Result};
pub use native::{
    ReadLimits, read_directory, read_directory_with_limits, read_git_tree,
    read_git_tree_with_limits, validate_checkout, validate_checkout_with_limits, write_directory,
};
pub use snapshot::*;
