//! The slot-record codec: a [`Slot`] ↔ fixed-width byte record for the
//! `HEAP` and `STAC` atoms. Because the heap is index-based, a slot image
//! is just its fields laid out deterministically — the writer is a
//! serializer, not a relocator (design § Snapshots). The record is
//! ironhorse's own, not XS's 32-byte in-memory `txSlot`: `SlotIndex`/
//! `ChunkOffset` handles are already position-independent, so they
//! serialize verbatim.
//!
//! Layout ([`SLOT_RECORD_BYTES`] = 20 bytes, all multi-byte fields
//! big-endian):
//!
//! | offset | field |
//! |--------|-------|
//! | 0      | `kind` (`Kind` repr byte) |
//! | 1      | `flag` |
//! | 2..4   | `id` (u16) |
//! | 4..8   | `next` (`SlotIndex`, `u32::MAX` = NULL) |
//! | 8      | payload tag |
//! | 9      | reserved (0) |
//! | 10..20 | payload data (tag-specific; unused bytes 0) |
//!
//! Encoding always zero-fills the record first, so a round-trip
//! (write → read → write) is byte-identical: unused payload bytes are
//! deterministically zero both times.

use ironhorse_vm::{ChunkOffset, Kind, Payload, Slot, SlotIndex};

/// The fixed serialized width of one slot record, in bytes.
pub const SLOT_RECORD_BYTES: usize = 20;

// Payload discriminant tags. Distinct from `Kind` because several kinds
// share a payload arm and the empty `Payload::None` must be distinguished
// from a zeroed unknown.
const P_NONE: u8 = 0;
const P_BOOL: u8 = 1;
const P_INT: u8 = 2;
const P_NUM: u8 = 3;
const P_STR: u8 = 4;
const P_REF: u8 = 5;
const P_AT: u8 = 6;
const P_BIGINT: u8 = 7;

/// A slot record the reader could not decode.
#[derive(Debug, PartialEq, Eq)]
pub enum SlotCodecError {
    /// A kind byte that names no [`Kind`].
    BadKind(u8),
    /// A payload tag that names no payload arm.
    BadPayloadTag(u8),
}

/// Serialize one slot into `out` (appends exactly [`SLOT_RECORD_BYTES`]).
pub fn encode_slot(slot: &Slot, out: &mut Vec<u8>) {
    let mut rec = [0u8; SLOT_RECORD_BYTES];
    rec[0] = slot.kind as u8;
    rec[1] = slot.flag;
    rec[2..4].copy_from_slice(&slot.id.to_be_bytes());
    rec[4..8].copy_from_slice(&slot.next.0.to_be_bytes());
    let (tag, data): (u8, [u8; 10]) = encode_payload(&slot.value);
    rec[8] = tag;
    rec[10..20].copy_from_slice(&data);
    out.extend_from_slice(&rec);
}

fn encode_payload(p: &Payload) -> (u8, [u8; 10]) {
    let mut d = [0u8; 10];
    let tag = match *p {
        Payload::None => P_NONE,
        Payload::Boolean(b) => {
            d[0] = b as u8;
            P_BOOL
        }
        Payload::Integer(i) => {
            d[0..4].copy_from_slice(&i.to_be_bytes());
            P_INT
        }
        Payload::Number(n) => {
            d[0..8].copy_from_slice(&n.to_bits().to_be_bytes());
            P_NUM
        }
        Payload::String(o) => {
            d[0..4].copy_from_slice(&o.0.to_be_bytes());
            P_STR
        }
        Payload::Reference(r) => {
            d[0..4].copy_from_slice(&r.0.to_be_bytes());
            P_REF
        }
        Payload::At(id, index) => {
            d[0..2].copy_from_slice(&id.to_be_bytes());
            d[2..6].copy_from_slice(&index.to_be_bytes());
            P_AT
        }
        Payload::BigInt(o) => {
            d[0..4].copy_from_slice(&o.0.to_be_bytes());
            P_BIGINT
        }
    };
    (tag, d)
}

/// Deserialize one slot record (exactly [`SLOT_RECORD_BYTES`] bytes).
pub fn decode_slot(rec: &[u8]) -> Result<Slot, SlotCodecError> {
    debug_assert_eq!(rec.len(), SLOT_RECORD_BYTES);
    let kind = Kind::from_u8(rec[0]).ok_or(SlotCodecError::BadKind(rec[0]))?;
    let flag = rec[1];
    let id = u16::from_be_bytes([rec[2], rec[3]]);
    let next = SlotIndex(u32::from_be_bytes([rec[4], rec[5], rec[6], rec[7]]));
    let value = decode_payload(rec[8], &rec[10..20])?;
    Ok(Slot {
        next,
        id,
        flag,
        kind,
        value,
    })
}

