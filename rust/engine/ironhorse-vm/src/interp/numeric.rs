//! Numeric parsing, primitive arithmetic, and canonical property indices.

use crate::value::{number_to_ecma_string, Kind, Payload, Slot};

#[derive(Copy, Clone, Eq, PartialEq)]
pub(super) enum ArithOp {
    Add,
    Sub,
    Mul,
    Div,
    Mod,
}

/// The byte length of the WhiteSpace or LineTerminator code point that
/// starts `bytes` (CESU-8), or 0: StrWhiteSpaceChar (ES2024 7.1.4.1.1), which
/// XS's `fxSkipSpaces` also recognizes. Every such code point is in the BMP,
/// so it is one, two or three bytes; U+180E is not one of them.
fn leading_ws_len(bytes: &[u8]) -> usize {
    let (code_point, len) = match *bytes {
        [b, ..] if b < 0x80 => (u32::from(b), 1),
        [b0 @ 0xC0..=0xDF, b1, ..] => ((u32::from(b0 & 0x1F) << 6) | u32::from(b1 & 0x3F), 2),
        [b0 @ 0xE0..=0xEF, b1, b2, ..] => (
            (u32::from(b0 & 0x0F) << 12) | (u32::from(b1 & 0x3F) << 6) | u32::from(b2 & 0x3F),
            3,
        ),
        _ => return 0,
    };
    if super::text::is_ecma_whitespace(code_point) {
        len
    } else {
        0
    }
}

/// The byte length of the WhiteSpace or LineTerminator code point that ends
/// `bytes`, or 0 (see [`leading_ws_len`]).
fn trailing_ws_len(bytes: &[u8]) -> usize {
    (1..=3.min(bytes.len()))
        .find(|&len| {
            let start = bytes.len() - len;
            // A code point starts at a byte that is not a continuation.
            bytes[start] & 0xC0 != 0x80 && leading_ws_len(&bytes[start..]) == len
        })
        .unwrap_or(0)
}

/// The offset of the first byte past the leading whitespace of `bytes`.
fn skip_leading_ws(bytes: &[u8]) -> usize {
    let mut i = 0;
    loop {
        match leading_ws_len(&bytes[i..]) {
            0 => return i,
            len => i += len,
        }
    }
}

/// `fx_parseInt` (`xsNumber.c`): the integer prefix parse over the CESU-8
/// bytes — skip leading whitespace, an optional sign, an optional `0x`/`0X`
/// (radix 16) prefix, then digits valid in `radix` (default 10). Returns an
/// INTEGER-kind slot when the result fits `i32`, else a NUMBER-kind slot; an
/// empty digit run is `NaN`. No `mxMeterSome`, no chunk.
pub(super) fn parse_int(bytes: &[u8], mut radix: i32) -> Slot {
    let n = bytes.len();
    let mut i = skip_leading_ws(bytes);
    let mut sign = 1.0f64;
    match bytes.get(i) {
        Some(b'+') => i += 1,
        Some(b'-') => {
            i += 1;
            sign = -1.0;
        }
        _ => {}
    }
    if bytes.get(i) == Some(&b'0')
        && matches!(bytes.get(i + 1), Some(b'x') | Some(b'X'))
        && (radix == 0 || radix == 16)
    {
        radix = 16;
        i += 2;
    }
    if radix == 0 {
        radix = 10;
    }
    let start = i;
    let mut result = 0.0f64;
    while i < n {
        let c = bytes[i];
        let digit = if c.is_ascii_digit() {
            (c - b'0') as i32
        } else if c.is_ascii_lowercase() {
            10 + (c - b'a') as i32
        } else if c.is_ascii_uppercase() {
            10 + (c - b'A') as i32
        } else {
            break;
        };
        if digit >= radix {
            break;
        }
        result = result * radix as f64 + digit as f64;
        i += 1;
    }
    if i == start {
        return Slot::number(f64::NAN);
    }
    result *= sign;
    let ir = result as i32;
    if ir as f64 == result {
        Slot::integer(ir)
    } else {
        Slot::number(result)
    }
}

/// The non-decimal arm of `Number.prototype.toString(radix)`. ECMAScript
/// leaves the digits of a radix other than 10 implementation-defined, so this
/// is XS's algorithm (`fx_Number_prototype_toString`, after V8's): the
/// fraction emits digits until they distinguish the value from its neighbors
/// (at most 2047), rounding the last one half to even, and an integer part
/// past `2**53 * radix` is divided down, its low digits written as zeros.
pub(super) fn number_to_radix_string(number: f64, radix: u32) -> Vec<u8> {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    const FRACTION_PART_LENGTH: usize = 2048;
    if number.is_nan() {
        return b"NaN".to_vec();
    }
    if number.is_infinite() {
        return if number < 0.0 {
            b"-Infinity".to_vec()
        } else {
            b"Infinity".to_vec()
        };
    }
    if number == 0.0 {
        return b"0".to_vec();
    }
    let radix_f = f64::from(radix);
    let value = number.abs();
    let mut integer = value.floor();
    let mut fraction = value - integer;
    // Half the gap to the next Number up, and never below the least
    // subnormal.
    let next = f64::from_bits(value.to_bits() + 1);
    let mut delta = (0.5 * (next - value)).max(f64::from_bits(1));
    let mut fraction_digits = Vec::new();
    if fraction >= delta {
        loop {
            fraction *= radix_f;
            delta *= radix_f;
            let digit = fraction as usize;
            fraction_digits.push(DIGITS[digit]);
            fraction -= digit as f64;
            if (fraction > 0.5 || (fraction == 0.5 && digit & 1 == 1)) && fraction + delta > 1.0 {
                // Round up, carrying into the integer part when every
                // fraction digit was the radix's last.
                loop {
                    let Some(last) = fraction_digits.pop() else {
                        integer += 1.0;
                        break;
                    };
                    let last = DIGITS.iter().position(|&d| d == last).unwrap_or(0);
                    if last + 1 < radix as usize {
                        fraction_digits.push(DIGITS[last + 1]);
                        break;
                    }
                }
                break;
            }
            if fraction < delta || fraction_digits.len() + 1 >= FRACTION_PART_LENGTH {
                break;
            }
        }
    }
    let mut reversed = Vec::new();
    let exact_limit = 9_007_199_254_740_991.0 * radix_f;
    while integer > exact_limit {
        reversed.push(b'0');
        integer /= radix_f;
    }
    loop {
        let modulo = integer % radix_f;
        reversed.push(DIGITS[modulo as usize]);
        integer = (integer - modulo) / radix_f;
        if integer < 1.0 {
            break;
        }
    }
    if number < 0.0 {
        reversed.push(b'-');
    }
    reversed.reverse();
    if !fraction_digits.is_empty() {
        reversed.push(b'.');
        reversed.extend_from_slice(&fraction_digits);
    }
    reversed
}

