//! BigInt sign/magnitude arithmetic and StringIntegerLiteral parsing.
//!
//! Magnitudes use little-endian u32 limbs, trimmed to a nonzero high limb,
//! except zero, represented by `[0]`. The limb count is the size charged by
//! the interpreter's BigInt metering; callers own admission and allocation costs.
use super::{trim_ecma_whitespace, BitOp};

/// Trim trailing (most-significant) zero limbs, leaving at least one limb.
pub(super) fn bi_trim(mut mag: Vec<u32>) -> Vec<u32> {
    while mag.len() > 1 && *mag.last().unwrap() == 0 {
        mag.pop();
    }
    if mag.is_empty() {
        mag.push(0);
    }
    mag
}

pub(super) fn bi_is_zero(mag: &[u32]) -> bool {
    mag.iter().all(|&d| d == 0)
}

/// The canonical form of a sign and limbs, as a BigInt chunk stores it:
/// trimmed (no zero high limb above the first), and zero never negative.
pub(super) fn bi_canonical(negative: bool, magnitude: Vec<u32>) -> (bool, Vec<u32>) {
    let magnitude = bi_trim(magnitude);
    let negative = if bi_is_zero(&magnitude) {
        false
    } else {
        negative
    };
    (negative, magnitude)
}

/// The low 64 bits of `(negative, magnitude)` in two's complement: the
/// value modulo 2^64, what a BigInt64/BigUint64 store keeps.
pub(super) fn bi_low_u64(negative: bool, magnitude: &[u32]) -> u64 {
    let mut u: u64 = 0;
    if let Some(&l0) = magnitude.first() {
        u |= l0 as u64;
    }
    if let Some(&l1) = magnitude.get(1) {
        u |= (l1 as u64) << 32;
    }
    if negative {
        u.wrapping_neg()
    } else {
        u
    }
}

