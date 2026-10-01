//! A direct eval inherits its caller's class context.
//! XS's `fxRunEval` parses a direct eval with its caller's flags: `new.target`
//! when the caller can construct, `super` property access when it has a home
//! object, `arguments` refused in a class field initializer, and a strict eval's
//! unresolved `#name` bound at run time from the caller's environment
//! (`EVAL_PRIVATE`). Ironhorse compiled every eval as a bare program, so each of
//! these was a SyntaxError (or, for `arguments`, a ReferenceError).
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
fn private_names_resolve_through_the_caller() {
    check(&[
        (
            "field",
            r#"class C { #x = 7; m() { return eval('this.#x'); } } new C().m()"#,
            r#"7"#,
        ),
        (
            "assign",
            r#"class C { #x = 1; m(o) { return eval('o.#x = 5, o.#x'); } } new C().m(new C())"#,
            r#"5"#,
        ),
        (
            "update",
            r#"class C { #x = 1; m() { return eval('this.#x++'); } } var c = new C(); [c.m(), c.m()].join()"#,
            r#"1,2"#,
        ),
        (
            "nested_eval",
            r#"class C { #x = 1; m() { return eval('eval("this.#x")'); } } new C().m()"#,
            r#"1"#,
        ),
        (
            "arrow",
            r#"class C { #x = 1; m() { return eval('() => this.#x')(); } } new C().m()"#,
            r#"1"#,
        ),
        (
            "function_in_eval",
            r#"class C { #x = 1; m() { return eval('(function () { return this.#x; })').call(this); } } new C().m()"#,
            r#"1"#,
        ),
        (
            "function_calling_eval",
            r#"class C { #x = 1; m() { var f = function () { return eval('this.#x'); }; return f.call(this); } } new C().m()"#,
            r#"1"#,
        ),
        (
            "static",
            r#"class C { #x = 1; static #y = 2; m() { return eval('[this.#x, C.#y]').join(); } } new C().m()"#,
            r#"1,2"#,
        ),
        (
            "method",
            r#"class C { #m() { return 'priv'; } go() { return eval('this.#m()'); } } new C().go()"#,
            r#"priv"#,
        ),
        (
            "getter",
            r#"class C { get #g() { return 'g'; } m() { return eval('this.#g'); } } new C().m()"#,
            r#"g"#,
        ),
        (
            "generator",
            r#"class C { #x = 1; *g() { yield eval('this.#x'); } } new C().g().next().value"#,
            r#"1"#,
        ),
        (
            "class_in_eval",
            r#"class A { #x = 'a'; m() { return eval('class B { #x = "b"; g(o) { return o.#x; } }; new B().g(new B())'); } } new A().m()"#,
            r#"b"#,
        ),
        (
            "with_declarations",
            r#"class C { #x = 1; m() { return eval('let z = 2; this.#x + z'); } } new C().m()"#,
            r#"3"#,
        ),
        (
            "wrong_object",
            r#"class C { #x = 1; m(o) { try { return eval('o.#x'); } catch (e) { return e.constructor.name; } } } new C().m({})"#,
            r#"TypeError"#,
        ),
        (
            "undeclared",
            r#"class C { #y = 1; m() { try { return eval('this.#x'); } catch (e) { return e.constructor.name + ':' + e.message; } } } new C().m()"#,
            r#"SyntaxError:eval #x: undefined private property"#,
        ),
        (
            "strict_program",
            r#"'use strict'; var r; try { eval('this.#x'); } catch (e) { r = e.constructor.name + ':' + e.message; } r"#,
            r#"SyntaxError:eval #x: undefined private property"#,
        ),
        (
            "sloppy_program",
            r#"var r; try { eval('this.#x'); } catch (e) { r = e.constructor.name + ':' + e.message; } r"#,
            r#"SyntaxError:invalid private identifier"#,
        ),
        (
            "indirect",
            r#"class C { #x = 1; m() { try { return (0, eval)('this.#x'); } catch (e) { return e.constructor.name; } } } new C().m()"#,
            r#"SyntaxError"#,
        ),
        // The specification, as V8; XS rejects `#x in o` inside an eval ("invalid character").
        (
            "brand_check",
            r#"class C { #x = 1; m(o) { return eval('#x in o'); } } [new C().m(new C()), new C().m({})].join()"#,
            r#"true,false"#,
        ),
        // The specification, as V8; XS throws a ReferenceError ("get C: not initialized yet").
        (
            "static_block",
            r#"class C { static #s = 4; static { this.v = eval('C.#s'); } } C.v"#,
            r#"4"#,
        ),
    ]);
}

