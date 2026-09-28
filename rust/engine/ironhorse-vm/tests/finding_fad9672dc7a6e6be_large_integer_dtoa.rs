//! Regression for ironhorse fuzz finding `fad9672dc7a6e6be`
//! (target `differential_source`, toolchain `nightly-2026-08-15`).
//!
//! The exact minimized 6-byte input (sha256
//! `676e2c8aa6e7d449bd966554684840708b84656330fadc8b69bff829ef18c94b`)
//! folds through the maintained differential-source grammar into
//! [`FINDING_SOURCE`]. The short-circuiting operands reduce the program to
//! `(false - 494927872) * 494927872`, that is `-(494927872 ** 2)`. The
//! mathematical integer `-244953598482448384` is exactly representable.
//!
//! At project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb` the differential
//! harness reported `oracle="-244953598482448380"` against
//! `ironhorse="-244953598482448400"`. XS renders the double with a
//! non-shortest 17-digit spelling; ironhorse follows ECMA-262's shortest
//! round-tripping rule (as V8 does) and needs only 16 digits. The engines
//! computed the same value. The differential harness compares a Number
//! completion against the ECMA-262 spelling of the oracle's exact double
//! (`xs_oracle::number_to_ecma_string` over `OracleOutcome::result_number`),
//! instead of treating XS's non-shortest spelling as authoritative.
//!
//! This submodule-free test replays the program that
//! `ironhorse_fuzz::gen_program` generates from the exact input, pinned in
//! `fixtures/finding-fad9672dc7a6e6be.program.txt`, which
//! `ironhorse-fuzz/tests/vm_finding_fixtures.rs` regenerates from the input
//! and byte-compares; the test also asserts the input's cited sha256,
//! compiles the pinned program with the pure-Rust compiler, and runs it
//! through `ironhorse-vm`. It asserts completion without panic and the
//! spec-conformant result.

mod common;

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-fad9672dc7a6e6be.input.bin");
const FINDING_SOURCE: &str = include_str!("fixtures/finding-fad9672dc7a6e6be.program.txt");
const SHORTEST_RESULT: &str = "-244953598482448400";
const XS_RESULT: &str = "-244953598482448380";
const EXACT_RESULT: &str = "-244953598482448384";

#[test]
fn exact_fuzz_input_completes_and_renders_the_shortest_decimal() {
    assert_eq!(FINDING_INPUT.len(), 6, "the minimized input remains exact");
    common::fixtures::assert_input_sha256(
        FINDING_INPUT,
        "676e2c8aa6e7d449bd966554684840708b84656330fadc8b69bff829ef18c94b",
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
    let exact_bits = EXACT_RESULT.parse::<f64>().unwrap().to_bits();
    assert_eq!(
        SHORTEST_RESULT.parse::<f64>().unwrap().to_bits(),
        exact_bits,
        "the shortest spelling denotes the exact product",
    );
    assert_eq!(
        XS_RESULT.parse::<f64>().unwrap().to_bits(),
        exact_bits,
        "the XS spelling denotes the same IEEE-754 Number",
    );
}
