//! Regression for ironhorse fuzz finding `407764ab1120ed1a`
//! (target `differential_regexp`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`).
//!
//! The 3-byte minimized input
//! (sha256 `233ee70cc76db030ee8cbd0ae4edd4352ce82cc30faafe8085261d9ffe42c131`,
//! bytes `14 7f 5c`) folds, through `ironhorse_fuzz::gen_regexp`, into a
//! deeply nested, **backreference-heavy** pattern (capturing groups plus
//! `\2`, `\4`, `\8`, `\11`, … references to optional/unset groups) with
//! the `s` (dotAll) flag, matched against `"abbab"` at start offset 1.
//! Matching it dispatches 330041 metered steps, so the raw 16.16 match
//! meter is `330041 * 65536 = 21_629_566_976` — **larger than
//! `u32::MAX`**.
//!
//! This is the same harness-side class as finding `5d122a6fc10babd9`: the
//! port meters into a `u64` and holds the full value, while the XS
//! differential oracle originally copied the pin's (64-bit `meterIndex`)
//! match meter into a 32-bit `txU4` field, wrapping it to
//! `21_629_566_976 mod 2^32 = 154_730_496` and manufacturing a phantom
//! "match meter" divergence in the `differential_regexp` arm. That
//! oracle-side truncation was already fixed (widening the regexp meter
//! fields to 64 bit end to end); the continuous fuzzer re-surfaced the
//! same class because it fuzzes the `llm` base branch, which predates the
//! fix. This case is distinct from `5d122a6fc10babd9` in shape — that one
//! used only non-capturing groups; this one is dominated by quantified
//! backreferences to unset captures — so it independently guards the
//! backreference dispatch path against a silently narrowed meter.
//!
//! Like the sibling regression, this test needs neither the XS oracle nor
//! the `c/moddable` submodule: it pins the port's own full-width meter for
//! the exact reproducing case, standing as the portable source of truth
//! the oracle must agree with.

/// The pattern `ironhorse_fuzz::gen_regexp` produces from the finding's
/// 3 bytes (`14 7f 5c`). Reproduced here as a raw-string literal so the
/// regression builds without the fuzz crate (which pulls in the oracle).
const PATTERN: &str = r"((?:(?:b{1,3}b{1,3}b{1,3}){1,2}(?:b{1,3}b{1,3}b{1,3}){1,2}|b{1,3}b{1,3}b{1,3}){1,2}(?:(\2{1,3}\2{1,3}\2{1,3})?(\2{1,3}\2{1,3}\2{1,3})?(\4{1,3}\4{1,3}\4{1,3})?){1,2}(?:(?:b{1,3}b{1,3}b{1,3}){1,2}(?:b{1,3}b{1,3}b{1,3}){1,2}|b{1,3}b{1,3}b{1,3}){1,2}|(\3{1,3}\3{1,3}\3{1,3})?(\2{1,3}\2{1,3}\2{1,3})?(\2{1,3}\2{1,3}\2{1,3})?){1,2}(?:(?:(\8{1,3}\8{1,3}\8{1,3})?(\2{1,3}\2{1,3}\2{1,3})?(\8{1,3}\8{1,3}\8{1,3})?){1,2}(?:(?:b{1,3}b{1,3}b{1,3}){1,2}(?:b{1,3}b{1,3}b{1,3}){1,2}|b{1,3}b{1,3}b{1,3}){1,2}|(\7{1,3}\7{1,3}\7{1,3})?(\8{1,3}\8{1,3}\8{1,3})?(\11{1,3}\11{1,3}\11{1,3})?){1,2}(?:(?:(\2{1,3}\2{1,3}\2{1,3})?(\8{1,3}\8{1,3}\8{1,3})?(\16{1,3}\16{1,3}\16{1,3})?){1,2}(?:(?:b{1,3}b{1,3}b{1,3}){1,2}(?:b{1,3}b{1,3}b{1,3}){1,2}|b{1,3}b{1,3}b{1,3}){1,2}|(\9{1,3}\9{1,3}\9{1,3})?(\2{1,3}\2{1,3}\2{1,3})?(\14{1,3}\14{1,3}\14{1,3})?){1,2}|(?:(\8{1,3}\8{1,3}\8{1,3})?(\2{1,3}\2{1,3}\2{1,3})?(\18{1,3}\18{1,3}\18{1,3})?){1,2}(?:(?:b{1,3}b{1,3}b{1,3}){1,2}(?:b{1,3}b{1,3}b{1,3}){1,2}|b{1,3}b{1,3}b{1,3}){1,2}|(\13{1,3}\13{1,3}\13{1,3})?(\8{1,3}\8{1,3}\8{1,3})?(\3{1,3}\3{1,3}\3{1,3})?";

const FLAGS: &str = "s";
const SUBJECT: &str = "abbab";
const START: i32 = 1;

/// `330041 * XS_REGEXP_METERING (65536)` — the exact full-width raw match
/// meter, which exceeds `u32::MAX` and so must never be truncated.
const EXPECTED_MATCH_METER_RAW: u64 = 21_629_566_976;

#[test]
fn regexp_match_meter_does_not_overflow_u32() {
    // Sanity: the reproducing meter really is past the 32-bit boundary, so
    // a narrowing bug here would actually change the value.
    assert!(EXPECTED_MATCH_METER_RAW > u64::from(u32::MAX));

    let program = ironhorse_regexp::compile(PATTERN, FLAGS).expect("pattern compiles");
    // No panic on this pathological, backreference-heavy pattern.
    let outcome = ironhorse_regexp::match_regexp(&program, SUBJECT.as_bytes(), START);

    assert!(outcome.matched, "the pattern matches (empty) at offset {START}");
    assert_eq!(
        outcome.match_meter_raw, EXPECTED_MATCH_METER_RAW,
        "full-width match meter must be pinned bit-exact (no 32-bit wrap)"
    );
}
