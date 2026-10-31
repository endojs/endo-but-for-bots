//! Regression for ironhorse fuzz finding `fcbb16f5721e8fd2`
//! (target `differential_source`, toolchain `nightly-2026-08-15`).
//!
//! The exact 6-byte minimized input (sha256
//! `fad46ca0784d81a835adc494ab8451891bfb14000c497d7a9a7aa1c72ae0e13e`)
//! folds through the maintained differential-source grammar into
//! `(-(((true && -17) || (0.22 << 914358272)) * ((914358272 * 33554432) &&
//! (914358272 * 33554432))))`. The short-circuit arms reduce this to
//! `17 * 914358272 * 33554432`, the double `521573131844845568`.
//!
//! XS renders that double as the non-shortest `521573131844845570`; ironhorse
//! follows ECMA-262's shortest round-tripping rule (as V8 does) and renders
//! the same Number as `521573131844845600`. The engines computed the same
//! value. The differential harness compares a Number completion against the
//! ECMA-262 spelling of the oracle's exact double
//! (`xs_oracle::number_to_ecma_string` over `OracleOutcome::result_number`),
//! so this spelling difference is no longer a divergence.
//!
//! This submodule-free test replays the program that
//! `ironhorse_fuzz::gen_program` generates from the exact input, pinned in
//! `fixtures/finding-fcbb16f5721e8fd2.program.txt`, which
//! `ironhorse-fuzz/tests/vm_finding_fixtures.rs` regenerates from the input
//! and byte-compares; the test also asserts the input's cited sha256,
//! compiles the pinned program with the pure-Rust compiler, and runs it
//! through `ironhorse-vm`. It asserts completion without panic and the
//! spec-conformant result.

mod common;

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-fcbb16f5721e8fd2.input.bin");
const FINDING_SOURCE: &str = include_str!("fixtures/finding-fcbb16f5721e8fd2.program.txt");
const SHORTEST_RESULT: &str = "521573131844845600";
const XS_RESULT: &str = "521573131844845570";

#[test]
fn exact_fuzz_input_completes_and_renders_the_shortest_decimal() {
    assert_eq!(FINDING_INPUT.len(), 6, "the minimized input remains exact");
    common::fixtures::assert_input_sha256(
        FINDING_INPUT,
        "fad46ca0784d81a835adc494ab8451891bfb14000c497d7a9a7aa1c72ae0e13e",
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
