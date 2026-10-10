//! Number.prototype's digit formatting methods.
//!
//! `toFixed`, `toExponential` and `toPrecision` were missing. They round the
//! exact binary value, a tie to the larger digits (ES2024 21.1.3.2, .3, .5),
//! and XS agrees in all but two places: `(±0.5).toFixed(0)` is `0`/`-0` there,
//! and some `toPrecision` results lose trailing zeros. Those cases follow the
//! specification, as V8 does.
//!
//! Each case runs on its own machine. Every expectation is the XS oracle's
//! answer, except where a case says the specification (and V8) is followed
//! instead; `ironhorse-262/tests/xs_departures.rs` records those departures.
mod common;
use common::TestCompiler;

use ironhorse_vm::{parse_symbols, Interp};

fn run(source: &str) -> String {
    let source = source.to_string();
    std::thread::Builder::new()
        .stack_size(ironhorse_vm::NATIVE_STACK_BYTES)
        .spawn(move || {
            let (code, symbols) = ironhorse_compile::compile_atoms(&source).unwrap();
            let mut machine = Interp::new();
            machine.set_source_compiler(std::rc::Rc::new(TestCompiler));
            machine.link_intrinsics(&parse_symbols(&symbols));
            let outcome = machine.run(&code);
            assert!(outcome.completed, "{:?}\n  {source}", outcome.halt);
            outcome.result
        })
        .unwrap()
        .join()
        .unwrap()
}

fn check(cases: &[(&str, &str, &str)]) {
    for (name, source, expected) in cases {
        assert_eq!(run(source), *expected, "{name}: {source}");
    }
}

#[test]
fn to_fixed_rounds_the_exact_value() {
    check(&[
        (
            "agrees_with_xs",
            r#"[(123.456).toFixed(2), (1.005).toFixed(2), (0.1).toFixed(20), (1e20).toFixed(2), (1e21).toFixed(2), (-1.5e-7).toFixed(3), (-0).toFixed(2), (NaN).toFixed(2), (-Infinity).toFixed(1), (5e-324).toFixed(100).length, (1.45).toFixed(1), (8.345).toFixed(2)].join(' ')"#,
            r#"123.46 1.00 0.10000000000000000555 100000000000000000000.00 1e+21 -0.000 0.00 NaN -Infinity 102 1.4 8.35"#,
        ),
        (
            "ties_take_the_larger_digits",
            r#"[(1.5).toFixed(0), (2.5).toFixed(0), (-2.5).toFixed(0), (-1.5).toFixed(0), (0.125).toFixed(2), (0.375).toFixed(2), (99.5).toFixed(0), (999.995).toFixed(2), (-0.5).toFixed(1)].join(' ')"#,
            r#"2 3 -3 -2 0.13 0.38 100 1000.00 -0.5"#,
        ),
        // The specification, as V8; XS answers `0 -0`.
        (
            "a_half_to_no_places",
            r#"[(0.5).toFixed(0), (-0.5).toFixed(0)].join(' ')"#,
            r#"1 -1"#,
        ),
        (
            "wrappers_and_arguments",
            r#"[new Number(4.5).toFixed(1), (4.25).toFixed('1'), (4.25).toFixed(1.9), (4.25).toFixed(), (4.25).toFixed(undefined), (4.25).toFixed(null), (4.25).toFixed(NaN)].join(' ')"#,
            r#"4.5 4.3 4.3 4 4 4 4"#,
        ),
    ]);
}

