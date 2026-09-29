//! Regression for ironhorse fuzz finding `ab41c5d203ace017`
//! (target `differential_regexp`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`).
//!
//! The exact 6-byte minimized input
//! (sha256 `b9c2c014ed3f9ee4dccbc06af2f048d3399c9b9be27b9bb49d13ed00cc0dd51e`)
//! folds, through `ironhorse_fuzz::gen_regexp`, into a 30-group pattern: a
//! `{1,2}`-quantified alternation of `{1,2}`-quantified groups of starred
//! backreferences around `\w*` runs, matched with no flags against `"0"`
//! from offset zero. It matches `[0, 1)`, but only after 170340 metered
//! backtracking steps, so the raw 16.16 match meter is
//! `170340 * 65536 = 11163402240`, beyond `u32::MAX`.
//!
//! The port keeps that full value in a `u64`. At the finding SHA, the XS
//! differential oracle copied its own 64-bit meter into a 32-bit field
//! (`txU4 match_meter_raw`) and wrapped it to `2573467648`
//! (`11163402240 - 2 * 2^32`), manufacturing a false meter divergence. The
//! causal oracle fix from finding `5d122a6fc10babd9` (c8497fd88b) widened the
//! meter fields to 64 bits; the port was always correct.
//!
//! This test replays the regexp case that `ironhorse_fuzz::gen_regexp`
//! generates from the exact input, pinned in
//! `fixtures/finding-ab41c5d203ace017.regexp-case.txt`, which
//! `ironhorse-fuzz/tests/vm_finding_fixtures.rs` regenerates from the input and
//! byte-compares; the test also asserts the input's cited sha256. It then runs
//! the pinned case through the pure-Rust regexp engine, so it builds without
//! the XS oracle or `c/moddable` submodule.

mod common;

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-ab41c5d203ace017.input.bin");
const REGEXP_CASE: &str = include_str!("fixtures/finding-ab41c5d203ace017.regexp-case.txt");
const EXPECTED_MATCH_METER_RAW: u64 = 11_163_402_240;
const EXPECTED_CAPTURES: &[(i32, i32)] = &[
    (0, 1),
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
    (1, 1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (1, 1),
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
    assert_eq!(
        FINDING_INPUT.len(),
        6,
        "the minimized finding remains exact"
    );
    common::fixtures::assert_input_sha256(
        FINDING_INPUT,
        "b9c2c014ed3f9ee4dccbc06af2f048d3399c9b9be27b9bb49d13ed00cc0dd51e",
    );
    assert!(EXPECTED_MATCH_METER_RAW > u64::from(u32::MAX));

    let (pattern, flags, subject, start) = common::fixtures::regexp_case(REGEXP_CASE);
    assert!(pattern.starts_with("(?:((\\1\\w*\\1){1,2}(\\3\\w*\\3){1,2}"));
    assert_eq!(flags, "");
    assert_eq!(subject, "0");
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
