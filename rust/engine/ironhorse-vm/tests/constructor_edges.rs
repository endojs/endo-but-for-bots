//! Constructor edge cases measured against XS.
//!
//! `class … extends` checking its heritage, Symbol and BigInt as constructors
//! that refuse `new`, `super(...)`'s `new.target` staying with the super call
//! rather than a construct in its arguments, the construct paths that halted the
//! engine, `new` on a bound native, and where the RegExp constructor reads its
//! prototype.
//!
//! Each case runs on its own machine. Every expectation is the XS oracle's
//! answer, except where a case says the specification (and V8) is followed
//! instead; the PR that added a table lists those departures.
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
fn class_heritage_is_checked() {
    check(&[
        // A bound function is a constructor, refused for the `prototype` it
        // lacks; the others are not constructors.
        (
            "non_constructor",
            r#"var r = []; [function () {}.bind(), () => 1, Math.max, {}, 1].forEach(function (h) { try { class C extends h {} r.push('ok'); } catch (e) { r.push(e.constructor.name + ':' + e.message); } }); r.join()"#,
            r#"TypeError:extends: class prototype is not an object,TypeError:extends: class is not a constructor,TypeError:extends: class is not a constructor,TypeError:extends: class is not a constructor,TypeError:extends: class is not a constructor"#,
        ),
        (
            "prototype_not_object",
            r#"var r = []; [1, 'x', undefined].forEach(function (p) { function F() {} F.prototype = p; try { class C extends F {} r.push('ok'); } catch (e) { r.push(e.constructor.name + ':' + e.message); } }); r.join()"#,
            r#"TypeError:extends: class prototype is not an object,TypeError:extends: class prototype is not an object,TypeError:extends: class prototype is not an object"#,
        ),
        (
            "null_heritage",
            r#"class C extends null {} [Object.getPrototypeOf(C.prototype), Object.getPrototypeOf(C) === Function.prototype].join()"#,
            r#",true"#,
        ),
        (
            "prototype_null",
            r#"function F() {} F.prototype = null; class C extends F {} Object.getPrototypeOf(C.prototype)"#,
            r#"null"#,
        ),
        (
            "prototype_read_once",
            r#"var n = 0; var F = new Proxy(function () {}, {get: function (t, k, r) { if (k === 'prototype') n++; return Reflect.get(t, k, r); }}); class C extends F {} n"#,
            r#"1"#,
        ),
    ]);
}

#[test]
fn symbol_and_bigint_are_constructors_that_refuse_new() {
    check(&[
        (
            "reflect_construct",
            r#"var r = []; [Symbol, BigInt].forEach(function (C) { try { Reflect.construct(C, []); } catch (e) { r.push(e.constructor.name + ':' + e.message); } }); r.join()"#,
            r#"TypeError:new: Symbol,TypeError:new: BigInt"#,
        ),
        (
            "is_constructor",
            r#"var r = []; [Symbol, BigInt].forEach(function (C) { try { class X extends C {} r.push('extends'); } catch (e) { r.push(e.message); } }); r.join()"#,
            r#"extends,extends"#,
        ),
        (
            "new_symbol",
            r#"try { new Symbol(); } catch (e) { e.constructor.name + ':' + e.message }"#,
            r#"TypeError:new: Symbol"#,
        ),
    ]);
}

#[test]
fn super_new_target_belongs_to_the_super_call() {
    check(&[
        (
            "argument_construct",
            r#"class D extends Array { constructor() { super(new Map()); } } var d = new D(); [d instanceof D, d[0] instanceof Map, Object.getPrototypeOf(d[0]) === Map.prototype].join()"#,
            r#"true,true,true"#,
        ),
        (
            "nested_super",
            r#"class M extends Map {} class D extends Array { constructor() { super(new M()); } } var d = new D(); [d instanceof D, d[0] instanceof M].join()"#,
            r#"true,true"#,
        ),
        (
            "native_after_user",
            r#"class B { constructor(x) { this.x = x; } } class D extends B { constructor() { super(new Set([1])); } } var d = new D(); [d instanceof D, d.x instanceof Set, Object.getPrototypeOf(d.x) === Set.prototype].join()"#,
            r#"true,true,true"#,
        ),
        (
            "proxy_parent",
            r#"var P = new Proxy(Map, {}); class D extends P {} var d = new D(); [d instanceof D, d instanceof Map].join()"#,
            r#"true,true"#,
        ),
    ]);
}
