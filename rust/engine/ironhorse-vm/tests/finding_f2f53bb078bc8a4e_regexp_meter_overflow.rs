//! Regression for Ironhorse fuzz finding `f2f53bb078bc8a4e`
//! (target `differential_regexp`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`).
//!
//! The exact 21-byte minimized input
//! (sha256 `d1ab102ba62df3b55e7860c92b21093521cffd1b63b96c7ca9e039c6d52faef3`)
//! folds, through `ironhorse_fuzz::gen_regexp`, into the 73-byte nested
//! empty-able quantifier pattern in the adjacent fixture. It is matched with
//! the `s` flag against `"aaaaaaaa"` at offset zero. The pattern does not
//! match, but the port explores 170633 metered steps before failing, so its
//! raw 16.16 match meter is `170633 * 65536 = 11_182_604_288`, larger than
//! `u32::MAX`.
//!
//! At the finding SHA, the XS differential oracle copied the pin's 64-bit
//! `meterIndex` into a 32-bit field and wrapped it to `2_592_669_696`, creating
//! a false divergence. The oracle-side fix in `c8497fd88` widened the meter
//! fields to 64 bits; the port was already correct.
//!
//! This submodule-free test keeps the exact input beside its generated pattern
//! and pins the port's completion and full-width meter. The paired
//! `ironhorse_fuzz` test proves that the input still generates this pattern and
//! that the widened oracle agrees.

const INPUT: &[u8] = include_bytes!("fixtures/finding-f2f53bb078bc8a4e.input.bin");
const PATTERN: &str = include_str!("fixtures/finding-f2f53bb078bc8a4e.pattern.txt");
const FLAGS: &str = "s";
const SUBJECT: &str = "aaaaaaaa";
const START: i32 = 0;
const EXPECTED_MATCH_METER_RAW: u64 = 11_182_604_288;
const OLD_ORACLE_WRAPPED_METER: u64 = 2_592_669_696;
const EXPECTED_CAPTURES: &[(i32, i32)] = &[(-1, -1); 8];

#[test]
fn exact_fuzz_input_preserves_the_full_width_match_meter() {
    assert_eq!(INPUT.len(), 21, "the minimized finding remains exact");
    assert_eq!(PATTERN.len(), 73, "the generated pattern remains exact");
    assert!(EXPECTED_MATCH_METER_RAW > u64::from(u32::MAX));

    let program = ironhorse_regexp::compile(PATTERN, FLAGS).expect("finding pattern compiles");
    let outcome = ironhorse_regexp::match_regexp(&program, SUBJECT.as_bytes(), START);

    assert!(
        !outcome.matched,
        "the exact finding pattern must remain a non-match"
    );
    assert!(!outcome.aborted, "matching must complete without aborting");
    assert!(
        !outcome.resource_limit,
        "matching must complete without a resource refusal"
    );
    assert_eq!(
        outcome.captures, EXPECTED_CAPTURES,
        "capture offsets must remain bit-identical to the XS pin"
    );
    assert_eq!(
        outcome.match_meter_raw, EXPECTED_MATCH_METER_RAW,
        "the full-width match meter must not be truncated"
    );
    assert_eq!(
        EXPECTED_MATCH_METER_RAW & u64::from(u32::MAX),
        OLD_ORACLE_WRAPPED_METER
    );
    assert_ne!(
        outcome.match_meter_raw, OLD_ORACLE_WRAPPED_METER,
        "the meter must not equal the old oracle's 32-bit wrap"
    );
}
