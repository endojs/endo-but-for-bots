//! Integer-only kernels of the ECMA-262 Number conversions the engine
//! performs on its hot paths: the fixed-width integer conversions
//! (§7.1.6–§7.1.12) and the relative-index clamp that the Array, TypedArray
//! and String methods share.
//!
//! Every kernel works on a Number's IEEE 754 bit pattern with integer
//! arithmetic only. That makes the result identical on every host (no
//! float rounding mode or libm is involved) and keeps the kernels inside
//! what the Kani proofs can check soundly: Kani 0.68 silently miscomputes
//! float `%`, `rem_euclid`, `powi` and `powf` (rule R1 in
//! `rust/engine/VERIFICATION.md`), which the conversions used before. The
//! proofs in the `proofs` module (built under `cfg(kani)`) compare each
//! kernel with the independent `ironhorse-spec` model of its clause over
//! every input.

/// `truncate(ℝ(number)) modulo 2^64` for the Number with bit pattern
/// `bits`, and 0 for NaN, ±∞ and ±0: the shared core of ECMA-262
/// §7.1.6 ToInt32 … §7.1.11 ToUint8 (steps 2–4), at the widest width.
/// Each narrower conversion keeps the low bits, because every `2^n` with
/// `n ≤ 64` divides `2^64`.
///
/// A finite `|number| = significand × 2^(biased - 1075)` exactly, with the
/// implicit bit restored for a normal Number. Below 1 (biased < 1023,
/// including the zeros and the subnormals) the truncation is 0. At or above
/// `2^52` the value is an integer, and a left shift that drops the bits
/// above 2^64 is the reduction; in between, the right shift drops the
/// fraction, which is truncation toward zero. A negative Number reduces to
/// the two's complement of its magnitude's residue.
#[inline]
pub(crate) fn number_to_u64_wrapping(bits: u64) -> u64 {
    let biased = (bits >> 52) & 0x7FF;
    if biased == 0x7FF || biased < 1023 {
        return 0;
    }
    let significand = (bits & ((1 << 52) - 1)) | (1 << 52);
    let magnitude = if biased >= 1075 {
        let shift = biased - 1075;
        if shift >= 64 {
            0
        } else {
            significand << shift
        }
    } else {
        // 1 ≤ 1075 - biased ≤ 52.
        significand >> (1075 - biased)
    };
    if bits >> 63 == 0 {
        magnitude
    } else {
        magnitude.wrapping_neg()
    }
}

/// ECMA-262 §7.1.6 ToInt32 of the Number with bit pattern `bits`.
#[inline]
pub(crate) fn to_int32(bits: u64) -> i32 {
    number_to_u64_wrapping(bits) as u32 as i32
}

/// ECMA-262 §7.1.7 ToUint32 of the Number with bit pattern `bits`.
#[inline]
pub(crate) fn to_uint32(bits: u64) -> u32 {
    number_to_u64_wrapping(bits) as u32
}

/// ECMA-262 §7.1.8 ToInt16 of the Number with bit pattern `bits`.
#[inline]
pub(crate) fn to_int16(bits: u64) -> i16 {
    number_to_u64_wrapping(bits) as u16 as i16
}

/// ECMA-262 §7.1.9 ToUint16 of the Number with bit pattern `bits`.
#[inline]
pub(crate) fn to_uint16(bits: u64) -> u16 {
    number_to_u64_wrapping(bits) as u16
}

/// ECMA-262 §7.1.10 ToInt8 of the Number with bit pattern `bits`.
#[inline]
pub(crate) fn to_int8(bits: u64) -> i8 {
    number_to_u64_wrapping(bits) as u8 as i8
}

/// ECMA-262 §7.1.11 ToUint8 of the Number with bit pattern `bits`.
#[inline]
pub(crate) fn to_uint8(bits: u64) -> u8 {
    number_to_u64_wrapping(bits) as u8
}

