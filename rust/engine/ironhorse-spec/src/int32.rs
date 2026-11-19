//! The Number operators that work on 32-bit integers (ECMA-262
//! §6.1.6.1.9–§6.1.6.1.19) and `Math.imul` / `Math.clz32`.
//!
//! Each operator begins by converting its operands with ToInt32 or
//! ToUint32. These models take the ToInt32 results `x` and `y` (as `i32`,
//! whose range is exactly ToInt32's) and compute with mathematical integers
//! (`i64`): a shift is a multiplication or floor division by a power of two
//! and a bit is `floor(v / 2^k) modulo 2`, so the models never use a shift
//! or bitwise operator on the operands themselves. ToUint32 of a Number
//! whose ToInt32 is `x` is `x modulo 2^32` (both are `truncate(ℝ(n))
//! modulo 2^32`, read signed or unsigned; §7.1.7 note: "ToUint32(ToInt32(x))
//! is the same value as ToUint32(x)"), which [`uint32_of`] computes.

const TWO_32: i64 = 1 << 32;

/// ToUint32 of a Number whose ToInt32 is `x`: `ℝ(x) modulo 2^32` (§7.1.7
/// steps 3–5 on an integer; §5.2.5 "modulo" has the divisor's sign).
pub fn uint32_of(x: i32) -> i64 {
    i64::from(x).rem_euclid(TWO_32)
}

/// The integer a 32-bit two's complement bit string with unsigned value
/// `u` (`0 ≤ u < 2^32`) represents.
fn signed_of(u: i64) -> i64 {
    if u >= 1 << 31 {
        u - TWO_32
    } else {
        u
    }
}

/// "shiftCount be ℝ(rnum) modulo 32" with `rnum = ToUint32(y)`.
fn shift_count(y: i32) -> u32 {
    (uint32_of(y) % 32) as u32
}

/// ECMA-262 §6.1.6.1.9 Number::leftShift ( x, y ):
///
/// > 1. Let lnum be ! ToInt32(x).
/// > 2. Let rnum be ! ToUint32(y).
/// > 3. Let shiftCount be ℝ(rnum) modulo 32.
/// > 4. Return the result of left shifting lnum by shiftCount bits. The
/// >    mathematical value of the result is exactly representable as a
/// >    32-bit two's complement bit string.
///
/// Left shifting a 32-bit string by `s` bits multiplies its value by `2^s`
/// and keeps it modulo `2^32`.
pub fn left_shift(x: i32, y: i32) -> i64 {
    let product = uint32_of(x) * (1i64 << shift_count(y));
    signed_of(product.rem_euclid(TWO_32))
}

/// ECMA-262 §6.1.6.1.10 Number::signedRightShift ( x, y ):
///
/// > 1. Let lnum be ! ToInt32(x).
/// > 2. Let rnum be ! ToUint32(y).
/// > 3. Let shiftCount be ℝ(rnum) modulo 32.
/// > 4. Return the result of performing a sign-extending right shift of
/// >    lnum by shiftCount bits. The most significant bit is propagated.
///
/// A sign-extending right shift by `s` is `floor(lnum / 2^s)`.
pub fn signed_right_shift(x: i32, y: i32) -> i64 {
    i64::from(x).div_euclid(1i64 << shift_count(y))
}

/// ECMA-262 §6.1.6.1.11 Number::unsignedRightShift ( x, y ):
///
/// > 1. Let lnum be ! ToUint32(x).
/// > 2. Let rnum be ! ToUint32(y).
/// > 3. Let shiftCount be ℝ(rnum) modulo 32.
/// > 4. Return the result of performing a zero-filling right shift of lnum
/// >    by shiftCount bits. Vacated bits are filled with zero. The
/// >    mathematical value of the result is exactly representable as a
/// >    32-bit unsigned bit string.
///
/// The result is `floor(lnum / 2^s)`, in `[0, 2^32)`.
pub fn unsigned_right_shift(x: i32, y: i32) -> i64 {
    uint32_of(x) / (1i64 << shift_count(y))
}

/// The bitwise operations of ECMA-262 §6.1.6.1.16 NumberBitwiseOp.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum BitwiseOp {
    And,
    Xor,
    Or,
}