/// `fxStringToNumber` (`xsdtoa.c`): coerce a CESU-8 string to a number.
/// `whole` = the `Number(...)`/`fxToNumber`/`isNaN`/`isFinite` mode (leading
/// AND trailing whitespace allowed, empty ⇒ `0`, `0b`/`0o`/`0x` integer
/// prefixes, trailing garbage ⇒ `NaN`); `!whole` = the `parseFloat` prefix
/// mode (leading whitespace, then the longest valid float prefix, empty ⇒
/// `NaN`). Uses Rust's IEEE-correct `f64` parse for the decimal body (the
/// `strtod2` equivalent).
pub(super) fn string_to_number(bytes: &[u8], whole: bool) -> f64 {
    let n = bytes.len();
    let i = skip_leading_ws(bytes);
    if whole {
        // Trim trailing whitespace; the body must consume the rest exactly.
        let mut end = n;
        loop {
            match trailing_ws_len(&bytes[i..end]) {
                0 => break,
                len => end -= len,
            }
        }
        let body = &bytes[i..end];
        if body.is_empty() {
            return 0.0;
        }
        // 0b / 0o / 0x integer literals (no sign).
        if body.len() >= 2 && body[0] == b'0' {
            let (r, digits): (u32, &[u8]) = match body[1] {
                b'b' | b'B' => (2, &body[2..]),
                b'o' | b'O' => (8, &body[2..]),
                b'x' | b'X' => (16, &body[2..]),
                _ => (0, body),
            };
            if r != 0 {
                if digits.is_empty() {
                    return f64::NAN;
                }
                let mut acc = 0.0f64;
                for &c in digits {
                    let d = match (c as char).to_digit(r) {
                        Some(d) => d as f64,
                        None => return f64::NAN,
                    };
                    acc = acc * r as f64 + d;
                }
                return acc;
            }
        }
        parse_decimal_body(body)
    } else {
        // parseFloat: the longest valid float prefix from `i`.
        let body = &bytes[i..];
        let len = float_prefix_len(body);
        if len == 0 {
            return f64::NAN;
        }
        parse_decimal_body(&body[..len])
    }
}

/// Parse a fully-delimited ECMAScript `StrDecimalLiteral` body (already
/// whitespace-trimmed) to `f64`, returning `NaN` on any invalid character —
/// notably rejecting the `inf`/`nan` spellings Rust's parser would otherwise
/// accept (only the exact `Infinity` word, handled here, is valid).
fn parse_decimal_body(body: &[u8]) -> f64 {
    // `Infinity` with an optional sign.
    let (sign, rest): (f64, &[u8]) = match body.first() {
        Some(b'+') => (1.0, &body[1..]),
        Some(b'-') => (-1.0, &body[1..]),
        _ => (1.0, body),
    };
    if rest == b"Infinity" {
        return sign * f64::INFINITY;
    }
    // Reject any character outside the decimal grammar (so `inf`/`nan`/hex
    // letters do not sneak through Rust's permissive parser).
    if body.is_empty()
        || body
            .iter()
            .any(|&c| !matches!(c, b'0'..=b'9' | b'.' | b'e' | b'E' | b'+' | b'-'))
    {
        return f64::NAN;
    }
    match std::str::from_utf8(body)
        .ok()
        .and_then(|s| s.parse::<f64>().ok())
    {
        Some(v) => v,
        None => f64::NAN,
    }
}

/// The byte length of the longest `parseFloat` float prefix of `body`
/// (optional sign, then `Infinity` or a decimal with optional fraction and
/// exponent); `0` when no valid prefix begins here.
fn float_prefix_len(body: &[u8]) -> usize {
    let n = body.len();
    let mut i = 0;
    if matches!(body.first(), Some(b'+') | Some(b'-')) {
        i += 1;
    }
    if body[i.min(n)..].starts_with(b"Infinity") {
        return i + b"Infinity".len();
    }
    let mut digits = 0;
    while i < n && body[i].is_ascii_digit() {
        i += 1;
        digits += 1;
    }
    if i < n && body[i] == b'.' {
        i += 1;
        while i < n && body[i].is_ascii_digit() {
            i += 1;
            digits += 1;
        }
    }
    if digits == 0 {
        return 0;
    }
    // Optional exponent — only if followed by (sign?) at least one digit.
    if i < n && (body[i] == b'e' || body[i] == b'E') {
        let mut j = i + 1;
        if j < n && matches!(body[j], b'+' | b'-') {
            j += 1;
        }
        if j < n && body[j].is_ascii_digit() {
            while j < n && body[j].is_ascii_digit() {
                j += 1;
            }
            i = j;
        }
    }
    i
}

/// `fx_Math_toInteger` (`xsMath.c`): fold a number result to an INTEGER-kind
/// slot when it is an exact `txInteger` (32-bit) value and not negative zero,
/// exactly as `round`/`sign`/`trunc` do before returning. Otherwise the
/// NUMBER-kind slot is preserved. Both kinds stringify identically, so this
/// affects only the value representation, matching the pin.
pub(super) fn math_to_integer(number: f64) -> Slot {
    let integer = number as i32;
    let check = integer as f64;
    if number == check && (number != 0.0 || !number.is_sign_negative()) {
        Slot::integer(integer)
    } else {
        Slot::number(number)
    }
}

pub(super) fn to_number(s: &Slot) -> f64 {
    match s.value {
        Payload::None => match s.kind {
            Kind::Null => 0.0,
            _ => f64::NAN, // undefined
        },
        Payload::Boolean(b) => {
            if b {
                1.0
            } else {
                0.0
            }
        }
        Payload::Integer(i) => i as f64,
        Payload::Number(n) => n,
        _ => f64::NAN,
    }
}

/// Number::divide (ECMA-262 §6.1.6.1.5): IEEE 754 division. The integer
/// fast path and the Number path both call it, so they agree by
/// construction.
#[inline]
fn number_divide(x: f64, y: f64) -> f64 {
    x / y
}

