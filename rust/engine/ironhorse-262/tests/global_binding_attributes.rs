//! `CreateGlobalVarBinding` / `CreateGlobalFunctionBinding` take `D` as the
//! created global property's `configurable` attribute, and the three ways a
//! name reaches the global object do not share one answer:
//!
//! * a **Script**'s top-level `var`/function declaration —
//!   GlobalDeclarationInstantiation passes `D = false`, so the property is
//!   non-configurable and cannot be deleted;
//! * an **eval**'s `var`/function declaration — EvalDeclarationInstantiation
//!   passes `D = true` for direct *and* indirect eval, so it stays deletable;
//! * an unqualified assignment (`x = 1`), which is not a declaration at all and
//!   creates an ordinary configurable data property.
//!
//! The Script direction is pinned in
//! `ironhorse-vm/tests/hardened_js_boundary.rs`, which needs no source
//! compiler. The **eval** direction lives here because it needs the runtime
//! source bridge, and it is dual-run so the pinned XS oracle certifies it: XS
//! and node agree that an eval-created global var is deletable, so getting the
//! Script direction right must not drag the eval direction along with it.

use ironhorse_262::{dual_run, Agreement};

fn assert_result_agrees(source: &str) {
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(
        run.agreement,
        Agreement::BothComplete,
        "`{source}` must complete on both engines (ironhorse halt: {:?}; oracle={:?} ironhorse={:?})",
        run.ironhorse_halt,
        run.oracle_result,
        run.ironhorse_result,
    );
    assert!(
        run.result_agrees,
        "`{source}` result divergence: oracle={:?} ironhorse={:?}",
        run.oracle_result, run.ironhorse_result,
    );
}

/// A member access performs `RequireObjectCoercible`, so reading a property
/// through `undefined`/`null` is a `TypeError`, never `undefined`. This is
/// what the test262 property helpers rely on —
/// `verifyEnumerable` reads `Object.getOwnPropertyDescriptor(obj, name)
/// .enumerable`, which must abort when the property is missing rather than
/// carry on to a misleading assertion failure.
#[test]
fn reading_a_property_through_undefined_or_null_throws() {
    for source in [
        "var r='no'; try { undefined.enumerable } catch (e) { r = e.constructor.name } r",
        "var r='no'; try { null.foo } catch (e) { r = e.constructor.name } r",
        // The helper shape itself: a missing property's descriptor is
        // `undefined`, so reading through it aborts.
        "var r='no'; try { Object.getOwnPropertyDescriptor({a:1},'nope').enumerable } \
         catch (e) { r = e.constructor.name } r",
        "var r='no'; try { Object.getOwnPropertyDescriptor(globalThis,'absentXyz').enumerable } \
         catch (e) { r = e.constructor.name } r",
        // The primitives that box still box rather than throwing. (A boolean
        // primitive does not box to `%Boolean.prototype%` on Ironhorse yet —
        // a separate pre-existing gap in the same match, untouched here, so
        // `true.toString()` is deliberately not asserted.)
        "'abc'.length",
        "(42).toString(2)",
        "(1n).toString()",
        // And an ordinary object read is untouched.
        "var o = {a: 1}; o.a",
        "var o = {a: 1}; typeof o.missing",
    ] {
        assert_result_agrees(source);
    }
}

/// An eval-created global binding keeps `D = true`: configurable, deletable.
/// Both eval forms, both strictness contexts for the *calling* program, and
/// function declarations as well as `var`.
#[test]
fn an_eval_created_global_binding_stays_configurable() {
    for source in [
        "(0,eval)('var e = 1;'); delete globalThis.e",
        "eval('var e = 1;'); delete globalThis.e",
        "(0,eval)('var e = 1;'); Object.getOwnPropertyDescriptor(globalThis,'e').configurable",
        "(0,eval)('function ef(){}'); delete globalThis.ef",
        // A strict *caller* does not make the eval's binding non-deletable: the
        // `D` argument comes from EvalDeclarationInstantiation, not the caller.
        "'use strict'; (0,eval)('var e = 1;'); delete globalThis.e",
        "'use strict'; eval('var e = 1;'); delete globalThis.e",
        // An eval nested inside a Script that also declares its own global.
        "var s = 1; (0,eval)('var e = 2;'); delete globalThis.e",
    ] {
        assert_result_agrees(source);
    }
}

/// The Script direction is a **divergence** from the pinned oracle, at either
/// strictness, and the oracle therefore cannot certify it. Because the shim
/// runs every source with the `eval` builtin's flags, the `D` it passes is
/// `true`, so even a *sloppy* Script's top-level `var` is deletable on the
/// oracle where ECMA-262 (and node) make it non-deletable. Pin both sides so
/// the divergence is recorded rather than hidden; the values themselves are
/// pinned oracle-free in `ironhorse-vm/tests/hardened_js_boundary.rs`.
#[test]
fn the_script_declared_global_attribute_diverges_from_the_eval_framed_oracle() {
    for (source, ironhorse, oracle) in [
        ("var g = 1; delete globalThis.g", "false", "true"),
        (
            "var g = 1; Object.getOwnPropertyDescriptor(globalThis,'g').configurable",
            "false",
            "true",
        ),
        ("function f(){} delete globalThis.f", "false", "true"),
        // Declaration instantiation runs before any statement, so the `var y`
        // binding is created (non-configurable) first and the assignment merely
        // writes it — the property is not the configurable one an unqualified
        // assignment would have made. Node agrees with Ironhorse's `false`.
        ("y = 1; var y; delete globalThis.y", "false", "true"),
    ] {
        let run = dual_run(source).expect("the XS oracle machine must start");
        assert_eq!(run.agreement, Agreement::BothComplete, "{source}: {:?}", run.ironhorse_halt);
        assert_eq!(run.ironhorse_result, ironhorse, "{source}: ironhorse (Script `D = false`)");
        assert_eq!(run.oracle_result, oracle, "{source}: oracle (eval-framed `D = true`)");
    }

    // Where the two goals agree, they must keep agreeing. An unqualified
    // assignment is not a declaration at all, so it still makes a configurable
    // property; and `D` touches only configurability, leaving writable and
    // enumerable alone.
    for source in [
        "x = 1; delete globalThis.x",
        "var g = 1; var d = Object.getOwnPropertyDescriptor(globalThis,'g'); \
         '' + d.writable + d.enumerable",
    ] {
        assert_result_agrees(source);
    }
}
