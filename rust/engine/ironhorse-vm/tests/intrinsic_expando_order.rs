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
