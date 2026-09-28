//! Regression for ironhorse fuzz finding `931a687135cabb0c`
//! (target `differential_source`, toolchain `nightly-2026-08-15`).
//!
//! The 5-byte minimized input
//! (sha256 `dca671e311ff51c7e982a8778381d2a16c177906a0465b373d68f95977589a67`)
//! folds, through `ironhorse_fuzz::gen_program`, into [`FINDING_PROGRAM`]: the
//! square of `620757035`, where `310378496` is the generator's `37 << 23`
//! atom. The exact product `385339296501991225` rounds to the double
//! `385339296501991232`, and both engines compute that double.
//!
//! The divergence was in the XS oracle's rendering, not the port, as with
//! `05264cccae42245a`. XS's `fx_dtoa` printed `385339296501991200`, which lies
//! exactly halfway between the adjacent doubles `...168` and `...232` (the
//! spacing here is 64). Round-half-even takes it to `...168`, so it does not
//! round-trip. ECMA-262 §6.1.6.1.20 requires the shortest spelling that does,
//! `385339296501991230`, which is what ironhorse and V8 print.
//!
//! The differential harness already compares a Number completion against
//! the oracle's exact double, so the finding does not reproduce. This test
//! needs neither the XS oracle nor the `c/moddable` submodule. It replays
//! the program that `ironhorse_fuzz::gen_program` generates from the exact
//! input, pinned in `fixtures/finding-931a687135cabb0c.program.txt`, which
//! `ironhorse-fuzz/tests/vm_finding_fixtures.rs` regenerates from the input
//! and byte-compares; the test also asserts the input's cited sha256, and
//! pins the port's own evaluation and rendering.

mod common;

use common::TestCompiler;
use ironhorse_vm::value::number_to_ecma_string;
use ironhorse_vm::{parse_symbols, Interp};

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-931a687135cabb0c.input.bin");

/// `gen_program(FINDING_INPUT)`.
const FINDING_PROGRAM: &str = include_str!("fixtures/finding-931a687135cabb0c.program.txt");

/// The double the finding program evaluates to on both engines.
const FINDING_VALUE: f64 = 385339296501991232.0;
/// The spec-conformant (V8-matching) rendering.
const SPEC: &str = "385339296501991230";
/// XS's rendering, a tie that parses back to the neighboring double.
const XS_TIE: &str = "385339296501991200";

#[test]
fn exact_fuzz_input_generates_the_finding_program() {
    assert_eq!(FINDING_INPUT.len(), 5, "the minimized input remains exact");
    common::fixtures::assert_input_sha256(
        FINDING_INPUT,
        "dca671e311ff51c7e982a8778381d2a16c177906a0465b373d68f95977589a67",
    );
}

#[test]
fn finding_program_evaluates_and_renders_round_tripping_decimal() {
    let (code, symbols) = ironhorse_compile::compile_atoms(FINDING_PROGRAM).unwrap();
    let mut vm = Interp::new();
    vm.set_source_compiler(std::rc::Rc::new(TestCompiler));
    vm.link_intrinsics(&parse_symbols(&symbols));
    let outcome = vm.run(&code);
    assert!(outcome.completed, "{:?}", outcome.halt);
    assert_eq!(outcome.result, SPEC);
}

#[test]
fn tie_spelling_does_not_round_trip() {
    assert_eq!(number_to_ecma_string(FINDING_VALUE), SPEC);
    assert_eq!(
        SPEC.parse::<f64>().unwrap().to_bits(),
        FINDING_VALUE.to_bits()
    );
    // XS's spelling denotes a different double, so the port must not emit it.
    let tie = XS_TIE.parse::<f64>().unwrap();
    assert_eq!(tie, 385339296501991168.0);
    assert_ne!(tie.to_bits(), FINDING_VALUE.to_bits());
    assert_ne!(number_to_ecma_string(FINDING_VALUE), XS_TIE);
}
