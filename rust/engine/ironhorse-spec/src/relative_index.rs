//! The relative-index clamp that the Array, TypedArray and String methods
//! apply to a `ToIntegerOrInfinity` result.

use crate::number::{decompose, Decomposed};

/// The extended mathematical value of a Number that `ToIntegerOrInfinity`
/// (ECMA-262 §7.1.5) can return, i.e. an integral Number or ±∞, as an
/// `i128` saturated at `±2^64` (`None` for NaN and for a non-integral
/// finite Number, which `ToIntegerOrInfinity` never returns).
///
/// ±∞ map to `±2^64` and so does every finite value whose magnitude is at
/// least `2^64`. The models below only compare such a value with a length
/// below `2^64` or add it to one, so the saturation changes no result: any
/// `v ≥ 2^64 > len` gives `min(v, len) = len`, and any `v ≤ -2^64` gives
/// `len + v < 0`.
pub fn integer_or_infinity_saturated(number: u64) -> Option<i128> {
    const SATURATED: i128 = 1 << 64;
    let (negative, magnitude) = match decompose(number) {
        Decomposed::NaN => return None,
        Decomposed::Infinity { negative } => (negative, SATURATED),
        Decomposed::Zero { .. } => (false, 0),
        Decomposed::Finite {
            negative,
            significand,
            exponent,
        } => {
            let magnitude = if exponent >= 0 {
                if exponent >= 64 {
                    SATURATED
                } else {
                    (i128::from(significand) << exponent).min(SATURATED)
                }
            } else {
                let shift = exponent.unsigned_abs();
                if shift >= 64 || significand & ((1u64 << shift) - 1) != 0 {
                    // A nonzero value below 1, or one with a fraction.
                    return None;
                }
                i128::from(significand >> shift)
            };
            (negative, magnitude)
        }
    };
    Some(if negative { -magnitude } else { magnitude })
}

/// The clamp of a relative index, e.g. ECMA-262 §23.1.3.28
/// Array.prototype.slice ( start, end ), with `len` the object's length:
///
/// > 3. Let relativeStart be ? ToIntegerOrInfinity(start).
/// > 4. If relativeStart = -∞, let k be 0.
/// > 5. Else if relativeStart < 0, let k be max(len + relativeStart, 0).
/// > 6. Else, let k be min(relativeStart, len).
///
/// The same three steps recur for `end` (steps 7–10), and in `splice`,
/// `copyWithin`, `fill`, `toSpliced`, the %TypedArray% methods and
/// `String.prototype.slice`. `relative` is the bit pattern of the
/// `ToIntegerOrInfinity` result; `None` if it is not one (NaN, or a
/// non-integral finite Number).
pub fn relative_index(relative: u64, len: u64) -> Option<u64> {
    let r = integer_or_infinity_saturated(relative)?;
    let len = i128::from(len);
    let k = if relative == 0xFFF0_0000_0000_0000 {
        // Step 4: -∞.
        0
    } else if r < 0 {
        // Step 5.
        (len + r).max(0)
    } else {
        // Step 6 (including +∞).
        r.min(len)
    };
    Some(k as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b(x: f64) -> u64 {
        x.to_bits()
    }

    #[test]
    fn integer_or_infinity_classifies() {
        assert_eq!(integer_or_infinity_saturated(b(f64::NAN)), None);
        assert_eq!(integer_or_infinity_saturated(b(0.5)), None);
        assert_eq!(integer_or_infinity_saturated(b(-1.5)), None);
        assert_eq!(integer_or_infinity_saturated(b(5e-324)), None);
        assert_eq!(integer_or_infinity_saturated(b(-0.0)), Some(0));
        assert_eq!(integer_or_infinity_saturated(b(3.0)), Some(3));
        assert_eq!(integer_or_infinity_saturated(b(-7.0)), Some(-7));
        assert_eq!(
            integer_or_infinity_saturated(b(9007199254740992.0)),
            Some(1 << 53)
        );
        assert_eq!(
            integer_or_infinity_saturated(b(18446744073709549568.0)),
            Some((1 << 64) - 2048)
        );
        assert_eq!(integer_or_infinity_saturated(b(1e300)), Some(1 << 64));
        assert_eq!(integer_or_infinity_saturated(b(-1e300)), Some(-(1 << 64)));
        assert_eq!(
            integer_or_infinity_saturated(b(f64::INFINITY)),
            Some(1 << 64)
        );
    }

    #[test]
    fn slice_known_answers() {
        // test262 test/built-ins/Array/prototype/slice: S15.4.4.10_A1.*
        // (negative start and end counted from the end, starts and ends
        // beyond the length, on [0,1,2,3,4]) and S15.4.4.10_A2.1_T3/T4,
        // A2.2_T3/T4 (start and end of Infinity and -Infinity); then the
        // 2^32 and 2^53 - 1 length boundaries.
        let cases: &[(f64, u64, u64)] = &[
            (f64::NEG_INFINITY, 5, 0),
            (f64::INFINITY, 5, 5),
            (-2.0, 5, 3),
            (-5.0, 5, 0),
            (-6.0, 5, 0),
            (-1e300, 5, 0),
            (0.0, 5, 0),
            (-0.0, 5, 0),
            (3.0, 5, 3),
            (5.0, 5, 5),
            (9.0, 5, 5),
            (4294967296.0, 4294967295, 4294967295),
            (-4294967295.0, 4294967295, 0),
            (-1.0, 0, 0),
            (1.0, 0, 0),
            (-1.0, 9007199254740991, 9007199254740990),
            (9007199254740992.0, 9007199254740991, 9007199254740991),
        ];
        for &(n, len, want) in cases {
            assert_eq!(relative_index(b(n), len), Some(want), "{n} {len}");
        }
        assert_eq!(relative_index(b(f64::NAN), 3), None);
        assert_eq!(relative_index(b(2.5), 3), None);
    }
}
