use serde::de::{MapAccess, SeqAccess, Visitor};
use serde::ser::{SerializeMap, SerializeSeq};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Number, Value};
use std::cell::{Ref, RefCell};
use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::hash::{Hash, Hasher};
use std::rc::Rc;

#[derive(Clone, Copy, Debug)]
enum CompactNumber {
    Signed(i64),
    Unsigned(u64),
    Float(u64),
}

impl CompactNumber {
    fn from_serde(number: &Number) -> Self {
        if number.is_i64() {
            Self::Signed(number.as_i64().unwrap())
        } else if number.is_u64() {
            Self::Unsigned(number.as_u64().unwrap())
        } else {
            Self::Float(number.as_f64().unwrap().to_bits())
        }
    }

    fn as_i64(self) -> Option<i64> {
        match self {
            Self::Signed(value) => Some(value),
            Self::Unsigned(value) => i64::try_from(value).ok(),
            Self::Float(_) => None,
        }
    }

    fn as_u64(self) -> Option<u64> {
        match self {
            Self::Signed(value) => u64::try_from(value).ok(),
            Self::Unsigned(value) => Some(value),
            Self::Float(_) => None,
        }
    }
}

impl Serialize for CompactNumber {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match *self {
            Self::Signed(value) => serializer.serialize_i64(value),
            Self::Unsigned(value) => serializer.serialize_u64(value),
            Self::Float(bits) => serializer.serialize_f64(f64::from_bits(bits)),
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum ValueNode {
    Null,
    Bool(bool),
    Number(CompactNumber),
    String(u32),
    Array { start: u32, len: u32 },
    Object { start: u32, len: u32 },
}

#[derive(Clone, Copy, Debug)]
struct StringSegment {
    start: u32,
    len: u32,
}

pub(crate) type SharedArena = Rc<RefCell<RecordArena>>;

#[derive(Debug)]
pub(crate) struct RecordArena {
    values: Vec<ValueNode>,
    array_values: Vec<u32>,
    object_values: Vec<(u32, u32)>,
    strings: Vec<StringSegment>,
    string_bytes: Vec<u8>,
    string_hashes: HashMap<u64, Vec<u32>>,
}

impl Default for RecordArena {
    fn default() -> Self {
        Self {
            values: vec![ValueNode::Null],
            array_values: Vec::new(),
            object_values: Vec::new(),
            strings: Vec::new(),
            string_bytes: Vec::new(),
            string_hashes: HashMap::new(),
        }
    }
}

impl RecordArena {
    fn string(&self, handle: u32) -> &str {
        let segment = self.strings[handle as usize];
        let start = segment.start as usize;
        let end = start + segment.len as usize;
        std::str::from_utf8(&self.string_bytes[start..end]).unwrap()
    }

    fn intern(&mut self, value: &str) -> u32 {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        value.hash(&mut hasher);
        let hash = hasher.finish();
        if let Some(handles) = self.string_hashes.get(&hash) {
            for &handle in handles {
                if self.string(handle) == value {
                    return handle;
                }
            }
        }
        let handle =
            u32::try_from(self.strings.len()).expect("record arena string handle overflow");
        let start =
            u32::try_from(self.string_bytes.len()).expect("record arena string size overflow");
        let len = u32::try_from(value.len()).expect("record arena string length overflow");
        self.string_bytes.extend_from_slice(value.as_bytes());
        self.strings.push(StringSegment { start, len });
        self.string_hashes.entry(hash).or_default().push(handle);
        handle
    }

    fn push_value(&mut self, node: ValueNode) -> u32 {
        let handle = u32::try_from(self.values.len()).expect("record arena value handle overflow");
        self.values.push(node);
        handle
    }

