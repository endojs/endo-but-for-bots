//! `XS_CODE_FOR_IN` over `null`, `undefined` and the other operand kinds:
//! the same completion and value as the pinned XS oracle. The oracle gates
//! results only; XS-computron parity is a non-goal (`README.md` § "Metering
//! objective"), so the computrons in a failure message are diagnostics.
//!
//! Provenance of the nullish weight: `fx_Enumerator` builds the enumerator
//! and its result for a nullish operand but lists no keys and has no first
//! level to walk. Ironhorse charged such a loop the whole creation cluster
//! calibrated on an empty object, which counts an own-keys collection it
//! does not do, so `ironhorse-meter-6` charges
//! `FOR_IN_NULLISH_ENUMERATOR_METERING` instead. Its size was taken from
//! XS's count at the time; the oracle-free `for-in-nullish` row of
//! `ironhorse-vm/tests/fixtures/computrons.tsv` pins Ironhorse's own cost,
//! and the `for-in-primitive` and `for-in-proxy` rows pin the other operand
//! kinds below.

use ironhorse_262::dual_run;

/// The program completes with the XS oracle's completion and value.
fn agrees(source: &str) {
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert!(
        run.observables_agree(),
        "observable divergence: {source}\n  oracle_result={} ironhorse_result={}\n  oracle_computrons={} ironhorse_computrons={}\n  ironhorse_halt={:?}",
        run.oracle_result,
        run.ironhorse_result,
        run.oracle_computrons,
        run.ironhorse_computrons,
        run.ironhorse_halt,
    );
}

#[test]
fn a_nullish_for_in_runs_no_body() {
    for operand in ["null", "undefined", "void 0", "(function () {})()"] {
        agrees(&format!("for (var k in {operand}); 1"));
        agrees(&format!("var n = 0; for (var k in {operand}) n++; n"));
    }
}

#[test]
fn repeated_nullish_loops_agree() {
    for loops in 1..=8 {
        agrees(&"for (var k in null); ".repeat(loops));
        agrees(&format!(
            "var o = null; var n = 0; for (var i = 0; i < {loops}; i++) for (var k in o) n++; n"
        ));
    }
    agrees("function f(o) { var n = 0; for (var k in o) n++; return n; } [f(null), f(undefined), f({}), f(null)].join()");
}

#[test]
fn an_empty_object_or_array_runs_no_body() {
    for operand in ["{}", "[]", "Object.create(null)"] {
        agrees(&format!("var n = 0; for (var k in {operand}) n++; n"));
    }
}

#[test]
fn other_operands_enumerate_as_xs() {
    // An object with no prototype, a TypedArray, a Proxy, and primitives
    // boxed by ToObject.
    for operand in [
        "Object.create(null)",
        "new Uint8Array(2)",
        "new Proxy(Object.create(null), {})",
        "new Proxy({ a: 1, b: 2 }, {})",
        "Object('ab')",
        "''",
        "'ab'",
        "Symbol()",
        "1n",
        "true",
        "1",
    ] {
        agrees(&format!(
            "var ks = []; for (var k in {operand}) ks.push(k); ks.join()"
        ));
    }
}
