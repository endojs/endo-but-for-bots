//! The ES2024-and-later built-ins XS ships, run inside the Ironhorse guest.
//!
//! Every expectation is the pinned XS oracle's answer unless a case says the
//! specification is followed instead; `ironhorse-262/tests/xs_departures.rs`
//! records those departures.
mod common;
use common::TestCompiler;

use ironhorse_vm::{parse_symbols, Interp};

/// Run `cranks` in order on one machine, each a separate job-draining run,
/// and answer the last one's completion value.
fn run_cranks(cranks: &[&str]) -> String {
    let cranks: Vec<String> = cranks.iter().map(|crank| crank.to_string()).collect();
    std::thread::Builder::new()
        .stack_size(ironhorse_vm::NATIVE_STACK_BYTES)
        .spawn(move || {
            let mut machine = Interp::new();
            machine.set_source_compiler(std::rc::Rc::new(TestCompiler));
            let mut result = String::new();
            for (index, source) in cranks.iter().enumerate() {
                let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
                let code = if index == 0 {
                    machine.link_intrinsics(&parse_symbols(&symbols));
                    code
                } else {
                    machine
                        .relink_crank(&code, &parse_symbols(&symbols))
                        .unwrap()
                };
                let outcome = machine.run(&code);
                assert!(outcome.completed, "{:?}\n  {source}", outcome.halt);
                result = outcome.result;
            }
            result
        })
        .unwrap()
        .join()
        .unwrap()
}

fn check(cases: &[(&str, &str)]) {
    for (source, expected) in cases {
        assert_eq!(run_cranks(&[source]), *expected, "{source}");
    }
}

#[test]
fn promise_with_resolvers() {
    check(&[
        (
            "var r = Promise.withResolvers(); [r.promise instanceof Promise, Object.keys(r).join('+'), typeof r.resolve, r.resolve.length, Object.getPrototypeOf(r) === Object.prototype, Promise.withResolvers.name, Promise.withResolvers.length].join()",
            "true,promise+resolve+reject,function,1,true,withResolvers,0",
        ),
        (
            "var e = []; try { Promise.withResolvers.call(undefined) } catch (x) { e.push(x.name) } try { Promise.withResolvers.call({}) } catch (x) { e.push(x.name) } try { new Promise.withResolvers() } catch (x) { e.push(x.name) } e.join()",
            "TypeError,TypeError,TypeError",
        ),
        (
            "var calls = 0; function C(ex) { calls++; ex(function () {}, function () {}); } var r = Promise.withResolvers.call(C); class P extends Promise {} [r.promise instanceof C, calls, P.withResolvers().promise instanceof P].join()",
            "true,1,true",
        ),
    ]);
    assert_eq!(
        run_cranks(&[
            "var log = []; var a = Promise.withResolvers(), b = Promise.withResolvers(); a.promise.then(function (v) { log.push('a' + v); }); b.promise.then(null, function (e) { log.push('b' + e); }); a.resolve(1); a.reject(2); b.reject(3); b.resolve(4);",
            "log.join()",
        ]),
        "a1,b3"
    );
}

#[test]
fn promise_try() {
    check(&[
        (
            "var p = Promise.try(function (a, b) { return a + b; }, 1, 2); [p instanceof Promise, Promise.try.name, Promise.try.length].join()",
            "true,try,1",
        ),
        (
            "var r = []; try { Promise.try.call(undefined, function () {}) } catch (e) { r.push(e.name) } try { Promise.try.call({}, function () {}) } catch (e) { r.push(e.name) } r.push(Promise.try() instanceof Promise); r.join()",
            "TypeError,TypeError,true",
        ),
        // The callback runs synchronously, with `this` undefined.
        (
            "var seen = 'unset'; Promise.try(function () { 'use strict'; seen = this; }); String(seen)",
            "undefined",
        ),
        // The specification; XS rejects with what resolve threw
        // (`xs_departures.rs`).
        (
            "var log = []; function C(ex) { ex(function (v) { log.push('res' + v); throw new Error('boom'); }, function (e) { log.push('rej' + e); }); } var out; try { Promise.try.call(C, function () { return 1; }); out = 'returned'; } catch (e) { out = 'threw ' + e.message; } out + '|' + log.join()",
            "threw boom|res1",
        ),
    ]);
    assert_eq!(
        run_cranks(&[
            "var log = []; Promise.try(function (x) { return x * 2; }, 21).then(function (v) { log.push('ok' + v); }); Promise.try(function () { throw 'no'; }).then(null, function (e) { log.push('err' + e); });",
            "log.join()",
        ]),
        "ok42,errno"
    );
}

