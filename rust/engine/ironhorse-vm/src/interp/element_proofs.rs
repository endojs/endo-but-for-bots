//! Kani proofs of the binary16 conversion (NUM-7) and the typed-array
//! element codec (NUM-8) against the `ironhorse-spec` models
//! (`rust/engine/VERIFICATION.md`).

use super::{decode_element_le, encode_element_le, f16_bits_to_f64, f64_to_f16_bits};
use crate::value::Slot;

// NUM-7 ----------------------------------------------------------------------

/// (a) Rounding binary64 to binary16 equals the roundTiesToEven model, NaN
/// to `0x7E00`, for every bit pattern.
#[kani::proof]
fn num7_f64_to_f16_matches_spec() {
    let bits: u64 = kani::any();
    let got = f64_to_f16_bits(f64::from_bits(bits));
    assert_eq!(got, ironhorse_spec::binary64_to_binary16(bits));
    // 1 + 2^-11 is the tie between 1 and 1 + 2^-10; it rounds to even (1).
    kani::cover!(
        bits == 0x3FF0_0200_0000_0000 && got == 0x3C00,
        "a tie rounding to even"
    );
    kani::cover!(
        (bits >> 52) & 0x7FF < 1023 - 14 && got & 0x7FFF != 0 && got & 0x7C00 == 0,
        "a binary16 subnormal result"
    );
    kani::cover!(
        (bits >> 52) & 0x7FF == 1023 + 15 && got & 0x7FFF == 0x7C00,
        "a finite value rounding to infinity"
    );
}

/// (b) Widening then rounding is the identity on every non-NaN binary16.
#[kani::proof]
#[kani::unwind(12)]
fn num7_f16_round_trip() {
    let half: u16 = kani::any();
    kani::assume(half & 0x7C00 != 0x7C00 || half & 0x3FF == 0);
    assert_eq!(f64_to_f16_bits(f16_bits_to_f64(half)), half);
    kani::cover!(half & 0x7C00 == 0 && half & 0x3FF != 0, "a subnormal");
}

/// (c) Widening equals the exact decode for every binary16, and every
/// binary16 NaN widens to a NaN.
#[kani::proof]
#[kani::unwind(12)]
fn num7_f16_to_f64_matches_spec() {
    let half: u16 = kani::any();
    let got = f16_bits_to_f64(half).to_bits();
    let want = ironhorse_spec::binary16_to_binary64(half);
    if half & 0x7C00 == 0x7C00 && half & 0x3FF != 0 {
        assert!(f64::from_bits(got).is_nan());
        kani::cover!(true, "a NaN");
    } else {
        assert_eq!(got, want);
        kani::cover!(half == 0x0001, "the smallest subnormal");
    }
}

// NUM-8 ----------------------------------------------------------------------

/// The element bytes as an `[u8; N]`, for a kind of width `N`.
fn encoded<const N: usize>(kind: u8, n: f64) -> [u8; N] {
    let bytes = encode_element_le(kind, n).expect("a Number element kind");
    assert_eq!(bytes.len(), N);
    let mut out = [0u8; N];
    out.copy_from_slice(&bytes);
    out
}

/// The slot RawBytesToNumeric's integer result takes: `Integer` when it
/// fits an int32 (every kind but Uint32 always does), else `Number`.
fn canonical_slot(value: i64) -> Slot {
    if value > i64::from(i32::MAX) {
        Slot::number(value as f64)
    } else {
        Slot::integer(value as i32)
    }
}

/// The Number a decoded integer element holds.
fn decoded_value(slot: Slot) -> f64 {
    super::numeric::to_number(&slot)
}

/// One integer element kind: for every Number `bits`, the stored bytes are
/// the model's conversion, and decoding them yields `Integer` of that value
/// (`Number` for a Uint32 above `i32::MAX`); for every byte pattern, the
/// decoded value encodes back to the same bytes. Returns the Number's bits
/// and the model value, for the caller's cover.
fn check_integer_kind<const N: usize>(kind: u8, model: fn(u64) -> ([u8; N], i64)) -> (u64, i64) {
    let bits: u64 = kani::any();
    let (want, value) = model(bits);
    let bytes: [u8; N] = encoded(kind, f64::from_bits(bits));
    assert_eq!(bytes, want);
    let slot = decode_element_le(kind, &bytes).expect("an integer element");
    assert_eq!(slot, canonical_slot(value));
    let raw: [u8; N] = kani::any();
    let back = decode_element_le(kind, &raw).expect("an integer element");
    assert_eq!(encoded::<N>(kind, decoded_value(back)), raw);
    (bits, value)
}

#[kani::proof]
fn num8_int8_element() {
    let (bits, value) = check_integer_kind::<1>(4, |b| {
        let v = ironhorse_spec::to_int8(b);
        (v.to_le_bytes(), i64::from(v))
    });
    kani::cover!(
        bits >> 63 == 0 && value < 0,
        "a positive Number stored negative"
    );
}

#[kani::proof]
fn num8_int16_element() {
    let (bits, value) = check_integer_kind::<2>(5, |b| {
        let v = ironhorse_spec::to_int16(b);
        (v.to_le_bytes(), i64::from(v))
    });
    kani::cover!(
        bits >> 63 == 1 && value > 0,
        "a negative Number stored positive"
    );
}

