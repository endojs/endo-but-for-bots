//! Number arithmetic on int32-valued operands (ECMA-262 §6.1.6.1.1,
//! §6.1.6.1.4–§6.1.6.1.8), the Number value of an exact integer, and the
//! Number comparisons SameValue, SameValueZero and Number::equal.
//!
//! Results are binary64 bit patterns, so a proof compares them with
//! `to_bits` and `-0𝔽` is distinguished from `+0𝔽`.

use crate::number::{decompose, Decomposed};

/// The bit pattern of `NaN` this module returns (any NaN is the one
/// language value NaN; §6.1.6.1).
pub const NAN: u64 = 0x7FF8_0000_0000_0000;
/// The bit pattern of `-0𝔽`.
pub const NEGATIVE_ZERO: u64 = 1 << 63;

/// "The Number value for x" (ECMA-262 §6.1.6.1, written 𝔽(x)) for an
/// integer `x` with `|x| < 2^127`: the binary64 value nearest `x`, ties to
/// the one with an even significand (IEEE 754-2019 roundTiesToEven). `x =
/// 0` gives `+0𝔽`. Every such `x` is below `2^1024`, so the result is finite.
///
/// With `b` the bit length of `|x|`, `|x| = q × 2^(b-53) + rest` for the
/// 53-bit (or shorter) `q`; rounding adds one to `q` when `rest` exceeds
/// half the quantum, or equals it with `q` odd, and a carry out of 53 bits
/// renormalises.
pub fn number_value_of_integer(x: i128) -> u64 {
    if x == 0 {
        return 0;
    }
    let sign = u64::from(x < 0) << 63;
    let magnitude = x.unsigned_abs();
    let bit_length = 128 - magnitude.leading_zeros();
    let (mut significand, mut exponent) = if bit_length <= 53 {
        // Exact: shift up to the 53-bit significand.
        (magnitude << (53 - bit_length), bit_length as i32 - 53)
    } else {
        let drop = bit_length - 53;
        let q = magnitude >> drop;
        let rest = magnitude & ((1u128 << drop) - 1);
        let half = 1u128 << (drop - 1);
        let rounded = if rest > half || (rest == half && q & 1 == 1) {
            q + 1
        } else {
            q
        };
        (rounded, drop as i32)
    };
    if significand == 1 << 53 {
        significand >>= 1;
        exponent += 1;
    }
    // value = significand × 2^exponent with 2^52 ≤ significand < 2^53:
    // biased exponent = exponent + 52 + 1023.
    let biased = (exponent + 1075) as u64;
    sign | biased << 52 | (significand as u64 & ((1 << 52) - 1))
}

/// ECMA-262 §6.1.6.1.7 Number::add ( x, y ) on Numbers whose values are the
/// integers `x` and `y`:
///
/// > 1. If x is NaN or y is NaN, return NaN.
/// > …
/// > 6. Assert: x and y are both finite.
/// > 7. If x is -0𝔽 and y is -0𝔽, return -0𝔽.
/// > 8. Return 𝔽(ℝ(x) + ℝ(y)).
///
/// An int32 is never `-0𝔽`, so step 7 never applies: an exact zero sum is
/// `𝔽(0) = +0𝔽`.
pub fn add_int32(x: i32, y: i32) -> u64 {
    number_value_of_integer(i128::from(x) + i128::from(y))
}

/// ECMA-262 §6.1.6.1.8 Number::subtract ( x, y ):
///
/// > 1. Return Number::add(x, Number::unaryMinus(y)).
///
/// For an int32 `y = 0`, `Number::unaryMinus(y)` is `-0𝔽`, and
/// Number::add(x, -0𝔽) is `x` (step 8: `𝔽(ℝ(x) + 0)`, as `x` is never
/// `-0𝔽`). Otherwise the operands are integers and the result is
/// `𝔽(ℝ(x) - ℝ(y))`.
pub fn subtract_int32(x: i32, y: i32) -> u64 {
    number_value_of_integer(i128::from(x) - i128::from(y))
}

