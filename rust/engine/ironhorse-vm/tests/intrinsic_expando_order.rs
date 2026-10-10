//! A key a program adds to an intrinsic object follows every key the object
//! is created with, as XS and the specification order them
//! (OrdinaryOwnPropertyKeys lists string keys in creation order).
//!
//! Ironhorse installs an intrinsic's members lazily: those a program names at
//! link time, and the rest when something reflects on the object. A guest key
//! added before that reflection took a place among the members, so
//! `Map.prototype.zz = 1` listed `constructor,set,size,zz,get,…`. A guest's
//! first new key on an intrinsic now installs the object's remaining members
//! before it. A member deleted and added again is a new key, last as the
//! specification puts it.
//!
//! Each case runs on its own machine. Every expectation is the XS oracle's
//! answer, which V8 shares.
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
    ]);
}
