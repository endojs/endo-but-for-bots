//! Regression for ironhorse fuzz finding `12aca768c2e73c73`
//! (target `differential_regexp`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`).
//!
//! The exact 10-byte minimized input
//! (sha256 `bceeca5a518f6f60608f8c89d24091431806eebe454eacc00d453b8082d9ee5d`)
//! folds, through `ironhorse_fuzz::gen_regexp`, into a deeply nested
//! empty-matchable pattern matched with the `s` flag against `"0"` at offset
//! zero. Matching dispatches 104376 metered steps, so the raw 16.16 match
//! meter is `104376 * 65536 = 6840385536`, which exceeds `u32::MAX`.
//!
//! The port keeps that full value in a `u64`. At the finding SHA, the XS
//! differential oracle copied its own 64-bit meter into a 32-bit field and
//! wrapped it to `2545418240`, manufacturing a false divergence. The causal
//! oracle fix from finding `5d122a6fc10babd9` widened the meter fields to 64
//! bits; the port was always correct.
//!
//! This test replays the regexp case that `ironhorse_fuzz::gen_regexp`
//! generates from the exact input, pinned in
//! `fixtures/finding-12aca768c2e73c73.regexp-case.txt`, which
//! `ironhorse-fuzz/tests/vm_finding_fixtures.rs` regenerates from the input and
//! byte-compares; the test also asserts the input's cited sha256. It then runs
//! the pinned case through the pure-Rust regexp engine, so it builds without
//! the XS oracle or `c/moddable` submodule.

mod common;

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-12aca768c2e73c73.input.bin");
const REGEXP_CASE: &str = include_str!("fixtures/finding-12aca768c2e73c73.regexp-case.txt");
const EXPECTED_MATCH_METER_RAW: u64 = 6_840_385_536;

#[test]
fn exact_fuzz_input_preserves_the_full_width_match_meter() {
    assert_eq!(
        FINDING_INPUT.len(),
        10,
        "the minimized finding remains exact"
    );
    common::fixtures::assert_input_sha256(
        FINDING_INPUT,
        "bceeca5a518f6f60608f8c89d24091431806eebe454eacc00d453b8082d9ee5d",
    );
    assert!(EXPECTED_MATCH_METER_RAW > u64::from(u32::MAX));

    let (pattern, flags, subject, start) = common::fixtures::regexp_case(REGEXP_CASE);
    let program = ironhorse_regexp::compile(&pattern, &flags).expect("finding pattern compiles");
    let outcome = ironhorse_regexp::match_regexp(&program, subject.as_bytes(), start);

    assert!(
        !outcome.matched,
        "the exact finding pattern must remain a no-match"
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
