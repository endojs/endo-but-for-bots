//! Regression for ironhorse fuzz finding `9edaa2277fb90f03`
//! (target `differential_source`, toolchain `nightly-2026-08-15`).
//!
//! The exact minimized input `2d 1c 7e 5c` (sha256
//! `3add41810a522cd14a50ab2b5c48b49e76625f9b82dc4cef0b85841efb4891d2`)
//! folds through the maintained differential-source grammar into a quotient
//! of products whose value is `234881024 * 234881024`, the exactly
//! representable double `55169095435288576`. XS renders that double as the
//! non-shortest `55169095435288576`; ironhorse follows ECMA-262's shortest
//! round-tripping rule and renders the same double as `55169095435288580`.
//!
//! The engines computed the same value, so this is the large-integer dtoa
//! spelling class again (compare `8adaa3bbc9cda1ce`). The divergence reproduced
//! only at the fuzzed project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`.
//! The differential harness compares finite Number results against the
//! oracle's exact double (commit `fdb9fef6e0`), so it no longer reports a
//! divergence. This submodule-free test replays the program that
//! `ironhorse_fuzz::gen_program` generates from the exact input, pinned in
//! `fixtures/finding-9edaa2277fb90f03.program.txt`, which
//! `ironhorse-fuzz/tests/vm_finding_fixtures.rs` regenerates from the input
//! and byte-compares; the test also asserts the input's cited sha256,
//! compiles the pinned program with the pure-Rust compiler, and runs it
//! through `ironhorse-vm`. It asserts that the program completes without
//! panic and returns the spec-conformant result.

mod common;

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-9edaa2277fb90f03.input.bin");
const FINDING_SOURCE: &str = include_str!("fixtures/finding-9edaa2277fb90f03.program.txt");
const SHORTEST_RESULT: &str = "55169095435288580";
/// XS's non-shortest rendering of the same double.
const XS_EXACT: &str = "55169095435288576";

#[test]
fn exact_fuzz_input_completes_without_panic_and_renders_shortest() {
    assert_eq!(FINDING_INPUT.len(), 4, "the minimized input remains exact");
    common::fixtures::assert_input_sha256(
        FINDING_INPUT,
        "3add41810a522cd14a50ab2b5c48b49e76625f9b82dc4cef0b85841efb4891d2",
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
