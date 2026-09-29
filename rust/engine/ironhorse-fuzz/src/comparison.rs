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
/// When the oracle's completion was a Number, IronHorse must spell it as
/// `oracle_spelling`, the ECMA-262 `Number::toString` of the oracle's exact
/// double; XS's own spelling is ignored because it is not always shortest or
/// round-tripping. The one freedom the spec leaves is the last digit of an
/// exact tie (step 5 does not determine `s` uniquely; Note 2 only recommends
/// the even one), so a spelling with the same shape and digit count that
/// denotes the same double also agrees. Otherwise the oracle has reported that
/// the completion was not a Number (a String, BigInt, Boolean, and so on), so
/// the strings must be byte-identical: re-inferring a Number from a
/// numeric-looking spelling would hide a divergence such as the String `"1e2"`
/// against `"100"`.
pub(crate) fn results_agree(oracle: &str, oracle_spelling: Option<&str>, ironhorse: &str) -> bool {
    match oracle_spelling {
        Some(spec) => ironhorse == spec || is_tie_spelling(spec, ironhorse),
        None => oracle == ironhorse,
    }
}

/// Whether `other` is `spec` with a different choice of shortest digits for
/// the same finite double: same length, same significant-digit count, and the
/// same parsed value.
fn is_tie_spelling(spec: &str, other: &str) -> bool {
    let same_double = match (spec.parse::<f64>(), other.parse::<f64>()) {
        (Ok(a), Ok(b)) => a.is_finite() && a == b,
        _ => false,
    };
    same_double
        && spec.len() == other.len()
        && significant_digits(spec).is_some()
        && significant_digits(spec) == significant_digits(other)
}

/// The spec's `k` for a decimal spelling (digits without leading or trailing
/// zeros), or `None` if it contains anything a finite Number spelling cannot.
fn significant_digits(spelling: &str) -> Option<usize> {
    let mantissa = spelling.split_once('e').map_or(spelling, |(m, _)| m);
    if !spelling
        .bytes()
        .all(|b| b.is_ascii_digit() || matches!(b, b'-' | b'+' | b'.' | b'e'))
    {
        return None;
    }
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    Some(digits.trim_start_matches('0').trim_end_matches('0').len())
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
        let spec = Some("57632001481506820");
        assert!(compare_observations(
            (true, "57632001481506816", spec, 1),
            (true, "57632001481506820", 2)
        )
        .is_ok());
        assert!(compare_observations(
            (true, "57632001481506816", spec, 1),
            (true, "57632001481506824", 2)
        )
        .is_err());
    }

    #[test]
    fn either_shortest_spelling_of_an_exact_tie_agrees() {
        // -125343939420064.625 is exactly halfway between the 17-digit
        // candidates; Ryu spells the even one, Rust's `{:e}` the odd one.
        let spec = Some("-125343939420064.62");
        assert!(results_agree("", spec, "-125343939420064.63"));
        assert!(!results_agree("", spec, "-125343939420064.61"));
        assert!(!results_agree("", spec, "-125343939420064.625"));
        assert!(!results_agree("", spec, "125343939420064.63"));
        assert!(!results_agree("", None, "-125343939420064.63"));
    }

    #[test]
    fn non_number_completions_compare_byte_for_byte() {
        assert!(results_agree("true", None, "true"));
        assert!(!results_agree("true", None, "false"));
        assert!(!results_agree("Infinity", None, "1e999"));
        // `'' + 51298827675632344` completes as a String. XS spells it
        // "51298827675632340"; a different String is a divergence even though
        // both spellings parse to nearby (or equal) doubles.
        assert!(!results_agree(
            "51298827675632340",
            None,
            "51298827675632344"
        ));
        // The same double spelled two ways is still two different Strings.
        assert!(!results_agree(
            "57632001481506816",
            None,
            "57632001481506820"
        ));
        assert!(!results_agree("1e2", None, "100"));
        assert!(!results_agree("100000000000000000000", None, "1e+20"));
        assert!(results_agree("1e2", None, "1e2"));
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