/// Convert a trimmed BigInt to the nearest IEEE-754 binary64 value, using
/// round-to-nearest, ties-to-even. Reading only the leading 53 bits and the
/// discarded round/sticky bits avoids an intermediate `f64` accumulation
/// (and therefore avoids double rounding for wide values).
pub(super) fn bi_to_f64(negative: bool, magnitude: &[u32]) -> f64 {
    if bi_is_zero(magnitude) {
        return 0.0;
    }

    let top = *magnitude.last().expect("a BigInt has at least one limb");
    let bit_length = (magnitude.len() - 1) * 32 + (32 - top.leading_zeros() as usize);
    let mut exponent = bit_length - 1;
    let discarded = bit_length.saturating_sub(53);

    let bit = |position: usize| -> bool {
        magnitude
            .get(position / 32)
            .is_some_and(|limb| limb & (1u32 << (position % 32)) != 0)
    };
    let mut significand = 0u64;
    for position in (discarded..bit_length).rev() {
        significand = (significand << 1) | u64::from(bit(position));
    }
    if bit_length < 53 {
        significand <<= 53 - bit_length;
    }

    if discarded > 0 {
        let round = bit(discarded - 1);
        let sticky = (0..discarded - 1).any(bit);
        if round && (sticky || significand & 1 != 0) {
            significand += 1;
            if significand == 1u64 << 53 {
                significand >>= 1;
                exponent += 1;
            }
        }
    }

    if exponent > 1023 {
        return if negative {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    let sign = u64::from(negative) << 63;
    let biased = (exponent as u64 + 1023) << 52;
    let fraction = significand - (1u64 << 52);
    f64::from_bits(sign | biased | fraction)
}

/// What `BigInt.asIntN` / `BigInt.asUintN` produce for a BigInt.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum WidthResult {
    /// The argument already lies in the target range: return it as is,
    /// allocating nothing.
    Unchanged,
    /// A new BigInt with this sign and these limbs (not yet trimmed).
    Value(bool, Vec<u32>),
    /// The result would need more than [`MAX_BIGINT_WIDTH_BITS`] bits.
    TooLarge,
}

/// The widest result `BigInt.asIntN` / `BigInt.asUintN` builds.
const MAX_BIGINT_WIDTH_BITS: u64 = 64 * 1024;

/// Reduce the trimmed BigInt `(negative, magnitude)` modulo `2**bits`,
/// interpreting the retained high bit as a sign bit when `signed`
/// (`asIntN`). Widths that would require an adversarially large positive
/// result are [`WidthResult::TooLarge`]; widths wider than an
/// already-representable value return [`WidthResult::Unchanged`].
pub(super) fn bi_as_n(negative: bool, magnitude: &[u32], bits: u64, signed: bool) -> WidthResult {
    if bits == 0 || bi_is_zero(magnitude) {
        return WidthResult::Value(false, vec![0]);
    }
    let top = *magnitude
        .last()
        .expect("a non-zero BigInt has a leading limb");
    let magnitude_bits = (magnitude.len() as u64 - 1) * 32 + u64::from(32 - top.leading_zeros());

    if !negative && ((!signed && magnitude_bits <= bits) || (signed && magnitude_bits < bits)) {
        return WidthResult::Unchanged;
    }
    if negative && signed {
        let minimum_at_width = magnitude_bits == bits
            && magnitude
                .iter()
                .take(magnitude.len() - 1)
                .all(|&limb| limb == 0)
            && top.is_power_of_two();
        if magnitude_bits < bits || minimum_at_width {
            return WidthResult::Unchanged;
        }
    }
    if bits > MAX_BIGINT_WIDTH_BITS {
        return WidthResult::TooLarge;
    }

    let limb_count = bits.div_ceil(32) as usize;
    let mut unsigned = vec![0u32; limb_count];
    let copied = limb_count.min(magnitude.len());
    unsigned[..copied].copy_from_slice(&magnitude[..copied]);
    if negative {
        for limb in &mut unsigned {
            *limb = !*limb;
        }
        bi_add_one_in_place(&mut unsigned);
    }
    bi_mask_width(&mut unsigned, bits);

    if signed {
        let sign_index = (bits - 1) as usize;
        let sign_set = unsigned[sign_index / 32] & (1u32 << (sign_index % 32)) != 0;
        if sign_set {
            for limb in &mut unsigned {
                *limb = !*limb;
            }
            bi_add_one_in_place(&mut unsigned);
            bi_mask_width(&mut unsigned, bits);
            return WidthResult::Value(true, unsigned);
        }
    }
    WidthResult::Value(false, unsigned)
}

/// Add one modulo the fixed width of `limbs`.
pub(super) fn bi_add_one_in_place(limbs: &mut [u32]) {
    for limb in limbs {
        let (next, carry) = limb.overflowing_add(1);
        *limb = next;
        if !carry {
            break;
        }
    }
}

/// Clear the unused high bits in a fixed-width little-endian limb vector.
pub(super) fn bi_mask_width(limbs: &mut [u32], bits: u64) {
    let retained = bits % 32;
    if retained != 0 {
        let mask = (1u32 << retained) - 1;
        if let Some(top) = limbs.last_mut() {
            *top &= mask;
        }
    }
}

/// Compare two magnitudes (already trimmed): Ordering of `a` vs `b`.
fn bi_cmp_mag(a: &[u32], b: &[u32]) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    if a.len() != b.len() {
        return a.len().cmp(&b.len());
    }
    for i in (0..a.len()).rev() {
        if a[i] != b[i] {
            return a[i].cmp(&b[i]);
        }
    }
    Ordering::Equal
}

/// `a + b` (magnitudes), trimmed.
pub(super) fn bi_add_mag(a: &[u32], b: &[u32]) -> Vec<u32> {
    let n = a.len().max(b.len());
    let mut out = Vec::with_capacity(n + 1);
    let mut carry: u64 = 0;
    for i in 0..n {
        let x = *a.get(i).unwrap_or(&0) as u64;
        let y = *b.get(i).unwrap_or(&0) as u64;
        let s = x + y + carry;
        out.push((s & 0xFFFF_FFFF) as u32);
        carry = s >> 32;
    }
    if carry != 0 {
        out.push(carry as u32);
    }
    bi_trim(out)
}

