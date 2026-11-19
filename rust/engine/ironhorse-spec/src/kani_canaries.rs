//! Canaries for the verifier itself (VERIFICATION.md, soundness rule 2).
//!
//! This is the one module in the proof tree that may use float `%`,
//! `rem_euclid`, `powi` and `powf`, and it uses them only to pin down that
//! Kani 0.68 / CBMC 6.11 computes them **wrongly, without a warning**. Each
//! float canary asserts the wrong answer Kani currently produces, so it
//! passes today; the comment gives the true IEEE 754 value. When a Kani or
//! CBMC upgrade fixes an encoding, its canary fails and forces a deliberate
//! review: the rule "no proof may depend on these operations" can then be
//! relaxed for that operation, in VERIFICATION.md, by a human.
//!
//! `pins` makes an `f64` symbolic and then pins it to one value, so rustc
//! cannot fold the operation at compile time: the result comes from Kani's
//! encoding, which is what is under test.
//!
//! The last canary is a deliberately false assertion, run with
//! `expect = "fail"`: it proves the runner notices a failed check.

/// A symbolic `f64` constrained to the bit pattern of `value`.
fn pins(value: f64) -> f64 {
    let x: f64 = kani::any();
    kani::assume(x.to_bits() == value.to_bits());
    x
}

/// `3.0 % 2.0` is `1.0` (IEEE 754 remainder toward zero, `fmod`); Kani
/// lowers `%` on floats to CBMC's `floatbv_mod`, which yields `0.0`.
#[kani::proof]
fn float_rem_is_miscomputed() {
    let r = pins(3.0) % pins(2.0);
    kani::cover!(r == 0.0, "Kani computes 3 % 2 as 0");
    assert!(
        r == 0.0,
        "true value 1.0: Kani's f64 % may be fixed; review"
    );
}

/// `(-3.0).rem_euclid(2.0)` is `1.0`; built on `%`, Kani yields `0.0`.
#[kani::proof]
fn float_rem_euclid_is_miscomputed() {
    let r = pins(-3.0).rem_euclid(pins(2.0));
    kani::cover!(r == 0.0, "Kani computes rem_euclid(-3, 2) as 0");
    assert!(
        r == 0.0,
        "true value 1.0: Kani's f64 rem_euclid may be fixed; review"
    );
}

/// `3.0.powi(2)` is `9.0`; Kani yields some other value.
#[kani::proof]
fn float_powi_is_miscomputed() {
    let r = pins(3.0).powi(2);
    kani::cover!(
        r != 9.0,
        "Kani computes powi(3, 2) as something other than 9"
    );
    assert!(
        r != 9.0,
        "true value 9.0: Kani's f64 powi may be fixed; review"
    );
}

/// `3.0.powf(2.0)` is `9.0`; Kani yields some other value.
#[kani::proof]
fn float_powf_is_miscomputed() {
    let r = pins(3.0).powf(pins(2.0));
    kani::cover!(
        r != 9.0,
        "Kani computes powf(3, 2) as something other than 9"
    );
    assert!(
        r != 9.0,
        "true value 9.0: Kani's f64 powf may be fixed; review"
    );
}

/// A false assertion. The manifest expects this harness to FAIL; if the
/// runner ever reports it as passing, failure detection is broken.
#[kani::proof]
fn false_assertion_is_reported() {
    let x: u8 = kani::any();
    kani::cover!(x == 7, "the refuting input is reachable");
    assert!(x != 7, "deliberately false: x = 7 refutes it");
}