#[kani::proof]
fn num8_int32_element() {
    let (_, value) = check_integer_kind::<4>(6, |b| {
        let v = ironhorse_spec::to_int32(b);
        (v.to_le_bytes(), i64::from(v))
    });
    kani::cover!(value == i64::from(i32::MIN), "i32::MIN");
}

#[kani::proof]
fn num8_uint8_element() {
    let (bits, value) = check_integer_kind::<1>(7, |b| {
        let v = ironhorse_spec::to_uint8(b);
        (v.to_le_bytes(), i64::from(v))
    });
    kani::cover!(
        bits >> 63 == 1 && value == 255,
        "a negative Number stored as 255"
    );
}

#[kani::proof]
fn num8_uint16_element() {
    let (bits, value) = check_integer_kind::<2>(8, |b| {
        let v = ironhorse_spec::to_uint16(b);
        (v.to_le_bytes(), i64::from(v))
    });
    kani::cover!(
        (bits >> 52) & 0x7FF >= 1023 + 63 && value != 0,
        "a Number at or above 2^63 with a nonzero residue"
    );
}

#[kani::proof]
fn num8_uint32_element() {
    let (_, value) = check_integer_kind::<4>(9, |b| {
        let v = ironhorse_spec::to_uint32(b);
        (v.to_le_bytes(), i64::from(v))
    });
    kani::cover!(value > i64::from(i32::MAX), "a value decoding to a Number");
}

#[kani::proof]
fn num8_uint8_clamped_element() {
    let (bits, value) = check_integer_kind::<1>(10, |b| {
        let v = ironhorse_spec::to_uint8_clamp(b);
        (v.to_le_bytes(), i64::from(v))
    });
    kani::cover!(
        bits == 0x4004_0000_0000_0000 && value == 2,
        "2.5 rounding to even"
    );
}

/// Float64 stores every non-NaN Number's own bits and every NaN as the
/// canonical quiet NaN; decoding returns the stored bits.
#[kani::proof]
fn num8_float64_element() {
    let bits: u64 = kani::any();
    let bytes: [u8; 8] = encoded(3, f64::from_bits(bits));
    let nan = (bits >> 52) & 0x7FF == 0x7FF && bits & ((1 << 52) - 1) != 0;
    let want = if nan { 0x7FF8_0000_0000_0000 } else { bits };
    assert_eq!(u64::from_le_bytes(bytes), want);
    let raw: [u8; 8] = kani::any();
    let slot = decode_element_le(3, &raw).expect("a Number element");
    assert_eq!(slot, Slot::number(f64::from_le_bytes(raw)));
    kani::cover!(nan && bits != want, "a non-canonical NaN");
}

/// Float16 stores the NUM-7 rounding and decodes with the NUM-7 widening.
#[kani::proof]
#[kani::unwind(12)]
fn num8_float16_element() {
    let bits: u64 = kani::any();
    let bytes: [u8; 2] = encoded(11, f64::from_bits(bits));
    assert_eq!(
        u16::from_le_bytes(bytes),
        ironhorse_spec::binary64_to_binary16(bits)
    );
    let raw: [u8; 2] = kani::any();
    let half = u16::from_le_bytes(raw);
    let slot = decode_element_le(11, &raw).expect("a Number element");
    assert_eq!(slot, Slot::number(f16_bits_to_f64(half)));
    kani::cover!(
        half & 0x7C00 == 0 && half != 0,
        "a subnormal or zero pattern"
    );
}

/// Float32 stores the binary32 roundTiesToEven model of the Number (NaN as
/// `0x7FC0_0000`), and decodes every non-NaN binary32 to exactly the
/// model's binary64 widening and every binary32 NaN to a NaN. This rests on
/// Kani's encoding of the `f64 as f32` and `f32 as f64` casts, which the
/// KANI-3 canary checks at their boundaries; neither cast is on R1's list.
#[kani::proof]
fn num8_float32_element() {
    let bits: u64 = kani::any();
    let bytes: [u8; 4] = encoded(2, f64::from_bits(bits));
    let stored = u32::from_le_bytes(bytes);
    assert_eq!(stored, ironhorse_spec::binary64_to_binary32(bits));
    let raw: [u8; 4] = kani::any();
    let single = u32::from_le_bytes(raw);
    let slot = decode_element_le(2, &raw).expect("a Number element");
    let value = decoded_value(slot);
    if single & 0x7F80_0000 == 0x7F80_0000 && single & 0x7F_FFFF != 0 {
        assert!(value.is_nan());
        kani::cover!(single != 0x7FC0_0000, "a non-canonical binary32 NaN");
    } else {
        assert_eq!(
            value.to_bits(),
            ironhorse_spec::binary32_to_binary64(single)
        );
        kani::cover!(
            single & 0x7F80_0000 == 0 && single != 0,
            "a binary32 subnormal"
        );
    }
    kani::cover!(
        bits == 0x3FF0_0000_1000_0000 && stored == 0x3F80_0000,
        "a tie rounding to even"
    );
    kani::cover!(
        (bits >> 52) & 0x7FF < 1023 - 126 && stored & 0x7FFF_FFFF != 0 && stored & 0x7F80_0000 == 0,
        "a binary32 subnormal result"
    );
    kani::cover!(
        (bits >> 52) & 0x7FF == 1023 + 127 && stored & 0x7FFF_FFFF == 0x7F80_0000,
        "a finite value rounding to infinity"
    );
}