    fn pack_serde(&mut self, value: &Value) -> u32 {
        match value {
            Value::Null => self.push_value(ValueNode::Null),
            Value::Bool(value) => self.push_value(ValueNode::Bool(*value)),
            Value::Number(number) => {
                self.push_value(ValueNode::Number(CompactNumber::from_serde(number)))
            }
            Value::String(value) => {
                let handle = self.intern(value);
                self.push_value(ValueNode::String(handle))
            }
            Value::Array(values) => {
                let handles = values
                    .iter()
                    .map(|value| self.pack_serde(value))
                    .collect::<Vec<_>>();
                let start = u32::try_from(self.array_values.len())
                    .expect("record arena array offset overflow");
                let len = u32::try_from(handles.len()).expect("record arena array length overflow");
                self.array_values.extend(handles);
                self.push_value(ValueNode::Array { start, len })
            }
            Value::Object(values) => {
                let handles = values
                    .iter()
                    .map(|(key, value)| {
                        let key = self.intern(key);
                        let value = self.pack_serde(value);
                        (key, value)
                    })
                    .collect::<Vec<_>>();
                let start = u32::try_from(self.object_values.len())
                    .expect("record arena object offset overflow");
                let len =
                    u32::try_from(handles.len()).expect("record arena object length overflow");
                self.object_values.extend(handles);
                self.push_value(ValueNode::Object { start, len })
            }
        }
    }

    fn allocated_bytes(&self) -> usize {
        self.values.capacity() * size_of::<ValueNode>()
            + self.array_values.capacity() * size_of::<u32>()
            + self.object_values.capacity() * size_of::<(u32, u32)>()
            + self.strings.capacity() * size_of::<StringSegment>()
            + self.string_bytes.capacity()
            + self.string_hashes.capacity() * size_of::<(u64, Vec<u32>)>()
            + self
                .string_hashes
                .values()
                .map(|handles| handles.capacity() * size_of::<u32>())
                .sum::<usize>()
    }
}

#[derive(Clone)]
pub struct CompactValue {
    arena: Rc<RefCell<RecordArena>>,
    root: u32,
}

impl CompactValue {
    pub(crate) fn from_arena(arena: Rc<RefCell<RecordArena>>, value: &Value) -> Self {
        let root = arena.borrow_mut().pack_serde(value);
        Self { arena, root }
    }

    pub fn view(&self) -> ValueView<'_> {
        ValueView {
            arena: self.arena.borrow(),
            handle: self.root,
        }
    }

    pub(crate) fn repack(&self, arena: &Rc<RefCell<RecordArena>>) -> Self {
        if Rc::ptr_eq(&self.arena, arena) {
            return self.clone();
        }
        let root = self.view().pack_into(arena);
        Self {
            arena: arena.clone(),
            root,
        }
    }

    pub(crate) fn allocated_bytes(&self) -> usize {
        self.arena.borrow().allocated_bytes()
    }

    pub(crate) fn arena_id(&self) -> usize {
        std::rc::Rc::as_ptr(&self.arena) as usize
    }
}

impl From<Value> for CompactValue {
    fn from(value: Value) -> Self {
        Self::from(&value)
    }
}

impl From<&Value> for CompactValue {
    fn from(value: &Value) -> Self {
        Self::from_arena(Rc::new(RefCell::new(RecordArena::default())), value)
    }
}

impl<'a> From<ValueView<'a>> for CompactValue {
    fn from(value: ValueView<'a>) -> Self {
        let arena = Rc::new(RefCell::new(RecordArena::default()));
        let root = value.pack_into(&arena);
        Self { arena, root }
    }
}

impl fmt::Debug for CompactValue {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.view(), formatter)
    }
}

impl fmt::Display for CompactValue {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.view(), formatter)
    }
}

impl PartialEq for CompactValue {
    fn eq(&self, other: &Self) -> bool {
        if Rc::ptr_eq(&self.arena, &other.arena) && self.root == other.root {
            return true;
        }
        self.view() == other.view()
    }
}

impl Serialize for CompactValue {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.view().serialize(serializer)
    }
}

#[derive(Clone, Debug)]
enum OwnedValue {
    Null,
    Bool(bool),
    Number(CompactNumber),
    String(String),
    Array(Vec<OwnedValue>),
    Object(BTreeMap<String, OwnedValue>),
}

