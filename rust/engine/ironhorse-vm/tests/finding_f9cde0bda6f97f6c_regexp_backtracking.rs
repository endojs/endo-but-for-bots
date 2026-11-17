//! Regression for ironhorse fuzz finding `f9cde0bda6f97f6c`, a
//! `differential_regexp` timeout: the exact input folds into a 415-byte
//! chain of `.*` atoms with lookaround, flags `i`, over "cccccccc", that
//! fails only after trying every split of the subject among the atoms.
//! The differential harness ran the matcher unbudgeted and hung; through
//! the VM, an armed meter must halt the same match near its limit.
//!
//! Submodule-free: the generated pattern is pinned in
//! `fixtures/finding-f9cde0bda6f97f6c.pattern.txt`, and the fuzz crate
//! checks that the exact input still generates it.

use ironhorse_vm::{Halt, Interp};

const PATTERN: &str = include_str!("fixtures/finding-f9cde0bda6f97f6c.pattern.txt");

#[test]
fn an_armed_meter_halts_the_finding_match_mid_way() {
    const LIMIT: u64 = 200_000;
    assert!(!PATTERN.contains('/') && !PATTERN.contains('\n'));
    let src = format!("var re = /{PATTERN}/i; re.test('cccccccc')");
    let (b, s) = ironhorse_compile::compile_atoms(&src).expect("compiles");
    let n = ironhorse_vm::parse_symbols(&s);
    let mut m = Interp::new();
    m.link_intrinsics(&n);
    m.arm_meter(1_000, Box::new(|computrons| computrons <= LIMIT));
    let out = m.run(&b);
    assert!(
        matches!(out.halt, Halt::MeterAbort),
        "the host's refusal must halt the crank: {:?}",
        out.halt
    );
    let slack = 4 * ironhorse_regexp::MATCH_CHECK_STRIDE + 1_000;
    assert!(
        out.computrons < LIMIT + slack,
        "abort must land inside the match: {} computrons against a limit of {LIMIT}",
        out.computrons
    );
}
