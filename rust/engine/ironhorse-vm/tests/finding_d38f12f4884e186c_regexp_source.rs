//! Regression for continuous-Ironhorse-fuzz finding `d38f12f4884e186c`
//! (target `differential_regexp_surface`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`).
//!
//! The exact 6-byte fuzz input (sha256
//! `a28c0d2756d1b3e68325325c49b7d19651960a203207a3a2a1f37f486ed1c85e`)
//! folds into a nested `\s{1,3}`/`a{1,3}0{1,3}a{1,3}`/`0{1,3}0*` alternation
//! read back through `RegExp.source`, a completion value of 1166 bytes. The
//! pre-fix XS oracle captured at most 1023 bytes in its fixed 1024-byte
//! buffer, so its reference value was a strict prefix of the port's and the
//! differential harness read the port's correct full value as a divergence
//! and panicked. The port was never wrong; commit
//! `7fae4aea2f67f5b28c9ab0e371f95c0c6f25ab15` fixed the oracle by enlarging
//! the buffer and explicitly reporting any remaining overflow.
//!
//! This submodule-free test keeps the exact input beside the deterministic
//! bytecode and symbols emitted for its generated program, which
//! `ironhorse-fuzz/tests/vm_finding_fixtures.rs` regenerates and
//! byte-compares. It replays that program through IronHorse and checks the
//! full result without panicking.

mod common;

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-d38f12f4884e186c.input.bin");
const BYTECODE: &[u8] = include_bytes!("fixtures/finding-d38f12f4884e186c.bytecode.bin");
const SYMBOLS: &[u8] = include_bytes!("fixtures/finding-d38f12f4884e186c.symbols.bin");
const EXPECTED_RESULT: &str = include_str!("fixtures/finding-d38f12f4884e186c.expected-result.txt");

#[test]
fn exact_fuzz_input_program_completes_without_panic_or_truncation() {
    assert_eq!(FINDING_INPUT.len(), 6, "the minimized input stays exact");
    common::fixtures::assert_input_sha256(
        FINDING_INPUT,
        "a28c0d2756d1b3e68325325c49b7d19651960a203207a3a2a1f37f486ed1c85e",
    );

    let output = ironhorse_vm::run_program_with_symbols(BYTECODE, SYMBOLS);
    assert!(
        output.completed,
        "the RegExp.source program must complete, got halt {:?}",
        output.halt
    );
    assert_eq!(
        output.result.len(),
        1166,
        "the VM must return the complete value past the former oracle boundary"
    );
    assert_eq!(
        output.result, EXPECTED_RESULT,
        "the VM must render the complete RegExp source without truncation"
    );
}