// XS_CODE_ADD/SUBTRACT/MULTIPLY/DIVIDE/MODULO integer fast paths.
//
// An overflowing int32 sum, difference or product is computed exactly in
// i64 and converted once: `(x as i64 + y as i64) as f64` is the
// round-to-nearest-even Number value of the exact result, which is what IEEE
// `x as f64 + y as f64` computes from the exact operands (a sum or
// difference of two int32s is below 2^33 and exact either way; a product
// below 2^62 is rounded once either way). The Kani proofs check the integer
// forms against the ECMA-262 models and the float forms against the integer
// path (NUM-3, VERIFICATION.md).
pub(super) fn apply_arith(op: ArithOp, a: &Slot, b: &Slot) -> Slot {
    if let (Payload::Integer(x), Payload::Integer(y)) = (a.value, b.value) {
        match op {
            ArithOp::Add => match x.checked_add(y) {
                Some(v) => return Slot::integer(v),
                None => return Slot::number((i64::from(x) + i64::from(y)) as f64),
            },
            ArithOp::Sub => match x.checked_sub(y) {
                Some(v) => return Slot::integer(v),
                None => return Slot::number((i64::from(x) - i64::from(y)) as f64),
            },
            ArithOp::Mul => {
                // XS mxMinusZero: 0 * negative and negative * 0 -> -0.
                if x == 0 {
                    if y < 0 {
                        return Slot::number(-0.0);
                    }
                    return Slot::integer(0);
                }
                if y == 0 {
                    if x < 0 {
                        return Slot::number(-0.0);
                    }
                    return Slot::integer(0);
                }
                match x.checked_mul(y) {
                    Some(v) => return Slot::integer(v),
                    None => return Slot::number((i64::from(x) * i64::from(y)) as f64),
                }
            }
            ArithOp::Div => {
                // JS `/` is always floating; XS produces a number.
                return Slot::number(number_divide(x as f64, y as f64));
            }
            ArithOp::Mod => {
                if y == 0 {
                    return Slot::number(f64::NAN);
                }
                if x < 0 {
                    let r = x.wrapping_rem(y);
                    if r == 0 {
                        return Slot::number(-0.0);
                    }
                    return Slot::integer(r);
                }
                return Slot::integer(x.wrapping_rem(y));
            }
        }
    }
    // At least one operand is a number: XS does f64 arithmetic.
    let x = to_number(a);
    let y = to_number(b);
    let r = match op {
        ArithOp::Add => x + y,
        ArithOp::Sub => x - y,
        ArithOp::Mul => x * y,
        ArithOp::Div => number_divide(x, y),
        ArithOp::Mod => x % y, // Rust f64 % is C fmod semantics
    };
    Slot::number(r)
}

/// The Int32 operators on their operands' ToInt32 results `a` and `b`
/// (ECMA-262 §6.1.6.1.9–§6.1.6.1.11 and §6.1.6.1.16–§6.1.6.1.19): `& | ^`
/// on the two's complement bits, and the shifts by `ToUint32(b) mod 32`,
/// which is `b & 0x1f`. Every result is an int32, so an `Integer`, except an
/// unsigned shift above `i32::MAX`, which stays a `Number` (XS keeps it a
/// number when the high bit is set).
pub(super) fn int32_bitop(op: super::BitOp, a: i32, b: i32) -> Slot {
    use super::BitOp;
    let r = match op {
        BitOp::And => a & b,
        BitOp::Or => a | b,
        BitOp::Xor => a ^ b,
        BitOp::Shl => ((a as u32) << (b & 0x1f)) as i32,
        BitOp::Sar => a >> (b & 0x1f),
        BitOp::Shr => ((a as u32) >> (b & 0x1f)) as i32,
    };
    if let BitOp::Shr = op {
        let u = (a as u32) >> (b & 0x1f);
        if u > i32::MAX as u32 {
            return Slot::number(u as f64);
        }
    }
    Slot::integer(r)
}

/// `Math.imul` on its operands' ToInt32 results (ECMA-262 §21.3.2.19): the
/// product modulo 2^32, read as an int32.
#[inline]
pub(super) fn math_imul(a: i32, b: i32) -> i32 {
    a.wrapping_mul(b)
}

/// `Math.clz32` on its operand's ToUint32 result (ECMA-262 §21.3.2.11): the
/// number of leading zero bits, 32 for 0.
#[inline]
pub(super) fn math_clz32(n: u32) -> i32 {
    n.leading_zeros() as i32
}

// XS_CODE_MINUS: negate, with -0 and INT_MIN promotion to number.
pub(super) fn unary_minus(a: &Slot) -> Slot {
    match a.value {
        Payload::Integer(i) => {
            // XS: `if (integer & 0x7FFFFFFF)` negate as integer, else
            // promote (covers 0 -> -0.0 and INT_MIN).
            if (i & 0x7FFF_FFFFu32 as i32) != 0 {
                Slot::integer(i.wrapping_neg())
            } else {
                Slot::number(-(i as f64))
            }
        }
        Payload::Number(n) => Slot::number(-n),
        _ => Slot::number(-to_number(a)),
    }
}

// Strict equality for immediate values and reference identity.
// Arena-backed strings and BigInts are compared by Interp::strict_equal.
pub(super) fn strict_equals(a: &Slot, b: &Slot) -> bool {
    match (a.value, b.value) {
        (Payload::None, Payload::None) => a.kind == b.kind, // undefined===undefined, null===null
        (Payload::Boolean(x), Payload::Boolean(y)) => x == y,
        (Payload::Integer(x), Payload::Integer(y)) => x == y,
        (Payload::Number(x), Payload::Number(y)) => x == y, // NaN handled by IEEE
        (Payload::Integer(x), Payload::Number(y)) => (x as f64) == y,
        (Payload::Number(x), Payload::Integer(y)) => x == (y as f64),
        // Reference identity: two references are `===` iff they name the
        // same arena instance (XS compares `value.reference` pointers).
        (Payload::Reference(x), Payload::Reference(y)) => x == y,
        _ => false,
    }
}

/// Whether comparing `a` and `b` needs arena contents: two strings or two
/// BigInts, which `Interp::strict_equal` compares by content. Every other
/// pair is decided by its immediate payloads.
#[inline]
pub(super) fn needs_arena_equality(a: &Slot, b: &Slot) -> bool {
    matches!(
        (a.value, b.value),
        (Payload::String(_), Payload::String(_)) | (Payload::BigInt(_), Payload::BigInt(_))
    )
}

/// SameValue (ECMA-262 §7.2.10) on a pair that does not
/// [`needs_arena_equality`]: Number::sameValue on two numerics, so NaN is
/// the same value as NaN and `+0` is not `-0`, else [`strict_equals`].
pub(super) fn same_value_immediate(a: &Slot, b: &Slot) -> bool {
    match (numeric_of(a), numeric_of(b)) {
        (Some(x), Some(y)) => (x.is_nan() && y.is_nan()) || x.to_bits() == y.to_bits(),
        _ => strict_equals(a, b),
    }
}

/// SameValueZero (ECMA-262 §7.2.11) on a pair that does not
/// [`needs_arena_equality`]: strict equality except that NaN equals NaN
/// (`+0` and `-0` are equal, which strict equality already gives).
pub(super) fn same_value_zero_immediate(a: &Slot, b: &Slot) -> bool {
    if let (Some(x), Some(y)) = (numeric_of(a), numeric_of(b)) {
        if x.is_nan() && y.is_nan() {
            return true;
        }
    }
    strict_equals(a, b)
}

