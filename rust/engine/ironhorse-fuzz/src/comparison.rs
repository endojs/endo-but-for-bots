//! Pure acceptance policy, testable without building XS. A cost gap is data,
//! never a conformance failure; release vectors pin IronHorse's own costs.

/// The IronHorse observation is `(completed, rendered result, computrons)`.
/// The oracle observation is `(completed, rendered result, spec spelling,
/// computrons)`: its third field is ECMA-262 `Number::toString` of the
/// completion's exact IEEE-754 double when the completion was a Number, and
/// `None` otherwise, so the computrons sit at `.3` on the oracle side and `.2`
/// on the IronHorse side. The caller derives the spec spelling (this module
/// stays dependency-free so CI can test it with a bare `rustc --test`).
pub(crate) fn compare_observations(
    oracle: (bool, &str, Option<&str>, u64),
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

/// Whether IronHorse's completion string denotes the oracle's completion.
///
/// When the oracle's completion was a Number, IronHorse must spell it exactly
/// as `oracle_spelling`, the ECMA-262 `Number::toString` of the oracle's
/// exact double; XS's own spelling is ignored because it is not always
/// shortest or round-tripping. Otherwise the strings must be byte-identical,
/// or both parse as decimal Numbers with the same double.
pub(crate) fn results_agree(oracle: &str, oracle_spelling: Option<&str>, ironhorse: &str) -> bool {
    if let Some(spec) = oracle_spelling {
        return ironhorse == spec;
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
        // "51298827675632340", which parses to 51298827675632336. The spec
        // spelling of the oracle's exact double is all 17 digits.
        assert_ne!(
            "51298827675632340".parse::<f64>().unwrap(),
            51298827675632344.0_f64
        );
        let spec = Some("51298827675632344");
        assert!(results_agree(
            "51298827675632340",
            spec,
            "51298827675632344"
        ));
        // The same ambiguous spelling no longer masks a one-ulp divergence.
        assert!(!results_agree(
            "51298827675632340",
            spec,
            "51298827675632340"
        ));
        assert!(!results_agree(
            "51298827675632340",
            spec,
            "51298827675632336"
        ));
        // A right-valued but non-canonical spelling is still a divergence.
        assert!(!results_agree(
            "51298827675632340",
            spec,
            "5.1298827675632344e16"
        ));
        assert!(!results_agree(
            "51298827675632340",
            spec,
            "51298827675632344.0"
        ));
        // XS's non-minimal exact-integer spelling is not the spec spelling.
        let spec = Some("57632001481506820");
        assert!(results_agree(
            "57632001481506816",
            spec,
            "57632001481506820"
        ));
        assert!(!results_agree(
            "57632001481506816",
            spec,
            "57632001481506816"
        ));
        // -0 and +0 both spell "0"; "-0" never agrees.
        assert!(results_agree("0", Some("0"), "0"));
        assert!(!results_agree("0", Some("0"), "-0"));
        // Exponent-form extremes: only the spec spelling agrees.
        let spec = Some("1.7976931348623157e+308");
        assert!(results_agree(
            "1.7976931348623157e+308",
            spec,
            "1.7976931348623157e+308"
        ));
        assert!(!results_agree(
            "1.7976931348623157e+308",
            spec,
            "1.7976931348623157e308"
        ));
        assert!(results_agree("5e-324", Some("5e-324"), "5e-324"));
        assert!(!results_agree("5e-324", Some("5e-324"), "4.9e-324"));
        assert!(!results_agree("5e-324", Some("5e-324"), "0"));
        // A Number completion never agrees with a non-numeric one.
        assert!(!results_agree("1", Some("1"), "true"));
        // Non-finite Numbers spell as the spec does.
        assert!(results_agree("Infinity", Some("Infinity"), "Infinity"));
        assert!(results_agree("-Infinity", Some("-Infinity"), "-Infinity"));
        assert!(!results_agree("-Infinity", Some("-Infinity"), "Infinity"));
        assert!(results_agree("NaN", Some("NaN"), "NaN"));
        assert!(!results_agree("NaN", Some("NaN"), "Infinity"));
        // ECMA-262 switches to exponent notation at 10^21 and below 10^-6.
        assert!(results_agree("1e+21", Some("1e+21"), "1e+21"));
        assert!(!results_agree(
            "1e+21",
            Some("1e+21"),
            "1000000000000000000000"
        ));
        assert!(results_agree("1e-7", Some("1e-7"), "1e-7"));
        assert!(!results_agree("1e-7", Some("1e-7"), "0.0000001"));
        // The exact-integer transition at 2^53 stays explicit as well.
        assert!(results_agree(
            "9007199254740992",
            Some("9007199254740992"),
            "9007199254740992"
        ));
        assert!(!results_agree(
            "9007199254740992",
            Some("9007199254740992"),
            "9007199254740994"
        ));
    }
}