impl OwnedValue {
    fn into_compact(self, arena: &Rc<RefCell<RecordArena>>) -> u32 {
        match self {
            Self::Null => arena.borrow_mut().push_value(ValueNode::Null),
            Self::Bool(value) => arena.borrow_mut().push_value(ValueNode::Bool(value)),
            Self::Number(number) => arena.borrow_mut().push_value(ValueNode::Number(number)),
            Self::String(value) => {
                let handle = arena.borrow_mut().intern(&value);
                arena.borrow_mut().push_value(ValueNode::String(handle))
            }
            Self::Array(values) => {
                let handles = values
                    .into_iter()
                    .map(|value| value.into_compact(arena))
                    .collect::<Vec<_>>();
                let mut arena = arena.borrow_mut();
                let start = u32::try_from(arena.array_values.len())
                    .expect("record arena array offset overflow");
                let len = u32::try_from(handles.len()).expect("record arena array length overflow");
                arena.array_values.extend(handles);
                arena.push_value(ValueNode::Array { start, len })
            }
            Self::Object(values) => {
                let handles = values
                    .into_iter()
                    .map(|(key, value)| {
                        let key = arena.borrow_mut().intern(&key);
                        let value = value.into_compact(arena);
                        (key, value)
                    })
                    .collect::<Vec<_>>();
                let mut arena = arena.borrow_mut();
                let start = u32::try_from(arena.object_values.len())
                    .expect("record arena object offset overflow");
                let len =
                    u32::try_from(handles.len()).expect("record arena object length overflow");
                arena.object_values.extend(handles);
                arena.push_value(ValueNode::Object { start, len })
            }
        }
    }
}

impl<'de> Deserialize<'de> for OwnedValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct OwnedVisitor;
        impl<'de> Visitor<'de> for OwnedVisitor {
            type Value = OwnedValue;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a JSON value")
            }

            fn visit_unit<E>(self) -> Result<Self::Value, E> {
                Ok(OwnedValue::Null)
            }

            fn visit_none<E>(self) -> Result<Self::Value, E> {
                Ok(OwnedValue::Null)
            }

            fn visit_some<D: Deserializer<'de>>(
                self,
                deserializer: D,
            ) -> Result<Self::Value, D::Error> {
                Deserialize::deserialize(deserializer)
            }

            fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
                Ok(OwnedValue::Bool(value))
            }

            fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
                Ok(OwnedValue::Number(CompactNumber::Signed(value)))
            }

            fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
                Ok(OwnedValue::Number(CompactNumber::Unsigned(value)))
            }

            fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E> {
                Ok(OwnedValue::Number(CompactNumber::Float(value.to_bits())))
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
                Ok(OwnedValue::String(value.into()))
            }

            fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
                Ok(OwnedValue::String(value))
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                let mut values = Vec::new();
                while let Some(value) = seq.next_element()? {
                    values.push(value);
                }
                Ok(OwnedValue::Array(values))
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut values = BTreeMap::new();
                while let Some((key, value)) = map.next_entry()? {
                    values.insert(key, value);
                }
                Ok(OwnedValue::Object(values))
            }
        }
        deserializer.deserialize_any(OwnedVisitor)
    }
}

impl<'de> Deserialize<'de> for CompactValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = OwnedValue::deserialize(deserializer)?;
        let arena = Rc::new(RefCell::new(RecordArena::default()));
        let root = value.into_compact(&arena);
        Ok(Self { arena, root })
    }
}

pub struct ValueView<'a> {
    arena: Ref<'a, RecordArena>,
    handle: u32,
}

impl<'a> ValueView<'a> {
    fn node(&self) -> &ValueNode {
        &self.arena.values[self.handle as usize]
    }

    fn child(&self, handle: u32) -> Self {
        Self {
            arena: Ref::clone(&self.arena),
            handle,
        }
    }

    pub fn get(&self, key: &str) -> Option<Self> {
        let ValueNode::Object { start, len } = *self.node() else {
            return None;
        };
        let start = start as usize;
        let pairs = &self.arena.object_values[start..start + len as usize];
        pairs
            .binary_search_by(|(candidate, _)| self.arena.string(*candidate).cmp(key))
            .ok()
            .map(|index| self.child(pairs[index].1))
    }

    pub fn index(&self, key: &str) -> Self {
        self.get(key).unwrap_or_else(|| self.child(0))
    }

    pub fn as_str(&self) -> Option<&str> {
        match self.node() {
            ValueNode::String(handle) => Some(self.arena.string(*handle)),
            _ => None,
        }
    }

