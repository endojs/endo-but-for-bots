//! An ordinary object keeps its integer-indexed properties BY INDEX.
//!
//! `intern_key` hands out a fresh `u16` per novel name and the table grows
//! into the meet with the symbol-key floor — a saturation guard that POISONS
//! the machine, uncatchably and unpersistably. Storing an ordinary object's
//! index properties as named slots therefore made this a denial of service on
//! the whole engine, from a loop no one would look at twice:
//!
//! ```js
//! var o = {}; for (var i = 0; i < 70000; i++) o[i] = i;
//! ```
//!
//! It was the root cause under `Object.assign({}, bigArray)`,
//! `{...bigArray}`, `var {length, ...rest} = bigArray` and
//! `JSON.parse(json, reviver)` — every shape that CREATES index properties on
//! a plain object.
//!
//! XS keeps them in an internal `XS_ARRAY_KIND` slot on the instance:
//! `fxOrdinarySetProperty` (`xsType.c:727`) grows one on the first index
//! write, `fxOrdinaryGetProperty` reads it back without scanning the named
//! chain, and `fxOrdinaryOwnKeys` queues its keys ahead of the named ones. No
//! property name is involved at any point.
//!
//! Two disciplines are pinned here. The loops prove the id space survives; the
//! assertions beside them prove every operation still answers exactly what it
//! answered before — because the cheap way to pass a "mints no key" test is to
//! stop doing the work. Every expected value was measured on the XS oracle.

use ironhorse_vm::{run_program_with_symbols, RunOutcome};

fn run(source: &str) -> RunOutcome {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("source compiles");
    run_program_with_symbols(&bytecode, &symbols)
}

fn assert_result(source: &str, expected: &str) {
    let out = run(source);
    assert!(
        out.completed,
        "must complete; halt: {:?}\n  {source}",
        out.halt
    );
    assert_eq!(out.result, expected, "{source}");
}

/// Past the `u16` id space: before the fix each of these halted with
/// `Unsupported("property-key:id-space-exhausted")`.
const N: u32 = 70_000;

fn big_array() -> String {
    format!("var a = []; for (var i = 0; i < {N}; i++) a[i] = i;")
}

// ------------------------------------------------------- the DoS family

#[test]
fn writing_many_indices_on_an_ordinary_object_mints_no_key() {
    assert_result(
        &format!("var o = {{}}; for (var i = 0; i < {N}; i++) o[i] = i; Object.keys(o).length"),
        "70000",
    );
}

#[test]
fn object_assign_into_an_ordinary_target_mints_no_key() {
    assert_result(
        &format!("{} Object.keys(Object.assign({{}}, a)).length", big_array()),
        "70000",
    );
}

#[test]
fn spreading_a_large_array_into_an_object_mints_no_key() {
    assert_result(
        &format!("{} var r = {{...a}}; Object.keys(r).length", big_array()),
        "70000",
    );
}

#[test]
fn an_object_rest_pattern_over_a_large_array_mints_no_key() {
    assert_result(
        &format!(
            "{} var {{length, ...rest}} = a; Object.keys(rest).length",
            big_array()
        ),
        "70000",
    );
}

/// The parse builds the object before any reviver runs, so this used to
/// poison the machine without a single reviver call.
#[test]
fn a_reviver_over_a_large_index_keyed_object_mints_no_key() {
    assert_result(
        &format!(
            "var o = {{}}; for (var i = 0; i < {N}; i++) o[i] = i; \
             Object.keys(JSON.parse(JSON.stringify(o), function (k, v) {{ return v; }})).length"
        ),
        "70000",
    );
}

// ------------------------------------------------- the operations still work

