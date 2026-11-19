//! The exact value of a Number, from its IEEE 754 binary64 bit pattern.

/// The classification of a binary64 bit pattern, with the exact value of
/// every finite nonzero Number.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Decomposed {
    /// Any NaN (ECMA-262 §6.1.6.1: all NaN values are one Number, NaN).
    NaN,
    /// `+∞𝔽` (`negative == false`) or `-∞𝔽`.
    Infinity { negative: bool },
    /// `+0𝔽` (`negative == false`) or `-0𝔽`.
    Zero { negative: bool },
    /// The finite nonzero value
    /// `(-1)^negative × significand × 2^exponent`, exactly, with
    /// `1 ≤ significand < 2^53` and `-1074 ≤ exponent ≤ 971`.
    Finite {
        negative: bool,
        significand: u64,
        exponent: i32,
    },
}

/// Decompose a binary64 bit pattern (IEEE 754-2019 §3.4, binary64:
/// sign `S` = bit 63, biased exponent `E` = bits 62..52, trailing
/// significand `T` = bits 51..0).
///
/// - `E = 2047`: `T = 0` is `(-1)^S × ∞`; otherwise NaN.
/// - `E = 0`: the value is `(-1)^S × 2^(1-1023) × (0 + 2^-52 × T)`
///   `= (-1)^S × T × 2^-1074` (zero when `T = 0`).
/// - otherwise: `(-1)^S × 2^(E-1023) × (1 + 2^-52 × T)`
///   `= (-1)^S × (2^52 + T) × 2^(E-1075)`.
pub fn decompose(bits: u64) -> Decomposed {
    let negative = bits >> 63 == 1;
    let biased = ((bits >> 52) & 0x7FF) as i32;
    let trailing = bits & ((1 << 52) - 1);
    match (biased, trailing) {
        (0x7FF, 0) => Decomposed::Infinity { negative },
        (0x7FF, _) => Decomposed::NaN,
        (0, 0) => Decomposed::Zero { negative },
        (0, t) => Decomposed::Finite {
            negative,
            significand: t,
            exponent: -1074,
        },
        (e, t) => Decomposed::Finite {
            negative,
            significand: (1 << 52) | t,
            exponent: e - 1075,
        },
    }
}

/// Split `significand / 2^shift` into its integer part and a comparison of
/// its fractional part with one half: `(floor(q), (q - floor(q)) cmp ½)`.
/// This is the exact information that "truncate", "floor" and
/// "roundTiesToEven" need. The models call it with `significand < 2^53`.
pub(crate) fn split_fraction(significand: u64, shift: u32) -> (u64, core::cmp::Ordering) {
    if shift == 0 {
        return (significand, core::cmp::Ordering::Less);
    }
    // For significand < 2^53, so a shift of 54 or more leaves an integer part
    // of 0 and a fraction strictly below 2^53 / 2^54 = ½.
    if shift >= 54 {
        return (0, core::cmp::Ordering::Less);
    }
    let integer = significand >> shift;
    let fraction = significand & ((1u64 << shift) - 1);
    let half = 1u64 << (shift - 1);
    (integer, fraction.cmp(&half))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_the_special_values() {
        assert_eq!(decompose(f64::NAN.to_bits()), Decomposed::NaN);
        assert_eq!(decompose(0x7FF0_0000_0000_0001), Decomposed::NaN);
        assert_eq!(decompose(0xFFFF_FFFF_FFFF_FFFF), Decomposed::NaN);
        assert_eq!(
            decompose(f64::INFINITY.to_bits()),
            Decomposed::Infinity { negative: false }
        );
        assert_eq!(
            decompose(f64::NEG_INFINITY.to_bits()),
            Decomposed::Infinity { negative: true }
        );
        assert_eq!(decompose(0), Decomposed::Zero { negative: false });
        assert_eq!(
            decompose((-0.0f64).to_bits()),
            Decomposed::Zero { negative: true }
        );
    }

    #[test]
    fn finite_values_are_exact() {
        assert_eq!(
            decompose(1.0f64.to_bits()),
            Decomposed::Finite {
                negative: false,
                significand: 1 << 52,
                exponent: -52
            }
        );
        assert_eq!(
            decompose((-1.5f64).to_bits()),
            Decomposed::Finite {
                negative: true,
                significand: 3 << 51,
                exponent: -52
            }
        );
        // The smallest subnormal, 2^-1074.
        assert_eq!(
            decompose(1),
            Decomposed::Finite {
                negative: false,
                significand: 1,
                exponent: -1074
            }
        );
        // The largest finite, (2^53 - 1) × 2^971.
        assert_eq!(
            decompose(f64::MAX.to_bits()),
            Decomposed::Finite {
                negative: false,
                significand: (1 << 53) - 1,
                exponent: 971
            }
        );
    }

    #[test]
    fn split_fraction_reports_the_half() {
        use core::cmp::Ordering::*;
        // 2.5 = 5 × 2^-1, 1.25 = 5 × 2^-2, 1.75 = 7 × 2^-2.
        assert_eq!(split_fraction(5, 1), (2, Equal));
        assert_eq!(split_fraction(5, 2), (1, Less));
        assert_eq!(split_fraction(7, 2), (1, Greater));
        assert_eq!(split_fraction((1 << 53) - 1, 53), (0, Greater));
        assert_eq!(split_fraction(1 << 52, 53), (0, Equal));
        assert_eq!(split_fraction((1 << 53) - 1, 54), (0, Less));
        assert_eq!(split_fraction(1, 1074), (0, Less));
        assert_eq!(split_fraction(9, 0), (9, Less));
    }
}
