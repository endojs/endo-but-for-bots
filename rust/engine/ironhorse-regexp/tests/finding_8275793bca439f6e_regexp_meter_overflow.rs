//! Regression for ironhorse fuzz finding `8275793bca439f6e`
//! (target `differential_regexp`, toolchain `nightly-2026-08-15`).
//!
//! The 20-byte minimized input
//! (sha256 `15296cb07e6337df77cdd36ad89a34455d3d77a3576d8a5fc2f7f3019e3e7a1e`)
//! folds, through `ironhorse_fuzz::gen_regexp`, into a **backreference-heavy**
//! pathological pattern (nested empty-matchable `\1*`/`\3*` backrefs, lazy
//! `\1+?`/`\3*\3*\1+?` quantifiers, and `{2}` repeats) matched over the
//! subject `"0"` at start offset 0. The whole match is just the leading `.`
//! (`(0, 1)`), but reaching it dispatches 1_120_070 metered steps, so the
//! raw 16.16 match meter is `1_120_070 * 65536 = 73_404_907_520`, which is
//! **17x larger than `u32::MAX`**.
//!
//! This is the *same 32-bit-meter-truncation class* as findings
//! `493390fc03979205` and `5d122a6fc10babd9`, resolved on this branch by
//! widening the XS oracle's meter fields to 64 bit (`txU8`). The port's
//! [`ironhorse_regexp`] matcher always metered into a `u64` and held the
//! full value; the pre-fix oracle copied the pin's (64-bit `meterIndex`)
//! match meter into a 32-bit `txU4` field, wrapping `73_404_907_520 mod
//! 2^32 = 390_463_488` and manufacturing a false "match meter" divergence
//! in the `differential_regexp` arm. Under the widened oracle the port and
//! the XS pin agree bit-exact (1_120_070 metered steps, identical
//! per-opcode dispatch histogram); this finding only reproduces against the
//! base SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb` that predates that
//! fix. This case is a *distinct*, backreference-driven witness (the sibling
//! `5d122a6fc10babd9` case is an alternation-of-empty-stars pattern that
//! uses no backreferences), so it independently guards the full-width meter.
//!
//! This test needs neither the XS oracle nor the `c/moddable` submodule:
//! it pins the port's own full-width meter for the exact reproducing case,
//! so it stands as the portable source-of-truth the oracle must agree
//! with, and guards the matcher against ever silently narrowing the meter.

/// The pattern `ironhorse_fuzz::gen_regexp` produces from the finding's
/// 20 bytes (`ec cf 97 68 68 … 68 68 ff c6`). Reproduced here as a raw
/// literal (it contains `\1`/`\3`/`\B` escapes) so the regression builds
/// without the fuzz crate (which pulls in the oracle).
const PATTERN: &str = r".(?:(?:(?:0*0*0*)?b(\1*\1*\1*)|\1[a-c0-9]\1*)(?:(?:\1*\1*\1+?){2}.(?:\1*\1*\1*)|\1+?\B\1*)(?:(?:\1*\1*\1+?){2}.(?:\1*\1*\1*)|\1+?\B\1*)|(?:\1*\1*\1+?){2}.(?:\1*\1*\1*)|\1+?\B\1*)(?:(?:(?:\1*\1[a-c0-9])(?:\1*\1*\1*)(?:.+?\B\1*)|\1*\1*\1*)?\1((?:\1*\1*\1*)(?:.+?\B\1*)(?:\1*\1*\1*)?){2}){2}|(?:(?:\1*\1*\1*)?\1(\3*\3*\3*)|\3[a-c0-9]\3*)(?:(?:\3*\3*\1+?){2}.(?:\3*\3*\3*)|\1+?\B\3*)(?:(?:\3*\3*\1+?){2}.(?:\3*\3*\3*)|\1+?\B\3*)|(?:\3*\3*\1+?){2}.(?:\3*\3*\3*)|\1+?\B\3*";

const SUBJECT: &str = "0";
const START: i32 = 0;

/// `1_120_070 * XS_REGEXP_METERING (65536)` — the exact full-width raw
/// match meter, which exceeds `u32::MAX` and so must never be truncated.
const EXPECTED_MATCH_METER_RAW: u64 = 73_404_907_520;

#[test]
fn regexp_match_meter_does_not_overflow_u32() {
    // Sanity: the reproducing meter really is past the 32-bit boundary, so
    // a narrowing bug here would actually change the value.
    assert!(EXPECTED_MATCH_METER_RAW > u64::from(u32::MAX));

    let program = ironhorse_regexp::compile(PATTERN, "").expect("pattern compiles");
    // No panic on this pathological backreference-heavy pattern.
    let outcome = ironhorse_regexp::match_regexp(&program, SUBJECT.as_bytes(), START);

    assert!(outcome.matched, "the pattern matches at offset {START}");
    // The whole match is the single leading `.`; every capture group stays
    // unset (its backreferences all matched empty).
    assert_eq!(
        outcome.captures.first().copied(),
        Some((0, 1)),
        "whole match is the leading dot"
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
        "meter must not be the 32-bit-wrapped figure (390_463_488)"
    );
}
