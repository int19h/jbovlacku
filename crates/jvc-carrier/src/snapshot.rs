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
        let events = self.envelope_stream()?;
        let bodies = self.retained_bodies();
        Ok(Manifest {
            version: 1,
            events: Inventory {
                count: self.events.len(),
                hash: hash_id("sha256:", b"", &events),
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
        for event in self.events.values() {
            bytes.extend(self.record_line(event)?);
        }
        Ok(bytes)
    }
    pub fn from_jsonl(bytes: &[u8]) -> Result<Self> {
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
            if line.is_empty() {
                return Err(error(
                    "record_blank",
                    format!("record line {} is empty", line_no + 1),
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
            let event = verify_envelope(&canonical_value(&record["envelope"])?)?;
            if snapshot.events.contains_key(event.id()) {
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
                snapshot.insert_body(&c.hash, &bytes)?;
            }
            snapshot.insert_verified(event)?;
        }
        Ok(snapshot)
    }
    pub fn to_files(&self) -> Result<BTreeMap<String, Vec<u8>>> {
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
            if values.len() > 1_000_000 {
                return Err(error(
                    "partition_limit",
                    "partition exceeds one million parts",
                ));
            }
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
        for (path, bytes) in files {
            if path.starts_with("records/") {
                if bytes.is_empty() || bytes.len() > PART_BYTES {
                    return Err(error(
                        "part_size",
                        format!("{path} is empty or exceeds 8 MiB"),
                    ));
                }
                let part = Self::from_jsonl(bytes)?;
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
            "records" => parts[2]
                .strip_suffix(".jsonl")
                .is_some_and(|s| s.len() == 6 && s.bytes().all(|b| b.is_ascii_digit())),
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
