//! The value encoding of the Durable Object host imports (design
//! `designs/thixotrope-wasm-worker.md` § 4.1), as pure functions over byte
//! slices. The import block itself (`host_exec`, `host_take`) is `unsafe`
//! and stays in the wasm shell, which encodes a statement's parameters with
//! [`encode_params`] and decodes the host's answer with [`decode_rows`].
//! [`decode_params`] and [`encode_rows`] are the host's half, for a host
//! written in Rust and for tests.
//!
//! Both directions, little-endian:
//!
//! - a value is one tag byte then its payload: [`TAG_NULL`] null,
//!   [`TAG_NUMBER`] an f64 (8 bytes), [`TAG_BLOB`] a blob (u32 length, the
//!   bytes), [`TAG_TEXT`] text (u32 length, UTF-8);
//! - the parameters of a call are a sequence of values;
//! - a result is a u32 row count, then per row a u32 column count and that
//!   many values.
//!
//! The Durable Object's `sql.exec` binds and returns JavaScript numbers, so
//! an integer travels as a double. The mapping is checked both ways: an
//! integer that no double represents exactly is refused on encode
//! ([`StoreError::Unsupported`], deterministic), and a double that is not an
//! integer, or lies outside the `i64` range, is refused on decode. The store
//! itself only binds `u32`s and section lengths, all exact.
//!
//! A malformed encoding (a truncation, an unknown tag, trailing bytes, text
//! that is not UTF-8, a non-integer number) is
//! [`SnapshotError::Corrupt`], classified poisoned: an answer the host
//! should never produce, which a retry would not change.

use ironhorse_snapshot::store::StoreError;
use ironhorse_snapshot::SnapshotError;

use crate::Value;

pub const TAG_NULL: u8 = 0;
pub const TAG_NUMBER: u8 = 1;
pub const TAG_BLOB: u8 = 2;
pub const TAG_TEXT: u8 = 3;

/// 2^63, the first double past `i64::MAX`.
const TWO_POW_63: f64 = 9_223_372_036_854_775_808.0;

fn malformed(message: &'static str) -> StoreError {
    StoreError::Snapshot(SnapshotError::Corrupt(message))
}

/// The double that carries `n`, if one represents it exactly.
pub fn integer_to_f64(n: i64) -> Result<f64, StoreError> {
    let x = n as f64;
    // `x as i64` saturates, so `i64::MAX`, which rounds up to 2^63, would
    // pass the round trip without the range test.
    if x >= TWO_POW_63 || x as i64 != n {
        return Err(StoreError::Unsupported(
            "do wire: an integer no double represents exactly",
        ));
    }
    Ok(x)
}

/// The integer a double carries: finite, integral and inside the `i64` range.
pub fn f64_to_integer(x: f64) -> Result<i64, StoreError> {
    if !x.is_finite() || x.fract() != 0.0 || !(-TWO_POW_63..TWO_POW_63).contains(&x) {
        return Err(malformed("do wire: a number that is not an integer"));
    }
    Ok(x as i64)
}

fn length(len: usize) -> Result<[u8; 4], StoreError> {
    u32::try_from(len)
        .map(u32::to_le_bytes)
        .map_err(|_| StoreError::Unsupported("do wire: a length over u32"))
}

fn encode_value(out: &mut Vec<u8>, value: &Value) -> Result<(), StoreError> {
    match value {
        Value::Null => out.push(TAG_NULL),
        Value::Integer(n) => {
            out.push(TAG_NUMBER);
            out.extend_from_slice(&integer_to_f64(*n)?.to_le_bytes());
        }
        Value::Blob(bytes) => {
            out.push(TAG_BLOB);
            out.extend_from_slice(&length(bytes.len())?);
            out.extend_from_slice(bytes);
        }
        Value::Text(text) => {
            out.push(TAG_TEXT);
            out.extend_from_slice(&length(text.len())?);
            out.extend_from_slice(text.as_bytes());
        }
    }
    Ok(())
}

/// A statement's parameters, as the guest hands them to `host_exec`.
pub fn encode_params(params: &[Value]) -> Result<Vec<u8>, StoreError> {
    let mut out = Vec::new();
    for value in params {
        encode_value(&mut out, value)?;
    }
    Ok(out)
}

/// A statement's rows, as the host answers them.
pub fn encode_rows(rows: &[Vec<Value>]) -> Result<Vec<u8>, StoreError> {
    let mut out = Vec::new();
    out.extend_from_slice(&length(rows.len())?);
    for row in rows {
        out.extend_from_slice(&length(row.len())?);
        for value in row {
            encode_value(&mut out, value)?;
        }
    }
    Ok(out)
}