/// ECMA-262 §7.1.12 ToUint8Clamp of the Number with bit pattern `bits`:
/// NaN and every value at or below 0 give 0, every value at or above 255
/// gives 255, and anything between rounds to the nearest integer, ties to
/// even.
///
/// Between 0.5 and 256 (biased exponents 1022 to 1030) the value is
/// `significand / 2^shift` with `45 ≤ shift ≤ 53`, so its integer part and
/// the comparison of its fraction with ½ are exact integer facts.
#[inline]
pub(crate) fn to_uint8_clamp(bits: u64) -> u8 {
    let biased = (bits >> 52) & 0x7FF;
    let trailing = bits & ((1 << 52) - 1);
    if bits >> 63 != 0 || (biased == 0x7FF && trailing != 0) || biased < 1022 {
        // Negative (including -0 and -∞), NaN, or below ½.
        return 0;
    }
    if biased >= 1023 + 8 {
        // At least 256, or +∞.
        return 255;
    }
    let significand = trailing | (1 << 52);
    let shift = 1075 - biased;
    let integer = significand >> shift;
    if integer >= 255 {
        return 255;
    }
    let fraction = significand & ((1 << shift) - 1);
    let half = 1 << (shift - 1);
    let round_up = fraction > half || (fraction == half && integer & 1 == 1);
    (integer + u64::from(round_up)) as u8
}