/// `fx_pow` (xsMath.c:552): the `**` / `Math.pow` core. ECMAScript's
/// exponentiation returns NaN when the base's magnitude is 1 and the
/// exponent is non-finite; otherwise it is C `pow`, which Rust's
/// `f64::powf` lowers to the same libm call, so the result is bit-exact
/// with the oracle.
pub(super) fn fx_pow(x: f64, y: f64) -> f64 {
    if !y.is_finite() && x.abs() == 1.0 {
        return f64::NAN;
    }
    crate::math::pow(x, y)
}

/// The `f64` value of a primitive numeric slot (integer or number), or
/// `None` for any other kind — the fast-path guard the numeric opcodes
/// share, mirroring XS's `XS_INTEGER_KIND`/`XS_NUMBER_KIND` discrimination
/// before its general (ToNumeric/BigInt) fallback.
#[inline]
pub(super) fn numeric_of(s: &Slot) -> Option<f64> {
    match (s.kind, s.value) {
        (Kind::Integer, Payload::Integer(i)) => Some(i as f64),
        (Kind::Number, Payload::Number(n)) => Some(n),
        _ => None,
    }
}

// Loose equality for numeric/boolean/null/undefined operands, falling back
// to immediate strict equality. The interpreter handles string, BigInt, and
// object coercion before delegating here.
pub(super) fn loose_equals(a: &Slot, b: &Slot) -> bool {
    match (a.kind, b.kind) {
        (Kind::Undefined | Kind::Null, Kind::Undefined | Kind::Null) => true,
        _ => {
            // Numeric coercion for number/int/boolean.
            let numeric = |s: &Slot| matches!(s.kind, Kind::Integer | Kind::Number | Kind::Boolean);
            if numeric(a) && numeric(b) {
                let x = to_number(a);
                let y = to_number(b);
                !x.is_nan() && !y.is_nan() && x == y
            } else {
                strict_equals(a, b)
            }
        }
    }
}

/// A Number's integer part modulo 2^64 (NaN and the infinities are 0): the
/// bits every integer element conversion (`ToInt8` ... `ToUint32`) keeps the
/// low bytes of, since each element width divides 64. A Rust `f64 as u64`
/// cast saturates instead. See [`crate::numeric_kernel::number_to_u64_wrapping`].
#[inline]
pub(super) fn number_to_u64_wrapping(n: f64) -> u64 {
    crate::numeric_kernel::number_to_u64_wrapping(n.to_bits())
}

/// Render a value without access to its arenas.
/// Strings, BigInts, and transient keys produce an empty fallback; use
/// `Interp::render` when arena-backed content is available.
pub fn slot_to_ecma_string(s: &Slot) -> String {
    match s.value {
        Payload::None => match s.kind {
            Kind::Null => "null".into(),
            _ => "undefined".into(),
        },
        Payload::Boolean(b) => if b { "true" } else { "false" }.to_string(),
        Payload::Integer(i) => i.to_string(),
        Payload::Number(n) => number_to_ecma_string(n),
        Payload::String(_) => String::new(), // content requires the chunk arena
        Payload::Reference(_) => "[object Object]".into(),
        Payload::At(..) => String::new(), // a transient computed key, never rendered
        // A BigInt's decimal needs the digit chunk (arena-bound); the
        // arena-aware `Interp::render` handles it before falling here.
        Payload::BigInt(_) => String::new(),
    }
}

/// The value of a string of at most 16 ASCII decimal digits, or `None` if
/// any byte is not a digit. (At most 16 digits, so below 10^16 < 2^64; this
/// is what `str::parse::<u64>` returns on such a string, without its sign
/// and overflow handling.)
fn ascii_digits_value(bytes: &[u8]) -> Option<u64> {
    debug_assert!(bytes.len() <= 16);
    let mut n = 0u64;
    for &b in bytes {
        if !b.is_ascii_digit() {
            return None;
        }
        n = n * 10 + u64::from(b - b'0');
    }
    Some(n)
}

/// Parse a string that is a canonical array-index (a "CanonicalNumericIndex"
/// in `[0, 2^32-1)` with no leading zeros or sign), returning the index.
/// `"0"`, `"1"`, `"10"` are indices; `"01"`, `"-1"`, `"1.5"`, `"4294967295"`
/// (the max length, not an index), and `""` are not.
pub(super) fn string_to_index(s: &str) -> Option<u32> {
    if s.is_empty() || s.len() > 10 {
        return None;
    }
    let bytes = s.as_bytes();
    if bytes[0] == b'0' && s.len() > 1 {
        return None; // no leading zeros
    }
    let n = ascii_digits_value(bytes)?;
    if n < 4294967295 {
        Some(n as u32)
    } else {
        None
    }
}

/// Parse a canonical non-negative integer property name in the `ToLength`
/// domain.  Unlike an Array index, an ordinary array-like object can have an
/// indexed property at or above `2^32 - 1`; generic Array methods must still
/// discover those properties while jumping over sparse holes.
pub(super) fn string_to_array_like_index(s: &str) -> Option<u64> {
    if s.is_empty() || s.len() > 16 {
        return None;
    }
    let bytes = s.as_bytes();
    if bytes[0] == b'0' && s.len() > 1 {
        return None;
    }
    let n = ascii_digits_value(bytes)?;
    (n <= 9_007_199_254_740_991).then_some(n)
}

pub(super) fn canonical_numeric_index_string(s: &str) -> Option<f64> {
    if s == "-0" {
        return Some(-0.0);
    }
    let number = string_to_number(s.as_bytes(), true);
    if number_to_ecma_string(number) == s {
        Some(number)
    } else {
        None
    }
}

/// The exact decimal expansion of a finite, positive `x`: its significant
/// digits, without leading or trailing zeros, and `point`, with
/// `x = 0.d₁d₂… × 10^point`. The `Number.prototype.toFixed` family rounds on
/// the exact value of `x`, not on a shortest spelling.
fn exact_decimal(x: f64) -> (Vec<u8>, i32) {
    // 1100 places hold every finite double exactly (2⁻¹⁰⁷⁴ needs 1074), and
    // Rust renders a fixed precision exactly.
    let text = format!("{x:.1100}");
    let (whole, fraction) = text.split_once('.').expect("a fixed-point rendering");
    let mut digits: Vec<u8> = whole
        .bytes()
        .chain(fraction.bytes())
        .map(|b| b - b'0')
        .collect();
    let leading = digits.iter().take_while(|&&d| d == 0).count();
    digits.drain(..leading);
    while digits.last() == Some(&0) {
        digits.pop();
    }
    (digits, whole.len() as i32 - leading as i32)
}

