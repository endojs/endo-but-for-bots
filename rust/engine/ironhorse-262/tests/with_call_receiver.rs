//! A call through a `with` object's binding takes that object as its
//! receiver (EvaluateCall's `WithBaseObject`, ES2024 9.1.1.2.10), against
//! the pinned XS oracle (V8 agrees on each).

use ironhorse_262::dual_run;

fn agrees(source: &str) {
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert!(
        run.observables_agree(),
        "observable divergence: {source}\n  oracle={} ironhorse={}\n  ironhorse_halt={:?}",
        run.oracle_result,
        run.ironhorse_result,
        run.ironhorse_halt,
    );
}

#[test]
fn a_with_binding_call_receives_the_with_object() {
    for program in [
        "var o = { f() { return this === o; } }; with (o) { f() }",
        "var o = { f() { 'use strict'; return this; } }; var t; with (o) { t = f(); } [typeof t, t === o].join()",
        "function g() { var o = { f() { return this; } }; var t; with (o) { t = f(); } return [typeof t, t === o, t === globalThis].join(); } g()",
        "var o = { f() { return this === o; } }; with (o) { (function () { return f(); })() }",
        "var o = { f(s) { return this === o && s[0]; } }; with (o) { f`x` }",
        "var p = new Proxy({ f() { return this === p; } }, {}); with (p) { f() }",
        "var o = { f() { return this === o; } }; with (o) { eval('f()') }",
        "var o = { get f() { return function () { return this === o; }; } }; with (o) { f() }",
        "var u = { f() { return this; } }; var o = Object.create(u); with (o) { f() === o }",
        "var o = { f() { return this === o; } }; with ({}) { with (o) { f() } }",
    ] {
        agrees(program);
    }
}

#[test]
fn other_calls_inside_a_with_keep_their_receiver() {
    for program in [
        "function f() { return this === globalThis; } var o = {}; with (o) { f() }",
        "function f() { 'use strict'; return this; } var o = {}; with (o) { String(f()) }",
        "var o = { f() { return this === o; } }; with (o) { var r = []; r.push(f(), (f)(), (0, f)()); r.join() }",
        "var o = { f() { return this === o; } }; with (o) { new f().constructor === f }",
        "var o = { f() { return this; } }; with (o) { var g = f; } String(g() === o)",
        "var q = { f() { return this === q; } }; var o = { q }; with (o) { q.f() }",
    ] {
        agrees(&format!(
            "try {{ String({program}) }} catch (e) {{ 'throw ' + String(e) }}"
        ));
    }
}