    pub fn as_i64(&self) -> Option<i64> {
        match self.node() {
            ValueNode::Number(number) => number.as_i64(),
            _ => None,
        }
    }

    pub fn as_u64(&self) -> Option<u64> {
        match self.node() {
            ValueNode::Number(number) => number.as_u64(),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self.node() {
            ValueNode::Bool(value) => Some(*value),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<ArrayValues<'a>> {
        match *self.node() {
            ValueNode::Array { start, len } => Some(ArrayValues {
                arena: Ref::clone(&self.arena),
                start,
                len,
                position: 0,
            }),
            _ => None,
        }
    }

    pub fn for_each_child(&self, mut visit: impl FnMut(Self)) {
        match *self.node() {
            ValueNode::Array { .. } => {
                for child in self.as_array().unwrap() {
                    visit(child);
                }
            }
            ValueNode::Object { start, len } => {
                let start = start as usize;
                for (_, value) in &self.arena.object_values[start..start + len as usize] {
                    visit(self.child(*value));
                }
            }
            _ => {}
        }
    }

    pub fn is_null(&self) -> bool {
        matches!(self.node(), ValueNode::Null)
    }

    pub fn is_string(&self) -> bool {
        matches!(self.node(), ValueNode::String(_))
    }

    pub fn string_bytes(&self) -> u64 {
        match self.node() {
            ValueNode::Null | ValueNode::Bool(_) | ValueNode::Number(_) => 0,
            ValueNode::String(handle) => self.arena.string(*handle).len() as u64,
            ValueNode::Array { .. } => self
                .as_array()
                .unwrap()
                .map(|value| value.string_bytes())
                .sum(),
            ValueNode::Object { start, len } => {
                let start = *start as usize;
                self.arena.object_values[start..start + *len as usize]
                    .iter()
                    .map(|(key, value)| {
                        self.arena.string(*key).len() as u64 + self.child(*value).string_bytes()
                    })
                    .sum()
            }
        }
    }

    fn pack_into(&self, target: &Rc<RefCell<RecordArena>>) -> u32 {
        match *self.node() {
            ValueNode::Null => target.borrow_mut().push_value(ValueNode::Null),
            ValueNode::Bool(value) => target.borrow_mut().push_value(ValueNode::Bool(value)),
            ValueNode::Number(number) => target.borrow_mut().push_value(ValueNode::Number(number)),
            ValueNode::String(handle) => {
                let handle = target.borrow_mut().intern(self.arena.string(handle));
                target.borrow_mut().push_value(ValueNode::String(handle))
            }
            ValueNode::Array { .. } => {
                let handles = self
                    .as_array()
                    .unwrap()
                    .map(|value| value.pack_into(target))
                    .collect::<Vec<_>>();
                let mut target = target.borrow_mut();
                let start = u32::try_from(target.array_values.len())
                    .expect("record arena array offset overflow");
                let len = u32::try_from(handles.len()).expect("record arena array length overflow");
                target.array_values.extend(handles);
                target.push_value(ValueNode::Array { start, len })
            }
            ValueNode::Object { start, len } => {
                let start = start as usize;
                let pairs = self.arena.object_values[start..start + len as usize]
                    .iter()
                    .map(|(key, value)| (self.arena.string(*key), self.child(*value)))
                    .collect::<Vec<_>>();
                let handles = pairs
                    .into_iter()
                    .map(|(key, value)| {
                        let key = target.borrow_mut().intern(key);
                        let value = value.pack_into(target);
                        (key, value)
                    })
                    .collect::<Vec<_>>();
                let mut target = target.borrow_mut();
                let start = u32::try_from(target.object_values.len())
                    .expect("record arena object offset overflow");
                let len =
                    u32::try_from(handles.len()).expect("record arena object length overflow");
                target.object_values.extend(handles);
                target.push_value(ValueNode::Object { start, len })
            }
        }
    }
}

impl Clone for ValueView<'_> {
    fn clone(&self) -> Self {
        self.child(self.handle)
    }
}

impl fmt::Debug for ValueView<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, formatter)
    }
}

impl fmt::Display for ValueView<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let json = serde_json::to_string(self).map_err(|_| fmt::Error)?;
        formatter.write_str(&json)
    }
}

