//! Regression for ironhorse fuzz finding `51c6a212946102f6`
//! (target `differential_regexp`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`).
//!
//! The exact 31-byte minimized input
//! (sha256 `a7224c7f8068466ff6259c1236ad389b6e86d577975d5842ea71b71573cc02f6`)
//! folds, through `ironhorse_fuzz::gen_regexp`, into a deeply nested
//! quantified-group pattern matched with the `s` flag against `"aaaaaaaa"`
//! at offset zero. Matching dispatches 71083 metered steps, so the raw 16.16
//! match meter is `71083 * 65536 = 4658495488`, which exceeds `u32::MAX`.
//!
//! The port keeps that full value in a `u64`. At the finding SHA, the XS
//! differential oracle copied its own 64-bit meter into a 32-bit field and
//! wrapped it to `363528192`, manufacturing a false divergence. The causal
//! oracle fix from finding `5d122a6fc10babd9` widened the meter fields to 64
//! bits; the port was always correct.
//!
//! This test replays the regexp case that `ironhorse_fuzz::gen_regexp`
//! generates from the exact input, pinned in
//! `fixtures/finding-51c6a212946102f6.regexp-case.txt`, which
//! `ironhorse-fuzz/tests/vm_finding_fixtures.rs` regenerates from the input and
//! byte-compares; the test also asserts the input's cited sha256. It then runs
//! the pinned case through the pure-Rust regexp engine, so it builds without
//! the XS oracle or `c/moddable` submodule.

mod common;

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-51c6a212946102f6.input.bin");
const REGEXP_CASE: &str = include_str!("fixtures/finding-51c6a212946102f6.regexp-case.txt");
const EXPECTED_MATCH_METER_RAW: u64 = 4_658_495_488;
const EXPECTED_CAPTURES: &[(i32, i32)] = &[
    (0, 8),
    (0, 3),
    (0, 3),
    (0, 3),
    (3, 3),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (3, 4),
    (4, 4),
    (4, 4),
    (4, 8),
    (4, 4),
    (-1, -1),
    (-1, -1),
    (4, 8),
];

#[test]
fn exact_fuzz_input_preserves_the_full_width_match_meter() {
    assert_eq!(
        FINDING_INPUT.len(),
        31,
        "the minimized finding remains exact"
    );
    common::fixtures::assert_input_sha256(
        FINDING_INPUT,
        "a7224c7f8068466ff6259c1236ad389b6e86d577975d5842ea71b71573cc02f6",
    );
    assert!(EXPECTED_MATCH_METER_RAW > u64::from(u32::MAX));

    let (pattern, flags, subject, start) = common::fixtures::regexp_case(REGEXP_CASE);
    assert_eq!(
        pattern,
        "(((a*a*)?a*|a+)((a0){1,2}(a*a*)?|a*)?|([a-c0-9]){1,2}){1,2}([a-c0-9]((a*)?a*|a*){1,2})(((a?a){1,2}(a*a*)?|a*)?((?:aa){2}){1,2}){1,2}"
    );
    assert_eq!(flags, "s");
    assert_eq!(subject, "aaaaaaaa");
    assert_eq!(start, 0);

    let program = ironhorse_regexp::compile(&pattern, &flags).expect("finding pattern compiles");
    let outcome = ironhorse_regexp::match_regexp(&program, subject.as_bytes(), start);

    assert!(outcome.matched, "the exact finding pattern must match");
    assert_eq!(
        outcome.captures, EXPECTED_CAPTURES,
        "the exact finding must retain its capture offsets"
    );
    assert_eq!(
        outcome.match_meter_raw, EXPECTED_MATCH_METER_RAW,
        "the exact finding must retain its full-width meter"
    );
    assert_ne!(
        outcome.match_meter_raw,
        EXPECTED_MATCH_METER_RAW & u64::from(u32::MAX),
        "the meter must not wrap to the old oracle's 32-bit value"
    );
}