/// ECMA-262 §6.1.6.1.4 Number::multiply ( x, y ) on int32-valued operands.
/// The finite, non-zero-operand case is `𝔽(ℝ(x) × ℝ(y))`; a zero product's
/// sign follows IEEE 754-2019 §6.3 ("the sign of a product … is the
/// exclusive OR of the operands' signs"), the rule the clause's `-0𝔽` steps
/// and test262's S11.5.1_A4_T2 (`0 * -0 === -0`, `-0 * -0 === 0`) encode:
/// `+0 × y` is `-0𝔽` for a negative `y`.
pub fn multiply_int32(x: i32, y: i32) -> u64 {
    let product = i128::from(x) * i128::from(y);
    if product == 0 && (x < 0 || y < 0) {
        NEGATIVE_ZERO
    } else {
        number_value_of_integer(product)
    }
}

/// ECMA-262 §6.1.6.1.6 Number::remainder ( n, d ) on int32-valued
/// operands:
///
/// > 1. If n is NaN or d is NaN, return NaN.
/// > 2. If n is either +∞𝔽 or -∞𝔽, return NaN.
/// > 3. If d is either +∞𝔽 or -∞𝔽, return n.
/// > 4. If d is either +0𝔽 or -0𝔽, return NaN.
/// > 5. If n is either +0𝔽 or -0𝔽, return n.
/// > 6. Assert: n and d are finite and non-zero.
/// > 7. Let quotient be ℝ(n) / ℝ(d).
/// > 8. Let q be truncate(quotient).
/// > 9. Let r be ℝ(n) - (ℝ(d) × q).
/// > 10. If r = 0 and n < -0𝔽, return -0𝔽.
/// > 11. Return 𝔽(r).
pub fn remainder_int32(n: i32, d: i32) -> u64 {
    if d == 0 {
        return NAN; // Step 4.
    }
    if n == 0 {
        return 0; // Step 5: n is +0𝔽.
    }
    // Steps 7-8: truncate(n / d), computed as the quotient of the
    // magnitudes (each at most 2^31, so a u32) with the sign of the true
    // quotient.
    let magnitude = i64::from(n.unsigned_abs() / d.unsigned_abs());
    let q = if (n < 0) == (d < 0) {
        magnitude
    } else {
        -magnitude
    };
    let r = i64::from(n) - i64::from(d) * q; // Step 9.
    if r == 0 && n < 0 {
        return NEGATIVE_ZERO; // Step 10.
    }
    number_value_of_integer(i128::from(r)) // Step 11.
}

/// ECMA-262 §6.1.6.1.1 Number::unaryMinus ( x ) on an int32-valued `x`:
///
/// > 1. If x is NaN, return NaN.
/// > 2. Return the result of negating x; that is, compute a Number with the
/// >    same magnitude but opposite sign.
///
/// The negation of `+0𝔽` is `-0𝔽`.
pub fn unary_minus_int32(x: i32) -> u64 {
    if x == 0 {
        NEGATIVE_ZERO
    } else {
        number_value_of_integer(-i128::from(x))
    }
}

/// The int32 whose Number value is the Number with bit pattern `number`,
/// excluding `-0𝔽`: `Some(i)` iff `number` is `𝔽(i)` for an integer
/// `-2^31 ≤ i < 2^31` (`𝔽(0)` is `+0𝔽`). This is the domain of the engine's
/// `Integer` slot representation, whose contract is that `Integer(i)` and
/// `Number(𝔽(i))` are two encodings of one Number and that `-0𝔽`, which no
/// integer denotes, is always a `Number`.
pub fn exact_int32(number: u64) -> Option<i32> {
    match decompose(number) {
        Decomposed::Zero { negative: false } => Some(0),
        Decomposed::Finite {
            negative,
            significand,
            exponent,
        } => {
            let magnitude: i128 = if exponent >= 0 {
                if exponent > 31 {
                    return None;
                }
                i128::from(significand) << exponent
            } else {
                let shift = exponent.unsigned_abs();
                if shift >= 64 || significand & ((1u64 << shift) - 1) != 0 {
                    return None;
                }
                i128::from(significand >> shift)
            };
            let value = if negative { -magnitude } else { magnitude };
            i32::try_from(value).ok()
        }
        _ => None,
    }
}

/// Whether a bit pattern is a NaN (§6.1.6.1: every NaN is the value NaN).
fn is_nan(number: u64) -> bool {
    matches!(decompose(number), Decomposed::NaN)
}

