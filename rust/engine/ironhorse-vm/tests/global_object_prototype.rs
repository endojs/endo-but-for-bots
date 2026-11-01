//! The global object, and every Compartment global, chains to
//! `%Object.prototype%`, as it does on XS, node and browsers
//! (architecture review 2026-10-16, CORE-4 / PROP-7).
//!
//! The global was once allocated with a null [[Prototype]], and
//! `GET_VARIABLE`/`SET_VARIABLE` asked `%Object.prototype%` directly so that
//! `typeof toString` still read `"function"`. Bare-name resolution and
//! object-level operations on `globalThis` then disagreed: `'toString' in
//! globalThis` was `false`, `globalThis instanceof Object` was `false`, and a
//! top-level `this.hasOwnProperty('x')` threw. These pin them back together;
//! `guest_compartment.rs` pins the same link for a Compartment global.

use ironhorse_vm::Interp;

fn run(src: &str) -> String {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(src).expect("compiles");
    let names = ironhorse_vm::parse_symbols(&symbols);
    let mut m = Interp::new();
    m.link_intrinsics(&names);
    let out = m.run(&bytecode);
    assert!(out.completed, "{src}: {:?}", out.halt);
    out.result
}

#[test]
fn the_global_object_inherits_from_object_prototype() {
    assert_eq!(
        run("Object.getPrototypeOf(globalThis) === Object.prototype"),
        "true"
    );
    assert_eq!(run("globalThis instanceof Object"), "true");
    assert_eq!(run("Object.prototype.isPrototypeOf(globalThis)"), "true");
    assert_eq!(run("var x = 1; this.hasOwnProperty('x')"), "true");
    assert_eq!(run("this.propertyIsEnumerable('Object')"), "false");
    assert_eq!(run("String(globalThis)"), "[object Object]");
}

#[test]
fn name_resolution_and_has_property_agree_on_inherited_names() {
    assert_eq!(run("'toString' in globalThis"), "true");
    assert_eq!(run("typeof toString"), "function");
    assert_eq!(run("toString === Object.prototype.toString"), "true");
    // A name the prototype gains later is resolvable both ways.
    assert_eq!(
        run("Object.prototype.pp = 7; ['pp' in globalThis, pp].join()"),
        "true,7"
    );
    // A sloppy store to an inherited name creates an own global.
    assert_eq!(
        run("toString = 1; [globalThis.hasOwnProperty('toString'), typeof toString].join()"),
        "true,number"
    );
}