#[test]
fn to_exponential_and_to_precision() {
    check(&[
        (
            "to_exponential",
            r#"[(123456).toExponential(), (123456).toExponential(2), (0.00015).toExponential(1), (0).toExponential(3), (-0).toExponential(), (5e-324).toExponential(), (1.7976931348623157e308).toExponential(5), (Infinity).toExponential(1000), (NaN).toExponential(-5)].join(' ')"#,
            r#"1.23456e+5 1.23e+5 1.5e-4 0.000e+0 0e+0 5e-324 1.79769e+308 Infinity NaN"#,
        ),
        (
            "to_precision",
            r#"[(123456).toPrecision(2), (0.000001234).toPrecision(2), (0.0000001234).toPrecision(2), (0).toPrecision(3), (-0).toPrecision(1), (1e21).toPrecision(3), (123.456).toPrecision(), (Infinity).toPrecision(200), (5).toPrecision(1)].join(' ')"#,
            r#"1.2e+5 0.0000012 1.2e-7 0.00 0 1.00e+21 123.456 Infinity 5"#,
        ),
        (
            "to_precision_pads_with_zeros",
            r#"[(1).toPrecision(5), (100).toPrecision(5), (0).toPrecision(3), (1e-7).toPrecision(3)].join(' ')"#,
            r#"1.0000 100.00 0.00 1.00e-7"#,
        ),
        // The specification, as V8; XS answers `123456 12.0 1.500 123.5`.
        (
            "to_precision_keeps_trailing_zeros",
            r#"[(123456).toPrecision(7), (12).toPrecision(4), (1.5).toPrecision(5), (123.5).toPrecision(6)].join(' ')"#,
            r#"123456.0 12.00 1.5000 123.500"#,
        ),
        (
            "exponential_ties",
            r#"[(9.995).toExponential(2), (9.9999).toExponential(2), (1.25).toExponential(1), (1.35).toExponential(1), (0.5).toExponential(0), (2.5).toExponential(0)].join(' ')"#,
            r#"9.99e+0 1.00e+1 1.3e+0 1.4e+0 5e-1 3e+0"#,
        ),
        (
            "precision_ties",
            r#"[(99.95).toPrecision(3), (1.5).toPrecision(1), (2.5).toPrecision(1), (0.125).toPrecision(2)].join(' ')"#,
            r#"100 2 3 0.13"#,
        ),
    ]);
}

// The cases below are drawn from a sweep of 50 values through every digit
// count of the three methods (3,200 results), in which Ironhorse agrees with
// V8 everywhere and with XS outside the two departures above. Each case
// covers one class of that sweep: every digit count of one value, the
// magnitudes on either side of an exponent or notation boundary, and the
// last-place roundings and carries. XS and V8 give every answer here.

#[test]
fn to_fixed_across_digit_counts_and_magnitudes() {
    check(&[
        (
            "every_digit_count",
            r#"var r = []; for (var d = 0; d <= 20; d++) r.push((2 / 3).toFixed(d)); r.join(' ')"#,
            r#"1 0.7 0.67 0.667 0.6667 0.66667 0.666667 0.6666667 0.66666667 0.666666667 0.6666666667 0.66666666667 0.666666666667 0.6666666666667 0.66666666666667 0.666666666666667 0.6666666666666666 0.66666666666666663 0.666666666666666630 0.6666666666666666297 0.66666666666666662966"#,
        ),
        (
            "every_digit_count_negative",
            r#"var r = []; for (var d = 0; d <= 20; d++) r.push((-123.456).toFixed(d)); r.join(' ')"#,
            r#"-123 -123.5 -123.46 -123.456 -123.4560 -123.45600 -123.456000 -123.4560000 -123.45600000 -123.456000000 -123.4560000000 -123.45600000000 -123.456000000000 -123.4560000000000 -123.45600000000000 -123.456000000000003 -123.4560000000000031 -123.45600000000000307 -123.456000000000003070 -123.4560000000000030695 -123.45600000000000306954"#,
        ),
        (
            "small_magnitudes",
            r#"[1e-10, 1.5e-7, 7e-7, 1e-6, 0.000001234, 0.0005, 0.00049999, 5e-324].map(function (v) { return [0, 5, 7, 20].map(function (d) { return v.toFixed(d); }).join('/'); }).join(' ')"#,
            r#"0/0.00000/0.0000000/0.00000000010000000000 0/0.00000/0.0000001/0.00000015000000000000 0/0.00000/0.0000007/0.00000070000000000000 0/0.00000/0.0000010/0.00000100000000000000 0/0.00000/0.0000012/0.00000123400000000000 0/0.00050/0.0005000/0.00050000000000000001 0/0.00050/0.0005000/0.00049998999999999996 0/0.00000/0.0000000/0.00000000000000000000"#,
        ),
        (
            "large_magnitudes",
            r#"[123456789, 1e15, 1e20, 1e21, 1.7976931348623157e308].map(function (v) { return [0, 5, 20].map(function (d) { return v.toFixed(d); }).join('/'); }).join(' ')"#,
            r#"123456789/123456789.00000/123456789.00000000000000000000 1000000000000000/1000000000000000.00000/1000000000000000.00000000000000000000 100000000000000000000/100000000000000000000.00000/100000000000000000000.00000000000000000000 1e+21/1e+21/1e+21 1.7976931348623157e+308/1.7976931348623157e+308/1.7976931348623157e+308"#,
        ),
        (
            "the_last_place",
            r#"[[0.05, 1], [0.15, 1], [0.25, 1], [0.35, 1], [0.95, 1], [0.095, 2], [1.255, 2], [10.235, 2], [4.35, 1], [2.718281828459045, 15], [3.14159265358979, 13], [0.0005, 3], [7e-7, 6], [1.5e-7, 7]].map(function (p) { return p[0].toFixed(p[1]); }).join(' ')"#,
            r#"0.1 0.1 0.3 0.3 0.9 0.10 1.25 10.23 4.3 2.718281828459045 3.1415926535898 0.001 0.000001 0.0000001"#,
        ),
        (
            "carries",
            r#"[[999.5, 0], [99.95, 1], [9.5, 0], [0.95, 0], [0.095, 1], [9.995, 2], [1.5, 0], [2.5, 0], [-9.5, 0], [-999.5, 0]].map(function (p) { return p[0].toFixed(p[1]); }).join(' ')"#,
            r#"1000 100.0 10 1 0.1 9.99 2 3 -10 -1000"#,
        ),
    ]);
}

