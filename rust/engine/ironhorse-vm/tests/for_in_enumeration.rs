//! A for-in loop enumerates as XS does.
//!
//! XS steps a for-in through an enumerator whose private prototype
//! (`mxEnumeratorFunction.prototype`, which inherits `%IteratorPrototype%`)
//! owns its `next`; only a program that captures the enumerator, through a
//! patched `%IteratorPrototype%.return`, reaches it. It lists one object's
//! own keys at a time, the next prototype only when the level before it is
//! done, and reads each key's own property on that level when its turn
//! comes: a key that is gone is passed over, and one that is present is
//! visited — enumerable or not — so an inherited key of the same name is
//! never yielded. Ironhorse's enumerator inherited the guest-patchable
//! `%ArrayIteratorPrototype%`, collected every level up front, yielded keys
//! deleted mid-loop, let a non-enumerable own key leave an inherited one
//! visible, skipped a Proxy, and halted on a primitive or nullish operand.
//!
//! The specification leaves enumeration order and mid-loop changes to the
//! implementation; where V8 answers differently, the case says so.
//!
//! Each case runs on its own machine. Every expectation is the XS oracle's
//! answer, except where a case says the specification (and V8) is followed
//! instead; `ironhorse-262/tests/xs_departures.rs` records those departures.
mod common;
use common::TestCompiler;

use ironhorse_vm::{parse_symbols, Interp};

fn run(source: &str) -> String {
    let source = source.to_string();
    std::thread::Builder::new()
        .stack_size(ironhorse_vm::NATIVE_STACK_BYTES)
        .spawn(move || {
            let (code, symbols) = ironhorse_compile::compile_atoms(&source).unwrap();
            let mut machine = Interp::new();
            machine.set_source_compiler(std::rc::Rc::new(TestCompiler));
            machine.link_intrinsics(&parse_symbols(&symbols));
            let outcome = machine.run(&code);
            assert!(outcome.completed, "{:?}\n  {source}", outcome.halt);
            outcome.result
        })
        .unwrap()
        .join()
        .unwrap()
}

fn check(cases: &[(&str, &str, &str)]) {
    for (name, source, expected) in cases {
        assert_eq!(run(source), *expected, "{name}: {source}");
    }
}

#[test]
fn a_patched_array_iterator_next_cannot_drive_for_in() {
    check(&[
        (
            "calls",
            r#"var AIP = Object.getPrototypeOf([][Symbol.iterator]()); var orig = AIP.next; var calls = 0; AIP.next = function () { calls++; return orig.call(this); }; var n = 0; for (var k in {a: 1, b: 2}) n++; n + ':' + calls"#,
            r#"2:0"#,
        ),
        (
            "capture",
            r#"var AIP = Object.getPrototypeOf([][Symbol.iterator]()); var seen = 'none'; AIP.next = function () { seen = typeof this; return {done: true}; }; for (var k in {a: 1}); seen"#,
            r#"none"#,
        ),
        (
            "forge",
            r#"var AIP = Object.getPrototypeOf([][Symbol.iterator]()); var n = 0; AIP.next = function () { n++; return n < 3 ? {value: 'x' + n, done: false} : {done: true}; }; var r = []; for (var k in {}) r.push(k); r.join() + '|' + n"#,
            r#"|0"#,
        ),
        (
            "deleted",
            r#"var AIP = Object.getPrototypeOf([][Symbol.iterator]()); delete AIP.next; var r = []; for (var k in {a: 1, b: 2}) r.push(k); r.join()"#,
            r#"a,b"#,
        ),
        (
            "iterator_prototype_next",
            r#"var IP = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())); IP.next = function () { throw 1; }; var r = []; for (var k in {a: 1, b: 2}) r.push(k); r.join()"#,
            r#"a,b"#,
        ),
        (
            "return_on_break",
            r#"var IP = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())); var seen = 'none'; IP.return = function () { seen = typeof this; return {}; }; for (var k in {a: 1, b: 2}) break; seen"#,
            r#"object"#,
        ),
        // The enumerator does not inherit `%ArrayIteratorPrototype%`.
        (
            "array_iterator_return",
            r#"var AIP = Object.getPrototypeOf([][Symbol.iterator]()); var seen = 'none'; AIP.return = function () { seen = 'called'; return {}; }; for (var k in {a: 1}) break; seen"#,
            r#"none"#,
        ),
        // A captured enumerator's result keeps `value` and `done` fixed, as
        // every intrinsic iterator's reused result does. V8 has no enumerator
        // object to capture.
        (
            "captured_result",
            r#"var IP = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())); var cap; IP.return = function () { cap = this; return {}; }; for (var k in {a: 1, b: 2, c: 3}) break; var r = cap.next(); var t = []; try { r.value = 9; } catch (e) { t.push('w'); } t.push(delete r.value); t.push(Object.keys(r).join('+')); t.push(cap.next().value); t.join()"#,
            r#"false,value+done,c"#,
        ),
    ]);
}