#[test]
fn super_resolves_through_the_callers_home() {
    check(&[
        (
            "method",
            r#"class B { g() { return 'B'; } } class D extends B { g() { return eval('super.g()'); } } new D().g()"#,
            r#"B"#,
        ),
        (
            "getter",
            r#"class B { get v() { return 'bv'; } } class D extends B { m() { return eval('super.v'); } } new D().m()"#,
            r#"bv"#,
        ),
        (
            "static",
            r#"class B { static s() { return 'S'; } } class D extends B { static m() { return eval('super.s()'); } } D.m()"#,
            r#"S"#,
        ),
        (
            "object_literal",
            r#"var o = { m() { return eval('super.toString === Object.prototype.toString'); } }; o.m()"#,
            r#"true"#,
        ),
        (
            "arrow_in_eval",
            r#"var o = { m() { return eval('() => super.toString === Object.prototype.toString')(); } }; o.m()"#,
            r#"true"#,
        ),
        (
            "plain_function",
            r#"class C { m() { var f = function () { return eval('super.x'); }; try { return f(); } catch (e) { return e.constructor.name; } } } new C().m()"#,
            r#"SyntaxError"#,
        ),
        // The specification, as V8; XS throws a TypeError ("cannot coerce to object").
        (
            "derived_constructor",
            r#"class B { constructor() { this.b = 1; } } class D extends B { constructor() { super(); this.v = eval('super.constructor === B'); } } new D().v"#,
            r#"true"#,
        ),
        // XS, and so Ironhorse, rejects `super()` in an eval ("invalid super"), so the
        // constructor never binds `this`. The specification allows it in a derived
        // constructor, and V8 answers `[object Object]`.
        (
            "super_call",
            r#"class B {} class D extends B { constructor() { try { eval('super()'); } catch (e) { this.e = e.constructor.name; } } } try { new D(); } catch (e) { e.constructor.name }"#,
            r#"ReferenceError"#,
        ),
    ]);
}

#[test]
fn new_target_and_field_initializers() {
    check(&[
        (
            "constructed",
            r#"function F() { this.t = eval('new.target') === F; } new F().t"#,
            r#"true"#,
        ),
        (
            "called",
            r#"function f() { return eval('new.target'); } String(f())"#,
            r#"undefined"#,
        ),
        (
            "both",
            r#"function f() { return eval('new.target === f'); } [f(), new f() instanceof f].join()"#,
            r#"false,true"#,
        ),
        (
            "arrow_in_eval",
            r#"function F() { this.v = eval('() => new.target')() === F; } new F().v"#,
            r#"true"#,
        ),
        (
            "program",
            r#"var r; try { r = eval('new.target'); } catch (e) { r = e.constructor.name; } r"#,
            r#"SyntaxError"#,
        ),
        (
            "field",
            r#"class C { x = eval('new.target'); } String(new C().x)"#,
            r#"undefined"#,
        ),
        (
            "field_arguments",
            r#"class C { x = (function () { try { return eval('arguments'); } catch (e) { return e.constructor.name; } })(); } typeof new C().x"#,
            r#"object"#,
        ),
        (
            "field_this",
            r#"class C { x = eval('typeof this'); } new C().x"#,
            r#"object"#,
        ),
    ]);
}
