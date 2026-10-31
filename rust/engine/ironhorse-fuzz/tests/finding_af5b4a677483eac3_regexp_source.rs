//! Differential regression for continuous-fuzz finding `af5b4a677483eac3`.
//!
//! The exact input generates a 1037-byte `RegExp.source` result that crossed
//! the XS oracle's former 1023-byte capture boundary. The oracle-buffer fix
//! must keep this distinct input from becoming a false divergence.

const FINDING_INPUT: &[u8] =
    include_bytes!("../../ironhorse-vm/tests/fixtures/finding-af5b4a677483eac3.input.bin");

#[test]
fn exact_regexp_source_input_agrees_with_xs() {
    assert_eq!(FINDING_INPUT.len(), 5, "the minimized input stays exact");

    let program = ironhorse_fuzz::gen_stage3b_regexp_program(FINDING_INPUT);
    assert!(
        program.ends_with(".source"),
        "the finding must continue to exercise RegExp.source"
    );
    assert_eq!(
        program.len(),
        1063,
        "the generated source must continue to cross the former capture boundary"
    );
    if let Err(divergence) = ironhorse_fuzz::differential_check_meter_v4(&program) {
        panic!("finding af5b4a677483eac3 must not diverge: {divergence:?}");
    }
}
