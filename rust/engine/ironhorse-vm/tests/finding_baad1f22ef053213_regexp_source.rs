//! Regression for continuous-Ironhorse-fuzz finding `baad1f22ef053213`
//! (target `differential_regexp_surface`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`).
//!
//! The exact 6-byte fuzz input (sha256
//! `acb62697b33de3dda0995721979c11600eef65c7d2544621556d3f401b7d284a`)
//! folds into a nested `a{1,3}`/`b{1,3}`/`\s{1,3}` alternation read back
//! through `RegExp.source`, a 1278-byte completion value. The pre-fix XS
//! oracle truncated its reference value at its fixed 1024-byte capture
//! buffer, so the differential harness read the port's correct full value as
//! a divergence and panicked. The port was never wrong; commit
//! `7fae4aea2f67f5b28c9ab0e371f95c0c6f25ab15` fixed the oracle by enlarging
//! the buffer and explicitly reporting any remaining overflow.
//!
//! This submodule-free test keeps the exact input beside the deterministic
//! bytecode and symbols emitted for its generated program. It replays that
//! program through IronHorse and checks the full result without panicking.

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-baad1f22ef053213.input.bin");
const BYTECODE: &[u8] = include_bytes!("fixtures/finding-baad1f22ef053213.bytecode.bin");
const SYMBOLS: &[u8] = include_bytes!("fixtures/finding-baad1f22ef053213.symbols.bin");
const EXPECTED_RESULT: &str = include_str!("fixtures/finding-baad1f22ef053213.expected-result.txt");

#[test]
fn exact_fuzz_input_program_completes_without_panic_or_truncation() {
    assert_eq!(FINDING_INPUT.len(), 6, "the minimized input stays exact");

    let output = ironhorse_vm::run_program_with_symbols(BYTECODE, SYMBOLS);
    assert!(
        output.completed,
        "the RegExp.source program must complete, got halt {:?}",
        output.halt
    );
    assert_eq!(
        output.result.len(),
        1278,
        "the VM must return the complete value across the former oracle boundary"
    );
    assert_eq!(
        output.result, EXPECTED_RESULT,
        "the VM must render the complete RegExp source without truncation"
    );
}