struct Reader<'a> {
    rest: &'a [u8],
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], StoreError> {
        if n > self.rest.len() {
            return Err(malformed("do wire: truncated"));
        }
        let (taken, rest) = self.rest.split_at(n);
        self.rest = rest;
        Ok(taken)
    }

    fn u32(&mut self) -> Result<u32, StoreError> {
        let b = self.take(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn value(&mut self) -> Result<Value, StoreError> {
        let tag = self.take(1)?[0];
        match tag {
            TAG_NULL => Ok(Value::Null),
            TAG_NUMBER => {
                let b = self.take(8)?;
                let x = f64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]);
                Ok(Value::Integer(f64_to_integer(x)?))
            }
            TAG_BLOB => {
                let len = self.u32()? as usize;
                Ok(Value::Blob(self.take(len)?.to_vec()))
            }
            TAG_TEXT => {
                let len = self.u32()? as usize;
                String::from_utf8(self.take(len)?.to_vec())
                    .map(Value::Text)
                    .map_err(|_| malformed("do wire: text is not UTF-8"))
            }
            _ => Err(malformed("do wire: unknown value tag")),
        }
    }

    fn finish(self) -> Result<(), StoreError> {
        if !self.rest.is_empty() {
            return Err(malformed("do wire: trailing bytes"));
        }
        Ok(())
    }
}

/// A statement's parameters, as the host receives them.
pub fn decode_params(bytes: &[u8]) -> Result<Vec<Value>, StoreError> {
    let mut reader = Reader { rest: bytes };
    let mut out = Vec::new();
    while !reader.rest.is_empty() {
        out.push(reader.value()?);
    }
    Ok(out)
}

