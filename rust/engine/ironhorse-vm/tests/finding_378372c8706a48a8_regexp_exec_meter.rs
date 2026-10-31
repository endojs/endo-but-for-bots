//! Regression for continuous-Ironhorse-fuzz finding `378372c8706a48a8`
//! (target `differential_regexp_surface`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`).
//!
//! The exact 4-byte input
//! (sha256 `9e4628f969978382d9e41916212caa85a61b2c6ea35f25889faed1b7bfe92ebc`)
//! folds, through `ironhorse_fuzz::gen_stage3b_regexp_program`, into a
//! `new RegExp(..., "").exec("c\nc")` over nested `{1,2}` whitespace groups
//! with a `\2` backreference, reporting `m ? m.index : -1`. The pattern needs
//! three whitespace characters and the subject has one, so no match exists and
//! the completion is `-1` (V8 agrees).
//!
//! At the finding SHA the observable result agreed exactly with the XS pin;
//! only the meter differed (`computrons: oracle=108 ironhorse=109`). That is
//! the advisory cost-table class of sibling RegExp-surface findings (such as
//! `e773681b6d831dc1`), not an engine-semantic defect:
//! `differential_check_meter_v4` requires completion and result agreement
//! while treating XS computrons as advisory, so it runs this exact fuzz input
//! without divergence.
//!
//! This submodule-free test preserves the exact input beside the deterministic
//! bytecode and symbols XS emitted for its generated program, then replays them
//! through `ironhorse_vm`. It deliberately does not pin a raw computron count.

mod common;

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-378372c8706a48a8.input.bin");
const BYTECODE: &[u8] = include_bytes!("fixtures/finding-378372c8706a48a8.bytecode.bin");
const SYMBOLS: &[u8] = include_bytes!("fixtures/finding-378372c8706a48a8.symbols.bin");
const EXPECTED_RESULT: &str = include_str!("fixtures/finding-378372c8706a48a8.expected-result.txt");

#[test]
fn exact_fuzz_input_regexp_exec_completes_with_the_pinned_value() {
    assert_eq!(FINDING_INPUT.len(), 4, "the minimized input stays exact");
    common::fixtures::assert_input_sha256(
        FINDING_INPUT,
        "9e4628f969978382d9e41916212caa85a61b2c6ea35f25889faed1b7bfe92ebc",
    );
    assert_eq!(
        EXPECTED_RESULT, "-1",
        "the fixture preserves the no-match index"
    );

    let output = ironhorse_vm::run_program_with_symbols(BYTECODE, SYMBOLS);
    assert!(
        output.completed,
        "the RegExp.exec surface program must complete without panic, got halt {:?}",
        output.halt
    );
    assert_eq!(
        output.result, EXPECTED_RESULT,
        "the exec surface must report no match"
    );
}
