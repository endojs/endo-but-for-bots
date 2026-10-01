//! Where each native constructor reads its prototype.
//!
//! Each constructor reads `newTarget.prototype` (GetPrototypeFromConstructor) at
//! the step XS reads it, which a Proxy `newTarget` makes observable: after a
//! length's ToNumber and before its range check for a TypedArray, after the
//! length check for an ArrayBuffer, before an Array's elements, an Error's
//! message or an AggregateError's iterable. A TypedArray source detached by
//! that read is refused rather than copied.
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
fn the_prototype_read_happens_at_the_engines_step() {
    check(&[
        (
            "buffers",
            r#"var log = []; function NT() { return new Proxy(function () {}, {get: function (t, k, r) { if (k === 'prototype') log.push('P'); return Reflect.get(t, k, r); }}); } function A(n, v) { return {valueOf: function () { log.push(n + 'v'); return v; }, toString: function () { log.push(n + 's'); return String(v); }}; } function t(name, C, args) { log = []; var r; try { Reflect.construct(C, args, NT()); r = 'ok'; } catch (e) { r = e.constructor.name; } out.push(name + ':' + log.join('') + '>' + r); } var out = []; t('ab', ArrayBuffer, [A('n', 8)]); t('ab_negative', ArrayBuffer, [A('n', -1)]); t('ab_huge', ArrayBuffer, [2 ** 40]); t('sab', SharedArrayBuffer, [A('n', 8)]); t('sab_negative', SharedArrayBuffer, [A('n', -1)]); out.join()"#,
            r#"ab:nvP>ok,ab_negative:nv>RangeError,ab_huge:P>RangeError,sab:nvP>ok,sab_negative:nv>RangeError"#,
        ),
        (
            "typed_arrays",
            r#"var log = []; function NT() { return new Proxy(function () {}, {get: function (t, k, r) { if (k === 'prototype') log.push('P'); return Reflect.get(t, k, r); }}); } function A(n, v) { return {valueOf: function () { log.push(n + 'v'); return v; }, toString: function () { log.push(n + 's'); return String(v); }}; } function t(name, C, args) { log = []; var r; try { Reflect.construct(C, args, NT()); r = 'ok'; } catch (e) { r = e.constructor.name; } out.push(name + ':' + log.join('') + '>' + r); } var out = []; t('length', Uint8Array, [4]); t('bad_length', Uint8Array, [-1]); t('huge', Uint8Array, [2 ** 40]); t('symbol', Uint8Array, [Symbol()]); t('array_like', Uint8Array, [{get length() { log.push('len'); return 1; }, get 0() { log.push('el'); return A('e', 1); }}]); t('iterable', Uint8Array, [{[Symbol.iterator]: function () { log.push('it'); return [A('e', 1)][Symbol.iterator](); }}]); t('buffer', Uint8Array, [new ArrayBuffer(8), A('o', 0), A('l', 4)]); out.join()"#,
            r#"length:P>ok,bad_length:P>RangeError,huge:P>RangeError,symbol:>TypeError,array_like:Plenelev>ok,iterable:Pitev>ok,buffer:Povlv>ok"#,
        ),
        (
            "array",
            r#"var log = []; function NT() { return new Proxy(function () {}, {get: function (t, k, r) { if (k === 'prototype') log.push('P'); return Reflect.get(t, k, r); }}); } function A(n, v) { return {valueOf: function () { log.push(n + 'v'); return v; }, toString: function () { log.push(n + 's'); return String(v); }}; } function t(name, C, args) { log = []; var r; try { Reflect.construct(C, args, NT()); r = 'ok'; } catch (e) { r = e.constructor.name; } out.push(name + ':' + log.join('') + '>' + r); } var out = []; t('one', Array, [A('a', 1)]); t('length', Array, [3]); out.join()"#,
            r#"one:P>ok,length:P>ok"#,
        ),
        (
            "errors",
            r#"var log = []; function NT() { return new Proxy(function () {}, {get: function (t, k, r) { if (k === 'prototype') log.push('P'); return Reflect.get(t, k, r); }}); } function A(n, v) { return {valueOf: function () { log.push(n + 'v'); return v; }, toString: function () { log.push(n + 's'); return String(v); }}; } function t(name, C, args) { log = []; var r; try { Reflect.construct(C, args, NT()); r = 'ok'; } catch (e) { r = e.constructor.name; } out.push(name + ':' + log.join('') + '>' + r); } var out = []; t('error', Error, [A('m', 'x'), {get cause() { log.push('c'); return 1; }}]); t('aggregate', AggregateError, [{[Symbol.iterator]: function () { log.push('it'); return [][Symbol.iterator](); }}, A('m', 'x')]); out.join()"#,
            r#"error:Pmsc>ok,aggregate:Pmsit>ok"#,
        ),
        (
            "detached_source",
            r#"var src = new Uint8Array(4); var NT = new Proxy(function () {}, {get: function (t, k, r) { if (k === 'prototype') src.buffer.transfer(); return Reflect.get(t, k, r); }}); var r; try { Reflect.construct(Uint8Array, [src], NT); r = 'copied'; } catch (e) { r = e.constructor.name; } r"#,
            r#"TypeError"#,
        ),
    ]);
}
