//! Regression for ironhorse fuzz finding `67ca18e4febe7a34`
//! (target `differential_source`, toolchain `nightly-2026-08-15`).
//!
//! The exact 3-byte minimized input (sha256
//! `e19049016d8614f90c078f93b854af0cc1d7142ae509c60bbf5072f2353292df`)
//! folds through the maintained differential-source grammar into
//! `(226492416 * 226492416)`. Its value is the exactly representable double
//! `51298814505517056`. XS renders that double as the non-shortest exact
//! integer `51298814505517056`; ironhorse follows ECMA-262's shortest
//! round-tripping rule and renders the same double as `51298814505517060`.
//!
//! The engines computed the same value. The differential harness compares a
//! Number completion against the ECMA-262 spelling of the oracle's exact
//! double (`xs_oracle::number_to_ecma_string` over
//! `OracleOutcome::result_number`), so this divergence is not reported. This
//! submodule-free test replays the program that `ironhorse_fuzz::gen_program`
//! generates from the exact input, pinned in
//! `fixtures/finding-67ca18e4febe7a34.program.txt`, which
//! `ironhorse-fuzz/tests/vm_finding_fixtures.rs` regenerates from the input
//! and byte-compares; the test also asserts the input's cited sha256,
//! compiles the pinned program with the pure-Rust compiler, and runs it
//! through `ironhorse-vm`, asserting completion and the spec-conformant
//! result.

mod common;

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-67ca18e4febe7a34.input.bin");
const FINDING_SOURCE: &str = include_str!("fixtures/finding-67ca18e4febe7a34.program.txt");
const SHORTEST_RESULT: &str = "51298814505517060";

#[test]
fn exact_fuzz_input_completes_without_panic_and_renders_shortest() {
    assert_eq!(FINDING_INPUT.len(), 3, "the minimized input remains exact");
    common::fixtures::assert_input_sha256(
        FINDING_INPUT,
        "e19049016d8614f90c078f93b854af0cc1d7142ae509c60bbf5072f2353292df",
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
}
