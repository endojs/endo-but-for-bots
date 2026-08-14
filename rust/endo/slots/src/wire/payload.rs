//! Payload structs for the four slot-machine verbs, with canonical
//! CBOR encode/decode.  Every payload is a top-level CBOR array;
//! fields are positional so the wire format carries no field names.

use crate::error::{Result, SlotError};
use crate::wire::codec::{
    as_array, as_bytes, read_descriptor, read_descriptor_array, read_optional_descriptor,
    read_top_level, read_uint_helper, write_array_header, write_byte_string, write_descriptor,
    write_descriptor_array, write_null, write_uint,
};
use crate::wire::descriptor::Descriptor;

// ---- deliver ----

/// `deliver` payload:
///
/// ```text
/// [
///   target:   Descriptor,
///   body:     bytes,
///   targets:  [Descriptor, ...],   -- positions for in-band target markers in body
///   promises: [Descriptor, ...],   -- positions for in-band promise markers in body
///   reply:    Descriptor | null,   -- where to send the return value (None = fire-and-forget)
/// ]
/// ```
#[derive(Clone, Debug, PartialEq)]
pub struct DeliverPayload {
    pub target: Descriptor,
    pub body: Vec<u8>,
    pub targets: Vec<Descriptor>,
    pub promises: Vec<Descriptor>,
    pub reply: Option<Descriptor>,
}

impl DeliverPayload {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(16 + self.body.len());
        write_array_header(&mut out, 5);
        write_descriptor(&mut out, &self.target);
        write_byte_string(&mut out, &self.body);
        write_descriptor_array(&mut out, &self.targets);
        write_descriptor_array(&mut out, &self.promises);
        match &self.reply {
            Some(d) => write_descriptor(&mut out, d),
            None => write_null(&mut out),
        }
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        let top = read_top_level(bytes)?;
        let arr = as_array(&top)?;
        if arr.len() != 5 {
            return Err(SlotError::Invariant(format!(
                "deliver payload must be 5-element array, got {}",
                arr.len()
            )));
        }
        Ok(DeliverPayload {
            target: read_descriptor(&arr[0])?,
            body: as_bytes(&arr[1])?.to_vec(),
            targets: read_descriptor_array(&arr[2])?,
            promises: read_descriptor_array(&arr[3])?,
            reply: read_optional_descriptor(&arr[4])?,
        })
    }
}

// ---- resolve ----

/// `resolve` payload:
///
/// ```text
/// [
///   target:    Descriptor,         -- the promise being resolved
///   is_reject: uint (0 | 1),
///   body:      bytes,              -- opaque resolution value
///   targets:   [Descriptor, ...],
///   promises:  [Descriptor, ...],
/// ]
/// ```
#[derive(Clone, Debug, PartialEq)]
pub struct ResolvePayload {
    pub target: Descriptor,
    pub is_reject: bool,
    pub body: Vec<u8>,
    pub targets: Vec<Descriptor>,
    pub promises: Vec<Descriptor>,
}

impl ResolvePayload {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(16 + self.body.len());
        write_array_header(&mut out, 5);
        write_descriptor(&mut out, &self.target);
        write_uint(&mut out, if self.is_reject { 1 } else { 0 });
        write_byte_string(&mut out, &self.body);
        write_descriptor_array(&mut out, &self.targets);
        write_descriptor_array(&mut out, &self.promises);
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        let top = read_top_level(bytes)?;
        let arr = as_array(&top)?;
        if arr.len() != 5 {
            return Err(SlotError::Invariant(format!(
                "resolve payload must be 5-element array, got {}",
                arr.len()
            )));
        }
        let flag = read_uint_helper(&arr[1])?;
        if flag > 1 {
            return Err(SlotError::Invariant(format!(
                "resolve is_reject must be 0 or 1, got {flag}"
            )));
        }
        Ok(ResolvePayload {
            target: read_descriptor(&arr[0])?,
            is_reject: flag == 1,
            body: as_bytes(&arr[2])?.to_vec(),
            targets: read_descriptor_array(&arr[3])?,
            promises: read_descriptor_array(&arr[4])?,
        })
    }
}

// ---- drop ----

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DropDelta {
    pub target: Descriptor,
    pub ram: u64,
    pub clist: u64,
    pub export: u64,
}

/// `drop` payload: one or more pillar decrements.
///
/// ```text
/// [
///   [target: Descriptor, ram: uint, clist: uint, export: uint],
///   ...
/// ]
/// ```
#[derive(Clone, Debug, PartialEq)]
pub struct DropPayload {
    pub deltas: Vec<DropDelta>,
}

impl DropPayload {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(8 + 16 * self.deltas.len());
        write_array_header(&mut out, self.deltas.len() as u64);
        for d in &self.deltas {
            write_array_header(&mut out, 4);
            write_descriptor(&mut out, &d.target);
            write_uint(&mut out, d.ram);
            write_uint(&mut out, d.clist);
            write_uint(&mut out, d.export);
        }
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        let top = read_top_level(bytes)?;
        let arr = as_array(&top)?;
        let mut deltas = Vec::with_capacity(arr.len());
        for item in arr {
            let fields = as_array(item)?;
            if fields.len() != 4 {
                return Err(SlotError::Invariant(format!(
                    "drop entry must be 4-element array, got {}",
                    fields.len()
                )));
            }
            deltas.push(DropDelta {
                target: read_descriptor(&fields[0])?,
                ram: read_uint_helper(&fields[1])?,
                clist: read_uint_helper(&fields[2])?,
                export: read_uint_helper(&fields[3])?,
            });
        }
        Ok(DropPayload { deltas })
    }
}