/// ECMA-262 §6.1.6.1.14 Number::sameValue ( x, y ):
///
/// > 1. If x is NaN and y is NaN, return true.
/// > 2. If x is +0𝔽 and y is -0𝔽, return false.
/// > 3. If x is -0𝔽 and y is +0𝔽, return false.
/// > 4. If x is y, return true.
/// > 5. Return false.
///
/// Two non-NaN Numbers are the same value iff their bit patterns are equal
/// (binary64 encodes every non-NaN value, and each zero, exactly once).
pub fn number_same_value(x: u64, y: u64) -> bool {
    if is_nan(x) || is_nan(y) {
        return is_nan(x) && is_nan(y);
    }
    x == y
}

/// ECMA-262 §6.1.6.1.15 Number::sameValueZero ( x, y ):
///
/// > 1. If x is NaN and y is NaN, return true.
/// > 2. If x is +0𝔽 and y is -0𝔽, return true.
/// > 3. If x is -0𝔽 and y is +0𝔽, return true.
/// > 4. If x is y, return true.
/// > 5. Return false.
pub fn number_same_value_zero(x: u64, y: u64) -> bool {
    let zero = |v: u64| v << 1 == 0;
    number_same_value(x, y) || (zero(x) && zero(y))
}

/// ECMA-262 §6.1.6.1.13 Number::equal ( x, y ), used by IsStrictlyEqual
/// (§7.2.15) and IsLooselyEqual on Numbers:
///
/// > 1. If x is NaN, return false.
/// > 2. If y is NaN, return false.
/// > 3. If x is y, return true.
/// > 4. If x is +0𝔽 and y is -0𝔽, return true.
/// > 5. If x is -0𝔽 and y is +0𝔽, return true.
/// > 6. Return false.
pub fn number_equal(x: u64, y: u64) -> bool {
    !is_nan(x) && !is_nan(y) && number_same_value_zero(x, y)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b(x: f64) -> u64 {
        x.to_bits()
    }

    #[test]
    fn number_value_rounds_ties_to_even() {
        assert_eq!(number_value_of_integer(1), b(1.0));
        assert_eq!(number_value_of_integer(-3), b(-3.0));
        assert_eq!(number_value_of_integer(1 << 53), b(9007199254740992.0));
        // 2^53 + 1 is a tie between 2^53 and 2^53 + 2: even is 2^53.
        assert_eq!(number_value_of_integer((1 << 53) + 1), b(9007199254740992.0));
        // 2^53 + 3 ties between 2^53 + 2 and 2^53 + 4: even is + 4.
        assert_eq!(number_value_of_integer((1 << 53) + 3), b(9007199254740996.0));
        assert_eq!(number_value_of_integer(-(1 << 53) - 1), b(-9007199254740992.0));
        // 2^62 - 1 rounds up to 2^62 (a carry out of 53 bits).
        assert_eq!(number_value_of_integer((1 << 62) - 1), b(4611686018427387904.0));
        assert_eq!(
            number_value_of_integer(i128::from(i32::MIN) * i128::from(i32::MIN)),
            b(4611686018427387904.0)
        );
        assert_eq!(number_value_of_integer(i128::MAX), b(1.7014118346046923e38));
        for x in (-5000i64..5000).chain([i64::MAX, i64::MIN + 1, 0x7FFF_FFFF_FFFF_FC00]) {
            assert_eq!(number_value_of_integer(i128::from(x)), b(x as f64), "{x}");
        }
        let mut z = 0x0123_4567_89AB_CDEFu64;
        for _ in 0..100_000 {
            z ^= z << 13;
            z ^= z >> 7;
            z ^= z << 17;
            let x = (z as i64) >> (z % 63);
            assert_eq!(number_value_of_integer(i128::from(x)), b(x as f64), "{x}");
        }
    }

    #[test]
    fn int32_arithmetic_known_answers() {
        // test262 S11.6.1_A4_T*, S11.6.2_A4_T*, S11.5.1_A4_T*,
        // S11.5.3_A4_T*: the IEEE edge cases on integer operands.
        assert_eq!(add_int32(i32::MAX, 1), b(2147483648.0));
        assert_eq!(add_int32(i32::MIN, i32::MIN), b(-4294967296.0));
        assert_eq!(add_int32(5, -5), 0);
        assert_eq!(subtract_int32(0, 0), 0);
        assert_eq!(subtract_int32(i32::MIN, 1), b(-2147483649.0));
        assert_eq!(subtract_int32(3, 3), 0);
        assert_eq!(multiply_int32(0, -5), NEGATIVE_ZERO);
        assert_eq!(multiply_int32(-5, 0), NEGATIVE_ZERO);
        assert_eq!(multiply_int32(0, 5), 0);
        assert_eq!(multiply_int32(0, 0), 0);
        assert_eq!(multiply_int32(i32::MIN, i32::MIN), b(4611686018427387904.0));
        assert_eq!(multiply_int32(i32::MAX, i32::MAX), b(4611686014132420609.0));
        assert_eq!(multiply_int32(65536, 65536), b(4294967296.0));
        assert_eq!(remainder_int32(5, 0), NAN);
        assert_eq!(remainder_int32(0, -3), 0);
        assert_eq!(remainder_int32(-4, 2), NEGATIVE_ZERO);
        assert_eq!(remainder_int32(-5, 3), b(-2.0));
        assert_eq!(remainder_int32(5, -3), b(2.0));
        assert_eq!(remainder_int32(i32::MIN, -1), NEGATIVE_ZERO);
        assert_eq!(remainder_int32(i32::MIN, i32::MAX), b(-1.0));
        assert_eq!(unary_minus_int32(0), NEGATIVE_ZERO);
        assert_eq!(unary_minus_int32(i32::MIN), b(2147483648.0));
        assert_eq!(unary_minus_int32(7), b(-7.0));
    }

    #[test]
    fn int32_arithmetic_matches_platform_floats() {
        let values: Vec<i32> = (-60..60)
            .chain([i32::MIN, i32::MIN + 1, i32::MAX, i32::MAX - 1, 46341, -46341, 1 << 30])
            .collect();
        for &x in &values {
            for &y in &values {
                let (fx, fy) = (f64::from(x), f64::from(y));
                assert_eq!(add_int32(x, y), b(fx + fy));
                assert_eq!(subtract_int32(x, y), b(fx - fy));
                assert_eq!(multiply_int32(x, y), b(fx * fy), "{x} * {y}");
                let r = fx % fy;
                if r.is_nan() {
                    assert!(is_nan(remainder_int32(x, y)));
                } else {
                    assert_eq!(remainder_int32(x, y), b(r), "{x} % {y}");
                }
            }
            assert_eq!(unary_minus_int32(x), b(-f64::from(x)));
        }
    }

    #[test]
    fn exact_int32_classifies() {
        assert_eq!(exact_int32(0), Some(0));
        assert_eq!(exact_int32(NEGATIVE_ZERO), None);
        assert_eq!(exact_int32(b(-1.0)), Some(-1));
        assert_eq!(exact_int32(b(2147483647.0)), Some(i32::MAX));
        assert_eq!(exact_int32(b(2147483648.0)), None);
        assert_eq!(exact_int32(b(-2147483648.0)), Some(i32::MIN));
        assert_eq!(exact_int32(b(-2147483649.0)), None);
        assert_eq!(exact_int32(b(0.5)), None);
        assert_eq!(exact_int32(b(1e300)), None);
        assert_eq!(exact_int32(b(f64::NAN)), None);
        assert_eq!(exact_int32(b(f64::INFINITY)), None);
        assert_eq!(exact_int32(1), None);
    }

    #[test]
    fn comparisons_known_answers() {
        let (nan, other_nan) = (b(f64::NAN), 0xFFF0_0000_0000_0001);
        assert!(number_same_value(nan, other_nan));
        assert!(!number_same_value(0, NEGATIVE_ZERO));
        assert!(number_same_value(b(1.5), b(1.5)));
        assert!(number_same_value_zero(nan, other_nan));
        assert!(number_same_value_zero(0, NEGATIVE_ZERO));
        assert!(!number_same_value_zero(0, b(5e-324)));
        assert!(!number_equal(nan, nan));
        assert!(number_equal(NEGATIVE_ZERO, 0));
        assert!(!number_equal(b(1.0), b(-1.0)));
    }
}
