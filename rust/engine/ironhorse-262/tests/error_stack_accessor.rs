//! The `%Error.prototype%` `stack` host accessor, dual-run against the
//! pinned XS oracle.
//!
//! Regression: ironhorse had no `stack` accessor at all, so the three
//! `built-ins/Error/prototype/stack/setter-*` official cases passed by
//! accident (calling the undefined setter threw the expected TypeError)
//! while the oracle — whose accessor exists but predates the proposal's
//! setter semantics — failed them: an over-acceptance. The accessor now
//! mirrors XS 8.3.1 exactly: the getter renders `name[: message]` plus one
//! `\n at <fn> ()` line per construction-time frame; the setter defines an
//! own `{value, writable, enumerable, configurable}` property with no
//! string check (`mxDefineID`), throwing only for a non-object `this`, a
//! missing argument, or a refused define.

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
fn getter_renders_name_message_and_frames() {
    assert_result_agrees("var e = new Error('m'); '' + e.stack");
    assert_result_agrees("'' + new Error().stack");
    assert_result_agrees("'' + new TypeError('t').stack");
    assert_result_agrees(
        "function inner() { return new Error('deep'); } \
         function outer() { return inner(); } '' + outer().stack",
    );
    assert_result_agrees(
        "var named = new Error('n'); named.name = 'Custom'; '' + named.stack",
    );
}

#[test]
fn accessor_descriptor_shape_matches_xs() {
    assert_result_agrees(
        "var d = Object.getOwnPropertyDescriptor(Error.prototype, 'stack'); \
         '' + [typeof d.get, typeof d.set, d.enumerable, d.configurable].join(',')",
    );
    assert_result_agrees(
        "var d = Object.getOwnPropertyDescriptor(Error.prototype, 'stack'); \
         '' + d.get.call({})",
    );
}

#[test]
fn setter_defines_unconditionally_and_gates_this() {
    assert_result_agrees(
        "var set = Object.getOwnPropertyDescriptor(Error.prototype, 'stack').set; \
         var e = new Error('m'); set.call(e, 123); \
         var od = Object.getOwnPropertyDescriptor(e, 'stack'); \
         '' + [od.value, od.writable, od.enumerable, od.configurable].join(',')",
    );
    assert_result_agrees(
        "var set = Object.getOwnPropertyDescriptor(Error.prototype, 'stack').set; \
         var p = {}; set.call(p, 'plain'); '' + p.stack",
    );
    assert_result_agrees(
        "var set = Object.getOwnPropertyDescriptor(Error.prototype, 'stack').set; \
         var c = ''; try { set.call(null, 'x') } catch (e) { c = e.constructor.name } '' + c",
    );
    assert_result_agrees(
        "var set = Object.getOwnPropertyDescriptor(Error.prototype, 'stack').set; \
         var c = ''; try { set.call({}) } catch (e) { c = e.constructor.name } '' + c",
    );
    assert_result_agrees(
        "var set = Object.getOwnPropertyDescriptor(Error.prototype, 'stack').set; \
         var nw = new Error('m2'); \
         Object.defineProperty(nw, 'stack', { value: 'orig', writable: false, enumerable: false, configurable: true }); \
         set.call(nw, 'upd'); '' + Object.getOwnPropertyDescriptor(nw, 'stack').value",
    );
}
