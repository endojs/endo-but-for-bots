//! Regression for ironhorse fuzz finding `13b68e2edb67861a`
//! (target `differential_regexp`, toolchain `nightly-2026-08-15`).
//!
//! The 12-byte minimized input `3b 2b bc bc bc bc bc bc bc bc bc bc`
//! (sha256 `e0c61bad393fb669bbe423fe93e96d90353b9a9a374824d89c0dc9753540188b`,
//! fixture `fixtures/finding-13b68e2edb67861a.input.bin`) folds, through
//! `ironhorse_fuzz::gen_regexp`, into a backreference-heavy nested
//! alternation (`\1{1,3}`, `\1{2}`, `\3{1,3}`, `\4{2}` runs interleaved
//! with `\n{1,3}`, `.{2}` and ` {1,3}`) with flag `i`, matched against the
//! subject `"\n\n\n0 "` at start offset `2`.
//!
//! It matches `"\n0 "` at `(2, 5)` with every capture group unset; V8/Node
//! agree (`/.../gi` with `lastIndex = 2` finds index 2, length 3, groups
//! `null`). But the empty-backreference quantifiers drive the port through
//! `91920681` metered backtracking steps first, so the raw 16.16 match
//! meter is `91920681 * 65536 = 6024113750016`, far **larger than
//! `u32::MAX`**.
//!
//! The port's [`ironhorse_regexp`] matcher meters into a `u64` and holds
//! that full value. The XS differential oracle at the fuzzed base
//! (`38ca1d18`, `match_meter_raw: u32`) wrapped the pin's meter to
//! `6024113750016 mod 2^32 = 2569601024`, manufacturing a false "match
//! meter" divergence. This is the same root cause as findings
//! `5d122a6fc10babd9` / `407764ab1120ed1a` / `8275793bca439f6e` /
//! `8b8afc47fcfb223d` / `c99f800f6a36e8a6` / `a172d6aba922c9ad` /
//! `1dc231089278c110`; the oracle-side fix (meter fields widened to 64
//! bits, commit `c8497fd8`) is on `llm`, and the port was always correct.
//! With the widened oracle the arm checks clean
//! (verified: `cargo +nightly-2026-08-15 fuzz run differential_regexp
//! <input> -- -runs=1` exits 0; port and pin agree bit-for-bit on
//! `matched`, all five capture slots, and the full-width meter).
//!
//! This test needs neither the XS oracle nor the `c/moddable` submodule:
//! it pins the port's own full-width meter and capture offsets for the
//! reproducing case, and guards the matcher against ever silently
//! narrowing the meter.

/// The pattern `ironhorse_fuzz::gen_regexp` produces from the finding's
/// 12 bytes, as a byte-exact raw-string literal (`\n` here is the two-char
/// regexp escape, not a newline) so the regression builds without the
/// fuzz crate (which pulls in the oracle).
const PATTERN: &str = r#"((?:(?:\1{1,3}\1{2}\n{1,3})(?:\1{1,3}\1{2}\n{1,3})(?:\1{1,3}\1{2}\n{1,3})|\1{1,3}\1{2}\n{1,3})(?:(?:\1{1,3}.{2}\1{1,3})(?:\1{1,3}\1{2}\1{1,3})(?:\1{1,3}\1{2}\1{1,3})|\1{1,3}\1{2}\1{1,3})(?:(?:\1{2}\n{1,3}\1{1,3})(?:\1{2}\n{1,3}\1{1,3})(?:\1{2}\n{1,3}\1{1,3})|\1{2}\n{1,3}\1{1,3})|(?:.{2}\1{1,3}\1{1,3})(?:\1{2}\1{1,3}\1{1,3})(?:\1{2}\1{1,3}\1{1,3})|\1{2}\1{1,3}\1{1,3})(?:(?:(\1{1,3}\1{1,3}\1{1,3})(\3{1,3}\3{1,3}\3{1,3})(\1{1,3}\1{1,3}\1{1,3}))(?:(?:\1{1,3}\1{2}\n{1,3})(?:\1{1,3}\1{2}\n{1,3})(?:\1{1,3}\1{2}\n{1,3})|\1{1,3}\1{2}\n{1,3})(?:(?:\1{1,3}.{2}\1{1,3})(?:\1{1,3}\4{2}\1{1,3})(?:\1{1,3}\4{2}\1{1,3})|\1{1,3}\4{2}\1{1,3})|(?:\1{2}\n{1,3}\1{1,3})(?:\1{2}\n{1,3}\1{1,3})(?:\1{2}\n{1,3}\1{1,3})|\1{2}\n{1,3}\1{1,3})(?:(?: {1,3}(?:\1{1,3}\1{1,3}\4{2})(?:\1{1,3}\1{1,3}\4{2})|\1{1,3}\1{1,3}\4{2})(?:(?:\1{1,3}\1{2}\n{1,3})(?:\1{1,3}\1{2}\n{1,3})(?:\1{1,3}\1{2}\n{1,3})|\1{1,3}\1{2}\n{1,3})(?:(?:\1{1,3}.{2}\1{1,3})(?:\1{1,3}\4{2}\1{1,3})(?:\1{1,3}\4{2}\1{1,3})|\1{1,3}\4{2}\1{1,3})|(?:\1{2}\n{1,3}\1{1,3})(?:\1{2}\n{1,3}\1{1,3})(?:\1{2}\n{1,3}\1{1,3})|\1{2}\n{1,3}\1{1,3})|(?: {1,3}(?:\1{1,3}\1{1,3}\4{2})(?:\1{1,3}\1{1,3}\4{2})|\1{1,3}\1{1,3}\4{2})(?:(?:\1{1,3}\1{2}\n{1,3})(?:\1{1,3}\1{2}\n{1,3})(?:\1{1,3}\1{2}\n{1,3})|\1{1,3}\1{2}\n{1,3})(?:(?:\1{1,3}.{2}\1{1,3})(?:\1{1,3}\4{2}\1{1,3})(?:\1{1,3}\4{2}\1{1,3})|\1{1,3}\4{2}\1{1,3})|(?:\1{2}\n{1,3}\1{1,3})(?:\1{2}\n{1,3}\1{1,3})(?:\1{2}\n{1,3}\1{1,3})|\1{2}\n{1,3}\1{1,3}"#;

const FLAGS: &str = "i";
/// Real newlines in the subject.
const SUBJECT: &str = "\n\n\n0 ";
const START: i32 = 2;

/// `91920681 * XS_REGEXP_METERING (65536)` — the exact full-width raw
/// match meter, which exceeds `u32::MAX` and so must never be truncated.
const EXPECTED_MATCH_METER_RAW: u64 = 6024113750016;

/// The whole match `"\n0 "` at `(2, 5)` and four unset groups, identical to
/// the XS pin's and to V8's.
const EXPECTED_CAPTURES: &[(i32, i32)] = &[(2, 5), (-1, -1), (-1, -1), (-1, -1), (-1, -1)];

#[test]
fn regexp_match_meter_does_not_overflow_u32() {
    // Sanity: the reproducing meter really is past the 32-bit boundary, so
    // a narrowing bug here would actually change the value.
    assert!(EXPECTED_MATCH_METER_RAW > u64::from(u32::MAX));

    let program = ironhorse_regexp::compile(PATTERN, FLAGS).expect("pattern compiles");
    let outcome = ironhorse_regexp::match_regexp(&program, SUBJECT.as_bytes(), START);

    assert!(outcome.matched, "the pattern matches \"\\n0 \"");
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
