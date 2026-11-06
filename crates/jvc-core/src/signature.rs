use crate::{Error, Result};
use base64::{Engine, engine::general_purpose::STANDARD};
use curve25519_dalek::{edwards::CompressedEdwardsY, scalar::Scalar, traits::IsIdentity};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use ssh_encoding::{Decode, Encode, Reader};
use ssh_key::{Algorithm, HashAlg, SshSig};

const NAMESPACE: &str = "jbovlacku-event-v1";
fn crypto_error(message: impl Into<String>) -> Error {
    Error::new("signature", message)
}

fn point(bytes: &[u8; 32], public: bool) -> Result<()> {
    let p = CompressedEdwardsY(*bytes)
        .decompress()
        .ok_or_else(|| crypto_error("point encoding is invalid"))?;
    if p.compress().to_bytes() != *bytes || !p.is_torsion_free() || (public && p.is_identity()) {
        return Err(crypto_error(
            "point does not satisfy the canonical prime-order profile",
        ));
    }
    Ok(())
}
pub(crate) fn validate_public_key(bytes: &[u8; 32]) -> Result<()> {
    point(bytes, true)
}
/// Construction proves the static public-point requirements.
#[derive(Clone)]
pub(crate) struct ValidatedPublicKey {
    key: VerifyingKey,
}
impl ValidatedPublicKey {
    pub(crate) fn new(bytes: &[u8; 32]) -> Result<Self> {
        validate_public_key(bytes)?;
        Ok(Self {
            key: VerifyingKey::from_bytes(bytes).map_err(|e| crypto_error(e.to_string()))?,
        })
    }
}

/// Apply the specified prime-order profile and uncofactored equation.
pub fn verify_ed25519_profile(
    public_key: &[u8; 32],
    message: &[u8],
    signature: &[u8; 64],
) -> Result<()> {
    let key = ValidatedPublicKey::new(public_key)?;
    verify_with_public_key(&key, message, signature)
}
fn verify_with_public_key(
    public_key: &ValidatedPublicKey,
    message: &[u8],
    signature: &[u8; 64],
) -> Result<()> {
    // Dalek 2.2.0 raw_verify compares the supplied compressed R bytes with
    // compress([S]B - [k]A), without cofactor multiplication. It also checks
    // canonical S (legacy_compatibility is disabled). Since this key and B
    // have prime order, success proves R's canonical encoding and membership
    // in the prime-order subgroup, including the permitted identity R.
    if public_key
        .key
        .verify(message, &Signature::from_bytes(signature))
        .is_ok()
    {
        return Ok(());
    }
    // Preserve the existing error precedence when the equation fails.
    point(signature[..32].try_into().unwrap(), false)?;
    let scalar: [u8; 32] = signature[32..].try_into().unwrap();
    if !bool::from(Scalar::from_canonical_bytes(scalar).is_some()) {
        return Err(crypto_error("signature scalar is not below L"));
    }
    Err(crypto_error("Ed25519 equation failed"))
}

pub fn identity_from_seed(seed: &[u8; 32]) -> String {
    format!(
        "ed25519:{}",
        hex::encode(
            ed25519_dalek::SigningKey::from_bytes(seed)
                .verifying_key()
                .as_bytes()
        )
    )
}
fn encode(sig: &SshSig) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    sig.encode(&mut bytes)
        .map_err(|e| crypto_error(e.to_string()))?;
    Ok(bytes)
}
fn decode(bytes: &[u8]) -> Result<SshSig> {
    let mut reader = bytes;
    let sig = SshSig::decode(&mut reader).map_err(|e| crypto_error(e.to_string()))?;
    if !reader.is_finished() || encode(&sig)? != bytes {
        return Err(crypto_error("SSHSIG has trailing or noncanonical bytes"));
    }
    Ok(sig)
}
pub(crate) fn sign_sshsig(seed: &[u8; 32], message: &[u8]) -> Result<String> {
    let key =
        ssh_key::private::KeypairData::Ed25519(ssh_key::private::Ed25519Keypair::from_seed(seed));
    let key = ssh_key::PrivateKey::new(key, "disposable prototype key")
        .map_err(|e| crypto_error(e.to_string()))?;
    let sig = SshSig::sign(&key, NAMESPACE, HashAlg::Sha512, message)
        .map_err(|e| crypto_error(e.to_string()))?;
    Ok(STANDARD.encode(encode(&sig)?))
}
pub(crate) fn verify_sshsig(
    issuer: &str,
    message: &[u8],
    encoded: &str,
    validated_key: &ValidatedPublicKey,
) -> Result<Vec<u8>> {
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| crypto_error("signature base64 is invalid"))?;
    if STANDARD.encode(&bytes) != encoded {
        return Err(crypto_error(
            "signature base64 is not padded canonical base64",
        ));
    }
    let sig = decode(&bytes)?;
    if sig.version() != 1
        || sig.namespace() != NAMESPACE
        || !sig.reserved().is_empty()
        || sig.hash_alg() != HashAlg::Sha512
        || sig.signature().algorithm() != Algorithm::Ed25519
    {
        return Err(crypto_error("SSHSIG fields do not match version 1"));
    }
    let public = sig
        .public_key()
        .ed25519()
        .ok_or_else(|| crypto_error("SSHSIG public key is not ssh-ed25519"))?;
    let public_bytes: &[u8; 32] = public.as_ref();
    if format!("ed25519:{}", hex::encode(public_bytes)) != issuer
        || validated_key.key.as_bytes() != public_bytes
    {
        return Err(crypto_error("SSHSIG public key differs from the issuer"));
    }
    let signature: &[u8; 64] = sig
        .signature_bytes()
        .try_into()
        .map_err(|_| crypto_error("Ed25519 signature has an invalid length"))?;
    let signed_data = SshSig::signed_data(NAMESPACE, HashAlg::Sha512, message)
        .map_err(|e| crypto_error(e.to_string()))?;
    verify_with_public_key(validated_key, &signed_data, signature)?;
    Ok(bytes)
}
pub fn sshsig_armor(encoded: &str) -> Result<String> {
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|e| crypto_error(e.to_string()))?;
    if STANDARD.encode(&bytes) != encoded {
        return Err(crypto_error("signature base64 is not canonical"));
    }
    decode(&bytes)?
        .to_pem(ssh_key::LineEnding::LF)
        .map_err(|e| crypto_error(e.to_string()))
}
pub fn sshsig_from_armor(armor: &str) -> Result<String> {
    let sig = SshSig::from_pem(armor).map_err(|e| crypto_error(e.to_string()))?;
    Ok(STANDARD.encode(encode(&sig)?))
}

