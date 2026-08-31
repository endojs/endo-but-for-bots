//! Regression for continuous-Ironhorse-fuzz finding `2276f4edebdcb3bb`
//! (target `differential_regexp_surface`, toolchain `nightly-2026-08-15`).
//!
//! The exact 5-byte fuzz input
//! (sha256 `4f0d6ca037b3a7536fa8e0595f92fd251fbd6aa459d916652f87a3e9f7ad111e`)
//! folds into a deeply nested `RegExp.source` program with a 1312-byte
//! completion value. The pre-fix XS oracle truncated its own reference value
//! at its fixed 1024-byte capture buffer, then the differential harness read
//! the port's correct full value as a divergence and panicked. The port was
//! never wrong; the causal oracle-side fix (larger capture buffer plus an
//! honest skip on overflow) already landed for same-class finding
//! `493390fc03979205`.
//!
//! This submodule-free test keeps the exact input alongside the deterministic
//! bytecode and symbols emitted for its generated program. It replays that
//! program through `ironhorse_vm::run_program_with_symbols` and asserts the VM
//! completes without panicking or truncating the result.

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-2276f4edebdcb3bb.input.bin");
const BYTECODE: &[u8] = include_bytes!("fixtures/finding-2276f4edebdcb3bb.bytecode.bin");
const SYMBOLS: &[u8] = include_bytes!("fixtures/finding-2276f4edebdcb3bb.symbols.bin");
const EXPECTED_RESULT: &str = include_str!("fixtures/finding-2276f4edebdcb3bb.expected-result.txt");

#[test]
fn exact_fuzz_input_program_completes_without_panic_or_truncation() {
    assert_eq!(FINDING_INPUT.len(), 5, "the minimized input stays exact");
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
    assert!(
        output.result.len() > 1023,
        "the full result must cross the oracle's former 1023-byte boundary"
    );
    assert_eq!(
        output.result, EXPECTED_RESULT,
        "the VM must render the complete RegExp source without truncation"
    );
}
