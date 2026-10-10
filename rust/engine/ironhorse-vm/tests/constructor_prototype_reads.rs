//! Where each native constructor reads its prototype.
//!
//! Each constructor reads `newTarget.prototype` (GetPrototypeFromConstructor) at
//! the step XS reads it, which a Proxy `newTarget` makes observable: after a
//! length's ToNumber and before its range check for a TypedArray, after an
//! ArrayBuffer length's sign and safe-integer checks and before its allocation
//! limit, before an Array's elements, an Error's message or an AggregateError's
//! iterable. A TypedArray source detached by that read is refused rather than
//! copied. An ordinary constructor reads an accessor or inherited `prototype` on
//! its `newTarget` as observably as a Proxy's.
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
        // A Promise reads its prototype after it checks the executor and before it calls it.
        (
            "promise",
            r#"var log = []; function NT() { return new Proxy(function () {}, {get: function (t, k, r) { if (k === 'prototype') log.push('P'); return Reflect.get(t, k, r); }}); } function A(n, v) { return {valueOf: function () { log.push(n + 'v'); return v; }, toString: function () { log.push(n + 's'); return String(v); }}; } function t(name, C, args) { log = []; var r; try { Reflect.construct(C, args, NT()); r = 'ok'; } catch (e) { r = e.constructor.name; } out.push(name + ':' + log.join('') + '>' + r); } var out = []; t('promise', Promise, [function () { log.push('ex'); }]); t('promise_bad', Promise, [1]); out.join()"#,
            r#"promise:Pex>ok,promise_bad:>TypeError"#,
        ),
        // A keyed collection reads its prototype first. `NT()` hands back an ordinary
        // `prototype`, so the adder lookup on the new instance then fails before the
        // iterable is opened.
        (
            "collections",
            r#"var log = []; function NT() { return new Proxy(function () {}, {get: function (t, k, r) { if (k === 'prototype') log.push('P'); return Reflect.get(t, k, r); }}); } function A(n, v) { return {valueOf: function () { log.push(n + 'v'); return v; }, toString: function () { log.push(n + 's'); return String(v); }}; } function t(name, C, args) { log = []; var r; try { Reflect.construct(C, args, NT()); r = 'ok'; } catch (e) { r = e.constructor.name; } out.push(name + ':' + log.join('') + '>' + r); } var out = []; t('weakmap', WeakMap, [{[Symbol.iterator]: function () { log.push('it'); return [][Symbol.iterator](); }}]); t('weakset', WeakSet, [{[Symbol.iterator]: function () { log.push('it'); return [][Symbol.iterator](); }}]); t('set', Set, [{[Symbol.iterator]: function () { log.push('it'); return [][Symbol.iterator](); }}]); out.join()"#,
            r#"weakmap:P>TypeError,weakset:P>TypeError,set:P>TypeError"#,
        ),
        // A dynamic function converts its parameters and body, then reads its
        // prototype, then parses.
        (
            "function",
            r#"var log = []; function NT() { return new Proxy(function () {}, {get: function (t, k, r) { if (k === 'prototype') log.push('P'); return Reflect.get(t, k, r); }}); } function A(n, v) { return {valueOf: function () { log.push(n + 'v'); return v; }, toString: function () { log.push(n + 's'); return String(v); }}; } function t(name, C, args) { log = []; var r; try { Reflect.construct(C, args, NT()); r = 'ok'; } catch (e) { r = e.constructor.name; } out.push(name + ':' + log.join('') + '>' + r); } var out = []; t('function', Function, [A('a', 'x'), A('b', 'return x')]); t('function_bad', Function, [A('b', '(')]); out.join()"#,
            r#"function:asbsP>ok,function_bad:bs>SyntaxError"#,
        ),
        (
            "date",
            r#"var log = []; function NT() { return new Proxy(function () {}, {get: function (t, k, r) { if (k === 'prototype') log.push('P'); return Reflect.get(t, k, r); }}); } function A(n, v) { return {valueOf: function () { log.push(n + 'v'); return v; }, toString: function () { log.push(n + 's'); return String(v); }}; } function t(name, C, args) { log = []; var r; try { Reflect.construct(C, args, NT()); r = 'ok'; } catch (e) { r = e.constructor.name; } out.push(name + ':' + log.join('') + '>' + r); } var out = []; t('date_none', Date, []); t('date_str', Date, ['2000-01-01']); out.join()"#,
            r#"date_none:P>ok,date_str:P>ok"#,
        ),
        (
            "error_options",
            r#"var log = []; function NT() { return new Proxy(function () {}, {get: function (t, k, r) { if (k === 'prototype') log.push('P'); return Reflect.get(t, k, r); }}); } function A(n, v) { return {valueOf: function () { log.push(n + 'v'); return v; }, toString: function () { log.push(n + 's'); return String(v); }}; } function t(name, C, args) { log = []; var r; try { Reflect.construct(C, args, NT()); r = 'ok'; } catch (e) { r = e.constructor.name; } out.push(name + ':' + log.join('') + '>' + r); } var out = []; t('suppressed', SuppressedError, [1, 2, A('m', 'x')]); t('error_opts', Error, [undefined, {get cause() { log.push('c'); return 1; }}]); out.join()"#,
            r#"suppressed:Pms>ok,error_opts:Pc>ok"#,
        ),
        // A DataView validates its offset and length before it reads its prototype.
        (
            "dataview",
            r#"var log = []; function NT() { return new Proxy(function () {}, {get: function (t, k, r) { if (k === 'prototype') log.push('P'); return Reflect.get(t, k, r); }}); } function A(n, v) { return {valueOf: function () { log.push(n + 'v'); return v; }, toString: function () { log.push(n + 's'); return String(v); }}; } function t(name, C, args) { log = []; var r; try { Reflect.construct(C, args, NT()); r = 'ok'; } catch (e) { r = e.constructor.name; } out.push(name + ':' + log.join('') + '>' + r); } var out = []; t('dataview_len', DataView, [new ArrayBuffer(4), A('o', 1), A('l', 2)]); t('dataview_bad', DataView, [new ArrayBuffer(4), A('o', 5)]); t('dataview_badlen', DataView, [new ArrayBuffer(4), A('o', 1), A('l', 9)]); out.join()"#,
            r#"dataview_len:ovlvP>ok,dataview_bad:ov>RangeError,dataview_badlen:ovlv>RangeError"#,
        ),
        // A TypedArray over another TypedArray or a buffer reads its prototype first.
        (
            "typed_array_sources",
            r#"var log = []; function NT() { return new Proxy(function () {}, {get: function (t, k, r) { if (k === 'prototype') log.push('P'); return Reflect.get(t, k, r); }}); } function A(n, v) { return {valueOf: function () { log.push(n + 'v'); return v; }, toString: function () { log.push(n + 's'); return String(v); }}; } function t(name, C, args) { log = []; var r; try { Reflect.construct(C, args, NT()); r = 'ok'; } catch (e) { r = e.constructor.name; } out.push(name + ':' + log.join('') + '>' + r); } var out = []; t('ta_from_ta', Uint8Array, [new Uint16Array(2)]); t('ta_buffer_bad', Uint16Array, [new ArrayBuffer(4), A('o', 1)]); t('ta_buffer_badlen', Uint8Array, [new ArrayBuffer(4), A('o', 1), A('l', 9)]); out.join()"#,
            r#"ta_from_ta:P>ok,ta_buffer_bad:Pov>RangeError,ta_buffer_badlen:Povlv>RangeError"#,
        ),
        (
            "objects",
            r#"var log = []; function NT() { return new Proxy(function () {}, {get: function (t, k, r) { if (k === 'prototype') log.push('P'); return Reflect.get(t, k, r); }}); } function A(n, v) { return {valueOf: function () { log.push(n + 'v'); return v; }, toString: function () { log.push(n + 's'); return String(v); }}; } function t(name, C, args) { log = []; var r; try { Reflect.construct(C, args, NT()); r = 'ok'; } catch (e) { r = e.constructor.name; } out.push(name + ':' + log.join('') + '>' + r); } var out = []; t('object', Object, [1]); t('boolean', Boolean, [A('b', 1)]); t('bigint64', BigInt64Array, [A('n', 2)]); t('dstack', DisposableStack, []); t('ads', AsyncDisposableStack, []); t('iter', Iterator, []); out.join()"#,
            r#"object:P>ok,boolean:P>ok,bigint64:P>ok,dstack:P>ok,ads:P>ok,iter:P>ok"#,
        ),
        (
            "regexp",
            r#"var log = []; function NT() { return new Proxy(function () {}, {get: function (t, k, r) { if (k === 'prototype') log.push('P'); return Reflect.get(t, k, r); }}); } function A(n, v) { return {valueOf: function () { log.push(n + 'v'); return v; }, toString: function () { log.push(n + 's'); return String(v); }}; } function t(name, C, args) { log = []; var r; try { Reflect.construct(C, args, NT()); r = 'ok'; } catch (e) { r = e.constructor.name; } out.push(name + ':' + log.join('') + '>' + r); } var out = []; t('regexp_regexp_flags', RegExp, [/a/g, A('f', 'i')]); t('regexp_sym', RegExp, [Symbol()]); out.join()"#,
            r#"regexp_regexp_flags:Pfs>ok,regexp_sym:P>TypeError"#,
        ),
    ]);
}

