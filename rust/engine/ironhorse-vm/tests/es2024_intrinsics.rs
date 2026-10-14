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
