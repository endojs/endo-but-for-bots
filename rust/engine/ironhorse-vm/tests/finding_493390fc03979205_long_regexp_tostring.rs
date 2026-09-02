//! Regression for continuous-Ironhorse-fuzz finding `493390fc03979205`
//! (target `differential_regexp_surface`).
//!
//! The 4-byte fuzz input `08 74 74 2a` folds into a deeply nested
//! `new RegExp(<pattern>, "s").toString()` program whose completion value is a
//! 1099-byte string — longer than the XS differential oracle's (then) fixed
//! 1024-byte capture buffer. The oracle truncated its own reference result to
//! 1023 bytes and the harness read the port's *correct* full result as a
//! divergence. The port was never wrong; the fix is oracle-side (grow the
//! buffer and skip honestly when a result still overflows it).
//!
//! This test locks in the port half without needing the XS oracle or the
//! `c/moddable` submodule: it replays the exact program — as the deterministic
//! bytecode + symbols the pure-Rust `ironhorse-compile` emits for it — through
//! `ironhorse_vm::run_program_with_symbols` and asserts it runs to completion,
//! without panicking or truncating, producing the whole `> 1023`-byte string.

/// The compiled program for the finding's generated source, captured once and
/// frozen. (Bytecode + symbols only — no oracle, no submodule.)
const BYTECODE: &[u8] = include_bytes!("fixtures/finding-493390fc03979205.bytecode.bin");
const SYMBOLS: &[u8] = include_bytes!("fixtures/finding-493390fc03979205.symbols.bin");
const EXPECTED_RESULT: &str =
    include_str!("fixtures/finding-493390fc03979205.expected-result.txt");

#[test]
fn long_regexp_tostring_result_is_not_panicked_or_truncated() {
    let out = ironhorse_vm::run_program_with_symbols(BYTECODE, SYMBOLS);

    assert!(
        out.completed,
        "the RegExp.toString() program must run to completion, got halt {:?}",
        out.halt
    );
    // The essence of the finding: a completion value longer than the oracle's
    // old 1023-byte usable buffer. Guard the boundary so a future shrink of the
    // port's string handling that silently truncated here would fail.
    assert!(
        out.result.len() > 1023,
        "the finding's whole-program result must exceed the old 1023-byte \
         oracle buffer (that overflow is the finding); got {} bytes",
        out.result.len()
    );
    assert_eq!(
        out.result, EXPECTED_RESULT,
        "the port must render the complete RegExp source string, untruncated"
    );
}
