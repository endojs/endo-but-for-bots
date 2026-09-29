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
//! tie, a spelling that does not round-trip. IronHorse's spelling is always
//! a valid step-5 `s`, so string conversion and non-index numeric property
//! keys can spell the same Number differently on the two engines.
//!
//! Step 5 does not always determine `s`: when a double lies exactly halfway
//! between two `k`-digit candidates, both are valid. IronHorse follows Note 2
//! and picks the even last digit (Rust's `{:e}` alone picks the upper one),
//! as Ryu and V8 do, so every spelling in the workspace is fully determined
//! and the differentials compare Number spellings byte for byte.

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
/// [`number_to_ecma_string_with`], with an exact decimal tie resolved to the
/// even last digit (6.1.6.1.20 Note 2).
pub fn std_shortest_digits(magnitude: f64) -> (String, i32) {
    let spelled = format!("{magnitude:e}");
    let (mantissa, exponent) = spelled
        .split_once('e')
        .expect("`{:e}` of a finite Number always carries an exponent");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let exponent: i32 = exponent.parse().expect("`{:e}` exponent is an integer");
    (even_tie_digits(magnitude, digits, exponent), exponent)
}

/// Replace a shortest spelling that ends in an odd digit with its even
/// neighbor when `magnitude` lies exactly halfway between the two and the
/// neighbor also round-trips; otherwise return `digits` unchanged.
fn even_tie_digits(magnitude: f64, digits: String, exponent: i32) -> String {
    let last = digits.as_bytes()[digits.len() - 1] - b'0';
    if last.is_multiple_of(2) {
        return digits;
    }
    let Some((exact, exact_exponent)) = exact_short_decimal(magnitude) else {
        return digits;
    };
    // A tie needs the exact value to carry exactly one more significant
    // digit, a 5, and to share the leading digit's position.
    if exact.len() != digits.len() + 1 || !exact.ends_with('5') || exact_exponent != exponent {
        return digits;
    }
    let lower = &exact[..digits.len()];
    let neighbor = if digits == lower {
        // Rounding the odd lower candidate up to the even one; `last` is odd,
        // so a 9 would carry and shorten `s`, which step 5 already excluded.
        if last == 9 {
            return digits;
        }
        format!("{}{}", &lower[..lower.len() - 1], last + 1)
    } else {
        // `digits` is the odd upper candidate, so `lower` is even.
        lower.to_string()
    };
    let candidate = format!("{}.{}e{exponent}", &neighbor[..1], &neighbor[1..]);
    if candidate.parse::<f64>() == Ok(magnitude) {
        neighbor
    } else {
        digits
    }
}

/// The exact decimal value of a finite positive `magnitude` as significant
/// digits (no trailing zero) and the exponent of the first one, or `None` when
/// it has more than 18 significant digits and so cannot be a tie between two
/// shortest (at most 17-digit) candidates.
fn exact_short_decimal(magnitude: f64) -> Option<(String, i32)> {
    const MAX_DIGITS: usize = 18;
    let bits = magnitude.to_bits();
    let biased = ((bits >> 52) & 0x7ff) as i32;
    let fraction = bits & ((1 << 52) - 1);
    let (mut significand, mut binary_exponent) = if biased == 0 {
        (fraction, -1074)
    } else {
        (fraction | (1 << 52), biased - 1075)
    };
    let zeros = significand.trailing_zeros();
    significand >>= zeros;
    binary_exponent += zeros as i32;
    // magnitude = significand * 2^binary_exponent, significand odd.
    let (integer, decimal_exponent) = if binary_exponent >= 0 {
        // Pair factors of 5 in the significand with the factors of 2 to
        // move them into the decimal exponent.
        let mut remaining = significand;
        let mut tens = 0;
        while tens < binary_exponent && remaining.is_multiple_of(5) {
            remaining /= 5;
            tens += 1;
        }
        let shift = (binary_exponent - tens) as u32;
        if 64 - remaining.leading_zeros() + shift > 127 {
            return None;
        }
        ((remaining as u128) << shift, tens)
    } else {
        // significand / 2^a == significand * 5^a / 10^a. The product has no
        // trailing zero, and past a = 31 it is longer than 18 digits.
        let halvings = (-binary_exponent) as u32;
        if halvings > 31 {
            return None;
        }
        (significand as u128 * 5u128.pow(halvings), binary_exponent)
    };
    let spelled = integer.to_string();
    let digits = spelled.trim_end_matches('0');
    if digits.len() > MAX_DIGITS {
        return None;
    }
    Some((
        digits.to_string(),
        decimal_exponent + spelled.len() as i32 - 1,
    ))
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

    #[test]
    fn exact_decimal_ties_take_the_even_digit() {
        for (number, expected) in [
            // Exact sums: each literal alone would read as its shortest spelling.
            // Halfway between the 17-digit candidates `...062` and `...063`.
            (-(125343939420064.0 + 0.625), "-125343939420064.62"),
            (-(614423824407840.0 + 0.25), "-614423824407840.2"),
            (614423824407840.0 + 0.75, "614423824407840.8"),
            // 2^-1: the exact value is itself short, not a tie.
            (0.5, "0.5"),
        ] {
            assert_eq!(spell(number), expected, "{number:e}");
        }
    }

    #[test]
    fn exact_short_decimal_is_exact_or_absent() {
        assert_eq!(exact_short_decimal(0.625), Some(("625".to_string(), -1)));
        assert_eq!(exact_short_decimal(1e21), Some(("1".to_string(), 21)));
        assert_eq!(exact_short_decimal(3.0 * 2f64.powi(100)), None);
        assert_eq!(exact_short_decimal(0.1), None);
        assert_eq!(exact_short_decimal(5e-324), None);
    }
}