impl PartialEq for ValueView<'_> {
    fn eq(&self, other: &Self) -> bool {
        match (self.node(), other.node()) {
            (ValueNode::Null, ValueNode::Null) => true,
            (ValueNode::Bool(a), ValueNode::Bool(b)) => a == b,
            (ValueNode::Number(a), ValueNode::Number(b)) => {
                serde_json::to_string(a).unwrap() == serde_json::to_string(b).unwrap()
            }
            (ValueNode::String(a), ValueNode::String(b)) => {
                self.arena.string(*a) == other.arena.string(*b)
            }
            (ValueNode::Array { len: a, .. }, ValueNode::Array { len: b, .. }) if a == b => self
                .as_array()
                .unwrap()
                .zip(other.as_array().unwrap())
                .all(|(a, b)| a == b),
            (ValueNode::Object { len: a, .. }, ValueNode::Object { len: b, .. }) if a == b => {
                let pairs = |value: &Self| {
                    let ValueNode::Object { start, len } = *value.node() else {
                        unreachable!()
                    };
                    let start = start as usize;
                    value.arena.object_values[start..start + len as usize]
                        .iter()
                        .map(|(key, child)| {
                            (value.arena.string(*key).to_owned(), value.child(*child))
                        })
                        .collect::<Vec<_>>()
                };
                pairs(self)
                    .into_iter()
                    .zip(pairs(other))
                    .all(|((ak, av), (bk, bv))| ak == bk && av == bv)
            }
            _ => false,
        }
    }
}

impl PartialEq<&str> for ValueView<'_> {
    fn eq(&self, other: &&str) -> bool {
        self.as_str() == Some(*other)
    }
}

impl PartialEq<ValueView<'_>> for &str {
    fn eq(&self, other: &ValueView<'_>) -> bool {
        other == self
    }
}

impl Serialize for ValueView<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match *self.node() {
            ValueNode::Null => serializer.serialize_unit(),
            ValueNode::Bool(value) => serializer.serialize_bool(value),
            ValueNode::Number(number) => number.serialize(serializer),
            ValueNode::String(handle) => serializer.serialize_str(self.arena.string(handle)),
            ValueNode::Array { .. } => {
                let values = self.as_array().unwrap();
                let mut sequence = serializer.serialize_seq(Some(values.len()))?;
                for value in values {
                    sequence.serialize_element(&value)?;
                }
                sequence.end()
            }
            ValueNode::Object { start, len } => {
                let start = start as usize;
                let pairs = &self.arena.object_values[start..start + len as usize];
                let mut map = serializer.serialize_map(Some(pairs.len()))?;
                for (key, value) in pairs {
                    map.serialize_entry(self.arena.string(*key), &self.child(*value))?;
                }
                map.end()
            }
        }
    }
}

pub struct ArrayValues<'a> {
    arena: Ref<'a, RecordArena>,
    start: u32,
    len: u32,
    position: u32,
}

impl ArrayValues<'_> {
    pub fn len(&self) -> usize {
        (self.len - self.position) as usize
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl<'a> Iterator for ArrayValues<'a> {
    type Item = ValueView<'a>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.position == self.len {
            return None;
        }
        let index = self.start as usize + self.position as usize;
        self.position += 1;
        Some(ValueView {
            arena: Ref::clone(&self.arena),
            handle: self.arena.array_values[index],
        })
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        (self.len(), Some(self.len()))
    }
}

