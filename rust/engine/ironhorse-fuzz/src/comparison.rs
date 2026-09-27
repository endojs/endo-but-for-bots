//! Pure acceptance policy, testable without building XS. A cost gap is data,
//! never a conformance failure; release vectors pin IronHorse's own costs.

use ironhorse_vm::value::number_to_ecma_string;

/// The IronHorse observation is `(completed, rendered result, computrons)`.
/// The oracle observation is `(completed, rendered result, exact double,
/// computrons)`: its third field is the completion's exact IEEE-754 double
/// when the completion was a Number, and `None` otherwise, so the computrons
/// sit at `.3` on the oracle side and `.2` on the IronHorse side.
pub(crate) fn compare_observations(
    oracle: (bool, &str, Option<f64>, u64),
    ironhorse: (bool, &str, u64),
) -> Result<Option<(u64, u64)>, String> {
    if oracle.0 != ironhorse.0 {
        return Err(format!(
            "completion: oracle={} ironhorse={}",
            oracle.0, ironhorse.0
        ));
    }
    if oracle.0 && !results_agree(oracle.1, oracle.2, ironhorse.1) {
        return Err(format!(
            "result: oracle={:?} ironhorse={:?}",
            oracle.1, ironhorse.1
        ));
    }
    Ok((oracle.0 && oracle.3 != ironhorse.2).then_some((oracle.3, ironhorse.2)))
}

/// Whether two completion result strings denote the same guest value.
///
/// Byte-identical strings agree. Beyond that, a **Number** completion is
/// compared by its IEEE-754 double rather than its decimal spelling. XS's
/// `fx_dtoa` renders some large integer-valued doubles in a non-shortest,
/// exact-integer form — finding `d99d263fcf6ca7a7` reproduced
/// `327155712 * ((327155712 * (729808896 % 603979776)) % 729808896)`, whose
/// value is the exactly-representable double `57632001481506816`, which XS
/// prints verbatim (17 digits). ironhorse — like V8/SpiderMonkey and
/// ECMA-262 §6.1.6.1.20's "k is as small as possible" — prints the *shortest*
/// round-tripping decimal, `57632001481506820` (16 digits). Both spellings
/// parse back to the identical double, so the two engines computed the same
/// value and disagree only on rendering; forcing byte-identity would make
/// ironhorse reproduce XS's non-shortest, non-conformant rendering.
///
/// Comparing the parsed doubles suppresses that spurious spelling divergence
/// while still flagging every genuine value divergence: two *different*
/// doubles never share a parse (a decimal string parses to exactly one
/// nearest double), so `a.to_bits() == b.to_bits()` fails the moment the
/// engines actually computed different numbers.
///
/// That parse is only sound when the oracle's spelling round-trips, and XS's
/// does not always: finding `05264cccae42245a` computed the double
/// `51298827675632344` on both engines, but XS rendered it as
/// `51298827675632340` — exactly halfway between it and `51298827675632336`,
/// a tie that round-half-even parses back to `...336`. ironhorse (like V8, and
/// as ECMA-262 §6.1.6.1.20 requires, since `𝔽(s × 10^(n−k))` must be `x`)
/// needs all 17 digits and prints `51298827675632344`. So when the oracle
/// reports its completion's exact double (`oracle_number`), the oracle's
/// spelling is ignored and a finite Number must be spelled exactly as
/// ECMA-262 `Number::toString` spells that double
/// ([`number_to_ecma_string`]). That stops the ambiguous tie from masking a
/// genuine one-ulp divergence, and, because the oracle is known to break
/// §6.1.6.1.20 here, it checks IronHorse's spelling against the spec rather
/// than merely checking that it parses back to the same value: a
/// non-minimal, exponent-form, or `"-0"` spelling of the right double is
/// still a divergence.
pub(crate) fn results_agree(oracle: &str, oracle_number: Option<f64>, ironhorse: &str) -> bool {
    if let Some(x) = oracle_number.filter(|x| x.is_finite()) {
        return ironhorse == number_to_ecma_string(x);
    }
    if oracle == ironhorse {
        return true;
    }
    match (as_ecma_number(oracle), as_ecma_number(ironhorse)) {
        (Some(a), Some(b)) => a.to_bits() == b.to_bits(),
        _ => false,
    }
}

