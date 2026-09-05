//! Stage-7 child 1/7 behavioral gate: the live `globalThis` binding (design
//! [`designs/ironhorse-engine.md`] § Hardened JavaScript and Compartment,
//! requirement 5).
//!
//! `globalThis` resolves in guest code to the *real* global object, so a
//! property op on it is the SAME state a `var`/sloppy-global declaration and
//! plain identifier resolution see, and the intrinsic bindings are reachable
//! as its properties. Each snippet below is dual-run against the XS oracle;
//! the gate is **result agreement where the oracle accepts the program**
//! (`BothComplete` + `result_agrees`), per the accuracy-over-parity doctrine —
//! computron agreement is advisory telemetry, not asserted here.
//!
//! The oracle is a build-time dependency of this crate (`xs-oracle` links
//! the pinned XS), so `dual_run` is always available when this test
//! compiles; there is no test262 subset to locate.

use ironhorse_262::{dual_run, Agreement};

/// Assert one program completes on BOTH engines with the SAME completion
/// value — the result-agreement gate. Reports the divergence verbatim on
/// failure so a regression names itself.
fn assert_result_agrees(source: &str) {
    let dr = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(
        dr.agreement,
        Agreement::BothComplete,
        "`{source}` must complete on both engines (ironhorse halt: {:?}; oracle={:?} ironhorse={:?})",
        dr.ironhorse_halt,
        dr.oracle_result,
        dr.ironhorse_result,
    );
    assert!(
        dr.result_agrees,
        "`{source}` result divergence: oracle={:?} ironhorse={:?}",
        dr.oracle_result, dr.ironhorse_result,
    );
}

// -------------------------------------------------------------------------
// §1  `globalThis` is the live global object: its property state IS the
//     `var`/sloppy-global/identifier state.
// -------------------------------------------------------------------------

#[test]
fn globalthis_write_is_visible_to_identifier_resolution() {
    // A write through `globalThis` creates/updates a global that plain
    // identifier resolution then reads — the `global_props` fast index the
    // resolver consults is kept in lock-step with the global object's chain.
    assert_result_agrees("globalThis.x = 1; x");
    assert_result_agrees("globalThis.a = 10; globalThis.a = 20; a");
}

#[test]
fn var_declaration_is_visible_through_globalthis() {
    // A top-level `var` hoists onto the global object, so it is readable as a
    // property of `globalThis`.
    assert_result_agrees("var y = 2; globalThis.y");
    assert_result_agrees("var z = 3; z = 4; globalThis.z");
}

#[test]
fn sloppy_global_assignment_is_visible_through_globalthis() {
    // An assignment to an undeclared name creates a global property, readable
    // through `globalThis`.
    assert_result_agrees("w = 7; globalThis.w");
}

#[test]
fn globalthis_read_round_trips_its_own_write() {
    assert_result_agrees("globalThis.p = 42; globalThis.p");
    assert_result_agrees("globalThis.q = 1 + 2; globalThis.q");
}

#[test]
fn globalthis_is_an_object_and_self_referential() {
    // `typeof globalThis` is "object"; `globalThis.globalThis` is the same
    // object (the self-reference the realm global carries).
    assert_result_agrees("typeof globalThis");
    assert_result_agrees("globalThis.globalThis === globalThis");
}

#[test]
fn delete_through_globalthis_drops_the_binding() {
    // `delete globalThis.k` removes the property from the chain AND the fast
    // index, so a later read sees `undefined`.
    assert_result_agrees("globalThis.d = 5; delete globalThis.d; globalThis.d");
}

// -------------------------------------------------------------------------
// §2  Intrinsic bindings are reachable as properties OF the global object,
//     with the same identity identifier resolution yields.
// -------------------------------------------------------------------------

#[test]
fn intrinsics_are_reachable_as_properties_of_globalthis() {
    // The intrinsic bound as an identifier and the property of `globalThis`
    // are the SAME instance.
    assert_result_agrees("globalThis.Object === Object");
    assert_result_agrees("globalThis.Math === Math");
}

#[test]
fn intrinsic_typeof_through_globalthis() {
    assert_result_agrees("typeof globalThis.Object");
    assert_result_agrees("typeof globalThis.Math");
}

#[test]
fn runtime_created_global_names_materialize_complete_intrinsics() {
    for source in [
        "var D=Reflect.get(globalThis,'Da'+'te');var s='U'+'TC';var m='get'+'Time';typeof D+':'+D.hasOwnProperty(s)+':'+typeof D.prototype[m]",
        "var A=Reflect.get(globalThis,'Arr'+'ay');A.hasOwnProperty('from')+':'+typeof A.prototype.map",
        "var N=Reflect.get(globalThis,'Num'+'ber');N.hasOwnProperty('isNaN')+':'+typeof N.prototype.toString",
        "var O=Reflect.get(globalThis,'Obj'+'ect');O.hasOwnProperty('keys')+':'+typeof O.prototype.valueOf",
    ] {
        assert_result_agrees(source);
    }
}

#[test]
fn own_key_reflection_materializes_complete_runtime_intrinsics() {
    for source in [
        "var A=Reflect.get(globalThis,'Arr'+'ay');Object.getOwnPropertyNames(A).join(',')",
        "var N=Reflect.get(globalThis,'Num'+'ber');Object.getOwnPropertyNames(N).join(',')",
        "var O=Reflect.get(globalThis,'Obj'+'ect');Object.getOwnPropertyNames(O).join(',')",
        "var D=Reflect.get(globalThis,'Da'+'te');Object.getOwnPropertyNames(D).join(',')",
        "var A=Reflect.get(globalThis,'Arr'+'ay');Object.keys(Object.getOwnPropertyDescriptors(A)).join(',')",
    ] {
        assert_result_agrees(source);
    }
}

#[test]
fn own_key_materialization_preserves_guest_deletion() {
    assert_result_agrees(
        "var A=Reflect.get(globalThis,'Arr'+'ay');Object.getOwnPropertyNames(A);var k='o'+'f';delete A[k];Object.getOwnPropertyNames(A);typeof A[k]",
    );
}
