//! Stage-7 child 2/7 behavioral gate: the `Reflect` namespace intrinsic
//! (design [`designs/ironhorse-engine.md`] § Hardened JavaScript, the
//! engine boot-surface residuals the SES shim and the ses-boot bundles
//! consume).
//!
//! `Reflect` is the reflective built-in namespace (`typeof Reflect ===
//! "object"`) carrying `getPrototypeOf`/`setPrototypeOf`/
//! `getOwnPropertyDescriptor`/`defineProperty`/`ownKeys`/`has`/`get`/`set`/
//! `deleteProperty`. Each snippet below is dual-run against the XS oracle;
//! the gate is **result agreement where the oracle accepts the program**
//! (`BothComplete` + `result_agrees`), per the accuracy-over-parity doctrine —
//! computron agreement is advisory telemetry, not asserted here.
//!
//! The re-entrant `Reflect.apply`/`Reflect.construct` are NOT exercised here:
//! they self-name an honest `Halt::Unsupported` this child (their
//! spread-argument trampoline metering is a later increment), so a dual-run of
//! them would not `BothComplete` on ironhorse — the gap is documented, not tested.

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
// §0  `Reflect` is a namespace object, not a function.
// -------------------------------------------------------------------------

#[test]
fn reflect_is_a_namespace_object() {
    assert_result_agrees("typeof Reflect");
    assert_result_agrees("typeof Reflect.get");
    assert_result_agrees("typeof Reflect.ownKeys");
}

// -------------------------------------------------------------------------
// §1  Prototype reflection.
// -------------------------------------------------------------------------

#[test]
fn reflect_get_prototype_of() {
    // Two object literals share one prototype (`%Object.prototype%`), so their
    // `[[Prototype]]` reflects to the SAME identity. (ironhorse does not model the
    // intrinsic constructor's own `.prototype` data property — `Object.prototype`
    // reads `undefined` there — so the identity is asserted via self-agreement
    // rather than against `Object.prototype`.)
    assert_result_agrees("Reflect.getPrototypeOf({}) === Reflect.getPrototypeOf({})");
    assert_result_agrees("typeof Reflect.getPrototypeOf({})");
    // A fresh object's prototype is not `null`.
    assert_result_agrees("Reflect.getPrototypeOf({}) === null");
}

#[test]
fn reflect_set_prototype_of_round_trips() {
    // Install a new prototype, then read it back — the identity round-trips,
    // and the call reports success.
    assert_result_agrees("var p = {}; var o = {}; Reflect.setPrototypeOf(o, p)");
    assert_result_agrees(
        "var p = {}; var o = {}; Reflect.setPrototypeOf(o, p); Reflect.getPrototypeOf(o) === p",
    );
    assert_result_agrees("var o = {}; Reflect.setPrototypeOf(o, null); Reflect.getPrototypeOf(o)");
    // A property on the new prototype is now inherited by the target.
    assert_result_agrees("var p = {}; p.z = 9; var o = {}; Reflect.setPrototypeOf(o, p); o.z");
}

// -------------------------------------------------------------------------
// §2  Own-property descriptor reflection.
// -------------------------------------------------------------------------

#[test]
fn reflect_get_own_property_descriptor() {
    // A present data property's descriptor; an absent key is `undefined`.
    assert_result_agrees("var o = { a: 1 }; Reflect.getOwnPropertyDescriptor(o, 'a').value");
    assert_result_agrees("var o = { a: 1 }; Reflect.getOwnPropertyDescriptor(o, 'a').writable");
    assert_result_agrees("var o = { a: 1 }; Reflect.getOwnPropertyDescriptor(o, 'a').enumerable");
    assert_result_agrees("var o = { a: 1 }; Reflect.getOwnPropertyDescriptor(o, 'a').configurable");
    assert_result_agrees("var o = { a: 1 }; Reflect.getOwnPropertyDescriptor(o, 'b')");
}

