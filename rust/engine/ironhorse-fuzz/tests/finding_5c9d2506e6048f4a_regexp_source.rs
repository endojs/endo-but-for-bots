//! Differential regression for continuous-fuzz finding `5c9d2506e6048f4a`.
//!
//! The exact input generated a RegExp `.source` result that crossed the XS
//! oracle's former capture-buffer boundary. The current oracle-buffer fix must
//! keep that input from becoming a false differential divergence.

const PROGRAM: &str =
    include_str!("../../ironhorse-vm/tests/fixtures/finding-5c9d2506e6048f4a.regexp-program.txt");

#[test]
fn exact_regexp_source_input_agrees_with_xs() {
    let program = PROGRAM;
    assert!(
        program.ends_with(".source"),
        "the finding must continue to exercise RegExp.source"
    );
    assert_eq!(
        program.len(),
        1197,
        "the generated source must continue to cross the former capture boundary"
    );
    if let Err(divergence) = ironhorse_fuzz::differential_check_meter_v4(&program) {
        panic!("finding 5c9d2506e6048f4a must not diverge: {divergence:?}");
    }
}
