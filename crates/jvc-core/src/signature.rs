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

/// Apply the specified uncofactored equation after point and scalar checks.
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
    point(signature[..32].try_into().unwrap(), false)?;
    let scalar: [u8; 32] = signature[32..].try_into().unwrap();
    if !bool::from(Scalar::from_canonical_bytes(scalar).is_some()) {
        return Err(crypto_error("signature scalar is not below L"));
    }
    // Dalek computes R = [S]B - [k]A. Its strict method also rejects identity R.
    public_key
        .key
        .verify(message, &Signature::from_bytes(signature))
        .map_err(|_| crypto_error("Ed25519 equation failed"))
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
