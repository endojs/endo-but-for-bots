//! Payload structs for the slot-machine verbs, with canonical
//! CBOR encode/decode.  Every payload is a top-level CBOR array;
//! fields are positional so the wire format carries no field names.

use crate::error::{Result, SlotError};
use crate::wire::codec::{
    as_array, as_bytes, read_descriptor, read_descriptor_array, read_optional_descriptor,
    read_top_level, read_top_level_exact, read_uint_helper, write_array_header, write_byte_string,
    write_descriptor, write_descriptor_array, write_null, write_uint,
};
use crate::wire::descriptor::{Descriptor, Kind};

/// A JavaScript array index is an integer in `0 <= index < 2**32 - 1`.
/// This mirrors `packages/slots/src/payload.js`'s `INDEX_LIMIT`.
pub const INDEX_LIMIT: u64 = (1u64 << 32) - 1;

/// A data operation (`get` / `index` / `untag`) observes the shape of
/// data at a target that carries no behavior selection.  Its target
/// may be an `Object`, `Promise`, or `Answer` (pipelining preserved);
/// a `Device` target is rejected.  Its reply is required and must have
/// kind `Promise`.
fn check_data_descriptors(target: &Descriptor, reply: &Descriptor) -> Result<()> {
    if target.kind == Kind::Device {
        return Err(SlotError::Invariant(
            "data-operation target must not be a device".into(),
        ));
    }
    if reply.kind != Kind::Promise {
        return Err(SlotError::Invariant(
            "data-operation reply must be a promise descriptor".into(),
        ));
    }
    Ok(())
}

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

// ---- data lanes: get / index / untag ----
//
// Each carries a scalar operand and exactly two capability
// descriptors — `target` and `reply` — and no opaque marshalled body.
// The supervisor can therefore validate and translate the whole
// operation without interpreting guest data.

/// `get` payload — string-named field access:
///
/// ```text
/// [target: Descriptor, field_name: UTF-8 bytes, reply: Descriptor]
/// ```
#[derive(Clone, Debug, PartialEq)]
pub struct GetPayload {
    pub target: Descriptor,
    pub field_name: String,
    pub reply: Descriptor,
}

impl GetPayload {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(16 + self.field_name.len());
        write_array_header(&mut out, 3);
        write_descriptor(&mut out, &self.target);
        write_byte_string(&mut out, self.field_name.as_bytes());
        write_descriptor(&mut out, &self.reply);
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        let top = read_top_level_exact(bytes)?;
        let arr = as_array(&top)?;
        if arr.len() != 3 {
            return Err(SlotError::Invariant(format!(
                "get payload must be 3-element array, got {}",
                arr.len()
            )));
        }
        let target = read_descriptor(&arr[0])?;
        let field_name = read_utf8(&arr[1], "get field name")?;
        let reply = read_descriptor(&arr[2])?;
        check_data_descriptors(&target, &reply)?;
        Ok(GetPayload { target, field_name, reply })
    }
}

/// `index` payload — positional list access:
///
/// ```text
/// [target: Descriptor, index: uint, reply: Descriptor]
/// ```
#[derive(Clone, Debug, PartialEq)]
pub struct IndexPayload {
    pub target: Descriptor,
    pub index: u64,
    pub reply: Descriptor,
}

impl IndexPayload {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(16);
        write_array_header(&mut out, 3);
        write_descriptor(&mut out, &self.target);
        write_uint(&mut out, self.index);
        write_descriptor(&mut out, &self.reply);
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        let top = read_top_level_exact(bytes)?;
        let arr = as_array(&top)?;
        if arr.len() != 3 {
            return Err(SlotError::Invariant(format!(
                "index payload must be 3-element array, got {}",
                arr.len()
            )));
        }
        let target = read_descriptor(&arr[0])?;
        let index = read_uint_helper(&arr[1])?;
        if index >= INDEX_LIMIT {
            return Err(SlotError::Invariant(format!(
                "slot index {index} out of array-index range"
            )));
        }
        let reply = read_descriptor(&arr[2])?;
        check_data_descriptors(&target, &reply)?;
        Ok(IndexPayload { target, index, reply })
    }
}

