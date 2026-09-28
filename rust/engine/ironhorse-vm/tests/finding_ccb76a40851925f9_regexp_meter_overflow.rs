//! Regression for Ironhorse fuzz finding `ccb76a40851925f9`
//! (target `differential_regexp`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`).
//!
//! The exact 5-byte minimized input
//! (sha256 `8876046ff9e64aad9dacb15b75288ecaaef453d2324d137682ca05923270247c`)
//! folds, through `ironhorse_fuzz::gen_regexp`, into the 922-byte nested
//! backreference and `\s{1,3}` alternation pattern in the adjacent fixture. It
//! is matched with the `i` flag against `" \n\n\n\n"` at offset zero. The
//! pattern matches the whole subject, but the port explores 78620 metered
//! steps first, so its raw 16.16 match meter is
//! `78620 * 65536 = 5_152_440_320`, larger than `u32::MAX`.
//!
//! At the finding SHA, the XS differential oracle copied the pin's 64-bit
//! `meterIndex` into a 32-bit field and wrapped it to `857_473_024`, creating
//! a false divergence. The oracle-side fix in `c8497fd88` widened the meter
//! fields to 64 bits; the port was already correct.
//!
//! This submodule-free test keeps the exact input beside its generated pattern
//! and pins the port's completion, captures, and full-width meter. The paired
//! `ironhorse_fuzz` test proves that the input still generates this pattern and
//! that the widened oracle agrees.

const INPUT: &[u8] = include_bytes!("fixtures/finding-ccb76a40851925f9.input.bin");
const PATTERN: &str = include_str!("fixtures/finding-ccb76a40851925f9.pattern.txt");
const FLAGS: &str = "i";
const SUBJECT: &str = " \n\n\n\n";
const START: i32 = 0;
const EXPECTED_MATCH_METER_RAW: u64 = 5_152_440_320;
const OLD_ORACLE_WRAPPED_METER: u64 = 857_473_024;
const EXPECTED_CAPTURES: &[(i32, i32)] = &[
    (0, 5),
    (0, 3),
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
    assert_eq!(INPUT.len(), 5, "the minimized finding remains exact");
    assert_eq!(PATTERN.len(), 922, "the generated pattern remains exact");
    assert!(EXPECTED_MATCH_METER_RAW > u64::from(u32::MAX));

    let program = ironhorse_regexp::compile(PATTERN, FLAGS).expect("finding pattern compiles");
    let outcome = ironhorse_regexp::match_regexp(&program, SUBJECT.as_bytes(), START);

    assert!(
        outcome.matched,
        "the exact finding pattern must still match"
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
