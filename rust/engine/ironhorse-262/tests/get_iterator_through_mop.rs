//! GetIterator reads `@@iterator` through [[Get]] on the operand, or on a
//! primitive's wrapper prototype, for for-of, spread, destructuring,
//! `yield*` and `Object.groupBy`/`Map.groupBy`, against the pinned XS oracle
//! (V8 agrees).
//!
//! The dense fast paths ran when `@@iterator` read `undefined`, so after
//! `delete Array.prototype[Symbol.iterator]` every array form still
//! iterated, and a primitive's wrapper prototype was never consulted:
//! `Number.prototype[Symbol.iterator]` could not make `[...5]` work, and an
//! overridden `String.prototype[Symbol.iterator]` was ignored. A WeakMap or
//! WeakSet operand halted instead of throwing.

use ironhorse_262::dual_run;

/// Every consumer of GetIterator, as a function body over `OPERAND`.
const CONSUMERS: &[&str] = &[
    "var [a] = OPERAND; return String(a);",
    "var r = []; for (var x of OPERAND) r.push(String(x)); return r.join();",
    "return [...OPERAND].map(String).join();",
    "return String(Math.max(...[0].concat([...OPERAND].map(Number))));",
    "function* g() { yield* OPERAND; } return [...g()].map(String).join();",
    "var a; [a] = OPERAND; return String(a);",
    "return JSON.stringify(Object.groupBy(OPERAND, function (x) { return typeof x; }));",
    "return String(Map.groupBy(OPERAND, function (x) { return typeof x; }).size);",
];

fn each_consumer(setup: &str, operand: &str) {
    for consumer in CONSUMERS {
        let body = consumer.replace("OPERAND", operand);
        let run = dual_run(&format!(
            "{setup}; var r; try {{ r = (function () {{ {body} }})(); }} catch (e) {{ r = String(e); }} r"
        ))
        .expect("the XS oracle machine must start");
        assert!(
            run.ironhorse_result != "" && !run.ironhorse_result.starts_with("SyntaxError"),
            "{setup} / {body}: the program must run: {run:?}"
        );
        assert!(
            run.observables_agree(),
            "{setup} / {body}\n  oracle={} ironhorse={}",
            run.oracle_result,
            run.ironhorse_result
        );
    }
}

#[test]
fn a_missing_iterator_method_throws() {
    for (setup, operand) in [
        ("delete Array.prototype[Symbol.iterator]", "[1]"),
        ("Array.prototype[Symbol.iterator] = undefined", "[1]"),
        ("Array.prototype[Symbol.iterator] = null", "[1]"),
        ("delete String.prototype[Symbol.iterator]", "'ab'"),
        ("delete Set.prototype[Symbol.iterator]", "new Set([1])"),
        ("delete Map.prototype[Symbol.iterator]", "new Map([[1, 2]])"),
        ("var w = new WeakMap()", "w"),
        ("var w = new WeakSet()", "w"),
        ("var o = {}", "o"),
        ("1", "5"),
        ("1", "true"),
        ("1", "Symbol()"),
        ("1", "5n"),
    ] {
        each_consumer(setup, operand);
    }
}

#[test]
fn a_replaced_iterator_method_is_called() {
    for (setup, operand) in [
        ("Number.prototype[Symbol.iterator] = function* () { yield this + 1; }", "5"),
        ("Boolean.prototype[Symbol.iterator] = function* () { yield !this.valueOf(); }", "true"),
        ("BigInt.prototype[Symbol.iterator] = function* () { yield this + 1n; }", "5n"),
        ("Symbol.prototype[Symbol.iterator] = function* () { yield typeof this; }", "Symbol()"),
        ("String.prototype[Symbol.iterator] = function* () { yield 'z'; }", "'ab'"),
        ("Array.prototype[Symbol.iterator] = function* () { yield 'replaced'; }", "[1, 2]"),
        ("var a = [1, 2]; a[Symbol.iterator] = function* () { yield 'own'; }", "a"),
        ("Set.prototype[Symbol.iterator] = function* () { yield 'set'; }", "new Set([1])"),
        (
            "Object.defineProperty(String.prototype, Symbol.iterator, { get: function () { return function* () { yield typeof this; }; } })",
            "'ab'",
        ),
        (
            "Number.prototype[Symbol.iterator] = function () { return 1; }",
            "5",
        ),
    ] {
        each_consumer(setup, operand);
    }
}
