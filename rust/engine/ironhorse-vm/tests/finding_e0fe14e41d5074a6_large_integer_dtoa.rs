//! Regression for ironhorse fuzz finding `e0fe14e41d5074a6`
//! (target `differential_source`, toolchain `nightly-2026-08-15`).
//!
//! The exact minimized 3-byte input (sha256
//! `0863e8c3609e900aaa74aac92dc110696bf0c485c630b4e14c655d5e61fb1e98`)
//! folds through the maintained differential-source grammar into
//! [`FINDING_SOURCE`]. The short-circuiting operands reduce the program to
//! `226492415 * 226492415 + 327155712`. The mathematical integer is
//! `51298814379687937`, which rounds to the exactly representable double
//! `51298814379687936`.
//!
//! XS renders that double as the non-shortest exact integer
//! `51298814379687936`; ironhorse follows ECMA-262's shortest round-tripping
//! rule (as V8 does) and renders the same Number as `51298814379687940`.
//! The engines computed the same value. The differential harness compares a
//! Number completion against the ECMA-262 spelling of the oracle's exact
//! double (`xs_oracle::number_to_ecma_string` over
//! `OracleOutcome::result_number`), instead of treating XS's non-shortest
//! spelling as authoritative.
//!
//! This submodule-free test replays the program that
//! `ironhorse_fuzz::gen_program` generates from the exact input, pinned in
//! `fixtures/finding-e0fe14e41d5074a6.program.txt`, which
//! `ironhorse-fuzz/tests/vm_finding_fixtures.rs` regenerates from the input
//! and byte-compares; the test also asserts the input's cited sha256,
//! compiles the pinned program with the pure-Rust compiler, and runs it
//! through `ironhorse-vm`. It asserts completion without panic and the
//! spec-conformant result.

mod common;

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-e0fe14e41d5074a6.input.bin");
const FINDING_SOURCE: &str = include_str!("fixtures/finding-e0fe14e41d5074a6.program.txt");
const SHORTEST_RESULT: &str = "51298814379687940";
const XS_EXACT_RESULT: &str = "51298814379687936";

#[test]
fn exact_fuzz_input_completes_and_renders_the_shortest_decimal() {
    assert_eq!(FINDING_INPUT.len(), 3, "the minimized input remains exact");
    common::fixtures::assert_input_sha256(
        FINDING_INPUT,
        "0863e8c3609e900aaa74aac92dc110696bf0c485c630b4e14c655d5e61fb1e98",
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
        XS_EXACT_RESULT.parse::<f64>().unwrap().to_bits(),
        "the shortest and XS spellings denote the same IEEE-754 Number",
    );
}
