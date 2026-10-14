//! Four Ironhorse-only specification gaps, against the pinned XS oracle
//! (V8 agrees on each):
//!
//! - a TypedArray answers a canonical numeric key itself, wherever it sits
//!   in the chain an `in`, `Reflect.has`, Proxy or `with` lookup walks;
//! - a definition that CreateDataPropertyOrThrow refuses throws XS's
//!   `set X: const`, including a static class member named `prototype` and
//!   a class field defined on a frozen object or array a base constructor
//!   returned (which Ironhorse wrote into, unfreezing it);
//! - a sloppy write to a function expression's own name is ignored, a write
//!   in a binding's temporal dead zone throws, and a refused sloppy `super`
//!   write is silent;
//! - a Date setter on an invalid Date leaves a time a coercion set.

use ironhorse_262::dual_run;

fn agrees(source: &str) {
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert!(
        run.observables_agree(),
        "observable divergence: {source}\n  oracle={} ironhorse={}\n  ironhorse_halt={:?}",
        run.oracle_result,
        run.ironhorse_result,
        run.ironhorse_halt,
    );
}

#[test]
fn a_typed_array_answers_numeric_keys_at_its_own_level() {
    for constructor in ["Int8Array", "Float64Array", "BigInt64Array"] {
        for key in [
            "42",
            "'42'",
            "'-0'",
            "'1.5'",
            "'Infinity'",
            "'NaN'",
            "1",
            "'1'",
            "'foo'",
            "'01'",
        ] {
            agrees(&format!(
                "var ta = new {constructor}(4); var P = Object.getPrototypeOf({constructor}.prototype); \
                 [{key}].forEach(function (k) {{ {constructor}.prototype[k] = 'p'; }}); \
                 var r = [Reflect.has(ta, {key}), {key} in ta, {key} in new Proxy(ta, {{}}), \
                          {key} in Object.create(ta), Reflect.has(Object.create(Object.create(ta)), {key})]; \
                 [{key}].forEach(function (k) {{ delete {constructor}.prototype[k]; }}); r.join()"
            ));
        }
    }
    agrees(
        "var log = []; var ta = new Int8Array(2); \
         Object.setPrototypeOf(ta, new Proxy({}, { has: function (t, k) { log.push(String(k)); return true; } })); \
         [5 in ta, '1.5' in ta, 'x' in ta, 0 in ta, log.join('+')].join()",
    );
    agrees(
        "var ta = new Int8Array(2); Object.setPrototypeOf(ta, { Infinity: 7, NaN: 8, x: 9 }); \
         var r; with (ta) { r = [Infinity, NaN, x, typeof Infinity] } r.join()",
    );
    agrees("var ta = new Int8Array(4); Int8Array.prototype[1] = 'p'; ta.buffer.transfer(); var r = [1 in ta, Reflect.has(ta, '1')]; delete Int8Array.prototype[1]; r.join()");
}

#[test]
fn a_refused_definition_throws() {
    for member in [
        "static ['prototype']() {}",
        "static get ['prototype']() {}",
        "static set ['prototype'](v) {}",
        "static *['prototype']() {}",
        "static async ['prototype']() {}",
        "static async *['prototype']() {}",
        "static ['prototype'] = 1",
        "static ['proto' + 'type'] = 1",
    ] {
        agrees(&format!(
            "var r; try {{ class C {{ {member} }} r = 'no throw'; }} catch (e) {{ r = String(e); }} r"
        ));
    }
    for field in ["[0] = 2", "[5] = 2", "['y'] = 2", "y = 2", "['length'] = 0"] {
        for target in [
            "Object.freeze([1])",
            "Object.seal([1])",
            "Object.preventExtensions([1])",
            "harden([1])",
            "Object.freeze({})",
            "Object.seal({ 0: 1, y: 1 })",
            "Object.preventExtensions({})",
            "new Proxy({}, { defineProperty: function () { return false; } })",
            "(function () { var a = [1]; Object.defineProperty(a, 'length', { writable: false }); return a; })()",
            "(function () { var a = [1, 2]; Object.defineProperty(a, 0, { value: 1, configurable: false }); return a; })()",
        ] {
            agrees(&format!(
                "var t = {target}; class B {{ constructor() {{ return t; }} }} class C extends B {{ {field} }} \
                 var r; try {{ new C(); r = 'no throw'; }} catch (e) {{ r = String(e); }} \
                 [r, JSON.stringify(Object.getOwnPropertyDescriptors(t)), Object.isFrozen(t), Object.isExtensible(t)].join(' ')"
            ));
        }
    }
}

