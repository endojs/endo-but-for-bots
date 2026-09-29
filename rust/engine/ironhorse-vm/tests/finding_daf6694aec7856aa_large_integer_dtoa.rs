//! Regression for ironhorse fuzz finding `daf6694aec7856aa`
//! (target `differential_source`, toolchain `nightly-2026-08-15`).
//!
//! The exact minimized input (sha256
//! `5da04328283592ebed204c27a9517bd883afa1109abbef2498a88c781eb546da`, 3 bytes
//! `1b 1b 74`) folds through the maintained differential-source grammar into
//! `(226492416 * 226492416)` — the byte-identical program of the earlier,
//! already-locked finding `67a52af412f03a7b`, reached from different fuzzer
//! bytes. Its value is the exactly representable double `51298814505517056`
//! (`729 * 2^46`). XS renders that double as the non-shortest exact integer
//! `51298814505517056`; ironhorse follows ECMA-262 §6.1.6.1.20's shortest
//! round-tripping rule (matching V8/Node) and renders the same double as
//! `51298814505517060`.
//!
//! The engines computed the same value. The differential harness compares a
//! Number completion against the ECMA-262 spelling of the oracle's exact
//! double (`xs_oracle::number_to_ecma_string` over
//! `OracleOutcome::result_number`), so this divergence is not reported. This
//! submodule-free test replays the program that `ironhorse_fuzz::gen_program`
//! generates from the exact input, pinned in
//! `fixtures/finding-daf6694aec7856aa.program.txt`, which
//! `ironhorse-fuzz/tests/vm_finding_fixtures.rs` regenerates from the input
//! and byte-compares; the test also asserts the input's cited sha256,
//! compiles the pinned program with the pure-Rust compiler, and runs it
//! through `ironhorse-vm`, asserting completion without panic and the
//! spec-conformant shortest result.

mod common;

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-daf6694aec7856aa.input.bin");
const FINDING_SOURCE: &str = include_str!("fixtures/finding-daf6694aec7856aa.program.txt");
const SHORTEST_RESULT: &str = "51298814505517060";

#[test]
fn exact_fuzz_input_completes_without_panic_and_renders_shortest() {
    assert_eq!(FINDING_INPUT.len(), 3, "the minimized input remains exact");
    common::fixtures::assert_input_sha256(
        FINDING_INPUT,
        "5da04328283592ebed204c27a9517bd883afa1109abbef2498a88c781eb546da",
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