#[test]
fn an_ordinary_constructor_reads_a_new_target_prototype_observably() {
    check(&[
        (
            "bound_accessor",
            r#"function F() {} var G = function () {}.bind(); Object.defineProperty(G, 'prototype', {get: function () { return Array.prototype; }}); Object.getPrototypeOf(Reflect.construct(F, [], G)) === Array.prototype"#,
            r#"true"#,
        ),
        (
            "derived_class_bound_accessor",
            r#"class B {} class D extends B {} var G = function () {}.bind(); Object.defineProperty(G, 'prototype', {get: function () { return Array.prototype; }}); Object.getPrototypeOf(Reflect.construct(D, [], G)) === Array.prototype"#,
            r#"true"#,
        ),
        (
            "bound_without_prototype",
            r#"function F() {} var G = function () {}.bind(); Object.getPrototypeOf(Reflect.construct(F, [], G)) === Object.prototype"#,
            r#"true"#,
        ),
        (
            "bound_inherits_prototype",
            r#"function F() {} var G = function () {}.bind(); Function.prototype.prototype = Array.prototype; var r = Object.getPrototypeOf(Reflect.construct(F, [], G)) === Array.prototype; delete Function.prototype.prototype; r"#,
            r#"true"#,
        ),
        (
            "data_prototype_not_an_object",
            r#"function F() {} F.prototype = 3; Object.getPrototypeOf(new F()) === Object.prototype"#,
            r#"true"#,
        ),
    ]);
}

