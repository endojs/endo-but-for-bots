//! The constructor-function own `prototype` property, dual-run against the
//! pinned XS oracle.
//!
//! Regression: a user function's `.prototype` read resolved to `undefined`
//! (no own property was installed), so `T.prototype.m = …` silently
//! vanished, `T.prototype.toString = …` never took, and every instance
//! chained to an object the program could not reach — the root cause behind
//! a large slice of the full-sweep `ironhorse-aborted`/`abort-value-differs`
//! mass (any test augmenting a constructor prototype) and the hardened262
//! harness's `Test262Error` custom `toString` being dropped.

use ironhorse_262::{dual_run, Agreement};

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

#[test]
fn prototype_identity_links_reads_and_instances() {
    assert_result_agrees(
        "function T() {} '' + (T.prototype === Object.getPrototypeOf(new T()))",
    );
    assert_result_agrees("function T() {} function U() {} '' + (T.prototype === U.prototype)");
    assert_result_agrees("function T() {} '' + (typeof T.prototype)");
    assert_result_agrees(
        "function T() {} var d = Object.getOwnPropertyDescriptor(T, 'prototype'); \
         '' + [typeof d.value, d.writable, d.enumerable, d.configurable].join(',')",
    );
}

#[test]
fn prototype_augmentation_reaches_instances() {
    assert_result_agrees("function T() {} T.prototype.x = 7; '' + new T().x");
    assert_result_agrees("function T() {} T.prototype.m = function () { return 3; }; '' + new T().m()");
    assert_result_agrees("function T() {} var i = new T(); T.prototype.x = 1; '' + i.x");
    assert_result_agrees(
        "function T() {} T.prototype.toString = function () { return 'custom'; }; '' + new T()",
    );
}

#[test]
fn prototype_reassignment_re_points_new_instances() {
    assert_result_agrees(
        "function T() {} var old = T.prototype; T.prototype = { y: 9 }; \
         var i = new T(); '' + [i.y, Object.getPrototypeOf(i) === old].join(',')",
    );
}

#[test]
fn generator_and_method_shapes_mirror_xs() {
    assert_result_agrees("function* g() {} '' + (typeof g.prototype)");
    assert_result_agrees(
        "function* g() {} g.prototype.extra = 5; var it = g(); '' + it.extra",
    );
    assert_result_agrees("var o = { m() {} }; '' + (typeof o.m.prototype)");
    assert_result_agrees("var a = () => 1; '' + (typeof a.prototype)");
    assert_result_agrees("async function h() {} '' + (typeof h.prototype)");
}

#[test]
fn user_error_types_render_through_custom_to_string() {
    assert_result_agrees(
        "function E(m) { this.message = m || ''; } \
         E.prototype.toString = function () { return 'E: ' + this.message; }; \
         var e = new E('x'); e.toString() + '|' + ('' + e) + '|' + String(e)",
    );
}
