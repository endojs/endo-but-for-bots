//! Regression for continuous-Ironhorse-fuzz finding `1898f584e9bf841a`
//! (target `differential_regexp_surface`, toolchain `nightly-2026-08-15`).
//!
//! The exact 6-byte input
//! (sha256 `aaec838a749c7930e99743ea63dbb71008d33ddd8a3cb58d52c2052d608017fe`)
//! folds into an unescaped 79-byte `RegExp.source` result. XS returns the
//! constructor's existing source key without allocating a new string, while
//! the pre-fix port charged a fresh 96-raw-unit chunk. That pushed Ironhorse
//! from the oracle's 36 computrons to 37 and made the differential target
//! panic despite the completion value agreeing exactly.
//!
//! This submodule-free test keeps the exact input beside the deterministic
//! bytecode and symbols emitted for its generated program. It replays the
//! program through `ironhorse_vm` and locks the non-allocating getter path.

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-1898f584e9bf841a.input.bin");
const BYTECODE: &[u8] = include_bytes!("fixtures/finding-1898f584e9bf841a.bytecode.bin");
const SYMBOLS: &[u8] = include_bytes!("fixtures/finding-1898f584e9bf841a.symbols.bin");
const EXPECTED_RESULT: &str = include_str!("fixtures/finding-1898f584e9bf841a.expected-result.txt");

#[test]
fn exact_fuzz_input_source_getter_does_not_allocate() {
    assert_eq!(FINDING_INPUT.len(), 6, "the minimized input stays exact");

    let output = ironhorse_vm::run_program_with_symbols(BYTECODE, SYMBOLS);
    assert!(
        output.completed,
        "the RegExp.source program must complete without panic, got halt {:?}",
        output.halt
    );
    assert_eq!(
        output.result, EXPECTED_RESULT,
        "the source getter must preserve the completion value"
    );
    assert_eq!(
        output.computrons, 36,
        "an unescaped source getter must reuse the existing source string"
    );
}
