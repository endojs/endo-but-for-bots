//! Behavioral gate for Array exotic `[[DefineOwnProperty]]` and
//! `ArraySetLength` (ECMA-262 10.4.2.1–2). Compact array elements carry the
//! default data-property attributes; restrictive and accessor descriptors are
//! materialized into the ordinary property chain while preserving Array index
//! and length invariants. Every snippet is dual-run against the pinned XS
//! oracle and must agree on the observable completion value.

use ironhorse_262::{dual_run, Agreement};

fn agrees(source: &str) {
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

#[test]
fn index_descriptors_update_length_and_attributes() {
    agrees(
        "var a = []; Object.defineProperty(a, '2', { value: 7, writable: false, \
         enumerable: true, configurable: false }); \
         var d = Object.getOwnPropertyDescriptor(a, '2'); \
         '' + a.length + ',' + a[2] + ',' + d.writable + ',' + d.enumerable + ',' + d.configurable",
    );
    agrees(
        "var a = [1]; Object.defineProperty(a, '0', { value: 4, writable: false }); \
         a[0] = 9; '' + a[0] + ',' + delete a[0]",
    );
    agrees(
        "var a = []; var value = 3; Object.defineProperty(a, '1', { \
         get: function () { return value; }, set: function (v) { value = v + 1; }, \
         configurable: true }); a[1] = 8; '' + a.length + ',' + a[1]",
    );
}

#[test]
fn length_shrink_deletes_indices_and_honors_blockers() {
    agrees(
        "var a = [0, 1, 2, 3]; Object.defineProperty(a, 'length', { value: 2 }); \
         '' + a.length + ',' + a.hasOwnProperty('2') + ',' + a.hasOwnProperty('3')",
    );
    agrees(
        "var a = [0, 1, 2, 3]; Object.defineProperty(a, '2', { configurable: false }); \
         var ok = Reflect.defineProperty(a, 'length', { value: 1 }); \
         '' + ok + ',' + a.length + ',' + a.hasOwnProperty('2') + ',' + a.hasOwnProperty('3')",
    );
}

#[test]
fn nonwritable_length_rejects_growth_but_allows_existing_index_updates() {
    agrees(
        "var a = [1]; Object.defineProperty(a, 'length', { writable: false }); \
         var grow = Reflect.defineProperty(a, '1', { value: 2 }); \
         var update = Reflect.defineProperty(a, '0', { value: 8 }); \
         '' + grow + ',' + update + ',' + a.length + ',' + a[0] + ',' + a[1]",
    );
    agrees(
        "var a = [1]; Object.defineProperty(a, 'length', { writable: false }); \
         var caught = false; try { Object.defineProperty(a, '1', { value: 2 }); } \
         catch (e) { caught = e instanceof TypeError; } '' + caught + ',' + a.length",
    );
}

#[test]
fn length_coercion_and_range_error_order_match() {
    agrees(
        "var log = ''; var value = { valueOf: function () { log += 'v'; return 2; } }; \
         var a = [0, 1, 2]; Object.defineProperty(a, 'length', { value: value, writable: false }); \
         '' + log + ',' + a.length + ',' + Object.getOwnPropertyDescriptor(a, 'length').writable",
    );
    agrees(
        "var a = [1]; var caught = false; try { \
         Object.defineProperty(a, 'length', { value: 1.5 }); \
         } catch (e) { caught = e instanceof RangeError; } '' + caught + ',' + a.length",
    );
}

#[test]
fn proxy_forwarding_uses_array_define_own_property() {
    agrees(
        "var target = []; var proxy = new Proxy(target, {}); \
         Object.defineProperty(proxy, '1', { value: 6, enumerable: true }); \
         '' + target.length + ',' + target[1] + ',' + target.propertyIsEnumerable('1')",
    );
}

#[test]
fn arguments_length_remains_an_ordinary_configurable_property() {
    agrees(
        "function f() { var before = arguments.length; var deleted = delete arguments.length; \
         return '' + before + ',' + deleted + ',' + arguments.hasOwnProperty('length') + \
         ',' + arguments.length; } f(1, 2)",
    );
    agrees(
        "function f() { arguments[3] = 9; return '' + arguments.length + ',' + arguments[3]; } f(1)",
    );
    agrees(
        "function f() { Object.defineProperty(arguments, 'length', { value: 7 }); \
         var d = Object.getOwnPropertyDescriptor(arguments, 'length'); \
         return '' + arguments.length + ',' + d.writable + ',' + d.enumerable + ',' + d.configurable; } f(1)",
    );
    agrees(
        "function f() { 'use strict'; arguments.length = 4; \
         return '' + arguments.length + ',' + arguments.propertyIsEnumerable('length'); } f(1, 2)",
    );
}

#[test]
fn array_iterators_re_read_exotic_length_and_elements() {
    agrees(
        "function f() { var it = Array.prototype.values.call(arguments); \
         var first = it.next(); arguments.length = 0; var second = it.next(); \
         return '' + first.value + ',' + first.done + ',' + second.value + ',' + second.done; } \
         f(3, 4)",
    );
    agrees(
        "function f() { 'use strict'; var it = Array.prototype.values.call(arguments); \
         var first = it.next(); arguments.length = 0; var second = it.next(); \
         return '' + first.value + ',' + first.done + ',' + second.value + ',' + second.done; } \
         f(3, 4)",
    );
    agrees(
        "var a = [1]; Object.defineProperty(a, '0', { get: function () { return 7; } }); \
         a.values().next().value",
    );
}
