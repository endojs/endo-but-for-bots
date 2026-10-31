//! Differential regression for continuous-fuzz finding `ad5b483fc5e0973f`.
//!
//! The exact input generates a 1549-byte `RegExp.source` result that crossed
//! the XS oracle's former 1023-byte capture boundary. The oracle-buffer fix
//! must keep this distinct input from becoming a false divergence.

const FINDING_INPUT: &[u8] =
    include_bytes!("../../ironhorse-vm/tests/fixtures/finding-ad5b483fc5e0973f.input.bin");

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
        panic!("finding ad5b483fc5e0973f must not diverge: {divergence:?}");
    }
}
