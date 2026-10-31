//! Regression for ironhorse fuzz finding `bd4559ecbc0432c1`
//! (target `differential_source`, toolchain `nightly-2026-08-15`).
//!
//! The exact 3-byte minimized input (sha256
//! `f0f8704523911b8babc757edfe36bcfb8950b021396395d84afb657de8387f49`)
//! folds through the maintained differential-source grammar into
//! `(226492416 * 226492416)`. The product `51298814505517056` is below
//! `2^56` and a multiple of `2^16`, so it is an exact double.
//!
//! At project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb` the differential
//! harness reported `oracle="51298814505517056"` against
//! `ironhorse="51298814505517060"`. XS renders the double as its exact
//! 17-digit integer; ironhorse follows ECMA-262's shortest round-tripping rule
//! (as V8 does) and needs only 16 significant digits. The engines computed
//! the same value. The differential harness compares a Number completion
//! against the ECMA-262 spelling of the oracle's exact double
//! (`xs_oracle::number_to_ecma_string` over `OracleOutcome::result_number`),
//! so this spelling difference is no longer a divergence.
//!
//! This submodule-free test replays the program that
//! `ironhorse_fuzz::gen_program` generates from the exact input, pinned in
//! `fixtures/finding-bd4559ecbc0432c1.program.txt`, which
//! `ironhorse-fuzz/tests/vm_finding_fixtures.rs` regenerates from the input
//! and byte-compares; the test also asserts the input's cited sha256,
//! compiles the pinned program with the pure-Rust compiler, and runs it
//! through `ironhorse-vm`. It asserts completion without panic and the
//! spec-conformant result.

mod common;

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-bd4559ecbc0432c1.input.bin");
const FINDING_SOURCE: &str = include_str!("fixtures/finding-bd4559ecbc0432c1.program.txt");
const SHORTEST_RESULT: &str = "51298814505517060";
const XS_RESULT: &str = "51298814505517056";

#[test]
fn exact_fuzz_input_completes_and_renders_the_shortest_decimal() {
    assert_eq!(FINDING_INPUT.len(), 3, "the minimized input remains exact");
    common::fixtures::assert_input_sha256(
        FINDING_INPUT,
        "f0f8704523911b8babc757edfe36bcfb8950b021396395d84afb657de8387f49",
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
        XS_RESULT.parse::<f64>().unwrap().to_bits(),
        "the shortest and XS spellings denote the same IEEE-754 Number",
    );
}
