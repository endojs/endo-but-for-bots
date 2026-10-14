//! A key a program adds to an intrinsic object follows every key the object
//! is created with, as XS and the specification order them
//! (OrdinaryOwnPropertyKeys lists string keys in creation order).
//!
//! Ironhorse installs an intrinsic's members lazily: those a program names at
//! link time, and the rest when something reflects on the object. A guest key
//! added before that reflection took a place among the members, so
//! `Map.prototype.zz = 1` listed `constructor,set,size,zz,get,…`. A guest's
//! first new key on an intrinsic now installs the object's remaining members
//! before it, and each member takes its place in the object's own order as it
//! is installed. A member deleted and added again is a new key, last as the
//! specification puts it.
//!
//! Each case runs on its own machine. Every expectation is the XS oracle's
//! answer; V8 shares the guest-key cases, and orders a built-in's own
//! members its own way.
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
fn a_guest_key_follows_every_boot_key() {
    check(&[
        (
            "map_prototype_set",
            r#"Map.prototype.zz = 1; var k = Reflect.ownKeys(Map.prototype).filter(function (k) { return typeof k === 'string'; }); k[k.length - 1] + ':' + (k.indexOf('get') >= 0) + ':' + (k.indexOf('values') >= 0)"#,
            r#"zz:true:true"#,
        ),
        (
            "array_prototype_define",
            r#"Object.defineProperty(Array.prototype, 'zz', {value: 1, configurable: true}); var k = Object.getOwnPropertyNames(Array.prototype); k[k.length - 1]"#,
            r#"zz"#,
        ),
        (
            "promise_prototype",
            r#"Promise.prototype.zz = 1; var k = Object.getOwnPropertyNames(Promise.prototype); k[k.length - 1]"#,
            r#"zz"#,
        ),
        (
            "math_namespace",
            r#"Math.zz = 1; var k = Object.getOwnPropertyNames(Math); k[k.length - 1]"#,
            r#"zz"#,
        ),
        (
            "reflect_namespace",
            r#"Reflect.zz = 1; var k = Object.getOwnPropertyNames(Reflect); [k[k.length - 1], k.length].join()"#,
            r#"zz,14"#,
        ),
        (
            "symbol_key",
            r#"var s = Symbol('s'); Map.prototype[s] = 1; var k = Object.getOwnPropertySymbols(Map.prototype); k[k.length - 1] === s"#,
            r#"true"#,
        ),
        (
            "symbol_key_on_a_namespace",
            r#"var s = Symbol(); Math[s] = 1; Reflect.ownKeys(Math).map(String).slice(-2).join('+')"#,
            r#"Symbol(Symbol.toStringTag)+Symbol()"#,
        ),
        (
            "symbol_key_defined",
            r#"var s = Symbol('t'); Reflect.defineProperty(Array.prototype, s, {value: 1, configurable: true}); var k = Object.getOwnPropertySymbols(Array.prototype); [k[k.length - 1] === s, k.length].join()"#,
            r#"true,3"#,
        ),
        (
            "constructors",
            r#"function last(o) { var k = Object.getOwnPropertyNames(o); return k[k.length - 1]; } var r = []; [Array, Object, Promise, Map, Set, Symbol, Number, String, BigInt, Date, RegExp, Uint8Array, Object.getPrototypeOf(Uint8Array), ArrayBuffer, Proxy, Iterator].forEach(function (o, i) { o.zz = 1; r.push(i + ':' + last(o)); delete o.zz; }); r.join(' ')"#,
            r#"0:zz 1:zz 2:zz 3:zz 4:zz 5:zz 6:zz 7:zz 8:zz 9:zz 10:zz 11:zz 12:zz 13:zz 14:zz 15:zz"#,
        ),
        (
            "namespaces_and_prototypes",
            r#"function last(o) { var k = Object.getOwnPropertyNames(o); return k[k.length - 1]; } var r = []; [JSON, Atomics, Object.prototype, Function.prototype, Object.getPrototypeOf([][Symbol.iterator]()), Iterator.prototype, Error.prototype, TypeError.prototype, String.prototype, Number.prototype, Set.prototype, Date.prototype, RegExp.prototype, ArrayBuffer.prototype, DataView.prototype, WeakMap.prototype, Object.getPrototypeOf(function* () {}).prototype, Uint8Array.prototype].forEach(function (o, i) { o.zz = 1; r.push(i + ':' + last(o)); delete o.zz; }); r.join(' ')"#,
            r#"0:zz 1:zz 2:zz 3:zz 4:zz 5:zz 6:zz 7:zz 8:zz 9:zz 10:zz 11:zz 12:zz 13:zz 14:zz 15:zz 16:zz 17:zz"#,
        ),
        (
            "native_functions",
            r#"function last(o) { var k = Object.getOwnPropertyNames(o); return k[k.length - 1]; } var r = []; [Array.prototype.map, Math.max, parseInt, Object.getOwnPropertyDescriptor(Map.prototype, 'size').get].forEach(function (o, i) { o.zz = 1; r.push(i + ':' + last(o) + ':' + Object.getOwnPropertyNames(o).length); delete o.zz; }); r.join(' ')"#,
            r#"0:zz:3 1:zz:3 2:zz:3 3:zz:3"#,
        ),
        (
            "class_static_field",
            r#"class D extends Map { static zz = 1; } D.zy = 2; [Object.getOwnPropertyNames(D).join('+'), Object.getOwnPropertyNames(D.prototype).join('+')].join(' | ')"#,
            r#"length+name+prototype+zz+zy | constructor"#,
        ),
    ]);
}

