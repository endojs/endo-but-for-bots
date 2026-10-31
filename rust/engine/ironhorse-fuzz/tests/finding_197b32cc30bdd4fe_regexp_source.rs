//! Differential regression for continuous-fuzz finding `197b32cc30bdd4fe`.
//!
//! The exact input generated a RegExp `.source` result that crossed the XS
//! oracle's former capture-buffer boundary. The current oracle-buffer fix must
//! keep that input from becoming a false differential divergence.

const FINDING_INPUT: &[u8] =
    include_bytes!("../../ironhorse-vm/tests/fixtures/finding-197b32cc30bdd4fe.input.bin");

#[test]
fn exact_regexp_source_input_agrees_with_xs() {
    let program = ironhorse_fuzz::gen_stage3b_regexp_program(FINDING_INPUT);
    assert!(
        program.ends_with(".source"),
        "the finding must continue to exercise RegExp.source"
    );
    assert!(
        program.len() > 1024,
        "the generated source must cross the former capture boundary"
    );
    if let Err(divergence) = ironhorse_fuzz::differential_check_meter_v4(&program) {
        panic!("finding 197b32cc30bdd4fe must not diverge: {divergence:?}");
    }
}
