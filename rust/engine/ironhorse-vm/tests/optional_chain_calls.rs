//! An optional chain short-circuits to `undefined` as a call's callee.
//! Every `?.` link of a chain branched to one landing, whatever the stack held
//! there. As a call's callee the chain leaves a receiver/value pair, so a
//! short-circuit landed a slot short — `(a?.b)()` underflowed the stack and
//! halted the engine — or a slot long, when a call inside the chain had pushed
//! its receiver: `f?.()?.()` and `a?.b()?.()` with a nullish base then called a
//! stale stack slot and threw. XS emits the same unbalanced landings (and throws
//! `call: not a function` for the second kind). The coder now lands each
//! short-circuit at a level that matches, through an enclosing optional call's
//! receiver-dropping path where one fits, and keeps XS's bytes for every chain
//! that was already balanced.
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
fn a_parenthesized_chain_callee() {
    check(&[
        (
            "nullish",
            r#"var a = null; var r; try { (a?.b)(); r = 'no'; } catch (e) { r = e.constructor.name + ':' + e.message; } r"#,
            r#"TypeError:call: not a function"#,
        ),
        (
            "nullish_member",
            r#"var a = null; var r; try { (a?.b.c)(); r = 'no'; } catch (e) { r = e.constructor.name; } r"#,
            r#"TypeError"#,
        ),
        (
            "nullish_call",
            r#"var a = null; var r; try { (a?.())(); r = 'no'; } catch (e) { r = e.constructor.name; } r"#,
            r#"TypeError"#,
        ),
        (
            "then_optional_call",
            r#"var a = null; String((a?.b)?.())"#,
            r#"undefined"#,
        ),
        (
            "tagged_template",
            r#"var f = null; var r; try { r = (f?.x)`q`; } catch (e) { r = e.constructor.name; } r"#,
            r#"TypeError"#,
        ),
        (
            "present_keeps_this",
            r#"var o = { m() { return this; } }; [(o?.m)() === o, o?.m?.() === o, (o?.m)?.() === o].join()"#,
            r#"true,true,true"#,
        ),
        (
            "present_member_this",
            r#"var o = { x: { y() { return this.z; }, z: 5 } }; [o?.x.y(), (o?.x.y)(), o.x?.y?.()].join()"#,
            r#"5,5,5"#,
        ),
    ]);
}

#[test]
fn a_call_inside_the_chain() {
    check(&[
        // The specification, as V8; XS throws `call: not a function`.
        (
            "optional_call_twice",
            r#"var f = null; String(f?.()?.())"#,
            r#"undefined"#,
        ),
        // The specification, as V8; XS throws `call: not a function`.
        (
            "optional_call_three_times",
            r#"var f = null; String(f?.()?.()?.())"#,
            r#"undefined"#,
        ),
        // The specification, as V8; XS throws `call: not a function`.
        (
            "method_then_optional_call",
            r#"var a = null; String(a?.b()?.())"#,
            r#"undefined"#,
        ),
        // The specification, as V8; XS throws `call: not a function`.
        (
            "arguments_not_evaluated",
            r#"var a = null; var n = 0; String(a?.b(n++)?.(n++)) + n"#,
            r#"undefined0"#,
        ),
        // The specification, as V8; XS throws `call: not a function`.
        (
            "in_a_loop",
            r#"var r = []; var a = null; for (var i = 0; i < 3; i++) r.push(String(a?.b()?.())); r.join()"#,
            r#"undefined,undefined,undefined"#,
        ),
        (
            "in_a_function",
            r#"function F() { var a = null; return a?.b()?.(); } String(F())"#,
            r#"undefined"#,
        ),
        (
            "longer_chain",
            r#"var a = null; String(a?.b()?.c?.())"#,
            r#"undefined"#,
        ),
        (
            "present",
            r#"var g = function () { return function () { return 7; }; }; [g?.()?.(), g?.()(), (g?.())()].join()"#,
            r#"7,7,7"#,
        ),
        (
            "present_methods",
            r#"var o = { b() { return { c() { return 'C'; } }; } }; [o?.b()?.c(), o?.b?.()?.c?.(), (o?.b)().c()].join()"#,
            r#"C,C,C"#,
        ),
        (
            "returns_nullish",
            r#"var a = { b() { return null; } }; String(a?.b()?.())"#,
            r#"undefined"#,
        ),
    ]);
}

#[test]
fn balanced_chains_are_unchanged() {
    check(&[
        (
            "member_and_call",
            r#"var o = { m() { return 1; } }; var r = []; r.push((o?.m)()); r.push(o?.m()); var n = null; r.push(String(n?.m())); r.push(String(n?.m().x.y)); r.push(String(n?.[0]?.())); r.join()"#,
            r#"1,1,undefined,undefined,undefined"#,
        ),
        (
            "receiver",
            r#"var o = { a: { b() { return this === o.a; } } }; [o?.a.b(), (o?.a).b(), (o?.a?.b)() === false].join()"#,
            r#"true,true,false"#,
        ),
        (
            "delete_and_typeof",
            r#"var a = null; [delete a?.b, delete a?.b.c, typeof a?.b, String(a?.[0]?.())].join()"#,
            r#"true,true,undefined,undefined"#,
        ),
    ]);
}

