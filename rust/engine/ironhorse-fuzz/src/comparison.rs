//! Pure acceptance policy, testable without building XS. A cost gap is data,
//! never a conformance failure; release vectors pin IronHorse's own costs.

/// Each observation is (completed, rendered result, computrons).
pub(crate) fn compare_observations(
    oracle: (bool, &str, u64),
    ironhorse: (bool, &str, u64),
) -> Result<Option<(u64, u64)>, String> {
    if oracle.0 != ironhorse.0 {
        return Err(format!(
            "completion: oracle={} ironhorse={}",
            oracle.0, ironhorse.0
        ));
    }
    if oracle.0 && !results_agree(oracle.1, ironhorse.1) {
        return Err(format!(
            "result: oracle={:?} ironhorse={:?}",
            oracle.1, ironhorse.1
        ));
    }
    Ok((oracle.0 && oracle.2 != ironhorse.2).then_some((oracle.2, ironhorse.2)))
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
pub(crate) fn results_agree(oracle: &str, ironhorse: &str) -> bool {
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
            compare_observations((true, "42", 1), (true, "42", u64::MAX)),
            Ok(Some((1, u64::MAX)))
        );
        assert_eq!(
            compare_observations((true, "42", 1), (true, "42", 1)),
            Ok(None)
        );
    }

    #[test]
    fn cost_drift_never_hides_a_semantic_failure() {
        assert!(compare_observations((true, "42", 1), (false, "42", 2))
            .unwrap_err()
            .starts_with("completion:"));
        assert!(compare_observations((true, "42", 1), (true, "43", 2))
            .unwrap_err()
            .starts_with("result:"));
    }

    #[test]
    fn numeric_spelling_policy_is_preserved() {
        assert!(compare_observations(
            (true, "57632001481506816", 1),
            (true, "57632001481506820", 2)
        )
        .is_ok());
        assert!(compare_observations(
            (true, "57632001481506816", 1),
            (true, "57632001481506824", 2)
        )
        .is_err());
    }
    #[test]
    fn results_agree_on_equal_doubles_spelled_differently() {
        // The finding's two renderings of the same double.
        assert!(results_agree("57632001481506816", "57632001481506820"));
        // A genuine value divergence is still caught.
        assert!(!results_agree("57632001481506816", "57632001481506824"));
        assert!(!results_agree("3", "4"));
        // Non-numeric completions compare byte-for-byte.
        assert!(results_agree("true", "true"));
        assert!(!results_agree("true", "false"));
        assert!(!results_agree("Infinity", "1e999"));
        // `Infinity`/`NaN` are not parsed as numbers (they match as strings).
        assert!(as_ecma_number("Infinity").is_none());
        assert!(as_ecma_number("NaN").is_none());
        assert!(as_ecma_number("").is_none());
    }
}