#[test]
fn immutable_and_uninitialized_bindings_refuse_writes_as_specified() {
    for write in [
        "f = 1",
        "f += 1",
        "f++",
        "[f] = [1]",
        "({ f } = { f: 1 })",
        "for (f of [1]);",
        "for (f in { a: 1 });",
        "eval('f = 1')",
        "(function () { f = 2; })()",
        "(() => { f = 3; })()",
    ] {
        for kind in ["function", "function*", "async function"] {
            agrees(&format!(
                "var out = 'pending'; var r = ({kind} f() {{ var r; try {{ {write}; r = typeof f; }} catch (e) {{ r = String(e); }} out = r; return r; }})(); \
                 typeof r === 'object' ? (r.next ? r.next() : 0, out) : out"
            ));
            // XS does not throw on a destructuring or for-of write to an
            // immutable binding; `xs_departures.rs` records it.
            if !write.starts_with(['[', '(', 'f']) || write.starts_with("f ") || write == "f++" {
                agrees(&format!(
                    "var out = 'pending'; var r = ({kind} f() {{ 'use strict'; var r; try {{ {write}; r = typeof f; }} catch (e) {{ r = String(e); }} out = r; return r; }})(); \
                     typeof r === 'object' ? (r.next ? r.next() : 0, out) : out"
                ));
            }
        }
    }
    for body in [
        "b = 0; let b;",
        "b = 0; const b = 1;",
        "b += 1; let b = 0;",
        "[b] = [1]; let b;",
        "var g = function () { b = 1; }; g(); let b;",
        "var g = () => b; b = 0; let b;",
        "eval('b = 1'); let b;",
        "b = 0; class b {}",
    ] {
        agrees(&format!(
            "function f() {{ {body} }} var r; try {{ f(); r = 'no throw'; }} catch (e) {{ r = String(e); }} r"
        ));
    }
    for (setup, write) in [
        ("Object.freeze(o)", "super.y = 1; super['z'] = 2"),
        ("Object.preventExtensions(o)", "super['y'] = 1"),
        (
            "Object.setPrototypeOf(o, Object.defineProperty({}, 'y', { get: function () { return 0; } }))",
            "super.y = 1",
        ),
    ] {
        agrees(&format!(
            "var o = {{ m() {{ {write}; return 'ok ' + Object.keys(this).join(); }} }}; {setup}; \
             var r; try {{ r = o.m(); }} catch (e) {{ r = String(e); }} r"
        ));
    }
}

#[test]
fn a_date_setter_on_an_invalid_date_keeps_a_time_its_coercion_set() {
    for method in [
        "setMilliseconds",
        "setSeconds",
        "setMinutes",
        "setHours",
        "setDate",
        "setMonth",
        "setFullYear",
        "setUTCMilliseconds",
        "setUTCSeconds",
        "setUTCMinutes",
        "setUTCHours",
        "setUTCDate",
        "setUTCMonth",
        "setUTCFullYear",
    ] {
        agrees(&format!(
            "var dt = new Date(NaN); var r = dt.{method}({{ valueOf: function () {{ dt.setTime(0); return 1; }} }}); \
             [r, dt.getTime(), new Date(NaN).{method}(1)].join()"
        ));
    }
}
