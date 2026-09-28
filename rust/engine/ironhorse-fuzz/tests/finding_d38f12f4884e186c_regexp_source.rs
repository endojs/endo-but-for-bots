//! Differential regression for continuous-fuzz finding `d38f12f4884e186c`.
//!
//! The exact input generates a `RegExp.source` result of 1166 bytes, past the
//! XS oracle's former 1023-byte capture boundary. The oracle-buffer fix must
//! keep this distinct input from becoming a false divergence.

const FINDING_INPUT: &[u8] =
    include_bytes!("../../ironhorse-vm/tests/fixtures/finding-d38f12f4884e186c.input.bin");
const EXPECTED_RESULT: &str =
    include_str!("../../ironhorse-vm/tests/fixtures/finding-d38f12f4884e186c.expected-result.txt");

#[test]
fn exact_regexp_source_input_agrees_with_xs() {
    assert_eq!(FINDING_INPUT.len(), 6, "the minimized input stays exact");

    let program = ironhorse_fuzz::gen_stage3b_regexp_program(FINDING_INPUT);
    assert!(
        program.ends_with(".source"),
        "the finding must continue to exercise RegExp.source"
    );
    let oracle = xs_oracle::run(&program).expect("the XS oracle must run the program");
    assert!(
        !oracle.result_truncated && oracle.result.len() == 1166,
        "the oracle must capture the full 1166-byte value, not the former 1023-byte prefix"
    );
    assert_eq!(
        oracle.result, EXPECTED_RESULT,
        "the VM fixture must pin the value XS computes"
    );
    if let Err(divergence) = ironhorse_fuzz::differential_check_meter_v4(&program) {
        panic!("finding d38f12f4884e186c must not diverge: {divergence:?}");
    }
}