/// The decimal digits of the integer `n` closest to `x × 10^shift`, the
/// larger on a tie (the specification's rule), for
/// `x = 0.digits × 10^point`.
fn scaled_round(digits: &[u8], point: i32, shift: i32) -> Vec<u8> {
    let whole = point + shift;
    if whole < 0 {
        return vec![0];
    }
    let whole = whole as usize;
    let mut n: Vec<u8> = (0..whole)
        .map(|i| digits.get(i).copied().unwrap_or(0))
        .collect();
    if digits.get(whole).is_some_and(|&next| next >= 5) {
        let mut i = n.len();
        loop {
            if i == 0 {
                n.insert(0, 1);
                break;
            }
            i -= 1;
            if n[i] == 9 {
                n[i] = 0;
            } else {
                n[i] += 1;
                break;
            }
        }
    }
    let leading = n
        .iter()
        .take_while(|&&d| d == 0)
        .count()
        .min(n.len().saturating_sub(1));
    n.drain(..leading);
    if n.is_empty() {
        n.push(0);
    }
    n
}

/// The `precision` digits of `n` and the exponent `e` for which
/// `n × 10^(e − precision + 1)` is closest to `x`, the larger `n` on a tie.
fn significant_digits(x: f64, precision: usize) -> (Vec<u8>, i32) {
    let (digits, point) = exact_decimal(x);
    let precision = precision as i32;
    let mut n = scaled_round(&digits, point, precision - point);
    let mut e = point - 1;
    // A carry out of the top digit (`9.99` to three digits): `n` gained a
    // trailing zero and `e` a decade.
    if n.len() > precision as usize {
        n.pop();
        e += 1;
    }
    (n, e)
}

fn digit_text(digits: &[u8]) -> String {
    digits.iter().map(|&d| char::from(b'0' + d)).collect()
}

fn exponent_text(e: i32) -> String {
    if e < 0 {
        format!("e-{}", -e)
    } else {
        format!("e+{e}")
    }
}

/// `Number.prototype.toFixed` steps 7-11 (ES2024 21.1.3.3) for a finite `x`
/// below `10^21` in magnitude and `fraction_digits` in `0..=100`.
pub(super) fn number_to_fixed(x: f64, fraction_digits: usize) -> String {
    let (sign, x) = if x < 0.0 { ("-", -x) } else { ("", x) };
    let n = if x == 0.0 {
        vec![0]
    } else {
        let (digits, point) = exact_decimal(x);
        scaled_round(&digits, point, fraction_digits as i32)
    };
    let mut m = digit_text(&n);
    if fraction_digits != 0 {
        if m.len() <= fraction_digits {
            m = "0".repeat(fraction_digits + 1 - m.len()) + &m;
        }
        m.insert(m.len() - fraction_digits, '.');
    }
    format!("{sign}{m}")
}

/// `Number.prototype.toExponential` steps 5-12 (ES2024 21.1.3.2) for a finite
/// `x`: `fraction_digits` in `0..=100`, or `None` for as many digits as
/// uniquely identify `x`.
pub(super) fn number_to_exponential(x: f64, fraction_digits: Option<usize>) -> String {
    let (sign, x) = if x < 0.0 { ("-", -x) } else { ("", x) };
    let (n, e) = if x == 0.0 {
        (vec![0; fraction_digits.unwrap_or(0) + 1], 0)
    } else if let Some(fraction_digits) = fraction_digits {
        significant_digits(x, fraction_digits + 1)
    } else {
        // Rust's `{:e}` spells the shortest round-tripping digits.
        let text = format!("{x:e}");
        let (mantissa, exponent) = text.split_once('e').expect("an exponential rendering");
        (
            mantissa
                .bytes()
                .filter(u8::is_ascii_digit)
                .map(|b| b - b'0')
                .collect(),
            exponent.parse().expect("a decimal exponent"),
        )
    };
    let mut m = digit_text(&n);
    if m.len() > 1 {
        m.insert(1, '.');
    }
    format!("{sign}{m}{}", exponent_text(e))
}

/// `Number.prototype.toPrecision` steps 6-13 (ES2024 21.1.3.5) for a finite
/// `x` and `precision` in `1..=100`.
pub(super) fn number_to_precision(x: f64, precision: usize) -> String {
    let (sign, x) = if x < 0.0 { ("-", -x) } else { ("", x) };
    let (n, e) = if x == 0.0 {
        (vec![0; precision], 0)
    } else {
        significant_digits(x, precision)
    };
    let mut m = digit_text(&n);
    let p = precision as i32;
    if e < -6 || e >= p {
        if precision != 1 {
            m.insert(1, '.');
        }
        return format!("{sign}{m}{}", exponent_text(e));
    }
    if e == p - 1 {
        return format!("{sign}{m}");
    }
    if e >= 0 {
        m.insert(e as usize + 1, '.');
    } else {
        m = format!("0.{}{m}", "0".repeat((-(e + 1)) as usize));
    }
    format!("{sign}{m}")
}

#[cfg(test)]
mod number_format_tests {
    use super::*;

    #[test]
    fn to_fixed_rounds_the_exact_value_ties_up() {
        // An exact tie takes the larger `n`.
        assert_eq!(number_to_fixed(0.5, 0), "1");
        assert_eq!(number_to_fixed(2.5, 0), "3");
        assert_eq!(number_to_fixed(0.125, 2), "0.13");
        // `1.005` is `1.00499…` exactly, so it rounds down.
        assert_eq!(number_to_fixed(1.005, 2), "1.00");
        assert_eq!(number_to_fixed(-1.5, 0), "-2");
        assert_eq!(number_to_fixed(-0.0, 2), "0.00");
        assert_eq!(number_to_fixed(-0.0001, 2), "-0.00");
        assert_eq!(number_to_fixed(0.0005, 3), "0.001");
        assert_eq!(number_to_fixed(999.995, 2), "1000.00");
        assert_eq!(number_to_fixed(99.5, 0), "100");
        assert_eq!(number_to_fixed(1e20, 2), "100000000000000000000.00");
        assert_eq!(number_to_fixed(0.1, 20), "0.10000000000000000555");
    }

    #[test]
    fn to_exponential_and_to_precision_spell_like_the_specification() {
        assert_eq!(number_to_exponential(123456.0, None), "1.23456e+5");
        assert_eq!(number_to_exponential(0.00015, Some(1)), "1.5e-4");
        assert_eq!(number_to_exponential(9.995, Some(2)), "9.99e+0");
        assert_eq!(number_to_exponential(9.9999, Some(2)), "1.00e+1");
        assert_eq!(number_to_exponential(0.0, Some(2)), "0.00e+0");
        assert_eq!(number_to_exponential(5e-324, None), "5e-324");
        assert_eq!(number_to_precision(123456.0, 7), "123456.0");
        assert_eq!(number_to_precision(123456.0, 2), "1.2e+5");
        assert_eq!(number_to_precision(0.000001234, 2), "0.0000012");
        assert_eq!(number_to_precision(0.0000001234, 2), "1.2e-7");
        assert_eq!(number_to_precision(0.0, 3), "0.00");
        assert_eq!(number_to_precision(99.95, 3), "100");
        assert_eq!(number_to_precision(1.5, 1), "2");
    }
}

