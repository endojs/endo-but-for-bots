//! Differential regression for continuous-fuzz finding `6ba52f2bdc534545`.
//!
//! The exact input generates a RegExp `.toString()` result that crosses the
//! XS oracle's former capture-buffer boundary. The oracle-buffer fix must keep
//! that input from becoming a false differential divergence.

const FINDING_INPUT: &[u8] =
    include_bytes!("../../ironhorse-vm/tests/fixtures/finding-6ba52f2bdc534545.input.bin");

#[test]
fn exact_regexp_tostring_input_agrees_with_xs() {
    let program = ironhorse_fuzz::gen_stage3b_regexp_program(FINDING_INPUT);
    assert!(
        program.ends_with(".toString()"),
        "the finding must continue to exercise RegExp.prototype.toString"
    );
    assert!(
        program.len() > 1024,
        "the generated source must cross the former capture boundary"
    );
    if let Err(divergence) = ironhorse_fuzz::differential_check_meter_v4(&program) {
        panic!("finding 6ba52f2bdc534545 must not diverge: {divergence:?}");
    }
}
