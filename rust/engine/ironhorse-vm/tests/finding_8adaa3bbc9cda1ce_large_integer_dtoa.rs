//! Regression for ironhorse fuzz finding `8adaa3bbc9cda1ce`
//! (target `differential_source`, toolchain `nightly-2026-08-15`).
//!
//! The exact minimized input `fc 03 bd` (sha256
//! `ae3640c01867b87df0ac9300ea7bc73ac273a010780e949beb393d945d0821bd`)
//! folds through the maintained differential-source grammar into a quotient
//! of products of `2113929216 / 1585446912` and `1585446912`. Its value is the
//! double `2513641910770335744`. XS renders that double as the non-shortest
//! `2513641910770335700`; ironhorse follows ECMA-262's shortest round-tripping
//! rule and renders the same double as `2513641910770336000`.
//!
//! The engines computed the same value, so this is the large-integer dtoa
//! spelling class again (compare `37e026fd30cbae19`). The divergence reproduced
//! only at the fuzzed project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`.
//! The differential harness compares finite Number results against the
//! oracle's exact double (commit `fdb9fef6e0`), so it no longer reports a
//! divergence. This submodule-free test replays the program that
//! `ironhorse_fuzz::gen_program` generates from the exact input, pinned in
//! `fixtures/finding-8adaa3bbc9cda1ce.program.txt`, which
//! `ironhorse-fuzz/tests/vm_finding_fixtures.rs` regenerates from the input
//! and byte-compares; the test also asserts the input's cited sha256,
//! compiles the pinned program with the pure-Rust compiler, and runs it
//! through `ironhorse-vm`. It asserts that the program completes without
//! panic and returns the spec-conformant result.

mod common;

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-8adaa3bbc9cda1ce.input.bin");
const FINDING_SOURCE: &str = include_str!("fixtures/finding-8adaa3bbc9cda1ce.program.txt");
const SHORTEST_RESULT: &str = "2513641910770336000";
/// XS's non-shortest rendering of the same double.
const XS_EXACT: &str = "2513641910770335700";

#[test]
fn exact_fuzz_input_completes_without_panic_and_renders_shortest() {
    assert_eq!(FINDING_INPUT.len(), 3, "the minimized input remains exact");
    common::fixtures::assert_input_sha256(
        FINDING_INPUT,
        "ae3640c01867b87df0ac9300ea7bc73ac273a010780e949beb393d945d0821bd",
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
