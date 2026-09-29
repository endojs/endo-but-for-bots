//! Regression for ironhorse fuzz finding `ecae051e6e8f5a27`
//! (target `differential_source`, toolchain `nightly-2026-08-15`).
//!
//! The exact minimized 10-byte input (sha256
//! `08008aee2c5d688bdab03d295c367c457bba1ed3706e802ff7ec2c6cd2e40c7d`)
//! folds through the maintained differential-source grammar into
//! [`FINDING_SOURCE`], a product of `922746880` and the negated sum
//! `377487360 + 922746880 / 17.5`. Its value is the double
//! `-396980243939421632`. Ironhorse follows ECMA-262's shortest
//! round-tripping rule (as V8 does) and renders it as `-396980243939421630`.
//! XS rendered `-396980243939421600`, which is not even the same double: it
//! rounds to a neighbor 64 below. The port is correct; the XS spelling is the
//! artifact.
//!
//! This is the large-integer dtoa spelling class again (compare
//! `aaa423e9c5d56067`). The divergence reproduced only at the fuzzed project
//! SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`. The differential harness
//! checks Number spelling against the spec, not the oracle (commit
//! `4b95dc199e`), so it no longer reports a divergence. This submodule-free
//! test replays the program that `ironhorse_fuzz::gen_program` generates
//! from the exact input, pinned in
//! `fixtures/finding-ecae051e6e8f5a27.program.txt`, which
//! `ironhorse-fuzz/tests/vm_finding_fixtures.rs` regenerates from the input
//! and byte-compares; the test also asserts the input's cited sha256,
//! compiles the pinned program with the pure-Rust compiler, and runs it
//! through `ironhorse-vm`. It asserts that the program completes without
//! panic and returns the spec-conformant result.

mod common;

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-ecae051e6e8f5a27.input.bin");
const FINDING_SOURCE: &str = include_str!("fixtures/finding-ecae051e6e8f5a27.program.txt");
const SHORTEST_RESULT: &str = "-396980243939421630";
/// The exact integer value of the result double.
const EXACT_VALUE: &str = "-396980243939421632";
/// XS's rendering, which names a different double.
const XS_SPELLING: &str = "-396980243939421600";

#[test]
fn exact_fuzz_input_completes_without_panic_and_renders_shortest() {
    assert_eq!(FINDING_INPUT.len(), 10, "the minimized input remains exact");
    common::fixtures::assert_input_sha256(
        FINDING_INPUT,
        "08008aee2c5d688bdab03d295c367c457bba1ed3706e802ff7ec2c6cd2e40c7d",
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
        EXACT_VALUE.parse::<f64>().unwrap().to_bits(),
        "the shortest spelling round-trips to the result double",
    );
    assert_ne!(
        XS_SPELLING.parse::<f64>().unwrap().to_bits(),
        EXACT_VALUE.parse::<f64>().unwrap().to_bits(),
        "the XS spelling names a different double",
    );
}