/// `a - b` (magnitudes), requires `a >= b`, trimmed.
pub(super) fn bi_sub_mag(a: &[u32], b: &[u32]) -> Vec<u32> {
    let mut out = Vec::with_capacity(a.len());
    let mut borrow: i64 = 0;
    for (i, &x) in a.iter().enumerate() {
        let x = x as i64;
        let y = *b.get(i).unwrap_or(&0) as i64;
        let mut d = x - y - borrow;
        if d < 0 {
            d += 1 << 32;
            borrow = 1;
        } else {
            borrow = 0;
        }
        out.push(d as u32);
    }
    bi_trim(out)
}

/// `a * b` (magnitudes), trimmed (schoolbook, XS's `fxBigInt_umul`).
pub(super) fn bi_mul_mag(a: &[u32], b: &[u32]) -> Vec<u32> {
    if bi_is_zero(a) || bi_is_zero(b) {
        return vec![0];
    }
    let mut out = vec![0u32; a.len() + b.len()];
    for (i, &ai) in a.iter().enumerate() {
        let mut carry: u64 = 0;
        for (j, &bj) in b.iter().enumerate() {
            let idx = i + j;
            let cur = out[idx] as u64 + (ai as u64) * (bj as u64) + carry;
            out[idx] = (cur & 0xFFFF_FFFF) as u32;
            carry = cur >> 32;
        }
        out[i + b.len()] = (out[i + b.len()] as u64 + carry) as u32;
    }
    bi_trim(out)
}

/// Unsigned magnitude division. Returns `(quotient, remainder)`, both
/// trimmed. The one-limb path covers the common case in linear time; the
/// general path is binary long division over little-endian limbs.
pub(super) fn bi_div_rem_mag(dividend: &[u32], divisor: &[u32]) -> (Vec<u32>, Vec<u32>) {
    use std::cmp::Ordering;
    debug_assert!(!bi_is_zero(divisor));
    match bi_cmp_mag(dividend, divisor) {
        Ordering::Less => return (vec![0], dividend.to_vec()),
        Ordering::Equal => return (vec![1], vec![0]),
        Ordering::Greater => {}
    }

    if divisor.len() == 1 {
        let divisor = divisor[0] as u64;
        let mut quotient = vec![0u32; dividend.len()];
        let mut remainder = 0u64;
        for i in (0..dividend.len()).rev() {
            let wide = (remainder << 32) | dividend[i] as u64;
            quotient[i] = (wide / divisor) as u32;
            remainder = wide % divisor;
        }
        return (bi_trim(quotient), vec![remainder as u32]);
    }

    let dividend_bits = bi_bit_length(dividend);
    let divisor_bits = bi_bit_length(divisor);
    let shift = dividend_bits - divisor_bits;
    let mut shifted_divisor = bi_shl_bits(divisor, shift);
    let mut remainder = dividend.to_vec();
    let mut quotient = vec![0u32; shift / 32 + 1];
    for bit in (0..=shift).rev() {
        if bi_cmp_mag(&remainder, &shifted_divisor) != Ordering::Less {
            remainder = bi_sub_mag(&remainder, &shifted_divisor);
            quotient[bit / 32] |= 1u32 << (bit % 32);
        }
        bi_shr_one_in_place(&mut shifted_divisor);
    }
    (bi_trim(quotient), bi_trim(remainder))
}

pub(super) fn bi_bit_length(magnitude: &[u32]) -> usize {
    let top = *magnitude
        .last()
        .expect("a BigInt magnitude has at least one limb");
    (magnitude.len() - 1) * 32 + (32 - top.leading_zeros() as usize)
}

pub(super) fn bi_shl_bits(magnitude: &[u32], bits: usize) -> Vec<u32> {
    let limb_shift = bits / 32;
    let bit_shift = bits % 32;
    let mut out = vec![0u32; magnitude.len() + limb_shift + usize::from(bit_shift != 0)];
    let mut carry = 0u64;
    for (i, &limb) in magnitude.iter().enumerate() {
        let wide = ((limb as u64) << bit_shift) | carry;
        out[i + limb_shift] = wide as u32;
        carry = wide >> 32;
    }
    if carry != 0 {
        out[magnitude.len() + limb_shift] = carry as u32;
    }
    bi_trim(out)
}

