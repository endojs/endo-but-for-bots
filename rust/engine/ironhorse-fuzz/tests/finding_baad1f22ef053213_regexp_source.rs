//! Differential regression for continuous-fuzz finding `baad1f22ef053213`.
//!
//! The exact input generates a 1278-byte `RegExp.source` result that crossed
//! the XS oracle's former 1023-byte capture boundary. The oracle-buffer fix
//! must keep this distinct input from becoming a false divergence.

const FINDING_INPUT: &[u8] =
    include_bytes!("../../ironhorse-vm/tests/fixtures/finding-baad1f22ef053213.input.bin");

#[test]
fn exact_regexp_source_input_agrees_with_xs() {
    assert_eq!(FINDING_INPUT.len(), 6, "the minimized input stays exact");

    let program = ironhorse_fuzz::gen_stage3b_regexp_program(FINDING_INPUT);
    assert!(
        program.ends_with(".source"),
        "the finding must continue to exercise RegExp.source"
    );
    assert_eq!(
        program.len(),
        1307,
        "the generated source must continue to cross the former capture boundary"
    );
    if let Err(divergence) = ironhorse_fuzz::differential_check_meter_v4(&program) {
        panic!("finding baad1f22ef053213 must not diverge: {divergence:?}");
    }
}
