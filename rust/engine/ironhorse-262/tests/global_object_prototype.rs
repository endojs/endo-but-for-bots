//! The global object inherits from `%Object.prototype%`.
//!
//! ECMA-262 SetRealmGlobalObject creates the default global with
//! `OrdinaryObjectCreate(%Object.prototype%)`, and XS builds both the
//! machine's global and every `Compartment` global over `mxObjectPrototype`.
//! Ironhorse used to leave the global's [[Prototype]] null, so
//! `this.propertyIsEnumerable(...)` in global code threw "call: not a
//! function" and `Object.getPrototypeOf(Object.getPrototypeOf(this))` threw
//! "cannot coerce null to object". Bare names that are not own globals now
//! resolve through the global's actual prototype chain, so replacing that
//! prototype is observed the way XS observes it.

use ironhorse_262::{dual_run, Agreement};

fn assert_result_agrees(source: &str, expected: &str) {
    let run = dual_run(source).expect("pinned XS oracle is available");
    assert_eq!(run.agreement, Agreement::BothComplete, "{source}");
    assert_eq!(run.oracle_result, expected, "oracle result for {source}");
    assert_eq!(
        run.ironhorse_result, expected,
        "ironhorse result for {source}"
    );
    assert!(run.result_agrees, "results must agree for {source}");
}

#[test]
fn the_global_object_inherits_object_prototype() {
    assert_result_agrees(
        "Object.getPrototypeOf(globalThis) === Object.prototype",
        "true",
    );
    assert_result_agrees(
        "(globalThis instanceof Object) + ':' + typeof globalThis.toString",
        "true:function",
    );
    // The shape of `built-ins/parseInt/S15.1.2.2_A9.5.js` and its siblings.
    assert_result_agrees(
        "this.hasOwnProperty('parseInt') + ':' + this.propertyIsEnumerable('parseInt')",
        "true:false",
    );
}

#[test]
fn a_compartment_global_inherits_object_prototype() {
    assert_result_agrees(
        "Object.getPrototypeOf(new Compartment().globalThis) === Object.prototype",
        "true",
    );
    assert_result_agrees(
        "new Compartment().evaluate('typeof this.hasOwnProperty')",
        "function",
    );
}

#[test]
fn bare_names_resolve_through_the_replaced_global_prototype() {
    assert_result_agrees(
        "Object.setPrototypeOf(globalThis, { inherited: 7 }); inherited",
        "7",
    );
    assert_result_agrees(
        "Object.setPrototypeOf(globalThis, null); typeof toString",
        "undefined",
    );
    // An inherited name is resolvable, so a strict store does not raise the
    // unresolvable-reference error; it creates an own global property.
    assert_result_agrees(
        "'use strict'; Object.setPrototypeOf(globalThis, { q: 1 }); q = 2; \
         Object.prototype.hasOwnProperty.call(globalThis, 'q') + ':' + q",
        "true:2",
    );
    // With no prototype, `toString` is unresolvable, and a strict store to it
    // is the ReferenceError.
    assert_result_agrees(
        "'use strict'; Object.setPrototypeOf(globalThis, null); \
         try { toString = 1; 'stored' } catch (e) { e.name }",
        "ReferenceError",
    );
}
