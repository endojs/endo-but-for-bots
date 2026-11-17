//! Regression for ironhorse fuzz finding `3fc02d8b57faa79a`
//! (target `differential_source`, toolchain `nightly-2026-08-15`).
//!
//! The exact 4-byte minimized input (sha256
//! `b79d35f1bef51f37955b7b7b82e9cc54bc54739c5fc7faac9403dd96e9f95d55`)
//! folds through the maintained differential-source grammar into
//! `(981467136 * (981467136 ? (981467136 ? (-17 ? 58720256 : -17) :
//! (-17 * 58720256)) : 981467136))`. The truthy conditional arms reduce this
//! to `981467136 * 58720256`, the exactly representable double
//! `57632001481506816`.
//!
//! XS renders that double as the non-shortest exact integer
//! `57632001481506816`; ironhorse follows ECMA-262's shortest round-tripping
//! rule and renders the same Number as `57632001481506820`. The engines
//! computed the same value. The differential harness fix carries the oracle's
//! exact Number bits and compares IronHorse with an independently derived
//! ECMA-262 spelling, so this spelling difference is no longer a divergence.
//!
//! This submodule-free test replays the program that
//! `ironhorse_fuzz::gen_program` generates from the exact input, pinned in
//! `fixtures/finding-3fc02d8b57faa79a.program.txt`, which
//! `ironhorse-fuzz/tests/vm_finding_fixtures.rs` regenerates from the input
//! and byte-compares; the test also asserts the input's cited sha256,
//! compiles the pinned program with the pure-Rust compiler, and runs it
//! through `ironhorse-vm`. It asserts completion without panic and the
//! spec-conformant result.

mod common;

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-3fc02d8b57faa79a.input.bin");
const FINDING_SOURCE: &str = include_str!("fixtures/finding-3fc02d8b57faa79a.program.txt");
const SHORTEST_RESULT: &str = "57632001481506820";
const XS_EXACT_RESULT: &str = "57632001481506816";

#[test]
fn exact_fuzz_input_completes_and_renders_the_shortest_decimal() {
    assert_eq!(FINDING_INPUT.len(), 4, "the minimized input remains exact");
    common::fixtures::assert_input_sha256(
        FINDING_INPUT,
        "b79d35f1bef51f37955b7b7b82e9cc54bc54739c5fc7faac9403dd96e9f95d55",
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
        "the shortest and XS-exact spellings denote the same IEEE-754 Number",
    );
}
