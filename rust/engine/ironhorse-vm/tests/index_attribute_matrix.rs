//! Index-property attributes against ECMAScript (Thixotrope harness C-16).
//!
//! `GET_LOCAL` pushed a `const` binding's scope slot whole, flag bits
//! included, and the stores that create an element kept the incoming slot's
//! flag. So `const x = {}; a.push(x)` created element 0 with
//! `XS_DONT_SET_FLAG` set: writable false, enumerable and configurable true,
//! a shape no freeze, seal or harden produces. The next in-place write to it
//! (`splice`, `shift`, `a[0] = ...`) threw "set ?: not writable". A const
//! captured by a closure was read through its cell, which copies only kind
//! and value, so whether a given program failed depended on whether the
//! const happened to be captured.
//!
//! The matrix compares every own property's attributes and value, after one
//! operation on one base, with what Node produced for the same program
//! (`fixtures/index_attribute_matrix.cjs` generates `.tsv`), except where V8
//! departs from ECMA-262, which the generator lists in `SPEC_OVERRIDES`.

use ironhorse_vm::{run_program_with_symbols, RunOutcome};

fn run(source: &str) -> RunOutcome {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("source compiles");
    run_program_with_symbols(&bytecode, &symbols)
}

fn result(source: &str) -> String {
    let out = run(source);
    if out.completed {
        out.result
    } else {
        format!("HALT {:?}", out.halt)
    }
}

/// The reduction of the session queue's failure (J-0271): a `const` pushed
/// onto an array, then spliced out.
#[test]
fn a_const_pushed_onto_an_array_can_be_spliced_out() {
    assert_eq!(
        result(
            "(function () { 'use strict'; const x = {}; const a = []; a.push(x); \
             a.push(1); a.splice(0, 1); \
             const d = Object.getOwnPropertyDescriptor(a, 0); \
             return a.length + ':' + d.writable + d.enumerable + d.configurable; })()"
        ),
        "1:truetruetrue"
    );
}

/// A sloppy function expression's own name is the other flagged binding:
/// `XS_DONT_SET_FLAG | XS_DONT_ENUM_FLAG`, which made the element
/// non-enumerable as well.
#[test]
fn a_function_expressions_own_name_stores_as_a_plain_element() {
    assert_eq!(
        result(
            "(function nm() { const a = []; a.push(nm); a[1] = nm; const o = {}; o[0] = nm; \
             return [Object.getOwnPropertyDescriptor(a, 0), \
                     Object.getOwnPropertyDescriptor(a, 1), \
                     Object.getOwnPropertyDescriptor(o, 0)] \
               .map(d => '' + d.writable + d.enumerable + d.configurable).join(','); })()"
        ),
        "truetruetrue,truetruetrue,truetruetrue"
    );
}