fn decode_payload(tag: u8, d: &[u8]) -> Result<Payload, SlotCodecError> {
    let u32_at = |i: usize| u32::from_be_bytes([d[i], d[i + 1], d[i + 2], d[i + 3]]);
    Ok(match tag {
        P_NONE => Payload::None,
        P_BOOL => Payload::Boolean(d[0] != 0),
        P_INT => Payload::Integer(i32::from_be_bytes([d[0], d[1], d[2], d[3]])),
        P_NUM => Payload::Number(f64::from_bits(u64::from_be_bytes([
            d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[7],
        ]))),
        P_STR => Payload::String(ChunkOffset(u32_at(0))),
        P_REF => Payload::Reference(SlotIndex(u32_at(0))),
        P_AT => Payload::At(u16::from_be_bytes([d[0], d[1]]), u32_at(2)),
        P_BIGINT => Payload::BigInt(ChunkOffset(u32_at(0))),
        other => return Err(SlotCodecError::BadPayloadTag(other)),
    })
}

/// Encode a slice of slots into a flat record array.
pub fn encode_slots(slots: &[Slot]) -> Vec<u8> {
    let mut out = Vec::with_capacity(slots.len() * SLOT_RECORD_BYTES);
    for s in slots {
        encode_slot(s, &mut out);
    }
    out
}

/// Decode a flat record array back into a `Vec<Slot>`.
pub fn decode_slots(buf: &[u8]) -> Result<Vec<Slot>, SlotCodecError> {
    let mut out = Vec::with_capacity(buf.len() / SLOT_RECORD_BYTES);
    let mut i = 0;
    while i + SLOT_RECORD_BYTES <= buf.len() {
        out.push(decode_slot(&buf[i..i + SLOT_RECORD_BYTES])?);
        i += SLOT_RECORD_BYTES;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip(slot: Slot) {
        let mut buf = Vec::new();
        encode_slot(&slot, &mut buf);
        assert_eq!(buf.len(), SLOT_RECORD_BYTES);
        let back = decode_slot(&buf).unwrap();
        assert_eq!(back, slot);
        // Byte-equality: re-encoding the decoded slot yields identical bytes.
        let mut buf2 = Vec::new();
        encode_slot(&back, &mut buf2);
        assert_eq!(buf, buf2);
    }

    #[test]
    fn every_payload_arm_round_trips() {
        round_trip(Slot::undefined());
        round_trip(Slot::null());
        round_trip(Slot::boolean(true));
        round_trip(Slot::boolean(false));
        round_trip(Slot::integer(-42));
        round_trip(Slot::integer(i32::MIN));
        round_trip(Slot::number(3.14159));
        round_trip(Slot::number(f64::INFINITY));
        round_trip(Slot::of(Kind::String, Payload::String(ChunkOffset(7))));
        round_trip(Slot::of(Kind::Reference, Payload::Reference(SlotIndex(99))));
        round_trip(Slot::of(Kind::At, Payload::At(300, 0xDEADBEEF)));
        round_trip(Slot::of(Kind::BigInt, Payload::BigInt(ChunkOffset(12))));
    }

    #[test]
    fn nan_bits_preserved() {
        // A signaling-NaN bit pattern must survive exactly, not collapse
        // to a canonical NaN.
        let raw: u64 = 0x7ff0_0000_0000_0001;
        let slot = Slot::number(f64::from_bits(raw));
        let mut buf = Vec::new();
        encode_slot(&slot, &mut buf);
        let back = decode_slot(&buf).unwrap();
        // NaN != NaN under PartialEq, so compare the raw bits directly:
        // the exact bit pattern must survive, not collapse to canonical.
        match back.value {
            Payload::Number(n) => assert_eq!(n.to_bits(), raw),
            other => panic!("expected number payload, got {:?}", other),
        }
    }

    #[test]
    fn preserves_next_id_flag() {
        let mut slot = Slot::property(1234, Payload::Integer(5));
        slot.next = SlotIndex(88);
        slot.flag = 0xAB;
        round_trip(slot);
    }

    #[test]
    fn null_index_round_trips() {
        let mut slot = Slot::instance(SlotIndex::NULL);
        slot.next = SlotIndex::NULL;
        let mut buf = Vec::new();
        encode_slot(&slot, &mut buf);
        let back = decode_slot(&buf).unwrap();
        assert!(back.next.is_null());
        if let Payload::Reference(r) = back.value {
            assert!(r.is_null());
        } else {
            panic!("instance payload is a reference");
        }
    }

    #[test]
    fn rejects_bad_kind() {
        let mut buf = vec![0u8; SLOT_RECORD_BYTES];
        buf[0] = 200; // no such kind
        assert_eq!(decode_slot(&buf), Err(SlotCodecError::BadKind(200)));
    }

    #[test]
    fn slice_round_trips() {
        let slots = vec![
            Slot::integer(1),
            Slot::boolean(true),
            Slot::of(Kind::String, Payload::String(ChunkOffset(4))),
        ];
        let bytes = encode_slots(&slots);
        assert_eq!(decode_slots(&bytes).unwrap(), slots);
    }
}
