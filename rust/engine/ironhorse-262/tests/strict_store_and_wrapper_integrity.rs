//! Oracle-backed coverage for the test262 ratchet's tenth slice: a rejected
//! strict computed-key store throws, a String wrapper's `length` is not
//! deletable, `new String(symbol)` throws, and the dynamic-function
//! prototypes carry the spec's `constructor` / `prototype` attributes.
//!
//! Every case runs on both Ironhorse and the pinned XS oracle and must agree.

use ironhorse_262::{dual_run, Agreement};

fn agrees(source: &str, expected: &str) {
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(
        run.agreement,
        Agreement::BothComplete,
        "`{source}` must complete on both engines (halt: {:?})",
        run.ironhorse_halt,
    );
    assert!(
        run.result_agrees,
        "`{source}` diverged: oracle={:?} ironhorse={:?}",
        run.oracle_result, run.ironhorse_result,
    );
    assert_eq!(run.ironhorse_result, expected, "`{source}`");
}

fn thrown(body: &str) -> String {
    format!("var r; try {{ {body}; r = 'none'; }} catch (e) {{ r = e.constructor.name; }} r")
}

#[test]
fn strict_computed_key_store_rejection_throws() {
    for body in [
        // Non-writable symbol and string keys, reached by a computed key.
        "var s = Symbol(); var o = {}; Object.defineProperty(o, s, {value: 1}); o[s] = 2",
        "var k = 'k'; var o = {}; Object.defineProperty(o, k, {value: 1}); o[k] = 2",
        "var o = {}; Object.defineProperty(o, 'k', {value: 1}); o['k'] = 2",
        // A frozen object, and a new key on a non-extensible object.
        "var s = Symbol(); var o = {}; o[s] = 1; Object.freeze(o); o[s] = 2",
        "var s = Symbol(); var o = Object.preventExtensions({}); o[s] = 1",
        "var o = Object.seal({}); o['fresh'] = 1",
        // An inherited accessor without a setter.
        "var p = {}; Object.defineProperty(p, 'g', {get: function () { return 1; }}); var o = Object.create(p); o['g'] = 2",
        // The global object's non-writable `undefined`.
        "var g = this; g['undefined'] = 5",
    ] {
        agrees(&format!("'use strict'; {}", thrown(body)), "TypeError");
    }
}

#[test]
fn sloppy_computed_key_store_rejection_is_silent() {
    agrees(
        "var s = Symbol(); var o = {}; Object.defineProperty(o, s, {value: 1}); \
         var v = (o[s] = 2); v + ':' + o[s]",
        "2:1",
    );
    agrees(
        "var o = Object.preventExtensions({}); o['k'] = 1; String(o.k)",
        "undefined",
    );
}

#[test]
fn string_wrapper_length_is_not_deletable() {
    agrees(
        "var s = new String('ab'); var d = delete s.length; d + ':' + s.length",
        "false:2",
    );
    agrees(
        &format!(
            "'use strict'; var s = new String('ab'); {}",
            thrown("delete s.length")
        ),
        "TypeError",
    );
    agrees("var d = delete 'ab'.length; String(d)", "false");
    agrees(
        &format!("'use strict'; {}", thrown("delete 'ab'.length")),
        "TypeError",
    );
    // An expando and a missing key on a primitive remain deletable.
    agrees(
        "var s = new String('ab'); s.x = 1; (delete s.x) + ':' + ('x' in s) + ':' + (delete 'ab'.nope)",
        "true:false:true",
    );
}

#[test]
fn new_string_of_a_symbol_throws() {
    agrees(&thrown("new String(Symbol('66'))"), "TypeError");
    agrees("String(Symbol('66'))", "Symbol(66)");
}

#[test]
fn dynamic_function_prototypes_have_spec_attributes() {
    let attrs = |ctor: &str, key: &str| {
        format!(
            "var C = Object.getPrototypeOf({ctor}).constructor; \
             var d = Object.getOwnPropertyDescriptor(C.prototype, '{key}'); \
             [d.writable, d.enumerable, d.configurable].join()"
        )
    };
    for ctor in ["function* () {}", "async function* () {}"] {
        agrees(&attrs(ctor, "constructor"), "false,false,true");
        agrees(&attrs(ctor, "prototype"), "false,false,true");
    }
    agrees(
        &attrs("async function () {}", "constructor"),
        "false,false,true",
    );
    // A function instance's own writable `prototype` is unaffected.
    agrees(
        "'use strict'; var g = function* () {}; var p = {}; g.prototype = p; g.prototype === p",
        "true",
    );
}
