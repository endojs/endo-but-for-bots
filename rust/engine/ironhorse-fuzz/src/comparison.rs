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
/// while still flagging every genuine value divergence — ALMOST. The reasoning
/// it rested on was "two *different* doubles never share a parse, so
/// `a.to_bits() == b.to_bits()` fails the moment the engines actually computed
/// different numbers". That holds only while both renderings round-trip, and
/// XS's does not always: `xsdtoa.c:56` defines David Gay's `ROUND_BIASED`, so
/// XS can emit a spelling sitting EXACTLY on the boundary between two doubles
/// and read it back by rounding up rather than to even. Parsed here with
/// ties-to-even, that spelling lands on the OTHER double, and the check
/// reported a value divergence where there was none.
///
/// `differential_source` found one: the doubles were byte-identical
/// (`247,255,255,255,255,199,102,195`) and both engines answered `true` to
/// `expr === -51298814505516984`, yet XS rendered `-51298814505516980` — the
/// exact midpoint down — and the comparison read that back as
/// `-51298814505516976`. A false positive, and the exact inverse of the family
/// this function was written for.
///
/// So a boundary spelling is treated as what it is: AMBIGUOUS. It denotes
/// either neighbour depending on the reader's tie rule, and the engines agree
/// if ironhorse's double is one of them. Restricted to integral values, where
/// the midpoint is itself an integer and the comparison is exact; a genuine
/// value divergence of more than one ulp, or between non-integral values, is
/// unaffected.
pub(crate) fn results_agree(oracle: &str, ironhorse: &str) -> bool {
    if oracle == ironhorse {
        return true;
    }
    match (as_ecma_number(oracle), as_ecma_number(ironhorse)) {
        (Some(a), Some(b)) => a.to_bits() == b.to_bits() || oracle_spelling_is_a_tie(oracle, b),
        _ => false,
    }
}

/// Whether `oracle` is the exact decimal midpoint between `ironhorse` and one
/// of its two adjacent doubles — the one shape a `ROUND_BIASED` renderer emits
/// that a ties-to-even parser reads back as the neighbour.
///
/// Integral values only. Both doubles and the midpoint are then exact integers,
/// so the test is done in `i128` and involves no rounding of its own.
fn oracle_spelling_is_a_tie(oracle: &str, ironhorse: f64) -> bool {
    let exact = |v: f64| -> Option<i128> {
        (v.is_finite() && v.fract() == 0.0 && v.abs() < 9.0e18).then_some(v as i128)
    };
    let Some(here) = exact(ironhorse) else {
        return false;
    };
    // The oracle's text must itself be an exact decimal integer; anything with
    // an exponent or a fraction is not the shape this rule is about.
    let Ok(spelled) = oracle.parse::<i128>() else {
        return false;
    };
    [ironhorse.next_down(), ironhorse.next_up()]
        .into_iter()
        .filter_map(exact)
        .any(|neighbour| {
            let sum = here + neighbour;
            sum % 2 == 0 && sum / 2 == spelled
        })
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

    /// The `differential_source` crash of 2026-09-18
    /// (`crash-7fc45770f3c4e8e481b84f9caca3f0a5408c319b`).
    ///
    /// Both engines held the SAME double: byte-identical IEEE-754
    /// (`247,255,255,255,255,199,102,195`) and both answered `true` to
    /// `expr === -51298814505516984`. XS rendered the exact midpoint down,
    /// which ties-to-even reads back as `-51298814505516976`, so the by-double
    /// comparison called it a value divergence and the target panicked.
    #[test]
    fn a_biased_boundary_spelling_is_not_a_value_divergence() {
        assert!(results_agree("-51298814505516980", "-51298814505516984"));
        // The positive-signed member of the same class.
        assert!(results_agree("51298814505517060", "51298814505517064"));
        // And it is genuinely the tie that does it, not mere proximity: the
        // midpoint is 51298814505517060, so 51298814505517058 is not it.
        assert!(!results_agree("51298814505517058", "51298814505517064"));
    }

    /// The suppression must not swallow a real one-ulp disagreement.
    #[test]
    fn an_adjacent_double_spelled_exactly_is_still_a_divergence() {
        // Both spellings round-trip to DIFFERENT doubles one ulp apart. Only a
        // spelling on the boundary between them is ambiguous; these are not.
        assert!(!results_agree("51298814505517056", "51298814505517064"));
        assert!(!results_agree("57632001481506816", "57632001481506824"));
        // Two ulps away from the tie is not a tie either.
        assert!(!results_agree("51298814505517052", "51298814505517064"));
        // Non-integral values are outside the rule entirely.
        assert!(!results_agree("0.5", "0.5000000000000001"));
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
        // Multi-crank CI finding 3bb7e699: no epsilon comparison. Even the
        // immediately adjacent double must remain a divergence.
        let finding = f64::from_bits(0x4370_7400_0000_0000);
        assert_eq!("74098287619080190".parse::<f64>().unwrap(), finding);
        assert_eq!("74098287619080200".parse::<f64>().unwrap(), finding);
        assert!(results_agree("74098287619080190", "74098287619080200"));
        for bits in [finding.to_bits() - 1, finding.to_bits() + 1] {
            assert!(!results_agree(
                "74098287619080190",
                &f64::from_bits(bits).to_string()
            ));
        }
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