#[test]
fn error_is_error() {
    check(&[
        (
            "[Error.isError.name, Error.isError.length, Object.getOwnPropertyNames(Error).join('+')].join()",
            "isError,1,length+name+prototype+isError",
        ),
        (
            "class E extends Error {} var thrown = []; try { null.x } catch (e) { thrown.push(e) } try { JSON.parse('{') } catch (e) { thrown.push(e) } [new Error(), new TypeError(), new AggregateError([]), new SuppressedError(1, 2), new E(), RangeError('x')].concat(thrown).map(Error.isError).join()",
            "true,true,true,true,true,true,true,true",
        ),
        (
            "[undefined, {}, Error.prototype, Object.create(Error.prototype), new Proxy(new Error(), {}), 'Error', null, Error].map(function (v) { return Error.isError(v); }).join() + ',' + Error.isError()",
            "false,false,false,false,false,false,false,false,false",
        ),
    ]);
}

#[test]
fn math_sum_precise() {
    check(&[
        (
            "[Math.sumPrecise.name, Math.sumPrecise.length].join()",
            "sumPrecise,1",
        ),
        (
            "[Math.sumPrecise([0.1, 0.2]), Math.sumPrecise([1e20, 0.1, -1e20]), Math.sumPrecise([1, 2, 3]), Math.sumPrecise([1e308, 1e308, -1e308]), Math.sumPrecise([1e308, 1e308]), Math.sumPrecise([5e-324, 5e-324]), Math.sumPrecise(new Set([1, 2])), Math.sumPrecise(new Float64Array([0.5, 0.25]))].join()",
            "0.30000000000000004,0.1,6,1e+308,Infinity,1e-323,3,0.75",
        ),
        (
            "[Math.sumPrecise([Infinity, -Infinity]), Math.sumPrecise([NaN, 1]), Math.sumPrecise([Infinity, 1]), Math.sumPrecise([-Infinity, -0])].join()",
            "NaN,NaN,Infinity,-Infinity",
        ),
        // Ties round to even, once, on the exact sum.
        (
            "[Math.sumPrecise([2 ** 53, 1]), Math.sumPrecise([2 ** 53, 1, 1]), Math.sumPrecise([-(2 ** 53), -1, -5e-324]), Math.sumPrecise([1.7976931348623157e308, 9.979201547673598e291]), Math.sumPrecise([1.7976931348623157e308, 9.979201547673599e291])].join()",
            "9007199254740992,9007199254740994,-9007199254740994,1.7976931348623157e+308,Infinity",
        ),
        // Only -0 items, or none, leave -0; XS answers -0 for a +0 stored
        // as a double (`xs_departures.rs`).
        (
            "var z = 0.5 - 0.5; [Object.is(Math.sumPrecise([]), -0), Object.is(Math.sumPrecise([-0, -0]), -0), Object.is(Math.sumPrecise([z]), 0), Object.is(Math.sumPrecise([1.5, -1.5]), 0)].join()",
            "true,true,true,true",
        ),
        (
            "var r = []; [undefined, null, [1, '2'], {}, [1n], '12'].forEach(function (v) { try { Math.sumPrecise(v); r.push('ok'); } catch (e) { r.push(e.name); } }); r.join()",
            "TypeError,TypeError,TypeError,TypeError,TypeError,TypeError",
        ),
        // A non-Number item closes the iterator.
        (
            "var closed = 0; var it = {[Symbol.iterator]: function () { var i = 0; return {next: function () { i++; return {done: i > 3, value: i === 2 ? 'x' : i}; }, return: function () { closed++; return {}; }}; }}; var r; try { Math.sumPrecise(it); } catch (e) { r = e.name; } [r, closed].join()",
            "TypeError,1",
        ),
    ]);
}

