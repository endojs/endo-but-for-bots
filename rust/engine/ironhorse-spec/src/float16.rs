//! binary64 ↔ binary16 conversion (ECMA-262 §21.3.2.17 Math.f16round, and
//! the Float16 cases of NumericToRawBytes and RawBytesToNumeric).

use core::cmp::Ordering;

use crate::number::{decompose, split_fraction, Decomposed};

/// The binary16 encoding of `+∞`; OR in `0x8000` for `-∞`.
const BINARY16_INFINITY: u16 = 0x7C00;
/// The binary16 NaN this model produces. ECMA-262 lets an implementation
/// choose ("If value is NaN, rawBytes may be set to any implementation
/// chosen IEEE 754-2019 binary16 format Not-a-Number encoding",
/// NumericToRawBytes); `0x7E00` is the canonical quiet NaN, the choice
/// Ironhorse and XS make.
pub const BINARY16_NAN: u16 = 0x7E00;

/// Convert a Number to IEEE 754-2019 binary16 with roundTiesToEven,
/// returning the binary16 bit pattern. This is step 4 of ECMA-262
/// §21.3.2.17 Math.f16round ( x ):
///
/// > 2. If n is NaN, return NaN.
/// > 3. If n is one of +0𝔽, -0𝔽, +∞𝔽, or -∞𝔽, return n.
/// > 4. Let n16 be the result of converting n to IEEE 754-2019 binary16
/// >    format using roundTiesToEven mode.
///
/// and the Float16 case of NumericToRawBytes, which converts the same way
/// ("using roundTiesToEven mode") and stores the bits.
///
/// The derivation, from IEEE 754-2019 §3.3 (binary16: precision p = 11,
/// emin = -14, emax = 15) and §4.3.1 (roundTiesToEven):
///
/// - Every finite binary16 magnitude is `M × 2^k` with integers
///   `0 ≤ M < 2^11` and `k ≥ emin - (p - 1) = -24`.
/// - For `|x| = significand × 2^exponent`, the quantum of the binary16
///   neighbours of `x` is `2^k` with
///   `k = max(floor(log2 |x|) - (p - 1), -24)`, so the rounded magnitude
///   is `M × 2^k` with `M = roundTiesToEven(|x| / 2^k)`. If `M` rounds up
///   to `2^11`, the same value is `2^10 × 2^(k+1)`.
/// - §7.4 overflow: under roundTiesToEven a value whose rounded magnitude
///   (unbounded exponent) exceeds the largest finite number
///   `(2^11 - 1) × 2^5 = 65504` becomes `∞` of the same sign, that is
///   when `k > 5` after renormalising.
/// - Encoding: `k = -24` with `M < 2^10` is subnormal, bits `M`; otherwise
///   biased exponent `k + 25` (so `(2^10 + m) × 2^(e - 25)` with trailing
///   significand `m = M - 2^10`). `M = 0` is a zero of the input's sign.
pub fn binary64_to_binary16(number: u64) -> u16 {
    let sign = ((number >> 63) as u16) << 15;
    match decompose(number) {
        Decomposed::NaN => BINARY16_NAN,
        Decomposed::Infinity { .. } => sign | BINARY16_INFINITY,
        Decomposed::Zero { .. } => sign,
        Decomposed::Finite {
            significand,
            exponent,
            ..
        } => {
            let log2 = (63 - significand.leading_zeros()) as i32 + exponent;
            let mut k = (log2 - 10).max(-24);
            // M = roundTiesToEven(significand × 2^(exponent - k)).
            let mut m = if exponent >= k {
                // exponent - k ≤ 10 - (bit length of significand - 1) here.
                significand << (exponent - k)
            } else {
                let (q, fraction) = split_fraction(significand, (k - exponent) as u32);
                match fraction {
                    Ordering::Less => q,
                    Ordering::Greater => q + 1,
                    Ordering::Equal => q + (q & 1),
                }
            };
            if m == 1 << 11 {
                m = 1 << 10;
                k += 1;
            }
            if k > 5 {
                return sign | BINARY16_INFINITY;
            }
            let bits = if m < 1 << 10 {
                // Only possible at k = -24: a subnormal, or zero.
                m
            } else {
                (((k + 25) as u64) << 10) | (m - (1 << 10))
            };
            sign | bits as u16
        }
    }
}

