//! Regression for continuous-Ironhorse-fuzz finding `c781c9b9de456ab2`
//! (target `differential_regexp_surface`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`).
//!
//! The exact 14-byte input
//! (sha256 `1daa22f72981a1c640bc9c5d96a4a5779a0f8d78f1ad0c171d5ab847f5a29902`)
//! folds, through `ironhorse_fuzz::gen_stage3b_regexp_program`, into a
//! `new RegExp(..., "m").flags` read of a nested `\S+\S{2}` quantifier
//! alternation.
//!
//! At the finding SHA the observable result agreed exactly with the XS pin
//! (`"m"`); only the meter differed (`computrons: oracle=48 ironhorse=49`).
//! That is the advisory cost-table class of sibling RegExp-surface findings,
//! not an engine-semantic defect: `differential_check_meter_v4` requires
//! completion and result agreement while treating XS computrons as
//! advisory, and with that fix the target runs this exact fuzz input
//! without divergence.
//!
//! This submodule-free test preserves the exact input beside the deterministic
//! bytecode and symbols XS emitted for its generated program, then replays them
//! through `ironhorse_vm`. It deliberately does not pin a raw computron count.

mod common;

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-c781c9b9de456ab2.input.bin");
const BYTECODE: &[u8] = include_bytes!("fixtures/finding-c781c9b9de456ab2.bytecode.bin");
const SYMBOLS: &[u8] = include_bytes!("fixtures/finding-c781c9b9de456ab2.symbols.bin");
const EXPECTED_RESULT: &str = include_str!("fixtures/finding-c781c9b9de456ab2.expected-result.txt");

#[test]
fn exact_fuzz_input_regexp_flags_completes_with_the_pinned_value() {
    assert_eq!(FINDING_INPUT.len(), 14, "the minimized input stays exact");
    common::fixtures::assert_input_sha256(
        FINDING_INPUT,
        "1daa22f72981a1c640bc9c5d96a4a5779a0f8d78f1ad0c171d5ab847f5a29902",
    );
    assert_eq!(
        EXPECTED_RESULT, "m",
        "the fixture preserves the RegExp flags spelling"
    );

    let output = ironhorse_vm::run_program_with_symbols(BYTECODE, SYMBOLS);
    assert!(
        output.completed,
        "the RegExp.prototype.flags surface program must complete without panic, got halt {:?}",
        output.halt
    );
    assert_eq!(
        output.result, EXPECTED_RESULT,
        "the flags surface must yield the byte-identical flags text"
    );
}