/// A native constructor reads an accessor `prototype` on a bound `newTarget`
/// exactly once and builds the instance from what it answered, whether the
/// native is the target itself or the base a derived class's `super()`
/// reaches.
#[test]
fn a_native_constructor_reads_an_accessor_new_target_prototype_once() {
    check(&[
        (
            "direct",
            r#"var natives = [[Map], [Set], [WeakMap], [Error, ['m']], [Array, [2]], [Uint8Array, [1]], [ArrayBuffer, [1]], [DataView, [new ArrayBuffer(1)]], [Promise, [function () {}]], [RegExp, ['a']], [Date, [0]], [Boolean, [1]], [Function, ['return 1']], [Object, []]]; var out = []; natives.forEach(function (c) { var n = 0, P = Object.create(c[0].prototype); var G = function () {}.bind(); Object.defineProperty(G, 'prototype', {get: function () { n++; return P; }}); var o = Reflect.construct(c[0], c[1] || [], G); out.push(c[0].name + ':' + n + (Object.getPrototypeOf(o) === P)); }); out.join()"#,
            r#"Map:1true,Set:1true,WeakMap:1true,Error:1true,Array:1true,Uint8Array:1true,ArrayBuffer:1true,DataView:1true,Promise:1true,RegExp:1true,Date:1true,Boolean:1true,Function:1true,Object:1true"#,
        ),
        (
            "derived",
            r#"var natives = [[Map], [Set], [WeakMap], [Error, ['m']], [Array, [2]], [Uint8Array, [1]], [ArrayBuffer, [1]], [DataView, [new ArrayBuffer(1)]], [Promise, [function () {}]], [RegExp, ['a']], [Date, [0]], [Boolean, [1]], [Function, ['return 1']], [Object, []]]; var out = []; natives.forEach(function (c) { var n = 0, P = Object.create(c[0].prototype); var G = function () {}.bind(); Object.defineProperty(G, 'prototype', {get: function () { n++; return P; }}); class D extends c[0] { constructor() { super(...(c[1] || [])); } } var o = Reflect.construct(D, [], G); out.push(c[0].name + ':' + n + (Object.getPrototypeOf(o) === P)); }); out.join()"#,
            r#"Map:1true,Set:1true,WeakMap:1true,Error:1true,Array:1true,Uint8Array:1true,ArrayBuffer:1true,DataView:1true,Promise:1true,RegExp:1true,Date:1true,Boolean:1true,Function:1true,Object:1true"#,
        ),
    ]);
}
