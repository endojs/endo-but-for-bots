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
//! instead; the PR that added a table lists those departures.
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