#[test]
fn an_index_property_answers_every_way_it_is_asked() {
    assert_result(
        "var o = {}; o[0] = 1; o[1] = 2; JSON.stringify(o)",
        "{\"0\":1,\"1\":2}",
    );
    assert_result(
        "var o = {}; o[0] = 1; String(o[0]) + '|' + String(o['0']) + '|' + String(o[1])",
        "1|1|undefined",
    );
    assert_result(
        "var o = {}; o[0] = 1; JSON.stringify(Object.getOwnPropertyDescriptor(o, '0'))",
        "{\"value\":1,\"writable\":true,\"enumerable\":true,\"configurable\":true}",
    );
    assert_result(
        "var o = {}; o[0] = 1; String('0' in o) + '|' + String(0 in o) + '|' + String(1 in o)",
        // `0 in o` is `'0' in o`: the operator takes ToPropertyKey of its
        // left operand, so the number and the string name the same own
        // property and both answer true.
        "true|true|false",
    );
    assert_result(
        "var o = {}; o[0] = 1; String(o.hasOwnProperty('0')) + '|' \
         + String(o.propertyIsEnumerable('0'))",
        "true|true",
    );
    assert_result(
        "var o = {}; o[0] = 1; String(delete o[0]) + '|' + String(o[0]) + '|' \
         + Object.keys(o).length",
        "true|undefined|0",
    );
    // Index keys ascending, ahead of the named chain — `fxOrdinaryOwnKeys`.
    assert_result(
        "var o = {}; o.b = 1; o[2] = 1; o[1] = 1; Object.keys(o).join(',')",
        "1,2,b",
    );
    assert_result(
        "var o = {}; o[0] = 1; var r = []; for (var k in o) r.push(k); r.join('|')",
        "0",
    );
    assert_result(
        "var p = {}; p[0] = 'proto'; var o = Object.create(p); \
         String(o[0]) + '|' + String(o.hasOwnProperty('0'))",
        "proto|false",
    );
    assert_result(
        "var o = {}; o[4294967294] = 1; Object.keys(o).join('|')",
        "4294967294",
    );
}

#[test]
fn the_integrity_operations_still_bind_an_index_property() {
    assert_result(
        "var o = {}; o[0] = 1; Object.freeze(o); o[0] = 9; \
         String(o[0]) + '|' + String(Object.isFrozen(o))",
        "1|true",
    );
    assert_result(
        "var o = {}; o[0] = 1; Object.seal(o); String(delete o[0]) + '|' + String(o[0])",
        "false|1",
    );
    assert_result(
        "var o = {}; o[0] = 1; Object.preventExtensions(o); o[1] = 2; \
         String(o[1]) + '|' + Object.keys(o).length",
        "undefined|1",
    );
    assert_result(
        "var o = {}; o[0] = 1; harden(o); o[0] = 9; \
         String(o[0]) + '|' + String(Object.isFrozen(o))",
        "1|true",
    );
    // harden is transitive through the store.
    assert_result(
        "var o = {}; o[0] = {}; harden(o); o[0].x = 1; \
         String(Object.isFrozen(o[0])) + '|' + String(o[0].x)",
        "true|undefined",
    );
}

/// An accessor cannot live in the store (`self.accessors` is keyed by
/// `(instance, id)`), so the property PROMOTES to a named slot — carrying its
/// current attributes with it, or a redefinition would read as a creation and
/// silently reset `enumerable`.
#[test]
fn an_accessor_on_an_index_promotes_and_keeps_its_attributes() {
    assert_result(
        "var o = {}; o[0] = 1; Object.defineProperty(o, '0', {get: function () { return 9; }}); \
         String(o[0]) + '|' + Object.keys(o).join(',')",
        "9|0",
    );
    assert_result(
        "var o = {}; o[0] = 1; Object.defineProperty(o, '0', {get: function () { return 9; }}); \
         Object.defineProperty(o, '0', {value: 3}); \
         String(o[0]) + '|' + Object.keys(o).join(',')",
        "3|0",
    );
    assert_result(
        "var o = {}; o[0] = 1; Object.defineProperty(o, '0', {enumerable: false}); \
         Object.keys(o).length + '|' + String(o[0])",
        "0|1",
    );
}

