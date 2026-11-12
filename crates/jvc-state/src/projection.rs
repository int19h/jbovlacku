use super::*;
use jvc_core::{Error, Result};

pub const PROJECTION_ROW_VERSION: u8 = 1;
const MAX_ROW_BYTES: usize = 1024 * 1024;
const KINDS: &[&str] = &[
    "identity.merge",
    "identity.profile",
    "identity.transfer",
    "identity.accept",
    "identity.compromise",
    "definition.publish",
    "rafsi.publish",
    "judgment.set",
    "status.set",
    "trust.set",
    "import.status",
    "report.set",
    "account.set",
    "account.observe",
    "bridge.set",
    "view.publish",
];

#[derive(Clone, Debug, PartialEq)]
pub struct ProjectionRow {
    pub(crate) node: graph::Node,
}

impl ProjectionRow {
    pub fn extract(event: &VerifiedEnvelope, body: Option<&[u8]>) -> Self {
        Self::from_availability(event, inspect_body(event, body))
    }

    pub fn from_availability(event: &VerifiedEnvelope, availability: BodyAvailability) -> Self {
        let (node, ()) = graph::Node::from_parts(event.id(), event.header(), availability, |_| ());
        Self { node }
    }

    pub fn id(&self) -> &str {
        &self.node.id
    }

    pub fn body_hash(&self) -> Option<&str> {
        self.node.body_hash.as_deref()
    }

    pub fn apply_body_retention(&mut self, retained: bool) {
        if !retained && self.node.body_hash.is_some() {
            self.node.body = None;
            self.node.body_label = "missing".into();
        }
    }