fn bi_shr_one_in_place(magnitude: &mut Vec<u32>) {
    let mut carry = 0u32;
    for limb in magnitude.iter_mut().rev() {
        let next_carry = *limb & 1;
        *limb = (*limb >> 1) | (carry << 31);
        carry = next_carry;
    }
    while magnitude.len() > 1 && magnitude.last() == Some(&0) {
        magnitude.pop();
    }
}

/// Convert canonical sign+magnitude into a fixed-width two's-complement limb
/// vector. `width` includes at least one sign-extension limb.
pub(super) fn bi_to_twos_complement(negative: bool, magnitude: &[u32], width: usize) -> Vec<u32> {
    let mut limbs = vec![0u32; width];
    limbs[..magnitude.len()].copy_from_slice(magnitude);
    if negative {
        for limb in &mut limbs {
            *limb = !*limb;
        }
        bi_add_one_in_place(&mut limbs);
    }
    limbs
}

/// Convert a fixed-width two's-complement vector back to canonical
/// sign+magnitude.
pub(super) fn bi_from_twos_complement(mut limbs: Vec<u32>) -> (bool, Vec<u32>) {
    let negative = limbs.last().is_some_and(|limb| limb & 0x8000_0000 != 0);
    if negative {
        for limb in &mut limbs {
            *limb = !*limb;
        }
        bi_add_one_in_place(&mut limbs);
    }
    let magnitude = bi_trim(limbs);
    (negative && !bi_is_zero(&magnitude), magnitude)
}

/// BigInt `&`/`|`/`^` (`op` is one of [`BitOp::And`], [`BitOp::Or`],
/// [`BitOp::Xor`]) over the spec's infinite two's-complement values. One
/// extra high limb preserves sign extension while the operation runs; the
/// result is converted back to sign+magnitude form.
pub(super) fn bi_bitwise(
    op: BitOp,
    a_negative: bool,
    a_magnitude: &[u32],
    b_negative: bool,
    b_magnitude: &[u32],
) -> (bool, Vec<u32>) {
    let width = a_magnitude.len().max(b_magnitude.len()) + 1;
    let a_twos = bi_to_twos_complement(a_negative, a_magnitude, width);
    let b_twos = bi_to_twos_complement(b_negative, b_magnitude, width);
    let result = a_twos
        .into_iter()
        .zip(b_twos)
        .map(|(a_limb, b_limb)| match op {
            BitOp::And => a_limb & b_limb,
            BitOp::Or => a_limb | b_limb,
            BitOp::Xor => a_limb ^ b_limb,
            _ => unreachable!("only the three logical BigInt ops call this helper"),
        })
        .collect();
    bi_from_twos_complement(result)
}

/// Convert a nonnegative magnitude to `usize` only when it does not exceed
/// `maximum`; otherwise return `None` without narrowing or wrapping.
pub(super) fn bi_usize_up_to(magnitude: &[u32], maximum: usize) -> Option<usize> {
    if usize::BITS == 32 {
        if magnitude.len() > 1 || magnitude[0] as usize > maximum {
            return None;
        }
        return Some(magnitude[0] as usize);
    }
    let mut value = 0usize;
    for &limb in magnitude.iter().rev() {
        value = value.checked_shl(32)?.checked_add(limb as usize)?;
        if value > maximum {
            return None;
        }
    }
    Some(value)
}

/// Shift a magnitude right and report whether any discarded bit was nonzero.
/// The latter distinguishes truncation from floor for negative BigInts.
pub(super) fn bi_shr_mag(magnitude: &[u32], bits: usize) -> (Vec<u32>, bool) {
    if bits == 0 {
        return (magnitude.to_vec(), false);
    }
    let limb_shift = bits / 32;
    let bit_shift = bits % 32;
    if limb_shift >= magnitude.len() {
        return (vec![0], !bi_is_zero(magnitude));
    }

    let whole_discarded = magnitude[..limb_shift].iter().any(|&limb| limb != 0);
    let partial_discarded =
        bit_shift != 0 && magnitude[limb_shift] & ((1u32 << bit_shift) - 1) != 0;
    let mut shifted = Vec::with_capacity(magnitude.len() - limb_shift);
    for i in limb_shift..magnitude.len() {
        let low = magnitude[i] >> bit_shift;
        let high = if bit_shift != 0 {
            magnitude.get(i + 1).copied().unwrap_or(0) << (32 - bit_shift)
        } else {
            0
        };
        shifted.push(low | high);
    }
    (bi_trim(shifted), whole_discarded || partial_discarded)
}