/// A promoted index keeps its place among the integer keys. The store lists
/// its indices and the named chain its names, so `[[OwnPropertyKeys]]` and
/// `for-in` emitted a promoted `"2"` after a stored `3` — `0+3+2` where XS
/// (one indexed chunk, `fxOrdinaryOwnKeys`) and OrdinaryOwnPropertyKeys give
/// `0+2+3`. `for-in` also kept an exotic shape's index expandos in insertion
/// order, and counted a stored index and a named one as two keys, so a
/// shadowed index was yielded twice.
#[test]
fn a_promoted_index_keeps_its_place_among_the_integer_keys() {
    let promoted = "var o = {0: 1, 2: 3, 3: 4, b: 1}; \
         Object.defineProperty(o, '2', {get: function () { return 9; }, \
             enumerable: true, configurable: true}); \
         o[1] = 7; o.a = 2;";
    for (probe, expected) in [
        ("Object.keys(o).join('+')", "0+1+2+3+b+a"),
        ("Object.getOwnPropertyNames(o).join('+')", "0+1+2+3+b+a"),
        ("Reflect.ownKeys(o).join('+')", "0+1+2+3+b+a"),
        (
            "Object.entries(o).map(function (e) { return e[0]; }).join('+')",
            "0+1+2+3+b+a",
        ),
        (
            "JSON.stringify(o)",
            r#"{"0":1,"1":7,"2":9,"3":4,"b":1,"a":2}"#,
        ),
        (
            "var r = []; for (var k in o) r.push(k); r.join('+')",
            "0+1+2+3+b+a",
        ),
        // Inherited keys follow every own key, index keys first per level.
        (
            "var p = Object.create(o); p[5] = 1; p.q = 1; \
             Object.defineProperty(p, '4', {get: function () {}, enumerable: true}); \
             var r = []; for (var k in p) r.push(k); r.join('+')",
            "4+5+q+0+1+2+3+b+a",
        ),
    ] {
        assert_result(&format!("{promoted} {probe}"), expected);
    }
    // An object `JSON.parse` built keeps its indices in the store too.
    assert_result(
        "var j = JSON.parse('{\"3\":1,\"1\":2}'); \
         Object.defineProperty(j, '1', {get: function () { return 5; }, \
             enumerable: true, configurable: true}); \
         j[0] = 0; Object.keys(j).join('+')",
        "0+1+3",
    );
    // An Array's promoted item, and the index expandos an exotic shape keeps
    // by name, are ordered the same way under `for-in`.
    assert_result(
        "var a = [1, 2, 3]; a.x = 1; \
         Object.defineProperty(a, '0', {get: function () { return 0; }, \
             enumerable: true, configurable: true}); \
         var r = []; for (var k in a) r.push(k); r.join('+')",
        "0+1+2+x",
    );
    assert_result(
        "var m = new Map(); m[3] = 1; m.k = 1; m[1] = 1; \
         var r = []; for (var k in m) r.push(k); r.join('+')",
        "1+3+k",
    );
    assert_result(
        "var s = new String('ab'); s[5] = 1; s.y = 1; s[3] = 1; \
         var r = []; for (var k in s) r.push(k); r.join('+')",
        "0+1+3+5+y",
    );
    // An own named (promoted) index shadows an inherited stored one, and an
    // own stored index an inherited named one: one key either way, not two.
    assert_result(
        "var o = {2: 1}; var p = Object.create(o); \
         Object.defineProperty(p, '2', {get: function () { return 0; }, \
             enumerable: true, configurable: true}); \
         var r = []; for (var k in p) r.push(k); r.join('+')",
        "2",
    );
    assert_result(
        "var o = {}; Object.defineProperty(o, '2', {get: function () { return 0; }, \
             enumerable: true, configurable: true}); \
         var p = Object.create(o); Object.defineProperty(p, '2', {value: 1, \
             writable: true, enumerable: true, configurable: true}); \
         var r = []; for (var k in p) r.push(k); r.join('+') + '|' + Object.keys(p).join('+')",
        "2|2",
    );
    // An exotic shape's index expandos, inherited, keep the same order per
    // level and are shadowed by an own index of the same number.
    assert_result(
        "var m = new Map(); m[3] = 1; m.k = 1; m[1] = 1; var o = Object.create(m); \
         o[2] = 1; o[1] = 0; o.z = 1; var r = []; for (var k in o) r.push(k); r.join('+')",
        "1+2+z+3+k",
    );
}