pub(crate) fn signing_bytes(message: &[u8]) -> Result<Vec<u8>> {
    SshSig::signed_data(NAMESPACE, HashAlg::Sha512, message)
        .map_err(|e| crypto_error(e.to_string()))
}
pub(crate) fn wrap_signature(issuer: &str, raw_signature: &[u8; 64]) -> Result<String> {
    let bytes: [u8; 32] = hex::decode(&issuer[8..])
        .map_err(|e| crypto_error(e.to_string()))?
        .try_into()
        .map_err(|_| crypto_error("issuer key length is invalid"))?;
    let public = ssh_key::public::KeyData::Ed25519(ssh_key::public::Ed25519PublicKey(bytes));
    let raw = ssh_key::Signature::new(Algorithm::Ed25519, raw_signature.to_vec())
        .map_err(|e| crypto_error(e.to_string()))?;
    let sshsig = SshSig::new(public, NAMESPACE, HashAlg::Sha512, raw)
        .map_err(|e| crypto_error(e.to_string()))?;
    Ok(STANDARD.encode(encode(&sshsig)?))
}

#[cfg(test)]
mod profile_tests {
    use super::*;

    // Retain the old order as an independent error and acceptance control.
    fn previous(public: &[u8; 32], message: &[u8], signature: &[u8; 64]) -> Result<()> {
        let key = ValidatedPublicKey::new(public)?;
        point(signature[..32].try_into().unwrap(), false)?;
        let scalar = signature[32..].try_into().unwrap();
        if !bool::from(Scalar::from_canonical_bytes(scalar).is_some()) {
            return Err(crypto_error("signature scalar is not below L"));
        }
        key.key
            .verify(message, &Signature::from_bytes(signature))
            .map_err(|_| crypto_error("Ed25519 equation failed"))
    }

    #[test]
    fn corpus_acceptance_and_errors_match_the_previous_order() {
        let corpus: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/corpus.json")).unwrap();
        let mut cases = 0;
        for case in corpus["cases"].as_array().unwrap() {
            if case["op"] != "ed25519" {
                continue;
            }
            let public = hex::decode(case["public"].as_str().unwrap()).unwrap();
            let message = hex::decode(case["message"].as_str().unwrap()).unwrap();
            let signature = hex::decode(case["signature"].as_str().unwrap()).unwrap();
            let public: [u8; 32] = public.try_into().unwrap();
            let signature: [u8; 64] = signature.try_into().unwrap();
            assert_eq!(
                verify_ed25519_profile(&public, &message, &signature),
                previous(&public, &message, &signature),
                "{}",
                case["name"]
            );
            let expected_message = match case["name"].as_str().unwrap() {
                "negative-zero-r"
                | "low-order-r-1"
                | "mixed-order-r-1"
                | "reject-identity-key"
                | "noncanonical-identity-r" => {
                    Some("point does not satisfy the canonical prime-order profile")
                }
                "scalar-equals-L" => Some("signature scalar is not below L"),
                "invalid-equation" => Some("Ed25519 equation failed"),
                _ => None,
            };
            if let Some(expected) = expected_message {
                assert_eq!(
                    verify_ed25519_profile(&public, &message, &signature),
                    Err(Error::new("signature", expected)),
                    "{}",
                    case["name"]
                );
            }
            if case["name"] == "rfc8032-empty-message" {
                // S + L satisfies the reduced equation but must stay invalid.
                let order =
                    hex::decode("edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010")
                        .unwrap();
                let mut malleable = signature;
                let mut carry = 0u16;
                for (s, l) in malleable[32..].iter_mut().zip(order) {
                    let sum = *s as u16 + l as u16 + carry;
                    *s = sum as u8;
                    carry = sum >> 8;
                }
                assert_eq!(carry, 0);
                let expected = Err(Error::new("signature", "signature scalar is not below L"));
                assert_eq!(previous(&public, &message, &malleable), expected);
                assert_eq!(
                    verify_ed25519_profile(&public, &message, &malleable),
                    expected
                );
            }
            // R errors precede scalar errors, and key errors precede both.
            let mut invalid_scalar = signature;
            invalid_scalar[32..].fill(255);
            assert_eq!(
                verify_ed25519_profile(&public, &message, &invalid_scalar),
                previous(&public, &message, &invalid_scalar),
                "{} with noncanonical S",
                case["name"]
            );
            cases += 1;
        }
        assert!(cases >= 35);
    }
}
