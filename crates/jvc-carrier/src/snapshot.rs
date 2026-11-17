use jvc_core::{
    BodyAvailability, Error, MAX_BODY_BYTES, MAX_ENVELOPE_BYTES, Result, VerifiedEnvelope,
    canonical_value, hash_id, inspect_body, parse_stored_json, parse_transport_json, valid_id,
    verify_envelope,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub const PART_BYTES: usize = 8 * 1024 * 1024;
pub const SELECTION_BYTES: usize = 16 * 1024 * 1024;
pub const SELECTION_IDS: usize = 200_000;
pub const FORMAT_BYTES: &[u8] = br#"{"format":"jbovlacku-git","version":1}"#;
pub const ATTRIBUTES_BYTES: &[u8] = b"* -text -ident -filter\n";
const MAX_RECORD_BYTES: usize = MAX_BODY_BYTES + MAX_ENVELOPE_BYTES + 32;

fn error(code: &str, message: impl Into<String>) -> Error {
    Error::new(code, message)
}

/// The outcome of reading one line with a byte cap.
pub(crate) struct CappedLine {
    pub oversized: bool,
    pub terminated: bool,
}

/// Read one LF-terminated line without retaining more than `cap` bytes.
/// The rest of an over-cap line is consumed and discarded, so the caller
/// can tell a terminated oversized line from an unterminated one.
pub(crate) fn read_capped_line<R: std::io::BufRead + ?Sized>(
    reader: &mut R,
    line: &mut Vec<u8>,
    cap: usize,
) -> Result<Option<CappedLine>> {
    line.clear();
    let mut total = 0usize;
    let mut terminated = false;
    let mut any = false;
    loop {
        let buffer = reader
            .fill_buf()
            .map_err(|e| error("filesystem", e.to_string()))?;
        if buffer.is_empty() {
            break;
        }
        any = true;
        let (take, found) = match buffer.iter().position(|b| *b == b'\n') {
            Some(position) => (position + 1, true),
            None => (buffer.len(), false),
        };
        total += take;
        let keep = cap.saturating_sub(line.len()).min(take);
        line.extend_from_slice(&buffer[..keep]);
        reader.consume(take);
        if found {
            terminated = true;
            break;
        }
    }
    if !any {
        return Ok(None);
    }
    Ok(Some(CappedLine {
        oversized: total > cap,
        terminated,
    }))
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RetentionPolicy {
    #[serde(default)]
    pub refused_bodies: BTreeSet<String>,
    #[serde(default)]
    pub refused_events: BTreeSet<String>,
    #[serde(default)]
    pub refused_issuers: BTreeSet<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Inventory {
    pub count: usize,
    pub hash: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub version: u8,
    pub events: Inventory,
    pub bodies: Inventory,
    pub import_selections: Inventory,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InsertOutcome {
    Added,
    Duplicate,
    VariantSelected,
    VariantRetained,
    Refused,
}
#[derive(Clone, Debug, Serialize)]
pub struct Diagnostic {
    pub code: String,
    pub event: Option<String>,
    pub path: String,
    pub message: String,
}
#[derive(Clone, Debug, Serialize)]
pub struct ValidationReport {
    pub manifest: Manifest,
    pub snapshot: String,
    pub logical_inventory: String,
    pub admitted_events: usize,
    pub diagnostics: Vec<Diagnostic>,
}

/// Only authenticated objects enter these maps. Export omits unreferenced cached bodies.
#[derive(Clone, Debug, Default)]
pub struct Snapshot {
    events: BTreeMap<String, VerifiedEnvelope>,
    bodies: BTreeMap<String, Vec<u8>>,
    selections: BTreeMap<String, Vec<u8>>,
    refused_bodies: BTreeSet<String>,
    refused_issuers: BTreeSet<String>,
    quarantined_events: BTreeSet<String>,
    quarantined_bodies: BTreeSet<String>,
    quarantined_selections: BTreeSet<String>,
    readme: Vec<u8>,
}
impl Snapshot {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn events(&self) -> &BTreeMap<String, VerifiedEnvelope> {
        &self.events
    }
    pub fn bodies(&self) -> &BTreeMap<String, Vec<u8>> {
        &self.bodies
    }
    pub fn selections(&self) -> &BTreeMap<String, Vec<u8>> {
        &self.selections
    }
    pub fn refused_issuers(&self) -> &BTreeSet<String> {
        &self.refused_issuers
    }
    /// Save this private policy outside the carrier and supply it on later merges.
    /// Event refusals have become issuer refusals, so removed events are not needed.
    pub fn retention_policy(&self) -> RetentionPolicy {
        RetentionPolicy {
            refused_bodies: self.refused_bodies.clone(),
            refused_events: BTreeSet::new(),
            refused_issuers: self.refused_issuers.clone(),
        }
    }
    pub fn insert_envelope(&mut self, bytes: &[u8]) -> Result<InsertOutcome> {
        let event = verify_envelope(bytes)?;
        self.insert_verified(event)
    }
    fn insert_verified(&mut self, event: VerifiedEnvelope) -> Result<InsertOutcome> {
        let id = event.id().to_owned();
        if self.refused_issuers.contains(&event.header().issuer) {
            return Ok(InsertOutcome::Refused);
        }
        if self.quarantined_events.contains(&id) {
            return Err(error(
                "event_collision",
                "event identifier remains quarantined",
            ));
        }
        if let Some(old) = self.events.get(&id) {
            if old.canonical_header() != event.canonical_header() {
                self.events.remove(&id);
                self.quarantined_events.insert(id);
                return Err(error(
                    "event_collision",
                    "different authenticated headers share one event identifier",
                ));
            }
            if old.signature_bytes() == event.signature_bytes() {
                return Ok(InsertOutcome::Duplicate);
            }
            if old.signature_bytes() < event.signature_bytes() {
                return Ok(InsertOutcome::VariantRetained);
            }
            self.events.insert(id, event);
            return Ok(InsertOutcome::VariantSelected);
        }
        self.events.insert(id, event);
        Ok(InsertOutcome::Added)
    }
    pub fn insert_body(&mut self, claimed_hash: &str, bytes: &[u8]) -> Result<InsertOutcome> {
        if !valid_id(claimed_hash, "sha256:") {
            return Err(error("body_hash", "body identifier is invalid"));
        }
        if bytes.len() > MAX_BODY_BYTES {
            return Err(error("body_size", "body exceeds 256 KiB"));
        }
        let body = parse_stored_json(bytes)?;
        if !body.is_object() {
            return Err(error("body_shape", "carrier body must be an object"));
        }
        if hash_id("sha256:", b"", bytes) != claimed_hash {
            return Err(error(
                "body_hash",
                "body bytes do not match their claimed identifier",
            ));
        }
        if self.refused_bodies.contains(claimed_hash) {
            return Ok(InsertOutcome::Refused);
        }
        insert_authenticated(
            &mut self.bodies,
            &mut self.quarantined_bodies,
            claimed_hash,
            bytes,
            "body_collision",
        )
    }
    pub fn insert_selection(&mut self, claimed_hash: &str, bytes: &[u8]) -> Result<InsertOutcome> {
        if !valid_id(claimed_hash, "sha256:") {
            return Err(error("selection_hash", "selection identifier is invalid"));
        }
        if bytes.len() > SELECTION_BYTES {
            return Err(error("selection_size", "selection exceeds 16 MiB"));
        }
        let selection = parse_stored_json(bytes)?;
        let ids = selection
            .as_array()
            .ok_or_else(|| error("selection_shape", "selection must be an array"))?;
        if ids.len() > SELECTION_IDS {
            return Err(error(
                "selection_size",
                "selection exceeds 200000 event identifiers",
            ));
        }
        let mut previous = None;
        for v in ids {
            let id = v.as_str().ok_or_else(|| {
                error(
                    "selection_shape",
                    "selection entries must be event identifiers",
                )
            })?;
            if !valid_id(id, "jve1:") || previous.is_some_and(|p| p >= id) {
                return Err(error(
                    "selection_order",
                    "selection identifiers must be valid, sorted, and unique",
                ));
            }
            previous = Some(id);
        }
        if hash_id("sha256:", b"", bytes) != claimed_hash {
            return Err(error(
                "selection_hash",
                "selection bytes do not match their claimed identifier",
            ));
        }
        insert_authenticated(
            &mut self.selections,
            &mut self.quarantined_selections,
            claimed_hash,
            bytes,
            "selection_collision",
        )
    }
    pub fn apply_retention(&mut self, policy: &RetentionPolicy) -> Result<()> {
        for id in &policy.refused_bodies {
            if !valid_id(id, "sha256:") {
                return Err(error("policy", "refused body identifier is invalid"));
            }
        }
        for id in &policy.refused_events {
            if !valid_id(id, "jve1:") {
                return Err(error("policy", "refused event identifier is invalid"));
            }
        }
        for issuer in &policy.refused_issuers {
            if !valid_id(issuer, "ed25519:") {
                return Err(error("policy", "refused issuer identifier is invalid"));
            }
        }
        let mut issuers = policy.refused_issuers.clone();
        for id in &policy.refused_events {
            let event=self.events.get(id).ok_or_else(||error("policy_unknown_event","refused event has no retained issuer evidence. Use its recorded issuer in the private policy."))?;
            issuers.insert(event.header().issuer.clone());
        }
        self.refused_bodies
            .extend(policy.refused_bodies.iter().cloned());
        self.refused_issuers.extend(issuers);
        self.events
            .retain(|_, e| !self.refused_issuers.contains(&e.header().issuer));
        self.bodies
            .retain(|id, _| !self.refused_bodies.contains(id));
        Ok(())
    }
    pub fn merge(&self, other: &Snapshot, policy: &RetentionPolicy) -> Result<Self> {
        let mut merged = self.clone();
        for event in other.events.values() {
            merged.insert_verified(event.clone())?;
        }
        for (hash, body) in &other.bodies {
            merged.insert_body(hash, body)?;
        }
        for (hash, selection) in &other.selections {
            merged.insert_selection(hash, selection)?;
        }
        merged.apply_retention(policy)?;
        merged.events.retain(|id, e| {
            !merged.refused_issuers.contains(&e.header().issuer)
                && !merged.quarantined_events.contains(id)
        });
        merged.bodies.retain(|id, _| {
            !merged.refused_bodies.contains(id) && !merged.quarantined_bodies.contains(id)
        });
        merged
            .selections
            .retain(|id, _| !merged.quarantined_selections.contains(id));
        Ok(merged)
    }
    fn retained_bodies(&self) -> BTreeMap<&str, &[u8]> {
        let mut bodies = BTreeMap::new();
        for event in self.events.values() {
            if let Some(c) = &event.header().content {
                if self.refused_bodies.contains(&c.hash)
                    || self.quarantined_bodies.contains(&c.hash)
                {
                    continue;
                }
                if let Some(bytes) = self
                    .bodies
                    .get(&c.hash)
                    .filter(|b| b.len() as u64 == c.bytes)
                {
                    bodies.insert(c.hash.as_str(), bytes.as_slice());
                }
            }
        }
        bodies
    }
    pub fn manifest(&self) -> Result<Manifest> {
        // Hash the envelope stream incrementally so a manifest does not
        // retain a second copy of every envelope.
        use std::io::Write;
        let mut hasher = jvc_core::HashWriter::new(b"", usize::MAX);
        for event in self.events.values() {
            hasher
                .write_all(&event.canonical_envelope()?)
                .map_err(|e| error("hash", e.to_string()))?;
            hasher
                .write_all(b"\n")
                .map_err(|e| error("hash", e.to_string()))?;
        }
        let (events_hash, _) = hasher.finish("sha256:");
        let bodies = self.retained_bodies();
        Ok(Manifest {
            version: 1,
            events: Inventory {
                count: self.events.len(),
                hash: events_hash,
            },
            bodies: Inventory {
                count: bodies.len(),
                hash: hash_id(
                    "sha256:",
                    b"",
                    &canonical_value(&json!(bodies.keys().collect::<Vec<_>>()))?,
                ),
            },
            import_selections: Inventory {
                count: self.selections.len(),
                hash: hash_id(
                    "sha256:",
                    b"",
                    &canonical_value(&json!(self.selections.keys().collect::<Vec<_>>()))?,
                ),
            },
        })
    }
    pub fn snapshot_id(&self) -> Result<String> {
        Ok(hash_id(
            "sha256:",
            b"",
            &canonical_value(&serde_json::to_value(self.manifest()?).unwrap())?,
        ))
    }
    pub fn logical_digest(&self) -> Result<String> {
        Ok(hash_id(
            "sha256:",
            b"",
            &canonical_value(
                &json!({"events":self.events.keys().collect::<Vec<_>>(),"bodies":self.retained_bodies().keys().collect::<Vec<_>>(),"import_selections":self.selections.keys().collect::<Vec<_>>()}),
            )?,
        ))
    }
    pub fn envelope_stream(&self) -> Result<Vec<u8>> {
        let mut out = Vec::new();
        for event in self.events.values() {
            out.extend(event.canonical_envelope()?);
            out.push(b'\n');
        }
        Ok(out)
    }
    fn record_line(&self, event: &VerifiedEnvelope) -> Result<Vec<u8>> {
        let body = event
            .header()
            .content
            .as_ref()
            .filter(|c| {
                !self.refused_bodies.contains(&c.hash) && !self.quarantined_bodies.contains(&c.hash)
            })
            .and_then(|c| {
                self.bodies
                    .get(&c.hash)
                    .filter(|b| b.len() as u64 == c.bytes)
                    .map(|b| parse_stored_json(b))
            })
            .transpose()?
            .unwrap_or(Value::Null);
        let mut bytes =
            serde_json_canonicalizer::to_vec(&json!({"envelope":event.envelope(),"body":body}))
                .map_err(|e| error("canonical", e.to_string()))?;
        bytes.push(b'\n');
        Ok(bytes)
    }
    pub fn to_jsonl(&self) -> Result<Vec<u8>> {
        let mut bytes = Vec::new();
        self.write_jsonl(&mut bytes)?;
        Ok(bytes)
    }
    /// Write canonical carrier records one at a time to a writer.
    pub fn write_jsonl(&self, mut writer: impl std::io::Write) -> Result<()> {
        for event in self.events.values() {
            writer
                .write_all(&self.record_line(event)?)
                .map_err(|e| error("filesystem", e.to_string()))?;
        }
        Ok(())
    }
    pub fn from_jsonl(bytes: &[u8]) -> Result<Self> {
        Self::from_jsonl_with_verifier(bytes, &mut jvc_core::EnvelopeVerifier::default())
    }
    fn from_jsonl_with_verifier(
        bytes: &[u8],
        verifier: &mut jvc_core::EnvelopeVerifier,
    ) -> Result<Self> {
        let mut snapshot = Self::new();
        if bytes.is_empty() {
            return Ok(snapshot);
        }
        if !bytes.ends_with(b"\n") {
            return Err(error(
                "record_newline",
                "every carrier record must end with LF",
            ));
        }
        for (line_no, line) in bytes[..bytes.len() - 1].split(|b| *b == b'\n').enumerate() {
            snapshot.insert_jsonl_line(line, line_no + 1, verifier)?;
        }
        Ok(snapshot)
    }
    /// Insert one canonical carrier record line (without its LF) into this
    /// snapshot. This is the per-record path used by streamed readers; the
    /// record stays within the envelope and body bounds.
    pub(crate) fn insert_jsonl_line(
        &mut self,
        line: &[u8],
        line_no: usize,
        verifier: &mut jvc_core::EnvelopeVerifier,
    ) -> Result<String> {
        if line.is_empty() {
            return Err(error(
                "record_blank",
                format!("record line {line_no} is empty"),
            ));
        }
        if line.len() > MAX_RECORD_BYTES {
            return Err(error(
                "record_size",
                "carrier record exceeds its envelope and body limits",
            ));
        }
        let record = parse_transport_json(line)?;
        let canonical = serde_json_canonicalizer::to_vec(&record)
            .map_err(|e| error("canonical", e.to_string()))?;
        if canonical != line {
            return Err(error("canonical", "carrier record bytes are not canonical"));
        }
        let o = record
            .as_object()
            .ok_or_else(|| error("record_shape", "carrier record must be an object"))?;
        if o.len() != 2 || !o.contains_key("envelope") || !o.contains_key("body") {
            return Err(error(
                "record_shape",
                "carrier record requires exactly body and envelope",
            ));
        }
        let event = verifier.verify(&canonical_value(&record["envelope"])?)?;
        if self.events.contains_key(event.id()) {
            return Err(error(
                "duplicate_event",
                "carrier contains a duplicate event identifier",
            ));
        }
        if !record["body"].is_null() {
            let c = event.header().content.as_ref().ok_or_else(|| {
                error(
                    "body_descriptor",
                    "null content descriptor requires null body",
                )
            })?;
            let bytes = canonical_value(&record["body"])?;
            if bytes.len() as u64 != c.bytes {
                return Err(error(
                    "body_length",
                    "inline body length differs from its descriptor",
                ));
            }
            self.insert_body(&c.hash, &bytes)?;
        }
        let id = event.id().to_owned();
        self.insert_verified(event)?;
        Ok(id)
    }
    /// Read canonical carrier records from a buffered reader, one line at a
    /// time. Only one record line is retained at a time.
    pub fn from_jsonl_reader<R: std::io::BufRead>(reader: R) -> Result<Self> {
        let mut snapshot = Self::new();
        let mut verifier = jvc_core::EnvelopeVerifier::default();
        snapshot.read_jsonl_lines(reader, &mut verifier)?;
        Ok(snapshot)
    }
    pub(crate) fn read_jsonl_lines<R: std::io::BufRead>(
        &mut self,
        mut reader: R,
        verifier: &mut jvc_core::EnvelopeVerifier,
    ) -> Result<()> {
        let mut line = Vec::new();
        let mut line_no = 0usize;
        while let Some(capped) = read_capped_line(&mut reader, &mut line, MAX_RECORD_BYTES + 1)? {
            line_no += 1;
            // A missing final LF keeps the precedence of the in-memory
            // reader, which checks the final LF before any record size.
            if !capped.terminated {
                return Err(error(
                    "record_newline",
                    "every carrier record must end with LF",
                ));
            }
            if capped.oversized {
                return Err(error(
                    "record_size",
                    "carrier record exceeds its envelope and body limits",
                ));
            }
            self.insert_jsonl_line(&line[..line.len() - 1], line_no, verifier)?;
        }
        Ok(())
    }
    pub fn to_files(&self) -> Result<BTreeMap<String, Vec<u8>>> {
        self.to_files_with_partition_limit(None)
    }
    /// Write carrier files with an optional local quota on the number of
    /// parts in one digest partition. `None` (the default through
    /// `to_files`) sets no quota. A configured quota returns
    /// `partition_limit`. The 8 MiB per-part bound always applies.
    pub fn to_files_with_partition_limit(
        &self,
        max_parts_per_partition: Option<usize>,
    ) -> Result<BTreeMap<String, Vec<u8>>> {
        let mut files = BTreeMap::new();
        files.insert("format.json".into(), FORMAT_BYTES.to_vec());
        files.insert(".gitattributes".into(), ATTRIBUTES_BYTES.to_vec());
        files.insert(
            "manifest.json".into(),
            canonical_value(&serde_json::to_value(self.manifest()?).unwrap())?,
        );
        files.insert("README.md".into(), self.readme.clone());
        let mut parts: BTreeMap<String, Vec<Vec<u8>>> = BTreeMap::new();
        for event in self.events.values() {
            let partition = event.id()[5..7].to_owned();
            let line = self.record_line(event)?;
            let values = parts.entry(partition).or_insert_with(|| vec![Vec::new()]);
            if values.last().unwrap().len() + line.len() > PART_BYTES {
                values.push(Vec::new());
            }
            check_partition_part_count(values.len(), max_parts_per_partition)?;
            values.last_mut().unwrap().extend(line);
        }
        for (partition, parts) in parts {
            for (index, part) in parts.into_iter().enumerate() {
                files.insert(format!("records/{partition}/{index:06}.jsonl"), part);
            }
        }
        for (id, bytes) in &self.selections {
            files.insert(
                format!("import-selections/{}/{}.json", &id[7..9], &id[9..]),
                bytes.clone(),
            );
        }
        Ok(files)
    }
    pub fn from_files(files: &BTreeMap<String, Vec<u8>>) -> Result<Self> {
        for path in files.keys() {
            validate_path(path)?;
        }
        for (path, wanted) in [
            ("format.json", FORMAT_BYTES),
            (".gitattributes", ATTRIBUTES_BYTES),
        ] {
            if files.get(path).map(Vec::as_slice) != Some(wanted) {
                return Err(error(
                    "fixed_file",
                    format!("{path} must contain its exact format bytes"),
                ));
            }
        }
        let declared = files
            .get("manifest.json")
            .ok_or_else(|| error("manifest_missing", "manifest.json is missing"))?;
        parse_stored_json(declared)?;
        let mut snapshot = Self::new();
        snapshot.readme = files
            .get("README.md")
            .ok_or_else(|| error("readme_missing", "README.md is missing"))?
            .clone();
        let mut verifier = jvc_core::EnvelopeVerifier::default();
        for (path, bytes) in files {
            if path.starts_with("records/") {
                if bytes.is_empty() || bytes.len() > PART_BYTES {
                    return Err(error(
                        "part_size",
                        format!("{path} is empty or exceeds 8 MiB"),
                    ));
                }
                let part = Self::from_jsonl_with_verifier(bytes, &mut verifier)?;
                for event in part.events.values() {
                    if event.id()[5..7] != path[8..10] {
                        return Err(error(
                            "partition",
                            format!("{path} contains an event from another partition"),
                        ));
                    }
                    if snapshot.events.contains_key(event.id()) {
                        return Err(error(
                            "duplicate_event",
                            "carrier contains duplicate event identifiers",
                        ));
                    }
                    snapshot.insert_verified(event.clone())?;
                }
                for (hash, body) in part.bodies {
                    snapshot.insert_body(&hash, &body)?;
                }
            } else if path.starts_with("import-selections/") {
                let pieces: Vec<_> = path.split('/').collect();
                let id = format!(
                    "sha256:{}{}",
                    pieces[1],
                    pieces[2].strip_suffix(".json").unwrap()
                );
                snapshot.insert_selection(&id, bytes)?;
            }
        }
        if canonical_value(&serde_json::to_value(snapshot.manifest()?).unwrap())? != *declared {
            return Err(error(
                "manifest_mismatch",
                "declared manifest differs from authenticated inventory",
            ));
        }
        let canonical = snapshot.to_files()?;
        for (path, bytes) in &canonical {
            if path != "README.md" && files.get(path) != Some(bytes) {
                return Err(error(
                    "carrier_noncanonical",
                    format!(
                        "{path} differs from canonical sorting, filling, or greedy partitioning"
                    ),
                ));
            }
        }
        if canonical.len() != files.len() {
            return Err(error(
                "carrier_noncanonical",
                "carrier has extra or missing record parts",
            ));
        }
        Ok(snapshot)
    }
    /// Build a snapshot from a listed carrier without retaining every file
    /// at once. `read_file` returns one small or selection file.
    /// `open_reader` streams one record part line by line. The listed paths
    /// must carry their byte sizes and are sorted here.
    pub(crate) fn from_listed_files(
        listed: &[(String, usize)],
        mut read_file: impl FnMut(&str) -> Result<Vec<u8>>,
        mut open_reader: impl FnMut(&str) -> Result<Box<dyn std::io::BufRead>>,
        mut check_tail: impl FnMut(&str) -> Result<()>,
    ) -> Result<Self> {
        let mut listed: Vec<(String, usize)> = listed.to_vec();
        listed.sort_by(|a, b| {
            let key = |path: &str| -> String {
                if let Some(rest) = path.strip_prefix("records/") {
                    let index = rest[3..].strip_suffix(".jsonl").unwrap_or("0");
                    let numeric = index.parse::<usize>().unwrap_or(0);
                    format!("records/{}/{numeric:012}", &rest[..2])
                } else {
                    path.to_owned()
                }
            };
            key(&a.0).cmp(&key(&b.0))
        });
        for (path, _) in &listed {
            validate_path(path)?;
        }
        let present: BTreeSet<&str> = listed.iter().map(|(p, _)| p.as_str()).collect();
        for (path, wanted) in [
            ("format.json", FORMAT_BYTES),
            (".gitattributes", ATTRIBUTES_BYTES),
        ] {
            if !present.contains(path) || read_file(path)? != wanted {
                return Err(error(
                    "fixed_file",
                    format!("{path} must contain its exact format bytes"),
                ));
            }
        }
        if !present.contains("manifest.json") {
            return Err(error("manifest_missing", "manifest.json is missing"));
        }
        let declared = read_file("manifest.json")?;
        parse_stored_json(&declared)?;
        if !present.contains("README.md") {
            return Err(error("readme_missing", "README.md is missing"));
        }
        let mut snapshot = Self::new();
        snapshot.readme = read_file("README.md")?;
        let mut verifier = jvc_core::EnvelopeVerifier::default();
        let mut current_partition: Option<String> = None;
        let mut next_index: usize = 0;
        let mut previous_part_len: Option<usize> = None;
        let mut last_id: Option<String> = None;
        for (path, _size) in &listed {
            if let Some(rest) = path.strip_prefix("records/") {
                let partition = &rest[..2];
                let index: usize = rest[3..]
                    .strip_suffix(".jsonl")
                    .unwrap()
                    .parse()
                    .map_err(|_| error("path", format!("unexpected carrier path: {path}")))?;
                if current_partition.as_deref() != Some(partition) {
                    current_partition = Some(partition.to_owned());
                    next_index = 0;
                    previous_part_len = None;
                    last_id = None;
                }
                if index != next_index {
                    return Err(error(
                        "carrier_noncanonical",
                        format!(
                            "{path} differs from canonical sorting, filling, or greedy partitioning"
                        ),
                    ));
                }
                // A record part is a file: its last byte must be LF before
                // any of its records are parsed, as in the in-memory reader.
                check_tail(path)?;
                let mut reader = open_reader(path)?;
                let mut line = Vec::new();
                let mut line_no = 0usize;
                let mut part_len = 0usize;
                let mut first_line = true;
                while let Some(capped) =
                    read_capped_line(&mut *reader, &mut line, MAX_RECORD_BYTES + 1)?
                {
                    line_no += 1;
                    if !capped.terminated {
                        return Err(error(
                            "record_newline",
                            "every carrier record must end with LF",
                        ));
                    }
                    if capped.oversized {
                        return Err(error(
                            "record_size",
                            "carrier record exceeds its envelope and body limits",
                        ));
                    }
                    if first_line
                        && let Some(prev) = previous_part_len
                        && prev + line.len() <= PART_BYTES
                    {
                        return Err(error(
                            "carrier_noncanonical",
                            format!(
                                "{path} differs from canonical sorting, filling, or greedy partitioning"
                            ),
                        ));
                    }
                    first_line = false;
                    part_len += line.len();
                    if part_len > PART_BYTES {
                        return Err(error(
                            "part_size",
                            format!("{path} is empty or exceeds 8 MiB"),
                        ));
                    }
                    let id = snapshot.insert_jsonl_line(
                        &line[..line.len() - 1],
                        line_no,
                        &mut verifier,
                    )?;
                    if &id[5..7] != partition {
                        return Err(error(
                            "partition",
                            format!("{path} contains an event from another partition"),
                        ));
                    }
                    if last_id.as_deref().is_some_and(|last| last >= id.as_str()) {
                        return Err(error(
                            "carrier_noncanonical",
                            format!(
                                "{path} differs from canonical sorting, filling, or greedy partitioning"
                            ),
                        ));
                    }
                    last_id = Some(id);
                }
                if line_no == 0 {
                    return Err(error(
                        "part_size",
                        format!("{path} is empty or exceeds 8 MiB"),
                    ));
                }
                previous_part_len = Some(part_len);
                next_index += 1;
            } else if path.starts_with("import-selections/") {
                let pieces: Vec<_> = path.split('/').collect();
                let id = format!(
                    "sha256:{}{}",
                    pieces[1],
                    pieces[2].strip_suffix(".json").unwrap()
                );
                let bytes = read_file(path)?;
                snapshot.insert_selection(&id, &bytes)?;
            }
        }
        // Canonical filling: every record whose descriptor matches a
        // retained body must carry that body inline. A body matches only
        // when the retained bytes have the descriptor's exact byte count.
        // This second pass does not verify signatures again. It reads one
        // line at a time and keeps no per-event state, because whether a
        // body is retained is known only after every record is read.
        for (path, _size) in &listed {
            if !path.starts_with("records/") {
                continue;
            }
            let mut reader = open_reader(path)?;
            let mut line = Vec::new();
            while let Some(_capped) =
                read_capped_line(&mut *reader, &mut line, MAX_RECORD_BYTES + 1)?
            {
                let record = parse_transport_json(&line[..line.len().saturating_sub(1)])?;
                if !record["body"].is_null() {
                    continue;
                }
                let content = &record["envelope"]["header"]["content"];
                let (Some(hash), Some(bytes)) =
                    (content["hash"].as_str(), content["bytes"].as_u64())
                else {
                    continue;
                };
                let retained = snapshot
                    .bodies
                    .get(hash)
                    .is_some_and(|retained| retained.len() as u64 == bytes)
                    && !snapshot.refused_bodies.contains(hash)
                    && !snapshot.quarantined_bodies.contains(hash);
                if retained {
                    return Err(error(
                        "carrier_noncanonical",
                        format!(
                            "{path} differs from canonical sorting, filling, or greedy partitioning"
                        ),
                    ));
                }
            }
        }
        if canonical_value(&serde_json::to_value(snapshot.manifest()?).unwrap())? != declared {
            return Err(error(
                "manifest_mismatch",
                "declared manifest differs from authenticated inventory",
            ));
        }
        Ok(snapshot)
    }
    pub fn validation_report(&self) -> Result<ValidationReport> {
        let mut diagnostics = Vec::new();
        for event in self.events.values() {
            if let Err(e) = jvc_core::validate_action(event.header()) {
                diagnostics.push(Diagnostic {
                    code: "action_inert".into(),
                    event: Some(event.id().into()),
                    path: "/header/action".into(),
                    message: e.to_string(),
                });
            }
            let body = event
                .header()
                .content
                .as_ref()
                .and_then(|c| self.bodies.get(&c.hash))
                .map(Vec::as_slice);
            match inspect_body(event, body) {
                BodyAvailability::Missing => diagnostics.push(Diagnostic {
                    code: "body_missing".into(),
                    event: Some(event.id().into()),
                    path: "/body".into(),
                    message: "Body is unavailable. The signed header remains admitted.".into(),
                }),
                BodyAvailability::Invalid { reason } => diagnostics.push(Diagnostic {
                    code: "body_invalid".into(),
                    event: Some(event.id().into()),
                    path: "/body".into(),
                    message: reason,
                }),
                _ => {}
            }
        }
        Ok(ValidationReport {
            manifest: self.manifest()?,
            snapshot: self.snapshot_id()?,
            logical_inventory: self.logical_digest()?,
            admitted_events: self.events.len(),
            diagnostics,
        })
    }
}
fn insert_authenticated(
    map: &mut BTreeMap<String, Vec<u8>>,
    quarantined: &mut BTreeSet<String>,
    id: &str,
    bytes: &[u8],
    code: &str,
) -> Result<InsertOutcome> {
    if quarantined.contains(id) {
        return Err(error(code, "content identifier remains quarantined"));
    }
    if let Some(old) = map.get(id) {
        if old == bytes {
            return Ok(InsertOutcome::Duplicate);
        }
        map.remove(id);
        quarantined.insert(id.to_owned());
        return Err(error(
            code,
            "different authenticated bytes share one content identifier",
        ));
    }
    map.insert(id.into(), bytes.to_vec());
    Ok(InsertOutcome::Added)
}
fn hex_lower(s: &str, n: usize) -> bool {
    s.len() == n
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
/// Enforce an optional per-partition part-count quota. `None` sets no
/// quota, so any count passes. This takes a count only, so a test can
/// exercise counts above 1,000,000 without allocating that many parts.
pub fn check_partition_part_count(count: usize, max: Option<usize>) -> Result<()> {
    if let Some(max) = max
        && count > max
    {
        return Err(error(
            "partition_limit",
            "partition exceeds its configured part limit",
        ));
    }
    Ok(())
}
pub fn validate_path(path: &str) -> Result<()> {
    if [
        "format.json",
        "manifest.json",
        ".gitattributes",
        "README.md",
    ]
    .contains(&path)
    {
        return Ok(());
    }
    let parts: Vec<_> = path.split('/').collect();
    let valid = parts.len() == 3
        && hex_lower(parts[1], 2)
        && match parts[0] {
            "records" => parts[2].strip_suffix(".jsonl").is_some_and(|s| {
                // The canonical spelling is {index:06}: at least six digits,
                // and more only when the index itself needs them.
                s.len() >= 6
                    && s.bytes().all(|b| b.is_ascii_digit())
                    && s.parse::<usize>()
                        .map(|index| s == format!("{index:06}"))
                        .unwrap_or(false)
            }),
            "import-selections" => parts[2]
                .strip_suffix(".json")
                .is_some_and(|s| hex_lower(s, 62)),
            _ => false,
        };
    if !valid {
        return Err(error("path", format!("unexpected carrier path: {path}")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn authenticated_content_collision_quarantines_both_values() {
        let mut map = BTreeMap::new();
        let mut quarantine = BTreeSet::new();
        assert_eq!(
            insert_authenticated(
                &mut map,
                &mut quarantine,
                "simulated digest",
                b"a",
                "collision"
            )
            .unwrap(),
            InsertOutcome::Added
        );
        assert!(
            insert_authenticated(
                &mut map,
                &mut quarantine,
                "simulated digest",
                b"b",
                "collision"
            )
            .is_err()
        );
        assert!(!map.contains_key("simulated digest"));
        assert!(quarantine.contains("simulated digest"));
        assert!(
            insert_authenticated(
                &mut map,
                &mut quarantine,
                "simulated digest",
                b"a",
                "collision"
            )
            .is_err()
        );
    }
}