#[cfg(test)]
mod spec_tests {
    //! The integer fast paths and the Int32 operators against the
    //! `ironhorse-spec` models, and the replaced float forms of the overflow
    //! branches, without Kani (NUM-2, NUM-3, NUM-4, NUM-5).
    use super::super::{BitOp, Interp};
    use super::*;
    use crate::value::SlotIndex;

    fn operands() -> Vec<i32> {
        let mut out: Vec<i32> = (-70..70).collect();
        out.extend([
            i32::MIN,
            i32::MIN + 1,
            i32::MAX,
            i32::MAX - 1,
            46340,
            46341,
            -46341,
            65535,
            65536,
            1 << 30,
            -(1 << 30),
            0x5555_5555,
            -0x5555_5556,
        ]);
        let mut z = 0x2545_F491_4F6C_DD1Du64;
        for _ in 0..300 {
            z ^= z << 13;
            z ^= z >> 7;
            z ^= z << 17;
            out.push(z as i32 >> (z >> 59));
        }
        out
    }

    fn bits(slot: &Slot) -> u64 {
        to_number(slot).to_bits()
    }

    /// `Integer` exactly when the value is an int32 other than -0.
    fn canonical(slot: &Slot) -> bool {
        matches!(slot.value, Payload::Integer(_))
            == ironhorse_spec::arith::exact_int32(bits(slot)).is_some()
    }

    #[test]
    fn integer_arithmetic_matches_the_spec_and_the_number_path() {
        use ironhorse_spec::arith;
        let xs = operands();
        for &x in &xs {
            for &y in &xs {
                let (ix, iy) = (Slot::integer(x), Slot::integer(y));
                let (nx, ny) = (Slot::number(f64::from(x)), Slot::number(f64::from(y)));
                for (op, want) in [
                    (ArithOp::Add, arith::add_int32(x, y)),
                    (ArithOp::Sub, arith::subtract_int32(x, y)),
                    (ArithOp::Mul, arith::multiply_int32(x, y)),
                    (ArithOp::Mod, arith::remainder_int32(x, y)),
                ] {
                    let fast = apply_arith(op, &ix, &iy);
                    let slow = apply_arith(op, &nx, &ny);
                    if f64::from_bits(want).is_nan() {
                        assert!(to_number(&fast).is_nan() && to_number(&slow).is_nan());
                    } else {
                        assert_eq!(bits(&fast), want, "{x} {y}");
                        assert_eq!(bits(&slow), want, "{x} {y}");
                    }
                    assert!(canonical(&fast), "{x} {y}");
                }
                let div = apply_arith(ArithOp::Div, &ix, &iy);
                assert_eq!(
                    bits(&div),
                    bits(&apply_arith(ArithOp::Div, &nx, &ny)),
                    "{x} / {y}"
                );
                // The integer forms of the overflow branches equal the float
                // forms they replaced (a product only overflows when neither
                // operand is zero, so it is never a signed zero).
                let (fx, fy) = (f64::from(x), f64::from(y));
                if x.checked_mul(y).is_none() {
                    assert_eq!(
                        ((i64::from(x) * i64::from(y)) as f64).to_bits(),
                        (fx * fy).to_bits()
                    );
                }
                assert_eq!(
                    ((i64::from(x) + i64::from(y)) as f64).to_bits(),
                    (fx + fy).to_bits()
                );
                assert_eq!(
                    ((i64::from(x) - i64::from(y)) as f64).to_bits(),
                    (fx - fy).to_bits()
                );
            }
            let minus = unary_minus(&Slot::integer(x));
            assert_eq!(bits(&minus), arith::unary_minus_int32(x));
            assert!(canonical(&minus));
        }
    }

    #[test]
    fn int32_operators_match_the_spec() {
        use ironhorse_spec::int32;
        let xs = operands();
        for &a in &xs {
            for &b in &xs {
                for (op, want) in [
                    (BitOp::And, int32::bitwise(int32::BitwiseOp::And, a, b)),
                    (BitOp::Or, int32::bitwise(int32::BitwiseOp::Or, a, b)),
                    (BitOp::Xor, int32::bitwise(int32::BitwiseOp::Xor, a, b)),
                    (BitOp::Shl, int32::left_shift(a, b)),
                    (BitOp::Sar, int32::signed_right_shift(a, b)),
                    (BitOp::Shr, int32::unsigned_right_shift(a, b)),
                ] {
                    let got = int32_bitop(op, a, b);
                    assert_eq!(to_number(&got), want as f64);
                    assert!(canonical(&got));
                }
                assert_eq!(i64::from(math_imul(a, b)), int32::imul(a, b));
            }
            assert_eq!(i64::from(math_clz32(a as u32)), int32::clz32(a as u32));
        }
    }

    #[test]
    fn number_slots_are_canonical_and_keep_their_bits() {
        let mut z = 0x9E37_79B9_7F4A_7C15u64;
        let samples = (0..100_000).map(|i| {
            z ^= z << 13;
            z ^= z >> 7;
            z ^= z << 17;
            match i % 3 {
                0 => z,
                1 => f64::from(z as i32).to_bits(),
                _ => ((z as i64 >> (z % 40)) as f64).to_bits() ^ (z & (1 << 63)),
            }
        });
        for b in samples.chain([0, 1 << 63, 0x7FF8_0000_0000_0001, 0x41E0_0000_0000_0000]) {
            let n = f64::from_bits(b);
            for slot in [Interp::slot_from_number(n), math_to_integer(n)] {
                match ironhorse_spec::arith::exact_int32(b) {
                    Some(i) => assert_eq!(slot, Slot::integer(i)),
                    None => assert_eq!(slot, Slot::number(n)),
                }
            }
        }
    }

