//! binary64 ↔ binary32 conversion (the Float32 cases of ECMA-262
//! §25.1.3.17 NumericToRawBytes and §25.1.3.15 RawBytesToNumeric).

use core::cmp::Ordering;

use crate::number::{decompose, split_fraction, Decomposed};

/// The binary32 encoding of `+∞`; OR in `0x8000_0000` for `-∞`.
const BINARY32_INFINITY: u32 = 0x7F80_0000;
/// The binary32 NaN this model produces. NumericToRawBytes lets an
/// implementation choose ("If value is NaN, rawBytes may be set to any
/// implementation chosen IEEE 754-2019 binary32 format Not-a-Number
/// encoding"); `0x7FC0_0000` is the canonical quiet NaN, the choice
/// Ironhorse makes.
pub const BINARY32_NAN: u32 = 0x7FC0_0000;

/// Convert a Number to IEEE 754-2019 binary32 with roundTiesToEven,
/// returning the binary32 bit pattern: the Float32 case of §25.1.3.17
/// NumericToRawBytes ( type, value, isLittleEndian ),
///
/// > 1. If type is float32, then
/// >    a. Let rawBytes be a List whose elements are the 4 bytes that are
/// >       the result of converting value to IEEE 754-2019 binary32 format
/// >       using roundTiesToEven mode. The bytes are arranged in little
/// >       endian order. If value is NaN, rawBytes may be set to any
/// >       implementation chosen IEEE 754-2019 binary32 format
/// >       Not-a-Number encoding.
///
/// The derivation is [`crate::float16::binary64_to_binary16`]'s with the
/// binary32 parameters (IEEE 754-2019 §3.3: precision p = 24, emin = -126,
/// emax = 127):
///
/// - Every finite binary32 magnitude is `M × 2^k` with integers
///   `0 ≤ M < 2^24` and `k ≥ emin - (p - 1) = -149`.
/// - For `|x| = significand × 2^exponent` the quantum of the binary32
///   neighbours of `x` is `2^k` with `k = max(floor(log2 |x|) - 23, -149)`,
///   so the rounded magnitude is `M × 2^k` with
///   `M = roundTiesToEven(|x| / 2^k)`; `M = 2^24` renormalises to
///   `2^23 × 2^(k+1)`.
/// - §7.4 overflow: a rounded magnitude above the largest finite number
///   `(2^24 - 1) × 2^104` becomes `∞` of the same sign, that is when
///   `k > 104` after renormalising.
/// - Encoding: `k = -149` with `M < 2^23` is subnormal, bits `M`; otherwise
///   biased exponent `k + 150` and trailing significand `M - 2^23`. `M = 0`
///   is a zero of the input's sign.
pub fn binary64_to_binary32(number: u64) -> u32 {
    let sign = ((number >> 63) as u32) << 31;
    match decompose(number) {
        Decomposed::NaN => BINARY32_NAN,
        Decomposed::Infinity { .. } => sign | BINARY32_INFINITY,
        Decomposed::Zero { .. } => sign,
        Decomposed::Finite {
            significand,
            exponent,
            ..
        } => {
            let log2 = (63 - significand.leading_zeros()) as i32 + exponent;
            let mut k = (log2 - 23).max(-149);
            // M = roundTiesToEven(significand × 2^(exponent - k)). Every
            // finite binary64 has k > exponent: a normal one has a 53-bit
            // significand, so k = exponent + 29 unless clamped at -149, and
            // a subnormal one has exponent -1074.
            let (q, fraction) = split_fraction(significand, (k - exponent) as u32);
            let mut m = match fraction {
                Ordering::Less => q,
                Ordering::Greater => q + 1,
                Ordering::Equal => q + (q & 1),
            };
            if m == 1 << 24 {
                m = 1 << 23;
                k += 1;
            }
            if k > 104 {
                return sign | BINARY32_INFINITY;
            }
            let bits = if m < 1 << 23 {
                // Only possible at k = -149: a subnormal, or zero.
                m
            } else {
                (((k + 150) as u64) << 23) | (m - (1 << 23))
            };
            sign | bits as u32
        }
    }
}