/// ECMA-262 §6.1.6.1.16 NumberBitwiseOp ( op, x, y ), used by
/// §6.1.6.1.17 Number::bitwiseAND, §6.1.6.1.18 Number::bitwiseXOR and
/// §6.1.6.1.19 Number::bitwiseOR:
///
/// > 1. Let lnum be ! ToInt32(x).
/// > 2. Let rnum be ! ToInt32(y).
/// > 3. Let lbits be the 32-bit two's complement bit string representing
/// >    ℝ(lnum).
/// > 4. Let rbits be the 32-bit two's complement bit string representing
/// >    ℝ(rnum).
/// > 5. If op is &, let result be the result of applying the bitwise AND
/// >    operation to lbits and rbits.
/// > 6. Else if op is ^, … bitwise exclusive OR (XOR) …
/// > 7. Else, op is |. Let result be … bitwise inclusive OR …
/// > 8. Return 𝔽(the integer represented by the 32-bit two's complement
/// >    bit string result).
///
/// Bit `k` of a string with unsigned value `u` is `floor(u / 2^k) modulo 2`.
pub fn bitwise(op: BitwiseOp, x: i32, y: i32) -> i64 {
    let (l, r) = (uint32_of(x), uint32_of(y));
    let mut result = 0i64;
    let mut weight = 1i64;
    for _ in 0..32 {
        let (a, b) = ((l / weight) % 2, (r / weight) % 2);
        let bit = match op {
            BitwiseOp::And => a * b,
            BitwiseOp::Xor => (a + b) % 2,
            BitwiseOp::Or => (a + b + 1) / 2,
        };
        result += bit * weight;
        weight *= 2;
    }
    signed_of(result)
}

/// ECMA-262 §6.1.6.1.2 Number::bitwiseNOT ( x ):
///
/// > 1. Let oldValue be ! ToInt32(x).
/// > 2. Return the bitwise complement of oldValue. The mathematical value
/// >    of the result is exactly representable as a 32-bit two's complement
/// >    bit string.
///
/// The complement of a 32-bit string with value `v` has value `-v - 1`.
pub fn bitwise_not(x: i32) -> i64 {
    -i64::from(x) - 1
}

/// ECMA-262 §21.3.2.19 Math.imul ( x, y ), on the ToInt32 results:
///
/// > 1. Let a be ℝ(? ToUint32(x)).
/// > 2. Let b be ℝ(? ToUint32(y)).
/// > 3. Let product be (a × b) modulo 2^32.
/// > 4. If product ≥ 2^31, return 𝔽(product - 2^32); otherwise return
/// >    𝔽(product).
pub fn imul(x: i32, y: i32) -> i64 {
    let product = (i128::from(uint32_of(x)) * i128::from(uint32_of(y))) % (1 << 32);
    signed_of(product as i64)
}