#[test]
fn regexp_escape() {
    check(&[
        (
            "[RegExp.escape.name, RegExp.escape.length].join()",
            "escape,1",
        ),
        // A leading digit or ASCII letter, the syntax characters and `/`,
        // the control escapes and the other punctuators.
        (
            "[RegExp.escape('abc'), RegExp.escape('1a'), RegExp.escape('a.b*c'), RegExp.escape('^$\\\\.*+?()[]{}|/'), RegExp.escape('\\t\\n\\v\\f\\r'), RegExp.escape('_'), RegExp.escape('')].join('|')",
            "\\x61bc|\\x31a|\\x61\\.b\\*c|\\^\\$\\\\\\.\\*\\+\\?\\(\\)\\[\\]\\{\\}\\|\\/|\\t\\n\\v\\f\\r|_|",
        ),
        (
            "RegExp.escape(',-=<>#&!%:;@~\\'`\"')",
            "\\x2c\\x2d\\x3d\\x3c\\x3e\\x23\\x26\\x21\\x25\\x3a\\x3b\\x40\\x7e\\x27\\x60\\x22",
        ),
        // Every WhiteSpace and LineTerminator code point, and a lone
        // surrogate; XS leaves U+1680, U+2000-U+200A, U+205F and U+3000
        // (`xs_departures.rs`).
        (
            "[RegExp.escape(' \\u00a0\\u202f\\ufeff\\u2028\\u2029'), RegExp.escape('\\u1680\\u2000\\u200a\\u205f\\u3000'), RegExp.escape('\\ud800x\\udc00'), RegExp.escape('\\ud83d\\ude00') === '\\ud83d\\ude00'].join('|')",
            "\\x20\\xa0\\u202f\\ufeff\\u2028\\u2029|\\u1680\\u2000\\u200a\\u205f\\u3000|\\ud800x\\udc00|true",
        ),
        (
            "var r = []; [undefined, 1, {}, new String('a'), null].forEach(function (v) { try { RegExp.escape(v); r.push('ok'); } catch (e) { r.push(e.name); } }); r.join()",
            "TypeError,TypeError,TypeError,TypeError,TypeError",
        ),
    ]);
}

#[test]
fn json_raw_json() {
    check(&[
        (
            "[JSON.rawJSON.name, JSON.rawJSON.length, JSON.isRawJSON.name, JSON.isRawJSON.length].join()",
            "rawJSON,1,isRawJSON,1",
        ),
        (
            "var r = JSON.rawJSON('1e1000'); var d = Object.getOwnPropertyDescriptor(r, 'rawJSON'); [Object.getPrototypeOf(r), Object.isFrozen(r), Reflect.ownKeys(r).join(), d.value, d.writable, d.enumerable, d.configurable].join()",
            ",true,rawJSON,1e1000,false,true,false",
        ),
        // `JSON.stringify` emits the text as it is, after `toJSON` and the
        // replacer and before any unwrapping.
        (
            "[JSON.stringify(JSON.rawJSON('12345678901234567890')), JSON.stringify({a: JSON.rawJSON('1e1000'), b: [JSON.rawJSON('\"x\"'), JSON.rawJSON('null')]}), JSON.stringify({toJSON: function () { return JSON.rawJSON('7'); }}), JSON.stringify([1], function (k, v) { return k === '0' ? JSON.rawJSON('8') : v; })].join('|')",
            "12345678901234567890|{\"a\":1e1000,\"b\":[\"x\",null]}|7|[8]",
        ),
        (
            "['', ' 1', '1 ', '\\t1', '1\\n', '{}', '[]', '[1]', '1,', 'nul', '\"x', '01', '1 2'].map(function (s) { try { JSON.rawJSON(s); return 'ok'; } catch (e) { return e.name; } }).join()",
            "SyntaxError,SyntaxError,SyntaxError,SyntaxError,SyntaxError,SyntaxError,SyntaxError,SyntaxError,SyntaxError,SyntaxError,SyntaxError,SyntaxError,SyntaxError",
        ),
        // Only `JSON.rawJSON` makes a raw JSON object; XS throws for a
        // missing argument (`xs_departures.rs`).
        (
            "[JSON.isRawJSON(JSON.rawJSON(1)), JSON.isRawJSON(), JSON.isRawJSON(null), JSON.isRawJSON(new Proxy(JSON.rawJSON(1), {})), JSON.isRawJSON(Object.freeze(Object.assign(Object.create(null), {rawJSON: '1'})))].join()",
            "true,false,false,false,false",
        ),
        (
            "var r = JSON.rawJSON(1); var c = {}; for (var k in r) c[k] = 1; [Object.keys(c).join(), JSON.stringify({...r}), JSON.isRawJSON(harden(r))].join('|')",
            "rawJSON|{\"rawJSON\":\"1\"}|true",
        ),
    ]);
}

