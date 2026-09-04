//! Regression for ironhorse fuzz finding `5c29667cc15d6d93`
//! (target `differential_source`, toolchain `nightly-2026-08-15`).
//!
//! The 5-byte minimized input `e1 1b dc dc dc`
//! (sha256 `203db557fe4893accc7f29b36e0fc723551a7494f0c33a65e809ec88045449e2`)
//! folds, through `ironhorse_fuzz::gen_program`, into the arithmetic program
//!
//! ```text
//! ((-(-(-226492416))) * (-(-(-226492416))))
//! ```
//!
//! The literal `226492416` is `27 * 2^23` (the generator's "larger integer"
//! atom, `byte << 23` with `byte = 27`). The triple unary minus is just `-x`,
//! so the program is `(-226492416) * (-226492416) = 226492416^2`. Evaluated in
//! IEEE-754 doubles (ECMAScript Number semantics) this is
//! `(27 * 2^23)^2 = 27^2 * 2^46 = 729 * 2^46`, the *exactly* representable
//! double whose real value is `51298814505517056`.
//!
//! ironhorse and XS compute the identical double. They diverged only in how
//! they render it to a string (verified against the pinned XS oracle:
//! oracle result `51298814505517056`, ironhorse result `51298814505517060`):
//!
//!   * XS's `fx_dtoa` printed the double's exact integer, `51298814505517056`
//!     (17 significant digits).
//!   * ironhorse — like V8/SpiderMonkey and ECMA-262 §6.1.6.1.20's Number
//!     `toString` ("let `k` be as small as possible") — prints the *shortest*
//!     decimal that round-trips, `51298814505517060` (17 significant digits,
//!     the last a trailing zero) — the identical spelling Node/V8 emit.
//!
//! Both spellings parse back to the same double, so the port was never wrong.
//! This is the same class as finding `d99d263fcf6ca7a7`: the differential
//! harness now compares numeric completions by their double rather than their
//! decimal spelling (`results_agree`), which already suppresses this divergence
//! on the standing branch. No port or harness change is required for this
//! specific input; this test pins the *reproducing value's* rendering so the
//! port can never be "corrected" to XS's non-conformant exact-integer form.
//!
//! It needs neither the XS oracle nor the `c/moddable` submodule: it pins the
//! port's own `number_to_ecma_string` for the reproducing value, the portable
//! source-of-truth the oracle's non-shortest rendering must not override.

use ironhorse_vm::value::number_to_ecma_string;

/// `729 * 2^46`, the exactly-representable double the finding program
/// evaluates to.
const FINDING_VALUE: f64 = 51298814505517056.0;

/// The spec-shortest (V8/Node-matching) rendering.
const SHORTEST: &str = "51298814505517060";
/// XS's non-shortest exact-integer rendering of the same double.
const XS_EXACT: &str = "51298814505517056";

#[test]
fn large_integer_result_renders_shortest_round_tripping_decimal() {
    // Reconstruct the value the way the program does, in f64, so the test is
    // tied to the finding and not just to a magic literal. The generator's
    // atom is `27 << 23`; the triple unary minus collapses to a single negate.
    let a: f64 = (27_i64 << 23) as f64; // 226492416
    let value = (-(-(-a))) * (-(-(-a)));
    assert_eq!(value.to_bits(), FINDING_VALUE.to_bits(), "program value is 729*2^46");

    // The port renders the ECMA-262 shortest decimal, exactly as V8/Node does.
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