/// ECMA-262 §21.3.2.11 Math.clz32 ( x ), on ToUint32's result `n`:
///
/// > 1. Let n be ? ToUint32(x).
/// > 2. Let p be the number of leading zero bits in the unsigned 32-bit
/// >    binary representation of n.
/// > 3. Return 𝔽(p).
///
/// `p` is `32 - b` for the bit length `b`, the least `b` with `n < 2^b`.
pub fn clz32(n: u32) -> i64 {
    let n = i64::from(n);
    let mut bit_length = 0;
    while bit_length < 32 && n >= 1i64 << bit_length {
        bit_length += 1;
    }
    32 - bit_length
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shift_known_answers() {
        // The shift count is ℝ(ToUint32(y)) modulo 32: 32 shifts by 0, 33
        // by 1, -1 by 31 (test262 test/language/expressions/left-shift and
        // its signed/unsigned siblings, S11.7.*_A4_T*, check powers of two
        // and their negations at every count).
        assert_eq!(left_shift(1, 31), i64::from(i32::MIN));
        assert_eq!(left_shift(1, 32), 1);
        assert_eq!(left_shift(1, 33), 2);
        assert_eq!(left_shift(-1, 31), i64::from(i32::MIN));
        assert_eq!(left_shift(3, -1), i64::from(i32::MIN));
        assert_eq!(left_shift(0x4000_0000, 1), i64::from(i32::MIN));
        assert_eq!(signed_right_shift(-1, 31), -1);
        assert_eq!(signed_right_shift(-7, 1), -4);
        assert_eq!(signed_right_shift(i32::MIN, 31), -1);
        assert_eq!(signed_right_shift(i32::MIN, 32), i64::from(i32::MIN));
        assert_eq!(signed_right_shift(7, 1), 3);
        assert_eq!(unsigned_right_shift(-1, 0), 4294967295);
        assert_eq!(unsigned_right_shift(-1, 32), 4294967295);
        assert_eq!(unsigned_right_shift(-1, 31), 1);
        assert_eq!(unsigned_right_shift(-8, 1), 2147483644);
        assert_eq!(unsigned_right_shift(i32::MIN, 0), 2147483648);
    }

    #[test]
    fn bitwise_known_answers() {
        assert_eq!(bitwise(BitwiseOp::And, -1, 0x55), 0x55);
        assert_eq!(bitwise(BitwiseOp::And, i32::MIN, -1), i64::from(i32::MIN));
        assert_eq!(bitwise(BitwiseOp::Or, 0x0F, 0xF0), 0xFF);
        assert_eq!(bitwise(BitwiseOp::Or, i32::MIN, 1), i64::from(i32::MIN) + 1);
        assert_eq!(bitwise(BitwiseOp::Xor, -1, 0), -1);
        assert_eq!(bitwise(BitwiseOp::Xor, -1, -1), 0);
        assert_eq!(bitwise(BitwiseOp::Xor, 6, 3), 5);
        assert_eq!(bitwise_not(0), -1);
        assert_eq!(bitwise_not(i32::MIN), i64::from(i32::MAX));
        assert_eq!(bitwise_not(-1), 0);
    }

    #[test]
    fn imul_and_clz32_known_answers() {
        // test262 test/built-ins/Math/imul/results.js and
        // test/built-ins/Math/clz32/int32bit.js.
        assert_eq!(imul(2, 4), 8);
        assert_eq!(imul(-1, 8), -8);
        assert_eq!(imul(-2, -2), 4);
        assert_eq!(imul(-5, 12), -60);
        assert_eq!(imul(0xFFFF_FFFFu32 as i32, 5), -5);
        assert_eq!(imul(0xFFFF_FFFEu32 as i32, 5), -10);
        assert_eq!(imul(i32::MAX, i32::MAX), 1);
        assert_eq!(imul(i32::MIN, -1), i64::from(i32::MIN));
        assert_eq!(clz32(0), 32);
        assert_eq!(clz32(1), 31);
        assert_eq!(clz32(0x8000_0000), 0);
        assert_eq!(clz32(0xFFFF_FFFF), 0);
        assert_eq!(clz32(0x0001_0000), 15);
        assert_eq!(clz32(0x7FFF_FFFF), 1);
    }

    #[test]
    fn exhaustive_on_small_and_boundary_operands() {
        let values: Vec<i32> = (-40..40)
            .chain([i32::MIN, i32::MIN + 1, i32::MAX, i32::MAX - 1, 1 << 30, -(1 << 30)])
            .collect();
        for &x in &values {
            for &y in &values {
                let s = (y as u32 & 31) as i64;
                assert_eq!(left_shift(x, y), i64::from(x.wrapping_shl(y as u32)));
                assert_eq!(signed_right_shift(x, y), i64::from(x) >> s);
                assert_eq!(unsigned_right_shift(x, y), i64::from((x as u32) >> s));
                assert_eq!(bitwise(BitwiseOp::And, x, y), i64::from(x & y));
                assert_eq!(bitwise(BitwiseOp::Or, x, y), i64::from(x | y));
                assert_eq!(bitwise(BitwiseOp::Xor, x, y), i64::from(x ^ y));
                assert_eq!(imul(x, y), i64::from(x.wrapping_mul(y)));
            }
            assert_eq!(clz32(x as u32), i64::from((x as u32).leading_zeros()));
        }
    }
}
