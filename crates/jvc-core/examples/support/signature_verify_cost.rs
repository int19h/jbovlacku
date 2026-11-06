use jvc_core::{EnvelopeVerifier, Result, verify_envelope};
use sha2::{Digest, Sha256};

pub fn verify(events: &[String], cached: bool) -> Result<String> {
    let mut verifier = EnvelopeVerifier::default();
    let mut digest = Sha256::new();
    for bytes in events {
        let event = if cached {
            verifier.verify(bytes.as_bytes())?
        } else {
            verify_envelope(bytes.as_bytes())?
        };
        digest.update(event.canonical_envelope()?);
        digest.update(b"\n");
    }
    Ok(hex::encode(digest.finalize()))
}