    #[test]
    fn index_strings_match_the_spec() {
        use ironhorse_spec::index_string::{array_index, integer_key};
        let mut keys: Vec<String> = ["", "0", "00", "01", "-0", "+1", "1.0", "1e3", " 1", "a"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        for n in (0..1100u64).chain(4_294_967_290..4_294_967_300).chain([
            9_007_199_254_740_990,
            9_007_199_254_740_991,
            9_007_199_254_740_992,
            9_999_999_999_999_999,
            10_000_000_000_000_000,
        ]) {
            keys.push(n.to_string());
            keys.push(format!("0{n}"));
            keys.push(format!("{n}x"));
        }
        for key in &keys {
            assert_eq!(string_to_index(key), array_index(key.as_bytes()), "{key:?}");
            assert_eq!(
                string_to_array_like_index(key),
                integer_key(key.as_bytes(), (1 << 53) - 1),
                "{key:?}"
            );
        }
    }

    #[test]
    fn immediate_equalities_match_the_spec() {
        use ironhorse_spec::arith;
        let numbers = [
            0.0,
            -0.0,
            1.0,
            -1.0,
            1.5,
            f64::NAN,
            f64::INFINITY,
            2147483648.0,
        ];
        let mut slots = vec![
            Slot::undefined(),
            Slot::null(),
            Slot::boolean(true),
            Slot::boolean(false),
            Slot::of(Kind::Reference, Payload::Reference(SlotIndex(7))),
            Slot::of(Kind::Reference, Payload::Reference(SlotIndex(8))),
            Slot::integer(0),
            Slot::integer(1),
            Slot::integer(-1),
            Slot::integer(i32::MIN),
        ];
        slots.extend(numbers.map(Slot::number));
        let number = |s: &Slot| match s.value {
            Payload::Integer(i) => Some(f64::from(i).to_bits()),
            Payload::Number(n) => Some(n.to_bits()),
            _ => None,
        };
        for a in &slots {
            for b in &slots {
                let (want_sv, want_svz, want_eq) = match (number(a), number(b)) {
                    (Some(x), Some(y)) => (
                        arith::number_same_value(x, y),
                        arith::number_same_value_zero(x, y),
                        arith::number_equal(x, y),
                    ),
                    _ => {
                        let same = a.kind == b.kind && a.value == b.value;
                        (same, same, same)
                    }
                };
                assert_eq!(same_value_immediate(a, b), want_sv, "{a:?} {b:?}");
                assert_eq!(same_value_zero_immediate(a, b), want_svz, "{a:?} {b:?}");
                assert_eq!(strict_equals(a, b), want_eq, "{a:?} {b:?}");
            }
        }
    }
}

#[cfg(kani)]
mod proofs {
    //! Kani proofs of the Int32 operators (NUM-2), the integer fast paths
    //! (NUM-3), the canonical Integer representation (NUM-4) and the
    //! immediate equalities (NUM-5), against the `ironhorse-spec` models.
    use super::super::{BitOp, Interp};
    use super::*;
    use crate::value::SlotIndex;
    use ironhorse_spec::{arith, int32};

    fn bits(slot: &Slot) -> u64 {
        to_number(slot).to_bits()
    }

    /// The Number value of `slot` equals the model's bits, and the slot is
    /// `Integer` exactly when that value is an int32 other than `-0`.
    fn assert_represents(slot: &Slot, want: u64) {
        assert_eq!(bits(slot), want);
        assert_eq!(
            matches!(slot.value, Payload::Integer(_)),
            arith::exact_int32(want).is_some()
        );
    }

    fn assert_int32_result(slot: &Slot, want: i64) {
        assert_represents(slot, arith::number_value_of_integer(i128::from(want)));
    }

    // NUM-2 ------------------------------------------------------------------

    #[kani::proof]
    #[kani::unwind(33)]
    fn num2_bitwise_and() {
        let (a, b): (i32, i32) = (kani::any(), kani::any());
        let got = int32_bitop(BitOp::And, a, b);
        assert_int32_result(&got, int32::bitwise(int32::BitwiseOp::And, a, b));
        kani::cover!(a < 0 && b < 0, "two negative operands");
    }

    #[kani::proof]
    #[kani::unwind(33)]
    fn num2_bitwise_or() {
        let (a, b): (i32, i32) = (kani::any(), kani::any());
        let got = int32_bitop(BitOp::Or, a, b);
        assert_int32_result(&got, int32::bitwise(int32::BitwiseOp::Or, a, b));
        kani::cover!(
            a > 0 && b < 0 && bits(&got) >> 63 == 1,
            "a positive OR a negative"
        );
    }

    #[kani::proof]
    #[kani::unwind(33)]
    fn num2_bitwise_xor() {
        let (a, b): (i32, i32) = (kani::any(), kani::any());
        let got = int32_bitop(BitOp::Xor, a, b);
        assert_int32_result(&got, int32::bitwise(int32::BitwiseOp::Xor, a, b));
        kani::cover!(a < 0 && b > 0, "mixed signs");
    }

    #[kani::proof]
    fn num2_left_shift() {
        let (a, b): (i32, i32) = (kani::any(), kani::any());
        let got = int32_bitop(BitOp::Shl, a, b);
        assert_int32_result(&got, int32::left_shift(a, b));
        kani::cover!(
            b >= 32 && a != 0 && bits(&got) != 0,
            "a count of 32 or more, taken mod 32"
        );
    }

    #[kani::proof]
    fn num2_signed_right_shift() {
        let (a, b): (i32, i32) = (kani::any(), kani::any());
        let got = int32_bitop(BitOp::Sar, a, b);
        assert_int32_result(&got, int32::signed_right_shift(a, b));
        kani::cover!(a < 0 && b & 31 == 31, "a negative value shifted by 31");
    }

    #[kani::proof]
    fn num2_unsigned_right_shift() {
        let (a, b): (i32, i32) = (kani::any(), kani::any());
        let got = int32_bitop(BitOp::Shr, a, b);
        let want = int32::unsigned_right_shift(a, b);
        assert_int32_result(&got, want);
        kani::cover!(
            want > i64::from(i32::MAX),
            "a result above i32::MAX, kept a Number"
        );
        kani::cover!(
            a < 0 && want <= i64::from(i32::MAX),
            "a negative operand yielding an Integer"
        );
    }

    #[kani::proof]
    fn num2_imul() {
        let (a, b): (i32, i32) = (kani::any(), kani::any());
        let got = math_imul(a, b);
        assert_eq!(i64::from(got), int32::imul(a, b));
        kani::cover!(
            a > 0 && b > 0 && got < 0,
            "a positive product wrapping negative"
        );
    }

    #[kani::proof]
    #[kani::unwind(34)]
    fn num2_clz32() {
        let n: u32 = kani::any();
        let got = math_clz32(n);
        assert_eq!(i64::from(got), int32::clz32(n));
        kani::cover!(got == 32, "zero");
        kani::cover!(got == 17, "a value in [2^14, 2^15)");
    }

    // NUM-3 ------------------------------------------------------------------

    #[kani::proof]
    fn num3_add_integer_path() {
        let (x, y): (i32, i32) = (kani::any(), kani::any());
        let got = apply_arith(ArithOp::Add, &Slot::integer(x), &Slot::integer(y));
        assert_represents(&got, arith::add_int32(x, y));
        kani::cover!(x.checked_add(y).is_none(), "an overflowing sum");
    }

    #[kani::proof]
    fn num3_sub_integer_path() {
        let (x, y): (i32, i32) = (kani::any(), kani::any());
        let got = apply_arith(ArithOp::Sub, &Slot::integer(x), &Slot::integer(y));
        assert_represents(&got, arith::subtract_int32(x, y));
        kani::cover!(x.checked_sub(y).is_none(), "an overflowing difference");
    }

