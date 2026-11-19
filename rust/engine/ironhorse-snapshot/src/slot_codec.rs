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
//! deterministically zero both times. Decoding is the exact inverse on
//! everything but NaN payloads: it refuses a non-zero reserved byte 9
//! ([`SlotCodecError::ReservedByte`]), a non-zero byte past the payload
//! arm's width ([`SlotCodecError::UnusedPayloadBytes`]) and a Boolean byte
//! other than 0 or 1 ([`SlotCodecError::BadBoolean`]), so an accepted record
//! re-encodes to the same 20 bytes (Kani guarantee SNAP-2(c),
//! `verification/proofs.d/framing.toml`). Number NaNs are written in XS's
//! canonical form, including payloads constructed without `Slot::number`.
//! Decoding preserves legacy NaN bits; re-encoding normalizes them (the one
//! carve-out from canonicality: format-16 images refuse such a NaN at the
//! whole-image byte comparison in `read_machine`). Raw chunk/ArrayBuffer
//! bytes are outside this codec and remain unchanged.

use crate::sink::Sink;
use ironhorse_vm::value::canonicalize_nan;
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
    /// A record (or record array) whose byte length is not exactly
    /// [`SLOT_RECORD_BYTES`] (or a whole multiple of it): the length found.
    BadLength(usize),
    /// A non-zero reserved byte 9 (the byte found). The encoder writes 0,
    /// so accepting another value would give one slot many encodings.
    ReservedByte(u8),
    /// A non-zero payload data byte beyond the width the payload arm uses
    /// (the encoder zero-fills them).
    UnusedPayloadBytes,
    /// A Boolean payload byte other than 0 or 1 (the byte found).
    BadBoolean(u8),
}

/// Serialize one slot into `out` (appends exactly [`SLOT_RECORD_BYTES`]).
pub fn encode_slot(slot: &Slot, out: &mut Vec<u8>) {
    put_slot(slot, out);
}