    pub fn encode(&self) -> Result<Vec<u8>> {
        let node = &self.node;
        let id = digest(&node.id, "jve1:")?;
        let issuer = digest(&node.issuer, "ed25519:")?;
        let action = serde_json::to_vec(&node.action)
            .map_err(|error| Error::new("projection_row", error.to_string()))?;
        let body = node
            .body
            .as_ref()
            .map(serde_json::to_vec)
            .transpose()
            .map_err(|error| Error::new("projection_row", error.to_string()))?;
        let (body_code, invalid_reason) = match node.body_label.as_str() {
            "absent" => (0, None),
            "missing" => (1, None),
            "valid" => (2, None),
            label => (
                if node.body_hash.is_some() { 3 } else { 4 },
                Some(
                    label
                        .strip_prefix("invalid:")
                        .ok_or_else(|| Error::new("projection_row", "invalid body label"))?,
                ),
            ),
        };
        if body_code == 2 && body.is_none() || body_code != 2 && body.is_some() {
            return Err(Error::new(
                "projection_row",
                "body availability does not match",
            ));
        }
        let hash_valid = match body_code {
            0 | 4 => node.body_hash.is_none(),
            _ => node.body_hash.is_some(),
        };
        if !hash_valid {
            return Err(Error::new(
                "projection_row",
                "body hash does not match availability",
            ));
        }
        let kind = KINDS.iter().position(|kind| *kind == node.kind);
        let previous = node
            .previous
            .iter()
            .map(|id| digest(id, "jve1:"))
            .collect::<Result<Vec<_>>>()?;
        if previous.len() > 64 {
            return Err(Error::new(
                "projection_row",
                "too many previous identifiers",
            ));
        }
        let body_hash = node
            .body_hash
            .as_deref()
            .map(|hash| digest(hash, "sha256:"))
            .transpose()?;
        let mut output = Vec::new();
        output.push(PROJECTION_ROW_VERSION);
        output.extend(id);
        output.extend(issuer);
        output.push(previous.len() as u8);
        for id in previous {
            output.extend(id);
        }
        output.push(kind.map_or(0, |index| index as u8 + 1));
        if kind.is_none() {
            put_bytes(&mut output, node.kind.as_bytes())?;
        }
        output.push(u8::from(node.semantic));
        output.push(body_code);
        if let Some(reason) = invalid_reason {
            put_bytes(&mut output, reason.as_bytes())?;
        }
        if let Some(hash) = body_hash {
            output.extend(hash);
        }
        put_bytes(&mut output, &action)?;
        if let Some(body) = body {
            put_bytes(&mut output, &body)?;
        }
        if output.len() > MAX_ROW_BYTES {
            return Err(Error::new("projection_row", "row exceeds 1 MiB"));
        }
        Ok(output)
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_ROW_BYTES {
            return Err(Error::new("projection_row", "row exceeds 1 MiB"));
        }
        let mut input = Input { bytes };
        if input.byte()? != PROJECTION_ROW_VERSION {
            return Err(Error::new("projection_row", "unsupported row version"));
        }
        let id = text_id("jve1:", input.array::<32>()?);
        let issuer = text_id("ed25519:", input.array::<32>()?);
        let previous_count = input.byte()? as usize;
        if previous_count > 64 {
            return Err(Error::new(
                "projection_row",
                "too many previous identifiers",
            ));
        }
        let mut previous = Vec::with_capacity(previous_count);
        for _ in 0..previous_count {
            previous.push(text_id("jve1:", input.array::<32>()?));
        }
        if previous.windows(2).any(|pair| pair[0] >= pair[1]) {
            return Err(Error::new(
                "projection_row",
                "previous identifiers are not in order",
            ));
        }
        let kind_code = input.byte()?;
        let kind = if kind_code == 0 {
            input.text()?.to_owned()
        } else {
            KINDS
                .get(kind_code as usize - 1)
                .ok_or_else(|| Error::new("projection_row", "unknown kind code"))?
                .to_string()
        };
        let semantic = match input.byte()? {
            0 => false,
            1 => true,
            _ => return Err(Error::new("projection_row", "invalid semantic flag")),
        };
        let body_code = input.byte()?;
        if body_code > 4 {
            return Err(Error::new("projection_row", "unknown body code"));
        }
        let invalid_reason = if body_code >= 3 {
            Some(input.text()?.to_owned())
        } else {
            None
        };
        let body_hash = if matches!(body_code, 0 | 4) {
            None
        } else {
            Some(text_id("sha256:", input.array::<32>()?))
        };
        let action_bytes = input.bytes()?;
        let action: CompactValue = serde_json::from_slice(action_bytes)
            .map_err(|error| Error::new("projection_row", error.to_string()))?;
        let body = if body_code == 2 {
            let body_bytes = input.bytes()?;
            Some(
                serde_json::from_slice(body_bytes)
                    .map_err(|error| Error::new("projection_row", error.to_string()))?,
            )
        } else {
            None
        };
        if !input.bytes.is_empty() {
            return Err(Error::new("projection_row", "trailing row bytes"));
        }
        let expected_kind = action.view().index("kind").as_str().map(str::to_owned);
        if kind != expected_kind.as_deref().unwrap_or_default() {
            return Err(Error::new("projection_row", "kind does not match action"));
        }
        let body_label = match body_code {
            0 => "absent".into(),
            1 => "missing".into(),
            2 => "valid".into(),
            3 | 4 => format!("invalid:{}", invalid_reason.unwrap()),
            _ => unreachable!(),
        };
        Ok(Self {
            node: graph::Node {
                id,
                issuer,
                previous,
                action,
                kind,
                semantic,
                body_hash,
                body,
                body_label,
            },
        })
    }
}

fn digest(value: &str, prefix: &str) -> Result<[u8; 32]> {
    if !jvc_core::valid_id(value, prefix) {
        return Err(Error::new("projection_row", "invalid digest identifier"));
    }
    hex::decode(&value[prefix.len()..])
        .map_err(|error| Error::new("projection_row", error.to_string()))?
        .try_into()
        .map_err(|_| Error::new("projection_row", "invalid digest length"))
}

fn text_id(prefix: &str, bytes: [u8; 32]) -> String {
    format!("{prefix}{}", hex::encode(bytes))
}

fn put_bytes(output: &mut Vec<u8>, bytes: &[u8]) -> Result<()> {
    let length = u32::try_from(bytes.len())
        .map_err(|_| Error::new("projection_row", "value exceeds the row limit"))?;
    output.extend(length.to_le_bytes());
    output.extend(bytes);
    Ok(())
}