/// Convert a binary32 bit pattern to the binary64 bit pattern of the same
/// value: the Float32 case of §25.1.3.15 RawBytesToNumeric ("If type is
/// float32, then a. Let value be the byte elements of rawBytes concatenated
/// and interpreted as a little-endian bit string encoding of an IEEE
/// 754-2019 binary32 value. b. If value is an IEEE 754-2019 binary32 NaN
/// value, return the NaN Number value. c. Return the Number value that
/// corresponds to value."). Every binary32 value is exactly representable
/// in binary64, so there is no rounding: decode `(-1)^S × M × 2^k` per IEEE
/// 754-2019 §3.4 (`E = 0` gives `M = T, k = -149`; otherwise
/// `M = 2^23 + T, k = E - 150`) and encode it as binary64. A NaN gives the
/// quiet NaN `0x7FF8_0000_0000_0000`.
pub fn binary32_to_binary64(single: u32) -> u64 {
    let sign = u64::from(single >> 31) << 63;
    let biased = ((single >> 23) & 0xFF) as i32;
    let trailing = u64::from(single & 0x7F_FFFF);
    let (m, k) = match (biased, trailing) {
        (0xFF, 0) => return sign | 0x7FF0_0000_0000_0000,
        (0xFF, _) => return 0x7FF8_0000_0000_0000,
        (0, 0) => return sign,
        (0, t) => (t, -149),
        (e, t) => ((1 << 23) | t, e - 150),
    };
    let top = (63 - m.leading_zeros()) as i32;
    let biased64 = (top + k + 1023) as u64;
    let trailing64 = (m << (52 - top)) & ((1 << 52) - 1);
    sign | biased64 << 52 | trailing64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests_support::SplitMix64;

    #[test]
    fn known_answers() {
        let cases: &[(f64, u32)] = &[
            (0.0, 0x0000_0000),
            (-0.0, 0x8000_0000),
            (1.0, 0x3F80_0000),
            (-2.0, 0xC000_0000),
            (f64::INFINITY, 0x7F80_0000),
            (f64::NEG_INFINITY, 0xFF80_0000),
            (f64::NAN, 0x7FC0_0000),
            (-f64::NAN, 0x7FC0_0000),
            // Largest finite, (2 - 2^-23) × 2^127.
            (3.4028234663852886e38, 0x7F7F_FFFF),
            // The overflow threshold (2 - 2^-24) × 2^127 is a tie between
            // the largest finite (odd M) and 2^128: to even, ∞.
            (3.4028235677973366e38, 0x7F80_0000),
            (3.4028235677973362e38, 0x7F7F_FFFF),
            (1e300, 0x7F80_0000),
            // Smallest normal 2^-126 and smallest subnormal 2^-149.
            (1.1754943508222875e-38, 0x0080_0000),
            (1.401298464324817e-45, 0x0000_0001),
            // 2^-150 ties between 0 and 2^-149: to even, 0.
            (7.006492321624085e-46, 0x0000_0000),
            (-7.006492321624085e-46, 0x8000_0000),
            // 3 × 2^-150 ties between 2^-149 (odd) and 2^-148: up.
            (2.1019476964872256e-45, 0x0000_0002),
            (5e-324, 0x0000_0000),
            // 1 + 2^-24 ties between 1 and 1 + 2^-23: to even, 1.
            (1.0000000596046448, 0x3F80_0000),
            // 1 + 3 × 2^-24 ties between 1 + 2^-23 (odd) and 1 + 2^-22: up.
            (1.0000001788139343, 0x3F80_0002),
            (0.1, 0x3DCC_CCCD),
            (16777217.0, 0x4B80_0000),
            (16777219.0, 0x4B80_0002),
        ];
        for &(x, want) in cases {
            assert_eq!(
                binary64_to_binary32(x.to_bits()),
                want,
                "f32({x:e}) = {want:#010x}"
            );
        }
    }

    /// rustc defines `f64 as f32` as IEEE 754 roundTiesToEven, overflow
    /// to infinity (the Rust Reference's numeric cast semantics), on every
    /// platform, so the native cast is an independent reference for the
    /// model.
    #[test]
    fn matches_the_platform_cast() {
        let mut rng = SplitMix64(0x0F32);
        for i in 0..2_000_000u64 {
            let x = match i % 4 {
                0 => f64::from_bits(rng.next()),
                1 => rng.interesting_f64(),
                // Concentrate on the binary32 range, subnormals included.
                2 => {
                    let r = rng.next();
                    let biased = 1023 - 152 + (r >> 52) % 284;
                    f64::from_bits((r & 1 << 63) | biased << 52 | (rng.next() >> 12))
                }
                // Values near ties: few significand bits below the
                // binary32 quantum.
                _ => {
                    let r = rng.next();
                    let biased = 1023 - 152 + (r >> 52) % 284;
                    let low = (rng.next() & 0x1FFF_FFFF) & !((1 << (r % 29)) - 1);
                    f64::from_bits((r & 1 << 63) | biased << 52 | (r & 0xF_FFFF_E000_0000) | low)
                }
            };
            let want = if x.is_nan() {
                BINARY32_NAN
            } else {
                (x as f32).to_bits()
            };
            assert_eq!(binary64_to_binary32(x.to_bits()), want, "f32({x:e})");
        }
    }

    /// Decoding equals the platform widening for every biased exponent
    /// and a spread of trailing significands, and narrowing the decoded
    /// value gives the binary32 back.
    #[test]
    fn decode_matches_the_platform_and_round_trips() {
        let mut rng = SplitMix64(0x032F);
        for biased in 0..=0xFFu32 {
            for j in 0..4096u32 {
                let trailing = match j {
                    0 => 0,
                    1 => 1,
                    2 => 0x7F_FFFF,
                    _ => (rng.next() as u32) & 0x7F_FFFF,
                };
                for sign in [0, 1u32 << 31] {
                    let single = sign | biased << 23 | trailing;
                    let model = binary32_to_binary64(single);
                    let platform = f64::from(f32::from_bits(single));
                    if platform.is_nan() {
                        assert_eq!(model, 0x7FF8_0000_0000_0000, "{single:#010x}");
                        assert_eq!(binary64_to_binary32(model), BINARY32_NAN);
                    } else {
                        assert_eq!(model, platform.to_bits(), "{single:#010x}");
                        assert_eq!(binary64_to_binary32(model), single, "{single:#010x}");
                    }
                }
            }
        }
    }
}