#[test]
fn reflect_define_property_returns_boolean_and_takes_effect() {
    // `Reflect.defineProperty` returns `true` on success (vs. `Object`'s
    // returning the object), and the property's attributes ripple through the
    // descriptor readback.
    assert_result_agrees(
        "var o = {}; Reflect.defineProperty(o, 'x', { value: 5, writable: true, enumerable: true, configurable: true })",
    );
    assert_result_agrees(
        "var o = {}; Reflect.defineProperty(o, 'x', { value: 5, writable: true, enumerable: true, configurable: true }); o.x",
    );
    assert_result_agrees(
        "var o = {}; Reflect.defineProperty(o, 'x', { value: 7, writable: false, enumerable: false, configurable: false }); Reflect.getOwnPropertyDescriptor(o, 'x').writable",
    );
    assert_result_agrees(
        "var o = {}; Reflect.defineProperty(o, 'x', { value: 7, writable: false, enumerable: false, configurable: false }); Reflect.getOwnPropertyDescriptor(o, 'x').enumerable",
    );
}

// -------------------------------------------------------------------------
// §3  `ownKeys` — all own string keys in creation order (enumerable or not).
// -------------------------------------------------------------------------

#[test]
fn reflect_own_keys() {
    assert_result_agrees("var o = { a: 1, b: 2, c: 3 }; Reflect.ownKeys(o).length");
    assert_result_agrees("var o = { a: 1, b: 2, c: 3 }; Reflect.ownKeys(o)[0]");
    assert_result_agrees("var o = { a: 1, b: 2, c: 3 }; Reflect.ownKeys(o)[2]");
    assert_result_agrees("Reflect.ownKeys({}).length");
    // NOTE: `ownKeys` over an object carrying a *runtime-defined* key
    // (`Reflect.defineProperty(o, 'h', …)` where `'h'` is a string-literal
    // argument, not a static property name the compiler recorded as a program
    // symbol) is an honest skip — the same `symbol_names` reverse-lookup limit
    // `Object.keys` has for a non-program-symbol key. Not exercised here.
}

// -------------------------------------------------------------------------
// §4  `has` / `get` — the chain-walking reads.
// -------------------------------------------------------------------------

#[test]
fn reflect_has() {
    assert_result_agrees("var o = { a: 1 }; Reflect.has(o, 'a')");
    assert_result_agrees("var o = { a: 1 }; Reflect.has(o, 'b')");
    // Inherited names are visible through the chain.
    assert_result_agrees("var p = { inherited: 1 }; var o = {}; Reflect.setPrototypeOf(o, p); Reflect.has(o, 'inherited')");
}

#[test]
fn reflect_get() {
    assert_result_agrees("var o = { a: 42 }; Reflect.get(o, 'a')");
    assert_result_agrees("var o = { a: 42 }; Reflect.get(o, 'missing')");
    // An inherited data property is read through the chain.
    assert_result_agrees(
        "var p = { v: 3 }; var o = {}; Reflect.setPrototypeOf(o, p); Reflect.get(o, 'v')",
    );
}

// -------------------------------------------------------------------------
// §5  `set` / `deleteProperty` — the mutating reflections, boolean-returning.
// -------------------------------------------------------------------------

#[test]
fn reflect_set() {
    // Create + update, each returning `true`, the write visible on readback.
    assert_result_agrees("var o = {}; Reflect.set(o, 'k', 1)");
    assert_result_agrees("var o = {}; Reflect.set(o, 'k', 1); o.k");
    assert_result_agrees("var o = { k: 1 }; Reflect.set(o, 'k', 99); o.k");
    // A non-writable own property rejects the write (→ `false`), value intact.
    assert_result_agrees(
        "var o = {}; Reflect.defineProperty(o, 'r', { value: 1, writable: false, enumerable: true, configurable: true }); Reflect.set(o, 'r', 2)",
    );
    assert_result_agrees(
        "var o = {}; Reflect.defineProperty(o, 'r', { value: 1, writable: false, enumerable: true, configurable: true }); Reflect.set(o, 'r', 2); o.r",
    );
}

