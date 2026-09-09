//! W6 C5: measure the guest Math surface, including its exact controls, without XS.
//! The artifact uses input/output IEEE-754 bits, never decimal result rendering.
use ironhorse_vm::{parse_symbols, Interp};
use std::fmt::Write;

const FUNCTIONS: &[&str] = &[
    "acos", "acosh", "asin", "asinh", "atan", "atanh", "cbrt", "cos", "cosh", "exp", "expm1",
    "log", "log1p", "log10", "log2", "sin", "sinh", "tan", "tanh", "atan2", "pow", "hypot", "abs",
    "ceil", "floor", "sqrt",
];

fn guest_bits(function: &str, arguments: &[u64]) -> u64 {
    // Construct arguments from bytes too: do not let decimal parsing become a
    // second variable in the provider comparison. Explicit big endian on both ends.
    let mut source = String::from("var d = new DataView(new ArrayBuffer(8));\n");
    for (i, bits) in arguments.iter().enumerate() {
        writeln!(
            source,
            "d.setUint32(0, {}); d.setUint32(4, {}); var a{i} = d.getFloat64(0);",
            bits >> 32,
            bits & 0xffff_ffff
        )
        .unwrap();
    }
    let args = (0..arguments.len())
        .map(|i| format!("a{i}"))
        .collect::<Vec<_>>()
        .join(",");
    writeln!(
        source,
        "d.setFloat64(0, Math.{function}({args})); d.getUint32(0) + ':' + d.getUint32(4)"
    )
    .unwrap();
    let (code, symbols) = ironhorse_compile::compile_atoms(&source).unwrap();
    let mut vm = Interp::new();
    vm.link_intrinsics(&parse_symbols(&symbols));
    let outcome = vm.run(&code);
    assert!(
        outcome.completed,
        "{function}({arguments:x?}): {:?}",
        outcome.halt
    );
    let (high, low) = outcome.result.split_once(':').unwrap();
    (high.parse::<u64>().unwrap() << 32) | low.parse::<u64>().unwrap()
}

fn vector() -> Vec<(&'static str, Vec<u64>)> {
    let inputs = [
        f64::NAN,
        0.0,
        -0.0,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::from_bits(1),
        f64::MAX,
        -1.0,
        1.0,
        -2.0,
        2.0,
        0.7,
        1.7,
        -0.7,
        1.0e-20,
        1.0e20,
        std::f64::consts::PI,
        f64::from_bits(1.0f64.to_bits() - 1),
        f64::from_bits(1.0f64.to_bits() + 1),
    ];
    let mut cases = Vec::new();
    for &function in FUNCTIONS {
        for input in inputs {
            let mut args = vec![input.to_bits()];
            if matches!(function, "atan2" | "pow" | "hypot") {
                args.push(1.3f64.to_bits());
            }
            cases.push((function, args));
        }
        if matches!(function, "atan2" | "pow" | "hypot") {
            for x in inputs[..11].iter() {
                for y in inputs[..11].iter() {
                    cases.push((function, vec![x.to_bits(), y.to_bits()]));
                }
            }
        }
    }
    cases.push(("hypot", vec![]));
    cases.push((
        "hypot",
        vec![3.0f64.to_bits(), 4.0f64.to_bits(), 12.0f64.to_bits()],
    ));
    cases
}

#[test]
fn platform_math_vector() {
    let mut report = String::from("function\targuments\tbits\n");
    for (function, arguments) in vector() {
        let bits = guest_bits(function, &arguments);
        if matches!(function, "abs" | "ceil" | "floor" | "sqrt") {
            let x = f64::from_bits(arguments[0]);
            let expected = match function {
                "abs" => x.abs(),
                "ceil" => x.ceil(),
                "floor" => x.floor(),
                "sqrt" => x.sqrt(),
                _ => unreachable!(),
            };
            let expected = if expected.is_nan() {
                0x7ff8_0000_0000_0000
            } else {
                expected.to_bits()
            };
            assert_eq!(bits, expected, "control {function}({arguments:x?})");
        }
        let args = arguments
            .iter()
            .map(|bits| format!("{bits:016x}"))
            .collect::<Vec<_>>()
            .join(",");
        writeln!(report, "{function}\t{args}\t{bits:016x}").unwrap();
    }
    // Optional export is observational: the test never regenerates expected values.
    if let Some(path) = std::env::var_os("IRONHORSE_MATH_VECTOR") {
        std::fs::write(path, report).unwrap();
    }
}

fn fixture_cases(text: &str) -> impl Iterator<Item = Vec<&str>> {
    text.lines()
        .filter(|line| !line.starts_with('#'))
        .map(|line| line.split('\t').collect())
}

fn argument_bits(text: &str) -> Vec<u64> {
    if text.is_empty() {
        return Vec::new();
    }
    text.split(',')
        .map(|bits| u64::from_str_radix(bits, 16).unwrap())
        .collect()
}