#[test]
fn iterator_concat() {
    check(&[
        (
            "[Iterator.concat.name, Iterator.concat.length, Iterator.concat().next().done, Object.prototype.toString.call(Iterator.concat())].join()",
            "concat,0,true,[object Iterator Helper]",
        ),
        (
            "var it = Iterator.concat([1, 2], new Set([3]), 'ab'.split('')); var out = []; for (var v of it) out.push(v); [out.join(), Object.getPrototypeOf(it) === Object.getPrototypeOf([].values().map(function (x) { return x; })), Iterator.concat([1, 2]).map(function (x) { return x * 10; }).toArray().join()].join('|')",
            "1,2,3,a,b|true|10,20",
        ),
        (
            "var r = []; [1, 's', null, {}, {[Symbol.iterator]: 1}].forEach(function (v) { try { Iterator.concat([], v); r.push('ok'); } catch (e) { r.push(e.name); } }); r.join()",
            "TypeError,TypeError,TypeError,TypeError,TypeError",
        ),
        // `@@iterator` is read once per item when the helper is made, and
        // each item is opened only when its turn comes.
        (
            "var log = []; var item = {get [Symbol.iterator]() { log.push('get'); return function () { log.push('open'); var i = 0; return {next: function () { log.push('next'); return {done: i++ > 0, value: 9}; }, return: function () { log.push('ret'); return {}; }}; }; }}; var it = Iterator.concat(item, item); log.push('made'); it.next(); it.next(); log.push('|'); it.return(); log.join()",
            "get,get,made,open,next,next,open,next,|,ret",
        ),
        // Before the first `next()` there is nothing to close.
        (
            "var log = []; var item = {[Symbol.iterator]: function () { log.push('open'); return {next: function () { return {done: false, value: 1}; }, return: function () { log.push('ret'); return {}; }}; }}; var it = Iterator.concat(item); var a = it.return(); [log.join(), a.done, it.next().done].join()",
            ",true,true",
        ),
        // A helper suspended at a yield closes its inner iterator while
        // executing, so a request from inside that close is refused.
        (
            "var log = []; var src = {[Symbol.iterator]: function () { return {next: function () { return {done: false, value: 1}; }, return: function () { try { it.return(); log.push('no throw'); } catch (e) { log.push(e.name); } return {}; }}; }}; var it = Iterator.concat(src); it.next(); it.return(); [log.join(), it.next().done].join()",
            "TypeError,true",
        ),
        (
            "var it = Iterator.concat({[Symbol.iterator]: function () { return 5; }}); try { it.next(); 'ok' } catch (e) { e.name + ':' + it.next().done }",
            "TypeError:true",
        ),
    ]);
}

#[test]
fn uint8_array_base64_and_hex() {
    check(&[
        (
            "[Uint8Array.fromBase64.length, Uint8Array.fromHex.length, Uint8Array.prototype.setFromBase64.length, Uint8Array.prototype.setFromHex.length, Uint8Array.prototype.toBase64.length, Uint8Array.prototype.toHex.length, typeof Int8Array.fromBase64, typeof Int8Array.prototype.toHex].join()",
            "1,1,1,1,0,0,undefined,undefined",
        ),
        (
            "[Uint8Array.fromBase64('SGVsbG8=').join(), Uint8Array.fromBase64(' S G V s\\nbG8 ').join(), Uint8Array.fromHex('cafeBABE').join(), new Uint8Array([72, 101, 108, 108, 111]).toBase64(), new Uint8Array([255, 254]).toBase64({alphabet: 'base64url'}), new Uint8Array([1]).toBase64({omitPadding: true}), new Uint8Array([171, 205]).toHex(), Object.getPrototypeOf(Uint8Array.fromHex('00')) === Uint8Array.prototype].join('|')",
            "72,101,108,108,111|72,101,108,108,111|202,254,186,190|SGVsbG8=|__4=|AQ|abcd|true",
        ),
        (
            "['S', 'SG=', 'S===', 'SGVsbG8=x', 'SGV*', 'SGVsbG9='].map(function (s) { try { return Uint8Array.fromBase64(s).join('-'); } catch (e) { return e.name; } }).join() + '|' + ['SGVsbG9=', 'SG'].map(function (s) { try { return Uint8Array.fromBase64(s, {lastChunkHandling: 'strict'}).join('-'); } catch (e) { return e.name; } }).join() + '|' + ['SGVsbG8', 'SG=='].map(function (s) { return Uint8Array.fromBase64(s, {lastChunkHandling: 'stop-before-partial'}).join('-'); }).join()",
            "SyntaxError,SyntaxError,SyntaxError,SyntaxError,SyntaxError,72-101-108-108-111|SyntaxError,SyntaxError|72-101-108,72",
        ),
        // `setFrom*` writes what it decoded before an error, and stops at
        // the end of the target.
        (
            "var v = new Uint8Array(4), w = new Uint8Array(4), e1, e2; try { v.setFromHex('01020x'); } catch (e) { e1 = e.name; } try { w.setFromBase64('AQID*'); } catch (e) { e2 = e.name; } var t = new Uint8Array(4); var r = t.setFromBase64('SGVsbG8gd29ybGQ='); var u = new Uint8Array(8); var s = new Uint8Array(u.buffer, 2, 3).setFromHex('aabbccdd'); [e1, v.join(), e2, w.join(), r.read, r.written, t.join(), s.read, s.written, u.join()].join('|')",
            "SyntaxError|1,2,0,0|SyntaxError|1,2,3,0|4|3|72,101,108,0|6|3|0,0,170,187,204,0,0,0",
        ),
        (
            "var log = []; var opts = {get alphabet() { log.push('a'); }, get lastChunkHandling() { log.push('l'); }, get omitPadding() { log.push('o'); return 0; }}; Uint8Array.fromBase64('', opts); new Uint8Array(1).toBase64(opts); new Uint8Array(1).setFromBase64('', opts); log.join()",
            "a,l,a,o,a,l",
        ),
        (
            "var r = []; [function () { Uint8Array.fromBase64(1) }, function () { Uint8Array.fromBase64('', 1) }, function () { Uint8Array.fromBase64('', {alphabet: new String('base64')}) }, function () { Uint8Array.prototype.toHex.call(new Int8Array(1)) }, function () { Uint8Array.fromHex('abc') }, function () { var u = new Uint8Array(1); u.buffer.transfer(); u.toHex(); }, function () { var u = new Uint8Array(1); u.setFromHex('00', {get x() {}}); u.buffer.transfer(); u.setFromHex('00'); }].forEach(function (f) { try { f(); r.push('ok'); } catch (e) { r.push(e.name); } }); r.join()",
            "TypeError,TypeError,TypeError,TypeError,SyntaxError,TypeError,TypeError",
        ),
    ]);
}

