//! Regression for ironhorse fuzz finding `37e026fd30cbae19`
//! (target `differential_source`, toolchain `nightly-2026-08-15`).
//!
//! The exact minimized input `1b 55 09` (sha256
//! `647d3c14b217f8fce6e2db6fc2ebd5f861669cbf3a48ca77a498505e7be15d36`)
//! folds through the maintained differential-source grammar into
//! `(((-(false * 226492416)) * (-(false * 226492416))) + (-((-226492416) *
//! (-226492416))))`. The left half is `(-0) * (-0)`, which is `+0`, so the
//! value is `-(226492416 * 226492416)`, the exactly representable double
//! `-51298814505517056` (`-729 * 2^46`). XS renders that double as the
//! non-shortest exact integer `-51298814505517056`; ironhorse follows
//! ECMA-262's shortest round-tripping rule and renders the same double as
//! `-51298814505517060`.
//!
//! The engines computed the same value, so this is the large-integer dtoa
//! spelling class again (compare `67a52af412f03a7b`, which is the positive
//! `(226492416 * 226492416)`). The divergence reproduced only at the fuzzed
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`. The differential
//! harness compares finite Number results against the oracle's exact double
//! (commit `fdb9fef6e0`), so it no longer reports a divergence. This
//! submodule-free test replays the program that `ironhorse_fuzz::gen_program`
//! generates from the exact input, pinned in
//! `fixtures/finding-37e026fd30cbae19.program.txt`, which
//! `ironhorse-fuzz/tests/vm_finding_fixtures.rs` regenerates from the input
//! and byte-compares; the test also asserts the input's cited sha256,
//! compiles the pinned program with the pure-Rust compiler, and runs it
//! through `ironhorse-vm`, asserting that it completes without panic and
//! returns the spec-conformant result.

mod common;

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-37e026fd30cbae19.input.bin");
const FINDING_SOURCE: &str = include_str!("fixtures/finding-37e026fd30cbae19.program.txt");
const SHORTEST_RESULT: &str = "-51298814505517060";
/// XS's non-shortest exact-integer rendering of the same double.
const XS_EXACT: &str = "-51298814505517056";

#[test]
fn exact_fuzz_input_completes_without_panic_and_renders_shortest() {
    assert_eq!(FINDING_INPUT.len(), 3, "the minimized input remains exact");
    common::fixtures::assert_input_sha256(
        FINDING_INPUT,
        "647d3c14b217f8fce6e2db6fc2ebd5f861669cbf3a48ca77a498505e7be15d36",
    );
    let source = FINDING_SOURCE;

    let (bytecode, symbols) =
        ironhorse_compile::compile_atoms(&source).expect("finding source compiles");
    let outcome = ironhorse_vm::run_program_with_symbols(&bytecode, &symbols);

    assert!(
        outcome.completed,
        "finding program must complete without panic, got halt {:?}",
        outcome.halt
    );
    assert_eq!(outcome.result, SHORTEST_RESULT);
    assert_eq!(
        SHORTEST_RESULT.parse::<f64>().unwrap().to_bits(),
        XS_EXACT.parse::<f64>().unwrap().to_bits(),
        "the shortest and XS-exact spellings are the same IEEE-754 double",
    );
}