#[test]
fn each_level_is_listed_when_its_turn_comes() {
    check(&[
        // A non-enumerable own key added mid-loop was never listed, so the
        // inherited one is still yielded (V8 agrees).
        (
            "own_key_added_mid_loop",
            r#"var p = {a: 1, b: 2}, o = Object.create(p); o.x = 1; var r = []; for (var k in o) { r.push(k); if (k === 'x') Object.defineProperty(o, 'b', {value: 1}); } r.join()"#,
            r#"x,a,b"#,
        ),
        // V8 answers `a`.
        (
            "key_added_to_prototype_mid_loop",
            r#"var p = {}, o = Object.create(p); o.a = 1; var r = []; for (var k in o) { r.push(k); p.z = 1; } r.join()"#,
            r#"a,z"#,
        ),
        // V8 answers `a`.
        (
            "prototype_swapped_mid_loop",
            r#"var q = {y: 1}, p = {z: 1}, o = Object.create(p); o.a = 1; var r = []; for (var k in o) { r.push(k); Object.setPrototypeOf(o, q); } r.join()"#,
            r#"a,y"#,
        ),
        // V8 answers `a`.
        (
            "made_enumerable_before_its_turn",
            r#"var o = {a: 1}; Object.defineProperty(o, 'b', {value: 2, enumerable: false, configurable: true}); var r = []; for (var k in o) { r.push(k); Object.defineProperty(o, 'b', {enumerable: true}); } r.join()"#,
            r#"a,b"#,
        ),
        // The own `b` was gone at its turn, so it was never visited. V8
        // answers `a`.
        (
            "hiding_key_deleted",
            r#"var p = {b: 1}, o = Object.create(p); o.a = 1; Object.defineProperty(o, 'b', {value: 2, enumerable: false, configurable: true}); var r = []; for (var k in o) { r.push(k); delete o.b; } r.join()"#,
            r#"a,b"#,
        ),
        // V8 answers `a,b,c`.
        (
            "own_key_deleted_yields_the_inherited_one_in_place",
            r#"var p = {c: 1, b: 2}; var o = Object.create(p); o.a = 1; o.b = 3; var r = []; for (var k in o) { r.push(k); if (k === 'a') delete o.b; } r.join()"#,
            r#"a,c,b"#,
        ),
        (
            "levels_in_order",
            r#"var a = []; a[5] = 1; a.x = 2; a[1] = 3; var o = Object.create(a); o[3] = 1; o.y = 1; var r = []; for (var k in o) r.push(k); r.join()"#,
            r#"3,y,1,5,x"#,
        ),
        (
            "nested_over_the_same_object",
            r#"var p = {a: 1}; var o = Object.create(p); var r = []; for (var k in o) { r.push(k); for (var j in o) r.push(j); } r.join()"#,
            r#"a,a"#,
        ),
        (
            "suspended_in_a_generator",
            r#"function* g() { var o = {a: 1, b: 2}; for (var k in o) yield k; } var it = g(); [it.next().value, it.next().value, it.next().done].join()"#,
            r#"a,b,true"#,
        ),
    ]);
}

