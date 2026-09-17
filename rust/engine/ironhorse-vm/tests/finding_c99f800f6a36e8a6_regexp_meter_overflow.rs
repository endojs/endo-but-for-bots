//! Regression for ironhorse fuzz finding `c99f800f6a36e8a6`
//! (target `differential_regexp`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`).
//!
//! The 20-byte minimized input
//! (sha256 `60759a7390a6148500eb9d9e577d4bc2e8d263e69d0a00c904510db02e785335`)
//! folds, through `ironhorse_fuzz::gen_regexp`, into the nested
//! empty-matchable pattern
//!
//! ```text
//! ((a+a*|a+)a*){1,2}((a*|a*)?(?!a*[a-c0-9](a*)?|a*)|0){1,2}(a*|a*|[^a-c]*){1,2}
//! ```
//!
//! matched with the `s` flag against the subject `"aaaaaaaa"` at start
//! offset 0. The pattern never matches: its middle `{1,2}` group requires
//! either a literal `0` (absent from the subject) or the first alternative
//! `(a*|a*)?(?!…|a*)`, whose negative lookahead `(?!…|a*)` can never
//! succeed — the `a*` branch always matches the empty string, so the
//! negation always fails. V8/Node agree: `new RegExp(pattern,"s").exec("aaaaaaaa")`
//! is `null`. But the port explores `67862` metered backtracking steps
//! before failing, so the raw 16.16 match meter is
//! `67862 * 65536 = 4447404032`, which is **larger than `u32::MAX`**.
//!
//! The port's [`ironhorse_regexp`] matcher meters into a `u64` and holds
//! that full value. The XS differential oracle originally copied the pin's
//! (64-bit `meterIndex`) match meter into a 32-bit `txU4` field, wrapping
//! it to `4447404032 mod 2^32 = 152436736` and manufacturing a false "match
//! meter ironhorse=4447404032 pin=152436736" divergence in the
//! `differential_regexp` arm. This is the same root cause as findings
//! `5d122a6fc10babd9` / `8275793bca439f6e` / `407764ab1120ed1a` /
//! `637d760bc2e0278e` / `8b8afc47fcfb223d`; the oracle-side fix (widening
//! the meter fields to 64 bit, commit `c8497fd8`) was already landed on the
//! standing branch and merged to `llm`, and the port was always correct.
//! With the widened oracle the arm checks clean (verified:
//! `cargo +nightly-2026-08-15 fuzz run differential_regexp <input> -- -runs=1`
//! exits 0; the port and pin agree bit-for-bit on `matched`, every capture,
//! and the full-width meter `4447404032`).
//!
//! This test needs neither the XS oracle nor the `c/moddable` submodule:
//! it pins the port's own full-width meter and exact capture offsets for
//! the reproducing case, so it stands as the portable source-of-truth the
//! oracle must agree with, and guards the matcher against ever silently
//! narrowing the meter.

/// The pattern `ironhorse_fuzz::gen_regexp` produces from the finding's
/// 20 bytes. Reproduced here as a byte-exact raw-string literal so the
/// regression builds without the fuzz crate (which pulls in the oracle).
const PATTERN: &str =
    r###"((a+a*|a+)a*){1,2}((a*|a*)?(?!a*[a-c0-9](a*)?|a*)|0){1,2}(a*|a*|[^a-c]*){1,2}"###;

/// The generated case carries the `s` (dotAll) flag; the subject has no
/// line terminators so `s` does not change the answer, but the flag must
/// still be honored on compile for the meter to reproduce bit-exact.
const FLAGS: &str = "s";
const SUBJECT: &str = "aaaaaaaa";
const START: i32 = 0;

/// `67862 * XS_REGEXP_METERING (65536)` — the exact full-width raw match
/// meter, which exceeds `u32::MAX` and so must never be truncated.
const EXPECTED_MATCH_METER_RAW: u64 = 4447404032;

/// The exact `(from, to)` capture byte-offsets the port leaves on this
/// no-match, byte-for-byte identical to the XS pin's (both engines reset
/// captures per start-attempt but do not clear the last failed attempt's
/// partial state on overall failure — a shared, observable-value-irrelevant
/// detail, since a no-match returns `null` to JS). Pinned so the port's
/// backtracking trace stays locked to the pin's.
const EXPECTED_CAPTURES: &[(i32, i32)] = &[
    (-1, -1),
    (8, -1),
    (8, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
];

#[test]
fn regexp_match_meter_does_not_overflow_u32() {
    // Sanity: the reproducing meter really is past the 32-bit boundary, so
    // a narrowing bug here would actually change the value.
    assert!(EXPECTED_MATCH_METER_RAW > u64::from(u32::MAX));

    let program = ironhorse_regexp::compile(PATTERN, FLAGS).expect("pattern compiles");
    // No panic on this pathological nested empty-matchable pattern.
    let outcome = ironhorse_regexp::match_regexp(&program, SUBJECT.as_bytes(), START);

    // This case never matches; it is the *backtracking* that overflows u32.
    assert!(!outcome.matched, "the pattern does not match the subject");
    assert_eq!(
        outcome.captures, EXPECTED_CAPTURES,
        "capture offsets must stay bit-identical to the XS pin"
    );
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
