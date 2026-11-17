//! Regression for ironhorse fuzz finding `2a2de75b75de4894`
//! (target `differential_source`, toolchain `nightly-2026-08-15`).
//!
//! The exact 3-byte minimized input (sha256
//! `ad63534a58b0bed2901e28c08837180c41ee82dde81e780bde94367b9e924a4e`)
//! folds through the maintained differential-source grammar into
//! `((((553648128 || 226492416) * (553648128 || 226492416)) - ((226492416 -
//! true) || (true * 226492416))) || ...)`. The short-circuit arms reduce this
//! to `553648128 * 553648128 - 226492415`. The product `1089 * 2^48` is exact;
//! the subtraction rounds to the double `306526249411411968`.
//!
//! At project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb` the differential
//! harness reported `oracle="306526249411411970"` against
//! `ironhorse="306526249411412000"`. XS renders the double with a non-shortest
//! 17-digit spelling; ironhorse follows ECMA-262's shortest round-tripping rule
//! (as V8 does) and needs only 15 digits. The engines computed the same value.
//! The differential harness compares a Number completion against the ECMA-262
//! spelling of the oracle's exact double (`xs_oracle::number_to_ecma_string`
//! over `OracleOutcome::result_number`), so this spelling difference is no
//! longer a divergence.
//!
//! This submodule-free test replays the program that
//! `ironhorse_fuzz::gen_program` generates from the exact input, pinned in
//! `fixtures/finding-2a2de75b75de4894.program.txt`, which
//! `ironhorse-fuzz/tests/vm_finding_fixtures.rs` regenerates from the input
//! and byte-compares; the test also asserts the input's cited sha256,
//! compiles the pinned program with the pure-Rust compiler, and runs it
//! through `ironhorse-vm`. It asserts completion without panic and the
//! spec-conformant result.

mod common;

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-2a2de75b75de4894.input.bin");
const FINDING_SOURCE: &str = include_str!("fixtures/finding-2a2de75b75de4894.program.txt");
const SHORTEST_RESULT: &str = "306526249411412000";
const XS_RESULT: &str = "306526249411411970";

#[test]
fn exact_fuzz_input_completes_and_renders_the_shortest_decimal() {
    assert_eq!(FINDING_INPUT.len(), 3, "the minimized input remains exact");
    common::fixtures::assert_input_sha256(
        FINDING_INPUT,
        "ad63534a58b0bed2901e28c08837180c41ee82dde81e780bde94367b9e924a4e",
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