#[test]
fn reflect_delete_property() {
    assert_result_agrees("var o = { a: 1 }; Reflect.deleteProperty(o, 'a')");
    assert_result_agrees("var o = { a: 1 }; Reflect.deleteProperty(o, 'a'); Reflect.has(o, 'a')");
    // A non-configurable own property refuses deletion (→ `false`).
    assert_result_agrees(
        "var o = {}; Reflect.defineProperty(o, 'c', { value: 1, writable: true, enumerable: true, configurable: false }); Reflect.deleteProperty(o, 'c')",
    );
}

#[test]
fn ordinary_descriptor_regressions() {
    assert_result_agrees(
        "var o={}; Object.defineProperty(o,'x',{value:1}); var d=Object.getOwnPropertyDescriptor(o,'x'); d.value===1&&!d.writable&&!d.enumerable&&!d.configurable",
    );
    assert_result_agrees(
        "var o={}; Object.defineProperty(o,'x',{value:1,writable:true,configurable:true}); Object.defineProperty(o,'x',{value:2}); o.x",
    );
    assert_result_agrees(
        "var o={}; var n=0; Object.defineProperty(o,'x',{get:function(){return ++n},set:function(v){n=v},enumerable:true,configurable:true}); o.x+o.x",
    );
    assert_result_agrees(
        "var p={}; Object.defineProperty(p,'x',{set:function(v){this.y=v}}); var o=Object.create(p); o.x=7; o.y",
    );
    assert_result_agrees(
        "var p={}; Object.defineProperty(p,'x',{set:function(v){this.y=v}}); var o=Object.create(Object.create(p)); o.x=7; o.y+'|'+Object.prototype.hasOwnProperty.call(o,'x')",
    );
    assert_result_agrees(
        "var p={}; Object.defineProperty(p,'x',{value:1,writable:false}); var o=Object.create(Object.create(p)); Reflect.set(o,'x',7)+'|'+o.x+'|'+Object.prototype.hasOwnProperty.call(o,'x')",
    );
    assert_result_agrees(
        "var o={}; Object.defineProperty(o,'x',{value:0,writable:false,configurable:false}); Reflect.defineProperty(o,'x',{value:-0})",
    );
    assert_result_agrees("({get x(){return 1},x:2}).x");
    assert_result_agrees(
        "var g=function(){}; var o={}; Object.defineProperty(o,'x',{get:g}); harden(o); g.injected=7; g.injected",
    );
    assert_result_agrees(
        "var s=Symbol(); var o={b:1}; o[2]=2; o[1]=1; o[s]=3; Reflect.ownKeys(o)[0]",
    );
}

#[test]
fn reflect_extensibility_and_symbol_statics() {
    assert_result_agrees("var o={}; Reflect.isExtensible(o)");
    assert_result_agrees(
        "var o={}; Reflect.preventExtensions(o); Reflect.isExtensible(o)+'|'+Reflect.set(o,'x',1)",
    );
    assert_result_agrees("var s=Symbol(); var o={}; o[s]=1; Object.getOwnPropertySymbols(o).length");
}

#[test]
fn object_create_and_define_properties() {
    assert_result_agrees(
        "var p={x:1}; var o=Object.create(p,{y:{value:2,enumerable:true,writable:true,configurable:true}}); o.x+o.y",
    );
    assert_result_agrees(
        "var o={}; Object.defineProperties(o,{a:{value:1},b:{value:2,enumerable:true}}); o.a+o.b",
    );
}

#[test]
fn object_spread_and_delete_use_the_ordinary_mop() {
    assert_result_agrees("var s={a:1,b:2}; var o={z:0,...s,a:3}; o.a+o.b+o.z");
    assert_result_agrees("var o={a:1}; delete o.a; 'a' in o");
    assert_result_agrees("var a=[1,2]; delete a[0]; String(a[0])+'|'+a.length");
    assert_result_agrees(
        "'use strict'; var caught=false; try {var o={}; Object.defineProperty(o,'x',{value:1,configurable:false}); delete o['x']} catch (e) {caught=e instanceof TypeError} caught",
    );
    assert_result_agrees(
        "var caught=false; try { var n=null; delete n.x } catch (e) { caught=e instanceof TypeError } caught",
    );
}
