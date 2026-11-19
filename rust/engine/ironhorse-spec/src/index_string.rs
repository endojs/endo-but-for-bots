//! Array-index property keys: the canonical decimal strings of integers.

/// ToString(𝔽(n)) for an integer `0 ≤ n < 2^53`, written into `out`;
/// returns the length. ECMA-262 §6.1.6.1.20 Number::toString ( x, 10 ),
/// for an integer `x = n` with `k` decimal digits (`n < 10^21`):
///
/// > 5. Let n, k, and s be integers such that k ≥ 1, 10^(k-1) ≤ s < 10^k,
/// >    𝔽(s × 10^(n - k)) is x, and k is as small as possible. …
/// > 7. If x = 0, return "0" (steps 2–3 for the zeros).
/// > 8. If k ≤ n ≤ 21, then return the code units of the k digits of the
/// >    decimal representation of s, followed by n - k occurrences of 0.
///
/// For an integer that is the decimal representation of `n` itself, with
/// no leading zero: the digits are `floor(n / 10^i) modulo 10`.
pub fn integer_to_decimal(n: u64, out: &mut [u8; 16]) -> usize {
    let mut digits = 1;
    let mut power = 10u64;
    while digits < 16 && n >= power {
        digits += 1;
        power *= 10;
    }
    let mut rest = n;
    for i in (0..digits).rev() {
        out[i] = b'0' + (rest % 10) as u8;
        rest /= 10;
    }
    digits
}

/// The array index a property key denotes (ECMA-262 §6.1.7: "An array
/// index is an integer index whose numeric value i is in the range
/// +0𝔽 ≤ i < 𝔽(2^32 - 1)", and an integer index is "a property name n such
/// that CanonicalNumericIndexString(n) returns an integral Number"): the
/// key is ToString(𝔽(i)) for such an i. Every such string is at most 10
/// digits, so the model compares the key with the rendering of the value
/// its digits spell.
pub fn array_index(key: &[u8]) -> Option<u32> {
    integer_key(key, (1 << 32) - 2).map(|n| n as u32)
}

/// The integer `0 ≤ n ≤ max` (with `max < 10^16`) whose ToString(𝔽(n)) is
/// `key`, if any: an array-like index for `max = 2^53 - 1`.
pub fn integer_key(key: &[u8], max: u64) -> Option<u64> {
    if key.is_empty() || key.len() > 16 {
        return None;
    }
    let mut value = 0u64;
    for &unit in key {
        if !unit.is_ascii_digit() {
            return None;
        }
        value = value * 10 + u64::from(unit - b'0');
    }
    let mut rendered = [0u8; 16];
    let len = integer_to_decimal(value, &mut rendered);
    (value <= max && rendered[..len] == *key).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn render(n: u64) -> String {
        let mut out = [0; 16];
        let len = integer_to_decimal(n, &mut out);
        String::from_utf8(out[..len].to_vec()).unwrap()
    }

    #[test]
    fn renders_like_the_platform() {
        for n in (0..2000).chain([4294967294, 4294967295, 9007199254740991, 999_999_999_999_999]) {
            assert_eq!(render(n), n.to_string());
        }
    }

    #[test]
    fn array_index_known_answers() {
        // test262 test/built-ins/Array/length and the §6.1.7 boundary:
        // "4294967294" is the last index, "4294967295" is not one.
        assert_eq!(array_index(b"0"), Some(0));
        assert_eq!(array_index(b"10"), Some(10));
        assert_eq!(array_index(b"4294967294"), Some(4294967294));
        assert_eq!(array_index(b"4294967295"), None);
        assert_eq!(array_index(b"4294967296"), None);
        assert_eq!(array_index(b"01"), None);
        assert_eq!(array_index(b"00"), None);
        assert_eq!(array_index(b"-1"), None);
        assert_eq!(array_index(b"1.5"), None);
        assert_eq!(array_index(b"1e3"), None);
        assert_eq!(array_index(b""), None);
        assert_eq!(array_index(b" 1"), None);
        assert_eq!(array_index(b"+1"), None);
        assert_eq!(integer_key(b"9007199254740991", (1 << 53) - 1), Some((1 << 53) - 1));
        assert_eq!(integer_key(b"9007199254740992", (1 << 53) - 1), None);
    }
}
