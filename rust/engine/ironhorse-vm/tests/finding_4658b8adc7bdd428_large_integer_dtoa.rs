//! Regression for ironhorse fuzz finding `4658b8adc7bdd428`
//! (target `differential_source`, toolchain `nightly-2026-08-15`).
//!
//! The 7-byte minimized input `7e 69 2d ed 7e ed b4`
//! (sha256 `81ca826d13cee1bdf7d448ba16c41fae2d8079f4e94ec7c18510dfc21196945b`)
//! folds, through `ironhorse_fuzz::gen_program`, into the arithmetic program
//!
//! ```text
//! ((((377487360 - 1056964608) * (true && 377487360))
//!   * ((true && 377487360) && (1509949440 && true)))
//!  + (~((true * true) * (~1988100096))))
//! ```
//!
//! Evaluated in IEEE-754 doubles (ECMAScript Number semantics) the leading
//! product is `-679477248 * 377487360 = -256494072527585280`, the logical
//! group `((true && 377487360) && (1509949440 && true))` is `true` (coerced
//! to `1` by the surrounding `*`), and the tail `~((1*1) * ~1988100096)` is
//! `1988100096`. The sum is the *exactly* representable double whose real
//! value is `-256494070539485184`.
//!
//! ironhorse and XS compute the identical double. They diverged only in how
//! they render it to a string:
//!
//!   * XS's `fx_dtoa` printed the double's exact integer,
//!     `-256494070539485184` (18 significant digits).
//!   * ironhorse — like V8/SpiderMonkey and ECMA-262 §6.1.6.1.20's Number
//!     `toString` ("let `k` be as small as possible") — prints the *shortest*
//!     decimal that round-trips, `-256494070539485200` (17 significant
//!     digits).
//!
//! Both spellings parse back to the same double, so the port was never wrong;
//! the differential harness compares numeric completions by their double
//! rather than their decimal spelling (finding `d99d263fcf6ca7a7`). This is a
//! re-discovery of that dtoa-spelling class under a new minimized input.
//!
//! This test needs neither the XS oracle nor the `c/moddable` submodule: it
//! pins the port's own `number_to_ecma_string` for the reproducing value, the
//! portable source-of-truth the oracle's non-shortest rendering must not be
//! allowed to override.

use ironhorse_vm::value::number_to_ecma_string;

/// The exactly-representable double the finding program evaluates to.
const FINDING_VALUE: f64 = -256494070539485184.0;

/// The spec-shortest (V8-matching) rendering.
const SHORTEST: &str = "-256494070539485200";
/// XS's non-shortest exact-integer rendering of the same double.
const XS_EXACT: &str = "-256494070539485184";

#[test]
fn large_integer_result_renders_shortest_round_tripping_decimal() {
    // Reconstruct the value the way the program evaluates it, in f64 / ToInt32
    // arithmetic, so the test is tied to the finding and not just to a magic
    // literal.
    //
    // `(377487360 - 1056964608) * (true && 377487360)`: `true && x` yields `x`,
    // so this is `-679477248 * 377487360`.
    let left = (377487360.0_f64 - 1056964608.0) * 377487360.0;
    // `((true && 377487360) && (1509949440 && true))` evaluates to boolean
    // `true`, which ToNumber-coerces to `1` in the surrounding `*`.
    let big = left * 1.0;
    // `~((true * true) * (~1988100096))` is pure ToInt32 arithmetic:
    // `~1988100096 = -1988100097`, `1 * -1988100097 = -1988100097`, and
    // `~(-1988100097) = 1988100096`.
    let tail = !(1_i32.wrapping_mul(!1988100096_i32)) as f64;
    let value = big + tail;
    assert_eq!(
        value.to_bits(),
        FINDING_VALUE.to_bits(),
        "program value is -256494070539485184 (exact double)"
    );

    // The port renders the ECMA-262 shortest decimal, exactly as V8 does.
    assert_eq!(
        number_to_ecma_string(value),
        SHORTEST,
        "Number::toString must be the shortest round-tripping decimal, not XS's exact integer",
    );

    // Both spellings denote the identical double — that is *why* the harness
    // treats them as agreeing rather than diverging.
    assert_eq!(
        SHORTEST.parse::<f64>().unwrap().to_bits(),
        XS_EXACT.parse::<f64>().unwrap().to_bits(),
        "the shortest and XS-exact spellings are the same IEEE-754 double",
    );
    // The port must not emit XS's non-shortest form.
    assert_ne!(number_to_ecma_string(value), XS_EXACT);
}
