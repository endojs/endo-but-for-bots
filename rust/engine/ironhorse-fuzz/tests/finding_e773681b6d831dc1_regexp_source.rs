//! Differential regression for continuous-fuzz finding `e773681b6d831dc1`.
//!
//! The exact input generates a `RegExp.source` read whose result agrees with
//! XS; the finding was solely a 37-vs-38 computron gap, which the meter-v4
//! policy treats as advisory. Completion and result agreement stay mandatory.

const FINDING_INPUT: &[u8] =
    include_bytes!("../../ironhorse-vm/tests/fixtures/finding-e773681b6d831dc1.input.bin");

#[test]
fn exact_regexp_source_input_agrees_with_xs() {
    assert_eq!(FINDING_INPUT.len(), 4, "the minimized input stays exact");

    let program = ironhorse_fuzz::gen_stage3b_regexp_program(FINDING_INPUT);
    assert!(
        program.starts_with("new RegExp(") && program.ends_with(".source"),
        "the finding must continue to exercise RegExp.source: {program}"
    );
    if let Err(divergence) = ironhorse_fuzz::differential_check_meter_v4(&program) {
        panic!("finding e773681b6d831dc1 must not diverge: {divergence:?}");
    }
}
