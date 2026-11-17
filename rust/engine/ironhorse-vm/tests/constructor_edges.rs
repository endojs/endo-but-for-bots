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

#[test]
fn engine_halts_became_catchable_errors() {
    check(&[
        (
            "array_lengths",
            r#"var r = []; [-1, 2 ** 32, 1.5, NaN].forEach(function (v) { try { new Array(v); } catch (e) { r.push(e.constructor.name + ':' + e.message); } }); try { Array(-1); } catch (e) { r.push('call:' + e.constructor.name); } r.join()"#,
            r#"RangeError:invalid length,RangeError:invalid length,RangeError:invalid length,RangeError:invalid length,call:RangeError"#,
        ),
        (
            "array_max_length",
            r#"new Array(4294967295).length"#,
            r#"4294967295"#,
        ),
    ]);
}

#[test]
fn a_bound_native_constructs() {
    check(&[
        (
            "map",
            r#"var B = Map.bind(null); var m = new B([[1, 2]]); [m.get(1), m instanceof Map, Object.getPrototypeOf(m) === Map.prototype].join()"#,
            r#"2,true,true"#,
        ),
        (
            "array_and_date",
            r#"var A = Array.bind(null, 1, 2); var D = Date.bind(null, 0); [JSON.stringify(new A(3)), new D().getTime()].join()"#,
            r#"[1,2,3],0"#,
        ),
        (
            "error_promise_object",
            r#"var E = Error.bind(null, 'm'); var P = Promise.bind(null, function (r) { r(1); }); var O = Object.bind(null); [new E().message, new P() instanceof Promise, typeof new O()].join()"#,
            r#"m,true,object"#,
        ),
        (
            "not_constructors",
            r#"var r = []; [Symbol.bind(null), Math.max.bind(null), (() => 1).bind(null)].forEach(function (B) { try { new B(); } catch (e) { r.push(e.constructor.name + ':' + e.message); } }); r.join()"#,
            r#"TypeError:new: Symbol,TypeError:new: not a constructor,TypeError:new: not a constructor"#,
        ),
        (
            "reflect_construct_new_target",
            r#"var B = Array.bind(null, 1); class X {} var a = Reflect.construct(B, [2], X); [Object.getPrototypeOf(a) === X.prototype, a.length, Array.isArray(a)].join()"#,
            r#"true,2,true"#,
        ),
        (
            "bound_bound",
            r#"var B = Map.bind(null).bind(null); new B() instanceof Map"#,
            r#"true"#,
        ),
        (
            "typed_and_regexp",
            r#"var U = Uint8Array.bind(null, 3); var R = RegExp.bind(null, 'a'); [new U().length, String(new R('g'))].join()"#,
            r#"3,/a/g"#,
        ),
        (
            "bad_length",
            r#"var B = Array.bind(null); try { new B(-1); } catch (e) { e.constructor.name + ':' + e.message }"#,
            r#"RangeError:invalid length"#,
        ),
    ]);
}

#[test]
fn a_regexp_reads_its_prototype_between_its_reads_and_conversions() {
    check(&[
        // The specification, as V8; XS answers `like:Psrcflgpsfs>ok,like_flags:Psrcpsgs>ok`.
        (
            "regexp_like",
            r#"var log = []; function NT() { return new Proxy(function () {}, {get: function (t, k, r) { if (k === 'prototype') log.push('P'); return Reflect.get(t, k, r); }}); } function A(n, v) { return {valueOf: function () { log.push(n + 'v'); return v; }, toString: function () { log.push(n + 's'); return String(v); }}; } function t(name, C, args) { log = []; var r; try { Reflect.construct(C, args, NT()); r = 'ok'; } catch (e) { r = e.constructor.name; } out.push(name + ':' + log.join('') + '>' + r); } var out = []; var like = {[Symbol.match]: true, get source() { log.push('src'); return A('p', 'x'); }, get flags() { log.push('flg'); return A('f', 'g'); }}; t('like', RegExp, [like]); t('like_flags', RegExp, [like, A('g', 'i')]); out.join()"#,
            r#"like:srcflgPpsfs>ok,like_flags:srcPpsgs>ok"#,
        ),
        (
            "regexp_plain",
            r#"var log = []; function NT() { return new Proxy(function () {}, {get: function (t, k, r) { if (k === 'prototype') log.push('P'); return Reflect.get(t, k, r); }}); } function A(n, v) { return {valueOf: function () { log.push(n + 'v'); return v; }, toString: function () { log.push(n + 's'); return String(v); }}; } function t(name, C, args) { log = []; var r; try { Reflect.construct(C, args, NT()); r = 'ok'; } catch (e) { r = e.constructor.name; } out.push(name + ':' + log.join('') + '>' + r); } var out = []; t('plain', RegExp, [A('p', 'z'), A('f', 'y')]); t('bad', RegExp, [A('p', '('), A('f', 'g')]); t('bad_flags', RegExp, [A('p', 'a'), A('f', 'gg')]); t('regexp', RegExp, [/q/m, undefined]); out.join()"#,
            r#"plain:Ppsfs>ok,bad:Ppsfs>SyntaxError,bad_flags:Ppsfs>SyntaxError,regexp:P>ok"#,
        ),
    ]);
}
