//! Regression for ironhorse fuzz finding `bf6cfbd74a7487fc`
//! (target `differential_regexp`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d1893` under fuzz).
//!
//! The 6-byte minimized input `47 2b 38 68 38 38`
//! (sha256 `7438aae1a9b4a8675efb11242949c17d753770526152b8864a7b228b0ac030b6`)
//! folds, through `ironhorse_fuzz::gen_regexp`, into an 822-byte nested
//! alternation of `b*bb*` runs, starred backreferences (`\1*`..`\19*`)
//! and `\n{2}0*\n{2}` sequences (see the `.pattern.txt` fixture), matched
//! with the `m` (multiline) flag against the one-character subject `"\n"`
//! at start offset 0. The backtracking search dispatches 22_238_862 metered
//! steps, so the raw 16.16 match meter is
//! `22_238_862 * 65536 = 1_457_446_060_032`, far larger than `u32::MAX`
//! (it wraps to `1_457_446_060_032 mod 2^32 = 1_452_146_688`).
//!
//! At `38ca1d1893` the XS differential oracle copied the pin's 64-bit
//! `meterIndex` into a 32-bit `txU4` field and reported the wrapped
//! figure, manufacturing a false "match meter ironhorse=1457446060032
//! pin=1452146688" divergence. The port's [`ironhorse_regexp`] matcher
//! always metered into a `u64`. This is the same root cause as findings
//! `f83dc8932cd3b41a` / `5565a021a8cc30bc` / `12aca768c2e73c73`; the
//! oracle-side fix (widening the meter fields to 64 bits, commit
//! `c8497fd88`) is on `llm`, where the finding no longer reproduces. The
//! port needed no change.
//!
//! This test needs neither the XS oracle nor the `c/moddable` submodule:
//! it pins the port's own full-width meter for the exact reproducing case
//! (the fuzz crate's `finding_bf6cfbd74a7487fc_*` test proves the fixture
//! pattern is what the recorded bytes generate, and that the pin agrees).

mod common;

/// The finding's minimized fuzzer input, kept beside the pattern it folds to.
const INPUT: &[u8] = include_bytes!("fixtures/finding-bf6cfbd74a7487fc.input.bin");

/// The pattern `ironhorse_fuzz::gen_regexp` produces from `INPUT`.
const PATTERN: &str = include_str!("fixtures/finding-bf6cfbd74a7487fc.pattern.txt");

const FLAGS: &str = "m";
const SUBJECT: &str = "\n";
const START: i32 = 0;

/// `22_238_862 * XS_REGEXP_METERING (65536)` — the exact full-width raw
/// match meter, which exceeds `u32::MAX` and so must never be truncated.
const EXPECTED_MATCH_METER_RAW: u64 = 1_457_446_060_032;

#[test]
fn regexp_match_meter_does_not_overflow_u32() {
    assert_eq!(INPUT, b"G+8h88");
    common::fixtures::assert_input_sha256(
        INPUT,
        "7438aae1a9b4a8675efb11242949c17d753770526152b8864a7b228b0ac030b6",
    );
    assert_eq!(PATTERN.len(), 822);
    // Sanity: the reproducing meter really is past the 32-bit boundary, so
    // a narrowing bug here would actually change the value.
    assert!(EXPECTED_MATCH_METER_RAW > u64::from(u32::MAX));

    let program = ironhorse_regexp::compile(PATTERN, FLAGS).expect("pattern compiles");
    let outcome = ironhorse_regexp::match_regexp(&program, SUBJECT.as_bytes(), START);

    assert_eq!(
        outcome.match_meter_raw, EXPECTED_MATCH_METER_RAW,
        "full-width match meter must be pinned bit-exact (no 32-bit wrap)"
    );
    assert_ne!(
        outcome.match_meter_raw,
        EXPECTED_MATCH_METER_RAW & u64::from(u32::MAX),
        "meter must not be the 32-bit-wrapped figure"
    );
}