#[test]
fn every_entry_point_puts_the_guest_key_last() {
    check(&[
        (
            "reflect_and_object_functions",
            r#"function last(o) { var k = Object.getOwnPropertyNames(o); return k[k.length - 1]; } var r = []; [Array, Map.prototype, Math].forEach(function (o, i) { Reflect.set(o, 'zy', 1); r.push(last(o)); Reflect.defineProperty(o, 'zx', {value: 1, configurable: true}); r.push(last(o)); Object.assign(o, {zw: 1}); r.push(last(o)); Object.defineProperties(o, {zv: {value: 1, configurable: true}}); r.push(last(o)); }); r.join(' ')"#,
            r#"zy zx zw zv zy zx zw zv zy zx zw zv"#,
        ),
        (
            "reflect_and_object_functions_on_set_prototype",
            r#"function last(o) { var k = Object.getOwnPropertyNames(o); return k[k.length - 1]; } var r = []; var P = Set.prototype; Reflect.set(P, 'zy', 1); r.push(last(P)); Reflect.defineProperty(P, 'zx', {value: 1, configurable: true}); r.push(last(P)); Object.assign(P, {zw: 1}); r.push(last(P)); Object.defineProperties(P, {zv: {value: 1, configurable: true}}); r.push(last(P)); r.join(' ')"#,
            r#"zy zx zw zv"#,
        ),
        (
            "assignment_targets",
            r#"function last(o) { var k = Object.getOwnPropertyNames(o); return k[k.length - 1]; } var r = []; [Array, Map.prototype, Math].forEach(function (o, i) { o['zu'] = 1; r.push(last(o)); [o.zt] = [1]; r.push(last(o)); for (o.zs in {a: 1}); r.push(last(o)); o.zr ??= 1; r.push(last(o)); }); r.join(' ')"#,
            r#"zu zt zs zr zu zt zs zr zu zt zs zr"#,
        ),
    ]);
}