#[test]
fn float16() {
    check(&[
        (
            "[typeof Float16Array, Float16Array.BYTES_PER_ELEMENT, Float16Array.prototype.BYTES_PER_ELEMENT, Object.getPrototypeOf(Float16Array) === Object.getPrototypeOf(Int8Array), Object.prototype.toString.call(new Float16Array(1)), Math.f16round.name, Math.f16round.length, DataView.prototype.getFloat16.length, DataView.prototype.setFloat16.length].join()",
            "function,2,2,true,[object Float16Array],f16round,1,1,2",
        ),
        // Ties round to even, once, from the double; the largest finite
        // binary16 is 65504, and half its last place more is Infinity.
        (
            "[Math.f16round(0.1), Math.f16round(65519.99), Math.f16round(65520), Math.f16round(5.960464477539063e-8), Math.f16round(2.980232238769531e-8), Math.f16round(2.9802322387695315e-8), Math.f16round(1.00048828125), Math.f16round(1.00146484375), Math.f16round(), Object.is(Math.f16round(-0), -0)].join()",
            "0.0999755859375,65504,Infinity,5.960464477539063e-8,0,0,1,1.001953125,NaN,true",
        ),
        (
            "var d = new DataView(new ArrayBuffer(6)); d.setFloat16(0, 1.5); d.setFloat16(2, -2.75, true); d.setFloat16(4, NaN); [d.getUint16(0), d.getUint16(2, true), d.getFloat16(0), d.getFloat16(2, true), d.getUint16(4)].join()",
            "15872,49536,1.5,-2.75,32256",
        ),
        (
            "var f = new Float16Array(new Uint16Array([0x7c00, 0xfc00, 0x0001, 0x8000, 0x3c00, 0x7bff, 0x03ff]).buffer); [Array.from(f).map(String).join(), new Float16Array([5, NaN, -1, 2]).sort().join()].join('|')",
            "Infinity,-Infinity,5.960464477539063e-8,0,1,65504,0.00006097555160522461|-1,2,5,NaN",
        ),
        // Not an integer view, so every Atomics operation refuses it before
        // coercing its index or value.
        (
            "var f = new Float16Array(4); ['add', 'and', 'compareExchange', 'exchange', 'load', 'or', 'store', 'sub', 'xor'].map(function (m) { try { Atomics[m](f, { valueOf() { throw 'index' } }, 1, 1); return 'ok'; } catch (e) { return typeof e === 'object' ? e.constructor.name : e; } }).join()",
            "TypeError,TypeError,TypeError,TypeError,TypeError,TypeError,TypeError,TypeError,TypeError",
        ),
    ]);
}
