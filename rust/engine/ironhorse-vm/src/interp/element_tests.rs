//! The typed-array element codec against the `ironhorse-spec` conversion
//! models, without Kani: the same properties as `element_proofs` (NUM-8),
//! exhaustively over every 8- and 16-bit pattern and on sampled Numbers and
//! 32-bit patterns.

use super::{decode_element_le, encode_element_le};
use crate::value::Slot;

fn numbers() -> impl Iterator<Item = u64> {
    let mut state = 0x0E1E_3E47_u64;
    let edges = [
        0.0f64,
        -0.0,
        0.5,
        1.5,
        2.5,
        -0.5,
        127.0,
        128.0,
        -129.0,
        254.5,
        255.5,
        256.0,
        32768.0,
        65536.0,
        2147483648.0,
        4294967295.0,
        4294967296.0,
        9007199254740993.0,
        18446744073709555712.0,
        f64::MAX,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NAN,
    ];
    edges
        .into_iter()
        .map(f64::to_bits)
        .chain((0..50_000).map(move |i| {
            state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = state;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            z ^= z >> 31;
            if i % 2 == 0 {
                z
            } else {
                // An exponent near the conversion widths.
                (z & 0x800F_FFFF_FFFF_FFFF) | ((1020 + (z >> 52) % 70) << 52)
            }
        }))
}

fn expected(kind: u8, bits: u64) -> (Vec<u8>, i64) {
    match kind {
        4 => {
            let v = ironhorse_spec::to_int8(bits);
            (v.to_le_bytes().to_vec(), i64::from(v))
        }
        5 => {
            let v = ironhorse_spec::to_int16(bits);
            (v.to_le_bytes().to_vec(), i64::from(v))
        }
        6 => {
            let v = ironhorse_spec::to_int32(bits);
            (v.to_le_bytes().to_vec(), i64::from(v))
        }
        7 => {
            let v = ironhorse_spec::to_uint8(bits);
            (v.to_le_bytes().to_vec(), i64::from(v))
        }
        8 => {
            let v = ironhorse_spec::to_uint16(bits);
            (v.to_le_bytes().to_vec(), i64::from(v))
        }
        9 => {
            let v = ironhorse_spec::to_uint32(bits);
            (v.to_le_bytes().to_vec(), i64::from(v))
        }
        10 => {
            let v = ironhorse_spec::to_uint8_clamp(bits);
            (v.to_le_bytes().to_vec(), i64::from(v))
        }
        _ => unreachable!(),
    }
}

fn canonical(value: i64) -> Slot {
    if value > i64::from(i32::MAX) {
        Slot::number(value as f64)
    } else {
        Slot::integer(value as i32)
    }
}

#[test]
fn integer_elements_store_the_spec_conversion() {
    for bits in numbers() {
        for kind in 4..=10u8 {
            let (bytes, value) = expected(kind, bits);
            let got = encode_element_le(kind, f64::from_bits(bits)).unwrap();
            assert_eq!(got, bytes, "kind {kind}, {:e}", f64::from_bits(bits));
            assert_eq!(decode_element_le(kind, &got).unwrap(), canonical(value));
        }
    }
}

#[test]
fn integer_decode_is_a_left_inverse_of_encode() {
    let round_trip = |kind: u8, raw: &[u8]| {
        let slot = decode_element_le(kind, raw).unwrap();
        let n = super::numeric::to_number(&slot);
        assert_eq!(encode_element_le(kind, n).unwrap(), raw, "kind {kind}");
    };
    for byte in 0..=u8::MAX {
        for kind in [4, 7, 10] {
            round_trip(kind, &[byte]);
        }
    }
    for half in 0..=u16::MAX {
        for kind in [5, 8] {
            round_trip(kind, &half.to_le_bytes());
        }
    }
    for bits in numbers() {
        for kind in [6, 9] {
            round_trip(kind, &(bits as u32).to_le_bytes());
            round_trip(kind, &((bits >> 32) as u32).to_le_bytes());
        }
    }
    for edge in [0u32, 1, 0x7FFF_FFFF, 0x8000_0000, 0xFFFF_FFFF] {
        round_trip(6, &edge.to_le_bytes());
        round_trip(9, &edge.to_le_bytes());
    }
}

#[test]
fn float_elements_canonicalise_nan_and_keep_other_bits() {
    for bits in numbers() {
        let n = f64::from_bits(bits);
        let stored = u64::from_le_bytes(encode_element_le(3, n).unwrap().try_into().unwrap());
        assert_eq!(
            stored,
            if n.is_nan() {
                0x7FF8_0000_0000_0000
            } else {
                bits
            }
        );
        let half = u16::from_le_bytes(encode_element_le(11, n).unwrap().try_into().unwrap());
        assert_eq!(half, ironhorse_spec::binary64_to_binary16(bits));
    }
}