/// A function is an ordinary object for index storage, so `f[1] = 1` lands in
/// the index store — which the function arm of `[[OwnPropertyKeys]]` never
/// listed. The property was invisible to every key walk, and because
/// `Object.freeze` and `harden` freeze what that walk reports, it stayed
/// writable (and its referent unhardened) behind a `true` from
/// `Object.isFrozen`.
#[test]
fn a_function_lists_and_freezes_its_stored_index_keys() {
    let keyed = "var g = function () {}; g[3] = 1; g[1] = 1; \
         Object.defineProperty(g, '2', {get: function () {}, enumerable: true}); g.z = 1;";
    for (probe, expected) in [
        ("Object.keys(g).join('+')", "1+2+3+z"),
        (
            "Reflect.ownKeys(g).join('+')",
            "1+2+3+length+name+prototype+caller+z",
        ),
        (
            "var r = []; for (var k in g) r.push(k); r.join('+')",
            "1+2+3+z",
        ),
    ] {
        assert_result(&format!("{keyed} {probe}"), expected);
    }
    assert_result(
        "var f = function () {}; f[1] = 1; Object.freeze(f); f[1] = 2; \
         [f[1], Object.isFrozen(f), Object.getOwnPropertyDescriptor(f, '1').writable].join('|')",
        "1|true|false",
    );
    assert_result(
        "var h = function () {}; h[0] = {}; harden(h); h[0].x = 1; \
         [Object.isFrozen(h[0]), h[0].x].join('|')",
        "true|",
    );
}

/// The function fix above is one member of a class: every object kind keeps
/// its index keys in one ascending run ahead of its named keys, whatever it
/// stores them in. Each subject here gets a `3` and a `1` by index, a `z` by
/// name between them, and a `2` promoted to a named slot by its accessor;
/// `Reflect.ownKeys`, `Object.keys` and `for-in` all answer the indices first,
/// then the kind's own boot keys, then `z`.
#[test]
fn every_object_kind_lists_its_index_keys_first() {
    for (subject, expected) in [
        (
            "class {}",
            "1+2+3+length+name+prototype+z | 1+2+3+z | 1+2+3+z",
        ),
        ("() => 1", "1+2+3+length+name+z | 1+2+3+z | 1+2+3+z"),
        (
            "function () {}.bind(null)",
            "1+2+3+length+name+z | 1+2+3+z | 1+2+3+z",
        ),
        (
            "function* () {}",
            "1+2+3+length+name+prototype+z | 1+2+3+z | 1+2+3+z",
        ),
        // V8 lists an own `stack` ahead of `message`.
        ("new Error('m')", "1+2+3+message+z | 1+2+3+z | 1+2+3+z"),
        ("new Date(0)", "1+2+3+z | 1+2+3+z | 1+2+3+z"),
        ("/x/g", "1+2+3+lastIndex+z | 1+2+3+z | 1+2+3+z"),
        ("new Map()", "1+2+3+z | 1+2+3+z | 1+2+3+z"),
        ("new Set()", "1+2+3+z | 1+2+3+z | 1+2+3+z"),
        ("new WeakMap()", "1+2+3+z | 1+2+3+z | 1+2+3+z"),
        ("Promise.resolve()", "1+2+3+z | 1+2+3+z | 1+2+3+z"),
        ("new Boolean(true)", "1+2+3+z | 1+2+3+z | 1+2+3+z"),
        ("new Number(5)", "1+2+3+z | 1+2+3+z | 1+2+3+z"),
        ("Object(Symbol())", "1+2+3+z | 1+2+3+z | 1+2+3+z"),
        ("new ArrayBuffer(2)", "1+2+3+z | 1+2+3+z | 1+2+3+z"),
        (
            "new DataView(new ArrayBuffer(2))",
            "1+2+3+z | 1+2+3+z | 1+2+3+z",
        ),
        ("Object.create(null)", "1+2+3+z | 1+2+3+z | 1+2+3+z"),
        ("[].values()", "1+2+3+z | 1+2+3+z | 1+2+3+z"),
    ] {
        assert_result(
            &format!(
                "var o = {subject}; o[3] = 1; o.z = 1; o[1] = 1; \
                 Object.defineProperty(o, '2', {{get: function () {{ return 0; }}, \
                     enumerable: true, configurable: true}}); \
                 var r = []; for (var k in o) r.push(k); \
                 [Reflect.ownKeys(o).map(String).join('+'), Object.keys(o).join('+'), \
                     r.join('+')].join(' | ')"
            ),
            expected,
        );
    }
}

