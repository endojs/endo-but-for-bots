//! Programs that once stopped Ironhorse with a `NotImplemented` halt, each
//! against the pinned XS oracle (V8 agrees on each unless noted).
//!
//! A halt never agrees with an XS answer, so each of these failed before
//! its fix.

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

#[test]
fn a_symbol_coerced_to_a_string_or_number_throws() {
    for program in [
        "`${Symbol('a')}`",
        "`x${Object(Symbol())}y`",
        "String(Object(Symbol('w')))",
        "var s = Symbol(); s++",
        "var s = Symbol(); s--",
        "var s = Symbol(); ++s",
        "var s = Symbol(); --s",
        "var o = { p: Symbol() }; o.p++",
        "var a = [Symbol()]; a[0]--",
    ] {
        agrees(&format!(
            "try {{ {program}; 'ok' }} catch (e) {{ String(e) }}"
        ));
    }
    agrees("String(Symbol('described'))");
}

#[test]
fn deleting_a_super_reference_throws_after_the_reference_evaluates() {
    for program in [
        "class A { m() { delete super.x; } } new A().m()",
        "class A { m() { return delete super[1 + 1]; } } new A().m()",
        "class A { static m() { delete super.x; } } A.m()",
        "var o = { m() { return delete super.x; } }; Object.setPrototypeOf(o, null); o.m()",
        "var o = { m() { return delete super[0]; } }; Object.setPrototypeOf(o, null); o.m()",
        // The key is evaluated, not converted to a property key.
        "var log = ''; class A { m() { delete super[(log += 'k', { toString() { log += 's'; return 'x'; } })]; } } \
         try { new A().m(); } catch (e) { log += e.constructor.name; } throw log",
        // A derived constructor reads `this` first.
        "class A extends Object { constructor() { delete super.x; super(); } } new A()",
    ] {
        agrees(&format!(
            "try {{ {program}; 'ok' }} catch (e) {{ String(e) }}"
        ));
    }
}
