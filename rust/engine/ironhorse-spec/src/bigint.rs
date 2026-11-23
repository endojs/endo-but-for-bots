//! BigInt operations (ECMA-262 §6.1.6.2 The BigInt Type, §7.1.15
//! ToBigInt64, §7.1.16 ToBigUint64, §21.2.2.1 BigInt.asIntN, §21.2.2.2
//! BigInt.asUintN, and the BigInt cases of §25.1.3.15 RawBytesToNumeric)
//! on mathematical integers.
//!
//! A BigInt value is a mathematical integer (§6.1.6.2: "The BigInt type
//! represents an integer value. The value may be any size"). These models
//! take and return it as an `i128`, so they are exact for every BigInt
//! whose magnitude is below `2^127`; each function states the range it
//! needs. "x modulo y" is the spec's (§5.2.5): the result has the sign of
//! `y`, so for `y = 2^k` it lies in `0..2^k`.

/// `ℝ(x) modulo 2^bits` (§5.2.5) for `bits ≤ 126`, in `0..2^bits`.
///
/// For a power-of-two modulus the spec's modulo is the low `bits` bits of
/// the two's-complement representation: write `x = q × 2^bits + r` with
/// `0 ≤ r < 2^bits`; in two's complement the low `bits` bits of `x` are
/// exactly `r`, because `q × 2^bits` contributes only to higher bits. (The
/// known-answer tests check this against `i128::rem_euclid`.)
pub fn modulo_pow2(x: i128, bits: u32) -> i128 {
    assert!(bits <= 126, "modulo_pow2 models widths up to 126 bits");
    x & ((1i128 << bits) - 1)
}

/// §6.1.6.2.1 BigInt::unaryMinus ( x ):
///
/// > 1. If x = 0ℤ, return 0ℤ.
/// > 2. Return -x.
///
/// (There is one BigInt zero, so step 1 is `-0 = 0`.) Exact for
/// `|x| < 2^127`.
pub fn unary_minus(x: i128) -> i128 {
    if x == 0 {
        return 0;
    }
    -x
}

/// §6.1.6.2.7 BigInt::add ( x, y ): "Return x + y." Exact for
/// `|x|, |y| < 2^126`.
pub fn add(x: i128, y: i128) -> i128 {
    x + y
}

/// §6.1.6.2.8 BigInt::subtract ( x, y ): "Return x - y." Exact for
/// `|x|, |y| < 2^126`.
pub fn subtract(x: i128, y: i128) -> i128 {
    x - y
}

/// §6.1.6.2.12 BigInt::lessThan ( x, y ) "Return ℝ(x) < ℝ(y)", together
/// with §6.1.6.2.13 BigInt::equal ( x, y ) "Return ℝ(x) = ℝ(y)", as one
/// three-way comparison: `Less` iff lessThan(x, y), `Equal` iff equal(x,
/// y), `Greater` iff lessThan(y, x).
pub fn compare(x: i128, y: i128) -> core::cmp::Ordering {
    if x < y {
        core::cmp::Ordering::Less
    } else if x == y {
        core::cmp::Ordering::Equal
    } else {
        core::cmp::Ordering::Greater
    }
}

/// The three bitwise operators of §6.1.6.2.17 BigIntBitwiseOp.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum BitwiseOp {
    /// §6.1.6.2.18 BigInt::bitwiseAND.
    And,
    /// §6.1.6.2.20 BigInt::bitwiseOR.
    Or,
    /// §6.1.6.2.19 BigInt::bitwiseXOR.
    Xor,
}

