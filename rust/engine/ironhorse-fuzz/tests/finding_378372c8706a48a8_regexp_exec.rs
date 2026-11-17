//! Differential regression for continuous-fuzz finding `378372c8706a48a8`.
//!
//! The exact input generates a `RegExp.prototype.exec` index read whose result
//! agrees with XS; the finding was solely a 108-vs-109 computron gap, which the
//! meter-v4 policy treats as advisory. Completion and result agreement stay
//! mandatory.

const FINDING_INPUT: &[u8] =
    include_bytes!("../../ironhorse-vm/tests/fixtures/finding-378372c8706a48a8.input.bin");

#[test]
fn exact_regexp_exec_input_agrees_with_xs() {
    assert_eq!(FINDING_INPUT.len(), 4, "the minimized input stays exact");

    let program = ironhorse_fuzz::gen_stage3b_regexp_program(FINDING_INPUT);
    assert!(
        program.starts_with("var m = new RegExp(") && program.contains(".exec("),
        "the finding must continue to exercise RegExp.prototype.exec: {program}"
    );
    if let Err(divergence) = ironhorse_fuzz::differential_check_meter_v4(&program) {
        panic!("finding 378372c8706a48a8 must not diverge: {divergence:?}");
    }
}
