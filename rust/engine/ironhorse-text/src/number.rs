//! ECMA-262 `Number::toString(10)` spelling (6.1.6.1.20), parameterized by
//! the source of the shortest round-tripping decimal digits.
//!
//! The spec's fixed/exponential placement is engine-agnostic, so every
//! Number spelling in the workspace shares it. The digit source is not
//! shared: the XS oracle supplies its own so that a regression in the
//! engine's dtoa cannot agree with itself in the differential.
//!
//! IronHorse's spelling intentionally departs from XS's `fxNumberToString`.
//! XS's `fx_dtoa` sometimes prints a longer exact-integer form
//! (`57632001481506816` where the spec prints `57632001481506820`) or, at a
//! tie, a spelling that does not round-trip. IronHorse always follows the
//! spec, so string conversion and non-index numeric property keys can spell
//! the same Number differently on the two engines.

/// Spell `number` as ECMA-262 `Number::toString(10)` with the standard
/// library's shortest digits; the spelling the compiler and VM share.
pub fn number_to_ecma_string(number: f64) -> String {
    number_to_ecma_string_with(number, std_shortest_digits)
}

/// Spell `number` as ECMA-262 `Number::toString(10)`.
///
/// `shortest` receives a finite, positive `number.abs()` and returns
/// `(digits, exponent)`: the shortest round-tripping decimal significand
/// with one digit before its point, spelled with or without that point
/// (`"1.25"` or `"125"`), and its base-10 exponent, so that
/// `1.25 x 10^exponent` is the value.
pub fn number_to_ecma_string_with(
    number: f64,
    shortest: impl FnOnce(f64) -> (String, i32),
) -> String {
    if number.is_nan() {
        return "NaN".to_string();
    }
    if number.is_infinite() {
        return if number < 0.0 {
            "-Infinity"
        } else {
            "Infinity"
        }
        .to_string();
    }
    if number == 0.0 {
        // Covers +0 and -0; JS String(-0) === "0".
        return "0".to_string();
    }
    let (mantissa, exponent) = shortest(number.abs());
    let mut digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    while digits.ends_with('0') {
        digits.pop();
    }
    assert!(
        !digits.is_empty() && !digits.starts_with('0'),
        "shortest digits for a nonzero finite Number must start with a nonzero digit"
    );
    let body = place_digits(&digits, exponent + 1);
    if number < 0.0 {
        format!("-{body}")
    } else {
        body
    }
}

/// Shortest digits from Rust's `{:e}` formatting, for
/// [`number_to_ecma_string_with`].
pub fn std_shortest_digits(magnitude: f64) -> (String, i32) {
    let spelled = format!("{magnitude:e}");
    let (mantissa, exponent) = spelled
        .split_once('e')
        .expect("`{:e}` of a finite Number always carries an exponent");
    (
        mantissa.to_string(),
        exponent.parse().expect("`{:e}` exponent is an integer"),
    )
}

/// Place `digits` (the spec's `s`, `k` digits long, no leading or trailing
/// zero) so that the value is `0.s x 10^point` (`point` is the spec's `n`).
fn place_digits(digits: &str, point: i32) -> String {
    let count = digits.len() as i32;
    if count <= point && point <= 21 {
        format!("{digits}{}", "0".repeat((point - count) as usize))
    } else if 0 < point && point <= 21 {
        let (whole, fraction) = digits.split_at(point as usize);
        format!("{whole}.{fraction}")
    } else if -6 < point && point <= 0 {
        format!("0.{}{digits}", "0".repeat((-point) as usize))
    } else {
        let exponent = point - 1;
        let exponent_sign = if exponent >= 0 { "+" } else { "-" };
        let (head, tail) = digits.split_at(1);
        let significand = if tail.is_empty() {
            head.to_string()
        } else {
            format!("{head}.{tail}")
        };
        format!("{significand}e{exponent_sign}{}", exponent.abs())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spell(number: f64) -> String {
        number_to_ecma_string_with(number, std_shortest_digits)
    }

    #[test]
    fn placement_covers_each_branch_and_boundary() {
        for (number, expected) in [
            (f64::NAN, "NaN"),
            (f64::INFINITY, "Infinity"),
            (f64::NEG_INFINITY, "-Infinity"),
            (-0.0, "0"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (1.5e20, "150000000000000000000"),
            (123000.0, "123000"),
            (123.456, "123.456"),
            (0.5, "0.5"),
            (1e-6, "0.000001"),
            (1.25e-6, "0.00000125"),
            (1e-7, "1e-7"),
            (-1.5, "-1.5"),
            (f64::MAX, "1.7976931348623157e+308"),
            (f64::MIN_POSITIVE, "2.2250738585072014e-308"),
            (5e-324, "5e-324"),
        ] {
            assert_eq!(spell(number), expected, "{number:e}");
        }
    }
}