/// Convert a binary16 bit pattern to the binary64 bit pattern of the same
/// value: step 5 of ECMA-262 §21.3.2.17 Math.f16round ("Let n64 be the
/// result of converting n16 to IEEE 754-2019 binary64 format") and the
/// Float16 case of RawBytesToNumeric ("If value is an IEEE 754-2019
/// binary16 NaN value, return the NaN Number value" — any binary64 NaN;
/// this model returns the quiet NaN `0x7FF8_0000_0000_0000`). Every
/// binary16 value is exactly representable in binary64, so there is no
/// rounding: decode `(-1)^S × M × 2^k` per IEEE 754-2019 §3.4 (binary16:
/// `E = 0` gives `M = T, k = -24`; otherwise `M = 2^10 + T, k = E - 25`)
/// and encode it as binary64 (`M × 2^k = (2^52 + T') × 2^(E' - 1075)`
/// with `E' = floor(log2 M) + k + 1023`).
pub fn binary16_to_binary64(half: u16) -> u64 {
    let sign = u64::from(half >> 15) << 63;
    let biased = i32::from((half >> 10) & 0x1F);
    let trailing = u64::from(half & 0x3FF);
    let (m, k) = match (biased, trailing) {
        (0x1F, 0) => return sign | 0x7FF0_0000_0000_0000,
        (0x1F, _) => return 0x7FF8_0000_0000_0000,
        (0, 0) => return sign,
        (0, t) => (t, -24),
        (e, t) => ((1 << 10) | t, e - 25),
    };
    let top = (63 - m.leading_zeros()) as i32;
    let biased64 = (top + k + 1023) as u64;
    let trailing64 = (m << (52 - top)) & ((1 << 52) - 1);
    sign | biased64 << 52 | trailing64
}

/// [`binary64_to_binary16`] on a Number.
pub fn f64_to_f16_bits(number: f64) -> u16 {
    binary64_to_binary16(number.to_bits())
}