/// Parse a completion string as the ECMAScript `String()` of a finite
/// Number, or `None` when it is not a plain decimal Number spelling — so
/// `"Infinity"`, `"NaN"`, booleans, and string results fall through to the
/// byte comparison in [`results_agree`] (and `Infinity`/`NaN` already match
/// byte-for-byte anyway). The character allow-list is what keeps Rust's
/// float parser from accepting `inf`/`nan`/`infinity`, which JS never prints.
fn as_ecma_number(s: &str) -> Option<f64> {
    if s.is_empty() {
        return None;
    }
    if !s
        .bytes()
        .all(|b| b.is_ascii_digit() || matches!(b, b'+' | b'-' | b'.' | b'e' | b'E'))
    {
        return None;
    }
    s.parse::<f64>().ok().filter(|v| v.is_finite())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recalibration_is_advisory_even_at_extreme_costs() {
        assert_eq!(
            compare_observations((true, "42", None, 1), (true, "42", u64::MAX)),
            Ok(Some((1, u64::MAX)))
        );
        assert_eq!(
            compare_observations((true, "42", None, 1), (true, "42", 1)),
            Ok(None)
        );
    }

    #[test]
    fn cost_drift_never_hides_a_semantic_failure() {
        assert!(
            compare_observations((true, "42", None, 1), (false, "42", 2))
                .unwrap_err()
                .starts_with("completion:")
        );
        assert!(compare_observations((true, "42", None, 1), (true, "43", 2))
            .unwrap_err()
            .starts_with("result:"));
    }

    #[test]
    fn numeric_spelling_policy_is_preserved() {
        assert!(compare_observations(
            (true, "57632001481506816", None, 1),
            (true, "57632001481506820", 2)
        )
        .is_ok());
        assert!(compare_observations(
            (true, "57632001481506816", None, 1),
            (true, "57632001481506824", 2)
        )
        .is_err());
    }
    fn results_agree_str(oracle: &str, ironhorse: &str) -> bool {
        results_agree(oracle, None, ironhorse)
    }

    #[test]
    fn results_agree_on_equal_doubles_spelled_differently() {
        // The finding's two renderings of the same double.
        assert!(results_agree_str("57632001481506816", "57632001481506820"));
        // A genuine value divergence is still caught.
        assert!(!results_agree_str("57632001481506816", "57632001481506824"));
        assert!(!results_agree_str("3", "4"));
        // Non-numeric completions compare byte-for-byte.
        assert!(results_agree_str("true", "true"));
        assert!(!results_agree_str("true", "false"));
        assert!(!results_agree_str("Infinity", "1e999"));
        // `Infinity`/`NaN` are not parsed as numbers (they match as strings).
        assert!(as_ecma_number("Infinity").is_none());
        assert!(as_ecma_number("NaN").is_none());
        assert!(as_ecma_number("").is_none());
    }

    #[test]
    fn oracle_double_overrides_a_non_round_tripping_spelling() {
        // Finding 05264cccae42245a: XS spells 51298827675632344 as
        // "51298827675632340", which parses to 51298827675632336.
        let x = 51298827675632344.0_f64;
        assert_ne!("51298827675632340".parse::<f64>().unwrap(), x);
        assert!(results_agree(
            "51298827675632340",
            Some(x),
            "51298827675632344"
        ));
        // The same ambiguous spelling no longer masks a one-ulp divergence.
        assert!(!results_agree(
            "51298827675632340",
            Some(x),
            "51298827675632340"
        ));
        assert!(!results_agree(
            "51298827675632340",
            Some(x),
            "51298827675632336"
        ));
        // -0 renders as "0" on both engines.
        assert!(results_agree("0", Some(-0.0), "0"));
        // A right-valued but non-canonical spelling is still a divergence.
        assert!(!results_agree("0", Some(0.0), "-0"));
        assert!(!results_agree("0", Some(-0.0), "-0"));
        assert!(!results_agree(
            "51298827675632340",
            Some(x),
            "5.1298827675632344e16"
        ));
        assert!(!results_agree(
            "51298827675632340",
            Some(x),
            "51298827675632344.0"
        ));
        // XS's non-minimal exact-integer spelling is not the spec spelling.
        let d = 57632001481506816.0_f64;
        assert!(results_agree(
            "57632001481506816",
            Some(d),
            "57632001481506820"
        ));
        assert!(!results_agree(
            "57632001481506816",
            Some(d),
            "57632001481506816"
        ));
        // Exponent-form extremes: only the spec spelling agrees.
        assert!(results_agree(
            "1.7976931348623157e+308",
            Some(f64::MAX),
            "1.7976931348623157e+308"
        ));
        assert!(!results_agree(
            "1.7976931348623157e+308",
            Some(f64::MAX),
            "1.7976931348623157e308"
        ));
        let min_subnormal = f64::from_bits(1);
        assert!(results_agree("5e-324", Some(min_subnormal), "5e-324"));
        assert!(!results_agree("5e-324", Some(min_subnormal), "4.9e-324"));
        assert!(!results_agree("5e-324", Some(min_subnormal), "0"));
        // A Number completion never agrees with a non-numeric one.
        assert!(!results_agree("1", Some(1.0), "true"));
        // Non-finite Numbers still compare by spelling.
        assert!(results_agree("Infinity", Some(f64::INFINITY), "Infinity"));
        assert!(results_agree("NaN", Some(f64::NAN), "NaN"));
        assert!(!results_agree("NaN", Some(f64::NAN), "Infinity"));
    }
}
