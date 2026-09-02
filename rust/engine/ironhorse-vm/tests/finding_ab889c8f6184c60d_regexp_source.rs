//! Regression for continuous-Ironhorse-fuzz finding `ab889c8f6184c60d`
//! (target `differential_regexp_surface`, toolchain `nightly-2026-08-15`).
//!
//! The exact 4-byte fuzz input
//! (sha256 `e31b5a31b37ce02cba6b665098b0d9844e248e95e89f252910a4ec2660412e07`)
//! folds, through `ironhorse_fuzz::gen_stage3b_regexp_program`, into a deeply
//! nested `new RegExp(<pattern>, "s").source` program whose completion value
//! is a 1216-byte string — longer than the XS differential oracle's pre-fix
//! fixed 1024-byte capture buffer. The oracle truncated its own reference
//! result to 1023 bytes and the harness read the port's correct full result as
//! a divergence and panicked. The port was never wrong; the causal fix is
//! oracle-side (grow the buffer and skip honestly when a result still
//! overflows it), already landed for same-class finding `493390fc03979205`.
//!
//! This test locks in the port half without needing the XS oracle or the
//! `c/moddable` submodule: it replays the exact generated program as the
//! deterministic bytecode + symbols emitted by the differential oracle and
//! asserts that the port runs it to completion without panicking or
//! truncating, producing the whole 1216-byte string.

/// The compiled program for the finding's generated source, captured once and
/// frozen. (Bytecode + symbols only — no oracle, no submodule.)
const BYTECODE: &[u8] = include_bytes!("fixtures/finding-ab889c8f6184c60d.bytecode.bin");
const SYMBOLS: &[u8] = include_bytes!("fixtures/finding-ab889c8f6184c60d.symbols.bin");
const EXPECTED_RESULT: &str = include_str!("fixtures/finding-ab889c8f6184c60d.expected-result.txt");

#[test]
fn regexp_source_result_is_not_panicked_or_truncated() {
    let out = ironhorse_vm::run_program_with_symbols(BYTECODE, SYMBOLS);

    assert!(
        out.completed,
        "the RegExp.source program must run to completion, got halt {:?}",
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