#[test]
fn a_proxy_level_runs_its_traps() {
    check(&[
        (
            "receiver",
            r#"var p = new Proxy({a: 1, b: 2}, {}); var r = []; for (var k in p) r.push(k); r.join()"#,
            r#"a,b"#,
        ),
        (
            "prototype",
            r#"var o = Object.create(new Proxy({a: 1, b: 2}, {})); o.c = 1; var r = []; for (var k in o) r.push(k); r.join()"#,
            r#"c,a,b"#,
        ),
        // V8 reads the prototype before the first descriptor:
        // `keys,proto,gopda,bodya,gopdb,bodyb`.
        (
            "trap_order",
            r#"var log = []; var t = {a: 1, b: 2}; var p = new Proxy(t, {ownKeys: function (t) { log.push('keys'); return Reflect.ownKeys(t); }, getOwnPropertyDescriptor: function (t, k) { log.push('gopd' + k); return Reflect.getOwnPropertyDescriptor(t, k); }, getPrototypeOf: function (t) { log.push('proto'); return Reflect.getPrototypeOf(t); }}); for (var k in p) log.push('body' + k); log.join()"#,
            r#"keys,gopda,bodya,gopdb,bodyb,proto"#,
        ),
        // A Proxy level is listed only when its turn comes. V8 lists every level
        // first: `keys,proto,bodyc,gopda,bodya,gopdb,bodyb`.
        (
            "prototype_trap_order",
            r#"var log = []; var t = {a: 1, b: 2}; var p = new Proxy(t, {ownKeys: function (t) { log.push('keys'); return Reflect.ownKeys(t); }, getOwnPropertyDescriptor: function (t, k) { log.push('gopd' + k); return Reflect.getOwnPropertyDescriptor(t, k); }, getPrototypeOf: function (t) { log.push('proto'); return Reflect.getPrototypeOf(t); }}); var o = Object.create(p); o.c = 1; for (var k in o) log.push('body' + k); log.join()"#,
            r#"bodyc,keys,gopda,bodya,gopdb,bodyb,proto"#,
        ),
        // A key whose descriptor the trap denies is passed over, on the receiver
        // or on a prototype level.
        (
            "descriptor_undefined",
            r#"var p = new Proxy({a: 1, b: 2}, {getOwnPropertyDescriptor: function (t, k) { return k === 'a' ? undefined : Reflect.getOwnPropertyDescriptor(t, k); }}); var r = []; for (var k in p) r.push(k); r.join()"#,
            r#"b"#,
        ),
        (
            "descriptor_undefined_on_prototype",
            r#"var p = new Proxy({a: 1, b: 2}, {getOwnPropertyDescriptor: function (t, k) { return k === 'a' ? undefined : Reflect.getOwnPropertyDescriptor(t, k); }}); var o = Object.create(p); var r = []; for (var k in o) r.push(k); r.join()"#,
            r#"b"#,
        ),
        (
            "descriptor_not_enumerable",
            r#"var p = new Proxy({a: 1}, {getOwnPropertyDescriptor: function (t, k) { return {value: 1, enumerable: false, configurable: true}; }}); var r = []; for (var k in p) r.push(k); r.join() + '|'"#,
            r#"|"#,
        ),
        // A symbol key is never yielded, and the trap's own key order is kept.
        (
            "symbol_and_unknown_keys",
            r#"var s = Symbol('s'); var p = new Proxy({}, {ownKeys: function () { return ['a', s, 'b']; }, getOwnPropertyDescriptor: function (t, k) { return {value: 1, enumerable: true, configurable: true}; }}); var r = []; for (var k in p) r.push(k); r.join()"#,
            r#"a,b"#,
        ),
        (
            "own_keys_order",
            r#"var p = new Proxy({a: 1, b: 2}, {ownKeys: function () { return ['b', 'a', 'zz']; }}); var r = []; for (var k in p) r.push(k); r.join()"#,
            r#"b,a"#,
        ),
        (
            "hidden_by_a_non_enumerable_own_key",
            r#"var p = new Proxy({b: 1}, {}); var o = Object.create(p); o.a = 1; Object.defineProperty(o, 'b', {value: 1, enumerable: false}); var r = []; for (var k in o) r.push(k); r.join()"#,
            r#"a"#,
        ),
        (
            "key_added_to_target_mid_loop",
            r#"var t = {a: 1}; var p = new Proxy(t, {}); var r = []; for (var k in p) { r.push(k); t.b = 1; } r.join()"#,
            r#"a"#,
        ),
        (
            "array_target",
            r#"var r = []; for (var k in new Proxy([1, 2], {})) r.push(k); r.join()"#,
            r#"0,1"#,
        ),
        // A trap's throw propagates out of the loop when that level's turn comes.
        // V8 answers `RangeError` for the second and third, having listed every
        // level before the first iteration.
        (
            "throwing_own_keys",
            r#"var p = new Proxy({}, {ownKeys: function () { throw new RangeError('k'); }}); try { for (var k in p); 'no' } catch (e) { e.constructor.name }"#,
            r#"RangeError"#,
        ),
        (
            "throwing_own_keys_on_prototype",
            r#"var p = new Proxy({}, {ownKeys: function () { throw new RangeError('k'); }}); var o = Object.create(p); o.x = 1; var r = []; try { for (var k in o) r.push(k); } catch (e) { r.push(e.constructor.name); } r.join()"#,
            r#"x,RangeError"#,
        ),
        (
            "throwing_get_prototype_of",
            r#"var p = new Proxy({a: 1}, {getPrototypeOf: function () { throw new RangeError('p'); }}); var r = []; try { for (var k in p) r.push(k); } catch (e) { r.push(e.constructor.name); } r.join()"#,
            r#"a,RangeError"#,
        ),
        (
            "throwing_descriptor",
            r#"var p = new Proxy({a: 1}, {getOwnPropertyDescriptor: function () { throw new RangeError('d'); }}); var r = []; try { for (var k in p) r.push(k); } catch (e) { r.push(e.constructor.name); } r.join()"#,
            r#"RangeError"#,
        ),
        // A revoked level, or one whose trap reports a key twice, throws a
        // TypeError at its turn.
        (
            "revoked",
            r#"var o = Proxy.revocable({}, {}); o.revoke(); try { for (var k in o.proxy); 'no' } catch (e) { e.constructor.name }"#,
            r#"TypeError"#,
        ),
        (
            "revoked_mid_loop_on_the_chain",
            r#"var o = Proxy.revocable({a: 1}, {}); var c = Object.create(o.proxy); c.x = 1; var r = []; try { for (var k in c) { r.push(k); o.revoke(); } } catch (e) { r.push(e.constructor.name); } r.join()"#,
            r#"x,TypeError"#,
        ),
        (
            "duplicate_own_keys",
            r#"var p = new Proxy({}, {ownKeys: function () { return ['a', 'a']; }}); try { for (var k in p); 'no' } catch (e) { e.constructor.name }"#,
            r#"TypeError"#,
        ),
        (
            "duplicate_own_keys_on_prototype",
            r#"var p = new Proxy({}, {ownKeys: function () { return ['a', 'a']; }}); var o = Object.create(p); try { for (var k in o); 'no' } catch (e) { e.constructor.name }"#,
            r#"TypeError"#,
        ),
    ]);
}

