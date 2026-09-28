//! Regression for ironhorse fuzz finding `aaa423e9c5d56067`
//! (target `differential_source`, toolchain `nightly-2026-08-15`).
//!
//! The exact minimized 5-byte input (sha256
//! `3f59968fa7d286a962d7f5db249db8b45793530987923928c9a6b708ed1d68b8`)
//! folds through the maintained differential-source grammar into
//! [`FINDING_SOURCE`], a product of a short-circuited comparison with
//! `176160768 * (true - 176160768)` and a difference of that product and
//! `~830472192`. Its value is the double `-31032616836661248`. XS renders
//! that double as the non-shortest `-31032616836661248`; ironhorse follows
//! ECMA-262's shortest round-tripping rule (as V8 does) and renders the same
//! double as `-31032616836661250`.
//!
//! The engines computed the same value, so this is the large-integer dtoa
//! spelling class again (compare `8adaa3bbc9cda1ce`). The divergence reproduced
//! only at the fuzzed project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`.
//! The differential harness checks Number spelling against the spec, not
//! the oracle (commit `4b95dc199e`), so it no longer reports a divergence.
//! This submodule-free test replays the program that
//! `ironhorse_fuzz::gen_program` generates from the exact input, pinned in
//! `fixtures/finding-aaa423e9c5d56067.program.txt`, which
//! `ironhorse-fuzz/tests/vm_finding_fixtures.rs` regenerates from the input
//! and byte-compares; the test also asserts the input's cited sha256,
//! compiles the pinned program with the pure-Rust compiler, and runs it
//! through `ironhorse-vm`. It asserts that the program completes without
//! panic and returns the spec-conformant result.

mod common;

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-aaa423e9c5d56067.input.bin");
const FINDING_SOURCE: &str = include_str!("fixtures/finding-aaa423e9c5d56067.program.txt");
const SHORTEST_RESULT: &str = "-31032616836661250";
/// XS's non-shortest rendering of the same double.
const XS_EXACT: &str = "-31032616836661248";

#[test]
fn exact_fuzz_input_completes_without_panic_and_renders_shortest() {
    assert_eq!(FINDING_INPUT.len(), 5, "the minimized input remains exact");
    common::fixtures::assert_input_sha256(
        FINDING_INPUT,
        "3f59968fa7d286a962d7f5db249db8b45793530987923928c9a6b708ed1d68b8",
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