/// The exotic and instance kinds that keep some indices in their own storage
/// order a promoted accessor index among those too: an arguments object
/// (mapped or not), an Array with holes, a String wrapper past its length, a
/// class instance whose constructor wrote names and indices interleaved, and
/// a Proxy, whose writes land on its target in the same order.
#[test]
fn an_exotic_object_orders_a_promoted_index_among_its_own() {
    for mode in ["", "'use strict'; "] {
        assert_result(
            &format!(
                "function f() {{ {mode}var a = arguments; a.x = 1; a[5] = 1; \
                 Object.defineProperty(a, '3', {{get: function () {{ return 0; }}, \
                     enumerable: true, configurable: true}}); \
                 a[4] = 1; var r = []; for (var k in a) r.push(k); \
                 return Reflect.ownKeys(a).map(String).join('+') + ' | ' + r.join('+'); }} \
                 f(1, 2)"
            ),
            "0+1+3+4+5+length+callee+x+Symbol(Symbol.iterator) | 0+1+3+4+5+x",
        );
    }
    assert_result(
        "var a = [1, 2, 3]; a.x = 1; a[10] = 1; \
         Object.defineProperty(a, '5', {get: function () { return 0; }, \
             enumerable: true, configurable: true}); \
         var r = []; for (var k in a) r.push(k); \
         [Reflect.ownKeys(a).join('+'), r.join('+'), JSON.stringify(a)].join(' | ')",
        "0+1+2+5+10+length+x | 0+1+2+5+10+x | [1,2,3,null,null,0,null,null,null,null,1]",
    );
    assert_result(
        "var s = new String('ab'); \
         Object.defineProperty(s, '4', {get: function () { return 1; }, \
             enumerable: true, configurable: true}); \
         s[3] = 1; s.y = 1; var r = []; for (var k in s) r.push(k); \
         Reflect.ownKeys(s).join('+') + ' | ' + r.join('+')",
        "0+1+3+4+length+y | 0+1+3+4+y",
    );
    assert_result(
        "class C { constructor() { this.b = 1; this[2] = 1; this.a = 1; this[0] = 1; } } \
         var c = new C(); \
         Object.defineProperty(c, '1', {get: function () { return 0; }, \
             enumerable: true, configurable: true}); \
         var r = []; for (var k in c) r.push(k); \
         Reflect.ownKeys(c).join('+') + ' | ' + r.join('+')",
        "0+1+2+b+a | 0+1+2+b+a",
    );
    assert_result(
        "var t = {}; var p = new Proxy(t, {}); p[3] = 1; p.z = 1; p[1] = 1; \
         Object.defineProperty(p, '2', {get: function () { return 0; }, \
             enumerable: true, configurable: true}); \
         var r = []; for (var k in p) r.push(k); \
         [Reflect.ownKeys(p).join('+'), r.join('+'), Object.keys(t).join('+')].join(' | ')",
        "1+2+3+z | 1+2+3+z | 1+2+3+z",
    );
    // A TypedArray drops an out-of-range index and every other canonical
    // numeric string (`-0`, `1.5`); only a non-canonical `01` is an expando,
    // and it follows `z`.
    assert_result(
        "var t = new Uint8Array(2); t.z = 1; t[5] = 1; t['-0'] = 1; t['1.5'] = 1; \
         t['01'] = 1; var r = []; for (var k in t) r.push(k); \
         [Reflect.ownKeys(t).join('+'), r.join('+'), String(t[5])].join(' | ')",
        "0+1+z+01 | 0+1+z+01 | undefined",
    );
}

/// An array index is at most `4294967294`; `4294967295`, `01`, `-0` and
/// `1e3` are names and keep their insertion order after the named `z`. Every
/// kind draws that line in the same place, and `Object.keys` and `for-in`
/// agree on it.
#[test]
fn the_largest_array_index_is_the_last_integer_key() {
    let names = "3+7+4294967294+z+4294967295+01+-0+1e3";
    assert_result(
        "var r = []; [[], new String('ab'), function () {}, {}, \
             (function () { return arguments; })(), new Map()].forEach(function (o) { \
             o.z = 1; o['4294967295'] = 1; o['01'] = 1; o['4294967294'] = 1; o['-0'] = 1; \
             o['7'] = 1; o['1e3'] = 1; o['3'] = 1; \
             var s = []; for (var k in o) s.push(k); \
             r.push(Object.keys(o).join('+') === s.join('+') ? s.join('+') \
                 : 'keys ' + Object.keys(o).join('+')); \
         }); r.join(' | ')",
        &format!("{names} | 0+1+{names} | {names} | {names} | {names} | {names}"),
    );
}

/// Seventeen kinds of object, each able to hold an index property.
const KINDS: &str = "[function () {}, () => 1, class {}, function () {}.bind(null), \
     async function () {}, function* () {}, new Error('x'), new Map(), new Date(0), /x/, \
     Promise.resolve(), new String('a'), [], Object.create(null), new Proxy({}, {}), \
     new Boolean(true), Symbol.prototype]";