#[test]
fn to_exponential_across_digit_counts_and_magnitudes() {
    check(&[
        (
            "every_digit_count",
            r#"var r = []; for (var d = 0; d <= 20; d++) r.push((2 / 3).toExponential(d)); r.join(' ')"#,
            r#"7e-1 6.7e-1 6.67e-1 6.667e-1 6.6667e-1 6.66667e-1 6.666667e-1 6.6666667e-1 6.66666667e-1 6.666666667e-1 6.6666666667e-1 6.66666666667e-1 6.666666666667e-1 6.6666666666667e-1 6.66666666666667e-1 6.666666666666666e-1 6.6666666666666663e-1 6.66666666666666630e-1 6.666666666666666297e-1 6.6666666666666662966e-1 6.66666666666666629659e-1"#,
        ),
        (
            "every_digit_count_of_an_integer",
            r#"var r = []; for (var d = 0; d <= 20; d++) r.push((123456789).toExponential(d)); r.join(' ')"#,
            r#"1e+8 1.2e+8 1.23e+8 1.235e+8 1.2346e+8 1.23457e+8 1.234568e+8 1.2345679e+8 1.23456789e+8 1.234567890e+8 1.2345678900e+8 1.23456789000e+8 1.234567890000e+8 1.2345678900000e+8 1.23456789000000e+8 1.234567890000000e+8 1.2345678900000000e+8 1.23456789000000000e+8 1.234567890000000000e+8 1.2345678900000000000e+8 1.23456789000000000000e+8"#,
        ),
        (
            "shortest_digits",
            r#"[0, -0, 1, -1, 0.5, 1.5, 2.5, 0.05, 0.15, 0.25, 0.35, 1.005, 1.255, 123.456, 999.5, 9.995, 1e-7, 1.5e-7, 1e-10, 123456789, 1e15, 1e20, 1e21, 5e-324, 1.7976931348623157e308].map(function (v) { return v.toExponential(); }).join(' ')"#,
            r#"0e+0 0e+0 1e+0 -1e+0 5e-1 1.5e+0 2.5e+0 5e-2 1.5e-1 2.5e-1 3.5e-1 1.005e+0 1.255e+0 1.23456e+2 9.995e+2 9.995e+0 1e-7 1.5e-7 1e-10 1.23456789e+8 1e+15 1e+20 1e+21 5e-324 1.7976931348623157e+308"#,
        ),
        (
            "more_shortest_digits",
            r#"[0.1, 0.2, 0.3, 2 / 3, 1 / 3, 4.35, 8.345, 10.235, 1.45, 99.95, 0.000001234, 12345.6789, -123.456, 7e-7, 25, 35, 45, 0.0005, 0.00049999, 3.14159265358979, 2.718281828459045, 1e-6, 9.5, 0.95, 0.095].map(function (v) { return v.toExponential(); }).join(' ')"#,
            r#"1e-1 2e-1 3e-1 6.666666666666666e-1 3.333333333333333e-1 4.35e+0 8.345e+0 1.0235e+1 1.45e+0 9.995e+1 1.234e-6 1.23456789e+4 -1.23456e+2 7e-7 2.5e+1 3.5e+1 4.5e+1 5e-4 4.9999e-4 3.14159265358979e+0 2.718281828459045e+0 1e-6 9.5e+0 9.5e-1 9.5e-2"#,
        ),
        (
            "extremes",
            r#"[5e-324, 1.7976931348623157e308, 1e21, 1e-10, 1e-6, -0].map(function (v) { return [0, 1, 5, 16, 20].map(function (d) { return v.toExponential(d); }).join('/'); }).join(' ')"#,
            r#"5e-324/4.9e-324/4.94066e-324/4.9406564584124654e-324/4.94065645841246544177e-324 2e+308/1.8e+308/1.79769e+308/1.7976931348623157e+308/1.79769313486231570815e+308 1e+21/1.0e+21/1.00000e+21/1.0000000000000000e+21/1.00000000000000000000e+21 1e-10/1.0e-10/1.00000e-10/1.0000000000000000e-10/1.00000000000000003643e-10 1e-6/1.0e-6/1.00000e-6/9.9999999999999995e-7/9.99999999999999954748e-7 0e+0/0.0e+0/0.00000e+0/0.0000000000000000e+0/0.00000000000000000000e+0"#,
        ),
        (
            "the_last_place_and_carries",
            r#"[[999.5, 2], [0.95, 0], [0.095, 0], [9.5, 0], [25, 0], [35, 0], [45, 0], [1.005, 2], [1.255, 2], [4.35, 1], [10.235, 3], [99.95, 2], [0.0005, 0], [0.00049999, 0], [123.456, 1], [-123.456, 4]].map(function (p) { return p[0].toExponential(p[1]); }).join(' ')"#,
            r#"1.00e+3 9e-1 1e-1 1e+1 3e+1 4e+1 5e+1 1.00e+0 1.25e+0 4.3e+0 1.023e+1 1.00e+2 5e-4 5e-4 1.2e+2 -1.2346e+2"#,
        ),
    ]);
}

