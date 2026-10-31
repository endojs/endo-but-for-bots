//! Regression for continuous-Ironhorse-fuzz finding `af5b4a677483eac3`
//! (target `differential_regexp_surface`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`).
//!
//! The exact 5-byte fuzz input (sha256
//! `364855bc3a2f7ac1e15c7d1ae53b06033c3e9999369eca3ce39397f434fb516b`)
//! folds into a deeply nested `RegExp.source` program with a 1037-byte
//! completion value. The pre-fix XS oracle truncated its reference value at
//! its fixed 1024-byte capture buffer, then the differential harness read the
//! port's correct full value as a divergence and panicked. The port was never
//! wrong; commit `7fae4aea2f67f5b28c9ab0e371f95c0c6f25ab15` fixed the oracle by
//! enlarging the buffer and explicitly reporting any remaining overflow.
//!
//! This submodule-free test keeps the exact input beside the deterministic
//! bytecode and symbols emitted for its generated program. It replays that
//! program through IronHorse and checks the full result without panicking.

mod common;

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-af5b4a677483eac3.input.bin");
const BYTECODE: &[u8] = include_bytes!("fixtures/finding-af5b4a677483eac3.bytecode.bin");
const SYMBOLS: &[u8] = include_bytes!("fixtures/finding-af5b4a677483eac3.symbols.bin");
const EXPECTED_RESULT: &str = include_str!("fixtures/finding-af5b4a677483eac3.expected-result.txt");

#[test]
fn exact_fuzz_input_program_completes_without_panic_or_truncation() {
    assert_eq!(FINDING_INPUT.len(), 5, "the minimized input stays exact");
    common::fixtures::assert_input_sha256(
        FINDING_INPUT,
        "364855bc3a2f7ac1e15c7d1ae53b06033c3e9999369eca3ce39397f434fb516b",
    );

    let output = ironhorse_vm::run_program_with_symbols(BYTECODE, SYMBOLS);
    assert!(
        output.completed,
        "the RegExp.source program must complete, got halt {:?}",
        output.halt
    );
    assert_eq!(
        output.result.len(),
        1037,
        "the VM must return the complete value across the former oracle boundary"
    );
    assert_eq!(
        output.result, EXPECTED_RESULT,
        "the VM must render the complete RegExp source without truncation"
    );
}
