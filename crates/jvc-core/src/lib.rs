//! Signed Jbovlacku records with separate content and action results.
mod definition;
mod json;
mod record;
mod schema;
mod signature;
mod wasm;

pub use definition::{interpret_definition, omit_definition_defaults};
pub use json::{
    MAX_DEPTH, MAX_SAFE_INTEGER, canonical_value, canonicalize_json, parse_json, parse_stored_json,
    parse_transport_json,
};
pub use record::*;
pub use schema::{validate_action, validate_body, validate_scope};
use serde::{Deserialize, Serialize};
pub use signature::{identity_from_seed, sshsig_armor, sshsig_from_armor, verify_ed25519_profile};
use std::fmt;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Error {
    pub code: String,
    pub message: String,
}
impl Error {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for Error {}