#[test]
fn to_precision_across_precisions_and_magnitudes() {
    check(&[
        (
            "every_precision",
            r#"var r = []; for (var p = 1; p <= 20; p++) r.push((1 / 3).toPrecision(p)); r.join(' ')"#,
            r#"0.3 0.33 0.333 0.3333 0.33333 0.333333 0.3333333 0.33333333 0.333333333 0.3333333333 0.33333333333 0.333333333333 0.3333333333333 0.33333333333333 0.333333333333333 0.3333333333333333 0.33333333333333331 0.333333333333333315 0.3333333333333333148 0.33333333333333331483"#,
        ),
        (
            "exponential_until_the_precision_holds_the_integer",
            r#"var r = []; for (var p = 1; p <= 9; p++) r.push((123456789).toPrecision(p)); r.join(' ')"#,
            r#"1e+8 1.2e+8 1.23e+8 1.235e+8 1.2346e+8 1.23457e+8 1.234568e+8 1.2345679e+8 123456789"#,
        ),
        (
            "every_precision_of_a_power_of_ten",
            r#"var r = []; for (var p = 1; p <= 20; p++) r.push((1e15).toPrecision(p)); r.join(' ')"#,
            r#"1e+15 1.0e+15 1.00e+15 1.000e+15 1.0000e+15 1.00000e+15 1.000000e+15 1.0000000e+15 1.00000000e+15 1.000000000e+15 1.0000000000e+15 1.00000000000e+15 1.000000000000e+15 1.0000000000000e+15 1.00000000000000e+15 1000000000000000 1000000000000000.0 1000000000000000.00 1000000000000000.000 1000000000000000.0000"#,
        ),
        // A millionth is the smallest magnitude written without an exponent.
        // The double nearest 1e-6 lies just below it, which shows from 17
        // digits on, and those take an exponent.
        (
            "every_precision_of_a_millionth",
            r#"var r = []; for (var p = 1; p <= 20; p++) r.push((1e-6).toPrecision(p)); r.join(' ')"#,
            r#"0.000001 0.0000010 0.00000100 0.000001000 0.0000010000 0.00000100000 0.000001000000 0.0000010000000 0.00000100000000 0.000001000000000 0.0000010000000000 0.00000100000000000 0.000001000000000000 0.0000010000000000000 0.00000100000000000000 0.000001000000000000000 9.9999999999999995e-7 9.99999999999999955e-7 9.999999999999999547e-7 9.9999999999999995475e-7"#,
        ),
        (
            "around_a_millionth",
            r#"[[7e-7, 1], [7e-7, 3], [1e-7, 2], [0.000001234, 1], [0.000001234, 4], [1.5e-7, 17], [1e-10, 18], [0.0005, 17], [0.05, 5]].map(function (p) { return p[0].toPrecision(p[1]); }).join(' ')"#,
            r#"7e-7 7.00e-7 1.0e-7 0.000001 0.000001234 1.4999999999999999e-7 1.00000000000000004e-10 0.00050000000000000001 0.050000"#,
        ),
        (
            "extremes",
            r#"[5e-324, 1.7976931348623157e308, 1e20, 1e21, 0, -0, -1].map(function (v) { return [1, 2, 5, 17, 20].map(function (p) { return v.toPrecision(p); }).join('/'); }).join(' ')"#,
            r#"5e-324/4.9e-324/4.9407e-324/4.9406564584124654e-324/4.9406564584124654418e-324 2e+308/1.8e+308/1.7977e+308/1.7976931348623157e+308/1.7976931348623157081e+308 1e+20/1.0e+20/1.0000e+20/1.0000000000000000e+20/1.0000000000000000000e+20 1e+21/1.0e+21/1.0000e+21/1.0000000000000000e+21/1.0000000000000000000e+21 0/0.0/0.0000/0.0000000000000000/0.0000000000000000000 0/0.0/0.0000/0.0000000000000000/0.0000000000000000000 -1/-1.0/-1.0000/-1.0000000000000000/-1.0000000000000000000"#,
        ),
        (
            "the_last_place_and_carries",
            r#"[[0.15, 1], [0.25, 1], [0.25, 2], [0.35, 1], [0.35, 2], [999.5, 3], [999.5, 4], [9.995, 3], [9.995, 4], [0.95, 1], [0.95, 2], [0.095, 1], [0.095, 2], [25, 1], [35, 1], [45, 1], [9.5, 1], [9.5, 2], [12345.6789, 4], [12345.6789, 5], [12345.6789, 9], [2 / 3, 17], [0.00049999, 4], [0.00049999, 5], [1.005, 3], [1.005, 4], [8.345, 3], [8.345, 4], [10.235, 4], [10.235, 5], [99.95, 4]].map(function (p) { return p[0].toPrecision(p[1]); }).join(' ')"#,
            r#"0.1 0.3 0.25 0.3 0.35 1.00e+3 999.5 9.99 9.995 0.9 0.95 0.1 0.095 3e+1 4e+1 5e+1 1e+1 9.5 1.235e+4 12346 12345.6789 0.66666666666666663 0.0005000 0.00049999 1.00 1.005 8.35 8.345 10.23 10.235 99.95"#,
        ),
    ]);
}

