//! Regression for ironhorse fuzz finding `27824c75429b8581`
//! (target `differential_source`, toolchain `nightly-2026-08-15`).
//!
//! The exact minimized input (sha256
//! `7fe960a158191d9bbf71e234947f5d3854f846606e3b44edb3e800f8e408b5af`)
//! folds through the maintained differential-source grammar into
//! [`FINDING_SOURCE`]. Both engines compute the exactly representable double
//! `57983845202395136`. XS renders that value as the non-shortest exact
//! integer, while ironhorse uses the ECMA-262 shortest round-tripping decimal
//! `57983845202395140`, matching V8.
//!
//! The port was correct: the differential harness compares a Number
//! completion against the ECMA-262 spelling of the oracle's exact double
//! (`xs_oracle::number_to_ecma_string` over `OracleOutcome::result_number`),
//! so this divergence is not reported. This submodule-free test replays the
//! program that `ironhorse_fuzz::gen_program` generates from the exact
//! input, pinned in `fixtures/finding-27824c75429b8581.program.txt`, which
//! `ironhorse-fuzz/tests/vm_finding_fixtures.rs` regenerates from the input
//! and byte-compares; the test also asserts the input's cited sha256,
//! compiles the pinned program with the pure-Rust compiler, and runs it
//! through `ironhorse-vm`.

mod common;

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-27824c75429b8581.input.bin");
const FINDING_SOURCE: &str = include_str!("fixtures/finding-27824c75429b8581.program.txt");
const SHORTEST_RESULT: &str = "57983845202395140";
const XS_EXACT_RESULT: &str = "57983845202395136";

#[test]
fn exact_fuzz_input_completes_without_panic_and_renders_shortest() {
    assert_eq!(FINDING_INPUT.len(), 11, "the minimized input remains exact");
    common::fixtures::assert_input_sha256(
        FINDING_INPUT,
        "7fe960a158191d9bbf71e234947f5d3854f846606e3b44edb3e800f8e408b5af",
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
        "the shortest and XS-exact spellings are the same IEEE-754 double",
    );
}
