//! ECMA-262 §7.1.6–§7.1.12: the fixed-width integer conversions.
//!
//! Every model takes the binary64 bit pattern of a Number and returns the
//! mathematical integer result as the Rust integer type whose range is
//! exactly the clause's result range; the clause's result is `𝔽` of that
//! integer. All results are integers, so the result is never `-0𝔽`.

use core::cmp::Ordering;

use crate::number::{decompose, split_fraction, Decomposed};

/// The shared core of ToInt32 … ToUint8: `truncate(ℝ(number)) modulo 2^n`,
/// for `1 ≤ n ≤ 64`, or `0` when number is not finite or is a zero.
///
/// Each of ECMA-262 §7.1.6 ToInt32, §7.1.7 ToUint32, §7.1.8 ToInt16,
/// §7.1.9 ToUint16, §7.1.10 ToInt8 and §7.1.11 ToUint8 begins with the
/// same steps (here for ToInt32, with `n = 32`):
///
/// > 2. If number is not finite or number is either +0𝔽 or -0𝔽, return
/// >    +0𝔽.
/// > 3. Let int be truncate(ℝ(number)).
/// > 4. Let int32bit be int modulo 2^32.
///
/// "x modulo y" (§5.2.5) has the sign of `y`, so the result lies in
/// `[0, 2^n)`. With `|number| = significand × 2^exponent` exactly:
///
/// - `exponent ≥ 0`: `|number|` is an integer, so truncation is the
///   identity; when `exponent ≥ n` it is a multiple of `2^n`.
/// - `exponent < 0`: truncation is `floor(|number|)`, rounding the
///   magnitude toward zero.
///
/// A negative int is `-|int|`, whose residue is `(2^n - |int| mod 2^n)
/// mod 2^n`.
///
/// # Panics
///
/// If `n` is outside `1..=64` (a misuse of the model, not a Number case).
pub fn truncate_to_integer_mod_2n(number: u64, n: u32) -> u64 {
    assert!((1..=64).contains(&n), "modulus 2^{n} outside 2^1..=2^64");
    let modulus: u128 = 1 << n;
    let (negative, magnitude_mod) = match decompose(number) {
        // Step 2.
        Decomposed::NaN | Decomposed::Infinity { .. } | Decomposed::Zero { .. } => return 0,
        Decomposed::Finite {
            negative,
            significand,
            exponent,
        } => {
            // Step 3 on the magnitude, reduced modulo 2^n (step 4).
            let magnitude_mod = if exponent >= 0 {
                if exponent >= n as i32 {
                    0
                } else {
                    // significand < 2^53 and exponent < 64: fits in u128.
                    (u128::from(significand) << exponent) % modulus
                }
            } else {
                u128::from(split_fraction(significand, exponent.unsigned_abs()).0) % modulus
            };
            (negative, magnitude_mod)
        }
    };
    let residue = if negative {
        (modulus - magnitude_mod) % modulus
    } else {
        magnitude_mod
    };
    residue as u64
}

/// The signed reading of a residue in `[0, 2^n)`: the final step of the
/// signed conversions, e.g. ToInt32 step 5:
///
/// > 5. If int32bit ≥ 2^31, return 𝔽(int32bit - 2^32); otherwise return
/// >    𝔽(int32bit).
fn signed(residue: u64, n: u32) -> i64 {
    let residue = i128::from(residue);
    let modulus = 1i128 << n;
    (if residue >= modulus / 2 {
        residue - modulus
    } else {
        residue
    }) as i64
}

/// ECMA-262 §7.1.6 ToInt32 ( argument ), on a Number's bit pattern.
///
/// > 1. Let number be ? ToNumber(argument).
/// > 2. If number is not finite or number is either +0𝔽 or -0𝔽, return
/// >    +0𝔽.
/// > 3. Let int be truncate(ℝ(number)).
/// > 4. Let int32bit be int modulo 2^32.
/// > 5. If int32bit ≥ 2^31, return 𝔽(int32bit - 2^32); otherwise return
/// >    𝔽(int32bit).
pub fn to_int32(number: u64) -> i32 {
    signed(truncate_to_integer_mod_2n(number, 32), 32) as i32
}