#[test]
fn errors_and_their_order() {
    check(&[
        (
            "range",
            r#"var r = []; [[1, 'toFixed', 101], [1, 'toFixed', -1], [1, 'toFixed', Infinity], [1, 'toExponential', 101], [1, 'toPrecision', 0], [1, 'toPrecision', 101]].forEach(function (c) { try { r.push(c[0][c[1]](c[2])); } catch (e) { r.push(e.constructor.name + ':' + e.message); } }); r.join()"#,
            r#"RangeError:invalid fractionDigits,RangeError:invalid fractionDigits,RangeError:invalid fractionDigits,RangeError:invalid fractionDigits,RangeError:invalid precision,RangeError:invalid precision"#,
        ),
        (
            "this_not_a_number",
            r#"var r = []; ['toFixed', 'toExponential', 'toPrecision'].forEach(function (k) { try { Number.prototype[k].call('1', 1); } catch (e) { r.push(e.constructor.name + ':' + e.message); } }); r.join()"#,
            r#"TypeError:this: not a number,TypeError:this: not a number,TypeError:this: not a number"#,
        ),
        (
            "argument_runs_first",
            r#"var log = []; var arg = {valueOf: function () { log.push('v'); return 1; }}; [(Infinity).toFixed(arg), (NaN).toExponential(arg), (Infinity).toPrecision(arg), log.length].join()"#,
            r#"Infinity,NaN,Infinity,3"#,
        ),
        (
            "this_before_argument",
            r#"var log = []; try { Number.prototype.toFixed.call({}, {valueOf: function () { log.push('v'); return 1; }}); } catch (e) { log.push(e.constructor.name); } log.join()"#,
            r#"TypeError"#,
        ),
    ]);
}