impl ExactSizeIterator for ArrayValues<'_> {}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn round_trip(value: Value) {
        let expected = serde_json::to_vec(&value).unwrap();
        let compact = CompactValue::from(&value);
        let encoded = serde_json::to_vec(&compact).unwrap();
        assert_eq!(encoded, expected);
        let decoded: CompactValue = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(serde_json::to_vec(&decoded).unwrap(), encoded);
        assert_eq!(compact, decoded);
    }

    #[test]
    fn accepted_number_forms_and_unicode_round_trip() {
        for token in [
            "0",
            "-0",
            "1",
            "-1",
            "9007199254740991",
            "-9007199254740991",
            "1.0",
            "1.00e0",
            "1e3",
            "100e-2",
            "0.0001e4",
            "-2.5e1",
        ] {
            let value = jvc_core::parse_json(token.as_bytes()).unwrap();
            round_trip(value);
        }
        round_trip(json!({
            "ascii": "plain",
            "combining": "e\u{301}",
            "composed": "é",
            "cjk": "汉字",
            "emoji": "😀",
            "escaped": "\u{0}\n\t\"\\",
            "absent": null,
            "nested": [true, false, null, {"number": 1}]
        }));
    }

    #[test]
    fn arbitrary_valid_values_round_trip() {
        fn value(seed: &mut u64, depth: usize) -> Value {
            *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            let kind = (*seed >> 32) % if depth == 0 { 6 } else { 8 };
            match kind {
                0 => Value::Null,
                1 => Value::Bool(*seed & 1 == 0),
                2 => json!((*seed as i64 % 1_000_000) - 500_000),
                3 => json!(*seed % 1_000_000),
                4 => json!(format!("text-{}-é-😀", *seed)),
                5 => json!((*seed as f64 / 1024.0) + 0.25),
                6 => Value::Array((0..*seed % 5).map(|_| value(seed, depth - 1)).collect()),
                _ => Value::Object(
                    (0..*seed % 5)
                        .map(|index| (format!("key-{index}"), value(seed, depth - 1)))
                        .collect(),
                ),
            }
        }
        let mut seed = 42;
        for _ in 0..256 {
            round_trip(value(&mut seed, 4));
        }
    }

    #[test]
    fn absent_and_null_are_distinct_and_shared_strings_have_one_copy() {
        let compact = CompactValue::from(&json!({
            "present": null,
            "repeat": "same",
            "nested": {"repeat": "same"}
        }));
        assert!(compact.view().get("absent").is_none());
        assert!(compact.view().get("present").unwrap().is_null());
        assert_eq!(compact.arena.borrow().strings.len(), 4);
        assert_eq!(compact.view().index("absent").as_str(), None);
    }

    #[test]
    fn malformed_actions_keep_their_generic_form() {
        round_trip(json!({
            "kind": "judgment.set",
            "target": null,
            "value": ["bless", 1.0, {"unexpected": true}],
            "extra": {"present": null}
        }));
    }

    #[test]
    fn signed_malformed_action_and_present_null_keep_host_bytes() {
        let body = json!({"present":null,"nested":{"text":"e\u{301}"}});
        let body_bytes = jvc_core::canonical_value(&body).unwrap();
        let signed = jvc_core::sign_header(
            &[19; 32],
            jvc_core::Header {
                version: 1,
                issuer: jvc_core::identity_from_seed(&[19; 32]),
                previous: Vec::new(),
                nonce: "19".repeat(16),
                action: json!({
                    "kind":"judgment.set",
                    "target":null,
                    "value":["bless",1],
                    "extra":{"present":null}
                }),
                content: Some(jvc_core::body_descriptor(&body_bytes).unwrap()),
            },
        )
        .unwrap();
        let event = jvc_core::verify_envelope(&signed.canonical_envelope().unwrap()).unwrap();
        assert!(jvc_core::validate_action(event.header()).is_err());
        let availability = jvc_core::inspect_host_stored_body(event.header(), Some(&body_bytes));
        let (record, ()) = crate::HostVerifiedRecord::extract_with(
            event.id(),
            event.header(),
            availability,
            |_| (),
        );
        let encoded = serde_json::to_vec(&record).unwrap();
        let decoded: crate::HostVerifiedRecord = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(serde_json::to_vec(&decoded).unwrap(), encoded);
        assert_eq!(decoded, record);
    }

    #[test]
    fn repack_preserves_json_and_shares_the_target_arena() {
        let first = CompactValue::from(&json!({"word":"same","value":1}));
        let second = CompactValue::from(&json!({"word":"same","value":null}));
        let target = Rc::new(RefCell::new(RecordArena::default()));
        let first = first.repack(&target);
        let second = second.repack(&target);
        assert_eq!(first.view().index("word"), second.view().index("word"));
        assert_eq!(target.borrow().strings.len(), 3);
        assert_eq!(
            serde_json::to_vec(&first).unwrap(),
            br#"{"value":1,"word":"same"}"#
        );
        assert!(first.allocated_bytes() > 0);
    }
}