/// Every source of a value against every store that creates a property: the
/// new property is writable, enumerable and configurable, and a later write
/// to it succeeds.
#[test]
fn every_value_source_creates_plain_properties_in_every_store() {
    const SOURCES: &[(&str, &str, &str)] = &[
        ("const local", "const v = {};", "v"),
        (
            "const block",
            "{ const w = {}; var v = w; } const u = {};",
            "u",
        ),
        ("let local", "let v = {};", "v"),
        ("var local", "var v = {};", "v"),
        ("param", "", "p"),
        ("const captured", "const v = {}; const f = () => v;", "v"),
        ("frozen prop", "const F = Object.freeze({p: {}});", "F.p"),
        (
            "frozen prop computed",
            "const F = Object.freeze({p: {}}); const k = 'p';",
            "F[k]",
        ),
        ("frozen elem", "const F = Object.freeze([{}]);", "F[0]"),
        (
            "frozen index prop",
            "const F = {}; F[0] = 1; Object.freeze(F);",
            "F[0]",
        ),
        (
            "read-only prop",
            "const F = {}; Object.defineProperty(F, 'p', {value: 3});",
            "F.p",
        ),
        (
            "read-only elem",
            "const F = [1]; Object.defineProperty(F, 0, {writable: false});",
            "F[0]",
        ),
        ("destructured const", "const {q: v} = {q: {}};", "v"),
        (
            "for-of const",
            "let v; for (const x of [{}]) { v = x; }",
            "v",
        ),
        (
            "catch param",
            "let v; try { throw {}; } catch (e) { v = e; }",
            "v",
        ),
        ("arguments", "", "arguments[0]"),
        ("this", "", "this"),
        ("global const", "", "G"),
        ("global let", "", "GL"),
        ("global read-only", "", "globalThis.GF"),
        ("function name", "", "(function nm() { return nm; })()"),
        ("sloppy function name", "", "SLOPPY()"),
        (
            "inherited frozen",
            "const F = Object.create(Object.freeze({p: 5}));",
            "F.p",
        ),
    ];
    const SINKS: &[(&str, &str, &str)] = &[
        ("push", "const t = []; t.push(X);", "0"),
        (
            "push then shift",
            "const t = [1]; t.push(X); t.shift();",
            "0",
        ),
        ("unshift", "const t = []; t.unshift(X);", "0"),
        ("splice insert", "const t = []; t.splice(0, 0, X);", "0"),
        ("index set", "const t = []; t[0] = X;", "0"),
        (
            "index set at length",
            "const t = [9]; t.length = 0; t[t.length] = X;",
            "0",
        ),
        ("literal", "const t = [X];", "0"),
        ("spread literal", "const t = [...[X]];", "0"),
        ("concat", "const t = [].concat([X]);", "0"),
        ("concat argument", "const t = [].concat(X);", "0"),
        ("Array.of", "const t = Array.of(X);", "0"),
        ("Array.from", "const t = Array.from([X]);", "0"),
        ("map", "const t = [0].map(() => X);", "0"),
        ("slice", "const t = [X].slice();", "0"),
        ("fill", "const t = [0].fill(X);", "0"),
        ("Reflect.set", "const t = []; Reflect.set(t, 0, X);", "0"),
        (
            "Object.assign",
            "const t = []; Object.assign(t, {0: X});",
            "0",
        ),
        ("object index", "const t = {}; t[0] = X;", "0"),
        ("object literal index", "const t = {0: X};", "0"),
        ("object named", "const t = {}; t.k = X;", "'k'"),
        ("object literal named", "const t = {k: X};", "'k'"),
        (
            "object computed",
            "const t = {}; const kk = 'k'; t[kk] = X;",
            "'k'",
        ),
        ("object spread", "const t = {...{k: X}};", "'k'"),
        (
            "Map entry",
            "const t = [...new Map([[0, X]]).values()];",
            "0",
        ),
    ];
    let mut failures = Vec::new();
    for (source_name, prelude, expression) in SOURCES {
        for (sink_name, sink, key) in SINKS {
            let store = sink.replace('X', expression);
            let program = format!(
                "var SLOPPY = function nm() {{ return nm; }}; \
                 const G = {{}}; let GL = {{}}; globalThis.GF = 1; \
                 Object.defineProperty(globalThis, 'GF', {{writable: false}}); \
                 (function (p) {{ 'use strict'; {prelude} {store} \
                   const d = Object.getOwnPropertyDescriptor(t, {key}); \
                   let w = 'ok'; try {{ t[{key}] = 1; }} catch (e) {{ w = 'threw'; }} \
                   return '' + d.writable + d.enumerable + d.configurable + w; \
                 }}).call({{}}, {{}}, {{}})"
            );
            let got = result(&program);
            if got != "truetruetrueok" {
                failures.push(format!("{source_name} -> {sink_name}: {got}"));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} combinations created a property that is not plain:\n{}",
        failures.len(),
        SOURCES.len() * SINKS.len(),
        failures.join("\n")
    );
}

/// Arrays, plain objects and a TypedArray, each through push, splice, shift,
/// unshift, length changes, writes, deletes, freeze, seal and a harden of a
/// neighbouring object: every own property's attributes and value equal
/// Node's for the same program.
#[test]
fn index_attributes_match_ecmascript_across_operations() {
    let table = include_str!("fixtures/index_attribute_matrix.tsv");
    let mut failures = Vec::new();
    let mut cases = 0;
    for line in table.lines().filter(|line| !line.is_empty()) {
        let fields: Vec<&str> = line.split('\t').collect();
        assert_eq!(fields.len(), 4, "malformed fixture line: {line:.80}");
        let (base, op, source, expected) = (fields[0], fields[1], fields[2], fields[3]);
        cases += 1;
        let got = result(source);
        if got != expected {
            failures.push(format!(
                "{base} / {op}:\n    expected {expected}\n    got      {got}"
            ));
        }
    }
    assert!(cases >= 200, "the fixture holds {cases} cases");
    assert!(
        failures.is_empty(),
        "{} of {cases} cases differ from ECMAScript (Node):\n{}",
        failures.len(),
        failures.join("\n")
    );
}
