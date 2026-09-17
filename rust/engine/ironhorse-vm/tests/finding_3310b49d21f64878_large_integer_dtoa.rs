//! Regression for ironhorse fuzz finding `3310b49d21f64878`
//! (target `differential_source`, toolchain `nightly-2026-08-15`).
//!
//! The 4-byte minimized input `24 00 1b 1b`
//! (sha256 `8052cd0fe6de647863a6803fad31515cf631d6fccc45ead2e8092630456f566d`)
//! folds, through `ironhorse_fuzz::gen_program`, into the arithmetic program
//!
//! ```text
//! ((((true * true) + (true * true)) * ((226492416 + true) * (301989888 * true)))
//!  + (((true * true) + (true * true)) * ((226492416 + true) * (301989888 * true))))
//! ```
//!
//! The two `226492416`/`301989888` operands are the generator's large-integer
//! atoms `27 << 23` and `36 << 23` (`gen_atom` case 3, driven by the cyclic
//! input bytes `0x1b = 27` and `0x24 = 36`).
//!
//! Evaluated in IEEE-754 doubles (ECMAScript Number semantics): `true * true`
//! is `1`, `(true * true) + (true * true)` is `2`, `226492416 + true` is
//! `226492417`, and `301989888 * true` is `301989888`. Each half is
//! `2 * (226492417 * 301989888)`, and the whole is their sum — `4 * (226492417
//! * 301989888)`, the *exactly* representable double whose real value is
//! `273593678570717184`.
//!
//! ironhorse and XS compute the identical double. They diverged only in how
//! they render it to a string:
//!
//!   * XS's `fx_dtoa` printed the double's exact integer,
//!     `273593678570717184` (18 significant digits).
//!   * ironhorse — like V8/SpiderMonkey and ECMA-262 §6.1.6.1.20's Number
//!     `toString` ("let `k` be as small as possible") — prints the *shortest*
//!     decimal that round-trips, `273593678570717200` (16 significant
//!     digits).
//!
//! Both spellings parse back to the same double, so the port was never wrong;
//! the differential harness compares numeric completions by their double
//! rather than their decimal spelling (finding `d99d263fcf6ca7a7`). This is a
//! re-discovery of that dtoa-spelling class under a new minimized input; the
//! finding reproduced only at the older project SHA
//! `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`, before that harness policy
//! suppressed the spurious spelling divergence.
//!
//! This test needs neither the XS oracle nor the `c/moddable` submodule: it
//! pins the port's own `number_to_ecma_string` for the reproducing value, the
//! portable source-of-truth the oracle's non-shortest rendering must not be
//! allowed to override.

use ironhorse_vm::value::number_to_ecma_string;

/// The exactly-representable double the finding program evaluates to.
const FINDING_VALUE: f64 = 273593678570717184.0;

/// The spec-shortest (V8-matching) rendering.
const SHORTEST: &str = "273593678570717200";
/// XS's non-shortest exact-integer rendering of the same double.
const XS_EXACT: &str = "273593678570717184";

#[test]
fn large_integer_result_renders_shortest_round_tripping_decimal() {
    // Reconstruct the value the way the program evaluates it, in f64
    // arithmetic, so the test is tied to the finding and not just to a magic
    // literal.
    //
    // `226492416` and `301989888` are the generator's `27 << 23` and
    // `36 << 23` large-integer atoms.
    let big_a = (27_i64 << 23) as f64; // 226492416
    let big_b = (36_i64 << 23) as f64; // 301989888
    assert_eq!(big_a, 226492416.0);
    assert_eq!(big_b, 301989888.0);
    // `(true * true) + (true * true)` is `1 + 1 = 2`; `226492416 + true` is
    // `226492417`; `301989888 * true` is `301989888`. Each half is the product
    // of those three.
    let half = ((1.0_f64 * 1.0) + (1.0 * 1.0)) * ((big_a + 1.0) * (big_b * 1.0));
    // The whole program is the sum of the two identical halves.
    let value = half + half;
    assert_eq!(
        value.to_bits(),
        FINDING_VALUE.to_bits(),
        "program value is 273593678570717184 (exact double)"
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
