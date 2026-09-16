//! Regression for ironhorse fuzz finding `8b8afc47fcfb223d`
//! (target `differential_regexp`, toolchain `nightly-2026-08-15`).
//!
//! The 2-byte minimized input `80 c7`
//! (sha256 `cea5043725572fdb3e9ac49b92a2368b09dfbcea2ba2fe5d560f5d77a1246d95`)
//! folds, through `ironhorse_fuzz::gen_regexp`, into a deeply nested
//! `.*`-and-alternation pattern (nine copies of `(.*.*.*)(?:[a-c][a-c])(.*.*.*)`
//! wrapped in three groups), matched with the `i` flag against the subject
//! `"babababa"` at start offset 1. The pattern never matches, but the port
//! explores 66496 metered backtracking steps before failing, so the raw
//! 16.16 match meter is `66496 * 65536 = 4357881856`, which is **larger than
//! `u32::MAX`**.
//!
//! The port's [`ironhorse_regexp`] matcher meters into a `u64` and holds
//! that full value. The XS differential oracle originally copied the pin's
//! (64-bit `meterIndex`) match meter into a 32-bit `txU4` field, wrapping
//! it to `4357881856 mod 2^32 = 62914560` and manufacturing a false "match
//! meter ironhorse=4357881856 pin=62914560" divergence in the
//! `differential_regexp` arm. This is the same root cause as findings
//! `5d122a6fc10babd9` / `8275793bca439f6e` / `407764ab1120ed1a` /
//! `637d760bc2e0278e`; the oracle-side fix (widening the meter fields to
//! 64 bit, commit `c8497fd8`) was already landed on the standing branch,
//! and the port was always correct.
//!
//! This test needs neither the XS oracle nor the `c/moddable` submodule:
//! it pins the port's own full-width meter for the exact reproducing case,
//! so it stands as the portable source-of-truth the oracle must agree
//! with, and guards the matcher against ever silently narrowing the meter.

/// The pattern `ironhorse_fuzz::gen_regexp` produces from the finding's
/// 2 bytes (`80 c7`). Reproduced here as a byte-exact raw-string literal so
/// the regression builds without the fuzz crate (which pulls in the oracle).
const PATTERN: &str = r###"(((.*.*.*)(?:[a-c][a-c])(.*.*.*)|[a-c][a-c])((.*.*.*)(?:[a-c][a-c])(.*.*.*)|[a-c][a-c])((.*.*.*)(?:[a-c][a-c])(.*.*.*)|[a-c][a-c]))(((.*.*.*)(?:[a-c][a-c])(.*.*.*)|[a-c][a-c])((.*.*.*)(?:[a-c][a-c])(.*.*.*)|[a-c][a-c])((.*.*.*)(?:[a-c][a-c])(.*.*.*)|[a-c][a-c]))(((.*.*.*)(?:[a-c][a-c])(.*.*.*)|[a-c][a-c])((.*.*.*)(?:[a-c][a-c])(.*.*.*)|[a-c][a-c])((.*.*.*)(?:[a-c][a-c])(.*.*.*)|[a-c][a-c]))"###;

/// The generated case carries the `i` (ignore-case) flag; the subject is
/// all lowercase so case-folding does not change the answer, but the flag
/// must still be honored on compile for the meter to reproduce bit-exact.
const FLAGS: &str = "i";
const SUBJECT: &str = "babababa";
const START: i32 = 1;

/// `66496 * XS_REGEXP_METERING (65536)` — the exact full-width raw match
/// meter, which exceeds `u32::MAX` and so must never be truncated.
const EXPECTED_MATCH_METER_RAW: u64 = 4357881856;

#[test]
fn regexp_match_meter_does_not_overflow_u32() {
    // Sanity: the reproducing meter really is past the 32-bit boundary, so
    // a narrowing bug here would actually change the value.
    assert!(EXPECTED_MATCH_METER_RAW > u64::from(u32::MAX));

    let program = ironhorse_regexp::compile(PATTERN, FLAGS).expect("pattern compiles");
    // No panic on this pathological nested `.*`-alternation pattern.
    let outcome = ironhorse_regexp::match_regexp(&program, SUBJECT.as_bytes(), START);

    // This case never matches; it is the *backtracking* that overflows u32.
    assert!(!outcome.matched, "the pattern does not match the subject");
    assert_eq!(
        outcome.match_meter_raw, EXPECTED_MATCH_METER_RAW,
        "full-width match meter must be pinned bit-exact (no 32-bit wrap)"
    );
    // The wrapped value the truncating oracle used to report; the port must
    // never coincidentally produce it.
    assert_ne!(
        outcome.match_meter_raw,
        EXPECTED_MATCH_METER_RAW & u64::from(u32::MAX),
        "meter must not be the 32-bit-wrapped figure"
    );
}
