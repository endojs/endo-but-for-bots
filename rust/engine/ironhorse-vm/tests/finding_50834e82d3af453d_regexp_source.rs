//! Regression for continuous-Ironhorse-fuzz finding `50834e82d3af453d`
//! (target `differential_regexp_surface`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`).
//!
//! The exact 4-byte fuzz input (sha256
//! `d1902d4a0515ef8b070f7e77cd65ad31467a9042e37de8f68b00b2f771532cb7`)
//! folds into a nested `\s{1,3}`/`.{1,3}`/`[a-c]` alternation read back
//! through `RegExp.source`, a completion value of exactly 1024 bytes. The
//! pre-fix XS oracle captured at most 1023 bytes in its fixed 1024-byte
//! buffer, so its reference value lost the final byte and the differential
//! harness read the port's correct full value as a divergence and panicked.
//! The port was never wrong; commit
//! `7fae4aea2f67f5b28c9ab0e371f95c0c6f25ab15` fixed the oracle by enlarging
//! the buffer and explicitly reporting any remaining overflow.
//!
//! This submodule-free test keeps the exact input beside the deterministic
//! bytecode and symbols emitted for its generated program. It replays that
//! program through IronHorse and checks the full result without panicking.

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-50834e82d3af453d.input.bin");
const BYTECODE: &[u8] = include_bytes!("fixtures/finding-50834e82d3af453d.bytecode.bin");
const SYMBOLS: &[u8] = include_bytes!("fixtures/finding-50834e82d3af453d.symbols.bin");
const EXPECTED_RESULT: &str = include_str!("fixtures/finding-50834e82d3af453d.expected-result.txt");

#[test]
fn exact_fuzz_input_program_completes_without_panic_or_truncation() {
    assert_eq!(FINDING_INPUT.len(), 4, "the minimized input stays exact");

    let output = ironhorse_vm::run_program_with_symbols(BYTECODE, SYMBOLS);
    assert!(
        output.completed,
        "the RegExp.source program must complete, got halt {:?}",
        output.halt
    );
    assert_eq!(
        output.result.len(),
        1024,
        "the VM must return the complete value one byte past the former oracle boundary"
    );
    assert_eq!(
        output.result, EXPECTED_RESULT,
        "the VM must render the complete RegExp source without truncation"
    );
}
