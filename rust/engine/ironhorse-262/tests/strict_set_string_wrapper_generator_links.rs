//! Behavioral gate: strict computed-key stores, String wrapper edge cases,
//! and the `%GeneratorFunction.prototype%` /
//! `%AsyncGeneratorFunction.prototype%` link descriptors.
//!
//! - A strict computed-key store (`o[k] = v`) that `[[Set]]` rejects on a
//!   frozen, sealed, or non-extensible object (or on a TypedArray's named
//!   key) throws a `TypeError`, as the named-key store does (test262
//!   `built-ins/Object/*/symbol-*-strict.js`,
//!   `built-ins/undefined/15.1.1.3-2.js`).
//! - `new String(sym)` throws (ToString of a Symbol), while `String(sym)`
//!   still answers the descriptive string (`built-ins/String/symbol-wrapping.js`).
//! - `delete` of a String wrapper's `length` is refused: `false` sloppy, a
//!   `TypeError` strict (`built-ins/String/S15.5.5.1_A3.js`).
//! - `constructor` on both generator-function prototypes, and `prototype` on
//!   `%AsyncGeneratorFunction.prototype%`, are non-writable and configurable
//!   (`built-ins/{,Async}GeneratorFunction/prototype/{constructor,prototype}.js`).
//!
//! Each snippet is dual-run against the XS oracle and must agree with it.

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

fn strict_store_throws(setup: &str) -> String {
    format!(
        "(function () {{ 'use strict'; {setup} \
         try {{ o[k] = 2; return 'stored:' + o[k]; }} \
         catch (e) {{ return e instanceof TypeError; }} }})()"
    )
}

#[test]
fn strict_computed_symbol_store_on_frozen_object_throws() {
    assert_result_agrees(&strict_store_throws(
        "var k = Symbol('k'); var o = {}; o[k] = 1; Object.freeze(o);",
    ));
}

#[test]
fn strict_computed_symbol_store_on_non_writable_property_throws() {
    assert_result_agrees(&strict_store_throws(
        "var k = Symbol('k'); var o = {}; Object.defineProperty(o, k, { value: 1 });",
    ));
}

#[test]
fn strict_computed_new_key_on_sealed_or_non_extensible_object_throws() {
    assert_result_agrees(&strict_store_throws(
        "var k = Symbol('k'); var o = Object.seal({});",
    ));
    assert_result_agrees(&strict_store_throws(
        "var k = 'x'; var o = Object.preventExtensions({});",
    ));
}

#[test]
fn strict_computed_store_to_global_undefined_throws() {
    assert_result_agrees(&strict_store_throws(
        "var k = 'undefined'; var o = globalThis;",
    ));
}

#[test]
fn strict_computed_named_store_on_typed_array_throws() {
    assert_result_agrees(&strict_store_throws(
        "var k = 'x'; var o = new Uint8Array(1); \
         Object.defineProperty(o, k, { value: 1 });",
    ));
    assert_result_agrees(&strict_store_throws(
        "var k = 'x'; var o = Object.preventExtensions(new Uint8Array(1));",
    ));
}

#[test]
fn sloppy_computed_store_on_frozen_object_is_silent() {
    assert_result_agrees(
        "var k = Symbol('k'); var o = {}; o[k] = 1; Object.freeze(o); o[k] = 2; o[k]",
    );
}

#[test]
fn new_string_of_symbol_throws_but_call_describes() {
    assert_result_agrees(
        "var s = Symbol('66'); var r; \
         try { new String(s); r = 'no throw'; } catch (e) { r = e instanceof TypeError; } \
         r + ':' + String(s)",
    );
}

#[test]
fn delete_string_wrapper_length_is_refused() {
    assert_result_agrees(
        "var w = new String('globglob'); (delete w.length) + ':' + w.hasOwnProperty('length')",
    );
    assert_result_agrees(
        "(function () { 'use strict'; var w = new String('ab'); \
         try { delete w.length; return 'deleted'; } \
         catch (e) { return (e instanceof TypeError) + ':' + w.length; } })()",
    );
}

fn descriptor(target: &str, key: &str) -> String {
    format!(
        "var d = Object.getOwnPropertyDescriptor({target}, '{key}'); \
         [d.writable, d.enumerable, d.configurable].join()"
    )
}

#[test]
fn generator_function_prototype_constructor_is_non_writable() {
    assert_result_agrees(&descriptor(
        "Object.getPrototypeOf(function* () {})",
        "constructor",
    ));
}

#[test]
fn async_generator_function_prototype_links_are_non_writable_configurable() {
    assert_result_agrees(&descriptor(
        "Object.getPrototypeOf(async function* () {})",
        "constructor",
    ));
    assert_result_agrees(&descriptor(
        "Object.getPrototypeOf(async function* () {})",
        "prototype",
    ));
}
