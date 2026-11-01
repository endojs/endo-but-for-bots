//! A RegExp that exceeds the matcher's or the compiler's private storage
//! bound throws a catchable `RangeError` (architecture review RGX-1, design
//! `ironhorse-in-crank-string-garbage`). The bound is on per-operation
//! scratch that is dropped when the operation returns, so the heap is intact
//! and the guest may recover; only a ceiling on the shared heap halts.
//!
//! Quantifier bounds above 2^31-1 clamp as XS's `fxPatternParserDecimal`
//! does, while the `{m,n}` order check still sees the unclamped values.

use ironhorse_vm::halt_labels::{REGEXP_COMPILE_LIMIT_MESSAGE, REGEXP_MATCH_LIMIT_MESSAGE};
use ironhorse_vm::{Interp, RunOutcome};

fn run(source: &str) -> RunOutcome {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("source compiles");
    let mut machine = Interp::new();
    machine.link_intrinsics(&ironhorse_vm::parse_symbols(&symbols));
    machine.run(&bytecode)
}

fn completes_with(source: &str, expected: &str) {
    let out = run(source);
    assert!(out.completed, "halt: {:?}\n  {source}", out.halt);
    assert_eq!(out.result, expected, "{source}");
}

/// The program names `RangeError` and `SyntaxError` so the realm links their
/// prototypes before the engine raises one.
const CATCH: &str = "function attempt(f) { \
     try { return 'no throw:' + f(); } \
     catch (e) { return (e instanceof RangeError ? 'RangeError' : \
                         e instanceof SyntaxError ? 'SyntaxError' : 'other') \
                        + ':' + e.message; } }";

#[test]
fn a_match_past_the_state_limit_throws_a_catchable_range_error() {
    // Every iteration of `(a|aa)+` leaves an alternative to backtrack into,
    // so the state stack grows with the subject and cannot be compressed.
    let source = format!(
        "{CATCH} var s = 'a'.repeat(200000); \
         var first = attempt(function () {{ return /(a|aa)+/.exec(s); }}); \
         var after = /(a|aa)+/.exec('aaa')[0]; \
         first + '|' + after"
    );
    completes_with(
        &source,
        &format!("RangeError:{REGEXP_MATCH_LIMIT_MESSAGE}|aaa"),
    );
}

#[test]
fn a_compile_past_the_payload_limit_throws_a_catchable_range_error() {
    let source = format!(
        "{CATCH} var parts = []; \
         for (var n = 0x1000; n < 0x5000; n += 2) parts.push('\\\\u{{' + n.toString(16) + '}}'); \
         var p = '[' + parts.join('') + ']'; \
         attempt(function () {{ return new RegExp(p, 'u'); }})"
    );
    completes_with(
        &source,
        &format!("RangeError:{REGEXP_COMPILE_LIMIT_MESSAGE}"),
    );
}

#[test]
fn quantifier_bounds_above_the_integer_limit_clamp() {
    // test262 built-ins/RegExp/quantifier-integer-limit.js.
    completes_with(
        "var re1 = new RegExp('b{' + Number.MAX_SAFE_INTEGER + '}', 'u'); \
         var re2 = new RegExp('b{' + Number.MAX_SAFE_INTEGER + ',}?'); \
         var re3 = new RegExp('b{' + Number.MAX_SAFE_INTEGER + ',' + Number.MAX_SAFE_INTEGER + '}'); \
         [re1.test(''), re2.test('a'), re3.test('b'), /b{4294967296,}/.test('bb')].join()",
        "false,false,false,false",
    );
}

#[test]
fn quantifier_order_is_checked_on_the_unclamped_bounds() {
    let source = format!(
        "{CATCH} [attempt(function () {{ return new RegExp('a{{4294967296,4294967295}}'); }}), \
          attempt(function () {{ return new RegExp('a{{2147483648,2147483647}}', 'u'); }}), \
          attempt(function () {{ return new RegExp('a{{4294967295,4294967296}}').test('a'); }})]\
          .map(function (r) {{ return r.split(':')[0]; }}).join()"
    );
    completes_with(&source, "SyntaxError,SyntaxError,no throw");
}