struct Input<'a> {
    bytes: &'a [u8],
}

impl Input<'_> {
    fn take(&mut self, length: usize) -> Result<&[u8]> {
        let bytes = self
            .bytes
            .get(..length)
            .ok_or_else(|| Error::new("projection_row", "truncated row"))?;
        self.bytes = &self.bytes[length..];
        Ok(bytes)
    }

    fn byte(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }

    fn array<const N: usize>(&mut self) -> Result<[u8; N]> {
        Ok(self.take(N)?.try_into().unwrap())
    }

    fn bytes(&mut self) -> Result<&[u8]> {
        let length = u32::from_le_bytes(self.array::<4>()?) as usize;
        self.take(length)
    }

    fn text(&mut self) -> Result<&str> {
        std::str::from_utf8(self.bytes()?)
            .map_err(|error| Error::new("projection_row", error.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row() -> ProjectionRow {
        ProjectionRow {
            node: graph::Node {
                id: text_id("jve1:", [1; 32]),
                issuer: text_id("ed25519:", [2; 32]),
                previous: vec![text_id("jve1:", [3; 32])],
                action: CompactValue::from(&json!({
                    "kind": "definition.publish",
                    "word": "jvw1:test",
                    "number": -0.0,
                    "nested": [null, true, "same", {"repeat": "same"}]
                })),
                kind: "definition.publish".into(),
                semantic: false,
                body_hash: Some(text_id("sha256:", [4; 32])),
                body: Some(CompactValue::from(&json!({"legacy": null}))),
                body_label: "valid".into(),
            },
        }
    }

    #[test]
    fn round_trip_preserves_the_complete_node() {
        let row = row();
        let encoded = row.encode().unwrap();
        assert_eq!(encoded[0], PROJECTION_ROW_VERSION);
        assert_eq!(ProjectionRow::decode(&encoded).unwrap(), row);
    }

    #[test]
    fn body_retention_matches_missing_original_input() {
        let mut row = row();
        let action = row.node.action.clone();
        let hash = row.node.body_hash.clone();
        row.apply_body_retention(false);
        assert!(row.node.body.is_none());
        assert_eq!(row.node.body_label, "missing");
        assert_eq!(row.node.body_hash, hash);
        assert_eq!(row.node.action, action);
        assert_eq!(ProjectionRow::decode(&row.encode().unwrap()).unwrap(), row);
        row.apply_body_retention(true);
        assert_eq!(row.node.body_label, "missing");
    }

    #[test]
    fn other_kinds_and_invalid_bodies_round_trip() {
        let mut row = row();
        row.node.kind = "future.action".into();
        row.node.action = CompactValue::from(&json!({"kind": "future.action"}));
        row.node.body = None;
        row.node.body_hash = None;
        row.node.body_label = "invalid:future body".into();
        let encoded = row.encode().unwrap();
        assert_eq!(ProjectionRow::decode(&encoded).unwrap(), row);
    }

    #[test]
    fn encoder_enforces_the_decoder_size_limit() {
        let mut row = row();
        row.node.body = None;
        row.node.body_hash = None;
        row.node.body_label = format!("invalid:{}", "x".repeat(MAX_ROW_BYTES));
        let error = row.encode().unwrap_err();
        assert_eq!(error.code, "projection_row");
        assert_eq!(error.message, "row exceeds 1 MiB");
    }

    #[test]
    fn decoder_rejects_damage_and_random_bytes_without_panicking() {
        let encoded = row().encode().unwrap();
        for end in 0..encoded.len() {
            let _ = ProjectionRow::decode(&encoded[..end]);
        }
        for index in 0..encoded.len() {
            let mut changed = encoded.clone();
            changed[index] ^= 0x80;
            let _ = ProjectionRow::decode(&changed);
        }
        let mut seed = 0x4d595df4d0f33173u64;
        for length in 0..2048 {
            let mut bytes = encoded[..length.min(137)].to_vec();
            while bytes.len() < length {
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
                bytes.push(seed as u8);
            }
            let _ = ProjectionRow::decode(&bytes);
        }
    }
}
