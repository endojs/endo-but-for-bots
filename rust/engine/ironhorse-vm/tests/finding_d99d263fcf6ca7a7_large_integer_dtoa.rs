//! Regression for ironhorse fuzz finding `d99d263fcf6ca7a7`
//! (target `differential_source`, toolchain `nightly-2026-08-15`).
//!
//! The 5-byte minimized input `2d 57 27 48 86`
//! (sha256 `749f2021f82cf2664d886690b5e87184f084e600df531f9ab232e3f64e09a4f9`)
//! folds, through `ironhorse_fuzz::gen_program`, into the arithmetic program
//!
//! ```text
//! ((729808896 && (729808896 && (-83 && 327155712)))
//!  * (((-83 && 327155712) * (729808896 % 603979776)) % 729808896))
//! ```
//!
//! Evaluated in IEEE-754 doubles (ECMAScript Number semantics) this is
//! `327155712 * ((327155712 * 125829120) % 729808896)`
//! = `327155712 * 176160768` = **`819 * 2^46`**, the *exactly* representable
//! double whose real value is `57632001481506816`.
//!
//! ironhorse and XS compute the identical double. They diverged only in how
//! they render it to a string:
//!
//!   * XS's `fx_dtoa` printed the double's exact integer, `57632001481506816`
//!     (17 significant digits).
//!   * ironhorse — like V8/SpiderMonkey and ECMA-262 §6.1.6.1.20's Number
//!     `toString` ("let `k` be as small as possible") — prints the *shortest*
//!     decimal that round-trips, `57632001481506820` (16 significant digits).
//!
//! Both spellings parse back to the same double, so the port was never wrong;
//! the differential harness now compares numeric completions by their double
//! rather than their decimal spelling (finding `d99d263fcf6ca7a7`).
//!
//! This test needs neither the XS oracle nor the `c/moddable` submodule: it
//! pins the port's own `number_to_ecma_string` for the reproducing value, the
//! portable source-of-truth the oracle's non-shortest rendering must not be
//! allowed to override.

use ironhorse_vm::value::number_to_ecma_string;

/// `819 * 2^46`, the exactly-representable double the finding program
/// evaluates to.
const FINDING_VALUE: f64 = 57632001481506816.0;

/// The spec-shortest (V8-matching) rendering.
const SHORTEST: &str = "57632001481506820";
/// XS's non-shortest exact-integer rendering of the same double.
const XS_EXACT: &str = "57632001481506816";

#[test]
fn large_integer_result_renders_shortest_round_tripping_decimal() {
    // Reconstruct the value the way the program does, in f64, so the test is
    // tied to the finding and not just to a magic literal.
    let a: f64 = 327155712.0;
    let inner = (a * (729808896.0_f64 % 603979776.0)) % 729808896.0;
    let value = a * inner;
    assert_eq!(value.to_bits(), FINDING_VALUE.to_bits(), "program value is 819*2^46");

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
