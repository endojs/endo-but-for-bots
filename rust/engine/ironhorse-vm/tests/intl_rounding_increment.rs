//! F079: decimal increment rounding must never overflow a bounded integer.
use ironhorse_vm::{parse_symbols, Interp};

fn evaluate(source: &str) -> String {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    let mut vm = Interp::new();
    vm.link_intrinsics(&parse_symbols(&symbols));
    let outcome = vm.run(&code);
    assert!(outcome.completed, "{:?}", outcome.halt);
    outcome.result
}

#[test]
fn large_increment_rounding_formats_without_overflow() {
    for value in [1e38, 1e300, f64::MAX, -1e300, -f64::MAX] {
        // These binary64 magnitudes are exact integers divisible by five only
        // after the decimal fraction scaling; increment 5 at two places leaves
        // every integer unchanged. Rust fixed formatting supplies the exact
        // integer digits independently of the VM's decimal conversion.
        let source = format!("new Intl.NumberFormat('en', {{useGrouping:false,roundingIncrement:5,minimumFractionDigits:2,maximumFractionDigits:2}}).format({value:e})");
        assert_eq!(evaluate(&source), format!("{value:.2}"));
    }
}

#[test]
fn increment_rounding_uses_original_fraction_and_tie_parity() {
    for (mode, positive, negative) in [
        ("ceil", "1.25", "-1.00"),
        ("floor", "1.00", "-1.25"),
        ("expand", "1.25", "-1.25"),
        ("trunc", "1.00", "-1.00"),
        ("halfCeil", "1.25", "-1.00"),
        ("halfFloor", "1.00", "-1.25"),
        ("halfExpand", "1.25", "-1.25"),
        ("halfTrunc", "1.00", "-1.00"),
        ("halfEven", "1.00", "-1.00"),
    ] {
        let source = format!("var f = new Intl.NumberFormat('en', {{useGrouping:false,roundingMode:'{mode}',roundingIncrement:25,minimumFractionDigits:2,maximumFractionDigits:2}}); f.format(1.125) + ':' + f.format(-1.125)");
        assert_eq!(
            evaluate(&source),
            format!("{positive}:{negative}"),
            "{mode}"
        );
    }
    for (value, expected) in [
        (1.124, "1.00"),
        (1.126, "1.25"),
        (1.375, "1.50"),
        (0.001, "0.00"),
    ] {
        let source = format!("new Intl.NumberFormat('en', {{roundingMode:'halfEven',roundingIncrement:25,minimumFractionDigits:2,maximumFractionDigits:2}}).format({value})");
        assert_eq!(evaluate(&source), expected);
    }
}

#[test]
fn even_increment_keeps_fraction_above_the_integer_halfway_point() {
    for (value, expected) in [
        (1.0625, "1.00"),
        (1.125, "1.20"),
        (1.09375, "1.00"),
        (1.1015625, "1.20"),
    ] {
        let source = format!("new Intl.NumberFormat('en', {{roundingMode:'halfEven',roundingIncrement:20,minimumFractionDigits:2,maximumFractionDigits:2}}).format({value})");
        assert_eq!(evaluate(&source), expected);
    }
}

#[test]
fn large_integer_carry_and_borrow() {
    // Independent pins: f64::MAX = (2^53 - 1) * 2^971. Integer division
    // by 5000 gives the lower multiple; adding 5000 gives the upper one.
    let lower = "179769313486231570814527423731704356798070567525844996598917476803157260780028538760589558632766878171540458953514382464234321326889464182768467546703537516986049910576551282076245490090389328944075868508455133942304583236903222948165808559332123348274797826204144723168738177180919299881250404026184124855000";
    let upper = "179769313486231570814527423731704356798070567525844996598917476803157260780028538760589558632766878171540458953514382464234321326889464182768467546703537516986049910576551282076245490090389328944075868508455133942304583236903222948165808559332123348274797826204144723168738177180919299881250404026184124860000";
    for (mode, expected) in [("floor", lower), ("ceil", upper)] {
        let source = format!("new Intl.NumberFormat('en', {{useGrouping:false,roundingMode:'{mode}',roundingIncrement:5000,maximumFractionDigits:0}}).format(Number.MAX_VALUE)");
        assert_eq!(evaluate(&source), expected);
    }
}
