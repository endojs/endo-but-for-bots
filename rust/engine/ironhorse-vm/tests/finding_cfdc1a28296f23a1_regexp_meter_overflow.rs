//! Regression for Ironhorse fuzz finding `cfdc1a28296f23a1`
//! (target `differential_regexp`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`).
//!
//! The exact 6-byte minimized input
//! (sha256 `0603c5237ff20137251a9f7ce92fccd95d7ba0d80ebd5e300dd82dbfd6453f4d`)
//! folds, through `ironhorse_fuzz::gen_regexp`, into the 371-byte nested
//! backreference pattern in the adjacent fixture. It is matched with the `s`
//! flag against `"0"` at offset zero. The pattern does not match, but the port
//! explores 164938 metered steps before failing, so its raw 16.16 match meter
//! is `164938 * 65536 = 10_809_376_768`, larger than `u32::MAX`.
//!
//! At the finding SHA, the XS differential oracle copied the pin's 64-bit
//! `meterIndex` into a 32-bit field and wrapped it to `2_219_442_176`, creating
//! a false divergence. The oracle-side fix in `c8497fd88` widened the meter
//! fields to 64 bits; the port was already correct.
//!
//! This submodule-free test keeps the exact input beside its generated pattern
//! and pins the port's completion and full-width meter. The paired
//! `ironhorse_fuzz` test proves that the input still generates this pattern and
//! that the widened oracle agrees.

mod common;

const INPUT: &[u8] = include_bytes!("fixtures/finding-cfdc1a28296f23a1.input.bin");
const PATTERN: &str = include_str!("fixtures/finding-cfdc1a28296f23a1.pattern.txt");
const FLAGS: &str = "s";
const SUBJECT: &str = "0";
const START: i32 = 0;
const EXPECTED_MATCH_METER_RAW: u64 = 10_809_376_768;
const EXPECTED_CAPTURES: &[(i32, i32)] = &[
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
];

#[test]
fn exact_fuzz_input_preserves_the_full_width_match_meter() {
    assert_eq!(INPUT.len(), 6, "the minimized finding remains exact");
    common::fixtures::assert_input_sha256(
        INPUT,
        "0603c5237ff20137251a9f7ce92fccd95d7ba0d80ebd5e300dd82dbfd6453f4d",
    );
    assert_eq!(PATTERN.len(), 371, "the generated pattern remains exact");
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
    assert_ne!(
        outcome.match_meter_raw,
        EXPECTED_MATCH_METER_RAW & u64::from(u32::MAX),
        "the meter must not equal the old oracle's 32-bit wrap"
    );
}
