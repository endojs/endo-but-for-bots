//! `XS_CODE_FOR_IN` over `null` or `undefined`: bit-exact agreement with the
//! pinned XS oracle, value and computrons.
//!
//! `fx_Enumerator` builds the enumerator and its result for a nullish operand
//! but lists no keys and has no first level to walk. Ironhorse charged such a
//! loop the whole creation cluster calibrated on an empty object, 1.5625 units
//! more than XS per loop: `for (var k in null);` cost 53 computrons where XS
//! charges 51. It now charges `FOR_IN_NULLISH_ENUMERATOR_METERING`.

use ironhorse_262::dual_run;

/// The program completes with the XS oracle's value and computrons.
/// `observables_agree` leaves costs advisory, so this compares them itself.
fn exact(source: &str) {
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert!(
        run.observables_agree() && run.ironhorse_computrons == run.oracle_computrons,
        "not exact: {source}\n  oracle_result={} ironhorse_result={}\n  oracle_computrons={} ironhorse_computrons={}\n  ironhorse_halt={:?}",
        run.oracle_result,
        run.ironhorse_result,
        run.oracle_computrons,
        run.ironhorse_computrons,
        run.ironhorse_halt,
    );
}

#[test]
fn a_nullish_for_in_meters_as_xs() {
    for operand in ["null", "undefined", "void 0", "(function () {})()"] {
        exact(&format!("for (var k in {operand}); 1"));
        exact(&format!("var n = 0; for (var k in {operand}) n++; n"));
    }
}

#[test]
fn repeated_nullish_loops_meter_as_xs() {
    // One loop's residual stays under a computron; these show it does not
    // accumulate into one.
    for loops in 1..=8 {
        exact(&"for (var k in null); ".repeat(loops));
        exact(&format!(
            "var o = null; var n = 0; for (var i = 0; i < {loops}; i++) for (var k in o) n++; n"
        ));
    }
    exact("function f(o) { var n = 0; for (var k in o) n++; return n; } [f(null), f(undefined), f({}), f(null)].join()");
}

#[test]
fn an_empty_object_or_array_still_meters_as_xs() {
    // The calibration the nullish weight is taken from.
    for operand in ["{}", "[]", "Object.create(null)"] {
        exact(&format!("for (var k in {operand}); 1"));
    }
}
