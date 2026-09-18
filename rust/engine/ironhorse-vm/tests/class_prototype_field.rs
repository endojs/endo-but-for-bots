//! A `prototype` field's SEMANTICS, not just its grammar (F063).
//!
//! Admitting the syntax without these would repeat the Annex B `for-in` head
//! mistake on this branch, where the parser accepted a shape and the coder
//! dropped its initializer. `prototype` is a name the class machinery has its
//! own uses for, so "the coder already handles it" is a claim to check rather
//! than assume: an instance field named `prototype` must be an ordinary own
//! property of the INSTANCE and must leave the constructor's own `.prototype`
//! alone.
//!
//! It does, and unchanged — `code_class` and `code_field` key fields by symbol
//! with no special case for `prototype`, so the parser gate was the whole bug.
//! These pin that, so a later change to the field path cannot quietly break the
//! case no corpus covers.
//!
//! Every expectation was taken from Node 22 first and then asserted here.

use ironhorse_compile::compile_atoms;
use ironhorse_vm::{parse_symbols_checked, Interp};

fn run(source: &str) -> String {
    let (bytecode, symbols) = compile_atoms(source).unwrap();
    let mut vm = Interp::new();
    vm.link_intrinsics(&parse_symbols_checked(&symbols).unwrap());
    let out = vm.run(&bytecode);
    assert!(out.completed, "{source}: {:?}", out.halt);
    out.result
}

#[test]
fn an_instance_prototype_field_is_an_ordinary_own_property() {
    // The initializer's value reaches the instance.
    assert_eq!(
        run("String((new (class { prototype = 7; })).prototype)"),
        "7"
    );
    // And without one, the field still exists, holding `undefined`.
    assert_eq!(
        run("String((new (class { prototype; })).prototype)"),
        "undefined"
    );
    assert_eq!(
        run("String(Object.hasOwn(new (class { prototype = 7; }), 'prototype'))"),
        "true"
    );
    assert_eq!(
        run("String(Object.getOwnPropertyNames(new (class { prototype = 7; })).join(','))"),
        "prototype"
    );
}

#[test]
fn it_does_not_disturb_the_constructor_s_own_prototype() {
    // The class object's `.prototype` is untouched: still an object, not the
    // field's value and not `undefined`.
    assert_eq!(
        run("String((class { prototype = 7; }).prototype === undefined)"),
        "false"
    );
    assert_eq!(
        run("String(typeof (class { prototype = 7; }).prototype)"),
        "object"
    );
    // And instances still inherit from it.
    assert_eq!(
        run("class C { prototype = 7; } \
             String(Object.getPrototypeOf(new C()) === C.prototype)"),
        "true"
    );
}

#[test]
fn the_initializer_runs_once_per_instance_and_in_a_derived_class() {
    assert_eq!(
        run("var n = 0; class C { prototype = ++n; } new C(); new C(); String(n)"),
        "2"
    );
    assert_eq!(
        run("String((new (class extends Object { prototype = 1; })).prototype)"),
        "1"
    );
    // Alongside a static field, so the two field paths are both exercised.
    assert_eq!(
        run("String((new (class { static q = 1; prototype = 2; })).prototype)"),
        "2"
    );
}