// ---- abort ----

/// `abort` payload: a UTF-8 reason string encoded as a byte string.
#[derive(Clone, Debug, PartialEq)]
pub struct AbortPayload {
    pub reason: String,
}

impl AbortPayload {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(4 + self.reason.len());
        write_byte_string(&mut out, self.reason.as_bytes());
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        let top = read_top_level(bytes)?;
        let raw = as_bytes(&top)?;
        let reason = std::str::from_utf8(raw)
            .map_err(|e| SlotError::Invariant(format!("abort reason not utf-8: {e}")))?
            .to_string();
        Ok(AbortPayload { reason })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::descriptor::{Direction, Kind};

    #[test]
    fn deliver_roundtrip() {
        let p = DeliverPayload {
            target: Descriptor::new(Direction::Remote, Kind::Object, 7),
            body: b"hello".to_vec(),
            targets: vec![Descriptor::new(Direction::Local, Kind::Object, 1)],
            promises: vec![],
            reply: Some(Descriptor::new(Direction::Local, Kind::Promise, 2)),
        };
        let bytes = p.encode();
        let p2 = DeliverPayload::decode(&bytes).unwrap();
        assert_eq!(p, p2);
    }

    #[test]
    fn deliver_fire_and_forget() {
        let p = DeliverPayload {
            target: Descriptor::new(Direction::Remote, Kind::Object, 7),
            body: vec![],
            targets: vec![],
            promises: vec![],
            reply: None,
        };
        let bytes = p.encode();
        let p2 = DeliverPayload::decode(&bytes).unwrap();
        assert_eq!(p2.reply, None);
    }

    #[test]
    fn resolve_roundtrip() {
        let p = ResolvePayload {
            target: Descriptor::new(Direction::Local, Kind::Promise, 42),
            is_reject: true,
            body: b"error-data".to_vec(),
            targets: vec![],
            promises: vec![Descriptor::new(Direction::Remote, Kind::Promise, 5)],
        };
        let bytes = p.encode();
        let p2 = ResolvePayload::decode(&bytes).unwrap();
        assert_eq!(p, p2);
    }

    #[test]
    fn drop_roundtrip_multi() {
        let p = DropPayload {
            deltas: vec![
                DropDelta {
                    target: Descriptor::new(Direction::Local, Kind::Object, 1),
                    ram: 1,
                    clist: 0,
                    export: 0,
                },
                DropDelta {
                    target: Descriptor::new(Direction::Remote, Kind::Promise, 9),
                    ram: 0,
                    clist: 1,
                    export: 1,
                },
            ],
        };
        let bytes = p.encode();
        let p2 = DropPayload::decode(&bytes).unwrap();
        assert_eq!(p, p2);
    }

    #[test]
    fn abort_roundtrip() {
        let p = AbortPayload { reason: "worker exited".into() };
        let bytes = p.encode();
        let p2 = AbortPayload::decode(&bytes).unwrap();
        assert_eq!(p, p2);
    }

    #[test]
    fn decode_rejects_wrong_shape() {
        // deliver expects 5 elements; give it 3.
        let mut bogus = vec![0x83]; // array(3)
        bogus.extend([0x00, 0x00, 0x00]);
        assert!(DeliverPayload::decode(&bogus).is_err());
    }

    // Pinned hex fixtures: each appears in both
    // packages/slots/test/payload.test.js and
    // rust/endo/slots/src/wire/payload.rs so any wire-shape drift
    // between the JS and Rust sides fails one suite or the other.

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn deliver_pinned_hex_fixture() {
        let p = DeliverPayload {
            target: Descriptor::new(Direction::Local, Kind::Object, 1),
            body: vec![],
            targets: vec![],
            promises: vec![],
            reply: None,
        };
        assert_eq!(hex(&p.encode()), "85820001408080f6");
    }

    #[test]
    fn resolve_pinned_hex_fixture() {
        let p = ResolvePayload {
            target: Descriptor::new(Direction::Local, Kind::Promise, 1),
            is_reject: false,
            body: vec![],
            targets: vec![],
            promises: vec![],
        };
        assert_eq!(hex(&p.encode()), "8582020100408080");
    }

    #[test]
    fn drop_pinned_hex_fixture() {
        let p = DropPayload {
            deltas: vec![DropDelta {
                target: Descriptor::new(Direction::Local, Kind::Object, 1),
                ram: 1,
                clist: 0,
                export: 0,
            }],
        };
        assert_eq!(hex(&p.encode()), "8184820001010000");
    }

    #[test]
    fn abort_pinned_hex_fixture() {
        let p = AbortPayload { reason: "bye".into() };
        assert_eq!(hex(&p.encode()), "43627965");
    }
}