/// `untag` payload — tag-checked payload access:
///
/// ```text
/// [target: Descriptor, tag: UTF-8 bytes, reply: Descriptor]
/// ```
#[derive(Clone, Debug, PartialEq)]
pub struct UntagPayload {
    pub target: Descriptor,
    pub tag: String,
    pub reply: Descriptor,
}

impl UntagPayload {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(16 + self.tag.len());
        write_array_header(&mut out, 3);
        write_descriptor(&mut out, &self.target);
        write_byte_string(&mut out, self.tag.as_bytes());
        write_descriptor(&mut out, &self.reply);
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        let top = read_top_level_exact(bytes)?;
        let arr = as_array(&top)?;
        if arr.len() != 3 {
            return Err(SlotError::Invariant(format!(
                "untag payload must be 3-element array, got {}",
                arr.len()
            )));
        }
        let target = read_descriptor(&arr[0])?;
        let tag = read_utf8(&arr[1], "untag tag")?;
        let reply = read_descriptor(&arr[2])?;
        check_data_descriptors(&target, &reply)?;
        Ok(UntagPayload { target, tag, reply })
    }
}

/// Decode a CBOR byte string as a strictly-valid UTF-8 string.
fn read_utf8(v: &ciborium::value::Value, what: &str) -> Result<String> {
    let raw = as_bytes(v)?;
    std::str::from_utf8(raw)
        .map_err(|e| SlotError::Invariant(format!("slot {what} not valid utf-8: {e}")))
        .map(|s| s.to_string())
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

    // ---- data lanes ----

    #[test]
    fn get_roundtrip() {
        let p = GetPayload {
            target: Descriptor::new(Direction::Remote, Kind::Object, 7),
            field_name: "field".into(),
            reply: Descriptor::new(Direction::Local, Kind::Promise, 2),
        };
        assert_eq!(GetPayload::decode(&p.encode()).unwrap(), p);
    }

    #[test]
    fn index_roundtrip_answer_target() {
        // An Answer target preserves promise pipelining.
        let p = IndexPayload {
            target: Descriptor::new(Direction::Remote, Kind::Answer, 4),
            index: 42,
            reply: Descriptor::new(Direction::Local, Kind::Promise, 1),
        };
        assert_eq!(IndexPayload::decode(&p.encode()).unwrap(), p);
    }

    #[test]
    fn untag_roundtrip() {
        let p = UntagPayload {
            target: Descriptor::new(Direction::Remote, Kind::Object, 9),
            tag: "example".into(),
            reply: Descriptor::new(Direction::Local, Kind::Promise, 6),
        };
        assert_eq!(UntagPayload::decode(&p.encode()).unwrap(), p);
    }

    #[test]
    fn data_lane_rejects_device_target() {
        // Hand-encode a get whose target is a Device; decode must reject.
        let mut bytes = vec![0x83];
        // target: Device/Remote => kind_byte = (3<<1)|1 = 7, position 1
        bytes.extend([0x82, 0x07, 0x01]);
        bytes.extend([0x41, 0x78]); // field "x"
        bytes.extend([0x82, 0x02, 0x01]); // reply Promise/Local/1
        let err = GetPayload::decode(&bytes).unwrap_err();
        assert!(format!("{err}").contains("must not be a device"), "{err}");
    }

    #[test]
    fn data_lane_rejects_non_promise_reply() {
        // untag whose reply is an Object descriptor.
        let mut bytes = vec![0x83];
        bytes.extend([0x82, 0x00, 0x01]); // target Object/Local/1
        bytes.extend([0x41, 0x74]); // tag "t"
        bytes.extend([0x82, 0x00, 0x01]); // reply Object/Local/1 (wrong)
        let err = UntagPayload::decode(&bytes).unwrap_err();
        assert!(
            format!("{err}").contains("reply must be a promise"),
            "{err}"
        );
    }

    #[test]
    fn index_rejects_out_of_range() {
        // Hand-encode an index at exactly INDEX_LIMIT (invalid).
        let mut bytes = vec![0x83];
        bytes.extend([0x82, 0x00, 0x01]); // target Object/Local/1
        // uint INDEX_LIMIT = 4294967295 = 0x1a ffffffff
        bytes.push(0x1a);
        bytes.extend((INDEX_LIMIT as u32).to_be_bytes());
        bytes.extend([0x82, 0x02, 0x01]); // reply Promise/Local/1
        let err = IndexPayload::decode(&bytes).unwrap_err();
        assert!(format!("{err}").contains("out of array-index range"), "{err}");
    }

    #[test]
    fn index_largest_valid_roundtrips() {
        let p = IndexPayload {
            target: Descriptor::new(Direction::Local, Kind::Object, 1),
            index: INDEX_LIMIT - 1,
            reply: Descriptor::new(Direction::Local, Kind::Promise, 1),
        };
        assert_eq!(IndexPayload::decode(&p.encode()).unwrap(), p);
    }

    #[test]
    fn get_rejects_invalid_utf8() {
        let mut bytes = vec![0x83];
        bytes.extend([0x82, 0x00, 0x01]); // target
        bytes.extend([0x41, 0xff]); // 1-byte field name 0xff (illegal utf-8)
        bytes.extend([0x82, 0x02, 0x01]); // reply
        let err = GetPayload::decode(&bytes).unwrap_err();
        assert!(format!("{err}").contains("not valid utf-8"), "{err}");
    }

    #[test]
    fn data_lane_rejects_wrong_shape() {
        // A 5-element deliver payload is not a 3-element get payload.
        let deliver = DeliverPayload {
            target: Descriptor::new(Direction::Local, Kind::Object, 1),
            body: vec![],
            targets: vec![],
            promises: vec![],
            reply: Some(Descriptor::new(Direction::Local, Kind::Promise, 1)),
        }
        .encode();
        assert!(GetPayload::decode(&deliver).is_err());
    }

    #[test]
    fn data_lane_rejects_trailing_bytes() {
        let mut bytes = IndexPayload {
            target: Descriptor::new(Direction::Local, Kind::Object, 1),
            index: 1,
            reply: Descriptor::new(Direction::Local, Kind::Promise, 1),
        }
        .encode();
        bytes.push(0x00);
        let err = IndexPayload::decode(&bytes).unwrap_err();
        assert!(format!("{err}").contains("trailing CBOR bytes"), "{err}");
    }

    // Pinned hex fixtures shared with
    // packages/slots/test/payload.test.js.  Target Local/Object/1,
    // reply Local/Promise/1 in each.
    #[test]
    fn get_pinned_hex_fixture() {
        let p = GetPayload {
            target: Descriptor::new(Direction::Local, Kind::Object, 1),
            field_name: "x".into(),
            reply: Descriptor::new(Direction::Local, Kind::Promise, 1),
        };
        assert_eq!(hex(&p.encode()), "838200014178820201");
    }

    #[test]
    fn index_pinned_hex_fixture() {
        let p = IndexPayload {
            target: Descriptor::new(Direction::Local, Kind::Object, 1),
            index: 5,
            reply: Descriptor::new(Direction::Local, Kind::Promise, 1),
        };
        assert_eq!(hex(&p.encode()), "8382000105820201");
    }

    #[test]
    fn untag_pinned_hex_fixture() {
        let p = UntagPayload {
            target: Descriptor::new(Direction::Local, Kind::Object, 1),
            tag: "t".into(),
            reply: Descriptor::new(Direction::Local, Kind::Promise, 1),
        };
        assert_eq!(hex(&p.encode()), "838200014174820201");
    }
}
