//! Behavioral gate for the `Proxy` exotic object (ECMA-262 10.5), the object
//! metaobject-protocol child of the Ironhorse JS completion arc (garden issue
//! 51). Each snippet is dual-run against the XS differential oracle; the gate is
//! **result agreement where the oracle accepts the program** (`BothComplete` +
//! `result_agrees`) per the accuracy-over-parity doctrine — computron agreement
//! is advisory here.
//!
//! Coverage: the `Proxy` constructor and `Proxy.revocable`, all thirteen traps
//! (`apply`/`construct`/`defineProperty`/`deleteProperty`/`get`/
//! `getOwnPropertyDescriptor`/`getPrototypeOf`/`has`/`isExtensible`/`ownKeys`/
//! `preventExtensions`/`set`/`setPrototypeOf`), trap-absent forwarding to the
//! target, invariant enforcement (a violated invariant throws a catchable
//! `TypeError`), revocation, callable/constructable proxies, nested proxies,
//! and the `Object.*` / `Reflect.*` / ordinary-syntax routing through the shared
//! behavior seam so a trap cannot be bypassed.

use ironhorse_262::{dual_run, Agreement};

/// Assert a program completes on BOTH engines with the SAME completion value.
fn agrees(source: &str) {
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
// §0  Construction, typeof, revocable.
// -------------------------------------------------------------------------

#[test]
fn proxy_constructor_shape() {
    agrees("typeof Proxy");
    agrees("Proxy.length");
    agrees("Proxy.name");
    agrees("typeof new Proxy({}, {})");
    // A non-object target or handler is a TypeError, caught here.
    agrees("var e; try { new Proxy(1, {}); } catch (x) { e = x instanceof TypeError; } e");
    agrees("var e; try { new Proxy({}, 1); } catch (x) { e = x instanceof TypeError; } e");
    // `Proxy()` without `new` throws.
    agrees("var e; try { Proxy({}, {}); } catch (x) { e = x instanceof TypeError; } e");
}

#[test]
fn proxy_revocable_shape_and_revocation() {
    agrees("typeof Proxy.revocable({}, {}).proxy");
    agrees("typeof Proxy.revocable({}, {}).revoke");
    // After revoke, any operation throws a TypeError.
    agrees(
        "var r = Proxy.revocable({ a: 1 }, {}); r.revoke(); \
         var e; try { r.proxy.a; } catch (x) { e = x instanceof TypeError; } e",
    );
    // Revoke is idempotent.
    agrees("var r = Proxy.revocable({}, {}); r.revoke(); r.revoke(); typeof r.revoke()");
}

// -------------------------------------------------------------------------
// §1  The property traps: get / set / has / deleteProperty.
// -------------------------------------------------------------------------

#[test]
fn get_trap() {
    agrees("new Proxy({}, { get: function (t, k) { return k + '!'; } }).foo");
    agrees("new Proxy({ x: 5 }, {})['x']"); // trap absent -> forward to target
    agrees("var seen; new Proxy({}, { get: function (t, k, r) { seen = k; return 1; } }).bar; seen");
}

#[test]
fn set_trap() {
    agrees(
        "var log = []; var p = new Proxy({}, { set: function (t, k, v) { log.push(k + '=' + v); return true; } }); \
         p.a = 3; log.join(',')",
    );
    // trap-absent set forwards to the target and is observable there.
    agrees("var t = {}; var p = new Proxy(t, {}); p.z = 9; t.z");
}

#[test]
fn has_trap_and_in_operator() {
    agrees("'foo' in new Proxy({}, { has: function () { return true; } })");
    agrees("'missing' in new Proxy({}, { has: function () { return false; } })");
    agrees("'k' in new Proxy({ k: 1 }, {})"); // forward
    agrees(
        "var target = Object.create([14]); var handler = { has: function (t, k) { \
         return this === handler && t === target && k === '1' ? false : true; } }; \
         var array = []; Object.setPrototypeOf(array, new Proxy(target, handler)); 1 in array",
    );
}

#[test]
fn delete_trap() {
    agrees("delete new Proxy({}, { deleteProperty: function () { return true; } }).x");
    agrees("var t = { a: 1 }; var p = new Proxy(t, {}); delete p.a; 'a' in t");
}

// -------------------------------------------------------------------------
// §2  getOwnPropertyDescriptor / defineProperty / ownKeys.
// -------------------------------------------------------------------------

#[test]
fn get_own_property_descriptor_trap() {
    agrees(
        "var p = new Proxy({}, { getOwnPropertyDescriptor: function () { \
            return { value: 7, writable: true, enumerable: true, configurable: true }; } }); \
         Object.getOwnPropertyDescriptor(p, 'x').value",
    );
    agrees("typeof Object.getOwnPropertyDescriptor(new Proxy({}, {}), 'nope')");
}

#[test]
fn define_property_trap() {
    agrees(
        "var log; var p = new Proxy({}, { defineProperty: function (t, k, d) { log = k; return true; } }); \
         Object.defineProperty(p, 'y', { value: 1 }); log",
    );
    // trap-absent define forwards to the target.
    agrees(
        "var t = {}; var p = new Proxy(t, {}); \
         Object.defineProperty(p, 'q', { value: 42, enumerable: true, writable: true, configurable: true }); t.q",
    );
}

#[test]
fn own_keys_trap_and_object_keys() {
    agrees(
        "var p = new Proxy({ a: 1, b: 2 }, { ownKeys: function (t) { return Object.keys(t); } }); \
         Object.keys(p).join(',')",
    );
    agrees("Object.getOwnPropertyNames(new Proxy({ a: 1, b: 2 }, {})).join(',')");
    // A non-string/symbol key in the trap result is a TypeError.
    agrees(
        "var p = new Proxy({}, { ownKeys: function () { return [true]; } }); \
         var e; try { Object.keys(p); } catch (x) { e = x instanceof TypeError; } e",
    );
}

#[test]
fn array_is_array_transparently_unwraps_proxies() {
    for source in [
        "Array.isArray(new Proxy([],{}))",
        "Array.isArray(new Proxy(new Proxy([],{}),{}))",
        "Array.isArray(new Proxy({},{}))",
        "var hits=0;var p=new Proxy([],{get:function(){hits++}});Array.isArray(p)+':'+hits",
        "var r=Proxy.revocable([],{});r.revoke();try{Array.isArray(r.proxy);false}catch(e){e instanceof TypeError}",
    ] {
        agrees(source);
    }
}

// -------------------------------------------------------------------------
// §3  Prototype and extensibility traps.
// -------------------------------------------------------------------------

#[test]
fn prototype_traps() {
    agrees(
        "var proto = {}; var p = new Proxy({}, { getPrototypeOf: function () { return proto; } }); \
         Object.getPrototypeOf(p) === proto",
    );
    agrees(
        "var called; var p = new Proxy({}, { setPrototypeOf: function () { called = true; return true; } }); \
         Object.setPrototypeOf(p, {}); called",
    );
}

#[test]
fn extensibility_traps() {
    agrees("Object.isExtensible(new Proxy({}, { isExtensible: function () { return true; } }))");
    agrees(
        "var t = {}; var p = new Proxy(t, { preventExtensions: function (x) { Object.preventExtensions(x); return true; } }); \
         Object.preventExtensions(p); Object.isExtensible(t)",
    );
}

// -------------------------------------------------------------------------
// §4  Callable & constructable proxies (apply / construct traps).
// -------------------------------------------------------------------------

#[test]
fn apply_trap() {
    agrees("typeof new Proxy(function () {}, {})"); // a callable proxy is a function
    agrees("new Proxy(function () {}, { apply: function (t, thiz, args) { return args[0] + args[1]; } })(2, 3)");
    // trap-absent call forwards to the target function.
    agrees("new Proxy(function (a) { return a * 2; }, {})(21)");
}

#[test]
fn construct_trap() {
    agrees(
        "var p = new Proxy(function () {}, { construct: function (t, args) { return { sum: args[0] + args[1] }; } }); \
         new p(4, 5).sum",
    );
}

#[test]
fn reflect_apply_and_construct() {
    agrees("Reflect.apply(function (a, b) { return a - b; }, undefined, [10, 3])");
    agrees("Reflect.construct(function (a) { this.v = a; }, [99]).v");
}

// -------------------------------------------------------------------------
// §5  Invariant enforcement (a violated invariant throws a catchable TypeError).
// -------------------------------------------------------------------------

#[test]
fn get_invariant_non_writable_non_configurable() {
    // A `get` that returns a value different from a non-writable,
    // non-configurable target data property must throw.
    agrees(
        "var t = {}; Object.defineProperty(t, 'x', { value: 1, writable: false, configurable: false }); \
         var p = new Proxy(t, { get: function () { return 2; } }); \
         var e; try { p.x; } catch (x) { e = x instanceof TypeError; } e",
    );
    // Returning the SAME value is fine.
    agrees(
        "var t = {}; Object.defineProperty(t, 'x', { value: 1, writable: false, configurable: false }); \
         var p = new Proxy(t, { get: function () { return 1; } }); p.x",
    );
}

#[test]
fn trap_not_callable_throws() {
    agrees("var e; try { new Proxy({}, { get: 5 }).x; } catch (x) { e = x instanceof TypeError; } e");
}

// -------------------------------------------------------------------------
// §6  Nested proxies and the shared-seam routing.
// -------------------------------------------------------------------------

#[test]
fn nested_proxy_forwarding() {
    // An outer trap-absent proxy forwards to an inner proxy target.
    agrees("new Proxy(new Proxy({ v: 8 }, {}), {}).v");
    agrees(
        "var inner = new Proxy({}, { get: function () { return 'inner'; } }); \
         new Proxy(inner, {}).anything",
    );
    agrees(
        "var inner = new Proxy({ foo: 2 }, {}); \
         var outer = new Proxy(inner, { has: undefined }); \
         ['foo' in outer, 'bar' in outer, Reflect.has(outer, 'foo')].join(',')",
    );
    agrees(
        "var inner = new Proxy([1, 2], {}); \
         var outer = new Proxy(inner, { has: undefined }); \
         ['length' in Object.create(outer), '1' in outer, '2' in outer].join(',')",
    );
}

#[test]
fn reflect_routes_through_traps() {
    agrees("Reflect.get(new Proxy({}, { get: function (t, k) { return k; } }), 'abc')");
    agrees("Reflect.has(new Proxy({}, { has: function () { return true; } }), 'z')");
    agrees("Reflect.ownKeys(new Proxy({ m: 1 }, {})).join(',')");
}