/// A statement's rows, as the guest receives them from `host_take`.
pub fn decode_rows(bytes: &[u8]) -> Result<Vec<Vec<Value>>, StoreError> {
    let mut reader = Reader { rest: bytes };
    let rows = reader.u32()? as usize;
    // A row is at least its 4-byte column count and a value at least its
    // tag, so the counts cannot reserve more than the bytes could hold.
    let mut out = Vec::with_capacity(rows.min(reader.rest.len() / 4));
    for _ in 0..rows {
        let columns = reader.u32()? as usize;
        let mut row = Vec::with_capacity(columns.min(reader.rest.len()));
        for _ in 0..columns {
            row.push(reader.value()?);
        }
        out.push(row);
    }
    reader.finish()?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ironhorse_snapshot::store::StoreFailure;

    fn sample() -> Vec<Vec<Value>> {
        vec![
            vec![
                Value::Null,
                Value::Integer(0),
                Value::Integer(-1),
                Value::Integer(u32::MAX.into()),
                Value::Integer(1 << 53),
                Value::Integer(1 << 60),
                Value::Integer(i64::MIN),
            ],
            vec![],
            vec![
                Value::Blob(vec![]),
                Value::Blob(vec![0, 1, 2, 255]),
                Value::Text(String::new()),
                Value::Text("é\u{1F600}".into()),
            ],
        ]
    }

    fn poisoned(result: Result<impl std::fmt::Debug, StoreError>, message: &str) {
        let error = result.expect_err("refused");
        assert_eq!(
            error,
            StoreError::Snapshot(SnapshotError::Corrupt(match message {
                "truncated" => "do wire: truncated",
                "tag" => "do wire: unknown value tag",
                "trailing" => "do wire: trailing bytes",
                "utf8" => "do wire: text is not UTF-8",
                "number" => "do wire: a number that is not an integer",
                other => panic!("no message {other}"),
            }))
        );
        assert_eq!(error.classify(), StoreFailure::Poisoned);
    }

    #[test]
    fn rows_and_params_round_trip() {
        let rows = sample();
        assert_eq!(decode_rows(&encode_rows(&rows).unwrap()).unwrap(), rows);
        let params: Vec<Value> = rows.concat();
        assert_eq!(
            decode_params(&encode_params(&params).unwrap()).unwrap(),
            params
        );
        assert_eq!(decode_params(&[]).unwrap(), vec![]);
        assert_eq!(
            decode_rows(&encode_rows(&[]).unwrap()).unwrap(),
            vec![] as Vec<Vec<Value>>
        );
    }

    #[test]
    fn the_encoding_is_the_documented_one() {
        let bytes = encode_params(&[
            Value::Null,
            Value::Integer(7),
            Value::Blob(vec![9]),
            Value::Text("a".into()),
        ])
        .unwrap();
        let mut expected = vec![TAG_NULL, TAG_NUMBER];
        expected.extend_from_slice(&7f64.to_le_bytes());
        expected.extend_from_slice(&[TAG_BLOB, 1, 0, 0, 0, 9, TAG_TEXT, 1, 0, 0, 0, b'a']);
        assert_eq!(bytes, expected);
        assert_eq!(
            encode_rows(&[vec![Value::Null]]).unwrap(),
            vec![1, 0, 0, 0, 1, 0, 0, 0, TAG_NULL]
        );
    }

    #[test]
    fn every_truncation_is_refused() {
        let bytes = encode_rows(&sample()).unwrap();
        for cut in 0..bytes.len() {
            poisoned(decode_rows(&bytes[..cut]), "truncated");
        }
        let params = encode_params(&sample().concat()).unwrap();
        // A cut on a value boundary is a shorter, well-formed sequence; every
        // other cut is truncated.
        let mut boundaries = vec![0];
        for value in sample().concat() {
            let last = *boundaries.last().unwrap();
            boundaries.push(last + encode_params(&[value]).unwrap().len());
        }
        for cut in 0..params.len() {
            if !boundaries.contains(&cut) {
                poisoned(decode_params(&params[..cut]), "truncated");
            }
        }
    }

    #[test]
    fn unknown_tags_are_refused() {
        for tag in 4..=u8::MAX {
            poisoned(decode_params(&[tag]), "tag");
            poisoned(decode_rows(&[1, 0, 0, 0, 1, 0, 0, 0, tag]), "tag");
        }
    }

    #[test]
    fn trailing_bytes_are_refused() {
        let mut bytes = encode_rows(&sample()).unwrap();
        bytes.push(0);
        poisoned(decode_rows(&bytes), "trailing");
        poisoned(decode_rows(&[0, 0, 0, 0, TAG_NULL]), "trailing");
    }

    #[test]
    fn text_that_is_not_utf8_is_refused() {
        poisoned(decode_params(&[TAG_TEXT, 1, 0, 0, 0, 0xff]), "utf8");
        // An unpaired surrogate in CESU-8 form.
        poisoned(
            decode_rows(&[
                1, 0, 0, 0, 1, 0, 0, 0, TAG_TEXT, 3, 0, 0, 0, 0xed, 0xa0, 0x80,
            ]),
            "utf8",
        );
    }

    #[test]
    fn a_number_must_carry_an_integer() {
        for x in [
            0.5,
            -1.25,
            f64::NAN,
            f64::INFINITY,
            f64::NEG_INFINITY,
            TWO_POW_63,
            -TWO_POW_63 * 2.0,
            1e300,
        ] {
            let mut bytes = vec![TAG_NUMBER];
            bytes.extend_from_slice(&x.to_le_bytes());
            poisoned(decode_params(&bytes), "number");
        }
        assert_eq!(f64_to_integer(-0.0).unwrap(), 0);
        assert_eq!(f64_to_integer(-TWO_POW_63).unwrap(), i64::MIN);
        assert_eq!(f64_to_integer(9_007_199_254_740_993.0).unwrap(), 1 << 53);
    }

    #[test]
    fn an_integer_must_be_exact_as_a_double() {
        for n in [(1i64 << 53) + 1, i64::MAX, -(1i64 << 53) - 1, (1 << 60) + 1] {
            let error = encode_params(&[Value::Integer(n)]).expect_err("refused");
            assert_eq!(
                error,
                StoreError::Unsupported("do wire: an integer no double represents exactly")
            );
            assert_eq!(error.classify(), StoreFailure::Refused);
        }
        for n in [0, 1 << 53, -(1 << 53), 1 << 62, i64::MIN, u32::MAX.into()] {
            assert_eq!(f64_to_integer(integer_to_f64(n).unwrap()).unwrap(), n);
        }
    }

    #[test]
    fn counts_do_not_reserve_what_the_bytes_cannot_hold() {
        // Four billion rows announced in four bytes: refused as truncated,
        // without reserving for them.
        poisoned(decode_rows(&[0xff, 0xff, 0xff, 0xff]), "truncated");
        poisoned(
            decode_rows(&[1, 0, 0, 0, 0xff, 0xff, 0xff, 0xff]),
            "truncated",
        );
        poisoned(
            decode_params(&[TAG_BLOB, 0xff, 0xff, 0xff, 0xff]),
            "truncated",
        );
    }
}
