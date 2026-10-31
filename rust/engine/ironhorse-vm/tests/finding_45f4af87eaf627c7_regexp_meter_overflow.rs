//! Regression for ironhorse fuzz finding `45f4af87eaf627c7`
//! (target `differential_regexp`, toolchain `nightly-2026-08-15`).
//!
//! The 3-byte minimized input `50 bc 5b`
//! (sha256 `4999211e387d6bd25b5e5abdaf5cf4210531e28c7e80abf9771d01593200300a`,
//! fixture `fixtures/finding-45f4af87eaf627c7.input.bin`) folds, through
//! `ironhorse_fuzz::gen_regexp`, into a three-way alternation of optional
//! groups of starred backreferences (`\1*`, `\2*`, `\4*`, `\8*`, `\12*`,
//! ..., 24 capture groups) interleaved with `\n{1,3}` repetitions, no flags,
//! matched against the subject `"a\n\na\n"` at start offset `1`.
//!
//! It matches the empty string at `(1, 1)` with every capture group unset;
//! V8/Node agree (`/.../g` with `lastIndex = 1` finds index 1, length 0, all
//! groups `undefined`). But the empty-backreference stars drive the port
//! through `82118` metered backtracking steps first, so the raw 16.16 match
//! meter is `82118 * 65536 = 5381685248`, **larger than `u32::MAX`**.
//!
//! The port's [`ironhorse_regexp`] matcher meters into a `u64` and holds
//! that full value. The XS differential oracle at the fuzzed base
//! (`38ca1d18`, `match_meter_raw: u32`) wrapped the pin's meter to
//! `5381685248 mod 2^32 = 1086717952` — reproduced at `38ca1d18` as
//! `match meter ironhorse=5381685248 pin=1086717952` — manufacturing a false
//! divergence. Same root cause as findings `13b68e2edb67861a` /
//! `1dc231089278c110` / `a172d6aba922c9ad` / `c99f800f6a36e8a6` et al.; the
//! oracle-side fix (meter fields widened to 64 bits, commit `c8497fd8`) is
//! on `llm`, and the port was always correct. With the widened oracle the
//! arm checks clean.
//!
//! This test needs neither the XS oracle nor the `c/moddable` submodule:
//! it pins the port's own full-width meter and capture offsets for the
//! reproducing case, and guards the matcher against ever silently
//! narrowing the meter.

/// The pattern `ironhorse_fuzz::gen_regexp` produces from the finding's
/// 3 bytes, as a byte-exact raw-string literal (`\n` here is the two-char
/// regexp escape, not a newline) so the regression builds without the
/// fuzz crate (which pulls in the oracle).
const PATTERN: &str = r#"(?:(?:(\1*\1*\1*)(\2*\2*\2*)(\2*\2*\2*))?(?:(?:\n{1,3}\n{1,3}\n{1,3}){2}(?:\n{1,3}\n{1,3}\n{1,3}){2}|\n{1,3}\n{1,3}\n{1,3}){2}|(\4*\4*\4*)(\2*\2*\2*)(\2*\2*\2*))?(?:(?:(\1*\1*\1*)(\4*\4*\4*)(\2*\2*\2*))?(?:(?:\n{1,3}\n{1,3}\n{1,3}){2}(?:\n{1,3}\n{1,3}\n{1,3}){2}|\n{1,3}\n{1,3}\n{1,3}){2}|(\2*\2*\2*)(\4*\4*\4*)(\8*\8*\8*))?(?:(?:(\1*\1*\1*)(\8*\8*\8*)(\2*\2*\2*))?(?:(?:\n{1,3}\n{1,3}\n{1,3}){2}(?:\n{1,3}\n{1,3}\n{1,3}){2}|\n{1,3}\n{1,3}\n{1,3}){2}|(\12*\12*\12*)(\7*\7*\7*)(\2*\2*\2*))?|(?:(\16*\16*\16*)(\12*\12*\12*)(\8*\8*\8*))?(?:(?:\n{1,3}\n{1,3}\n{1,3}){2}(?:\n{1,3}\n{1,3}\n{1,3}){2}|\n{1,3}\n{1,3}\n{1,3}){2}|(\4*\4*\4*)(\23*\23*\23*)(\20*\20*\20*)"#;

const FLAGS: &str = "";
/// Real newlines in the subject.
const SUBJECT: &str = "a\n\na\n";
const START: i32 = 1;

/// `82118 * XS_REGEXP_METERING (65536)` — the exact full-width raw match
/// meter, which exceeds `u32::MAX` and so must never be truncated.
const EXPECTED_MATCH_METER_RAW: u64 = 5381685248;

/// The empty whole match at `(1, 1)` and 24 unset groups, identical to the
/// XS pin's and to V8's.
const EXPECTED_CAPTURES: &[(i32, i32)] = &[
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
fn regexp_match_meter_does_not_overflow_u32() {
    // Sanity: the reproducing meter really is past the 32-bit boundary, so
    // a narrowing bug here would actually change the value.
    assert!(EXPECTED_MATCH_METER_RAW > u64::from(u32::MAX));

    let program = ironhorse_regexp::compile(PATTERN, FLAGS).expect("pattern compiles");
    let outcome = ironhorse_regexp::match_regexp(&program, SUBJECT.as_bytes(), START);

    assert!(outcome.matched, "the pattern matches empty at 1");
    assert_eq!(
        outcome.captures, EXPECTED_CAPTURES,
        "capture offsets must stay bit-identical to the XS pin"
    );
    assert_eq!(
        outcome.match_meter_raw, EXPECTED_MATCH_METER_RAW,
        "full-width match meter must be pinned bit-exact (no 32-bit wrap)"
    );
    // The wrapped value the truncating oracle reported at the fuzzed base.
    assert_ne!(
        outcome.match_meter_raw,
        EXPECTED_MATCH_METER_RAW & u64::from(u32::MAX),
        "meter must not be the 32-bit-wrapped figure"
    );
}
