//! Regression for ironhorse fuzz finding `284de587e16bce32`
//! (target `differential_source`, toolchain `nightly-2026-08-15`).
//!
//! The 9-byte minimized input `00 fc 00 01 b1 5d 00 00 00`
//! (sha256 `05b1ea60cf0ed92291daeb24a160652baaa07e231d88d84f48548d261b517c33`)
//! folds, through `ironhorse_fuzz::gen_program`, into the arithmetic program
//!
//! ```text
//! (((~(true && true)) - ((780140544 - true) * (true + true)))
//!  * ((~(true && true)) - ((780140544 - true) * (true + true))))
//! ```
//!
//! In IEEE-754 doubles (ECMAScript Number semantics) the inner subexpression
//! is `-2 - (780140543 * 2) = -1560281088`, and the whole program squares it:
//! `1560281088^2`. The literal `780140544` is `93 * 2^23`, so
//! `1560281088 = 780140544 - 1 = ...` — more usefully, the *result*
//! `1560281088^2 = (186 * 2^23)^2 = 186^2 * 2^46 = 8649 * 2^48`. Since
//! `8649 < 2^14`, that is the *exactly* representable double whose real value
//! is `2434477073570463744`.
//!
//! ironhorse and XS compute the identical double. They diverged only in how
//! they render it to a string (the same oracle-rendering class as findings
//! `d99d263fcf6ca7a7`, `5c29667cc15d6d93`, `7289e31013d074ec`, and
//! `783be6e6106bad98`):
//!
//!   * XS's `fx_dtoa` prints the double's exact integer,
//!     `2434477073570463744` (19 significant digits).
//!   * ironhorse — like V8/SpiderMonkey and ECMA-262 §6.1.6.1.20's Number
//!     `toString` ("let `k` be as small as possible") — prints the *shortest*
//!     decimal that round-trips, `2434477073570464000` — the identical
//!     spelling Node/V8 emit.
//!
//! Both spellings parse back to the same double, so the port was never wrong.
//! The differential harness compares numeric completions by their double
//! rather than their decimal spelling (`results_agree`), which already
//! suppresses this divergence on the standing branch. No port or harness
//! change is required for this specific input; this test pins the
//! *reproducing value's* rendering so the port can never be "corrected" to
//! XS's non-conformant exact-integer form.
//!
//! It needs neither the XS oracle nor the `c/moddable` submodule: it pins the
//! port's own `number_to_ecma_string` for the reproducing value, the portable
//! source-of-truth the oracle's non-shortest rendering must not override.

use ironhorse_vm::value::number_to_ecma_string;

/// `8649 * 2^48`, the exactly-representable double the finding program
/// evaluates to.
const FINDING_VALUE: f64 = 2434477073570463744.0;

/// The spec-shortest (V8/Node-matching) rendering.
const SHORTEST: &str = "2434477073570464000";
/// XS's non-shortest exact-integer rendering of the same double.
const XS_EXACT: &str = "2434477073570463744";

#[test]
fn large_integer_result_renders_shortest_round_tripping_decimal() {
    // Reconstruct the value the way the program does, in f64, so the test is
    // tied to the finding and not just to a magic literal: the inner
    // subexpression is `(~(true && true)) - ((780140544 - true) * (true + true))`.
    let inner = (-2.0_f64) - ((780140544.0_f64 - 1.0) * (1.0 + 1.0));
    assert_eq!(inner, -1560281088.0, "inner subexpression is -1560281088");
    let value = inner * inner;
    assert_eq!(value.to_bits(), FINDING_VALUE.to_bits(), "program value is 8649*2^48");

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