/// ECMA-262 §7.1.7 ToUint32 ( argument ), on a Number's bit pattern.
///
/// > 2. If number is not finite or number is either +0𝔽 or -0𝔽, return
/// >    +0𝔽.
/// > 3. Let int be truncate(ℝ(number)).
/// > 4. Let int32bit be int modulo 2^32.
/// > 5. Return 𝔽(int32bit).
pub fn to_uint32(number: u64) -> u32 {
    truncate_to_integer_mod_2n(number, 32) as u32
}

/// ECMA-262 §7.1.8 ToInt16 ( argument ), on a Number's bit pattern.
///
/// > 2. If number is not finite or number is either +0𝔽 or -0𝔽, return
/// >    +0𝔽.
/// > 3. Let int be truncate(ℝ(number)).
/// > 4. Let int16bit be int modulo 2^16.
/// > 5. If int16bit ≥ 2^15, return 𝔽(int16bit - 2^16); otherwise return
/// >    𝔽(int16bit).
pub fn to_int16(number: u64) -> i16 {
    signed(truncate_to_integer_mod_2n(number, 16), 16) as i16
}

/// ECMA-262 §7.1.9 ToUint16 ( argument ), on a Number's bit pattern.
///
/// > 2. If number is not finite or number is either +0𝔽 or -0𝔽, return
/// >    +0𝔽.
/// > 3. Let int be truncate(ℝ(number)).
/// > 4. Let int16bit be int modulo 2^16.
/// > 5. Return 𝔽(int16bit).
pub fn to_uint16(number: u64) -> u16 {
    truncate_to_integer_mod_2n(number, 16) as u16
}

/// ECMA-262 §7.1.10 ToInt8 ( argument ), on a Number's bit pattern.
///
/// > 2. If number is not finite or number is either +0𝔽 or -0𝔽, return
/// >    +0𝔽.
/// > 3. Let int be truncate(ℝ(number)).
/// > 4. Let int8bit be int modulo 2^8.
/// > 5. If int8bit ≥ 2^7, return 𝔽(int8bit - 2^8); otherwise return
/// >    𝔽(int8bit).
pub fn to_int8(number: u64) -> i8 {
    signed(truncate_to_integer_mod_2n(number, 8), 8) as i8
}

/// ECMA-262 §7.1.11 ToUint8 ( argument ), on a Number's bit pattern.
///
/// > 2. If number is not finite or number is either +0𝔽 or -0𝔽, return
/// >    +0𝔽.
/// > 3. Let int be truncate(ℝ(number)).
/// > 4. Let int8bit be int modulo 2^8.
/// > 5. Return 𝔽(int8bit).
pub fn to_uint8(number: u64) -> u8 {
    truncate_to_integer_mod_2n(number, 8) as u8
}