#[test]
fn known_answers_are_bit_exact_and_neighbour_distinct() {
    let rows: Vec<_> = fixture_cases(include_str!("fixtures/math-known.tsv")).collect();
    assert_eq!(rows.len(), 22);
    let mut expected_values = std::collections::BTreeSet::new();
    for (i, row) in rows.iter().enumerate() {
        assert_eq!(
            row[0], FUNCTIONS[i],
            "every provider-sensitive function has one probe"
        );
        let expected = u64::from_str_radix(row[2], 16).unwrap();
        assert!(
            expected_values.insert(expected),
            "coincident known answers: {}",
            row[0]
        );
        let mut args = argument_bits(row[1]);
        assert_eq!(guest_bits(row[0], &args), expected, "{}", row[0]);
        // Check the actual neighbour rule at EACH chosen input, not just
        // distinct results at unrelated inputs. Unary Math ignores argument 2.
        if args.len() == 1 {
            args.push(1.3f64.to_bits());
        }
        for other in &FUNCTIONS[..22] {
            if *other != row[0] {
                assert_ne!(
                    guest_bits(other, &args),
                    expected,
                    "{} miswired to {other} would escape at {args:x?}",
                    row[0]
                );
            }
        }
    }
}

#[test]
fn special_values_and_domain_boundary_observations_are_bit_exact() {
    // See ECMA-262 §21.3.2. All results use canonical NaN bits and preserve
    // signed zero. Captured boundary pins describe current behavior; they do
    // not establish correctness. acosh(MAX) and asinh(MAX) currently overflow
    // to infinity, tracked by the explicit ignored regression below. MAX/subnormal inputs are not
    // generally spec-mandated exact outputs: tan(MAX) currently differs by an
    // ULP between platforms, recorded explicitly rather than hidden by epsilon.
    // https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-math-object
    let mut covered = std::collections::BTreeSet::new();
    for row in fixture_cases(include_str!("fixtures/math-boundaries.tsv")) {
        assert_eq!(row.len(), 4);
        let args = argument_bits(row[1]);
        assert!(
            covered.insert((row[0], args.clone())),
            "duplicate boundary case"
        );
        let expected = row[if cfg!(target_os = "macos") { 3 } else { 2 }];
        assert_eq!(
            guest_bits(row[0], &args),
            u64::from_str_radix(expected, 16).unwrap(),
            "{}({:x?})",
            row[0],
            args
        );
    }
    assert_eq!(
        covered.len(),
        522,
        "review boundary coverage when changing the fixture"
    );
    for &function in FUNCTIONS {
        for input in [
            f64::NAN,
            0.0,
            -0.0,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::from_bits(1),
            f64::MAX,
        ] {
            let mut args = vec![input.to_bits()];
            if matches!(function, "atan2" | "pow" | "hypot") {
                args.push(1.3f64.to_bits());
            }
            assert!(
                covered.contains(&(function, args)),
                "missing {function} boundary {input:?}"
            );
        }
    }
    let nan = 0x7ff8_0000_0000_0000;
    for function in &FUNCTIONS[..19] {
        assert_eq!(guest_bits(function, &[f64::NAN.to_bits()]), nan);
    }
    for function in [
        "asin", "asinh", "atan", "atanh", "cbrt", "expm1", "log1p", "sin", "sinh", "tan", "tanh",
    ] {
        for zero in [0.0f64, -0.0] {
            assert_eq!(
                guest_bits(function, &[zero.to_bits()]),
                zero.to_bits(),
                "{function} sign of zero"
            );
        }
    }
    for (function, input, expected) in [
        ("acos", 1.0f64, 0.0f64.to_bits()),
        ("acos", 2.0, nan),
        ("log", 0.0, f64::NEG_INFINITY.to_bits()),
        ("log", -1.0, nan),
        ("atanh", 1.0, f64::INFINITY.to_bits()),
        ("atanh", -1.0, f64::NEG_INFINITY.to_bits()),
    ] {
        assert_eq!(guest_bits(function, &[input.to_bits()]), expected);
    }
    for base in [1.0f64, -1.0] {
        for exponent in [f64::INFINITY, f64::NEG_INFINITY] {
            assert_eq!(
                guest_bits("pow", &[base.to_bits(), exponent.to_bits()]),
                nan
            );
        }
    }
    assert_eq!(guest_bits("hypot", &[]), 0.0f64.to_bits());
}

// Phase 2 must replace the overflowing provider in frozen interp.rs. Keep a
// runnable correctness test beside the observational pins, and remove those
// two Infinity pins when enabling it. Both exact results round to these bits.
#[test]
#[ignore = "Phase 2: acosh/asinh(MAX) overflow in the current provider; interp.rs is frozen"]
fn large_inverse_hyperbolics_have_finite_known_answers() {
    for function in ["acosh", "asinh"] {
        assert_eq!(
            guest_bits(function, &[f64::MAX.to_bits()]),
            0x4086_33ce_8fb9_f87e,
            "{function}(MAX)"
        );
    }
}