/// The integrity operations reach a stored index on every kind that has an
/// index store, not only the ordinary object and the function above.
#[test]
fn the_integrity_operations_bind_a_stored_index_on_every_kind() {
    let each = |answer: &str| {
        (0..17)
            .map(|i| format!("{i}:{answer}"))
            .collect::<Vec<_>>()
            .join(" ")
    };
    assert_result(
        &format!(
            "var r = []; {KINDS}.forEach(function (o, i) {{ o[5] = {{}}; Object.freeze(o); \
             o[5] = 2; var d = Object.getOwnPropertyDescriptor(o, '5'); \
             r.push(i + ':' + typeof o[5] + d.writable + Object.isFrozen(o)); }}); r.join(' ')"
        ),
        &each("objectfalsetrue"),
    );
    assert_result(
        &format!(
            "var r = []; {KINDS}.forEach(function (o, i) {{ o[5] = 1; Object.seal(o); \
             o[6] = 1; r.push(i + ':' + delete o[5] + Object.isSealed(o) + (6 in o)); }}); \
             r.join(' ')"
        ),
        &each("falsetruefalse"),
    );
    // harden is transitive through every kind's store.
    assert_result(
        &format!(
            "var r = []; {KINDS}.forEach(function (o, i) {{ o[5] = {{}}; harden(o); \
             o[5].x = 1; r.push(i + ':' + Object.isFrozen(o) + Object.isFrozen(o[5]) + o[5].x); \
             }}); r.join(' ')"
        ),
        &each("truetrueundefined"),
    );
    assert_result(
        "function f() { arguments[5] = {}; Object.freeze(arguments); arguments[5] = 1; \
         return [typeof arguments[5], Object.isFrozen(arguments), \
             Object.getOwnPropertyDescriptor(arguments, '5').writable].join(); } f(1)",
        "object,true,false",
    );
    assert_result(
        "function f() { arguments[5] = {}; harden(arguments); arguments[5].x = 1; \
         return [Object.isFrozen(arguments), Object.isFrozen(arguments[5]), \
             arguments[5].x].join(); } f(1)",
        "true,true,",
    );
}

/// Index keys a program adds to an intrinsic prototype list ahead of its boot
/// properties, as every own-keys order puts array indices first
/// (`fxOrdinaryOwnKeys` queues the index chunk before the named chain). A `1`
/// and `3` written by index and a `2` promoted to a named slot by its
/// accessor come first and ascending, then the boot string keys in boot
/// order, then a named key added after them, then the boot symbol keys. An
/// instance's `for-in` meets the inherited keys in the same order.
///
/// The probe reads the boot surface before it adds anything, so every added
/// key is created after every boot property, and it compares against that
/// surface rather than spelling it: the boot keys' own order is the engine's
/// choice, and XS and V8 already create them in different orders. A
/// comparison answers `true`, or the list it read. The added keys are
/// configurable, and deleting them must restore the boot surface. XS and V8
/// give every answer below.
#[test]
fn an_intrinsic_prototype_lists_its_index_keys_first() {
    // Nothing assigns an array element while the index-2 getter is
    // installed: on `Array.prototype` it is an inherited accessor without a
    // setter, so `push` would throw, as in XS and V8. Array literals and the
    // Array methods define their elements instead.
    let probe = "function probe(P, instance) { \
         var boot = Reflect.ownKeys(P); \
         Object.defineProperty(P, '2', {get: function () { return 9; }, \
             enumerable: true, configurable: true}); \
         P[3] = 1; P[1] = 1; P.zz = 1; \
         var strings = boot.filter(function (k) { return typeof k === 'string'; }); \
         var symbols = boot.filter(function (k) { return typeof k !== 'string'; }).map(String); \
         var all = Reflect.ownKeys(P).map(String).join('+'); \
         var names = Object.getOwnPropertyNames(P).join('+'); \
         var inherited = ''; for (var k in instance) inherited += '+' + k; \
         var answer = [ \
             all === ['1', '2', '3'].concat(strings, ['zz'], symbols).join('+') || all, \
             names === ['1', '2', '3'].concat(strings, ['zz']).join('+') || names, \
             Object.keys(P).join('+'), inherited.slice(1), [P[1], P[2], P[3]].join() \
         ]; \
         delete P[1]; delete P[2]; delete P[3]; delete P.zz; \
         answer.push(Reflect.ownKeys(P).map(String).join('+') === boot.map(String).join('+')); \
         return answer.join(' ; '); \
     }";
    for target in [
        "Map.prototype, new Map()",
        "String.prototype, new String('')",
        "Array.prototype, []",
        "Number.prototype, new Number(0)",
        "Boolean.prototype, new Boolean(false)",
        "Function.prototype, function () {}",
        "Object.prototype, {}",
        "RegExp.prototype, /x/",
        "Error.prototype, new Error('m')",
        // V8 leaves the inherited index keys out of a TypedArray's `for-in`
        // and answers `zz` there; XS walks them.
        "Object.getPrototypeOf(Uint8Array.prototype), new Uint8Array(0)",
        "Array, class extends Array {}",
        "Iterator.prototype, [].values()",
        "Object.getPrototypeOf([].values()), [].values()",
        "Symbol.prototype, Object(Symbol())",
        "Date.prototype, new Date(0)",
        "Promise.prototype, Promise.resolve()",
    ] {
        assert_result(
            &format!("{probe} probe({target})"),
            "true ; true ; 1+2+3+zz ; 1+2+3+zz ; 1,9,1 ; true",
        );
    }
}