#[test]
fn a_key_deleted_before_its_turn_is_skipped() {
    check(&[
        (
            "own",
            r#"var o = {a: 1, b: 2, c: 3}; var r = []; for (var k in o) { r.push(k); delete o.b; } r.join()"#,
            r#"a,c"#,
        ),
        (
            "inherited",
            r#"var p = {x: 1}; var o = Object.create(p); o.y = 2; var r = []; for (var k in o) { r.push(k); delete p.x; } r.join()"#,
            r#"y"#,
        ),
        (
            "array_length",
            r#"var o = [1, 2, 3]; var r = []; for (var k in o) { r.push(k); o.length = 1; } r.join()"#,
            r#"0"#,
        ),
        (
            "arguments",
            r#"function f() { var r = []; for (var k in arguments) { r.push(k); delete arguments[1]; } return r.join(); } f(1, 2, 3)"#,
            r#"0,2"#,
        ),
        (
            "strict_arguments",
            r#"function f(a, b) { 'use strict'; var r = []; for (var k in arguments) { r.push(k); delete arguments[1]; } return r.join(); } f(1, 2, 3)"#,
            r#"0,2"#,
        ),
        (
            "hole_filled_mid_loop",
            r#"var o = [1, , 3]; o.x = 9; var r = []; for (var k in o) { r.push(k); if (k === '0') o[1] = 2; } r.join()"#,
            r#"0,2,x"#,
        ),
        (
            "readded",
            r#"var o = {a: 1, b: 2}; var r = []; for (var k in o) { r.push(k); delete o.b; o.b = 5; } r.join()"#,
            r#"a,b"#,
        ),
        (
            "own_deleted_inherited_survives",
            r#"var p = {a: 1, b: 2}; var o = Object.create(p); o.b = 3; var r = []; for (var k in o) { r.push(k); delete o.b; } r.join()"#,
            r#"b,a"#,
        ),
        (
            "index_store",
            r#"var o = {0: 'a', 1: 'b', 2: 'c'}; var r = []; for (var k in o) { r.push(k); delete o[2]; } r.join()"#,
            r#"0,1"#,
        ),
        // V8 answers `a,b`.
        (
            "made_non_enumerable",
            r#"var o = {a: 1, b: 2}; var r = []; for (var k in o) { r.push(k); Object.defineProperty(o, 'b', {enumerable: false}); } r.join()"#,
            r#"a"#,
        ),
    ]);
}

