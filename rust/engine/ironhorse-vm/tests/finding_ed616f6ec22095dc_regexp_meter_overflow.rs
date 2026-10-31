//! Regression for ironhorse fuzz finding `ed616f6ec22095dc`
//! (target `differential_regexp`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`).
//!
//! The exact 18-byte minimized input
//! (sha256 `e15239bbb919b284ba91a83037f73cd30935a195fb38574f310c9647a6ecde10`)
//! folds, through `ironhorse_fuzz::gen_regexp`, into a nested `a*`/`a?`/`{1,2}`
//! capture-group pattern matched with the `s` flag against `"aaaaaaaa"` at
//! offset zero. Matching dispatches 240323 metered steps, so the raw 16.16
//! match meter is `240323 * 65536 = 15749808128`, which exceeds `u32::MAX`.
//!
//! The port keeps that full value in a `u64`. At the finding SHA, the XS
//! differential oracle copied its own 64-bit meter into a 32-bit field and
//! wrapped it to `2864906240`, manufacturing a false divergence. The causal
//! oracle fix from finding `5d122a6fc10babd9` widened the meter fields to 64
//! bits; the port was always correct.
//!
//! This test replays the regexp case that `ironhorse_fuzz::gen_regexp`
//! generates from the exact input, pinned in
//! `fixtures/finding-ed616f6ec22095dc.regexp-case.txt`, which
//! `ironhorse-fuzz/tests/vm_finding_fixtures.rs` regenerates from the input and
//! byte-compares; the test also asserts the input's cited sha256. It then runs
//! the pinned case through the pure-Rust regexp engine, so it builds without
//! the XS oracle or `c/moddable` submodule.

mod common;

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-ed616f6ec22095dc.input.bin");
const REGEXP_CASE: &str = include_str!("fixtures/finding-ed616f6ec22095dc.regexp-case.txt");
const EXPECTED_MATCH_METER_RAW: u64 = 15_749_808_128;
const OLD_ORACLE_WRAPPED_METER: u64 = 2_864_906_240;

#[test]
fn exact_fuzz_input_preserves_the_full_width_match_meter() {
    assert_eq!(
        FINDING_INPUT.len(),
        18,
        "the minimized finding remains exact"
    );
    common::fixtures::assert_input_sha256(
        FINDING_INPUT,
        "e15239bbb919b284ba91a83037f73cd30935a195fb38574f310c9647a6ecde10",
    );
    assert!(EXPECTED_MATCH_METER_RAW > u64::from(u32::MAX));

    let (pattern, flags, subject, start) = common::fixtures::regexp_case(REGEXP_CASE);
    assert_eq!(flags, "s");
    assert_eq!(subject, "aaaaaaaa");
    assert_eq!(start, 0);

    let program = ironhorse_regexp::compile(&pattern, &flags).expect("finding pattern compiles");
    let outcome = ironhorse_regexp::match_regexp(&program, subject.as_bytes(), start);

    assert!(
        !outcome.matched,
        "the exact finding pattern must remain a no-match"
    );
    assert!(!outcome.aborted, "matching must complete without aborting");
    assert!(
        !outcome.resource_limit,
        "matching must complete without a resource refusal"
    );
    assert_eq!(
        outcome.match_meter_raw, EXPECTED_MATCH_METER_RAW,
        "the exact finding must retain its full-width meter"
    );
    assert_eq!(
        EXPECTED_MATCH_METER_RAW & u64::from(u32::MAX),
        OLD_ORACLE_WRAPPED_METER
    );
    assert_ne!(
        outcome.match_meter_raw, OLD_ORACLE_WRAPPED_METER,
        "the meter must not wrap to the old oracle's 32-bit value"
    );
}
