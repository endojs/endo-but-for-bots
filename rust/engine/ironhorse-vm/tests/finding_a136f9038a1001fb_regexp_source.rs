//! Regression for continuous-Ironhorse-fuzz finding `a136f9038a1001fb`
//! (target `differential_regexp_surface`, toolchain `nightly-2026-08-15`).
//!
//! The 5-byte fuzz input `2c 2c 2c d4 88`
//! (sha256 `d3bc62680a221ff9518c4aad6b03787bded65b75091e3b1dd34b1451e7a5835c`)
//! folds, through `ironhorse_fuzz::gen_stage3b_regexp_program`, into a deeply
//! nested `new RegExp(<pattern>, "m").source` program whose completion value
//! is a 1955-byte string — longer than the XS differential oracle's (pre-fix)
//! fixed 1024-byte capture buffer. The oracle truncated its own reference
//! result to 1023 bytes and the harness read the port's *correct* full result
//! as a divergence and panicked. The port was never wrong; the fix is
//! oracle-side (grow the buffer and skip honestly when a result still
//! overflows it — landed for the same-class finding `493390fc03979205`, which
//! already covers this distinct input; `3ea435c58b4c588e` is another distinct
//! input of the class, there via `.toString()`, here via the `.source`
//! accessor).
//!
//! This test locks in the port half without needing the XS oracle or the
//! `c/moddable` submodule: it replays the exact program — as the deterministic
//! bytecode + symbols the differential oracle emitted for it — through
//! `ironhorse_vm::run_program_with_symbols` and asserts it runs to completion,
//! without panicking or truncating, producing the whole 1955-byte string.

/// The compiled program for the finding's generated source, captured once and
/// frozen. (Bytecode + symbols only — no oracle, no submodule.)
const BYTECODE: &[u8] = include_bytes!("fixtures/finding-a136f9038a1001fb.bytecode.bin");
const SYMBOLS: &[u8] = include_bytes!("fixtures/finding-a136f9038a1001fb.symbols.bin");
const EXPECTED_RESULT: &str =
    include_str!("fixtures/finding-a136f9038a1001fb.expected-result.txt");

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