#[test]
fn a_non_enumerable_own_key_hides_an_inherited_one() {
    check(&[
        (
            "ordinary",
            r#"var p = {x: 1, y: 2}; var o = Object.create(p); Object.defineProperty(o, 'x', {value: 0, enumerable: false}); var r = []; for (var k in o) r.push(k); r.join()"#,
            r#"y"#,
        ),
        (
            "function_metadata",
            r#"var p = {length: 1, name: 2, prototype: 3, other: 4}; var o = function () {}; Object.setPrototypeOf(o, p); var r = []; for (var k in o) r.push(k); r.join()"#,
            r#"other"#,
        ),
        (
            "array_length",
            r#"var o = [1]; Object.setPrototypeOf(o, {length: 5, z: 1}); var r = []; for (var k in o) r.push(k); r.join()"#,
            r#"0,z"#,
        ),
        (
            "string_wrapper",
            r#"var o = Object('ab'); Object.setPrototypeOf(o, {length: 1, 0: 'q', 7: 'r', w: 1}); var r = []; for (var k in o) r.push(k); r.join()"#,
            r#"0,1,7,w"#,
        ),
        (
            "string_wrapper_expandos",
            r#"var o = Object('ab'); o.x = 1; o[5] = 'y'; var r = []; for (var k in o) r.push(k); r.join()"#,
            r#"0,1,5,x"#,
        ),
        (
            "typed_array",
            r#"var o = new Uint8Array(3); var r = []; for (var k in o) r.push(k); r.join()"#,
            r#"0,1,2"#,
        ),
        (
            "promoted_index_on_function",
            r#"var o = function () {}; o[3] = 1; o[1] = 1; Object.defineProperty(o, '2', {get: function () {}, enumerable: true}); o.z = 1; var r = []; for (var k in o) r.push(k); r.join()"#,
            r#"1,2,3,z"#,
        ),
    ]);
}

#[test]
fn every_value_can_be_enumerated() {
    check(&[
        (
            "nullish",
            r#"var n = 0; for (var k in null) n++; for (var k in undefined) n++; n"#,
            r#"0"#,
        ),
        (
            "string",
            r#"String.prototype.z = 1; var r = []; for (var k in 'ab') r.push(k); r.join()"#,
            r#"0,1,z"#,
        ),
        (
            "number",
            r#"Number.prototype.z = 1; var r = []; for (var k in 5) r.push(k); for (var k in 1.5) r.push(k); r.join()"#,
            r#"z,z"#,
        ),
        (
            "boolean",
            r#"Boolean.prototype.z = 1; var r = []; for (var k in true) r.push(k); r.join()"#,
            r#"z"#,
        ),
        (
            "bigint",
            r#"BigInt.prototype.z = 1; var r = []; for (var k in 1n) r.push(k); r.join()"#,
            r#"z"#,
        ),
        (
            "symbol",
            r#"Symbol.prototype.z = 1; var r = []; for (var k in Symbol()) r.push(k); r.join()"#,
            r#"z"#,
        ),
    ]);
}

