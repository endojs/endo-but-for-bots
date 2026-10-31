//! Differential regression for continuous-fuzz finding `bc3d0df623811a38`.
//!
//! The exact input generates a `RegExp.source` result of 1036 bytes, past the
//! XS oracle's former 1023-byte capture boundary. The oracle-buffer fix must
//! keep this distinct input from becoming a false divergence.

const FINDING_INPUT: &[u8] =
    include_bytes!("../../ironhorse-vm/tests/fixtures/finding-bc3d0df623811a38.input.bin");

#[test]
fn exact_regexp_source_input_agrees_with_xs() {
    assert_eq!(FINDING_INPUT.len(), 4, "the minimized input stays exact");

    let program = ironhorse_fuzz::gen_stage3b_regexp_program(FINDING_INPUT);
    assert!(
        program.ends_with(".source"),
        "the finding must continue to exercise RegExp.source"
    );
    let oracle = xs_oracle::run(&program).expect("the XS oracle must run the program");
    assert!(
        !oracle.result_truncated && oracle.result.len() == 1036,
        "the oracle must capture the full 1036-byte value, not the former 1023-byte prefix"
    );
    if let Err(divergence) = ironhorse_fuzz::differential_check_meter_v4(&program) {
        panic!("finding bc3d0df623811a38 must not diverge: {divergence:?}");
    }
}