#[test]
fn a_short_circuit_after_an_overcounted_base_lands_balanced() {
    // XS's linear stack level counts a template substitution's `TO_STRING`,
    // a spread, `??=`/`||=`, a destructuring assignment, a class heritage and
    // a tagged template as pushes. Each base below runs one of those before
    // its `?.`, so its short-circuit is landed by structure, not by that
    // count; XS lands all but the last correctly too.
    check(&[
        (
            "m1",
            r#"var n = {}, k = 'x'; try { String(n[`${k}`]?.b) } catch (e) { 'caught ' + e }"#,
            r#"undefined"#,
        ),
        (
            "m2",
            r#"var o = {}; try { String((o.p ??= null)?.b) } catch (e) { 'caught ' + e }"#,
            r#"undefined"#,
        ),
        (
            "m3",
            r#"function f() { return null } try { String(f(...[])?.b) } catch (e) { 'caught ' + e }"#,
            r#"undefined"#,
        ),
        (
            "m4",
            r#"var x; try { String(([x] = [null], x)?.b) } catch (e) { 'caught ' + e }"#,
            r#"undefined"#,
        ),
        (
            "m5",
            r#"var m = new Map(); var k = 'a'; try { String(m.get(`${k}`)?.size) } catch (e) { 'caught ' + e }"#,
            r#"undefined"#,
        ),
        (
            "m6",
            r#"var m = new Map(); var k = 'a'; [1,2].map(i => m.get(`k${i}`)?.size ?? 0).join()"#,
            r#"0,0"#,
        ),
        (
            "m7",
            r#"var o = { f(){ return null } }; String(o.f(...[1])?.x)"#,
            r#"undefined"#,
        ),
        (
            "m8",
            r#"var x = 1; String((x ||= null, null)?.b)"#,
            r#"undefined"#,
        ),
        (
            "m9",
            r#"var o = null; var x; String(o?.[(x ??= 'k')]?.z)"#,
            r#"undefined"#,
        ),
        (
            "n1",
            r#"function fn7() { return () => {}; } try { String(fn7()`hello`?.a) } catch (e) { 'caught ' + e }"#,
            r#"undefined"#,
        ),
        (
            "n2",
            r#"class A { constructor() { return null } } var r; class B extends A { constructor() { try { r = String(super()?.a) } catch (e) { r = 'caught ' + e } return {} } } new B(); r"#,
            r#"undefined"#,
        ),
        (
            "p1",
            r#"var B = class {}; var reg = new Map(); try { String(reg.get(class extends B {})?.name) } catch (e) { 'caught ' + e }"#,
            r#"undefined"#,
        ),
        (
            "p2",
            r#"var o = { f(...a) { return null } }; var args = [1]; try { [1, o.f?.(...args)?.x, 3].join() } catch (e) { 'caught ' + e }"#,
            r#"1,,3"#,
        ),
        (
            "p3",
            r#"var o = {}; var x; try { String((x = [1], [o.k] = x, o.z)?.q) } catch (e) { 'caught ' + e }"#,
            r#"undefined"#,
        ),
        (
            "p4",
            r#"function f(k) { var cache = {}; return cache[`key:${k}`]?.value ?? 'miss' } [f(1), f(2)].join()"#,
            r#"miss,miss"#,
        ),
        (
            "p5",
            r#"var r = []; for (var i = 0; i < 3; i++) { var o = {}; r.push(o[`k${i}`]?.v) } r.length"#,
            r#"3"#,
        ),
        (
            "u1",
            r#"var o = {}; JSON.stringify([1, (o.p ??= null)?.b, 3])"#,
            r#"[1,null,3]"#,
        ),
        (
            "u2",
            r#"var o = {}; var r = 'x' + (o.p ??= null)?.b; r"#,
            r#"xundefined"#,
        ),
        (
            "u3",
            r#"var o = {}; function f(...a) { return a.length + ':' + a.join() } f(1, (o.p ||= null)?.b, 3)"#,
            r#"3:1,,3"#,
        ),
        (
            "u4",
            r#"var v; function f(...a) { return a.length + ':' + a.join() } f(1, (v ??= null)?.b, 3)"#,
            r#"3:1,,3"#,
        ),
        (
            "v1",
            r#"var o = { b() { return null } }; try { String(o?.b(`${1}`)?.()) } catch (e) { 'caught ' + e }"#,
            r#"undefined"#,
        ),
        (
            "v2",
            r#"var o = { b() { return null } }; try { String(o?.b(`${1}`)?.c()) } catch (e) { 'caught ' + e }"#,
            r#"undefined"#,
        ),
        // The specification, as V8: a call of `undefined`. XS lands this
        // short-circuit a slot long and calls a stale value (`new: not a
        // constructor`).
        (
            "v3",
            r#"var o = { b() { return null } }; try { String((o?.b(`${1}`)?.c)()) } catch (e) { 'caught ' + e }"#,
            r#"caught TypeError: call: not a function"#,
        ),
        (
            "w1",
            r#"var o = {}, k = 1; var s = 'pre-' + o[`${k}`]?.v; s"#,
            r#"pre-undefined"#,
        ),
        (
            "w2",
            r#"var o = {}, k = 1; function f(a, b, c) { return [a, b, c].join('|') } f('A', 'B', o[`${k}`]?.v)"#,
            r#"A|B|"#,
        ),
        (
            "w3",
            r#"var o = {}, k = 1; var x = 10, y = 20; x + y * (o[`${k}`]?.v ?? 2)"#,
            r#"50"#,
        ),
        (
            "x1",
            r#"function f() { return null } try { String(f(...[])?.()) } catch (e) { 'caught ' + e }"#,
            r#"undefined"#,
        ),
        (
            "x2",
            r#"var g = () => null; try { String(g(`${1}`)?.()) } catch (e) { 'caught ' + e }"#,
            r#"undefined"#,
        ),
    ]);
}