/// Signed add of `(neg_a, a) + (neg_b, b)` → `(neg, mag)`, trimmed. A `-0`
/// result is normalized to `+0`.
pub(super) fn bi_add(neg_a: bool, a: &[u32], neg_b: bool, b: &[u32]) -> (bool, Vec<u32>) {
    use std::cmp::Ordering;
    let (neg, mag) = if neg_a == neg_b {
        (neg_a, bi_add_mag(a, b))
    } else {
        match bi_cmp_mag(a, b) {
            Ordering::Equal => (false, vec![0]),
            Ordering::Greater => (neg_a, bi_sub_mag(a, b)),
            Ordering::Less => (neg_b, bi_sub_mag(b, a)),
        }
    };
    if bi_is_zero(&mag) {
        (false, mag)
    } else {
        (neg, mag)
    }
}

/// Signed multiply.
pub(super) fn bi_mul(neg_a: bool, a: &[u32], neg_b: bool, b: &[u32]) -> (bool, Vec<u32>) {
    let mag = bi_mul_mag(a, b);
    if bi_is_zero(&mag) {
        (false, mag)
    } else {
        (neg_a != neg_b, mag)
    }
}

/// Decode the 64-bit value `u` into a BigInt `(negative, LE u32 limbs)`.
/// When `signed`, `u` is interpreted as two's-complement `i64` (a set high
/// bit is a negative magnitude); otherwise it is the unsigned magnitude.
/// This is the numeric core of `DataView.prototype.getBigInt64`/
/// `getBigUint64` and the BigInt64/BigUint64 typed-array element read.
pub(super) fn u64_to_signed_limbs(signed: bool, u: u64) -> (bool, Vec<u32>) {
    let (neg, mag) = if signed && (u as i64) < 0 {
        // Magnitude of a negative i64 without overflowing at i64::MIN.
        (true, (u as i64 as i128).unsigned_abs() as u64)
    } else {
        (false, u)
    };
    (neg, vec![(mag & 0xFFFF_FFFF) as u32, (mag >> 32) as u32])
}

/// Decompose a finite JS Number into a BigInt `(negative, little-endian
/// limbs)`, replicating XS's `fxNumberToBigInt`: truncate toward zero, size the
/// magnitude by repeated division by `2^32`, then peel the limbs
/// most-significant first through the fractional carry. The limb count is XS's
/// allocated `bigint.size` (the `fxNewChunk(size*4)` the caller meters).
pub(super) fn number_to_bigint(number: f64) -> (bool, Vec<u32>) {
    let sign = number < 0.0;
    let mut number = if sign { -number } else { number };
    let limit = 4294967296.0_f64; // 2^32
    let mut size: usize = 1;
    // XS divides `number` itself down into `[0, 2^32)` while sizing, so the
    // fill loop below peels the reduced value most-significant limb first.
    while number >= limit {
        size += 1;
        number /= limit;
    }
    let mut data = vec![0u32; size];
    let mut i = size;
    while i > 0 {
        let part = number as u32; // (txU4)number: the top limb's integer part
        number -= part as f64;
        i -= 1;
        data[i] = part;
        number *= limit;
    }
    (sign, bi_trim(data))
}

/// Signed compare `(neg_a, a)` vs `(neg_b, b)`.
pub(super) fn bi_cmp(neg_a: bool, a: &[u32], neg_b: bool, b: &[u32]) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    match (neg_a, neg_b) {
        (false, true) => Ordering::Greater,
        (true, false) => Ordering::Less,
        (false, false) => bi_cmp_mag(a, b),
        (true, true) => bi_cmp_mag(b, a),
    }
}

