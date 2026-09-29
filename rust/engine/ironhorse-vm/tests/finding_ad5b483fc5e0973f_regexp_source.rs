//! Regression for continuous-Ironhorse-fuzz finding `ad5b483fc5e0973f`
//! (target `differential_regexp_surface`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`).
//!
//! The exact 5-byte fuzz input (sha256
//! `2cb19c84bdd3ba49bc1ac5004946f79f7c2757a5787b2153019a58cd7012a48e`)
//! folds into a deeply nested `RegExp.source` program with a 1549-byte
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

mod common;

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-ad5b483fc5e0973f.input.bin");
const BYTECODE: &[u8] = include_bytes!("fixtures/finding-ad5b483fc5e0973f.bytecode.bin");
const SYMBOLS: &[u8] = include_bytes!("fixtures/finding-ad5b483fc5e0973f.symbols.bin");
const EXPECTED_RESULT: &str = include_str!("fixtures/finding-ad5b483fc5e0973f.expected-result.txt");

#[test]
fn exact_fuzz_input_program_completes_without_panic_or_truncation() {
    assert_eq!(FINDING_INPUT.len(), 5, "the minimized input stays exact");
    common::fixtures::assert_input_sha256(
        FINDING_INPUT,
        "2cb19c84bdd3ba49bc1ac5004946f79f7c2757a5787b2153019a58cd7012a48e",
    );
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
    assert_eq!(
        output.result.len(),
        1549,
        "the VM must return the complete value across the former oracle boundary"
    );
    assert_eq!(
        output.result, EXPECTED_RESULT,
        "the VM must render the complete RegExp source without truncation"
    );
}