/// Every "this index is provably absent" claim in the engine enumerates the
/// storages an index can live in, and adding one falsifies each of them. These
/// are the sites that got it wrong: the generic-Array answerability probe, the
/// `has` fallback, and both directions of the sparse-index skipper — the last
/// of which made `indexOf` answer `-1` over live elements.
#[test]
fn the_generic_array_methods_see_an_index_stored_by_index() {
    assert_result(
        "var o = {length: 2, 0: 'a', 1: 'b'}; \
         Array.prototype.map.call(o, function (x) { return x + '!'; }).join('|')",
        "a!|b!",
    );
    assert_result(
        "var o = {length: 2, 0: 'a'}; String(Array.prototype.indexOf.call(o, 'a'))",
        "0",
    );
    assert_result(
        "var o = {length: 3, 0: 'a', 2: 'c'}; String(Array.prototype.lastIndexOf.call(o, 'c'))",
        "2",
    );
    assert_result(
        "var o = {length: 3, 0: 'a', 2: 'c'}; \
         JSON.stringify(Array.prototype.filter.call(o, function () { return true; }))",
        "[\"a\",\"c\"]",
    );
    assert_result("Array.from({length: 3, 1: 'x'}).join('|')", "|x|");
    assert_result(
        "var o = {length: 2, 0: 'a', 1: 'b'}; Array.prototype.join.call(o, '-')",
        "a-b",
    );
    assert_result(
        "var o = {length: 3, 0: 'a', 2: 'c'}; var r = []; \
         Array.prototype.forEach.call(o, function (v, i) { r.push(i + ':' + v); }); r.join(',')",
        "0:a,2:c",
    );
    // The answer must not depend on whether some unrelated code interned the
    // index's NAME: an uninterned key takes the by-index path and an interned
    // one the by-id path, and both have to find the same property.
    assert_result(
        "var probe = {}; probe['0'] = 1; var o = {}; o[0] = 'a'; \
         String('0' in o) + '|' + String(o.hasOwnProperty('0')) + '|' + String(o[0])",
        "true|true|a",
    );
}

/// The index store's values are strong GC edges, walked by BOTH collectors —
/// the full one through `extra_edges` and the partial one through
/// `each_side_table_ref`. A referent reachable only as `o[0]` must survive a
/// collection; missing either walk hands its slot to the next allocation.
#[test]
fn a_referent_reachable_only_through_the_index_store_survives_collection() {
    assert_result(
        "var o = {}; o[0] = {tag: 'kept'}; \
         for (var i = 0; i < 40000; i++) { var junk = {a: i, b: [i]}; } \
         String(o[0].tag)",
        "kept",
    );
    // A string value there holds a chunk offset that full-GC compaction
    // rewrites; a missed remap leaves it dangling.
    assert_result(
        "var o = {}; o[0] = 'a string long enough to live in the chunk arena'; \
         for (var i = 0; i < 40000; i++) { var junk = 'garbage ' + i; } \
         o[0].length + '|' + o[0].slice(0, 8)",
        "47|a string",
    );
}