/// ECMA-262 §7.1.12 ToUint8Clamp ( argument ), on a Number's bit pattern.
///
/// > 1. Let number be ? ToNumber(argument).
/// > 2. If number is NaN, return +0𝔽.
/// > 3. Let mv be the extended mathematical value of number.
/// > 4. Let clamped be the result of clamping mv between 0 and 255.
/// > 5. Let f be floor(clamped).
/// > 6. If clamped < f + 0.5, return 𝔽(f).
/// > 7. If clamped > f + 0.5, return 𝔽(f + 1).
/// > 8. If f is even, return 𝔽(f). Otherwise, return 𝔽(f + 1).
///
/// With `mv = significand × 2^exponent`: a negative mv (including `-∞`)
/// and a zero clamp to 0; `+∞` clamps to 255; a finite `mv ≥ 2^52`
/// (`exponent ≥ 0`) clamps to 255. Otherwise `f` and the comparison of
/// `clamped - f` with `0.5` are exact integer facts of the bit pattern,
/// and a clamped value of exactly 255 has `f = 255` and no fraction.
pub fn to_uint8_clamp(number: u64) -> u8 {
    match decompose(number) {
        // Step 2.
        Decomposed::NaN => 0,
        // Step 4 at the extended values ±∞ and at zero.
        Decomposed::Infinity { negative } => {
            if negative {
                0
            } else {
                255
            }
        }
        Decomposed::Zero { .. } => 0,
        Decomposed::Finite { negative: true, .. } => 0,
        Decomposed::Finite {
            negative: false,
            significand,
            exponent,
        } => {
            if exponent >= 0 {
                // mv ≥ 2^52 > 255.
                return 255;
            }
            // Step 5, and the fraction compared with ½ for steps 6–8.
            let (f, fraction) = split_fraction(significand, exponent.unsigned_abs());
            if f >= 255 {
                // mv ≥ 255: clamped = 255 = f with no fraction (step 6).
                return 255;
            }
            let f = f as u8;
            match fraction {
                Ordering::Less => f,
                Ordering::Greater => f + 1,
                Ordering::Equal => {
                    if f.is_multiple_of(2) {
                        f
                    } else {
                        f + 1
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests_support::SplitMix64;

    fn b(x: f64) -> u64 {
        x.to_bits()
    }

    const TWO_31: f64 = 2147483648.0;
    const TWO_32: f64 = 4294967296.0;
    const TWO_53: f64 = 9007199254740992.0;
    const TWO_63: f64 = 9223372036854775808.0;
    const TWO_64: f64 = 18446744073709551616.0;

    #[test]
    fn non_finite_and_zero_are_positive_zero() {
        for x in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 0.0, -0.0] {
            assert_eq!(to_int32(b(x)), 0, "{x}");
            assert_eq!(to_uint32(b(x)), 0, "{x}");
            assert_eq!(to_int16(b(x)), 0, "{x}");
            assert_eq!(to_uint16(b(x)), 0, "{x}");
            assert_eq!(to_int8(b(x)), 0, "{x}");
            assert_eq!(to_uint8(b(x)), 0, "{x}");
        }
        // Every NaN bit pattern, not just the canonical one.
        assert_eq!(to_uint32(0x7FF0_0000_0000_0001), 0);
        assert_eq!(to_uint32(0xFFF8_0000_0000_0000), 0);
    }

    #[test]
    fn to_int32_known_answers() {
        let cases: &[(f64, i32)] = &[
            (1.0, 1),
            (-1.0, -1),
            (1.9, 1),
            (-1.9, -1),
            (0.5, 0),
            (-0.5, 0),
            (f64::MIN_POSITIVE, 0),
            (5e-324, 0),
            (-5e-324, 0),
            (TWO_31 - 1.0, i32::MAX),
            (TWO_31, i32::MIN),
            (-TWO_31, i32::MIN),
            (-TWO_31 - 1.0, i32::MAX),
            (TWO_32, 0),
            (TWO_32 - 1.0, -1),
            (TWO_32 + 1.0, 1),
            (-TWO_32 - 1.0, -1),
            (TWO_32 + 0.5, 0),
            (TWO_53, 0),
            (TWO_53 - 1.0, -1),
            (TWO_53 + 2.0, 2),
            (TWO_63, 0),
            (TWO_64, 0),
            (f64::MAX, 0),
            (f64::MIN, 0),
            // 2^32 × 3 + 7 and its negation.
            (12884901895.0, 7),
            (-12884901895.0, -7),
            // 2^31 × 3 = 0x1_8000_0000.
            (6442450944.0, i32::MIN),
        ];
        for &(x, want) in cases {
            assert_eq!(to_int32(b(x)), want, "ToInt32({x})");
            assert_eq!(to_uint32(b(x)), want as u32, "ToUint32({x})");
        }
    }

    #[test]
    fn spec_note_identities_hold() {
        // §7.1.6 note: "ToInt32(ToUint32(x)) is the same value as
        // ToInt32(x) for all values of x." §7.1.7 note: "ToUint32(ToInt32(x))
        // is the same value as ToUint32(x) for all values of x."
        let mut rng = SplitMix64(7);
        for _ in 0..4000 {
            let x = rng.interesting_f64();
            let u = to_uint32(b(x));
            let i = to_int32(b(x));
            assert_eq!(to_int32(b(f64::from(u))), i, "{x}");
            assert_eq!(to_uint32(b(f64::from(i))), u, "{x}");
            // Truncation is odd, so negation commutes modulo 2^32.
            assert_eq!(to_int32(b(-x)), i.wrapping_neg(), "{x}");
        }
    }

    #[test]
    fn narrow_widths_known_answers() {
        assert_eq!(to_int16(b(32767.0)), 32767);
        assert_eq!(to_int16(b(32768.0)), -32768);
        assert_eq!(to_int16(b(-32769.0)), 32767);
        assert_eq!(to_uint16(b(65536.0)), 0);
        assert_eq!(to_uint16(b(65537.5)), 1);
        assert_eq!(to_uint16(b(-1.0)), 65535);
        assert_eq!(to_int8(b(127.0)), 127);
        assert_eq!(to_int8(b(128.0)), -128);
        assert_eq!(to_int8(b(-129.0)), 127);
        assert_eq!(to_int8(b(255.9)), -1);
        assert_eq!(to_uint8(b(256.0)), 0);
        assert_eq!(to_uint8(b(-1.0)), 255);
        assert_eq!(to_uint8(b(-0.5)), 0);
        assert_eq!(to_uint8(b(TWO_53 + 2.0)), 2);
    }

    #[test]
    fn full_width_modulus() {
        assert_eq!(truncate_to_integer_mod_2n(b(-1.0), 64), u64::MAX);
        assert_eq!(truncate_to_integer_mod_2n(b(TWO_63), 64), 1 << 63);
        assert_eq!(truncate_to_integer_mod_2n(b(TWO_64), 64), 0);
        assert_eq!(truncate_to_integer_mod_2n(b(-TWO_63), 64), 1 << 63);
        assert_eq!(truncate_to_integer_mod_2n(b(3.0), 1), 1);
        assert_eq!(truncate_to_integer_mod_2n(b(-3.0), 1), 1);
        assert_eq!(truncate_to_integer_mod_2n(b(-4.0), 1), 0);
    }

    #[test]
    #[should_panic(expected = "outside")]
    fn rejects_a_zero_width() {
        truncate_to_integer_mod_2n(b(1.0), 0);
    }

    #[test]
    fn to_uint8_clamp_known_answers() {
        let cases: &[(f64, u8)] = &[
            (f64::NAN, 0),
            (f64::NEG_INFINITY, 0),
            (f64::INFINITY, 255),
            (0.0, 0),
            (-0.0, 0),
            (-0.5, 0),
            (-1.0, 0),
            (5e-324, 0),
            (0.49999999999999994, 0),
            (0.5, 0),
            (0.5000000000000001, 1),
            (1.5, 2),
            (2.5, 2),
            (3.5, 4),
            (253.5, 254),
            (254.5, 254),
            (254.50000000000003, 255),
            (254.9, 255),
            (255.0, 255),
            (255.5, 255),
            (256.0, 255),
            (TWO_53, 255),
            (f64::MAX, 255),
            (1.0, 1),
            (1.4999999999999998, 1),
        ];
        for &(x, want) in cases {
            assert_eq!(to_uint8_clamp(b(x)), want, "ToUint8Clamp({x})");
        }
    }

    /// The platform's float semantics, independently of the model:
    /// truncation, then IEEE `fmod` (exact) for the residue.
    fn platform_mod_2n(x: f64, n: i32) -> u64 {
        if !x.is_finite() {
            return 0;
        }
        let modulus = 2f64.powi(n);
        x.trunc().rem_euclid(modulus) as u64
    }

    fn platform_clamp(x: f64) -> u8 {
        if x.is_nan() {
            return 0;
        }
        x.clamp(0.0, 255.0).round_ties_even() as u8
    }

    #[test]
    fn differential_against_platform_floats() {
        let mut rng = SplitMix64(0x1E9C_5EED);
        for i in 0..6000 {
            let bits = if i % 2 == 0 {
                rng.next()
            } else {
                rng.interesting_f64().to_bits()
            };
            let x = f64::from_bits(bits);
            for n in [8, 16, 32] {
                assert_eq!(
                    truncate_to_integer_mod_2n(bits, n as u32),
                    platform_mod_2n(x, n),
                    "mod 2^{n} of {x} ({bits:#018x})"
                );
            }
            assert_eq!(to_int32(bits), platform_mod_2n(x, 32) as u32 as i32);
            assert_eq!(to_int16(bits), platform_mod_2n(x, 16) as u16 as i16);
            assert_eq!(to_int8(bits), platform_mod_2n(x, 8) as u8 as i8);
            assert_eq!(to_uint8_clamp(bits), platform_clamp(x), "clamp {x}");
            // Small positive values exercise the clamp's rounding.
            let small = f64::from_bits(bits & 0x7FFF_FFFF_FFFF_FFFF) % 300.0;
            assert_eq!(to_uint8_clamp(small.to_bits()), platform_clamp(small));
            // Halfway points are exact in binary64.
            let tie = (rng.next() % 600) as f64 / 2.0 - 20.0;
            assert_eq!(to_uint8_clamp(tie.to_bits()), platform_clamp(tie), "{tie}");
        }
    }
}