#[test]
fn a_member_deleted_and_added_again_comes_last() {
    check(&[
        (
            "map_get",
            r#"delete Map.prototype.get; Map.prototype.get = function () {}; var k = Object.getOwnPropertyNames(Map.prototype); k[k.length - 1]"#,
            r#"get"#,
        ),
        (
            "for_in_through_the_prototype",
            r#"var o = Object.create(Map.prototype); o.q = 1; Map.prototype.yy = 2; var r = []; for (var k in o) r.push(k); r.join()"#,
            r#"q,yy"#,
        ),
        (
            "a_static_named_at_run_time",
            r#"var k = 'is' + 'Array'; var v = Array[k]; delete Array[k]; Array[k] = v; Object.getOwnPropertyNames(Array).join()"#,
            r#"length,name,prototype,from,fromAsync,of,isArray"#,
        ),
        (
            "a_static_named_in_the_text",
            r#"var v = Array.from; delete Array.from; Array.from = v; Object.getOwnPropertyNames(Array).join()"#,
            r#"length,name,prototype,fromAsync,isArray,of,from"#,
        ),
        (
            "a_namespace_member",
            r#"var m = Math.max; delete Math.max; Math.max = m; var k = Object.getOwnPropertyNames(Math); k[k.length - 1]"#,
            r#"max"#,
        ),
        (
            "a_global_binding",
            r#"var zz = 1; var m = Map; delete globalThis.Map; globalThis.Map = m; Object.getOwnPropertyNames(globalThis).slice(-2).join()"#,
            r#"zz,Map"#,
        ),
        (
            "a_symbol_key",
            r#"var f = Map.prototype[Symbol.iterator]; delete Map.prototype[Symbol.iterator]; Map.prototype[Symbol.iterator] = f; Reflect.ownKeys(Map.prototype).slice(-2).map(String).join()"#,
            r#"Symbol(Symbol.toStringTag),Symbol(Symbol.iterator)"#,
        ),
        (
            "before_the_rest_is_installed",
            r#"var p = globalThis['Ma' + 'p']['proto' + 'type']; var k = 'g' + 'et'; var g = p[k]; delete p[k]; p[k] = g; Object.getOwnPropertyNames(p).join()"#,
            r#"size,clear,delete,entries,forEach,has,keys,set,values,getOrInsert,getOrInsertComputed,constructor,get"#,
        ),
        (
            "deleted_and_never_added_again",
            r#"var p = globalThis['Ma' + 'p']['proto' + 'type']; delete p['g' + 'et']; Object.getOwnPropertyNames(p).join()"#,
            r#"size,clear,delete,entries,forEach,has,keys,set,values,getOrInsert,getOrInsertComputed,constructor"#,
        ),
    ]);
}

/// An intrinsic's keys come in its own order whatever the program's text
/// names: a member linked because the text names it takes its place among
/// the rest, and a guest's global follows every standard binding.
#[test]
fn the_text_does_not_reorder_an_intrinsic() {
    check(&[
        (
            "a_member_named_in_the_text",
            r#"var q = { clear: 1 }; Object.getOwnPropertyNames(Map.prototype).join()"#,
            r#"size,clear,delete,entries,forEach,get,has,keys,set,values,getOrInsert,getOrInsertComputed,constructor"#,
        ),
        (
            "constructor_named_in_the_text",
            r#"var q = { constructor: 1 }; Object.getOwnPropertyNames(TypeError.prototype).join()"#,
            r#"name,message,constructor"#,
        ),
        (
            "another_intrinsic_reflected_first",
            r#"Reflect.ownKeys(Reflect); Object.getOwnPropertyNames(WeakMap.prototype).join()"#,
            r#"delete,get,has,set,getOrInsert,getOrInsertComputed,constructor"#,
        ),
        (
            "a_guest_global",
            r#"var zz = 1; var n = Object.getOwnPropertyNames(globalThis); [n[n.length - 1], n.indexOf('Array')].join()"#,
            r#"zz,1"#,
        ),
        (
            "async_generator_prototype",
            r#"Reflect.ownKeys(Object.getPrototypeOf(async function* () {}).prototype).map(String).join()"#,
            r#"next,return,throw,constructor,Symbol(Symbol.toStringTag)"#,
        ),
        (
            "disposable_stack_prototype",
            r#"Object.getOwnPropertySymbols(DisposableStack.prototype).map(String).join()"#,
            r#"Symbol(Symbol.dispose),Symbol(Symbol.toStringTag)"#,
        ),
    ]);
}