/// [`encode_slot`] into any sink: the one record encoder behind every
/// `HEAP`, `STAC` and side-table slot the crate writes.
#[inline]
pub(crate) fn put_slot<S: Sink>(slot: &Slot, out: &mut S) {
    let mut rec = [0u8; SLOT_RECORD_BYTES];
    rec[0] = slot.kind as u8;
    rec[1] = slot.flag;
    rec[2..4].copy_from_slice(&slot.id.to_be_bytes());
    rec[4..8].copy_from_slice(&slot.next.0.to_be_bytes());
    let (tag, data): (u8, [u8; 10]) = encode_payload(&slot.value);
    rec[8] = tag;
    rec[10..20].copy_from_slice(&data);
    out.put(&rec);
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
            d[0..8].copy_from_slice(&canonicalize_nan(n).to_bits().to_be_bytes());
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

/// Deserialize one slot record (exactly [`SLOT_RECORD_BYTES`] bytes; any
/// other length is [`SlotCodecError::BadLength`]).
pub fn decode_slot(rec: &[u8]) -> Result<Slot, SlotCodecError> {
    let rec: &[u8; SLOT_RECORD_BYTES] = rec
        .try_into()
        .map_err(|_| SlotCodecError::BadLength(rec.len()))?;
    decode_record(rec)
}

/// [`decode_slot`] on a record whose width the type already proves.
///
/// The kind and payload tag are checked first, so a record that failed
/// before canonicality was enforced fails with the same error.
fn decode_record(rec: &[u8; SLOT_RECORD_BYTES]) -> Result<Slot, SlotCodecError> {
    // Every byte named (no `data @ ..` sub-array binding, which Kani 0.68
    // cannot model), so the SNAP-2 proofs run on this exact code.
    let [kind, flag, id0, id1, n0, n1, n2, n3, tag, reserved, d0, d1, d2, d3, d4, d5, d6, d7, d8, d9] =
        *rec;
    let data = [d0, d1, d2, d3, d4, d5, d6, d7, d8, d9];
    let kind = Kind::from_u8(kind).ok_or(SlotCodecError::BadKind(kind))?;
    let id = u16::from_be_bytes([id0, id1]);
    let next = SlotIndex(u32::from_be_bytes([n0, n1, n2, n3]));
    let value = decode_payload(tag, data)?;
    if reserved != 0 {
        return Err(SlotCodecError::ReservedByte(reserved));
    }
    Ok(Slot {
        next,
        id,
        flag,
        kind,
        value,
    })
}

fn decode_payload(tag: u8, d: [u8; 10]) -> Result<Payload, SlotCodecError> {
    let [d0, d1, d2, d3, d4, d5, d6, d7, d8, d9] = d;
    let word = u32::from_be_bytes([d0, d1, d2, d3]);
    // Each arm with the number of leading data bytes it reads; the rest
    // must be the zeros the encoder writes.
    let (value, used): (Payload, u32) = match tag {
        P_NONE => (Payload::None, 0),
        P_BOOL => match d0 {
            0 | 1 => (Payload::Boolean(d0 != 0), 1),
            other => return Err(SlotCodecError::BadBoolean(other)),
        },
        P_INT => (Payload::Integer(i32::from_be_bytes([d0, d1, d2, d3])), 4),
        P_NUM => (
            Payload::Number(f64::from_bits(u64::from_be_bytes([
                d0, d1, d2, d3, d4, d5, d6, d7,
            ]))),
            8,
        ),
        P_STR => (Payload::String(ChunkOffset(word)), 4),
        P_REF => (Payload::Reference(SlotIndex(word)), 4),
        P_AT => (
            Payload::At(
                u16::from_be_bytes([d0, d1]),
                u32::from_be_bytes([d2, d3, d4, d5]),
            ),
            6,
        ),
        P_BIGINT => (Payload::BigInt(ChunkOffset(word)), 4),
        other => return Err(SlotCodecError::BadPayloadTag(other)),
    };
    // The ten data bytes as one big-endian 80-bit field: the unused ones
    // are its low `(10 - used) * 8` bits. Loop-free, so the SNAP-2 proofs
    // need no unwinding bound.
    let field = u128::from_be_bytes([0, 0, 0, 0, 0, 0, d0, d1, d2, d3, d4, d5, d6, d7, d8, d9]);
    let unused_bits = (10 - used) * 8;
    if field & ((1u128 << unused_bits) - 1) != 0 {
        return Err(SlotCodecError::UnusedPayloadBytes);
    }
    Ok(value)
}

/// Encode a slice of slots into a flat record array.
pub fn encode_slots(slots: &[Slot]) -> Vec<u8> {
    let mut out = Vec::with_capacity(slots.len() * SLOT_RECORD_BYTES);
    for s in slots {
        encode_slot(s, &mut out);
    }
    out
}

/// Decode a flat record array back into a `Vec<Slot>`. A trailing partial
/// record is [`SlotCodecError::BadLength`] rather than silently dropped.
pub fn decode_slots(buf: &[u8]) -> Result<Vec<Slot>, SlotCodecError> {
    let records = buf.chunks_exact(SLOT_RECORD_BYTES);
    if !records.remainder().is_empty() {
        return Err(SlotCodecError::BadLength(buf.len()));
    }
    let mut out = Vec::with_capacity(buf.len() / SLOT_RECORD_BYTES);
    for rec in records {
        out.push(decode_slot(rec)?);
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
        round_trip(Slot::number(std::f64::consts::PI));
        round_trip(Slot::number(f64::INFINITY));
        round_trip(Slot::of(Kind::String, Payload::String(ChunkOffset(7))));
        round_trip(Slot::of(Kind::Reference, Payload::Reference(SlotIndex(99))));
        round_trip(Slot::of(Kind::At, Payload::At(300, 0xDEADBEEF)));
        round_trip(Slot::of(Kind::BigInt, Payload::BigInt(ChunkOffset(12))));
    }

    #[test]
    fn nan_is_canonicalized_even_when_slot_constructor_is_bypassed() {
        for bits in [
            0x7ff0_0000_0000_0001,
            0x7ff8_0000_0000_0042,
            0xfff0_0000_0000_0001,
            0xfff8_0000_0000_0042,
        ] {
            let mut slot = Slot::number(0.0);
            slot.value = Payload::Number(f64::from_bits(bits));
            let mut buf = Vec::new();
            encode_slot(&slot, &mut buf);
            assert_eq!(&buf[10..18], &0x7ff8_0000_0000_0000u64.to_be_bytes());
            let back = decode_slot(&buf).unwrap();
            let Payload::Number(n) = back.value else {
                panic!("expected number")
            };
            assert_eq!(n.to_bits(), 0x7ff8_0000_0000_0000);
            assert_eq!(encode_slots(&[back]), buf);

            // Old records remain readable, but their next write is canonical.
            buf[10..18].copy_from_slice(&bits.to_be_bytes());
            let legacy = decode_slot(&buf).unwrap();
            assert_eq!(
                &encode_slots(&[legacy])[10..18],
                &0x7ff8_0000_0000_0000u64.to_be_bytes()
            );
        }
    }

    #[test]
    fn non_nan_number_bits_are_unchanged() {
        for bits in [
            0,
            0x8000_0000_0000_0000,
            1,
            0x8000_0000_0000_0001,
            0x7ff0_0000_0000_0000,
            0xfff0_0000_0000_0000,
            0x7fef_ffff_ffff_ffff,
        ] {
            let slot = Slot::number(f64::from_bits(bits));
            let buf = encode_slots(&[slot]);
            assert_eq!(&buf[10..18], &bits.to_be_bytes());
            let Payload::Number(n) = decode_slot(&buf).unwrap().value else {
                panic!("expected number")
            };
            assert_eq!(n.to_bits(), bits);
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

    /// Regression: `decode_slot` is public and indexed its input with only a
    /// `debug_assert` on the width, so a short record (here one byte) panicked
    /// with an out-of-bounds index in release builds; and `decode_slots`
    /// silently dropped a trailing partial record. Both now refuse by length.
    #[test]
    fn rejects_records_of_the_wrong_width() {
        assert_eq!(decode_slot(&[7]), Err(SlotCodecError::BadLength(1)));
        assert_eq!(decode_slot(&[]), Err(SlotCodecError::BadLength(0)));
        assert_eq!(
            decode_slot(&[0; SLOT_RECORD_BYTES + 1]),
            Err(SlotCodecError::BadLength(SLOT_RECORD_BYTES + 1))
        );
        let mut bytes = encode_slots(&[Slot::integer(1)]);
        bytes.push(0);
        assert_eq!(
            decode_slots(&bytes),
            Err(SlotCodecError::BadLength(SLOT_RECORD_BYTES + 1))
        );
        assert_eq!(decode_slots(&[]), Ok(Vec::new()));
    }

    /// Regression (SNAP-2(c), Kani counterexample "all zeros except
    /// `rec[9] = 0xAA`"): the decoder ignored the reserved byte, the unused
    /// payload bytes and all but zero/non-zero of a Boolean byte, so one
    /// slot had many accepted encodings. Each is now refused by name.
    #[test]
    fn non_canonical_records_are_refused() {
        let mut rec = [0u8; SLOT_RECORD_BYTES];
        rec[9] = 0xAA;
        assert_eq!(decode_slot(&rec), Err(SlotCodecError::ReservedByte(0xAA)));

        let mut boolean = encode_slots(&[Slot::boolean(true)]);
        boolean[10] = 2;
        assert_eq!(decode_slot(&boolean), Err(SlotCodecError::BadBoolean(2)));

        let mut unused = encode_slots(&[Slot::integer(7)]);
        unused[19] = 1;
        assert_eq!(
            decode_slot(&unused),
            Err(SlotCodecError::UnusedPayloadBytes)
        );
        // Errors that preceded the canonicality checks are unchanged.
        let mut both = [0u8; SLOT_RECORD_BYTES];
        both[0] = 200;
        both[9] = 1;
        assert_eq!(decode_slot(&both), Err(SlotCodecError::BadKind(200)));
        both[0] = 0;
        both[8] = 99;
        assert_eq!(decode_slot(&both), Err(SlotCodecError::BadPayloadTag(99)));
    }

    /// Whether the record carries a Number payload whose bits are a NaN
    /// other than the canonical one: the documented carve-out, which
    /// decodes and re-encodes canonically.
    fn non_canonical_nan(rec: &[u8; SLOT_RECORD_BYTES]) -> bool {
        let bits = u64::from_be_bytes(rec[10..18].try_into().unwrap());
        rec[8] == P_NUM && f64::from_bits(bits).is_nan() && bits != 0x7ff8_0000_0000_0000
    }

    /// The canonicality property `decode(r) == Ok(s)` implies
    /// `encode(s) == r` outside the NaN carve-out, and the round trip
    /// `decode(encode(s)) == s` on what was accepted.
    fn check_canonical(rec: &[u8; SLOT_RECORD_BYTES]) -> bool {
        let Ok(slot) = decode_slot(rec) else {
            return false;
        };
        let again = encode_slots(&[slot]);
        if non_canonical_nan(rec) {
            assert_eq!(&again[10..18], &0x7ff8_0000_0000_0000u64.to_be_bytes());
        } else {
            assert_eq!(
                &again[..],
                &rec[..],
                "accepted {rec:?} re-encodes differently"
            );
            assert_eq!(decode_slot(&again), Ok(slot));
        }
        true
    }

    /// Exhaustive over every (kind byte, tag byte, reserved byte) with zero
    /// data, then over every value of every data byte under every valid
    /// tag and kind, with the other bytes zero: complements Kani's
    /// all-records proof with the concrete images it ranges over.
    #[test]
    fn accepted_records_are_canonical_exhaustive_by_byte() {
        let mut accepted = 0u32;
        for kind in 0..=255u8 {
            for tag in 0..=255u8 {
                for reserved in [0u8, 1, 0x80, 0xFF] {
                    let mut rec = [0u8; SLOT_RECORD_BYTES];
                    rec[0] = kind;
                    rec[8] = tag;
                    rec[9] = reserved;
                    accepted += u32::from(check_canonical(&rec));
                }
            }
        }
        for kind in (0..=255u8).filter(|&k| Kind::from_u8(k).is_some()) {
            for tag in P_NONE..=P_BIGINT {
                for at in 1..SLOT_RECORD_BYTES {
                    for value in 0..=255u8 {
                        let mut rec = [0u8; SLOT_RECORD_BYTES];
                        rec[0] = kind;
                        rec[8] = tag;
                        rec[at] = value;
                        accepted += u32::from(check_canonical(&rec));
                    }
                }
            }
        }
        assert!(accepted > 10_000, "only {accepted} accepted records");
    }

    /// Random records, biased towards valid kinds and tags and towards
    /// zero bytes so that many are accepted.
    #[test]
    fn accepted_records_are_canonical_random() {
        let mut rng = crate::wire::SplitMix(0x5EED_51A7);
        let kinds: Vec<u8> = (0..=255u8)
            .filter(|&k| Kind::from_u8(k).is_some())
            .collect();
        let mut accepted = 0u32;
        for _ in 0..200_000 {
            let mut rec = [0u8; SLOT_RECORD_BYTES];
            for byte in rec.iter_mut() {
                let r = rng.next();
                *byte = if r.is_multiple_of(3) {
                    (r >> 8) as u8
                } else {
                    0
                };
            }
            let r = rng.next();
            rec[0] = kinds[(r as usize) % kinds.len()];
            rec[8] = ((r >> 32) % 9) as u8;
            if (r >> 40).is_multiple_of(2) {
                rec[9] = 0;
            }
            if rec[8] == P_BOOL && (r >> 48).is_multiple_of(2) {
                rec[10] &= 1;
            }
            accepted += u32::from(check_canonical(&rec));
        }
        assert!(accepted > 1_000, "only {accepted} accepted records");
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
