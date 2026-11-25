use crate::{Error, Result, canonical_value, parse_json, parse_stored_json, schema, signature};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use unicode_normalization::{
    IsNormalized, UnicodeNormalization, char::canonical_combining_class, is_nfc, is_nfc_quick,
};

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
/// Hash a bounded byte stream without retaining its source bytes.
pub struct HashWriter {
    hash: Sha256,
    bytes: usize,
    limit: usize,
}
impl HashWriter {
    pub fn new(domain: &[u8], limit: usize) -> Self {
        let mut hash = Sha256::new();
        hash.update(domain);
        Self {
            hash,
            bytes: 0,
            limit,
        }
    }
    pub fn finish(self, prefix: &str) -> (String, usize) {
        (
            format!("{prefix}{}", hex::encode(self.hash.finalize())),
            self.bytes,
        )
    }
}
impl std::io::Write for HashWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > self.limit.saturating_sub(self.bytes) {
            return Err(std::io::Error::other("hash source byte limit"));
        }
        self.hash.update(bytes);
        self.bytes += bytes.len();
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
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
    let mut identity = word.clone();
    identity["spelling"] = Value::String(identity_spelling(word["spelling"].as_str().unwrap())?);
    Ok(hash_id(
        "jvw1:",
        b"jbovlacku-word-v1\n",
        &canonical_value(&identity)?,
    ))
}
/// Canonical word ID for a Lojban spelling without parsing or allocating a JSON object.
pub fn word_id_for_lojban_spelling(spelling: &str) -> Result<String> {
    validate_word_spelling(spelling)?;
    let identity = identity_spelling(spelling)?;
    let encoded = canonical_value(&Value::String(identity))?;
    let mut bytes = Vec::with_capacity(30 + encoded.len());
    bytes.extend_from_slice(br#"{"language":"jbo","spelling":"#);
    bytes.extend_from_slice(&encoded);
    bytes.push(b'}');
    Ok(hash_id("jvw1:", b"jbovlacku-word-v1\n", &bytes))
}
pub(crate) fn validate_word_spelling(spelling: &str) -> Result<()> {
    validate_spelling(spelling, 256)?;
    validate_acute_accents(spelling)
}
fn identity_spelling(spelling: &str) -> Result<String> {
    let identity = strip_acute_accents(spelling);
    validate_spelling(&identity, 256)?;
    Ok(identity)
}
/// Check both forms of a word spelling without computing its ID.
pub fn valid_word_id_spelling(spelling: &str) -> bool {
    validate_spelling(spelling, 256).is_ok()
        && match acute_accents(spelling) {
            Ok(true) => identity_spelling(spelling).is_ok(),
            Ok(false) => true,
            Err(_) => false,
        }
}
fn is_nfc_starter(c: char) -> bool {
    canonical_combining_class(c) == 0 && is_nfc_quick(std::iter::once(c)) == IsNormalized::Yes
}
/// Conservative single-UTF-16-unit spelling characters whose concatenation is
/// already NFC, satisfies the acute rule, and strips to a valid NFC identity
/// spelling without growing in UTF-8 byte length.
pub fn qualifies_safe_bmp_spelling_char(c: char) -> bool {
    if !is_nfc_starter(c) || c.is_control() || c.is_whitespace() {
        return false;
    }
    let mut buf = [0u8; 4];
    let s = c.encode_utf8(&mut buf);
    let mut dec = s.nfd();
    if dec
        .next()
        .is_none_or(|first| canonical_combining_class(first) != 0)
    {
        return false;
    }
    if acute_accents(s).is_err() {
        return false;
    }
    let mut stripped = s.nfd().filter(|a| *a != '\u{301}').nfc();
    let Some(t) = stripped.next() else {
        return false;
    };
    stripped.next().is_none()
        && is_nfc_starter(t)
        && !t.is_control()
        && !t.is_whitespace()
        && t.len_utf8() <= c.len_utf8()
}
/// Inclusive BMP code-point ranges that qualify for the fast spelling test,
/// including ASCII space (allowed only in the interior by the caller).
pub fn safe_bmp_spelling_ranges() -> Vec<(u32, u32)> {
    let mut ranges = Vec::new();
    let mut start = None;
    for code in 0..=0x10000u32 {
        let yes = code == 0x20
            || (code < 0x10000
                && char::from_u32(code).is_some_and(qualifies_safe_bmp_spelling_char));
        if yes && start.is_none() {
            start = Some(code);
        } else if !yes && let Some(begin) = start.take() {
            ranges.push((begin, code - 1));
        }
    }
    ranges
}
/// Format the TypeScript module generated from `safe_bmp_spelling_ranges`.
pub fn format_safe_bmp_spelling_ts() -> String {
    let ranges = safe_bmp_spelling_ranges();
    let mut pattern = String::from("[^");
    for (start, end) in &ranges {
        pattern.push_str(&format!("\\u{start:04x}"));
        if start != end {
            pattern.push_str(&format!("-\\u{end:04x}"));
        }
    }
    pattern.push(']');
    format!(
        "/**\n * Generated from jvc-core Unicode normalization and spelling rules.\n * Regenerate with: cargo run -p jvc-core --example spelling_ranges\n */\nexport const OUTSIDE_SAFE_BMP_SPELLING = /{pattern}/;\n"
    )
}
/// Acute stress marks affect display only. Keep every other diacritic.
pub fn strip_acute_accents(spelling: &str) -> String {
    spelling.nfd().filter(|c| *c != '\u{301}').nfc().collect()
}
/// A stress mark must follow a Lojban vowel or consonant.
pub fn validate_acute_accents(spelling: &str) -> Result<()> {
    acute_accents(spelling).map(|_| ())
}
fn acute_accents(spelling: &str) -> Result<bool> {
    let mut letter = false;
    let mut accented = false;
    for c in spelling.nfd() {
        if c == '\u{301}' {
            if !letter {
                return Err(Error::new(
                    "spelling",
                    "An acute accent must follow a Lojban vowel or consonant.",
                ));
            }
            accented = true;
        }
        letter = "abcdefgijklmnoprstuvxyz".contains(c.to_ascii_lowercase());
    }
    Ok(accented)
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
        || !is_nfc(s)
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
/// Every record still applies the complete signature profile and equation.
/// The least recently used key leaves the cache at its 1,024-key limit.
#[derive(Default)]
pub struct EnvelopeVerifier {
    keys: BTreeMap<[u8; 32], (signature::ValidatedPublicKey, u64)>,
    recency: BTreeMap<u64, [u8; 32]>,
    clock: u64,
    public_key_checks: u64,
}
impl EnvelopeVerifier {
    /// Count static public-key profile checks, including failed checks.
    pub fn public_key_checks(&self) -> u64 {
        self.public_key_checks
    }
    pub fn verify(&mut self, bytes: &[u8]) -> Result<VerifiedEnvelope> {
        if bytes.len() > MAX_ENVELOPE_BYTES {
            return Err(Error::new("size", "complete envelope exceeds 20 KiB"));
        }
        self.verify_value(parse_json(bytes)?)
    }
    /// Read a canonical stored envelope with the same bounded key cache.
    pub fn verify_stored(&mut self, bytes: &[u8]) -> Result<VerifiedEnvelope> {
        if bytes.len() > MAX_ENVELOPE_BYTES {
            return Err(Error::new("size", "complete envelope exceeds 20 KiB"));
        }
        self.verify_value(parse_stored_json(bytes)?)
    }
    fn tick(&mut self) -> u64 {
        if self.clock == u64::MAX {
            // Keep the order on wrap, with bounded work and storage.
            let order = std::mem::take(&mut self.recency);
            for (i, bytes) in order.into_values().enumerate() {
                let stamp = i as u64;
                self.keys.get_mut(&bytes).unwrap().1 = stamp;
                self.recency.insert(stamp, bytes);
            }
            self.clock = self.keys.len() as u64;
        }
        let stamp = self.clock;
        self.clock += 1;
        stamp
    }
    fn public_key(&mut self, bytes: &[u8; 32]) -> Result<signature::ValidatedPublicKey> {
        let stamp = self.tick();
        if let Some((key, old_stamp)) = self.keys.get_mut(bytes) {
            self.recency.remove(old_stamp);
            *old_stamp = stamp;
            self.recency.insert(stamp, *bytes);
            return Ok(key.clone());
        }
        self.public_key_checks = self.public_key_checks.saturating_add(1);
        let key = signature::ValidatedPublicKey::new(bytes)?;
        if self.keys.len() == VERIFIED_KEY_CACHE_LIMIT {
            let (_, oldest) = self.recency.pop_first().unwrap();
            self.keys.remove(&oldest);
        }
        self.keys.insert(*bytes, (key.clone(), stamp));
        self.recency.insert(stamp, *bytes);
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
    EnvelopeVerifier::default().verify_stored(bytes)
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

/// Parse admitted private bytes without checking signatures, hashes, or canonical form.
/// Only the host's trusted record store can supply these bytes.
pub fn inspect_host_stored_body(header: &Header, bytes: Option<&[u8]>) -> BodyAvailability {
    if header.content.is_none() {
        return BodyAvailability::Absent;
    }
    let Some(bytes) = bytes else {
        return BodyAvailability::Missing;
    };
    let parsed = serde_json::from_slice(bytes)
        .map_err(|e| Error::new("json", e.to_string()))
        .and_then(|body| {
            schema::validate_parsed_body(header, &body)?;
            Ok(body)
        });
    match parsed {
        Ok(body) => BodyAvailability::Valid { body },
        Err(error) => BodyAvailability::Invalid {
            reason: error.to_string(),
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
/// Stream envelope JSONL from a buffered reader, one line at a time. The
/// result is the same deduplicated, event-ID-ordered set that
/// `import_jsonl` returns for the same bytes.
pub fn import_jsonl_reader<R: std::io::BufRead>(mut reader: R) -> Result<Vec<VerifiedEnvelope>> {
    use std::io::{BufRead as _, Read};
    let mut events = Vec::new();
    let mut verifier = EnvelopeVerifier::default();
    let mut line = Vec::new();
    loop {
        line.clear();
        let read = (&mut reader)
            .take((MAX_ENVELOPE_BYTES + 2) as u64)
            .read_until(b'\n', &mut line)
            .map_err(|e| Error::new("filesystem", e.to_string()))?;
        if read == 0 {
            break;
        }
        if line.len() > MAX_ENVELOPE_BYTES + 1 {
            return Err(Error::new("size", "complete envelope exceeds 20 KiB"));
        }
        let stored = line.strip_suffix(b"\n").unwrap_or(&line);
        events.push(verifier.verify_stored(stored)?);
    }
    let export = export_jsonl(&events)?;
    if export.is_empty() {
        return Ok(Vec::new());
    }
    export[..export.len() - 1]
        .split(|b| *b == b'\n')
        .map(|line| verifier.verify_stored(line))
        .collect()
}
pub fn import_jsonl(bytes: &[u8]) -> Result<Vec<VerifiedEnvelope>> {
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    let mut events = Vec::new();
    let mut verifier = EnvelopeVerifier::default();
    for line in bytes
        .strip_suffix(b"\n")
        .unwrap_or(bytes)
        .split(|b| *b == b'\n')
    {
        events.push(verifier.verify_stored(line)?);
    }
    let export = export_jsonl(&events)?;
    export
        .strip_suffix(b"\n")
        .unwrap_or(&export)
        .split(|b| *b == b'\n')
        .map(|line| verifier.verify_stored(line))
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

#[cfg(test)]
mod hash_writer_tests {
    use super::*;
    use std::io::Write;
    #[test]
    fn bounded_hash_stream_matches_bytes_and_refuses_before_mutation() {
        let mut writer = HashWriter::new(b"domain\n", 7);
        writer.write_all(b"abc").unwrap();
        writer.write_all(b"defg").unwrap();
        assert!(writer.write_all(b"h").is_err());
        let (hash, bytes) = writer.finish("sha256:");
        assert_eq!(bytes, 7);
        assert_eq!(hash, hash_id("sha256:", b"domain\n", b"abcdefg"));
    }
}

#[cfg(test)]
mod verifier_cache_tests {
    use super::*;
    use curve25519_dalek::{constants::ED25519_BASEPOINT_POINT, scalar::Scalar};

    #[test]
    fn key_cache_keeps_recent_keys_after_its_limit_and_clock_wrap() {
        let mut verifier = EnvelopeVerifier::default();
        let keys: Vec<_> = (1..=VERIFIED_KEY_CACHE_LIMIT + 2)
            .map(|i| {
                (Scalar::from(i as u64) * ED25519_BASEPOINT_POINT)
                    .compress()
                    .to_bytes()
            })
            .collect();
        for bytes in &keys[..VERIFIED_KEY_CACHE_LIMIT] {
            verifier.public_key(bytes).unwrap();
        }
        verifier.public_key(&keys[0]).unwrap();
        verifier
            .public_key(&keys[VERIFIED_KEY_CACHE_LIMIT])
            .unwrap();
        assert!(verifier.keys.contains_key(&keys[0]));
        assert!(!verifier.keys.contains_key(&keys[1]));
        let checks = verifier.public_key_checks();
        for _ in 0..5 {
            verifier
                .public_key(&keys[VERIFIED_KEY_CACHE_LIMIT])
                .unwrap();
        }
        assert_eq!(verifier.public_key_checks(), checks);
        verifier.clock = u64::MAX;
        verifier.public_key(&keys[0]).unwrap();
        verifier
            .public_key(&keys[VERIFIED_KEY_CACHE_LIMIT + 1])
            .unwrap();
        assert!(verifier.keys.contains_key(&keys[0]));
        assert!(!verifier.keys.contains_key(&keys[2]));
        assert_eq!(verifier.keys.len(), VERIFIED_KEY_CACHE_LIMIT);
        assert_eq!(verifier.recency.len(), VERIFIED_KEY_CACHE_LIMIT);
        for (bytes, (_, stamp)) in &verifier.keys {
            assert_eq!(verifier.recency.get(stamp), Some(bytes));
        }
        let checks = verifier.public_key_checks();
        for _ in 0..2 {
            assert!(verifier.public_key(&[0; 32]).is_err());
        }
        assert_eq!(verifier.public_key_checks(), checks + 2);
        assert_eq!(verifier.keys.len(), VERIFIED_KEY_CACHE_LIMIT);
    }
}

#[cfg(test)]
mod spelling_ranges_tests {
    use super::*;

    fn in_ranges(ranges: &[(u32, u32)], code: u32) -> bool {
        ranges.iter().any(|&(a, b)| code >= a && code <= b)
    }

    #[test]
    fn safe_bmp_table_matches_committed_module_and_core_word_id() {
        let committed = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/core/src/word-spelling-ranges.ts"
        ))
        .expect("committed word-spelling-ranges.ts must exist");
        assert_eq!(committed, format_safe_bmp_spelling_ts());

        let ranges = safe_bmp_spelling_ranges();
        assert!(!ranges.is_empty());

        // Every single BMP scalar in the table (except space) must be valid alone
        // and inside a spelling.
        for code in 0u32..=0xFFFF {
            let Some(ch) = char::from_u32(code) else {
                assert!(!in_ranges(&ranges, code));
                continue;
            };
            if in_ranges(&ranges, code) {
                if code == 0x20 {
                    assert!(valid_word_id_spelling("a b"));
                    assert!(!valid_word_id_spelling(" "));
                } else {
                    let s = ch.to_string();
                    assert!(valid_word_id_spelling(&s), "U+{code:04X} alone");
                    assert!(
                        word_id(&serde_json::json!({"language": "jbo", "spelling": s})).is_ok(),
                        "word_id U+{code:04X}"
                    );
                }
            }
        }

        // Known counterexamples must stay outside the fast BMP table.
        for excluded in ['\u{0000}', '\u{00a0}', '\u{0301}', '\u{1161}', '\u{1e83}'] {
            assert!(
                !in_ranges(&ranges, excluded as u32),
                "U+{:04X} must fall back to core",
                excluded as u32
            );
        }
        // Hangul L + V fails NFC when concatenated; V is outside the table.
        assert!(!valid_word_id_spelling("\u{1100}\u{1161}"));
        assert!(!valid_word_id_spelling("e\u{0301}"));
        assert!(!valid_word_id_spelling("á\u{0301}"));
        assert!(!valid_word_id_spelling("q\u{0301}"));
        assert!(!valid_word_id_spelling("\u{00a0}a"));

        let ok_256 = format!("{}a", "水".repeat(85));
        assert_eq!(ok_256.len(), 256);
        assert!(valid_word_id_spelling(&ok_256));
        let bad_258 = "水".repeat(86);
        assert_eq!(bad_258.len(), 258);
        assert!(!valid_word_id_spelling(&bad_258));

        for sample in [
            "cukta", "djan", "dján", "ba'a", "Ba’a", "a\"b\\c", "水", "𠮷", &ok_256,
        ] {
            assert_eq!(
                word_id_for_lojban_spelling(sample).unwrap(),
                word_id(&serde_json::json!({ "language": "jbo", "spelling": sample })).unwrap(),
                "word_id_for_lojban_spelling mismatch for {sample:?}"
            );
        }
        for invalid in ["", " ", " cukta", "\u{1100}\u{1161}", "e\u{0301}", &bad_258] {
            assert!(word_id_for_lojban_spelling(invalid).is_err());
        }
    }
}