/// Decimal string of `(neg, mag)` (XS's `fxBigInt` decimal formatting): the
/// magnitude in base 10 with a leading `-` when negative and non-zero.
pub(super) fn bi_to_decimal(neg: bool, mag: &[u32]) -> String {
    if bi_is_zero(mag) {
        return "0".into();
    }
    // Repeated division of the magnitude by 1e9, collecting base-1e9 chunks.
    let mut limbs = mag.to_vec();
    let mut chunks: Vec<u32> = Vec::new();
    while !bi_is_zero(&limbs) {
        let mut rem: u64 = 0;
        for i in (0..limbs.len()).rev() {
            let cur = (rem << 32) | limbs[i] as u64;
            limbs[i] = (cur / 1_000_000_000) as u32;
            rem = cur % 1_000_000_000;
        }
        limbs = bi_trim(limbs);
        chunks.push(rem as u32);
    }
    let mut out = String::new();
    if neg {
        out.push('-');
    }
    // Most-significant chunk without padding, the rest zero-padded to 9.
    out.push_str(&chunks.last().unwrap().to_string());
    for c in chunks.iter().rev().skip(1) {
        out.push_str(&format!("{:09}", c));
    }
    out
}

/// Parse the String branch of `ToBigInt`, retaining only the low 64 bits a
/// BigInt64Array/BigUint64Array element store observes.
pub(super) fn parse_bigint_string_u64(source: &str) -> Option<u64> {
    let mut s = trim_ecma_whitespace(source);
    if s.is_empty() {
        return Some(0);
    }
    let mut negative = false;
    let mut explicitly_signed = false;
    if let Some(rest) = s.strip_prefix('-') {
        negative = true;
        explicitly_signed = true;
        s = rest;
    } else if let Some(rest) = s.strip_prefix('+') {
        explicitly_signed = true;
        s = rest;
    }
    let (radix, digits) = if !explicitly_signed {
        if let Some(rest) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
            (16, rest)
        } else if let Some(rest) = s.strip_prefix("0o").or_else(|| s.strip_prefix("0O")) {
            (8, rest)
        } else if let Some(rest) = s.strip_prefix("0b").or_else(|| s.strip_prefix("0B")) {
            (2, rest)
        } else {
            (10, s)
        }
    } else {
        (10, s)
    };
    if digits.is_empty() {
        return None;
    }
    let mut value = 0u64;
    for ch in digits.chars() {
        let digit = ch.to_digit(radix)? as u64;
        value = value.wrapping_mul(radix as u64).wrapping_add(digit);
    }
    Some(if negative {
        value.wrapping_neg()
    } else {
        value
    })
}

/// Parse a StringIntegerLiteral into arbitrary-precision sign/magnitude
/// limbs. The accepted syntax matches [`parse_bigint_string_u64`], but retains
/// every digit for the public `BigInt(string)` constructor.
pub(super) fn parse_bigint_string(source: &str) -> Option<(bool, Vec<u32>)> {
    let mut s = trim_ecma_whitespace(source);
    if s.is_empty() {
        return Some((false, vec![0]));
    }
    let mut negative = false;
    let mut explicitly_signed = false;
    if let Some(rest) = s.strip_prefix('-') {
        negative = true;
        explicitly_signed = true;
        s = rest;
    } else if let Some(rest) = s.strip_prefix('+') {
        explicitly_signed = true;
        s = rest;
    }
    let (radix, digits) = if !explicitly_signed {
        if let Some(rest) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
            (16, rest)
        } else if let Some(rest) = s.strip_prefix("0o").or_else(|| s.strip_prefix("0O")) {
            (8, rest)
        } else if let Some(rest) = s.strip_prefix("0b").or_else(|| s.strip_prefix("0B")) {
            (2, rest)
        } else {
            (10, s)
        }
    } else {
        (10, s)
    };
    if digits.is_empty() {
        return None;
    }
    let mut magnitude = vec![0u32];
    for ch in digits.chars() {
        let digit = ch.to_digit(radix)? as u64;
        let mut carry = digit;
        for limb in &mut magnitude {
            let value = *limb as u64 * radix as u64 + carry;
            *limb = value as u32;
            carry = value >> 32;
        }
        if carry != 0 {
            magnitude.push(carry as u32);
        }
    }
    let magnitude = bi_trim(magnitude);
    Some((negative && !bi_is_zero(&magnitude), magnitude))
}
