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

/// Whether `b` is an ASCII byte XS's `fxSkipSpaces` treats as whitespace.
fn is_ecma_ws(b: u8) -> bool {
    matches!(b, 0x09 | 0x0A | 0x0B | 0x0C | 0x0D | 0x20)
}

/// `fx_parseInt` (`xsNumber.c`): the integer prefix parse over the CESU-8
/// bytes — skip leading whitespace, an optional sign, an optional `0x`/`0X`
/// (radix 16) prefix, then digits valid in `radix` (default 10). Returns an
/// INTEGER-kind slot when the result fits `i32`, else a NUMBER-kind slot; an
/// empty digit run is `NaN`. No `mxMeterSome`, no chunk.
pub(super) fn parse_int(bytes: &[u8], mut radix: i32) -> Slot {
    let n = bytes.len();
    let mut i = 0;
    while i < n && is_ecma_ws(bytes[i]) {
        i += 1;
    }
    let mut sign = 1.0f64;
    match bytes.get(i) {
        Some(b'+') => i += 1,
        Some(b'-') => {
            i += 1;
            sign = -1.0;
        }
        _ => {}
    }
    if bytes.get(i) == Some(&b'0') && matches!(bytes.get(i + 1), Some(b'x') | Some(b'X')) {
        if radix == 0 || radix == 16 {
            radix = 16;
            i += 2;
        }
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

/// The non-decimal integral arm of `Number.prototype.toString(radix)`.
/// ECMAScript permits an implementation-defined digit algorithm for this
/// radix-generalized spelling. Integers up to the exact-number boundary need
/// no rounding choice, so repeated division produces the canonical digits.
pub(super) fn number_to_radix_string(number: f64, radix: u32) -> Option<Vec<u8>> {
    if number.is_nan() {
        return Some(b"NaN".to_vec());
    }
    if number == f64::INFINITY {
        return Some(b"Infinity".to_vec());
    }
    if number == f64::NEG_INFINITY {
        return Some(b"-Infinity".to_vec());
    }
    if number == 0.0 {
        return Some(b"0".to_vec());
    }
    if number.fract() != 0.0 || number.abs() > 9007199254740992.0 {
        return None;
    }
    let negative = number.is_sign_negative();
    let mut magnitude = number.abs() as u64;
    let mut reversed = Vec::new();
    while magnitude != 0 {
        let digit = (magnitude % radix as u64) as u8;
        reversed.push(if digit < 10 {
            b'0' + digit
        } else {
            b'a' + digit - 10
        });
        magnitude /= radix as u64;
    }
    if negative {
        reversed.push(b'-');
    }
    reversed.reverse();
    Some(reversed)
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
    let mut i = 0;
    while i < n && is_ecma_ws(bytes[i]) {
        i += 1;
    }
    if whole {
        // Trim trailing whitespace; the body must consume the rest exactly.
        let mut end = n;
        while end > i && is_ecma_ws(bytes[end - 1]) {
            end -= 1;
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
                _ => (0, &body[..]),
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

// XS_CODE_ADD/SUBTRACT/MULTIPLY/DIVIDE/MODULO integer fast paths.
pub(super) fn apply_arith(op: ArithOp, a: &Slot, b: &Slot) -> Slot {
    if let (Payload::Integer(x), Payload::Integer(y)) = (a.value, b.value) {
        match op {
            ArithOp::Add => match x.checked_add(y) {
                Some(v) => return Slot::integer(v),
                None => return Slot::number(x as f64 + y as f64),
            },
            ArithOp::Sub => match x.checked_sub(y) {
                Some(v) => return Slot::integer(v),
                None => return Slot::number(x as f64 - y as f64),
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
                    None => return Slot::number(x as f64 * y as f64),
                }
            }
            ArithOp::Div => {
                // JS `/` is always floating; XS produces a number.
                return Slot::number(x as f64 / y as f64);
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
        ArithOp::Div => x / y,
        ArithOp::Mod => x % y, // Rust f64 % is C fmod semantics
    };
    Slot::number(r)
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

/// The i64 value of a decoded integer TypedArray element (an `Integer` or, for
/// a large `Uint32`, a `Number` slot). Used as the arithmetic operand of an
/// `Atomics` read-modify-write; the write re-wraps to the element width.
pub(super) fn element_slot_to_i64(s: Slot) -> i64 {
    match s.value {
        Payload::Integer(i) => i as i64,
        Payload::Number(n) => n as i64,
        _ => 0,
    }
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
    if !bytes.iter().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n: u64 = s.parse().ok()?;
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
    if !bytes.iter().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n: u64 = s.parse().ok()?;
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