/// §6.1.6.2.17 BigIntBitwiseOp ( op, x, y ), for `|x|, |y| < 2^126`:
///
/// > 1. Let result be 0.
/// > 2. Let shift be 0.
/// > 3. Repeat, until (x = 0 or x = -1) and (y = 0 or y = -1),
/// >    a. Let xDigit be x modulo 2.
/// >    b. Let yDigit be y modulo 2.
/// >    c. If op is &, set result to result + 2^shift × BinaryAnd(xDigit, yDigit).
/// >    d. Else if op is |, set result to result + 2^shift × BinaryOr(xDigit, yDigit).
/// >    e. Else, (op is ^) set result to result + 2^shift × BinaryXor(xDigit, yDigit).
/// >    f. Set shift to shift + 1.
/// >    g. Set x to (x - xDigit) / 2.
/// >    h. Set y to (y - yDigit) / 2.
/// > 4. If op is &, let tmp be BinaryAnd(x modulo 2, y modulo 2).
/// > 5. Else if op is |, let tmp be BinaryOr(x modulo 2, y modulo 2).
/// > 6. Else, (op is ^) let tmp be BinaryXor(x modulo 2, y modulo 2).
/// > 7. If tmp ≠ 0, then
/// >    a. Set result to result - 2^shift.
/// >    b. NOTE: This extends the sign.
/// > 8. Return the BigInt value for result.
///
/// The digits `xDigit` taken in step 3 are the bits of `x`'s infinite
/// two's-complement expansion, low first, and the loop stops when only
/// sign bits remain; steps 4–7 apply the operator to those sign bits and
/// sign-extend. For `|x|, |y| < 2^126` both expansions agree with their
/// 128-bit two's-complement representations in every bit (bits 126 and
/// 127 are already sign bits), and so does the result, so the operator on
/// `i128` computes exactly this.
pub fn bitwise(op: BitwiseOp, x: i128, y: i128) -> i128 {
    match op {
        BitwiseOp::And => x & y,
        BitwiseOp::Or => x | y,
        BitwiseOp::Xor => x ^ y,
    }
}

/// §21.2.2.2 BigInt.asUintN ( bits, bigint ), steps 3–4, for `bits ≤ 126`
/// (step 1's ToIndex and step 2's ToBigInt are the caller's):
///
/// > 3. Return ℤ(ℝ(bigint) modulo 2^bits).
pub fn as_uint_n(bits: u32, bigint: i128) -> i128 {
    modulo_pow2(bigint, bits)
}

/// §21.2.2.1 BigInt.asIntN ( bits, bigint ), steps 3–4, for `bits ≤ 126`:
///
/// > 3. Let mod be ℝ(bigint) modulo 2^bits.
/// > 4. If mod ≥ 2^(bits - 1), return ℤ(mod - 2^bits); otherwise, return
/// >    ℤ(mod).
///
/// For `bits = 0`, `mod` is 0 and `2^-1 = ½`, so step 4 returns 0.
pub fn as_int_n(bits: u32, bigint: i128) -> i128 {
    let modulus = modulo_pow2(bigint, bits);
    if bits > 0 && modulus >= 1i128 << (bits - 1) {
        modulus - (1i128 << bits)
    } else {
        modulus
    }
}

/// §7.1.16 ToBigUint64 ( argument ), steps 2–3, on a BigInt `n` with
/// `|n| < 2^127` (step 1, `Let n be ? ToBigInt(argument)`, is the
/// caller's):
///
/// > 2. Let int64bit be ℝ(n) modulo 2^64.
/// > 3. Return ℤ(int64bit).
pub fn to_big_uint64(n: i128) -> u64 {
    modulo_pow2(n, 64) as u64
}

/// §7.1.15 ToBigInt64 ( argument ), steps 2–4, on a BigInt `n` with
/// `|n| < 2^127`:
///
/// > 2. Let int64bit be ℝ(n) modulo 2^64.
/// > 3. If int64bit ≥ 2^63, return ℤ(int64bit - 2^64); otherwise return
/// >    ℤ(int64bit).
pub fn to_big_int64(n: i128) -> i64 {
    let int64bit = modulo_pow2(n, 64);
    let value = if int64bit >= 1i128 << 63 {
        int64bit - (1i128 << 64)
    } else {
        int64bit
    };
    value as i64
}

