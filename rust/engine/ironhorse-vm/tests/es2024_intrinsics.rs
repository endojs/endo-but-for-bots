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
