//! Canonical CBOR encoder/decoder primitives shared by all payloads.
//!
//! We don't use a serde derive layer because we need tight control
//! over the canonical byte sequence — in particular, minimal-length
//! integer encoding and no indefinite-length containers.  These
//! helpers write bytes directly per RFC 8949 §4.2 and read back via
//! [`ciborium::value::Value`] for decode.

use ciborium::value::Value;

use crate::error::{Result, SlotError};
use crate::wire::descriptor::Descriptor;

// ---- Writers ----

/// Push a CBOR "head" byte: major type in the top 3 bits, and the
/// "additional info" giving either the inline value (0..=23) or the
/// length of the extension bytes that follow (24 ⇒ 1 byte, 25 ⇒ 2,
/// 26 ⇒ 4, 27 ⇒ 8).
fn write_head(out: &mut Vec<u8>, major: u8, value: u64) {
    let major = (major & 0b111) << 5;
    if value <= 23 {
        out.push(major | value as u8);
    } else if value <= u8::MAX as u64 {
        out.push(major | 24);
        out.push(value as u8);
    } else if value <= u16::MAX as u64 {
        out.push(major | 25);
        out.extend_from_slice(&(value as u16).to_be_bytes());
    } else if value <= u32::MAX as u64 {
        out.push(major | 26);
        out.extend_from_slice(&(value as u32).to_be_bytes());
    } else {
        out.push(major | 27);
        out.extend_from_slice(&value.to_be_bytes());
    }
}

pub(crate) fn write_uint(out: &mut Vec<u8>, v: u64) {
    write_head(out, 0, v);
}

pub(crate) fn write_byte_string(out: &mut Vec<u8>, bytes: &[u8]) {
    write_head(out, 2, bytes.len() as u64);
    out.extend_from_slice(bytes);
}

pub(crate) fn write_array_header(out: &mut Vec<u8>, len: u64) {
    write_head(out, 4, len);
}

pub(crate) fn write_null(out: &mut Vec<u8>) {
    out.push(0xf6);
}

pub(crate) fn write_descriptor(out: &mut Vec<u8>, d: &Descriptor) {
    write_array_header(out, 2);
    write_uint(out, d.to_kind_byte() as u64);
    write_uint(out, d.position);
}

pub(crate) fn write_descriptor_array(out: &mut Vec<u8>, ds: &[Descriptor]) {
    write_array_header(out, ds.len() as u64);
    for d in ds {
        write_descriptor(out, d);
    }
}

// ---- Readers ----

pub(crate) fn read_top_level(bytes: &[u8]) -> Result<Value> {
    ciborium::de::from_reader(bytes)
        .map_err(|e| SlotError::Invariant(format!("cbor decode: {e}")))
}

pub(crate) fn as_array(v: &Value) -> Result<&[Value]> {
    match v {
        Value::Array(a) => Ok(a.as_slice()),
        other => Err(SlotError::Invariant(format!(
            "expected CBOR array, got {}",
            value_kind(other)
        ))),
    }
}

pub(crate) fn read_uint_helper(v: &Value) -> Result<u64> {
    as_uint(v)
}

pub(crate) fn as_uint(v: &Value) -> Result<u64> {
    match v {
        Value::Integer(i) => {
            let n: u128 = (*i).try_into().map_err(|_| {
                SlotError::Invariant("expected non-negative integer".into())
            })?;
            u64::try_from(n).map_err(|_| SlotError::Invariant("integer exceeds u64".into()))
        }
        other => Err(SlotError::Invariant(format!(
            "expected unsigned integer, got {}",
            value_kind(other)
        ))),
    }
}

pub(crate) fn as_bytes(v: &Value) -> Result<&[u8]> {
    match v {
        Value::Bytes(b) => Ok(b.as_slice()),
        other => Err(SlotError::Invariant(format!(
            "expected byte string, got {}",
            value_kind(other)
        ))),
    }
}

pub(crate) fn read_descriptor(v: &Value) -> Result<Descriptor> {
    let arr = as_array(v)?;
    if arr.len() != 2 {
        return Err(SlotError::Invariant(format!(
            "descriptor must be 2-element array, got {}",
            arr.len()
        )));
    }
    let kind_byte = as_uint(&arr[0])?;
    let position = as_uint(&arr[1])?;
    if kind_byte > u8::MAX as u64 {
        return Err(SlotError::Invariant(format!(
            "descriptor kind byte {kind_byte} exceeds u8"
        )));
    }
    Descriptor::from_kind_byte(kind_byte as u8, position)
}

pub(crate) fn read_descriptor_array(v: &Value) -> Result<Vec<Descriptor>> {
    let arr = as_array(v)?;
    arr.iter().map(read_descriptor).collect()
}

pub(crate) fn read_optional_descriptor(v: &Value) -> Result<Option<Descriptor>> {
    match v {
        Value::Null => Ok(None),
        other => Ok(Some(read_descriptor(other)?)),
    }
}

fn value_kind(v: &Value) -> &'static str {
    match v {
        Value::Integer(_) => "integer",
        Value::Bytes(_) => "bytes",
        Value::Text(_) => "text",
        Value::Array(_) => "array",
        Value::Map(_) => "map",
        Value::Tag(_, _) => "tag",
        Value::Bool(_) => "bool",
        Value::Null => "null",
        Value::Float(_) => "float",
        _ => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uint_encoding_is_canonical() {
        let mut b = Vec::new();
        write_uint(&mut b, 0);
        assert_eq!(b, vec![0x00]);
        b.clear();
        write_uint(&mut b, 23);
        assert_eq!(b, vec![0x17]);
        b.clear();
        write_uint(&mut b, 24);
        assert_eq!(b, vec![0x18, 0x18]);
        b.clear();
        write_uint(&mut b, 255);
        assert_eq!(b, vec![0x18, 0xff]);
        b.clear();
        write_uint(&mut b, 256);
        assert_eq!(b, vec![0x19, 0x01, 0x00]);
        b.clear();
        write_uint(&mut b, u64::MAX);
        assert_eq!(b, vec![0x1b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    }

    #[test]
    fn descriptor_byte_fixture() {
        // Object local, position 0: [0x00, 0x00] wrapped in array(2).
        // array(2) head = 0x82, uint(0) = 0x00, uint(0) = 0x00.
        let d = Descriptor::new(super::super::Direction::Local, super::super::Kind::Object, 0);
        let mut b = Vec::new();
        write_descriptor(&mut b, &d);
        assert_eq!(b, vec![0x82, 0x00, 0x00]);
    }

    #[test]
    fn descriptor_roundtrip_through_ciborium() {
        let d = Descriptor::new(super::super::Direction::Remote, super::super::Kind::Promise, 300);
        let mut b = Vec::new();
        write_descriptor(&mut b, &d);
        let v = read_top_level(&b).unwrap();
        let d2 = read_descriptor(&v).unwrap();
        assert_eq!(d, d2);
    }
}