    #[kani::proof]
    fn num3_mul_integer_path() {
        let (x, y): (i32, i32) = (kani::any(), kani::any());
        let got = apply_arith(ArithOp::Mul, &Slot::integer(x), &Slot::integer(y));
        assert_represents(&got, arith::multiply_int32(x, y));
        kani::cover!(x == 0 && y < 0, "+0 times a negative: -0");
        kani::cover!(
            (i64::from(x) * i64::from(y)).unsigned_abs() > 1 << 53,
            "a product above 2^53, rounded"
        );
    }

    #[kani::proof]
    fn num3_unary_minus() {
        let x: i32 = kani::any();
        let got = unary_minus(&Slot::integer(x));
        assert_represents(&got, arith::unary_minus_int32(x));
        kani::cover!(x == 0, "0 negates to -0");
        kani::cover!(x == i32::MIN, "i32::MIN negates to 2^31");
    }

    /// The integer path and the Number path give bit-identical results for
    /// int32 operands. Float addition: `--no-overflow-checks`, nightly.
    #[kani::proof]
    fn num3_add_paths_agree() {
        let (x, y): (i32, i32) = (kani::any(), kani::any());
        let fast = apply_arith(ArithOp::Add, &Slot::integer(x), &Slot::integer(y));
        let slow = apply_arith(
            ArithOp::Add,
            &Slot::number(f64::from(x)),
            &Slot::number(f64::from(y)),
        );
        assert_eq!(bits(&fast), bits(&slow));
        kani::cover!(x.checked_add(y).is_none(), "an overflowing sum");
    }

    #[kani::proof]
    fn num3_sub_paths_agree() {
        let (x, y): (i32, i32) = (kani::any(), kani::any());
        let fast = apply_arith(ArithOp::Sub, &Slot::integer(x), &Slot::integer(y));
        let slow = apply_arith(
            ArithOp::Sub,
            &Slot::number(f64::from(x)),
            &Slot::number(f64::from(y)),
        );
        assert_eq!(bits(&fast), bits(&slow));
        kani::cover!(x.checked_sub(y).is_none(), "an overflowing difference");
    }

    // NUM-4 ------------------------------------------------------------------

    fn assert_canonical_slot(slot: Slot, number: u64) {
        match arith::exact_int32(number) {
            Some(i) => assert_eq!(slot, Slot::integer(i)),
            // Slot equality compares a Number's bits, NaN payload included.
            None => assert_eq!(slot, Slot::number(f64::from_bits(number))),
        }
    }

    #[kani::proof]
    fn num4_slot_from_number() {
        let b: u64 = kani::any();
        let slot = Interp::slot_from_number(f64::from_bits(b));
        assert_canonical_slot(slot, b);
        kani::cover!(b == arith::NEGATIVE_ZERO, "-0 stays a Number");
        kani::cover!(
            matches!(slot.value, Payload::Integer(i) if i < 0),
            "a negative Integer"
        );
    }

    #[kani::proof]
    fn num4_math_to_integer() {
        let b: u64 = kani::any();
        let slot = math_to_integer(f64::from_bits(b));
        assert_canonical_slot(slot, b);
        kani::cover!(b == 0x41E0_0000_0000_0000, "2^31 stays a Number");
    }

    // NUM-5 ------------------------------------------------------------------

    /// A language value an immediate slot denotes; an `Integer(i)` denotes
    /// the Number 𝔽(i).
    #[derive(Copy, Clone, PartialEq)]
    enum Value {
        Undefined,
        Null,
        Boolean(bool),
        Number(u64),
        Object(SlotIndex),
    }

    /// A well-formed slot with an immediate payload, of any kind.
    fn any_immediate() -> (Slot, Value) {
        match kani::any::<u8>() % 6 {
            0 => (Slot::undefined(), Value::Undefined),
            1 => (Slot::null(), Value::Null),
            2 => {
                let b = kani::any();
                (Slot::boolean(b), Value::Boolean(b))
            }
            3 => {
                let i = kani::any();
                (
                    Slot::integer(i),
                    Value::Number(arith::number_value_of_integer(i128::from(i))),
                )
            }
            4 => {
                let b: u64 = kani::any();
                (Slot::number(f64::from_bits(b)), Value::Number(b))
            }
            _ => {
                let r = SlotIndex(kani::any());
                (
                    Slot::of(Kind::Reference, Payload::Reference(r)),
                    Value::Object(r),
                )
            }
        }
    }

    #[kani::proof]
    fn num5_same_value() {
        let ((a, va), (b, vb)) = (any_immediate(), any_immediate());
        let want = match (va, vb) {
            (Value::Number(x), Value::Number(y)) => arith::number_same_value(x, y),
            _ => va == vb,
        };
        assert!(!needs_arena_equality(&a, &b));
        assert_eq!(same_value_immediate(&a, &b), want);
        kani::cover!(
            matches!(a.value, Payload::Integer(1))
                && matches!(b.value, Payload::Number(n) if n == 1.0),
            "Integer(1) and Number(1.0): the same value, different representations"
        );
        kani::cover!(
            want && a.value != b.value,
            "a pair Payload::eq (representation equality) tells apart"
        );
        kani::cover!(
            matches!(a.value, Payload::Number(x) if x.is_nan()) && want,
            "NaN is the same value as NaN"
        );
    }

    #[kani::proof]
    fn num5_same_value_zero() {
        let ((a, va), (b, vb)) = (any_immediate(), any_immediate());
        let want = match (va, vb) {
            (Value::Number(x), Value::Number(y)) => arith::number_same_value_zero(x, y),
            _ => va == vb,
        };
        assert_eq!(same_value_zero_immediate(&a, &b), want);
        kani::cover!(
            matches!(a.value, Payload::Integer(0))
                && matches!(b.value, Payload::Number(n) if n.to_bits() == arith::NEGATIVE_ZERO),
            "Integer(0) and -0"
        );
    }

    #[kani::proof]
    fn num5_strict_equals() {
        let ((a, va), (b, vb)) = (any_immediate(), any_immediate());
        let want = match (va, vb) {
            (Value::Number(x), Value::Number(y)) => arith::number_equal(x, y),
            _ => va == vb,
        };
        assert_eq!(strict_equals(&a, &b), want);
        kani::cover!(
            matches!(a.value, Payload::Integer(0))
                && matches!(b.value, Payload::Number(n) if n.to_bits() == arith::NEGATIVE_ZERO)
                && want,
            "Integer(0) === -0"
        );
        kani::cover!(
            matches!((a.value, b.value), (Payload::Number(x), Payload::Number(y)) if x.is_nan() && x.to_bits() == y.to_bits()),
            "NaN !== NaN with the same bits"
        );
    }
}
