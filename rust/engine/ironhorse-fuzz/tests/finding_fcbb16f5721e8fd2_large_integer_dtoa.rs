//! Differential regression for continuous-fuzz finding `fcbb16f5721e8fd2`.
//!
//! The exact input generates a large-integer product whose Number XS spells
//! as the non-shortest `521573131844845570` while ironhorse spells the
//! shortest `521573131844845600`. Both denote the same IEEE-754 double, so the
//! differential check must agree.

const FINDING_INPUT: &[u8] =
    include_bytes!("../../ironhorse-vm/tests/fixtures/finding-fcbb16f5721e8fd2.input.bin");

#[test]
fn exact_large_integer_dtoa_input_agrees_with_xs() {
    assert_eq!(FINDING_INPUT.len(), 6, "the minimized input stays exact");

    let program = ironhorse_fuzz::gen_program(FINDING_INPUT);
    if let Err(divergence) = ironhorse_fuzz::differential_check(&program) {
        panic!("finding fcbb16f5721e8fd2 must not diverge: {divergence:?}");
    }
}
