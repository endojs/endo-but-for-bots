//! Regression for Ironhorse fuzz finding `e2a75557f762cd9c`
//! (target `differential_regexp`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`).
//!
//! The exact 6-byte minimized input
//! (sha256 `85095187c6aeec9c687faa7157f09e51d8f91b247fde5a65bb1c84c1be31e512`)
//! folds through the maintained regexp generator into the adjacent 349-byte
//! nested-backreference pattern. Matching against a single space at offset
//! zero completes without a match after 84388 metered steps, for a raw 16.16
//! meter of `5_530_451_968`, which exceeds `u32::MAX`.
//!
//! At the finding SHA, the XS differential shim copied its 64-bit meter into
//! a 32-bit field and reported the wrapped value `1_235_484_672`. The existing
//! causal fix in `c8497fd88` widened the oracle fields to 64 bits; the port was
//! already correct. This test replays the regexp case that
//! `ironhorse_fuzz::gen_regexp` generates from the exact input, pinned in
//! `fixtures/finding-e2a75557f762cd9c.regexp-case.txt`, which
//! `ironhorse-fuzz/tests/vm_finding_fixtures.rs` regenerates from the input
//! and byte-compares; the test also asserts the input's cited sha256 and pins
//! the port's completion and full-width meter without depending on the
//! oracle or the `c/moddable` submodule.

mod common;

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-e2a75557f762cd9c.input.bin");
const REGEXP_CASE: &str = include_str!("fixtures/finding-e2a75557f762cd9c.regexp-case.txt");
const EXPECTED_PATTERN: &str = include_str!("fixtures/finding-e2a75557f762cd9c.pattern.txt");
const EXPECTED_MATCH_METER_RAW: u64 = 5_530_451_968;
const OLD_ORACLE_WRAPPED_METER: u64 = 1_235_484_672;
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
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (1, -1),
    (1, -1),
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
        "85095187c6aeec9c687faa7157f09e51d8f91b247fde5a65bb1c84c1be31e512",
    );
    assert!(EXPECTED_MATCH_METER_RAW > u64::from(u32::MAX));

    let (pattern, flags, subject, start) = common::fixtures::regexp_case(REGEXP_CASE);
    assert_eq!(pattern, EXPECTED_PATTERN);
    assert_eq!(flags, "");
    assert_eq!(subject, " ");
    assert_eq!(start, 0);

    let program = ironhorse_regexp::compile(&pattern, &flags).expect("finding pattern compiles");
    let outcome = ironhorse_regexp::match_regexp(&program, subject.as_bytes(), start);

    assert!(
        !outcome.matched,
        "the exact finding must remain a non-match"
    );
    assert!(!outcome.aborted, "matching must complete without aborting");
    assert!(
        !outcome.resource_limit,
        "matching must complete without a resource refusal"
    );
    assert_eq!(outcome.captures, EXPECTED_CAPTURES);
    assert_eq!(outcome.match_meter_raw, EXPECTED_MATCH_METER_RAW);
    assert_eq!(
        EXPECTED_MATCH_METER_RAW & u64::from(u32::MAX),
        OLD_ORACLE_WRAPPED_METER
    );
    assert_ne!(outcome.match_meter_raw, OLD_ORACLE_WRAPPED_METER);
}
