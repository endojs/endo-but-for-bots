//! Regression for ironhorse fuzz finding `f83dc8932cd3b41a`
//! (target `differential_regexp`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d1893` under fuzz).
//!
//! The 44-byte minimized input
//! (sha256 `146b8f4431372cd73256cc4302c068589239f8950a29c52c89886074c33ad26c`)
//! folds, through `ironhorse_fuzz::gen_regexp`, into a deeply nested
//! backreference-and-quantifier pattern (see `PATTERN` below), matched with
//! the `s` (dotAll) flag against the subject `"a0aaaaaa"` at start offset 0.
//! The pattern never matches, but the port explores 168576 metered
//! backtracking steps before failing, so the raw 16.16 match meter is
//! `168576 * 65536 = 11047796736`, which is **larger than `u32::MAX`** (it
//! wraps to `11047796736 mod 2^32 = 2457862144`).
//!
//! The port's [`ironhorse_regexp`] matcher meters into a `u64` and holds
//! that full value. The XS differential oracle originally copied the pin's
//! (64-bit `meterIndex`) match meter into a 32-bit `txU4` field, wrapping
//! it and manufacturing a false "match meter ironhorse=11047796736
//! pin=2457862144" divergence in the `differential_regexp` arm. This is the
//! same root cause as findings `5d122a6fc10babd9` / `8275793bca439f6e` /
//! `407764ab1120ed1a` / `637d760bc2e0278e` / `8b8afc47fcfb223d`; the
//! oracle-side fix (widening the meter fields to 64 bit, commit
//! `c8497fd88`) was already landed on the standing branch — it is an
//! ancestor of this branch's HEAD but is *not* in the `38ca1d1893` SHA the
//! finding was recorded against — and the port was always correct.
//!
//! This test needs neither the XS oracle nor the `c/moddable` submodule:
//! it pins the port's own full-width meter for the exact reproducing case,
//! so it stands as the portable source-of-truth the oracle must agree
//! with, and guards the matcher against ever silently narrowing the meter.

/// The pattern `ironhorse_fuzz::gen_regexp` produces from the finding's
/// 44 bytes. Reproduced here as a byte-exact raw-string literal so the
/// regression builds without the fuzz crate (which pulls in the oracle).
const PATTERN: &str = r###"(((a*){1,2}.{2})?a*|(?:bab*)){1,2}(((a0a){1,2}a*|\6*?a*)?b*|\2(b*[^a-c0-9]){1,2}){1,2}(((.a){1,2}a*|\8*?a*)?b*(?:\8(b*[^a-c0-9]){1,2}){1,2})"###;

/// The generated case carries the `s` (dotAll) flag.
const FLAGS: &str = "s";
const SUBJECT: &str = "a0aaaaaa";
const START: i32 = 0;

/// `168576 * XS_REGEXP_METERING (65536)` — the exact full-width raw match
/// meter, which exceeds `u32::MAX` and so must never be truncated.
const EXPECTED_MATCH_METER_RAW: u64 = 11047796736;

#[test]
fn regexp_match_meter_does_not_overflow_u32() {
    // Sanity: the reproducing meter really is past the 32-bit boundary, so
    // a narrowing bug here would actually change the value.
    assert!(EXPECTED_MATCH_METER_RAW > u64::from(u32::MAX));

    let program = ironhorse_regexp::compile(PATTERN, FLAGS).expect("pattern compiles");
    // No panic on this pathological nested backreference pattern.
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
