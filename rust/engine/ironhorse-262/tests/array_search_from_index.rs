//! `fromIndex` in `indexOf`, `lastIndexOf` and `includes`, on a dense array
//! and on a TypedArray, against the pinned XS oracle (V8 agrees on each).
//!
//! The dense array paths never read the argument (`indexOf`,
//! `lastIndexOf`) or read only a Number (`includes`), so
//! `[1, 2, 3].indexOf(1, 1)` was 0 and `[1, 2, 3].includes(1, true)` was
//! `true`. They now honour a Number and leave every other kind to the
//! generic path, which coerces it and still scans to the length it read
//! first. TypedArray `indexOf` and `lastIndexOf` matched `undefined` in a
//! buffer the coercion detached, where HasProperty is false.

use ironhorse_262::dual_run;

fn agrees(source: &str) {
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert!(
        run.observables_agree(),
        "observable divergence: {source}\n  oracle={} ironhorse={}\n  ironhorse_halt={:?}",
        run.oracle_result,
        run.ironhorse_result,
        run.ironhorse_halt,
    );
}

/// Every `fromIndex` kind, absent and present, through every search method
/// on arrays with repeated elements, a hole and a NaN.
#[test]
fn every_from_index_kind_agrees_on_a_dense_array() {
    let from = "[undefined, null, true, false, 0, -0, 1, 1.9, -1, -1.5, 2, 3, 4, -3, -4, 2**32, -(2**32), \
                Infinity, -Infinity, NaN, '1', '-1', '', 'x', [], [2], {}, \
                { valueOf: function () { return 1; } }, { toString: function () { return '-2'; } }]";
    for method in ["indexOf", "lastIndexOf", "includes"] {
        for array in ["[1, 2, 1, 3]", "[NaN, 1, NaN]", "[]", "[undefined, 1]"] {
            for target in ["1", "NaN", "undefined", "3"] {
                agrees(&format!(
                    "var f = {from}; var out = [{array}.{method}({target})]; \
                     for (var i = 0; i < f.length; i++) out.push({array}.{method}({target}, f[i])); \
                     out.join()"
                ));
            }
        }
    }
}

#[test]
fn an_abrupt_from_index_throws_from_every_search() {
    for method in ["indexOf", "lastIndexOf", "includes"] {
        for value in [
            "Symbol()",
            "1n",
            "{ valueOf: function () { throw new RangeError('v'); } }",
        ] {
            agrees(&format!(
                "try {{ [1].{method}(1, {value}); 'none' }} catch (e) {{ e.constructor.name }}"
            ));
        }
        // An empty array returns before coercing.
        agrees(&format!(
            "var log = []; [[].{method}(1, {{ valueOf: function () {{ log.push('v'); return 0; }} }}), log.length].join()"
        ));
    }
}

#[test]
fn a_coercion_that_resizes_the_array_scans_the_length_read_first() {
    for method in ["indexOf", "lastIndexOf", "includes"] {
        for (mutation, start) in [
            ("a.length = 2", "0"),
            ("a.length = 1", "3"),
            ("a.push(4, 4)", "0"),
            ("a.pop()", "-1"),
            ("delete a[1]", "0"),
            (
                "Object.defineProperty(Array.prototype, 1, { value: 4, configurable: true })",
                "0",
            ),
        ] {
            for target in ["4", "undefined", "2"] {
                agrees(&format!(
                    "var a = [1, 2, 3, 4]; var log = []; \
                     var r = a.{method}({target}, {{ valueOf: function () {{ log.push('v'); {mutation}; return {start}; }} }}); \
                     delete Array.prototype[1]; [r, log.join(), a.length].join()"
                ));
            }
        }
    }
}

#[test]
fn a_detached_typed_array_has_no_elements_for_index_of() {
    for method in ["indexOf", "lastIndexOf", "includes"] {
        for start in ["0", "3", "-1"] {
            for (constructor, zero) in [
                ("Float64Array", "0"),
                ("Int8Array", "0"),
                ("BigInt64Array", "0n"),
            ] {
                for target in ["undefined", zero] {
                    agrees(&format!(
                        "var ta = new {constructor}(4); \
                         ta.{method}({target}, {{ valueOf: function () {{ ta.buffer.transfer(); return {start}; }} }})"
                    ));
                }
            }
        }
    }
}
