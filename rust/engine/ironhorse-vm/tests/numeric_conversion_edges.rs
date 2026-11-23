//! Guest-visible edges of the ECMA-262 numeric conversions (§7.1.6–§7.1.12)
//! and relative-index clamping, at the magnitudes where a saturating Rust
//! `as` cast and the spec's modular reduction part ways (2^31, 2^32, 2^53,
//! 2^63, 2^64).

fn eval(source: &str) -> String {
    let (code, atoms) = ironhorse_compile::compile_atoms(source).expect("compile");
    let mut vm = ironhorse_vm::Interp::new();
    vm.link_intrinsics(&ironhorse_vm::parse_symbols(&atoms));
    let result = vm.run(&code);
    assert!(result.completed, "{source}: {:?}", result.halt);
    result.result
}

/// ECMA-262 §22.1.2.1 String.fromCharCode step 2.a: ToUint16(next), which
/// is `truncate(ℝ(n)) modulo 2^16` (§7.1.9), so `2^63`, `2^64` and
/// `2^63 + 2^11` give 0, 0 and 2048. A saturating `as i64` cast instead
/// clamps every Number at or above 2^63 to `i64::MAX`, whose residue is
/// `0xFFFF`.
#[test]
fn from_char_code_reduces_huge_magnitudes_modulo_2_16() {
    assert_eq!(
        eval(
            "[2**63, 2**64, 2**63 + 2**11, 2**70, 1.7976931348623157e308, -(2**63), -(2**64), \
             2**53 + 2, -(2**53) - 2, 65537.9, -1.5, 2**32 + 65]\
             .map(function (n) { return String.fromCharCode(n).charCodeAt(0); }).join()"
        ),
        "0,0,2048,0,0,0,0,2,65534,1,65535,65"
    );
}

/// ToInt32/ToUint32 through the bitwise operators at the reduction edges.
#[test]
fn bitwise_operators_reduce_modulo_2_32() {
    assert_eq!(
        eval(
            "[2**31, 2**32, 2**32 + 1, -(2**31) - 1, 2**53 - 1, 2**63, 2**64 + 2**12, \
             -(2**64) - 2**12, 1e308, -1e-300, NaN, Infinity]\
             .map(function (n) { return (n | 0) + ':' + (n >>> 0); }).join()"
        ),
        "-2147483648:2147483648,0:0,1:1,2147483647:2147483647,-1:4294967295,0:0,\
         4096:4096,-4096:4294963200,0:0,0:0,0:0,0:0"
    );
}

/// Typed-array element stores apply ToInt8 … ToUint32 and ToUint8Clamp
/// (§25.1.3.17 NumericToRawBytes).
#[test]
fn typed_array_stores_wrap_and_clamp() {
    assert_eq!(
        eval(
            "var v = [2**64 + 2**12, -(2**63), 2**53 + 2, -129, 255.5, 254.5, 0.5, 1.5, -0.5, \
             NaN, Infinity, -Infinity, 2**32 - 1];\
             [Int8Array, Uint8Array, Int16Array, Uint16Array, Int32Array, Uint32Array, \
             Uint8ClampedArray].map(function (C) { return Array.from(new C(v)).join(' '); })\
             .join('|')"
        ),
        "0 0 2 127 -1 -2 0 1 0 0 0 0 -1|\
         0 0 2 127 255 254 0 1 0 0 0 0 255|\
         4096 0 2 -129 255 254 0 1 0 0 0 0 -1|\
         4096 0 2 65407 255 254 0 1 0 0 0 0 65535|\
         4096 0 2 -129 255 254 0 1 0 0 0 0 -1|\
         4096 0 2 4294967167 255 254 0 1 0 0 0 0 4294967295|\
         255 0 255 0 255 254 0 2 0 0 255 0 255"
    );
}

/// `split`'s limit is ToUint32 (§22.1.3.23 step 6) and an array `length`
/// assignment is ToUint32 then a range check (§10.4.2.4 ArraySetLength).
#[test]
fn split_limit_and_array_length_use_to_uint32() {
    assert_eq!(
        eval(
            "['a,b,c'.split(',', 2**32 + 2).length, 'a,b,c'.split(',', -(2**32) + 1).length, \
             'a,b,c'.split(',', 2**64).length].join()"
        ),
        "2,1,0"
    );
    assert_eq!(
        eval(
            "var a = [1, 2, 3]; var e = ''; try { a.length = 2**32; } catch (x) \
             { e = x instanceof RangeError; } e + ':' + a.length"
        ),
        "true:3"
    );
}

/// Relative indices (`ToIntegerOrInfinity` then clamp to `[0, len]`) at
/// ±∞ and beyond the length, through every family that clamps.
#[test]
fn relative_indices_clamp_at_infinities() {
    assert_eq!(
        eval(
            "var a = [0, 1, 2, 3, 4];\
             [a.slice(-Infinity, Infinity).join(''), a.slice(-7, -2).join(''), \
             a.slice(2**53, -(2**53)).join(''), a.slice(3, 2**64).join(''), \
             a.indexOf(4, -Infinity), a.indexOf(0, -(2**64)), a.lastIndexOf(0, Infinity), \
             a.lastIndexOf(0, -Infinity), a.lastIndexOf(4, -1), a.includes(0, -6), \
             [0, 1, 2, 3, 4].fill(9, -Infinity, -3).join(''), \
             [0, 1, 2, 3, 4].copyWithin(-Infinity, 3, Infinity).join(''), \
             [0, 1, 2, 3, 4].splice(-Infinity, 2).join(''), \
             'abcde'.slice(-Infinity, -1), 'abcde'.substring(-1, Infinity), \
             new Uint8Array(a).subarray(-2, Infinity).join(''), \
             new Uint8Array(a).slice(-Infinity, 2**40).join('')].join()"
        ),
        "01234,012,,34,4,0,0,-1,4,true,99234,34234,01,abcd,abcde,34,01234"
    );
}