/// [`binary16_to_binary64`] as a Number.
pub fn f16_bits_to_f64(half: u16) -> f64 {
    f64::from_bits(binary16_to_binary64(half))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests_support::SplitMix64;

    #[test]
    fn known_answers() {
        let cases: &[(f64, u16)] = &[
            (0.0, 0x0000),
            (-0.0, 0x8000),
            (1.0, 0x3C00),
            (-2.0, 0xC000),
            (f64::INFINITY, 0x7C00),
            (f64::NEG_INFINITY, 0xFC00),
            (f64::NAN, 0x7E00),
            (-f64::NAN, 0x7E00),
            // Largest finite, 65504 = 0x7BFF.
            (65504.0, 0x7BFF),
            // Up to the overflow threshold 65520 everything rounds to max.
            (65519.99999999999, 0x7BFF),
            // 65520 is the tie between 65504 (odd M) and 65536: to even, ∞.
            (65520.0, 0x7C00),
            (-65520.0, 0xFC00),
            (1e300, 0x7C00),
            // Smallest normal 2^-14 and largest subnormal.
            (6.103515625e-05, 0x0400),
            (6.097555160522461e-05, 0x03FF),
            // Smallest subnormal 2^-24, and the ties around it.
            (5.960464477539063e-08, 0x0001),
            // 2^-25 is the tie between 0 and 2^-24: to even, 0.
            (2.9802322387695312e-08, 0x0000),
            (-2.9802322387695312e-08, 0x8000),
            (2.980232238769532e-08, 0x0001),
            // 3 × 2^-25 is the tie between 2^-24 (odd) and 2^-23: up.
            (8.940696716308594e-08, 0x0002),
            (5e-324, 0x0000),
            (-5e-324, 0x8000),
            // 1 + 2^-11 ties between 1 and 1 + 2^-10: to even, 1.
            (1.00048828125, 0x3C00),
            // 1 + 3 × 2^-11 ties between 1 + 2^-10 (odd) and 1 + 2^-9: up.
            (1.00146484375, 0x3C02),
            (1.0004882812500002, 0x3C01),
            // The largest subnormal rounding up into the smallest normal.
            (6.1005353927612305e-05, 0x0400),
            (0.1, 0x2E66),
            (1.0 / 3.0, 0x3555),
            (2048.0, 0x6800),
            (2049.0, 0x6800),
            (2051.0, 0x6802),
        ];
        for &(x, want) in cases {
            assert_eq!(f64_to_f16_bits(x), want, "f16({x:e}) = {want:#06x}");
        }
    }

    #[test]
    fn decode_known_answers() {
        assert_eq!(f16_bits_to_f64(0x3C00), 1.0);
        assert_eq!(f16_bits_to_f64(0x7BFF), 65504.0);
        assert_eq!(f16_bits_to_f64(0x0001), 5.960464477539063e-08);
        assert_eq!(f16_bits_to_f64(0x03FF), 6.097555160522461e-05);
        assert_eq!(f16_bits_to_f64(0x0400), 6.103515625e-05);
        assert_eq!(f16_bits_to_f64(0x8000).to_bits(), (-0.0f64).to_bits());
        assert_eq!(f16_bits_to_f64(0x7C00), f64::INFINITY);
        assert_eq!(f16_bits_to_f64(0xFC00), f64::NEG_INFINITY);
        assert!(f16_bits_to_f64(0x7E00).is_nan());
        assert!(f16_bits_to_f64(0xFC01).is_nan());
    }

    /// The value of a binary16 pattern via platform float arithmetic,
    /// independently of the model: `M × 2^k` is exact in binary64.
    fn platform_decode(half: u16) -> f64 {
        let sign = if half & 0x8000 != 0 { -1.0 } else { 1.0 };
        let e = i32::from((half >> 10) & 0x1F);
        let t = f64::from(half & 0x3FF);
        match e {
            0x1F if t == 0.0 => sign * f64::INFINITY,
            0x1F => f64::NAN,
            0 => sign * t * 2f64.powi(-24),
            _ => sign * (1024.0 + t) * 2f64.powi(e - 25),
        }
    }

    #[test]
    fn decode_matches_platform_exhaustively() {
        for half in 0..=u16::MAX {
            let model = f16_bits_to_f64(half);
            let platform = platform_decode(half);
            if platform.is_nan() {
                assert!(model.is_nan(), "{half:#06x}");
            } else {
                assert_eq!(model.to_bits(), platform.to_bits(), "{half:#06x}");
            }
        }
    }

    #[test]
    fn round_trip_is_identity_on_non_nan() {
        for half in 0..=u16::MAX {
            if (half & 0x7C00) == 0x7C00 && (half & 0x3FF) != 0 {
                assert_eq!(binary64_to_binary16(binary16_to_binary64(half)), 0x7E00);
            } else {
                assert_eq!(binary64_to_binary16(binary16_to_binary64(half)), half);
            }
        }
    }

    /// Round to nearest binary16 by search over the platform-decoded
    /// finite non-negative binary16 values, ties to the even pattern.
    /// `x - lo` and `hi - x` are exact: either `lo = 0`, or
    /// `lo ≤ x ≤ hi ≤ 2 lo` (Sterbenz).
    fn platform_round(x: f64, table: &[(f64, u16)]) -> u16 {
        if x.is_nan() {
            return 0x7E00;
        }
        let sign = if x.is_sign_negative() { 0x8000 } else { 0 };
        let a = x.abs();
        // Overflow threshold: max + half an ulp of max = 65520.
        if a >= 65520.0 {
            return sign | 0x7C00;
        }
        let hi_index = table.partition_point(|&(v, _)| v < a);
        let (hi, hi_bits) = table[hi_index];
        if hi == a {
            return sign | hi_bits;
        }
        let (lo, lo_bits) = table[hi_index - 1];
        let bits = match (a - lo).partial_cmp(&(hi - a)).unwrap() {
            Ordering::Less => lo_bits,
            Ordering::Greater => hi_bits,
            Ordering::Equal if lo_bits % 2 == 0 => lo_bits,
            Ordering::Equal => hi_bits,
        };
        sign | bits
    }

    #[test]
    fn differential_against_platform_floats() {
        // Finite non-negative binary16 values in increasing order, then a
        // sentinel 65536 (the value "M = 2^11" at the top exponent).
        let mut table: Vec<(f64, u16)> = (0..0x7C00u16).map(|h| (platform_decode(h), h)).collect();
        table.push((65536.0, 0x7C00));
        let mut rng = SplitMix64(0xF16);
        for i in 0..8000 {
            let x = match i % 4 {
                0 => f64::from_bits(rng.next()),
                1 => rng.interesting_f64(),
                // Concentrate on the binary16 range, including subnormals.
                2 => {
                    let r = rng.next();
                    let biased = 1023 - 26 + (r >> 52) % 44;
                    f64::from_bits((r & 1 << 63) | biased << 52 | (rng.next() >> 12))
                }
                // Exact ties: odd multiples of half a binary16 quantum.
                _ => {
                    let r = rng.next();
                    let k = (r % 31) as i32 - 25;
                    let m = (rng.next() % 4096) | 1;
                    m as f64 * 2f64.powi(k)
                }
            };
            assert_eq!(
                f64_to_f16_bits(x),
                platform_round(x, &table),
                "f16({x:e}) bits {:#018x}",
                x.to_bits()
            );
        }
    }
}
