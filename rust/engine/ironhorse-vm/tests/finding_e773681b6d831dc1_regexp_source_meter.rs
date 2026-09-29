//! Regression for continuous-Ironhorse-fuzz finding `e773681b6d831dc1`
//! (target `differential_regexp_surface`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`).
//!
//! The exact 4-byte input
//! (sha256 `e920afdac5ce7e95c1bc7584407e45fa0cff40756ed0c6493716bc07a31b495f`)
//! folds, through `ironhorse_fuzz::gen_stage3b_regexp_program`, into a
//! `new RegExp(..., "").source` read of an `a{1,3}`/`c{1,3}`/`\s*`/`.*`
//! alternation with optional non-capturing groups.
//!
//! At the finding SHA the observable result agreed exactly with the XS pin;
//! only the meter differed (`computrons: oracle=37 ironhorse=38`). That is the
//! advisory cost-table class of sibling RegExp-surface findings (such as
//! `d5413146a257bc30`), not an engine-semantic defect:
//! `differential_check_meter_v4` requires completion and result agreement
//! while treating XS computrons as advisory, so it runs this exact fuzz input
//! without divergence.
//!
//! This submodule-free test preserves the exact input beside the deterministic
//! bytecode and symbols XS emitted for its generated program, then replays them
//! through `ironhorse_vm`. It deliberately does not pin a raw computron count.

mod common;

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-e773681b6d831dc1.input.bin");
const BYTECODE: &[u8] = include_bytes!("fixtures/finding-e773681b6d831dc1.bytecode.bin");
const SYMBOLS: &[u8] = include_bytes!("fixtures/finding-e773681b6d831dc1.symbols.bin");
const EXPECTED_RESULT: &str = include_str!("fixtures/finding-e773681b6d831dc1.expected-result.txt");

#[test]
fn exact_fuzz_input_regexp_source_completes_with_the_pinned_value() {
    assert_eq!(FINDING_INPUT.len(), 4, "the minimized input stays exact");
    common::fixtures::assert_input_sha256(
        FINDING_INPUT,
        "e920afdac5ce7e95c1bc7584407e45fa0cff40756ed0c6493716bc07a31b495f",
    );
    assert_eq!(
        EXPECTED_RESULT, r"a{1,3}(?:c{1,3}|\s*|.*c{1,3})?c{1,3}|\s*|(?:c{1,3})?c{1,3}|\s*",
        "the fixture preserves the RegExp.source spelling"
    );

    let output = ironhorse_vm::run_program_with_symbols(BYTECODE, SYMBOLS);
    assert!(
        output.completed,
        "the RegExp.source surface program must complete without panic, got halt {:?}",
        output.halt
    );
    assert_eq!(
        output.result, EXPECTED_RESULT,
        "the source surface must yield the byte-identical pattern text"
    );
}
