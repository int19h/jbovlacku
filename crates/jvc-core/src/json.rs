use crate::{Error, Result};
use serde::de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Number, Value};
use std::fmt;

pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
pub const MAX_DEPTH: usize = 32;

struct StrictValue(usize, usize);
impl<'de> DeserializeSeed<'de> for StrictValue {
    type Value = Value;
    fn deserialize<D: de::Deserializer<'de>>(self, d: D) -> std::result::Result<Value, D::Error> {
        d.deserialize_any(self)
    }
}
impl<'de> Visitor<'de> for StrictValue {
    type Value = Value;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a version 1 JSON value")
    }
    fn visit_bool<E: de::Error>(self, v: bool) -> std::result::Result<Value, E> {
        Ok(Value::Bool(v))
    }
    fn visit_unit<E: de::Error>(self) -> std::result::Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_str<E: de::Error>(self, v: &str) -> std::result::Result<Value, E> {
        Ok(Value::String(v.into()))
    }
    fn visit_string<E: de::Error>(self, v: String) -> std::result::Result<Value, E> {
        Ok(Value::String(v))
    }
    fn visit_i64<E: de::Error>(self, v: i64) -> std::result::Result<Value, E> {
        if v.unsigned_abs() > MAX_SAFE_INTEGER {
            return Err(E::custom("integer exceeds the safe range"));
        }
        Ok(Value::Number(Number::from(v)))
    }
    fn visit_u64<E: de::Error>(self, v: u64) -> std::result::Result<Value, E> {
        if v > MAX_SAFE_INTEGER {
            return Err(E::custom("integer exceeds the safe range"));
        }
        Ok(Value::Number(Number::from(v)))
    }
    fn visit_f64<E: de::Error>(self, _: f64) -> std::result::Result<Value, E> {
        Err(E::custom("number must use integer syntax"))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> std::result::Result<Value, A::Error> {
        if self.0 >= self.1 {
            return Err(de::Error::custom(format!(
                "JSON container depth exceeds {}",
                self.1
            )));
        }
        let mut out = Vec::new();
        while let Some(v) = a.next_element_seed(StrictValue(self.0 + 1, self.1))? {
            out.push(v);
        }
        Ok(Value::Array(out))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> std::result::Result<Value, A::Error> {
        if self.0 >= self.1 {
            return Err(de::Error::custom(format!(
                "JSON container depth exceeds {}",
                self.1
            )));
        }
        let mut out = Map::new();
        while let Some(key) = a.next_key::<String>()? {
            if out.contains_key(&key) {
                return Err(de::Error::custom("duplicate JSON object key"));
            }
            out.insert(key, a.next_value_seed(StrictValue(self.0 + 1, self.1))?);
        }
        Ok(Value::Object(out))
    }
}

pub fn parse_json(bytes: &[u8]) -> Result<Value> {
    parse_with_depth(bytes, MAX_DEPTH)
}

/// Parse an outer transport wrapper. Callers must enforce the enclosed object limits separately.
pub fn parse_transport_json(bytes: &[u8]) -> Result<Value> {
    parse_with_depth(bytes, MAX_DEPTH + 2)
}

fn parse_with_depth(bytes: &[u8], maximum: usize) -> Result<Value> {
    let normalized = normalize_numbers(bytes)?;
    let mut d = serde_json::Deserializer::from_slice(&normalized);
    let value = StrictValue(0, maximum)
        .deserialize(&mut d)
        .map_err(|e| Error::new("json", e.to_string()))?;
    d.end().map_err(|e| Error::new("json", e.to_string()))?;
    Ok(value)
}

pub fn canonicalize_json(bytes: &[u8]) -> Result<Vec<u8>> {
    canonical_value(&parse_json(bytes)?)
}

pub fn canonical_value(value: &Value) -> Result<Vec<u8>> {
    // Reparse public values to enforce the same limits as wire input.
    let source = serde_json::to_vec(value).map_err(|e| Error::new("json", e.to_string()))?;
    parse_json(&source)?;
    serde_json_canonicalizer::to_vec(value).map_err(|e| Error::new("json", e.to_string()))
}

pub fn parse_stored_json(bytes: &[u8]) -> Result<Value> {
    let value = parse_json(bytes)?;
    // parse_json already enforces the public Value limits.
    let canonical =
        serde_json_canonicalizer::to_vec(&value).map_err(|e| Error::new("json", e.to_string()))?;
    if canonical != bytes {
        return Err(Error::new(
            "canonical",
            "stored JSON bytes are not canonical",
        ));
    }
    Ok(value)
}

fn normalize_numbers(bytes: &[u8]) -> Result<Vec<u8>> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'"' {
            let start = at;
            at += 1;
            while at < bytes.len() {
                match bytes[at] {
                    b'\\' => {
                        at += 1;
                        if at < bytes.len() {
                            at += 1;
                        }
                    }
                    b'"' => {
                        at += 1;
                        break;
                    }
                    _ => at += 1,
                }
            }
            out.extend_from_slice(&bytes[start..at]);
        } else if bytes[at] == b'-' || bytes[at].is_ascii_digit() {
            let start = at;
            while at < bytes.len()
                && (bytes[at].is_ascii_digit()
                    || matches!(bytes[at], b'-' | b'+' | b'.' | b'e' | b'E'))
            {
                at += 1;
            }
            out.extend(normalize_number(&bytes[start..at])?);
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    Ok(out)
}

fn normalize_number(token: &[u8]) -> Result<Vec<u8>> {
    let error = || {
        Error::new(
            "number",
            "number must be an exact integer within the safe range",
        )
    };
    let mut at = 0;
    let negative = token.first() == Some(&b'-');
    if negative {
        at += 1;
    }
    let start = at;
    if token.get(at) == Some(&b'0') {
        at += 1;
    } else {
        if !token.get(at).is_some_and(|b| (b'1'..=b'9').contains(b)) {
            return Err(error());
        }
        while token.get(at).is_some_and(u8::is_ascii_digit) {
            at += 1;
        }
    }
    let mut digits = token[start..at].to_vec();
    let mut fractional = 0i64;
    if token.get(at) == Some(&b'.') {
        at += 1;
        let first = at;
        while token.get(at).is_some_and(u8::is_ascii_digit) {
            digits.push(token[at]);
            at += 1;
            fractional += 1;
        }
        if first == at {
            return Err(error());
        }
    }
    let mut exponent = 0i64;
    if matches!(token.get(at), Some(b'e' | b'E')) {
        at += 1;
        let minus = token.get(at) == Some(&b'-');
        if matches!(token.get(at), Some(b'+' | b'-')) {
            at += 1;
        }
        let first = at;
        while token.get(at).is_some_and(u8::is_ascii_digit) {
            exponent = (exponent * 10 + i64::from(token[at] - b'0')).min(1_000_000_000);
            at += 1;
        }
        if first == at {
            return Err(error());
        }
        if minus {
            exponent = -exponent;
        }
    }
    if at != token.len() {
        return Err(error());
    }
    let first_nonzero = digits.iter().position(|b| *b != b'0');
    let Some(first_nonzero) = first_nonzero else {
        return Ok(vec![b'0']);
    };
    digits.drain(..first_nonzero);
    let mut scale = exponent - fractional;
    while scale < 0 && digits.last() == Some(&b'0') {
        digits.pop();
        scale += 1;
    }
    if !(0..=16).contains(&scale) || digits.len() + scale as usize > 16 {
        return Err(error());
    }
    digits.extend(std::iter::repeat_n(b'0', scale as usize));
    let magnitude = std::str::from_utf8(&digits)
        .unwrap()
        .parse::<u64>()
        .map_err(|_| error())?;
    if magnitude > MAX_SAFE_INTEGER {
        return Err(error());
    }
    if negative {
        digits.insert(0, b'-');
    }
    Ok(digits)
}
