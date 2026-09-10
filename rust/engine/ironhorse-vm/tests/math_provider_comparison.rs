//! W6 C4 prerequisite: measure the candidate before changing runtime selection.
//! Exact special values are never covered by the ordinary-value ULP allowance.
mod math_support;
use math_support::{guest_bits, vector};
use std::fmt::Write;

fn candidate(function: &str, args: &[u64]) -> u64 {
    let x = args.first().map(|x| f64::from_bits(*x)).unwrap_or(f64::NAN);
    let y = args.get(1).map(|y| f64::from_bits(*y)).unwrap_or(f64::NAN);
    let result = match function {
        "acos" => libm::acos(x),
        "acosh" => libm::acosh(x),
        "asin" => libm::asin(x),
        "asinh" => libm::asinh(x),
        "atan" => libm::atan(x),
        "atanh" => libm::atanh(x),
        "cbrt" => libm::cbrt(x),
        "cos" => libm::cos(x),
        "cosh" => libm::cosh(x),
        "exp" => libm::exp(x),
        "expm1" => libm::expm1(x),
        "log" => libm::log(x),
        "log1p" => libm::log1p(x),
        "log10" => libm::log10(x),
        "log2" => libm::log2(x),
        "sin" => libm::sin(x),
        "sinh" => libm::sinh(x),
        "tan" => libm::tan(x),
        "tanh" => libm::tanh(x),
        "atan2" => libm::atan2(x, y),
        "pow" if !y.is_finite() && x.abs() == 1.0 => f64::NAN,
        "pow" => libm::pow(x, y),
        "hypot" if args.is_empty() => 0.0,
        "hypot" if args.len() == 2 => libm::hypot(x, y),
        "hypot" => args
            .iter()
            .map(|x| {
                let value = f64::from_bits(*x);
                value * value
            })
            .sum::<f64>()
            .sqrt(),
        "abs" => x.abs(),
        "ceil" => x.ceil(),
        "floor" => x.floor(),
        "sqrt" => x.sqrt(),
        _ => panic!("uncovered provider function {function}"),
    };
    if result.is_nan() {
        0x7ff8_0000_0000_0000
    } else {
        result.to_bits()
    }
}

fn ordered(bits: u64) -> u64 {
    if bits >> 63 == 0 {
        bits | (1 << 63)
    } else {
        !bits
    }
}

#[test]
fn shared_vector_compares_candidate_provider_with_checked_ulp_bound() {
    // Four ULP is the release-reviewed ordinary-value limit, not an epsilon.
    // Record every distance, including zero, so artifact consumers can measure
    // what a provider swap changes rather than merely seeing a passing bound.
    const MAX_ORDINARY_ULP: u64 = 4;
    let mut report =
        String::from("function\targuments\tplatform\tpure_rust\tulp\tclassification\n");
    let mut failures = Vec::new();
    for (function, args) in vector() {
        let platform = guest_bits(function, &args);
        let pure = candidate(function, &args);
        let distance = ordered(platform).abs_diff(ordered(pure));
        let known_overflow = matches!(function, "acosh" | "asinh")
            && args == [f64::MAX.to_bits()]
            && platform == f64::INFINITY.to_bits();
        let class = if known_overflow {
            // The independently pinned 1D regression already records this
            // correctness defect. It is not a spec-mandated infinite result.
            assert!(f64::from_bits(pure).is_finite());
            assert!(
                pure.abs_diff(0x4086_33ce_8fb9_f87e) <= MAX_ORDINARY_ULP,
                "finite inverse hyperbolic at MAX stays near the rounded reference"
            );
            "known-platform-overflow"
        } else if function == "acosh"
            && args == [0x3ff0_0000_0000_0001]
            && platform == 0x3e56_a09e_67ff_ffff
        {
            // Cancellation in the current Darwin provider. Independent
            // 200-digit Decimal ln(x + sqrt(x*x - 1)) rounds to ...3bcc;
            // libm is one ULP away, while this platform is 25,216,051 away.
            assert!(pure.abs_diff(0x3e56_a09e_667f_3bcc) <= MAX_ORDINARY_ULP);
            "known-platform-cancellation"
        } else if !f64::from_bits(platform).is_finite()
            || !f64::from_bits(pure).is_finite()
            || f64::from_bits(platform) == 0.0
            || f64::from_bits(pure) == 0.0
            || args.iter().any(|bits| {
                let value = f64::from_bits(*bits);
                !value.is_finite() || value == 0.0
            })
            || matches!(function, "abs" | "ceil" | "floor" | "sqrt")
        {
            if platform != pure {
                failures.push(format!(
                    "exact {function}({args:x?}): {platform:016x} vs {pure:016x}"
                ));
            }
            "exact"
        } else {
            if distance > MAX_ORDINARY_ULP {
                failures.push(format!("{function}({args:x?}): {distance} ULP"));
            }
            "ordinary"
        };
        let args = args
            .iter()
            .map(|b| format!("{b:016x}"))
            .collect::<Vec<_>>()
            .join(",");
        writeln!(
            report,
            "{function}\t{args}\t{platform:016x}\t{pure:016x}\t{distance}\t{class}"
        )
        .unwrap();
    }
    if let Some(path) = std::env::var_os("IRONHORSE_PROVIDER_VECTOR") {
        std::fs::write(path, report).unwrap();
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