/// Every kind of object lists its own keys, then each prototype's in turn:
/// an instance's class prototype, a Map's or a TypedArray's intrinsic
/// prototype, and no prototype at all. A frozen object enumerates as any
/// other, and a symbol key is never yielded.
#[test]
fn every_object_kind_lists_its_own_level_first() {
    check(&[
        (
            "own_key_added_mid_loop",
            r#"var o = {a: 1}; var r = []; for (var k in o) { r.push(k); o.b = 2; } r.join()"#,
            r#"a"#,
        ),
        (
            "class_instance",
            r#"class C { constructor() { this.y = 1; this[1] = 1; } m() {} } C.prototype.z = 1; var r = []; for (var k in new C()) r.push(k); r.join()"#,
            r#"1,y,z"#,
        ),
        (
            "map_expando",
            r#"var m = new Map(); m.a = 1; Map.prototype.zz = 1; var r = []; for (var k in m) r.push(k); delete Map.prototype.zz; r.join()"#,
            r#"a,zz"#,
        ),
        (
            "typed_array_expando",
            r#"var t = new Uint8Array(2); t.x = 1; Object.getPrototypeOf(Uint8Array.prototype).q = 1; var r = []; for (var k in t) r.push(k); delete Object.getPrototypeOf(Uint8Array.prototype).q; r.join()"#,
            r#"0,1,x,q"#,
        ),
        (
            "frozen",
            r#"var o = Object.freeze({a: 1, b: 2}); var r = []; for (var k in o) r.push(k); r.join()"#,
            r#"a,b"#,
        ),
        (
            "symbol_keys_skipped",
            r#"var s = Symbol(); var o = {[s]: 1, a: 1}; var r = []; for (var k in o) r.push(typeof k); r.join()"#,
            r#"string"#,
        ),
        (
            "null_prototype",
            r#"var o = Object.create(null); o.a = 1; var r = []; for (var k in o) r.push(k); r.join()"#,
            r#"a"#,
        ),
    ]);
}

/// Every loop head binds each key as an ordinary assignment or binding
/// would, and every jump out of or past an iteration leaves the enumerator
/// in step.
#[test]
fn every_loop_head_and_jump_steps_the_enumerator() {
    check(&[
        (
            "let_closures",
            r#"var r = []; for (let k in {a: 1, b: 2}) r.push(function () { return k; }); r.map(function (f) { return f(); }).join()"#,
            r#"a,b"#,
        ),
        (
            "const_closures",
            r#"var r = []; for (const k in {a: 1, b: 2}) r.push(function () { return k; }); r.map(function (f) { return f(); }).join()"#,
            r#"a,b"#,
        ),
        (
            "member_and_pattern_heads",
            r#"var o = {}; var r = []; for (o.p in {a: 1, b: 2}) r.push(o.p); var x = {}; for ([x.q] in {ab: 1}) r.push(x.q); r.join()"#,
            r#"a,b,a"#,
        ),
        (
            "array_pattern_head",
            r#"var r = []; for (var [a, b] in {xy: 1, zw: 2}) r.push(b + a); r.join()"#,
            r#"yx,wz"#,
        ),
        (
            "object_pattern_head",
            r#"var r = []; for (let {length} in {abc: 1, d: 2}) r.push(length); r.join()"#,
            r#"3,1"#,
        ),
        (
            "continue",
            r#"var r = []; for (var k in {a: 1, b: 2, c: 3}) { if (k === 'b') continue; r.push(k); } r.join()"#,
            r#"a,c"#,
        ),
        (
            "labelled_continue",
            r#"var o = {a: 1, b: 2}; var r = []; outer: for (var i = 0; i < 2; i++) { for (var k in o) { r.push(i + k); continue outer; } } r.join()"#,
            r#"0a,1a"#,
        ),
        (
            "labelled_continue_between_for_ins",
            r#"var r = []; outer: for (var k in {a: 1, b: 2}) { for (var j in {x: 1, y: 2}) { if (j === 'y') continue outer; r.push(k + j); } } r.join()"#,
            r#"ax,bx"#,
        ),
        (
            "labelled_break",
            r#"var r = []; outer: for (var k in {a: 1, b: 2}) { for (var j in {x: 1, y: 2}) { r.push(k + j); break outer; } } r.join()"#,
            r#"ax"#,
        ),
        // A `return` or a `throw` out of the loop closes the enumerator, as
        // `return_on_break` does for a `break`. V8 has no enumerator to close and
        // answers 0.
        (
            "return_and_throw_close_the_enumerator",
            r#"var IP = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())); var n = 0; IP.return = function () { n++; return {}; }; function f() { for (var k in {a: 1}) return k; } f(); try { for (var k in {a: 1}) throw 1; } catch (e) {} delete IP.return; n"#,
            r#"2"#,
        ),
    ]);
}