/// The relative-index clamp that ECMA-262 applies to a
/// `ToIntegerOrInfinity` result `relative` against a length `len`, e.g.
/// §23.1.3.28 Array.prototype.slice steps 4–5:
///
/// > 4. If relativeStart = -∞, let k be 0.
/// > 5. Else if relativeStart < 0, let k be max(len + relativeStart, 0).
/// > 6. Else, let k be min(relativeStart, len).
///
/// The same steps recur for `splice`, `copyWithin`, `fill`, `toSpliced`, the
/// TypedArray `slice`/`subarray`/`fill`/`copyWithin` and `String.prototype.slice`.
///
/// For a negative `relative`, `len + relative < 0` exactly when
/// `-relative > len`, and otherwise `-relative` is an integer at most `len`,
/// so the subtraction is exact in `u64`; a float addition is never needed.
/// The result is always in `0..=len`, for every `f64`. A NaN (which
/// `ToIntegerOrInfinity` never yields) gives `len`, as the float form this
/// replaces did.
///
/// `len` must be at most `2^53`, so that `len as f64` is exact (an array-like
/// length is at most `2^53 - 1`).
#[inline]
pub(crate) fn relative_index(relative: f64, len: u64) -> u64 {
    let bound = len as f64;
    if relative < 0.0 {
        let back = -relative;
        if back >= bound {
            0
        } else {
            // 0 < back < len ≤ 2^53, an integer: the cast is exact.
            len - back as u64
        }
    } else if relative < bound {
        // 0 ≤ relative < len: the cast is exact.
        relative as u64
    } else {
        // relative ≥ len, +∞, or NaN.
        len
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The conversions this module replaced, kept verbatim so the
    /// differential test below shows the rewrite is behaviour-identical on
    /// sampled inputs (the Kani proofs show it equals the spec on every
    /// input).
    mod legacy {
        pub(super) fn to_int32(n: f64) -> i32 {
            if !n.is_finite() {
                return 0;
            }
            let m = n.trunc();
            let m = m.rem_euclid(4294967296.0); // 2^32
            let u = m as u32; // exact: m in [0, 2^32)
            u as i32
        }

        pub(super) fn number_to_u64_wrapping(n: f64) -> u64 {
            if !n.is_finite() {
                return 0;
            }
            let n = n.trunc();
            if n.abs() < 9_223_372_036_854_775_808.0 {
                return n as i64 as u64;
            }
            n.rem_euclid(18_446_744_073_709_551_616.0) as u64
        }

        pub(super) fn to_wrapped(x: f64, bits: u32) -> u64 {
            if !x.is_finite() {
                return 0;
            }
            let m = 2f64.powi(bits as i32);
            x.trunc().rem_euclid(m) as u64
        }

        pub(super) fn to_uint32_inline(n: f64) -> u32 {
            if !n.is_finite() || n == 0.0 {
                return 0;
            }
            n.trunc().rem_euclid(4_294_967_296.0) as u32
        }

        fn round_half_even(x: f64) -> f64 {
            let r = x.round();
            if (x - x.trunc()).abs() == 0.5 {
                let lower = x.floor();
                if (lower as i64) % 2 == 0 {
                    lower
                } else {
                    x.ceil()
                }
            } else {
                r
            }
        }

        pub(super) fn uint8_clamped(n: f64) -> u8 {
            let v = if n.is_nan() || n <= 0.0 {
                0.0
            } else if n >= 255.0 {
                255.0
            } else {
                round_half_even(n)
            };
            v as u8
        }

        pub(super) fn relative_index(integer: f64, length: u64) -> u64 {
            if integer == f64::NEG_INFINITY {
                0
            } else if integer < 0.0 {
                (length as f64 + integer).max(0.0) as u64
            } else {
                integer.min(length as f64) as u64
            }
        }
    }

    struct SplitMix64(u64);

    impl SplitMix64 {
        fn next(&mut self) -> u64 {
            self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = self.0;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            z ^ (z >> 31)
        }

        /// Bit patterns concentrated where the conversions change
        /// behaviour: exponents from 2^-3 to 2^70, any sign, and often
        /// few significand bits so integers and ties are common.
        fn interesting(&mut self) -> u64 {
            let r = self.next();
            match r % 4 {
                0 => self.next(),
                _ => {
                    let biased = 1020 + (r >> 8) % 70;
                    let mut trailing = self.next() & ((1 << 52) - 1);
                    if r & 0x10 != 0 {
                        trailing &= !((1 << ((r >> 20) % 52)) - 1);
                    }
                    (r >> 63) << 63 | biased << 52 | trailing
                }
            }
        }
    }

    const EDGES: [f64; 24] = [
        0.0,
        -0.0,
        0.5,
        -0.5,
        1.0,
        -1.0,
        254.5,
        255.5,
        2147483647.0,
        2147483648.0,
        -2147483649.0,
        4294967295.0,
        4294967296.0,
        9007199254740991.0,
        9007199254740992.0,
        9223372036854775808.0,
        -9223372036854775808.0,
        18446744073709551616.0,
        18446744073709555712.0,
        f64::MAX,
        f64::MIN_POSITIVE,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NAN,
    ];

    fn samples() -> impl Iterator<Item = u64> {
        let mut rng = SplitMix64(0x5EED_0F1C);
        EDGES
            .iter()
            .map(|x| x.to_bits())
            .chain([
                0x7FF0_0000_0000_0001,
                0xFFF8_0000_0000_0000,
                1,
                0x8000_0000_0000_0001,
            ])
            .chain((0..200_000).map(move |_| rng.interesting()))
    }

    #[test]
    fn integer_conversions_match_the_float_forms_they_replace() {
        for bits in samples() {
            let n = f64::from_bits(bits);
            assert_eq!(to_int32(bits), legacy::to_int32(n), "{n:e}");
            assert_eq!(to_uint32(bits), legacy::to_int32(n) as u32, "{n:e}");
            assert_eq!(to_uint32(bits), legacy::to_uint32_inline(n), "{n:e}");
            assert_eq!(
                number_to_u64_wrapping(bits),
                legacy::number_to_u64_wrapping(n),
                "{n:e}"
            );
            assert_eq!(u64::from(to_uint8(bits)), legacy::to_wrapped(n, 8) & 0xFF);
            assert_eq!(
                u64::from(to_uint16(bits)),
                legacy::to_wrapped(n, 16) & 0xFFFF
            );
            assert_eq!(u64::from(to_uint32(bits)), legacy::to_wrapped(n, 32));
            assert_eq!(to_uint8_clamp(bits), legacy::uint8_clamped(n), "{n:e}");
        }
    }

    #[test]
    fn integer_conversions_match_the_spec_models() {
        for bits in samples() {
            assert_eq!(
                number_to_u64_wrapping(bits),
                ironhorse_spec::truncate_to_integer_mod_2n(bits, 64)
            );
            assert_eq!(to_int32(bits), ironhorse_spec::to_int32(bits));
            assert_eq!(to_uint32(bits), ironhorse_spec::to_uint32(bits));
            assert_eq!(to_int16(bits), ironhorse_spec::to_int16(bits));
            assert_eq!(to_uint16(bits), ironhorse_spec::to_uint16(bits));
            assert_eq!(to_int8(bits), ironhorse_spec::to_int8(bits));
            assert_eq!(to_uint8(bits), ironhorse_spec::to_uint8(bits));
            assert_eq!(to_uint8_clamp(bits), ironhorse_spec::to_uint8_clamp(bits));
        }
    }

    #[test]
    fn uint8_clamp_is_exhaustive_over_the_rounding_range() {
        // Every Number in [0.25, 256) with its low 40 significand bits
        // zero: 9 exponents × 2^12 high-significand patterns, each with
        // the lowest kept bit flipped to reach ties and near-ties.
        for biased in 1021u64..=1031 {
            for high in 0..1u64 << 12 {
                for low in [0u64, 1 << 39, (1 << 40) - 1, 1 << 40] {
                    let bits = biased << 52 | high << 40 | low;
                    let n = f64::from_bits(bits);
                    assert_eq!(to_uint8_clamp(bits), legacy::uint8_clamped(n), "{n}");
                    assert_eq!(to_uint8_clamp(bits), ironhorse_spec::to_uint8_clamp(bits));
                }
            }
        }
    }

    #[test]
    fn relative_index_matches_the_float_form_and_the_spec() {
        let mut rng = SplitMix64(0x000C_1A4D);
        let lengths = [0u64, 1, 2, 5, 255, 1 << 31, u32::MAX as u64, (1 << 53) - 1];
        for i in 0..100_000u64 {
            let len = if i % 3 == 0 {
                lengths[(i / 3 % lengths.len() as u64) as usize]
            } else {
                rng.next() % (1 << (rng.next() % 54))
            };
            let n = match i % 5 {
                0 => f64::from_bits(rng.interesting()).trunc(),
                1 => (rng.next() % (2 * len + 3)) as f64 - len as f64 - 1.0,
                2 => -((rng.next() % (len + 2)) as f64),
                3 => [f64::INFINITY, f64::NEG_INFINITY, -0.0, 0.0][(i / 5 % 4) as usize],
                _ => f64::from_bits(rng.next()).trunc(),
            };
            if n.is_nan() {
                continue;
            }
            let got = relative_index(n, len);
            assert_eq!(got, legacy::relative_index(n, len), "{n:e} {len}");
            assert_eq!(Some(got), ironhorse_spec::relative_index(n.to_bits(), len));
        }
        // A NaN keeps the float form's answer.
        assert_eq!(
            relative_index(f64::NAN, 7),
            legacy::relative_index(f64::NAN, 7)
        );
    }
}

#[cfg(kani)]
mod proofs {
    use super::*;

    /// NUM-1: the 2^64 core equals the model for every bit pattern.
    #[kani::proof]
    fn num1_number_to_u64_wrapping_matches_spec() {
        let bits: u64 = kani::any();
        let got = number_to_u64_wrapping(bits);
        assert_eq!(got, ironhorse_spec::truncate_to_integer_mod_2n(bits, 64));
        kani::cover!(
            bits >> 52 == 0x43F + 0x800 && got >> 63 == 1,
            "a value at or below -2^64 whose residue has bit 63 set"
        );
        kani::cover!(
            bits >> 52 == 0x433 && got & 1 == 1,
            "an odd integer just above 2^52"
        );
    }

    #[kani::proof]
    fn num1_to_int32_matches_spec() {
        let bits: u64 = kani::any();
        let got = to_int32(bits);
        assert_eq!(got, ironhorse_spec::to_int32(bits));
        kani::cover!(
            (bits >> 52) & 0x7FF > 1023 + 32 && got != 0,
            "a residue of a value above 2^33"
        );
    }

    #[kani::proof]
    fn num1_to_uint32_matches_spec() {
        let bits: u64 = kani::any();
        let got = to_uint32(bits);
        assert_eq!(got, ironhorse_spec::to_uint32(bits));
        kani::cover!(
            bits >> 63 == 1 && got > 1 << 31,
            "a negative value read as a large uint32"
        );
    }

    #[kani::proof]
    fn num1_to_int16_matches_spec() {
        let bits: u64 = kani::any();
        let got = to_int16(bits);
        assert_eq!(got, ironhorse_spec::to_int16(bits));
        kani::cover!(got == i16::MIN, "a residue of exactly 2^15");
    }

    #[kani::proof]
    fn num1_to_uint16_matches_spec() {
        let bits: u64 = kani::any();
        let got = to_uint16(bits);
        assert_eq!(got, ironhorse_spec::to_uint16(bits));
        kani::cover!(
            (bits >> 52) & 0x7FF >= 1023 + 63 && got != 0,
            "a value at or above 2^63 with a nonzero residue"
        );
    }

    #[kani::proof]
    fn num1_to_int8_matches_spec() {
        let bits: u64 = kani::any();
        let got = to_int8(bits);
        assert_eq!(got, ironhorse_spec::to_int8(bits));
        kani::cover!(
            got == -1 && bits >> 63 == 0,
            "a positive value wrapping to -1"
        );
    }

    #[kani::proof]
    fn num1_to_uint8_matches_spec() {
        let bits: u64 = kani::any();
        let got = to_uint8(bits);
        assert_eq!(got, ironhorse_spec::to_uint8(bits));
        kani::cover!(
            got == 255 && bits >> 63 == 1,
            "a negative value wrapping to 255"
        );
    }

    #[kani::proof]
    fn num1_to_uint8_clamp_matches_spec() {
        let bits: u64 = kani::any();
        let got = to_uint8_clamp(bits);
        assert_eq!(got, ironhorse_spec::to_uint8_clamp(bits));
        // 2.5 rounds to 2 (a tie to even); 3.5 rounds to 4.
        kani::cover!(
            bits == 0x4004_0000_0000_0000 && got == 2,
            "a tie rounding down to even"
        );
        // 254.5 = 0x406F_D000_0000_0000 and 255 = 0x406F_E000_0000_0000.
        kani::cover!(
            bits > 0x406F_D000_0000_0000 && bits < 0x406F_E000_0000_0000 && got == 255,
            "a value in (254.5, 255) rounding up to 255"
        );
    }

    /// NUM-6: the clamp equals the spec formula for every integral or
    /// infinite `relative` and every `len ≤ 2^53 - 1`, and stays in
    /// `0..=len` for every `f64`.
    #[kani::proof]
    fn num6_relative_index_matches_spec() {
        let bits: u64 = kani::any();
        let len: u64 = kani::any();
        kani::assume(len < 1 << 53);
        let got = relative_index(f64::from_bits(bits), len);
        assert!(got <= len);
        if let Some(want) = ironhorse_spec::relative_index(bits, len) {
            assert_eq!(got, want);
            kani::cover!(
                bits == f64::NEG_INFINITY.to_bits() && len > 0,
                "relative = -∞"
            );
            kani::cover!(
                bits >> 63 == 1 && got == 0 && bits != f64::NEG_INFINITY.to_bits(),
                "a finite relative below -len"
            );
            kani::cover!(
                bits >> 63 == 1 && got > 0 && got < len,
                "a negative relative counted from the end"
            );
            kani::cover!(
                bits >> 63 == 0 && got == len && bits != f64::INFINITY.to_bits() && len > 0,
                "a finite relative above len"
            );
        }
    }
}
