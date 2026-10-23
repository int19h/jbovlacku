use crate::{Error, Result, canonical_value, parse_json, parse_stored_json, schema, signature};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use unicode_normalization::UnicodeNormalization;

pub const MAX_HEADER_BYTES: usize = 16 * 1024;
pub const MAX_ENVELOPE_BYTES: usize = 20 * 1024;
pub const MAX_BODY_BYTES: usize = 256 * 1024;
pub const EVENT_DOMAIN: &[u8] = b"jbovlacku-event-v1\n";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContentDescriptor {
    pub hash: String,
    pub bytes: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Header {
    pub version: u8,
    pub issuer: String,
    pub previous: Vec<String>,
    pub nonce: String,
    pub action: Value,
    pub content: Option<ContentDescriptor>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub id: String,
    pub header: Header,
    pub signature: String,
}

/// A record whose header, identifier, and signature satisfy the wire rules.
#[derive(Clone, Debug, Serialize)]
#[serde(transparent)]
pub struct VerifiedEnvelope {
    envelope: Envelope,
    #[serde(skip)]
    canonical_header: Vec<u8>,
    #[serde(skip)]
    signature_bytes: Vec<u8>,
}
impl VerifiedEnvelope {
    pub fn envelope(&self) -> &Envelope {
        &self.envelope
    }
    pub fn id(&self) -> &str {
        &self.envelope.id
    }
    pub fn header(&self) -> &Header {
        &self.envelope.header
    }
    pub fn canonical_header(&self) -> &[u8] {
        &self.canonical_header
    }
    pub fn signature_bytes(&self) -> &[u8] {
        &self.signature_bytes
    }
    pub fn canonical_envelope(&self) -> Result<Vec<u8>> {
        canonical_value(&serde_json::to_value(&self.envelope).unwrap())
    }
    pub fn into_envelope(self) -> Envelope {
        self.envelope
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "availability", rename_all = "snake_case")]
pub enum BodyAvailability {
    Absent,
    Missing,
    Valid { body: Value },
    Invalid { reason: String },
}

pub fn valid_id(value: &str, prefix: &str) -> bool {
    value.strip_prefix(prefix).is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
pub fn hash_id(prefix: &str, domain: &[u8], bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(domain);
    h.update(bytes);
    format!("{prefix}{}", hex::encode(h.finalize()))
}
pub fn sorted_ids(values: &[String], prefix: &str, max: usize) -> Result<()> {
    if values.len() > max
        || values.iter().any(|v| !valid_id(v, prefix))
        || values.windows(2).any(|p| p[0] >= p[1])
    {
        return Err(Error::new(
            "identifier",
            "identifiers must be valid, sorted, unique, and within their limit",
        ));
    }
    Ok(())
}
pub fn validate_header(header: &Header) -> Result<Vec<u8>> {
    validate_header_with_key_check(header, signature::validate_public_key)
}
fn validate_header_with_key_check(
    header: &Header,
    validate_key: impl FnOnce(&[u8; 32]) -> Result<()>,
) -> Result<Vec<u8>> {
    if header.version != 1 {
        return Err(Error::new("version", "header version must be 1"));
    }
    if !valid_id(&header.issuer, "ed25519:") {
        return Err(Error::new(
            "issuer",
            "issuer must be a lowercase Ed25519 identity",
        ));
    }
    validate_key(
        &hex::decode(&header.issuer[8..])
            .unwrap()
            .try_into()
            .unwrap(),
    )?;
    if header.nonce.len() != 32
        || !header
            .nonce
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(Error::new(
            "nonce",
            "nonce must contain 32 lowercase hexadecimal digits",
        ));
    }
    sorted_ids(&header.previous, "jve1:", 64)?;
    if let Some(c) = &header.content {
        if !valid_id(&c.hash, "sha256:") || c.bytes > MAX_BODY_BYTES as u64 {
            return Err(Error::new(
                "content",
                "content descriptor exceeds the body rules",
            ));
        }
    }
    let bytes = canonical_value(&serde_json::to_value(header).unwrap())?;
    if bytes.len() > MAX_HEADER_BYTES {
        return Err(Error::new("size", "canonical header exceeds 16 KiB"));
    }
    Ok(bytes)
}
pub fn event_id(header: &Header) -> Result<String> {
    Ok(hash_id("jve1:", EVENT_DOMAIN, &validate_header(header)?))
}
pub fn event_message(header: &Header) -> Result<Vec<u8>> {
    let mut m = EVENT_DOMAIN.to_vec();
    m.extend(validate_header(header)?);
    Ok(m)
}
pub fn word_id(word: &Value) -> Result<String> {
    schema::validate_word(word)?;
    Ok(hash_id(
        "jvw1:",
        b"jbovlacku-word-v1\n",
        &canonical_value(word)?,
    ))
}
pub fn rafsi_pair_id(word: &str, rafsi: &str) -> Result<String> {
    if !valid_id(word, "jvw1:") {
        return Err(Error::new("word", "word identifier is invalid"));
    }
    validate_spelling(rafsi, 64)?;
    Ok(hash_id(
        "jvr1:",
        b"jbovlacku-rafsi-v1\n",
        &canonical_value(&serde_json::json!({"word":word,"rafsi":rafsi}))?,
    ))
}
pub fn validate_spelling(s: &str, max: usize) -> Result<()> {
    if s.is_empty()
        || s.len() > max
        || s.trim() != s
        || s.chars().any(char::is_control)
        || s.nfc().collect::<String>() != s
    {
        return Err(Error::new(
            "spelling",
            "spelling must be nonempty NFC text without controls or edge whitespace",
        ));
    }
    Ok(())
}
pub fn body_descriptor(bytes: &[u8]) -> Result<ContentDescriptor> {
    let canonical = crate::canonicalize_json(bytes)?;
    if canonical.len() > MAX_BODY_BYTES {
        return Err(Error::new("size", "canonical body exceeds 256 KiB"));
    }
    Ok(ContentDescriptor {
        hash: hash_id("sha256:", b"", &canonical),
        bytes: canonical.len() as u64,
    })
}
const VERIFIED_KEY_CACHE_LIMIT: usize = 1024;
/// A bounded, local cache of public keys that passed the static profile checks.
/// Every record still checks its signature point, scalar, and equation.
#[derive(Default)]
pub struct EnvelopeVerifier {
    keys: BTreeMap<[u8; 32], signature::ValidatedPublicKey>,
}
impl EnvelopeVerifier {
    pub fn verify(&mut self, bytes: &[u8]) -> Result<VerifiedEnvelope> {
        if bytes.len() > MAX_ENVELOPE_BYTES {
            return Err(Error::new("size", "complete envelope exceeds 20 KiB"));
        }
        self.verify_value(parse_json(bytes)?)
    }
    fn public_key(&mut self, bytes: &[u8; 32]) -> Result<signature::ValidatedPublicKey> {
        if let Some(key) = self.keys.get(bytes) {
            return Ok(key.clone());
        }
        let key = signature::ValidatedPublicKey::new(bytes)?;
        if self.keys.len() < VERIFIED_KEY_CACHE_LIMIT {
            self.keys.insert(*bytes, key.clone());
        }
        Ok(key)
    }
    fn verify_value(&mut self, value: Value) -> Result<VerifiedEnvelope> {
        // Option fields still require an explicit null on the wire.
        let h = value
            .get("header")
            .and_then(Value::as_object)
            .ok_or_else(|| Error::new("header", "header must be an object"))?;
        schema::fields(
            &Value::Object(h.clone()),
            &[
                "version", "issuer", "previous", "nonce", "action", "content",
            ],
        )?;
        if let Some(c) = h.get("content").filter(|c| !c.is_null()) {
            schema::fields(c, &["hash", "bytes"])?;
        }
        let envelope: Envelope =
            serde_json::from_value(value).map_err(|e| Error::new("envelope", e.to_string()))?;
        let mut public_key = None;
        let canonical_header = validate_header_with_key_check(&envelope.header, |bytes| {
            public_key = Some(self.public_key(bytes)?);
            Ok(())
        })?;
        if envelope.id != hash_id("jve1:", EVENT_DOMAIN, &canonical_header) {
            return Err(Error::new(
                "event_id",
                "event identifier does not match its header",
            ));
        }
        let mut message = EVENT_DOMAIN.to_vec();
        message.extend(&canonical_header);
        let signature_bytes = signature::verify_sshsig(
            &envelope.header.issuer,
            &message,
            &envelope.signature,
            &public_key.unwrap(),
        )?;
        let size = canonical_value(&serde_json::to_value(&envelope).unwrap())?.len();
        if size > MAX_ENVELOPE_BYTES {
            return Err(Error::new("size", "complete envelope exceeds 20 KiB"));
        }
        Ok(VerifiedEnvelope {
            envelope,
            canonical_header,
            signature_bytes,
        })
    }
}
fn verify_value(value: Value) -> Result<VerifiedEnvelope> {
    EnvelopeVerifier::default().verify_value(value)
}
/// The 20 KiB raw transport cap is local read policy. Canonical envelopes also
/// have the format's 20 KiB limit; extra transport whitespace uses this local cap.
pub fn verify_envelope(bytes: &[u8]) -> Result<VerifiedEnvelope> {
    EnvelopeVerifier::default().verify(bytes)
}
pub fn verify_stored_envelope(bytes: &[u8]) -> Result<VerifiedEnvelope> {
    if bytes.len() > MAX_ENVELOPE_BYTES {
        return Err(Error::new("size", "complete envelope exceeds 20 KiB"));
    }
    verify_value(parse_stored_json(bytes)?)
}
pub fn sign_header(seed: &[u8; 32], header: Header) -> Result<VerifiedEnvelope> {
    if header.issuer != signature::identity_from_seed(seed) {
        return Err(Error::new(
            "issuer",
            "signing key does not match the header issuer",
        ));
    }
    let id = event_id(&header)?;
    let signature = signature::sign_sshsig(seed, &event_message(&header)?)?;
    verify_value(
        serde_json::to_value(Envelope {
            id,
            header,
            signature,
        })
        .unwrap(),
    )
}
pub fn inspect_body(event: &VerifiedEnvelope, bytes: Option<&[u8]>) -> BodyAvailability {
    let Some(descriptor) = &event.header().content else {
        return if bytes.is_none() {
            BodyAvailability::Absent
        } else {
            BodyAvailability::Invalid {
                reason: "header has no content descriptor".into(),
            }
        };
    };
    let Some(bytes) = bytes else {
        return BodyAvailability::Missing;
    };
    let result = (|| {
        if bytes.len() > MAX_BODY_BYTES || bytes.len() as u64 != descriptor.bytes {
            return Err(Error::new(
                "body_length",
                "body length does not match the descriptor",
            ));
        }
        let body = parse_stored_json(bytes)?;
        if hash_id("sha256:", b"", bytes) != descriptor.hash {
            return Err(Error::new(
                "body_hash",
                "body hash does not match the descriptor",
            ));
        }
        schema::validate_parsed_body(event.header(), &body)?;
        Ok(body)
    })();
    match result {
        Ok(body) => BodyAvailability::Valid { body },
        Err(e) => BodyAvailability::Invalid {
            reason: e.to_string(),
        },
    }
}

/// Export one canonical envelope per line in event-ID order.
pub fn export_jsonl(events: &[VerifiedEnvelope]) -> Result<Vec<u8>> {
    let mut selected = std::collections::BTreeMap::<&str, &VerifiedEnvelope>::new();
    for event in events {
        if let Some(old) = selected.get(event.id()) {
            if old.canonical_header() != event.canonical_header() {
                return Err(Error::new(
                    "collision",
                    "different headers share one event identifier",
                ));
            }
            if old.signature_bytes() <= event.signature_bytes() {
                continue;
            }
        }
        selected.insert(event.id(), event);
    }
    let mut out = Vec::new();
    for event in selected.values() {
        out.extend(event.canonical_envelope()?);
        out.push(b'\n');
    }
    Ok(out)
}
pub fn import_jsonl(bytes: &[u8]) -> Result<Vec<VerifiedEnvelope>> {
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    let mut events = Vec::new();
    for line in bytes
        .strip_suffix(b"\n")
        .unwrap_or(bytes)
        .split(|b| *b == b'\n')
    {
        events.push(verify_stored_envelope(line)?);
    }
    let export = export_jsonl(&events)?;
    export
        .strip_suffix(b"\n")
        .unwrap_or(&export)
        .split(|b| *b == b'\n')
        .map(verify_stored_envelope)
        .collect()
}

/// Return the exact Ed25519 message inside SSHSIG for an admitted header.
pub fn sshsig_signing_bytes(header: &Header) -> Result<Vec<u8>> {
    signature::signing_bytes(&event_message(header)?)
}

/// Admit a signature from an external signer after applying every header and signature rule.
pub fn envelope_from_signature(
    header: Header,
    raw_signature: &[u8; 64],
) -> Result<VerifiedEnvelope> {
    let id = event_id(&header)?;
    let signature = signature::wrap_signature(&header.issuer, raw_signature)?;
    verify_value(
        serde_json::to_value(Envelope {
            id,
            header,
            signature,
        })
        .unwrap(),
    )
}