/// The BigInt cases of §25.1.3.15 RawBytesToNumeric ( type, rawBytes,
/// isLittleEndian ) for an 8-byte little-endian element:
///
/// > 3. If isLittleEndian is false, reverse the order of the elements of
/// >    rawBytes.
/// > …
/// > 6. If IsUnsignedElementType(type) is true, then
/// >    a. Let intValue be the byte elements of rawBytes concatenated and
/// >       interpreted as a bit string encoding of an unsigned
/// >       little-endian binary number.
/// > 7. Else,
/// >    a. Let intValue be the byte elements of rawBytes concatenated and
/// >       interpreted as a bit string encoding of a binary little-endian
/// >       two's complement number of bit length elementSize × 8.
/// > 8. If IsBigIntElementType(type) is true, return the BigInt value that
/// >    corresponds to intValue.
///
/// `signed` selects BigInt64 (step 7) over BigUint64 (step 6).
pub fn raw_bytes_to_bigint(signed: bool, raw: [u8; 8]) -> i128 {
    if signed {
        i128::from(i64::from_le_bytes(raw))
    } else {
        i128::from(u64::from_le_bytes(raw))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests_support::SplitMix64;

    /// The spec's "x modulo y" (§5.2.5) for y > 0, written with division.
    fn modulo(x: i128, y: i128) -> i128 {
        x.rem_euclid(y)
    }

    fn sample(rng: &mut SplitMix64) -> i128 {
        let wide = (i128::from(rng.next()) << 64 | i128::from(rng.next())) >> (rng.next() % 64 + 2);
        wide >> (rng.next() % 120)
    }

    #[test]
    fn modulo_pow2_is_the_spec_modulo() {
        let mut rng = SplitMix64(0x000B_161D);
        for _ in 0..100_000 {
            let x = sample(&mut rng);
            let bits = (rng.next() % 127) as u32;
            assert_eq!(
                modulo_pow2(x, bits),
                modulo(x, 1 << bits),
                "{x} mod 2^{bits}"
            );
        }
        for (x, bits, want) in [
            (-1, 0, 0),
            (-1, 1, 1),
            (-1, 64, u64::MAX as i128),
            (-5, 3, 3),
        ] {
            assert_eq!(modulo_pow2(x, bits), want);
        }
    }

    /// Values from test262 `built-ins/BigInt/asIntN/arithmetic.js` and
    /// `built-ins/BigInt/asUintN/arithmetic.js`, and the sign boundary.
    #[test]
    fn as_n_known_answers() {
        for (bits, x, signed, unsigned) in [
            (0, -2, 0, 0),
            (0, 7, 0, 0),
            (1, -2, 0, 0),
            (1, -1, -1, 1),
            (1, 1, -1, 1),
            (2, -3, 1, 1),
            (2, 3, -1, 3),
            (8, 0xFF, -1, 0xFF),
            (8, 0x80, -0x80, 0x80),
            (8, -0x81, 0x7F, 0x7F),
            (64, -1, -1, u64::MAX as i128),
            (64, 1 << 63, -(1 << 63), 1 << 63),
            (64, (1 << 64) + 5, 5, 5),
            (65, -1, -1, (1 << 65) - 1),
        ] {
            assert_eq!(as_int_n(bits, x), signed, "asIntN({bits}, {x})");
            assert_eq!(as_uint_n(bits, x), unsigned, "asUintN({bits}, {x})");
        }
    }

    #[test]
    fn as_n_matches_the_spec_steps() {
        let mut rng = SplitMix64(0x000A_51A7);
        for _ in 0..100_000 {
            let x = sample(&mut rng) >> 2;
            let bits = (rng.next() % 125) as u32 + 1;
            let m = modulo(x, 1 << bits);
            let want = if m >= 1 << (bits - 1) {
                m - (1 << bits)
            } else {
                m
            };
            assert_eq!(as_int_n(bits, x), want);
            assert_eq!(as_uint_n(bits, x), m);
        }
    }

    /// test262 `built-ins/DataView/prototype/setBigInt64` and
    /// `getBigUint64` style boundaries.
    #[test]
    fn to_big_int64_known_answers() {
        for (n, signed, unsigned) in [
            (0i128, 0i64, 0u64),
            (-1, -1, u64::MAX),
            (1 << 63, i64::MIN, 1 << 63),
            (-(1 << 63), i64::MIN, 1 << 63),
            ((1 << 63) - 1, i64::MAX, (1 << 63) - 1),
            (1 << 64, 0, 0),
            ((1 << 64) + 1, 1, 1),
            (-(1 << 64) - 1, -1, u64::MAX),
        ] {
            assert_eq!(to_big_int64(n), signed, "ToBigInt64({n})");
            assert_eq!(to_big_uint64(n), unsigned, "ToBigUint64({n})");
        }
        let mut rng = SplitMix64(0x0064_0B17);
        for _ in 0..100_000 {
            let n = sample(&mut rng);
            let m = modulo(n, 1 << 64);
            assert_eq!(i128::from(to_big_uint64(n)), m);
            let s = if m >= 1 << 63 { m - (1 << 64) } else { m };
            assert_eq!(i128::from(to_big_int64(n)), s);
        }
    }

    #[test]
    fn raw_bytes_known_answers() {
        let all = [0xFF; 8];
        assert_eq!(raw_bytes_to_bigint(true, all), -1);
        assert_eq!(raw_bytes_to_bigint(false, all), u64::MAX as i128);
        let min = (1u64 << 63).to_le_bytes();
        assert_eq!(raw_bytes_to_bigint(true, min), -(1 << 63));
        assert_eq!(raw_bytes_to_bigint(false, min), 1 << 63);
        assert_eq!(raw_bytes_to_bigint(true, 5u64.to_le_bytes()), 5);
    }

    /// The bitwise model against the digit loop of §6.1.6.2.17, run
    /// literally.
    #[test]
    fn bitwise_matches_the_digit_loop() {
        fn digit_loop(op: BitwiseOp, mut x: i128, mut y: i128) -> i128 {
            let apply = |a: i128, b: i128| match op {
                BitwiseOp::And => a & b,
                BitwiseOp::Or => a | b,
                BitwiseOp::Xor => a ^ b,
            };
            let mut result = 0i128;
            let mut shift = 0;
            while !((x == 0 || x == -1) && (y == 0 || y == -1)) {
                let xd = modulo(x, 2);
                let yd = modulo(y, 2);
                result += apply(xd, yd) << shift;
                shift += 1;
                x = (x - xd) / 2;
                y = (y - yd) / 2;
            }
            if apply(modulo(x, 2), modulo(y, 2)) != 0 {
                result -= 1 << shift;
            }
            result
        }
        let mut rng = SplitMix64(0x000B_170B);
        for _ in 0..20_000 {
            let (x, y) = (sample(&mut rng) >> 2, sample(&mut rng) >> 2);
            for op in [BitwiseOp::And, BitwiseOp::Or, BitwiseOp::Xor] {
                assert_eq!(bitwise(op, x, y), digit_loop(op, x, y), "{op:?} {x} {y}");
            }
        }
    }

    #[test]
    fn arithmetic_and_comparison() {
        assert_eq!(unary_minus(0), 0);
        assert_eq!(unary_minus(5), -5);
        assert_eq!(add(-3, 3), 0);
        assert_eq!(subtract(1 << 64, 1), u64::MAX as i128);
        assert_eq!(compare(-1, 0), core::cmp::Ordering::Less);
        assert_eq!(compare(1 << 64, 1 << 64), core::cmp::Ordering::Equal);
        assert_eq!(compare(1, -(1 << 64)), core::cmp::Ordering::Greater);
    }
}
