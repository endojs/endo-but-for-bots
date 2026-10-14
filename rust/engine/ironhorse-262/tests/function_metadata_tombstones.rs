//! A deleted function `length` or `name` stays deleted on every path, and
//! `bind` reads its target's `length` and `name` through [[GetOwnProperty]]
//! and [[Get]] (ledger F082), against the pinned XS oracle (V8 agrees).
//!
//! `delete` records a tombstone for the synthesized pair, but
//! `exotic_own_descriptor` rebuilt both from `FuncInfo` without checking it,
//! and every read and write walk consults that first: after
//! `delete g.length`, `g.length` still read 3, own keys still listed it, a
//! write through an extensible prototype failed, and `g.bind().length` was 3.

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

/// Every function kind whose `length` and `name` Ironhorse synthesizes.
const FUNCTIONS: &[&str] = &[
    "function g(a, b, c) {}",
    "var g = function (a, b) {};",
    "var g = (a, b) => a;",
    "var g = class { constructor(a) {} };",
    "var g = ({ m(a, b) {} }).m;",
    "var g = function* (a) {};",
    "var g = async function (a, b) {};",
    "var g = async function* (a) {};",
    "var g = function (a, b, c) {}.bind(null, 1);",
    "var g = new Function('a,b,c', null);",
    "var g = [].push;",
    "var g = Object.keys;",
];

#[test]
fn a_deleted_length_or_name_is_absent_on_every_path() {
    for function in FUNCTIONS {
        for key in ["length", "name"] {
            agrees(&format!(
                "{function} var before = Reflect.ownKeys(g).map(String); var d = delete g.{key}; \
                 [d, typeof g.{key}, JSON.stringify(g.{key}), JSON.stringify(g['{key}']), \
                  JSON.stringify(Reflect.get(g, '{key}')), JSON.stringify(Object.create(g).{key}), \
                  JSON.stringify(new Proxy(g, {{}}).{key}), g.hasOwnProperty('{key}'), '{key}' in g, \
                  JSON.stringify(Object.getOwnPropertyDescriptor(g, '{key}')), \
                  Reflect.ownKeys(g).map(String).join('+') === before.filter(function (k) {{ return k !== '{key}'; }}).join('+')].join()"
            ));
        }
    }
}

#[test]
fn a_deleted_length_or_name_reads_through_the_prototype_and_can_be_redefined() {
    for function in FUNCTIONS {
        for key in ["length", "name"] {
            agrees(&format!(
                "{function} delete g.{key}; Object.setPrototypeOf(g, {{ {key}: 42 }}); \
                 var inherited = g.{key}; Object.setPrototypeOf(g, {{}}); \
                 g.{key} = 5; var assigned = g.{key}; var set = Reflect.set(g, '{key}', 6); \
                 [inherited, assigned, set, g.{key}, Reflect.ownKeys(g).map(String).join('+'), \
                  JSON.stringify(Object.getOwnPropertyDescriptor(g, '{key}'))].join()"
            ));
            agrees(&format!(
                "'use strict'; {function} delete g.{key}; Object.setPrototypeOf(g, {{}}); \
                 var r; try {{ g.{key} = 5; r = g.{key}; }} catch (e) {{ r = e.constructor.name; }} r"
            ));
            agrees(&format!(
                "{function} delete g.{key}; Object.defineProperty(g, '{key}', {{ value: 9, configurable: true }}); \
                 [g.{key}, Reflect.ownKeys(g).map(String).join('+'), delete g.{key}, typeof g.{key}].join()"
            ));
        }
    }
}

#[test]
fn bind_reads_the_targets_length_and_name() {
    for (setup, expected_kind) in [
        ("", "the synthesized pair"),
        ("delete g.length;", "a deleted length"),
        ("delete g.name;", "a deleted name"),
        ("Object.defineProperty(g, 'length', { value: 7 });", "a redefined length"),
        ("Object.defineProperty(g, 'length', { value: Infinity });", "an infinite length"),
        ("Object.defineProperty(g, 'length', { value: -Infinity });", "a negative infinite length"),
        ("Object.defineProperty(g, 'length', { value: 2 ** 31 + 5 });", "a length past i32"),
        ("Object.defineProperty(g, 'length', { value: 2 ** 53 });", "a length past u32"),
        ("Object.defineProperty(g, 'length', { value: 2.9 });", "a fractional length"),
        ("Object.defineProperty(g, 'length', { value: -2.9 });", "a negative length"),
        ("Object.defineProperty(g, 'length', { value: NaN });", "a NaN length"),
        ("Object.defineProperty(g, 'length', { value: '3' });", "a string length"),
        ("Object.defineProperty(g, 'length', { value: 3n });", "a BigInt length"),
        ("Object.defineProperty(g, 'name', { value: 42 });", "a number name"),
        ("Object.defineProperty(g, 'name', { value: Symbol('s') });", "a symbol name"),
        (
            "delete g.length; Object.setPrototypeOf(g, { length: 42 });",
            "an inherited length, which bind ignores",
        ),
        (
            "delete g.name; Object.setPrototypeOf(g, Object.assign(Object.create(Function.prototype), { name: 'inherited' }));",
            "an inherited name, which bind reads",
        ),
        (
            "Object.defineProperty(g, 'length', { get: function () { log.push('length'); return 5; } }); \
             Object.defineProperty(g, 'name', { get: function () { log.push('name'); return 'got'; } });",
            "accessors, read in order",
        ),
    ] {
        for bound_args in ["", "null", "null, 1", "null, 1, 2, 3, 4"] {
            agrees(&format!(
                "var log = []; function g(a, b, c) {{}} {setup} var b = g.bind({bound_args}); \
                 [b.length, JSON.stringify(b.name), log.join('+'), \
                  JSON.stringify(Object.getOwnPropertyDescriptor(b, 'length')), \
                  Reflect.ownKeys(b).map(String).join('+')].join() /* {expected_kind} */"
            ));
        }
    }
}
