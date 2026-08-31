//! Regression for continuous-Ironhorse-fuzz finding `6fec81f3b42a99c1`
//! (target `differential_regexp_surface`, toolchain `nightly-2026-08-15`).
//!
//! The exact 4-byte fuzz input `2c 2c 2c 64`
//! (sha256 `ddd9481301bdb65461682c2d751d04140a4b7ae3c184c43b1bf4eec2e9fb4c8f`)
//! folds, through `ironhorse_fuzz::gen_stage3b_regexp_program`, into a deeply
//! nested `new RegExp(<pattern>, "").source` program whose completion value is
//! an 1101-byte string — longer than the XS differential oracle's (pre-fix)
//! fixed 1024-byte capture buffer. The oracle truncated its own reference
//! result at that boundary and the differential harness read the port's
//! *correct* full result as a divergence and panicked. The port was never
//! wrong; the causal fix is oracle-side (grow the capture buffer and skip
//! honestly when a result still overflows it — landed for the same-class
//! finding `493390fc03979205`, which already covers this distinct input;
//! `2276f4edebdcb3bb` and `a136f9038a1001fb` are other distinct inputs of the
//! class, likewise via the `.source` accessor).
//!
//! This submodule-free test keeps the exact input alongside the deterministic
//! bytecode and symbols the differential oracle emitted for its generated
//! program. It replays that program through
//! `ironhorse_vm::run_program_with_symbols` and asserts the VM completes
//! without panicking or truncating the result.

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-6fec81f3b42a99c1.input.bin");
const BYTECODE: &[u8] = include_bytes!("fixtures/finding-6fec81f3b42a99c1.bytecode.bin");
const SYMBOLS: &[u8] = include_bytes!("fixtures/finding-6fec81f3b42a99c1.symbols.bin");
const EXPECTED_RESULT: &str = include_str!("fixtures/finding-6fec81f3b42a99c1.expected-result.txt");

#[test]
fn exact_fuzz_input_regexp_source_completes_without_panic_or_truncation() {
    assert_eq!(FINDING_INPUT.len(), 4, "the minimized input stays exact");
    assert_eq!(
        FINDING_INPUT.last().map(|byte| byte % 12),
        Some(4),
        "the exact input selects the RegExp.source surface"
    );

    let output = ironhorse_vm::run_program_with_symbols(BYTECODE, SYMBOLS);
    assert!(
        output.completed,
        "the RegExp.source program must complete, got halt {:?}",
        output.halt
    );
    // The essence of the finding: a completion value longer than the oracle's
    // old 1023-byte usable buffer. Guard the boundary so a future shrink of the
    // port's string handling that silently truncated here would fail.
    assert!(
        output.result.len() > 1023,
        "the finding's whole-program result must exceed the old 1023-byte \
         oracle buffer (that overflow is the finding); got {} bytes",
        output.result.len()
    );
    assert_eq!(
        output.result, EXPECTED_RESULT,
        "the VM must render the complete RegExp source without truncation"
    );
}
